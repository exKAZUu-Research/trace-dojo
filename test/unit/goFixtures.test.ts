import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { compileProgram } from '../../src/go/compiler';
import { runProgram } from '../../src/go/execute';
import { parseGo } from '../../src/go/parse';
import { Runtime } from '../../src/go/runtime';

/**
 * Programs of the later stages with the output that Go 1.27.3 printed for them on an arm64 Mac: goroutines on the
 * deterministic scheduler, the stage C syntax, and the libraries. A program that ends with a panic or a fatal error
 * has the first line of what Go printed to standard error in `<name>.err`.
 */
const directory = path.join(import.meta.dirname, '../fixtures/go');
const programs = readdirSync(directory)
  .filter((file) => file.endsWith('.go'))
  .map((file) => file.slice(0, -3));

test.each(programs)('%s prints what Go prints', (name) => {
  const source = readFileSync(path.join(directory, `${name}.go`), 'utf8');
  const expectedOutput = readFileSync(path.join(directory, `${name}.out`), 'utf8');
  const errorFile = path.join(directory, `${name}.err`);
  const expectedError = existsSync(errorFile) ? readFileSync(errorFile, 'utf8').trim() : undefined;
  const runtime = new Runtime();
  const run = runProgram(runtime, compileProgram(parseGo(source)));
  expect(run.stdout).toBe(expectedOutput);
  expect(run.uncaughtException?.split('\n').find((line) => /^(panic|fatal error): /.test(line))).toBe(expectedError);
});
