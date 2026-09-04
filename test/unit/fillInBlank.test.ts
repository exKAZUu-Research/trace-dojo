import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { gradeFillInBlankAnswers } from '../../src/problems/fillInBlank/grade';
import { createLocalJvmExecutor, createWandboxExecutor } from '../../src/problems/fillInBlank/javaExecutors';
import type { InstantiatedProblem } from '../../src/problems/instantiateProblem';
import { instantiateProblem, isFillInBlankProblem } from '../../src/problems/instantiateProblem';
import type { ProblemId } from '../../src/problems/problemData';

const localJvm = createLocalJvmExecutor();
const withoutJava = { javaExecutors: [] };
const withLocalJvm = { javaExecutors: [localJvm] };

function instantiate(problemId: ProblemId, seed = '1'): InstantiatedProblem {
  const problem = instantiateProblem(problemId, 'java', seed);
  if (!problem) throw new Error(`Failed to instantiate ${problemId}`);
  return problem;
}

describe('problem instantiation', () => {
  test('detects fill-in-the-blank problems', () => {
    expect(isFillInBlankProblem('fillInBlank1')).toBe(true);
    expect(isFillInBlankProblem('straight')).toBe(false);
  });

  test('replaces blanks with placeholders and keeps model answers', () => {
    const problem = instantiate('fillInBlank4');
    expect(problem.displayProgram).toContain('i < 【1】');
    expect(problem.displayProgram).toContain('【2】');
    expect(problem.displayProgram).not.toContain('@[');
    expect(problem.blankAnswers).toEqual(['3', 't.右を向く();']);
  });

  test('instantiates random numbers inside and around blanks consistently', () => {
    const problem = instantiate('fillInBlank2', 'seed');
    const [, x] = /int x = (\d);/.exec(problem.displayProgram) ?? [];
    expect(x).toMatch(/^[1-4]$/);
    expect(problem.finalTurtles).toEqual([{ x: Number(x), y: Number(x) + 2, color: '#', dir: 'N' }]);
  });
});

describe('stage 1: exact match', () => {
  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 4'] },
    { problemId: 'fillInBlank1', answers: ['i<4'] },
    { problemId: 'fillInBlank1', answers: ['  i   <   4  '] },
    { problemId: 'fillInBlank2', answers: ['x + 1'] },
    { problemId: 'fillInBlank2', answers: ['x+1'] },
    { problemId: 'fillInBlank3', answers: ['t.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['t . 右を向く ( ) ;'] },
    { problemId: 'fillInBlank4', answers: ['3', 't.右を向く();'] },
    { problemId: 'fillInBlank4', answers: [' 3 ', 't.右を向く( );'] },
  ] as const)('accepts $answers for $problemId', async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withoutJava)).toEqual({
      status: 'correct',
      stage: 1,
    });
  });

  test('rejects a wrong number of answers', async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank4'), ['3'], withoutJava);
    expect(result).toMatchObject({ status: 'incorrect', stage: 1 });
  });
});

describe('stage 2: re-execution with the instrumented program', () => {
  test.each([
    { problemId: 'fillInBlank1', answers: ['i <= 3'] },
    { problemId: 'fillInBlank1', answers: ['i != 4'] },
    { problemId: 'fillInBlank1', answers: ['i < 2 + 2'] },
    { problemId: 'fillInBlank1', answers: ['i < 2 * 2'] },
    { problemId: 'fillInBlank1', answers: ['4 > i'] },
    { problemId: 'fillInBlank1', answers: ['!(i >= 4)'] },
    { problemId: 'fillInBlank1', answers: ['i < 4 && true'] },
    { problemId: 'fillInBlank1', answers: ['t.前に進めるか() && i < 4'] },
    { problemId: 'fillInBlank2', answers: ['1 + x'] },
    { problemId: 'fillInBlank2', answers: ['x + 2 - 1'] },
    { problemId: 'fillInBlank2', answers: ['x - -1'] },
    { problemId: 'fillInBlank3', answers: ['t.左を向く(); t.左を向く(); t.左を向く();'] },
    { problemId: 'fillInBlank3', answers: ['t.turnRight();'] },
    { problemId: 'fillInBlank4', answers: ['1 + 2', 't.turnRight();'] },
    { problemId: 'fillInBlank4', answers: ['3', 't.左を向く(); t.左を向く(); t.左を向く();'] },
  ] as const)('accepts $answers for $problemId', async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withoutJava)).toEqual({
      status: 'correct',
      stage: 2,
    });
  });

  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 5'] },
    { problemId: 'fillInBlank1', answers: ['i < 3'] },
    { problemId: 'fillInBlank1', answers: ['true'] },
    { problemId: 'fillInBlank2', answers: ['x'] },
    { problemId: 'fillInBlank2', answers: ['x + 2'] },
    { problemId: 'fillInBlank3', answers: ['t.左を向く();'] },
    { problemId: 'fillInBlank3', answers: ['t.前に進む();'] },
    { problemId: 'fillInBlank4', answers: ['2', 't.右を向く();'] },
    { problemId: 'fillInBlank4', answers: ['3', 't.左を向く();'] },
  ] as const)('rejects $answers for $problemId', async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withoutJava)).toMatchObject({
      status: 'incorrect',
      stage: 2,
    });
  });

  test.each(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])('works with random seed %s', async (seed) => {
    expect(await gradeFillInBlankAnswers(instantiate('fillInBlank2', seed), ['1 + x'], withoutJava)).toEqual({
      status: 'correct',
      stage: 2,
    });
  });
});

