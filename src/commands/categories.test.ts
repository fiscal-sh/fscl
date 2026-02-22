import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type CategoryGroupCreateOutput = {
  status: string;
  entity: string;
  action: string;
  id: string;
};

type CategoryCreateOutput = {
  status: string;
  entity: string;
  action: string;
  id: string;
  group_id: string;
};

type CategoryRow = {
  kind: 'group' | 'category';
  id: string;
  group_id?: string | null;
  name: string;
  group_name?: string;
};

type CategoryFindOutput = {
  status: string;
  entity: string;
  count: number;
  matches: number;
  query: string;
  data: CategoryRow[];
};

type CategoryListOutput = {
  status: string;
  entity: string;
  count: number;
  data: CategoryRow[];
};

describe('categories happy path', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('creates a category group and category, then finds it', () => {
    createLocalBudget(testEnv, 'CategoriesBudget');

    const createGroupResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'categories',
        'create-group',
        'Essentials',
      ],
      undefined,
      testEnv.env,
    );
    expect(createGroupResult.exitCode).toBe(0);
    const group = parseJsonOutput<CategoryGroupCreateOutput>(
      createGroupResult.stdout,
    );
    expect(group).toMatchObject({
      status: 'ok',
      entity: 'category-group',
      action: 'create',
    });
    expect(group.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const createCategoryResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'categories',
        'create',
        'Groceries',
        '--group',
        group.id,
      ],
      undefined,
      testEnv.env,
    );
    expect(createCategoryResult.exitCode).toBe(0);
    const category = parseJsonOutput<CategoryCreateOutput>(
      createCategoryResult.stdout,
    );
    expect(category).toMatchObject({
      status: 'ok',
      entity: 'category',
      action: 'create',
      group_id: group.id,
    });

    const findResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'categories', 'find', 'groc'],
      undefined,
      testEnv.env,
    );
    expect(findResult.exitCode).toBe(0);
    const found = parseJsonOutput<CategoryFindOutput>(findResult.stdout);
    expect(found.status).toBe('ok');
    expect(found.entity).toBe('categories-find');
    expect(found.query).toBe('groc');
    expect(found.matches).toBeGreaterThanOrEqual(1);
    expect(found.data.some(row => row.id === category.id)).toBe(true);

    const listResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'categories', 'list'],
      undefined,
      testEnv.env,
    );
    expect(listResult.exitCode).toBe(0);
    const listed = parseJsonOutput<CategoryListOutput>(listResult.stdout);
    expect(listed.status).toBe('ok');
    expect(listed.entity).toBe('categories');
    expect(listed.count).toBeGreaterThanOrEqual(1);
    expect(
      listed.data.some(row => row.kind === 'group' && row.id === group.id),
    ).toBe(true);
    expect(
      listed.data.some(row => row.kind === 'category' && row.id === category.id),
    ).toBe(true);
  }, 20000);
});
