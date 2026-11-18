import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

test('shared reference views serialize and render within a bounded heap', { timeout: 30_000 }, () => {
  const bundle = execFileSync(
    'bun',
    ['build', 'test/helpers/haskellDisplayOutput.ts', '--target=node', '--packages=external'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const output = execFileSync('node', ['--max-old-space-size=512', '--input-type=module'], {
    input: bundle,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
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
    .parse(JSON.parse(output));
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
    const bundle = execFileSync(
      'bun',
      ['build', 'test/helpers/haskellScalarOutput.ts', '--target=node', '--packages=external'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
    );
    const output = execFileSync('node', ['--max-old-space-size=256', '--input-type=module'], {
      input: bundle,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
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
      .parse(JSON.parse(output));
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
  const bundle = execFileSync(
    'bun',
    ['build', 'test/helpers/haskellRecordingOutput.ts', '--target=node', '--packages=external'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const output = execFileSync('node', ['--max-old-space-size=256', '--input-type=module'], {
    input: bundle,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const result = z
    .object({ bytes: z.number(), transportBytes: z.number(), stateLimited: z.boolean() })
    .parse(JSON.parse(output));
  expect(result.bytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.transportBytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.stateLimited).toBe(true);
});
