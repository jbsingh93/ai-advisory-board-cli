/**
 * CLI root. Wires commander, global flags, error mapping.
 */
import { Command } from 'commander';
import { AabError, CancelledError } from './core/errors.js';
import { logger, setLogLevel, type LogLevel } from './core/logger.js';
import { c } from './ui/colors.js';
import { PRODUCT_NAME, VERSION } from './version.js';
import { maybeNotifyUpdate } from './core/update-check.js';
import { registerInitCommand } from './commands/init.js';
import { registerSettingsCommand } from './commands/settings.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerWorkspaceCommand } from './commands/workspace.js';
import { registerDiscussCommand } from './commands/discuss.js';
import { registerUiCommand } from './commands/ui.js';
import { registerKnowledgeCommand } from './commands/knowledge.js';
import { registerMembersCommand } from './commands/members.js';
import { registerPrinciplesCommand } from './commands/principles.js';
import { registerCoachCommand } from './commands/coach.js';
import { registerActionsCommand } from './commands/actions.js';
import { registerSkillsCommand } from './commands/skills.js';

interface GlobalOpts {
  workspace?: string;
  json?: boolean;
  debug?: boolean;
  logLevel?: LogLevel;
  quiet?: boolean;
}

export async function runCli(argv: string[]): Promise<void> {
  // Trap Ctrl+C cleanly.
  process.on('SIGINT', () => {
    process.exit(6);
  });

  const program = new Command();
  program
    .name('aab')
    .description(`${PRODUCT_NAME} — convene a panel of Claude sub-agents on any business question.`)
    .version(VERSION, '-v, --version', 'output the version number')
    .option('--workspace <id>', 'workspace id override (also honors AAB_WORKSPACE env)')
    .option('--json', 'machine-readable output where supported')
    .option('--debug', 'verbose logging (sets log level to debug)')
    .option('--log-level <level>', 'silent | error | warn | info | debug | trace')
    .option('--quiet', 'suppress non-error stderr output')
    .hook('preAction', (thisCommand, actionCommand) => {
      const opts = thisCommand.opts<GlobalOpts>();
      if (opts.debug) setLogLevel('debug');
      else if (opts.logLevel) setLogLevel(opts.logLevel);
      else if (opts.quiet) setLogLevel('error');
      // Non-blocking "update available" notice. `doctor` reports it as its own
      // check, so skip the banner there to avoid saying it twice.
      if (actionCommand.name() !== 'doctor') maybeNotifyUpdate({ json: opts.json });
    });

  // Subcommands
  registerInitCommand(program);
  registerSettingsCommand(program);
  registerDoctorCommand(program);
  registerWorkspaceCommand(program);
  registerDiscussCommand(program);
  registerUiCommand(program);
  registerKnowledgeCommand(program);
  registerMembersCommand(program);
  registerPrinciplesCommand(program);
  registerCoachCommand(program);
  registerActionsCommand(program);
  registerSkillsCommand(program);

  // Friendly default when no command given
  program.action(() => {
    program.outputHelp();
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleError(error);
  }
}

function handleError(error: unknown): never {
  if (error instanceof CancelledError) {
    logger.warn(error.message);
    process.exit(error.exitCode);
  }
  if (error instanceof AabError) {
    process.stderr.write(`${c.err('✗')} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${c.hint('  ' + error.hint)}\n`);
    process.exit(error.exitCode);
  }
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${c.err('✗')} ${msg}\n`);
  if (error instanceof Error && error.stack) logger.debug(error.stack);
  process.exit(1);
}