describe('stage 2: Java semantics and safety', () => {
  test.each([
    { problemId: 'fillInBlank2', answers: ['x + 2147483647 + 2147483647 + 3'] },
    { problemId: 'fillInBlank2', answers: ["x + ('a' - 96)"] },
    { problemId: 'fillInBlank2', answers: ['x - 2147483647 * 2 - 1'] },
  ] as const)('accepts $answers for $problemId with int semantics', async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withoutJava)).toEqual({
      status: 'correct',
      stage: 2,
    });
  });

  test.each([
    { problemId: 'fillInBlank3', answers: ['Turtle u = t; u.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['var u = t; u.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['new Turtle(2, 1).右を向く(); t.remove(); t.remove(); t.右を向く();'] },
    { problemId: 'fillInBlank1', answers: ['i < Math.abs(-4)'] },
    { problemId: 'fillInBlank1', answers: ['i % 5 < 4'] },
  ] as const)('accepts $answers for $problemId with Java scoping', async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withoutJava)).toEqual({
      status: 'correct',
      stage: 2,
    });
  });

  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 0x4'] },
    { problemId: 'fillInBlank1', answers: ['Math.abs(-2147483648) < 0 && i < 4'] },
    { problemId: 'fillInBlank1', answers: ['i < 4 && t != null'] },
    { problemId: 'fillInBlank1', answers: ['i < 4 + args.length'] },
    { problemId: 'fillInBlank3', answers: ['t = t; t.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['String s = "Thread"; t.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['/* Runtime */ t.右を向く(); // Thread'] },
    { problemId: 'fillInBlank1', answers: ['i < 4L'] },
    { problemId: 'fillInBlank3', answers: ['t.hashCode(); t.右を向く();'] },
  ] as const)('leaves $answers for $problemId to Java', { timeout: 60_000 }, async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withLocalJvm)).toEqual({
      status: 'correct',
      stage: 4,
    });
  });

  test.each([
    't["constructor"]["constructor"]("globalThis.__traceDojoPwned = true")(); t.右を向く();',
    't.constructor.constructor("globalThis.__traceDojoPwned = true")(); t.右を向く();',
  ])('never evaluates %s as JavaScript', { timeout: 60_000 }, async (answer) => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withLocalJvm);
    expect((globalThis as { __traceDojoPwned?: boolean }).__traceDojoPwned).toBeUndefined();
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });

  test('leaves unknown members to Java instead of JavaScript', { timeout: 60_000 }, async () => {
    expect(
      await gradeFillInBlankAnswers(instantiate('fillInBlank3'), ['t.toString(); t.右を向く();'], withLocalJvm)
    ).toEqual({ status: 'correct', stage: 4 });
  });

  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 4 > false'], detail: 'Compile error' },
    { problemId: 'fillInBlank2', answers: ['x + 4294967297'], detail: 'Compile error' },
    { problemId: 'fillInBlank3', answers: ['t.右を向く(1);'], detail: 'Compile error' },
    { problemId: 'fillInBlank2', answers: ['x + (1 % 0) + x + 1'], detail: 'exception' },
    { problemId: 'fillInBlank1', answers: ['i - 4'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['4 - i'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['i < 4 && 1'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['!0 && i < 4'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['t.右を向く() == t.右を向く()'], detail: 'Compile error' },
    { problemId: 'fillInBlank2', answers: ['x + true'], detail: 'Compile error' },
    { problemId: 'fillInBlank2', answers: ['x + t.前に進めるか()'], detail: 'Compile error' },
    { problemId: 'fillInBlank3', answers: ['t.右を向く()'], detail: 'Compile error' },
    { problemId: 'fillInBlank3', answers: ['1; t.右を向く();'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['i == true || i < 4'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['i < 4 || (false && missing)'], detail: 'Compile error' },
    { problemId: 'fillInBlank4', answers: ['3', 'int i = i; t.右を向く();'], detail: 'Compile error' },
    { problemId: 'fillInBlank2', answers: ['y'], detail: 'Compile error' },
  ] as const)(
    'does not accept $answers for $problemId that Java rejects',
    { timeout: 60_000 },
    async ({ answers, detail, problemId }) => {
      const result = await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withLocalJvm);
      expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
      expect(result.status === 'incorrect' && result.detail).toContain(detail);
    }
  );

  test('confirms a provisional stage 2 verdict with Java', { timeout: 60_000 }, async () => {
    expect(await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i <= 3'], withLocalJvm)).toEqual({
      status: 'correct',
      stage: 4,
    });
  });

  test('bounds the cost of growing the turtle list inside a loop', { timeout: 60_000 }, async () => {
    const startedAt = Date.now();
    const answers = ['1000000', `${'new Turtle(0, 0); '.repeat(50)}t.後に戻る();`];
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank4'), answers, withLocalJvm);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result).toMatchObject({ status: 'incorrect' });
  });

  test('aborts unbounded loops instead of hanging', { timeout: 60_000 }, async () => {
    const startedAt = Date.now();
    const result = await gradeFillInBlankAnswers(
      instantiate('fillInBlank4'),
      ['1000000', 't.後に戻る();'],
      withLocalJvm
    );
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });
});

