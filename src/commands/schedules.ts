import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import { commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import {
  readMetadata,
  ScheduleReviewInputSchema,
  upsertScheduleReview,
} from '../metadata.js';
import { printRows, printStatusOk } from '../output.js';
import {
  buildNameMaps,
  enrichRows,
  getActionCommand,
  parseJsonWithSchema,
  requireYes,
} from './common.js';

const ScheduleCreateSchema = z.record(z.string(), z.unknown()).refine(
  value => Object.keys(value).length > 0,
  { message: 'Schedule payload must be a JSON object' },
);

const ScheduleUpdateSchema = z.record(z.string(), z.unknown()).refine(
  value => Object.keys(value).length > 0,
  { message: 'Schedule update payload must be a non-empty JSON object' },
);

const SCHEDULE_COLUMNS = [
  'id',
  'name',
  'posts_transaction',
  'next_date',
  'amount',
  'amount_op',
  'account',
  'account_name',
  'payee',
  'payee_name',
  'date',
] as const;

function mapScheduleRow(
  schedule: Record<string, unknown>,
  accountNames: Map<string, string>,
  payeeNames: Map<string, string>,
) {
  return {
    id: schedule.id,
    name: schedule.name,
    posts_transaction: schedule.posts_transaction,
    next_date: schedule.next_date,
    amount: schedule.amount,
    amount_op: schedule.amountOp,
    account: schedule.account,
    account_name:
      typeof schedule.account === 'string'
        ? accountNames.get(schedule.account) ?? ''
        : '',
    payee: schedule.payee,
    payee_name:
      typeof schedule.payee === 'string'
        ? payeeNames.get(schedule.payee) ?? ''
        : '',
    date: JSON.stringify(schedule.date),
  };
}

function findScheduleById(
  schedules: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  const found = schedules.find(s => s.id === id);
  if (!found) {
    throw new Error(
      `Schedule '${id}' not found. Run 'fscl schedules list' to see available schedules.`,
    );
  }
  return found;
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayLocalDateString(): string {
  return toLocalDateString(new Date());
}

function utcMidnightMs(dateStr: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const [yearPart, monthPart, dayPart] = dateStr.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day);
}

function addDays(dateStr: string, days: number): string {
  const ms = utcMidnightMs(dateStr);
  if (ms == null) {
    return dateStr;
  }
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr: string, months: number): string {
  const ms = utcMidnightMs(dateStr);
  if (ms == null) {
    return dateStr;
  }
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function dayDiff(fromDate: string, toDate: string): number | null {
  const fromMs = utcMidnightMs(fromDate);
  const toMs = utcMidnightMs(toDate);
  if (fromMs == null || toMs == null) {
    return null;
  }
  return Math.round((toMs - fromMs) / 86400000);
}

function toMonthlyAmount(amount: number, frequency: string, interval: number): number {
  switch (frequency) {
    case 'daily':
      return Math.round((amount * 365.25) / 12 / interval);
    case 'weekly':
      return Math.round((amount * 52) / 12 / interval);
    case 'monthly':
      return Math.round(amount / interval);
    case 'yearly':
      return Math.round(amount / (12 * interval));
    default:
      return amount;
  }
}

export function registerScheduleCommands(program: Command) {
  const schedules = program
    .command('schedules')
    .description('Manage schedules');

  schedules
    .command('list')
    .description('List schedules')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules list

Output columns: id, name, posts_transaction, next_date, amount, amount_op,
  account, account_name, payee, payee_name, date (JSON recurrence pattern)

Amounts are integer minor units. The date column is a JSON object describing
the recurrence (frequency, interval, start, etc.).`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const [list, { accountNames, payeeNames }] = await Promise.all([
            api.getSchedules() as Promise<Array<Record<string, unknown>>>,
            buildNameMaps(),
          ]);

          const rows = list.map(s => mapScheduleRow(s, accountNames, payeeNames));
          printRows(format, 'schedules', rows, [...SCHEDULE_COLUMNS]);
        });
      }),
    );

  schedules
    .command('find <names...>')
    .description('Find schedules by name (case-insensitive, multiple search terms)')
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
          const [list, { accountNames, payeeNames }] = await Promise.all([
            api.getSchedules() as Promise<Array<Record<string, unknown>>>,
            buildNameMaps(),
          ]);
          const matched = list.filter(row => {
            if (typeof row.name !== 'string') return false;
            const lower = row.name.toLowerCase();
            return needles.some(needle => lower.includes(needle));
          });
          const rows = matched.map(s => mapScheduleRow(s, accountNames, payeeNames));
          printRows(format, 'schedules-find', rows, [...SCHEDULE_COLUMNS], {
            query: needles.join(','),
            matches: rows.length,
          });
        });
      }),
    );

  schedules
    .command('upcoming')
    .description('Show schedules due within N days')
    .option('--days <n>', 'Number of days to look ahead', '7')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules upcoming
  fiscal schedules upcoming --days 14

Shows schedules with next_date between today and today+N days, sorted by
next_date ascending. Adds a days_until column.`,
    )
    .action(
      commandAction(async (options: { days?: string }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        const days = Number(options.days ?? 7);
        if (!Number.isFinite(days) || days < 0) {
          throw new Error('--days must be a non-negative number');
        }
        await withBudget(session, async () => {
          const today = todayLocalDateString();
          const cutoff = addDays(today, days);
          const [list, { accountNames, payeeNames }] = await Promise.all([
            api.getSchedules() as Promise<Array<Record<string, unknown>>>,
            buildNameMaps(),
          ]);
          const upcoming = list
            .filter(s => {
              const nd = String(s.next_date ?? '');
              return nd >= today && nd <= cutoff;
            })
            .sort((a, b) =>
              String(a.next_date ?? '').localeCompare(String(b.next_date ?? '')),
            );
          const rows = upcoming.map(s => {
            const base = mapScheduleRow(s, accountNames, payeeNames);
            const nd = String(s.next_date ?? '');
            const diff = dayDiff(today, nd);
            return { ...base, days_until: diff };
          });
          printRows(format, 'schedules-upcoming', rows, [
            ...SCHEDULE_COLUMNS,
            'days_until',
          ], { days, as_of: today });
        });
      }),
    );

  schedules
    .command('missed')
    .description('Show overdue schedules')
    .option('--days <n>', 'Number of days to look back', '30')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules missed
  fiscal schedules missed --days 60

Shows schedules with next_date before today (within lookback window), sorted
by next_date ascending. Adds a days_overdue column.`,
    )
    .action(
      commandAction(async (options: { days?: string }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        const days = Number(options.days ?? 30);
        if (!Number.isFinite(days) || days < 0) {
          throw new Error('--days must be a non-negative number');
        }
        await withBudget(session, async () => {
          const today = todayLocalDateString();
          const cutoff = addDays(today, -days);
          const [list, { accountNames, payeeNames }] = await Promise.all([
            api.getSchedules() as Promise<Array<Record<string, unknown>>>,
            buildNameMaps(),
          ]);
          const overdue = list
            .filter(s => {
              const nd = String(s.next_date ?? '');
              return nd !== '' && nd < today && nd >= cutoff;
            })
            .sort((a, b) =>
              String(a.next_date ?? '').localeCompare(String(b.next_date ?? '')),
            );
          const rows = overdue.map(s => {
            const base = mapScheduleRow(s, accountNames, payeeNames);
            const nd = String(s.next_date ?? '');
            const diff = dayDiff(nd, today);
            return { ...base, days_overdue: diff };
          });
          printRows(format, 'schedules-missed', rows, [
            ...SCHEDULE_COLUMNS,
            'days_overdue',
          ], { days, as_of: today });
        });
      }),
    );

  schedules
    .command('summary')
    .description('Show all recurring costs with monthly/annual totals')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules summary

Computes monthly_amount and annual_amount from each schedule's recurrence
frequency/interval. Output includes total_monthly and total_annual in metadata.
Amounts are integer minor units.`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const [list, { accountNames, payeeNames }] = await Promise.all([
            api.getSchedules() as Promise<Array<Record<string, unknown>>>,
            buildNameMaps(),
          ]);

          let totalMonthly = 0;
          let totalAnnual = 0;
          const rows = list.map(s => {
            const date = s.date as Record<string, unknown> | undefined;
            const frequency = typeof date?.frequency === 'string' ? date.frequency : 'monthly';
            const interval = typeof date?.interval === 'number' ? date.interval : 1;
            const amount = typeof s.amount === 'number' ? s.amount : 0;

            const monthly = toMonthlyAmount(amount, frequency, interval);
            const annual = monthly * 12;
            totalMonthly += monthly;
            totalAnnual += annual;

            return {
              id: s.id,
              name: s.name,
              payee_name:
                typeof s.payee === 'string'
                  ? payeeNames.get(s.payee) ?? ''
                  : '',
              account_name:
                typeof s.account === 'string'
                  ? accountNames.get(s.account) ?? ''
                  : '',
              amount,
              frequency,
              interval,
              monthly_amount: monthly,
              annual_amount: annual,
              next_date: s.next_date,
            };
          });
          printRows(format, 'schedules-summary', rows, [
            'id',
            'name',
            'payee_name',
            'account_name',
            'amount',
            'frequency',
            'interval',
            'monthly_amount',
            'annual_amount',
            'next_date',
          ], {
            total_monthly: totalMonthly,
            total_annual: totalAnnual,
          });
        });
      }),
    );

  schedules
    .command('history <id>')
    .description('Show transaction history for a schedule')
    .option('--limit <n>', 'Maximum transactions to show', '12')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules history <schedule-id>
  fiscal schedules history <schedule-id> --limit 5

