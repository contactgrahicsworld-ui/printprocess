import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, jobFor, waitFor, waitFinal, PRINTER, type TestEnv } from './helpers/env.js';
import { defaultScenario, type Phase } from './helpers/fakeBackend.js';
import { makePdf, makePng } from './helpers/fixtures.js';

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe('agent end-to-end against mock CONTRACT server + fake spooler', () => {
  it('happy path: claim → download → sha256 → submit → SPOOLED → PRINTING → COMPLETED_SPOOLER', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(2));
    env.backend.scenario = defaultScenario(2);
    await env.agent.start();
    await waitFinal(env, job.jobId);

    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER']);
    expect(env.backend.submissions).toHaveLength(1);
    const sub = env.backend.submissions[0]!;
    expect(sub.printerName).toBe(PRINTER);
    expect(sub.printSettings).toBe('1x,simplex,monochrome,paper=A4,shrink');
    expect(sub.filePath.endsWith(`MP_MP-20261030-0042_${job.jobId}.pdf`)).toBe(true);
    const final = env.server.statusLog.filter((s) => s.jobId === job.jobId).at(-1)!.body;
    expect(final.status).toBe('COMPLETED_SPOOLER');
    expect(final.spoolerJobId).toBe(sub.spoolerJobId);
    expect(final.pagesPrinted).toBe(2);
    expect(final.detail).toMatch(/NOT physically verified/);
    // never VERIFIED, no auth failures, temp file deleted (keepTempHours=0)
    expect(env.server.statusLog.some((s) => (s.body.status as string) === 'VERIFIED')).toBe(false);
    expect(env.server.authFailures).toEqual([]);
    expect(existsSync(sub.filePath)).toBe(false);
    // statuses carry monotonic event times
    const ats = env.server.statusLog.map((s) => s.body.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    await waitFor(() => env!.server.heartbeats.length > 0);
    expect(env.server.heartbeats[0]!.printers[0]).toMatchObject({ name: PRINTER, status: 'Normal', supportsDuplex: true });
  });

  it('PNG image is converted to a PDF at the chosen paper size and printed with colour/duplex/copies', async () => {
    env = await makeEnv();
    const job = jobFor({
      fileName: 'photo.png',
      mimeType: 'image/png',
      settings: { colorMode: 'COLOR', duplex: 'SINGLE', paperSize: 'A3', copies: 3, pageRanges: null },
    });
    env.server.addJob(job, makePng(40, 20));
    env.backend.scenario = defaultScenario(3);
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId).at(-1)).toBe('COMPLETED_SPOOLER');
    expect(env.backend.submissions[0]!.printSettings).toBe('3x,simplex,color,paper=A3,shrink');
  });

  it('printer offline before submit: does not submit, job stays claimed (no terminal status), heartbeat shows Offline, submits once back', async () => {
    env = await makeEnv();
    env.backend.setStatus(PRINTER, 'Offline');
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    env.backend.scenario = defaultScenario(1);
    await env.agent.start();
    await waitFor(() => env!.agent.jobLog.get(job.jobId, 1)?.state === 'WAITING_PRINTER');
    await new Promise((r) => setTimeout(r, 300));
    expect(env.backend.submissions).toHaveLength(0);
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED']);
    expect(env.server.jobs.get(job.jobId)!.status).toBe('DOWNLOADED'); // still active → staff cannot re-queue a duplicate
    await waitFor(() => env!.server.heartbeats.some((h) => h.printers.some((p) => p.name === PRINTER && p.status === 'Offline')));
    env.backend.setStatus(PRINTER, 'Normal');
    await waitFinal(env, job.jobId);
    expect(env.backend.submissions).toHaveLength(1);
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER']);
  });

  it('paper out before submit, max wait exceeded → final PAPER_OUT ("NOT sent"), never submitted', async () => {
    env = await makeEnv({ maxPrinterWaitMs: 300 });
    env.backend.setStatus(PRINTER, 'PaperOut');
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'PAPER_OUT']);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/NOT sent to the printer/);
    expect(env.backend.submissions).toHaveLength(0);
    // later claims of the finished job are ignored
    await new Promise((r) => setTimeout(r, 200));
    expect(env.backend.submissions).toHaveLength(0);
  });

  it('paper out mid-job: reports PAPER_OUT and never claims COMPLETED_SPOOLER', async () => {
    env = await makeEnv();
    const phases: Phase[] = [
      { flags: ['Spooling'], totalPages: 4, pagesPrinted: 0 },
      { flags: ['Printing'], totalPages: 4, pagesPrinted: 1 },
      { flags: ['Printing', 'PaperOut'], totalPages: 4, pagesPrinted: 2 },
      { flags: ['Error', 'PaperOut'], totalPages: 4, pagesPrinted: 2 },
      { flags: ['Printing'], totalPages: 4, pagesPrinted: 4 },
      'gone',
    ];
    env.backend.scenario = phases;
    const job = jobFor();
    env.server.addJob(job, await makePdf(4));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    const st = env.server.statusesFor(job.jobId);
    expect(st).toContain('PAPER_OUT');
    expect(st).not.toContain('COMPLETED_SPOOLER');
    expect(st.at(-1)).toBe('ERROR');
    const last = env.server.statusLog.filter((s) => s.jobId === job.jobId).at(-1)!.body;
    expect(last.detail).toMatch(/PaperOut/);
    expect(last.detail).toMatch(/NOT claimed/);
    expect(env.server.jobs.get(job.jobId)!.status).toBe('PAPER_OUT'); // server keeps first failure (terminal)
  });

  it('job never appears in spooler → ERROR "not observed in spooler", never COMPLETED', async () => {
    env = await makeEnv();
    env.backend.scenario = 'never';
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'SUBMITTED', 'ERROR']);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/not observed in spooler/);
  });

  it('job too fast for polling but Event 307 confirms it (eventLog307=confirm) → COMPLETED_SPOOLER', async () => {
    env = await makeEnv({ eventLog307: 'confirm' });
    env.backend.scenario = 'never';
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    env.backend.onPoll = () => {
      if (env!.backend.events.length === 0 && env!.backend.submissions.length === 1) {
        env!.backend.events.push({ spoolerJobId: 77, document: `MP_x_${job.jobId}.pdf`, printerName: PRINTER, pages: 1, timeCreated: Date.now() });
      }
    };
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId).at(-1)).toBe('COMPLETED_SPOOLER');
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/Event 307/);
  });

  it('eventLog307=require: leaving the queue without a 307 event is ERROR', async () => {
    env = await makeEnv({ eventLog307: 'require' });
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId).at(-1)).toBe('ERROR');
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/307/);
  });

  it('sha256 mismatch → FAILED, nothing submitted, temp removed', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob({ ...job, sha256: 'a'.repeat(64) }, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId)).toEqual(['FAILED']);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/sha256 mismatch/);
    expect(env.backend.submissions).toHaveLength(0);
    expect(readdirSync(join(env.dir, 'tmp'))).toEqual([]);
  });

  it('invalid magic bytes (declared PDF, actually HTML) → FAILED', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, Buffer.from('<html>not a pdf</html>'));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId)).toEqual(['FAILED']);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/magic bytes/);
    expect(env.backend.submissions).toHaveLength(0);
  });

  it('mime/magic disagreement (declared PNG, actually PDF) → FAILED', async () => {
    env = await makeEnv();
    const job = jobFor({ mimeType: 'image/png' });
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/magic bytes say pdf/);
  });

  it('duplicate claims of the same job (in one response and on every claim poll) print it exactly once', async () => {
    env = await makeEnv();
    env.server.duplicateInClaim = true;
    const job = jobFor();
    env.server.addJob(job, await makePdf(3));
    env.backend.scenario = defaultScenario(3).flatMap((p) => [p, p, p]); // slow job → many re-claims meanwhile
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.claimCalls).toBeGreaterThan(3);
    expect(env.backend.submissions).toHaveLength(1);
    expect(env.server.statusesFor(job.jobId).at(-1)).toBe('COMPLETED_SPOOLER');
    // further claims (server still returning it would be ignored)
    env.agent.handleClaimed({ ...job, sha256: 'x', downloadUrl: 'https://x' });
    await env.agent.idle();
    expect(env.backend.submissions).toHaveLength(1);
  });

  it('restart mid-job: in-flight job is reconciled from spooler by document name, never resubmitted', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(2));
    const long: Phase[] = [{ flags: ['Spooling'] }];
    for (let i = 0; i < 40; i++) long.push({ flags: ['Printing'], totalPages: 2, pagesPrinted: 0 });
    long.push({ flags: ['Printed', 'Retained'], totalPages: 2, pagesPrinted: 2 });
    env.backend.scenario = long;
    await env.agent.start();
    await waitFor(() => env!.agent.jobLog.get(job.jobId, 1)?.state === 'PRINTING');
    await env.agent.stop(); // simulated crash/restart: state stays PRINTING on disk
    const agent2 = env.newAgent();
    expect(agent2.jobLog.get(job.jobId, 1)!.state).toBe('PRINTING');
    await agent2.start();
    try {
      await waitFinal(env, job.jobId, 1, agent2);
      expect(env.backend.submissions).toHaveLength(1);
      expect(env.server.statusesFor(job.jobId).at(-1)).toBe('COMPLETED_SPOOLER');
      expect(agent2.jobLog.get(job.jobId, 1)!.spoolerJobId).toBe(env.backend.submissions[0]!.spoolerJobId);
    } finally {
      await agent2.stop();
    }
  });

  it('restart after SUBMITTING marker but job not in spooler → ERROR, NOT resubmitted', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    // agent 1: simulate crash right after durable SUBMITTING marker (before/while Sumatra ran)
    const rec = env.agent.jobLog.create({ ...job, sha256: 'x', downloadUrl: `${env.server.url}/files/none` });
    env.agent.jobLog.update(rec.key, { state: 'SUBMITTING', submittedAt: Date.now() - 120_000, printerName: PRINTER, filePath: join(env.dir, 'gone.pdf') });
    await env.agent.stop();
    const agent2 = env.newAgent();
    await agent2.start();
    try {
      await waitFinal(env, job.jobId, 1, agent2);
      expect(env.backend.submissions).toHaveLength(0);
      const last = env.server.statusLog.at(-1)!.body;
      expect(last.status).toBe('ERROR');
      expect(last.detail).toMatch(/NOT resubmitted/);
    } finally {
      await agent2.stop();
    }
  });

  it('restart while spooled; job left queue during downtime with no evidence → ERROR (outcome unknown)', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(2));
    const long: Phase[] = [];
    for (let i = 0; i < 30; i++) long.push({ flags: ['Spooling'] });
    long.push('gone');
    env.backend.scenario = long;
    await env.agent.start();
    await waitFor(() => env!.agent.jobLog.get(job.jobId, 1)?.state === 'SPOOLED');
    await env.agent.stop();
    env.backend.live.clear(); // job finished (or was lost) while agent was down
    const agent2 = env.newAgent();
    await agent2.start();
    try {
      await waitFinal(env, job.jobId, 1, agent2);
      expect(env.backend.submissions).toHaveLength(1);
      expect(env.server.statusesFor(job.jobId).at(-1)).toBe('ERROR');
      expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/outcome during the gap is unknown/);
    } finally {
      await agent2.stop();
    }
  });

  it('network drop: printing continues, status updates queue durably and replay in order when back', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(2));
    env.backend.scenario = defaultScenario(2).flatMap((p) => [p, p, p]);
    let dropped = false;
    env.backend.onPoll = () => {
      if (!dropped) {
        dropped = true;
        env!.server.down = true; // internet goes away right after submit
      }
    };
    await env.agent.start();
    await waitFor(() => env!.agent.jobLog.get(job.jobId, 1)?.state === 'FINAL');
    expect(env.agent.outbox.size()).toBeGreaterThan(0);
    const before = env.server.statusesFor(job.jobId);
    expect(before).not.toContain('COMPLETED_SPOOLER');
    await new Promise((r) => setTimeout(r, 200));
    env.server.down = false;
    await waitFor(() => env!.agent.outbox.size() === 0, 10000, 'outbox drained');
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER']);
    expect(env.server.jobs.get(job.jobId)!.status).toBe('COMPLETED_SPOOLER');
    expect(env.backend.submissions).toHaveLength(1);
    expect(env.logger.entries.some((e) => e.event === 'network_offline')).toBe(true);
  });

  it('outbox survives an agent restart while offline and is replayed after restart', async () => {
    env = await makeEnv();
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    env.backend.onPoll = () => {
      env!.server.down = true;
    };
    await env.agent.start();
    await waitFor(() => env!.agent.jobLog.get(job.jobId, 1)?.state === 'FINAL');
    await env.agent.stop();
    const pending = env.agent.outbox.size();
    expect(pending).toBeGreaterThan(0);
    env.backend.onPoll = null;
    env.server.down = false;
    const agent2 = env.newAgent();
    expect(agent2.outbox.size()).toBe(pending);
    await agent2.start();
    try {
      await waitFor(() => agent2.outbox.size() === 0);
      expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER']);
    } finally {
      await agent2.stop();
    }
  });

  it('capability mismatch: DOUBLE on simplex printer → ERROR, not submitted (no silent downgrade)', async () => {
    env = await makeEnv();
    env.backend.addPrinter({ name: PRINTER, isDefault: true, supportsDuplex: false });
    const job = jobFor({ settings: { colorMode: 'BW', duplex: 'DOUBLE', paperSize: 'A4', copies: 1, pageRanges: null } });
    env.server.addJob(job, await makePdf(2));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId)).toEqual(['DOWNLOADED', 'ERROR']);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/duplex/);
    expect(env.backend.submissions).toHaveLength(0);
  });

  it('capability mismatch: COLOR on monochrome printer → ERROR', async () => {
    env = await makeEnv();
    env.backend.addPrinter({ name: PRINTER, isDefault: true, supportsColor: false });
    const job = jobFor({ settings: { colorMode: 'COLOR', duplex: 'SINGLE', paperSize: 'A4', copies: 1, pageRanges: null } });
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/monochrome/);
    expect(env.backend.submissions).toHaveLength(0);
  });

  it('capability mismatch: A3 on A4-only printer → ERROR; printerOverrides can correct a lying driver', async () => {
    env = await makeEnv({ printerOverrides: { 'Other Printer': { paperSizes: ['A4', 'A3'] } } });
    env.backend.addPrinter({ name: PRINTER, isDefault: true, paperSizes: ['A4'] });
    env.backend.addPrinter({ name: 'Other Printer', paperSizes: ['A4'] });
    const bad = jobFor({ settings: { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'A3', copies: 1, pageRanges: null } });
    const ok = jobFor({ printerName: 'Other Printer', settings: { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'A3', copies: 1, pageRanges: null } });
    env.server.addJob(bad, await makePdf(1));
    env.server.addJob(ok, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, bad.jobId);
    await waitFinal(env, ok.jobId);
    expect(env.server.statusLog.filter((s) => s.jobId === bad.jobId).at(-1)!.body.detail).toMatch(/paper A3 not supported/);
    expect(env.server.statusesFor(ok.jobId).at(-1)).toBe('COMPLETED_SPOOLER');
    expect(env.backend.submissions.map((s) => s.printerName)).toEqual(['Other Printer']);
  });

  it('page range beyond document → ERROR; valid range passed to Sumatra', async () => {
    env = await makeEnv();
    const bad = jobFor({ settings: { colorMode: 'BW', duplex: 'DOUBLE', paperSize: 'A4', copies: 2, pageRanges: '1-3,9' } });
    const good = jobFor({ settings: { colorMode: 'BW', duplex: 'DOUBLE', paperSize: 'A4', copies: 2, pageRanges: '1-3,5' } });
    env.server.addJob(bad, await makePdf(5));
    env.server.addJob(good, await makePdf(5));
    await env.agent.start();
    await waitFinal(env, bad.jobId);
    await waitFinal(env, good.jobId);
    expect(env.server.statusLog.filter((s) => s.jobId === bad.jobId).at(-1)!.body.detail).toMatch(/exceeds document page count 5/);
    expect(env.backend.submissions).toHaveLength(1);
    expect(env.backend.submissions[0]!.printSettings).toBe('1-3,5,2x,duplexlong,monochrome,paper=A4,shrink');
    const dl = env.server.statusLog.find((s) => s.jobId === good.jobId && s.body.status === 'DOWNLOADED')!.body.detail;
    expect(dl).toMatch(/selected=4; sheets=4; sides=8/);
  });

  it('printer not in allowlist → ERROR without submitting', async () => {
    env = await makeEnv({ printerAllowlist: ['Some Other'] });
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/allowlist/i);
    expect(env.backend.submissions).toHaveLength(0);
  });

  it('job deleted from Windows queue by staff → FAILED', async () => {
    env = await makeEnv();
    env.backend.scenario = [{ flags: ['Spooling'] }, { flags: ['Deleting'] }, 'gone'];
    const job = jobFor();
    env.server.addJob(job, await makePdf(1));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusesFor(job.jobId).at(-1)).toBe('FAILED');
  });

  it('pages exposed but incomplete when leaving queue → ERROR', async () => {
    env = await makeEnv();
    env.backend.scenario = [{ flags: ['Printing'], totalPages: 5, pagesPrinted: 2 }, 'gone'];
    const job = jobFor();
    env.server.addJob(job, await makePdf(5));
    await env.agent.start();
    await waitFinal(env, job.jobId);
    expect(env.server.statusLog.at(-1)!.body.detail).toMatch(/2 of 5 pages/);
  });

  it('server clock skew > 5 min: first request rejected, agent learns offset and recovers', async () => {
    env = await makeEnv();
    env.server.clockOffset = 10 * 60_000;
    await env.agent.start();
    await waitFor(() => env!.server.heartbeats.length > 0, 10000, 'heartbeat after skew correction');
    expect(env.server.authFailures[0]).toBe('timestamp outside window');
  });
});
