import assert from 'node:assert/strict';

import { z } from 'zod';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { parse, stringify } from '../../src/interpreter/traceTransport';

const name = z
  .enum(['fourTurtles', 'fiveTurtles', 'sevenLists', 'sixteenLists', 'records', 'tuples', 'growing'])
  .parse(process.argv[2]);
const turtles = name === 'fourTurtles' || name === 'fiveTurtles';
const lists = name === 'sevenLists' || name === 'sixteenLists' || name === 'growing';
const count =
  name === 'fourTurtles'
    ? 4
    : name === 'fiveTurtles'
      ? 5
      : name === 'sevenLists' || name === 'growing'
        ? 7
        : name === 'sixteenLists'
          ? 16
          : 11;
const loops =
  name === 'fourTurtles'
    ? 4900
    : name === 'fiveTurtles'
      ? 4000
      : name === 'sevenLists'
        ? 4500
        : name === 'sixteenLists'
          ? 2000
          : name === 'growing'
            ? 3500
            : 1000;
const names = Array.from({ length: count }, (_, index) => `v${index}`);
const source = `import Control.Monad
data P=P Int Int
main=do
 ${lists || turtles ? '' : 'let ps=[P i i|i<-[1..200::Int]]'}
 ${name === 'growing' ? 'let ps=[P i i|i<-[1..200::Int]]\n forM_ [1..1000::Int] print' : ''}
 ${names.map((key, index) => (turtles ? `${key}<-newTurtleAt ${index % 7} ${Math.floor(index / 7)}` : `let ${key}=${lists ? `[${index},${index + 1}::Int]` : name === 'tuples' ? `(${index}::Int,True)` : `P ${index} ${index}`}`)).join('\n ')}
 forM_ [1..${loops}::Int] $ \\i->do
  print i`;
const execution = executeProgram('haskell', source);
assert.ok(execution.kind === 'executed');
assert.equal(execution.uncaughtException, undefined);
const trace = traceProgram('haskell', source, source);
assert.equal(trace.uncaughtException, undefined);
assert.equal(trace.stdout, execution.stdout);
assert.equal(trace.traceItems.filter((item) => item.line === source.split('\n').length).length, loops);
const first = trace.traceItems.findIndex((item) => names.every((key) => Object.hasOwn(item.referenceVars, key)));
assert.ok(first > 0);
checkRoots(trace.traceItems.slice(first));
const wire = stringify(trace);
const decoded = z
  .object({ stdout: z.string(), traceItems: z.array(z.object({ referenceVars: z.record(z.string(), z.unknown()) })) })
  .parse(parse(wire));
assert.equal(decoded.stdout, execution.stdout);
assert.equal(decoded.traceItems.length, trace.traceItems.length);
checkRoots(decoded.traceItems.slice(first));
if (turtles) assert.deepEqual(trace.finalTurtles, execution.finalTurtles);
process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(wire), items: trace.traceItems.length, loops }));

function checkRoots(items: { referenceVars: Record<string, unknown> }[]): void {
  for (const item of items) {
    for (const [index, key] of names.entries()) {
      assert.ok(Object.hasOwn(item.referenceVars, key));
      if (!lists && !turtles) {
        const node = z
          .object({
            kind: z.literal(name === 'tuples' ? 'array' : 'object'),
            entries: z.record(z.string(), z.unknown()),
          })
          .parse(item.referenceVars[key]);
        z.object({ kind: z.literal('value'), value: z.literal(index) }).parse(node.entries[0]);
        z.object({ kind: z.literal('value'), value: name === 'tuples' ? z.literal(true) : z.literal(index) }).parse(
          node.entries[1]
        );
      }
    }
  }
}
