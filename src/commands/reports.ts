import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import { CliError, ErrorCodes, commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { printRows, printStatusOk } from '../output.js';
import {
  getActionCommand,
  parseJsonWithSchema,
  requireYes,
  send,
} from './common.js';

const RuleConditionSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.unknown(),
}).passthrough();

const ReportCreateSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  conditionsOp: z.enum(['and', 'or']).default('and'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isDateStatic: z.boolean().optional(),
  dateRange: z.string().optional(),
  mode: z.string().optional(),
  groupBy: z.string().optional(),
  interval: z.string().optional(),
  balanceType: z.string().optional(),
  sortBy: z.enum(['asc', 'desc', 'name', 'budget']).optional(),
  showEmpty: z.boolean().optional(),
  showOffBudget: z.boolean().optional(),
  showHiddenCategories: z.boolean().optional(),
  showUncategorized: z.boolean().optional(),
  trimIntervals: z.boolean().optional(),
  includeCurrentInterval: z.boolean().optional(),
  graphType: z.string().optional(),
  conditions: z.array(RuleConditionSchema).optional(),
});

const ReportUpdateSchema = ReportCreateSchema.extend({
  id: z.string().trim().min(1, 'id is required'),
});

type DeleteOptions = {
  yes?: boolean;
};

const LIST_COLUMNS = [
  'id',
  'name',
  'date_range',
  'mode',
  'group_by',
  'interval',
  'graph_type',
];

const SHOW_COLUMNS = [
  'id',
  'name',
  'start_date',
  'end_date',
  'is_date_static',
  'date_range',
  'mode',
  'group_by',
  'interval',
  'balance_type',
  'sort_by',
  'show_empty',
  'show_offbudget',
  'show_hidden',
  'show_uncategorized',
  'trim_intervals',
  'include_current',
  'graph_type',
  'conditions_op',
  'conditions',
];

async function fetchAllReports(): Promise<Array<Record<string, unknown>>> {
  const result = await api.aqlQuery(
    api.q('custom_reports')
      .filter({ tombstone: false })
      .select(['*']) as Parameters<typeof api.aqlQuery>[0],
  );
  return ((result as { data?: unknown }).data ?? []) as Array<Record<string, unknown>>;
}

async function fetchReportById(id: string): Promise<Record<string, unknown>> {
  const all = await fetchAllReports();
  const found = all.find(r => r.id === id);
  if (!found) {
    throw new CliError(
      `Report '${id}' not found. Run 'fscl reports list' to see available reports.`,
      ErrorCodes.ENTITY_NOT_FOUND,
    );
  }
  return found;
}

function normalizeReportRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    is_date_static: row.date_static === 1,
    show_empty: row.show_empty === 1,
    show_offbudget: row.show_offbudget === 1,
    show_hidden: row.show_hidden === 1,
    show_uncategorized: row.show_uncategorized === 1,
    trim_intervals: row.trim_intervals === 1,
    include_current: row.include_current === 1,
  };
}

export function registerReportCommands(program: Command) {
  const reports = program
    .command('reports')
    .description('Manage custom reports');

  reports
    .command('list')
    .description('List all custom reports')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const all = await fetchAllReports();
          const rows = all.map(r => ({
            id: r.id,
            name: r.name,
            date_range: r.date_range,
            mode: r.mode,
            group_by: r.group_by,
            interval: r.interval,
            graph_type: r.graph_type,
          }));
          printRows(format, 'reports', rows, LIST_COLUMNS);
        });
      }),
    );

  reports
    .command('show <id>')
    .description('Show full details of a custom report')
    .action(
      commandAction(async (id: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const row = await fetchReportById(id);
          const normalized = normalizeReportRow(row);
          printRows(format, 'report', [normalized], SHOW_COLUMNS);
        });
      }),
    );

  reports
    .command('create <json>')
    .description('Create a custom report from JSON (use @filepath to read from file)')
    .addHelpText(
      'after',
      `
Examples:
  fiscal reports create '{"name":"Monthly Expenses","conditionsOp":"and"}'
  fiscal reports create @report.json

Only "name" is required. All other fields use Actual's defaults.
JSON shape (camelCase): name, conditionsOp, startDate, endDate, isDateStatic,
  dateRange, mode, groupBy, interval, balanceType, sortBy, showEmpty,
  showOffBudget, showHiddenCategories, showUncategorized, trimIntervals,
  includeCurrentInterval, graphType, conditions`,
    )
    .action(
      commandAction(async (json: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const payload = parseJsonWithSchema(json, ReportCreateSchema, 'report payload');
        await withBudget({ ...session, write: true }, async () => {
          const id = (await send('report/create', payload)) as string;
          printStatusOk({ entity: 'report', action: 'create', id });
        });
      }),
    );

  reports
    .command('update <json>')
    .description('Update a custom report from JSON (use @filepath to read from file)')
    .addHelpText(
      'after',
      `
Examples:
  fiscal reports update '{"id":"...","name":"Updated Name","conditionsOp":"and"}'
  fiscal reports update @report.json

Both "id" and "name" are required. Include all fields you want to set.`,
    )
    .action(
      commandAction(async (json: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const payload = parseJsonWithSchema(json, ReportUpdateSchema, 'report payload');
        await withBudget({ ...session, write: true }, async () => {
          await fetchReportById(payload.id);
          await send('report/update', payload);
          printStatusOk({ entity: 'report', action: 'update', id: payload.id });
        });
      }),
    );

  reports
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete a custom report')
    .action(
      commandAction(async (id: string, options: DeleteOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a report');
        await withBudget({ ...session, write: true }, async () => {
          await fetchReportById(id);
          await send('report/delete', id);
          printStatusOk({ entity: 'report', action: 'delete', id });
        });
      }),
    );
}
