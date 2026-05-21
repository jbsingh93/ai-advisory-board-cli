/**
 * `aab skills` — Phase 5 Chunk 5.
 *
 *   aab skills list                    enumerate installed skills (project + user)
 *   aab skills show <name>             pretty-print SKILL.md + sidecar metadata
 *   aab skills test <name> "<input>"   round-trip the skill via `claude -p`
 *   aab skills uninstall <name>        archive to .snapshots/skills/<name>-<ts>/
 *   aab skills restore <name> [--snapshot <ts>]
 */
import { Command } from 'commander';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeContext, openContext } from './_context.js';
import { askConfirm, askSelect } from '../ui/prompts.js';
import { c } from '../ui/colors.js';
import { spinner } from '../ui/spinner.js';
import { UserError } from '../core/errors.js';
import { runClaude } from '../llm/claude-code-runner.js';
import { resolveSkill } from '../core/skill/resolve-skill-creator.js';
import type { ResolvedSkill } from '../core/skill/resolve-skill-creator.js';

export function registerSkillsCommand(program: Command): void {
  const s = program.command('skills').description('list, show, test, uninstall installed Claude Code skills');

  // ----- list -----
  s.command('list')
    .description('enumerate installed skills (project + user + plugin)')
    .action(async () => {
      const ctx = await openContext(s, { lock: false });
      try {
        const installed = listInstalledSkills(process.cwd());
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ skills: installed }, null, 2) + '\n');
          return;
        }
        if (installed.length === 0) {
          process.stdout.write(c.hint('  (no installed skills)\n'));
          return;
        }
        for (const sk of installed) {
          process.stdout.write(
            `  ${c.bold(sk.name)} ${c.hint('(' + sk.scope + (sk.version ? '; v' + sk.version : '') + ') · ' + sk.dir)}\n`,
          );
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // ----- show -----
  s.command('show <name>')
    .description('pretty-print SKILL.md + sidecar metadata')
    .action(async (name: string) => {
      const ctx = await openContext(s, { lock: false });
      try {
        const sk = resolveSkill(name, { projectRoot: process.cwd() });
        if (!sk) throw new UserError(`Skill "${name}" not found in any scope.`);
        const body = readFileSync(sk.path, 'utf8');
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ skill: sk, body }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`\n${c.bold(sk.name)} ${c.hint('(' + sk.scope + (sk.version ? '; v' + sk.version : '') + ')')}\n`);
        process.stdout.write(c.hint('  ' + sk.dir + '\n\n'));
        process.stdout.write(body + '\n');
      } finally {
        await closeContext(ctx);
      }
    });

  // ----- test -----
  s.command('test <name> [input...]')
    .description('round-trip the skill via `claude -p` with --append-system-prompt-file')
    .option('--timeout <ms>', 'wall-clock timeout', '300000')
    .action(async (name: string, input: string[], opts: { timeout?: string }) => {
      const ctx = await openContext(s, { lock: false });
      try {
        const sk = resolveSkill(name, { projectRoot: process.cwd() });
        if (!sk) throw new UserError(`Skill "${name}" not found.`);
        const prompt = input.join(' ').trim() || `Activate the ${name} skill and walk through its workflow.`;
        const sp = spinner(`Testing skill ${c.bold(name)} via claude -p…`);
        sp.start();
        try {
          const result = await runClaude({
            prompt,
            appendSystemPromptFile: sk.path,
            timeoutMs: Number(opts.timeout) || 5 * 60_000,
          });
          sp.succeed('skill test ran');
          process.stdout.write('\n' + (result.json?.result ?? result.stdout) + '\n');
        } catch (err) {
          sp.fail('skill test failed');
          throw err;
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // ----- uninstall -----
  s.command('uninstall <name>')
    .description('archive a skill to .snapshots/skills/<name>-<timestamp>/')
    .option('--yes', 'skip confirmation')
    .option('--scope <scope>', 'project | user (default: auto)', undefined)
    .action(async (name: string, opts: { yes?: boolean; scope?: string }) => {
      const ctx = await openContext(s);
      try {
        const sk = resolveSkill(name, { projectRoot: process.cwd() });
        if (!sk) throw new UserError(`Skill "${name}" not found.`);
        if (opts.scope && opts.scope !== sk.scope) {
          throw new UserError(`Skill "${name}" is installed at ${sk.scope} scope, not ${opts.scope}.`);
        }
        if (!opts.yes) {
          const ok = await askConfirm(`Archive ${sk.dir} to .snapshots/?`, false);
          if (!ok) return;
        }
        const archived = archiveSkill(sk);
        process.stdout.write(`${c.ok('✓')} archived to ${archived}\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  // ----- restore -----
  s.command('restore <name>')
    .description('restore a skill from .snapshots/skills/')
    .option('--snapshot <ts>', 'specific snapshot timestamp to restore (default: latest)')
    .action(async (name: string, opts: { snapshot?: string }) => {
      const ctx = await openContext(s);
      try {
        const candidates = findArchivedSkills(name, process.cwd());
        if (candidates.length === 0) throw new UserError(`No archived snapshots found for "${name}".`);
        let chosen = candidates[candidates.length - 1]!;
        if (opts.snapshot) {
          const match = candidates.find((c) => c.includes(opts.snapshot!));
          if (!match) throw new UserError(`No snapshot matching "${opts.snapshot}".`);
          chosen = match;
        } else if (candidates.length > 1) {
          chosen = await askSelect('Pick a snapshot to restore', candidates.map((c) => ({ name: c, message: c })));
        }
        const targetParent = join(process.cwd(), '.claude', 'skills');
        mkdirSync(targetParent, { recursive: true });
        const target = join(targetParent, name);
        if (existsSync(target)) {
          throw new UserError(`Cannot restore: ${target} already exists. Uninstall first.`);
        }
        cpSync(chosen, target, { recursive: true });
        process.stdout.write(`${c.ok('✓')} restored ${name} from ${chosen}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

/**
 * List every installed skill across project + user + plugin scopes.
 */
export function listInstalledSkills(projectRoot: string): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  const seen = new Set<string>();
  const sources: Array<{ root: string; scope: ResolvedSkill['scope'] }> = [
    { root: join(projectRoot, '.claude', 'skills'), scope: 'project' },
    { root: join(homedir(), '.claude', 'skills'), scope: 'user' },
  ];
  for (const { root } of sources) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen.has(e)) continue;
      const sk = resolveSkill(e, { projectRoot });
      if (sk) {
        seen.add(e);
        out.push(sk);
      }
    }
  }
  // Plugin scope
  const pluginsRoot = join(homedir(), '.claude', 'plugins');
  if (existsSync(pluginsRoot)) {
    let plugins: string[] = [];
    try {
      plugins = readdirSync(pluginsRoot);
    } catch {
      plugins = [];
    }
    for (const p of plugins) {
      const inner = join(pluginsRoot, p, 'skills');
      if (!existsSync(inner)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(inner);
      } catch {
        continue;
      }
      for (const n of names) {
        if (seen.has(n)) continue;
        const sk = resolveSkill(n, { projectRoot });
        if (sk) {
          seen.add(n);
          out.push(sk);
        }
      }
    }
  }
  return out;
}

function archiveSkill(sk: ResolvedSkill): string {
  const parent = sk.dir.replace(/[\\/][^\\/]+$/, '');
  const snapshotsDir = join(parent, '.snapshots', 'skills');
  mkdirSync(snapshotsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(snapshotsDir, `${sk.name}-${ts}`);
  cpSync(sk.dir, target, { recursive: true });
  rmSync(sk.dir, { recursive: true, force: true });
  return target;
}

function findArchivedSkills(name: string, projectRoot: string): string[] {
  const out: string[] = [];
  const candidates = [
    join(projectRoot, '.claude', '.snapshots', 'skills'),
    join(projectRoot, '.claude', 'skills', '.snapshots', 'skills'),
    join(homedir(), '.claude', '.snapshots', 'skills'),
    join(homedir(), '.claude', 'skills', '.snapshots', 'skills'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith(name + '-')) out.push(join(dir, e));
    }
  }
  return out.sort();
}
