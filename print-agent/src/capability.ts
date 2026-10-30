import type { AgentJobStatus, JobSettings, PrinterInfo, PrinterStatus } from './types.js';
import { BLOCKING_PRINTER_STATUSES } from './types.js';
import type { AgentConfig } from './config.js';

export const CONTRACT_PAPER_NAME: Record<JobSettings['paperSize'], string> = {
  A4: 'A4',
  A3: 'A3',
  LEGAL: 'Legal',
};

/** Returns an error detail if the printer cannot honour the settings exactly; null if OK. Never downgrades. */
export function checkCapabilities(p: PrinterInfo, s: JobSettings): string | null {
  const problems: string[] = [];
  if (s.colorMode === 'COLOR' && !p.supportsColor) problems.push(`COLOR requested but printer "${p.name}" is monochrome`);
  if (s.duplex === 'DOUBLE' && !p.supportsDuplex) problems.push(`DOUBLE (duplex) requested but printer "${p.name}" has no duplex unit enabled in its driver`);
  const paper = CONTRACT_PAPER_NAME[s.paperSize];
  if (!paper) problems.push(`unknown paper size ${String(s.paperSize)}`);
  else if (!p.paperSizes.some((x) => x.toLowerCase() === paper.toLowerCase())) {
    problems.push(`paper ${paper} not supported by printer "${p.name}" (supports: ${p.paperSizes.join(', ') || 'none reported'})`);
  }
  return problems.length ? `capability mismatch: ${problems.join('; ')}. Not printed (no silent downgrade).` : null;
}

export function applyOverrides(p: PrinterInfo, overrides: AgentConfig['printerOverrides']): PrinterInfo {
  const o = overrides[p.name];
  if (!o) return p;
  return {
    ...p,
    supportsColor: o.supportsColor ?? p.supportsColor,
    supportsDuplex: o.supportsDuplex ?? p.supportsDuplex,
    paperSizes: o.paperSizes ?? p.paperSizes,
  };
}

export function isBlocking(status: PrinterStatus): boolean {
  return BLOCKING_PRINTER_STATUSES.includes(status);
}

export function printerStatusToJobStatus(status: PrinterStatus): AgentJobStatus {
  if (status === 'Offline') return 'PRINTER_OFFLINE';
  if (status === 'PaperOut') return 'PAPER_OUT';
  return 'ERROR';
}
