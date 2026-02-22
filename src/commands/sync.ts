import * as api from '@actual-app/api';
import { Command } from 'commander';

import { commandAction, getSessionOptions } from '../cli.js';
import { withBudget } from '../budget.js';
import { printStatusOk } from '../output.js';
import { getActionCommand } from './common.js';

export function registerSyncCommand(program: Command) {
  program
    .command('sync')
    .description('Run explicit sync with configured server')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async ({ serverURL }) => {
          if (!serverURL) {
            throw new Error(
              'Sync requires a configured server. Set --server-url or FISCAL_SERVER_URL.',
            );
          }
          await api.sync();
          printStatusOk({ entity: 'sync' });
        });
      }),
    );
}
