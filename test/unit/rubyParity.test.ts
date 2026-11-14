import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'rubyParity');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Each `.out` file holds what Ruby 4.0.9 printed for its program under a UTF-8 locale, followed by the first line of
// the exception that ended it, if one did.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.rb')))('%s prints what Ruby prints', (name) => {
  const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, name.replace(/\.rb$/, '.out')), 'utf8');
  const execution = executeProgram('ruby', program);
  if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
  const uncaught = execution.uncaughtException ? `[uncaught] ${execution.uncaughtException.split('\n')[0]}\n` : '';
  expect(execution.stdout + uncaught).toBe(expected);
});
