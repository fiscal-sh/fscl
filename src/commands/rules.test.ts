import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCliTestEnv,
  createLocalBudget,
  parseJsonOutput,
  runCli,
  type CliTestEnv,
} from '../test-utils.js';

type CategoryGroupCreateOutput = {
  id: string;
};

type CategoryCreateOutput = {
  id: string;
};

type RuleCreateOutput = {
  id: string;
};

type RuleDraftOutput = {
  status: string;
  entity: string;
  action: string;
  path: string;
  rules: number;
};

type RulesApplyPreviewOutput = {
  status: string;
  entity: string;
  count: number;
  data: Array<{
    id: string;
    action: string;
    conditions: string;
    actions: string;
    result: string;
  }>;
};

describe('rules draft/apply', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('accepts rule draft condition and action type metadata', () => {
    createLocalBudget(testEnv, 'RulesBudget');

    const groupResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'categories',
        'create-group',
        'Food',
      ],
      undefined,
      testEnv.env,
    );
    expect(groupResult.exitCode).toBe(0);
    const group = parseJsonOutput<CategoryGroupCreateOutput>(groupResult.stdout);

    const categoryResult = runCli(
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
    expect(categoryResult.exitCode).toBe(0);
    const category = parseJsonOutput<CategoryCreateOutput>(categoryResult.stdout);

    const rulePayload = {
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { field: 'imported_payee', op: 'contains', value: 'MARKET' },
      ],
      actions: [
        { field: 'category', op: 'set', value: category.id },
      ],
    };
    const createRuleResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'rules',
        'create',
        JSON.stringify(rulePayload),
      ],
      undefined,
      testEnv.env,
    );
    expect(createRuleResult.exitCode).toBe(0);
    const createdRule = parseJsonOutput<RuleCreateOutput>(createRuleResult.stdout);
    expect(createdRule.id).toBeTruthy();

    const draftResult = runCli(
      ['--data-dir', testEnv.dataDir, '--json', 'rules', 'draft'],
      undefined,
      testEnv.env,
    );
    expect(draftResult.exitCode).toBe(0);
    const draft = parseJsonOutput<RuleDraftOutput>(draftResult.stdout);
    expect(draft).toMatchObject({
      status: 'ok',
      entity: 'rules-draft',
      action: 'create',
    });

    const draftJson = JSON.parse(readFileSync(draft.path, 'utf8')) as Array<{
      id?: string;
      conditions: Array<Record<string, unknown>>;
      actions: Array<Record<string, unknown>>;
    }>;
    const ruleDraft = draftJson.find(row => row.id === createdRule.id);
    expect(ruleDraft).toBeDefined();
    ruleDraft!.conditions[0].type = 'string';
    ruleDraft!.actions[0].type = 'id';
    writeFileSync(draft.path, JSON.stringify(draftJson, null, 2) + '\n', 'utf8');

    const applyResult = runCli(
      [
        '--data-dir',
        testEnv.dataDir,
        '--json',
        'rules',
        'apply',
        '--dry-run',
      ],
      undefined,
      testEnv.env,
    );
    expect(applyResult.exitCode).toBe(0);
    const preview = parseJsonOutput<RulesApplyPreviewOutput>(applyResult.stdout);
    expect(preview.status).toBe('ok');
    expect(preview.entity).toBe('rules-apply-preview');
    expect(preview.count).toBeGreaterThanOrEqual(1);

    const row = preview.data.find(item => item.id === createdRule.id);
    expect(row).toBeDefined();
    expect(row?.conditions).not.toContain('"type"');
    expect(row?.actions).not.toContain('"type"');
  });
});

