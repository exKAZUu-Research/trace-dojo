import assert from 'node:assert/strict';

import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const summaries = [1000, 1001, 5000].map((length) => {
  const source = `main=do
 let xs=[1..${length}]::[Int]
 let ys=[2..${length + 1}]::[Int]
 let zs=[3..${length + 2}]::[Int]
 print(sum xs+sum ys+sum zs)
 loop 1 xs ys zs
loop::Int->[Int]->[Int]->[Int]->IO()
loop i xs ys zs
 |i>3000=print(length xs+length ys+length zs)
 |otherwise=do
  let k=i*2
  print k
  loop(i+1)xs ys zs`;
  const result = traceProgram('haskell', source, source);
  return {
    length,
    shape: 'integers',
    stdout: result.stdout,
    steps: result.traceItems.length,
    answers: result.traceItems.filter((item) => Object.hasOwn(item.vars, 'k')).length,
    first: result.traceItems.find((item) => item.referenceVars.xs?.kind === 'array')?.referenceVars.xs?.kind,
    last: result.traceItems.at(-1)?.referenceVars?.xs?.kind,
    exception: result.uncaughtException,
    ...transportSize(result),
  };
});
const pairs = `main=do
 let xs=[(i,i+1)|i<-[1..1000]]::[(Int,Int)]
 print(sum(map(\\(a,b)->a+b)xs))
 loop 1 xs
loop::Int->[(Int,Int)]->IO()
loop i xs
 |i>3000=print(length xs)
 |otherwise=do
  let k=i*2
  print k
  loop(i+1)xs`;
const pairResult = traceProgram('haskell', pairs, pairs);
summaries.push({
  length: 1000,
  shape: 'pairs',
  stdout: pairResult.stdout,
  steps: pairResult.traceItems.length,
  answers: pairResult.traceItems.filter((item) => Object.hasOwn(item.vars, 'k')).length,
  first: pairResult.traceItems.find((item) => item.referenceVars.xs?.kind === 'array')?.referenceVars.xs?.kind,
  last: pairResult.traceItems.at(-1)?.referenceVars?.xs?.kind,
  exception: pairResult.uncaughtException,
  ...transportSize(pairResult),
});
process.stdout.write(JSON.stringify(summaries));

function transportSize(result: ReturnType<typeof traceProgram>): { bytes: number; decodedAnswers: number } {
  const wire = stringify(result);
  const decoded = z
    .object({ stdout: z.string(), traceItems: z.array(z.object({ vars: z.record(z.string(), z.unknown()) })) })
    .parse(parse(wire));
  assert.equal(decoded.stdout, result.stdout);
  assert.equal(decoded.traceItems.length, result.traceItems.length);
  return {
    bytes: Buffer.byteLength(wire),
    decodedAnswers: decoded.traceItems.filter((item) => Object.hasOwn(item.vars, 'k')).length,
  };
}
