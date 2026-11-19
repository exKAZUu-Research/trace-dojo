import assert from 'node:assert/strict';

import { z } from 'zod';

import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const source = `import Control.Monad
data T=Leaf|T T T T
grow x=T x x x
main=do
 let x=iterate grow Leaf !! 8
 let cheap=42::Int
 forM_ [1..1000::Int] $ \\i->do
  print i`;
const recording = traceProgram('haskell', source, source);
assert.equal(recording.uncaughtException, undefined);
assert.equal(recording.stdout, Array.from({ length: 1000 }, (_, index) => `${index + 1}\n`).join(''));
assert.equal(recording.traceItems.filter((item) => item.line === 8).length, 1000);
assert.ok(recording.traceItems.some((item) => item.referenceVars.x?.kind === 'object'));
assert.equal(recording.traceItems.at(-1)?.vars.cheap, 42);
assert.equal(recording.finalVars.cheap, 42);
const wire = stringify(recording);
const decoded = z
  .object({
    stdout: z.string(),
    traceItems: z.array(z.object({ vars: z.record(z.string(), z.unknown()) })),
    finalVars: z.record(z.string(), z.unknown()),
  })
  .parse(parse(wire));
assert.equal(decoded.stdout, recording.stdout);
assert.equal(decoded.traceItems.length, recording.traceItems.length);
assert.equal(decoded.traceItems.at(-1)?.vars.cheap, 42);
assert.equal(decoded.finalVars.cheap, 42);
const transportBytes = Buffer.byteLength(wire);

const turtles = `import Control.Monad
main=do
 ts<-replicateM 1000 newTurtle
 forM_ [1..1000::Int] $ \\i->print i
 print(length ts)`;
const execution = executeProgram('haskell', turtles);
assert.ok(execution.kind === 'executed');
assert.equal(execution.stdout, Array.from({ length: 1000 }, (_, index) => `${index + 1}\n`).join('') + '1000\n');
assert.equal(execution.uncaughtException, undefined);
assert.equal(execution.finalTurtles.length, 1000);
assert.throws(
  () => traceProgram('haskell', turtles, turtles),
  (error) => error instanceof ExecutionLimitError && error.limit === 'trace'
);
process.stdout.write(JSON.stringify({ transportBytes, stateLimited: true }));
