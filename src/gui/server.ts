/**
 * Local Express + WebSocket server for the AI Advisory Board UI.
 *
 * Mounts at http://localhost:<port> (default 3737).
 * Static files live in `gui/` at the package root.
 *
 * REST endpoints (read):
 *   GET  /api/state           bootstrap (settings, members, principles, action items, discussion list)
 *   GET  /api/discussions     paginated list
 *   GET  /api/discussions/:id full discussion
 *   GET  /api/members
 *   GET  /api/principles
 *   GET  /api/actions
 *
 * REST endpoints (write):
 *   POST /api/discussions               start a new discussion (body: { question, memberIds? })
 *   POST /api/discussions/:id/continue  drive next round (orchestrator-gated)
 *   POST /api/discussions/:id/respond   answer pending HITL request (body: { content, selectedOption? })
 *   POST /api/discussions/:id/follow-up ask a targeted follow-up
 *                                        (body: { question, targetType, selectedMemberId?, selectedMemberIds? })
 *
 * WebSocket events (server → client) on /ws:
 *   { type: 'discussion_started',   discussion }
 *   { type: 'member_thinking',      discussionId, memberName, memberId, slug, index, total }
 *   { type: 'member_response',      discussionId, memberName, memberId, response, roundNumber, durationMs, costUsd }
 *   { type: 'orchestrator_decision',discussionId, decision }
 *   { type: 'discussion_gated',     discussion } — pre-round gate asked for user input
 *   { type: 'discussion_completed', discussion }
 *   { type: 'error',                discussionId?, message }
 */
import express, { Request, Response } from 'express';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import {
  addFollowUpQuestion,
  continueDiscussion,
  respondToUserRequest,
  startDiscussion,
  type FollowUpTargetType,
} from '../core/discussion/conversation-flow.js';
import { unlinkSync } from 'node:fs';
import {
  emitMemberAgentFile,
  isAabGenerated,
  memberAgentPath,
  memberAgentSlug,
  readMemberAgentColor,
} from '../agents/emit-member-agent.js';
import { logger } from '../core/logger.js';
import { generateUUID, nowIso } from '../core/utils.js';
import type { FsStorageService } from '../storage/fs-storage-service.js';
import { DEFAULT_SETTINGS } from '../storage/types.js';
import { paths, resolveWorkspace } from '../storage/paths.js';
import { walkWikiPages, parsePage, serializePage, extractWikiLinks, toPosix, type PageType } from '../core/knowledge/page.js';
import { buildSlugMap, resolveSlug, extractBacklinksSection } from '../core/knowledge/slug-map.js';
import { loadManifest, markUserEdited } from '../core/knowledge/manifest.js';
import { renameSlug } from '../core/knowledge/rename.js';
import { ingestFile, ingestFileBuffer, ingestPaste, ingestUrl, ingestDiscussionRaw } from '../core/knowledge/ingest.js';
import { queryWiki } from '../core/knowledge/query.js';
import { lintWiki } from '../core/knowledge/lint.js';
import { existsSync as fsExistsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  ActionItem,
  AdvisoryBoardMember,
  AppSettings,
  Board,
  DecisionSession,
  Discussion,
  Principle,
  PrincipleCategory,
} from '../storage/types.js';
import {
  boardSlug,
  ensureUniqueBoardSlug,
  validateBoardFields,
} from '../core/boards/board-helpers.js';
import { pruneMemberFromBoards } from '../core/boards/prune-member-from-boards.js';
import {
  extractActionItems,
  type ExtractedActionItem,
} from '../core/actions/conversation-analyzer.js';
import { buildSourceContext } from '../core/actions/source-context.js';
import { enhancePersona, researchExpertise, type EnhancementType } from '../core/members/ai-enhancer.js';
import { generateVoiceGuide } from '../core/members/voice-guide.js';
import { coachReply, newDecisionSession } from '../core/coach/decision-coach.js';
import { maybeEnqueueUserInput } from '../core/knowledge/ingest-queue.js';
import {
  EXPLORER_STEPS,
  applyStep,
  explorerReply,
  type ExplorerStep,
  type ExplorerTurn,
} from '../core/coach/principle-explorer.js';
import { openSparringSession, sendSparringMessage } from '../core/sparring/sparring-service.js';
import { injectSparringInsight } from '../core/sparring/inject-insight.js';
import { STARTER_PRINCIPLES } from '../starter/starter-principles.js';
import { runSolve, type SolveEvent } from '../core/skill/solve-orchestrator.js';
import { renderProposalMarkdown, type ResolvedSkillCapabilityProfile } from '../core/skill/planner-review.js';
import { resolveSkill } from '../core/skill/resolve-skill-creator.js';
import { listInstalledSkills } from '../commands/skills.js';
import { scan as scanPc } from '../core/skill/recon/pc-scan.js';
import type { SkillDesignProposal } from '../core/parsing/llm-response-schemas.js';
import { summariseUsage } from '../core/tokens/usage-summary.js';

const PRINCIPLE_CATEGORIES: PrincipleCategory[] = [
  'life',
  'work',
  'relationships',
  'health',
  'finance',
  'meta',
];

function coerceCategory(input: unknown, fallback: PrincipleCategory = 'meta'): PrincipleCategory {
  return typeof input === 'string' && (PRINCIPLE_CATEGORIES as string[]).includes(input)
    ? (input as PrincipleCategory)
    : fallback;
}

const ACTION_PRIORITIES = ['low', 'medium', 'high'] as const;
const ACTION_STATUSES = ['pending', 'in-progress', 'completed'] as const;
type ActionPriority = (typeof ACTION_PRIORITIES)[number];
type ActionStatus = (typeof ACTION_STATUSES)[number];

function coerceActionPriority(value: unknown, fallback: ActionPriority = 'medium'): ActionPriority {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((ACTION_PRIORITIES as readonly string[]).includes(v)) return v as ActionPriority;
  }
  return fallback;
}

function coerceActionStatus(value: unknown, fallback: ActionStatus = 'pending'): ActionStatus {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((ACTION_STATUSES as readonly string[]).includes(v)) return v as ActionStatus;
    if (v === 'inprogress' || v === 'in_progress' || v === 'doing') return 'in-progress';
    if (v === 'todo') return 'pending';
    if (v === 'done') return 'completed';
  }
  return fallback;
}

/**
 * Load the discussion + members and snapshot the source context for an action
 * item. Best-effort: any failure (missing discussion, storage hiccup) yields
 * `undefined` so action creation never breaks on enrichment.
 */
