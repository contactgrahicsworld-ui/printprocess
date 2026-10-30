import { existsSync } from 'node:fs';
import type { PrinterInfo } from '../../src/types.js';
import type { PrintedEvent, PrinterBackend, SpoolerFlag, SpoolerJob, SubmitRequest, SubmitResult } from '../../src/printer/backend.js';

/** One snapshot of how our spooler job looks on a given poll. 'gone' = left queue. */
export type Phase = { flags: SpoolerFlag[]; pagesPrinted?: number | null; totalPages?: number | null } | 'gone';

export interface Submission extends SubmitRequest {
  at: number;
  spoolerJobId: number | null;
}

interface LiveJob {
  job: SpoolerJob;
  phases: Phase[];
  idx: number;
}

/** In-memory fake of the Windows printer/spooler, used ONLY by tests. */
export class FakeBackend implements PrinterBackend {
  readonly kind = 'fake';
  printers = new Map<string, PrinterInfo>();
  submissions: Submission[] = [];
  events: PrintedEvent[] = [];
  live = new Map<string, LiveJob[]>();
  nextSpoolerId = 10;
  /** scenario applied to the next submission; 'never' = job never shows in the queue */
  scenario: Phase[] | 'never' = defaultScenario(2);
  /** called on each listSpoolerJobs to let a test mutate printers mid-job */
  onPoll: ((poll: number) => void) | null = null;
  polls = 0;
  failSpoolerPolls = 0;

  addPrinter(p: Partial<PrinterInfo> & { name: string }): PrinterInfo {
    const info: PrinterInfo = {
      isDefault: false,
      status: 'Normal',
      statusDetail: 'flags=Normal',
      supportsColor: true,
      supportsDuplex: true,
      paperSizes: ['A4', 'A3', 'Legal'],
      ...p,
    };
    this.printers.set(info.name, info);
    return info;
  }

  setStatus(name: string, status: PrinterInfo['status']): void {
    const p = this.printers.get(name);
    if (p) p.status = status;
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    return [...this.printers.values()].map((p) => ({ ...p }));
  }

  async getPrinter(name: string): Promise<PrinterInfo | null> {
    const p = this.printers.get(name);
    return p ? { ...p } : null;
  }

  async listSpoolerJobs(printerName: string): Promise<SpoolerJob[]> {
    this.polls++;
    this.onPoll?.(this.polls);
    if (this.failSpoolerPolls > 0) {
      this.failSpoolerPolls--;
      throw new Error('simulated PowerShell failure');
    }
    const out: SpoolerJob[] = [];
    const list = this.live.get(printerName) ?? [];
    const remaining: LiveJob[] = [];
    for (const lj of list) {
      const ph = lj.phases[Math.min(lj.idx, lj.phases.length - 1)]!;
      lj.idx++;
      if (ph === 'gone') continue;
      remaining.push(lj);
      lj.job.flags = ph.flags;
      lj.job.rawStatus = ph.flags.join(', ');
      if (ph.pagesPrinted !== undefined) lj.job.pagesPrinted = ph.pagesPrinted;
      if (ph.totalPages !== undefined) lj.job.totalPages = ph.totalPages;
      out.push({ ...lj.job, flags: [...lj.job.flags] });
    }
    this.live.set(printerName, remaining);
    return out;
  }

  async submitPdf(req: SubmitRequest): Promise<SubmitResult> {
    if (!existsSync(req.filePath)) return { exitCode: 1, timedOut: false, stdout: '', stderr: 'file missing' };
    const docName = req.filePath.split(/[\\/]/).pop()!;
    let id: number | null = null;
    if (this.scenario !== 'never') {
      id = this.nextSpoolerId++;
      const job: SpoolerJob = {
        id,
        printerName: req.printerName,
        document: docName,
        flags: ['Spooling'],
        rawStatus: 'Spooling',
        totalPages: null,
        pagesPrinted: null,
        submittedAt: Date.now(),
      };
      const list = this.live.get(req.printerName) ?? [];
      list.push({ job, phases: this.scenario, idx: 0 });
      this.live.set(req.printerName, list);
    }
    this.submissions.push({ ...req, at: Date.now(), spoolerJobId: id });
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  }

  async readPrintedEvents(sinceMs: number): Promise<PrintedEvent[]> {
    return this.events.filter((e) => e.timeCreated >= sinceMs);
  }

  async protectSecret(plain: string): Promise<string> {
    return 'FAKE:' + Buffer.from(plain).toString('base64');
  }
  async unprotectSecret(blob: string): Promise<string> {
    return Buffer.from(blob.replace(/^FAKE:/, ''), 'base64').toString();
  }
  async restrictPath(): Promise<void> {}
  async isSpoolerRunning(): Promise<boolean | null> {
    return true;
  }
  async powershellVersion(): Promise<string | null> {
    return 'fake';
  }
}

export function defaultScenario(pages: number): Phase[] {
  const phases: Phase[] = [{ flags: ['Spooling'], totalPages: pages, pagesPrinted: 0 }];
  for (let i = 0; i < pages; i++) phases.push({ flags: ['Printing'], totalPages: pages, pagesPrinted: i });
  phases.push({ flags: ['Printing'], totalPages: pages, pagesPrinted: pages });
  phases.push('gone');
  return phases;
}
