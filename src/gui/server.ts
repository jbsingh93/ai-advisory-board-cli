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
} from '../agents/emit-member-agent.js';
import { logger } from '../core/logger.js';
import { generateUUID, nowIso } from '../core/utils.js';
import type { FsStorageService } from '../storage/fs-storage-service.js';
import { DEFAULT_SETTINGS } from '../storage/types.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Discussion,
  Principle,
  PrincipleCategory,
} from '../storage/types.js';

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
  app.use(express.json({ limit: '256kb' }));

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
      const [settings, members, principles, actionItems, discussionPage] = await Promise.all([
        opts.storage.loadSettings(),
        opts.storage.loadBoardMembers(),
        opts.storage.loadPrinciples(),
        opts.storage.loadActionItems(),
        opts.storage.loadDiscussionPage({ limit: 50 }),
      ]);
      res.json({
        workspace: {
          id: opts.storage.getWorkspaceId(),
          root: opts.storage.getWorkspaceRoot(),
          scope: opts.storage.getWorkspaceScope(),
          projectRoot,
        },
        settings,
        members: enrichMembers(members),
        principles,
        actionItems,
        discussions: discussionPage.discussions,
        discussionTotal: discussionPage.totalCount,
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

  app.get('/api/members', async (_req, res) => {
    try {
      const members = await opts.storage.loadBoardMembers();
      res.json(enrichMembers(members));
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
        ...(Array.isArray(body.allowedTools) ? { allowedTools: body.allowedTools } : {}),
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
      // Clean up the agent file iff it was AAB-generated (don't nuke user-edited).
      try {
        const p = memberAgentPath(memberAgentSlug(existing.name), projectRoot);
        if (isAabGenerated(p)) {
          unlinkSync(p);
        }
      } catch {
        /* fine */
      }
      res.status(204).end();
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
  app.post('/api/discussions', async (req, res) => {
    try {
      const { question, memberIds } = req.body as { question?: string; memberIds?: string[] };
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
          broadcast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
        });
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
        });
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
      const allowedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
      const candidatePool = allMembers.filter((m) => allowedIds.has(m.id) && m.isActive);
      if (candidatePool.length === 0) {
        res.status(400).json({ error: "No active members from this discussion's original board remain." });
        return;
      }

      // Resolve which members will actually spawn (so we can verify their files).
      let willSpawn = candidatePool;
      if (targetType === 'specific') {
        willSpawn = candidatePool.filter((m) => m.id === body.selectedMemberId);
        if (willSpawn.length === 0) {
          res.status(400).json({ error: `Member ${body.selectedMemberId} is not part of this discussion.` });
          return;
        }
      } else if (targetType === 'subset') {
        const set = new Set(body.selectedMemberIds);
        willSpawn = candidatePool.filter((m) => set.has(m.id));
        if (willSpawn.length === 0) {
          res.status(400).json({ error: 'None of the selected members are part of this discussion.' });
          return;
        }
      }

      const missing = willSpawn
        .map((m) => ({ name: m.name, slug: memberAgentSlug(m.name) }))
        .filter((m) => !existsSync(join(projectRoot, '.claude', 'agents', `${m.slug}.md`)));
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing .claude/agents/<slug>.md for: ${missing.map((m) => m.name).join(', ')}`,
        });
        return;
      }

      res.status(202).json({ accepted: true });

      const fromRoundNumber = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
      logger.info(
        `[ui] follow-up on discussion ${discussion.id.slice(0, 8)} (target=${targetType}, members=${willSpawn.length})`,
      );
      addFollowUpQuestion({
        discussion,
        question: body.question.trim(),
        members: candidatePool,
        settings,
        storage: opts.storage,
        projectRoot,
        targetType,
        selectedMemberId: body.selectedMemberId,
        selectedMemberIds: body.selectedMemberIds,
        onProgress: broadcastRoundProgress(discussion.id, willSpawn),
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
          logger.warn('[ui] follow-up failed:', error);
          broadcast({
            type: 'error',
            discussionId: discussion.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    } catch (error) {
      sendError(res, 500, error);
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

function enrichMembers(members: AdvisoryBoardMember[]): Array<AdvisoryBoardMember & { slug: string; initials: string }> {
  return members.map(enrichOne);
}

function enrichOne(m: AdvisoryBoardMember): AdvisoryBoardMember & { slug: string; initials: string } {
  return {
    ...m,
    slug: memberAgentSlug(m.name),
    initials: initialsOf(m.name),
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

// Keep `Request` import used (ESLint clean)
void (null as unknown as Request);

// Export the default port for the CLI command
export { DEFAULT_PORT };
