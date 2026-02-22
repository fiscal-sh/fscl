import { Command } from 'commander';

import { commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { printRows, printStatusOk } from '../output.js';
import { getActionCommand, requireYes, send } from './common.js';

type TagCreateOptions = {
  color?: string;
  description?: string;
};

type TagUpdateOptions = {
  name?: string;
  color?: string;
  description?: string;
};

export function registerTagCommands(program: Command) {
  const tags = program.command('tags').description('Manage tags');

  tags
    .command('list')
    .description('List tags')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const rows = (await send('api/tags-get')) as Record<string, unknown>[];
          printRows(format, 'tags', rows as Record<string, unknown>[], [
            'id',
            'tag',
            'color',
            'description',
          ]);
        });
      }),
    );

  tags
    .command('find <names...>')
    .description('Find tags by name (case-insensitive, multiple search terms)')
    .action(
      commandAction(async (names: string[], ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const format = getFormat(cmd);
        const session = getSessionOptions(cmd);
        await withBudget(session, async () => {
          const needles = names
            .map(n => n.trim().toLowerCase())
            .filter(Boolean);
          if (needles.length === 0) {
            throw new Error('Name search must be non-empty');
          }
          const all = (await send('api/tags-get')) as Record<string, unknown>[];
          const rows = all.filter(row => {
            if (typeof row.tag !== 'string') return false;
            const lower = row.tag.toLowerCase();
            return needles.some(needle => lower.includes(needle));
          });
          printRows(format, 'tags-find', rows, [
            'id',
            'tag',
            'color',
            'description',
          ], { query: needles.join(','), matches: rows.length });
        });
      }),
    );

  tags
    .command('create <name>')
    .option('--color <hex>', 'Tag color')
    .option('--description <text>', 'Tag description')
    .description('Create tag')
    .action(
      commandAction(async (name: string, options: TagCreateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async () => {
            const id = (await send('api/tag-create', {
              tag: {
                tag: name,
                color: options.color ?? null,
                description: options.description ?? null,
              },
            })) as string;
            printStatusOk({ entity: 'tag', action: 'create', id });
          },
        );
      }),
    );

  tags
    .command('update <id>')
    .option('--name <name>', 'Tag name')
    .option('--color <hex>', 'Tag color')
    .option('--description <text>', 'Tag description')
    .description('Update tag')
    .action(
      commandAction(async (id: string, options: TagUpdateOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const fields: Record<string, unknown> = {};
        if (options.name !== undefined) {
          fields.tag = options.name;
        }
        if (options.color !== undefined) {
          fields.color = options.color;
        }
        if (options.description !== undefined) {
          fields.description = options.description;
        }
        if (Object.keys(fields).length === 0) {
          throw new Error('No fields provided to update');
        }
        await withBudget(
          { ...session, write: true },
          async () => {
            await send('api/tag-update', { id, fields });
            printStatusOk({ entity: 'tag', action: 'update', id });
          },
        );
      }),
    );

  tags
    .command('delete <id>')
    .option('--yes', 'Confirm permanent deletion')
    .description('Delete tag')
    .action(
      commandAction(async (id: string, options: { yes?: boolean }, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        requireYes(options.yes, 'Deleting a tag');
        await withBudget(
          { ...session, write: true },
          async () => {
            await send('api/tag-delete', { id });
            printStatusOk({ entity: 'tag', action: 'delete', id });
          },
        );
      }),
    );
}
