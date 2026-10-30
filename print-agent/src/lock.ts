import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';

export class AlreadyRunningError extends Error {}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Single-instance lock: exclusive-create lock file holding our PID; stale locks (dead PID) are taken over. */
export class InstanceLock {
  private held = false;
  constructor(private readonly path: string) {}

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(this.path, 'wx');
        writeSync(fd, String(process.pid));
        fsyncSync(fd);
        closeSync(fd);
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let pid = NaN;
        try {
          pid = Number(readFileSync(this.path, 'utf8').trim());
        } catch {
          /* unreadable → treat as stale */
        }
        if (pid === process.pid || !pidAlive(pid)) {
          try { unlinkSync(this.path); } catch { /* raced */ }
          continue;
        }
        throw new AlreadyRunningError(`another agent instance is running (pid ${pid}); lock ${this.path}`);
      }
    }
    throw new AlreadyRunningError(`could not acquire lock ${this.path}`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const pid = Number(readFileSync(this.path, 'utf8').trim());
      if (pid === process.pid) unlinkSync(this.path);
    } catch {
      /* ignore */
    }
  }
}
