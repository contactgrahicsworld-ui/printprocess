/**
 * Spooler monitoring after submission. Decides SPOOLED / PRINTING / error / COMPLETED_SPOOLER.
 *
 * Rules (never claim completion without evidence):
 *  - SPOOLED when the job is first found in the printer queue (by document name containing the
 *    job id, or by remembered spooler job id after restart).
 *  - PRINTING when JobStatus has Printing.
 *  - PAPER_OUT / PRINTER_OFFLINE / ERROR when the job carries PaperOut / Offline / Error,
 *    UserIntervention, BlockedDevQ flags (each reported once).
 *  - COMPLETED_SPOOLER only when the job left the queue (or is Retained/Printed/Complete with
 *    "Keep printed documents") with NO error ever seen AND, if the spooler exposed page counts,
 *    PagesPrinted >= TotalPages, or the Printed flag / event 307 was seen.
 *  - Never observed in the spooler within notObservedTimeoutMs → ERROR "not observed in spooler"
 *    (unless event 307 confirms it, when that source is enabled).
 */
import type { AgentJobStatus } from './types.js';
import type { PrintedEvent, PrinterBackend, SpoolerFlag, SpoolerJob } from './printer/backend.js';
import type { Logger } from './logger.js';

export interface MonitorEmit {
  status: AgentJobStatus;
  spoolerJobId: number | null;
  pagesPrinted: number | null;
  detail: string;
}

export interface MonitorResult {
  status: AgentJobStatus;
  detail: string;
  spoolerJobId: number | null;
  pagesPrinted: number | null;
  /** monitoring was aborted because the agent is stopping: no final status decided */
  aborted?: boolean;
}

