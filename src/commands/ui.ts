/**
 * `aab ui` — start the local web dashboard and open the browser.
 *
 * Usage:
 *   aab ui                              # default port 3737, opens browser
 *   aab ui --port 4000
 *   aab ui --no-open                    # don't auto-open browser
 *   aab ui --bind 0.0.0.0                # listen on all interfaces
 */
import { Command } from 'commander';
import open from 'open';
import { closeContext, openContext } from './_context.js';
import { c, brand } from '../ui/colors.js';
import { startUiServer } from '../gui/server.js';

export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .description('start the local web dashboard (messaging-app style)')
    .option('--port <n>', 'port to listen on', (v) => Number(v), 3737)
    .option('--bind <host>', 'host/interface to bind', '127.0.0.1')
    .option('--no-open', 'do not open the browser automatically')
    .option('--agents-dir <path>', 'project root containing .claude/agents/ (default: cwd)')
    .action(async (opts: { port: number; bind: string; open: boolean; agentsDir?: string }) => {
      const ctx = await openContext(program, { lock: false });
      try {
        const handle = await startUiServer({
          storage: ctx.storage,
          port: opts.port,
          host: opts.bind,
          projectRoot: opts.agentsDir ?? process.cwd(),
        });

        process.stdout.write(`\n${brand()}  ${c.hint('· UI ready')}\n`);
        process.stdout.write(`  ${c.cyan(handle.url)}\n`);
        process.stdout.write(`  ${c.hint('workspace:')} ${ctx.workspace.id}\n`);
        process.stdout.write(`  ${c.hint('press Ctrl+C to stop')}\n\n`);

        if (opts.open !== false) {
          try {
            await open(handle.url);
          } catch {
            // best-effort; user can navigate manually
          }
        }

        // Keep the process alive until Ctrl+C
        await new Promise<void>((resolve) => {
          const onSignal = async () => {
            process.stdout.write(c.hint('\nshutting down…\n'));
            await handle.close();
            resolve();
          };
          process.once('SIGINT', onSignal);
          process.once('SIGTERM', onSignal);
        });
      } finally {
        await closeContext(ctx);
      }
    });
}
