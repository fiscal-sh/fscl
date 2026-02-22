import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import { commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { deleteDraft, readDraft, writeDraft } from '../drafts.js';
import { printDraftValidationErrors, printRows, printStatusOk } from '../output.js';
import {
  buildNameMaps,
  enrichRows,
  getActionCommand,
  parseJsonWithSchema,
  requireYes,
  send,
} from './common.js';

const PREVIEW_COLUMNS = [
  'id',
  'date',
  'account',
  'account_name',
  'amount',
  'payee',
  'payee_name',
  'category',
  'category_name',
  'notes',
];

const APPLY_COLUMNS = [
  'id',
  'date',
  'account',
  'account_name',
  'amount',
  'payee_before',
  'payee_before_name',
  'payee_after',
  'payee_after_name',
  'notes',
  'category_before',
  'category_before_name',
  'category_after',
  'category_after_name',
  'matched_rule',
];

const RULE_DIFF_FIELDS = ['category', 'payee', 'notes', 'cleared'] as const;

const RuleConditionSchema = z.object({
  field: z.string().min(1, 'condition.field is required'),
  op: z.string().min(1, 'condition.op is required'),
  value: z.unknown(),
}).strict();

const RuleActionSchema = z.object({
  field: z.string().min(1, 'action.field is required'),
  op: z.string().min(1, 'action.op is required'),
  value: z.unknown(),
}).strict();

const RuleInputSchema = z.object({
  stage: z.union([z.literal('pre'), z.literal('post'), z.null()]).optional(),
  conditionsOp: z.enum(['and', 'or']).optional(),
  conditions: z.array(RuleConditionSchema).min(1, 'At least one condition is required'),
  actions: z.array(RuleActionSchema).min(1, 'At least one action is required'),
}).passthrough();

const RuleWithIdSchema = RuleInputSchema.extend({
  id: z.string().min(1, 'id is required'),
});

const RuleBatchEntrySchema = z.object({
  stage: z.union([z.literal('pre'), z.literal('post'), z.null()]).optional(),
  conditionsOp: z.enum(['and', 'or']).optional(),
  conditions: z.array(RuleConditionSchema).min(1, 'At least one condition is required'),
  actions: z.array(RuleActionSchema).min(1, 'At least one action is required'),
}).strict();

const RuleBatchSchema = z.array(RuleBatchEntrySchema).min(
  1,
  'Expected a non-empty JSON array of rule objects',
);

const RuleDraftEntrySchema = RuleInputSchema.extend({
  id: z.string().trim().min(1, 'id must be non-empty when provided').optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const RuleDraftSchema = z.array(RuleDraftEntrySchema);

type RuleMatcher = {
  id: string;
  conditionsOp: 'and' | 'or';
  filters: Array<Record<string, unknown>>;
  categoryAfter?: string;
};

type RuleValidationError = {
  conditionErrors?: string[];
  actionErrors?: string[];
};

function normalizeValidationErrors(
  value: unknown,
): { conditionErrors: string[]; actionErrors: string[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const err = value as RuleValidationError;
  return {
    conditionErrors: Array.isArray(err.conditionErrors)
      ? err.conditionErrors.filter(item => typeof item === 'string')
      : [],
    actionErrors: Array.isArray(err.actionErrors)
      ? err.actionErrors.filter(item => typeof item === 'string')
      : [],
  };
}

async function validateRuleOrThrow(rule: Record<string, unknown>): Promise<void> {
  const result = (await send('rule-validate', rule)) as {
    error?: RuleValidationError | null;
  };
  const errors = normalizeValidationErrors(result.error);
  if (!errors) {
    return;
  }
  const lines = [
    ...errors.conditionErrors.map(message => `condition: ${message}`),
    ...errors.actionErrors.map(message => `action: ${message}`),
  ];
  if (lines.length === 0) {
    throw new Error('Rule validation failed');
  }
  throw new Error(`Rule validation failed: ${lines.join(' | ')}`);
}

function normalizeConditionsOp(value: unknown): 'and' | 'or' {
  return value === 'or' ? 'or' : 'and';
}

function normalizeRulePayload(
  rule: Record<string, unknown>,
): {
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
  conditions: unknown[];
  actions: unknown[];
} {
  return {
    stage: rule.stage === 'pre' || rule.stage === 'post' ? rule.stage : null,
    conditionsOp: normalizeConditionsOp(rule.conditionsOp),
    conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
    actions: Array.isArray(rule.actions) ? rule.actions : [],
  };
}

function ruleFingerprint(rule: Record<string, unknown>): string {
  return JSON.stringify(normalizeRulePayload(rule));
}

function actionTarget(actions: unknown, field: string): string | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  for (const action of actions) {
    if (
      action &&
      typeof action === 'object' &&
      (action as Record<string, unknown>).field === field &&
      (action as Record<string, unknown>).op === 'set' &&
      typeof (action as Record<string, unknown>).value === 'string' &&
      (action as Record<string, unknown>).value
    ) {
      return (action as Record<string, unknown>).value as string;
    }
  }
  return undefined;
}

function categoryActionTarget(actions: unknown): string | undefined {
  return actionTarget(actions, 'category');
}

function toRuleBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return undefined;
}

function extractRuleDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const field of RULE_DIFF_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(after, field)) {
      continue;
    }
    const afterVal = after[field];
    if (afterVal !== undefined && afterVal !== before[field]) {
      diff[field] = afterVal;
    }
  }
  return diff;
}

