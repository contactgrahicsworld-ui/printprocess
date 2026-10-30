import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import type { AgentConfig, ResolvedPaths } from './config.js';
import type { Logger } from './logger.js';
import type { PrinterBackend } from './printer/backend.js';
import { ApiClient, HttpError, NetworkError } from './apiClient.js';
import { JobLog, IN_FLIGHT_STATES, type JobRecord } from './jobLog.js';
import { Outbox } from './outbox.js';
import { DownloadError, IntegrityError, downloadToFile, verifyFile } from './download.js';
import { countPdfPages, imageToPdf } from './pdf.js';
import { PageRangeError, calcSheets, countSelectedPages, isAllPages, parsePageRanges, validateRangesAgainst } from './pageRanges.js';
import { SettingsError, buildPrintSettings } from './sumatra.js';
import { applyOverrides, checkCapabilities, isBlocking, printerStatusToJobStatus } from './capability.js';
import { monitorSpoolerJob, type MonitorResult } from './monitor.js';
import { AGENT_VERSION, type AgentJobStatus, type HeartbeatBody, type PrintJob, type PrinterInfo } from './types.js';

export interface AgentDeps {
  config: AgentConfig;
  paths: ResolvedPaths;
  backend: PrinterBackend;
  api: ApiClient;
  logger: Logger;
  now?: () => number;
  hostname?: string;
  fetchImpl?: typeof fetch;
}

export function sanitizeForFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}

