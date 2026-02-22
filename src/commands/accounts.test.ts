import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type AccountCreateOutput = {
  status: string;
  entity: string;
  action: string;
  id: string;
  name: string;
};

type AccountRow = {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
};

type AccountListOutput = {
  status: string;
  entity: string;
  count: number;
  data: AccountRow[];
};

type AccountFindOutput = {
  status: string;
  entity: string;
  count: number;
  matches: number;
  query: string;
  data: AccountRow[];
};

describe('accounts happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('creates an account and finds it by name', () => {
    createLocalBudget(testEnv, 'AccountsBudget');

    const createResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'accounts',
        'create',
        'Checking',
        '--balance',
        '250.55',
      ],
      undefined,
      testEnv.env,
    );
    expect(createResult.exitCode).toBe(0);
    const created = parseJsonOutput<AccountCreateOutput>(createResult.stdout);
    expect(created).toMatchObject({
      status: 'ok',
      entity: 'account',
      action: 'create',
      name: 'Checking',
    });
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const listResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'list'],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<AccountListOutput>(listResult.stdout);
    expect(listed.status).toBe('ok');
    expect(listed.entity).toBe('accounts');
    expect(listed.count).toBeGreaterThanOrEqual(1);
    expect(listed.data.some(row => row.id === created.id)).toBe(true);

    const findResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'accounts', 'find', 'check'],
      undefined,
      testEnv.env,
    );
    expect(findResult.exitCode).toBe(0);
    const found = parseJsonOutput<AccountFindOutput>(findResult.stdout);
    expect(found.status).toBe('ok');
    expect(found.entity).toBe('accounts-find');
    expect(found.query).toBe('check');
    expect(found.matches).toBeGreaterThanOrEqual(1);
    expect(found.data.some(row => row.id === created.id)).toBe(true);
  }, 20000);
});
