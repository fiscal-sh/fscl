import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { CliError, ErrorCodes } from './cli.js';

const require = createRequire(import.meta.url);

export function getFsclVersion(): string {
  const pkg = require('../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}

export function getBundledApiVersion(): string {
  // The package's exports map blocks require('@actual-app/api/package.json'),
  // so resolve the entry point (.../dist/index.js) and read the manifest from
  // the package root above it.
  try {
    const entry = require.resolve('@actual-app/api');
    const manifest = join(dirname(dirname(entry)), 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export type VersionCompatibility = 'match' | 'patch-drift' | 'drift' | 'unknown';

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare the bundled API version against a server version. Actual releases
 * the API, web client, and sync server together, so matching major.minor is
 * the supported pairing. Drift is reported, never enforced: the sync protocol
 * tolerates skew, and the real failure mode (budget migrations from a newer
 * client) is caught at budget load and mapped to ACTUAL_VERSION_MISMATCH.
 */
export function compareVersions(
  apiVersion: string,
  serverVersion: string | undefined,
): { compatibility: VersionCompatibility; warning?: string } {
  if (!serverVersion) {
    return { compatibility: 'unknown' };
  }
  const api = parseVersion(apiVersion);
  const server = parseVersion(serverVersion);
  if (!api || !server) {
    return { compatibility: 'unknown' };
  }
  if (api[0] === server[0] && api[1] === server[1]) {
    return api[2] === server[2]
      ? { compatibility: 'match' }
      : { compatibility: 'patch-drift' };
  }
  return {
    compatibility: 'drift',
    warning: `Fiscal bundles Actual API ${apiVersion} but the server is ${serverVersion}. This usually works, but if the budget was opened by a newer client it may fail to load. Update fscl or pin the server image to ${apiVersion}.`,
  };
}

const MIGRATION_MISMATCH_MARKERS = [
  'out-of-sync-migrations',
  'out-of-sync-data',
  'cannot be loaded with this version',
];

/**
 * Map Actual's budget-migration failures (a budget touched by a newer client
 * that this API version cannot open) to an actionable stable error code.
 */
export function normalizeVersionMismatchError(error: unknown): unknown {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = message.toLowerCase();
  if (!MIGRATION_MISMATCH_MARKERS.some(marker => lower.includes(marker))) {
    return error;
  }
  return new CliError(
    `This budget was migrated by a newer Actual client and cannot be opened by the bundled Actual API (${getBundledApiVersion()}). Update fscl to a release bundling the newer API, or keep all clients (server web UI included) on matching versions. Local data is untouched. Original error: ${message}`,
    ErrorCodes.ACTUAL_VERSION_MISMATCH,
  );
}
