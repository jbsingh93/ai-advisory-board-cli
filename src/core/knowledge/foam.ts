/**
 * Foam (VS Code) recommendation — emits/merges `.vscode/extensions.json` so
 * users who open the workspace in VS Code get a one-click install prompt for
 * `foam.foam-vscode`.
 *
 * Spec: `PLAN/KNOWLEDGE_WIKI.md` §17 ("aab init --foam"). Foam is the
 * recommended human-side editor — speaks `[[wikilinks]]` natively (Obsidian
 * flavor), gives autocomplete + click navigation + graph view + backlinks
 * panel, MIT-licensed, free. Zero engineering on our side.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FOAM_EXTENSION_ID = 'foam.foam-vscode';

export type FoamEmitResult =
  | { action: 'created'; path: string }
  | { action: 'merged'; path: string }
  | { action: 'noop'; path: string; reason: string };

export interface VsCodeExtensionsJson {
  recommendations?: string[];
  unwantedRecommendations?: string[];
  [key: string]: unknown;
}

/**
 * Write or merge a Foam recommendation into `<projectRoot>/.vscode/extensions.json`.
 *
 * Behavior:
 *  - File missing: create with `{ recommendations: ["foam.foam-vscode"] }`.
 *  - File exists, already lists Foam: no-op.
 *  - File exists, missing Foam: parse, append, write back atomically.
 *  - File exists but unparseable: refuse to overwrite (unless `force` is true).
 */
export function emitFoamRecommendation(opts: {
  projectRoot: string;
  force?: boolean;
}): FoamEmitResult {
  const path = join(opts.projectRoot, '.vscode', 'extensions.json');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify({ recommendations: [FOAM_EXTENSION_ID] }, null, 2) + '\n';
    writeFileSync(path, body, 'utf8');
    return { action: 'created', path };
  }

  let parsed: VsCodeExtensionsJson;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as VsCodeExtensionsJson;
  } catch (error) {
    if (!opts.force) {
      return {
        action: 'noop',
        path,
        reason: `existing .vscode/extensions.json is not valid JSON (${error instanceof Error ? error.message : 'parse error'}); refusing to overwrite — re-run with --foam-overwrite to replace`,
      };
    }
    const body = JSON.stringify({ recommendations: [FOAM_EXTENSION_ID] }, null, 2) + '\n';
    writeFileSync(path, body, 'utf8');
    return { action: 'created', path };
  }

  const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations.slice() : [];
  if (recs.includes(FOAM_EXTENSION_ID)) {
    return { action: 'noop', path, reason: 'already recommends foam.foam-vscode' };
  }
  recs.push(FOAM_EXTENSION_ID);
  parsed.recommendations = recs;
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return { action: 'merged', path };
}

/** True if `.vscode/extensions.json` already lists Foam in its recommendations. */
export function foamAlreadyRecommended(projectRoot: string): boolean {
  const path = join(projectRoot, '.vscode', 'extensions.json');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VsCodeExtensionsJson;
    return Array.isArray(parsed.recommendations) && parsed.recommendations.includes(FOAM_EXTENSION_ID);
  } catch {
    return false;
  }
}
