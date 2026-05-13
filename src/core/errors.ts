/**
 * Typed error classes mapped to CLI exit codes.
 *
 * 0 success
 * 1 user error
 * 2 model error (Claude API)
 * 3 network error
 * 4 parse / contract violation
 * 5 filesystem error
 * 6 cancelled (Ctrl+C)
 * 7 budget exceeded
 */

export type AabExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export class AabError extends Error {
  public readonly exitCode: AabExitCode;
  public readonly hint?: string;

  constructor(message: string, exitCode: AabExitCode, hint?: string) {
    super(message);
    this.name = 'AabError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class UserError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint);
    this.name = 'UserError';
  }
}

export class ModelError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
    this.name = 'ModelError';
  }
}

export class NetworkError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 3, hint);
    this.name = 'NetworkError';
  }
}

export class ContractError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 4, hint);
    this.name = 'ContractError';
  }
}

export class FsError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 5, hint);
    this.name = 'FsError';
  }
}

export class CancelledError extends AabError {
  constructor(message = 'Cancelled.') {
    super(message, 6);
    this.name = 'CancelledError';
  }
}

export class BudgetError extends AabError {
  constructor(message: string, hint?: string) {
    super(message, 7, hint);
    this.name = 'BudgetError';
  }
}
