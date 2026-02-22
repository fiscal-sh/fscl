import * as api from '@actual-app/api';
import { Command } from 'commander';

import { isAuthError } from '../auth.js';
import { commandAction, getFormat } from '../cli.js';
import { withApi } from '../budget.js';
import { getConfigPath, readConfig } from '../config.js';
import { printObject, printRowsTable } from '../output.js';
import type { OutputFormat } from '../types.js';
import { budgetRows, getActionCommand } from './common.js';

const STATUS_PAIR_FIELDS: ReadonlyArray<{ key: string; field: string }> = [
  { key: 'config.path', field: 'config_path' },
  { key: 'config.data_dir', field: 'data_dir' },
  { key: 'connection.configured', field: 'server_configured' },
  { key: 'connection.url', field: 'server_url' },
  { key: 'connection.logged_in', field: 'server_logged_in' },
  { key: 'connection.reachable', field: 'server_reachable' },
  { key: 'connection.version', field: 'server_version' },
  { key: 'connection.error', field: 'server_error' },
  { key: 'budget.active_id', field: 'active_budget_id' },
  { key: 'budget.active_name', field: 'active_budget_name' },
  { key: 'budget.group_id', field: 'active_budget_group_id' },
  { key: 'budget.cloud_file_id', field: 'active_budget_cloud_file_id' },
  { key: 'budget.state', field: 'active_budget_state' },
  { key: 'budget.local', field: 'active_budget_local' },
  { key: 'budget.remote_linked', field: 'active_budget_remote_linked' },
  { key: 'budget.type', field: 'budget_type' },
  { key: 'budget.loaded', field: 'budget_loaded' },
  { key: 'budget.load_error', field: 'budget_load_error' },
  { key: 'budget.count.total', field: 'budgets_total_count' },
  { key: 'budget.count.local', field: 'budgets_local_count' },
  { key: 'budget.count.remote_only', field: 'budgets_remote_only_count' },
  { key: 'metrics.accounts.total', field: 'accounts_total' },
  { key: 'metrics.accounts.open', field: 'accounts_open' },
  { key: 'metrics.accounts.closed', field: 'accounts_closed' },
  { key: 'metrics.accounts.on_budget', field: 'accounts_on_budget' },
  { key: 'metrics.accounts.off_budget', field: 'accounts_off_budget' },
  { key: 'metrics.accounts.open_on_budget', field: 'accounts_open_on_budget' },
  { key: 'metrics.accounts.open_off_budget', field: 'accounts_open_off_budget' },
  { key: 'metrics.accounts.current_total', field: 'accounts_current_total' },
  { key: 'metrics.categories.groups', field: 'category_groups_total' },
  { key: 'metrics.categories.total', field: 'categories_total' },
  { key: 'metrics.payees.total', field: 'payees_total' },
  { key: 'metrics.rules.total', field: 'rules_total' },
  { key: 'metrics.schedules.total', field: 'schedules_total' },
  { key: 'metrics.schedules.upcoming', field: 'schedules_upcoming' },
  { key: 'metrics.schedules.overdue', field: 'schedules_overdue' },
  { key: 'metrics.transactions.total', field: 'transactions_total' },
  { key: 'metrics.transactions.uncategorized', field: 'transactions_uncategorized' },
  { key: 'metrics.transactions.unreconciled', field: 'transactions_unreconciled' },
  { key: 'metrics.transactions.latest_date', field: 'latest_transaction_date' },
  { key: 'metrics.transactions.earliest_date', field: 'earliest_transaction_date' },
  { key: 'sync.pending', field: 'sync_pending' },
];

type StatusSession = {
  dataDir: string;
  budgetId?: string;
  serverURL?: string;
  token?: string;
};

type StatusRow = Record<string, string | number | undefined>;

type CountQueryResultRow = {
  count?: unknown;
};

export type StatusFormat = OutputFormat;

const COMPACT_STATUS_FIELDS = [
  'active_budget_id',
  'active_budget_name',
  'budget_type',
  'budget_loaded',
  'budget_load_error',
  'server_configured',
  'server_logged_in',
  'server_reachable',
  'server_error',
  'transactions_uncategorized',
  'sync_pending',
] as const;

