import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

function steps(program: string): { line: number; callLines: number[]; vars: Record<string, unknown> }[] {
  return traceProgram('bash', program, program).traceItems.map(({ line, callLines, vars }) => ({
    line,
    callLines,
    vars,
  }));
}

test('a call statement records no step after the steps its function recorded, and conditions record none', () => {
  const program = `二歩前に進める() {
  前に進む "$1"
  前に進む "$1"
}
turtle_new t
二歩前に進める "$t"
if (( 1 > 0 )) && [[ -n $t ]]; then
  右を向く "$t"
fi
x=$(( 2 * 3 ))
`;
  expect(steps(program)).toEqual([
    { line: 0, callLines: [], vars: {} },
    { line: 5, callLines: [], vars: {} },
    { line: 2, callLines: [6], vars: {} },
    { line: 3, callLines: [6], vars: {} },
    { line: 8, callLines: [], vars: {} },
    { line: 10, callLines: [], vars: { x: '6' } },
  ]);
});

test('a for loop over strings records each binding, and one over turtles records only a change', () => {
  const program = `for s in a b; do
  :
done
turtle_new p
turtle_new q 1 1
for t in "$p" "$q"; do
  前に進む "$t"
done
`;
  expect(steps(program).map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 1, vars: { s: 'a' } },
    { line: 2, vars: { s: 'a' } },
    { line: 1, vars: { s: 'b' } },
    { line: 2, vars: { s: 'b' } },
    { line: 4, vars: { s: 'b' } },
    { line: 5, vars: { s: 'b' } },
    { line: 7, vars: { s: 'b' } },
    { line: 7, vars: { s: 'b' } },
  ]);
});

test('a function marked # atomic counts as one step, and a misplaced annotation is an error', () => {
  const program = `N歩前に進める() { # atomic
  local t=$1 n=$2 i
  for (( i = 0; i < n; i++ )); do
    前に進む "$t"
  done
}
turtle_new t
N歩前に進める "$t" 3
`;
  expect(steps(program).map(({ line }) => line)).toEqual([0, 7, 8]);
  expect(() => traceProgram('bash', 'echo a # atomic\n', 'echo a # atomic\n')).toThrow('# atomic は、関数を定義する行');
});

test('a structure that a function receives by name reference shows its fields, as a Java method shows this', () => {
  const program = `MyTurtle_new() {
  local -n this=$1
  turtle_new 'this[t]'
  this[speed]=2
}
declare -A m
MyTurtle_new m
`;
  const trace = traceProgram('bash', program, program);
  expect(trace.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 3, vars: {} },
    { line: 4, vars: { 'this[speed]': '2' } },
  ]);
  expect(trace.traceItems.at(-1)?.referenceVars).toMatchObject({
    this: { kind: 'object', entries: { t: { kind: 'object' }, speed: { kind: 'value', value: '2' } } },
    m: { kind: 'object', entries: { t: { kind: 'object' }, speed: { kind: 'value', value: '2' } } },
  });
});

test('a turtle whose handle is overwritten stays on the board until remove removes a turtle', () => {
  const program = `turtle_new t1
turtle_new t2 3 3
t2=$t1
前に進む "$t2"
remove "$t2"
`;
  const trace = traceProgram('bash', program, program);
  expect(trace.traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 2, 2, 2, 1]);
  expect(executeProgram('bash', program)).toMatchObject({ finalTurtles: [{ x: 3, y: 3, dir: 'N' }] });
});
