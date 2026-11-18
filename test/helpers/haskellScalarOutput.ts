import assert from 'node:assert/strict';

import { traceProgram } from '../../src/interpreter/program';

const scenarios = [
  { name: 'small', outer: 100, inner: 100, loops: 5, binding: '' },
  { name: 'million', outer: 1000, inner: 1000, loops: 250, binding: '' },
  { name: 'repeated', outer: 1000, inner: 200, loops: 500, binding: '' },
  {
    name: 'aliases',
    outer: 100,
    inner: 100,
    loops: 5,
    binding: `let {${Array.from({ length: 20 }, (_, i) => `alias${i}=xs`).join(';')}}`,
  },
  { name: 'selfField', outer: 1000, inner: 200, loops: 5, binding: 'let this=Record xs (7::Int)' },
];
const results = scenarios.map(({ name, outer, inner, loops, binding }) => {
  const source = `import Control.Monad
data Record=Record{payload::[[Int]],small::Int}
main=do
 let xs=replicate ${outer} [1..${inner}::Int]
 ${binding}
 let cheap=42::Int
 print(length xs)
 print(sum(head xs))
 forM_ [1..${loops}::Int] $ \\i -> do
  print i`;
  const recording = traceProgram('haskell', source, source);
  assert.equal(recording.uncaughtException, undefined);
  const serialized = JSON.stringify(recording);
  const last = recording.traceItems.at(-1);
  assert.ok(last);
  const small = name === 'small' || name === 'aliases';
  if (small) {
    assert.ok(Array.isArray(last.vars.xs));
    assert.equal(last.vars.xs.length, outer);
    assert.deepEqual(
      last.vars.xs[0],
      Array.from({ length: inner }, (_, index) => index + 1)
    );
    assert.deepEqual(recording.finalVars.xs, last.vars.xs);
  } else {
    assert.equal(Object.hasOwn(last.vars, 'xs'), false);
    assert.equal(Object.hasOwn(recording.finalVars, 'xs'), false);
    assert.deepEqual(last.referenceVars.xs, { kind: 'value', value: '…' });
  }
  assert.equal(last.vars.cheap, 42);
  assert.equal(recording.finalVars.cheap, 42);
  if (name === 'selfField') {
    assert.equal(Object.hasOwn(last.vars, 'this.payload'), false);
    assert.equal(Object.hasOwn(recording.finalVars, 'this.payload'), false);
    assert.equal(last.vars['this.small'], 7);
    assert.equal(recording.finalVars['this.small'], 7);
  }
  return {
    name,
    bytes: Buffer.byteLength(serialized),
    stdout: recording.stdout,
    answers: Object.keys(last.vars),
    finalAnswers: Object.keys(recording.finalVars),
    loops,
    outer,
    inner,
  };
});
process.stdout.write(JSON.stringify(results));