type ServerInfoResponse = {
  version?: unknown;
  build?: {
    version?: unknown;
  };
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function fetchServerVersion(serverURL: string): Promise<string | undefined> {
  const base = serverURL.endsWith('/') ? serverURL : `${serverURL}/`;
  const url = new URL('info', base).toString();
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let payload: ServerInfoResponse;
  try {
    payload = (await response.json()) as ServerInfoResponse;
  } catch {
    return undefined;
  }
  const directVersion =
    typeof payload.version === 'string' ? payload.version.trim() : '';
  if (directVersion) {
    return directVersion;
  }
  const buildVersion =
    typeof payload.build?.version === 'string'
      ? payload.build.version.trim()
      : '';
  return buildVersion || undefined;
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function fromOneZero(value: unknown): boolean | undefined {
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  return undefined;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map(item => prune(item))
      .filter(item => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (value != null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = prune(child);
      if (next !== undefined) {
        output[key] = next;
      }
    }
    return Object.keys(output).length > 0 ? output : undefined;
  }

  if (value === undefined || value === '') {
    return undefined;
  }
  return value;
}

function statusJsonObject(row: StatusRow): Record<string, unknown> {
  const structured = {
    status: 'ok',
    entity: 'status',
    config: {
      path: row.config_path,
      data_dir: row.data_dir,
    },
    connection: {
      configured: fromOneZero(row.server_configured),
      url: row.server_url,
      logged_in: fromOneZero(row.server_logged_in),
      reachable: fromOneZero(row.server_reachable),
      version: row.server_version,
      error: row.server_error,
    },
    budget: {
      active_id: row.active_budget_id,
      active_name: row.active_budget_name,
      group_id: row.active_budget_group_id,
      cloud_file_id: row.active_budget_cloud_file_id,
      state: row.active_budget_state,
      local: fromOneZero(row.active_budget_local),
      remote_linked: fromOneZero(row.active_budget_remote_linked),
      type: row.budget_type,
      loaded: fromOneZero(row.budget_loaded),
      load_error: row.budget_load_error,
      count: {
        total: row.budgets_total_count,
        local: row.budgets_local_count,
        remote_only: row.budgets_remote_only_count,
      },
    },
    metrics: {
      accounts: {
        total: row.accounts_total,
        open: row.accounts_open,
        closed: row.accounts_closed,
        on_budget: row.accounts_on_budget,
        off_budget: row.accounts_off_budget,
        open_on_budget: row.accounts_open_on_budget,
        open_off_budget: row.accounts_open_off_budget,
        current_total: row.accounts_current_total,
      },
      categories: {
        groups: row.category_groups_total,
        total: row.categories_total,
      },
      payees: {
        total: row.payees_total,
      },
      rules: {
        total: row.rules_total,
      },
      schedules: {
        total: row.schedules_total,
        upcoming: row.schedules_upcoming,
        overdue: row.schedules_overdue,
      },
      transactions: {
        total: row.transactions_total,
        uncategorized: row.transactions_uncategorized,
        unreconciled: row.transactions_unreconciled,
        latest_date: row.latest_transaction_date,
        earliest_date: row.earliest_transaction_date,
      },
    },
    sync: {
      pending: row.sync_pending,
    },
  };

  const pruned = prune(structured);
  return (pruned as Record<string, unknown>) ?? {};
}

function compactStatusObject(row: StatusRow): Record<string, unknown> {
  const compactRow: Record<string, unknown> = {};
  for (const field of COMPACT_STATUS_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== '') {
      compactRow[field] = value;
    }
  }
  return {
    status: 'ok',
    entity: 'status',
    compact: true,
    ...compactRow,
  };
}

function printStatusJson(
  row: StatusRow,
  options: { compact?: boolean } = {},
): void {
  printObject(
    options.compact ? compactStatusObject(row) : statusJsonObject(row),
  );
}

function printStatusTable(
  row: StatusRow,
  options: { compact?: boolean } = {},
): void {
  const compactSet = options.compact
    ? new Set<string>(COMPACT_STATUS_FIELDS)
    : null;
  const pairs: Array<{ key: string; value: string }> = [];
  for (const item of STATUS_PAIR_FIELDS) {
    if (compactSet && !compactSet.has(item.field)) {
      continue;
    }
    const value = row[item.field];
    if (value === undefined || value === '') {
      continue;
    }
    pairs.push({ key: item.key, value: String(value) });
  }
  printRowsTable(pairs, ['key', 'value']);
}

export function renderStatus(
  format: StatusFormat,
  row: StatusRow,
  options: { compact?: boolean } = {},
): void {
  if (format === 'table') {
    printStatusTable(row, options);
    return;
  }
  printStatusJson(row, options);
}

export function getStatusFormat(command: Command): StatusFormat {
  return getFormat(command);
}

export function resolveStatusSession(command: Command): StatusSession {
  const opts = command.optsWithGlobals() as {
    dataDir?: string;
    budget?: string;
    serverUrl?: string;
  };
  const config = readConfig();
  const dataDir = opts.dataDir ?? config.dataDir;
  if (!dataDir) {
    throw new Error("No config found. Run 'fscl init' to get started.");
  }
  return {
    dataDir,
    budgetId: opts.budget ?? config.activeBudgetId,
    serverURL: opts.serverUrl ?? process.env.FISCAL_SERVER_URL ?? config.serverURL,
    token: config.token,
  };
}

async function queryTransactionCount(filter?: Record<string, unknown>): Promise<number> {
  let query = api.q('transactions');
  if (filter) {
    query = query.filter(filter);
  }
  query = query.select([{ count: { $count: '$id' } }] as never);
  const result = await api.aqlQuery(query as Parameters<typeof api.aqlQuery>[0]);
  const rows = ((result as { data?: unknown }).data ?? []) as CountQueryResultRow[];
  return toNumber(rows[0]?.count) ?? 0;
}

async function queryTransactionBoundaryDate(
  direction: 'asc' | 'desc',
): Promise<string | undefined> {
  const query = api
    .q('transactions')
    .select(['date'])
    .orderBy({ date: direction })
    .limit(1);
  const result = await api.aqlQuery(query as Parameters<typeof api.aqlQuery>[0]);
  const rows = ((result as { data?: unknown }).data ?? []) as Array<
    Record<string, unknown>
  >;
  return typeof rows[0]?.date === 'string' ? rows[0].date : undefined;
}

async function collectBudgetMetrics(
  row: StatusRow,
  session: StatusSession,
): Promise<void> {
  const budgets = budgetRows(await api.getBudgets());
  const localBudgets = budgets.filter(item => Boolean(item.id));
  const remoteOnlyBudgets = budgets.filter(item => item.group_id && !item.id);
  const activeBudget = session.budgetId
    ? budgets.find(item => item.id === session.budgetId)
    : undefined;

  row.budgets_local_count = localBudgets.length;
  row.budgets_remote_only_count = remoteOnlyBudgets.length;
  row.budgets_total_count = budgets.length;
  row.active_budget_id = session.budgetId;
  row.active_budget_name = activeBudget?.name;
  row.active_budget_group_id = activeBudget?.group_id;
  row.active_budget_cloud_file_id = activeBudget?.cloud_file_id;
  row.active_budget_state = activeBudget?.state;
  row.active_budget_local = activeBudget ? 1 : 0;
  row.active_budget_remote_linked = activeBudget?.group_id ? 1 : 0;
  if (!session.serverURL || !activeBudget?.group_id) {
    row.sync_pending = 0;
  }

  if (!session.budgetId) {
    row.budget_loaded = 0;
    row.budget_load_error = 'No active budget selected';
    return;
  }

  if (!activeBudget) {
    row.budget_loaded = 0;
    row.budget_load_error =
      `Active budget '${session.budgetId}' is missing locally. ` +
      "Run 'fscl budgets use <id>' or pull it again with 'fscl budgets pull <syncId>'.";
    return;
  }

  try {
    await api.loadBudget(session.budgetId);
    row.budget_loaded = 1;
    const prefs = (await api.internal.send('preferences/get', undefined)) as
      | Record<string, unknown>
      | undefined;
    row.budget_type = (prefs?.budgetType as string) ?? 'envelope';
  } catch (error) {
    row.budget_loaded = 0;
    row.budget_load_error =
      error instanceof Error ? error.message : 'Failed to load active budget';
    return;
  }

  const [
    accounts,
    categoryGroups,
    categories,
    payees,
    rules,
    schedules,
    totalCount,
    uncategorizedCount,
    unreconciledCount,
    latestTransactionDate,
    earliestTransactionDate,
  ] = await Promise.all([
    api.getAccounts() as Promise<Array<Record<string, unknown>>>,
    api.getCategoryGroups() as Promise<Array<Record<string, unknown>>>,
    api.getCategories() as Promise<Array<Record<string, unknown>>>,
    api.getPayees() as Promise<Array<Record<string, unknown>>>,
    api.getRules() as Promise<Array<Record<string, unknown>>>,
    api.getSchedules() as Promise<Array<Record<string, unknown>>>,
    queryTransactionCount(),
    queryTransactionCount({ category: null }),
    queryTransactionCount({ reconciled: false }),
    queryTransactionBoundaryDate('desc'),
    queryTransactionBoundaryDate('asc'),
  ]);

  const openAccounts = accounts.filter(account => !toBool(account.closed));
  const closedAccounts = accounts.filter(account => toBool(account.closed));
  const offBudgetAccounts = accounts.filter(account => toBool(account.offbudget));
  const onBudgetAccounts = accounts.filter(account => !toBool(account.offbudget));
  const openOnBudgetAccounts = openAccounts.filter(
    account => !toBool(account.offbudget),
  );
  const openOffBudgetAccounts = openAccounts.filter(account =>
    toBool(account.offbudget),
  );
  const accountCurrentTotal = accounts.reduce((sum, account) => {
    return sum + (toNumber(account.balance_current) ?? 0);
  }, 0);
  const today = new Date().toISOString().slice(0, 10);
  const schedulesWithNextDate = schedules.filter(
    item => typeof item.next_date === 'string' && item.next_date !== '',
  );
  const schedulesUpcoming = schedulesWithNextDate.filter(
    item => String(item.next_date) >= today,
  );
  const schedulesOverdue = schedulesWithNextDate.filter(
    item => String(item.next_date) < today,
  );

  row.accounts_total = accounts.length;
  row.accounts_open = openAccounts.length;
  row.accounts_closed = closedAccounts.length;
  row.accounts_on_budget = onBudgetAccounts.length;
  row.accounts_off_budget = offBudgetAccounts.length;
  row.accounts_open_on_budget = openOnBudgetAccounts.length;
  row.accounts_open_off_budget = openOffBudgetAccounts.length;
  row.accounts_current_total = accountCurrentTotal;
  row.category_groups_total = categoryGroups.length;
  row.categories_total = categories.length;
  row.payees_total = payees.length;
  row.rules_total = rules.length;
  row.schedules_total = schedules.length;
  row.schedules_upcoming = schedulesUpcoming.length;
  row.schedules_overdue = schedulesOverdue.length;
  row.transactions_total = totalCount;
  row.transactions_uncategorized = uncategorizedCount;
  row.transactions_unreconciled = unreconciledCount;
  row.latest_transaction_date = latestTransactionDate;
  row.earliest_transaction_date = earliestTransactionDate;
}

export async function collectStatus(session: StatusSession): Promise<StatusRow> {
  const row: StatusRow = {
    config_path: getConfigPath(),
    data_dir: session.dataDir,
    server_configured: session.serverURL ? 1 : 0,
    server_url: session.serverURL,
    server_logged_in: session.token ? 1 : 0,
    active_budget_id: session.budgetId,
    sync_pending: session.serverURL ? 'unknown' : 0,
  };

  await withApi(
    {
      dataDir: session.dataDir,
      serverURL: '',
    },
    async () => {
      await collectBudgetMetrics(row, session);
    },
  );

  if (!session.serverURL) {
    return row;
  }
  const serverURL = session.serverURL;

  const activeBudgetMissingLocally =
    Boolean(session.budgetId) && row.active_budget_local !== 1;

  if (activeBudgetMissingLocally) {
    row.server_error =
      'Skipped server connectivity check because the active budget is missing locally.';
    return row;
  }

  try {
    await withApi(
      {
        dataDir: session.dataDir,
        serverURL,
        token: session.token,
      },
      async () => {
        await collectBudgetMetrics(row, session);
        row.server_reachable = 1;

        if (row.budget_loaded === 1) {
          const version = await fetchServerVersion(serverURL);
          if (version) {
            row.server_version = version;
          }
        }
      },
    );
    return row;
  } catch (error) {
    row.server_reachable = 0;
    if (isAuthError(error)) {
      row.server_logged_in = 0;
      row.server_error = "Not logged in. Run 'fscl login' to authenticate.";
      return row;
    }
    row.server_error =
      error instanceof Error ? error.message : 'Failed to connect to configured server';
    return row;
  }
}

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show active budget, connectivity, and summary metrics')
    .option('--compact', 'Emit compact status fields for routine check-ins')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const options = cmd.optsWithGlobals() as { compact?: boolean };
        const session = resolveStatusSession(cmd);
        const row = await collectStatus(session);
        renderStatus(getStatusFormat(cmd), row, {
          compact: Boolean(options.compact),
        });
      }),
    );
}
