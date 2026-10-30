import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { sha256hex, verifySignature, deriveHmacKey } from '../../src/hmac.js';
import type { PrintJob, StatusUpdateBody, HeartbeatBody } from '../../src/types.js';

const RANK: Record<string, number> = { QUEUED: 0, CLAIMED: 1, DOWNLOADED: 2, SUBMITTED: 3, SPOOLED: 4, PRINTING: 5, COMPLETED_SPOOLER: 6, VERIFIED: 7 };
const FAILURES = ['FAILED', 'PRINTER_OFFLINE', 'PAPER_OUT', 'ERROR'];
const TERMINAL = ['VERIFIED', 'CANCELLED', ...FAILURES];
/** Same monotonic rule as the web backend (web/src/lib/orders/status.ts applyAgentStatus). */
export function applyAgentStatus(current: string, reported: string): string | null {
  if (TERMINAL.includes(current)) return null;
  const cur = RANK[current];
  if (cur === undefined) return null;
  if (FAILURES.includes(reported)) return cur >= 1 && cur <= 5 ? reported : null;
  const next = RANK[reported];
  if (next === undefined || current === 'QUEUED') return null;
  return next > cur ? reported : null;
}

interface ServerJob {
  job: Omit<PrintJob, 'downloadUrl'>;
  status: string;
  claimedBy: string | null;
  file: Buffer;
}

/**
 * Mock of the web backend's /api/agent/* endpoints, implementing CONTRACT.md
 * including HMAC verification, ±5 min timestamp window and nonce replay protection.
 */
export class MockServer {
  private server: Server;
  private sockets = new Set<Socket>();
  url = '';
  readonly agents = new Map<string, { hmacKey: string; revoked: boolean }>();
  readonly jobs = new Map<string, ServerJob>();
  readonly statusLog: Array<{ jobId: string; body: StatusUpdateBody; duplicate: boolean }> = [];
  readonly heartbeats: HeartbeatBody[] = [];
  readonly authFailures: string[] = [];
  readonly nonces = new Map<string, number>();
  claimCalls = 0;
  /** when true, agent endpoints drop the connection (simulated internet loss) */
  down = false;
  /** return the same in-progress job twice in one claim response */
  duplicateInClaim = false;
  /** server clock offset vs real time (ms) */
  clockOffset = 0;
  private fileTokens = new Map<string, string>();

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  addAgent(agentId: string, secret: string): void {
    this.agents.set(agentId, { hmacKey: deriveHmacKey(secret), revoked: false });
  }

  addJob(job: Omit<PrintJob, 'downloadUrl' | 'sha256'> & { sha256?: string }, file: Buffer): void {
    this.jobs.set(job.jobId, {
      job: { ...job, sha256: job.sha256 ?? sha256hex(file) },
      status: 'QUEUED',
      claimedBy: null,
      file,
    });
  }

  statusesFor(jobId: string): string[] {
    return this.statusLog.filter((s) => s.jobId === jobId && !s.duplicate).map((s) => s.body.status);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private send(res: ServerResponse, code: number, obj: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json', date: new Date(Date.now() + this.clockOffset).toUTCString() });
    res.end(JSON.stringify(obj));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const jobId = this.fileTokens.get(url.pathname.slice('/files/'.length));
      const j = jobId ? this.jobs.get(jobId) : undefined;
      if (!j || url.searchParams.get('sig') !== 'ok') return this.send(res, 403, { error: 'expired' });
      if (this.down) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(j.file.length) });
      res.end(j.file);
      return;
    }
    if (!url.pathname.startsWith('/api/agent/')) return this.send(res, 404, { error: 'not found' });
    const body = await this.readBody(req);
    if (this.down) {
      req.socket.destroy();
      return;
    }
    // ---- HMAC auth per CONTRACT
    const agentId = String(req.headers['x-agent-id'] ?? '');
    const ts = String(req.headers['x-agent-timestamp'] ?? '');
    const nonce = String(req.headers['x-agent-nonce'] ?? '');
    const sig = String(req.headers['x-agent-signature'] ?? '');
    const agent = this.agents.get(agentId);
    const now = Date.now() + this.clockOffset;
    const fail = (why: string): void => {
      this.authFailures.push(why);
      this.send(res, 401, { error: why });
    };
    if (!agent || agent.revoked) return fail('unknown or revoked agent');
    if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 5 * 60_000) return fail('timestamp outside window');
    for (const [n, t] of this.nonces) if (now - t > 10 * 60_000) this.nonces.delete(n);
    if (!nonce || this.nonces.has(nonce)) return fail('nonce reused');
    if (!verifySignature(agent.hmacKey, req.method ?? '', url.pathname, ts, nonce, body, sig)) return fail('bad signature');
    this.nonces.set(nonce, now);
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      this.heartbeats.push(json as unknown as HeartbeatBody);
      return this.send(res, 200, { ok: true, serverTime: now });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/jobs/claim') {
      this.claimCalls++;
      const out: PrintJob[] = [];
      const active = ['CLAIMED', 'DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING'];
      for (const j of this.jobs.values()) {
        if (out.length >= 5) break;
        if (j.status === 'QUEUED') {
          j.status = 'CLAIMED';
          j.claimedBy = agentId;
        } else if (!(j.claimedBy === agentId && active.includes(j.status))) continue;
        const token = randomUUID();
        this.fileTokens.set(token, j.job.jobId);
        const pj = { ...j.job, downloadUrl: `${this.url}/files/${token}?sig=ok` };
        out.push(pj);
        if (this.duplicateInClaim) out.push(pj);
      }
      return this.send(res, 200, { jobs: out });
    }
    const m = /^\/api\/agent\/jobs\/([^/]+)\/status$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const jobId = decodeURIComponent(m[1]!);
      const j = this.jobs.get(jobId);
      if (!j) return this.send(res, 404, { error: 'unknown job' });
      const b = json as unknown as StatusUpdateBody;
      if (b.status === ('VERIFIED' as string)) return this.send(res, 400, { error: 'agent cannot verify' });
      const duplicate = this.statusLog.some((s) => s.jobId === jobId && s.body.status === b.status);
      this.statusLog.push({ jobId, body: b, duplicate });
      if (!duplicate) {
        const next = applyAgentStatus(j.status, b.status);
        if (next) j.status = next;
      }
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: 'not found' });
  }
}
