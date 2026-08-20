import { api } from '../actual-api.js';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { CliError, ErrorCodes, commandAction, getFormat, getSessionOptions } from '../cli.js';
import { getDefaultDataDir, readConfig, updateConfig } from '../config.js';
import { withApi, withBudget } from '../budget.js';
import { todayLocalDateString } from '../dates.js';
import { printRows, printStatusOk } from '../output.js';
import {
  budgetRows,
  budgetRowsForList,
  getActionCommand,
  requireYes,
  send,
} from './common.js';
import {
  collectBudgetSetup,
  collectBudgetSetupNonInteractive,
  runBudgetCreation,
} from './budget-wizard.js';

export function registerBudgetCommands(program: Command) {
  const budgets = program.command('budgets').description('Manage budgets');

  budgets
    .command('list')
    .description('List local and remote budgets')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const format = getFormat(cmd);
        await withApi(session, async () => {
          const rows = budgetRowsForList(budgetRows(await api.getBudgets()));
          printRows(format, 'budgets', rows, [
            'id',
            'name',
            'group_id',
            'cloud_file_id',
            'state',
          ]);
        });
      }),
    );

  budgets
    .command('create [name]')
    .description('Create a new budget')
    .option('--non-interactive', 'Run setup without prompts')
    .option('--mode <mode>', 'Setup mode: local | remote')
    .option('--budget-name <name>', 'Budget name (alternative to positional arg)')
    .option('--password <pw>', 'Server password for remote mode')
    .option('--sync-id <id>', 'Remote sync id for remote mode')
    .action(
      commandAction(async (name: string | undefined, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const cmdOpts = cmd.opts() as {
          nonInteractive?: boolean;
          mode?: string;
          budgetName?: string;
          password?: string;
          syncId?: string;
        };
        const globals = cmd.optsWithGlobals() as {
          dataDir?: string;
          serverUrl?: string;
        };
        const config = readConfig();
        const dataDir = globals.dataDir ?? config.dataDir ?? getDefaultDataDir();
        const budgetName = name ?? cmdOpts.budgetName;
        const isInteractive = !cmdOpts.nonInteractive && !name;

        let setup;
        if (isInteractive) {
          p.intro('fscl budgets create');
          setup = await collectBudgetSetup(
            {
              dataDir,
              mode: cmdOpts.mode,
              budgetName,
              serverUrl: globals.serverUrl,
              password: cmdOpts.password,
              syncId: cmdOpts.syncId,
            },
            config,
          );
        } else {
          setup = await collectBudgetSetupNonInteractive({
            dataDir,
            mode: cmdOpts.mode ?? 'local',
            budgetName: budgetName,
            serverUrl: globals.serverUrl ?? config.serverURL,
            password: cmdOpts.password,
            syncId: cmdOpts.syncId,
          });
        }

        const spin = p.spinner();
        if (isInteractive) {
          spin.start('Creating budget');
        }

        const result = await runBudgetCreation(setup);
        const configPatch = {
          dataDir: setup.dataDir,
          activeBudgetId: result.budgetId,
          ...(setup.mode !== 'local'
            ? {
                serverURL: setup.serverURL,
                token: setup.token,
              }
            : {}),
        };
        updateConfig(configPatch);

        if (isInteractive) {
          spin.stop('Budget created');
          p.outro('Done');
        }

        printStatusOk({
          entity: 'budget',
          action: 'create',
          id: result.budgetId,
          name: result.budgetName,
          ...(result.syncId ? { syncId: result.syncId } : {}),
        });
      }),
    );

  budgets
    .command('pull <syncId>')
    .description('Download a budget from sync server')
    .action(
      commandAction(async (syncId: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withApi(session, async resolved => {
          if (!resolved.serverURL) {
            throw new CliError(
              'budgets pull requires a configured server. Set --server-url or FISCAL_SERVER_URL.',
              ErrorCodes.SERVER_REQUIRED,
            );
          }
          await api.downloadBudget(syncId);
          const budgetsList = budgetRows(await api.getBudgets());
          const pulled = budgetsList.find(item => item.group_id === syncId);
          if (pulled?.id) {
            updateConfig({ activeBudgetId: pulled.id });
          }
          printStatusOk({
            entity: 'budget',
            action: 'pull',
            syncId,
            id: pulled?.id,
          });
        });
      }),
    );

  budgets
    .command('push')
    .description('Upload a local budget to sync server')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(
          { ...session, write: true },
          async ({ budgetId, serverURL }) => {
            if (!serverURL) {
              throw new CliError(
                'budgets push requires a configured server. Set --server-url or FISCAL_SERVER_URL.',
                ErrorCodes.SERVER_REQUIRED,
              );
            }
            const result = await send('upload-budget', undefined);
            const maybeError = (result as { error?: { reason?: string } })
              ?.error;
            if (maybeError) {
              throw new Error(
                `Failed to upload budget: ${maybeError.reason || 'unknown'}`,
              );
            }
            const budgetsList = budgetRows(await api.getBudgets());
            const updated = budgetsList.find(item => item.id === budgetId);
            printStatusOk({
              entity: 'budget',
              action: 'push',
              id: budgetId,
              group_id: updated?.group_id,
              cloud_file_id: updated?.cloud_file_id,
            });
          },
        );
      }),
    );

  budgets
    .command('export [path]')
    .description('Export the active budget to a zip file')
    .addHelpText(
      'after',
      `
Example:
  fiscal budgets export                     # ./<budget-id>-<date>.zip
  fiscal budgets export ~/backups/my.zip

Writes a full budget export (same format as the Actual UI's "Export budget"),
suitable for backups or re-import via Actual. When a server is configured,
the budget is synced before the export is created.`,
    )
    .action(
      commandAction(async (path: string | undefined, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        await withBudget(session, async ({ budgetId, serverURL }) => {
          if (serverURL) {
            await api.sync();
          }
          const data = await api.exportBudget();
          const target =
            path && path.trim()
              ? path
              : `${budgetId}-${todayLocalDateString()}.zip`;
          const resolved = resolve(target);
          mkdirSync(dirname(resolved), { recursive: true });
          writeFileSync(resolved, data);
          printStatusOk({
            entity: 'budget',
            action: 'export',
            id: budgetId,
            path: resolved,
            bytes: data.byteLength,
          });
        });
      }),
    );

  budgets
    .command('restore <path>')
    .description('Restore a budget export as a new local budget')
    .addHelpText(
      'after',
      `
Example:
  fiscal budgets restore ./backup.zip

Imports an Actual budget zip as a new local budget and selects it as active.
The existing budget is not overwritten or deleted. Automatic pre-mutation
snapshots are stored under <dataDir>/<budgetId>/snapshots/.`,
    )
    .action(
      commandAction(async (path: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const session = getSessionOptions(cmd);
        const resolvedPath = resolve(path);
        if (!existsSync(resolvedPath)) {
          throw new CliError(
            `Budget export not found: ${resolvedPath}`,
            ErrorCodes.ENTITY_NOT_FOUND,
          );
        }
        await withApi(session, async () => {
          const restored = await api.importBudget(resolvedPath, {
            type: 'actual',
            filename: resolvedPath,
          });
          updateConfig({ activeBudgetId: restored.id });
          printStatusOk({
            entity: 'budget',
            action: 'restore',
            id: restored.id,
            source: resolvedPath,
          });
        });
      }),
    );

  budgets
    .command('use <id>')
    .description('Set active budget id in config')
    .action(
      commandAction(async (id: string) => {
        updateConfig({ activeBudgetId: id });
        printStatusOk({ entity: 'budget', action: 'use', id });
      }),
    );

  budgets
    .command('delete <id>')
    .description('Delete a local budget copy')
    .option('--yes', 'Confirm permanent deletion')
    .action(
      commandAction(async (id: string, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const options = cmd.opts() as { yes?: boolean };
        requireYes(options.yes, 'Deleting a budget');

        const session = getSessionOptions(cmd);
        await withApi(session, async () => {
          const before = budgetRows(await api.getBudgets());
          const existing = before.find(item => item.id === id);
          if (!existing) {
            throw new Error(
              `Budget '${id}' not found. Run 'fscl budgets list' to see available budgets.`,
            );
          }

          const result = await send('delete-budget', { id });
          if (result !== 'ok') {
            throw new Error(`Failed to delete budget '${id}'.`);
          }

          const config = readConfig();
          if (config.activeBudgetId === id) {
            const after = budgetRows(await api.getBudgets());
            const nextLocalBudgetId = after.find(item => item.id)?.id;
            updateConfig({ activeBudgetId: nextLocalBudgetId });
          }

          printStatusOk({ entity: 'budget', action: 'delete', id });
        });
      }),
    );
}
