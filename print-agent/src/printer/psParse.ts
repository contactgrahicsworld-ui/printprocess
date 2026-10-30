/**
 * Parsers for PowerShell `ConvertTo-Json` output.
 *
 * Quirks handled:
 *  - Empty pipeline -> empty output or "null".
 *  - Single pipeline object -> bare object instead of a one-element array.
 *  - Windows PowerShell 5.1 sometimes wraps arrays as { "value": [...], "Count": n }.
 *  - A one-element array property can collapse to a scalar.
 *  - Enums may serialise as numbers (5.1/7 default) or strings (-EnumsAsStrings / [string] casts),
 *    and flag enums as "Printing, Retained".
 *  - DateTime may appear as "/Date(1730000000000)/" (5.1) or ISO-8601 (7.x) or unix ms.
 *  - UTF-8 BOM at start of output.
 */
import type { PrinterInfo, PrinterStatus } from '../types.js';
import type { PrintedEvent, SpoolerFlag, SpoolerJob } from './backend.js';

export class PsParseError extends Error {}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export function parseJsonLoose(text: string): Json {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t === '' || t === 'null') return null;
  try {
    return JSON.parse(t) as Json;
  } catch (e) {
    throw new PsParseError(`invalid JSON from PowerShell: ${(e as Error).message}; output starts: ${t.slice(0, 200)}`);
  }
}

function isObj(v: Json | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalise any of the shapes above into an array. */
export function asArray(v: Json | undefined): Json[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v['value']) && 'Count' in v && Object.keys(v).length <= 2) {
    return v['value'] as Json[];
  }
  return [v];
}

export function toRecords(text: string): Obj[] {
  return asArray(parseJsonLoose(text)).filter(isObj);
}

