import { mkdirSync } from 'node:fs';

import { api, type ActualInitConfig } from './actual-api.js';

import { CliError, ErrorCodes } from './cli.js';
import { send, setActiveInternalApi } from './commands/common.js';
import { getDefaultDataDir, readConfig } from './config.js';
import {
  assertBetterSqliteAvailable,
  normalizeNativeDependencyError,
} from './native-deps.js';
import {
  isSyncStale,
  readSyncState,
  recordSyncFailure,
  recordSyncSuccess,
} from './sync-state.js';
import type {
  ResolvedSessionOptions,
  SessionOptions,
} from './types.js';
import { normalizeVersionMismatchError } from './versions.js';

const AGENT_FEATURE_DEFAULTS: ReadonlyArray<{ id: string; value: 'true' | 'false' }> = [
  { id: 'flags.goalTemplatesEnabled', value: 'true' },
  { id: 'flags.goalTemplatesUIEnabled', value: 'true' },
  { id: 'flags.actionTemplating', value: 'true' },
  { id: 'flags.formulaMode', value: 'true' },
  { id: 'flags.budgetAnalysisReport', value: 'false' },
  { id: 'flags.crossoverReport', value: 'false' },
  { id: 'flags.customThemes', value: 'false' },
];

/** Re-sync before reads when the last successful sync is older than this. */
const SYNC_STALE_AFTER_MS = 5 * 60 * 1000;

async function tryAutoSync(resolved: ResolvedSessionOptions): Promise<void> {
  try {
    await api.sync();
    recordSyncSuccess(resolved.dataDir, resolved.budgetId!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSyncFailure(resolved.dataDir, resolved.budgetId!, message);
    // The command's stdout document is already printed and the local write
    // succeeded, so this must not become an error envelope (a consumer would
    // retry and duplicate the mutation). Emit a structured warning on stderr;
    // `status` reports the pending state until a later sync succeeds.
    console.error(
      JSON.stringify({
        status: 'warning',
        entity: 'sync',
        synced: false,
        message: `Changes were saved locally but not uploaded to the server: ${message}. They will upload on the next successful sync; check 'fscl status' for sync.pending.`,
      }),
    );
  }
}

async function syncBeforeRead(resolved: ResolvedSessionOptions): Promise<void> {
  const state = readSyncState(resolved.dataDir, resolved.budgetId!);
  if (!resolved.fresh && !isSyncStale(state, SYNC_STALE_AFTER_MS)) {
    return;
  }
  try {
    await api.sync();
    recordSyncSuccess(resolved.dataDir, resolved.budgetId!);
  } catch (error) {
    const normalized = normalizeVersionMismatchError(error);
    if (normalized !== error) {
      throw normalized;
    }
    // A failed pre-read sync degrades to local data rather than blocking the
    // command; the warning makes the staleness visible.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        status: 'warning',
        entity: 'sync',
        synced: false,
        message: `Could not sync from the server; using local data (last successful sync: ${state.lastSyncAt ?? 'never'}). ${message}`,
      }),
    );
  }
}

async function ensureAgentFeatureDefaults(): Promise<boolean> {
  const prefs = (await send('preferences/get', undefined)) as
    | Record<string, unknown>
    | undefined;

  let changed = false;
  for (const feature of AGENT_FEATURE_DEFAULTS) {
    if (prefs?.[feature.id] === feature.value) {
      continue;
    }
    await send('preferences/save', {
      id: feature.id,
      value: feature.value,
    });
    changed = true;
  }
  return changed;
}

function resolveSession(options: SessionOptions = {}): ResolvedSessionOptions {
  const config = readConfig();
  const dataDir = options.dataDir ?? config.dataDir ?? getDefaultDataDir();
  const offline = Boolean(options.offline);
  const serverURL = offline
    ? undefined
    : options.serverURL ?? process.env.FISCAL_SERVER_URL ?? config.serverURL;
  const token = options.token ?? config.token;
  const budgetId = options.budget ?? config.activeBudgetId;
  return {
    dataDir,
    budgetId,
    serverURL,
    token,
    write: Boolean(options.write),
    offline,
    fresh: Boolean(options.fresh),
  };
}

export function resolveBudgetId(options: SessionOptions = {}): string | undefined {
  return resolveSession(options).budgetId;
}

export async function withApi<T>(
  options: SessionOptions,
  fn: (ctx: ResolvedSessionOptions) => Promise<T>,
): Promise<T> {
  const resolved = resolveSession(options);
  // The Actual API bundle uses process.env.ACTUAL_DATA_DIR in exportDatabase()
  // but api.init() never sets it — only sets an internal documentDir variable.
  // Without this, upload-budget fails with "directory does not exist".
  mkdirSync(resolved.dataDir, { recursive: true });
  process.env.ACTUAL_DATA_DIR = resolved.dataDir;
  if (resolved.serverURL && !resolved.token) {
    throw new CliError("Not logged in. Run 'fscl login' to authenticate.", ErrorCodes.NOT_LOGGED_IN);
  }

  assertBetterSqliteAvailable();

  const initConfig: ActualInitConfig = resolved.serverURL
    ? ({
        dataDir: resolved.dataDir,
        verbose: false,
        serverURL: resolved.serverURL,
        ...(resolved.token ? { sessionToken: resolved.token } : {}),
      })
    : ({
        dataDir: resolved.dataDir,
        verbose: false,
      });

  setActiveInternalApi(await api.init(initConfig));

  try {
    return await fn(resolved);
  } finally {
    setActiveInternalApi(null);
    await api.shutdown();
  }
}

export async function withBudget<T>(
  options: SessionOptions,
  fn: (ctx: ResolvedSessionOptions) => Promise<T>,
): Promise<T> {
  return withApi(options, async resolved => {
    if (!resolved.budgetId) {
      throw new CliError(
        "No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.",
        ErrorCodes.NO_BUDGET,
      );
    }

    try {
      await api.loadBudget(resolved.budgetId);
    } catch (error) {
      const normalized = normalizeNativeDependencyError(error);
      throw normalized === error
        ? normalizeVersionMismatchError(error)
        : normalized;
    }
    if (resolved.serverURL) {
      await syncBeforeRead(resolved);
    }
    const updatedFeatureDefaults = await ensureAgentFeatureDefaults();
    try {
      return await fn(resolved);
    } finally {
      if (resolved.serverURL && (resolved.write || updatedFeatureDefaults)) {
        await tryAutoSync(resolved);
      }
    }
  });
}

/** Decimal notation for human-typed CLI flags and args (--amount 45.99). */
export function parseAmount(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid amount: ${input}`);
  }
  return api.utils.amountToInteger(value);
}

/**
 * Integer minor units for JSON payloads and draft files (-4599 = -$45.99),
 * matching the output convention so list/draft/apply round-trips are
 * identity. A fractional value is almost always a decimal-dollars mistake,
 * so the error says how to convert.
 */
export function parseMinorUnits(value: unknown, label = 'amount'): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new CliError(
      `Invalid ${label}: expected integer minor units (e.g. -4599 for -$45.99), got ${JSON.stringify(value)}`,
      ErrorCodes.INVALID_INPUT,
    );
  }
  if (!Number.isInteger(parsed)) {
    throw new CliError(
      `Invalid ${label}: JSON amounts are integer minor units, not decimals. Use ${api.utils.amountToInteger(parsed)} instead of ${parsed}.`,
      ErrorCodes.INVALID_INPUT,
    );
  }
  return parsed;
}
