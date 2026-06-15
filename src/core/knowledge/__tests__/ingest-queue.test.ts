import { describe, it, expect, vi } from 'vitest';
import { createIngestQueue, coalesce, type UserFactJob } from '../ingest-queue.js';
import type { ResolvedWorkspace } from '../../../storage/paths.js';
import type { AppSettings } from '../../../storage/types.js';

const ws: ResolvedWorkspace = { id: 'test', root: '/ws', scope: 'home' };
const settings = {} as AppSettings;

function job(partial: Partial<UserFactJob> & { text: string }): UserFactJob {
  return {
    kind: 'follow_up',
    workspace: ws,
    settings,
    ...partial,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createIngestQueue', () => {
  it('runs jobs serially — never two runners in flight at once', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await flush();
      active--;
    });
    const q = createIngestQueue(runner);

    q.enqueue(job({ text: 'a', discussionId: 'd1' }));
    q.enqueue(job({ text: 'b', discussionId: 'd2' }));
    q.enqueue(job({ text: 'c', discussionId: 'd3' }));
    await q.drain();

    expect(maxActive).toBe(1);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('coalesces items that arrive while a run is in flight into one run', async () => {
    // The realistic case: a slow ingest holds the queue open; follow-ups that
    // land during that window get batched into a single next run.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const texts: string[] = [];
    const runner = vi.fn(async (o: unknown) => {
      calls++;
      texts.push((o as UserFactJob).text);
      if (calls === 1) await gate; // hold the first run open
    });
    const q = createIngestQueue(runner);

    q.enqueue(job({ text: 'one', discussionId: 'd1', kind: 'follow_up' })); // starts running, blocks
    await flush();
    // These two land while the first run is in flight → coalesced next batch.
    q.enqueue(job({ text: 'two', discussionId: 'd1', kind: 'follow_up' }));
    q.enqueue(job({ text: 'three', discussionId: 'd1', kind: 'follow_up' }));
    release();
    await q.drain();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(texts[0]).toBe('one');
    expect(texts[1]).toContain('two');
    expect(texts[1]).toContain('three');
  });

  it('does NOT coalesce across different discussions or kinds', async () => {
    const runner = vi.fn(async () => {
      await flush();
    });
    const q = createIngestQueue(runner);
    q.enqueue(job({ text: 'a', discussionId: 'd1', kind: 'follow_up' }));
    q.enqueue(job({ text: 'b', discussionId: 'd2', kind: 'follow_up' }));
    q.enqueue(job({ text: 'c', discussionId: 'd1', kind: 'hitl_response' }));
    await q.drain();
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('skips duplicate events by eventId (double-fire idempotency)', async () => {
    const runner = vi.fn(async () => {
      await flush();
    });
    const q = createIngestQueue(runner);
    q.enqueue(job({ text: 'x', discussionId: 'd1', eventId: 'evt-1' }));
    q.enqueue(job({ text: 'x', discussionId: 'd1', eventId: 'evt-1' })); // dup
    await q.drain();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('a runner failure does not break the queue (subsequent jobs still run)', async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const q = createIngestQueue(runner);
    q.enqueue(job({ text: 'fails', discussionId: 'd1' }));
    await q.drain();
    q.enqueue(job({ text: 'ok', discussionId: 'd2' }));
    await q.drain();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('processes work enqueued mid-drain', async () => {
    const seen: string[] = [];
    const q = createIngestQueue(async (o) => {
      seen.push((o as UserFactJob).text);
      await flush();
    });
    q.enqueue(job({ text: 'first', discussionId: 'd1' }));
    // Enqueue more while the first is still running.
    await flush();
    q.enqueue(job({ text: 'second', discussionId: 'd2' }));
    await q.drain();
    expect(seen).toEqual(['first', 'second']);
  });
});

describe('coalesce', () => {
  it('preserves order within a group and joins with a divider', () => {
    const out = coalesce([
      job({ text: 'one', discussionId: 'd1' }),
      job({ text: 'two', discussionId: 'd1' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('one\n\n---\n\ntwo');
  });

  it('groups sparring messages by session when no discussion scope differs', () => {
    const out = coalesce([
      job({ text: 'a', kind: 'sparring_message', sparringSessionId: 's1' }),
      job({ text: 'b', kind: 'sparring_message', sparringSessionId: 's1' }),
      job({ text: 'c', kind: 'sparring_message', sparringSessionId: 's2' }),
    ]);
    expect(out).toHaveLength(2);
  });
});
