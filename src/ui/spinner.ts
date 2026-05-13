/**
 * Spinner wrapper. Quietly no-ops when stdout isn't a TTY (so piping is clean).
 */
import oraImport from 'ora';

const ora = oraImport;

export function spinner(text: string) {
  if (!process.stdout.isTTY) {
    return {
      start: () => undefined,
      succeed: (t?: string) => {
        if (t) process.stderr.write(`✓ ${t}\n`);
      },
      fail: (t?: string) => {
        if (t) process.stderr.write(`✗ ${t}\n`);
      },
      info: (t?: string) => {
        if (t) process.stderr.write(`• ${t}\n`);
      },
      warn: (t?: string) => {
        if (t) process.stderr.write(`⚠ ${t}\n`);
      },
      text,
      stop: () => undefined,
    };
  }
  return ora({ text, stream: process.stderr });
}
