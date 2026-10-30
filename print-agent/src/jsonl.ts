import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './config.js';

/**
 * Append-only JSON-lines file with fsync after every append (durable across crash/power loss).
 * A torn last line (crash mid-write) is ignored on read.
 */
export class DurableJsonl<T> {
  private fd: number | null = null;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  readAll(): T[] {
    if (!existsSync(this.path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* torn write; skip */
      }
    }
    return out;
  }

  append(rec: T): void {
    if (this.fd === null) {
      // If a previous crash left a torn last line without '\n', terminate it first so the
      // new record is not glued onto the garbage.
      let needsNewline = false;
      if (existsSync(this.path)) {
        const buf = readFileSync(this.path);
        needsNewline = buf.length > 0 && buf[buf.length - 1] !== 0x0a;
      }
      this.fd = openSync(this.path, 'a');
      if (needsNewline) writeSync(this.fd, '\n');
    }
    writeSync(this.fd, JSON.stringify(rec) + '\n');
    fsyncSync(this.fd);
  }

  /** Atomically replace the file with the given records (compaction). */
  rewrite(recs: T[]): void {
    this.close();
    writeFileAtomic(this.path, recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
  }

  close(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }
}
