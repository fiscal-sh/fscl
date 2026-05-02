import { mkdirSync } from 'node:fs';

import { api } from './actual-api.js';

import { CliError, ErrorCodes } from './cli.js';
import { send, setActiveInternalApi } from './commands/common.js';
import { getDefaultDataDir, readConfig } from './config.js';
import type {
  ResolvedSessionOptions,
  SessionOptions,
} from './types.js';

const AGENT_FEATURE_DEFAULTS: ReadonlyArray<{ id: string; value: 'true' | 'false' }> = [
  { id: 'flags.goalTemplatesEnabled', value: 'true' },
  { id: 'flags.goalTemplatesUIEnabled', value: 'true' },
  { id: 'flags.actionTemplating', value: 'true' },
  { id: 'flags.formulaMode', value: 'true' },
  { id: 'flags.budgetAnalysisReport', value: 'false' },
  { id: 'flags.crossoverReport', value: 'false' },
  { id: 'flags.customThemes', value: 'false' },
];

async function tryAutoSync(): Promise<void> {
  try {
    await api.sync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: automatic sync failed after local changes were saved: ${message}`);
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
  const serverURL =
    options.serverURL ?? process.env.FISCAL_SERVER_URL ?? config.serverURL;
  const token = options.token ?? config.token;
  const budgetId = options.budget ?? config.activeBudgetId;
  return {
    dataDir,
    budgetId,
    serverURL,
    token,
    write: Boolean(options.write),
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

  const initConfig: Record<string, unknown> = resolved.serverURL
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

    await api.loadBudget(resolved.budgetId);
    const updatedFeatureDefaults = await ensureAgentFeatureDefaults();
    try {
      return await fn(resolved);
    } finally {
      if (resolved.write && resolved.serverURL) {
        await tryAutoSync();
      } else if (updatedFeatureDefaults && resolved.serverURL) {
        await tryAutoSync();
      }
    }
  });
}

export function parseAmount(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid amount: ${input}`);
  }
  return api.utils.amountToInteger(value);
}
