import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/helpers/setup.ts'],
    // Only stops a hung test: interpreter tests are CPU-bound, and the same test takes up to 4 times as long on a
    // GitHub-hosted runner as on a developer machine, with a 1.8-fold spread between runners.
    testTimeout: 30_000,
    // Leave CPU capacity for native interpreter subprocesses within per-program deadlines.
    maxWorkers: '50%',
    // The interpreters recurse as deeply as the programs they run, up to their own call depth limit.
    execArgv: ['--stack-size=4000'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('src', import.meta.url)) },
  },
});
