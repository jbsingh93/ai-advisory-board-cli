import { runCli } from '../src/cli.js';

runCli(process.argv).catch((error: unknown) => {
  // Unhandled errors fall through to here. Normal command errors are caught
  // inside cli.ts and mapped to typed exit codes.
  // eslint-disable-next-line no-console
  console.error('[aabcli] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
