/**
 * Serialized, debounced, per-workspace user-fact ingest queue (Phase 8).
 * Reference: `docs/development/USER_INPUT_INGEST.md` §5.3, `PLAN.md` Part 11.
 *
 * Why this exists: per-utterance ingest is fired fire-and-forget after the
 * user's input is persisted. If we ran each ingest immediately and
 * concurrently, multiple merge agents would race on the shared
 * `wiki/index.md` slug-map rebuild and the `.manifest.json` append — atomic
 * writes prevent a half-written file but not a lost update (agent A's slug-map
 * clobbering agent B's new page).
 *
 * The queue:
 *   - drains ONE ingest at a time per workspace (serialized);
 *   - COALESCES whatever is pending when a drain cycle starts, grouping by
 *     (discussion/session, kind) and concatenating the text into a single
 *     merge pass — so a burst of follow-ups or sparring messages becomes one
 *     agent run, not N;
 *   - dedups double-fired *events* (double-click, retried POST) by event id —
 *     this is plumbing idempotency, NOT content dedup; it never blocks a
 *     genuine re-mention (those carry a fresh event id);
 *   - exposes `drain()` so the short-lived CLI can flush before exit.
 *
 * The core logic is exposed as a factory (`createIngestQueue`) that takes the
 * ingest runner, so tests can exercise serialization/coalescing/idempotency
 * without spawning a real `claude`. The module-level singletons use the real
 * `ingestUserFacts`.
 */
import { existsSync } from 'node:fs';
import { logger } from '../logger.js';
import { paths, resolveWorkspace, type ResolvedWorkspace } from '../../storage/paths.js';
import { ingestUserFacts, type IngestUserFactsOptions } from './ingest-user-facts.js';
import type { UserInputKind } from '../prompts/wiki-merge.js';
import type { AppSettings, StorageService } from '../../storage/types.js';

export interface UserFactJob {
  text: string;
  kind: UserInputKind;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  discussionId?: string;
  sparringSessionId?: string;
  coachSessionId?: string;
  /** Optional event identity for double-fire idempotency (e.g. UserResponse.id). */
  eventId?: string;
  /**
   * Optional callback invoked with the ingest result once the merge agent runs
   * for this job (or null if it failed). Used by the coach to surface "what was
   * added to your wiki" for a turn. Best-effort — never blocks the queue.
   */
  onResult?: (result: unknown) => void | Promise<void>;
}

export type IngestRunner = (opts: IngestUserFactsOptions) => Promise<unknown>;

interface QueueState {
  pending: UserFactJob[];
  running: boolean;
  chain: Promise<void>;
  seenEvents: Set<string>;
}

export interface IngestQueue {
  /** Enqueue a job. Returns immediately; the ingest runs in the background. */
  enqueue(job: UserFactJob): void;
  /** Await until the queue is fully drained (no pending, none running). */
  drain(): Promise<void>;
  /** Test/debug visibility into pending depth. */
  pendingCount(): number;
}

/**
 * Create an independent queue around a runner. The real singletons use
 * `ingestUserFacts`; tests inject a fake to assert ordering/coalescing.
 */
export function createIngestQueue(runner: IngestRunner = ingestUserFacts): IngestQueue {
  const state: QueueState = {
    pending: [],
    running: false,
    chain: Promise.resolve(),
    seenEvents: new Set(),
  };

  function enqueue(job: UserFactJob): void {
    if (job.eventId) {
      if (state.seenEvents.has(job.eventId)) {
        logger.debug('[ingest-queue] skipping duplicate event', { eventId: job.eventId });
        return;
      }
      state.seenEvents.add(job.eventId);
    }
    state.pending.push(job);
    kick();
  }

  function kick(): void {
    if (state.running) return;
    state.running = true;
    state.chain = (async () => {
      try {
        // Drain everything that is (or becomes) pending, one batch at a time.
        while (state.pending.length > 0) {
          const batch = state.pending.splice(0, state.pending.length);
          for (const group of coalesce(batch)) {
            try {
              const result = await runner({
                text: group.text,
                kind: group.kind,
                workspace: group.workspace,
                settings: group.settings,
                discussionId: group.discussionId,
                sparringSessionId: group.sparringSessionId,
                coachSessionId: group.coachSessionId,
              });
              if (group.onResult) {
                try { await group.onResult(result); } catch { /* best-effort */ }
              }
            } catch (error) {
              logger.warn('[ingest-queue] user-fact ingest failed (non-blocking):', error);
              if (group.onResult) {
                try { await group.onResult(null); } catch { /* best-effort */ }
              }
            }
          }
        }
      } finally {
        state.running = false;
      }
    })();
  }

  async function drain(): Promise<void> {
    // Loop because new work can be enqueued while we await the current chain.
    while (state.running || state.pending.length > 0) {
      await state.chain.catch(() => undefined);
    }
  }

  return { enqueue, drain, pendingCount: () => state.pending.length };
}

