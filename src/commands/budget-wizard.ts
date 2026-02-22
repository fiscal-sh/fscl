import { stdin, stdout } from 'node:process';
import { mkdirSync } from 'node:fs';

import * as api from '@actual-app/api';
import * as p from '@clack/prompts';

import { loginToServer } from '../auth.js';
import { withApi } from '../budget.js';
import type { Config } from '../types.js';
import { budgetRows, type BudgetRow } from './common.js';

export const INIT_MODES = ['local', 'remote'] as const;

export type InitMode = (typeof INIT_MODES)[number];

export type BudgetSetupInput = {
  mode: InitMode;
  dataDir: string;
  budgetName?: string;
  serverURL?: string;
  token?: string;
  syncId?: string;
};

export type BudgetCreationResult = {
  budgetId: string;
  budgetName?: string;
  syncId?: string;
};

type BudgetRowWithId = BudgetRow & { id: string };

type RemoteBudget = {
  syncId: string;
  name?: string;
  localId?: string;
  state?: string;
};

type BudgetWizardOptions = {
  dataDir: string;
  mode?: string;
  budgetName?: string;
  serverUrl?: string;
  password?: string;
  syncId?: string;
};

export function parseInitMode(value: string): InitMode {
  const mode = value.trim();
  if (mode === 'local' || mode === 'remote') {
    return mode;
  }
  throw new Error(
    `Invalid mode "${value}". Expected one of: ${INIT_MODES.join(', ')}`,
  );
}

function requireValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required ${label}.`);
  }
  return trimmed;
}

function cancelledOrValue<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return result;
}

function asRemoteBudgets(rows: BudgetRow[]): RemoteBudget[] {
  return rows
    .filter((row): row is BudgetRow & { group_id: string } => Boolean(row.group_id))
    .map(row => ({
      syncId: row.group_id,
      name: row.name,
      localId: row.id,
      state: row.state,
    }));
}

function remoteConnection(setup: BudgetSetupInput): {
  dataDir: string;
  serverURL: string;
  token: string;
} {
  return {
    dataDir: setup.dataDir,
    serverURL: requireValue(setup.serverURL, 'server URL'),
    token: requireValue(setup.token, 'session token'),
  };
}

async function listRemoteBudgets(setup: BudgetSetupInput): Promise<RemoteBudget[]> {
  const connection = remoteConnection(setup);
  let rows: BudgetRow[] = [];
  await withApi(connection, async () => {
    rows = budgetRows(await api.getBudgets());
  });
  return asRemoteBudgets(rows);
}

async function resolveRemoteSyncId(setup: BudgetSetupInput): Promise<string> {
  const remoteBudgets = await listRemoteBudgets(setup);
  if (setup.syncId) {
    const match = remoteBudgets.find(item => item.syncId === setup.syncId);
    if (match) {
      return match.syncId;
    }
    throw new Error(`Remote budget not found for sync id: ${setup.syncId}`);
  }
  if (remoteBudgets.length === 0) {
    throw new Error(
      'No remote budgets found on the server. Create one in Actual or create a local budget and run fscl budgets push.',
    );
  }
  if (remoteBudgets.length === 1) {
    return remoteBudgets[0].syncId;
  }
  throw new Error(
    'Multiple remote budgets found. Re-run with --sync-id <id> or use interactive mode.',
  );
}

async function chooseRemoteSyncIdInteractive(
  setup: BudgetSetupInput,
): Promise<string> {
  const spin = p.spinner();
  spin.start('Fetching remote budgets');
  const remoteBudgets = await listRemoteBudgets(setup);
  spin.stop('Fetched remote budgets');

  if (remoteBudgets.length === 0) {
    throw new Error(
      'No remote budgets found on the server. Create one in Actual or create a local budget and run fscl budgets push.',
    );
  }
  if (setup.syncId) {
    const match = remoteBudgets.find(item => item.syncId === setup.syncId);
    if (!match) {
      throw new Error(`Remote budget not found for sync id: ${setup.syncId}`);
    }
    return match.syncId;
  }
  if (remoteBudgets.length === 1) {
    return remoteBudgets[0].syncId;
  }

  const syncId = cancelledOrValue(
    await p.select({
      message: 'Which budget?',
      options: remoteBudgets.map(budget => ({
        value: budget.syncId,
        label: budget.name || '(unnamed)',
        hint: budget.syncId,
      })),
    }),
  );
  return syncId;
}

async function createBudget(
  setup: BudgetSetupInput,
  budgetName: string,
): Promise<BudgetRowWithId> {
  const session = {
    dataDir: setup.dataDir,
    ...(setup.serverURL ? { serverURL: setup.serverURL } : {}),
    ...(setup.token ? { token: setup.token } : {}),
  };
  let created: BudgetRow | undefined;
  await withApi(session, async () => {
    const before = budgetRows(await api.getBudgets());
    const beforeIds = new Set(
      before
        .map(item => item.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    await api.runImport(budgetName, async () => {});
    const after = budgetRows(await api.getBudgets());
    created =
      after.find(item => typeof item.id === 'string' && !beforeIds.has(item.id)) ??
      after.find(item => item.name === budgetName && typeof item.id === 'string');
  });
  if (!created?.id) {
    throw new Error('Budget was created but local budget id could not be resolved.');
  }
  return created as BudgetRowWithId;
}

async function pullBudget(
  setup: BudgetSetupInput,
  syncId: string,
): Promise<BudgetRowWithId> {
  const connection = remoteConnection(setup);
  let pulled: BudgetRow | undefined;
  await withApi(connection, async () => {
    await api.downloadBudget(syncId);
    const budgets = budgetRows(await api.getBudgets());
    pulled =
      budgets.find(item => item.group_id === syncId && typeof item.id === 'string') ??
      budgets.find(item => item.group_id === syncId);
  });
  if (!pulled?.id) {
    throw new Error(
      `Downloaded remote budget (${syncId}) but local budget id could not be resolved.`,
    );
  }
  return pulled as BudgetRowWithId;
}

export async function runBudgetCreation(setup: BudgetSetupInput): Promise<BudgetCreationResult> {
  mkdirSync(setup.dataDir, { recursive: true });

  if (setup.mode === 'local') {
    const created = await createBudget(setup, requireValue(setup.budgetName, 'budget name'));
    return {
      budgetId: created.id,
      budgetName: created.name ?? setup.budgetName,
    };
  }

  const syncId = await resolveRemoteSyncId(setup);
  const pulled = await pullBudget(setup, syncId);
  return {
    budgetId: pulled.id,
    budgetName: pulled.name,
    syncId,
  };
}

export async function collectBudgetSetup(
  options: BudgetWizardOptions,
  config: Config,
): Promise<BudgetSetupInput> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Interactive mode requires a TTY. Re-run with --non-interactive and flags.',
    );
  }

  const { dataDir } = options;

  const modeDefault = options.mode
    ? parseInitMode(options.mode)
    : config.serverURL
      ? 'remote'
      : 'local';

  const mode = cancelledOrValue(
    await p.select({
      message: 'Setup mode',
      initialValue: modeDefault,
      options: [
        {
          value: 'local' as InitMode,
          label: 'Local',
          hint: 'Create a local Fiscal budget',
        },
        {
          value: 'remote' as InitMode,
          label: 'Remote',
          hint: 'Link to an existing budget on your Actual Budget server',
        },
      ],
    }),
  );

  if (mode === 'local') {
    const budgetName = requireValue(
      cancelledOrValue(
        await p.text({
          message: 'Budget name',
          initialValue: options.budgetName ?? 'My Budget',
          validate: (v) => {
            if (!v?.trim()) return 'Budget name is required.';
          },
        }),
      ),
      'budget name',
    );
    return { mode, dataDir, budgetName };
  }

  const serverURL = requireValue(
    cancelledOrValue(
      await p.text({
        message: 'Server URL',
        initialValue:
          options.serverUrl ?? config.serverURL ?? 'http://localhost:5006',
        validate: (v) => {
          if (!v?.trim()) return 'Server URL is required.';
        },
      }),
    ),
    'server URL',
  );

  const pw = requireValue(
    cancelledOrValue(
      await p.password({
        message: 'Server password',
        validate: (v) => {
          if (!v?.trim()) return 'Server password is required.';
        },
      }),
    ),
    'server password',
  );
  const token = await loginToServer(serverURL, pw);

  const syncId = await chooseRemoteSyncIdInteractive({
    mode,
    dataDir,
    serverURL,
    token,
    syncId: options.syncId,
  });
  return { mode, dataDir, serverURL, token, syncId };
}

export async function collectBudgetSetupNonInteractive(
  options: BudgetWizardOptions,
): Promise<BudgetSetupInput> {
  if (!options.mode) {
    throw new Error(
      'Non-interactive mode requires --mode <local|remote>.',
    );
  }
  const mode = parseInitMode(options.mode);
  const { dataDir } = options;

  if (mode === 'local') {
    const budgetName = requireValue(options.budgetName, '--budget-name');
    return { mode, dataDir, budgetName };
  }

  const serverURL = requireValue(
    options.serverUrl ?? process.env.FISCAL_SERVER_URL,
    '--server-url',
  );
  const password = requireValue(
    options.password ?? process.env.FISCAL_PASSWORD,
    '--password',
  );
  const token = await loginToServer(serverURL, password);

  return {
    mode,
    dataDir,
    serverURL,
    token,
    syncId: options.syncId,
  };
}
