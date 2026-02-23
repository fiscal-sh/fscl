import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';

import * as p from '@clack/prompts';
import { Command } from 'commander';

import { commandAction } from '../cli.js';
import { getDefaultDataDir, readConfig, updateConfig } from '../config.js';
import type { Config } from '../types.js';
import { getActionCommand } from './common.js';
import {
  collectBudgetSetup,
  collectBudgetSetupNonInteractive,
  runBudgetCreation,
  type BudgetSetupInput,
  type BudgetCreationResult,
} from './budget-wizard.js';
import {
  collectStatus,
  getStatusFormat,
  renderStatus,
  resolveStatusSession,
} from './status.js';

const RESET = '\x1b[0m';
const GRAYS = [250, 248, 245, 243, 240, 238].map(
  (c) => `\x1b[38;5;${c}m`,
);

const LOGO = [
  '███████╗██╗███████╗ ██████╗ █████╗ ██╗     ',
  '██╔════╝██║██╔════╝██╔════╝██╔══██╗██║     ',
  '█████╗  ██║███████╗██║     ███████║██║     ',
  '██╔══╝  ██║╚════██║██║     ██╔══██║██║     ',
  '██║     ██║███████║╚██████╗██║  ██║███████╗',
  '╚═╝     ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝',
];
const SKILL_SOURCE = 'fiscal-sh/fscl';
const SKILLS_INSTALL_COMMAND = `npx skills add ${SKILL_SOURCE}`;

function printBanner() {
  const colored = LOGO
    .map((line, i) => `${GRAYS[i]}${line}${RESET}`)
    .join('\n');
  console.log(`\n${colored}\n`);
}

type InitCommandOptions = {
  nonInteractive?: boolean;
  mode?: string;
  budgetName?: string;
  syncId?: string;
};

type InitOptionsWithGlobals = InitCommandOptions & {
  dataDir?: string;
  serverUrl?: string;
  password?: string;
};

function requireValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required ${label}.`);
  }
  return trimmed;
}

function cancelledOrValue<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return result;
}

function currentMonthString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function configPatch(setup: BudgetSetupInput, result: BudgetCreationResult): Partial<Config> {
  if (setup.mode === 'local') {
    return {
      dataDir: setup.dataDir,
      activeBudgetId: result.budgetId,
      serverURL: undefined,
      token: undefined,
    };
  }
  return {
    dataDir: setup.dataDir,
    activeBudgetId: result.budgetId,
    serverURL: setup.serverURL,
    token: setup.token,
  };
}

function installSkills(): Promise<void> {
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return new Promise((resolve, reject) => {
    const child = spawn(npxBin, ['skills', 'add', SKILL_SOURCE], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command "${SKILLS_INSTALL_COMMAND}" exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
}

async function maybeInstallSkills(): Promise<void> {
  const shouldInstall = await p.confirm({
    message: 'Install Fiscal agent skills now?',
    active: 'yes',
    inactive: 'no',
    initialValue: true,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(`Skipped. Install later with:\n  ${SKILLS_INSTALL_COMMAND}`);
    return;
  }

  p.log.step(`Running: ${SKILLS_INSTALL_COMMAND}`);
  try {
    await installSkills();
    p.log.success('Fiscal agent skills installed.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(
      `Failed to install skills automatically.\n` +
        `Run manually:\n  ${SKILLS_INSTALL_COMMAND}\n` +
        `Reason: ${message}`,
    );
  }
}

async function collectInteractiveSetup(
  options: InitOptionsWithGlobals,
  config: Config,
): Promise<BudgetSetupInput> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Interactive init requires a TTY. Re-run with --non-interactive and flags.',
    );
  }

  printBanner();

  if (config.activeBudgetId) {
    p.log.warn(
      `Active budget already exists (${config.activeBudgetId}).\n` +
        'Creating a new budget will update the active budget.\n' +
        `To reactivate later: fscl budgets use ${config.activeBudgetId}`,
    );
  }

  const dataDirDefault = options.dataDir ?? config.dataDir ?? getDefaultDataDir();
  const dataDir = requireValue(
    cancelledOrValue(
      await p.text({
        message: 'Data directory',
        initialValue: dataDirDefault,
        validate: (v) => {
          if (!v?.trim()) return 'Data directory is required.';
        },
      }),
    ),
    'data directory',
  );

  return collectBudgetSetup(
    {
      dataDir,
      mode: options.mode,
      budgetName: options.budgetName,
      serverUrl: options.serverUrl,
      password: options.password,
      syncId: options.syncId,
    },
    config,
  );
}

async function collectNonInteractiveSetup(
  options: InitOptionsWithGlobals,
  config: Config,
): Promise<BudgetSetupInput> {
  const dataDir = options.dataDir ?? config.dataDir ?? getDefaultDataDir();

  return collectBudgetSetupNonInteractive({
    dataDir,
    mode: options.mode,
    budgetName: options.budgetName,
    serverUrl: options.serverUrl ?? config.serverURL,
    password: options.password,
    syncId: options.syncId,
  });
}

export function registerInitCommand(program: Command) {
  program
    .command('init')
    .description('Initialize config and first budget')
    .option('--non-interactive', 'Run setup without prompts')
    .option('--mode <mode>', 'Setup mode: local | remote')
    .option('--budget-name <name>', 'Budget name for local mode')
    .option('--password <pw>', 'Server password for remote mode')
    .option('--sync-id <id>', 'Remote sync id for remote mode')
    .action(
      commandAction(async (...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const options = cmd.optsWithGlobals() as InitOptionsWithGlobals;
        const config = readConfig();
        const isInteractive = !options.nonInteractive;

        if (!isInteractive && config.activeBudgetId) {
          p.log.warn(
            `Active budget already exists (${config.activeBudgetId}).\n` +
              'Creating a new budget will update the active budget.\n' +
              `To reactivate later: fscl budgets use ${config.activeBudgetId}`,
          );
        }

        const setup = isInteractive
          ? await collectInteractiveSetup(options, config)
          : await collectNonInteractiveSetup(options, config);

        const spin = p.spinner();
        if (isInteractive) {
          spin.start('Creating budget');
        }

        const result = await runBudgetCreation(setup);
        updateConfig(configPatch(setup, result));

        if (isInteractive) {
          spin.stop('Budget created');
          p.outro('Done');
        }

        const statusFormat = getStatusFormat(cmd);
        const row = await collectStatus(resolveStatusSession(cmd));
        renderStatus(statusFormat, row, { compact: true });

        if (statusFormat === 'table') {
          const month = currentMonthString();
          console.log(`
Next steps:
  fscl accounts create "Checking" --balance 3500.00
  fscl categories list
  fscl month set ${month} <category-id> 500.00
`);

          if (isInteractive) {
            await maybeInstallSkills();
          }
        }
      }),
    );
}
