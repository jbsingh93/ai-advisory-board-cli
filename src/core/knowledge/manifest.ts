/**
 * Manifest — `<workspace>/.manifest.json` — provenance ledger for the wiki.
 *
 * Format spec: `docs/development/KNOWLEDGE_WIKI.md` §13. Writes are atomic via
 * `writeJsonAtomic` so concurrent ingest + rename + lint stay consistent
 * (the workspace mutex serialises them; the atomic write keeps a crash
 * from leaving the JSON half-written).
 */
import { existsSync } from 'node:fs';
import { readJson, writeJsonAtomic } from '../../storage/io.js';
import { nowIso } from '../utils.js';
import { generateUUID } from '../utils.js';

export type ManifestSourceType =
  | 'file'
  | 'url'
  | 'pasted'
  | 'discussion'
  | 'summary'
  | 'discussion-rerun'
  // Phase 8 — a single user utterance ingested via the user-fact merge agent
  // (initial question / follow-up / HITL response / sparring message).
  | 'user-input';

export interface ManifestEntry {
  id: string;
  rawPath: string;
  sourceType: ManifestSourceType;
  originalName?: string;
  url?: string;
  discussionId?: string;
  hash: string;
  ingestedAt: string;
  ingestModel?: string;
  ingestCostUsd?: number;
  producedPages: string[];
  updatedPages: string[];
  userEditedPagesSkipped?: string[];
  notes?: string;
}

export interface ManifestUserEdited {
  page: string;
  lastEditedAt: string;
  editorHint?: string;
}

export type ManifestRenameTrigger = 'manual' | 'lint-recommended' | 'foam-reconcile';

export interface ManifestRename {
  id: string;
  from: string;
  to: string;
  fromSlug: string;
  toSlug: string;
  at: string;
  trigger: ManifestRenameTrigger;
  rewroteRefs?: number;
  rewroteRelated?: number;
  rewroteAliases?: number;
  rewroteManifestEntries?: number;
}

export interface Manifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  entries: ManifestEntry[];
  userEditedPages: ManifestUserEdited[];
  renames: ManifestRename[];
}

export const MANIFEST_VERSION = 1;

export function emptyManifest(): Manifest {
  const now = nowIso();
  return {
    version: MANIFEST_VERSION,
    createdAt: now,
    updatedAt: now,
    entries: [],
    userEditedPages: [],
    renames: [],
  };
}

export function loadManifest(path: string): Manifest {
  if (!existsSync(path)) return emptyManifest();
  const raw = readJson<Partial<Manifest>>(path, {} as Partial<Manifest>);
  return {
    version: typeof raw.version === 'number' ? raw.version : MANIFEST_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    userEditedPages: Array.isArray(raw.userEditedPages) ? raw.userEditedPages : [],
    renames: Array.isArray(raw.renames) ? raw.renames : [],
  };
}

export function saveManifest(path: string, manifest: Manifest): void {
  manifest.updatedAt = nowIso();
  writeJsonAtomic(path, manifest);
}

/**
 * Initialise an empty manifest file if it doesn't exist yet. Idempotent.
 */
export function initManifestIfAbsent(path: string): void {
  if (existsSync(path)) return;
  saveManifest(path, emptyManifest());
}

/**
 * Look up the manifest entry for a content hash. Returns the most-recent
 * entry if multiple exist (we don't dedupe entries — we dedupe new ingests
 * against the latest run).
 */
export function findEntryByHash(manifest: Manifest, hash: string): ManifestEntry | undefined {
  for (let i = manifest.entries.length - 1; i >= 0; i--) {
    const entry = manifest.entries[i]!;
    if (entry.hash === hash) return entry;
  }
  return undefined;
}

/** Build a new entry with a generated id + timestamp. */
export function newEntry(
  partial: Omit<ManifestEntry, 'id' | 'ingestedAt'> & { ingestedAt?: string },
): ManifestEntry {
  return {
    ...partial,
    id: `ing_${generateUUID().slice(0, 16)}`,
    ingestedAt: partial.ingestedAt ?? nowIso(),
  };
}

/** Append an entry and persist. */
export function appendEntry(path: string, entry: ManifestEntry): Manifest {
  const m = loadManifest(path);
  m.entries.push(entry);
  saveManifest(path, m);
  return m;
}

/** Append a rename record. */
export function appendRename(path: string, rename: Omit<ManifestRename, 'id' | 'at'> & { at?: string }): Manifest {
  const m = loadManifest(path);
  m.renames.push({
    ...rename,
    id: `ren_${generateUUID().slice(0, 16)}`,
    at: rename.at ?? nowIso(),
  });
  saveManifest(path, m);
  return m;
}

/**
 * Rewrite every `producedPages` / `updatedPages` / `userEditedPages.page`
 * reference from `fromPath` to `toPath`. Returns the count rewritten across
 * the three collections so the rename log can record it.
 */
export interface ManifestRewriteResult {
  manifest: Manifest;
  rewroteManifestEntries: number;
}

export function rewriteManifestPaths(
  manifest: Manifest,
  fromPath: string,
  toPath: string,
): ManifestRewriteResult {
  let count = 0;
  for (const entry of manifest.entries) {
    entry.producedPages = entry.producedPages.map((p) => {
      if (p === fromPath) {
        count++;
        return toPath;
      }
      return p;
    });
    entry.updatedPages = entry.updatedPages.map((p) => {
      if (p === fromPath) {
        count++;
        return toPath;
      }
      return p;
    });
    if (entry.userEditedPagesSkipped) {
      entry.userEditedPagesSkipped = entry.userEditedPagesSkipped.map((p) => {
        if (p === fromPath) {
          count++;
          return toPath;
        }
        return p;
      });
    }
  }
  for (const ue of manifest.userEditedPages) {
    if (ue.page === fromPath) {
      ue.page = toPath;
      count++;
    }
  }
  return { manifest, rewroteManifestEntries: count };
}

/** Mark a page as user-edited (or refresh the timestamp). */
export function markUserEdited(path: string, page: string, hint = 'manual'): void {
  const m = loadManifest(path);
  const existing = m.userEditedPages.find((u) => u.page === page);
  if (existing) {
    existing.lastEditedAt = nowIso();
    existing.editorHint = hint;
  } else {
    m.userEditedPages.push({ page, lastEditedAt: nowIso(), editorHint: hint });
  }
  saveManifest(path, m);
}