function applyRuleActionsPreview(
  transaction: Record<string, unknown>,
  actions: unknown[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...transaction };

  for (const rawAction of actions) {
    if (!rawAction || typeof rawAction !== 'object') {
      continue;
    }
    const action = rawAction as Record<string, unknown>;
    const op = action.op;
    if (op === 'set') {
      const field = action.field;
      const options = action.options;
      if (
        options &&
        typeof options === 'object' &&
        ((options as Record<string, unknown>).formula != null ||
          (options as Record<string, unknown>).template != null)
      ) {
        continue;
      }

      if (field === 'category' || field === 'payee' || field === 'notes') {
        const value = action.value;
        if (typeof value === 'string' || value === null) {
          next[field] = value;
        }
      } else if (field === 'cleared') {
        const cleared = toRuleBoolean(action.value);
        if (cleared !== undefined) {
          next.cleared = cleared;
        }
      }
      continue;
    }

    if (op === 'prepend-notes' || op === 'append-notes') {
      if (typeof action.value !== 'string') {
        continue;
      }
      const current = typeof next.notes === 'string' ? next.notes : '';
      next.notes = op === 'prepend-notes'
        ? current
          ? `${action.value}${current}`
          : action.value
        : current
          ? `${current}${action.value}`
          : action.value;
    }
  }

  return next;
}

function buildRuleApplyOutputRows(
  beforeRows: Array<Record<string, unknown>>,
  afterRows: Array<Record<string, unknown>>,
  ruleId: string,
): Array<Record<string, unknown>> {
  const afterById = new Map<string, Record<string, unknown>>();
  for (const row of afterRows) {
    if (typeof row.id === 'string' && row.id) {
      afterById.set(row.id, row);
    }
  }

  const outputRows: Array<Record<string, unknown>> = [];
  for (const before of beforeRows) {
    const id = typeof before.id === 'string' ? before.id : '';
    const after = id ? (afterById.get(id) ?? before) : before;
    const diff = extractRuleDiff(before, after);
    if (Object.keys(diff).length === 0) {
      continue;
    }

    const categoryBefore =
      typeof before.category === 'string' ? before.category : '';
    const payeeBefore = typeof before.payee === 'string' ? before.payee : '';
    const categoryAfter = typeof after.category === 'string' ? after.category : '';
    const payeeAfter = typeof after.payee === 'string' ? after.payee : '';

    outputRows.push({
      ...before,
      ...diff,
      category_before: categoryBefore,
      category_after: categoryAfter,
      payee_before: payeeBefore,
      payee_after: payeeAfter,
      matched_rule: ruleId,
    });
  }
  return outputRows;
}

function asRecordRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    item => item && typeof item === 'object',
  ) as Array<Record<string, unknown>>;
}

async function enrichRuleApplyRows(
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const { accountNames, categoryNames, payeeNames } = await buildNameMaps();
  enrichRows(rows, accountNames, categoryNames, payeeNames);
  for (const row of rows) {
    const catBefore =
      typeof row.category_before === 'string' ? row.category_before : '';
    const catAfter =
      typeof row.category_after === 'string' ? row.category_after : '';
    row.category_before_name = catBefore
      ? categoryNames.get(catBefore) ?? ''
      : '';
    row.category_after_name = catAfter
      ? categoryNames.get(catAfter) ?? ''
      : '';
    const payBefore =
      typeof row.payee_before === 'string' ? row.payee_before : '';
    const payAfter =
      typeof row.payee_after === 'string' ? row.payee_after : '';
    row.payee_before_name = payBefore
      ? payeeNames.get(payBefore) ?? ''
      : '';
    row.payee_after_name = payAfter
      ? payeeNames.get(payAfter) ?? ''
      : '';
  }
}