async function resolveSourceContext(
  storage: FsStorageService,
  args: { discussionId: string; title?: string; memberId?: string; memberName?: string },
): Promise<ActionItem['sourceContext']> {
  try {
    const discussion = await storage.loadDiscussionById(args.discussionId);
    if (!discussion) return undefined;
    const members = await storage.loadBoardMembers();
    return buildSourceContext(discussion, members, {
      memberId: args.memberId,
      memberName: args.memberName,
      stepText: args.title,
    });
  } catch (err) {
    logger.debug('[actions] sourceContext resolution failed', {
      discussionId: args.discussionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

const DEFAULT_PORT = 3737;

export interface UiServerOptions {
  storage: FsStorageService;
  port?: number;
  host?: string;
  /** Project root for `.claude/agents/` lookup (defaults to cwd). */
  projectRoot?: string;
}

export interface UiServerHandle {
  url: string;
  close: () => Promise<void>;
}

interface BroadcastEvent {
  type: string;
  [key: string]: unknown;
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? '127.0.0.1';
  const projectRoot = opts.projectRoot ?? process.cwd();
  const guiDir = resolveGuiDir();

  const app = express();
  // Most routes carry tiny JSON. The wiki-ingest route is the exception: it can
  // carry a base64-encoded local file (file/folder picker in the web UI), so it
  // gets a much larger body cap. Localhost-only, single trusted client.
  const jsonStd = express.json({ limit: '256kb' });
  const jsonLarge = express.json({ limit: '64mb' });
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/knowledge/ingest') return jsonLarge(req, res, next);
    return jsonStd(req, res, next);
  });

  // ---------- WebSocket broadcast plumbing ----------
  const sockets = new Set<WebSocket>();
  const broadcast = (evt: BroadcastEvent): void => {
    const data = JSON.stringify(evt);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  // ---------- Static files ----------
  app.use(express.static(guiDir));

  // ---------- API: read ----------
  app.get('/api/state', async (_req, res) => {
    try {
      const [settings, members, principles, actionItems, discussionPage, boards] = await Promise.all([
        opts.storage.loadSettings(),
        opts.storage.loadBoardMembers(),
        opts.storage.loadPrinciples(),
        opts.storage.loadActionItems(),
        opts.storage.loadDiscussionPage({ limit: 50 }),
        opts.storage.loadBoards(),
      ]);
      const enrichedBoards = await Promise.all(boards.filter((b) => !b.archivedAt).map((b) => enrichBoard(b)));
      res.json({
        workspace: {
          id: opts.storage.getWorkspaceId(),
          root: opts.storage.getWorkspaceRoot(),
          scope: opts.storage.getWorkspaceScope(),
          projectRoot,
        },
        settings,
        members: enrichMembers(members, projectRoot),
        principles,
        actionItems,
        discussions: discussionPage.discussions,
        discussionTotal: discussionPage.totalCount,
        boards: enrichedBoards,
        activeBoardId: settings.activeBoardId ?? null,
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/discussions', async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const page = await opts.storage.loadDiscussionPage({ limit, offset });
      res.json(page);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/discussions/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const direct = await opts.storage.loadDiscussionById(id);
      if (direct) {
        res.json(direct);
        return;
      }
      // Allow short-id prefix lookup
      const all = await opts.storage.loadDiscussions();
      const matches = all.filter((d) => d.id.startsWith(id));
      if (matches.length === 0) {
        res.status(404).json({ error: `No discussion matching "${id}"` });
        return;
      }
      if (matches.length > 1) {
        res.status(409).json({ error: `Multiple discussions match "${id}"` });
        return;
      }
      res.json(matches[0]);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // PATCH /api/discussions/:id — rename (set the display title). Body: { title }.
  // We set `title` rather than mutating `question` (the prompt members were
  // asked). An empty/whitespace title clears it (falls back to the question).
  app.patch('/api/discussions/:id', async (req, res) => {
    try {
      const discussion = await resolveDiscussionByIdOrPrefix(opts.storage, req.params.id, res);
      if (!discussion) return;
      const body = req.body as { title?: unknown };
      if (!('title' in (body ?? {}))) {
        res.status(400).json({ error: 'Body must include a `title` string.' });
        return;
      }
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      discussion.title = title || undefined;
      await opts.storage.updateDiscussion(discussion);
      res.json(discussion);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // DELETE /api/discussions/:id — permanently delete a discussion.
  app.delete('/api/discussions/:id', async (req, res) => {
    try {
      const discussion = await resolveDiscussionByIdOrPrefix(opts.storage, req.params.id, res);
      if (!discussion) return;
      await opts.storage.deleteDiscussion(discussion.id);
      res.status(204).end();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/members', async (_req, res) => {
    try {
      const members = await opts.storage.loadBoardMembers();
      res.json(enrichMembers(members, projectRoot));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Phase 6.5 — Usage dashboard. Aggregates token-usage JSONL logs into the
  // totals / by-day / by-feature / by-model shape the GUI renders. The
  // `since` query (YYYY-MM-DD) trims the daily-file scan window; the default
  // is the last 30 days. `limit` caps the raw log fetch to keep large
  // workspaces snappy.
  app.get('/api/usage', async (req, res) => {
    try {
      const sinceParam = typeof req.query.since === 'string' ? req.query.since : undefined;
      const since =
        sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)
          ? sinceParam
          : (() => {
              const d = new Date();
              d.setUTCDate(d.getUTCDate() - 29); // last 30 days inclusive
              return d.toISOString().slice(0, 10);
            })();
      const limit = req.query.limit ? Math.max(1, Math.min(100000, Number(req.query.limit))) : undefined;
      const logs = await opts.storage.loadTokenUsageLogs(limit !== undefined ? { since, limit } : { since });
      res.json({ since, summary: summariseUsage(logs), totalLogs: logs.length });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/principles', async (_req, res) => {
    try {
      res.json(await opts.storage.loadPrinciples());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/actions', async (_req, res) => {
    try {
      res.json(await opts.storage.loadActionItems());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Action Items CRUD (Phase 4)
  // ============================================================

  app.post('/api/actions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<ActionItem> & {
        sourceMemberId?: string;
        sourceMemberName?: string;
      };
      if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const now = nowIso();
      const priority = coerceActionPriority(body.priority);
      const status = coerceActionStatus(body.status);
      const title = body.title.trim();
      const discussionId = typeof body.discussionId === 'string' ? body.discussionId : undefined;

      // Snapshot discussion provenance so a later Plan/Solve gets the member's
      // real reasoning + the original question, not just "Suggested by X".
      const sourceContext = discussionId
        ? await resolveSourceContext(opts.storage, {
            discussionId,
            title,
            memberId: body.sourceMemberId,
            memberName: body.sourceMemberName,
          })
        : undefined;

      const item: ActionItem = {
        id: generateUUID(),
        discussionId,
        title,
        description: typeof body.description === 'string' ? body.description : '',
        priority,
        status,
        assignedTo: typeof body.assignedTo === 'string' && body.assignedTo.trim() ? body.assignedTo.trim() : undefined,
        dueDate: typeof body.dueDate === 'string' && body.dueDate.trim() ? body.dueDate.trim() : undefined,
        ...(sourceContext ? { sourceContext } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await opts.storage.saveActionItem(item);
      broadcast({ type: 'action_created', action: item });
      res.status(201).json(item);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.patch('/api/actions/:id', async (req, res) => {
    try {
      const all = await opts.storage.loadActionItems();
      const existing = all.find((i) => i.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No action item with id ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as Partial<ActionItem>;
      const updated: ActionItem = {
        ...existing,
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.priority === 'string' ? { priority: coerceActionPriority(body.priority) } : {}),
        ...(typeof body.status === 'string' ? { status: coerceActionStatus(body.status) } : {}),
        ...(typeof body.dueDate === 'string'
          ? { dueDate: body.dueDate.trim() || undefined }
          : {}),
        ...(typeof body.assignedTo === 'string'
          ? { assignedTo: body.assignedTo.trim() || undefined }
          : {}),
        ...(typeof body.discussionId === 'string' ? { discussionId: body.discussionId } : {}),
        updatedAt: nowIso(),
      };
      await opts.storage.updateActionItem(updated);
      broadcast({ type: 'action_updated', action: updated, from: existing.status, to: updated.status });
      res.json(updated);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.delete('/api/actions/:id', async (req, res) => {
    try {
      const all = await opts.storage.loadActionItems();
      const existing = all.find((i) => i.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No action item with id ${req.params.id}` });
        return;
      }
      await opts.storage.deleteActionItem(req.params.id);
      broadcast({ type: 'action_deleted', id: req.params.id });
      res.status(204).end();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Extract candidate action items from a concluded discussion.
  // POST /api/discussions/:id/actions/extract  → { candidates, method, analysisConfidence, ... }
  // POST /api/discussions/:id/actions/extract  with body { accept: [{title, description, ...}, ...] }
  //   → persists each accepted candidate and returns { created: ActionItem[] }
  app.post('/api/discussions/:id/actions/extract', async (req, res) => {
    try {
      const discussion = await opts.storage.loadDiscussionById(req.params.id);
      if (!discussion) {
        res.status(404).json({ error: `No discussion with id ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as { accept?: unknown };

      // Two modes: list candidates (no body) OR persist accepted items.
      if (Array.isArray(body.accept)) {
        const created: ActionItem[] = [];
        const members = await opts.storage.loadBoardMembers();
        for (const raw of body.accept) {
          if (!raw || typeof raw !== 'object') continue;
          const cand = raw as Partial<ExtractedActionItem>;
          if (!cand.title || typeof cand.title !== 'string' || !cand.title.trim()) continue;
          const now = nowIso();
          const title = cand.title.trim().slice(0, 200);
          const sourceContext = buildSourceContext(discussion, members, {
            memberId: cand.sourceMemberId,
            memberName: cand.sourceMemberName,
            stepText: title,
          });
          const item: ActionItem = {
            id: generateUUID(),
            discussionId: discussion.id,
            title,
            description: typeof cand.description === 'string' ? cand.description : '',
            priority: coerceActionPriority(cand.priority),
            status: 'pending',
            assignedTo:
              typeof cand.suggestedAssignee === 'string' && cand.suggestedAssignee.trim()
                ? cand.suggestedAssignee.trim()
                : undefined,
            dueDate:
              typeof cand.suggestedDueDate === 'string' && cand.suggestedDueDate.trim()
                ? cand.suggestedDueDate.trim()
                : undefined,
            ...(sourceContext ? { sourceContext } : {}),
            createdAt: now,
            updatedAt: now,
          };
          await opts.storage.saveActionItem(item);
          created.push(item);
          broadcast({ type: 'action_created', action: item, fromDiscussionId: discussion.id });
        }
        broadcast({ type: 'actions_extracted', discussionId: discussion.id, createdCount: created.length });
        res.status(201).json({ created });
        return;
      }

      const settings = await opts.storage.loadSettings();
      const analysis = await extractActionItems({ discussion, settings });
      res.json({
        discussionId: discussion.id,
        method: analysis.method,
        analysisConfidence: analysis.analysisConfidence,
        processingTimeMs: analysis.processingTimeMs,
        candidates: analysis.actionItems,
        keyInsights: analysis.keyInsights,
        recommendedNextSteps: analysis.recommendedNextSteps,
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Members CRUD
  // ============================================================

  // Create
  app.post('/api/members', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<AdvisoryBoardMember>;
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const all = await opts.storage.loadBoardMembers();
      if (all.some((m) => m.name.trim().toLowerCase() === body.name!.trim().toLowerCase())) {
        res.status(409).json({ error: `A member named "${body.name}" already exists.` });
        return;
      }
      const now = nowIso();
      const member: AdvisoryBoardMember = {
        id: generateUUID(),
        name: body.name.trim(),
        title: body.title?.trim() || 'Advisor',
        expertise: Array.isArray(body.expertise) ? body.expertise.filter(Boolean) : [],
        persona:
          body.persona?.trim() ||
          `${body.name.trim()} brings their unique perspective and expertise to advisory board discussions.`,
        voiceGuide: body.voiceGuide?.trim() || undefined,
        avatar: body.avatar?.trim() || undefined,
        allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : undefined,
        isActive: body.isActive !== false,
        createdAt: now,
        updatedAt: now,
      };
      await opts.storage.saveBoardMember(member);
      // Emit the .claude/agents/<slug>.md file so CLI and Claude Code can dispatch.
      try {
        emitMemberAgentFile(member, { projectRoot });
      } catch (err) {
        logger.warn('[ui] failed to emit agent file:', err);
      }
      res.status(201).json(enrichOne(member));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Update
  app.patch('/api/members/:id', async (req, res) => {
    try {
      const all = await opts.storage.loadBoardMembers();
      const existing = all.find((m) => m.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No member with id ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as Partial<AdvisoryBoardMember>;
      const updated: AdvisoryBoardMember = {
        ...existing,
        ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
        ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
        ...(Array.isArray(body.expertise) ? { expertise: body.expertise.filter(Boolean) } : {}),
        ...(typeof body.persona === 'string' ? { persona: body.persona.trim() } : {}),
        ...(typeof body.voiceGuide === 'string'
          ? { voiceGuide: body.voiceGuide.trim() || undefined }
          : {}),
        ...(typeof body.avatar === 'string' ? { avatar: body.avatar.trim() || undefined } : {}),
        ...(Array.isArray(body.allowedTools)
          ? { allowedTools: body.allowedTools.length === 0 ? undefined : body.allowedTools }
          : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        updatedAt: nowIso(),
      };
      await opts.storage.updateBoardMember(updated);
      // Re-emit agent file when name/persona/expertise/voice changed.
      const shouldRegen =
        body.name !== undefined ||
        body.persona !== undefined ||
        body.expertise !== undefined ||
        body.voiceGuide !== undefined ||
        body.allowedTools !== undefined;
      if (shouldRegen) {
        try {
          // If name changed, the old slug file is now orphaned — clean up if AAB-generated.
          if (body.name && body.name !== existing.name) {
            const oldPath = memberAgentPath(memberAgentSlug(existing.name), projectRoot);
            if (isAabGenerated(oldPath)) {
              try {
                unlinkSync(oldPath);
              } catch {
                /* fine — file may not exist */
              }
            }
          }
          emitMemberAgentFile(updated, { projectRoot });
        } catch (err) {
          logger.warn('[ui] failed to re-emit agent file:', err);
        }
      }
      res.json(enrichOne(updated));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Delete
  app.delete('/api/members/:id', async (req, res) => {
    try {
      const all = await opts.storage.loadBoardMembers();
      const existing = all.find((m) => m.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No member with id ${req.params.id}` });
        return;
      }
      await opts.storage.deleteBoardMember(existing.id);
      // Cascade-prune the member from every board's roster (Phase 7 orphan fix).
      const prune = await pruneMemberFromBoards(opts.storage, existing.id);
      // Clean up the agent file iff it was AAB-generated (don't nuke user-edited).
      try {
        const p = memberAgentPath(memberAgentSlug(existing.name), projectRoot);
        if (isAabGenerated(p)) {
          unlinkSync(p);
        }
      } catch {
        /* fine */
      }
      if (prune.affected.length > 0) {
        for (const b of prune.affected) {
          broadcast({ type: 'board_updated', board: await enrichBoard(b) });
        }
      }
      // 204 has no body; surface affected boards via a 200 JSON so the UI can toast.
      res.status(200).json({
        deleted: true,
        affectedBoards: prune.affected.map((b) => ({ id: b.id, name: b.name, memberCount: b.memberIds.length })),
        emptiedBoards: prune.emptied.map((b) => ({ id: b.id, name: b.name })),
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Boards (member groups) — Phase 7
  // ============================================================

  async function enrichBoard(board: Board): Promise<Record<string, unknown>> {
    const members = await opts.storage.loadBoardMembers();
    const byId = new Map(members.map((m) => [m.id, m]));
    const memberPreviews = board.memberIds.map((id) => {
      const m = byId.get(id);
      if (!m) return { id, name: '(deleted member)', slug: '', initials: '?', active: false, missing: true };
      return {
        id: m.id,
        name: m.name,
        slug: memberAgentSlug(m.name),
        initials: initialsOf(m.name),
        active: m.isActive,
        ...(readMemberAgentColor(m.name, projectRoot) ? { color: readMemberAgentColor(m.name, projectRoot) } : {}),
      };
    });
    const activeMemberCount = board.memberIds
      .map((id) => byId.get(id))
      .filter((m) => m && m.isActive).length;
    return { ...board, members: memberPreviews, activeMemberCount };
  }

  // List
  app.get('/api/boards', async (_req, res) => {
    try {
      const settings = await opts.storage.loadSettings();
      const boards = await opts.storage.loadBoards();
      const enriched = await Promise.all(boards.filter((b) => !b.archivedAt).map((b) => enrichBoard(b)));
      res.json({ boards: enriched, activeBoardId: settings.activeBoardId ?? null });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Active (resolved) — registered before any /:id route so it isn't shadowed.
  app.get('/api/boards/active', async (_req, res) => {
    try {
      const settings = await opts.storage.loadSettings();
      const boards = await opts.storage.loadBoards();
      const board = settings.activeBoardId ? boards.find((b) => b.id === settings.activeBoardId) : undefined;
      res.json({ board: board ? await enrichBoard(board) : null });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Create
  app.post('/api/boards', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { name?: string; description?: string; memberIds?: string[] };
      const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.filter(Boolean))] : [];
      const boards = await opts.storage.loadBoards();
      const members = await opts.storage.loadBoardMembers();
      const errors = validateBoardFields(
        { name: body.name ?? '', description: body.description, memberIds },
        { existingBoards: boards, members },
      );
      if (errors.length > 0) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
      const slug = ensureUniqueBoardSlug(boardSlug(body.name!.trim()), boards.map((b) => b.slug));
      const now = nowIso();
      const board: Board = {
        id: generateUUID(),
        name: body.name!.trim(),
        slug,
        description: body.description?.trim() || undefined,
        memberIds,
        createdAt: now,
        updatedAt: now,
      };
      await opts.storage.saveBoard(board);
      const enriched = await enrichBoard(board);
      broadcast({ type: 'board_created', board: enriched });
      res.status(201).json(enriched);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Update (name / description / memberIds)
  app.patch('/api/boards/:id', async (req, res) => {
    try {
      const boards = await opts.storage.loadBoards();
      const existing = boards.find((b) => b.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No board with id ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as { name?: string; description?: string; memberIds?: string[] };
      const members = await opts.storage.loadBoardMembers();
      const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
      const nextDescription = body.description !== undefined ? body.description.trim() : existing.description;
      const nextMemberIds = Array.isArray(body.memberIds)
        ? [...new Set(body.memberIds.filter(Boolean))]
        : existing.memberIds;
      const errors = validateBoardFields(
        { name: nextName, description: nextDescription, memberIds: nextMemberIds },
        { existingBoards: boards, members, excludeBoardId: existing.id },
      );
      if (errors.length > 0) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
      const next: Board = {
        ...existing,
        name: nextName,
        description: nextDescription || undefined,
        memberIds: nextMemberIds,
        ...(typeof body.name === 'string' && body.name.trim() && boardSlug(nextName) !== existing.slug
          ? { slug: ensureUniqueBoardSlug(boardSlug(nextName), boards.filter((b) => b.id !== existing.id).map((b) => b.slug)) }
          : {}),
      };
      await opts.storage.updateBoard(next);
      const enriched = await enrichBoard(next);
      broadcast({ type: 'board_updated', board: enriched });
      res.json(enriched);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Delete (boards only — never touches members)
  app.delete('/api/boards/:id', async (req, res) => {
    try {
      const boards = await opts.storage.loadBoards();
      const existing = boards.find((b) => b.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No board with id ${req.params.id}` });
        return;
      }
      await opts.storage.deleteBoard(existing.id);
      const settings = await opts.storage.loadSettings();
      if (settings.activeBoardId === existing.id) {
        await opts.storage.saveSettings({ ...settings, activeBoardId: undefined });
      }
      broadcast({ type: 'board_deleted', boardId: existing.id });
      res.status(200).json({ deleted: true });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Activate (set settings.activeBoardId)
  app.post('/api/boards/:id/activate', async (req, res) => {
    try {
      const boards = await opts.storage.loadBoards();
      const board = boards.find((b) => b.id === req.params.id);
      if (!board) {
        res.status(404).json({ error: `No board with id ${req.params.id}` });
        return;
      }
      const settings = await opts.storage.loadSettings();
      await opts.storage.saveSettings({ ...settings, activeBoardId: board.id });
      broadcast({ type: 'board_activated', boardId: board.id });
      res.json({ activeBoardId: board.id, board: await enrichBoard(board) });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Members — AI enhancement, voice refresh, agent-file regen
  // ============================================================

  function normalizeEnhanceTypeOrThrow(raw: unknown): EnhancementType {
    const v = String(raw ?? 'non-famous').toLowerCase().trim();
    if (v === 'famous') return 'famous';
    if (v === 'expert' || v === 'top-expert' || v === 'top_expert') return 'expert';
    if (v === 'non-famous' || v === 'non_famous' || v === 'practitioner') return 'non-famous';
    throw new Error(`Unknown enhance type "${raw}"`);
  }

  app.post('/api/members/:id/enhance', async (req, res) => {
    try {
      const all = await opts.storage.loadBoardMembers();
      const existing = all.find((m) => m.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No member with id ${req.params.id}` });
        return;
      }
      let type: EnhancementType;
      try {
        type = normalizeEnhanceTypeOrThrow((req.body ?? {}).type);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const keepVoice = (req.body ?? {}).keepVoice === true;
      res.status(202).json({ accepted: true, memberId: existing.id, type });
      broadcast({ type: 'member_enhance_started', memberId: existing.id, memberName: existing.name, enhanceType: type });

      (async () => {
        try {
          const settings = await opts.storage.loadSettings();
          const result = await enhancePersona(
            { name: existing.name, title: existing.title, expertise: existing.expertise, type },
            settings,
            {
              currentPersona: existing.persona,
              onEvent: (event) => {
                if (event.type === 'assistant' || event.type === 'tool_use') {
                  broadcast({ type: 'member_enhance_progress', memberId: existing.id, event: { type: event.type, subtype: event.subtype } });
                }
              },
            },
          );
          const next: AdvisoryBoardMember = {
            ...existing,
            persona: result.persona,
            voiceGuide: keepVoice ? existing.voiceGuide : result.voiceGuide || existing.voiceGuide,
            updatedAt: nowIso(),
          };
          await opts.storage.updateBoardMember(next);
          try {
            emitMemberAgentFile(next, { projectRoot });
          } catch (err) {
            logger.warn('[ui] failed to emit agent file:', err);
          }
          broadcast({ type: 'member_enhance_done', memberId: existing.id, member: enrichOne(next), enhanceType: type });
        } catch (error) {
          broadcast({
            type: 'member_enhance_failed',
            memberId: existing.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // POST /api/members/enhance-preview — stateless AI fill for the Add-Member
  // wizard. Derives name/title from the chosen archetype, runs an expertise
  // web-research call + the persona enhancer, and streams the result over WS
  // WITHOUT persisting anything. The wizard populates its editable fields from
  // the `member_preview_done` payload, then the user saves via POST /api/members.
  app.post('/api/members/enhance-preview', async (req, res) => {
    let type: EnhancementType;
    try {
      type = normalizeEnhanceTypeOrThrow((req.body ?? {}).type);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const body = (req.body ?? {}) as {
      name?: string;
      title?: string;
      field?: string;
      role?: string;
      domain?: string;
    };

    // Resolve archetype → { name, title, subject, context } per the chosen type.
    let name: string;
    let title: string;
    let subject: string;
    let context: string | undefined;
    if (type === 'famous') {
      name = (body.name ?? '').trim();
      title = (body.title ?? '').trim() || 'Advisor';
      if (!name) {
        res.status(400).json({ error: 'name is required for a well-known person' });
        return;
      }
      subject = name;
      context = title;
    } else if (type === 'expert') {
      const field = (body.field ?? '').trim();
      if (!field) {
        res.status(400).json({ error: 'field is required for a top 1% expert' });
        return;
      }
      name = `${field} Expert`;
      title = 'Top 1% Expert';
      subject = field;
      context = undefined;
    } else {
      // non-famous / practitioner
      const role = (body.role ?? '').trim();
      const domain = (body.domain ?? '').trim();
      if (!role) {
        res.status(400).json({ error: 'role is required for a practitioner' });
        return;
      }
      name = role;
      title = domain ? `${domain} practitioner` : 'Practitioner';
      subject = role;
      context = domain || undefined;
    }

    const previewId = generateUUID();
    res.status(202).json({ accepted: true, previewId, name, title, type });
    broadcast({ type: 'member_preview_started', previewId, name, enhanceType: type });

    (async () => {
      try {
        const settings = await opts.storage.loadSettings();
        broadcast({ type: 'member_preview_progress', previewId, stage: 'research' });
        const expertise = await researchExpertise({ subject, context, type }, settings);
        broadcast({ type: 'member_preview_progress', previewId, stage: 'persona' });
        const result = await enhancePersona(
          { name, title, expertise, type },
          settings,
          {
            onEvent: (event) => {
              if (event.type === 'assistant' || event.type === 'tool_use') {
                broadcast({ type: 'member_preview_progress', previewId, stage: 'persona', event: { type: event.type, subtype: event.subtype } });
              }
            },
          },
        );
        broadcast({
          type: 'member_preview_done',
          previewId,
          result: {
            name,
            title,
            expertise,
            persona: result.persona,
            voiceGuide: result.voiceGuide,
          },
        });
      } catch (error) {
        broadcast({
          type: 'member_preview_failed',
          previewId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  app.post('/api/members/:id/regenerate-voice', async (req, res) => {
    try {
      const all = await opts.storage.loadBoardMembers();
      const existing = all.find((m) => m.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No member with id ${req.params.id}` });
        return;
      }
      const settings = await opts.storage.loadSettings();
      broadcast({ type: 'member_voice_started', memberId: existing.id, memberName: existing.name });
      const result = await generateVoiceGuide(existing, settings);
      const preview = (req.body ?? {}).preview === true;
      if (preview) {
        broadcast({ type: 'member_voice_preview', memberId: existing.id, voiceGuide: result.voiceGuide, fellBack: result.fellBack });
        res.json({ voiceGuide: result.voiceGuide, fellBack: result.fellBack, applied: false });
        return;
      }
      const next: AdvisoryBoardMember = {
        ...existing,
        voiceGuide: result.voiceGuide,
        updatedAt: nowIso(),
      };
      await opts.storage.updateBoardMember(next);
      try {
        emitMemberAgentFile(next, { projectRoot });
      } catch (err) {
        logger.warn('[ui] failed to emit agent file:', err);
      }
      broadcast({ type: 'member_voice_done', memberId: existing.id, member: enrichOne(next), fellBack: result.fellBack });
      res.json({ voiceGuide: result.voiceGuide, fellBack: result.fellBack, applied: true, member: enrichOne(next) });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/members/sync-agents', async (req, res) => {
    try {
      const includeInactive = (req.body ?? {}).all === true;
      const members = await opts.storage.loadBoardMembers();
      let written = 0;
      let skipped = 0;
      const skippedDetail: string[] = [];
      for (const member of members) {
        if (!includeInactive && !member.isActive) continue;
        const slug = memberAgentSlug(member.name);
        const result = emitMemberAgentFile(member, { projectRoot });
        if (result.written) written++;
        else {
          skipped++;
          skippedDetail.push(`${slug} (${result.reason ?? 'unknown'})`);
        }
      }
      broadcast({ type: 'members_sync_done', written, skipped, total: members.length });
      res.json({ written, skipped, skippedDetail, total: members.length });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Principles CRUD
  // ============================================================

  app.post('/api/principles', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<Principle>;
      if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const now = nowIso();
      const principle: Principle = {
        id: generateUUID(),
        category: coerceCategory(body.category, 'meta'),
        title: body.title.trim(),
        description: body.description?.trim() || '',
        behavior: body.behavior?.trim() || '',
        antiPattern: body.antiPattern?.trim() || undefined,
        triggerQuestions: Array.isArray(body.triggerQuestions) ? body.triggerQuestions : undefined,
        priority: typeof body.priority === 'number' ? body.priority : 5,
        examples: Array.isArray(body.examples) ? body.examples : undefined,
        isActive: body.isActive !== false,
        createdAt: now,
        updatedAt: now,
      };
      await opts.storage.savePrinciple(principle);
      res.status(201).json(principle);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.patch('/api/principles/:id', async (req, res) => {
    try {
      const all = await opts.storage.loadPrinciples();
      const existing = all.find((p) => p.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No principle with id ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as Partial<Principle>;
      const updated: Principle = {
        ...existing,
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
        ...(typeof body.description === 'string' ? { description: body.description.trim() } : {}),
        ...(typeof body.category === 'string'
          ? { category: coerceCategory(body.category, existing.category) }
          : {}),
        ...(typeof body.behavior === 'string' ? { behavior: body.behavior.trim() } : {}),
        ...(typeof body.antiPattern === 'string'
          ? { antiPattern: body.antiPattern.trim() || undefined }
          : {}),
        ...(Array.isArray(body.triggerQuestions) ? { triggerQuestions: body.triggerQuestions } : {}),
        ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
        ...(Array.isArray(body.examples) ? { examples: body.examples } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        updatedAt: nowIso(),
      };
      await opts.storage.updatePrinciple(updated);
      res.json(updated);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.delete('/api/principles/:id', async (req, res) => {
    try {
      await opts.storage.deletePrinciple(req.params.id);
      res.status(204).end();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Principles — seed-starters + Explorer wizard step endpoint
  // ============================================================

  app.post('/api/principles/seed-starters', async (req, res) => {
    try {
      const existing = await opts.storage.loadPrinciples();
      const force = (req.body ?? {}).force === true;
      if (existing.length > 0 && !force) {
        res.status(409).json({ error: `${existing.length} principle(s) already exist. Pass force=true to seed on top.` });
        return;
      }
      const now = nowIso();
      let added = 0;
      const added_ids: string[] = [];
      for (const starter of STARTER_PRINCIPLES) {
        const principle: Principle = {
          id: generateUUID(),
          category: starter.category,
          title: starter.title,
          description: starter.description,
          behavior: starter.behavior,
          antiPattern: starter.antiPattern,
          triggerQuestions: starter.triggerQuestions,
          priority: starter.priority,
          examples: starter.examples,
          isActive: starter.isActive,
          createdAt: now,
          updatedAt: now,
        };
        await opts.storage.savePrinciple(principle);
        added++;
        added_ids.push(principle.id);
      }
      broadcast({ type: 'principles_seeded', added, ids: added_ids });
      res.json({ added, ids: added_ids });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // One step turn of the 5-step Principle Explorer. The browser keeps the
  // running `history` of prior turns and posts it back each call.
  app.post('/api/principles/explore-step', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        principle?: Partial<Principle>;
        history?: ExplorerTurn[];
        step?: ExplorerStep;
        userMessage?: string;
        isFirstMessage?: boolean;
      };
      if (!body.principle || !body.principle.title || !body.principle.category) {
        res.status(400).json({ error: 'principle.title and principle.category are required' });
        return;
      }
      if (!body.step || !(EXPLORER_STEPS as readonly string[]).includes(body.step)) {
        res.status(400).json({ error: `step must be one of: ${EXPLORER_STEPS.join(', ')}` });
        return;
      }
      const settings = await opts.storage.loadSettings();
      broadcast({ type: 'principle_explorer_thinking', step: body.step });
      const result = await explorerReply(
        {
          principle: body.principle as Principle,
          history: Array.isArray(body.history) ? body.history : [],
          step: body.step,
          isFirstMessage: !!body.isFirstMessage,
        },
        body.userMessage ?? '',
        settings,
      );
      broadcast({
        type: 'principle_explorer_reply',
        step: body.step,
        synthesised: result.synthesised,
      });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Apply a synthesised step result back to a principle (existing or new).
  app.post('/api/principles/apply-step', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        principleId?: string;
        principle?: Partial<Principle>;
        step?: ExplorerStep;
        value?: string;
      };
      if (!body.step || !(EXPLORER_STEPS as readonly string[]).includes(body.step)) {
        res.status(400).json({ error: 'invalid step' });
        return;
      }
      if (!body.value || typeof body.value !== 'string') {
        res.status(400).json({ error: 'value is required' });
        return;
      }
      let base: Partial<Principle> | Principle | undefined = body.principle;
      if (body.principleId) {
        const all = await opts.storage.loadPrinciples();
        const found = all.find((p) => p.id === body.principleId);
        if (!found) {
          res.status(404).json({ error: `No principle with id ${body.principleId}` });
          return;
        }
        base = found;
      }
      if (!base || !base.title || !base.category) {
        res.status(400).json({ error: 'principle (with title + category) is required' });
        return;
      }
      const merged = applyStep(base as Principle, body.step, body.value);
      res.json({ principle: merged });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Decision Coach — session CRUD + messages
  // ============================================================

  // Resolve the read-side wiki wiring for a coach turn. The per-session toggle
  // only takes effect when the global `exposeToCoach` opt-in is on.
  const coachWikiOpts = (
    session: DecisionSession,
    settings: AppSettings,
  ): { useWiki: boolean; workspaceRoot: string; wikiDir: string } => {
    const root = opts.storage.getWorkspaceRoot();
    const useWiki = !!session.useBusinessWiki && settings.knowledgeWiki?.exposeToCoach === true;
    return { useWiki, workspaceRoot: root, wikiDir: paths(root).wiki };
  };

  app.get('/api/coach/sessions', async (_req, res) => {
    try {
      const sessions = await opts.storage.loadDecisionSessions();
      res.json({ sessions });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/coach/sessions/:id', async (req, res) => {
    try {
      const session = await opts.storage.loadDecisionSessionById(req.params.id);
      if (!session) {
        const all = await opts.storage.loadDecisionSessions();
        const byShort = all.find((s) => s.id.startsWith(req.params.id));
        if (!byShort) {
          res.status(404).json({ error: `No coach session matching "${req.params.id}"` });
          return;
        }
        res.json(byShort);
        return;
      }
      res.json(session);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // PATCH — flip the per-session "Use Business Wiki" toggle (mid-session). Only
  // meaningful when the global `exposeToCoach` opt-in is on, but we persist the
  // flag regardless so it sticks if the opt-in is later enabled.
  app.patch('/api/coach/sessions/:id', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { useBusinessWiki?: unknown };
      let session = await opts.storage.loadDecisionSessionById(req.params.id);
      if (!session) {
        const all = await opts.storage.loadDecisionSessions();
        const byShort = all.find((s) => s.id.startsWith(req.params.id));
        if (!byShort) {
          res.status(404).json({ error: `No coach session matching "${req.params.id}"` });
          return;
        }
        session = byShort;
      }
      if (typeof body.useBusinessWiki !== 'boolean') {
        res.status(400).json({ error: 'Body must include a boolean `useBusinessWiki`.' });
        return;
      }
      const updated: DecisionSession = {
        ...session,
        useBusinessWiki: body.useBusinessWiki,
        updatedAt: nowIso(),
      };
      await opts.storage.updateDecisionSession(updated);
      broadcast({ type: 'coach_session_updated', session: updated });
      res.json(updated);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/coach/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { situation?: string; title?: string; useBusinessWiki?: boolean };
      if (!body.situation || !body.situation.trim()) {
        res.status(400).json({ error: 'situation is required' });
        return;
      }
      const session = newDecisionSession(body.situation.trim(), body.title?.trim() || undefined);
      if (typeof body.useBusinessWiki === 'boolean') session.useBusinessWiki = body.useBusinessWiki;
      await opts.storage.saveDecisionSession(session);
      res.status(202).json({ accepted: true, session });
      broadcast({ type: 'coach_session_started', session });

      // Kick off the opener turn in the background.
      (async () => {
        try {
          const settings = await opts.storage.loadSettings();
          const principles = await opts.storage.loadPrinciples();
          broadcast({ type: 'coach_thinking', sessionId: session.id });
          const { session: updated, reply } = await coachReply(session, principles, '', settings, coachWikiOpts(session, settings));
          await opts.storage.updateDecisionSession(updated);
          broadcast({ type: 'coach_message', sessionId: updated.id, message: reply, session: updated });
        } catch (error) {
          broadcast({
            type: 'coach_error',
            sessionId: session.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/coach/sessions/:id/messages', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { content?: string; useBusinessWiki?: boolean };
      if (!body.content || !body.content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      let session: DecisionSession | null = await opts.storage.loadDecisionSessionById(req.params.id);
      if (!session) {
        const all = await opts.storage.loadDecisionSessions();
        const byShort = all.find((s) => s.id.startsWith(req.params.id));
        if (!byShort) {
          res.status(404).json({ error: `No coach session matching "${req.params.id}"` });
          return;
        }
        session = byShort;
      }
      // Honor a toggle state carried with the message (flip + send atomically).
      if (typeof body.useBusinessWiki === 'boolean' && body.useBusinessWiki !== session.useBusinessWiki) {
        session = { ...session, useBusinessWiki: body.useBusinessWiki };
        await opts.storage.updateDecisionSession(session);
      }
      res.status(202).json({ accepted: true, sessionId: session.id });
      broadcast({ type: 'coach_thinking', sessionId: session.id });

      (async () => {
        try {
          const settings = await opts.storage.loadSettings();
          const principles = await opts.storage.loadPrinciples();
          const content = body.content!.trim();
          const { session: updated, reply } = await coachReply(session!, principles, content, settings, coachWikiOpts(session!, settings));
          await opts.storage.updateDecisionSession(updated);
          broadcast({ type: 'coach_message', sessionId: updated.id, message: reply, session: updated });

          // Write side (bidirectional): when the wiki is ON for this session,
          // ingest the user's own words back into the wiki so their
          // decision-thinking accumulates. Fire-and-forget via the queue —
          // gating + non-blocking are the queue's job.
          if (updated.useBusinessWiki && settings.knowledgeWiki?.exposeToCoach === true) {
            maybeEnqueueUserInput({
              text: content,
              kind: 'coach_message',
              settings,
              storage: opts.storage,
              coachSessionId: updated.id,
            });
          }
        } catch (error) {
          broadcast({
            type: 'coach_error',
            sessionId: session!.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.delete('/api/coach/sessions/:id', async (req, res) => {
    try {
      let session = await opts.storage.loadDecisionSessionById(req.params.id);
      if (!session) {
        const all = await opts.storage.loadDecisionSessions();
        const byShort = all.find((s) => s.id.startsWith(req.params.id));
        if (!byShort) {
          res.status(404).json({ error: `No coach session matching "${req.params.id}"` });
          return;
        }
        session = byShort;
      }
      await opts.storage.deleteDecisionSession(session.id);
      broadcast({ type: 'coach_session_deleted', sessionId: session.id });
      res.status(204).end();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/coach/sessions/:id/decide', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { decision?: string; status?: DecisionSession['status'] };
      let session = await opts.storage.loadDecisionSessionById(req.params.id);
      if (!session) {
        const all = await opts.storage.loadDecisionSessions();
        const byShort = all.find((s) => s.id.startsWith(req.params.id));
        if (!byShort) {
          res.status(404).json({ error: `No coach session matching "${req.params.id}"` });
          return;
        }
        session = byShort;
      }
      const updated: DecisionSession = {
        ...session,
        decision: body.decision ?? session.decision,
        status: body.status ?? (body.decision ? 'decided' : session.status),
        updatedAt: nowIso(),
      };
      await opts.storage.updateDecisionSession(updated);
      broadcast({ type: 'coach_session_updated', session: updated });
      res.json(updated);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Settings PATCH (merge updates)
  // ============================================================

  app.patch('/api/settings', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<AppSettings>;
      const current = await opts.storage.loadSettings();
      const next: AppSettings = { ...DEFAULT_SETTINGS, ...current, ...body };
      // Coerce a few known numeric fields that might come in as strings from the form
      if (typeof body.maxTurnsPerDiscussion === 'string') next.maxTurnsPerDiscussion = Number(body.maxTurnsPerDiscussion);
      if (typeof body.consensusThreshold === 'string') next.consensusThreshold = Number(body.consensusThreshold);
      if (typeof (body as Record<string, unknown>).perCallBudgetUsd === 'string') {
        next.perCallBudgetUsd = Number((body as Record<string, unknown>).perCallBudgetUsd as string);
      }
      await opts.storage.saveSettings(next);
      res.json(next);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ---------- shared kickoff helper for write endpoints ----------
  // Streams progress to all WS clients. Caller already returned 202 to the
  // HTTP client; failures here are surfaced via a `{type:'error'}` WS event.
  // Each engine progress event becomes a WS broadcast as it happens — so the
  // browser sees per-member responses arrive live, not all-at-once at end.
  const broadcastRoundProgress = (
    discussionId: string,
    selected: AdvisoryBoardMember[],
  ) =>
    (e: import('../core/discussion/conversation-flow.js').StartProgressEvent) => {
      if (e.stage === 'generating') {
        const member = selected.find((m) => m.name === e.memberName);
        broadcast({
          type: 'member_thinking',
          discussionId,
          memberName: e.memberName,
          memberId: member?.id,
          slug: member ? memberAgentSlug(member.name) : undefined,
          index: e.index,
          total: e.total,
        });
      } else if (e.stage === 'member_activity') {
        const member = selected.find((m) => m.name === e.memberName);
        broadcast({
          type: 'member_activity',
          discussionId,
          memberName: e.memberName,
          memberId: member?.id,
          activity: e.activity,
          tool: e.tool,
          detail: e.detail,
        });
      } else if (e.stage === 'member_done') {
        broadcast({
          type: 'member_response',
          discussionId,
          memberName: e.response.memberName,
          memberId: e.response.memberId,
          response: e.response,
          roundNumber: e.roundNumber,
          durationMs: e.durationMs,
          costUsd: e.costUsd,
        });
      } else if (e.stage === 'orchestrating') {
        broadcast({ type: 'orchestrator_thinking', discussionId });
      } else if (e.stage === 'orchestrator_decided') {
        broadcast({
          type: 'orchestrator_decision',
          discussionId,
          decision: e.decision,
          roundNumber: e.roundNumber,
        });
      }
    };

  // Once the engine returns, just announce the final state. Per-member
  // responses + orchestrator decisions were already broadcast live.
  const broadcastFinalDiscussion = (
    discussion: Discussion,
    _fromRoundNumber: number,
    extras: { costUsd?: number; durationMs?: number; gated?: boolean; concluded?: boolean } = {},
  ) => {
    if (extras.gated) {
      broadcast({ type: 'discussion_gated', discussion });
      return;
    }
    broadcast({
      type: 'discussion_completed',
      discussion,
      costUsd: extras.costUsd ?? 0,
      durationMs: extras.durationMs ?? 0,
    });
  };

  const resolveDiscussionByIdOrShort = async (id: string): Promise<Discussion | null> => {
    const direct = await opts.storage.loadDiscussionById(id);
    if (direct) return direct;
    const all = await opts.storage.loadDiscussions();
    const matches = all.filter((d) => d.id.startsWith(id));
    if (matches.length === 1) return matches[0]!;
    return null;
  };

  // ---------- API: write ----------

  // In-flight guard (one running round per discussion). The mutation endpoints
  // below return 202 and run the round async; without this, a double-submit
  // loads the same discussion record twice and the second save clobbers the
  // first round (last-writer-wins). Check+add happens synchronously (no await
  // in between) so concurrent requests can't both pass.
  const runningDiscussions = new Set<string>();

  app.post('/api/discussions', async (req, res) => {
    try {
      const { question, memberIds, boardId } = req.body as { question?: string; memberIds?: string[]; boardId?: string };
      if (!question || typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'question is required' });
        return;
      }

      const settings = await opts.storage.loadSettings();
      const allMembers = await opts.storage.loadBoardMembers();
      const selected = pickMembers(allMembers, memberIds);
      if (selected.length === 0) {
        res.status(400).json({ error: 'No active members selected' });
        return;
      }

      // Board snapshot (Phase 7): when the picker convened a board, stamp its
      // id/name onto the discussion. Enforce the per-discussion cap.
      let board: Board | undefined;
      if (boardId) {
        board = (await opts.storage.loadBoards()).find((b) => b.id === boardId);
        if (board && selected.length > settings.maxMembersPerDiscussion) {
          res.status(400).json({
            error: `Board "${board.name}" has ${selected.length} members; max per discussion is ${settings.maxMembersPerDiscussion}.`,
          });
          return;
        }
      }

      // Confirm agent files exist for the selected members
      const missing = selected
        .map((m) => ({ name: m.name, slug: memberAgentSlug(m.name) }))
        .filter((m) => !existsSync(join(projectRoot, '.claude', 'agents', `${m.slug}.md`)));
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing .claude/agents/<slug>.md for: ${missing.map((m) => m.name).join(', ')}. Run \`aab init\` from a project directory first.`,
        });
        return;
      }

      // Kick off async — return 202 immediately, stream progress via WS
      res.status(202).json({ accepted: true });

      logger.info(`[ui] starting discussion (${selected.length} members)`);
      // Use the same broadcaster as continue/follow-up so we get per-member
      // responses + orchestrator decisions streamed live. We don't have a
      // discussion id yet — the client matches typing bubbles by memberName,
      // and the final discussion record comes via discussion_completed.
      startDiscussion({
        question: question.trim(),
        members: selected,
        settings,
        storage: opts.storage,
        projectRoot,
        boardId: board?.id,
        boardName: board?.name,
        onProgress: broadcastRoundProgress('', selected),
      })
        .then((result) => {
          broadcastFinalDiscussion(result.discussion, 1, {
            costUsd: result.totalCostUsd,
            durationMs: result.totalDurationMs,
          });
        })
        .catch((error: unknown) => {
          logger.warn('[ui] discussion failed:', error);
          // No discussion id exists yet when a start fails — `context` lets
          // clients tell this apart from a round failure on an existing one.
          broadcast({
            type: 'error',
            context: 'start_discussion',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Drive the next round of an existing discussion.
  app.post('/api/discussions/:id/continue', async (req, res) => {
    try {
      const discussion = await resolveDiscussionByIdOrShort(req.params.id);
      if (!discussion) {
        res.status(404).json({ error: `No discussion matching "${req.params.id}"` });
        return;
      }
      if (discussion.completedAt) {
        res.status(409).json({ error: 'Discussion already concluded.' });
        return;
      }
      if (discussion.pendingUserRequest) {
        res.status(409).json({
          error: 'Discussion is awaiting your input. POST to /api/discussions/:id/respond first.',
        });
        return;
      }

      const settings = await opts.storage.loadSettings();
      const allMembers = await opts.storage.loadBoardMembers();
      const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
      const selected = allMembers.filter((m) => selectedIds.has(m.id) && m.isActive);
      if (selected.length === 0) {
        res.status(400).json({ error: 'No active members from this discussion remain.' });
        return;
      }

      const missing = selected
        .map((m) => ({ name: m.name, slug: memberAgentSlug(m.name) }))
        .filter((m) => !existsSync(join(projectRoot, '.claude', 'agents', `${m.slug}.md`)));
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing .claude/agents/<slug>.md for: ${missing.map((m) => m.name).join(', ')}`,
        });
        return;
      }

      if (runningDiscussions.has(discussion.id)) {
        res.status(409).json({ error: 'A round is already running for this discussion.' });
        return;
      }
      runningDiscussions.add(discussion.id);

      // 202 + WS streaming, same pattern as POST /api/discussions
      res.status(202).json({ accepted: true });

      const fromRoundNumber = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
      logger.info(`[ui] continuing discussion ${discussion.id.slice(0, 8)} → round ${fromRoundNumber}`);
      continueDiscussion({
        discussion,
        members: selected,
        settings,
        storage: opts.storage,
        projectRoot,
        onProgress: broadcastRoundProgress(discussion.id, selected),
      })
        .then((result) => {
          broadcastFinalDiscussion(result.discussion, fromRoundNumber, {
            costUsd: result.totalCostUsd,
            durationMs: result.totalDurationMs,
            gated: result.gated,
            concluded: result.concluded,
          });
        })
        .catch((error: unknown) => {
          logger.warn('[ui] continue failed:', error);
          broadcast({
            type: 'error',
            discussionId: discussion.id,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => runningDiscussions.delete(discussion.id));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Answer a pending HITL request, then drive the follow-up round.
  app.post('/api/discussions/:id/respond', async (req, res) => {
    try {
      const { content, selectedOption } = req.body as { content?: string; selectedOption?: string };
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      const discussion = await resolveDiscussionByIdOrShort(req.params.id);
      if (!discussion) {
        res.status(404).json({ error: `No discussion matching "${req.params.id}"` });
        return;
      }
      if (!discussion.pendingUserRequest) {
        res.status(409).json({ error: 'This discussion is not awaiting your input.' });
        return;
      }

      const settings = await opts.storage.loadSettings();
      const allMembers = await opts.storage.loadBoardMembers();
      const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
      const selected = allMembers.filter((m) => selectedIds.has(m.id) && m.isActive);
      if (selected.length === 0) {
        res.status(400).json({ error: 'No active members from this discussion remain.' });
        return;
      }

      const missing = selected
        .map((m) => ({ name: m.name, slug: memberAgentSlug(m.name) }))
        .filter((m) => !existsSync(join(projectRoot, '.claude', 'agents', `${m.slug}.md`)));
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing .claude/agents/<slug>.md for: ${missing.map((m) => m.name).join(', ')}`,
        });
        return;
      }

      if (runningDiscussions.has(discussion.id)) {
        res.status(409).json({ error: 'A round is already running for this discussion.' });
        return;
      }
      runningDiscussions.add(discussion.id);

      res.status(202).json({ accepted: true });

      const fromRoundNumber = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
      logger.info(`[ui] responding to discussion ${discussion.id.slice(0, 8)}`);
      respondToUserRequest({
        discussion,
        content: content.trim(),
        selectedOption,
        members: selected,
        settings,
        storage: opts.storage,
        projectRoot,
        onProgress: broadcastRoundProgress(discussion.id, selected),
      })
        .then((result) => {
          broadcastFinalDiscussion(result.discussion, fromRoundNumber, {
            costUsd: result.totalCostUsd,
            durationMs: result.totalDurationMs,
            gated: result.gated,
            concluded: result.concluded,
          });
        })
        .catch((error: unknown) => {
          logger.warn('[ui] respond failed:', error);
          broadcast({
            type: 'error',
            discussionId: discussion.id,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => runningDiscussions.delete(discussion.id));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // Targeted follow-up question.
  app.post('/api/discussions/:id/follow-up', async (req, res) => {
    try {
      const body = req.body as {
        question?: string;
        targetType?: FollowUpTargetType;
        selectedMemberId?: string;
        selectedMemberIds?: string[];
        addMemberIds?: string[];
        catchUpMode?: 'full' | 'summary' | 'fresh';
      };
      if (!body.question || typeof body.question !== 'string' || !body.question.trim()) {
        res.status(400).json({ error: 'question is required' });
        return;
      }
      const targetType: FollowUpTargetType = body.targetType ?? 'all';
      if (!['all', 'specific', 'subset'].includes(targetType)) {
        res.status(400).json({ error: `invalid targetType "${targetType}"` });
        return;
      }
      if (targetType === 'specific' && !body.selectedMemberId) {
        res.status(400).json({ error: 'targetType=specific requires selectedMemberId' });
        return;
      }
      if (targetType === 'subset' && (!Array.isArray(body.selectedMemberIds) || body.selectedMemberIds.length < 2)) {
        res.status(400).json({ error: 'targetType=subset requires at least 2 selectedMemberIds' });
        return;
      }
      const catchUpMode = body.catchUpMode ?? 'full';
      if (!['full', 'summary', 'fresh'].includes(catchUpMode)) {
        res.status(400).json({ error: `invalid catchUpMode "${catchUpMode}"` });
        return;
      }

      const discussion = await resolveDiscussionByIdOrShort(req.params.id);
      if (!discussion) {
        res.status(404).json({ error: `No discussion matching "${req.params.id}"` });
        return;
      }
      if (discussion.completedAt) {
        res.status(409).json({ error: 'Discussion already concluded.' });
        return;
      }
      if (discussion.pendingUserRequest) {
        res.status(409).json({
          error: 'Discussion is awaiting your input. POST to /api/discussions/:id/respond first.',
        });
        return;
      }

      const settings = await opts.storage.loadSettings();
      const allMembers = await opts.storage.loadBoardMembers();
      const activeAll = allMembers.filter((m) => m.isActive);
      const allowedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
      const existingPool = activeAll.filter((m) => allowedIds.has(m.id));
      if (existingPool.length === 0) {
        res.status(400).json({ error: "No active members from this discussion's original board remain." });
        return;
      }

      // ---- Validate members to add (Phase 7, Chunk 5) ----
      const addMemberIds = Array.isArray(body.addMemberIds) ? [...new Set(body.addMemberIds.filter(Boolean))] : [];
      const addMembers: AdvisoryBoardMember[] = [];
      for (const id of addMemberIds) {
        const m = activeAll.find((x) => x.id === id);
        if (!m) {
          res.status(400).json({ error: `Cannot add member ${id}: not an active member.` });
          return;
        }
        if (allowedIds.has(id)) {
          res.status(400).json({ error: `${m.name} is already part of this discussion.` });
          return;
        }
        addMembers.push(m);
      }
      const effectivePool = [...existingPool, ...addMembers];

      // Resolve which members will actually spawn (so we can verify their files).
      let willSpawn = effectivePool;
      if (targetType === 'specific') {
        willSpawn = effectivePool.filter((m) => m.id === body.selectedMemberId);
        if (willSpawn.length === 0) {
          res.status(400).json({ error: `Member ${body.selectedMemberId} is not part of this discussion.` });
          return;
        }
      } else if (targetType === 'subset') {
        const set = new Set(body.selectedMemberIds);
        willSpawn = effectivePool.filter((m) => set.has(m.id));
        if (willSpawn.length === 0) {
          res.status(400).json({ error: 'None of the selected members are part of this discussion.' });
          return;
        }
      }

      // Verify agent files only for EXISTING members; the engine emits files for
      // newcomers if missing.
      const addIdSet = new Set(addMembers.map((m) => m.id));
      const missing = willSpawn
        .filter((m) => !addIdSet.has(m.id))
        .map((m) => ({ name: m.name, slug: memberAgentSlug(m.name) }))
        .filter((m) => !existsSync(join(projectRoot, '.claude', 'agents', `${m.slug}.md`)));
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing .claude/agents/<slug>.md for: ${missing.map((m) => m.name).join(', ')}`,
        });
        return;
      }

      if (runningDiscussions.has(discussion.id)) {
        res.status(409).json({ error: 'A round is already running for this discussion.' });
        return;
      }
      runningDiscussions.add(discussion.id);

      res.status(202).json({ accepted: true });

      const fromRoundNumber = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
      logger.info(
        `[ui] follow-up on discussion ${discussion.id.slice(0, 8)} (target=${targetType}, members=${willSpawn.length}, add=${addMembers.length})`,
      );
      addFollowUpQuestion({
        discussion,
        question: body.question.trim(),
        members: activeAll,
        settings,
        storage: opts.storage,
        projectRoot,
        targetType,
        selectedMemberId: body.selectedMemberId,
        selectedMemberIds: body.selectedMemberIds,
        addMemberIds: addMemberIds.length > 0 ? addMemberIds : undefined,
        catchUpMode,
        onProgress: broadcastRoundProgress(discussion.id, willSpawn),
      })
        .then((result) => {
          // Announce mid-discussion joins (member_joined) from the new round's snapshot.
          const newRound = result.discussion.rounds.find((r) => r.roundNumber === fromRoundNumber);
          for (const id of newRound?.addedMemberIds ?? []) {
            const p = result.discussion.participants?.find((x) => x.memberId === id);
            broadcast({
              type: 'member_joined',
              discussionId: result.discussion.id,
              memberId: id,
              name: p?.name ?? id,
              joinedAtRound: p?.joinedAtRound ?? fromRoundNumber,
              catchUpMode: p?.catchUpMode ?? catchUpMode,
            });
          }
          broadcastFinalDiscussion(result.discussion, fromRoundNumber, {
            costUsd: result.totalCostUsd,
            durationMs: result.totalDurationMs,
            gated: result.gated,
            concluded: result.concluded,
          });
        })
        .catch((error: unknown) => {
          logger.warn('[ui] follow-up failed:', error);
          broadcast({
            type: 'error',
            discussionId: discussion.id,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => runningDiscussions.delete(discussion.id));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Knowledge Wiki (Phase 1.5)
  // ============================================================

  function resolveWorkspaceForWiki() {
    const ws = resolveWorkspace({ override: opts.storage.getWorkspaceId() });
    // Storage knows the actual root; align in case resolver picked a different scope.
    ws.root = opts.storage.getWorkspaceRoot();
    return ws;
  }

  app.get('/api/knowledge/state', async (_req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const pages = walkWikiPages(p.wiki, opts.storage.getWorkspaceRoot());
      const manifest = loadManifest(p.manifest);
      const map = buildSlugMap(p.wiki, opts.storage.getWorkspaceRoot());
      const byType: Record<string, number> = {};
      const slugMap: Record<string, { path: string; title?: string; type: string; summary?: string }> = {};
      const aliases: Record<string, string> = {};
      for (const page of pages) {
        const t = String(page.frontmatter.type ?? 'unknown');
        byType[t] = (byType[t] ?? 0) + 1;
      }
      for (const [slug, entry] of map.canonical) {
        slugMap[slug] = { path: entry.path, title: entry.title, type: String(entry.type), summary: entry.summary };
      }
      for (const [alias, canonical] of map.aliasToCanonical) {
        if (alias !== canonical) aliases[alias] = canonical;
      }
      res.json({
        pageCount: pages.length,
        byType,
        lastIngestAt: manifest.entries[manifest.entries.length - 1]?.ingestedAt,
        totalCostUsd: manifest.entries.reduce((sum, e) => sum + (e.ingestCostUsd ?? 0), 0),
        ingestCount: manifest.entries.length,
        renameCount: manifest.renames.length,
        userEditedCount: manifest.userEditedPages.length,
        slugMap,
        aliases,
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/knowledge/pages', async (_req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const pages = walkWikiPages(p.wiki, opts.storage.getWorkspaceRoot());
      const out = pages.map((page) => ({
        slug: page.frontmatter.slug,
        title: page.frontmatter.title,
        type: page.frontmatter.type,
        summary: page.frontmatter.summary,
        tags: page.frontmatter.tags ?? [],
        path: toPosix(`wiki/${page.wikiRelPath}`),
        userEdited: page.frontmatter.userEdited ?? false,
        updated: page.frontmatter.updated,
      }));
      res.json({ pages: out });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/knowledge/pages/:slug', async (req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const map = buildSlugMap(p.wiki, opts.storage.getWorkspaceRoot());
      const entry = resolveSlug(map, req.params.slug);
      if (!entry) {
        res.status(404).json({ error: `No page with slug "${req.params.slug}"` });
        return;
      }
      const full = join(p.wiki, entry.path);
      const raw = readFileSync(full, 'utf8');
      const parsed = parsePage(raw);
      if (!parsed) {
        res.status(500).json({ error: `Page has no parseable frontmatter: ${entry.path}` });
        return;
      }
      const backlinks = extractBacklinksSection(parsed.body);
      res.json({
        slug: entry.slug,
        path: toPosix(`wiki/${entry.path}`),
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        backlinks,
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/pages/:slug', async (req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const map = buildSlugMap(p.wiki, opts.storage.getWorkspaceRoot());
      const entry = resolveSlug(map, req.params.slug);
      if (!entry) {
        res.status(404).json({ error: `No page with slug "${req.params.slug}"` });
        return;
      }
      const body = (req.body ?? {}) as { body?: string; frontmatter?: Record<string, unknown> };
      const full = join(p.wiki, entry.path);
      const existing = parsePage(readFileSync(full, 'utf8'));
      if (!existing) {
        res.status(500).json({ error: `Page has no parseable frontmatter: ${entry.path}` });
        return;
      }
      const nextFm = { ...existing.frontmatter, ...(body.frontmatter ?? {}), userEdited: true, updated: nowIso().slice(0, 10) };
      const nextBody = typeof body.body === 'string' ? body.body : existing.body;
      writeFileSync(full, serializePage(nextFm as any, nextBody), 'utf8');
      markUserEdited(p.manifest, toPosix(`wiki/${entry.path}`), 'ui');
      res.json({ ok: true });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/pages/:slug/rename', async (req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const newSlug = (req.body?.newSlug ?? '').toString().trim();
      if (!newSlug) {
        res.status(400).json({ error: 'newSlug is required' });
        return;
      }
      const result = await renameSlug({
        wikiRoot: p.wiki,
        manifestPath: p.manifest,
        indexPath: p.wikiIndex,
        workspaceRoot: opts.storage.getWorkspaceRoot(),
        fromSlug: req.params.slug,
        toSlug: newSlug,
        trigger: 'manual',
      });
      broadcast({ type: 'wiki_renamed', fromSlug: result.fromSlug, toSlug: result.toSlug });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/ingest', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        paste?: string;
        url?: string;
        path?: string;
        file?: { name?: string; contentBase64?: string };
        force?: boolean;
        type?: string;
      };
      const workspace = resolveWorkspaceForWiki();
      const settings = await opts.storage.loadSettings();
      const sourceType = body.url ? 'url' : body.path || body.file ? 'file' : 'pasted';
      broadcast({ type: 'wiki_ingest_started', sourceType });
      let result;
      if (body.paste) {
        result = await ingestPaste({ text: body.paste, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else if (body.url) {
        result = await ingestUrl({ url: body.url, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else if (body.file?.contentBase64) {
        const buffer = Buffer.from(body.file.contentBase64, 'base64');
        result = await ingestFileBuffer({
          buffer,
          originalName: body.file.name?.trim() || 'upload',
          workspace,
          settings,
          force: body.force,
          hintType: body.type as PageType | undefined,
        });
      } else if (body.path) {
        result = await ingestFile({ path: body.path, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else {
        res.status(400).json({ error: 'Provide paste, url, file, or path.' });
        return;
      }
      for (const page of result.producedPages) broadcast({ type: 'wiki_ingest_page_written', path: page, action: 'created' });
      for (const page of result.updatedPages) broadcast({ type: 'wiki_ingest_page_written', path: page, action: 'updated' });
      broadcast({
        type: 'wiki_ingest_done',
        producedPages: result.producedPages,
        updatedPages: result.updatedPages,
        costUsd: result.costUsd,
      });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/ingest/discussion/:id', async (req, res) => {
    try {
      const id = req.params.id;
      let discussion = await opts.storage.loadDiscussionById(id);
      if (!discussion) {
        const all = await opts.storage.loadDiscussions();
        const matches = all.filter((d) => d.id.startsWith(id));
        if (matches.length === 0) {
          res.status(404).json({ error: `No discussion matching "${id}"` });
          return;
        }
        discussion = matches[0]!;
      }
      const workspace = resolveWorkspaceForWiki();
      const settings = await opts.storage.loadSettings();
      broadcast({ type: 'wiki_ingest_started', sourceType: 'discussion', discussionId: discussion.id });
      const result = await ingestDiscussionRaw({
        discussion,
        workspace,
        settings,
        storage: opts.storage,
        force: !!req.body?.force,
      });
      broadcast({
        type: 'wiki_ingest_done',
        producedPages: result.producedPages,
        updatedPages: result.updatedPages,
        costUsd: result.costUsd,
      });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/query', async (req, res) => {
    try {
      const question = (req.body?.question ?? '').toString().trim();
      if (!question) {
        res.status(400).json({ error: 'question is required' });
        return;
      }
      broadcast({ type: 'wiki_query_started', question });
      const settings = await opts.storage.loadSettings();
      const result = await queryWiki({
        question,
        workspace: resolveWorkspaceForWiki(),
        settings,
        maxPages: req.body?.maxPages,
      });
      broadcast({ type: 'wiki_query_done', costUsd: result.costUsd, citations: result.citations });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/knowledge/lint', async (req, res) => {
    try {
      const settings = await opts.storage.loadSettings();
      const result = await lintWiki({
        workspace: resolveWorkspaceForWiki(),
        settings,
        writeReport: req.body?.writeReport !== false,
        runLlm: req.body?.runLlm !== false,
        maxPages: req.body?.maxPages,
      });
      broadcast({
        type: 'wiki_lint_done',
        reportPath: result.reportPath,
        errorCount: result.findings.filter((f) => f.severity === 'error').length,
        warnCount: result.findings.filter((f) => f.severity === 'warn').length,
      });
      res.json(result);
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/knowledge/graph', async (_req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const pages = walkWikiPages(p.wiki, opts.storage.getWorkspaceRoot());
      const map = buildSlugMap(p.wiki, opts.storage.getWorkspaceRoot());
      const nodes = pages.map((page) => ({
        slug: page.frontmatter.slug,
        type: page.frontmatter.type,
        title: page.frontmatter.title,
        summary: page.frontmatter.summary,
      }));
      const edges: Array<{ from: string; to: string }> = [];
      for (const page of pages) {
        const from = (page.frontmatter.slug ?? '').toLowerCase();
        if (!from) continue;
        for (const link of extractWikiLinks(page.body)) {
          const to = map.aliasToCanonical.get(link.slug);
          if (to && to !== from) edges.push({ from, to });
        }
      }
      res.json({ nodes, edges });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/knowledge/raw', async (_req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const manifest = loadManifest(p.manifest);
      res.json({ entries: manifest.entries });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/knowledge/raw/:hash', async (req, res) => {
    try {
      const p = paths(opts.storage.getWorkspaceRoot());
      const manifest = loadManifest(p.manifest);
      const entry = manifest.entries.find((e) => e.hash.startsWith(req.params.hash));
      if (!entry) {
        res.status(404).json({ error: `No raw source with hash starting "${req.params.hash}"` });
        return;
      }
      const full = join(opts.storage.getWorkspaceRoot(), entry.rawPath);
      if (!fsExistsSync(full)) {
        res.status(404).json({ error: `Raw file missing on disk: ${entry.rawPath}` });
        return;
      }
      res.type('text/plain').send(readFileSync(full, 'utf8'));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ============================================================
  // Sparring (Phase 3) — 1:1 deep dive
  // ============================================================

  app.get('/api/discussions/:id/sparring', async (req, res) => {
    try {
      const sessions = await opts.storage.loadSparringSessionsForDiscussion(req.params.id);
      res.json({ sessions });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/discussions/:id/sparring', async (req, res) => {
    try {
      const discussion = await opts.storage.loadDiscussionById(req.params.id);
      if (!discussion) {
        res.status(404).json({ error: 'Discussion not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        memberId?: string;
        memberName?: string;
        anchorRoundNumber?: number;
        anchorTurnNumber?: number;
        title?: string;
      };
      const allMembers = await opts.storage.loadBoardMembers();
      const member = body.memberId
        ? allMembers.find((m) => m.id === body.memberId)
        : body.memberName
          ? allMembers.find((m) => m.name.toLowerCase() === body.memberName!.toLowerCase())
          : undefined;
      if (!member) {
        res.status(400).json({ error: 'memberId or memberName must match an existing board member.' });
        return;
      }
      const opened = await openSparringSession({
        discussion,
        member,
        anchorRoundNumber: body.anchorRoundNumber,
        anchorTurnNumber: body.anchorTurnNumber,
        title: body.title,
        storage: opts.storage,
      });
      broadcast({
        type: 'sparring_session_opened',
        discussionId: discussion.id,
        session: opened.session,
        reused: opened.reused,
      });
      res.json({ session: opened.session, reused: opened.reused });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get('/api/sparring/:sessionId', async (req, res) => {
    try {
      const session = await opts.storage.loadSparringSessionById(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'Sparring session not found' });
        return;
      }
      res.json({ session });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.delete('/api/sparring/:sessionId', async (req, res) => {
    try {
      const session = await opts.storage.loadSparringSessionById(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'Sparring session not found' });
        return;
      }
      await opts.storage.deleteSparringSession(session.id);
      broadcast({ type: 'sparring_session_deleted', sessionId: session.id, discussionId: session.discussionId });
      res.status(204).end();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/sparring/:sessionId/messages', async (req, res) => {
    try {
      const session = await opts.storage.loadSparringSessionById(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'Sparring session not found' });
        return;
      }
      const body = (req.body ?? {}) as { content?: string };
      const content = (body.content ?? '').toString().trim();
      if (!content) {
        res.status(400).json({ error: 'content is required and must be non-empty.' });
        return;
      }
      const discussion = await opts.storage.loadDiscussionById(session.discussionId);
      if (!discussion) {
        res.status(404).json({ error: 'Parent discussion not found' });
        return;
      }
      const allMembers = await opts.storage.loadBoardMembers();
      const member = allMembers.find((m) => m.id === session.memberId);
      if (!member) {
        res.status(404).json({ error: 'Member referenced by this sparring session no longer exists.' });
        return;
      }
      const settings = await opts.storage.loadSettings();

      res.status(202).json({ accepted: true, sessionId: session.id });
      broadcast({ type: 'sparring_thinking', sessionId: session.id, memberName: member.name });

      (async () => {
        try {
          const result = await sendSparringMessage({
            session,
            member,
            discussion,
            userMessage: content,
            settings,
            storage: opts.storage,
            projectRoot,
            onActivity: (event) => {
              broadcast({
                type: 'sparring_activity',
                sessionId: session.id,
                activity: event.activity,
                tool: event.tool,
                detail: event.detail,
              });
            },
          });
          if (result.error || !result.assistantMsg) {
            broadcast({
              type: 'sparring_error',
              sessionId: session.id,
              message: result.error ?? 'No reply',
            });
            return;
          }
          const updated = await opts.storage.loadSparringSessionById(session.id);
          broadcast({
            type: 'sparring_message',
            sessionId: session.id,
            message: result.assistantMsg,
            session: updated,
            fellBackToPrimary: result.fellBackToPrimary,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          });
        } catch (error) {
          broadcast({
            type: 'sparring_error',
            sessionId: session.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post('/api/sparring/:sessionId/inject', async (req, res) => {
    try {
      const session = await opts.storage.loadSparringSessionById(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'Sparring session not found' });
        return;
      }
      const discussion = await opts.storage.loadDiscussionById(session.discussionId);
      if (!discussion) {
        res.status(404).json({ error: 'Parent discussion not found' });
        return;
      }
      const body = (req.body ?? {}) as { insight?: string; sourceRoundNumber?: number; sourceTurnNumber?: number };
      let insight = (body.insight ?? '').toString().trim();
      if (!insight) {
        const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
        if (!lastAssistant) {
          res.status(400).json({ error: 'No assistant reply to inject. Pass an explicit insight body.' });
          return;
        }
        insight = lastAssistant.content.trim();
      }
      const result = await injectSparringInsight({
        discussion,
        session,
        insight,
        storage: opts.storage,
        sourceRoundNumber: body.sourceRoundNumber,
        sourceTurnNumber: body.sourceTurnNumber,
      });
      broadcast({
        type: 'sparring_injected',
        discussionId: result.discussion.id,
        sessionId: session.id,
        userResponse: result.injectedUserResponse,
      });
      res.json({
        discussion: result.discussion,
        injectedUserResponse: result.injectedUserResponse,
      });
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  // ---------- Phase 5 — Skill Planner + skill-creator orchestration ----------

  // In-memory plan cache for /api/plans/:planId rehydration. Each entry is
  // the full ResolvedSkillCapabilityProfile so a subsequent /solve can be
  // launched with the proposal pre-accepted.
  const planCache = new Map<string, ResolvedSkillCapabilityProfile>();

  // Running plan/solve runs keyed by planId, so POST /api/plans/:id/cancel can
  // abort the in-flight recon/planner `claude` children (stops the token burn).
  const runningPlans = new Map<string, AbortController>();

  // POST /api/actions/:id/plan — Planner-only, returns proposal + planId
  app.post('/api/actions/:id/plan', async (req, res) => {
    try {
      const actions = await opts.storage.loadActionItems();
      const action = actions.find((a) => a.id === req.params.id || a.id.startsWith(req.params.id));
      if (!action) {
        res.status(404).json({ error: 'Action not found' });
        return;
      }
      const settings = await opts.storage.loadSettings();
      const body = (req.body ?? {}) as {
        plannerTier?: 'minimal' | 'standard' | 'maximalist';
        plannerNoWeb?: boolean;
        plannerNoPcScan?: boolean;
        plannerDeepScan?: boolean;
        plannerNoWiki?: boolean;
      };
      const discussion = action.discussionId ? await opts.storage.loadDiscussionById(action.discussionId) : null;
      const planId = generateUUID();
      const controller = new AbortController();
      runningPlans.set(planId, controller);
      broadcast({ type: 'planner_started', planId, actionItemId: action.id });

      // Run asynchronously — return planId immediately, push events via WS.
      (async () => {
        try {
          const result = await runSolve({
            workspace: resolveWorkspace(),
            settings,
            storage: opts.storage,
            action,
            discussionSummary: discussion?.summary,
            plannerTierCap: body.plannerTier,
            skipPcScan: body.plannerNoPcScan,
            skipWiki: body.plannerNoWiki,
            skipWeb: body.plannerNoWeb,
            pcDeepScan: body.plannerDeepScan,
            planOnly: true,
            yes: true,
            projectRoot: process.cwd(),
            runId: planId,
            signal: controller.signal,
            onEvent: (evt) => broadcast(coerceSolveEventForWs(evt, planId)),
          });
          planCache.set(planId, result.capabilityProfile);
          broadcast({ type: 'planner_proposal_ready', planId, proposal: result.proposal });
        } catch (err) {
          if (controller.signal.aborted) {
            broadcast({ type: 'planner_cancelled', planId });
          } else {
            broadcast({ type: 'planner_failed', planId, reason: 'error', errorMessage: err instanceof Error ? err.message : String(err) });
          }
        } finally {
          runningPlans.delete(planId);
        }
      })();

      res.status(202).json({ planId, status: 'running' });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/plans/:planId — return the cached profile (?as=md → proposal markdown)
  app.get('/api/plans/:planId', (req, res) => {
    const profile = planCache.get(req.params.planId);
    if (!profile) {
      res.status(404).json({ error: 'Plan not found in cache (server restarted, or never created).' });
      return;
    }
    if ((req.query.as ?? '') === 'md') {
      res.type('text/markdown').send(renderProposalMarkdown(profile.proposal));
      return;
    }
    res.json({ planId: req.params.planId, profile });
  });

  // POST /api/plans/:planId/cancel — abort a running plan/solve. Kills the
  // in-flight recon/planner `claude` children so the token burn stops.
  app.post('/api/plans/:planId/cancel', (req, res) => {
    const controller = runningPlans.get(req.params.planId);
    if (!controller) {
      res.status(404).json({ error: 'No running plan with that id (already finished or never started).' });
      return;
    }
    controller.abort();
    broadcast({ type: 'planner_cancelled', planId: req.params.planId });
    res.json({ cancelled: true });
  });

  // POST /api/plans/:planId/replan — re-plan with user feedback (re-uses recon)
  app.post('/api/plans/:planId/replan', async (req, res) => {
    try {
      const existing = planCache.get(req.params.planId);
      if (!existing) {
        res.status(404).json({ error: 'Original plan not found in cache.' });
        return;
      }
      const body = (req.body ?? {}) as { feedback?: string };
      const feedback = (body.feedback ?? '').trim();
      if (feedback.length < 10) {
        res.status(400).json({ error: 'feedback must be at least 10 characters.' });
        return;
      }
      // Replan via the planner module directly (cheaper — recon is reused).
      const { runPlanner } = await import('../core/skill/planner.js');
      const actions = await opts.storage.loadActionItems();
      // The original action id is embedded — surface it via the action that matches the recon's apps
      // (best-effort: when there's only one action with discussionId set, prefer it). We require the
      // client to pass the actionId for safety.
      const actionId = (body as { actionId?: string }).actionId;
      const action = actionId ? actions.find((a) => a.id === actionId || a.id.startsWith(actionId)) : null;
      if (!action) {
        res.status(400).json({ error: 'actionId is required in the replan body.' });
        return;
      }
      const settings = await opts.storage.loadSettings();
      const discussion = action.discussionId ? await opts.storage.loadDiscussionById(action.discussionId) : null;
      const planId = generateUUID();
      res.status(202).json({ planId, status: 'running' });
      (async () => {
        try {
          const planner = await runPlanner({
            workspace: resolveWorkspace(),
            settings,
            action,
            discussionSummary: discussion?.summary,
            recon: existing.recon,
            userReplanFeedback: feedback,
          });
          // Build a fresh profile reusing the same accepted-tier defaults.
          const next: ResolvedSkillCapabilityProfile = {
            ...existing,
            generatedAt: nowIso(),
            proposal: planner.proposal,
          };
          planCache.set(planId, next);
          broadcast({ type: 'planner_proposal_ready', planId, proposal: planner.proposal });
        } catch (err) {
          broadcast({ type: 'planner_failed', planId, reason: 'replan error', errorMessage: err instanceof Error ? err.message : String(err) });
        }
      })();
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // POST /api/actions/:id/solve — body MAY include { planId, profile, scope, noInstall }
  app.post('/api/actions/:id/solve', async (req, res) => {
    try {
      const actions = await opts.storage.loadActionItems();
      const action = actions.find((a) => a.id === req.params.id || a.id.startsWith(req.params.id));
      if (!action) {
        res.status(404).json({ error: 'Action not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        planId?: string;
        scope?: 'project' | 'user';
        noInstall?: boolean;
        skillName?: string;
        stub?: boolean;
      };
      const settings = await opts.storage.loadSettings();
      const discussion = action.discussionId ? await opts.storage.loadDiscussionById(action.discussionId) : null;
      const runId = generateUUID();
      const preAcceptedProfile = body.planId ? planCache.get(body.planId) : undefined;
      res.status(202).json({ runId, status: 'started' });

      (async () => {
        try {
          await runSolve({
            workspace: resolveWorkspace(),
            settings,
            storage: opts.storage,
            action,
            discussionSummary: discussion?.summary,
            preAcceptedProfile,
            yes: true,
            scope: body.scope ?? 'project',
            noInstall: body.noInstall,
            skillName: body.skillName,
            stub: body.stub,
            projectRoot: process.cwd(),
            runId,
            onEvent: (evt) => broadcast(coerceSolveEventForWs(evt, runId)),
          });
        } catch (err) {
          broadcast({ type: 'skill_run_failed', runId, errorMessage: err instanceof Error ? err.message : String(err) });
        }
      })();
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/actions/:id/runs — list past skill runs for one action
  app.get('/api/actions/:id/runs', async (req, res) => {
    try {
      const actions = await opts.storage.loadActionItems();
      const action = actions.find((a) => a.id === req.params.id || a.id.startsWith(req.params.id));
      if (!action) {
        res.status(404).json({ error: 'Action not found' });
        return;
      }
      const runs = await opts.storage.loadSkillRuns(action.id);
      res.json({ runs });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/skill-runs/:id — single run detail (with embedded planner proposal)
  app.get('/api/skill-runs/:id', async (req, res) => {
    try {
      const run = await opts.storage.getSkillRun(req.params.id);
      if (!run) {
        res.status(404).json({ error: 'Skill run not found' });
        return;
      }
      res.json({ run });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // DELETE /api/skill-runs/:id
  app.delete('/api/skill-runs/:id', async (req, res) => {
    try {
      const run = await opts.storage.getSkillRun(req.params.id);
      if (!run) {
        res.status(404).json({ error: 'Skill run not found' });
        return;
      }
      await opts.storage.deleteSkillRun(run.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/recon/environment — fast read-only PC scan (no LLM)
  app.get('/api/recon/environment', (req, res) => {
    try {
      const recon = scanPc({ projectRoot: process.cwd() });
      res.json({ recon });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/skills — installed skills (project + user + plugin scopes)
  app.get('/api/skills', (req, res) => {
    try {
      const skills = listInstalledSkills(process.cwd()).map((sk) => ({
        name: sk.name,
        scope: sk.scope,
        version: sk.version,
        dir: sk.dir,
      }));
      res.json({ skills });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // GET /api/skills/:name — pretty SKILL.md + sidecar
  app.get('/api/skills/:name', (req, res) => {
    try {
      const sk = resolveSkill(req.params.name, { projectRoot: process.cwd() });
      if (!sk) {
        res.status(404).json({ error: 'Skill not installed' });
        return;
      }
      const body = readFileSync(sk.path, 'utf8');
      res.json({ skill: sk, body });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // ---------- HTTP + WS upgrade ----------
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });

  await new Promise<void>((res) => httpServer.listen(port, host, () => res()));
  const url = `http://${host}:${port}`;
  logger.info(`[ui] serving ${guiDir} at ${url}`);

  return {
    url,
    close: async () => {
      for (const ws of sockets) ws.close();
      wss.close();
      await new Promise<void>((res) => httpServer.close(() => res()));
    },
  };
}

// ---------- helpers ----------

function resolveGuiDir(): string {
  // dist/bin/aab.js → ../../gui/
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'gui'),
    resolve(here, '..', 'gui'),
    resolve(here, 'gui'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error('gui/ directory not found relative to ' + here);
}

function pickMembers(all: AdvisoryBoardMember[], ids?: string[]): AdvisoryBoardMember[] {
  if (!ids || ids.length === 0) return all.filter((m) => m.isActive);
  const set = new Set(ids);
  return all.filter((m) => m.isActive && set.has(m.id));
}

function enrichMembers(
  members: AdvisoryBoardMember[],
  projectRoot?: string,
): Array<AdvisoryBoardMember & { slug: string; initials: string; color?: string }> {
  return members.map((m) => enrichOne(m, projectRoot));
}

function enrichOne(
  m: AdvisoryBoardMember,
  projectRoot?: string,
): AdvisoryBoardMember & { slug: string; initials: string; color?: string } {
  const color = readMemberAgentColor(m.name, projectRoot);
  return {
    ...m,
    slug: memberAgentSlug(m.name),
    initials: initialsOf(m.name),
    ...(color ? { color } : {}),
  };
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function sendError(res: Response, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('[ui] api error', message);
  res.status(status).json({ error: message });
}

/**
 * Resolve a discussion by full id or short-id prefix. On miss/ambiguity it
 * writes the appropriate 404/409 response and returns null, so callers can
 * `if (!discussion) return;`.
 */
async function resolveDiscussionByIdOrPrefix(
  storage: FsStorageService,
  id: string,
  res: Response,
): Promise<Discussion | null> {
  const direct = await storage.loadDiscussionById(id);
  if (direct) return direct;
  const all = await storage.loadDiscussions();
  const matches = all.filter((d) => d.id.startsWith(id));
  if (matches.length === 0) {
    res.status(404).json({ error: `No discussion matching "${id}"` });
    return null;
  }
  if (matches.length > 1) {
    res.status(409).json({ error: `Multiple discussions match "${id}"` });
    return null;
  }
  return matches[0]!;
}

/**
 * Map a SolveEvent to the wire-shape WS event the GUI expects.
 * The orchestrator emits coarse SolveEvent objects; the GUI sees fine-grained
 * planner_* / skill_run_* events. We attach the planId/runId at the source.
 */
function coerceSolveEventForWs(evt: SolveEvent, id: string): { type: string; [key: string]: unknown } {
  const base = { ...evt.payload, runId: id, planId: id };
  switch (evt.type) {
    case 'planner_recon_progress':
      return { type: 'planner_recon_progress', ...base };
    case 'planner_recon_done':
      return { type: 'planner_recon_done', ...base };
    case 'planner_reasoning_started':
      return { type: 'planner_reasoning_started', ...base };
    case 'planner_proposal_ready':
      return { type: 'planner_proposal_ready', ...base };
    case 'planner_failed':
      return { type: 'planner_failed', ...base };
    case 'skill_run_started':
      return { type: 'skill_run_started', ...base };
    case 'skill_run_tool_call':
      return { type: 'skill_run_tool_call', ...base };
    case 'skill_run_adapter_diff':
      return { type: 'skill_run_adapter_diff', ...base };
    case 'skill_run_installed':
      return { type: 'skill_run_installed', ...base };
    case 'skill_run_failed':
      return { type: 'skill_run_failed', ...base };
    case 'skill_run_cancelled':
      return { type: 'skill_run_cancelled', ...base };
    case 'preflight':
      return { type: 'planner_preflight', ...base };
    case 'planner_started':
      return { type: 'planner_started', ...base };
    case 'skill_run_step':
      return { type: 'skill_run_step', ...base };
    case 'review_replan':
      return { type: 'review_replan', ...base };
    default:
      return { type: evt.type, ...base };
  }
}

// Keep `Request` import used (ESLint clean)
void (null as unknown as Request);

// Export the default port for the CLI command
export { DEFAULT_PORT };