Shows recent transactions linked to the schedule, sorted by date descending.`,
    )
    .action(
      commandAction(async (id: string, options: { limit?: string }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        const limit = Number(options.limit ?? 12);
        if (!Number.isFinite(limit) || limit < 1) {
          throw new Error('--limit must be a positive number');
        }
        await withBudget(session, async () => {
          const [allSchedules, { accountNames, categoryNames, payeeNames }] =
            await Promise.all([
              api.getSchedules() as Promise<Array<Record<string, unknown>>>,
              buildNameMaps(),
            ]);
          const schedule = findScheduleById(allSchedules, id);

          const query = api
            .q('transactions')
            .filter({ schedule: id })
            .select(['*'])
            .orderBy({ date: 'desc' })
            .limit(limit);
          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          const rows = (
            (result as { data?: unknown }).data ?? []
          ) as Array<Record<string, unknown>>;

          enrichRows(rows, accountNames, categoryNames, payeeNames);

          printRows(format, 'schedules-history', rows, [
            'id',
            'date',
            'amount',
            'payee',
            'payee_name',
            'account',
            'account_name',
            'category',
            'category_name',
            'notes',
          ], {
            schedule_id: id as string,
            schedule_name: (schedule.name ?? '') as string,
          });
        });
      }),
    );

  schedules
    .command('review <id> <reviewJson>')
    .description('Record a review decision for a schedule')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules review <schedule-id> '{"decision":"keep","note":"still using"}'
  fiscal schedules review <schedule-id> '{"decision":"cancel","note":"switching to competitor"}'
  fiscal schedules review <schedule-id> '{"decision":"keep","cadenceMonths":6}'

Valid decisions: keep, cancel, pause
cadenceMonths sets how many months until next review (default: 3).
Reviews are stored in fiscal.json alongside the budget.`,
    )
    .action(
      commandAction(async (id: string, reviewJson: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const input = parseJsonWithSchema(
          reviewJson,
          ScheduleReviewInputSchema,
          'schedule review',
        );
        await withBudget(session, async resolved => {
          const allSchedules = (await api.getSchedules()) as Array<
            Record<string, unknown>
          >;
          findScheduleById(allSchedules, id);

          const today = todayLocalDateString();
          const cadence = input.cadenceMonths ?? 3;
          const nextReviewAt = addMonths(today, cadence);

          upsertScheduleReview(resolved.dataDir, resolved.budgetId!, id, {
            decision: input.decision,
            reviewedAt: today,
            nextReviewAt,
            cadenceMonths: cadence,
            note: input.note,
          });

          printStatusOk({
            entity: 'schedule-review',
            action: 'review',
            schedule_id: id,
            decision: input.decision,
            next_review_at: nextReviewAt,
          });
        });
      }),
    );

  schedules
    .command('reviews')
    .description('Show review status for all schedules')
    .option('--due', 'Only show unreviewed or due-for-review schedules')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules reviews
  fiscal schedules reviews --due