describe('rules run transfer protection', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  function cli(args: string[]) {
    return runCli(
      ['--data-dir', testEnv.dataDir, '--json', ...args],
      undefined,
      testEnv.env,
    );
  }

  it('skips transfer-linked transactions by default and reports them', () => {
    createLocalBudget(testEnv, 'TransferRuleBudget');

    const checking = parseJsonOutput<{ id: string }>(
      cli(['accounts', 'create', 'Checking']).stdout,
    );
    const savings = parseJsonOutput<{ id: string }>(
      cli(['accounts', 'create', 'Savings']).stdout,
    );
    const roguePayee = parseJsonOutput<{ id: string }>(
      cli(['payees', 'create', 'Rogue']).stdout,
    );

    const transferResult = cli([
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
    ]);
    expect(transferResult.exitCode).toBe(0);

    // A payee-set rule that matches the transfer halves via notes
    const ruleResult = cli([
      'rules',
      'create',
      JSON.stringify({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'notes', op: 'contains', value: 'Move to savings' }],
        actions: [{ field: 'payee', op: 'set', value: roguePayee.id }],
      }),
    ]);
    expect(ruleResult.exitCode).toBe(0);

    const runResult = cli(['rules', 'run']);
    expect(runResult.exitCode).toBe(0);
    const run = parseJsonOutput<{
      status: string;
      matched?: number;
      updated?: number;
      skipped_transfers?: number;
    }>(runResult.stdout);
    expect(run.status).toBe('ok');
    expect(run.matched ?? 0).toBe(0);
    expect(run.skipped_transfers).toBe(2);

    // Both transfer halves must still exist and stay linked
    for (const [accountId, amount] of [
      [checking.id, -10000],
      [savings.id, 10000],
    ] as const) {
      const list = parseJsonOutput<{
        data: Array<{ amount: number; transfer_id: string | null }>;
      }>(
        cli([
          'transactions',
          'list',
          accountId,
          '--start',
          '2026-02-01',
          '--end',
          '2026-02-28',
        ]).stdout,
      );
      expect(
        list.data.some(row => row.amount === amount && row.transfer_id),
      ).toBe(true);
    }

    // --include-transfers opts back in (dry-run so nothing is harmed)
    const optIn = parseJsonOutput<{
      metadata?: { matched?: number; skipped_transfers?: number };
      matched?: number;
      skipped_transfers?: number;
    }>(cli(['rules', 'run', '--dry-run', '--include-transfers']).stdout);
    const matched = optIn.matched ?? optIn.metadata?.matched ?? 0;
    expect(matched).toBe(2);

    const plainTransaction = cli([
      'transactions',
      'add',
      checking.id,
      '--date',
      '2026-02-11',
      '--amount',
      '-5.00',
      '--notes',
      'Plain rule target',
    ]);
    expect(plainTransaction.exitCode).toBe(0);
    const plainRule = cli([
      'rules',
      'create',
      JSON.stringify({
        stage: null,
        conditionsOp: 'and',
        conditions: [
          { field: 'notes', op: 'contains', value: 'Plain rule target' },
        ],
        actions: [{ field: 'payee', op: 'set', value: roguePayee.id }],
      }),
    ]);
    expect(plainRule.exitCode).toBe(0);

    // --and-commit must remain one parseable JSON document while reporting the
    // automatic pre-mutation snapshot.
    const committed = parseJsonOutput<{
      matched: number;
      updated: number;
      skipped_transfers: number;
      snapshot: string;
      data: unknown[];
    }>(cli(['rules', 'run', '--and-commit']).stdout);
    expect(committed.matched).toBe(1);
    expect(committed.updated).toBe(1);
    expect(committed.skipped_transfers).toBe(2);
    expect(committed.data).toHaveLength(1);
    expect(existsSync(committed.snapshot)).toBe(true);
  });

  it('allows category rules on mixed on/off-budget transfers', () => {
    createLocalBudget(testEnv, 'MixedTransferRuleBudget');

    const checking = parseJsonOutput<{ id: string }>(
      cli(['accounts', 'create', 'Checking']).stdout,
    );
    const mortgage = parseJsonOutput<{ id: string }>(
      cli(['accounts', 'create', 'Mortgage', '--offbudget']).stdout,
    );
    const group = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create-group', 'Housing']).stdout,
    );
    const category = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create', 'Mortgage Principal', '--group', group.id]).stdout,
    );

    expect(cli([
      'transactions',
      'transfer',
      checking.id,
      mortgage.id,
      '--date',
      '2026-03-01',
      '--amount',
      '500.00',
      '--notes',
      'Mortgage payment',
    ]).exitCode).toBe(0);

    expect(cli([
      'rules',
      'create',
      JSON.stringify({
        stage: null,
        conditionsOp: 'and',
        conditions: [
          { field: 'account', op: 'is', value: checking.id },
          { field: 'notes', op: 'contains', value: 'Mortgage payment' },
        ],
        actions: [{ field: 'category', op: 'set', value: category.id }],
      }),
    ]).exitCode).toBe(0);

    const run = parseJsonOutput<{
      updated?: number;
      skipped_transfers?: number;
      metadata?: { updated?: number; skipped_transfers?: number };
    }>(cli(['rules', 'run']).stdout);
    expect(run.updated ?? run.metadata?.updated).toBe(1);
    expect(run.skipped_transfers ?? run.metadata?.skipped_transfers ?? 0).toBe(0);

    const checkingRows = parseJsonOutput<{
      data: Array<{ category: string | null; transfer_id: string | null }>;
    }>(cli([
      'transactions',
      'list',
      checking.id,
      '--start',
      '2026-03-01',
      '--end',
      '2026-03-31',
    ]).stdout);
    expect(checkingRows.data).toContainEqual(
      expect.objectContaining({ category: category.id }),
    );
    expect(checkingRows.data.some(row => row.transfer_id)).toBe(true);
  });

  it('refuses to update a rule that does not exist', () => {
    createLocalBudget(testEnv, 'RuleUpdateBudget');

    const group = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create-group', 'Spending']).stdout,
    );
    const category = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create', 'Dining', '--group', group.id]).stdout,
    );

    const bogusId = '00000000-0000-4000-8000-000000000000';
    const updateResult = cli([
      'rules',
      'update',
      JSON.stringify({
        id: bogusId,
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'imported_payee', op: 'contains', value: 'UBER' }],
        actions: [{ field: 'category', op: 'set', value: category.id }],
      }),
    ]);
    expect(updateResult.exitCode).not.toBe(0);
    expect(`${updateResult.stderr}${updateResult.stdout}`).toContain(
      'Rule not found',
    );

    // and it must NOT have silently created a rule with that id
    const list = parseJsonOutput<{ data: Array<{ id: string }> }>(
      cli(['rules', 'list']).stdout,
    );
    expect(list.data.some(rule => rule.id === bogusId)).toBe(false);
  });

  it('prints the rule-create envelope before the run output for create --run', () => {
    createLocalBudget(testEnv, 'RuleCreateRunBudget');

    const group = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create-group', 'Spending']).stdout,
    );
    const category = parseJsonOutput<{ id: string }>(
      cli(['categories', 'create', 'Dining', '--group', group.id]).stdout,
    );

    const result = cli([
      'rules',
      'create',
      JSON.stringify({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'imported_payee', op: 'contains', value: 'UBER' }],
        actions: [{ field: 'category', op: 'set', value: category.id }],
      }),
      '--run',
    ]);
    expect(result.exitCode).toBe(0);
    const firstLine = result.stdout.trim().split('\n')[0];
    const envelope = JSON.parse(firstLine) as {
      status: string;
      entity: string;
      action: string;
      id?: string;
    };
    expect(envelope).toMatchObject({
      status: 'ok',
      entity: 'rule',
      action: 'create',
    });
    expect(envelope.id).toBeTruthy();
  });
});
