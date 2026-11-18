import assert from 'node:assert/strict';

import { stringify } from 'superjson';

import { traceProgram } from '../../src/interpreter/program';

const scenarios = [
  { name: 'small', outer: 100, inner: 100, loops: 5, binding: '' },
  { name: 'manySnapshots', outer: 100, inner: 100, loops: 1000, binding: '' },
  { name: 'wideSnapshots', outer: 1000, inner: 100, loops: 200, binding: '' },
  { name: 'strings', outer: 1000, inner: 200, loops: 1500, binding: '', strings: true },
  { name: 'escapedStrings', outer: 1000, inner: 200, loops: 500, binding: '', strings: true, escaped: true },
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
const results = scenarios.map(({ name, outer, inner, loops, binding, strings, escaped }) => {
  const source = `import Control.Monad
data Record=Record{payload::[[Int]],small::Int}
main=do
 let xs=replicate ${outer} (${strings ? `replicate ${inner} '${escaped ? String.raw`\n` : 'x'}'` : `[1..${inner}::Int]`})
 ${binding}
 let cheap=42::Int
 print(length xs)
 print(${strings ? 'length' : 'sum'}(head xs))
 forM_ [1..${loops}::Int] $ \\i -> do
  print i`;
  const recording = traceProgram('haskell', source, source);
  assert.equal(recording.uncaughtException, undefined);
  assert.equal(recording.traceItems.filter((item) => item.line === 10).length, loops);
  const serialized = JSON.stringify(recording);
  const last = recording.traceItems.at(-1);
  assert.ok(last);
  const small = name === 'small';
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
    assert.ok(last.referenceVars.xs === undefined || last.referenceVars.xs.kind === 'value');
  }
  assert.equal(last.vars.cheap, 42);
  assert.equal(recording.finalVars.cheap, 42);
  if (name === 'selfField') {
    assert.equal(Object.hasOwn(last.vars, 'this.payload'), false);
    assert.equal(Object.hasOwn(recording.finalVars, 'this.payload'), false);
    assert.equal(last.vars['this.small'], 7);
    assert.equal(recording.finalVars['this.small'], 7);
  }
  const transported = stringify(recording);
  return {
    name,
    hadFullArray: recording.traceItems.some((item) => Array.isArray(item.vars.xs)),
    transportBytes: Buffer.byteLength(transported),
    strings: strings ?? false,
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
