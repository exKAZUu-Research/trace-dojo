import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import { z } from 'zod';

// Text helpers under `src/interpreter/` that load neither an interpreter nor a grammar.
const allowedModules = new Set(['src/interpreter/traceAnnotations.ts']);

test('the server evaluates no interpreter, which only browsers run', () => {
  const interpreterDirectories = [
    'interpreter',
    'interpreterHost',
    ...readdirSync('src/interpreter/languages').map((file) => path.parse(file).name),
  ].map((directory) => `src/${directory}/`);
  const serverModules = z
    .array(z.string())
    .parse(JSON.parse(execFileSync('bun', ['test/helpers/listServerModules.ts'], { encoding: 'utf8' })));

  expect(serverModules).toContain('src/infrastructures/trpcBackend/routers/index.ts');
  expect(
    serverModules.filter(
      (module) =>
        !allowedModules.has(module) && interpreterDirectories.some((directory) => module.startsWith(directory))
    )
  ).toEqual([]);
});
