import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import {
  asDate,
  commandAction,
  getFormat,
  getSessionOptions,
} from '../cli.js';
import { parseAmount, withBudget } from '../budget.js';
import { printRows, printStatusOk } from '../output.js';
import {
  getActionCommand,
  parseJsonWithSchema,
  requireYes,
  resolveAccountId,
  resolveCategoryId,
} from './common.js';

type AccountCreateOptions = {
  offbudget?: boolean;
  balance?: string;
};

type AccountUpdateOptions = {
  name?: string;
  offbudget?: boolean;
};

type AccountCloseOptions = {
  transferTo?: string;
  transferCategory?: string;
};

type AccountBalanceOptions = {
  cutoff?: string;
};

type AccountDeleteOptions = {
  yes?: boolean;
};

const AccountBatchEntrySchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  offbudget: z.boolean().optional(),
  balance: z.union([z.string(), z.number()]).optional(),
}).strict();

const AccountBatchSchema = z.array(AccountBatchEntrySchema).min(
  1,
  'Expected a non-empty JSON array',
);

export function registerAccountCommands(program: Command) {
  const accounts = program.command('accounts').description('Manage accounts');

  accounts
    .command('list')
    .description('List accounts')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const rows = await api.getAccounts();
          printRows(format, 'accounts', rows as Record<string, unknown>[], [
            'id',
            'name',
            'offbudget',
            'closed',
            'balance_current',
          ]);
        });
      }),
    );

  accounts
    .command('find <names...>')
    .description('Find accounts by name (case-insensitive, multiple search terms)')
    .action(
      commandAction(async (names: string[], ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        await withBudget(session, async () => {
          const needles = names
            .map(n => n.trim().toLowerCase())
            .filter(Boolean);
          if (needles.length === 0) {
            throw new Error('Name search must be non-empty');
          }
          const all = (await api.getAccounts()) as Array<Record<string, unknown>>;
          const rows = all.filter(row => {
            if (typeof row.name !== 'string') return false;
            const lower = row.name.toLowerCase();
            return needles.some(needle => lower.includes(needle));
          });
          printRows(format, 'accounts-find', rows, [
            'id',
            'name',
            'offbudget',
            'closed',
            'balance_current',
          ], { query: needles.join(','), matches: rows.length });
        });
      }),
    );

  accounts
    .command('create <name>')
    .description('Create account')
    .option('--offbudget', 'Create as off-budget account')
    .option('--balance <amount>', 'Initial balance in decimal currency units')
    .action(
      commandAction(async (name: string, options: AccountCreateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const initialBalance =
              options.balance != null ? parseAmount(options.balance) : 0;
            const id = await api.createAccount(
              { name, offbudget: Boolean(options.offbudget) },
              initialBalance,
            );
            printStatusOk({ entity: 'account', action: 'create', id, name });
          },
        );
      }),
    );

  accounts
    .command('create-batch <json>')
    .description('Create multiple accounts from a JSON array')
    .addHelpText(
      'after',
      `
Example:
  fiscal accounts create-batch '[{"name":"Checking","balance":"1500.00"},{"name":"Savings","balance":"2500.00"},{"name":"Credit Card","offbudget":true}]'

Each entry requires: name
Optional: offbudget (boolean), balance (decimal string)`,
    )
    .action(
      commandAction(async (json: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const entries = parseJsonWithSchema(
          json,
          AccountBatchSchema,
          'accounts batch payload',
        );
        await withBudget(
          { ...session, write: true },
          async () => {
            const rows: Array<Record<string, unknown>> = [];
            for (const entry of entries) {
              const initialBalance =
                entry.balance != null ? parseAmount(String(entry.balance)) : 0;
              const id = await api.createAccount(
                {
                  name: entry.name,
                  offbudget: Boolean(entry.offbudget),
                },
                initialBalance,
              );
              rows.push({
                id,
                name: entry.name,
                offbudget: Boolean(entry.offbudget),
                balance: initialBalance,
              });
            }
            printRows(format, 'account-batch', rows, ['id', 'name', 'offbudget', 'balance'], {
              created: rows.length,
            });
          },
        );
      }),
    );

  accounts
    .command('update <id>')
    .description('Update account fields')
    .option('--name <name>', 'New account name')
    .option('--offbudget', 'Mark as off-budget')
    .option('--no-offbudget', 'Mark as on-budget')
    .action(
      commandAction(async (id: string, options: AccountUpdateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const fields: Record<string, unknown> = {};
        if (options.name != null) {
          fields.name = options.name;
        }
        if (options.offbudget !== undefined) {
          fields.offbudget = options.offbudget;
        }
        if (Object.keys(fields).length === 0) {
          throw new Error('No fields provided to update');
        }
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveAccountId(id);
            await api.updateAccount(resolvedId, fields);
            printStatusOk({ entity: 'account', action: 'update', id: resolvedId });
          },
        );
      }),
    );

  accounts
    .command('close <id>')
    .description('Close account')
    .option('--transfer-to <id>', 'Transfer balance to account id')
    .option('--transfer-category <id>', 'Category id for on->off budget transfers')
    .action(
      commandAction(async (id: string, options: AccountCloseOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveAccountId(id);
            const resolvedTransferTo = options.transferTo
              ? await resolveAccountId(options.transferTo)
              : undefined;
            const resolvedTransferCategory = options.transferCategory
              ? await resolveCategoryId(options.transferCategory)
              : undefined;
            await api.closeAccount(resolvedId, resolvedTransferTo, resolvedTransferCategory);
            printStatusOk({ entity: 'account', action: 'close', id: resolvedId });
          },
        );
      }),
    );

  accounts
    .command('reopen <id>')
    .description('Reopen account')
    .action(
      commandAction(async (id: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveAccountId(id);
            await api.reopenAccount(resolvedId);
            printStatusOk({ entity: 'account', action: 'reopen', id: resolvedId });
          },
        );
      }),
    );

  accounts
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete account')
    .action(
      commandAction(async (id: string, options: AccountDeleteOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting an account');
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveAccountId(id);
            await api.deleteAccount(resolvedId);
            printStatusOk({ entity: 'account', action: 'delete', id: resolvedId });
          },
        );
      }),
    );

  accounts
    .command('balance <id>')
    .description('Get account balance')
    .option('--cutoff <yyyy-mm-dd>', 'Balance at date cutoff')
    .action(
      commandAction(async (id: string, options: AccountBalanceOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const resolvedId = await resolveAccountId(id);
          const cutoff = options.cutoff
            ? new Date(`${asDate(options.cutoff)}T12:00:00`)
            : undefined;
          const balance = await api.getAccountBalance(resolvedId, cutoff);
          printStatusOk({
            entity: 'account-balance',
            id: resolvedId,
            balance_current: balance,
          });
        });
      }),
    );
}
