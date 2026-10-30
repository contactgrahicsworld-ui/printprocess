import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { JobLog } from '../src/jobLog.js';
import { Outbox } from '../src/outbox.js';
import { InstanceLock, AlreadyRunningError } from '../src/lock.js';
import { detectMagic, verifyFile, IntegrityError } from '../src/download.js';
import { ConfigError, isUrlAllowed, parseConfig } from '../src/config.js';
import { imageToPdf, makeTestPagePdf, countPdfPages } from '../src/pdf.js';
import { matchPrintedEvent, matchSpoolerJob } from '../src/monitor.js';
import { checkCapabilities } from '../src/capability.js';
import { RotatingJsonLogger } from '../src/logger.js';
import { sha256hex } from '../src/hmac.js';
import { docFileName } from '../src/agent.js';
import { parseArgs } from '../src/cli.js';
import { makePdf, makePng } from './helpers/fixtures.js';
import type { PrintJob } from '../src/types.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'mpa-unit-')));

const job: PrintJob = {
  jobId: 'j1',
  orderNumber: 'MP-1',
  orderItemId: 'i1',
  attempt: 1,
  printerName: 'P',
  fileName: 'f.pdf',
  mimeType: 'application/pdf',
  sha256: 'x',
  downloadUrl: 'https://x',
  settings: { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'A4', copies: 1, pageRanges: null },
};

describe('durable job log', () => {
  it('persists across reopen, survives a torn last line, refuses to leave FINAL', () => {
    const d = tmp();
    const a = new JobLog(d);
    const r = a.create(job);
    a.update(r.key, { state: 'SUBMITTING', submittedAt: 5 });
    a.close();
    appendFileSync(join(d, 'jobs.jsonl'), '{"key":"j1#1","state":"FIN'); // crash mid-write
    const b = new JobLog(d);
    expect(b.get('j1', 1)!.state).toBe('SUBMITTING');
    expect(b.create(job).state).toBe('SUBMITTING'); // create is idempotent
    b.update(r.key, { state: 'FINAL' });
    expect(() => b.update(r.key, { state: 'SUBMITTED' })).toThrow(/FINAL/);
    b.close();
    // keyed by jobId+attempt
    const c = new JobLog(d);
    expect(c.get('j1', 2)).toBeUndefined();
    expect(c.create({ ...job, attempt: 2 }).state).toBe('RECEIVED');
    c.close();
  });
  it('appending after a torn line keeps the new record readable', () => {
    const d = tmp();
    const a = new JobLog(d);
    a.close();
    appendFileSync(join(d, 'jobs.jsonl'), '{"garbage');
    const b = new JobLog(d); // compaction rewrites; simulate torn again then append
    b.close();
    appendFileSync(join(d, 'jobs.jsonl'), '{"torn');
    const c = new JobLog(d);
    c.create(job);
    c.close();
    const e = new JobLog(d);
    expect(e.get('j1', 1)).toBeDefined();
    e.close();
  });
});

describe('outbox', () => {
  it('keeps order across restarts and removes acked items', () => {
    const d = tmp();
    const o = new Outbox(d);
    const body = (s: string) => ({ status: s as 'SUBMITTED', spoolerJobId: null, detail: '', pagesPrinted: null, at: 1 });
    o.enqueue('a', body('DOWNLOADED'));
    o.enqueue('a', body('SUBMITTED'));
    o.enqueue('b', body('DOWNLOADED'));
    o.ack(1);
    o.close();
    const o2 = new Outbox(d);
    expect(o2.pending().map((p) => [p.seq, p.jobId, p.body.status])).toEqual([
      [2, 'a', 'SUBMITTED'],
      [3, 'b', 'DOWNLOADED'],
    ]);
    expect(o2.enqueue('c', body('SPOOLED')).seq).toBe(4);
    o2.close();
  });
});

describe('single-instance lock', () => {
  it('second acquire fails while held; stale lock (dead pid) is taken over', () => {
    const d = tmp();
    const p = join(d, 'agent.lock');
    const l1 = new InstanceLock(p);
    l1.acquire();
    writeFileSync(p, String(process.ppid)); // pretend another live process holds it
    expect(() => new InstanceLock(p).acquire()).toThrow(AlreadyRunningError);
    writeFileSync(p, '999999999'); // dead pid
    const l2 = new InstanceLock(p);
    l2.acquire();
    expect(readFileSync(p, 'utf8')).toBe(String(process.pid));
    l2.release();
    expect(existsSync(p)).toBe(false);
  });
});

