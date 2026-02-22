import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type BudgetCreateOutput = {
  status: string;
  entity: string;
  action: string;
  id: string;
  name: string;
};

type BudgetRow = {
  id: string;
  name: string;
  group_id: string | null;
  cloud_file_id: string | null;
  state: string;
};

type BudgetListOutput = {
  status: string;
  entity: string;
  count: number;
  data: BudgetRow[];
};

describe('budgets happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('creates and lists a local budget in json mode', () => {
    const budgetName = 'HappyPathBudget';

    const createResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'budgets',
        'create',
        budgetName,
      ],
      undefined,
      testEnv.env,
    );
    expect(createResult.exitCode).toBe(0);

    const created = parseJsonOutput<BudgetCreateOutput>(createResult.stdout);
    expect(created).toMatchObject({
      status: 'ok',
      entity: 'budget',
      action: 'create',
      name: budgetName,
    });
    expect(created.id).toMatch(/^HappyPathBudget-/);

    const configPath = join(
      testEnv.env.XDG_CONFIG_HOME as string,
      'fiscal',
      'config.json',
    );
    expect(existsSync(configPath)).toBe(true);

    const listResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'budgets', 'list'],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);

    const list = parseJsonOutput<BudgetListOutput>(listResult.stdout);
    expect(list.status).toBe('ok');
    expect(list.entity).toBe('budgets');
    expect(list.count).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      id: created.id,
      name: budgetName,
      state: 'local',
      group_id: null,
      cloud_file_id: null,
    });
  });
});