/** Spooler document / temp file name. Windows forbids ':' in file names, so CONTRACT's `MP:{orderNumber}:{jobId}` becomes `MP_{orderNumber}_{jobId}.pdf` (see CONTRACT Changes). */
export function docFileName(job: Pick<PrintJob, 'orderNumber' | 'jobId'>): string {
  return `MP_${sanitizeForFileName(job.orderNumber)}_${sanitizeForFileName(job.jobId)}.pdf`;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class StopError extends Error {}

export class Agent {
  readonly jobLog: JobLog;
  readonly outbox: Outbox;
  private readonly cfg: AgentConfig;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly host: string;
  private stopping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly sleepers = new Set<() => void>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly printerLocks = new Map<string, Mutex>();
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private outboxBackoffUntil = 0;
  private outboxBackoffMs: number;
  private lastPrinters: PrinterInfo[] = [];
  /** last network state for logging transitions */
  online = true;

  constructor(private readonly deps: AgentDeps) {
    this.cfg = deps.config;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
    this.host = deps.hostname ?? osHostname();
    for (const d of [deps.paths.dataDir, deps.paths.tempDir, deps.paths.logDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.jobLog = new JobLog(deps.paths.dataDir, this.now);
    this.outbox = new Outbox(deps.paths.dataDir);
    this.outboxBackoffMs = this.cfg.networkInitialBackoffMs;
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.log.info('agent_start', { version: AGENT_VERSION, backend: this.deps.backend.kind, pendingOutbox: this.outbox.size() });
    try {
      await this.deps.backend.restrictPath(this.deps.paths.tempDir, true);
    } catch (e) {
      this.log.warn('temp_acl_failed', { error: (e as Error).message });
    }
    this.cleanupTemp();
    this.reconcileOnStartup();
    this.kickOutbox();
    this.loop('heartbeat', this.cfg.heartbeatIntervalMs, () => this.heartbeatOnce());
    this.loop('claim', this.cfg.claimIntervalMs, () => this.claimOnce());
    this.loop('housekeeping', 60_000, async () => {
      this.cleanupTemp();
      this.kickOutbox();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const wake of this.sleepers) wake();
    await Promise.allSettled([...this.active.values()]);
    if (this.flushing) await this.flushing.catch(() => undefined);
    this.jobLog.close();
    this.outbox.close();
    this.log.info('agent_stopped');
  }

  /** Waits for all currently running jobs (tests/CLI). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(t);
        this.sleepers.delete(wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  private loop(name: string, intervalMs: number, fn: () => Promise<void>): void {
    let backoff = this.cfg.networkInitialBackoffMs;
    const tick = async (): Promise<void> => {
      if (this.stopping) return;
      let delay = intervalMs;
      try {
        await fn();
        backoff = this.cfg.networkInitialBackoffMs;
        this.setOnline(true);
      } catch (e) {
        const retryable = e instanceof NetworkError || (e instanceof HttpError && e.retryable);
        if (retryable) {
          this.setOnline(false);
          delay = Math.max(Math.min(backoff, this.cfg.networkMaxBackoffMs), Math.min(intervalMs, backoff));
          backoff = Math.min(backoff * 2, this.cfg.networkMaxBackoffMs);
        }
        this.log.warn(`${name}_failed`, { error: (e as Error).message, retryInMs: delay });
      }
      if (this.stopping) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        void tick();
      }, delay + (delay > 1000 ? Math.floor(Math.random() * 250) : 0));
      this.timers.add(t);
    };
    void tick();
  }

  private setOnline(v: boolean): void {
    if (v !== this.online) {
      this.online = v;
      this.log.info(v ? 'network_online' : 'network_offline');
      if (v) {
        this.outboxBackoffUntil = 0;
        this.kickOutbox();
      }
    }
  }

  // ------------------------------------------------------------------ printers / heartbeat

  async discoverPrinters(): Promise<PrinterInfo[]> {
    const all = (await this.deps.backend.listPrinters()).map((p) => applyOverrides(p, this.cfg.printerOverrides));
    const allow = this.cfg.printerAllowlist;
    const list = allow.length ? all.filter((p) => allow.includes(p.name)) : all;
    this.lastPrinters = list;
    return list;
  }

  async heartbeatOnce(): Promise<void> {
    let printers: PrinterInfo[];
    try {
      printers = await this.discoverPrinters();
    } catch (e) {
      this.log.error('printer_discovery_failed', { error: (e as Error).message });
      printers = this.lastPrinters;
    }
    const body: HeartbeatBody = {
      agentVersion: AGENT_VERSION,
      hostname: this.host,
      printers: printers.map((p) => ({
        name: p.name,
        isDefault: p.isDefault,
        status: p.status,
        supportsColor: p.supportsColor,
        supportsDuplex: p.supportsDuplex,
        paperSizes: p.paperSizes,
      })),
    };
    const r = await this.deps.api.heartbeat(body);
    this.log.debug('heartbeat_ok', { printers: printers.length, clockOffsetMs: this.deps.api.clockOffsetMs, serverTime: r.serverTime });
    if (Math.abs(this.deps.api.clockOffsetMs) > 120_000) {
      this.log.warn('clock_skew', { clockOffsetMs: this.deps.api.clockOffsetMs, hint: 'Fix Windows time sync (w32tm /resync); signatures are corrected automatically' });
    }
  }

  // ------------------------------------------------------------------ claim

  async claimOnce(): Promise<void> {
    if (!this.lastPrinters.length) {
      try {
        await this.discoverPrinters();
      } catch (e) {
        this.log.warn('printer_discovery_failed', { error: (e as Error).message });
      }
    }
    const names = this.lastPrinters.length ? this.lastPrinters.map((p) => p.name) : this.cfg.printerAllowlist;
    const { jobs } = await this.deps.api.claim(names);
    for (const job of jobs) this.handleClaimed(job);
  }

  /** Entry for every job the server hands us (including repeated/idempotent re-claims). */
  handleClaimed(job: PrintJob): void {
    if (!job || typeof job.jobId !== 'string' || !Number.isInteger(job.attempt)) {
      this.log.error('claim_invalid_job', { job: job as unknown as Record<string, unknown> });
      return;
    }
    const existing = this.jobLog.get(job.jobId, job.attempt);
    const key = existing?.key ?? `${job.jobId}#${job.attempt}`;
    if (this.active.has(key)) {
      this.log.debug('claim_duplicate_active', { jobId: job.jobId, attempt: job.attempt });
      return;
    }
    if (existing) {
      if (existing.state === 'FINAL') {
        this.log.info('claim_duplicate_final', { jobId: job.jobId, attempt: job.attempt, finalStatus: existing.finalStatus });
        return;
      }
      if (IN_FLIGHT_STATES.includes(existing.state)) {
        // Already handed to the spooler; never submit again. Resume monitoring only.
        this.run(key, () => this.resumeInFlight(existing));
        return;
      }
      // Pre-submit: refresh job (new signed URL) and continue.
      const rec = this.jobLog.update(key, { job: { ...existing.job, downloadUrl: job.downloadUrl } });
      this.run(key, () => this.processJob(rec));
      return;
    }
    const rec = this.jobLog.create(job);
    this.log.info('job_claimed', { jobId: job.jobId, attempt: job.attempt, orderNumber: job.orderNumber, printer: job.printerName, settings: job.settings });
    this.run(key, () => this.processJob(rec));
  }

  private run(key: string, fn: () => Promise<void>): void {
    const p = (async () => {
      try {
        await fn();
      } catch (e) {
        if (!(e instanceof StopError)) this.log.error('job_unhandled_error', { key, error: (e as Error).stack ?? String(e) });
      } finally {
        this.active.delete(key);
      }
    })();
    this.active.set(key, p);
  }

  // ------------------------------------------------------------------ status reporting

  report(rec: JobRecord, status: AgentJobStatus, detail: string, extra: { spoolerJobId?: number | null; pagesPrinted?: number | null } = {}): JobRecord {
    this.outbox.enqueue(rec.jobId, {
      status,
      spoolerJobId: extra.spoolerJobId ?? rec.spoolerJobId ?? null,
      detail: detail.slice(0, 1000),
      pagesPrinted: extra.pagesPrinted ?? null,
      at: this.now(),
    });
    this.log.info('job_status', { jobId: rec.jobId, attempt: rec.attempt, status, detail, ...extra });
    const updated = this.jobLog.update(rec.key, { lastReportedStatus: status });
    this.kickOutbox();
    return updated;
  }

  private finalize(rec: JobRecord, status: AgentJobStatus, detail: string, extra: { spoolerJobId?: number | null; pagesPrinted?: number | null } = {}): void {
    const r = this.report(rec, status, detail, extra);
    this.jobLog.update(r.key, { state: 'FINAL', finalStatus: status, finalDetail: detail, finalAt: this.now(), spoolerJobId: extra.spoolerJobId ?? r.spoolerJobId });
    this.cleanupTemp();
  }

  kickOutbox(): void {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        await this.flushOutbox();
      } while (this.flushAgain && !this.stopping && this.now() >= this.outboxBackoffUntil);
    })().finally(() => {
      this.flushing = null;
    });
  }

  /** Sends queued status updates strictly in order. Stops at the first retryable failure. */
  async flushOutbox(): Promise<void> {
    if (this.now() < this.outboxBackoffUntil) return;
    for (;;) {
      if (this.stopping) return;
      const item = this.outbox.peek();
      if (!item) return;
      try {
        await this.deps.api.postStatus(item.jobId, item.body);
        this.outbox.ack(item.seq);
        this.outboxBackoffMs = this.cfg.networkInitialBackoffMs;
        this.log.debug('status_sent', { seq: item.seq, jobId: item.jobId, status: item.body.status });
      } catch (e) {
        if (e instanceof HttpError && !e.retryable) {
          this.log.error('status_rejected_dropped', { seq: item.seq, jobId: item.jobId, status: item.body.status, http: e.status, body: e.body.slice(0, 300) });
          this.outbox.ack(item.seq, true);
          continue;
        }
        this.setOnline(false);
        const wait = this.outboxBackoffMs;
        this.outboxBackoffMs = Math.min(this.outboxBackoffMs * 2, this.cfg.networkMaxBackoffMs);
        this.outboxBackoffUntil = this.now() + wait;
        this.log.warn('status_send_failed', { seq: item.seq, error: (e as Error).message, pending: this.outbox.size(), retryInMs: wait });
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.kickOutbox();
        }, wait);
        this.timers.add(t);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ job processing

  private lockFor(printer: string): Mutex {
    let m = this.printerLocks.get(printer);
    if (!m) {
      m = new Mutex();
      this.printerLocks.set(printer, m);
    }
    return m;
  }

  private async resolvePrinterName(job: PrintJob): Promise<string | null> {
    if (job.printerName) return job.printerName;
    if (this.cfg.defaultPrinter) return this.cfg.defaultPrinter;
    const list = this.lastPrinters.length ? this.lastPrinters : await this.discoverPrinters();
    return list.find((p) => p.isDefault)?.name ?? null;
  }

  private async getPrinter(name: string): Promise<PrinterInfo | null> {
    const p = await this.deps.backend.getPrinter(name);
    return p ? applyOverrides(p, this.cfg.printerOverrides) : null;
  }

  async processJob(recIn: JobRecord): Promise<void> {
    let rec = recIn;
    const job = rec.job;
    const s = job.settings;

    // 1. printer selection
    const printerName = rec.printerName ?? (await this.resolvePrinterName(job));
    if (!printerName) return this.finalize(rec, 'ERROR', 'no printer specified for job and no default printer configured/found');
    if (this.cfg.printerAllowlist.length && !this.cfg.printerAllowlist.includes(printerName)) {
      return this.finalize(rec, 'ERROR', `printer "${printerName}" is not in this agent's printerAllowlist`);
    }
    if (rec.printerName !== printerName) rec = this.jobLog.update(rec.key, { printerName });

    // 2. download + verify + prepare
    if (rec.state === 'RECEIVED' || !rec.filePath || !existsSync(rec.filePath)) {
      const prepared = await this.downloadAndPrepare(rec);
      if (!prepared) return;
      rec = prepared;
    }

    // 3. settings string (validated again; cheap)
    let printSettings: string;
    try {
      printSettings = buildPrintSettings(s, { scaling: this.cfg.sumatraScaling, isImage: job.mimeType.startsWith('image/') });
    } catch (e) {
      return this.finalize(rec, 'ERROR', `invalid print settings: ${(e as Error).message}`);
    }

    // 4. wait for printer to be ready (job stays claimed), check capability
    const ready = await this.waitForPrinter(rec, printerName);
    if (!ready) return;
    rec = ready;

    // 5. submit exactly once
    await this.lockFor(printerName).run(async () => {
      if (this.stopping) throw new StopError();
      // re-check just before submit (state may have changed while waiting for the lock)
      const p = await this.getPrinter(printerName).catch(() => null);
      if (!p || isBlocking(p.status)) {
        this.log.warn('printer_changed_before_submit', { printer: printerName, status: p?.status });
        return; // leave pre-submit; processJob will be re-run below
      }
      const cur = this.jobLog.get(rec.jobId, rec.attempt);
      if (!cur || cur.state !== rec.state || IN_FLIGHT_STATES.includes(cur.state) || cur.state === 'FINAL') {
        this.log.error('duplicate_submit_prevented', { jobId: rec.jobId, attempt: rec.attempt, state: cur?.state });
        return;
      }
      const submittedAt = this.now();
      // DURABLE MARKER BEFORE HANDING TO SPOOLER (fsync inside JobLog.update)
      rec = this.jobLog.update(rec.key, { state: 'SUBMITTING', submittedAt });
      this.log.info('job_submitting', { jobId: rec.jobId, attempt: rec.attempt, printer: printerName, printSettings, file: rec.filePath });
      const res = await this.deps.backend.submitPdf({ printerName, filePath: rec.filePath!, printSettings, timeoutMs: this.cfg.submitTimeoutMs });
      this.log.info('sumatra_exit', { jobId: rec.jobId, exitCode: res.exitCode, timedOut: res.timedOut, stderr: res.stderr.slice(0, 500) });
      if (res.exitCode === null && !res.timedOut) {
        // Process could not even be started: nothing reached the spooler.
        this.finalize(rec, 'ERROR', `SumatraPDF could not be started (${res.stderr.trim().slice(0, 200)}); check sumatraPath. Not printed.`);
        return;
      }
      rec = this.jobLog.update(rec.key, { state: 'SUBMITTED' });
      const note = res.timedOut ? ' (SumatraPDF timed out; checking spooler)' : res.exitCode !== 0 ? ` (SumatraPDF exit code ${res.exitCode}; checking spooler)` : '';
      rec = this.report(rec, 'SUBMITTED', `submitted to "${printerName}" with -print-settings "${printSettings}"${note}`);
    });

    const after = this.jobLog.get(rec.jobId, rec.attempt)!;
    if (after.state === 'FINAL') return;
    if (after.state === 'DOWNLOADED' || after.state === 'WAITING_PRINTER') {
      if (this.stopping) return;
      return this.processJob(after); // printer went bad right before submit: wait again
    }
    await this.monitor(after, false);
  }

  private async downloadAndPrepare(rec0: JobRecord): Promise<JobRecord | null> {
    let rec = rec0;
    const job = rec.job;
    const workDir = join(this.deps.paths.tempDir, `${sanitizeForFileName(job.jobId)}-${job.attempt}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    if (rec.workDir !== workDir) rec = this.jobLog.update(rec.key, { workDir });
    const srcPath = join(workDir, 'source.bin');
    const printPath = join(workDir, docFileName(job));
    let dl;
    try {
      dl = await downloadToFile(job.downloadUrl, srcPath, {
        maxBytes: this.cfg.maxDownloadBytes,
        timeoutMs: Math.max(this.cfg.requestTimeoutMs, 120_000),
        allowInsecureLocalhost: this.cfg.allowInsecureLocalhost,
        fetchImpl: this.deps.fetchImpl,
      });
    } catch (e) {
      const de = e as DownloadError;
      if (de instanceof DownloadError && (de.kind === 'too_large' || de.kind === 'url')) {
        this.finalize(rec, 'FAILED', `download rejected: ${de.message}`);
        return null;
      }
      // network / expired URL: keep job claimed; the next claim returns it with a fresh signed URL.
      this.log.warn('download_failed_will_retry', { jobId: job.jobId, error: (e as Error).message });
      return null;
    }
    let type;
    try {
      type = verifyFile(srcPath, dl.sha256, job.sha256, job.mimeType);
    } catch (e) {
      if (e instanceof IntegrityError) {
        this.finalize(rec, 'FAILED', `file integrity check failed: ${e.message}. Not printed.`);
        return null;
      }
      throw e;
    }

    // Prepare the PDF that will be printed (spooler document name derives from this file name).
    let pages: number | null;
    try {
      if (type === 'pdf') {
        renameSync(srcPath, printPath);
        pages = await countPdfPages(printPath);
      } else {
        await imageToPdf(srcPath, type, job.settings.paperSize, printPath, { title: docFileName(job) });
        rmSync(srcPath, { force: true });
        pages = 1;
      }
    } catch (e) {
      this.finalize(rec, 'FAILED', `could not prepare file for printing: ${(e as Error).message}`);
      return null;
    }

    // Page range validation
    let selected = pages ?? 0;
    try {
      const pr = job.settings.pageRanges;
      if (type !== 'pdf') {
        if (!isAllPages(pr) && !/^\s*1\s*(-\s*1\s*)?$/.test(pr!)) throw new PageRangeError(`image has 1 page; page range "${pr}" invalid`);
        selected = 1;
      } else if (!isAllPages(pr)) {
        const ranges = parsePageRanges(pr!);
        if (pages !== null) {
          const err = validateRangesAgainst(ranges, pages);
          if (err) throw new PageRangeError(err);
        }
        selected = pages !== null ? countSelectedPages(ranges, pages) : countSelectedPages(ranges, Number.MAX_SAFE_INTEGER);
      }
      buildPrintSettings(job.settings, { scaling: this.cfg.sumatraScaling, isImage: type !== 'pdf' });
    } catch (e) {
      if (e instanceof PageRangeError || e instanceof SettingsError) {
        this.finalize(rec, 'ERROR', `invalid job settings: ${e.message}`);
        return null;
      }
      throw e;
    }
    const sheets = calcSheets(selected, job.settings.duplex, job.settings.copies);
    rec = this.jobLog.update(rec.key, { state: 'DOWNLOADED', filePath: printPath, workDir, docName: docFileName(job) });
    rec = this.report(
      rec,
      'DOWNLOADED',
      `sha256 verified (${dl.bytes} bytes, ${type}); document pages=${pages ?? 'unknown'}; selected=${sheets.pagesSelected}; sheets=${sheets.totalSheets}; sides=${sheets.printedSides}`,
    );
    return rec;
  }

  /** Returns the record once printer is ready & capable; null if finalized or stopping. */
  private async waitForPrinter(rec0: JobRecord, printerName: string): Promise<JobRecord | null> {
    let rec = rec0;
    let backoff = this.cfg.printerWaitInitialMs;
    let lastStatus: string | null = null;
    for (;;) {
      if (this.stopping) return null;
      let p: PrinterInfo | null = null;
      let queryError: string | null = null;
      try {
        p = await this.getPrinter(printerName);
      } catch (e) {
        queryError = (e as Error).message;
      }
      if (p && !isBlocking(p.status)) {
        const capErr = checkCapabilities(p, rec.job.settings);
        if (capErr) {
          this.finalize(rec, 'ERROR', capErr);
          return null;
        }
        if (rec.state === 'WAITING_PRINTER') rec = this.jobLog.update(rec.key, { state: 'DOWNLOADED', waitingSince: null });
        return rec;
      }
      // Not ready. Per the server state machine PRINTER_OFFLINE / PAPER_OUT / ERROR are TERMINAL
      // (staff may re-queue → new job row). Reporting one now and printing later could print twice,
      // so while waiting we keep the job CLAIMED/DOWNLOADED on the server and surface the printer
      // problem through an immediate heartbeat (printer status). Only when maxPrinterWaitMs expires
      // do we send the matching failure status as FINAL ("not printed; safe to re-queue").
      const waitingSince = rec.waitingSince ?? this.now();
      if (rec.state !== 'WAITING_PRINTER' || rec.waitingSince === null) rec = this.jobLog.update(rec.key, { state: 'WAITING_PRINTER', waitingSince });
      const cond = p ? p.status : queryError ? 'QueryFailed' : 'NotFound';
      const detail = p
        ? `printer "${printerName}" is ${p.status} (${p.statusDetail})`
        : queryError
          ? `cannot query printer "${printerName}": ${queryError}`
          : `printer "${printerName}" not found on this PC (or not visible to the service account)`;
      if (cond !== lastStatus) {
        lastStatus = cond;
        this.log.warn('printer_not_ready_waiting', { jobId: rec.jobId, attempt: rec.attempt, printer: printerName, condition: cond, detail, maxWaitMs: this.cfg.maxPrinterWaitMs });
        void this.heartbeatOnce().catch(() => undefined); // show printer state on dashboard now
      }
      if (this.now() - waitingSince >= this.cfg.maxPrinterWaitMs) {
        const st: AgentJobStatus = p ? printerStatusToJobStatus(p.status) : cond === 'NotFound' ? 'ERROR' : 'PRINTER_OFFLINE';
        this.finalize(
          rec,
          st,
          `${detail}; waited ${Math.round((this.now() - waitingSince) / 1000)}s before submit. Job was NOT sent to the printer — safe to re-queue after fixing the printer.`,
        );
        return null;
      }
      await this.sleep(Math.min(backoff, Math.max(1, waitingSince + this.cfg.maxPrinterWaitMs - this.now())));
      backoff = Math.min(backoff * 2, this.cfg.printerWaitMaxBackoffMs);
    }
  }

  private async monitor(rec0: JobRecord, resumed: boolean): Promise<void> {
    let rec = rec0;
    const printerName = rec.printerName!;
    const otherAttemptIds = this.jobLog
      .all()
      .filter((r) => r.jobId === rec.jobId && r.attempt !== rec.attempt && r.spoolerJobId !== null)
      .map((r) => r.spoolerJobId as number);
    const result: MonitorResult = await monitorSpoolerJob({
      backend: this.deps.backend,
      logger: this.log,
      printerName,
      docToken: rec.jobId,
      submittedAt: rec.submittedAt ?? this.now(),
      knownSpoolerJobId: rec.spoolerJobId,
      previouslySeen: rec.state === 'SPOOLED' || rec.state === 'PRINTING',
      resumed,
      pollMs: this.cfg.spoolerPollMs,
      notObservedTimeoutMs: this.cfg.notObservedTimeoutMs,
      monitorTimeoutMs: this.cfg.monitorTimeoutMs,
      eventLog307: this.cfg.eventLog307,
      eventLog307WaitMs: this.cfg.eventLog307WaitMs,
      excludeSpoolerIds: otherAttemptIds,
      shouldStop: () => this.stopping,
      sleep: (ms) => this.sleep(ms),
      now: this.now,
      onEmit: (e) => {
        if (e.status === 'SPOOLED') rec = this.jobLog.update(rec.key, { state: 'SPOOLED', spoolerJobId: e.spoolerJobId });
        else if (e.status === 'PRINTING') rec = this.jobLog.update(rec.key, { state: 'PRINTING', spoolerJobId: e.spoolerJobId });
        rec = this.report(rec, e.status, e.detail, { spoolerJobId: e.spoolerJobId, pagesPrinted: e.pagesPrinted });
      },
    });
    if (result.aborted) return; // stays in-flight; reconciled on next start
    this.finalize(rec, result.status, result.detail, { spoolerJobId: result.spoolerJobId, pagesPrinted: result.pagesPrinted });
  }

  private async resumeInFlight(rec: JobRecord): Promise<void> {
    this.log.warn('reconcile_in_flight', { jobId: rec.jobId, attempt: rec.attempt, state: rec.state, spoolerJobId: rec.spoolerJobId });
    if (rec.state === 'SUBMITTING') rec = this.jobLog.update(rec.key, { state: 'SUBMITTED' });
    await this.monitor(rec, true);
  }

  /** On start: in-flight jobs are looked up in the spooler (never resubmitted); pre-submit jobs resume. */
  reconcileOnStartup(): void {
    for (const rec of this.jobLog.all()) {
      if (rec.state === 'FINAL') continue;
      if (IN_FLIGHT_STATES.includes(rec.state)) this.run(rec.key, () => this.resumeInFlight(rec));
      else this.run(rec.key, () => this.processJob(rec));
    }
  }

  cleanupTemp(): void {
    const keepMs = this.cfg.keepTempHours * 3600_000;
    for (const rec of this.jobLog.all()) {
      if (rec.state !== 'FINAL' || rec.tempDeleted) continue;
      if ((rec.finalAt ?? 0) + keepMs > this.now()) continue;
      try {
        if (rec.workDir && existsSync(rec.workDir) && statSync(rec.workDir).isDirectory()) rmSync(rec.workDir, { recursive: true, force: true });
        this.jobLog.update(rec.key, { tempDeleted: true });
      } catch (e) {
        this.log.warn('temp_cleanup_failed', { jobId: rec.jobId, error: (e as Error).message });
      }
    }
  }
}
