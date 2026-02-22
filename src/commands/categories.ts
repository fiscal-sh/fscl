import * as api from '@actual-app/api';
import { Command } from 'commander';
import { z } from 'zod';

import { CliError, ErrorCodes, commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { deleteDraft, readDraft, writeDraft } from '../drafts.js';
import { printDraftValidationErrors, printRows, printStatusOk } from '../output.js';
import {
  getActionCommand,
  requireYes,
  resolveCategoryGroupId,
  resolveCategoryId,
  validateCategoryId,
} from './common.js';

type CategoryCreateOptions = {
  group: string;
  income?: boolean;
};

type CategoryUpdateOptions = {
  name?: string;
};

type CategoryDeleteOptions = {
  transferTo?: string;
  yes?: boolean;
};

type GroupCreateOptions = {
  income?: boolean;
};

type GroupUpdateOptions = {
  name?: string;
};

type GroupDeleteOptions = {
  transferTo?: string;
  yes?: boolean;
};

const CategoryDraftCategorySchema = z.object({
  id: z.string().trim().min(1, 'id cannot be empty').optional(),
  name: z.string().trim().min(1, 'name is required'),
}).strict();

const CategoryDraftGroupSchema = z.object({
  id: z.string().trim().min(1, 'id cannot be empty').optional(),
  name: z.string().trim().min(1, 'name is required'),
  categories: z.array(CategoryDraftCategorySchema).default([]),
}).strict();

const CategoryDraftSchema = z.array(CategoryDraftGroupSchema);

type CategoryDraft = z.infer<typeof CategoryDraftSchema>;

type ExistingCategoryGroup = {
  id: string;
  name: string;
  isIncome: boolean;
};

type ExistingCategory = {
  id: string;
  name: string;
  groupId: string;
  isIncome: boolean;
};

async function validateCategoryGroupIds(ids: Iterable<string>): Promise<void> {
  const expected = [...new Set([...ids].filter(Boolean))];
  if (expected.length === 0) {
    return;
  }

  const groups = (await api.getCategoryGroups()) as Array<Record<string, unknown>>;
  const known = new Set(
    groups
      .map(group => (typeof group.id === 'string' ? group.id : ''))
      .filter((id): id is string => Boolean(id)),
  );
  for (const id of expected) {
    if (known.has(id)) {
      continue;
    }
    throw new CliError(
      `Category group '${id}' not found. Run 'fscl categories list' to see available category groups.`,
      ErrorCodes.ENTITY_NOT_FOUND,
    );
  }
}

function normalizeCategoryGroups(
  groups: Array<Record<string, unknown>>,
): ExistingCategoryGroup[] {
  const rows: ExistingCategoryGroup[] = [];
  for (const group of groups) {
    if (typeof group.id !== 'string' || typeof group.name !== 'string') {
      continue;
    }
    rows.push({
      id: group.id,
      name: group.name,
      isIncome: Boolean(group.is_income),
    });
  }
  return rows;
}

function normalizeCategories(
  categories: Array<Record<string, unknown>>,
): ExistingCategory[] {
  const rows: ExistingCategory[] = [];
  for (const category of categories) {
    if (
      typeof category.id !== 'string' ||
      typeof category.name !== 'string' ||
      typeof category.group_id !== 'string'
    ) {
      continue;
    }
    rows.push({
      id: category.id,
      name: category.name,
      groupId: category.group_id,
      isIncome: Boolean(category.is_income),
    });
  }
  return rows;
}

function validateCategoryDraftReferences(
  draft: CategoryDraft,
  groupById: Map<string, ExistingCategoryGroup>,
  categoryById: Map<string, ExistingCategory>,
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  const seenGroupIds = new Set<string>();
  const seenCategoryIds = new Set<string>();

  for (let i = 0; i < draft.length; i++) {
    const group = draft[i];
    if (group.id) {
      if (seenGroupIds.has(group.id)) {
        errors.push({
          path: `[${i}].id`,
          message: `Duplicate group id in draft: ${group.id}`,
        });
      } else if (!groupById.has(group.id)) {
        errors.push({
          path: `[${i}].id`,
          message: `Category group not found: ${group.id}`,
        });
      }
      seenGroupIds.add(group.id);
    }

    for (let j = 0; j < group.categories.length; j++) {
      const category = group.categories[j];
      if (!category.id) {
        continue;
      }
      if (seenCategoryIds.has(category.id)) {
        errors.push({
          path: `[${i}].categories[${j}].id`,
          message: `Duplicate category id in draft: ${category.id}`,
        });
      } else if (!categoryById.has(category.id)) {
        errors.push({
          path: `[${i}].categories[${j}].id`,
          message: `Category not found: ${category.id}`,
        });
      }
      seenCategoryIds.add(category.id);
    }
  }

  return errors;
}

export function registerCategoryCommands(program: Command) {
  const categories = program
    .command('categories')
    .description('Manage categories and groups');

  categories
    .command('list')
    .description('List category groups and categories')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const groups = (await api.getCategoryGroups()) as Array<
            Record<string, unknown>
          >;
          const categoriesList = (await api.getCategories()) as Array<
            Record<string, unknown>
          >;

          const rows: Record<string, unknown>[] = [];
          for (const group of groups) {
            rows.push({
              kind: 'group',
              id: group.id,
              name: group.name,
              is_income: group.is_income,
              hidden: group.hidden,
            });
            const childRows = categoriesList.filter(
              item => item.group_id === group.id,
            );
            for (const item of childRows) {
              rows.push({
                kind: 'category',
                id: item.id,
                group_id: item.group_id,
                name: item.name,
                is_income: item.is_income,
                hidden: item.hidden,
              });
            }
          }
          printRows(format, 'categories', rows, [
            'kind',
            'id',
            'group_id',
            'name',
            'is_income',
            'hidden',
          ]);
        });
      }),
    );

  categories
    .command('create <name>')
    .requiredOption('--group <groupId>', 'Parent group id')
    .option('--income', 'Create as income category')
    .description('Create category')
    .action(
      commandAction(async (name: string, options: CategoryCreateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedGroup = await resolveCategoryGroupId(options.group);
            const id = await api.createCategory({
              name,
              group_id: resolvedGroup,
              is_income: Boolean(options.income),
              hidden: false,
            });
            printStatusOk({
              entity: 'category',
              action: 'create',
              id,
              group_id: resolvedGroup,
            });
          },
        );
      }),
    );

  categories
    .command('draft')
    .description('Generate a category draft JSON file for bulk editing')
    .addHelpText(
      'after',
      `
Example:
  fiscal categories draft

Writes <dataDir>/<budgetId>/drafts/categories.json containing the current
group/category tree:
[
  { "id": "...", "name": "Group", "categories": [{ "id": "...", "name": "Category" }] }
]

Edit names, move categories between groups, and add new rows without an id.
Then run:
  fiscal categories apply`,
    )
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async resolved => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const groups = normalizeCategoryGroups(
            (await api.getCategoryGroups()) as Array<Record<string, unknown>>,
          );
          const categoriesList = normalizeCategories(
            (await api.getCategories()) as Array<Record<string, unknown>>,
          );

          const byGroupId = new Map<string, ExistingCategory[]>();
          for (const category of categoriesList) {
            const current = byGroupId.get(category.groupId) ?? [];
            current.push(category);
            byGroupId.set(category.groupId, current);
          }

          const draftEntries = groups.map(group => ({
            id: group.id,
            name: group.name,
            categories: (byGroupId.get(group.id) ?? []).map(category => ({
              id: category.id,
              name: category.name,
            })),
          }));

          const categoryCount = draftEntries.reduce(
            (sum, group) => sum + group.categories.length,
            0,
          );
          const filePath = writeDraft(
            resolved.dataDir,
            resolved.budgetId,
            'categories.json',
            draftEntries,
          );
          printStatusOk({
            entity: 'categories-draft',
            action: 'create',
            path: filePath,
            groups: draftEntries.length,
            categories: categoryCount,
          });
        });
      }),
    );

  categories
    .command('apply')
    .option('--dry-run', 'Preview changes without applying')
    .description('Apply a category draft JSON file')
    .addHelpText(
      'after',
      `
Examples:
  fiscal categories apply
  fiscal categories apply --dry-run

Reads <dataDir>/<budgetId>/drafts/categories.json and applies the draft:
- existing ids with changed names are renamed
- categories moved to a different group are reassigned
- rows without id are created
- missing rows are ignored (no deletion)

The draft file is deleted on successful non-dry-run apply.`,
    )
    .action(
      commandAction(async (options: { dryRun?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        const dryRun = Boolean(options.dryRun);

        await withBudget({ ...session, write: !dryRun }, async resolved => {
          if (!resolved.budgetId) {
            throw new Error("No budget selected. Run 'fscl init' or 'fscl budgets use <id>' to select one.");
          }

          const draftResult = readDraft(
            resolved.dataDir,
            resolved.budgetId,
            'categories.json',
            CategoryDraftSchema,
          );
          if (!draftResult.ok) {
            printDraftValidationErrors('categories-draft', draftResult.errors);
            process.exitCode = 1;
            return;
          }

          const existingGroups = normalizeCategoryGroups(
            (await api.getCategoryGroups()) as Array<Record<string, unknown>>,
          );
          const existingCategories = normalizeCategories(
            (await api.getCategories()) as Array<Record<string, unknown>>,
          );
          const groupById = new Map(existingGroups.map(group => [group.id, group]));
          const categoryById = new Map(
            existingCategories.map(category => [category.id, category]),
          );

          const referenceErrors = validateCategoryDraftReferences(
            draftResult.data,
            groupById,
            categoryById,
          );
          if (referenceErrors.length > 0) {
            printDraftValidationErrors('categories-draft', referenceErrors);
            process.exitCode = 1;
            return;
          }

          const rows: Array<Record<string, unknown>> = [];
          const counts = {
            groupsCreated: 0,
            groupsRenamed: 0,
            groupsSkipped: 0,
            categoriesCreated: 0,
            categoriesUpdated: 0,
            categoriesSkipped: 0,
          };

          for (let i = 0; i < draftResult.data.length; i++) {
            const groupEntry = draftResult.data[i];
            let resolvedGroupId: string;
            let resolvedGroupIncome = false;

            if (groupEntry.id) {
              const existingGroup = groupById.get(groupEntry.id);
              if (!existingGroup) {
                printDraftValidationErrors('categories-draft', [
                  {
                    path: `[${i}].id`,
                    message: `Category group not found: ${groupEntry.id}`,
                  },
                ]);
                process.exitCode = 1;
                return;
              }

              resolvedGroupId = existingGroup.id;
              resolvedGroupIncome = existingGroup.isIncome;

              if (existingGroup.name !== groupEntry.name) {
                if (!dryRun) {
                  await api.updateCategoryGroup(resolvedGroupId, {
                    name: groupEntry.name,
                  });
                }
                rows.push({
                  kind: 'group',
                  action: 'rename',
                  id: resolvedGroupId,
                  name: groupEntry.name,
                  group_id: resolvedGroupId,
                  from_group_id: '',
                  result: dryRun ? 'would-update' : 'updated',
                });
                counts.groupsRenamed += 1;
              } else {
                counts.groupsSkipped += 1;
              }
            } else {
              resolvedGroupIncome = false;
              if (dryRun) {
                resolvedGroupId = `new-group-${i + 1}`;
              } else {
                resolvedGroupId = await api.createCategoryGroup({
                  name: groupEntry.name,
                  is_income: false,
                  hidden: false,
                });
              }
              rows.push({
                kind: 'group',
                action: 'create',
                id: dryRun ? '(new)' : resolvedGroupId,
                name: groupEntry.name,
                group_id: resolvedGroupId,
                from_group_id: '',
                result: dryRun ? 'would-create' : 'created',
              });
              counts.groupsCreated += 1;
            }

            for (const categoryEntry of groupEntry.categories) {
              if (categoryEntry.id) {
                const existingCategory = categoryById.get(categoryEntry.id);
                if (!existingCategory) {
                  continue;
                }

                const fields: Record<string, unknown> = {};
                const actions: string[] = [];
                if (existingCategory.name !== categoryEntry.name) {
                  fields.name = categoryEntry.name;
                  actions.push('rename');
                }
                if (existingCategory.groupId !== resolvedGroupId) {
                  fields.group_id = resolvedGroupId;
                  if (existingCategory.isIncome !== resolvedGroupIncome) {
                    fields.is_income = resolvedGroupIncome;
                  }
                  actions.push('move');
                }

                if (actions.length === 0) {
                  counts.categoriesSkipped += 1;
                  continue;
                }

                if (!dryRun) {
                  await api.updateCategory(categoryEntry.id, fields);
                }
                rows.push({
                  kind: 'category',
                  action: actions.join('+'),
                  id: categoryEntry.id,
                  name: categoryEntry.name,
                  group_id: resolvedGroupId,
                  from_group_id:
                    existingCategory.groupId === resolvedGroupId
                      ? ''
                      : existingCategory.groupId,
                  result: dryRun ? 'would-update' : 'updated',
                });
                counts.categoriesUpdated += 1;
                continue;
              }

              let createdCategoryId = '(new)';
              if (!dryRun) {
                createdCategoryId = await api.createCategory({
                  name: categoryEntry.name,
                  group_id: resolvedGroupId,
                  is_income: resolvedGroupIncome,
                  hidden: false,
                });
              }
              rows.push({
                kind: 'category',
                action: 'create',
                id: createdCategoryId,
                name: categoryEntry.name,
                group_id: resolvedGroupId,
                from_group_id: '',
                result: dryRun ? 'would-create' : 'created',
              });
              counts.categoriesCreated += 1;
            }
          }

          if (!dryRun) {
            deleteDraft(resolved.dataDir, resolved.budgetId, 'categories.json');
          }

          if (rows.length === 0) {
            printStatusOk({
              entity: 'categories-apply',
              action: dryRun ? 'preview' : 'apply',
              changes: 0,
              dryRun: dryRun ? 1 : 0,
              ...counts,
            });
            return;
          }

          printRows(
            format,
            'categories-apply',
            rows,
            ['kind', 'action', 'id', 'name', 'group_id', 'from_group_id', 'result'],
            {
              dryRun: dryRun ? 1 : 0,
              changes: rows.length,
              ...counts,
            },
          );
        });
      }),
    );

  categories
    .command('find <names...>')
    .description('Find categories and groups by name (case-insensitive, multiple search terms)')
    .action(
      commandAction(async (names: string[], ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        await withBudget(session, async () => {
          const needles = names
            .map(n => n.trim().toLowerCase())
            .filter(Boolean);
          if (needles.length === 0) {
            throw new Error('Name search must be non-empty');
          }
          const groups = (await api.getCategoryGroups()) as Array<
            Record<string, unknown>
          >;
          const categoriesList = (await api.getCategories()) as Array<
            Record<string, unknown>
          >;
          const groupNames = new Map<string, string>();
          for (const group of groups) {
            if (typeof group.id === 'string' && typeof group.name === 'string') {
              groupNames.set(group.id, group.name);
            }
          }

          const rows: Array<Record<string, unknown>> = [];
          for (const group of groups) {
            if (
              typeof group.name === 'string' &&
              needles.some(needle => (group.name as string).toLowerCase().includes(needle))
            ) {
              rows.push({
                kind: 'group',
                id: group.id,
                name: group.name,
                group_id: '',
                group_name: '',
                is_income: group.is_income,
                hidden: group.hidden,
              });
            }
          }
          for (const category of categoriesList) {
            if (typeof category.name !== 'string') {
              continue;
            }
            const lower = category.name.toLowerCase();
            if (!needles.some(needle => lower.includes(needle))) {
              continue;
            }
            const groupId = typeof category.group_id === 'string' ? category.group_id : '';
            rows.push({
              kind: 'category',
              id: category.id,
              name: category.name,
              group_id: groupId,
              group_name: groupNames.get(groupId) ?? '',
              is_income: category.is_income,
              hidden: category.hidden,
            });
          }

          printRows(
            format,
            'categories-find',
            rows,
            ['kind', 'id', 'name', 'group_id', 'group_name', 'is_income', 'hidden'],
            { query: needles.join(','), matches: rows.length },
          );
        });
      }),
    );

  categories
    .command('update <id>')
    .option('--name <name>', 'New category name')
    .description('Update category')
    .action(
      commandAction(async (id: string, options: CategoryUpdateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const fields: Record<string, unknown> = {};
        if (options.name != null) {
          fields.name = options.name;
        }
        if (Object.keys(fields).length === 0) {
          throw new Error('No fields provided to update');
        }
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveCategoryId(id);
            await api.updateCategory(resolvedId, fields);
            printStatusOk({ entity: 'category', action: 'update', id: resolvedId });
          },
        );
      }),
    );

  categories
    .command('delete <id>')
    .option('--transfer-to <categoryId>', 'Transfer category id')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete category')
    .action(
      commandAction(async (id: string, options: CategoryDeleteOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a category');
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveCategoryId(id);
            const resolvedTransferTo = options.transferTo
              ? await resolveCategoryId(options.transferTo)
              : undefined;
            await api.deleteCategory(resolvedId, resolvedTransferTo);
            printStatusOk({ entity: 'category', action: 'delete', id: resolvedId });
          },
        );
      }),
    );

  categories
    .command('create-group <name>')
    .option('--income', 'Create as income group')
    .description('Create category group')
    .action(
      commandAction(async (name: string, options: GroupCreateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const id = await api.createCategoryGroup({
              name,
              is_income: Boolean(options.income),
              hidden: false,
            });
            printStatusOk({ entity: 'category-group', action: 'create', id });
          },
        );
      }),
    );

  categories
    .command('update-group <id>')
    .option('--name <name>', 'New group name')
    .description('Update category group')
    .action(
      commandAction(async (id: string, options: GroupUpdateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const fields: Record<string, unknown> = {};
        if (options.name != null) {
          fields.name = options.name;
        }
        if (Object.keys(fields).length === 0) {
          throw new Error('No fields provided to update');
        }
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveCategoryGroupId(id);
            await api.updateCategoryGroup(resolvedId, fields);
            printStatusOk({ entity: 'category-group', action: 'update', id: resolvedId });
          },
        );
      }),
    );

  categories
    .command('delete-group <id>')
    .option('--transfer-to <categoryId>', 'Transfer category id')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete category group')
    .action(
      commandAction(async (id: string, options: GroupDeleteOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a category group');
        await withBudget(
          { ...session, write: true },
          async () => {
            const resolvedId = await resolveCategoryGroupId(id);
            const resolvedTransferTo = options.transferTo
              ? await resolveCategoryId(options.transferTo)
              : undefined;
            await api.deleteCategoryGroup(resolvedId, resolvedTransferTo);
            printStatusOk({ entity: 'category-group', action: 'delete', id: resolvedId });
          },
        );
      }),
    );
}
