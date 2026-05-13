/**
 * Version + brand strings. Read once at startup.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMeta {
  version: string;
  description?: string;
}

function findPackageJson(): PackageMeta {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up until we find a package.json (works in src/, dist/bin/, etc.)
  let dir = here;
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      return JSON.parse(raw) as PackageMeta;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { version: '0.0.0' };
}

const meta = findPackageJson();
export const VERSION = meta.version;
export const PRODUCT_NAME = 'AI Advisory Board CLI';
export const PRODUCT_DESCRIPTION =
  meta.description ||
  'Convene a panel of Claude sub-agents and turn their action items into Claude Code skills.';
