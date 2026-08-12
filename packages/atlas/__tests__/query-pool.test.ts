import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { QueryPool, type PoolWorker } from '../src/mcp/query-pool';

class FakeWorker extends EventEmitter implements PoolWorker {
  postMessage(msg: unknown): void {
    const m = msg as { type: string; id?: number };
    if (m.type === 'call') {
      queueMicrotask(() => this.emit('message', { type: 'result', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    }
  }
  terminate(): Promise<number> { return Promise.resolve(0); }
  ready(): void { this.emit('message', { type: 'ready', ok: true }); }
}

describe('QueryPool warm-up', () => {
  it('proactively spawns toward maxSize as workers become ready, not just when the queue outstrips capacity', async () => {
    const created: FakeWorker[] = [];
    const pool = new QueryPool({
      root: '/tmp/none',
      size: 4,
      createWorker: () => { const w = new FakeWorker(); created.push(w); return w; },
    });

    // Construct spawns MAX_CONCURRENT_SPAWN (2) workers eagerly — not just one.
    expect(created.length).toBe(2);
    expect(pool.liveWorkers).toBe(2);

    // As each cold-start finishes, warmToTarget spawns the next one.
    created[0]!.ready();
    await Promise.resolve();
    expect(created.length).toBe(3);

    created[1]!.ready();
    await Promise.resolve();
    expect(created.length).toBe(4);

    // At maxSize, no further spawn.
    created[2]!.ready();
    created[3]!.ready();
    await Promise.resolve();
    expect(created.length).toBe(4);

    // Sanity: pool still serves calls end-to-end.
    const r = await pool.run('atlas_status', {});
    expect(r.content?.[0]).toMatchObject({ type: 'text', text: 'ok' });

    await pool.destroy();
  });
});
