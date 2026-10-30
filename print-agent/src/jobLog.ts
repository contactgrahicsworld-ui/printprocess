import { join } from 'node:path';
import { DurableJsonl } from './jsonl.js';
import type { AgentJobStatus, PrintJob } from './types.js';

/**
 * Local job states. The critical one is SUBMITTING: it is fsync'd to disk BEFORE SumatraPDF
 * is started, so after any crash/restart the agent knows the file may already be in the
 * spooler and will never hand it over a second time for the same jobId+attempt.
 */
export type LocalJobState =
  | 'RECEIVED'
  | 'DOWNLOADED'
  | 'WAITING_PRINTER'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'SPOOLED'
  | 'PRINTING'
  | 'FINAL';

export interface JobRecord {
  key: string;
  jobId: string;
  attempt: number;
  state: LocalJobState;
  job: PrintJob;
  printerName: string | null;
  filePath: string | null;
  workDir: string | null;
  docName: string | null;
  submittedAt: number | null;
  spoolerJobId: number | null;
  waitingSince: number | null;
  lastReportedStatus: AgentJobStatus | null;
  finalStatus: AgentJobStatus | null;
  finalDetail: string | null;
  finalAt: number | null;
  tempDeleted: boolean;
  updatedAt: number;
}

export function jobKey(jobId: string, attempt: number): string {
  return `${jobId}#${attempt}`;
}

export const IN_FLIGHT_STATES: readonly LocalJobState[] = ['SUBMITTING', 'SUBMITTED', 'SPOOLED', 'PRINTING'];

export class JobLog {
  private readonly file: DurableJsonl<JobRecord>;
  private readonly map = new Map<string, JobRecord>();

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = new DurableJsonl<JobRecord>(join(dataDir, 'jobs.jsonl'));
    for (const r of this.file.readAll()) if (r && typeof r.key === 'string') this.map.set(r.key, r);
    this.compact();
  }

  /** Keep one line per job; drop FINAL jobs older than 14 days. */
  compact(): void {
    const cutoff = this.now() - 14 * 24 * 3600 * 1000;
    for (const [k, r] of this.map) {
      if (r.state === 'FINAL' && r.tempDeleted && (r.finalAt ?? r.updatedAt) < cutoff) this.map.delete(k);
    }
    this.file.rewrite([...this.map.values()]);
  }

  get(jobId: string, attempt: number): JobRecord | undefined {
    return this.map.get(jobKey(jobId, attempt));
  }

  all(): JobRecord[] {
    return [...this.map.values()];
  }

  create(job: PrintJob): JobRecord {
    const key = jobKey(job.jobId, job.attempt);
    const existing = this.map.get(key);
    if (existing) return existing;
    const rec: JobRecord = {
      key,
      jobId: job.jobId,
      attempt: job.attempt,
      state: 'RECEIVED',
      job,
      printerName: null,
      filePath: null,
      workDir: null,
      docName: null,
      submittedAt: null,
      spoolerJobId: null,
      waitingSince: null,
      lastReportedStatus: null,
      finalStatus: null,
      finalDetail: null,
      finalAt: null,
      tempDeleted: false,
      updatedAt: this.now(),
    };
    this.persist(rec);
    return rec;
  }

  update(key: string, patch: Partial<Omit<JobRecord, 'key' | 'jobId' | 'attempt'>>): JobRecord {
    const cur = this.map.get(key);
    if (!cur) throw new Error(`unknown job ${key}`);
    // FINAL is terminal locally: never move out of it (except bookkeeping fields).
    if (cur.state === 'FINAL' && patch.state && patch.state !== 'FINAL') {
      throw new Error(`job ${key} is FINAL; refusing transition to ${patch.state}`);
    }
    const next: JobRecord = { ...cur, ...patch, updatedAt: this.now() };
    this.persist(next);
    return next;
  }

  private persist(rec: JobRecord): void {
    this.file.append(rec); // fsync'd before we return
    this.map.set(rec.key, rec);
  }

  close(): void {
    this.file.close();
  }
}
