import { expect, test } from 'vitest';

import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';

const actions = [
  ['print', 'print(sum [1..100::Int])', '5050\n'],
  ['putStrLn', 'putStrLn(show(sum [1..100::Int]))', '5050\n'],
  ['let prefix', 'do {let {n=sum [1..100::Int]}; print n}', '5050\n'],
  ['sequence', 'do {print(sum [1..100::Int]);print(sum [1..100::Int]+1)}', '5050\n5051\n'],
  ['bind action', 'do {n<-pure(sum [1..100::Int]);print n}', '5050\n'],
  ['conditional', 'if True then print(sum [1..100::Int]) else error "unused"', '5050\n'],
  ['case', 'case True of {True->print(sum [1..100::Int]);False->error "unused"}', '5050\n'],
  ['strict argument', '(\\x->x `seq` print x)(sum [1..100::Int])', '5050\n'],
];

test.each(actions.flatMap(([name, action, output]) => [false, true].map((force) => ({ name, action, output, force }))))(
  'reused $name action shares pure arguments, forced=$force',
  ({ action, output, force }) => {
    const source = `import Control.Monad
main=do
 let action=${action}
 ${force ? 'action `seq` ' : ''}replicateM_ 1000 action`;
    const stdout = output.repeat(1000);
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
    const recording = traceProgram('haskell', source, source);
    expect(recording.stdout).toBe(stdout);
    expect(recording.uncaughtException).toBeUndefined();
  }
);

test('bind continuations keep per-execution pure computations', () => {
  const source = `import Control.Monad
main=do
 let action=do {_<-pure();print(sum [1..100::Int])}
 replicateM_ 1000 action`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(() => traceProgram('haskell', source, source)).toThrowError(ExecutionLimitError);
});

test('reused actions produce fresh bind results and trace frames', () => {
  const source = `make::IO Turtle
make=do
 t<-newTurtle
 pure t
main=do
 a<-make
 b<-make
 turnRight a
 turnLeft b`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.finalTurtles).toEqual([
    { x: 0, y: 0, color: '#', dir: 'E' },
    { x: 0, y: 0, color: '#', dir: 'W' },
  ]);
  const calls = recording.traceItems.filter((item) => item.line === 3);
  expect(calls.map((item) => item.callLines)).toEqual([[6], [7]]);
});

test.each([false, true])('generic action shares its constructed prefix, forced=%s', (force) => {
  const source = `import Control.Monad
act::Monad m=>m()
act=do
 let n=sum [1..50000::Int]
 n \`seq\` pure()
main=do
 let action=act::IO()
 ${force ? 'action `seq` ' : ''}replicateM_ 2 action
 putStrLn "done"`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'done\n',
    uncaughtException: undefined,
  });
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('done\n');
  expect(recording.uncaughtException).toBeUndefined();
});

test.each([
  ['do {let {n=t `seq` (1::Int)}; print n}', false],
  ['print(t `seq` (1::Int))', true],
])('reused actions preserve future trace roots: %s', (body, released) => {
  const source = `make=do
 t<-newTurtleAt 0 1
 return $ ${body}
main=do
 a<-make
 a
 r<-newTurtle
 b<-canMoveForward r
 print b
 a`;
  const stdout = `1\n${released ? 'True' : 'False'}\n1\n`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe(stdout);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.find((item) => item.line === 8)?.turtles).toHaveLength(released ? 1 : 2);
});