/**
 * Coalesce a batch of jobs into one merge pass per (discussion/session, kind).
 * Concatenated text is separated by a divider so the agent can still tell the
 * utterances apart. Order within a group is preserved.
 */
export function coalesce(batch: UserFactJob[]): UserFactJob[] {
  const groups = new Map<string, UserFactJob[]>();
  for (const job of batch) {
    const scope = job.discussionId ?? job.sparringSessionId ?? job.coachSessionId ?? '_';
    const key = `${scope}::${job.kind}`;
    const arr = groups.get(key);
    if (arr) arr.push(job);
    else groups.set(key, [job]);
  }
  const out: UserFactJob[] = [];
  for (const arr of groups.values()) {
    const first = arr[0]!;
    if (arr.length === 1) {
      out.push(first);
      continue;
    }
    out.push({
      ...first,
      text: arr.map((j) => j.text.trim()).filter(Boolean).join('\n\n---\n\n'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module-level singletons (one queue per workspace root) using the real runner
// ---------------------------------------------------------------------------

const queues = new Map<string, IngestQueue>();

function queueForRoot(root: string): IngestQueue {
  let q = queues.get(root);
  if (!q) {
    q = createIngestQueue();
    queues.set(root, q);
  }
  return q;
}

export interface MaybeEnqueueOptions {
  text: string;
  kind: UserInputKind;
  settings: AppSettings;
  storage: StorageService;
  discussionId?: string;
  sparringSessionId?: string;
  coachSessionId?: string;
  eventId?: string;
  onResult?: (result: unknown) => void | Promise<void>;
}

/**
 * The single entry point call sites use. Applies the Phase 8 gates (wiki
 * enabled, `autoIngestUserInputs`, non-empty text, wiki dirs exist), resolves
 * the workspace, and enqueues. Never throws — gating failures are silent
 * no-ops so a discussion is never blocked or broken by ingest.
 */
export function maybeEnqueueUserInput(opts: MaybeEnqueueOptions): void {
  try {
    const wiki = opts.settings.knowledgeWiki;
    if (wiki?.enabled === false) return;
    if (wiki?.autoIngestUserInputs === false) return;
    const text = opts.text.trim();
    if (!text) return;

    const root = opts.storage.getWorkspaceRoot();
    const p = paths(root);
    // No wiki yet → nothing to merge into. (Conclude-time ingest bootstraps it.)
    if (!existsSync(p.wiki) || !existsSync(p.wikiKnowledge)) return;

    const workspace = resolveWorkspace({ override: opts.storage.getWorkspaceId() });
    workspace.root = root; // storage knows the true root even if env differs

    queueForRoot(root).enqueue({
      text,
      kind: opts.kind,
      workspace,
      settings: opts.settings,
      discussionId: opts.discussionId,
      sparringSessionId: opts.sparringSessionId,
      coachSessionId: opts.coachSessionId,
      eventId: opts.eventId,
      onResult: opts.onResult,
    });
  } catch (error) {
    logger.debug('[ingest-queue] enqueue failed (non-blocking):', error);
  }
}

/**
 * Drain pending user-fact ingests. With a root, drains that workspace; with
 * none, drains all. Used by the CLI's `closeContext` so a short-lived process
 * flushes background ingests before exiting. Best-effort — never throws.
 */
export async function drainUserFactQueue(root?: string): Promise<void> {
  try {
    if (root) {
      const q = queues.get(root);
      if (q) await q.drain();
      return;
    }
    await Promise.all([...queues.values()].map((q) => q.drain()));
  } catch (error) {
    logger.debug('[ingest-queue] drain failed (non-blocking):', error);
  }
}
