/**
 * `aab workspace list|new|switch|delete`
 *
 * Lightweight workspace management. The active workspace pointer lives at
 * ~/.aabcli/.active. Project-mounted workspaces (./.aabcli) are auto-detected
 * by the path resolver and don't need switching.
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { c, brand } from '../ui/colors.js';
import { UserError } from '../core/errors.js';
import {
  getActiveWorkspaceId,
  homeRoot,
  listHomeWorkspaces,
  setActiveWorkspaceId,
  slugifyWorkspaceId,
} from '../storage/paths.js';
import { askConfirm } from '../ui/prompts.js';

export function registerWorkspaceCommand(program: Command): void {
  const ws = program.command('workspace').description('manage workspaces under ~/.aabcli/');

  ws.command('list')
    .description('list home workspaces and show which one is active')
    .action(async () => {
      const all = listHomeWorkspaces();
      const active = getActiveWorkspaceId();
      const root = homeRoot();
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(JSON.stringify({ active, root, workspaces: all }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`\n${brand()}  ${c.hint('— workspaces under ' + root)}\n\n`);
      if (all.length === 0) {
        process.stdout.write(c.hint('  (none yet — run `aab init` to create one)\n\n'));
        return;
      }
      for (const id of all) {
        const marker = id === active ? c.ok('●') : ' ';
        process.stdout.write(`  ${marker} ${id === active ? c.bold(id) : id}\n`);
      }
      process.stdout.write('\n');
    });

  ws.command('new <id>')
    .description('create a new empty workspace at ~/.aabcli/<id>/ and switch to it')
    .action(async (rawId: string) => {
      const id = slugifyWorkspaceId(rawId);
      const root = join(homeRoot(), id);
      if (existsSync(root)) {
        throw new UserError(`Workspace "${id}" already exists at ${root}`);
      }
      mkdirSync(root, { recursive: true });
      setActiveWorkspaceId(id);
      process.stdout.write(`${c.ok('✓')} Created workspace ${c.bold(id)} (${root}).\n`);
      process.stdout.write(c.hint('  Run `aab init` inside it to seed starter members and principles.\n'));
    });

  ws.command('switch <id>')
    .description('set the active workspace pointer')
    .action(async (rawId: string) => {
      const id = slugifyWorkspaceId(rawId);
      const root = join(homeRoot(), id);
      if (!existsSync(root)) {
        throw new UserError(
          `No workspace at ${root}`,
          'Run `aab workspace new ' + id + '` to create it.',
        );
      }
      setActiveWorkspaceId(id);
      process.stdout.write(`${c.ok('✓')} Active workspace: ${c.bold(id)}.\n`);
    });

  ws.command('delete <id>')
    .description('move a workspace to ~/.aabcli/.trash/ (recoverable)')
    .option('--yes', 'skip confirmation')
    .action(async (rawId: string, opts: { yes?: boolean }) => {
      const id = slugifyWorkspaceId(rawId);
      const root = join(homeRoot(), id);
      if (!existsSync(root)) throw new UserError(`No workspace at ${root}`);
      if (!opts.yes) {
        const ok = await askConfirm(`Delete workspace "${id}"? It will be moved to .trash/.`, false);
        if (!ok) {
          process.stdout.write(c.hint('Aborted.\n'));
          return;
        }
      }
      const trashDir = join(homeRoot(), '.trash');
      if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
      const trashPath = join(trashDir, `${id}-${Date.now()}`);
      renameSync(root, trashPath);
      // If we just deleted the active one, clear the pointer
      if (getActiveWorkspaceId() === id) {
        setActiveWorkspaceId('');
      }
      process.stdout.write(`${c.ok('✓')} Workspace ${c.bold(id)} moved to ${trashPath}.\n`);
    });
}
