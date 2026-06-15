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
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeContext, openContext } from './_context.js';
import { c, brand } from '../ui/colors.js';
import { detectClaudeCode } from '../env/detect-claude-code.js';
import { detectClaudeCli } from '../llm/claude-code-runner.js';
import { paths } from '../storage/paths.js';
import { memberAgentPath, memberAgentSlug } from '../agents/emit-member-agent.js';
import { foamAlreadyRecommended } from '../core/knowledge/foam.js';
import { resolveSkillCreator } from '../core/skill/resolve-skill-creator.js';
import { quickPcScanProbe } from '../core/skill/recon/pc-scan.js';
import { probeWebReachability } from '../core/skill/recon/web-probe.js';
import { checkForUpdate, UPGRADE_COMMAND } from '../core/update-check.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
                ? `${activeMembers.length} agent file(s) at ${join(projectRoot, '.claude', 'agents')}`
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

        // Wiki index size — a huge index.md is the #1 cause of member agents
        // burning their tool budget trying to read it. Flag it loudly.
        if (wikiPresent && existsSync(wikiPaths.wikiIndex)) {
          const settingsForWiki = await ctx.storage.loadSettings();
          const warnBytes = settingsForWiki.knowledgeWiki?.indexSizeWarnBytes ?? 200 * 1024;
          const indexBytes = statSync(wikiPaths.wikiIndex).size;
          const oversized = indexBytes > warnBytes;
          const catalogPresent = existsSync(wikiPaths.wikiCatalog);
          checks.push({
            label: 'Wiki index size',
            ok: !oversized,
            detail: oversized
              ? `index.md is ${fmtBytes(indexBytes)} (> ${fmtBytes(warnBytes)}) — agents must not Read it directly. Run \`aab knowledge lint\` and rely on compact-catalog retrieval (${catalogPresent ? 'catalog present' : 'catalog MISSING — run `aab knowledge lint`'}).`
              : `${fmtBytes(indexBytes)}${catalogPresent ? ' · compact catalog present' : ''}`,
          });
        }

        // skill-creator (Phase 5 prerequisite — info-level unless solve is attempted)
        const skillCreator = resolveSkillCreator({ projectRoot });
        checks.push({
          label: 'skill-creator skill',
          ok: true,
          detail: skillCreator
            ? `installed (${skillCreator.scope} scope${skillCreator.version ? '; v' + skillCreator.version : ''})`
            : 'not installed — run `aab init --install-skill-creator` before `aab actions solve`',
        });

        // PC scan probe — fast, deterministic, never hits network.
        const pcProbe = quickPcScanProbe();
        checks.push({
          label: 'PC scan probe',
          ok: pcProbe.ok,
          detail: pcProbe.ok
            ? `${pcProbe.platform} — ${pcProbe.cliTools} CLI tool(s), ${pcProbe.mcpServers} MCP server(s), ${pcProbe.skills} skill(s), ${pcProbe.envVarMatches} env var(s) flagged`
            : pcProbe.error ?? 'unknown error',
        });

        // Web reachability probe — quick HEAD against anthropic.com; ≤1.5s budget.
        const web = await probeWebReachability({ timeoutMs: 1500 });
        checks.push({
          label: 'Web reachability',
          ok: true,
          detail: web.reachable
            ? `${web.host} reachable (${web.latencyMs}ms)`
            : `${web.host}: ${web.reason ?? 'unreachable'} — web recon will be degraded`,
        });

        // Update check — info-only, never fails doctor. Queries the npm
        // registry (≤1.5s) and falls back to the cached result when offline.
        const update = await checkForUpdate({ timeoutMs: 1500 });
        checks.push({
          label: 'CLI version',
          ok: true,
          detail: update.updateAvailable
            ? `v${update.current} — update available (v${update.latest}); run \`${UPGRADE_COMMAND}\``
            : update.latest
              ? `v${update.current} (latest)`
              : `v${update.current} — ${update.error ?? 'update check skipped'}`,
        });

        // Playwright MCP (UI test surface) — Phase 6.6 prerequisites.
        // `.mcp.json` exists but `node_modules/@playwright/mcp/cli.js` does
        // not → teammate forgot `npm install`. Warning, not failure.
        const mcpConfig = join(projectRoot, '.mcp.json');
        const mcpCli = join(projectRoot, 'node_modules', '@playwright', 'mcp', 'cli.js');
        if (existsSync(mcpConfig)) {
          checks.push({
            label: 'Playwright MCP install',
            ok: existsSync(mcpCli),
            detail: existsSync(mcpCli)
              ? '@playwright/mcp installed'
              : '`.mcp.json` present but `node_modules/@playwright/mcp/cli.js` missing — run `npm install`',
          });

          // Browser binaries cache check — only relevant if @playwright/mcp
          // is installed. Empty `~/.cache/ms-playwright/` → teammate forgot
          // `npx playwright install`.
          if (existsSync(mcpCli)) {
            const cacheDir =
              process.platform === 'win32'
                ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
                : process.platform === 'darwin'
                  ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
                  : join(homedir(), '.cache', 'ms-playwright');
            let browsersOk = false;
            try {
              if (existsSync(cacheDir) && statSync(cacheDir).isDirectory()) {
                browsersOk = readdirSync(cacheDir).length > 0;
              }
            } catch {
              browsersOk = false;
            }
            checks.push({
              label: 'Playwright browsers',
              ok: browsersOk,
              detail: browsersOk
                ? `cached at ${cacheDir}`
                : `${cacheDir} is empty — run \`npx playwright install\` (≈500MB)`,
            });
          }
        }

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