export interface MonitorParams {
  backend: PrinterBackend;
  logger: Logger;
  printerName: string;
  /** token that must appear in the spooler Document name (the job id) */
  docToken: string;
  submittedAt: number;
  knownSpoolerJobId: number | null;
  /** job was already observed in the spooler before an agent restart */
  previouslySeen: boolean;
  /** monitoring resumed after a restart: there is an unobserved gap */
  resumed: boolean;
  pollMs: number;
  notObservedTimeoutMs: number;
  monitorTimeoutMs: number;
  eventLog307: 'off' | 'confirm' | 'require';
  eventLog307WaitMs: number;
  /** spooler ids already used by other attempts of this job (don't match them) */
  excludeSpoolerIds?: number[];
  onEmit: (e: MonitorEmit) => Promise<void> | void;
  shouldStop: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const ERROR_FLAG_STATUS: Array<[SpoolerFlag, AgentJobStatus]> = [
  ['PaperOut', 'PAPER_OUT'],
  ['Offline', 'PRINTER_OFFLINE'],
  ['Error', 'ERROR'],
  ['UserIntervention', 'ERROR'],
  ['BlockedDevQ', 'ERROR'],
];

/** Find our job in the queue snapshot. */
export function matchSpoolerJob(jobs: SpoolerJob[], p: { docToken: string; knownSpoolerJobId: number | null; submittedAt: number; excludeIds?: number[] }): SpoolerJob | undefined {
  const token = p.docToken.toLowerCase();
  const byDoc = (j: SpoolerJob): boolean => j.document.toLowerCase().includes(token);
  if (p.knownSpoolerJobId !== null) {
    const j = jobs.find((x) => x.id === p.knownSpoolerJobId);
    // Spooler ids are reused after a spooler restart: require the document to match too when it is visible.
    if (j && (j.document === '' || byDoc(j))) return j;
  }
  const windowStart = p.submittedAt - 120_000; // allow some clock fuzz between spooler and agent
  const cands = jobs.filter((j) => byDoc(j) && !(p.excludeIds ?? []).includes(j.id) && (j.submittedAt === null || j.submittedAt >= windowStart));
  cands.sort((a, b) => b.id - a.id);
  return cands[0];
}

export function matchPrintedEvent(events: PrintedEvent[], p: { printerName: string; spoolerJobId: number | null; docToken: string; submittedAt: number }): PrintedEvent | undefined {
  const token = p.docToken.toLowerCase();
  return events.find((e) => {
    if (e.timeCreated < p.submittedAt - 5000) return false;
    if (e.printerName && e.printerName !== p.printerName) return false;
    const docOk = e.document.toLowerCase().includes(token);
    // Windows hides document names in event 307 by default ("Print Document"): fall back to job id.
    const idOk = p.spoolerJobId !== null && e.spoolerJobId === p.spoolerJobId;
    return docOk || idOk;
  });
}

export async function monitorSpoolerJob(p: MonitorParams): Promise<MonitorResult> {
  const startedAt = p.now();
  let seen = p.previouslySeen;
  let spoolerId: number | null = p.knownSpoolerJobId;
  let reportedSpooled = p.previouslySeen;
  let reportedPrinting = false;
  const reportedErrors = new Set<AgentJobStatus>();
  const errorFlagsSeen = new Set<SpoolerFlag>();
  let deletedSeen = false;
  let printedFlag = false;
  let maxPagesPrinted: number | null = null;
  let totalPages: number | null = null;
  let consecutivePollFailures = 0;
  const notObservedDeadline = Math.max(p.submittedAt + p.notObservedTimeoutMs, p.resumed ? startedAt + 3 * p.pollMs : 0);

  const emit = async (status: AgentJobStatus, detail: string): Promise<void> => {
    await p.onEmit({ status, spoolerJobId: spoolerId, pagesPrinted: maxPagesPrinted, detail });
  };

  const findEvent = async (waitMs: number): Promise<PrintedEvent | undefined> => {
    if (p.eventLog307 === 'off') return undefined;
    const until = p.now() + waitMs;
    for (;;) {
      const ev = matchPrintedEvent(await p.backend.readPrintedEvents(p.submittedAt - 5000), {
        printerName: p.printerName,
        spoolerJobId: spoolerId,
        docToken: p.docToken,
        submittedAt: p.submittedAt,
      });
      if (ev || p.now() >= until || p.shouldStop()) return ev;
      await p.sleep(Math.min(p.pollMs, 1000));
    }
  };

  const pagesText = (): string => `pagesPrinted=${maxPagesPrinted ?? 'n/a'} totalPages=${totalPages ?? 'n/a'}`;

  const finishLeftQueue = async (how: string): Promise<MonitorResult> => {
    const base = { spoolerJobId: spoolerId, pagesPrinted: maxPagesPrinted };
    if (deletedSeen && !printedFlag) {
      return { ...base, status: 'FAILED', detail: `job was deleted/cancelled from the Windows print queue (${pagesText()}); not printed by agent — re-queue if needed` };
    }
    if (errorFlagsSeen.size > 0) {
      return {
        ...base,
        status: 'ERROR',
        detail: `job ${how} after spooler error state(s) [${[...errorFlagsSeen].join(', ')}] (${pagesText()}); completion NOT claimed — staff must check physical output`,
      };
    }
    const pagesExposed = maxPagesPrinted !== null && maxPagesPrinted > 0 && totalPages !== null && totalPages > 0;
    if (pagesExposed && (maxPagesPrinted ?? 0) < (totalPages ?? 0) && !printedFlag) {
      return { ...base, status: 'ERROR', detail: `job ${how} incomplete: spooler reported ${maxPagesPrinted} of ${totalPages} pages printed` };
    }
    let evidence = printedFlag ? 'Printed flag seen' : pagesExposed ? 'all pages reported printed' : 'left queue with no error (page count not exposed by driver)';
    let pages = maxPagesPrinted;
    if (p.eventLog307 !== 'off') {
      const ev = await findEvent(p.eventLog307WaitMs);
      if (ev) {
        evidence += `; event 307 confirmed (pages=${ev.pages ?? 'n/a'})`;
        if (ev.pages !== null) pages = ev.pages;
      } else if (p.eventLog307 === 'require') {
        return { ...base, status: 'ERROR', detail: `job ${how} but no Event 307 "printed" confirmation found (eventLog307=require)` };
      } else if (p.resumed && !printedFlag) {
        return { ...base, status: 'ERROR', detail: `agent restarted while job was in spooler; job ${how} and outcome during the gap is unknown (no Printed flag / event 307) — staff must verify physically` };
      }
    } else if (p.resumed && !printedFlag) {
      return { ...base, status: 'ERROR', detail: `agent restarted while job was in spooler; job ${how} and outcome during the gap is unknown — staff must verify physically` };
    }
    return { spoolerJobId: spoolerId, pagesPrinted: pages, status: 'COMPLETED_SPOOLER', detail: `spooler: job ${how}; ${evidence}; ${pagesText()}. NOT physically verified.` };
  };

  for (;;) {
    if (p.shouldStop()) return { status: 'ERROR', detail: 'monitor aborted (agent stopping)', spoolerJobId: spoolerId, pagesPrinted: maxPagesPrinted, aborted: true };
    let jobs: SpoolerJob[] | null = null;
    try {
      jobs = await p.backend.listSpoolerJobs(p.printerName);
      consecutivePollFailures = 0;
    } catch (e) {
      consecutivePollFailures++;
      p.logger.warn('spooler_poll_failed', { printer: p.printerName, error: (e as Error).message, consecutivePollFailures });
    }

    if (jobs) {
      const j = matchSpoolerJob(jobs, { docToken: p.docToken, knownSpoolerJobId: spoolerId, submittedAt: p.submittedAt, excludeIds: p.excludeSpoolerIds });
      if (j) {
        seen = true;
        spoolerId = j.id;
        if (j.totalPages !== null && j.totalPages > 0) totalPages = Math.max(totalPages ?? 0, j.totalPages);
        if (j.pagesPrinted !== null) maxPagesPrinted = Math.max(maxPagesPrinted ?? 0, j.pagesPrinted);
        if (j.flags.includes('Printed') || j.flags.includes('Complete')) printedFlag = true;
        if (j.flags.includes('Deleting') || j.flags.includes('Deleted')) deletedSeen = true;
        p.logger.debug('spooler_job_seen', { printer: p.printerName, spoolerJobId: j.id, flags: j.flags, raw: j.rawStatus, pagesPrinted: j.pagesPrinted, totalPages: j.totalPages });

        if (!reportedSpooled) {
          reportedSpooled = true;
          await emit('SPOOLED', `in Windows queue as job ${j.id} (${j.document})`);
        }
        for (const [flag, st] of ERROR_FLAG_STATUS) {
          if (j.flags.includes(flag)) {
            errorFlagsSeen.add(flag);
            if (!reportedErrors.has(st)) {
              reportedErrors.add(st);
              await emit(
                st,
                `spooler job ${j.id} status: ${j.rawStatus || j.flags.join(', ')} (${pagesText()}). Job is STILL in the Windows queue and may resume when fixed — check the printer/queue before re-queueing to avoid a double print.`,
              );
            }
          }
        }
        if (j.flags.includes('Printing') && !reportedPrinting && errorFlagsSeen.size === 0) {
          reportedPrinting = true;
          await emit('PRINTING', `spooler job ${j.id} printing (${pagesText()})`);
        }
        // "Keep printed documents": finished jobs stay in the queue flagged Printed/Complete/Retained.
        const retainedDone = (j.flags.includes('Printed') || j.flags.includes('Complete')) && !j.flags.includes('Printing') && !j.flags.includes('Spooling');
        if (retainedDone) return finishLeftQueue('finished (retained in queue)');
      } else if (seen) {
        return finishLeftQueue('left the queue');
      } else if (p.now() >= notObservedDeadline) {
        const ev = await findEvent(0);
        if (ev && !p.resumed && p.eventLog307 !== 'off') {
          spoolerId = ev.spoolerJobId;
          return {
            status: 'COMPLETED_SPOOLER',
            spoolerJobId: ev.spoolerJobId,
            pagesPrinted: ev.pages,
            detail: `job not observed in queue polling (too fast) but Event 307 confirms printed (pages=${ev.pages ?? 'n/a'}). NOT physically verified.`,
          };
        }
        return {
          status: 'ERROR',
          spoolerJobId: null,
          pagesPrinted: null,
          detail: p.resumed
            ? `job not observed in spooler after agent restart (was submitted at ${new Date(p.submittedAt).toISOString()}); NOT resubmitted — staff must verify physically and re-queue if missing`
            : `job not observed in spooler within ${Math.round(p.notObservedTimeoutMs / 1000)}s of submit; completion NOT claimed`,
        };
      }
    }

    if (p.now() - startedAt > p.monitorTimeoutMs) {
      return {
        status: 'ERROR',
        spoolerJobId: spoolerId,
        pagesPrinted: maxPagesPrinted,
        detail: seen ? `job still in spooler after ${Math.round(p.monitorTimeoutMs / 60000)} min (${pagesText()}); stopped monitoring — check printer` : 'spooler could not be queried; outcome unknown',
      };
    }
    await p.sleep(p.pollMs);
  }
}
