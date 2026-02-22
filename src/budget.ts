import { mkdirSync } from 'node:fs';

import * as api from '@actual-app/api';

import { CliError, ErrorCodes } from './cli.js';
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

async function ensureAgentFeatureDefaults(): Promise<boolean> {
  const prefs = (await api.internal.send('preferences/get', undefined)) as
    | Record<string, unknown>
    | undefined;

  let changed = false;
  for (const feature of AGENT_FEATURE_DEFAULTS) {
    if (prefs?.[feature.id] === feature.value) {
      continue;
    }
    await api.internal.send('preferences/save', {
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

  const initConfig = resolved.serverURL
    ? ({
        dataDir: resolved.dataDir,
        verbose: false,
        serverURL: resolved.serverURL,
        ...(resolved.token ? { sessionToken: resolved.token } : {}),
      } as Parameters<typeof api.init>[0])
    : ({
        dataDir: resolved.dataDir,
        verbose: false,
      } as Parameters<typeof api.init>[0]);

  await api.init(initConfig);

  try {
    return await fn(resolved);
  } finally {
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
        await api.sync();
      } else if (updatedFeatureDefaults && resolved.serverURL) {
        await api.sync();
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
