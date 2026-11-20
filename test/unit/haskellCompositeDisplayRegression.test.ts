import { expect, test } from 'vitest';
import { z } from 'zod';

import { traceProgram } from '../../src/interpreter/program';
import type { DisplayNode } from '../../src/problems/trace';
import { createNodeBundleRunner } from '../helpers/nodeBundleRunner';

const runNodeBundle = createNodeBundleRunner();

test('immutable composite loops retain cheap answers within bounded transport output', { timeout: 30_000 }, () => {
  const output = runNodeBundle('test/helpers/haskellCompositeTrace.ts', { heapMb: 256, timeout: 15_000 });
  const array = z.object({ kind: z.literal('array'), entries: z.record(z.string(), z.unknown()) });
  const display = z.union([array, z.object({ kind: z.literal('value'), value: z.unknown() })]).optional();
  const result = z
    .object({
      unchanged: z.array(
        z.object({
          name: z.string(),
          size: z.number(),
          loops: z.number(),
          stdout: z.string(),
          answers: z.number(),
          shown: z.number(),
          first: array,
          entries: display,
          bytes: z.number(),
          decodedAnswers: z.number(),
          exception: z.unknown().optional(),
        })
      ),
      growing: z.array(
        z.object({
          loops: z.number(),
          stdout: z.string(),
          shown: z.number(),
          answers: z.number(),
          entries: display,
          bytes: z.number(),
          decodedAnswers: z.number(),
          exception: z.unknown().optional(),
        })
      ),
    })
    .parse(JSON.parse(output));
  expect(result.unchanged).toHaveLength(8);
  for (const summary of result.unchanged) {
    const { loops } = summary;
    expect(summary.stdout).toBe(
      Array.from({ length: loops }, (_, i) => `${(i + 1) * 2}\n`).join('') + `${loops + 1}\n`
    );
    expect(summary.answers).toBe(loops * 2);
    expect(summary.decodedAnswers).toBe(summary.answers);
    expect(Object.keys(summary.first.entries)).toHaveLength(summary.size);
    expect(summary.shown).toBeGreaterThan(0);
    expect(summary.shown).toBeLessThanOrEqual(summary.answers);
    if (loops === 100) {
      expect(summary.shown).toBe(summary.answers);
      expect(Object.keys(array.parse(summary.entries).entries)).toHaveLength(summary.size);
    }
    expect(summary.bytes).toBeLessThan(64 * 1024 * 1024);
    expect(summary.exception).toBeUndefined();
  }
  expect(result.growing).toHaveLength(2);
  for (const summary of result.growing) {
    const { loops } = summary;
    expect(summary.stdout).toBe(Array.from({ length: loops }, (_, i) => `${i + 1}\n`).join('') + `${loops}\n`);
    expect(summary.answers).toBeGreaterThanOrEqual(loops * 2);
    expect(summary.decodedAnswers).toBe(summary.answers);
    expect(summary.shown).toBeGreaterThan(0);
    if (loops === 30) {
      expect(summary.shown).toBeGreaterThanOrEqual(loops * 2);
      const entries = array.parse(summary.entries).entries;
      expect(Object.keys(entries)).toHaveLength(loops);
      expect(entries[String(loops - 1)]).toEqual({
        kind: 'array',
        entries: { '0': { kind: 'value', value: loops }, '1': { kind: 'value', value: loops * 2 } },
      });
    } else expect(summary.entries?.kind).not.toBe('array');
    expect(summary.bytes).toBeLessThan(64 * 1024 * 1024);
    expect(summary.exception).toBeUndefined();
  }
});

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
