/**
 * `aab settings get|set <key> [value]`
 *
 * Reads and writes individual fields of AppSettings. Settings persist via
 * FsStorageService.saveSettings (with snapshotting). No API-key fields —
 * the CLI shells out to the local `claude` CLI for all LLM calls.
 */
import { Command } from 'commander';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { UserError } from '../core/errors.js';
import { type AppSettings } from '../storage/types.js';

const ALLOWED_KEYS = [
  'boardTitle',
  'maxMembersPerDiscussion',
  'maxTurnsPerDiscussion',
  'orchestratorPromptStyle',
  'autoSummarization',
  'consensusThreshold',
  'enableUserInteraction',
  'userInteractionTimeout',
  'clarificationThreshold',
  'primaryModel',
  'researchModel',
  'fastModel',
  'perCallBudgetUsd',
  'locale',
  'activeBoardId',
] as const satisfies readonly (keyof AppSettings)[];

type AllowedKey = (typeof ALLOWED_KEYS)[number];

export function registerSettingsCommand(program: Command): void {
  const settings = program.command('settings').description('view or edit app settings');

  settings
    .command('get [key]')
    .description('print one setting (or all of them when key is omitted)')
    .action(async (key: string | undefined) => {
      const ctx = await openContext(settings, { lock: false });
      try {
        const all = await ctx.storage.loadSettings();
        if (!key) {
          if (ctx.json) {
            process.stdout.write(JSON.stringify(all, null, 2) + '\n');
          } else {
            process.stdout.write(prettySettings(all) + '\n');
          }
          return;
        }
        if (!ALLOWED_KEYS.includes(key as AllowedKey)) {
          throw new UserError(`Unknown setting: ${key}`, `Allowed: ${ALLOWED_KEYS.join(', ')}`);
        }
        const value = (all as unknown as Record<string, unknown>)[key];
        if (ctx.json) process.stdout.write(JSON.stringify({ [key]: value }, null, 2) + '\n');
        else process.stdout.write(`${c.bold(key)}: ${value ?? c.hint('(unset)')}\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  settings
    .command('set <key> <value>')
    .description('update one setting')
    .action(async (key: string, value: string) => {
      if (!ALLOWED_KEYS.includes(key as AllowedKey)) {
        throw new UserError(`Unknown setting: ${key}`, `Allowed: ${ALLOWED_KEYS.join(', ')}`);
      }
      const ctx = await openContext(settings);
      try {
        const current = await ctx.storage.loadSettings();
        const next = { ...current, [key]: coerceSettingValue(key as AllowedKey, value) } as AppSettings;
        await ctx.storage.saveSettings(next);
        process.stdout.write(`${c.ok('✓')} ${key} updated.\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

function prettySettings(s: AppSettings): string {
  const rows: Array<[string, string]> = [
    ['boardTitle', s.boardTitle],
    ['primaryModel', String(s.primaryModel)],
    ['fastModel', String(s.fastModel)],
    ['researchModel', String(s.researchModel)],
    ['maxMembersPerDiscussion', String(s.maxMembersPerDiscussion)],
    ['maxTurnsPerDiscussion', String(s.maxTurnsPerDiscussion)],
    ['consensusThreshold', String(s.consensusThreshold)],
    ['enableUserInteraction', String(s.enableUserInteraction)],
    ['clarificationThreshold', String(s.clarificationThreshold)],
    ['orchestratorPromptStyle', s.orchestratorPromptStyle],
    ['autoSummarization', String(s.autoSummarization)],
    ['perCallBudgetUsd', s.perCallBudgetUsd != null ? String(s.perCallBudgetUsd) : '(unset)'],
    ['locale', s.locale ?? '(unset)'],
    ['activeBoardId', s.activeBoardId ?? '(unset — all active members; set via `aab board use`)'],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.bold(k.padEnd(width))}  ${v}`).join('\n');
}

function coerceSettingValue(key: AllowedKey, raw: string): unknown {
  switch (key) {
    case 'maxMembersPerDiscussion':
    case 'maxTurnsPerDiscussion':
    case 'consensusThreshold':
    case 'userInteractionTimeout':
    case 'clarificationThreshold':
    case 'perCallBudgetUsd': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UserError(`Expected a number for ${key}, got "${raw}"`);
      return n;
    }
    case 'autoSummarization':
    case 'enableUserInteraction': {
      if (raw === 'true' || raw === '1' || raw === 'yes') return true;
      if (raw === 'false' || raw === '0' || raw === 'no') return false;
      throw new UserError(`Expected boolean (true/false) for ${key}, got "${raw}"`);
    }
    case 'orchestratorPromptStyle': {
      if (!['analytical', 'creative', 'balanced'].includes(raw))
        throw new UserError(`Expected analytical|creative|balanced for ${key}, got "${raw}"`);
      return raw;
    }
    case 'primaryModel':
    case 'fastModel':
    case 'researchModel': {
      // Allow aliases (sonnet/opus/haiku/inherit) or full ids — pass through.
      return raw;
    }
    default:
      return raw;
  }
}
