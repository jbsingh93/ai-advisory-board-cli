/**
 * Color helpers. We use chalk lazily so colors auto-disable in non-TTY pipes.
 */
import chalk from 'chalk';

const MEMBER_PALETTE = [
  chalk.cyanBright,
  chalk.greenBright,
  chalk.yellowBright,
  chalk.magentaBright,
  chalk.blueBright,
  chalk.redBright,
  chalk.white,
] as const;

/** Deterministic per-member color (FNV-1a → palette index). */
export function memberColor(name: string): (s: string) => string {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const idx = hash % MEMBER_PALETTE.length;
  return MEMBER_PALETTE[idx]!;
}

export const c = {
  bold: chalk.bold,
  dim: chalk.dim,
  cyan: chalk.cyan,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
  magenta: chalk.magenta,
  gray: chalk.gray,
  whiteBright: chalk.whiteBright,
  ok: chalk.greenBright,
  warn: chalk.yellow,
  err: chalk.redBright,
  hint: chalk.gray,
  brand: chalk.bold.cyan,
};

export function brand(): string {
  return c.brand('AI Advisory Board CLI');
}
