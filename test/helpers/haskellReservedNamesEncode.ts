import assert from 'node:assert/strict';

import { traceProgram } from '../../src/interpreter/program';
import { stringify } from '../../src/interpreter/traceTransport';

const results = [];
for (const name of ['constructor', '__proto__', 'prototype', 'toString']) {
  for (const field of [false, true]) {
    const source = `${field ? `data Box=Box{${name}::Integer}\n` : ''}main=do
 let ${field ? 'box=Box (10^30)' : `${name}=10^30::Integer`}
 let later=(-0.0::Double)
 print(1::Int)`;
    const recording = traceProgram('haskell', source, source);
    assert.equal(recording.uncaughtException, undefined);
    assert.equal(recording.stdout, '1\n');
    results.push({ name, field, wire: stringify(recording) });
  }
}
process.stdout.write(JSON.stringify(results));
