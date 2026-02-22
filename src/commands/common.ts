import * as api from '@actual-app/api';
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { CliError, ErrorCodes } from '../cli.js';

export const send = (
  api.internal as unknown as {
    send: (name: string, args?: unknown) => Promise<unknown>;
  }
).send;

export type BudgetRow = {
  id?: string;
  name?: string;
  group_id?: string;
  cloud_file_id?: string;
  state?: string;
};

export function budgetRows(budgets: unknown[]): BudgetRow[] {
  return budgets.map(item => {
    const budget = item as Record<string, unknown>;
    return {
      id: typeof budget.id === 'string' ? budget.id : undefined,
      name: typeof budget.name === 'string' ? budget.name : undefined,
      group_id: typeof budget.groupId === 'string' ? budget.groupId : undefined,
      cloud_file_id:
        typeof budget.cloudFileId === 'string' ? budget.cloudFileId : undefined,
      state: typeof budget.state === 'string' ? budget.state : undefined,
    };
  });
}

function budgetIdentityKey(row: BudgetRow): string {
  if (row.group_id) {
    return `group:${row.group_id}`;
  }
  if (row.cloud_file_id) {
    return `cloud:${row.cloud_file_id}`;
  }
  if (row.id) {
    return `local:${row.id}`;
  }
  return `name:${row.name ?? ''}`;
}

function localState(row: BudgetRow): string {
  return row.group_id ? 'linked' : 'local';
}

export function budgetRowsForList(rows: BudgetRow[]): BudgetRow[] {
  const localRows = rows.filter(item => Boolean(item.id));
  const remoteOnlyRows = rows.filter(item => !item.id);

  const localByGroupId = new Map<string, BudgetRow>();
  const localByCloudFileId = new Map<string, BudgetRow>();
  for (const row of localRows) {
    if (row.group_id) {
      localByGroupId.set(row.group_id, row);
    }
    if (row.cloud_file_id) {
      localByCloudFileId.set(row.cloud_file_id, row);
    }
  }

  const matchedRemoteKeys = new Set<string>();
  for (const remote of remoteOnlyRows) {
    const key = budgetIdentityKey(remote);
    const localMatch =
      (remote.group_id && localByGroupId.get(remote.group_id)) ||
      (remote.cloud_file_id && localByCloudFileId.get(remote.cloud_file_id));
    if (!localMatch) {
      continue;
    }
    matchedRemoteKeys.add(key);
  }

  const mergedLocalRows = localRows.map(row => ({
    ...row,
    state: localState(row),
  }));

  const seenRemoteKeys = new Set<string>();
  const remainingRemoteRows = remoteOnlyRows
    .filter(remote => {
      const key = budgetIdentityKey(remote);
      if (matchedRemoteKeys.has(key) || seenRemoteKeys.has(key)) {
        return false;
      }
      seenRemoteKeys.add(key);
      return true;
    })
    .map(row => ({
      ...row,
      state: 'remote',
    }));

  return [...mergedLocalRows, ...remainingRemoteRows];
}

function toIdSet(rows: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id) {
      ids.add(row.id);
    }
  }
  return ids;
}

function assertEntityIdExists(
  id: string,
  ids: Set<string>,
  entity: string,
  listCommand: string,
  listLabel: string,
): void {
  if (ids.has(id)) {
    return;
  }
  throw new CliError(
    `${entity} '${id}' not found. Run '${listCommand}' to see available ${listLabel}.`,
    ErrorCodes.ENTITY_NOT_FOUND,
  );
}

export async function validateAccountId(id: string): Promise<void> {
  const accounts = (await api.getAccounts()) as Array<Record<string, unknown>>;
  assertEntityIdExists(id, toIdSet(accounts), 'Account', 'fscl accounts list', 'accounts');
}

export async function resolveAccountId(input: string): Promise<string> {
  const accounts = (await api.getAccounts()) as Array<Record<string, unknown>>;
  const ids = toIdSet(accounts);
  if (ids.has(input)) {
    return input;
  }
  return resolveEntityByName(input, accounts, 'Account', 'fscl accounts list', 'accounts');
}

export async function resolveCategoryId(input: string): Promise<string> {
  const categories = (await api.getCategories()) as Array<Record<string, unknown>>;
  const ids = toIdSet(categories);
  if (ids.has(input)) {
    return input;
  }
  return resolveEntityByName(input, categories, 'Category', 'fscl categories list', 'categories');
}

export async function resolveCategoryGroupId(input: string): Promise<string> {
  const groups = (await api.getCategoryGroups()) as Array<Record<string, unknown>>;
  const ids = toIdSet(groups);
  if (ids.has(input)) {
    return input;
  }
  return resolveEntityByName(input, groups, 'Category group', 'fscl categories list', 'category groups');
}

