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

test.each([
  'small',
  'manySnapshots',
  'wideSnapshots',
  'strings',
  'escapedStrings',
  'million',
  'repeated',
  'aliases',
  'selfField',
])('shared scalar answer arrays round-trip within a bounded heap: %s', { timeout: 30_000 }, (name) => {
  const [result] = z
    .tuple([
      z.object({
        transportBytes: z.number(),
        hadFullArray: z.boolean(),
        strings: z.boolean(),
        stdout: z.string(),
        answers: z.array(z.string()),
        finalAnswers: z.array(z.string()),
        loops: z.number(),
        outer: z.number(),
        inner: z.number(),
      }),
    ])
    .parse(runHelper('test/helpers/haskellScalarOutput.ts', 256, [name]));
  expect(result.transportBytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.stdout).toBe(
    `${result.outer}\n${result.strings ? result.inner : (result.inner * (result.inner + 1)) / 2}\n${Array.from({ length: result.loops }, (_, i) => `${i + 1}\n`).join('')}`
  );
  expect(result.answers).toContain('cheap');
  expect(result.finalAnswers).toContain('cheap');
  if (name === 'aliases') {
    expect(result.hadFullArray).toBe(true);
    expect(result.answers).not.toContain('alias19');
  }
});

test('shared text stays bounded when a snapshot is expanded', { timeout: 30_000 }, () => {
  const [result] = z
    .tuple([
      z.object({
        transportBytes: z.number(),
        stdout: z.string(),
        answers: z.array(z.string()),
        finalAnswers: z.array(z.string()),
      }),
    ])
    .parse(runHelper('test/helpers/haskellScalarOutput.ts', 256, ['sharedText']));
  expect(result.transportBytes).toBeLessThan(32 * 1024 * 1024);
  expect(result.stdout).toBe('1000\n4\n1\n2\n3\n4\n5\n');
  expect(result.answers).toContain('cheap');
  expect(result.finalAnswers).toContain('cheap');
});

test('reference recordings and mandatory world snapshots stay bounded', { timeout: 30_000 }, () => {
  const output = runHelper('test/helpers/haskellRecordingOutput.ts', 256);
  const result = z.object({ transportBytes: z.number(), stateLimited: z.boolean() }).parse(output);
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
  'protectedName',
])('transport graphs round-trip within a bounded heap: %s', { timeout: 30_000 }, (name) => {
  const result = z
    .object({ bytes: z.number(), loops: z.number() })
    .parse(runHelper('test/helpers/haskellTransportOutput.ts', 256, [name]));
  expect(result.bytes).toBeLessThan(32 * 1024 * 1024);
  expect(result.loops).toBe(name === 'control' || name === 'equalityControl' ? 5 : 1200);
});

test('legal learner names round-trip through a fresh configured client', { timeout: 30_000 }, () => {
  const encoded = runHelper('test/helpers/haskellReservedNamesEncode.ts', 256);
  const decoded = runHelper('test/helpers/haskellReservedNamesDecode.ts', 256, [JSON.stringify(encoded)]);
  expect(decoded).toHaveLength(8);
});

test.each(['records', 'reverseOrder', 'turtles', 'longNames', 'wideRecords', 'snapshot'])(
  'visible reference roots remain represented in long traces: %s',
  { timeout: 30_000 },
  (name) => {
    const result = z
      .object({ bytes: z.number(), items: z.number() })
      .parse(runHelper('test/helpers/haskellRetainedOutput.ts', 256, [name]));
    expect(result.bytes).toBeLessThan(32 * 1024 * 1024);
    expect(result.items).toBeGreaterThan(name === 'snapshot' ? 0 : 2000);
  }
);

test.each(['fourTurtles', 'fiveTurtles', 'sevenLists', 'sixteenLists', 'records', 'tuples', 'growing'])(
  'optional output leaves capacity for complete traces and small roots: %s',
  { timeout: 30_000 },
  (name) => {
    const result = z
      .object({ bytes: z.number(), items: z.number(), loops: z.number() })
      .parse(runHelper('test/helpers/haskellOutputAdmission.ts', 256, [name]));
    expect(result.bytes).toBeLessThan(32 * 1024 * 1024);
    expect(result.items).toBeGreaterThan(result.loops * 2);
  }
);

test('trace stops when visible-name metadata exceeds export capacity', { timeout: 30_000 }, () => {
  const result = z.object({ limited: z.boolean() }).parse(runHelper('test/helpers/haskellMinimumOutput.ts', 256));
  expect(result.limited).toBe(true);
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
