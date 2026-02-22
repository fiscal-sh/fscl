import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, '..');
const CLI_PATH = resolve(REPO_ROOT, 'src', 'index.ts');

type MaybeBuffer = Buffer | string | null | undefined;

export type CliRunResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CliTestEnv = {
  rootDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

export type CreatedBudget = {
  id: string;
  name: string;
};

function quoteShellArg(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function toText(value: MaybeBuffer): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

export function stripAnsi(input: string): string {
  return stripVTControlCharacters(input);
}

export function parseJsonOutput<T = unknown>(stdout: string): T {
  const trimmed = stripAnsi(stdout).trim();
  if (!trimmed) {
    throw new Error('Expected JSON output but command produced no stdout.');
  }
  return JSON.parse(trimmed) as T;
}

export function createCliTestEnv(prefix = 'fscl-cli-test-'): CliTestEnv {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(rootDir, 'home');
  const xdgConfigHome = join(rootDir, 'config');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dataDir = join(rootDir, 'data-dir');

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(xdgDataHome, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  return {
    rootDir,
    dataDir,
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export function runCli(
  args: string[],
  cwd: string = REPO_ROOT,
  env: NodeJS.ProcessEnv = {},
): CliRunResult {
  const command = [
    quoteShellArg(process.execPath),
    '--import',
    'tsx',
    quoteShellArg(CLI_PATH),
    ...args.map(arg => quoteShellArg(arg)),
  ].join(' ');

  try {
    const stdout = execSync(command, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      command,
      stdout: stripAnsi(stdout),
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const wrapped = error as {
      status?: number;
      stdout?: MaybeBuffer;
      stderr?: MaybeBuffer;
    };
    return {
      command,
      stdout: stripAnsi(toText(wrapped.stdout)),
      stderr: stripAnsi(toText(wrapped.stderr)),
      exitCode: typeof wrapped.status === 'number' ? wrapped.status : 1,
    };
  }
}

export function createLocalBudget(
  testEnv: CliTestEnv,
  budgetName = 'TestBudget',
): CreatedBudget {
  const result = runCli(
    ['--data-dir', testEnv.dataDir, '--json', 'budgets', 'create', budgetName],
    undefined,
    testEnv.env,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create budget "${budgetName}" (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = parseJsonOutput<{
    id: unknown;
    name?: unknown;
  }>(result.stdout);
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new Error(`Budget create returned invalid id: ${result.stdout}`);
  }
  return {
    id: parsed.id,
    name: typeof parsed.name === 'string' ? parsed.name : budgetName,
  };
}