describe('integrity checks', () => {
  it('magic bytes', async () => {
    expect(detectMagic(await makePdf(1))).toBe('pdf');
    expect(detectMagic(makePng(2, 2))).toBe('png');
    expect(detectMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('jpeg');
    expect(detectMagic(Buffer.from('MZ\x90\x00'))).toBe('unknown');
    expect(detectMagic(Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from('%PDF-1.7')]))).toBe('pdf');
  });
  it('verifyFile: hash, unsupported mime, magic mismatch', async () => {
    const d = tmp();
    const f = join(d, 'f');
    const pdf = await makePdf(1);
    writeFileSync(f, pdf);
    expect(verifyFile(f, sha256hex(pdf), sha256hex(pdf).toUpperCase(), 'application/pdf')).toBe('pdf');
    expect(() => verifyFile(f, sha256hex(pdf), 'b'.repeat(64), 'application/pdf')).toThrow(/sha256 mismatch/);
    expect(() => verifyFile(f, sha256hex(pdf), sha256hex(pdf), 'application/msword')).toThrow(IntegrityError);
    expect(() => verifyFile(f, sha256hex(pdf), sha256hex(pdf), 'image/jpeg')).toThrow(/magic bytes say pdf/);
  });
});

describe('config', () => {
  it('HTTPS only unless allowInsecureLocalhost for localhost', () => {
    expect(isUrlAllowed('https://print.mansaprinter.in', false)).toBe(true);
    expect(isUrlAllowed('http://print.mansaprinter.in', false)).toBe(false);
    expect(isUrlAllowed('http://print.mansaprinter.in', true)).toBe(false);
    expect(isUrlAllowed('http://localhost:3000', false)).toBe(false);
    expect(isUrlAllowed('http://localhost:3000', true)).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:3000', true)).toBe(true);
    expect(() => parseConfig({ serverUrl: 'http://example.com', agentId: 'a', secret: 's' })).toThrow(ConfigError);
    expect(() => parseConfig({ serverUrl: 'https://example.com', agentId: 'a' })).toThrow(/secret/);
    const c = parseConfig({ serverUrl: 'https://example.com', agentId: 'a', secretProtected: 'AQAAANCMnd8B' });
    expect(c.heartbeatIntervalMs).toBe(30000);
    expect(c.claimIntervalMs).toBe(5000);
    expect(c.spoolerPollMs).toBe(2000);
    expect(c.keepTempHours).toBe(0);
    expect(c.eventLog307).toBe('off');
  });
});

describe('PDF generation', () => {
  it('image → PDF: page size matches paper (landscape for wide images), single page', async () => {
    const d = tmp();
    const png = join(d, 'i.png');
    writeFileSync(png, makePng(300, 100));
    await imageToPdf(png, 'png', 'A4', join(d, 'o.pdf'), { title: 'MP_x' });
    const doc = await PDFDocument.load(readFileSync(join(d, 'o.pdf')));
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
    writeFileSync(png, makePng(100, 300));
    await imageToPdf(png, 'png', 'LEGAL', join(d, 'o2.pdf'));
    const d2 = await PDFDocument.load(readFileSync(join(d, 'o2.pdf')));
    expect(d2.getPage(0).getSize()).toEqual({ width: 612, height: 1008 });
  });
  it('test page + page counting', async () => {
    const d = tmp();
    await makeTestPagePdf(join(d, 't.pdf'), { printerName: 'HP', hostname: 'PC', agentVersion: '1.0.0', now: new Date() });
    expect(await countPdfPages(join(d, 't.pdf'))).toBe(1);
    writeFileSync(join(d, 'bad.pdf'), '%PDF-1.4 broken');
    expect(await countPdfPages(join(d, 'bad.pdf'))).toBeNull();
  });
});

