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
