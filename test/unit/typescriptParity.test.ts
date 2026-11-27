import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const PARITY_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'typescriptParity');
const TYPE_ERROR_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'typescriptTypeErrors');

// The programs are `.ts.txt` files, which the repository's own type check leaves alone, as some are rejected on purpose.
const programsIn = (directory: string): string[] =>
  fs.readdirSync(directory).filter((name) => name.endsWith('.ts.txt'));
const read = (directory: string, name: string): string => fs.readFileSync(path.join(directory, name), 'utf8');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Each `.out` holds reference Node.js output for a program accepted by TypeScript 7.0.2 (`tsc --strict`),
// followed by the first line of the exception that ended it, if one did.
test.each(programsIn(PARITY_DIR))('%s prints what Node.js prints', (name) => {
  const execution = executeProgram('typescript', read(PARITY_DIR, name));
  if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
  const uncaught = execution.uncaughtException ? `[uncaught] ${execution.uncaughtException.split('\n')[0]}\n` : '';
  expect(execution.stdout + uncaught).toBe(read(PARITY_DIR, name.replace(/\.ts\.txt$/, '.out')));
  if (fs.existsSync(path.join(PARITY_DIR, name.replace(/\.ts\.txt$/, '.err'))))
    expect(execution.stderr).toBe(read(PARITY_DIR, name.replace(/\.ts\.txt$/, '.err')));
});

// Each `.out` file holds the errors TypeScript 7.0.2 (`tsc --strict`) reported for its program, one per line as
// `(row,column): error TSxxxx: message`; the interpreter must reject the program on the same rows.
test.each(programsIn(TYPE_ERROR_DIR))('%s is rejected on the rows tsc reports', (name) => {
  const expectedRows = [
    ...new Set(
      read(TYPE_ERROR_DIR, name.replace(/\.ts\.txt$/, '.out'))
        .split('\n')
        .filter((line) => line.startsWith('('))
        .map((line) => Number(/^\((\d+),/.exec(line)?.[1]))
    ),
  ];
  const execution = executeProgram('typescript', read(TYPE_ERROR_DIR, name));
  if (execution.kind !== 'compileError') throw new Error(`${name} was not rejected: ${JSON.stringify(execution)}`);
  expect([...new Set(execution.diagnostics.map((diagnostic) => diagnostic.row + 1))]).toEqual(expectedRows);
});

test('duplicate declarations report once at each name', () => {
  const execution = executeProgram(
    'typescript',
    `class C {}
class
C {}
let v = 1;
function
v(): void {}
const a = 1; const a = 2;`
  );
  if (execution.kind !== 'compileError') throw new Error('Expected duplicate declaration diagnostics');
  expect(execution.diagnostics.map(({ row }) => row + 1)).toEqual([1, 3, 4, 6, 7, 7]);
});

test('duplicate parameter names are reported in signatures and implementations', () => {
  const execution = executeProgram(
    'typescript',
    `interface Options { method(value: number, value: number): void; }
function repeat(
  value: number,
  value: number
): number { return value; }
const read = ({ value }: { value: number }, [value]: number[]) => value;
class Box { constructor(value: number, value: number) {} }`
  );
  if (execution.kind !== 'compileError') throw new Error('Expected duplicate parameter diagnostics');
  expect(execution.diagnostics.map(({ row }) => row + 1)).toEqual([1, 1, 3, 4, 6, 6, 7, 7]);
});