function str(v: Json | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function num(v: Json | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(v: Json | undefined): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  return null;
}

function numArray(v: Json | undefined): number[] {
  return asArray(v)
    .map((x) => num(x))
    .filter((x): x is number => x !== null);
}

function strArray(v: Json | undefined): string[] {
  return asArray(v)
    .map((x) => str(x))
    .filter((x) => x !== '');
}

/** Parse "/Date(1730000000000)/", ISO strings, or numbers to unix ms. */
export function parsePsDate(v: Json | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(v);
    if (m) return Number(m[1]);
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  if (isObj(v) && 'value' in v) return parsePsDate(v['value']);
  return null;
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

/** PRINTER_STATUS_* flags (= MSFT_Printer.PrinterStatus from Get-Printer). */
export const PRINTER_STATUS_FLAGS: Record<string, number> = {
  Paused: 0x1,
  Error: 0x2,
  PendingDeletion: 0x4,
  PaperJam: 0x8,
  PaperOut: 0x10,
  ManualFeed: 0x20,
  PaperProblem: 0x40,
  Offline: 0x80,
  IOActive: 0x100,
  Busy: 0x200,
  Printing: 0x400,
  OutputBinFull: 0x800,
  NotAvailable: 0x1000,
  Waiting: 0x2000,
  Processing: 0x4000,
  Initializing: 0x8000,
  WarmingUp: 0x10000,
  TonerLow: 0x20000,
  NoToner: 0x40000,
  PagePunt: 0x80000,
  UserIntervention: 0x100000,
  OutOfMemory: 0x200000,
  DoorOpen: 0x400000,
  ServerUnknown: 0x800000,
  PowerSave: 0x1000000,
};

/** Accepts a number bitmask or "Offline, PaperOut" style string; returns flag names. */
export function decodePrinterStatusFlags(v: Json | undefined): string[] {
  const n = num(v);
  if (n !== null) {
    if (n === 0) return [];
    return Object.entries(PRINTER_STATUS_FLAGS)
      .filter(([, bit]) => (n & bit) !== 0)
      .map(([name]) => name);
  }
  const s = str(v);
  if (!s) return [];
  return s
    .split(/[,|\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '' && x.toLowerCase() !== 'normal')
    .map((x) => Object.keys(PRINTER_STATUS_FLAGS).find((k) => k.toLowerCase() === x.toLowerCase()) ?? x);
}

/** Win32_Printer.PrinterStatus */
const WIN32_PRINTER_STATUS: Record<number, string> = {
  1: 'Other',
  2: 'Unknown',
  3: 'Idle',
  4: 'Printing',
  5: 'Warmup',
  6: 'StoppedPrinting',
  7: 'Offline',
};

/** Win32_Printer.DetectedErrorState */
const WIN32_DETECTED_ERROR: Record<number, string> = {
  0: 'Unknown',
  1: 'Other',
  2: 'NoError',
  3: 'LowPaper',
  4: 'NoPaper',
  5: 'LowToner',
  6: 'NoToner',
  7: 'DoorOpen',
  8: 'Jammed',
  9: 'Offline',
  10: 'ServiceRequested',
  11: 'OutputBinFull',
};

export function normalisePaperName(name: string): string | null {
  const n = name.trim();
  if (/^A4(\b|\s|$)/i.test(n) && !/rotated/i.test(n)) return 'A4';
  if (/^A3(\b|\s|$)/i.test(n) && !/rotated|extra|\+/i.test(n)) return 'A3';
  if (/^(US\s+)?Legal(\b|\s|$)/i.test(n)) return 'Legal';
  if (/^(US\s+)?Letter(\b|\s|$)/i.test(n) && !/rotated/i.test(n)) return 'Letter';
  return null;
}

/** Win32_Printer.PaperSizesSupported codes we care about. */
const WIN32_PAPER_CODES: Record<number, string> = { 7: 'Letter', 8: 'Legal', 21: 'A3', 22: 'A4' };

export interface StatusDerivation {
  status: PrinterStatus;
  detail: string;
}

export function derivePrinterStatus(rec: Obj): StatusDerivation {
  const flags = decodePrinterStatusFlags(rec['MsftPrinterStatus'] ?? rec['PrinterStatusFlags']);
  const workOffline = bool(rec['WorkOffline']) === true;
  const w32 = num(rec['PrinterStatus']);
  const w32Name = w32 !== null ? WIN32_PRINTER_STATUS[w32] ?? `code${w32}` : '';
  const des = num(rec['DetectedErrorState']);
  const desName = des !== null ? WIN32_DETECTED_ERROR[des] ?? `code${des}` : '';
  const has = (f: string): boolean => flags.includes(f);

  const detailParts = [
    flags.length ? `flags=${flags.join('|')}` : 'flags=Normal',
    workOffline ? 'WorkOffline=true' : '',
    w32Name ? `Win32Status=${w32Name}` : '',
    desName ? `DetectedErrorState=${desName}` : '',
  ].filter(Boolean);
  const detail = detailParts.join(' ');

  let status: PrinterStatus;
  if (workOffline || has('Offline') || w32 === 7 || des === 9 || has('NotAvailable') || has('ServerUnknown')) status = 'Offline';
  else if (has('PaperOut') || des === 4) status = 'PaperOut';
  else if (has('PaperJam') || des === 8) status = 'PaperJam';
  else if (has('DoorOpen') || des === 7) status = 'DoorOpen';
  else if (has('NoToner') || des === 6) status = 'TonerOut';
  else if (has('Paused')) status = 'Paused';
  else if (has('UserIntervention')) status = 'UserIntervention';
  else if (has('Error') || has('PaperProblem') || has('OutOfMemory') || des === 10 || w32 === 6) status = 'Error';
  else if (has('Printing') || has('Processing') || w32 === 4) status = 'Printing';
  else status = 'Normal';
  return { status, detail };
}

/**
 * Parses the output of WINDOWS_LIST_PRINTERS_SCRIPT: one record per printer combining
 * Get-Printer (MSFT_Printer), Win32_Printer and System.Drawing.Printing.PrinterSettings.
 */
export function parsePrinters(text: string): PrinterInfo[] {
  const out: PrinterInfo[] = [];
  for (const rec of toRecords(text)) {
    const name = str(rec['Name']);
    if (!name) continue;
    const caps = numArray(rec['Capabilities']);
    const capDesc = strArray(rec['CapabilityDescriptions']).map((s) => s.toLowerCase());
    const netColor = bool(rec['NetSupportsColor']);
    const netDuplex = bool(rec['NetCanDuplex']);
    const supportsColor = netColor ?? (caps.includes(2) || capDesc.some((d) => d.includes('color')));
    const supportsDuplex = netDuplex ?? (caps.includes(3) || capDesc.some((d) => d.includes('duplex')));

    const papers = new Set<string>();
    for (const p of [...strArray(rec['NetPaperNames']), ...strArray(rec['PrinterPaperNames'])]) {
      const n = normalisePaperName(p);
      if (n) papers.add(n);
    }
    for (const code of numArray(rec['PaperSizesSupported'])) {
      const n = WIN32_PAPER_CODES[code];
      if (n) papers.add(n);
    }
    const order = ['A4', 'A3', 'Legal', 'Letter'];
    const paperSizes = [...papers].sort((a, b) => order.indexOf(a) - order.indexOf(b));

    const { status, detail } = derivePrinterStatus(rec);
    out.push({
      name,
      isDefault: bool(rec['Default']) === true || bool(rec['IsDefault']) === true,
      status,
      statusDetail: detail,
      supportsColor,
      supportsDuplex,
      paperSizes,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spooler jobs
// ---------------------------------------------------------------------------

/** JOB_STATUS_* bits (Win32_PrintJob.StatusMask and MSFT_PrintJob.JobStatus share the layout). */
export const JOB_STATUS_BITS: Array<[SpoolerFlag, number]> = [
  ['Paused', 0x1],
  ['Error', 0x2],
  ['Deleting', 0x4],
  ['Spooling', 0x8],
  ['Printing', 0x10],
  ['Offline', 0x20],
  ['PaperOut', 0x40],
  ['Printed', 0x80],
  ['Deleted', 0x100],
  ['BlockedDevQ', 0x200],
  ['UserIntervention', 0x400],
  ['Restarting', 0x800],
  ['Complete', 0x1000],
  ['Retained', 0x2000],
  ['RenderingLocally', 0x4000],
];

const FLAG_ALIASES: Record<string, SpoolerFlag> = {
  paused: 'Paused',
  error: 'Error',
  deleting: 'Deleting',
  spooling: 'Spooling',
  printing: 'Printing',
  offline: 'Offline',
  paperout: 'PaperOut',
  printed: 'Printed',
  deleted: 'Deleted',
  blockeddevq: 'BlockedDevQ',
  blocked_devq: 'BlockedDevQ',
  userintervention: 'UserIntervention',
  user_intervention_req: 'UserIntervention',
  userinterventionrequired: 'UserIntervention',
  restarting: 'Restarting',
  complete: 'Complete',
  completed: 'Complete',
  retained: 'Retained',
  renderinglocally: 'RenderingLocally',
};

export function decodeJobFlags(mask: Json | undefined, statusText: Json | undefined): SpoolerFlag[] {
  const set = new Set<SpoolerFlag>();
  const n = num(mask);
  if (n !== null) for (const [f, bit] of JOB_STATUS_BITS) if ((n & bit) !== 0) set.add(f);
  for (const t of [statusText]) {
    const nn = num(t);
    if (nn !== null) {
      for (const [f, bit] of JOB_STATUS_BITS) if ((nn & bit) !== 0) set.add(f);
      continue;
    }
    for (const tok of str(t).split(/[,|]+/)) {
      const key = tok.trim().toLowerCase().replace(/[\s-]+/g, '');
      const f = FLAG_ALIASES[key] ?? FLAG_ALIASES[tok.trim().toLowerCase()];
      if (f) set.add(f);
    }
  }
  return [...set];
}

/** Parses output of WINDOWS_LIST_JOBS_SCRIPT (Win32_PrintJob records). */
export function parseSpoolerJobs(text: string, printerName: string): SpoolerJob[] {
  const out: SpoolerJob[] = [];
  for (const rec of toRecords(text)) {
    // Win32_PrintJob.Name is "PrinterName, 12"; JobId is the numeric id.
    let id = num(rec['JobId']) ?? num(rec['Id']);
    let printer = str(rec['PrinterName']);
    const name = str(rec['Name']);
    if (name && name.includes(',')) {
      const idx = name.lastIndexOf(',');
      if (!printer) printer = name.slice(0, idx).trim();
      if (id === null) id = num(name.slice(idx + 1).trim());
    }
    if (id === null) continue;
    if (!printer) printer = printerName;
    const total = num(rec['TotalPages']);
    const printed = num(rec['PagesPrinted']);
    const rawStatus = [str(rec['JobStatus']), str(rec['Status']), rec['StatusMask'] !== undefined ? `mask=${str(rec['StatusMask'])}` : '']
      .filter(Boolean)
      .join(' ');
    out.push({
      id,
      printerName: printer,
      document: str(rec['Document']) || str(rec['DocumentName']),
      flags: decodeJobFlags(rec['StatusMask'], rec['JobStatus']),
      rawStatus,
      totalPages: total,
      pagesPrinted: printed,
      submittedAt: parsePsDate(rec['Submitted'] ?? rec['SubmittedTime'] ?? rec['TimeSubmitted']),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event 307
// ---------------------------------------------------------------------------

export function parsePrintedEvents(text: string): PrintedEvent[] {
  const out: PrintedEvent[] = [];
  for (const rec of toRecords(text)) {
    const t = parsePsDate(rec['TimeCreated']);
    if (t === null) continue;
    out.push({
      spoolerJobId: num(rec['JobId']),
      document: str(rec['Document']),
      printerName: str(rec['Printer']),
      pages: num(rec['Pages']),
      timeCreated: t,
    });
  }
  return out;
}
