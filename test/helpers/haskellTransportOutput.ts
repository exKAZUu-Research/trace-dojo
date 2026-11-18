import assert from 'node:assert/strict';

import { z } from 'zod';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const name = z
  .enum([
    'control',
    'negativeZero',
    'nan',
    'infinity',
    'negativeInfinity',
    'deepBigints',
    'finite',
    'mixed',
    'selfField',
    'equalityControl',
    'emptyLists',
    'singletonLists',
    'singletonStrings',
    'deepEmpty',
    'protectedName',
  ])
  .parse(process.argv[2]);
const values = {
  control: 'replicate 1000 (-0.0::Double)',
  negativeZero: 'replicate 1000 (-0.0::Double)',
  nan: 'replicate 1000 (0/0::Double)',
  infinity: 'replicate 1000 (1/0::Double)',
  negativeInfinity: 'replicate 1000 (-1/0::Double)',
  deepBigints: `${'replicate 1 ('.repeat(10)}replicate 200 (10^30::Integer)${')'.repeat(10)}`,
  finite: '[0.0::Double]',
  mixed: 'concat(replicate 20 [0.0,-0.0,0/0,1/0,-1/0::Double])',
  selfField: 'replicate 1000 (0/0::Double)',
  equalityControl: 'replicate 1000 ([]::[Int])',
  emptyLists: 'replicate 1000 ([]::[Int])',
  singletonLists: 'replicate 1000 [0::Int]',
  singletonStrings: 'replicate 1000 [""::String]',
  protectedName: 'replicate 1000 ([]::[Int])',
  deepEmpty: `${'replicate 1 ('.repeat(10)}replicate 200 ([]::[Int])${')'.repeat(10)}`,
};
const loops = name === 'control' || name === 'equalityControl' ? 5 : 1200;
const source = `import Control.Monad
data R=R{specialFloatingPointValuesCollectedForTheCurrentIteration::[Double]}
main=do
 let ${name === 'protectedName' ? 'constructor' : 'xs'}=${values[name]}
 ${name === 'selfField' ? 'let this=R xs' : ''}
 let cheap=42::Int
 let later=(-0.0::Double)
 let big=(10^30::Integer)
 ${name === 'mixed' ? 'print(sum xs)' : `print(length ${name === 'protectedName' ? 'constructor' : 'xs'})`}
 forM_ [1..${loops}::Int] $ \\i->do
  print i`;
const recording = traceProgram('haskell', source, source);
assert.equal(recording.uncaughtException, undefined);
assert.equal(recording.traceItems.filter((item) => item.line === source.split('\n').length).length, loops);
const execution = executeProgram('haskell', source);
assert.ok(execution.kind === 'executed');
assert.equal(recording.stdout, execution.stdout);
assert.equal(execution.uncaughtException, undefined);
const transported = stringify(recording);
const decoded = z
  .object({
    finalVars: z.record(z.string(), z.unknown()),
    traceItems: z.array(z.object({ vars: z.record(z.string(), z.unknown()) })),
  })
  .parse(parse(transported));
assert.equal(decoded.traceItems.length, recording.traceItems.length);
assert.equal(decoded.finalVars.cheap, 42);
assert.ok(Object.is(decoded.finalVars.later, -0));
assert.equal(decoded.finalVars.big, 10n ** 30n);
const last = decoded.traceItems.at(-1);
assert.ok(last);
assert.equal(last.vars.cheap, 42);
assert.ok(Object.is(last.vars.later, -0));
assert.equal(last.vars.big, 10n ** 30n);
const displayed = decoded.traceItems.find((item) =>
  Array.isArray(item.vars[name === 'protectedName' ? 'constructor' : 'xs'])
);
assert.ok(displayed);
let leaf: unknown = displayed.vars[name === 'protectedName' ? 'constructor' : 'xs'];
while (Array.isArray(leaf)) leaf = leaf[0];
if (name === 'control' || name === 'negativeZero') assert.ok(Object.is(leaf, -0));
else if (name === 'nan' || name === 'selfField') assert.ok(Number.isNaN(leaf));
else if (name === 'infinity') assert.equal(leaf, Infinity);
else if (name === 'negativeInfinity') assert.equal(leaf, -Infinity);
else if (name === 'deepBigints') assert.equal(leaf, 10n ** 30n);
else if (name === 'finite') assert.ok(Object.is(leaf, 0));
else if (name === 'mixed') {
  const values = z.array(z.unknown()).parse(displayed.vars.xs);
  assert.ok(Object.is(values[0], 0));
  assert.ok(Object.is(values[1], -0));
  assert.ok(Number.isNaN(values[2]));
  assert.equal(values[3], Infinity);
  assert.equal(values[4], -Infinity);
}
if (name === 'equalityControl' || name === 'emptyLists') {
  z.array(z.array(z.unknown()).length(0)).length(1000).parse(displayed.vars.xs);
} else if (name === 'singletonLists') {
  z.array(z.tuple([z.literal(0)]))
    .length(1000)
    .parse(displayed.vars.xs);
} else if (name === 'singletonStrings') {
  z.array(z.tuple([z.literal('')]))
    .length(1000)
    .parse(displayed.vars.xs);
} else if (name === 'deepEmpty') {
  let nested: unknown = displayed.vars.xs;
  while (Array.isArray(nested) && nested.length === 1) nested = nested[0];
  z.array(z.array(z.unknown()).length(0)).length(200).parse(nested);
}
if (name === 'control' || name === 'finite' || name === 'equalityControl') {
  assert.ok(Array.isArray(last.vars.xs));
  assert.ok(Array.isArray(decoded.finalVars.xs));
  assert.equal(decoded.finalVars.xs.length, name === 'finite' ? 1 : 1000);
}
process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(transported), loops }));
