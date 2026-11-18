import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

const bundles = new Map<string, string>();

test('shared reference views serialize and render within a bounded heap', { timeout: 30_000 }, () => {
  const output = runHelper('test/helpers/haskellDisplayOutput.ts', 512);
  const results = z
    .array(
      z.object({
        name: z.string(),
        stdout: z.string(),
        names: z.array(z.string()),
        bytes: z.number(),
        leaves: z.number(),
        truncated: z.boolean(),
        renderedTruncation: z.boolean(),
        htmlLength: z.number(),
        cheap: z.unknown().optional(),
      })
    )
    .parse(output);
  expect(results.map((item) => item.name)).toEqual([
    'small',
    'binary',
    'ternary18',
    'ternary19',
    'forest',
    'tuple',
    'list',
    'map',
    'laterCheap',
  ]);
  for (const result of results) {
    expect(result.stdout).toBe('1\n2\n');
    expect(result.names).toContain('x');
    expect(result.bytes).toBeLessThan(16 * 1024 * 1024);
    expect(result.htmlLength).toBeGreaterThan(0);
    expect(result.truncated).toBe(result.name !== 'small');
    if (result.truncated) expect(result.renderedTruncation).toBe(true);
  }
  expect(results.find((item) => item.name === 'small')?.leaves).toBe(3 ** 8);
  const forest = results.find((item) => item.name === 'forest');
  expect(forest?.names).toHaveLength(21);
  for (const name of ['tuple', 'list', 'map']) {
    expect(results.find((item) => item.name === name)?.names).toContain('wrapped');
  }
  expect(results.find((item) => item.name === 'laterCheap')?.cheap).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 1 }, 1: { kind: 'value', value: 2 } },
  });
});

test(
  'shared scalar answer arrays keep complete recordings serializable within a bounded heap',
  { timeout: 30_000 },
  () => {
    const output = runHelper('test/helpers/haskellScalarOutput.ts', 256);
    const results = z
      .array(
        z.object({
          name: z.string(),
          bytes: z.number(),
          transportBytes: z.number(),
          hadFullArray: z.boolean(),
          strings: z.boolean(),
          stdout: z.string(),
          answers: z.array(z.string()),
          finalAnswers: z.array(z.string()),
          loops: z.number(),
          outer: z.number(),
          inner: z.number(),
        })
      )
      .parse(output);
    expect(results.map((item) => item.name)).toEqual([
      'small',
      'manySnapshots',
      'wideSnapshots',
      'strings',
      'escapedStrings',
      'million',
      'repeated',
      'aliases',
      'selfField',
    ]);
    for (const result of results) {
      expect(result.bytes).toBeLessThan(64 * 1024 * 1024);
      expect(result.transportBytes).toBeLessThan(64 * 1024 * 1024);
      expect(result.stdout).toBe(
        `${result.outer}\n${result.strings ? result.inner : (result.inner * (result.inner + 1)) / 2}\n${Array.from({ length: result.loops }, (_, i) => `${i + 1}\n`).join('')}`
      );
      expect(result.answers).toContain('cheap');
      expect(result.finalAnswers).toContain('cheap');
      if (result.name === 'aliases') {
        expect(result.hadFullArray).toBe(true);
        expect(result.answers).not.toContain('alias19');
      }
    }
  }
);

test('reference recordings and mandatory world snapshots stay bounded', { timeout: 30_000 }, () => {
  const output = runHelper('test/helpers/haskellRecordingOutput.ts', 256);
  const result = z.object({ bytes: z.number(), transportBytes: z.number(), stateLimited: z.boolean() }).parse(output);
  expect(result.bytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.transportBytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.stateLimited).toBe(true);
});

test.each([
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
])('transport graphs round-trip within a bounded heap: %s', { timeout: 30_000 }, (name) => {
  const result = z
    .object({ bytes: z.number(), loops: z.number() })
    .parse(runHelper('test/helpers/haskellTransportOutput.ts', 256, [name]));
  expect(result.bytes).toBeLessThan(32 * 1024 * 1024);
  expect(result.loops).toBe(name === 'control' || name === 'equalityControl' ? 5 : 1200);
});

function runHelper(path: string, heap: number, args: string[] = []): unknown {
  let bundle = bundles.get(path);
  if (bundle === undefined) {
    bundle = execFileSync('bun', ['build', path, '--target=node', '--packages=external'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    bundles.set(path, bundle);
  }
  return JSON.parse(
    execFileSync('node', [`--max-old-space-size=${heap}`, '--input-type=module', '-', ...args], {
      input: bundle,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
  );
}
