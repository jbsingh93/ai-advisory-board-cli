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
import { paths, resolveWorkspace } from '../storage/paths.js';
import { walkWikiPages, parsePage, serializePage, extractWikiLinks, toPosix, type PageType } from '../core/knowledge/page.js';
import { buildSlugMap, resolveSlug, extractBacklinksSection } from '../core/knowledge/slug-map.js';
import { loadManifest, markUserEdited } from '../core/knowledge/manifest.js';
import { renameSlug } from '../core/knowledge/rename.js';
import { ingestFile, ingestPaste, ingestUrl, ingestDiscussionRaw } from '../core/knowledge/ingest.js';
import { queryWiki } from '../core/knowledge/query.js';
import { lintWiki } from '../core/knowledge/lint.js';
import { existsSync as fsExistsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  AdvisoryBoardMember,
  AppSettings,
  DecisionSession,
  Discussion,
  Principle,
  PrincipleCategory,
} from '../storage/types.js';
import { enhancePersona, type EnhancementType } from '../core/members/ai-enhancer.js';
import { generateVoiceGuide } from '../core/members/voice-guide.js';
import { coachReply, newDecisionSession } from '../core/coach/decision-coach.js';
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

  app.post('/api/coach/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { situation?: string; title?: string };
      if (!body.situation || !body.situation.trim()) {
        res.status(400).json({ error: 'situation is required' });
        return;
      }
      const session = newDecisionSession(body.situation.trim(), body.title?.trim() || undefined);
      await opts.storage.saveDecisionSession(session);
      res.status(202).json({ accepted: true, session });
      broadcast({ type: 'coach_session_started', session });

      // Kick off the opener turn in the background.
      (async () => {
        try {
          const settings = await opts.storage.loadSettings();
          const principles = await opts.storage.loadPrinciples();
          broadcast({ type: 'coach_thinking', sessionId: session.id });
          const { session: updated, reply } = await coachReply(session, principles, '', settings);
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
      const body = (req.body ?? {}) as { content?: string };
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
      res.status(202).json({ accepted: true, sessionId: session.id });
      broadcast({ type: 'coach_thinking', sessionId: session.id });

      (async () => {
        try {
          const settings = await opts.storage.loadSettings();
          const principles = await opts.storage.loadPrinciples();
          const { session: updated, reply } = await coachReply(session!, principles, body.content!.trim(), settings);
          await opts.storage.updateDecisionSession(updated);
          broadcast({ type: 'coach_message', sessionId: updated.id, message: reply, session: updated });
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
      const body = (req.body ?? {}) as { paste?: string; url?: string; path?: string; force?: boolean; type?: string };
      const workspace = resolveWorkspaceForWiki();
      const settings = await opts.storage.loadSettings();
      broadcast({ type: 'wiki_ingest_started', sourceType: body.url ? 'url' : body.path ? 'file' : 'pasted' });
      let result;
      if (body.paste) {
        result = await ingestPaste({ text: body.paste, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else if (body.url) {
        result = await ingestUrl({ url: body.url, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else if (body.path) {
        result = await ingestFile({ path: body.path, workspace, settings, force: body.force, hintType: body.type as PageType | undefined });
      } else {
        res.status(400).json({ error: 'Provide paste, url, or path.' });
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
