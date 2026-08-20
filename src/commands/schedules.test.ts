import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type CreateOutput = {
  id: string;
};

type ScheduleListOutput = {
  status: string;
  entity: string;
  data: Array<{
    id: string;
    name: string;
    amount: number | null;
    amount_op: string | null;
  }>;
};

type ScheduleSummaryOutput = {
  status: string;
  data: Array<{
    id: string;
    monthly_amount: number;
  }>;
};

function cli(testEnv: CliTestEnv, args: string[]) {
  return runCli(
    ['--data-dir', testEnv.dataDir, '--json', ...args],
    undefined,
    testEnv.env,
  );
}

describe('schedules create/update', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('creates a schedule with decimal amount and defaulted amountOp, then updates the amount in one call', () => {
    createLocalBudget(testEnv, 'ScheduleBudget');

    const accountResult = cli(testEnv, ['accounts', 'create', 'Checking']);
    expect(accountResult.exitCode).toBe(0);
    const account = parseJsonOutput<CreateOutput>(accountResult.stdout);

    const payeeResult = cli(testEnv, ['payees', 'create', 'Netflix']);
    expect(payeeResult.exitCode).toBe(0);
    const payee = parseJsonOutput<CreateOutput>(payeeResult.stdout);

    const createResult = cli(testEnv, [
      'schedules',
      'create',
      JSON.stringify({
        name: 'Netflix',
        account: account.id,
        payee: payee.id,
        amount: -15.99,
        date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
      }),
    ]);
    expect(createResult.exitCode).toBe(0);
    const created = parseJsonOutput<CreateOutput>(createResult.stdout);
    expect(created.id).toBeTruthy();

    const listResult = cli(testEnv, ['schedules', 'list']);
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<ScheduleListOutput>(listResult.stdout);
    const row = listed.data.find(s => s.id === created.id);
    expect(row).toBeDefined();
    expect(row?.amount).toBe(-1599);
    expect(row?.amount_op).toBe('isapprox');

    // amount must land in a single update call (no two-pass repair dance)
    const updateResult = cli(testEnv, [
      'schedules',
      'update',
      created.id,
      JSON.stringify({ amount: -16.99 }),
    ]);
    expect(updateResult.exitCode).toBe(0);

    const afterUpdate = parseJsonOutput<ScheduleListOutput>(
      cli(testEnv, ['schedules', 'list']).stdout,
    );
    const updatedRow = afterUpdate.data.find(s => s.id === created.id);
    expect(updatedRow?.amount).toBe(-1699);
    expect(updatedRow?.amount_op).toBe('isapprox');

    const summaryResult = cli(testEnv, ['schedules', 'summary']);
    expect(summaryResult.exitCode).toBe(0);
    const summary = parseJsonOutput<ScheduleSummaryOutput>(summaryResult.stdout);
    const summaryRow = summary.data.find(s => s.id === created.id);
    expect(summaryRow?.monthly_amount).toBe(-1699);

    const reviewResult = cli(testEnv, [
      'schedules',
      'review',
      created.id,
      JSON.stringify({ decision: 'keep', note: 'still useful', cadenceMonths: 6 }),
    ]);
    expect(reviewResult.exitCode).toBe(0);

    const transactionResult = cli(testEnv, [
      'transactions',
      'add',
      account.id,
      '--date',
      '2026-02-01',
      '--amount',
      '-12.34',
      '--payee',
      'Netflix',
    ]);
    expect(transactionResult.exitCode).toBe(0);
    const balanceBefore = parseJsonOutput<{ balance_current: number }>(
      cli(testEnv, ['accounts', 'balance', account.id]).stdout,
    ).balance_current;

    const exportPath = join(testEnv.rootDir, 'schedule-budget.zip');
    const exportResult = cli(testEnv, ['budgets', 'export', exportPath]);
    expect(exportResult.exitCode).toBe(0);
    expect(existsSync(exportPath)).toBe(true);

    const restoreResult = cli(testEnv, ['budgets', 'restore', exportPath]);
    expect(restoreResult.exitCode).toBe(0);
    const restored = parseJsonOutput<{ id: string }>(restoreResult.stdout);
    expect(restored.id).toBeTruthy();

    const reviewsResult = cli(testEnv, ['schedules', 'reviews']);
    expect(reviewsResult.exitCode).toBe(0);
    const reviews = parseJsonOutput<{
      data: Array<{ schedule_id: string; decision: string; note: string }>;
    }>(reviewsResult.stdout);
    expect(reviews.data).toContainEqual(
      expect.objectContaining({
        schedule_id: created.id,
        decision: 'keep',
        note: 'still useful',
      }),
    );
    const balanceAfter = parseJsonOutput<{ balance_current: number }>(
      cli(testEnv, ['accounts', 'balance', account.id]).stdout,
    ).balance_current;
    expect(balanceAfter).toBe(balanceBefore);
  });

  it('rejects a schedule create with missing required fields or invalid amountOp', () => {
    createLocalBudget(testEnv, 'ScheduleValidationBudget');

    const accountResult = cli(testEnv, ['accounts', 'create', 'Checking']);
    expect(accountResult.exitCode).toBe(0);
    const account = parseJsonOutput<CreateOutput>(accountResult.stdout);

    const missingPayee = cli(testEnv, [
      'schedules',
      'create',
      JSON.stringify({
        account: account.id,
        amount: -10,
        date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
      }),
    ]);
    expect(missingPayee.exitCode).not.toBe(0);
    expect(`${missingPayee.stderr}${missingPayee.stdout}`).toContain(
      'payee is required',
    );

    const payeeResult = cli(testEnv, ['payees', 'create', 'Gym']);
    const payee = parseJsonOutput<CreateOutput>(payeeResult.stdout);

    const badOp = cli(testEnv, [
      'schedules',
      'create',
      JSON.stringify({
        account: account.id,
        payee: payee.id,
        amount: -10,
        amountOp: 'equals',
        date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
      }),
    ]);
    expect(badOp.exitCode).not.toBe(0);
    expect(`${badOp.stderr}${badOp.stdout}`).toContain('Invalid amountOp');

    const scalarBetween = cli(testEnv, [
      'schedules',
      'create',
      JSON.stringify({
        account: account.id,
        payee: payee.id,
        amount: -10,
        amountOp: 'isbetween',
        date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
      }),
    ]);
    expect(scalarBetween.exitCode).not.toBe(0);
    expect(parseJsonOutput<{ message: string }>(scalarBetween.stdout).message).toContain(
      'amountOp "isbetween" requires amount',
    );

    const valid = cli(testEnv, [
      'schedules',
      'create',
      JSON.stringify({
        account: account.id,
        payee: payee.id,
        amount: -10,
        date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
      }),
    ]);
    expect(valid.exitCode).toBe(0);
    const schedule = parseJsonOutput<CreateOutput>(valid.stdout);

    const incompatibleAmount = cli(testEnv, [
      'schedules',
      'update',
      schedule.id,
      JSON.stringify({ amount: { num1: -12, num2: -8 } }),
    ]);
    expect(incompatibleAmount.exitCode).not.toBe(0);
    expect(parseJsonOutput<{ message: string }>(incompatibleAmount.stdout).message).toContain(
      'requires a scalar amount',
    );

    const incompatibleOp = cli(testEnv, [
      'schedules',
      'update',
      schedule.id,
      JSON.stringify({ amountOp: 'isbetween' }),
    ]);
    expect(incompatibleOp.exitCode).not.toBe(0);
    expect(parseJsonOutput<{ message: string }>(incompatibleOp.stdout).message).toContain(
      'requires amount',
    );
  });

  it('keeps sidecar review history intact when listing reviews after a schedule is deleted', () => {
    createLocalBudget(testEnv, 'ReviewRetentionBudget');

    const account = parseJsonOutput<CreateOutput>(
      cli(testEnv, ['accounts', 'create', 'Checking']).stdout,
    );
    const payee = parseJsonOutput<CreateOutput>(
      cli(testEnv, ['payees', 'create', 'OldService']).stdout,
    );
    const created = parseJsonOutput<CreateOutput>(
      cli(testEnv, [
        'schedules',
        'create',
        JSON.stringify({
          name: 'OldService',
          account: account.id,
          payee: payee.id,
          amount: -9.99,
          date: { frequency: 'monthly', start: '2026-01-01', interval: 1 },
        }),
      ]).stdout,
    );

    const reviewResult = cli(testEnv, [
      'schedules',
      'review',
      created.id,
      JSON.stringify({ decision: 'cancel', note: 'canceled 2026-08' }),
    ]);
    expect(reviewResult.exitCode).toBe(0);

    const deleteResult = cli(testEnv, [
      'schedules',
      'delete',
      created.id,
      '--yes',
    ]);
    expect(deleteResult.exitCode).toBe(0);

    const budgetDirs = readdirSync(testEnv.dataDir).filter(name =>
      existsSync(join(testEnv.dataDir, name, 'fiscal.json')),
    );
    expect(budgetDirs.length).toBeGreaterThan(0);
    const sidecarPath = join(testEnv.dataDir, budgetDirs[0], 'fiscal.json');
    const sidecarBefore = readFileSync(sidecarPath, 'utf8');
    expect(sidecarBefore).toContain(created.id);

    // A listing must not rewrite the sidecar: pruning it here would erase the
    // only remaining record of the deleted schedule's review.
    const listResult = cli(testEnv, ['schedules', 'reviews']);
    expect(listResult.exitCode).toBe(0);
    const sidecarAfter = readFileSync(sidecarPath, 'utf8');
    expect(sidecarAfter).toBe(sidecarBefore);
  });
});
