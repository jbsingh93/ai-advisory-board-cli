/**
 * Thin wrappers around enquirer so callers don't import it directly.
 * Returning typed values; throws CancelledError on user abort.
 */
import enquirer from 'enquirer';
import { CancelledError } from '../core/errors.js';

const { prompt } = enquirer;

export async function askText(message: string, opts: { initial?: string; required?: boolean } = {}): Promise<string> {
  try {
    const answer = (await prompt<{ value: string }>({
      type: 'input',
      name: 'value',
      message,
      initial: opts.initial,
      validate: (v: string) => (opts.required && !v.trim() ? 'Required' : true),
    })).value;
    return answer.trim();
  } catch {
    throw new CancelledError();
  }
}

export async function askSecret(message: string, opts: { required?: boolean } = {}): Promise<string> {
  try {
    const answer = (await prompt<{ value: string }>({
      type: 'password',
      name: 'value',
      message,
      validate: (v: string) => (opts.required && !v.trim() ? 'Required' : true),
    })).value;
    return answer.trim();
  } catch {
    throw new CancelledError();
  }
}

export async function askConfirm(message: string, initial = true): Promise<boolean> {
  try {
    const answer = (await prompt<{ value: boolean }>({
      type: 'confirm',
      name: 'value',
      message,
      initial,
    })).value;
    return answer;
  } catch {
    throw new CancelledError();
  }
}

export async function askSelect<T extends string>(
  message: string,
  choices: Array<{ name: T; message?: string; hint?: string }>,
  opts: { initial?: T } = {},
): Promise<T> {
  try {
    const initialIndex = opts.initial ? choices.findIndex((c) => c.name === opts.initial) : 0;
    const answer = (await prompt<{ value: T }>({
      type: 'select',
      name: 'value',
      message,
      choices: choices.map((c) => ({ name: c.name, message: c.message ?? c.name, hint: c.hint })),
      initial: initialIndex < 0 ? 0 : initialIndex,
    })).value;
    return answer;
  } catch {
    throw new CancelledError();
  }
}

export async function askMultiSelect<T extends string>(
  message: string,
  choices: Array<{ name: T; message?: string; hint?: string; selected?: boolean }>,
): Promise<T[]> {
  try {
    const answer = (await prompt<{ value: T[] }>({
      type: 'multiselect',
      name: 'value',
      message,
      choices: choices.map((c) => ({
        name: c.name,
        message: c.message ?? c.name,
        hint: c.hint,
        enabled: c.selected ?? false,
      })),
    } as unknown as Parameters<typeof prompt>[0])).value;
    return answer;
  } catch {
    throw new CancelledError();
  }
}
