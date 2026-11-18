import assert from 'node:assert/strict';

import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';

const source = `import Control.Monad
data P=P Int Int
main=do
 ${Array.from({ length: 64 }, (_, index) => `let p${index}=P ${index} ${index}`).join('\n ')}
 forM_ [1..2000::Int] $ \\i->print i`;
const execution = executeProgram('haskell', source);
assert.ok(execution.kind === 'executed');
assert.equal(execution.uncaughtException, undefined);
assert.equal(execution.stdout, Array.from({ length: 2000 }, (_, index) => `${index + 1}\n`).join(''));
assert.throws(
  () => traceProgram('haskell', source, source),
  (error) => error instanceof ExecutionLimitError && error.limit === 'trace'
);
process.stdout.write(JSON.stringify({ limited: true }));
