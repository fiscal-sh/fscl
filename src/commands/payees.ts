import * as api from '@actual-app/api';
import { Command } from 'commander';

import { asDate, commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { printRows, printStatusOk } from '../output.js';
import { buildNameMaps, getActionCommand, requireYes } from './common.js';

type UpdateOptions = { name?: string };

type StatsOptions = {
  since?: string;
  minCount?: string;
  extended?: boolean;
};

export function registerPayeeCommands(program: Command) {
  const payees = program.command('payees').description('Manage payees');

  payees
    .command('list')
    .description('List payees')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const rows = await api.getPayees();
          printRows(format, 'payees', rows as Record<string, unknown>[], [
            'id',
            'name',
            'transfer_acct',
          ]);
        });
      }),
    );

  payees
    .command('find <names...>')
    .description('Find payees by name (case-insensitive, multiple search terms)')
    .addHelpText(
      'after',
      `
Examples:
  fiscal payees find amazon
  fiscal payees find amzn amazon "whole foods"

Multiple terms are OR-matched: a payee matches if its name contains any term.`,
    )
    .action(
      commandAction(async (names: string[], ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const needles = names
            .map(n => n.trim().toLowerCase())
            .filter(Boolean);
          if (needles.length === 0) {
            throw new Error('Name search must be non-empty');
          }
          const all = (await api.getPayees()) as Array<Record<string, unknown>>;
          const rows = all.filter(row => {
            if (typeof row.name !== 'string') return false;
            const lower = row.name.toLowerCase();
            return needles.some(needle => lower.includes(needle));
          });
          printRows(format, 'payees-find', rows, [
            'id',
            'name',
            'transfer_acct',
          ], { query: needles.join(','), matches: rows.length });
        });
      }),
    );

  payees
    .command('stats')
    .option('--since <yyyy-mm-dd>', 'Only include transactions after this date')
    .option('--min-count <n>', 'Only include payees with at least N transactions')
    .option('--extended', 'Include avg_amount and last_amount columns')
    .description('Show per-payee transaction statistics')
    .addHelpText(
      'after',
      `
Example:
  fiscal payees stats
  fiscal payees stats --since 2025-01-01 --min-count 3

Output columns: id, name, txn_count, total, first_date, last_date
With --extended: adds avg_amount, last_amount.
Amounts are integer minor units. Sorted by transaction count descending.`,
    )
    .action(
      commandAction(async (options: StatsOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          let query = api.q('transactions')
            .select(['payee', 'amount', 'date'])
            .orderBy({ date: 'asc' });
          if (options.since) {
            query = query.filter({
              date: { $gte: asDate(options.since) },
            });
          }
          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          const txRows = ((result as { data?: unknown }).data ?? []) as Array<
            Record<string, unknown>
          >;

          const { payeeNames } = await buildNameMaps();

          const stats = new Map<
            string,
            {
              id: string;
              name: string;
              txn_count: number;
              total: number;
              first_date: string;
              last_date: string;
              last_amount: number;
            }
          >();
          for (const row of txRows) {
            if (typeof row.payee !== 'string' || !row.payee) {
              continue;
            }
            const payeeId = row.payee;
            const amount = typeof row.amount === 'number' ? row.amount : Number(row.amount ?? 0);
            const date = typeof row.date === 'string' ? row.date : '';
            if (!Number.isFinite(amount) || !date) {
              continue;
            }

            const existing = stats.get(payeeId);
            if (!existing) {
              stats.set(payeeId, {
                id: payeeId,
                name: payeeNames.get(payeeId) ?? '',
                txn_count: 1,
                total: amount,
                first_date: date,
                last_date: date,
                last_amount: amount,
              });
              continue;
            }

            existing.txn_count += 1;
            existing.total += amount;
            if (date < existing.first_date) {
              existing.first_date = date;
            }
            if (date >= existing.last_date) {
              existing.last_date = date;
              existing.last_amount = amount;
            }
          }

          const minCount = options.minCount ? Number(options.minCount) : 0;
          if (!Number.isInteger(minCount) || minCount < 0) {
            throw new Error(`Invalid --min-count value: ${options.minCount}`);
          }

          let rows = [...stats.values()].filter(row =>
            minCount > 0 ? row.txn_count >= minCount : true,
          );
          rows.sort((a, b) => {
            if (b.txn_count !== a.txn_count) {
              return b.txn_count - a.txn_count;
            }
            return b.last_date.localeCompare(a.last_date);
          });

          if (options.extended) {
            printRows(
              format,
              'payee-stats',
              rows.map(row => ({
                ...row,
                avg_amount:
                  row.txn_count > 0 ? Math.round(row.total / row.txn_count) : 0,
              })),
              [
                'id',
                'name',
                'txn_count',
                'total',
                'avg_amount',
                'last_amount',
                'first_date',
                'last_date',
              ],
            );
            return;
          }

          printRows(format, 'payee-stats', rows, [
            'id',
            'name',
            'txn_count',
            'total',
            'first_date',
            'last_date',
          ]);
        });
      }),
    );

  payees
    .command('create <name>')
    .description('Create payee')
    .action(
      commandAction(async (name: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const id = await api.createPayee({ name });
            printStatusOk({ entity: 'payee', action: 'create', id, name });
          },
        );
      }),
    );

  payees
    .command('update <id>')
    .option('--name <name>', 'New name')
    .description('Update payee')
    .action(
      commandAction(async (id: string, options: UpdateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        if (!options.name) {
          throw new Error('No fields provided to update');
        }
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.updatePayee(id, { name: options.name });
            printStatusOk({ entity: 'payee', action: 'update', id });
          },
        );
      }),
    );

  payees
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete payee')
    .action(
      commandAction(async (id: string, options: { yes?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a payee');
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.deletePayee(id);
            printStatusOk({ entity: 'payee', action: 'delete', id });
          },
        );
      }),
    );

  payees
    .command('merge <targetId> <mergeIds...>')
    .description('Merge payees into target')
    .action(
      commandAction(async (targetId: string, mergeIds: string[], ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.mergePayees(targetId, mergeIds);
            printStatusOk({
              entity: 'payee',
              action: 'merge',
              targetId,
              merged: mergeIds.length,
            });
          },
        );
      }),
    );
}
