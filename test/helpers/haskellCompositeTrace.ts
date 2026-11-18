import assert from 'node:assert/strict';

import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const cases = [
  { name: 'pairs', type: '[(Int,Int)]', value: '[(k,k*2)|k<-[1..20]]', size: 20 },
  { name: 'maybe', type: '[Maybe Int]', value: '[Just k|k<-[1..20]]', size: 20 },
  { name: 'map', type: 'M.Map Int Int', value: 'M.fromList[(k,k)|k<-[1..100]]', size: 100 },
  { name: 'set', type: 'S.Set Int', value: 'S.fromList[1..100]', size: 100 },
];
const summaries = cases.flatMap(({ name, type, value, size }) =>
  [100, 1500].map((loops) => {
    const source = `import qualified Data.Map as M
import qualified Data.Set as S
main=do
 let xs=${value}::${type}
 print(length(show xs))
 loop 1 xs
loop::Int->${type}->IO()
loop i xs
 |i>${loops}=print i
 |otherwise=do
  let k=i*2
  print k
  loop(i+1)xs`;
    const result = traceProgram('haskell', source, source);
    const iterations = result.traceItems.filter((item) => Object.hasOwn(item.vars, 'k'));
    return {
      name,
      size,
      loops,
      stdout: result.stdout.split('\n').slice(1).join('\n'),
      answers: iterations.length,
      shown: iterations.filter((item) => item.referenceVars.xs?.kind === 'array').length,
      first: result.traceItems.find((item) => item.referenceVars.xs?.kind === 'array')?.referenceVars.xs,
      entries: result.traceItems.at(-1)?.referenceVars.xs,
      exception: result.uncaughtException,
      ...transportSize(result, 'k'),
    };
  })
);
const growing = [30, 300].map((loops) => {
  const source = `import qualified Data.Map as M
main=loop 1 M.empty
loop::Int->M.Map Int Int->IO()
loop i xs
 |i>${loops}=print(M.size xs)
 |otherwise=do
  let ys=M.insert i(i*2)xs
  print(M.size ys)
  loop(i+1)ys`;
  const result = traceProgram('haskell', source, source);
  return {
    loops,
    stdout: result.stdout,
    shown: result.traceItems.filter((item) => item.referenceVars.ys?.kind === 'array').length,
    answers: result.traceItems.filter((item) => Object.hasOwn(item.vars, 'i')).length,
    entries: result.traceItems.at(-1)?.referenceVars.xs,
    exception: result.uncaughtException,
    ...transportSize(result, 'i'),
  };
});
process.stdout.write(JSON.stringify({ unchanged: summaries, growing }));

function transportSize(
  recording: ReturnType<typeof traceProgram>,
  answer: string
): { bytes: number; decodedAnswers: number } {
  const transported = stringify(recording);
  const decoded = z
    .object({
      stdout: z.string(),
      traceItems: z.array(z.object({ vars: z.record(z.string(), z.unknown()) })),
    })
    .parse(parse(transported));
  assert.equal(decoded.stdout, recording.stdout);
  assert.equal(decoded.traceItems.length, recording.traceItems.length);
  return {
    bytes: Buffer.byteLength(transported),
    decodedAnswers: decoded.traceItems.filter((item) => Object.hasOwn(item.vars, answer)).length,
  };
}
