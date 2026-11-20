import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'phpParity');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Each `.out` file holds what PHP 8.5.12's CLI printed for its program, with the program's path written as /main.php.
// PHP prints warnings and the fatal error of an uncaught exception to standard output, so the output holds them too.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.php')))('%s prints what PHP prints', (name) => {
  const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, name.replace(/\.php$/, '.out')), 'utf8');
  const execution = executeProgram('php', program);
  if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
  expect(execution.stdout).toBe(expected);
});
