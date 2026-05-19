/**
 * `aab members` — full Phase 2 surface.
 *
 *   aab members list                    flat or --json
 *   aab members show <name|id>          full persona / voice / tools
 *   aab members add                     interactive (name/title/expertise/persona OR --enhance <type>)
 *   aab members edit <id|name>          interactive field-by-field edit
 *   aab members enhance <id|name>       AI-fill persona + voiceGuide via claude -p
 *   aab members delete <id|name>        also removes .claude/agents/<slug>.md
 *   aab members sync-agents             regenerate .claude/agents/*.md (preserves user-edited)
 *   aab members tools <id|name>         per-member tool allowlist editor
 *   aab members regenerate-voice <id>   voice-guide-only refresh
 */
import { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { closeContext, openContext } from './_context.js';
import { c, memberColor } from '../ui/colors.js';
import { askConfirm, askMultiSelect, askSelect, askText } from '../ui/prompts.js';
import { spinner } from '../ui/spinner.js';
import {
  emitMemberAgentFile,
  memberAgentPath,
  memberAgentSlug,
} from '../agents/emit-member-agent.js';
import { generateUUID, nowIso } from '../core/utils.js';
import { UserError } from '../core/errors.js';
import { enhancePersona, type EnhancementType } from '../core/members/ai-enhancer.js';
import { generateVoiceGuide } from '../core/members/voice-guide.js';
import type { AdvisoryBoardMember } from '../storage/types.js';

const DEFAULT_TOOL_PALETTE = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'] as const;

export function registerMembersCommand(program: Command): void {
  const m = program.command('members').description('manage advisory-board members');

  // --------------------------------------------------------------
  // list
  // --------------------------------------------------------------
  m.command('list')
    .description('list all board members')
    .option('--active', 'only show active members')
    .option('--inactive', 'only show inactive members')
    .action(async (opts: { active?: boolean; inactive?: boolean }) => {
      const ctx = await openContext(m, { lock: false });
      try {
        let members = await ctx.storage.loadBoardMembers();
        if (opts.active) members = members.filter((mb) => mb.isActive);
        if (opts.inactive) members = members.filter((mb) => !mb.isActive);

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ members }, null, 2) + '\n');
          return;
        }
        if (members.length === 0) {
          process.stdout.write(c.hint('  (no members — run `aab init` to seed starters)\n'));
          return;
        }
        for (const member of members) {
          const status = member.isActive ? c.ok('active') : c.hint('inactive');
          const color = memberColor(member.name);
          process.stdout.write(
            `  ${color(member.name)} ${c.hint('· ' + member.title)} ${status}\n`,
          );
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // show
  // --------------------------------------------------------------
  m.command('show <idOrName>')
    .description('show full persona, voice guide, and tool overrides')
    .action(async (idOrName: string) => {
      const ctx = await openContext(m, { lock: false });
      try {
        const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ member }, null, 2) + '\n');
          return;
        }
        const color = memberColor(member.name);
        process.stdout.write(`\n${color(c.bold(member.name))} ${c.hint('· ' + member.title)}\n`);
        process.stdout.write(`  ${c.hint('id:')} ${member.id}\n`);
        process.stdout.write(`  ${c.hint('status:')} ${member.isActive ? c.ok('active') : c.hint('inactive')}\n`);
        process.stdout.write(`  ${c.hint('expertise:')} ${member.expertise.join(', ') || '(none)'}\n`);
        if (member.allowedTools && member.allowedTools.length > 0) {
          process.stdout.write(`  ${c.hint('tools (allow):')} ${member.allowedTools.join(', ')}\n`);
        }
        if (member.disallowedTools && member.disallowedTools.length > 0) {
          process.stdout.write(`  ${c.hint('tools (deny):')} ${member.disallowedTools.join(', ')}\n`);
        }
        process.stdout.write(`\n${c.bold('Persona')}\n${member.persona}\n`);
        if (member.voiceGuide) {
          process.stdout.write(`\n${c.bold('Voice guide')}\n${member.voiceGuide}\n`);
        }
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // add
  // --------------------------------------------------------------
  m.command('add')
    .description('add a new board member (interactive; --enhance for AI persona)')
    .option('--name <name>', 'member name')
    .option('--title <title>', 'role / title')
    .option('--expertise <list>', 'comma-separated expertise areas')
    .option('--persona <text>', 'persona text (or omit and use --enhance)')
    .option('--voice-guide <text>', 'voice guide text')
    .option(
      '--enhance <type>',
      'AI-fill persona + voiceGuide. type: famous | expert | non-famous',
    )
    .option('--inactive', 'create the member as inactive')
    .action(
      async (opts: {
        name?: string;
        title?: string;
        expertise?: string;
        persona?: string;
        voiceGuide?: string;
        enhance?: string;
        inactive?: boolean;
      }) => {
        const ctx = await openContext(m);
        try {
          const name = opts.name ?? (await askText('Name', { required: true }));
          const title = opts.title ?? (await askText('Title / role', { required: true }));
          const expertiseRaw =
            opts.expertise ?? (await askText('Expertise (comma-separated)'));
          const expertise = expertiseRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

          let persona = opts.persona;
          let voiceGuide = opts.voiceGuide;
          if (opts.enhance) {
            const type = normalizeEnhanceType(opts.enhance);
            const settings = await ctx.storage.loadSettings();
            const sp = spinner(`Enhancing persona (${type})...`);
            sp.start();
            try {
              const result = await enhancePersona(
                { name, title, expertise, type },
                settings,
                { currentPersona: persona },
              );
              persona = result.persona;
              voiceGuide = voiceGuide ?? result.voiceGuide;
              sp.succeed(`Enhanced persona (${persona.length} chars).`);
            } catch (error) {
              sp.fail(`Enhancement failed: ${error instanceof Error ? error.message : String(error)}`);
              if (!persona) {
                throw new UserError(
                  'Persona could not be generated and none was supplied — pass --persona or fix the enhancement error.',
                );
              }
            }
          }

          if (!persona) {
            persona = await askText('Persona (multi-line OK; press enter when done)', {
              required: true,
            });
          }

          const now = nowIso();
          const member: AdvisoryBoardMember = {
            id: generateUUID(),
            name,
            title,
            expertise,
            persona,
            voiceGuide: voiceGuide || undefined,
            isActive: !opts.inactive,
            createdAt: now,
            updatedAt: now,
          };
          await ctx.storage.saveBoardMember(member);

          // Emit the .claude/agents/<slug>.md file.
          const result = emitMemberAgentFile(member, { projectRoot: process.cwd() });

          if (ctx.json) {
            process.stdout.write(
              JSON.stringify({ member, agentFile: result }, null, 2) + '\n',
            );
            return;
          }
          process.stdout.write(
            `${c.ok('✓')} Added member ${memberColor(name)(name)} (id ${member.id.slice(0, 8)})\n`,
          );
          if (result.written) {
            process.stdout.write(c.hint(`  → wrote ${result.path}\n`));
          } else {
            process.stdout.write(c.hint(`  — agent file skipped: ${result.reason}\n`));
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // edit
  // --------------------------------------------------------------
  m.command('edit <idOrName>')
    .description('interactively edit a member (field-by-field)')
    .option('--active <bool>', 'set active flag (true|false)')
    .option('--name <name>')
    .option('--title <title>')
    .option('--expertise <list>')
    .option('--persona <text>')
    .option('--voice-guide <text>')
    .action(
      async (
        idOrName: string,
        opts: {
          active?: string;
          name?: string;
          title?: string;
          expertise?: string;
          persona?: string;
          voiceGuide?: string;
        },
      ) => {
        const ctx = await openContext(m);
        try {
          const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);

          // Apply flag-supplied edits first (non-interactive path), then prompt
          // interactively for anything that wasn't overridden when the user
          // didn't pass any flags at all.
          const flagsTouched =
            !!opts.name ||
            !!opts.title ||
            !!opts.expertise ||
            !!opts.persona ||
            !!opts.voiceGuide ||
            !!opts.active;

          let next: AdvisoryBoardMember = { ...member };
          if (opts.name) next.name = opts.name;
          if (opts.title) next.title = opts.title;
          if (opts.expertise) {
            next.expertise = opts.expertise.split(',').map((s) => s.trim()).filter(Boolean);
          }
          if (opts.persona) next.persona = opts.persona;
          if (opts.voiceGuide) next.voiceGuide = opts.voiceGuide;
          if (opts.active) next.isActive = opts.active === 'true' || opts.active === '1';

          if (!flagsTouched) {
            next.name = await askText('Name', { initial: next.name, required: true });
            next.title = await askText('Title', { initial: next.title, required: true });
            const expertiseRaw = await askText('Expertise (comma-separated)', {
              initial: next.expertise.join(', '),
            });
            next.expertise = expertiseRaw.split(',').map((s) => s.trim()).filter(Boolean);
            next.persona = await askText('Persona', { initial: next.persona, required: true });
            next.voiceGuide = await askText('Voice guide', { initial: next.voiceGuide ?? '' });
            next.isActive = await askConfirm('Active?', next.isActive);
          }
          next.updatedAt = nowIso();

          await ctx.storage.updateBoardMember(next);

          // Regenerate the .claude/agents/<slug>.md file (renames if name changed).
          if (next.name !== member.name) {
            const oldPath = memberAgentPath(memberAgentSlug(member.name), process.cwd());
            if (existsSync(oldPath)) unlinkSync(oldPath);
          }
          const agent = emitMemberAgentFile(next, { projectRoot: process.cwd() });

          if (ctx.json) {
            process.stdout.write(JSON.stringify({ member: next, agentFile: agent }, null, 2) + '\n');
            return;
          }
          process.stdout.write(`${c.ok('✓')} Updated ${memberColor(next.name)(next.name)}\n`);
          if (agent.written) process.stdout.write(c.hint(`  → wrote ${agent.path}\n`));
          else process.stdout.write(c.hint(`  — agent file skipped: ${agent.reason}\n`));
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // enhance
  // --------------------------------------------------------------
  m.command('enhance <idOrName>')
    .description('AI-fill persona + voiceGuide via claude -p')
    .option(
      '--type <type>',
      'famous | expert | non-famous (default: non-famous)',
      'non-famous',
    )
    .option('--keep-voice', 'do not overwrite existing voiceGuide')
    .action(async (idOrName: string, opts: { type?: string; keepVoice?: boolean }) => {
      const ctx = await openContext(m);
      try {
        const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);
        const type = normalizeEnhanceType(opts.type ?? 'non-famous');
        const settings = await ctx.storage.loadSettings();
        const sp = spinner(`Enhancing ${member.name} (${type})...`);
        sp.start();
        try {
          const result = await enhancePersona(
            {
              name: member.name,
              title: member.title,
              expertise: member.expertise,
              type,
            },
            settings,
            { currentPersona: member.persona },
          );
          sp.succeed(`Enhanced (${result.persona.length} chars).`);

          const next: AdvisoryBoardMember = {
            ...member,
            persona: result.persona,
            voiceGuide: opts.keepVoice
              ? member.voiceGuide
              : result.voiceGuide || member.voiceGuide,
            updatedAt: nowIso(),
          };
          await ctx.storage.updateBoardMember(next);
          const agent = emitMemberAgentFile(next, { projectRoot: process.cwd() });

          if (ctx.json) {
            process.stdout.write(JSON.stringify({ member: next, agentFile: agent }, null, 2) + '\n');
            return;
          }
          process.stdout.write(`${c.ok('✓')} Persona refreshed for ${memberColor(next.name)(next.name)}\n`);
          if (agent.written) process.stdout.write(c.hint(`  → wrote ${agent.path}\n`));
        } catch (error) {
          sp.fail(`Enhancement failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // delete
  // --------------------------------------------------------------
  m.command('delete <idOrName>')
    .description('delete a member and remove its .claude/agents/<slug>.md')
    .option('--yes', 'skip confirmation prompt')
    .action(async (idOrName: string, opts: { yes?: boolean }) => {
      const ctx = await openContext(m);
      try {
        const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);
        if (!opts.yes) {
          const ok = await askConfirm(`Delete ${member.name}? This cannot be undone.`, false);
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }
        await ctx.storage.deleteBoardMember(member.id);
        const path = memberAgentPath(memberAgentSlug(member.name), process.cwd());
        let removedAgent = false;
        if (existsSync(path)) {
          try {
            unlinkSync(path);
            removedAgent = true;
          } catch {
            /* ignore — show warning instead */
          }
        }
        if (ctx.json) {
          process.stdout.write(
            JSON.stringify({ deleted: { id: member.id, name: member.name }, removedAgent }, null, 2) + '\n',
          );
          return;
        }
        process.stdout.write(`${c.ok('✓')} Deleted ${member.name}\n`);
        if (removedAgent) process.stdout.write(c.hint(`  → removed ${path}\n`));
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // sync-agents (kept from Phase 1.5)
  // --------------------------------------------------------------
  m.command('sync-agents')
    .description('regenerate .claude/agents/<slug>.md for every active member (preserves user-edited files)')
    .option('--agents-dir <path>', 'where .claude/agents/ should live (default: cwd)')
    .option('--all', 'include inactive members too')
    .action(async (opts: { agentsDir?: string; all?: boolean }) => {
      const ctx = await openContext(m);
      try {
        const members = await ctx.storage.loadBoardMembers();
        const projectRoot = opts.agentsDir ?? process.cwd();
        let written = 0;
        let skipped = 0;
        const skippedDetail: string[] = [];
        for (const member of members) {
          if (!opts.all && !member.isActive) continue;
          const slug = memberAgentSlug(member.name);
          const path = memberAgentPath(slug, projectRoot);
          const result = emitMemberAgentFile(member, { projectRoot });
          if (result.written) {
            written++;
          } else {
            skipped++;
            skippedDetail.push(`${slug} (${result.reason ?? 'unknown'})`);
          }
          if (!ctx.json) {
            process.stdout.write(`  ${result.written ? c.ok('✓') : c.warn('—')} ${slug} ${c.hint(path)}\n`);
          }
        }
        if (ctx.json) {
          process.stdout.write(
            JSON.stringify({ written, skipped, skippedDetail, total: members.length }, null, 2) + '\n',
          );
          return;
        }
        process.stdout.write(`\n${c.ok('✓')} sync complete: ${written} written, ${skipped} skipped\n`);
        if (skippedDetail.length > 0) {
          process.stdout.write(c.hint(`  ${skippedDetail.join('; ')}\n`));
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // tools — per-member allowlist editor
  // --------------------------------------------------------------
  m.command('tools <idOrName>')
    .description('edit per-member tool allowlist (overrides workspace default)')
    .option('--allow <list>', 'comma-separated allowlist; empty string clears the override')
    .option('--deny <list>', 'comma-separated denylist; empty string clears the override')
    .option('--reset', 'clear both allow and deny overrides (use workspace default)')
    .action(
      async (
        idOrName: string,
        opts: { allow?: string; deny?: string; reset?: boolean },
      ) => {
        const ctx = await openContext(m);
        try {
          const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);
          let allowed = member.allowedTools;
          let denied = member.disallowedTools;

          if (opts.reset) {
            allowed = undefined;
            denied = undefined;
          } else if (opts.allow !== undefined || opts.deny !== undefined) {
            if (opts.allow !== undefined) {
              const list = parseToolList(opts.allow);
              allowed = list.length === 0 ? undefined : list;
            }
            if (opts.deny !== undefined) {
              const list = parseToolList(opts.deny);
              denied = list.length === 0 ? undefined : list;
            }
          } else {
            const current = new Set(member.allowedTools ?? DEFAULT_TOOL_PALETTE);
            const choices = DEFAULT_TOOL_PALETTE.map((tool) => ({
              name: tool,
              message: tool,
              selected: current.has(tool),
            }));
            const picked = await askMultiSelect<string>('Allowed tools for this member', choices);
            allowed = picked.length === 0 ? undefined : picked;
          }

          const next: AdvisoryBoardMember = {
            ...member,
            allowedTools: allowed,
            disallowedTools: denied,
            updatedAt: nowIso(),
          };
          await ctx.storage.updateBoardMember(next);
          const agent = emitMemberAgentFile(next, { projectRoot: process.cwd() });
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ member: next, agentFile: agent }, null, 2) + '\n');
            return;
          }
          process.stdout.write(
            `${c.ok('✓')} Tools updated for ${memberColor(next.name)(next.name)} — allow: [${(allowed ?? DEFAULT_TOOL_PALETTE).join(', ')}]\n`,
          );
          if (agent.written) process.stdout.write(c.hint(`  → wrote ${agent.path}\n`));
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // regenerate-voice
  // --------------------------------------------------------------
  m.command('regenerate-voice <idOrName>')
    .description('voice-guide-only refresh via the fast model')
    .option('--keep-old', 'show a preview and ask before overwriting')
    .action(async (idOrName: string, opts: { keepOld?: boolean }) => {
      const ctx = await openContext(m);
      try {
        const member = await resolveMember(ctx.storage.loadBoardMembers(), idOrName);
        const settings = await ctx.storage.loadSettings();
        const sp = spinner(`Regenerating voice guide for ${member.name}...`);
        sp.start();
        const result = await generateVoiceGuide(member, settings);
        if (result.fellBack) {
          sp.warn(`Fell back to hardcoded voice guide: ${result.error ?? 'unknown'}`);
        } else {
          sp.succeed(`Voice guide refreshed (${result.voiceGuide.length} chars).`);
        }

        if (opts.keepOld && member.voiceGuide) {
          process.stdout.write(`\n${c.hint('Old:')} ${member.voiceGuide}\n`);
          process.stdout.write(`\n${c.hint('New:')} ${result.voiceGuide}\n`);
          const ok = await askConfirm('Overwrite?', true);
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }

        const next: AdvisoryBoardMember = {
          ...member,
          voiceGuide: result.voiceGuide,
          updatedAt: nowIso(),
        };
        await ctx.storage.updateBoardMember(next);
        const agent = emitMemberAgentFile(next, { projectRoot: process.cwd() });
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ member: next, fellBack: result.fellBack, agentFile: agent }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Voice guide saved for ${memberColor(next.name)(next.name)}\n`);
        if (agent.written) process.stdout.write(c.hint(`  → wrote ${agent.path}\n`));
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function resolveMember(
  loader: Promise<AdvisoryBoardMember[]>,
  idOrName: string,
): Promise<AdvisoryBoardMember> {
  const members = await loader;
  const lower = idOrName.toLowerCase();
  const byId = members.find((m) => m.id === idOrName);
  if (byId) return byId;
  const byShortId = members.find((m) => m.id.startsWith(idOrName) && idOrName.length >= 4);
  if (byShortId) return byShortId;
  const byName = members.find((m) => m.name.toLowerCase() === lower);
  if (byName) return byName;
  const byPartial = members.filter((m) => m.name.toLowerCase().includes(lower));
  if (byPartial.length === 1 && byPartial[0]) return byPartial[0];
  if (byPartial.length > 1) {
    throw new UserError(
      `Ambiguous member: "${idOrName}" matches ${byPartial.map((m) => m.name).join(', ')}`,
      'Use the full name or member id.',
    );
  }
  throw new UserError(
    `No member matches "${idOrName}"`,
    'Run `aab members list` to see available members.',
  );
}

function normalizeEnhanceType(input: string): EnhancementType {
  const v = input.toLowerCase().trim();
  if (v === 'famous' || v === 'famous_person' || v === 'famous-person') return 'famous';
  if (v === 'expert' || v === 'top-expert' || v === 'top_expert') return 'expert';
  if (v === 'non-famous' || v === 'non_famous' || v === 'practitioner') return 'non-famous';
  throw new UserError(
    `Unknown enhance type "${input}"`,
    'Use one of: famous | expert | non-famous.',
  );
}

function parseToolList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
