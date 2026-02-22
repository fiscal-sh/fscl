import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type PayeeCreateOutput = {
  status: string;
  entity: string;
  action: string;
  id: string;
  name: string;
};

type PayeeRow = {
  id: string;
  name: string;
  transfer_acct: string | null;
};

type PayeeListOutput = {
  status: string;
  entity: string;
  count: number;
  data: PayeeRow[];
};

type PayeeFindOutput = {
  status: string;
  entity: string;
  count: number;
  matches: number;
  query: string;
  data: PayeeRow[];
};

describe('payees happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('creates a payee and lists it', () => {
    createLocalBudget(testEnv, 'PayeesBudget');

    const createResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'payees', 'create', 'Grocery Store'],
      undefined,
      testEnv.env,
    );
    expect(createResult.exitCode).toBe(0);
    const created = parseJsonOutput<PayeeCreateOutput>(createResult.stdout);
    expect(created).toMatchObject({
      status: 'ok',
      entity: 'payee',
      action: 'create',
      name: 'Grocery Store',
    });
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const listResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'payees', 'list'],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<PayeeListOutput>(listResult.stdout);
    expect(listed.status).toBe('ok');
    expect(listed.entity).toBe('payees');
    expect(listed.count).toBeGreaterThanOrEqual(1);
    expect(listed.data.some(row => row.id === created.id)).toBe(true);

    const findResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'payees', 'find', 'groc'],
      undefined,
      testEnv.env,
    );
    expect(findResult.exitCode).toBe(0);
    const found = parseJsonOutput<PayeeFindOutput>(findResult.stdout);
    expect(found.status).toBe('ok');
    expect(found.entity).toBe('payees-find');
    expect(found.query).toBe('groc');
    expect(found.matches).toBeGreaterThanOrEqual(1);
    expect(found.data.some(row => row.id === created.id)).toBe(true);
  }, 20000);
});
