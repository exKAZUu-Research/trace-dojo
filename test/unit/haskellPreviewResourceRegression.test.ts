import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { buildNodeBundle } from '../helpers/buildNodeBundle';

test('repeated ready lists stay bounded on both sides of the display element limit', { timeout: 30_000 }, () => {
  const bundle = buildNodeBundle('test/helpers/haskellReadyListTrace.ts');
  const output = execFileSync('node', ['--max-old-space-size=256', '--input-type=module'], {
    input: bundle,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const summaries = z
    .array(
      z.object({
        length: z.number(),
        shape: z.enum(['integers', 'pairs']),
        stdout: z.string(),
        steps: z.number(),
        answers: z.number(),
        bytes: z.number(),
        decodedAnswers: z.number(),
        first: z.string().optional(),
        last: z.string().optional(),
        exception: z.unknown().optional(),
      })
    )
    .parse(JSON.parse(output));
  expect(summaries).toHaveLength(4);
  for (const summary of summaries) {
    const { length, shape } = summary;
    const isPairs = shape === 'pairs';
    const sum = isPairs ? length * (length + 2) : (3 * length * (length + 1)) / 2 + 3 * length;
    const expected =
      [sum, ...Array.from({ length: 3000 }, (_, index) => (index + 1) * 2), length * (isPairs ? 1 : 3)].join('\n') +
      '\n';
    expect(summary.stdout).toBe(expected);
    expect(summary.exception).toBeUndefined();
    expect(summary.answers).toBe(6000);
    expect(summary.steps).toBe(isPairs ? 6004 : 6006);
    expect(summary.first).toBe(length <= 1000 ? 'array' : undefined);
    if (length > 1000) expect(summary.last).not.toBe('array');
    expect(summary.decodedAnswers).toBe(summary.answers);
    expect(summary.bytes).toBeLessThan(32 * 1024 * 1024);
  }
});
