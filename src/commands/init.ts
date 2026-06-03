/**
 * `aab init` — bootstrap a workspace.
 *
 * Phase 0 scope (claude-CLI-native):
 *   - detect Claude Code session
 *   - detect the `claude` binary on PATH
 *   - choose home (~/.aabcli) or project-mounted (./.aabcli) workspace
 *   - seed starter members and starter principles
 *   - emit one .claude/agents/<member-slug>.md per starter member
 *   - write a default settings.json
 *
 * No Anthropic API key — the CLI shells out to `claude` for all LLM calls,
 * which uses the user's existing Claude Max/Pro subscription.
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectClaudeCode } from '../env/detect-claude-code.js';
import { detectClaudeCli } from '../llm/claude-code-runner.js';
import { generateUUID, nowIso } from '../core/utils.js';
import { c, brand } from '../ui/colors.js';
import { askConfirm, askSelect } from '../ui/prompts.js';
import { spinner } from '../ui/spinner.js';
import { homeRoot, paths, setActiveWorkspaceId, slugifyWorkspaceId } from '../storage/paths.js';
import { FsStorageService } from '../storage/fs-storage-service.js';
import { DEFAULT_SETTINGS, type AdvisoryBoardMember, type Board, type Principle } from '../storage/types.js';
import { STARTER_BOARD_MEMBERS } from '../starter/starter-board-members.js';
import { STARTER_PRINCIPLES } from '../starter/starter-principles.js';
import { emitMemberAgentFile } from '../agents/emit-member-agent.js';
import { ResolvedWorkspace } from '../storage/paths.js';
import { emitWikiSkeleton } from '../core/knowledge/schema-emitter.js';
import { emitFoamRecommendation } from '../core/knowledge/foam.js';
import { resolveSkillCreator, skillCreatorInstallHint } from '../core/skill/resolve-skill-creator.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('bootstrap a workspace, seed starter members and principles, write .claude/agents/')
    .option('--non-interactive', 'skip prompts (use --here / --home + --no-seed defaults)')
    .option('--here', 'mount workspace at ./.aabcli/ (project-scoped)')
    .option('--home', 'mount workspace at ~/.aabcli/<slug>/ (default)')
    .option('--name <slug>', 'workspace id override')
    .option('--no-seed', 'skip seeding starter members and principles')
    .option('--no-agents', 'skip writing .claude/agents/<member>.md files')
    .option('--agents-dir <path>', 'where to write .claude/agents/ (default: cwd)')
    .option('--no-wiki', 'skip emitting wiki/KNOWLEDGE.md + wiki/index.md + raw/')
    .option('--foam', 'recommend the Foam VS Code extension via .vscode/extensions.json')
    .option('--foam-overwrite', 'overwrite an unparseable .vscode/extensions.json (rare)')
    .option('--install-skill-creator', 'detect skill-creator (Phase 5 prereq) and print install instructions if missing')
    .action(async (cmdOpts: InitOptions) => {
      await runInit(cmdOpts);
    });
}

interface InitOptions {
  nonInteractive?: boolean;
  here?: boolean;
  home?: boolean;
  name?: string;
  seed?: boolean;
  agents?: boolean;
  agentsDir?: string;
  wiki?: boolean;
  foam?: boolean;
  foamOverwrite?: boolean;
  installSkillCreator?: boolean;
}

async function runInit(opts: InitOptions): Promise<void> {
  process.stdout.write(`\n${brand()}\n`);
  process.stdout.write(c.hint('  Convene a panel of Claude sub-agents on any business question.\n\n'));

  // 1. Detect Claude Code session
  const ccEnv = detectClaudeCode();
  process.stdout.write(
    `Claude Code session: ${ccEnv.detected ? c.ok('detected ✓') : c.hint('not detected')}` +
      (ccEnv.version ? ` ${c.hint('(' + ccEnv.version + ')')}` : '') +
      '\n',
  );

  // 2. Detect `claude` CLI on PATH (this is what we shell out to for LLM calls)
  const sp = spinner('Looking for `claude` CLI on PATH...');
  sp.start();
  const cli = await detectClaudeCli();
  if (cli.installed) {
    sp.succeed(`Found \`claude\` CLI${cli.version ? ' v' + cli.version : ''}.`);
  } else {
    sp.fail(`\`claude\` CLI not found on PATH.`);
    process.stdout.write(
      c.hint(
        '\n  The CLI uses the `claude` binary to run all LLM calls — no API key required.\n' +
          '  Install it: ' +
          c.cyan('npm install -g @anthropic-ai/claude-code') +
          '\n  Or grab Claude Desktop and ensure `claude` is on PATH.\n\n',
      ),
    );
    if (!opts.nonInteractive) {
      const proceed = await askConfirm('Continue anyway? (you can install claude later and re-run init)', false);
      if (!proceed) return;
    }
  }

  // 3. Choose workspace location
  const workspace = await chooseWorkspace(opts);
  process.stdout.write(`Workspace: ${c.bold(workspace.id)} ${c.hint('(' + workspace.scope + ': ' + workspace.root + ')')}\n`);

  // Sanity: refuse to overwrite an existing workspace silently
  const settingsPath = paths(workspace.root).settings;
  if (existsSync(settingsPath) && !opts.nonInteractive) {
    const ok = await askConfirm(
      `A workspace already exists at ${workspace.root}. Re-seed and overwrite settings?`,
      false,
    );
    if (!ok) {
      process.stdout.write(c.hint('Aborted; nothing changed.\n'));
      return;
    }
  }

  const storage = new FsStorageService(workspace);

  // 4. Save settings
  const sp2 = spinner('Writing workspace files...');
  sp2.start();
  await storage.saveSettings({ ...DEFAULT_SETTINGS });

  // Mark workspace version + active pointer
  writeFileSync(paths(workspace.root).versionFile, '1', 'utf8');
  if (workspace.scope === 'home') setActiveWorkspaceId(workspace.id);

  // 5. Seed starter members and principles (unless --no-seed)
  let memberCount = 0;
  let principleCount = 0;
  const seededMembers: AdvisoryBoardMember[] = [];

  if (opts.seed !== false) {
    const now = nowIso();

    for (const starter of STARTER_BOARD_MEMBERS) {
      const member: AdvisoryBoardMember = {
        id: generateUUID(),
        name: starter.name,
        title: starter.title,
        expertise: starter.expertise,
        persona: starter.persona,
        voiceGuide: starter.voiceGuide,
        avatar: starter.avatar,
        isActive: starter.isActive,
        createdAt: now,
        updatedAt: now,
      };
      await storage.saveBoardMember(member);
      seededMembers.push(member);
      memberCount++;
    }

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
      await storage.savePrinciple(principle);
      principleCount++;
    }
  }
  // Seed a starter "Full Board" containing all seeded members + set it active,
  // so the boards feature is discoverable from first run (spec §1.8).
  if (opts.seed !== false && seededMembers.length > 0) {
    const now = nowIso();
    const board: Board = {
      id: generateUUID(),
      name: 'Full Board',
      slug: 'full-board',
      description: 'All starter members.',
      memberIds: seededMembers.map((m) => m.id),
      createdAt: now,
      updatedAt: now,
    };
    await storage.saveBoard(board);
    const seededSettings = await storage.loadSettings();
    await storage.saveSettings({ ...seededSettings, activeBoardId: board.id });
  }

  sp2.succeed(
    `Workspace ready (${memberCount} starter members, ${principleCount} starter principles${
      opts.seed !== false && seededMembers.length > 0 ? ', 1 board' : ''
    }).`,
  );

  // 6. Generate .claude/agents/<slug>.md for each member (so Claude Code can dispatch them)
  if (opts.agents !== false && seededMembers.length > 0) {
    const projectRoot = opts.agentsDir ?? process.cwd();
    const sp3 = spinner(`Writing .claude/agents/ to ${projectRoot}/.claude/agents/...`);
    sp3.start();
    let written = 0;
    let skipped = 0;
    for (const member of seededMembers) {
      const result = emitMemberAgentFile(member, { projectRoot });
      if (result.written) written++;
      else skipped++;
    }
    sp3.succeed(
      `Sub-agents written (${written} new, ${skipped} skipped${
        skipped > 0 ? ' — user-edited files preserved' : ''
      }).`,
    );
  }

  // 7. Bootstrap the Knowledge Wiki (Phase 1.5) — idempotent, never overwrites
  if (opts.wiki !== false) {
    const sp4 = spinner('Bootstrapping wiki/ + raw/ + .manifest.json...');
    sp4.start();
    const result = emitWikiSkeleton({ workspaceRoot: workspace.root });
    const total = result.wrote.length + result.skipped.length;
    sp4.succeed(
      `Knowledge Wiki ready (${result.wrote.length} new, ${result.skipped.length} preserved; ${total} files total).`,
    );
  }

  // 8. Foam recommendation (opt-in via --foam)
  const wikiSettings = (await storage.loadSettings()).knowledgeWiki;
  const wantFoam = opts.foam || (opts.foam !== false && wikiSettings?.recommendFoam && opts.here);
  if (wantFoam) {
    const projectRootForFoam = opts.agentsDir ?? process.cwd();
    const result = emitFoamRecommendation({ projectRoot: projectRootForFoam, force: !!opts.foamOverwrite });
    if (result.action === 'created') {
      process.stdout.write(`${c.ok('✓')} Foam recommended in ${c.bold(result.path)} ${c.hint('— open in VS Code for [[wikilinks]] support')}\n`);
    } else if (result.action === 'merged') {
      process.stdout.write(`${c.ok('✓')} Foam appended to existing ${c.bold(result.path)}\n`);
    } else {
      process.stdout.write(`${c.hint('—')} Foam: ${result.reason}\n`);
    }
  }

  // 9. skill-creator detection (Phase 5 prerequisite)
  const projectRootForSkills = opts.agentsDir ?? process.cwd();
  const resolved = resolveSkillCreator({ projectRoot: projectRootForSkills });
  if (resolved) {
    process.stdout.write(
      `${c.ok('✓')} skill-creator detected ${c.hint('(' + resolved.scope + ' scope: ' + resolved.dir + (resolved.version ? '; v' + resolved.version : '') + ')')}\n`,
    );
  } else if (opts.installSkillCreator) {
    process.stdout.write(`${c.warn('!')} skill-creator skill not found.\n`);
    process.stdout.write(c.hint(skillCreatorInstallHint().split('\n').map((l) => '  ' + l).join('\n')) + '\n');
  } else {
    process.stdout.write(
      `${c.hint('—')} skill-creator skill not found ${c.hint('(install with `aab init --install-skill-creator` when ready to use `aab actions solve`)')}\n`,
    );
  }

  // Next steps
  process.stdout.write('\n' + c.bold('Next steps:') + '\n');
  process.stdout.write(`  ${c.cyan('aab doctor')}                 ${c.hint('— verify everything is wired up')}\n`);
  process.stdout.write(`  ${c.cyan('aab ui')}                     ${c.hint('— open the local web dashboard at http://127.0.0.1:3737 (recommended)')}\n`);
  process.stdout.write(`  ${c.cyan('aab discuss start')} ${c.hint('"What should we focus on this quarter?"')}\n`);
  process.stdout.write(`  ${c.cyan('aab knowledge ingest')} ${c.hint('<path-or-url>  — seed the wiki')}\n`);
  process.stdout.write(`  ${c.cyan('aab settings get')}\n`);
  process.stdout.write('\n');
}

async function chooseWorkspace(opts: InitOptions): Promise<ResolvedWorkspace> {
  const cwd = process.cwd();
  const cwdName = cwd.split(/[\\/]/).pop() ?? 'workspace';
  const id = opts.name ? slugifyWorkspaceId(opts.name) : slugifyWorkspaceId(cwdName);

  if (opts.here) {
    const root = join(cwd, '.aabcli');
    ensure(root);
    return { id: `project-${id}`, root, scope: 'project' };
  }
  if (opts.home || opts.nonInteractive) {
    const root = join(homeRoot(), id);
    ensure(root);
    return { id, root, scope: 'home' };
  }

  const choice = await askSelect('Where should this workspace live?', [
    { name: 'home', message: `Home directory  (~/.aabcli/${id}/)`, hint: 'shared across projects' },
    { name: 'project', message: `Current directory  (./.aabcli/)`, hint: 'travels with this repo' },
  ]);

  if (choice === 'project') {
    const root = join(cwd, '.aabcli');
    ensure(root);
    return { id: `project-${id}`, root, scope: 'project' };
  }
  const root = join(homeRoot(), id);
  ensure(root);
  return { id, root, scope: 'home' };
}

function ensure(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const parent = dirname(root);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}