Shows review status for all schedules, joined with live schedule data.
With --due, only shows schedules that have never been reviewed or whose
next_review_at has passed.`,
    )
    .action(
      commandAction(async (options: { due?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async resolved => {
          const today = todayLocalDateString();
          const [allSchedules, { accountNames, payeeNames }] = await Promise.all(
            [
              api.getSchedules() as Promise<Array<Record<string, unknown>>>,
              buildNameMaps(),
            ],
          );
          const metadata = readMetadata(resolved.dataDir, resolved.budgetId!);
          const reviews = metadata.scheduleReviews;

          let rows = allSchedules.map(s => {
            const review = reviews[String(s.id)];
            const nextReview = review?.nextReviewAt ?? null;
            const daysUntilReview = nextReview ? dayDiff(today, nextReview) : null;
            return {
              schedule_id: s.id,
              name: s.name,
              payee_name:
                typeof s.payee === 'string'
                  ? payeeNames.get(s.payee) ?? ''
                  : '',
              account_name:
                typeof s.account === 'string'
                  ? accountNames.get(s.account) ?? ''
                  : '',
              amount: s.amount,
              decision: review?.decision ?? null,
              reviewed_at: review?.reviewedAt ?? null,
              next_review_at: nextReview,
              cadence_months: review?.cadenceMonths ?? null,
              note: review?.note ?? null,
              days_until_review: daysUntilReview,
            };
          });

          if (options.due) {
            rows = rows.filter(r => {
              if (r.decision === null) return true;
              if (r.next_review_at && r.next_review_at <= today) return true;
              return false;
            });
          }

          printRows(format, 'schedules-reviews', rows, [
            'schedule_id',
            'name',
            'payee_name',
            'amount',
            'decision',
            'reviewed_at',
            'next_review_at',
            'cadence_months',
            'note',
            'days_until_review',
          ], { as_of: today });
        });
      }),
    );

  schedules
    .command('create <scheduleJson>')
    .description('Create schedule from JSON')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules create '{"account":"acct-id","payee":"payee-id","amount":-1599,"date":{"frequency":"monthly","start":"2025-07-01","interval":1}}'

See Actual Budget docs for the full schedule/recurrence schema.`,
    )
    .action(
      commandAction(async (scheduleJson: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const schedule = parseJsonWithSchema(
          scheduleJson,
          ScheduleCreateSchema,
          'schedule payload',
        );
        await withBudget(
          { ...session, write: true },
          async () => {
            const id = await api.createSchedule(
              schedule as unknown as Parameters<typeof api.createSchedule>[0],
            );
            printStatusOk({ entity: 'schedule', action: 'create', id });
          },
        );
      }),
    );

  schedules
    .command('update <id> <fieldsJson>')
    .description('Update schedule fields from JSON')
    .addHelpText(
      'after',
      `
Example:
  fiscal schedules update sch-abc123 '{"amount":-1699}'`,
    )
    .action(
      commandAction(async (id: string, fieldsJson: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const fields = parseJsonWithSchema(
          fieldsJson,
          ScheduleUpdateSchema,
          'schedule update payload',
        );
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.updateSchedule(
              id,
              fields as unknown as Parameters<typeof api.updateSchedule>[1],
            );
            printStatusOk({ entity: 'schedule', action: 'update', id });
          },
        );
      }),
    );

  schedules
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete schedule')
    .action(
      commandAction(async (id: string, options: { yes?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a schedule');
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.deleteSchedule(id);
            printStatusOk({ entity: 'schedule', action: 'delete', id });
          },
        );
      }),
    );
}
