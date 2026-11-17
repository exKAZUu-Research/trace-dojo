import { traceProgram } from '../../src/interpreter/program';

const cases = [
  { name: 'pairs', type: '[(Int,Int)]', value: '[(k,k*2)|k<-[1..20]]', size: 20 },
  { name: 'maybe', type: '[Maybe Int]', value: '[Just k|k<-[1..20]]', size: 20 },
  { name: 'map', type: 'M.Map Int Int', value: 'M.fromList[(k,k)|k<-[1..100]]', size: 100 },
  { name: 'set', type: 'S.Set Int', value: 'S.fromList[1..100]', size: 100 },
];
const summaries = cases.map(({ name, type, value, size }) => {
  const source = `import qualified Data.Map as M
import qualified Data.Set as S
main=do
 let xs=${value}::${type}
 print(length(show xs))
 loop 1 xs
loop::Int->${type}->IO()
loop i xs
 |i>1500=print i
 |otherwise=do
  let k=i*2
  print k
  loop(i+1)xs`;
  const result = traceProgram('haskell', source, source);
  const iterations = result.traceItems.filter((item) => Object.hasOwn(item.vars, 'k'));
  return {
    name,
    size,
    stdout: result.stdout.split('\n').slice(1).join('\n'),
    shown: iterations.filter((item) => item.referenceVars?.xs?.kind === 'array').length,
    entries: result.traceItems.at(-1)?.referenceVars?.xs,
    exception: result.uncaughtException,
  };
});
const growing = `import qualified Data.Map as M
main=loop 1 M.empty
loop::Int->M.Map Int Int->IO()
loop i xs
 |i>300=print(M.size xs)
 |otherwise=do
  let ys=M.insert i(i*2)xs
  print(M.size ys)
  loop(i+1)ys`;
const result = traceProgram('haskell', growing, growing);
const iterations = result.traceItems.filter((item) => Object.hasOwn(item.referenceVars, 'ys'));
process.stdout.write(
  JSON.stringify({
    unchanged: summaries,
    growing: {
      stdout: result.stdout,
      shown: iterations.filter((item) => item.referenceVars?.ys?.kind === 'array').length,
      expected: iterations.length,
      entries: result.traceItems.at(-1)?.referenceVars?.xs,
      exception: result.uncaughtException,
    },
  })
);
