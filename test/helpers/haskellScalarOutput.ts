import assert from 'node:assert/strict';

import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

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
  { name: 'sharedText', outer: 1000, inner: 4, loops: 5, binding: '', strings: true, text: true },
  { name: 'selfField', outer: 1000, inner: 200, loops: 5, binding: 'let this=Record xs (7::Int)' },
];
const selected = z.enum(scenarios.map(({ name }) => name)).parse(process.argv[2]);
const results = scenarios
  .filter(({ name }) => name === selected)
  .map(({ name, outer, inner, loops, binding, strings, escaped, text }) => {
    const source = `import Control.Monad
data Record=Record{payload::[[Int]],small::Int}
main=do
 let xs=replicate ${outer} (${text ? `replicate 4 ${JSON.stringify('x'.repeat(10_000))}` : strings ? `replicate ${inner} '${escaped ? String.raw`\n` : 'x'}'` : `[1..${inner}::Int]`})
 ${binding}
 let cheap=42::Int
 print(length xs)
 print(${strings ? 'length' : 'sum'}(head xs))
 forM_ [1..${loops}::Int] $ \\i -> do
  print i`;
    const recording = traceProgram('haskell', source, source);
    assert.equal(recording.uncaughtException, undefined);
    assert.equal(recording.traceItems.filter((item) => item.line === 10).length, loops);
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
    }
    if (text) {
      assert.equal(Object.hasOwn(last.vars, 'xs'), false);
      assert.equal(last.referenceVars.xs?.kind, 'value');
      assert.ok(JSON.stringify(last).length < 1_000_000);
    }
    assert.equal(last.vars.cheap, 42);
    assert.equal(recording.finalVars.cheap, 42);
    if (name === 'selfField') {
      assert.equal(last.vars['this.small'], 7);
      assert.equal(recording.finalVars['this.small'], 7);
    }
    const transported = stringify(recording);
    const decoded = z
      .object({
        traceItems: z.array(z.object({ vars: z.record(z.string(), z.unknown()) })),
        finalVars: z.record(z.string(), z.unknown()),
        stdout: z.string(),
      })
      .parse(parse(transported));
    assert.equal(decoded.traceItems.length, recording.traceItems.length);
    assert.equal(decoded.stdout, recording.stdout);
    assert.equal(decoded.traceItems.at(-1)?.vars.cheap, 42);
    assert.equal(decoded.finalVars.cheap, 42);
    return {
      name,
      hadFullArray: recording.traceItems.some((item) => Array.isArray(item.vars.xs)),
      transportBytes: Buffer.byteLength(transported),
      strings: strings ?? false,
      stdout: recording.stdout,
      answers: Object.keys(last.vars),
      finalAnswers: Object.keys(recording.finalVars),
      loops,
      outer,
      inner,
    };
  });
process.stdout.write(JSON.stringify(results));
