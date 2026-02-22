import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import {
  asMonth,
  commandAction,
  getFormat,
  getSessionOptions,
} from '../cli.js';
import { parseAmount, withBudget } from '../budget.js';
import { deleteDraft, readDraft, writeDraft } from '../drafts.js';
import { printDraftValidationErrors, printRows, printStatusOk } from '../output.js';
import {
  getActionCommand,
  parseBoolean,
  resolveCategoryId,
  send,
  validateCategoryId,
  validateCategoryIds,
} from './common.js';

const BudgetDraftEntrySchema = z.object({
  categoryId: z.string().min(1, 'categoryId is required'),
  group: z.string(),
  name: z.string(),
  amount: z.string().regex(
    /^-?\d+(\.\d{1,2})?$/,
    'Expected decimal string (e.g. "600.00")',
  ),
});

const BudgetDraftSchema = z.array(BudgetDraftEntrySchema).min(
  1,
  'Draft must contain at least one entry',
);

type StatusOptions = {
  month?: string;
  compare?: string;
  only?: string;
};

type BudgetCategoryRow = {
  month: string;
  group_id: string;
  group_name: string;
  category_id: string;
  category_name: string;
  budgeted: number;
  spent: number;
  balance: number;
};

const TemplateDraftEntrySchema = z.object({
  categoryId: z.string().trim().min(1, 'categoryId is required'),
  group: z.string().optional().default(''),
  name: z.string().optional().default(''),
  templates: z.array(z.record(z.string(), z.unknown())),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const TemplateDraftSchema = z.array(TemplateDraftEntrySchema);

async function fetchToBudget(month?: string): Promise<number | undefined> {
  const m = month ?? currentMonthString();
  const data = (await api.getBudgetMonth(m)) as Record<string, unknown>;
  const value = data.toBudget;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function currentMonthString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function previousMonths(month: string, count: number): string[] {
  const [yearPart, monthPart] = month.split('-');
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const result: string[] = [];
  for (let i = 1; i <= count; i++) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1));
    const prevYear = date.getUTCFullYear();
    const prevMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
    result.push(`${prevYear}-${prevMonth}`);
  }
  return result;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractBudgetRows(
  month: string,
  data: Record<string, unknown>,
): BudgetCategoryRow[] {
  const groups = Array.isArray(data.categoryGroups)
    ? (data.categoryGroups as Array<Record<string, unknown>>)
    : [];
  return groups.flatMap(group => {
    const groupId = typeof group.id === 'string' ? group.id : '';
    const groupName = typeof group.name === 'string' ? group.name : '';
    const categories = Array.isArray(group.categories)
      ? (group.categories as Array<Record<string, unknown>>)
      : [];
    return categories.map(category => ({
      month,
      group_id: groupId,
      group_name: groupName,
      category_id: typeof category.id === 'string' ? category.id : '',
      category_name: typeof category.name === 'string' ? category.name : '',
      budgeted: numberValue(category.budgeted),
      spent: numberValue(category.spent),
      balance: numberValue(category.balance),
    }));
  });
}

function templateFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function registerMonthCommands(program: Command) {
  const month = program.command('month').description('Manage monthly budget amounts');

  month
    .command('list')
    .description('List available budget months')
    .addHelpText(
      'after',
      `
Example:
  fiscal month list

Output columns: month (YYYY-MM format)`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const months = await api.getBudgetMonths();
          const rows = months.map(month => ({ month }));
          printRows(format, 'month-list', rows, ['month']);
        });
      }),
    );

  month
    .command('status')
    .option('--month <yyyy-mm>', 'Target month (default: current month)')
    .option('--compare <n>', 'Compare spent against previous N months average', '1')
    .option('--only <over|under|on>', 'Filter rows by budget status')
    .description('Show budget status with computed over/under and percent-used fields')
    .addHelpText(
      'after',
      `
Examples:
  fiscal month status
  fiscal month status --month 2025-07 --compare 3
  fiscal month status --only over

Output columns:
  month, group_id, group_name, category_id, category_name, budgeted, spent,
  remaining, percent_used, over_under, status, compare_months, prev_spent_avg, trend_delta`,
    )
    .action(
      commandAction(async (options: StatusOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);

        const month = options.month ? asMonth(options.month) : currentMonthString();
        const compareMonths = Number(options.compare ?? '1');
        if (!Number.isInteger(compareMonths) || compareMonths < 0) {
          throw new Error(`Invalid --compare value: ${options.compare}`);
        }
        const only = options.only?.toLowerCase();
        if (only && only !== 'over' && only !== 'under' && only !== 'on') {
          throw new Error(`Invalid --only value: ${options.only}`);
        }

        await withBudget(session, async () => {
          const monthData = (await api.getBudgetMonth(month)) as Record<string, unknown>;
          let rows = extractBudgetRows(month, monthData);

          if (rows.length === 0) {
            printStatusOk({
              entity: 'month-status',
              month,
              count: 0,
              toBudget: monthData.toBudget as number | undefined,
            });
            return;
          }

          const prevSpentByCategory = new Map<string, number[]>();
          for (const prevMonth of previousMonths(month, compareMonths)) {
            const prevData = (await api.getBudgetMonth(prevMonth)) as Record<
              string,
              unknown
            >;
            for (const prevRow of extractBudgetRows(prevMonth, prevData)) {
              if (!prevRow.category_id) {
                continue;
              }
              const values = prevSpentByCategory.get(prevRow.category_id) ?? [];
              values.push(prevRow.spent);
              prevSpentByCategory.set(prevRow.category_id, values);
            }
          }

          let computedRows = rows.map(row => {
            const prevValues = prevSpentByCategory.get(row.category_id) ?? [];
            const prevSpentAvg =
              prevValues.length > 0
                ? Math.round(
                    prevValues.reduce((sum, value) => sum + value, 0) /
                      prevValues.length,
                  )
                : null;
            const percentUsed =
              row.budgeted === 0
                ? null
                : Math.round(
                    (Math.abs(row.spent) / Math.abs(row.budgeted)) * 10000,
                  ) / 100;
            const status =
              row.balance < 0 ? 'over' : row.balance > 0 ? 'under' : 'on';
            return {
              ...row,
              remaining: row.balance,
              percent_used: percentUsed,
              over_under: row.balance,
              status,
              compare_months: prevValues.length,
              prev_spent_avg: prevSpentAvg,
              trend_delta:
                prevSpentAvg == null ? null : row.spent - prevSpentAvg,
            };
          });

          if (only) {
            computedRows = computedRows.filter(row => row.status === only);
          }

          printRows(format, 'month-status', computedRows, [
            'month',
            'group_id',
            'group_name',
            'category_id',
            'category_name',
            'budgeted',
            'spent',
            'remaining',
            'percent_used',
            'over_under',
            'status',
            'compare_months',
            'prev_spent_avg',
            'trend_delta',
          ], {
            month,
            toBudget: monthData.toBudget as number | undefined,
          });
        });
      }),
    );

  month
    .command('show <month>')
    .description('Show budget month summary and categories')
    .addHelpText(
      'after',
      `
Example:
  fiscal month show 2025-07

Output columns: month, group_id, group_name, category_id, category_name,
  budgeted, spent, balance

All amounts are integer minor units (e.g. 50000 = $500.00, -4599 = -$45.99).
Balance = budgeted + spent (spent is negative for expenses).`,
    )
    .action(
      commandAction(async (month: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const data = (await api.getBudgetMonth(asMonth(month))) as Record<
            string,
            unknown
          >;
          const groups = Array.isArray(data.categoryGroups)
            ? (data.categoryGroups as Array<Record<string, unknown>>)
            : [];

          const rows = groups.flatMap(group => {
            const categories = Array.isArray(group.categories)
              ? (group.categories as Array<Record<string, unknown>>)
              : [];
            return categories.map(category => ({
              month,
              group_id: group.id,
              group_name: group.name,
              category_id: category.id,
              category_name: category.name,
              budgeted: category.budgeted,
              spent: category.spent,
              balance: category.balance,
            }));
          });

          if (rows.length > 0) {
            printRows(format, 'month-show', rows, [
              'month',
              'group_id',
              'group_name',
              'category_id',
              'category_name',
              'budgeted',
              'spent',
              'balance',
            ], {
              month: asMonth(month),
              toBudget: data.toBudget as number | undefined,
            });
            return;
          }

          printStatusOk({
            entity: 'month-show',
            month,
            toBudget: data.toBudget as number | undefined,
          });
        });
      }),
    );

  month
    .command('draft <month>')
    .description('Generate a budget draft JSON file for editing')
    .addHelpText(
      'after',
      `
Example:
  fiscal month draft 2026-02

Writes a JSON file to <dataDir>/<budgetId>/drafts/budget-2026-02.json.
Edit the "amount" fields, then run 'fiscal month apply 2026-02' to commit.

Draft shape: [{ categoryId, group, name, amount }, ...]
Only categoryId and amount are used on apply. group and name are context.`,
    )
    .action(
      commandAction(async (month: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async resolved => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }
          const validatedMonth = asMonth(month);
          const data = (await api.getBudgetMonth(validatedMonth)) as Record<
            string,
            unknown
          >;
          const rows = extractBudgetRows(validatedMonth, data);

          const draftEntries = rows.map(row => ({
            categoryId: row.category_id,
            group: row.group_name,
            name: row.category_name,
            amount: (
              api.utils.integerToAmount(row.budgeted) as number
            ).toFixed(2),
          }));

          const filename = `budget-${validatedMonth}.json`;
          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            filename,
            draftEntries,
          );
          printStatusOk({
            entity: 'month-draft',
            action: 'create',
            month: validatedMonth,
            path: filePath,
            entries: draftEntries.length,
          });
        });
      }),
    );

  month
    .command('apply <month>')
    .option('--dry-run', 'Preview changes without applying')
    .description('Apply a budget draft JSON file')
    .addHelpText(
      'after',
      `
Example:
  fiscal month apply 2026-02
  fiscal month apply 2026-02 --dry-run

Reads <dataDir>/<budgetId>/drafts/budget-2026-02.json, validates with schema,
and sets budget amounts for each entry. Deletes the draft file on success.`,
    )
    .action(
      commandAction(
        async (month: string, options: { dryRun?: boolean }, ...args: unknown[]) => {
          const cmd = getActionCommand(args);
          const session = getSessionOptions(cmd);
          const format = getFormat(cmd);
          const dryRun = Boolean(options.dryRun);
          const validatedMonth = asMonth(month);
          const filename = `budget-${validatedMonth}.json`;

          await withBudget({ ...session, write: !dryRun }, async resolved => {
            if (!resolved.budgetId) {
              throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
            }
            const result = readDraft(
              resolved.dataDir,
              resolved.budgetId,
              filename,
              BudgetDraftSchema,
            );

            if (!result.ok) {
              printDraftValidationErrors('month-draft', result.errors);
              process.exitCode = 1;
              return;
            }

            await validateCategoryIds(result.data.map(e => e.categoryId));

            if (dryRun) {
              const previewRows = result.data.map(entry => ({
                category_id: entry.categoryId,
                group: entry.group,
                name: entry.name,
                amount: entry.amount,
                result: 'would-set',
              }));
              printRows(
                format,
                'month-apply-preview',
                previewRows,
                ['category_id', 'group', 'name', 'amount', 'result'],
                { month: validatedMonth, dryRun: 1 },
              );
              return;
            }

            const rows: Array<Record<string, unknown>> = [];
            for (const entry of result.data) {
              const intAmount = parseAmount(entry.amount);
              await api.setBudgetAmount(
                validatedMonth,
                entry.categoryId,
                intAmount,
              );
              rows.push({
                category_id: entry.categoryId,
                amount: intAmount,
              });
            }

            deleteDraft(resolved.dataDir, resolved.budgetId, filename);

            const toBudget = await fetchToBudget(validatedMonth);
            printRows(format, 'month-apply', rows, ['category_id', 'amount'], {
              month: validatedMonth,
              set: rows.length,
              toBudget,
            });
          });
        },
      ),
    );

  month
    .command('set <month> <categoryId> <amount>')
    .description('Set budget amount for category in month')
    .addHelpText(
      'after',
      `
Example:
  fiscal month set 2025-07 cat-groceries 500.00

Month format: YYYY-MM. Amount is a decimal string (e.g. 500.00 for $500.00).`,
    )
    .action(
      commandAction(async (month: string, categoryId: string, amount: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedCategoryId = await resolveCategoryId(categoryId);
            const validatedMonth = asMonth(month);
            await api.setBudgetAmount(validatedMonth, resolvedCategoryId, parseAmount(amount));
            const toBudget = await fetchToBudget(validatedMonth);
            printStatusOk({
              entity: 'month-set',
              action: 'set',
              month,
              categoryId: resolvedCategoryId,
              toBudget,
            });
          },
        );
      }),
    );

  month
    .command('set-carryover <month> <categoryId> <value>')
    .description('Enable or disable category carryover')
    .addHelpText(
      'after',
      `
Example:
  fiscal month set-carryover 2025-07 cat-groceries true

Value accepts: true/false, 1/0, yes/no.`,
    )
    .action(
      commandAction(async (month: string, categoryId: string, value: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedCategoryId = await resolveCategoryId(categoryId);
            await api.setBudgetCarryover(asMonth(month), resolvedCategoryId, parseBoolean(value));
            printStatusOk({
              entity: 'month-set',
              action: 'set-carryover',
              month,
              categoryId: resolvedCategoryId,
              value,
            });
          },
        );
      }),
    );

  const templates = month
    .command('templates')
    .description('Manage budget goal templates for categories');

  templates
    .command('check')
    .description('Validate configured budget templates')
    .addHelpText(
      'after',
      `
Example:
  fiscal month templates check`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const result = (await send('budget/check-templates')) as Record<
            string,
            unknown
          >;
          printStatusOk({
            entity: 'month-templates',
            action: 'check',
            type:
              typeof result.type === 'string' ? result.type : 'message',
            message:
              typeof result.message === 'string'
                ? result.message
                : 'Template check completed',
          });
        });
      }),
    );

  templates
    .command('run <month>')
    .option('--category <id>', 'Run only one category template')
    .description('Run template-driven budgeting for a month')
    .addHelpText(
      'after',
      `
Examples:
  fiscal month templates run 2026-02
  fiscal month templates run 2026-02 --category cat-groceries`,
    )
    .action(
      commandAction(
        async (month: string, options: { category?: string }, ...args: unknown[]) => {
          const cmd = getActionCommand(args);
          const session = getSessionOptions(cmd);
          await withBudget(
            { ...session, write: true },
            async () => {
              const normalizedMonth = asMonth(month);
              const resolvedCategory = options.category
                ? await resolveCategoryId(options.category)
                : undefined;
              const result = resolvedCategory
                ? ((await send('budget/apply-single-template', {
                    month: normalizedMonth,
                    category: resolvedCategory,
                  })) as Record<string, unknown>)
                : ((await send('budget/apply-goal-template', {
                    month: normalizedMonth,
                  })) as Record<string, unknown>);

              const toBudget = await fetchToBudget(normalizedMonth);
              printStatusOk({
                entity: 'month-templates',
                action: 'run',
                month: normalizedMonth,
                category: resolvedCategory,
                type:
                  typeof result.type === 'string' ? result.type : 'message',
                message:
                  typeof result.message === 'string'
                    ? result.message
                    : 'Templates run',
                toBudget,
              });
            },
          );
        },
      ),
    );

  templates
    .command('draft')
    .description('Generate a template draft JSON file for bulk editing')
    .addHelpText(
      'after',
      `
Example:
  fiscal month templates draft

Writes a JSON file to <dataDir>/<budgetId>/drafts/templates.json.
Each entry contains categoryId, group, name, templates, and _meta.
Edit templates in place, then run:
  fiscal month templates apply`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async resolved => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const groups = (await api.getCategoryGroups()) as Array<Record<string, unknown>>;
          const groupNames = new Map<string, string>();
          for (const group of groups) {
            if (typeof group.id === 'string' && typeof group.name === 'string') {
              groupNames.set(group.id, group.name);
            }
          }

          const categories = (await api.getCategories()) as Array<Record<string, unknown>>;
          const draftEntries: Array<Record<string, unknown>> = [];
          for (const category of categories) {
            if (typeof category.id !== 'string' || !category.id) {
              continue;
            }
            const categoryId = category.id;
            const result = (await send('budget/get-category-automations', categoryId)) as
              | Record<string, unknown>
              | undefined;
            const templatesForCategory = Array.isArray(result?.[categoryId])
              ? (result?.[categoryId] as Array<Record<string, unknown>>)
              : [];
            draftEntries.push({
              categoryId,
              group:
                typeof category.group_id === 'string'
                  ? (groupNames.get(category.group_id) ?? '')
                  : '',
              name: typeof category.name === 'string' ? category.name : '',
              templates: templatesForCategory,
              _meta: {
                templateCount: templatesForCategory.length,
              },
            });
          }

          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            'templates.json',
            draftEntries,
          );
          printStatusOk({
            entity: 'month-templates-draft',
            action: 'create',
            path: filePath,
            categories: draftEntries.length,
          });
        });
      }),
    );

  templates
    .command('apply')
    .option('--dry-run', 'Preview changes without applying')
    .description('Apply a template draft JSON file')
    .addHelpText(
      'after',
      `
Examples:
  fiscal month templates apply
  fiscal month templates apply --dry-run

Reads <dataDir>/<budgetId>/drafts/templates.json and sets template definitions
for categories. Skips unchanged entries. Deletes the draft file on success.`,
    )
    .action(
      commandAction(async (options: { dryRun?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const dryRun = Boolean(options.dryRun);

        await withBudget(
          { ...session, write: !dryRun },
          async resolved => {
            if (!resolved.budgetId) {
              throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
            }
            const result = readDraft(
              resolved.dataDir,
              resolved.budgetId,
              'templates.json',
              TemplateDraftSchema,
            );

            if (!result.ok) {
              printDraftValidationErrors('month-templates-draft', result.errors);
              process.exitCode = 1;
              return;
            }

            await validateCategoryIds(result.data.map(entry => entry.categoryId));

            const duplicates = new Set<string>();
            const seen = new Set<string>();
            for (const entry of result.data) {
              if (seen.has(entry.categoryId)) {
                duplicates.add(entry.categoryId);
              }
              seen.add(entry.categoryId);
            }
            if (duplicates.size > 0) {
              printDraftValidationErrors(
                'month-templates-draft',
                [...duplicates].map(categoryId => ({
                  path: '',
                  message: `Duplicate categoryId in draft: ${categoryId}`,
                })),
              );
              process.exitCode = 1;
              return;
            }

            const planned = [];
            for (const entry of result.data) {
              const currentResult = (await send('budget/get-category-automations', entry.categoryId)) as
                | Record<string, unknown>
                | undefined;
              const currentTemplates = Array.isArray(currentResult?.[entry.categoryId])
                ? (currentResult?.[entry.categoryId] as Array<Record<string, unknown>>)
                : [];
              const changed =
                templateFingerprint(entry.templates) !==
                templateFingerprint(currentTemplates);
              planned.push({
                categoryId: entry.categoryId,
                group: entry.group,
                name: entry.name,
                templates: entry.templates,
                action: changed ? 'update' : 'skip',
              });
            }

            if (dryRun) {
              const previewRows = planned.map(entry => ({
                category_id: entry.categoryId,
                group: entry.group,
                name: entry.name,
                templates: entry.templates.length,
                action: entry.action,
                result: entry.action === 'update' ? 'would-update' : 'would-skip',
              }));
              printRows(
                format,
                'month-templates-apply-preview',
                previewRows,
                ['category_id', 'group', 'name', 'templates', 'action', 'result'],
                {
                  dryRun: 1,
                  categories: planned.length,
                  updated: planned.filter(entry => entry.action === 'update').length,
                  skipped: planned.filter(entry => entry.action === 'skip').length,
                },
              );
              return;
            }

            const rows: Array<Record<string, unknown>> = [];
            let updatedCount = 0;
            let skippedCount = 0;
            for (const entry of planned) {
              if (entry.action === 'skip') {
                skippedCount += 1;
                rows.push({
                  category_id: entry.categoryId,
                  group: entry.group,
                  name: entry.name,
                  templates: entry.templates.length,
                  action: entry.action,
                  result: 'skipped',
                });
                continue;
              }
              await send('budget/set-category-automations', {
                categoriesWithTemplates: [{ id: entry.categoryId, templates: entry.templates }],
                source: 'ui',
              });
              updatedCount += 1;
              rows.push({
                category_id: entry.categoryId,
                group: entry.group,
                name: entry.name,
                templates: entry.templates.length,
                action: entry.action,
                result: 'updated',
              });
            }

            deleteDraft(resolved.dataDir, resolved.budgetId, 'templates.json');

            printRows(
              format,
              'month-templates-apply',
              rows,
              ['category_id', 'group', 'name', 'templates', 'action', 'result'],
              {
                categories: planned.length,
                updated: updatedCount,
                skipped: skippedCount,
              },
            );
          },
        );
      }),
    );

  month
    .command('cleanup <month>')
    .description('Run end-of-month cleanup for one month')
    .addHelpText(
      'after',
      `
Example:
  fiscal month cleanup 2026-02`,
    )
    .action(
      commandAction(async (month: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const normalizedMonth = asMonth(month);
            const result = (await send('budget/cleanup-goal-template', {
              month: normalizedMonth,
            })) as Record<string, unknown>;
            printStatusOk({
              entity: 'month-cleanup',
              action: 'run',
              month: normalizedMonth,
              type:
                typeof result.type === 'string' ? result.type : 'message',
              message:
                typeof result.message === 'string'
                  ? result.message
                  : 'Cleanup completed',
            });
          },
        );
      }),
    );

  month
    .command('copy <source> <target>')
    .description('Copy budget amounts from one month to another')
    .addHelpText(
      'after',
      `
Example:
  fiscal month copy 2026-01 2026-02

Copies all category budget amounts from the source month to the target month.
Existing amounts in the target month are overwritten.`,
    )
    .action(
      commandAction(async (source: string, target: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const sourceMonth = asMonth(source);
        const targetMonth = asMonth(target);

        await withBudget(
          { ...session, write: true },
          async () => {
            const data = (await api.getBudgetMonth(sourceMonth)) as Record<
              string,
              unknown
            >;
            const rows = extractBudgetRows(sourceMonth, data);

            if (rows.length === 0) {
              const toBudget = await fetchToBudget(targetMonth);
              printStatusOk({
                entity: 'month-copy',
                action: 'copy',
                source: sourceMonth,
                target: targetMonth,
                copied: 0,
                toBudget,
              });
              return;
            }

            const resultRows: Array<Record<string, unknown>> = [];
            for (const row of rows) {
              await api.setBudgetAmount(targetMonth, row.category_id, row.budgeted);
              resultRows.push({
                category_id: row.category_id,
                category_name: row.category_name,
                amount: row.budgeted,
              });
            }

            const toBudget = await fetchToBudget(targetMonth);
            printRows(format, 'month-copy', resultRows, ['category_id', 'category_name', 'amount'], {
              source: sourceMonth,
              target: targetMonth,
              copied: resultRows.length,
              toBudget,
            });
          },
        );
      }),
    );
}