async function buildRuleMatchers(
  rules: Array<Record<string, unknown>>,
): Promise<RuleMatcher[]> {
  const matchers: RuleMatcher[] = [];
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || !rule.id) {
      continue;
    }
    const conditions = Array.isArray(rule.conditions)
      ? rule.conditions
      : [];
    const { filters } = (await send('make-filters-from-conditions', {
      conditions,
    })) as { filters: unknown[] };
    matchers.push({
      id: rule.id,
      conditionsOp: normalizeConditionsOp(rule.conditionsOp),
      filters: filters
        .filter(filter => filter && typeof filter === 'object')
        .map(filter => filter as Record<string, unknown>),
      categoryAfter: categoryActionTarget(rule.actions),
    });
  }
  return matchers;
}

async function transactionMatchesRule(
  transactionId: string,
  matcher: RuleMatcher,
): Promise<boolean> {
  let query = api.q('transactions').filter({ id: transactionId }).select(['id']).limit(1);
  if (matcher.filters.length > 0) {
    if (matcher.conditionsOp === 'or') {
      query = query.filter({ $or: matcher.filters });
    } else {
      for (const filter of matcher.filters) {
        query = query.filter(filter);
      }
    }
  }
  const result = await api.aqlQuery(query as Parameters<typeof api.aqlQuery>[0]);
  const rows = ((result as { data?: unknown }).data ?? []) as Array<
    Record<string, unknown>
  >;
  return rows.length > 0;
}

async function matchedRuleIdForTransaction(
  transactionId: string,
  categoryAfter: string,
  matchers: RuleMatcher[],
): Promise<string> {
  for (const matcher of matchers) {
    if (matcher.categoryAfter && matcher.categoryAfter !== categoryAfter) {
      continue;
    }
    if (await transactionMatchesRule(transactionId, matcher)) {
      return matcher.id;
    }
  }
  return '';
}

async function applySingleRule(
  ruleId: string,
  format: 'json' | 'table',
  mode: 'dry-run' | 'apply' | 'and-commit',
): Promise<void> {
  const rule = (await send('rule-get', {
    id: ruleId,
  })) as Record<string, unknown> | null;
  if (!rule) {
    throw new Error(`Rule not found: ${ruleId}`);
  }

  const result = await api.aqlQuery(
    api.q('transactions')
      .filter({ category: null })
      .select(['*'])
      .orderBy({ date: 'desc' }) as Parameters<typeof api.aqlQuery>[0],
  );
  const uncategorized = ((result as { data?: unknown }).data ?? []) as Array<
    Record<string, unknown>
  >;

  if (uncategorized.length === 0) {
    printStatusOk({
      entity: 'rules-run',
      rule: ruleId,
      matched: 0,
      updated: 0,
    });
    return;
  }

  const conditions = rule.conditions as unknown[];
  const conditionsOp = normalizeConditionsOp(rule.conditionsOp);
  const actions = rule.actions as unknown[];

  const { filters } = (await send('make-filters-from-conditions', {
    conditions,
  })) as { filters: unknown[] };

  let matchQuery = api.q('transactions')
    .filter({ category: null })
    .select(['*']);
  if (filters.length > 0) {
    if (conditionsOp === 'or') {
      matchQuery = matchQuery.filter({
        $or: filters as Record<string, unknown>[],
      });
    } else {
      for (const filter of filters) {
        matchQuery = matchQuery.filter(filter as Record<string, unknown>);
      }
    }
  }

  const matchResult = await api.aqlQuery(
    matchQuery as Parameters<typeof api.aqlQuery>[0],
  );
  const matched = ((matchResult as { data?: unknown }).data ?? []) as Array<
    Record<string, unknown>
  >;

  if (matched.length === 0) {
    printStatusOk({
      entity: 'rules-run',
      rule: ruleId,
      matched: 0,
      updated: 0,
    });
    return;
  }

  const previewAfterRows = matched.map(tx => applyRuleActionsPreview(tx, actions));
  const previewRows = buildRuleApplyOutputRows(matched, previewAfterRows, ruleId);
  await enrichRuleApplyRows(previewRows);

  if (mode === 'and-commit') {
    printRows(format, 'rules-run-preview', previewRows, APPLY_COLUMNS, {
      rule: ruleId,
      matched: previewRows.length,
      updated: 0,
      dryRun: 1,
    });
    const applyResult = (await send('rule-apply-actions', {
      transactions: matched,
      actions,
    })) as { updated?: unknown[] };
    const appliedRows = buildRuleApplyOutputRows(
      matched,
      asRecordRows(applyResult.updated),
      ruleId,
    );
    printStatusOk({
      entity: 'rules-run-result',
      rule: ruleId,
      matched: appliedRows.length,
      updated: appliedRows.length,
    });
    return;
  }

  if (mode === 'apply') {
    const applyResult = (await send('rule-apply-actions', {
      transactions: matched,
      actions,
    })) as { updated?: unknown[] };
    const appliedRows = buildRuleApplyOutputRows(
      matched,
      asRecordRows(applyResult.updated),
      ruleId,
    );
    await enrichRuleApplyRows(appliedRows);
    printRows(format, 'rules-run', appliedRows, APPLY_COLUMNS, {
      rule: ruleId,
      matched: appliedRows.length,
      updated: appliedRows.length,
      dryRun: 0,
    });
    return;
  }

  printRows(format, 'rules-run', previewRows, APPLY_COLUMNS, {
    rule: ruleId,
    matched: previewRows.length,
    updated: 0,
    dryRun: 1,
  });
}