function resolveEntityByName(
  input: string,
  entities: Array<Record<string, unknown>>,
  entityLabel: string,
  listCommand: string,
  listLabel: string,
): string {
  const needle = input.toLowerCase();
  const matches = entities.filter(
    e => typeof e.name === 'string' && e.name.toLowerCase() === needle,
  );
  if (matches.length === 1 && typeof matches[0].id === 'string') {
    return matches[0].id;
  }
  if (matches.length > 1) {
    const ids = matches.map(e => String(e.id)).join(', ');
    throw new CliError(
      `Ambiguous ${entityLabel.toLowerCase()} name '${input}' matches ${matches.length} entities (${ids}). Use an ID instead. Run '${listCommand}' to see available ${listLabel}.`,
      ErrorCodes.ENTITY_NOT_FOUND,
    );
  }
  throw new CliError(
    `${entityLabel} '${input}' not found. Run '${listCommand}' to see available ${listLabel}.`,
    ErrorCodes.ENTITY_NOT_FOUND,
  );
}

export async function validateCategoryId(id: string): Promise<void> {
  const categories = (await api.getCategories()) as Array<Record<string, unknown>>;
  assertEntityIdExists(
    id,
    toIdSet(categories),
    'Category',
    'fscl categories list',
    'categories',
  );
}

export async function validateCategoryIds(ids: Iterable<string>): Promise<void> {
  const expected = [...new Set([...ids].filter(Boolean))];
  if (expected.length === 0) {
    return;
  }
  const categories = (await api.getCategories()) as Array<Record<string, unknown>>;
  const categoryIds = toIdSet(categories);
  for (const id of expected) {
    assertEntityIdExists(
      id,
      categoryIds,
      'Category',
      'fscl categories list',
      'categories',
    );
  }
}

export function requireYes(
  yes: boolean | undefined,
  actionDescription: string,
): void {
  if (yes) {
    return;
  }
  throw new Error(
    `${actionDescription} is destructive. Re-run with --yes to confirm.`,
  );
}

export async function buildNameMaps() {
  const [accounts, categories, payees] = await Promise.all([
    api.getAccounts() as Promise<Array<Record<string, unknown>>>,
    api.getCategories() as Promise<Array<Record<string, unknown>>>,
    api.getPayees() as Promise<Array<Record<string, unknown>>>,
  ]);
  const accountNames = new Map<string, string>();
  for (const a of accounts) {
    if (typeof a.id === 'string' && typeof a.name === 'string') {
      accountNames.set(a.id, a.name);
    }
  }
  const categoryNames = new Map<string, string>();
  for (const c of categories) {
    if (typeof c.id === 'string' && typeof c.name === 'string') {
      categoryNames.set(c.id, c.name);
    }
  }
  const payeeNames = new Map<string, string>();
  for (const p of payees) {
    if (typeof p.id === 'string' && typeof p.name === 'string') {
      payeeNames.set(p.id, p.name);
    }
  }
  return { accountNames, categoryNames, payeeNames };
}

export function enrichRows(
  rows: Array<Record<string, unknown>>,
  accountNames: Map<string, string>,
  categoryNames: Map<string, string>,
  payeeNames: Map<string, string>,
) {
  for (const row of rows) {
    row.account_name =
      typeof row.account === 'string'
        ? accountNames.get(row.account) ?? ''
        : '';
    row.category_name =
      typeof row.category === 'string'
        ? categoryNames.get(row.category) ?? ''
        : '';
    row.payee_name =
      typeof row.payee === 'string' ? payeeNames.get(row.payee) ?? '' : '';
  }
}

export function getActionCommand(args: unknown[]): Command {
  const cmd = args[args.length - 1];
  if (!cmd || typeof cmd !== 'object') {
    throw new Error('Unable to resolve command context');
  }
  return cmd as Command;
}

function resolveJsonInput(input: string): {
  text: string;
  source: 'inline' | 'file';
  filePath?: string;
} {
  const trimmed = input.trim();
  if (!trimmed.startsWith('@')) {
    return { text: input, source: 'inline' };
  }
  const filePath = trimmed.slice(1).trim();
  if (!filePath) {
    throw new Error('Invalid JSON source: expected "@<path>"');
  }
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read JSON file '${filePath}': ${error instanceof Error ? error.message : 'read failure'}`,
    );
  }
  return { text, source: 'file', filePath };
}

export function parseJson<T>(input: string): T {
  const resolved = resolveJsonInput(input);
  try {
    return JSON.parse(resolved.text) as T;
  } catch (error) {
    const sourceHint =
      resolved.source === 'file' ? ` in '${resolved.filePath}'` : '';
    throw new Error(
      `Invalid JSON${sourceHint}: ${error instanceof Error ? error.message : 'parse failure'}`,
    );
  }
}

function formatIssuePath(path: PropertyKey[]): string {
  return path
    .map(p => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');
}

export function parseJsonWithSchema<T>(
  input: string,
  schema: z.ZodType<T>,
  label = 'JSON input',
): T {
  const raw = parseJson<unknown>(input);
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const formatted = result.error.issues.map(issue => {
    const path = formatIssuePath(issue.path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new Error(`Invalid ${label}: ${formatted.join('; ')}`);
}

export function parseBoolean(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}
