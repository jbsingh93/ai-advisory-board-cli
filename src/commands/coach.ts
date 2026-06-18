/**
 * `aab coach` — principle-based decision coach REPL.
 *
 *   aab coach                          start a new session (interactive)
 *   aab coach --resume <id>            resume an existing session
 *   aab coach send <id> "<msg>"        send one message non-interactively
 *   aab coach show [<id>]              list sessions or print one
 *   aab coach delete <id>              remove a session
 */
import { Command } from 'commander';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { askConfirm, askText } from '../ui/prompts.js';
import { spinner } from '../ui/spinner.js';
import { UserError } from '../core/errors.js';
import { nowIso } from '../core/utils.js';
import { coachReply, newDecisionSession } from '../core/coach/decision-coach.js';
import { maybeEnqueueUserInput } from '../core/knowledge/ingest-queue.js';
import { paths } from '../storage/paths.js';
import type { AppSettings, DecisionSession } from '../storage/types.js';

export function registerCoachCommand(program: Command): void {
  const coach = program.command('coach').description('principle-based decision coach (Dalio-style)');

  // Default action (no subcommand) — interactive REPL, either new or resumed.
  coach
    .option('--resume <id>', 'resume an existing decision session')
    .option('--situation <text>', 'situation prompt (for a brand-new session)')
    .option('--title <text>', 'title for a brand-new session')
    .option('--no-stream', 'disable token streaming (useful for testing)')
    .option('--wiki', 'wire the Business/Knowledge Wiki to the coach for this session (reads + ingests)')
    .action(async (opts: { resume?: string; situation?: string; title?: string; stream?: boolean; wiki?: boolean }) => {
      // If the user invoked a subcommand, commander handles it. This action
      // only fires when there's no subcommand.
      const ctx = await openContext(coach);
      try {
        let session: DecisionSession;
        if (opts.resume) {
          const found = await ctx.storage.loadDecisionSessionById(opts.resume);
          if (!found) {
            const all = await ctx.storage.loadDecisionSessions();
            const byShort = all.find((s) => s.id.startsWith(opts.resume!));
            if (!byShort) throw new UserError(`No coach session matches "${opts.resume}"`);
            session = byShort;
          } else {
            session = found;
          }
          process.stdout.write(
            `${c.hint('Resuming session')} ${c.bold(session.id.slice(0, 8))} ${c.hint('(' + session.messages.length + ' messages)\n')}`,
          );
          for (const m of session.messages) renderMessage(m.role, m.content);
        } else {
          const situation = opts.situation ?? (await askText('Describe the decision / situation', { required: true }));
          const title = opts.title ?? '';
          session = newDecisionSession(situation, title || undefined);
          await ctx.storage.saveDecisionSession(session);
          process.stdout.write(`${c.hint('Started new session')} ${c.bold(session.id.slice(0, 8))}\n\n`);
        }

        const settings = await ctx.storage.loadSettings();
        if (opts.wiki && !session.useBusinessWiki) {
          session.useBusinessWiki = true;
          await ctx.storage.updateDecisionSession(session);
        }
        if (session.useBusinessWiki) {
          process.stdout.write(c.hint('📚 Business Wiki is ON for this session.\n'));
        }
        const principles = await ctx.storage.loadPrinciples();
        const activePrincipleCount = principles.filter((pp) => pp.isActive).length;
        process.stdout.write(
          c.hint(`Coach loaded with ${activePrincipleCount} active principle${activePrincipleCount === 1 ? '' : 's'}. Type 'exit' or press Ctrl+C to end.\n\n`),
        );

        // If brand-new session, ask the coach to open the conversation first.
        if (session.messages.length === 0) {
          const sp = spinner('Coach thinking...');
          sp.start();
          try {
            const { session: updated, reply } = await coachReply(
              session, principles, '', settings, coachWikiRunOpts(session, ctx.workspace.root),
            );
            sp.stop();
            session = updated;
            await ctx.storage.updateDecisionSession(session);
            renderMessage(reply.role, reply.content);
          } catch (error) {
            sp.fail(`Coach failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        }

        // REPL loop.
        let keepGoing = true;
        while (keepGoing) {
          const userInput = await askText('you', {});
          const trimmed = userInput.trim();
          if (!trimmed) continue;
          if (/^(exit|quit|bye)$/i.test(trimmed)) {
            keepGoing = false;
            break;
          }
          const sp = spinner('Coach thinking...');
          sp.start();
          try {
            const { session: updated, reply } = await coachReply(
              session, principles, trimmed, settings, coachWikiRunOpts(session, ctx.workspace.root),
            );
            sp.stop();
            session = updated;
            await ctx.storage.updateDecisionSession(session);
            renderMessage(reply.role, reply.content);
            fireCoachIngest(session, settings, ctx.storage, trimmed);
          } catch (error) {
            sp.fail(`Coach failed: ${error instanceof Error ? error.message : String(error)}`);
            // Continue the REPL so the user can retry.
          }
        }
        process.stdout.write(c.hint(`Session ${session.id.slice(0, 8)} saved.\n`));
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // send — one-shot non-interactive turn
  // --------------------------------------------------------------
  coach
    .command('send <sessionId> <message>')
    .description('send one message and print the coach reply (non-interactive)')
    .option('--wiki', 'wire the Business/Knowledge Wiki to the coach (reads + ingests); persists onto the session')
    .action(async (sessionId: string, message: string, sendOpts: { wiki?: boolean }) => {
      const ctx = await openContext(coach);
      try {
        let session = await ctx.storage.loadDecisionSessionById(sessionId);
        if (!session) {
          const all = await ctx.storage.loadDecisionSessions();
          const byShort = all.find((s) => s.id.startsWith(sessionId));
          if (!byShort) throw new UserError(`No coach session matches "${sessionId}"`);
          session = byShort;
        }
        const settings = await ctx.storage.loadSettings();
        if (sendOpts.wiki) {
          session = { ...session, useBusinessWiki: true };
        }
        const principles = await ctx.storage.loadPrinciples();
        const { session: updated, reply } = await coachReply(
          session, principles, message, settings, coachWikiRunOpts(session, ctx.workspace.root),
        );
        await ctx.storage.updateDecisionSession(updated);
        fireCoachIngest(updated, settings, ctx.storage, message);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ session: updated, reply }, null, 2) + '\n');
          return;
        }
        renderMessage(reply.role, reply.content);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // show — list or print one
  // --------------------------------------------------------------
  coach
    .command('show [sessionId]')
    .description('list past sessions; pass a session id (or short id) to print it')
    .action(async (sessionId?: string) => {
      const ctx = await openContext(coach, { lock: false });
      try {
        if (!sessionId) {
          const all = await ctx.storage.loadDecisionSessions();
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ sessions: all }, null, 2) + '\n');
            return;
          }
          if (all.length === 0) {
            process.stdout.write(c.hint('  (no sessions yet — run `aab coach` to start one)\n'));
            return;
          }
          for (const s of all) {
            const ts = new Date(s.updatedAt).toLocaleString();
            const title = s.title || s.situation.slice(0, 60);
            process.stdout.write(
              `  ${c.cyan(s.id.slice(0, 8))} ${c.hint(ts)} ${c.bold(title)} ${c.hint(`(${s.messages.length} msgs · ${s.status})`)}\n`,
            );
          }
          return;
        }

        let session = await ctx.storage.loadDecisionSessionById(sessionId);
        if (!session) {
          const all = await ctx.storage.loadDecisionSessions();
          const byShort = all.find((s) => s.id.startsWith(sessionId));
          if (!byShort) throw new UserError(`No coach session matches "${sessionId}"`);
          session = byShort;
        }
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ session }, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `\n${c.bold(session.title ?? 'Decision session')} ${c.hint('· ' + session.id.slice(0, 8))}\n`,
        );
        process.stdout.write(`  ${c.hint('situation:')} ${session.situation}\n`);
        process.stdout.write(`  ${c.hint('status:')} ${session.status}\n`);
        process.stdout.write(`  ${c.hint('messages:')} ${session.messages.length}\n\n`);
        for (const m of session.messages) renderMessage(m.role, m.content);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // delete
  // --------------------------------------------------------------
  coach
    .command('delete <sessionId>')
    .description('delete a coach session')
    .option('--yes', 'skip confirmation prompt')
    .action(async (sessionId: string, opts: { yes?: boolean }) => {
      const ctx = await openContext(coach);
      try {
        let session = await ctx.storage.loadDecisionSessionById(sessionId);
        if (!session) {
          const all = await ctx.storage.loadDecisionSessions();
          const byShort = all.find((s) => s.id.startsWith(sessionId));
          if (!byShort) throw new UserError(`No coach session matches "${sessionId}"`);
          session = byShort;
        }
        if (!opts.yes) {
          const ok = await askConfirm(
            `Delete session "${session.title ?? session.situation.slice(0, 40)}"?`,
            false,
          );
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }
        await ctx.storage.deleteDecisionSession(session.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ deleted: session.id }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Deleted session ${session.id.slice(0, 8)}\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // reflect / decided — set status (light-touch session lifecycle)
  // --------------------------------------------------------------
  coach
    .command('decide <sessionId> <decision>')
    .description('record the decision the user made and flip status to "decided"')
    .action(async (sessionId: string, decision: string) => {
      const ctx = await openContext(coach);
      try {
        const session = await ctx.storage.loadDecisionSessionById(sessionId);
        if (!session) throw new UserError(`No coach session matches "${sessionId}"`);
        const updated: DecisionSession = {
          ...session,
          decision,
          status: 'decided',
          updatedAt: nowIso(),
        };
        await ctx.storage.updateDecisionSession(updated);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ session: updated }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Decision recorded for ${updated.id.slice(0, 8)}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

/** Read-side wiki wiring for a coach turn — driven by the per-session toggle. */
function coachWikiRunOpts(
  session: DecisionSession,
  root: string,
): { useWiki: boolean; workspaceRoot: string; wikiDir: string } {
  return { useWiki: !!session.useBusinessWiki, workspaceRoot: root, wikiDir: paths(root).wiki };
}

/**
 * Write side (bidirectional): when the wiki is ON for this session, ingest the
 * user's own words back into the wiki. Fire-and-forget — the queue gates +
 * never blocks; `closeContext` drains it before the CLI exits.
 */
function fireCoachIngest(
  session: DecisionSession,
  settings: AppSettings,
  storage: CommandContextStorage,
  text: string,
): void {
  if (!session.useBusinessWiki) return;
  const userMsg = [...session.messages].reverse().find((m) => m.role === 'user');
  maybeEnqueueUserInput({
    text,
    kind: 'coach_message',
    settings,
    storage,
    coachSessionId: session.id,
    onResult: async (result) => {
      if (!userMsg) return;
      const r = (result ?? {}) as { producedPages?: unknown; updatedPages?: unknown; notes?: unknown };
      const fresh = await storage.loadDecisionSessionById(session.id);
      const msg = fresh?.messages.find((m) => m.id === userMsg.id);
      if (!fresh || !msg) return;
      msg.wikiIngest = {
        producedPages: Array.isArray(r.producedPages) ? (r.producedPages as string[]) : [],
        updatedPages: Array.isArray(r.updatedPages) ? (r.updatedPages as string[]) : [],
        notes: typeof r.notes === 'string' ? r.notes : undefined,
      };
      await storage.updateDecisionSession({ ...fresh, updatedAt: nowIso() });
    },
  });
}

type CommandContextStorage = Awaited<ReturnType<typeof openContext>>['storage'];

function renderMessage(role: 'user' | 'assistant', content: string): void {
  if (role === 'user') {
    process.stdout.write(`${c.cyan('you:')}\n${content}\n\n`);
  } else {
    process.stdout.write(`${c.green('coach:')}\n${content}\n\n`);
  }
}
