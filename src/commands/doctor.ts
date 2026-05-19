/**
 * `aab doctor` — non-destructive diagnostics.
 *
 * Phase 0 (claude-CLI-native) checks:
 *   - `claude` CLI on PATH and runs
 *   - Claude Code session detection
 *   - Workspace root + paths writable
 *   - Storage version recognized
 *   - Members + principles seeded
 *   - .claude/agents/<member>.md present for each active member
 */
import { Command } from 'commander';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { closeContext, openContext } from './_context.js';
import { c, brand } from '../ui/colors.js';
import { detectClaudeCode } from '../env/detect-claude-code.js';
import { detectClaudeCli } from '../llm/claude-code-runner.js';
import { paths } from '../storage/paths.js';
import { memberAgentPath, memberAgentSlug } from '../agents/emit-member-agent.js';
import { foamAlreadyRecommended } from '../core/knowledge/foam.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('run non-destructive diagnostics on the current workspace')
    .option('--agents-dir <path>', 'where .claude/agents/ should live (default: cwd)')
    .action(async (cmdOpts: { agentsDir?: string }) => {
      const ctx = await openContext(program, { lock: false });
      const checks: CheckResult[] = [];

      try {
        // claude CLI
        const cli = await detectClaudeCli();
        checks.push({
          label: '`claude` CLI',
          ok: cli.installed,
          detail: cli.installed
            ? `installed${cli.version ? ' (v' + cli.version + ')' : ''}`
            : (cli.error ?? 'not found on PATH'),
        });

        // Claude Code session (informational)
        const cc = detectClaudeCode();
        checks.push({
          label: 'Claude Code session',
          ok: true,
          detail: cc.detected
            ? `detected${cc.version ? ' (v' + cc.version + ')' : ''}`
            : 'not detected (you can still run from any shell)',
        });

        // Workspace
        checks.push({
          label: 'Workspace',
          ok: existsSync(ctx.workspace.root),
          detail: `${ctx.workspace.id} (${ctx.workspace.scope}: ${ctx.workspace.root})`,
        });

        // Writable
        try {
          accessSync(ctx.workspace.root, constants.W_OK);
          checks.push({ label: 'Workspace writable', ok: true });
        } catch {
          checks.push({ label: 'Workspace writable', ok: false, detail: 'No write access' });
        }

        // Storage version
        const versionFile = paths(ctx.workspace.root).versionFile;
        const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '';
        checks.push({
          label: 'Storage version',
          ok: version === '1',
          detail: version ? `v${version}` : '(no .version file — run `aab init`)',
        });

        // Seeds
        const members = await ctx.storage.loadBoardMembers();
        checks.push({
          label: 'Board members',
          ok: members.length > 0,
          detail: members.length === 0 ? 'none — run `aab init`' : `${members.length} member(s)`,
        });

        const principles = await ctx.storage.loadPrinciples();
        checks.push({
          label: 'Principles',
          ok: principles.length > 0,
          detail: principles.length === 0 ? 'none — run `aab init`' : `${principles.length} principle(s)`,
        });

        // .claude/agents/ files for active members
        const projectRoot = cmdOpts.agentsDir ?? process.cwd();
        const activeMembers = members.filter((m) => m.isActive);
        const missing: string[] = [];
        for (const m of activeMembers) {
          const slug = memberAgentSlug(m.name);
          if (!existsSync(memberAgentPath(slug, projectRoot))) missing.push(slug);
        }
        checks.push({
          label: '.claude/agents/<member>.md',
          ok: activeMembers.length === 0 || missing.length === 0,
          detail:
            activeMembers.length === 0
              ? 'no active members'
              : missing.length === 0
                ? `${activeMembers.length} agent file(s) at ${projectRoot}\\.claude\\agents\\`
                : `missing: ${missing.join(', ')} — run \`aab members sync-agents\``,
        });

        // Lock file (informational)
        checks.push({
          label: 'Workspace lock',
          ok: true,
          detail: existsSync(paths(ctx.workspace.root).lockFile)
            ? 'present'
            : 'will be created on first write',
        });

        // Knowledge Wiki (Phase 1.5)
        const wikiPaths = paths(ctx.workspace.root);
        const wikiPresent = existsSync(wikiPaths.wiki) && existsSync(wikiPaths.wikiKnowledge);
        checks.push({
          label: 'Knowledge Wiki',
          ok: true,
          detail: wikiPresent
            ? `present at ${wikiPaths.wiki}`
            : 're-run `aab init` to bootstrap wiki/ + raw/ + .manifest.json',
        });

        // Foam recommendation (info-only — never fails doctor)
        const settings = await ctx.storage.loadSettings();
        if (wikiPresent && settings.knowledgeWiki?.recommendFoam !== false) {
          const foam = foamAlreadyRecommended(projectRoot);
          checks.push({
            label: 'Foam (VS Code)',
            ok: true,
            detail: foam
              ? 'recommended in .vscode/extensions.json'
              : 'consider `aab init --foam` for [[wikilinks]] support in VS Code',
          });
        }
      } finally {
        await closeContext(ctx);
      }

      // Render
      if (ctx.json) {
        process.stdout.write(JSON.stringify({ checks }, null, 2) + '\n');
        if (checks.some((c) => !c.ok)) process.exit(1);
        return;
      }

      process.stdout.write(`\n${brand()}  ${c.hint('— doctor')}\n\n`);
      const labelWidth = Math.max(...checks.map((c) => c.label.length));
      for (const ck of checks) {
        const mark = ck.ok ? c.ok('✓') : c.err('✗');
        const lbl = ck.label.padEnd(labelWidth);
        const det = ck.detail ? `  ${c.hint('— ' + ck.detail)}` : '';
        process.stdout.write(`  ${mark}  ${c.bold(lbl)}${det}\n`);
      }
      const allOk = checks.every((c) => c.ok);
      process.stdout.write(`\n${allOk ? c.ok('All good.') : c.warn('Some checks failed.')}\n`);
      if (!allOk) process.exit(1);
    });
}
