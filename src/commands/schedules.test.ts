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
  }, 30000);

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
  }, 30000);
});
