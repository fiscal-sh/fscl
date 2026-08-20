import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every CLI assertion spawns a tsx subprocess, so under a parallel
    // full-suite run individual tests routinely take 15-40s. The default 5s
    // timeout produces false failures from contention alone; tests that hang
    // still fail, just later.
    testTimeout: 120_000,
  },
});
