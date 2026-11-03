import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, vi } from 'vitest';

import { compileJavaProgram } from '../../scripts/javaDiagnostics/localCompiler';
import { gradeFillInBlankCode } from '../../src/problems/fillInBlank/grade';
import { buildJavaJudgeProgram } from '../../src/problems/fillInBlank/javaProgram';
import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { diagnosticVerdictSchema } from '../helpers/compilerTransport';
import { localCompileOnlyExecutor } from '../helpers/localJavaCompiler';

const problem = instantiateProblem('fillInBlank1', 'local-diagnostic-test');
if (!problem) throw new Error('Missing fillInBlank1 problem');

test('local compiler builds without executing learner code and cleans successful and failed compilation artifacts', async () => {
  await mkdir('.tmp', { recursive: true });
  const parent = await mkdtemp(resolve('.tmp/local-compiler-'));
  try {
    const source = 'class Main { public static void main(String[] args) { while (true) {} } }';
    const built = buildJavaJudgeProgram(source, '__TRACE_DOJO_RESULT_local__');
    const success = await compileJavaProgram(built.program, parent);
    expect(success).toMatchObject({ kind: 'compiled', exitCode: 0 });
    const failed = await compileJavaProgram(
      buildJavaJudgeProgram(source.replace('while (true) {}', 'int 亀 = true;'), '__TRACE_DOJO_RESULT_local__').program,
      parent
    );
    expect(failed).toMatchObject({ kind: 'compileError', exitCode: 1 });
    expect(failed.stderr).toContain('boolean cannot be converted to int');
    expect(await readdir(parent)).toEqual([]);
    await expect(localCompileOnlyExecutor.execute(built.program, 'TraceDojoJudge')).rejects.toThrow(
      'received compiled'
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

test('a public helper class compiles when another class holds the entry point', async () => {
  const source = `public class Main { static void run() { new Turtle().前に進む(); } }
public interface Shape {}
class Runner { public static void main(String[] args) { Main.run(); } }`;
  const result = await compileJavaProgram(buildJavaJudgeProgram(source, '__TRACE_DOJO_RESULT_local__').program);
  expect(result).toMatchObject({ kind: 'compiled', exitCode: 0 });
}, 60_000);

test('actual compiler feedback preserves Japanese learner names and CRLF locations with Japanese primary and safe original', async () => {
  const source = '\r\nclass Main {\r\n public static void main(String[] args) {\r\n  前に進む();\r\n }\r\n}\r\n';
  const result = await gradeFillInBlankCode(problem, source, {
    javaExecutors: [localCompileOnlyExecutor],
  });
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
  const result = await gradeFillInBlankCode(problem, 'class Main {}', {
    javaExecutors: [localCompileOnlyExecutor],
  });
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual([expect.objectContaining({ message: expect.stringMatching(/始|開始/) })]);
  for (const diagnostic of verdict.diagnostics) {
    expect(diagnostic.line).toBeUndefined();
    expect(diagnostic.originalMessage).toBeUndefined();
  }
  expect(JSON.stringify(result)).not.toMatch(/TraceDojoJudge|\.java|__TRACE_DOJO_RESULT_|cannot find symbol/);
}, 30_000);

test('compiler launch failure remains tooling failure and removes temporary input', async () => {
  await mkdir('.tmp', { recursive: true });
  const parent = await mkdtemp(resolve('.tmp/local-compiler-'));
  vi.stubEnv('PATH', '/nonexistent-trace-dojo-tools');
  try {
    const result = await compileJavaProgram('class Main {}', parent);
    expect(result.kind).toBe('toolError');
    expect(result.failure).toMatch(/ENOENT/);
    expect(await readdir(parent)).toEqual([]);
    await expect(localCompileOnlyExecutor.execute('class Main {}', 'TraceDojoJudge')).rejects.toThrow(
      'received toolError'
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(parent, { recursive: true, force: true });
  }
});
