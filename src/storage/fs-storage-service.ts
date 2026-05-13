/**
 * Filesystem-backed StorageService.
 *
 * Each entity is one JSON file (or a JSONL append-only log for token usage).
 * Writes are atomic; settings/members/principles also snapshot the previous
 * version under .snapshots/ before overwrite.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdvisoryBoardMember,
  AppSettings,
  Board,
  BusinessContext,
  BusinessProfile,
  ActionItem,
  DEFAULT_SETTINGS,
  Discussion,
  Principle,
  SkillGenerationRun,
  StorageService,
  TokenUsageLog,
  UserPrompt,
} from './types.js';
import {
  appendJsonl,
  readJson,
  readJsonlAll,
  writeJsonAtomic,
} from './io.js';
import { ensureWorkspaceDirs, paths, ResolvedWorkspace } from './paths.js';
import { nowIso } from '../core/utils.js';

export class FsStorageService implements StorageService {
  private readonly workspace: ResolvedWorkspace;
  private readonly p: ReturnType<typeof paths>;

  constructor(workspace: ResolvedWorkspace) {
    this.workspace = workspace;
    ensureWorkspaceDirs(workspace.root);
    this.p = paths(workspace.root);
  }

  getWorkspaceId(): string {
    return this.workspace.id;
  }

  getWorkspaceRoot(): string {
    return this.workspace.root;
  }

  getWorkspaceScope(): 'home' | 'project' {
    return this.workspace.scope;
  }

  // ============================================================
  // Settings
  // ============================================================

  async loadSettings(): Promise<AppSettings> {
    const data = readJson<Partial<AppSettings>>(this.p.settings, {});
    return { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    writeJsonAtomic(this.p.settings, settings, { snapshotDir: this.p.snapshots });
  }

  // ============================================================
  // Board members
  // ============================================================

  async loadBoardMembers(): Promise<AdvisoryBoardMember[]> {
    return readJson<AdvisoryBoardMember[]>(this.p.members, []);
  }

  async saveBoardMember(member: AdvisoryBoardMember): Promise<void> {
    const all = await this.loadBoardMembers();
    if (all.some((m) => m.id === member.id)) {
      throw new Error(`Member with id ${member.id} already exists`);
    }
    all.push(member);
    writeJsonAtomic(this.p.members, all, { snapshotDir: this.p.snapshots });
  }

  async updateBoardMember(member: AdvisoryBoardMember): Promise<void> {
    const all = await this.loadBoardMembers();
    const idx = all.findIndex((m) => m.id === member.id);
    if (idx === -1) {
      all.push({ ...member, updatedAt: nowIso() });
    } else {
      all[idx] = { ...member, updatedAt: nowIso() };
    }
    writeJsonAtomic(this.p.members, all, { snapshotDir: this.p.snapshots });
  }

  async deleteBoardMember(id: string): Promise<void> {
    const all = await this.loadBoardMembers();
    const next = all.filter((m) => m.id !== id);
    writeJsonAtomic(this.p.members, next, { snapshotDir: this.p.snapshots });
  }

  // ============================================================
  // Boards
  // ============================================================

  async loadBoards(): Promise<Board[]> {
    return readJson<Board[]>(this.p.boards, []);
  }

  async saveBoard(board: Board): Promise<void> {
    const all = await this.loadBoards();
    all.push(board);
    writeJsonAtomic(this.p.boards, all);
  }

  async updateBoard(board: Board): Promise<void> {
    const all = await this.loadBoards();
    const idx = all.findIndex((b) => b.id === board.id);
    if (idx === -1) all.push(board);
    else all[idx] = { ...board, updatedAt: nowIso() };
    writeJsonAtomic(this.p.boards, all);
  }

  async deleteBoard(id: string): Promise<void> {
    const all = await this.loadBoards();
    writeJsonAtomic(this.p.boards, all.filter((b) => b.id !== id));
  }

  // ============================================================
  // Principles
  // ============================================================

  async loadPrinciples(): Promise<Principle[]> {
    return readJson<Principle[]>(this.p.principles, []);
  }

  async savePrinciple(principle: Principle): Promise<void> {
    const all = await this.loadPrinciples();
    all.push(principle);
    writeJsonAtomic(this.p.principles, all, { snapshotDir: this.p.snapshots });
  }

  async updatePrinciple(principle: Principle): Promise<void> {
    const all = await this.loadPrinciples();
    const idx = all.findIndex((p) => p.id === principle.id);
    if (idx === -1) all.push({ ...principle, updatedAt: nowIso() });
    else all[idx] = { ...principle, updatedAt: nowIso() };
    writeJsonAtomic(this.p.principles, all, { snapshotDir: this.p.snapshots });
  }

  async deletePrinciple(id: string): Promise<void> {
    const all = await this.loadPrinciples();
    writeJsonAtomic(
      this.p.principles,
      all.filter((p) => p.id !== id),
      { snapshotDir: this.p.snapshots },
    );
  }

  // ============================================================
  // Business context / profile
  // ============================================================

  async loadBusinessContext(): Promise<BusinessContext[]> {
    return readJson<BusinessContext[]>(this.p.businessContext, []);
  }

  async saveBusinessContext(context: BusinessContext): Promise<void> {
    const all = await this.loadBusinessContext();
    all.push(context);
    writeJsonAtomic(this.p.businessContext, all);
  }

  async updateBusinessContext(context: BusinessContext): Promise<void> {
    const all = await this.loadBusinessContext();
    const idx = all.findIndex((c) => c.id === context.id);
    if (idx === -1) all.push({ ...context, updatedAt: nowIso() });
    else all[idx] = { ...context, updatedAt: nowIso() };
    writeJsonAtomic(this.p.businessContext, all);
  }

  async deleteBusinessContext(id: string): Promise<void> {
    const all = await this.loadBusinessContext();
    writeJsonAtomic(this.p.businessContext, all.filter((c) => c.id !== id));
  }

  async loadBusinessProfile(): Promise<BusinessProfile | null> {
    if (!existsSync(this.p.businessProfile)) return null;
    return readJson<BusinessProfile | null>(this.p.businessProfile, null);
  }

  async saveBusinessProfile(profile: BusinessProfile): Promise<void> {
    writeJsonAtomic(this.p.businessProfile, profile, { snapshotDir: this.p.snapshots });
  }

  // ============================================================
  // Discussions (one JSON file per discussion under discussions/)
  // ============================================================

  async loadDiscussions(): Promise<Discussion[]> {
    if (!existsSync(this.p.discussions)) return [];
    const files = readdirSync(this.p.discussions)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const out: Discussion[] = [];
    for (const f of files) {
      const d = readJson<Discussion | null>(join(this.p.discussions, f), null);
      if (d) out.push(d);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async loadDiscussionPage(
    options: { limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): Promise<{ discussions: Discussion[]; totalCount: number; hasMore: boolean }> {
    const all = await this.loadDiscussions();
    const filtered = options.includeArchived ? all : all.filter((d) => !d.archivedAt);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    const slice = filtered.slice(offset, offset + limit);
    return { discussions: slice, totalCount: filtered.length, hasMore: offset + limit < filtered.length };
  }

  async loadDiscussionById(id: string): Promise<Discussion | null> {
    const path = join(this.p.discussions, `${id}.json`);
    if (!existsSync(path)) return null;
    return readJson<Discussion | null>(path, null);
  }

  async saveDiscussion(discussion: Discussion): Promise<void> {
    const path = join(this.p.discussions, `${discussion.id}.json`);
    writeJsonAtomic(path, discussion);
  }

  async updateDiscussion(discussion: Discussion): Promise<void> {
    return this.saveDiscussion(discussion);
  }

  async deleteDiscussion(id: string): Promise<void> {
    const path = join(this.p.discussions, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  async archiveDiscussion(id: string): Promise<void> {
    const d = await this.loadDiscussionById(id);
    if (!d) throw new Error(`Discussion ${id} not found`);
    d.archivedAt = nowIso();
    await this.saveDiscussion(d);
  }

  async unarchiveDiscussion(id: string): Promise<void> {
    const d = await this.loadDiscussionById(id);
    if (!d) throw new Error(`Discussion ${id} not found`);
    d.archivedAt = undefined;
    await this.saveDiscussion(d);
  }

  // ============================================================
  // Action items (kanban)
  // ============================================================

  async loadActionItems(): Promise<ActionItem[]> {
    return readJson<ActionItem[]>(this.p.actionItems, []);
  }

  async saveActionItem(item: ActionItem): Promise<void> {
    const all = await this.loadActionItems();
    all.push(item);
    writeJsonAtomic(this.p.actionItems, all);
  }

  async updateActionItem(item: ActionItem): Promise<void> {
    const all = await this.loadActionItems();
    const idx = all.findIndex((i) => i.id === item.id);
    if (idx === -1) all.push({ ...item, updatedAt: nowIso() });
    else all[idx] = { ...item, updatedAt: nowIso() };
    writeJsonAtomic(this.p.actionItems, all);
  }

  async deleteActionItem(id: string): Promise<void> {
    const all = await this.loadActionItems();
    writeJsonAtomic(this.p.actionItems, all.filter((i) => i.id !== id));
  }

  // ============================================================
  // Skill generation runs
  // ============================================================

  async loadSkillRuns(actionItemId: string): Promise<SkillGenerationRun[]> {
    const dir = join(this.p.skillRuns, actionItemId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const runs: SkillGenerationRun[] = [];
    for (const f of files) {
      const run = readJson<SkillGenerationRun | null>(join(dir, f), null);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async saveSkillRun(run: SkillGenerationRun): Promise<void> {
    const dir = join(this.p.skillRuns, run.actionItemId);
    writeJsonAtomic(join(dir, `${run.id}.json`), run);
  }

  async getSkillRun(runId: string): Promise<SkillGenerationRun | null> {
    if (!existsSync(this.p.skillRuns)) return null;
    const actionDirs = readdirSync(this.p.skillRuns, { withFileTypes: true });
    for (const dirent of actionDirs) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(this.p.skillRuns, dirent.name, `${runId}.json`);
      if (existsSync(candidate)) {
        return readJson<SkillGenerationRun | null>(candidate, null);
      }
    }
    return null;
  }

  async deleteSkillRun(runId: string): Promise<void> {
    if (!existsSync(this.p.skillRuns)) return;
    const actionDirs = readdirSync(this.p.skillRuns, { withFileTypes: true });
    for (const dirent of actionDirs) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(this.p.skillRuns, dirent.name, `${runId}.json`);
      if (existsSync(candidate)) {
        unlinkSync(candidate);
        return;
      }
    }
  }

  // ============================================================
  // Token usage logs (append-only JSONL, per-day file)
  // ============================================================

  async appendTokenUsageLog(log: TokenUsageLog): Promise<void> {
    const date = log.createdAt.slice(0, 10);
    appendJsonl(join(this.p.tokenUsage, `${date}.jsonl`), log);
  }

  async loadTokenUsageLogs(options: { since?: string; limit?: number } = {}): Promise<TokenUsageLog[]> {
    if (!existsSync(this.p.tokenUsage)) return [];
    const since = options.since ?? '0000-00-00';
    const files = readdirSync(this.p.tokenUsage)
      .filter((f) => f.endsWith('.jsonl') && f.replace('.jsonl', '') >= since)
      .sort();
    const out: TokenUsageLog[] = [];
    for (const f of files) {
      out.push(...readJsonlAll<TokenUsageLog>(join(this.p.tokenUsage, f)));
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit) return out.slice(0, options.limit);
    return out;
  }

  // ============================================================
  // User-customised prompts
  // ============================================================

  async loadPrompts(): Promise<UserPrompt[]> {
    return readJson<UserPrompt[]>(this.p.prompts, []);
  }

  async savePrompt(prompt: UserPrompt): Promise<void> {
    const all = await this.loadPrompts();
    all.push(prompt);
    writeJsonAtomic(this.p.prompts, all);
  }

  async updatePrompt(prompt: UserPrompt): Promise<void> {
    const all = await this.loadPrompts();
    const idx = all.findIndex((p) => p.id === prompt.id);
    if (idx === -1) all.push({ ...prompt, updatedAt: nowIso() });
    else all[idx] = { ...prompt, updatedAt: nowIso() };
    writeJsonAtomic(this.p.prompts, all);
  }

  async deletePrompt(id: string): Promise<void> {
    const all = await this.loadPrompts();
    writeJsonAtomic(this.p.prompts, all.filter((p) => p.id !== id));
  }
}
