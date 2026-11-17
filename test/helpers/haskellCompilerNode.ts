import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';

const count = 10_000;
const chain = Array.from({ length: count }, (_, index) => `type A${index}=A${index + 1}`).join('\n');
const synonyms = [
  `${chain}\ntype A${count}=Int\nmain=print(1::Int)`,
  `${chain}\ntype A${count}=A0\nmain=print(1::Int)`,
  'type A=B -> C\ntype B=C\ntype C=Int\nmain=print((id::A) 1)',
  'type A a=B a\ntype B a=C a -> a\ntype C a=A a\nmain=print(1::Int)',
];
const chains = [
  'main=print(' + Array.from({ length: 100 }, () => '1').join('+') + ')',
  ...[3000, 6000].map((size) => 'main=print(' + Array.from({ length: size }, () => '1').join('+') + ')'),
  'main=print(head(' + Array.from({ length: 3000 }, () => '1').join(':') + ':[]))',
  'main=print(case [] of {' + Array.from({ length: 3000 }, () => '_').join(':') + ':_ -> 1; _ -> 0})',
  'main=print(case [] of {[' + Array.from({ length: 3000 }, () => '_').join(',') + '] -> 1; _ -> 0})',
  'main=print(' +
    Array.from({ length: 50 }).reduce<string>(
      (value) => '(' + Array.from({ length: 20 }, () => '1').join('+') + '+' + value + ')',
      '1'
    ) +
    ')',
  'main=print(' +
    Array.from({ length: 50 }).reduce<string>(
      (value) => '(' + value + '+' + Array.from({ length: 20 }, () => '1').join('+') + ')',
      '1'
    ) +
    ')',
  'main=print(1::Int)',
];
const primitives = ['error(f(n+1))', 'errorWithoutStackTrace(f(n+1))', 'errorWithoutStackTrace("x"++f(n+1))'];
const nativeResults = primitives.flatMap((rhs) => {
  const source = `f n=${rhs}\nmain=putStrLn(f(0::Int))`;
  let trace;
  try {
    traceProgram('haskell', source, source);
    throw new Error('Expected an execution limit');
  } catch (error) {
    if (!(error instanceof ExecutionLimitError)) throw error;
    trace = { kind: 'limitExceeded', limit: error.limit };
  }
  return [executeProgram('haskell', source), trace];
});
const displayResults = primitives.map((rhs) => {
  const source = `f n=${rhs}\nmain=do\n let x=f(0::Int)\n let y=1::Int\n print y\n print(y+1)`;
  return traceProgram('haskell', source, source);
});
process.stdout.write(
  JSON.stringify({
    synonyms: synonyms.map((source) => executeProgram('haskell', source)),
    chains: chains.map((source) => executeProgram('haskell', source)),
    native: nativeResults,
    display: displayResults,
    recovery: executeProgram('haskell', 'f 0="stop"; f n=error(f(n-1)); main=putStrLn(f(32::Int))'),
  })
);
