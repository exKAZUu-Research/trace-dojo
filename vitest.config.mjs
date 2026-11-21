import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/helpers/setup.ts'],
    // Leave CPU capacity for native interpreter subprocesses within per-program deadlines.
    maxWorkers: '50%',
    // As scripts/start-production.sh runs the server, so that deep recursion behaves as there.
    execArgv: ['--stack-size=4000'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('src', import.meta.url)) },
  },
});