describe('spooler matching', () => {
  const base = { printerName: 'P', flags: [], rawStatus: '', totalPages: null, pagesPrinted: null };
  it('matches by doc token within submit window, prefers known spooler id, rejects reused ids with other docs', () => {
    const jobs = [
      { ...base, id: 3, document: 'MP_A_old-job.pdf', submittedAt: 1000 },
      { ...base, id: 4, document: 'C:\\tmp\\MP_A_JOB-1.pdf', submittedAt: 500_000 },
      { ...base, id: 5, document: 'other.pdf', submittedAt: 500_000 },
    ];
    expect(matchSpoolerJob(jobs, { docToken: 'job-1', knownSpoolerJobId: null, submittedAt: 500_000 })?.id).toBe(4);
    expect(matchSpoolerJob(jobs, { docToken: 'job-1', knownSpoolerJobId: 5, submittedAt: 500_000 })?.id).toBe(4);
    expect(matchSpoolerJob(jobs, { docToken: 'old-job', knownSpoolerJobId: null, submittedAt: 500_000 })).toBeUndefined();
    expect(matchSpoolerJob(jobs, { docToken: 'job-1', knownSpoolerJobId: null, submittedAt: 500_000, excludeIds: [4] })).toBeUndefined();
  });
  it('event 307 matching by doc name or spooler id (names hidden by default on Windows 10+)', () => {
    const evs = [{ spoolerJobId: 9, document: 'Print Document', printerName: 'P', pages: 2, timeCreated: 2000 }];
    expect(matchPrintedEvent(evs, { printerName: 'P', spoolerJobId: 9, docToken: 'x', submittedAt: 1000 })).toBeDefined();
    expect(matchPrintedEvent(evs, { printerName: 'P', spoolerJobId: 8, docToken: 'x', submittedAt: 1000 })).toBeUndefined();
    expect(matchPrintedEvent(evs, { printerName: 'Q', spoolerJobId: 9, docToken: 'x', submittedAt: 1000 })).toBeUndefined();
  });
});

describe('misc', () => {
  it('capabilities report all problems', () => {
    const p = { name: 'P', isDefault: true, status: 'Normal' as const, statusDetail: '', supportsColor: false, supportsDuplex: false, paperSizes: ['A4'] };
    const e = checkCapabilities(p, { colorMode: 'COLOR', duplex: 'DOUBLE', paperSize: 'LEGAL', copies: 1, pageRanges: null })!;
    expect(e).toMatch(/monochrome/);
    expect(e).toMatch(/duplex/);
    expect(e).toMatch(/Legal not supported/);
    expect(checkCapabilities({ ...p, paperSizes: ['A4', 'Legal'] }, { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'LEGAL', copies: 1, pageRanges: null })).toBeNull();
  });
  it('doc file name is Windows-safe', () => {
    expect(docFileName({ orderNumber: 'MP-20261030-0042', jobId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' })).toBe('MP_MP-20261030-0042_1b4e28ba-2fa1-11d2-883f-0016d3cca427.pdf');
    expect(docFileName({ orderNumber: 'MP:1/2', jobId: 'a\\b' })).toBe('MP_MP-1-2_a-b.pdf');
  });
  it('rotating logger rotates and redacts secrets', () => {
    const d = tmp();
    const l = new RotatingJsonLogger(d, { maxBytes: 300, maxFiles: 3 });
    for (let i = 0; i < 20; i++) l.info('evt', { i, secret: 'TOPSECRET', downloadUrl: 'https://s/f?token=abc' });
    expect(existsSync(join(d, 'agent.1.log'))).toBe(true);
    expect(existsSync(join(d, 'agent.2.log'))).toBe(true);
    expect(existsSync(join(d, 'agent.3.log'))).toBe(false);
    const all = readFileSync(join(d, 'agent.log'), 'utf8') + readFileSync(join(d, 'agent.1.log'), 'utf8');
    expect(all).not.toContain('TOPSECRET');
    expect(all).not.toContain('token=abc');
    expect(JSON.parse(all.split('\n')[0]!)).toMatchObject({ level: 'info', event: 'evt' });
  });
  it('CLI arg parsing', () => {
    const a = parseArgs(['test-print', 'HP LaserJet', '--color', '--paper', 'A3', '--config=C:\\x.json']);
    expect(a.cmd).toBe('test-print');
    expect(a.positional).toEqual(['HP LaserJet']);
    expect(a.flags.get('color')).toEqual(['true']);
    expect(a.flags.get('paper')).toEqual(['A3']);
    expect(a.flags.get('config')).toEqual(['C:\\x.json']);
    const b = parseArgs(['setup', '--allow', 'A', '--allow', 'B']);
    expect(b.flags.get('allow')).toEqual(['A', 'B']);
  });
});
