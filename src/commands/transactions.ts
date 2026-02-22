import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import { asDate, commandAction, getFormat, getSessionOptions } from '../cli.js';
import { parseAmount, withBudget } from '../budget.js';
import { deleteDraft, readDraft, writeDraft } from '../drafts.js';
import {
  printDraftValidationErrors,
  printErrorMessages,
  printRows,
  printStatusErr,
  printStatusOk,
} from '../output.js';
import { parseAmountFields } from '../parsers/amounts.js';
import {
  detectCsvMappings,
  normalizeFieldRef,
  readCsvCell,
  type CsvFieldMappings,
} from '../parsers/csv.js';
import { dateFormats, detectDateFormat, parseDate, type DateFormat } from '../parsers/dates.js';
import { parseFile } from '../parsers/index.js';
import type {
  CsvTransaction,
  StructuredImportTransaction,
} from '../parsers/types.js';
import {
  buildNameMaps,
  enrichRows,
  getActionCommand,
  requireYes,
  resolveAccountId,
  resolveCategoryId,
  send,
  validateAccountId,
  validateCategoryId,
  validateCategoryIds,
} from './common.js';

type ListOptions = {
  start: string;
  end: string;
};

type AddOptions = {
  date: string;
  amount: string;
  payee?: string;
  category?: string;
  notes?: string;
  cleared?: boolean;
};

type ImportOptions = {
  reconcile?: boolean;
  dryRun?: boolean;
  showRows?: boolean;
  report?: boolean;
  clear?: boolean;
  importNotes?: boolean;
  fallbackPayeeToMemo?: boolean;
  dateFormat?: string;
  multiplier?: string;
  flipAmount?: boolean;
  csvHeader?: boolean;
  csvDelimiter?: string;
  csvDateCol?: string;
  csvAmountCol?: string;
  csvPayeeCol?: string;
  csvNotesCol?: string;
  csvCategoryCol?: string;
  csvInflowCol?: string;
  csvOutflowCol?: string;
  csvInoutCol?: string;
  csvOutValue?: string;
  csvSkipStart?: string;
  csvSkipEnd?: string;
};

