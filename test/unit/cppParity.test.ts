import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cppParity');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Each `.out` file holds what a program built with Apple clang++ 21 (`-std=c++20`, libc++) printed, followed by the
// line libc++abi wrote when an uncaught exception ended it, if one did.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.cpp')))(
  '%s prints what clang++ prints',
  (name) => {
    const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURE_DIR, name.replace(/\.cpp$/, '.out')), 'utf8');
    const execution = executeProgram('cpp', program);
    if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
    const uncaught = execution.uncaughtException ? `[uncaught] ${execution.uncaughtException}\n` : '';
    expect(execution.stdout + uncaught).toBe(expected);
  }
);