export function registerRuleCommands(program: Command) {
  const rules = program.command('rules').description('Manage rules');

  rules
    .command('list')
    .description('List rules')
    .addHelpText(
      'after',
      `
Example:
  fiscal rules list

Output columns: id, stage, conditions_op, conditions (JSON), actions (JSON)

Conditions JSON schema: [{"field":"payee","op":"is","value":"<payee-id>"}, ...]
  Fields: account, amount, category, date, notes, payee, imported_payee, cleared, reconciled
  Ops vary by field. Common: is, isNot, contains, doesNotContain, oneOf, gt, lt, gte, lte

Actions JSON schema: [{"field":"category","op":"set","value":"<category-id>"}, ...]
  Ops: set, set-split-amount, link-schedule, prepend-notes, append-notes`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const list = (await api.getRules()) as Array<Record<string, unknown>>;
          const rows = list.map(rule => ({
            id: rule.id,
            stage: rule.stage,
            conditions_op: rule.conditionsOp,
            conditions: JSON.stringify(rule.conditions),
            actions: JSON.stringify(rule.actions),
          }));
          printRows(format, 'rules', rows, [
            'id',
            'stage',
            'conditions_op',
            'conditions',
            'actions',
          ]);
        });
      }),
    );

  rules
    .command('preview <ruleJson>')
    .description('Preview which existing transactions a rule would match')
    .addHelpText(
      'after',
      `
Example:
  fiscal rules preview '{"conditions":[{"field":"payee","op":"contains","value":"UBER"}],"conditionsOp":"and","actions":[{"field":"category","op":"set","value":"cat-dining"}]}'

Shows all transactions matching the rule's conditions without creating the rule.
Use this to verify a rule before committing it with "rules create".`,
    )
    .action(
      commandAction(async (ruleJson: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const rule = parseJsonWithSchema(ruleJson, RuleInputSchema, 'rule payload');
        const conditions = rule.conditions;
        const conditionsOp = normalizeConditionsOp(rule.conditionsOp);

        await withBudget(session, async () => {
          const { filters } = (await send('make-filters-from-conditions', {
            conditions,
          })) as { filters: unknown[] };

          let query = api.q('transactions').select(['*']);
          if (filters.length > 0) {
            if (conditionsOp === 'or') {
              query = query.filter({ $or: filters as Record<string, unknown>[] });
            } else {
              for (const filter of filters) {
                query = query.filter(filter as Record<string, unknown>);
              }
            }
          }
          query = query.orderBy({ date: 'desc' });

          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          const rows = ((result as { data?: unknown }).data ?? []) as Array<
            Record<string, unknown>
          >;

          const { accountNames, categoryNames, payeeNames } = await buildNameMaps();
          enrichRows(rows, accountNames, categoryNames, payeeNames);

          printRows(format, 'rule-preview', rows, PREVIEW_COLUMNS, {
            matches: rows.length,
            actions: JSON.stringify(rule.actions ?? []),
          });
        });
      }),
    );

  rules
    .command('run')
    .option('--rule <id>', 'Run only this rule (default: all rules)')
    .option('--dry-run', 'Preview changes without applying')
    .option('--and-commit', 'Preview then commit in one call')
    .description('Run rules retroactively on uncategorized transactions')
    .addHelpText(
      'after',
      `
Examples:
  fiscal rules run --dry-run             # preview what all rules would change
  fiscal rules run                       # apply all rules to uncategorized txns
  fiscal rules run --rule rule-abc123    # apply one specific rule
  fiscal rules run --and-commit          # preview then apply in one call

Finds uncategorized transactions and runs rules against them.
Only transactions where rules change one of these fields are reported:
category, payee, notes, or cleared.

Output includes payee_before/payee_after, category_before/category_after,
and matched_rule.`,
    )
    .action(
      commandAction(async (options: { rule?: string; dryRun?: boolean; andCommit?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const dryRun = Boolean(options.dryRun);
        const andCommit = Boolean(options.andCommit);

        if (dryRun && andCommit) {
          throw new Error('--dry-run and --and-commit are mutually exclusive');
        }

        await withBudget(
          { ...session, write: !dryRun },
          async () => {
            if (options.rule) {
              const mode = andCommit
                ? 'and-commit'
                : dryRun
                  ? 'dry-run'
                  : 'apply';
              await applySingleRule(options.rule, format, mode);
              return;
            }

            // All rules mode: get uncategorized transactions
            const result = await api.aqlQuery(
              api.q('transactions')
                .filter({ category: null })
                .select(['*'])
                .orderBy({ date: 'desc' }) as Parameters<typeof api.aqlQuery>[0],
            );
            const uncategorized = ((result as { data?: unknown }).data ?? []) as Array<
              Record<string, unknown>
            >;

            if (uncategorized.length === 0) {
              printStatusOk({
                entity: 'rules-run',
                matched: 0,
                updated: 0,
              });
              return;
            }

            const allRules = (await api.getRules()) as Array<Record<string, unknown>>;
            const matchers = await buildRuleMatchers(allRules);
            const changed: Array<Record<string, unknown>> = [];
            for (const tx of uncategorized) {
              const after = (await send('rules-run', {
                transaction: tx,
              })) as Record<string, unknown>;

              const diff = extractRuleDiff(tx, after);
              if (Object.keys(diff).length === 0) {
                continue;
              }

              const categoryAfter = Object.prototype.hasOwnProperty.call(diff, 'category')
                ? (typeof diff.category === 'string' ? diff.category : '')
                : (typeof tx.category === 'string' ? tx.category : '');
              const matchedRule =
                typeof tx.id === 'string' && categoryAfter
                  ? await matchedRuleIdForTransaction(tx.id, categoryAfter, matchers)
                  : '';
              const categoryBefore =
                typeof tx.category === 'string' ? tx.category : '';
              const payeeBefore =
                typeof tx.payee === 'string' ? tx.payee : '';
              const payeeAfter = Object.prototype.hasOwnProperty.call(diff, 'payee')
                ? (typeof diff.payee === 'string' ? diff.payee : '')
                : payeeBefore;

              changed.push({
                ...tx,
                ...diff,
                category_before: categoryBefore,
                category_after: categoryAfter,
                payee_before: payeeBefore,
                payee_after: payeeAfter,
                matched_rule: matchedRule,
                _diff: diff,
              });
            }

            await enrichRuleApplyRows(changed);

            // Build batch updates with all changed fields
            const buildUpdates = () =>
              changed.map(tx => ({
                id: tx.id,
                ...(tx._diff as Record<string, unknown>),
              }));

            if (andCommit) {
              printRows(format, 'rules-run-preview', changed, APPLY_COLUMNS, {
                matched: changed.length,
                updated: 0,
                dryRun: 1,
              });
              if (changed.length > 0) {
                await send('transactions-batch-update', { updated: buildUpdates() });
              }
              printStatusOk({
                entity: 'rules-run-result',
                matched: changed.length,
                updated: changed.length,
              });
            } else {
              if (changed.length > 0 && !dryRun) {
                await send('transactions-batch-update', { updated: buildUpdates() });
              }
              printRows(format, 'rules-run', changed, APPLY_COLUMNS, {
                matched: changed.length,
                updated: dryRun ? 0 : changed.length,
                dryRun: dryRun ? 1 : 0,
              });
            }
          },
        );
      }),
    );

  rules
    .command('validate <ruleJson>')
    .description('Validate rule JSON without creating or updating it')
    .addHelpText(
      'after',
      `
Example:
  fiscal rules validate '{"stage":null,"conditionsOp":"and","conditions":[{"field":"payee","op":"contains","value":"UBER"}],"actions":[{"field":"category","op":"set","value":"cat-dining"}]}'`,
    )
    .action(
      commandAction(async (ruleJson: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const rule = parseJsonWithSchema(ruleJson, RuleInputSchema, 'rule payload');
        await withBudget(session, async () => {
          const result = (await send('rule-validate', rule)) as {
            error?: RuleValidationError | null;
          };
          const errors = normalizeValidationErrors(result.error);
          if (!errors) {
            printStatusOk({
              entity: 'rule-validation',
              valid: 1,
            });
            return;
          }

          const rows = [
            ...errors.conditionErrors.map(message => ({
              scope: 'condition',
              message,
            })),
            ...errors.actionErrors.map(message => ({
              scope: 'action',
              message,
            })),
          ];
          printRows(format, 'rule-validation', rows, ['scope', 'message'], {
            valid: 0,
          });
          process.exitCode = 1;
        });
      }),
    );

  rules
    .command('create <ruleJson>')
    .option('--run', 'Run rule retroactively after creation')
    .description('Create rule from JSON')
    .addHelpText(
      'after',
      `
Examples:
  fiscal rules create '{"stage":null,"conditionsOp":"and","conditions":[{"field":"imported_payee","op":"contains","value":"UBER EATS"}],"actions":[{"field":"category","op":"set","value":"cat-dining-id"}]}'
  fiscal rules create '...' --run     # create and retroactively run

stage: null (default), "pre", or "post"
conditionsOp: "and" or "or"
See "rules list --help" for conditions/actions schema.`,
    )
    .action(
      commandAction(async (ruleJson: string, options: { run?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const rule = parseJsonWithSchema(ruleJson, RuleInputSchema, 'rule payload');
        await withBudget(
          { ...session, write: true },
          async () => {
            await validateRuleOrThrow(rule);
            const created = (await api.createRule(
              rule as unknown as Parameters<typeof api.createRule>[0],
            )) as { id?: string };
            printStatusOk({
              entity: 'rule',
              action: 'create',
              id: created?.id,
            });
            if (options.run && created?.id) {
              await applySingleRule(created.id, format, 'apply');
            }
          },
        );
      }),
    );

  rules
    .command('create-batch <json>')
    .description('Create multiple rules in a single session')
    .addHelpText(
      'after',
      `
Example:
  fiscal rules create-batch '[{"stage":null,"conditionsOp":"and","conditions":[...],"actions":[...]},{"stage":"pre","conditionsOp":"and","conditions":[...],"actions":[...]}]'
  fiscal rules create-batch @rules.json

All rules are validated before any are created. If any rule fails validation, no rules are created.
Supports @filepath for JSON input.`,
    )
    .action(
      commandAction(async (json: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const rules = parseJsonWithSchema(json, RuleBatchSchema, 'rules batch payload');
        await withBudget(
          { ...session, write: true },
          async () => {
            // Phase 1: validate all rules before creating any
            for (const rule of rules) {
              await validateRuleOrThrow(rule);
            }
            // Phase 2: create all validated rules
            const rows: Array<Record<string, unknown>> = [];
            for (const rule of rules) {
              const created = (await api.createRule(
                rule as unknown as Parameters<typeof api.createRule>[0],
              )) as { id?: string };
              rows.push({
                id: created?.id,
                stage: rule.stage ?? null,
              });
            }
            printRows(format, 'rules-create-batch', rows, ['id', 'stage'], {
              created: rows.length,
            });
          },
        );
      }),
    );

  rules
    .command('update <ruleJsonWithId>')
    .description('Update full rule object from JSON (must include id)')
    .addHelpText(
      'after',
      `
Example:
  fiscal rules update '{"id":"rule-abc","stage":null,"conditionsOp":"and","conditions":[...],"actions":[...]}'

The entire rule object must be provided (not just changed fields).`,
    )
    .action(
      commandAction(async (ruleJsonWithId: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const rule = parseJsonWithSchema(
          ruleJsonWithId,
          RuleWithIdSchema,
          'rule update payload',
        );
        await withBudget(
          { ...session, write: true },
          async () => {
            await validateRuleOrThrow(rule);
            const updated = (await api.updateRule(
              rule as unknown as Parameters<typeof api.updateRule>[0],
            )) as { id?: string };
            printStatusOk({
              entity: 'rule',
              action: 'update',
              id: updated?.id ?? (rule.id as string),
            });
          },
        );
      }),
    );

  rules
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete rule')
    .action(
      commandAction(async (id: string, options: { yes?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a rule');
        await withBudget(
          { ...session, write: true },
          async () => {
            await api.deleteRule(id);
            printStatusOk({ entity: 'rule', action: 'delete', id });
          },
        );
      }),
    );

  rules
    .command('draft')
    .description('Generate a rules draft JSON file for bulk editing')
    .addHelpText(
      'after',
      `
Examples:
  fiscal rules draft

Writes <dataDir>/<budgetId>/drafts/rules.json with full editable rule objects.
Each row includes id, stage, conditionsOp, conditions, actions, and _meta.
To create a new rule, add a row without id.
Edit the rules in place, then run:
  fiscal rules apply`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async resolved => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const list = (await api.getRules()) as Array<Record<string, unknown>>;
          const draftEntries = list.map((rule, index) => ({
            id: typeof rule.id === 'string' && rule.id ? rule.id : undefined,
            stage: rule.stage === 'pre' || rule.stage === 'post' ? rule.stage : null,
            conditionsOp: normalizeConditionsOp(rule.conditionsOp),
            conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
            actions: Array.isArray(rule.actions) ? rule.actions : [],
            _meta: {
              index,
            },
          }));

          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            'rules.json',
            draftEntries,
          );
          printStatusOk({
            entity: 'rules-draft',
            action: 'create',
            path: filePath,
            rules: draftEntries.length,
          });
        });
      }),
    );

  rules
    .command('apply')
    .option('--dry-run', 'Validate and preview without updating rules')
    .description('Apply a rules draft JSON file')
    .addHelpText(
      'after',
      `
Examples:
  fiscal rules apply
  fiscal rules apply --dry-run

Reads <dataDir>/<budgetId>/drafts/rules.json, validates each rule with Zod
and the Actual rule-validate API, creates rows without id, updates rows with
id, skips unchanged rows, and deletes the draft file on success.`,
    )
    .action(
      commandAction(
        async (
          options: { dryRun?: boolean },
          ...args: unknown[]
        ) => {
          const cmd = getActionCommand(args);
          const session = getSessionOptions(cmd);
          const format = getFormat(cmd);
          const dryRun = Boolean(options.dryRun);

          await withBudget(
            { ...session, write: !dryRun },
            async resolved => {
              if (!resolved.budgetId) {
                throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
              }
              const result = readDraft(
                resolved.dataDir,
                resolved.budgetId,
                'rules.json',
                RuleDraftSchema,
              );

              if (!result.ok) {
                printDraftValidationErrors('rules-draft', result.errors);
                process.exitCode = 1;
                return;
              }

              const cleanRules = result.data.map((entry, index) => {
                const { _meta: _, ...ruleFields } = entry;
                return {
                  index,
                  ruleFields,
                };
              });

              const existingRules = (await api.getRules()) as Array<Record<string, unknown>>;
              const existingById = new Map<string, Record<string, unknown>>();
              for (const existingRule of existingRules) {
                if (typeof existingRule.id === 'string' && existingRule.id) {
                  existingById.set(existingRule.id, existingRule);
                }
              }

              const idErrors: Array<{
                path: string;
                message: string;
              }> = [];
              const seenIds = new Set<string>();

              type PlannedChange = {
                index: number;
                id?: string;
                payload: ReturnType<typeof normalizeRulePayload>;
                action: 'create' | 'update' | 'skip';
              };
              const planned: PlannedChange[] = [];

              for (const entry of cleanRules) {
                const id = typeof entry.ruleFields.id === 'string' && entry.ruleFields.id.trim()
                  ? entry.ruleFields.id.trim()
                  : undefined;
                if (id) {
                  if (seenIds.has(id)) {
                    idErrors.push({
                      path: `[${entry.index}].id`,
                      message: `Duplicate rule id in draft: ${id}`,
                    });
                    continue;
                  }
                  seenIds.add(id);
                  if (!existingById.has(id)) {
                    idErrors.push({
                      path: `[${entry.index}].id`,
                      message: `Rule not found: ${id}`,
                    });
                    continue;
                  }
                }

                const payload = normalizeRulePayload(entry.ruleFields as Record<string, unknown>);
                const action = id
                  ? (ruleFingerprint(payload as unknown as Record<string, unknown>) ===
                      ruleFingerprint(existingById.get(id) as Record<string, unknown>)
                    ? 'skip'
                    : 'update')
                  : 'create';
                planned.push({
                  index: entry.index,
                  id,
                  payload,
                  action,
                });
              }

              if (idErrors.length > 0) {
                printDraftValidationErrors('rules-draft', idErrors);
                process.exitCode = 1;
                return;
              }

              const mutable = planned.filter(item => item.action !== 'skip');

              const emptyErrors: Array<{
                path: string;
                message: string;
              }> = [];
              for (const item of mutable) {
                for (let j = 0; j < item.payload.actions.length; j++) {
                  const action = item.payload.actions[j] as Record<string, unknown>;
                  if (
                    action.field === 'category' &&
                    action.op === 'set' &&
                    (action.value === '' || action.value == null)
                  ) {
                    emptyErrors.push({
                      path: `[${item.index}].actions[${j}].value`,
                      message:
                        'Category action value is empty — assign a category ID',
                    });
                  }
                }
              }
              if (emptyErrors.length > 0) {
                printDraftValidationErrors('rules-draft', emptyErrors);
                process.exitCode = 1;
                return;
              }

              for (const item of mutable) {
                try {
                  await validateRuleOrThrow(
                    item.payload as unknown as Record<string, unknown>,
                  );
                } catch (err) {
                  printDraftValidationErrors('rules-draft', [
                    {
                      path: `[${item.index}]`,
                      message:
                        err instanceof Error
                          ? err.message
                          : 'Rule validation failed',
                    },
                  ]);
                  process.exitCode = 1;
                  return;
                }
              }

              if (dryRun) {
                const previewRows = planned.map(item => ({
                  index: item.index,
                  id: item.id ?? '',
                  action: item.action,
                  stage: item.payload.stage,
                  conditions: JSON.stringify(item.payload.conditions),
                  actions: JSON.stringify(item.payload.actions),
                  result: item.action === 'create'
                    ? 'would-create'
                    : item.action === 'update'
                      ? 'would-update'
                      : 'would-skip',
                }));
                const counts = planned.reduce(
                  (acc, item) => {
                    if (item.action === 'create') acc.create += 1;
                    if (item.action === 'update') acc.update += 1;
                    if (item.action === 'skip') acc.skip += 1;
                    return acc;
                  },
                  { create: 0, update: 0, skip: 0 },
                );
                printRows(
                  format,
                  'rules-apply-preview',
                  previewRows,
                  ['index', 'id', 'action', 'stage', 'conditions', 'actions', 'result'],
                  {
                    dryRun: 1,
                    rules: planned.length,
                    create: counts.create,
                    update: counts.update,
                    skip: counts.skip,
                  },
                );
                return;
              }

              const rows: Array<Record<string, unknown>> = [];
              let createdCount = 0;
              let updatedCount = 0;
              let skippedCount = 0;
              for (const item of planned) {
                if (item.action === 'skip') {
                  skippedCount += 1;
                  rows.push({
                    id: item.id ?? '',
                    action: 'skip',
                    stage: item.payload.stage,
                    result: 'skipped',
                  });
                  continue;
                }

                if (item.action === 'create') {
                  const created = (await api.createRule(
                    item.payload as unknown as Parameters<typeof api.createRule>[0],
                  )) as { id?: string };
                  createdCount += 1;
                  rows.push({
                    id: created?.id ?? '',
                    action: 'create',
                    stage: item.payload.stage,
                    result: 'created',
                  });
                  continue;
                }

                const updatePayload = {
                  id: item.id,
                  ...item.payload,
                };
                const updated = (await api.updateRule(
                  updatePayload as unknown as Parameters<typeof api.updateRule>[0],
                )) as { id?: string };
                updatedCount += 1;
                rows.push({
                  id: updated?.id ?? item.id ?? '',
                  action: 'update',
                  stage: item.payload.stage,
                  result: 'updated',
                });
              }

              deleteDraft(resolved.dataDir, resolved.budgetId, 'rules.json');

              printRows(
                format,
                'rules-apply',
                rows,
                ['id', 'action', 'stage', 'result'],
                {
                  created: createdCount,
                  updated: updatedCount,
                  skipped: skippedCount,
                  rules: planned.length,
                },
              );
            },
          );
        },
      ),
    );
}
