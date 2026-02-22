import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Config } from './types.js';

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const CONFIG_PATH = join(CONFIG_DIR, 'fiscal', 'config.json');

const DATA_DIR = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const DEFAULT_DATA_DIR = join(DATA_DIR, 'fiscal');

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getDefaultDataDir(): string {
  return DEFAULT_DATA_DIR;
}

export function readConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Config;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function updateConfig(patch: Partial<Config>): Config {
  const current = readConfig();
  const next: Config = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const typedKey = key as keyof Config;
    if (value === undefined) {
      delete next[typedKey];
      continue;
    }
    next[typedKey] = value;
  }
  writeConfig(next);
  return next;
}
