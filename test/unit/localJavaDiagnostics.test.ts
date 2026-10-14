import { readdir } from 'node:fs/promises';

import { expect, test, vi } from 'vitest';

import { diagnosticVerdictSchema } from '../helpers/compilerTransport';
import { localCompileOnlyExecutor } from '../helpers/localJavaCompiler';
import { compileJavaProgram } from '../../scripts/javaDiagnostics/localCompiler';
import { gradeFillInBlankCode } from '../../src/problems/fillInBlank/grade';
import { buildJavaJudgeProgram } from '../../src/problems/fillInBlank/javaProgram';
import { instantiateProblem } from '../../src/problems/instantiateProblem';

const problem = instantiateProblem('fillInBlank1', 'java', 'local-diagnostic-test');
if (!problem) throw new Error('Missing fillInBlank1 problem');

test('local compiler builds without executing learner code and cleans successful and failed compilation artifacts', async () => {
  const before = await readdir('.tmp/javaDiagnostics').catch(() => []);
  const source = 'class Main { public static void main(String[] args) { while (true) {} } }';
  const built = buildJavaJudgeProgram(source, '__TRACE_DOJO_RESULT_local__');
  const success = await compileJavaProgram(built.program);
  expect(success).toMatchObject({ kind: 'compiled', exitCode: 0 });
  const failed = await compileJavaProgram(
    buildJavaJudgeProgram(source.replace('while (true) {}', 'int 亀 = true;'), '__TRACE_DOJO_RESULT_local__').program
  );
  expect(failed).toMatchObject({ kind: 'compileError', exitCode: 1 });
  expect(failed.stderr).toContain('boolean cannot be converted to int');
  expect(await readdir('.tmp/javaDiagnostics')).toEqual(before);
  await expect(localCompileOnlyExecutor.execute(built.program, 'TraceDojoJudge')).rejects.toThrow('received compiled');
}, 60_000);

test('actual compiler feedback preserves Japanese learner names and CRLF locations with Japanese primary and safe original', async () => {
  const source = '\r\nclass Main {\r\n public static void main(String[] args) {\r\n  前に進む();\r\n }\r\n}\r\n';
  const result = await gradeFillInBlankCode(problem, source, { javaExecutors: [localCompileOnlyExecutor] });
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        line: 4,
        message: expect.stringMatching(/前に進む.*[ぁ-ん]/),
        originalMessage: 'cannot find symbol\nsymbol: method 前に進む()',
      }),
    ])
  );
  for (const diagnostic of verdict.diagnostics) expect(diagnostic.message).not.toMatch(/^(?:コンパイル|構文|cannot)/);
  expect(JSON.stringify(result)).not.toMatch(
    /TraceDojoJudge|\.java|__TRACE_DOJO_RESULT_|location:|symbol: method Main/
  );
}, 30_000);

test('actual wrapper compile failure explains the program entry without exposing generated locations or secondary internals', async () => {
  const result = await gradeFillInBlankCode(problem, 'class Main {}', { javaExecutors: [localCompileOnlyExecutor] });
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual([expect.objectContaining({ message: expect.stringMatching(/始|開始/) })]);
  for (const diagnostic of verdict.diagnostics) {
    expect(diagnostic.line).toBeUndefined();
    expect(diagnostic.originalMessage).toBeUndefined();
  }
  expect(JSON.stringify(result)).not.toMatch(/TraceDojoJudge|\.java|__TRACE_DOJO_RESULT_|cannot find symbol/);
}, 30_000);

test('compiler launch failure remains tooling failure and removes temporary input', async () => {
  const before = await readdir('.tmp/javaDiagnostics').catch(() => []);
  vi.stubEnv('PATH', '/nonexistent-trace-dojo-tools');
  try {
    const result = await compileJavaProgram('class Main {}');
    expect(result.kind).toBe('toolError');
    expect(result.failure).toMatch(/ENOENT/);
    await expect(localCompileOnlyExecutor.execute('class Main {}', 'TraceDojoJudge')).rejects.toThrow(
      'received toolError'
    );
  } finally {
    vi.unstubAllEnvs();
  }
  expect(await readdir('.tmp/javaDiagnostics')).toEqual(before);
});
