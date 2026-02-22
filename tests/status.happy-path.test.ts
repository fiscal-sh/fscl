import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../src/test-utils.js';

type BudgetCreateOutput = {
  id: string;
  name: string;
};

type CompactStatusOutput = {
  status: string;
  entity: string;
  compact: boolean;
  active_budget_id: string;
  active_budget_name: string;
  budget_type: string;
  budget_loaded: number;
  server_configured: number;
  server_logged_in: number;
  sync_pending: number;
};

describe('status happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('reports compact status after creating a local budget', () => {
    const budgetName = 'StatusBudget';

    const createResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'budgets', 'create', budgetName],
      undefined,
      testEnv.env,
    );
    expect(createResult.exitCode).toBe(0);
    const created = parseJsonOutput<BudgetCreateOutput>(createResult.stdout);

    const statusResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'status', '--compact'],
      undefined,
      testEnv.env,
    );
    expect(statusResult.exitCode).toBe(0);

    const status = parseJsonOutput<CompactStatusOutput>(statusResult.stdout);
    expect(status).toMatchObject({
      status: 'ok',
      entity: 'status',
      compact: true,
      active_budget_id: created.id,
      active_budget_name: budgetName,
      budget_type: 'envelope',
      budget_loaded: 1,
      server_configured: 0,
      server_logged_in: 0,
      sync_pending: 0,
    });
  });
});
