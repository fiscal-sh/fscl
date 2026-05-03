import { createRequire } from 'node:module';

import { CliError, ErrorCodes } from './cli.js';

let checkedBetterSqlite = false;

function isBetterSqliteBindingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Could not locate the bindings file') ||
    message.includes('better_sqlite3.node') ||
    message.includes('better-sqlite3')
  );
}

export function nativeDependencyInstallMessage(): string {
  return [
    'The native SQLite dependency for Actual Budget is not installed correctly.',
    'This usually happens when npm install scripts are disabled, for example `npm config set ignore-scripts true`.',
    'Run a one-time rebuild with scripts enabled: `npm rebuild -g better-sqlite3 --ignore-scripts=false`.',
    'If that does not fix it, reinstall fscl with scripts enabled for only that command: `npm uninstall -g fscl && npm install -g fscl --ignore-scripts=false`.',
  ].join(' ');
}

export function assertBetterSqliteAvailable(): void {
  if (checkedBetterSqlite) {
    return;
  }

  try {
    const require = createRequire(import.meta.url);
    const BetterSqlite = require('better-sqlite3') as {
      new (path: string): { close(): void };
    };
    const db = new BetterSqlite(':memory:');
    db.close();
    checkedBetterSqlite = true;
  } catch (error) {
    if (isBetterSqliteBindingError(error)) {
      throw new CliError(
        nativeDependencyInstallMessage(),
        ErrorCodes.NATIVE_DEPENDENCY,
      );
    }
    throw error;
  }
}

export function normalizeNativeDependencyError(error: unknown): unknown {
  if (isBetterSqliteBindingError(error)) {
    return new CliError(
      nativeDependencyInstallMessage(),
      ErrorCodes.NATIVE_DEPENDENCY,
    );
  }
  return error;
}
