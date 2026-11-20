import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { buildNodeBundle } from '../helpers/buildNodeBundle';

test('nested turtle traces retain shared liveness within a bounded Node heap', { timeout: 30_000 }, () => {
  const bundle = buildNodeBundle('test/helpers/haskellGcLivenessMemory.ts');
  const output = execFileSync('node', ['--max-old-space-size=256', '--input-type=module'], {
    input: bundle,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const results = z
    .array(
      z.object({
        name: z.string(),
        stdout: z.string(),
        steps: z.number(),
        turtles: z.number(),
        variables: z.number(),
        first: z.number().optional(),
        last: z.number().optional(),
      })
    )
    .parse(JSON.parse(output));
  expect(results).toEqual([
    { name: 'right', stdout: '0\n', steps: 9003, turtles: 1, variables: 0 },
    { name: 'left', stdout: '0\n', steps: 9003, turtles: 1, variables: 0 },
    { name: 'distinct', stdout: '0\n(1,1)\n', steps: 6, turtles: 1, variables: 6000, first: 1, last: 1 },
  ]);
});

test('nested shadows preserve pending turtles at distinct lexical depths', () => {
  const source = `main=do
 a<-newTurtleAt 1 1
 if True then do
  b<-newTurtleAt 2 2
  if True then do
   let a=()
       b=()
   print(0::Int)
   else pure()
  turnRight a
  turnLeft b
  else pure()
 print(1::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n1\n');
  expect(result.traceItems.find((item) => item.line === 8)?.turtles).toEqual([
    { x: 1, y: 1, color: '#', dir: 'N' },
    { x: 2, y: 2, color: '#', dir: 'N' },
  ]);
  expect(result.finalTurtles).toEqual([{ x: 1, y: 1, color: '#', dir: 'E' }]);
});

test.each([
  'if True then do\n  let t=()\n  print(0::Int)\n  else pure()',
  'case True of\n  True->do\n   let t=()\n   print(0::Int)\n  False->pure()',
  'when True $ do\n  let t=()\n  print(0::Int)',
  'unless False $ do\n  let t=()\n  print(0::Int)',
])('temporary turtle shadowing preserves the resumed scope: %s', (block) => {
  const source = `import Control.Monad (unless, when)
main=do
 t<-newTurtleAt 0 1
 ${block}
 r<-newTurtle
 clear<-canMoveForward r
 print clear`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: '0\nFalse\n', uncaughtException: undefined });
  const traced = traceProgram('haskell', source, source);
  expect(traced.stdout).toBe('0\nFalse\n');
  expect(traced.uncaughtException).toBeUndefined();
  expect(traced.finalTurtles).toHaveLength(2);
});

test('ending a nested shadow restores the final visible turtle', () => {
  const source = `main=do
 t<-newTurtleAt 0 1
 if True then do
  let t=()
  print(0::Int)
  else pure()`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalTurtles).toEqual([{ x: 0, y: 1, color: '#', dir: 'N' }]);
});

test('nested shadowed turtles survive only while their lexical scopes remain active', () => {
  const source = `main=do
 a<-newTurtleAt 0 1
 if True then do
  b<-newTurtleAt 1 1
  if True then do
   let a=()
       b=()
   print(0::Int)
   else pure()
  print(1::Int)
  else pure()
 r<-newTurtle
 clear<-canMoveForward r
 print clear`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: '0\n1\nFalse\n', uncaughtException: undefined });
  const traced = traceProgram('haskell', source, source);
  expect(traced.stdout).toBe('0\n1\nFalse\n');
  expect(traced.uncaughtException).toBeUndefined();
  expect(traced.traceItems.find((item) => item.line === 8)?.turtles).toHaveLength(2);
  expect(traced.finalTurtles).toEqual([
    { x: 0, y: 1, color: '#', dir: 'N' },
    { x: 0, y: 0, color: '#', dir: 'N' },
  ]);
});

test('a permanent shadow releases the restored turtle when the shadow executes', () => {
  const source = `main=do
 t<-newTurtleAt 0 1
 if True then do
  let t=()
  print(0::Int)
  else pure()
 print(1::Int)
 let t=()
 r<-newTurtle
 clear<-canMoveForward r
 print clear`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: '0\n1\nTrue\n', uncaughtException: undefined });
  const traced = traceProgram('haskell', source, source);
  expect(traced.stdout).toBe('0\n1\nTrue\n');
  expect(traced.uncaughtException).toBeUndefined();
  expect(traced.traceItems.find((item) => item.line === 7)?.turtles).toHaveLength(1);
  expect(traced.finalTurtles).toEqual([{ x: 0, y: 0, color: '#', dir: 'N' }]);
});

test.each([
  ['length ts', 'count', 'count'],
  ['sum(map(const(1::Int))ts)', 'count', 'count'],
  ['(length ts, ())', 'fst count', 'fst count'],
  ['Just(length ts)', 'maybe 0 id count', 'maybe 0 id count'],
])('displaying %s preserves pending turtle references until normal demand', (expression, demand, result) => {
  const source = `main=do
 ts<-mapM (\\x->newTurtleAt x 1) [0]
 let count=${expression}
 let ts=[]::[Turtle]
 r<-newTurtle
 clear<-canMoveForward r
 print clear
 print(${demand})
 clearAfter<-canMoveForward r
 print clearAfter
 print(${result})`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: 'False\n1\nTrue\n1\n', uncaughtException: undefined });
  assert.equal(executed.kind, 'executed');
  const traced = traceProgram('haskell', source, source);
  expect(traced.stdout).toBe(executed.stdout);
  expect(traced.uncaughtException).toBeUndefined();
});

test('settling a shared child releases its original turtle roots through an undemanded parent', () => {
  const source = `main=do
 ts<-mapM (\\x->newTurtleAt x 1) [0]
 let child=length ts
 let parent=child+1
 let ts=[]::[Turtle]
 r<-newTurtle
 clear<-canMoveForward r
 print clear
 print child
 clearAfter<-canMoveForward r
 print clearAfter
 print parent`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: 'False\n1\nTrue\n2\n', uncaughtException: undefined });
  assert.equal(executed.kind, 'executed');
  expect(traceProgram('haskell', source, source).stdout).toBe(executed.stdout);
});

test('returned lazy values keep their original roots across trace frame retirement', () => {
  const source = `make=do
 ts<-mapM (\\x->newTurtleAt x 1) [0]
 pure(length ts)
main=do
 count<-make
 r<-newTurtle
 clear<-canMoveForward r
 print clear
 print count
 clearAfter<-canMoveForward r
 print clearAfter`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: 'False\n1\nTrue\n', uncaughtException: undefined });
  assert.equal(executed.kind, 'executed');
  expect(traceProgram('haskell', source, source).stdout).toBe(executed.stdout);
});

test('a displayed lazy drop preserves the original list until execution demands its tail', () => {
  const source = `main=do
 ts<-mapM (\\x->newTurtleAt x 1) [0,1]
 ts<-pure(drop 1 ts)
 r<-newTurtle
 clear<-canMoveForward r
 print clear
 mapM_ turnRight ts
 clearAfter<-canMoveForward r
 print clearAfter`;
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: 'False\nTrue\n', uncaughtException: undefined });
  assert.equal(executed.kind, 'executed');
  expect(traceProgram('haskell', source, source).stdout).toBe(executed.stdout);
});