describe('stage 3: Wandbox', () => {
  test('accepts an untranslatable but correct answer', { timeout: 60_000 }, async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createWandboxExecutor()],
    });
    expect(result).toEqual({ status: 'correct', stage: 3 });
  });

  test('falls back to the local JVM when Wandbox is unavailable', { timeout: 60_000 }, async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createWandboxExecutor({ compileUrl: 'http://127.0.0.1:9/api/compile.json' }), localJvm],
    });
    expect(result).toEqual({ status: 'correct', stage: 4 });
  });
});

describe('stage 4: local JVM', () => {
  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 8 / 2'] },
    { problemId: 'fillInBlank1', answers: ['i < Integer.parseInt("4")'] },
    { problemId: 'fillInBlank1', answers: ['i < (i < 2 ? 4 : 4)'] },
    { problemId: 'fillInBlank1', answers: ['i < Math.floorDiv(8, 2)'] },
    { problemId: 'fillInBlank2', answers: ['x + 4 / 4'] },
    { problemId: 'fillInBlank2', answers: ['(int) (x + 1.0)'] },
    { problemId: 'fillInBlank3', answers: ['if (true) { t.右を向く(); }'] },
    { problemId: 'fillInBlank3', answers: ['for (int i = 0; i < 5; i++) { t.右を向く(); }'] },
    { problemId: 'fillInBlank4', answers: ['9 / 3', 't.右を向く();'] },
  ] as const)('accepts $answers for $problemId', { timeout: 60_000 }, async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withLocalJvm)).toEqual({
      status: 'correct',
      stage: 4,
    });
  });

  test.each([
    { problemId: 'fillInBlank1', answers: ['i < 10 / 2'], detail: 'final state differs' },
    { problemId: 'fillInBlank1', answers: ['i < 20 / 2'], detail: 'exception' },
    { problemId: 'fillInBlank1', answers: ['i < 8 / 2 +'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['i < 4 &&'], detail: 'Compile error' },
    { problemId: 'fillInBlank1', answers: ['i < 8 / 2; while (true) {}'], detail: 'Compile error' },
    {
      problemId: 'fillInBlank3',
      answers: ['while (t.前に進めるか() || true) { t.右を向く(); }'],
      detail: 'Time limit',
    },
    { problemId: 'fillInBlank3', answers: ['Runtime.getRuntime().exec("ls");'], detail: 'forbidden' },
    { problemId: 'fillInBlank3', answers: ['System.exit(0);'], detail: 'forbidden' },
    { problemId: 'fillInBlank3', answers: ['new Thread(() -> {}).start();'], detail: 'forbidden' },
    { problemId: 'fillInBlank3', answers: ['java.nio.file.Files.readString(null);'], detail: 'forbidden' },
    { problemId: 'fillInBlank3', answers: ['if (true) { t.左を向く(); }'], detail: 'exception' },
    { problemId: 'fillInBlank4', answers: ['4 / 2', 't.右を向く();'], detail: 'final state differs' },
  ] as const)('rejects $answers for $problemId', { timeout: 60_000 }, async ({ answers, detail, problemId }) => {
    const result = await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect' });
    expect(result.status === 'incorrect' && result.detail).toContain(detail);
  });

  test('confines programs that evade the static pre-filter', { timeout: 60_000 }, async () => {
    const markerPath = path.join(tmpdir(), `trace-dojo-escape-${Date.now()}`);
    const answer = `
      try {
        var c = Main.class.getClassLoader().loadClass("ja" + "va.lang.Runt" + "ime");
        Object rt = c.getMethod("getRuntime").invoke(null);
        c.getMethod("exec", String.class).invoke(rt, "/usr/bin/touch ${markerPath}");
      } catch (Exception e) {}
      try {
        Object f = t.getClass().forName("jav" + "a.io.Fi" + "le").getConstructor(String.class).newInstance("${markerPath}");
        f.getClass().getMethod("createN" + "ewFile").invoke(f);
      } catch (Exception e) {}
      t.右を向く();`;
    // The escape attempts are swallowed by the program, so the drawing itself is right; only the side effects must be blocked.
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withLocalJvm);
    expect(existsSync(markerPath)).toBe(false);
    expect(result).toEqual({ status: 'correct', stage: 4 });
  });

  test('rejects Unicode escapes that could hide forbidden names', async () => {
    const answer = String.raw`jav\u0061.lang.Runtime.getRuntime().exec("ls"); t.右を向く();`;
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect', stage: 0 });
    expect(result.status === 'incorrect' && result.detail).toContain('forbidden');
  });

  test.each([
    "Turtle.board[0][0] = '#'; t.右を向く();",
    't.x = 3; t.右を向く();',
    String.raw`t.color = "\""; t.右を向く();`,
  ])('does not let %s tamper with the judged state', { timeout: 60_000 }, async (answer) => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
    expect(result.status === 'incorrect' && result.detail).toContain('Compile error');
  });

  test('ignores a fake result printed before closing stdout', { timeout: 60_000 }, async () => {
    const problem = instantiate('fillInBlank3');
    const fakeResult = JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles });
    const answer = `
      System.out.println("__TRACE_DOJO_RESULT__");
      System.out.println(${JSON.stringify(fakeResult)});
      System.out.close();
      t.左を向く();`;
    const result = await gradeFillInBlankAnswers(problem, [answer], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });

  test('ignores a fake result printed by a thread that outlives the program', { timeout: 60_000 }, async () => {
    const problem = instantiate('fillInBlank3');
    const fakeResult = JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles });
    const answer = `
      Runnable r = () -> {
        for (long i = 0; i < 400000000L; i++) {}
        System.out.println();
        System.out.println("__TRACE_DOJO_RESULT__");
        System.out.println(${JSON.stringify(fakeResult)});
      };
      try {
        var c = t.getClass().forName("jav" + "a.lang.Thr" + "ead");
        c.getMethod("start").invoke(c.getConstructor(Runnable.class).newInstance(r));
      } catch (Exception e) {}
      t.左を向く();`;
    const result = await gradeFillInBlankAnswers(problem, [answer], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });

  test('reports busy instead of queueing without bound', { timeout: 120_000 }, async () => {
    const executor = createLocalJvmExecutor({ maxPendingExecutions: 1 });
    const problem = instantiate('fillInBlank1');
    const results = await Promise.all(
      ['i < 8 / 2', 'i < 8 / 2', 'i < 8 / 2'].map((answer) =>
        gradeFillInBlankAnswers(problem, [answer], { javaExecutors: [executor] })
      )
    );
    expect(results.map((r) => r.status)).toEqual(['correct', 'ungradable', 'ungradable']);
  });

  test('rejects programs that flood stdout without misreporting the drawing', { timeout: 60_000 }, async () => {
    const answer =
      'for (int i = 0; i < 60000; i++) System.out.println("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); t.右を向く();';
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withLocalJvm);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
    expect(result.status === 'incorrect' && result.detail).toContain('too much output');
  });

  test('reports a broken toolchain as unavailable rather than a compile error', { timeout: 60_000 }, async () => {
    const javaHome = mkdtempSync(path.join(tmpdir(), 'trace-dojo-broken-jdk-'));
    mkdirSync(path.join(javaHome, 'bin'));
    writeFileSync(
      path.join(javaHome, 'bin', 'javac'),
      '#!/bin/sh\necho "Unable to locate a Java Runtime." >&2\nexit 1\n',
      {
        mode: 0o755,
      }
    );
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createLocalJvmExecutor({ javaHome })],
    });
    expect(result).toMatchObject({ status: 'ungradable' });
  });

  test('reports ungradable when no executor is available', async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createLocalJvmExecutor({ javaHome: '/nonexistent' })],
    });
    expect(result).toMatchObject({ status: 'ungradable' });
  });

  test('handles concurrent submissions', { timeout: 120_000 }, async () => {
    const problem = instantiate('fillInBlank1');
    const results = await Promise.all(
      ['i < 8 / 2', 'i < 10 / 2', 'i < 8 / 2'].map((answer) => gradeFillInBlankAnswers(problem, [answer], withLocalJvm))
    );
    expect(results.map((r) => r.status)).toEqual(['correct', 'incorrect', 'correct']);
  });
});
