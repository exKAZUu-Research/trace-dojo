import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test('structuredClone reads own enumerable array properties and keeps holes and the original length', () => {
  const source = `const input = [1, 2, 3]; let reads = 0;
Object.defineProperty(input, 0, {get() {reads++; delete input[2]; return 7;}, enumerable: true});
Object.defineProperty(input, 1, {enumerable: false});
Object.defineProperty(input, 'extra', {get() {return 42;}, enumerable: true});
const copy = structuredClone(input);
console.log(copy[0], copy.length, 1 in copy, 2 in copy, copy.extra, reads);
const hole = new Array(1);
Object.setPrototypeOf(hole, Object.create(Array.prototype, {0: {get() {reads++; return 8;}}}));
const clonedHole = structuredClone(hole);
console.log(clonedHole.length, 0 in clonedHole, reads);`;
  expect(executeProgram('javascript', source)).toMatchObject({
    kind: 'executed',
    stdout: '7 3 false false 42 1\n1 false 1\n',
    uncaughtException: undefined,
  });
});

test('array accessor traces show descriptors without invoking getters or showing ordinary null values', () => {
  const source = `let reads = 0;
const array = [1, 2, 3];
Object.defineProperty(array, 0, {get() {reads++; return 7;}});
Object.defineProperty(array, 1, {set(value: number) {reads++;}});
Object.defineProperty(array, 2, {get() {reads++; return 9;}, set(value: number) {reads++;}});
const value = array[0];
console.log(reads, value);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('1 7\n');
  expect(recording.finalVars.reads).toBe(1);
  expect(recording.finalVars.array).toBeUndefined();
  expect(recording.traceItems.at(-1)?.referenceVars?.array).toMatchObject({
    kind: 'array',
    entries: {
      0: { kind: 'value', value: '[Getter]', verbatim: true },
      1: { kind: 'value', value: '[Setter]', verbatim: true },
      2: { kind: 'value', value: '[Getter/Setter]', verbatim: true },
    },
  });
});
