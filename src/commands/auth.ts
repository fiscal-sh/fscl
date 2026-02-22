import { stdin, stdout } from 'node:process';

import * as p from '@clack/prompts';
import { Command } from 'commander';

import { loginToServer } from '../auth.js';
import { commandAction } from '../cli.js';
import { readConfig, updateConfig } from '../config.js';
import { printStatusOk } from '../output.js';
import { getActionCommand } from './common.js';

type LoginCommandOptions = {
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
    p.cancel('Login cancelled.');
    process.exit(0);
  }
  return result;
}

function writeAuthConfig(patch: { serverURL?: string; token?: string }): void {
  updateConfig(patch);
}

async function resolvePassword(optionPassword: string | undefined): Promise<string> {
  if (optionPassword?.trim()) {
    return optionPassword.trim();
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Missing required server password. Pass --password <pw>.');
  }

  const value = cancelledOrValue(
    await p.password({
      message: 'Server password',
      validate: (input) => {
        if (!input?.trim()) {
          return 'Server password is required.';
        }
      },
    }),
  );
  return requireValue(value, 'server password');
}

export function registerAuthCommands(program: Command) {
  program
    .command('login [server-url]')
    .description('Authenticate with the server and store a session token')
    .option('--password <pw>', 'Server password (prompted when omitted)')
    .action(
      commandAction(async (serverUrlArg: string | undefined, ...args: unknown[]) => {
        const cmd = getActionCommand(args);
        const options = cmd.opts() as LoginCommandOptions;
        const config = readConfig();

        const serverURL = requireValue(
          serverUrlArg ?? process.env.FISCAL_SERVER_URL ?? config.serverURL,
          'server URL',
        );
        const password = await resolvePassword(options.password);
        const token = await loginToServer(serverURL, password);

        writeAuthConfig({ serverURL, token });
        printStatusOk({ entity: 'auth', action: 'login', serverURL });
      }),
    );

  program
    .command('logout')
    .description('Clear stored server session token and URL')
    .action(
      commandAction(async () => {
        writeAuthConfig({ serverURL: undefined, token: undefined });
        printStatusOk({ entity: 'auth', action: 'logout' });
      }),
    );
}
