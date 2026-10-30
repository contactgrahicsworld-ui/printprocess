/**
 * Types mirroring /workspace/work/qr-print/CONTRACT.md (binding).
 */

export const AGENT_VERSION = '1.0.0';

export type ColorMode = 'BW' | 'COLOR';
export type DuplexMode = 'SINGLE' | 'DOUBLE';
export type PaperSize = 'A4' | 'A3' | 'LEGAL';

export interface JobSettings {
  colorMode: ColorMode;
  duplex: DuplexMode;
  paperSize: PaperSize;
  copies: number;
  pageRanges: string | null;
}

/** PrintJob as returned by POST /api/agent/jobs/claim */
export interface PrintJob {
  jobId: string;
  orderNumber: string;
  orderItemId: string;
  attempt: number;
  printerName: string | null;
  fileName: string;
  mimeType: string;
  sha256: string;
  downloadUrl: string;
  settings: JobSettings;
}

/** Status values the agent may send (never VERIFIED, never CLAIMED/QUEUED). */
export type AgentJobStatus =
  | 'DOWNLOADED'
  | 'SUBMITTED'
  | 'SPOOLED'
  | 'PRINTING'
  | 'COMPLETED_SPOOLER'
  | 'FAILED'
  | 'PRINTER_OFFLINE'
  | 'PAPER_OUT'
  | 'ERROR';

export const AGENT_JOB_STATUSES: readonly AgentJobStatus[] = [
  'DOWNLOADED',
  'SUBMITTED',
  'SPOOLED',
  'PRINTING',
  'COMPLETED_SPOOLER',
  'FAILED',
  'PRINTER_OFFLINE',
  'PAPER_OUT',
  'ERROR',
];

/** Body of POST /api/agent/jobs/{jobId}/status */
export interface StatusUpdateBody {
  status: AgentJobStatus;
  spoolerJobId: number | null;
  detail: string;
  pagesPrinted: number | null;
  at: number;
}

/** CONTRACT printer status strings ("Normal|Offline|PaperOut|Error|..."). */
export type PrinterStatus =
  | 'Normal'
  | 'Printing'
  | 'Offline'
  | 'PaperOut'
  | 'PaperJam'
  | 'Paused'
  | 'DoorOpen'
  | 'TonerOut'
  | 'UserIntervention'
  | 'Error'
  | 'Unknown';

/** Statuses that block submission of a new job. */
export const BLOCKING_PRINTER_STATUSES: readonly PrinterStatus[] = [
  'Offline',
  'PaperOut',
  'PaperJam',
  'Paused',
  'DoorOpen',
  'TonerOut',
  'UserIntervention',
  'Error',
];

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  status: PrinterStatus;
  /** Human-readable detail of why the status is what it is (raw flags). */
  statusDetail: string;
  supportsColor: boolean;
  supportsDuplex: boolean;
  /** Normalised to contract names where possible: "A4", "A3", "Legal", plus others as reported. */
  paperSizes: string[];
}

export interface HeartbeatPrinter {
  name: string;
  isDefault: boolean;
  status: PrinterStatus;
  supportsColor: boolean;
  supportsDuplex: boolean;
  paperSizes: string[];
}

export interface HeartbeatBody {
  agentVersion: string;
  hostname: string;
  printers: HeartbeatPrinter[];
}

export interface HeartbeatResponse {
  ok: boolean;
  serverTime: number;
}

export interface ClaimResponse {
  jobs: PrintJob[];
}
