import { readFileSync, writeFileSync } from 'node:fs';

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
  }, 20000);
});
