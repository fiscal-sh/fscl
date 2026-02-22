import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliTestEnv, runCli, type CliTestEnv } from './test-utils.js';

describe('cli help', () => {
  let testEnv: CliTestEnv;

  beforeEach(() => {
    testEnv = createCliTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('prints top-level help', () => {
    const result = runCli(['--help'], undefined, testEnv.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: fiscal [options] [command]');
    expect(result.stdout).toContain('Headless CLI for Actual Budget');
    expect(result.stdout).toContain('Config file:');
    expect(result.stdout).toContain('budgets');
  });

  it('prints subcommand help with global options', () => {
    const result = runCli(['status', '--help'], undefined, testEnv.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: fiscal status [options]');
    expect(result.stdout).toContain('Global Options:');
    expect(result.stdout).toContain('--data-dir <path>');
    expect(result.stdout).toContain('--json');
  });
});
