import { buildSignedHeaders } from './hmac.js';
import { assertServerUrlAllowed } from './config.js';
import type { ClaimResponse, HeartbeatBody, HeartbeatResponse, StatusUpdateBody } from './types.js';

export class NetworkError extends Error {
  readonly retryable = true;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
  /** 5xx, 408, 429 and 401 (possible clock skew / transient auth) are retried; other 4xx are permanent. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429 || this.status === 401;
  }
}

export interface ApiClientOptions {
  serverUrl: string;
  agentId: string;
  hmacKey: string;
  allowInsecureLocalhost: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ApiClient {
  /** serverTime - localTime, learned from heartbeat; applied to request timestamps. */
  clockOffsetMs = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ApiClientOptions) {
    assertServerUrlAllowed(opts.serverUrl, opts.allowInsecureLocalhost);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async request<T>(method: 'GET' | 'POST', path: string, bodyObj?: unknown): Promise<T> {
    const url = new URL(path, this.opts.serverUrl);
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const headers = buildSignedHeaders({
      agentId: this.opts.agentId,
      hmacKey: this.opts.hmacKey,
      method,
      path: url.pathname,
      body,
      now: this.now() + this.clockOffsetMs,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new NetworkError(`${method} ${url.pathname} failed: ${(e as Error).message}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new NetworkError(`${method} ${url.pathname} body read failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      if (res.status === 401) this.learnSkewFromDateHeader(res.headers.get('date'));
      throw new HttpError(res.status, text);
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new HttpError(res.status, `invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  private learnSkewFromDateHeader(date: string | null): void {
    if (!date) return;
    const t = Date.parse(date);
    if (Number.isNaN(t)) return;
    const off = t - this.now();
    // HTTP Date has 1s resolution; only correct large skews.
    if (Math.abs(off) > 60_000) this.clockOffsetMs = off;
  }

  async heartbeat(body: HeartbeatBody): Promise<HeartbeatResponse> {
    const sent = this.now();
    const r = await this.request<HeartbeatResponse>('POST', '/api/agent/heartbeat', body);
    const recv = this.now();
    if (typeof r.serverTime === 'number' && Number.isFinite(r.serverTime)) {
      this.clockOffsetMs = Math.round(r.serverTime - (sent + recv) / 2);
    }
    return r;
  }

  async claim(printers: string[]): Promise<ClaimResponse> {
    const r = await this.request<ClaimResponse>('POST', '/api/agent/jobs/claim', { printers });
    return { jobs: Array.isArray(r.jobs) ? r.jobs : [] };
  }

  async postStatus(jobId: string, body: StatusUpdateBody): Promise<void> {
    await this.request<{ ok: boolean }>('POST', `/api/agent/jobs/${encodeURIComponent(jobId)}/status`, body);
  }
}
