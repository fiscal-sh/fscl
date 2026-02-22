import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type AccountCreateOutput = {
  id: string;
};

type CategoryGroupCreateOutput = {
  id: string;
};

type CategoryCreateOutput = {
  id: string;
};

type TransactionAddOutput = {
  status: string;
  entity: string;
  action: string;
  accountId: string;
};

type TransactionRow = {
  id: string;
  date: string;
  account: string;
  account_name: string;
  amount: number;
  payee_name: string;
  category: string | null;
  category_name: string | null;
  notes: string | null;
};

type TransactionListOutput = {
  status: string;
  entity: string;
  count: number;
  data: TransactionRow[];
};

describe('transactions happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('adds a transaction and lists it by date range', () => {
    createLocalBudget(testEnv, 'TransactionsBudget');

    const accountCreateResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'create', 'Checking'],
      undefined,
      testEnv.env,
    );
    expect(accountCreateResult.exitCode).toBe(0);
    const account = parseJsonOutput<AccountCreateOutput>(accountCreateResult.stdout);

    const categoryGroupCreateResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'categories',
        'create-group',
        'Household',
      ],
      undefined,
      testEnv.env,
    );
    expect(categoryGroupCreateResult.exitCode).toBe(0);
    const categoryGroup = parseJsonOutput<CategoryGroupCreateOutput>(
      categoryGroupCreateResult.stdout,
    );

    const categoryCreateResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'categories',
        'create',
        'Groceries',
        '--group',
        categoryGroup.id,
      ],
      undefined,
      testEnv.env,
    );
    expect(categoryCreateResult.exitCode).toBe(0);
    const category = parseJsonOutput<CategoryCreateOutput>(
      categoryCreateResult.stdout,
    );

    const addResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'add',
        account.id,
        '--date',
        '2026-02-01',
        '--amount',
        '-12.34',
        '--payee',
        'Store',
        '--category',
        category.id,
        '--notes',
        'Snack',
      ],
      undefined,
      testEnv.env,
    );
    expect(addResult.exitCode).toBe(0);
    const added = parseJsonOutput<TransactionAddOutput>(addResult.stdout);
    expect(added).toMatchObject({
      status: 'ok',
      entity: 'transaction',
      action: 'add',
      accountId: account.id,
    });

    const listResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'list',
        account.id,
        '--start',
        '2026-02-01',
        '--end',
        '2026-02-28',
      ],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<TransactionListOutput>(listResult.stdout);
    expect(listed.status).toBe('ok');
    expect(listed.entity).toBe('transactions');
    expect(listed.count).toBeGreaterThanOrEqual(1);
    expect(
      listed.data.some(
        row =>
          row.account === account.id &&
          row.date === '2026-02-01' &&
          row.amount === -1234 &&
          row.payee_name === 'Store' &&
          row.category === category.id &&
          row.notes === 'Snack',
      ),
    ).toBe(true);

    const uncategorizedResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'transactions', 'uncategorized'],
      undefined,
      testEnv.env,
    );
    expect(uncategorizedResult.exitCode).toBe(0);
    const uncategorized = parseJsonOutput<TransactionListOutput>(
      uncategorizedResult.stdout,
    );
    expect(uncategorized.status).toBe('ok');
    expect(uncategorized.entity).toBe('transactions');
    expect(uncategorized.count).toBe(0);
  }, 20000);
});
