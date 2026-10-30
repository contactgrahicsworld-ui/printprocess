import type { PrinterInfo } from '../types.js';

/** Normalised spooler status flags (Win32 JOB_STATUS_* / Win32_PrintJob.StatusMask). */
export type SpoolerFlag =
  | 'Paused'
  | 'Error'
  | 'Deleting'
  | 'Spooling'
  | 'Printing'
  | 'Offline'
  | 'PaperOut'
  | 'Printed'
  | 'Deleted'
  | 'BlockedDevQ'
  | 'UserIntervention'
  | 'Restarting'
  | 'Complete'
  | 'Retained'
  | 'RenderingLocally';

export interface SpoolerJob {
  id: number;
  printerName: string;
  document: string;
  flags: SpoolerFlag[];
  /** raw status text for logs */
  rawStatus: string;
  totalPages: number | null;
  pagesPrinted: number | null;
  submittedAt: number | null;
}

/** Microsoft-Windows-PrintService/Operational Event ID 307 ("Document N ... was printed"). */
export interface PrintedEvent {
  spoolerJobId: number | null;
  document: string;
  printerName: string;
  pages: number | null;
  timeCreated: number;
}

export interface SubmitResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SubmitRequest {
  printerName: string;
  filePath: string;
  printSettings: string;
  timeoutMs: number;
}

/**
 * Every Windows-specific operation lives behind this interface so the core
 * (job processing, duplicate prevention, networking) is testable on Linux
 * with a fake. The shipped executable always uses WindowsPrinterBackend.
 */
export interface PrinterBackend {
  readonly kind: string;
  listPrinters(): Promise<PrinterInfo[]>;
  getPrinter(name: string): Promise<PrinterInfo | null>;
  listSpoolerJobs(printerName: string): Promise<SpoolerJob[]>;
  /** Hands the file to the spooler (SumatraPDF). Resolves once the submitting process exits. */
  submitPdf(req: SubmitRequest): Promise<SubmitResult>;
  /** Event 307 entries since the given unix ms. Returns [] when the log is disabled/unavailable. */
  readPrintedEvents(sinceMs: number): Promise<PrintedEvent[]>;
  /** Encrypt a secret for at-rest storage (DPAPI LocalMachine on Windows). */
  protectSecret(plain: string): Promise<string>;
  unprotectSecret(blob: string): Promise<string>;
  /** Restrict a file/dir to SYSTEM + Administrators (icacls on Windows). */
  restrictPath(path: string, isDir: boolean): Promise<void>;
  /** Is the Print Spooler service running? null if unknown. */
  isSpoolerRunning(): Promise<boolean | null>;
  /** Is PowerShell usable? Returns version string or null. */
  powershellVersion(): Promise<string | null>;
}
