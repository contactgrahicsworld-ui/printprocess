import { join } from 'node:path';
import { DurableJsonl } from './jsonl.js';
import type { StatusUpdateBody } from './types.js';

interface OutboxItem {
  t: 'item';
  seq: number;
  jobId: string;
  body: StatusUpdateBody;
}
interface OutboxAck {
  t: 'ack';
  seq: number;
  dropped?: boolean;
}
type OutboxLine = OutboxItem | OutboxAck;

export interface PendingUpdate {
  seq: number;
  jobId: string;
  body: StatusUpdateBody;
}

/**
 * Durable, ordered queue of status updates. Every update is written (fsync) before any send
 * attempt; it is removed only after the server answered 2xx (or a permanent 4xx). On network
 * failure the queue keeps growing and is replayed strictly in order when the server is back.
 * Replays are safe because the server treats the same (jobId, status) as a no-op.
 */
export class Outbox {
  private readonly file: DurableJsonl<OutboxLine>;
  private items: PendingUpdate[] = [];
  private nextSeq = 1;

  constructor(dataDir: string) {
    this.file = new DurableJsonl<OutboxLine>(join(dataDir, 'outbox.jsonl'));
    const acked = new Set<number>();
    const items: OutboxItem[] = [];
    for (const l of this.file.readAll()) {
      if (l.t === 'ack') acked.add(l.seq);
      else if (l.t === 'item') items.push(l);
    }
    for (const it of items) this.nextSeq = Math.max(this.nextSeq, it.seq + 1);
    this.items = items.filter((i) => !acked.has(i.seq)).sort((a, b) => a.seq - b.seq).map(({ seq, jobId, body }) => ({ seq, jobId, body }));
    this.file.rewrite(this.items.map((i) => ({ t: 'item' as const, ...i })));
  }

  enqueue(jobId: string, body: StatusUpdateBody): PendingUpdate {
    const item: PendingUpdate = { seq: this.nextSeq++, jobId, body };
    this.file.append({ t: 'item', ...item });
    this.items.push(item);
    return item;
  }

  peek(): PendingUpdate | undefined {
    return this.items[0];
  }

  pending(): PendingUpdate[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  ack(seq: number, dropped = false): void {
    this.file.append({ t: 'ack', seq, dropped });
    this.items = this.items.filter((i) => i.seq !== seq);
    if (this.items.length === 0) this.file.rewrite([]);
  }

  close(): void {
    this.file.close();
  }
}
