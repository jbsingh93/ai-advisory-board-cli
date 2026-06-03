/**
 * Pure helpers for the Boards feature (Phase 7): slug generation, validation,
 * and token resolution. Mirrors the member conventions (`emit-member-agent.ts`
 * slug, `discuss.ts` resolveMemberToken) and the sage-council
 * `boundary-validation.ts` bounds (1–100 name, 0–500 description, dedup ids).
 */
import slugify from 'slugify';
import type { AdvisoryBoardMember, Board } from '../../storage/types.js';

export const BOARD_NAME_MAX = 100;
export const BOARD_DESCRIPTION_MAX = 500;

/** Kebab-case slug from a board name — same scheme as member slugs. */
export function boardSlug(name: string): string {
  const slug = slugify(name, { lower: true, strict: true });
  return slug || 'board';
}

/**
 * Ensure a slug is unique against a set of existing slugs, suffixing `-2`,
 * `-3`, … on collision (sage-council parity).
 */
export function ensureUniqueBoardSlug(base: string, existingSlugs: Iterable<string>): string {
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export interface ValidateBoardInput {
  name: string;
  description?: string;
  memberIds: string[];
}

export interface ValidateBoardContext {
  /** All boards in the workspace (for name-uniqueness). */
  existingBoards: Board[];
  /** All members (for existence checks). */
  members: AdvisoryBoardMember[];
  /** When editing, the id of the board being edited (excluded from uniqueness). */
  excludeBoardId?: string;
}

/**
 * Validate board input against the sage-council bounds. Returns a list of
 * human-readable error strings (empty ⇒ valid). Does NOT mutate input.
 */
export function validateBoardFields(
  input: ValidateBoardInput,
  ctx: ValidateBoardContext,
): string[] {
  const errors: string[] = [];

  const name = input.name?.trim() ?? '';
  if (name.length < 1) errors.push('name is required');
  if (name.length > BOARD_NAME_MAX) errors.push(`name must be ≤ ${BOARD_NAME_MAX} characters`);

  const lower = name.toLowerCase();
  const nameClash = ctx.existingBoards.some(
    (b) => b.id !== ctx.excludeBoardId && b.name.trim().toLowerCase() === lower,
  );
  if (name.length >= 1 && nameClash) errors.push(`a board named "${name}" already exists`);

  if (input.description && input.description.length > BOARD_DESCRIPTION_MAX) {
    errors.push(`description must be ≤ ${BOARD_DESCRIPTION_MAX} characters`);
  }

  const ids = dedupeMemberIds(input.memberIds);
  if (ids.length < 1) errors.push('a board needs at least one member');
  const known = new Set(ctx.members.map((m) => m.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) errors.push(`unknown member id(s): ${missing.join(', ')}`);

  return errors;
}

/** Deduplicate member ids preserving first-seen order. */
export function dedupeMemberIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Resolve a CLI token to a board, matching exact id, exact slug, exact
 * (case-insensitive) name, then prefix on slug/name. Returns undefined on no
 * match. Mirrors `resolveMemberToken` in `discuss.ts`.
 */
export function resolveBoardToken(pool: Board[], token: string): Board | undefined {
  const raw = token.trim();
  const t = raw.toLowerCase();
  if (!t) return undefined;
  return (
    pool.find((b) => b.id === raw) ??
    pool.find((b) => b.slug === t) ??
    pool.find((b) => b.name.toLowerCase() === t) ??
    pool.find((b) => b.slug.startsWith(t)) ??
    pool.find((b) => b.name.toLowerCase().startsWith(t))
  );
}
