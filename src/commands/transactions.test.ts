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
  cleared: boolean;
  reconciled: boolean;
  transfer_id: string | null;
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

  it('lists and applies reconciliation draft for unreconciled transactions', () => {
    createLocalBudget(testEnv, 'ReconcileBudget');

    const accountCreateResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'create', 'Checking'],
      undefined,
      testEnv.env,
    );
    expect(accountCreateResult.exitCode).toBe(0);
    const account = parseJsonOutput<AccountCreateOutput>(accountCreateResult.stdout);

    const addResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'add',
        account.id,
        '--date',
        '2026-02-03',
        '--amount',
        '-25.00',
        '--payee',
        'Cafe',
      ],
      undefined,
      testEnv.env,
    );
    expect(addResult.exitCode).toBe(0);

    const listResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'reconcile',
        'list',
        '--account',
        account.id,
      ],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<TransactionListOutput>(listResult.stdout);
    expect(listed.status).toBe('ok');
    expect(listed.entity).toBe('transactions-reconcile');
    expect(listed.count).toBeGreaterThanOrEqual(1);
    expect(listed.data.some(row => row.payee_name === 'Cafe')).toBe(true);

    const draftResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'reconcile',
        'draft',
        '--account',
        account.id,
      ],
      undefined,
      testEnv.env,
    );
    expect(draftResult.exitCode).toBe(0);

    const applyResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'reconcile',
        'apply',
      ],
      undefined,
      testEnv.env,
    );
    expect(applyResult.exitCode).toBe(0);

    const afterResult = runCli(
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
    expect(afterResult.exitCode).toBe(0);
    const after = parseJsonOutput<TransactionListOutput>(afterResult.stdout);
    const reconciled = after.data.find(row => row.payee_name === 'Cafe');
    expect(reconciled).toBeDefined();
    expect(reconciled?.cleared).toBe(true);
    expect(reconciled?.reconciled).toBe(true);
  }, 20000);

  it('creates a linked transfer between accounts', () => {
    createLocalBudget(testEnv, 'TransferBudget');

    const checkingResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'create', 'Checking'],
      undefined,
      testEnv.env,
    );
    expect(checkingResult.exitCode).toBe(0);
    const checking = parseJsonOutput<AccountCreateOutput>(checkingResult.stdout);

    const savingsResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'create', 'Savings'],
      undefined,
      testEnv.env,
    );
    expect(savingsResult.exitCode).toBe(0);
    const savings = parseJsonOutput<AccountCreateOutput>(savingsResult.stdout);

    const transferResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'transfer',
        checking.id,
        savings.id,
        '--date',
        '2026-02-10',
        '--amount',
        '100.00',
        '--notes',
        'Move to savings',
      ],
      undefined,
      testEnv.env,
    );
    expect(transferResult.exitCode).toBe(0);
    const transfer = parseJsonOutput<{
      status: string;
      entity: string;
      action: string;
      from_account: string;
      to_account: string;
      amount: number;
    }>(transferResult.stdout);
    expect(transfer).toMatchObject({
      status: 'ok',
      entity: 'transfer',
      action: 'add',
      from_account: checking.id,
      to_account: savings.id,
      amount: 10000,
    });

    const checkingListResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'list',
        checking.id,
        '--start',
        '2026-02-01',
        '--end',
        '2026-02-28',
      ],
      undefined,
      testEnv.env,
    );
    expect(checkingListResult.exitCode).toBe(0);
    const checkingList = parseJsonOutput<TransactionListOutput>(
      checkingListResult.stdout,
    );
    expect(
      checkingList.data.some(
        row =>
          row.amount === -10000 &&
          row.notes === 'Move to savings' &&
          row.transfer_id,
      ),
    ).toBe(true);

    const savingsListResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'transactions',
        'list',
        savings.id,
        '--start',
        '2026-02-01',
        '--end',
        '2026-02-28',
      ],
      undefined,
      testEnv.env,
    );
    expect(savingsListResult.exitCode).toBe(0);
    const savingsList = parseJsonOutput<TransactionListOutput>(
      savingsListResult.stdout,
    );
    expect(
      savingsList.data.some(
        row =>
          row.amount === 10000 &&
          row.notes === 'Move to savings' &&
          row.transfer_id,
      ),
    ).toBe(true);
  }, 20000);
});