const CategorizeDraftEntrySchema = z.object({
  id: z.string().min(1, 'Transaction ID is required'),
  category: z.string().min(1, 'Category is required — fill in the category ID'),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const CategorizeDraftSchema = z.array(CategorizeDraftEntrySchema).min(
  1,
  'Draft must contain at least one entry',
);

const EditDraftEntrySchema = z.object({
  id: z.string().min(1, 'Transaction ID is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  amount: z.string().regex(
    /^-?\d+(\.\d{1,2})?$/,
    'Expected decimal string (e.g. "-45.99")',
  ).optional(),
  payee: z.union([z.string().min(1), z.null()]).optional(),
  category: z.union([z.string().min(1), z.null()]).optional(),
  notes: z.union([z.string(), z.null()]).optional(),
  cleared: z.boolean().optional(),
  account: z.string().min(1).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const EditDraftSchema = z.array(EditDraftEntrySchema).min(
  1,
  'Draft must contain at least one entry',
);

type DeleteOptions = {
  yes?: boolean;
};

type UncategorizedOptions = {
  account?: string;
  start?: string;
  end?: string;
};

const TRANSACTION_COLUMNS = [
  'id',
  'date',
  'account',
  'account_name',
  'amount',
  'payee',
  'payee_name',
  'category',
  'category_name',
  'notes',
  'cleared',
  'reconciled',
  'transfer_id',
  'imported_id',
];

const DATE_FORMAT_HINT = `Supported formats: ${dateFormats.join(
  ' | ',
)}. Use --date-format <format> to override.`;

async function enrichTransactions(
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const { accountNames, categoryNames, payeeNames } = await buildNameMaps();
  enrichRows(rows, accountNames, categoryNames, payeeNames);
}

function computeDateRange(
  rows: Array<{ date?: string }>,
): { dateStart: string; dateEnd: string } {
  const dates = rows
    .map(row => row.date)
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .sort();
  return {
    dateStart: dates[0] ?? '',
    dateEnd: dates[dates.length - 1] ?? '',
  };
}

function parseDateFormat(input?: string): DateFormat | null {
  if (!input) {
    return null;
  }
  const normalized = input.toLowerCase() as DateFormat;
  return (dateFormats as string[]).includes(normalized) ? normalized : null;
}

function parseDateError(raw: unknown): string {
  return `Unable to parse date: ${String(raw ?? '')}. ${DATE_FORMAT_HINT}`;
}

function csvColumnsHint(rows: CsvTransaction[]): string {
  const first = rows[0];
  if (!first) {
    return 'Found columns: (none).';
  }
  if (Array.isArray(first)) {
    if (first.length === 0) {
      return 'Found columns by index: (none).';
    }
    return `Found columns by index: ${first.map((_, index) => index).join(', ')}.`;
  }
  const keys = Object.keys(first);
  return keys.length > 0
    ? `Found columns: ${keys.join(', ')}.`
    : 'Found columns: (none).';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

async function queryUncategorizedCount(accountId?: string): Promise<number> {
  let query = api.q('transactions').filter({ category: null });
  if (accountId) {
    query = query.filter({ account: accountId });
  }
  query = query.select([{ count: { $count: '$id' } }] as never);
  const result = await api.aqlQuery(query as Parameters<typeof api.aqlQuery>[0]);
  const rows = ((result as { data?: unknown }).data ?? []) as Array<{ count?: unknown }>;
  return toNumber(rows[0]?.count);
}

function mapCategoryId(
  categoryValue: unknown,
  categoriesByName: Map<string, string>,
): string | null {
  if (typeof categoryValue !== 'string' || !categoryValue.trim()) {
    return null;
  }
  const trimmed = categoryValue.trim();
  if (/^[a-f0-9-]{20,}$/i.test(trimmed)) {
    return trimmed;
  }
  return categoriesByName.get(trimmed.toLowerCase()) || null;
}

function csvMappingsFromOptions(
  options: ImportOptions,
  detected: CsvFieldMappings,
): CsvFieldMappings {
  return {
    date: normalizeFieldRef(options.csvDateCol) ?? detected.date,
    amount: normalizeFieldRef(options.csvAmountCol) ?? detected.amount,
    payee: normalizeFieldRef(options.csvPayeeCol) ?? detected.payee,
    notes: normalizeFieldRef(options.csvNotesCol) ?? detected.notes,
    category: normalizeFieldRef(options.csvCategoryCol) ?? detected.category,
    inflow: normalizeFieldRef(options.csvInflowCol) ?? detected.inflow,
    outflow: normalizeFieldRef(options.csvOutflowCol) ?? detected.outflow,
    inOut: normalizeFieldRef(options.csvInoutCol) ?? detected.inOut,
  };
}

function normalizeCsvTransactions(
  rows: CsvTransaction[],
  options: ImportOptions,
  categoriesByName: Map<string, string>,
): { transactions: StructuredImportTransaction[]; errors: string[] } {
  const detected = detectCsvMappings(rows);
  const mappings = csvMappingsFromOptions(options, detected);
  const errors: string[] = [];
  const transactions: StructuredImportTransaction[] = [];

  if (mappings.date == null) {
    throw new Error(
      `CSV date column not detected. Specify --csv-date-col <name|index>. ${csvColumnsHint(rows)}`,
    );
  }

  const splitMode = Boolean(mappings.inflow || mappings.outflow);
  const hasAmount = mappings.amount != null || splitMode;
  if (!hasAmount) {
    throw new Error(
      `CSV amount column not detected. Specify --csv-amount-col or --csv-inflow-col/--csv-outflow-col. ${csvColumnsHint(rows)}`,
    );
  }

  const inOutMode = Boolean(mappings.inOut);
  const outValue = options.csvOutValue ?? '';
  const multiplier = options.multiplier ?? '1';
  const flipAmount = Boolean(options.flipAmount);
  const importNotes = options.importNotes !== false;

  const firstRow: CsvTransaction = rows[0] ?? [];
  const sampleDate = String(readCsvCell(firstRow, mappings.date) ?? '');
  const dateFormat =
    parseDateFormat(options.dateFormat) || detectDateFormat(sampleDate);

  for (const row of rows) {
    const source: Record<string, unknown> = {
      amount: readCsvCell(row, mappings.amount),
      outflow: readCsvCell(row, mappings.outflow),
      inflow: readCsvCell(row, mappings.inflow),
      inOut: readCsvCell(row, mappings.inOut),
    };

    const parsed = parseAmountFields(
      source,
      splitMode,
      inOutMode,
      outValue,
      flipAmount,
      multiplier,
    );
    if (parsed.amount == null) {
      errors.push('Transaction has no amount');
      continue;
    }

    const rawDate = readCsvCell(row, mappings.date);
    const dateString = dateFormat
      ? parseDate(rawDate as string, dateFormat)
      : parseDate(rawDate as string, 'mm dd yyyy');
    if (!dateString) {
      errors.push(parseDateError(rawDate));
      continue;
    }

    const payee = readCsvCell(row, mappings.payee);
    const notes = readCsvCell(row, mappings.notes);
    const categoryRaw = readCsvCell(row, mappings.category);
    const category = mapCategoryId(categoryRaw, categoriesByName);

    transactions.push({
      date: dateString,
      amount: parsed.amount,
      payee_name:
        typeof payee === 'string' && payee.trim() ? payee.trim() : undefined,
      imported_payee:
        typeof payee === 'string' && payee.trim() ? payee.trim() : undefined,
      notes:
        importNotes && typeof notes === 'string' && notes.trim()
          ? notes
          : null,
      category,
    });
  }

  return { transactions, errors };
}

function normalizeStructuredTransactions(
  fileType: string,
  rows: StructuredImportTransaction[],
  options: ImportOptions,
  categoriesByName: Map<string, string>,
): { transactions: StructuredImportTransaction[]; errors: string[] } {
  const errors: string[] = [];
  const output: StructuredImportTransaction[] = [];
  const importNotes = options.importNotes !== false;

  const sample = rows[0]?.date ? String(rows[0].date) : '';
  const dateFormat =
    parseDateFormat(options.dateFormat) ||
    (fileType === 'qif' ? detectDateFormat(sample) : null);

  for (const tx of rows) {
    if (tx.amount == null) {
      errors.push('Transaction has no amount');
      continue;
    }
    const normalizedDate =
      fileType === 'qif' && dateFormat
        ? parseDate(String(tx.date ?? ''), dateFormat)
        : (tx.date as string | null);
    if (!normalizedDate) {
      errors.push(parseDateError(tx.date));
      continue;
    }
    output.push({
      ...tx,
      date: normalizedDate,
      notes: importNotes ? tx.notes ?? null : null,
      category: mapCategoryId(tx.category, categoriesByName),
    });
  }

  return { transactions: output, errors };
}

async function importTransactionsCommand(
  inputAccountId: string,
  filePath: string,
  options: ImportOptions,
  args: unknown[],
) {
  const cmd = getActionCommand(args);
  const session = getSessionOptions(cmd);
  const format = getFormat(cmd);
  const showRows = Boolean(options.showRows);
  const showReport = Boolean(options.report);
  await withBudget({ ...session, write: true }, async () => {
    const accountId = await resolveAccountId(inputAccountId);
    const categories = (await api.getCategories()) as Array<Record<string, unknown>>;
    const categoriesByName = new Map<string, string>();
    for (const category of categories) {
      const name = category.name;
      const id = category.id;
      if (typeof name === 'string' && typeof id === 'string') {
        categoriesByName.set(name.toLowerCase(), id);
      }
    }

    const parsed = await parseFile(filePath, {
      hasHeaderRow: options.csvHeader !== false,
      delimiter: options.csvDelimiter,
      fallbackMissingPayeeToMemo: Boolean(options.fallbackPayeeToMemo),
      skipStartLines: options.csvSkipStart ? Number(options.csvSkipStart) : 0,
      skipEndLines: options.csvSkipEnd ? Number(options.csvSkipEnd) : 0,
      importNotes: options.importNotes !== false,
    });

    const parseErrors = parsed.errors.map(error => error.message);
    if (parseErrors.length > 0) {
      printStatusErr('Failed parsing input file');
      printErrorMessages(parseErrors);
      process.exitCode = 1;
      return;
    }

    const normalized =
      parsed.fileType === 'csv'
        ? normalizeCsvTransactions(
            parsed.transactions as CsvTransaction[],
            options,
            categoriesByName,
          )
        : normalizeStructuredTransactions(
            parsed.fileType,
            parsed.transactions as StructuredImportTransaction[],
            options,
            categoriesByName,
          );

    if (normalized.errors.length > 0) {
      printStatusErr('Failed to normalize transactions');
      printErrorMessages(normalized.errors);
      process.exitCode = 1;
      return;
    }

    await validateCategoryIds(
      normalized.transactions
        .map(tx => (typeof tx.category === 'string' ? tx.category : ''))
        .filter((category): category is string => Boolean(category)),
    );

    const clearFlag = options.clear !== false;
    const reconcile = options.reconcile !== false;
    const dryRun = Boolean(options.dryRun);
    if (!reconcile && dryRun) {
      throw new Error('Dry-run requires reconcile mode');
    }

    const transactions = normalized.transactions.map(tx => ({
      date: tx.date as string,
      amount: api.utils.amountToInteger(tx.amount as number),
      payee_name: tx.payee_name ?? undefined,
      imported_payee: tx.imported_payee ?? undefined,
      notes: tx.notes ?? undefined,
      imported_id:
        typeof tx.imported_id === 'string' && tx.imported_id
          ? tx.imported_id
          : undefined,
      category:
        typeof tx.category === 'string' && tx.category ? tx.category : undefined,
      cleared: clearFlag,
    }));

    if (!reconcile) {
      await api.addTransactions(accountId, transactions);
      const uncategorizedCount = await queryUncategorizedCount(accountId);
      const { dateStart, dateEnd } = computeDateRange(transactions);
      printStatusOk({
        entity: 'import',
        input: transactions.length,
        added: transactions.length,
        updated: 0,
        preview: 0,
        skipped: 0,
        dateStart,
        dateEnd,
        errors: 0,
        uncategorized_count: uncategorizedCount,
      });
      if (showRows) {
        printRows(format, 'import-rows', transactions as unknown as Array<Record<string, unknown>>, [
          'date', 'amount', 'payee_name', 'category', 'notes',
        ]);
      }
      if (showReport) {
        printRows(
          format,
          'import-report',
          [
            {
              file: filePath,
              account: accountId,
              input: transactions.length,
              added: transactions.length,
              updated: 0,
              skipped: 0,
              preview: 0,
              errors: 0,
              date_start: dateStart,
              date_end: dateEnd,
              uncategorized_count: uncategorizedCount,
              reconcile: 0,
              dry_run: dryRun ? 1 : 0,
            },
          ],
          [
            'file',
            'account',
            'input',
            'added',
            'updated',
            'skipped',
            'preview',
            'errors',
            'date_start',
            'date_end',
            'uncategorized_count',
            'reconcile',
            'dry_run',
          ],
        );
      }
      return;
    }

    const importPayload = transactions.map(transaction => ({
      ...transaction,
      account: accountId,
    }));

    const result = (await api.importTransactions(accountId, importPayload, {
      defaultCleared: clearFlag,
      dryRun,
    })) as {
      added: string[];
      updated: string[];
      errors?: Array<{ message?: string }>;
      updatedPreview?: unknown[];
    };

    const errorMessages = (result.errors || [])
      .map(error => error.message)
      .filter((message): message is string => Boolean(message));
    const addedCount = result.added?.length ?? 0;
    const updatedCount = result.updated?.length ?? 0;
    const previewCount = result.updatedPreview?.length ?? 0;
    const skipped = Math.max(0, transactions.length - addedCount - updatedCount);
    const { dateStart, dateEnd } = computeDateRange(transactions);
    const uncategorizedCount = dryRun
      ? undefined
      : await queryUncategorizedCount(accountId);

    printStatusOk({
      entity: 'import',
      input: transactions.length,
      added: addedCount,
      updated: updatedCount,
      preview: previewCount,
      skipped,
      dateStart,
      dateEnd,
      errors: errorMessages.length,
      uncategorized_count: uncategorizedCount,
    });
    if (errorMessages.length > 0) {
      printErrorMessages(errorMessages);
      process.exitCode = 1;
    }
    if (showRows) {
      printRows(format, 'import-rows', transactions as unknown as Array<Record<string, unknown>>, [
        'date', 'amount', 'payee_name', 'category', 'notes',
      ]);
    }
    if (showReport) {
      printRows(
        format,
        'import-report',
        [
          {
            file: filePath,
            account: accountId,
            input: transactions.length,
            added: addedCount,
            updated: updatedCount,
            skipped,
            preview: previewCount,
            errors: errorMessages.length,
            date_start: dateStart,
            date_end: dateEnd,
            uncategorized_count: uncategorizedCount,
            reconcile: 1,
            dry_run: dryRun ? 1 : 0,
          },
        ],
        [
          'file',
          'account',
          'input',
          'added',
          'updated',
          'skipped',
          'preview',
          'errors',
          'date_start',
          'date_end',
          'uncategorized_count',
          'reconcile',
          'dry_run',
        ],
      );
    }
  });
}

export function registerTransactionCommands(program: Command) {
  const transactions = program
    .command('transactions')
    .description('Manage transactions');

  transactions
    .command('list <accountId>')
    .requiredOption('--start <yyyy-mm-dd>', 'Start date')
    .requiredOption('--end <yyyy-mm-dd>', 'End date')
    .description('List transactions for an account within a date range')
    .addHelpText(
      'after',
      `
Example:
  fiscal transactions list acct-abc123 --start 2025-07-01 --end 2025-07-31

Output columns: id, date, account, account_name, amount, payee, payee_name,
  category, category_name, notes, cleared, reconciled, transfer_id, imported_id

Amounts in output are integer minor units (e.g. -4599 = -$45.99).`,
    )
    .action(
      commandAction(async (accountId: string, options: ListOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        await withBudget(session, async () => {
          const resolvedAccountId = await resolveAccountId(accountId);
          const rows = (await api.getTransactions(
            resolvedAccountId,
            asDate(options.start),
            asDate(options.end),
          )) as Array<Record<string, unknown>>;

          await enrichTransactions(rows);
          printRows(format, 'transactions', rows, TRANSACTION_COLUMNS);
        });
      }),
    );

  transactions
    .command('uncategorized')
    .option('--account <id>', 'Filter to specific account')
    .option('--start <yyyy-mm-dd>', 'Start date (inclusive)')
    .option('--end <yyyy-mm-dd>', 'End date (inclusive)')
    .description('List uncategorized transactions across all accounts')
    .addHelpText(
      'after',
      `
Example:
  fiscal transactions uncategorized
  fiscal transactions uncategorized --account acct-abc123 --start 2025-07-01

Output columns: same as "transactions list".
Returns only transactions with no category assigned.`,
    )
    .action(
      commandAction(async (options: UncategorizedOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        await withBudget(session, async () => {
          const resolvedAccount = options.account
            ? await resolveAccountId(options.account)
            : undefined;
          let query = api.q('transactions')
            .filter({ category: null })
            .select(['*']);
          if (resolvedAccount) {
            query = query.filter({ account: resolvedAccount });
          }
          if (options.start) {
            query = query.filter({ date: { $gte: asDate(options.start) } });
          }
          if (options.end) {
            query = query.filter({ date: { $lte: asDate(options.end) } });
          }
          query = query.orderBy({ date: 'desc' });

          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          const rows = ((result as { data?: unknown }).data ?? []) as Array<
            Record<string, unknown>
          >;

          await enrichTransactions(rows);
          printRows(format, 'transactions', rows, TRANSACTION_COLUMNS);
        });
      }),
    );

  const categorize = transactions
    .command('categorize')
    .description('Categorize uncategorized transactions using draft/apply workflow');

  categorize
    .command('draft')
    .option('--account <id>', 'Filter to specific account')
    .option('--start <yyyy-mm-dd>', 'Start date (inclusive)')
    .option('--end <yyyy-mm-dd>', 'End date (inclusive)')
    .option('--limit <n>', 'Maximum rows to include')
    .description('Generate a categorize draft JSON file from uncategorized transactions')
    .addHelpText(
      'after',
      `
Examples:
  fiscal transactions categorize draft
  fiscal transactions categorize draft --limit 50 --account <acct-id>

Writes a JSON file to <dataDir>/<budgetId>/drafts/categorize.json.
Each entry has "id" and "category" fields, plus a "_meta" field with
context (date, amount, payee, account, notes).

Fill in the "category" fields with category IDs, then run:
  fiscal transactions categorize apply

Tip: run 'fiscal rules run --and-commit' first to auto-categorize
transactions that match existing rules.`,
    )
    .action(
      commandAction(async (options: { account?: string; start?: string; end?: string; limit?: string }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);

        await withBudget(session, async (resolved) => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const resolvedAccount = options.account
            ? await resolveAccountId(options.account)
            : undefined;

          let query = api.q('transactions')
            .filter({ category: null })
            .select(['*']);
          if (resolvedAccount) {
            query = query.filter({ account: resolvedAccount });
          }
          if (options.start) {
            query = query.filter({ date: { $gte: asDate(options.start) } });
          }
          if (options.end) {
            query = query.filter({ date: { $lte: asDate(options.end) } });
          }
          query = query.orderBy({ date: 'desc' });

          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          let rows = ((result as { data?: unknown }).data ?? []) as Array<
            Record<string, unknown>
          >;

          if (options.limit != null) {
            const limit = Number(options.limit);
            if (!Number.isInteger(limit) || limit <= 0) {
              throw new Error(`Invalid --limit value: ${options.limit}`);
            }
            rows = rows.slice(0, limit);
          }

          const { accountNames, payeeNames } = await buildNameMaps();
          enrichRows(rows, accountNames, new Map(), payeeNames);

          const draftEntries = rows.map(row => ({
            id: String(row.id ?? ''),
            category: '',
            _meta: {
              date: String(row.date ?? ''),
              amount: typeof row.amount === 'number' ? row.amount : 0,
              payeeName: String(row.payee_name ?? ''),
              accountName: String(row.account_name ?? ''),
              notes: String(row.notes ?? ''),
            },
          }));

          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            'categorize.json',
            draftEntries,
          );
          printStatusOk({
            entity: 'categorize-draft',
            action: 'create',
            path: filePath,
            entries: draftEntries.length,
          });
        });
      }),
    );

  categorize
    .command('apply')
    .option('--dry-run', 'Preview changes without applying')
    .description('Apply a categorize draft JSON file')
    .addHelpText(
      'after',
      `
Examples:
  fiscal transactions categorize apply
  fiscal transactions categorize apply --dry-run

Reads <dataDir>/<budgetId>/drafts/categorize.json, validates each entry
(non-empty id and category), validates category IDs exist, batch-updates
transactions, and deletes the draft on success.`,
    )
    .action(
      commandAction(async (options: { dryRun?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const dryRun = Boolean(options.dryRun);

        await withBudget({ ...session, write: !dryRun }, async (resolved) => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const result = readDraft(
            resolved.dataDir,
            resolved.budgetId,
            'categorize.json',
            CategorizeDraftSchema,
          );

          if (!result.ok) {
            printDraftValidationErrors('categorize-draft', result.errors);
            process.exitCode = 1;
            return;
          }

          await validateCategoryIds(result.data.map(e => e.category));

          if (dryRun) {
            printRows(
              format,
              'categorize-apply',
              result.data.map(entry => ({
                id: entry.id,
                category: entry.category,
                result: 'would-update',
              })),
              ['id', 'category', 'result'],
              { dryRun: 1, entries: result.data.length },
            );
            return;
          }

          const updates = result.data.map(entry => ({
            id: entry.id,
            category: entry.category,
          }));

          const batchResult = (await send('transactions-batch-update', {
            updated: updates,
          })) as { updated?: unknown[] };
          const updatedCount = batchResult.updated?.length ?? 0;

          deleteDraft(resolved.dataDir, resolved.budgetId, 'categorize.json');

          const uncategorizedCount = await queryUncategorizedCount();

          printRows(
            format,
            'categorize-apply',
            updates.map(u => ({
              id: u.id,
              category: u.category,
              result: 'updated',
            })),
            ['id', 'category', 'result'],
            { updated: updatedCount, uncategorized_count: uncategorizedCount },
          );
        });
      }),
    );

  transactions
    .command('add <accountId>')
    .requiredOption('--date <yyyy-mm-dd>', 'Transaction date')
    .requiredOption('--amount <amount>', 'Decimal amount')
    .option('--payee <name>', 'Payee name')
    .option('--category <id>', 'Category id')
    .option('--notes <text>', 'Notes')
    .option('--cleared', 'Mark as cleared')
    .description('Add one transaction')
    .addHelpText(
      'after',
      `
Example:
  fiscal transactions add acct-abc123 --date 2025-07-15 --amount -45.99 --payee "Whole Foods" --category cat-groceries

Amount is a decimal string (e.g. 45.99 for $45.99, -45.99 for -$45.99).`,
    )
    .action(
      commandAction(async (accountId: string, options: AddOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedAccountId = await resolveAccountId(accountId);
            const resolvedCategory = options.category
              ? await resolveCategoryId(options.category)
              : undefined;
            await api.addTransactions(resolvedAccountId, [
              {
                date: asDate(options.date),
                amount: parseAmount(options.amount),
                payee_name: options.payee,
                category: resolvedCategory,
                notes: options.notes,
                cleared: Boolean(options.cleared),
              },
            ]);
            printStatusOk({ entity: 'transaction', action: 'add', accountId: resolvedAccountId });
          },
        );
      }),
    );

  const edit = transactions
    .command('edit')
    .description('Edit transactions using draft/apply workflow');

  edit
    .command('draft')
    .option('--account <id>', 'Filter to specific account')
    .option('--category <id>', 'Filter to specific category')
    .option('--start <yyyy-mm-dd>', 'Start date (inclusive)')
    .option('--end <yyyy-mm-dd>', 'End date (inclusive)')
    .option('--limit <n>', 'Maximum rows to include')
    .description('Generate an edit draft JSON file from matching transactions')
    .addHelpText(
      'after',
      `
Examples:
  fiscal transactions edit draft --account <acct-id> --start 2026-02-01 --end 2026-02-28
  fiscal transactions edit draft --category <cat-id> --limit 20

At least one filter is required. Writes a JSON file to
<dataDir>/<budgetId>/drafts/edit.json.

Each entry has all editable fields pre-filled (date, amount, payee, category,
notes, cleared, account) plus a "_meta" field with context (payeeName,
accountName, categoryName, reconciled, transferId, importedId).

Edit the fields you want to change, then run:
  fiscal transactions edit apply`,
    )
    .action(
      commandAction(async (options: { account?: string; category?: string; start?: string; end?: string; limit?: string }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);

        if (!options.account && !options.category && !options.start && !options.end) {
          throw new Error('At least one filter is required (--account, --category, --start, --end)');
        }

        await withBudget(session, async (resolved) => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const resolvedAccount = options.account
            ? await resolveAccountId(options.account)
            : undefined;
          const resolvedCategory = options.category
            ? await resolveCategoryId(options.category)
            : undefined;

          let query = api.q('transactions').select(['*']);
          if (resolvedAccount) {
            query = query.filter({ account: resolvedAccount });
          }
          if (resolvedCategory) {
            query = query.filter({ category: resolvedCategory });
          }
          if (options.start) {
            query = query.filter({ date: { $gte: asDate(options.start) } });
          }
          if (options.end) {
            query = query.filter({ date: { $lte: asDate(options.end) } });
          }
          query = query.orderBy({ date: 'desc' });

          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          let rows = ((result as { data?: unknown }).data ?? []) as Array<
            Record<string, unknown>
          >;

          if (options.limit != null) {
            const limit = Number(options.limit);
            if (!Number.isInteger(limit) || limit <= 0) {
              throw new Error(`Invalid --limit value: ${options.limit}`);
            }
            rows = rows.slice(0, limit);
          }

          if (rows.length === 0) {
            const filePath = writeDraft(
              resolved.dataDir,
              resolved.budgetId,
              'edit.json',
              [],
            );
            printStatusOk({
              entity: 'edit-draft',
              action: 'create',
              path: filePath,
              entries: 0,
            });
            return;
          }

          const { accountNames, categoryNames, payeeNames } = await buildNameMaps();
          enrichRows(rows, accountNames, categoryNames, payeeNames);

          const draftEntries = rows.map(row => ({
            id: String(row.id ?? ''),
            date: String(row.date ?? ''),
            amount: typeof row.amount === 'number'
              ? api.utils.integerToAmount(row.amount).toFixed(2)
              : '0.00',
            payee:
              typeof row.payee === 'string' && row.payee !== ''
                ? row.payee
                : null,
            category:
              typeof row.category === 'string' && row.category !== ''
                ? row.category
                : null,
            notes: typeof row.notes === 'string' ? row.notes : null,
            cleared: Boolean(row.cleared),
            account:
              typeof row.account === 'string' && row.account !== ''
                ? row.account
                : undefined,
            _meta: {
              payeeName: String(row.payee_name ?? ''),
              accountName: String(row.account_name ?? ''),
              categoryName: String(row.category_name ?? ''),
              reconciled: Boolean(row.reconciled),
              transferId: row.transfer_id ?? null,
              importedId: row.imported_id ?? null,
            },
          }));

          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            'edit.json',
            draftEntries,
          );
          printStatusOk({
            entity: 'edit-draft',
            action: 'create',
            path: filePath,
            entries: draftEntries.length,
          });
        });
      }),
    );

  edit
    .command('apply')
    .option('--dry-run', 'Preview changes without applying')
    .description('Apply an edit draft JSON file')
    .addHelpText(
      'after',
      `
Examples:
  fiscal transactions edit apply
  fiscal transactions edit apply --dry-run

Reads <dataDir>/<budgetId>/drafts/edit.json, validates entries with Zod,
validates category and account IDs, batch-updates transactions, and deletes
the draft on success.`,
    )
    .action(
      commandAction(async (options: { dryRun?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const dryRun = Boolean(options.dryRun);

        await withBudget({ ...session, write: !dryRun }, async (resolved) => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const result = readDraft(
            resolved.dataDir,
            resolved.budgetId,
            'edit.json',
            EditDraftSchema,
          );

          if (!result.ok) {
            printDraftValidationErrors('edit-draft', result.errors);
            process.exitCode = 1;
            return;
          }

          // Validate referenced category IDs
          const categoryIds = result.data
            .map(e => e.category)
            .filter((c): c is string => typeof c === 'string' && c !== '');
          if (categoryIds.length > 0) {
            await validateCategoryIds(categoryIds);
          }

          // Validate referenced account IDs
          const accountIds = new Set(
            result.data
              .map(e => e.account)
              .filter((a): a is string => typeof a === 'string' && a !== ''),
          );
          for (const accountId of accountIds) {
            await validateAccountId(accountId);
          }

          // Build update objects — only include changed fields (non-_meta, non-undefined)
          const updates = result.data.map(entry => {
            const fields: Record<string, unknown> = { id: entry.id };
            if (entry.date != null) {
              fields.date = asDate(entry.date);
            }
            if (entry.amount != null) {
              fields.amount = parseAmount(entry.amount);
            }
            if (entry.payee !== undefined) {
              fields.payee = entry.payee;
            }
            if (entry.category !== undefined) {
              fields.category = entry.category;
            }
            if (entry.notes !== undefined) {
              fields.notes = entry.notes;
            }
            if (entry.cleared != null) {
              fields.cleared = entry.cleared;
            }
            if (entry.account !== undefined) {
              fields.account = entry.account;
            }
            return fields;
          });

          if (dryRun) {
            printRows(
              format,
              'edit-apply',
              updates.map(u => ({
                id: u.id,
                fields: Object.keys(u).filter(k => k !== 'id').join(','),
                result: 'would-update',
              })),
              ['id', 'fields', 'result'],
              { dryRun: 1, entries: updates.length },
            );
            return;
          }

          const batchResult = (await send('transactions-batch-update', {
            updated: updates,
          })) as { updated?: unknown[] };
          const updatedCount = batchResult.updated?.length ?? 0;

          deleteDraft(resolved.dataDir, resolved.budgetId, 'edit.json');

          printRows(
            format,
            'edit-apply',
            updates.map(u => ({
              id: u.id,
              fields: Object.keys(u).filter(k => k !== 'id').join(','),
              result: 'updated',
            })),
            ['id', 'fields', 'result'],
            { updated: updatedCount },
          );
        });
      }),
    );

  transactions
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete transaction')
    .action(
      commandAction(async (id: string, options: DeleteOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a transaction');
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.deleteTransaction(id);
            printStatusOk({ entity: 'transaction', action: 'delete', id });
          },
        );
      }),
    );

  transactions
    .command('import <accountId> <file>')
    .option('--no-reconcile', 'Disable reconciliation and rule processing')
    .option('--dry-run', 'Preview import without commit')
    .option('--show-rows', 'Include individual parsed transactions in output')
    .option(
      '--report',
      'Include import summary report in output',
    )
    .option('--no-clear', 'Do not set cleared=true by default')
    .option('--no-import-notes', 'Skip notes field from source file')
    .option(
      '--fallback-payee-to-memo',
      'OFX: use memo when payee is missing',
    )
    .option(
      '--date-format <format>',
      'Date format (yyyy mm dd | yy mm dd | mm dd yyyy | mm dd yy | dd mm yyyy | dd mm yy)',
    )
    .option('--multiplier <n>', 'Multiply parsed amounts', '1')
    .option('--flip-amount', 'Negate imported amounts')
    .option('--no-csv-header', 'CSV has no header row')
    .option('--csv-delimiter <char>', 'CSV delimiter')
    .option('--csv-date-col <name|index>', 'CSV date column')
    .option('--csv-amount-col <name|index>', 'CSV signed amount column')
    .option('--csv-payee-col <name|index>', 'CSV payee column')
    .option('--csv-notes-col <name|index>', 'CSV notes/memo column')
    .option('--csv-category-col <name|index>', 'CSV category column')
    .option('--csv-inflow-col <name|index>', 'CSV inflow column (split mode)')
    .option('--csv-outflow-col <name|index>', 'CSV outflow column (split mode)')
    .option('--csv-inout-col <name|index>', 'CSV in/out marker column')
    .option('--csv-out-value <value>', 'Value in --csv-inout-col treated as outflow')
    .option('--csv-skip-start <n>', 'Skip N lines before parsing')
    .option('--csv-skip-end <n>', 'Skip N trailing lines before parsing')
    .description('Import transactions from file (CSV, TSV, QIF, OFX, QFX, CAMT XML)')
    .addHelpText(
      'after',
      `
Examples:
  fiscal transactions import acct-abc123 ./chase-july.csv
  fiscal transactions import acct-abc123 ./bank.csv --dry-run --show-rows
  fiscal transactions import acct-abc123 ./export.csv --csv-date-col Date --csv-amount-col Amount

Supported formats: .csv, .tsv, .qif, .ofx, .qfx, .xml (CAMT)
CSV columns are auto-detected from header names. Use --csv-*-col flags to override.
Reconciliation (default on) deduplicates and applies rules automatically.
Use --dry-run to preview without committing. Add --show-rows to see individual rows.

JSON output includes: input, added, updated, skipped, preview, errors
With --show-rows, also includes: date, amount, payee_name, category, notes`,
    )
    .action(
      commandAction(async (accountId: string, file: string, options: ImportOptions, ...args: unknown[]) => {
        await importTransactionsCommand(accountId, file, options, args);
      }),
    );
}
