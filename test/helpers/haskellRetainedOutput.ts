import assert from 'node:assert/strict';

import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const name = z
  .enum(['records', 'reverseOrder', 'turtles', 'longNames', 'wideRecords', 'snapshot'])
  .parse(process.argv[2]);
const recordBindings = [`let ps=[P i i | i<-[1..${name === 'wideRecords' ? 500 : 20}::Int]]`, 'let cheap=P 1 2'];
const field = name === 'longNames' ? 'aVeryLongFieldName'.repeat(40) : 'px';
const source =
  name === 'snapshot'
    ? `data T=Leaf|T T T
data P=P{px::Int,py::Int}
grow x=T x x
at n=iterate grow Leaf !! n
main=do
 let ps=map at [15,13,9,7,6,2,1,0,0,0]
 let cheap=P 1 2
 print(1::Int)
 print(2::Int)`
    : name === 'turtles'
      ? `import Control.Monad
main=do
 t<-newTurtle
 ts<-forM [1..30::Int] (\\i->newTurtleAt (i \`mod\` 7) 1)
 forM_ [1..1000::Int] $ \\i->do
  turnRight t`
      : `import Control.Monad
data P=P{${field}::Int,py::Int}
main=do
 ${(name === 'reverseOrder' ? recordBindings.toReversed() : recordBindings).join('\n ')}
 ${name === 'wideRecords' ? 'print(sum[px p+py p|p<-ps])' : ''}
 forM_ [1..2000::Int] $ \\i->do
  print i`;
const recording = traceProgram('haskell', source, source);
assert.equal(recording.uncaughtException, undefined);
const names = name === 'turtles' ? ['t', 'ts'] : ['ps', 'cheap'];
const initial = recording.traceItems.findIndex((item) => names.every((key) => Object.hasOwn(item.referenceVars, key)));
assert.ok(initial !== -1);
for (const item of recording.traceItems.slice(initial)) {
  for (const key of names) assert.ok(Object.hasOwn(item.referenceVars, key), `${key} absent on line ${item.line}`);
  if (name === 'records' || name === 'reverseOrder' || name === 'wideRecords' || name === 'snapshot')
    z.object({
      kind: z.literal('object'),
      entries: z.object({
        px: z.object({ kind: z.literal('value'), value: z.literal(1) }),
        py: z.object({ kind: z.literal('value'), value: z.literal(2) }),
      }),
    }).parse(item.referenceVars.cheap);
}
if (name === 'turtles' || name === 'longNames' || name === 'wideRecords' || name === 'snapshot')
  assert.ok(recording.traceItems.some((item) => item.referenceVars[names[0]!]?.kind === 'value'));
if (name === 'wideRecords' || name === 'snapshot')
  assert.ok(recording.traceItems.some((item) => item.referenceVars.ps?.kind === 'array'));
const wire = stringify(recording);
const decoded = z
  .object({ traceItems: z.array(z.object({ referenceVars: z.record(z.string(), z.unknown()) })) })
  .parse(parse(wire));
assert.equal(decoded.traceItems.length, recording.traceItems.length);
for (const item of decoded.traceItems.slice(initial)) {
  for (const key of names) assert.ok(Object.hasOwn(item.referenceVars, key));
}
if (name === 'turtles') assert.equal(recording.finalTurtles.length, 31);
else if (name === 'snapshot') assert.equal(recording.stdout, '1\n2\n');
else
  assert.equal(
    recording.stdout,
    (name === 'wideRecords' ? '250500\n' : '') + Array.from({ length: 2000 }, (_, index) => `${index + 1}\n`).join('')
  );
process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(wire), items: recording.traceItems.length }));
