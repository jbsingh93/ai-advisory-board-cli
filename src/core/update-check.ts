/**
 * "Update available" notifier — a dependency-free take on `update-notifier`.
 *
 * Design goals (see the discussion in CHANGELOG / README):
 *  - **Never block the current command.** The notice the user sees is computed
 *    from a *cached* `latest` version, so showing it costs zero network. When
 *    the cache is stale (>24h) we kick off a background HTTPS GET whose socket
 *    is `unref`'d — it refreshes the cache for *next* time and never holds the
 *    process open or delays exit.
 *  - **Fail silent.** Any error (offline, proxy, malformed JSON, unwritable
 *    cache) is swallowed. An update check must never break the CLI.
 *  - **Respect machine consumers.** Skipped when stderr isn't a TTY, when
 *    `--json` is in play, under CI, or when opted out via env.
 *
 * The cache lives at `~/.aabcli/.update-check.json`:
 *   { "lastCheck": <epoch-ms>, "latest": "0.2.0" }
 */
import { request as httpsRequest } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homeRoot } from '../storage/paths.js';
import { VERSION } from '../version.js';
import { c } from '../ui/colors.js';
import { logger } from './logger.js';

const PKG_NAME = 'ai-advisory-board';
const UPGRADE_CMD = `npm i -g ${PKG_NAME}@latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REGISTRY_HOST = 'registry.npmjs.org';

interface UpdateCache {
  lastCheck: number;
  latest: string | null;
}

function cachePath(): string {
  return join(homeRoot(), '.update-check.json');
}

function readCache(): UpdateCache | null {
  try {
    const raw = readFileSync(cachePath(), 'utf8');
    const data = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof data.lastCheck !== 'number') return null;
    return { lastCheck: data.lastCheck, latest: typeof data.latest === 'string' ? data.latest : null };
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    const p = cachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache) + '\n', 'utf8');
  } catch {
    // best-effort — a missing/unwritable home dir just means we re-check next run
  }
}

/** Parse `x.y.z` (ignoring any `-prerelease`/`+build` suffix) into a tuple. */
function parseVersion(v: string): [number, number, number] {
  const core = String(v).trim().replace(/^v/, '').split(/[-+]/)[0] ?? '';
  const [maj, min, pat] = core.split('.');
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

/** True when `latest` is strictly newer than `current` (major.minor.patch). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

/**
 * GET the npm registry's `latest` dist-tag for this package. Resolves to the
 * version string, or `null` on any failure. When `unref` is set the socket is
 * detached so a pending request can't keep the process alive.
 */
export function fetchLatestVersion(opts: { timeoutMs?: number; unref?: boolean } = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = httpsRequest(
      {
        host: REGISTRY_HOST,
        path: `/${PKG_NAME}/latest`,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json',
          'user-agent': `${PKG_NAME}/${VERSION}`,
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          done(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) req.destroy(); // guard against a runaway response
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body) as { version?: unknown };
            done(typeof json.version === 'string' ? json.version : null);
          } catch {
            done(null);
          }
        });
      },
    );
    if (opts.unref) req.on('socket', (s) => s.unref());
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

function notifierDisabled(json?: boolean): boolean {
  return (
    json === true ||
    !process.stderr.isTTY ||
    !!process.env.CI ||
    !!process.env.AAB_NO_UPDATE_NOTIFIER ||
    !!process.env.NO_UPDATE_NOTIFIER ||
    VERSION === '0.0.0' // couldn't resolve our own version — don't guess
  );
}

let alreadyNotified = false;

/**
 * Print a one-line "update available" notice (from cache) and, if the cache is
 * stale, refresh it in the background for next time. Synchronous, non-blocking,
 * and safe to call unconditionally — it self-guards and never throws.
 */
export function maybeNotifyUpdate(opts: { json?: boolean } = {}): void {
  try {
    if (alreadyNotified || notifierDisabled(opts.json)) return;
    alreadyNotified = true;

    const cache = readCache();

    // Refresh in the background when we've never checked or the cache is stale.
    // Stamp `lastCheck` optimistically so a burst of short commands doesn't hit
    // the registry more than once per interval even if the request gets cut off.
    const stale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (stale) {
      writeCache({ lastCheck: Date.now(), latest: cache?.latest ?? null });
      void fetchLatestVersion({ unref: true }).then((latest) => {
        if (latest) writeCache({ lastCheck: Date.now(), latest });
      });
    }

    if (cache?.latest && isNewerVersion(cache.latest, VERSION)) {
      const msg =
        `\n${c.brand('↑')} Update available ${c.dim(VERSION)} ${c.dim('→')} ${c.green(cache.latest)}  ` +
        `${c.hint('run:')} ${c.bold(UPGRADE_CMD)}\n`;
      process.stderr.write(msg);
    }
  } catch (err) {
    logger.debug('[update-check] notify failed', err);
  }
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  error?: string;
}

/**
 * Active check for `aab doctor`: try a fresh fetch (authoritative), fall back
 * to the cache when offline. Updates the cache on a successful fetch. Always
 * resolves — `latest: null` + `error` signals an inconclusive check.
 */
export async function checkForUpdate(opts: { timeoutMs?: number } = {}): Promise<UpdateStatus> {
  const fetched = await fetchLatestVersion({ timeoutMs: opts.timeoutMs ?? 1500 });
  if (fetched) {
    writeCache({ lastCheck: Date.now(), latest: fetched });
    return { current: VERSION, latest: fetched, updateAvailable: isNewerVersion(fetched, VERSION) };
  }
  const cache = readCache();
  if (cache?.latest) {
    return {
      current: VERSION,
      latest: cache.latest,
      updateAvailable: isNewerVersion(cache.latest, VERSION),
      error: 'registry unreachable — showing last cached result',
    };
  }
  return { current: VERSION, latest: null, updateAvailable: false, error: 'registry unreachable' };
}

export const UPGRADE_COMMAND = UPGRADE_CMD;
