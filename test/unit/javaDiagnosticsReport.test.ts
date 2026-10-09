import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';
import { z } from 'zod';

const reportSchema = z.object({
  compiler: z.object({ version: z.string().optional(), failure: z.string().optional() }),
  counts: z.object({
    selected: z.number(),
    attempted: z.number(),
    completed: z.number(),
    expectedFailures: z.number(),
    toolFailures: z.number(),
  }),
  results: z.array(
    z.object({
      id: z.string(),
      outcome: z.string(),
      observations: z.array(
        z.object({ diagnostic: z.object({ message: z.string(), originalMessage: z.string().optional() }) })
      ),
    })
  ),
});

test('report CLI selects samples deterministically, rejects invalid IDs, and reports compiler launch failure', async () => {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/javaDiagnosticReportTest-'));
  const command = resolve('scripts/collectJavaDiagnostics.ts');
  const bun = spawnSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' });
  expect(bun.status).toBe(0);
  const run = (ids: string[], env = process.env): SpawnSyncReturns<string> =>
    spawnSync(bun.stdout.trim(), [command, ...ids], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
  const readReport = async (): Promise<z.infer<typeof reportSchema>> =>
    reportSchema.parse(JSON.parse(await readFile(`${directory}/.tmp/javaDiagnostics/report.json`, 'utf8')));
  try {
    const selected = run(['method', 'valid']);
    expect(selected.status, selected.stderr).toBe(0);
    const report = await readReport();
    expect(report.compiler.version).toMatch(/^javac /);
    expect(report.counts).toMatchObject({
      selected: 2,
      attempted: 2,
      completed: 2,
      expectedFailures: 1,
      toolFailures: 0,
    });
    expect(report.results.map((result) => result.id)).toEqual(['valid', 'method']);
    expect(report.results.map((result) => result.outcome)).toEqual(['valid', 'expectedCompileError']);
    expect(report.results[1].observations[0].diagnostic.message).toMatch(/[ぁ-ん]/);
    expect(report.results[1].observations[0].diagnostic.originalMessage).toContain('前に進む');
    for (const ids of [['unknown-sample'], [''], ['valid', 'valid']]) {
      const invalid = run(ids);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain('known sample IDs');
    }
    const failure = run(['valid'], { ...process.env, PATH: '/nonexistent-trace-dojo-tools' });
    expect(failure.status).toBe(1);
    const failedReport = await readReport();
    expect(failedReport.compiler.failure).toBeTruthy();
    expect(failedReport.counts).toMatchObject({ selected: 1, attempted: 0, completed: 0, toolFailures: 1 });
    expect(failedReport.results).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
