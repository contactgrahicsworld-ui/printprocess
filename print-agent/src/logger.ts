import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
}

const SECRET_KEYS = /secret|signature|password|token/i;

function redact(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (k === 'downloadUrl' && typeof v === 'string') out[k] = v.split('?')[0] + '?[redacted]';
    else out[k] = v;
  }
  return out;
}

/** Rotating JSON-lines file logger: agent.log, agent.1.log ... agent.{maxFiles-1}.log */
export class RotatingJsonLogger implements Logger {
  private readonly file: string;
  constructor(
    private readonly dir: string,
    private readonly opts: { maxBytes: number; maxFiles: number; echo?: boolean; minLevel?: LogLevel; baseName?: string },
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${opts.baseName ?? 'agent'}.log`);
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.opts.maxBytes) return;
      const base = this.file.replace(/\.log$/, '');
      const oldest = `${base}.${this.opts.maxFiles - 1}.log`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.opts.maxFiles - 2; i >= 1; i--) {
        const src = `${base}.${i}.log`;
        if (existsSync(src)) renameSync(src, `${base}.${i + 1}.log`);
      }
      if (this.opts.maxFiles > 1) renameSync(this.file, `${base}.1.log`);
      else unlinkSync(this.file);
    } catch {
      /* never let logging crash the agent */
    }
  }

  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.opts.minLevel ?? 'debug')) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(data) });
    this.rotateIfNeeded();
    try {
      appendFileSync(this.file, line + '\n');
    } catch {
      /* ignore */
    }
    if (this.opts.echo) {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    }
  }
  info(e: string, d?: Record<string, unknown>): void { this.log('info', e, d); }
  warn(e: string, d?: Record<string, unknown>): void { this.log('warn', e, d); }
  error(e: string, d?: Record<string, unknown>): void { this.log('error', e, d); }
  debug(e: string, d?: Record<string, unknown>): void { this.log('debug', e, d); }
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; event: string; data?: Record<string, unknown> }> = [];
  constructor(private readonly echo = false) {}
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    this.entries.push({ level, event, data });
    if (this.echo) console.log(level, event, JSON.stringify(data ?? {}));
  }
  info(e: string, d?: Record<string, unknown>): void { this.log('info', e, d); }
  warn(e: string, d?: Record<string, unknown>): void { this.log('warn', e, d); }
  error(e: string, d?: Record<string, unknown>): void { this.log('error', e, d); }
  debug(e: string, d?: Record<string, unknown>): void { this.log('debug', e, d); }
}
