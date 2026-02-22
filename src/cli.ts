import { Command } from 'commander';

import { AUTH_ERROR_CODE, isAuthError } from './auth.js';
import { updateConfig } from './config.js';
import { printStatusErr, setColumnFilter } from './output.js';
import type { GlobalOptions, OutputFormat, SessionOptions } from './types.js';

export class CliError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export const ErrorCodes = {
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  NO_BUDGET: 'NO_BUDGET',
  NO_CONFIG: 'NO_CONFIG',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  INVALID_INPUT: 'INVALID_INPUT',
  DRAFT_VALIDATION: 'DRAFT_VALIDATION',
  SERVER_REQUIRED: 'SERVER_REQUIRED',
} as const;

export function getGlobalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals() as GlobalOptions;
  return {
    dataDir: opts.dataDir,
    budget: opts.budget,
    serverUrl: opts.serverUrl,
    json: opts.json,
    columns: opts.columns,
  };
}

export function getColumns(command: Command): string[] | undefined {
  const opts = getGlobalOptions(command);
  if (!opts.columns) {
    return undefined;
  }
  return opts.columns.split(',').map(c => c.trim()).filter(Boolean);
}

export function getSessionOptions(command: Command): SessionOptions {
  const opts = getGlobalOptions(command);
  return {
    dataDir: opts.dataDir,
    budget: opts.budget,
    serverURL: opts.serverUrl,
  };
}

export function getFormat(command: Command): OutputFormat {
  const opts = getGlobalOptions(command);
  return opts.json ? 'json' : 'table';
}

function persistConnectionOptions(command: Command): void {
  const opts = getGlobalOptions(command);
  const patch: { serverURL?: string } = {};
  if (opts.serverUrl !== undefined) {
    patch.serverURL = opts.serverUrl;
  }
  if (patch.serverURL !== undefined) {
    updateConfig(patch);
  }
}

export function commandAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
) {
  return async (...args: T) => {
    const commandArg = args.at(-1);
    const command = commandArg instanceof Command ? commandArg : undefined;
    try {
      if (command) {
        setColumnFilter(getColumns(command));
      }
      await fn(...args);
      if (command && command.name() !== 'login' && command.name() !== 'logout') {
        persistConnectionOptions(command);
      }
    } catch (error) {
      if (command?.name() !== 'login' && isAuthError(error)) {
        printStatusErr("Not logged in. Run 'fscl login' to authenticate.", {
          code: AUTH_ERROR_CODE,
        });
        process.exitCode = 1;
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred';
      const code = error instanceof CliError ? error.code : undefined;
      printStatusErr(message, code ? { code } : {});
      process.exitCode = 1;
    }
  };
}

export function asDate(input: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`Expected date in YYYY-MM-DD format, got "${input}"`);
  }
  return input;
}

export function asMonth(input: string): string {
  if (!/^\d{4}-\d{2}$/.test(input)) {
    throw new Error(`Expected month in YYYY-MM format, got "${input}"`);
  }
  return input;
}
