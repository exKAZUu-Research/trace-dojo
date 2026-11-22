import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/helpers/setup.ts'],
    // Leave CPU capacity for native interpreter subprocesses within per-program deadlines.
    maxWorkers: '50%',
    // The interpreters recurse as deeply as the programs they run, up to their own call depth limit.
    execArgv: ['--stack-size=4000'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('src', import.meta.url)) },
  },
});
