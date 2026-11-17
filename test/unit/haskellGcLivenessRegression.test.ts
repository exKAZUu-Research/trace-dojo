import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';

test('nested turtle traces retain shared liveness within a bounded Node heap', { timeout: 30_000 }, () => {
  const bundle = execFileSync(
    'bun',
    ['build', 'test/helpers/haskellGcLivenessMemory.ts', '--target=node', '--packages=external'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  );
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
