import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import * as api from '@actual-app/api';
import { Command } from 'commander';

import { commandAction, getFormat, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { printObject, printRows } from '../output.js';
import { getActionCommand } from './common.js';

type QueryModule = {
  default?: (q: typeof api.q) => unknown;
  query?: unknown;
};

type QueryOptions = {
  module?: string;
  inline?: string;
};

// Intentional use of Function constructor: this CLI is a local tool run by
// the user or their AI agent on their own machine. The inline expression is
// analogous to `node -e "..."` — same trust boundary, same permissions.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
function evaluateInlineQuery(expr: string, q: typeof api.q): unknown {
  const fn = new Function('q', 'return ' + expr);
  return fn(q);
}

export function registerQueryCommand(program: Command) {
  program
    .command('query')
    .option(
      '--module <path>',
      'Path to ESM/CJS module exporting default(q) => Query or query',
    )
    .option(
      '--inline <expr>',
      'Inline AQL expression, e.g. "q(\'transactions\').select(\'*\').limit(10)"',
    )
    .description('Run an ActualQL query')
    .addHelpText(
      'after',
      `
Examples:
  fiscal query --module ./my-query.js
  fiscal query --inline "q('transactions').filter({category: null}).select('*').limit(20)"
  fiscal query --inline "q('transactions').groupBy('payee').select([{payee:'payee'},{n:{\\$count:'\\$id'}}])"

The --inline expression receives q (the AQL query builder) and must return a Query.
Use --module for complex queries. The module should export default(q) => Query.
Exactly one of --module or --inline is required.`,
    )
    .action(
      commandAction(async (options: QueryOptions, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);

        if (options.module && options.inline) {
          throw new Error('Specify either --module or --inline, not both');
        }
        if (!options.module && !options.inline) {
          throw new Error('Specify --module <path> or --inline <expr>');
        }

        await withBudget(session, async () => {
          let query: unknown;

          if (options.inline) {
            query = evaluateInlineQuery(options.inline, api.q);
          } else {
            const modulePath = pathToFileURL(resolve(options.module!)).href;
            const loaded = (await import(modulePath)) as QueryModule;
            query =
              typeof loaded.default === 'function'
                ? loaded.default(api.q)
                : loaded.query;
          }

          if (!query) {
            throw new Error(
              'Query must return a value. For --module: export default(q) => Query or named export "query". For --inline: expression must return a Query.',
            );
          }

          const result = await api.aqlQuery(
            query as Parameters<typeof api.aqlQuery>[0],
          );
          const data = (result as { data?: unknown }).data;
          if (Array.isArray(data)) {
            printRows(
              format,
              'query-result',
              data as Record<string, unknown>[],
            );
            return;
          }
          printObject({
            status: 'ok',
            entity: 'query-result',
            data: result,
          });
        });
      }),
    );
}
