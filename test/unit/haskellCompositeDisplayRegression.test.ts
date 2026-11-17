import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import type { DisplayNode } from '../../src/problems/trace';

test(
  'immutable composite views survive unchanged and persistent-map loops within a bounded heap',
  { timeout: 30_000 },
  () => {
    const bundle = execFileSync(
      'bun',
      ['build', 'test/helpers/haskellCompositeTrace.ts', '--target=node', '--packages=external'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const output = execFileSync('node', ['--max-old-space-size=256', '--input-type=module'], {
      input: bundle,
      encoding: 'utf8',
      timeout: 15_000,
    });
    const array = z.object({ kind: z.literal('array'), entries: z.record(z.string(), z.unknown()) });
    const result = z
      .object({
        unchanged: z.array(
          z.object({
            name: z.string(),
            size: z.number(),
            stdout: z.string(),
            shown: z.number(),
            entries: array,
            exception: z.unknown().optional(),
          })
        ),
        growing: z.object({
          stdout: z.string(),
          shown: z.number(),
          expected: z.number(),
          entries: array,
          exception: z.unknown().optional(),
        }),
      })
      .parse(JSON.parse(output));
    expect(result.unchanged).toHaveLength(4);
    const stdout = Array.from({ length: 1500 }, (_, index) => `${(index + 1) * 2}\n`).join('') + '1501\n';
    for (const summary of result.unchanged) {
      expect(summary.stdout).toBe(stdout);
      expect(summary.shown).toBe(3000);
      expect(Object.keys(summary.entries.entries)).toHaveLength(summary.size);
      expect(summary.exception).toBeUndefined();
    }
    expect(result.growing.stdout).toBe(Array.from({ length: 300 }, (_, index) => `${index + 1}\n`).join('') + '300\n');
    expect(result.growing.shown).toBe(result.growing.expected);
    expect(result.growing.shown).toBeGreaterThanOrEqual(600);
    expect(Object.keys(result.growing.entries.entries)).toHaveLength(300);
    expect(result.growing.entries.entries['299']).toEqual({
      kind: 'array',
      entries: { '0': { kind: 'value', value: 300 }, '1': { kind: 'value', value: 600 } },
    });
    expect(result.growing.exception).toBeUndefined();
  }
);

test('cached structures keep nested turtle positions live', () => {
  const source = `import qualified Data.Map as M
data Box=Box {item::Turtle}
main=do
 t<-newTurtle
 let xs=[Just(t,1::Int)]
 let m=M.singleton(1::Int)t
 let box=Box t
 forward t
 turnRight t
 forward t`;
  const result = traceProgram('haskell', source, source);
  expect(result.traceItems.find((item) => item.line === 7)?.referenceVars).toMatchObject(turtleReferences(0, 0));
  expect(result.traceItems.at(-1)?.referenceVars).toMatchObject(turtleReferences(1, 1));
});

test('an incomplete composite display refreshes after execution demands its missing field', () => {
  const source = `main=do
 let pair=(sum[1..5000::Int],1::Int)
 print(0::Int)
 print(fst pair)
 print(snd pair)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n12502500\n1\n');
  expect(result.traceItems.at(-1)?.referenceVars?.pair).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 12_502_500 }, 1: { kind: 'value', value: 1 } },
  });
});

test('primitive node sharing preserves signed zero', () => {
  const source = `main=do
 let pair=(0.0::Double,-0.0::Double)
 print(fst pair)
 print(snd pair)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0.0\n-0.0\n');
  expect(result.traceItems.at(-1)?.referenceVars?.pair).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 0 }, 1: { kind: 'value', value: -0 } },
  });
});

function turtleReferences(x: number, y: number): Record<string, DisplayNode> {
  const turtle: DisplayNode = {
    kind: 'object',
    entries: { x: { kind: 'value', value: x }, y: { kind: 'value', value: y } },
  };
  return {
    xs: { kind: 'array', entries: { 0: { kind: 'array', entries: { 0: turtle } } } },
    m: { kind: 'array', entries: { 0: { kind: 'array', entries: { 1: turtle } } } },
    box: { kind: 'object', entries: { item: turtle } },
  };
}
