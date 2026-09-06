import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, test } from 'vitest';

import { gradeFillInBlankAnswers } from '../../src/problems/fillInBlank/grade';
import { fillBlanks } from '../../src/problems/fillInBlank/blanks';
import { createJudgeExecutor, createWandboxExecutor } from '../../src/problems/fillInBlank/javaExecutors';
import {
  buildJavaJudgeProgram,
  JAVA_JUDGE_CLASS_NAME,
  parseJavaJudgeOutput,
} from '../../src/problems/fillInBlank/javaProgram';
import type { InstantiatedProblem } from '../../src/problems/instantiateProblem';
import { instantiateProblem, isFillInBlankProblem } from '../../src/problems/instantiateProblem';
import type { ProblemId } from '../../src/problems/problemData';

const judge = createJudgeExecutor();
const withoutJava = { javaExecutors: [] };
const withJudge = { javaExecutors: [judge] };

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
    { problemId: 'fillInBlank3', answers: ['int b = 1; t.右を向く();'] },
    { problemId: 'fillInBlank3', answers: ['boolean b = t.前に進めるか(); t.右を向く();'] },
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
    { problemId: 'fillInBlank3', answers: ['var u = (t); u.右を向く();'] },
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
  ] as const)('leaves $answers for $problemId to Java', { timeout: 120_000 }, async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withJudge)).toEqual({
      status: 'correct',
      stage: 4,
    });
  });

  test.each([
    't["constructor"]["constructor"]("globalThis.__traceDojoPwned = true")(); t.右を向く();',
    't.constructor.constructor("globalThis.__traceDojoPwned = true")(); t.右を向く();',
  ])('never evaluates %s as JavaScript', { timeout: 120_000 }, async (answer) => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withJudge);
    expect((globalThis as { __traceDojoPwned?: boolean }).__traceDojoPwned).toBeUndefined();
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });

  test('leaves unknown members to Java instead of JavaScript', { timeout: 120_000 }, async () => {
    expect(
      await gradeFillInBlankAnswers(instantiate('fillInBlank3'), ['t.toString(); t.右を向く();'], withJudge)
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
    { timeout: 120_000 },
    async ({ answers, detail, problemId }) => {
      const result = await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withJudge);
      expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
      expect(result.status === 'incorrect' && result.detail).toContain(detail);
    }
  );

  test('confirms a provisional stage 2 verdict with Java', { timeout: 120_000 }, async () => {
    expect(await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i <= 3'], withJudge)).toEqual({
      status: 'correct',
      stage: 4,
    });
  });

  test('bounds the cost of growing the turtle list inside a loop', { timeout: 120_000 }, async () => {
    const startedAt = Date.now();
    const answers = ['1000000', `${'new Turtle(0, 0); '.repeat(50)}t.後に戻る();`];
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank4'), answers, withJudge);
    expect(Date.now() - startedAt).toBeLessThan(50_000);
    expect(result).toMatchObject({ status: 'incorrect' });
  });

  test('aborts unbounded loops instead of hanging', { timeout: 120_000 }, async () => {
    const startedAt = Date.now();
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank4'), ['1000000', 't.後に戻る();'], withJudge);
    expect(Date.now() - startedAt).toBeLessThan(50_000);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });
});

describe('stage 3: Wandbox', () => {
  test('accepts an untranslatable but correct answer', { timeout: 120_000 }, async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2']);
    // Wandbox is outside this project's control, so an outage moves the answer to the judge instead of failing.
    expect(result).toMatchObject({ status: 'correct' });
    if (result.status !== 'correct') return;
    expect([3, 4]).toContain(result.stage);
  });

  test('falls back to the judge when the Wandbox run does not start', { timeout: 120_000 }, async () => {
    // Wandbox reports a JVM that could not start with status "1", no compiler error and no program output.
    const server = createServer((_, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          status: '1',
          signal: '',
          compiler_error: '',
          program_output: '',
          program_error: 'Error: Could not find or load main class TraceDojoJudge',
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
        javaExecutors: [createWandboxExecutor({ compileUrl: `http://127.0.0.1:${port}/api/compile.json` }), judge],
      });
      expect(result).toEqual({ status: 'correct', stage: 4 });
    } finally {
      server.close();
    }
  });

  test('falls back to the judge when Wandbox is unavailable', { timeout: 120_000 }, async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createWandboxExecutor({ compileUrl: 'http://127.0.0.1:9/api/compile.json' }), judge],
    });
    expect(result).toEqual({ status: 'correct', stage: 4 });
  });
});

describe('stage 4: judge service', () => {
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
  ] as const)('accepts $answers for $problemId', { timeout: 120_000 }, async ({ answers, problemId }) => {
    expect(await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withJudge)).toEqual({
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
  ] as const)('rejects $answers for $problemId', { timeout: 120_000 }, async ({ answers, detail, problemId }) => {
    const result = await gradeFillInBlankAnswers(instantiate(problemId), [...answers], withJudge);
    expect(result).toMatchObject({ status: 'incorrect' });
    expect(result.status === 'incorrect' && result.detail).toContain(detail);
  });

  test.each([
    'var c = Main.class.getClassLoader().loadClass("ja" + "va.lang.Runt" + "ime"); t.右を向く();',
    'Object o = t.getClass().getMethod("toString").invoke(t); t.右を向く();',
    `var f = t.getClass().getDeclaredField("bo" + "ard"); f.setAccessible(true); t.右を向く();`,
  ])('rejects %s, which reflection could use to forge the result', async (answer) => {
    // The judge runs on a JDK without a security manager, so reflection into the judged state is stopped here.
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withJudge);
    expect(result).toMatchObject({ status: 'incorrect', stage: 0 });
    expect(result.status === 'incorrect' && result.detail).toContain('forbidden');
  });

  test('rejects Unicode escapes that could hide forbidden names', async () => {
    const answer = String.raw`jav\u0061.lang.Runtime.getRuntime().exec("ls"); t.turnRight();`;
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withJudge);
    expect(result).toMatchObject({ status: 'incorrect', stage: 0 });
    expect(result.status === 'incorrect' && result.detail).toContain('forbidden');
  });

  test.each([
    "Turtle.board[0][0] = '#'; t.右を向く();",
    't.x = 3; t.右を向く();',
    String.raw`t.color = "\""; t.turnRight();`,
  ])('does not let %s tamper with the judged state', { timeout: 120_000 }, async (answer) => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withJudge);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
    expect(result.status === 'incorrect' && result.detail).toContain('Compile error');
  });

  test('ignores a fake result printed before closing stdout', { timeout: 120_000 }, async () => {
    const problem = instantiate('fillInBlank3');
    const fakeResult = JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles });
    const answer = `
      System.out.println("__TRACE_DOJO_RESULT__");
      System.out.println(${JSON.stringify(fakeResult)});
      System.out.close();
      t.左を向く();`;
    const result = await gradeFillInBlankAnswers(problem, [answer], withJudge);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
  });

  test('ignores a fake result printed by a thread that outlives the program', { timeout: 120_000 }, async () => {
    const problem = instantiate('fillInBlank3');
    const marker = '__TEST_MARKER__';
    const fakeResult = JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles });
    const answer = `
      Runnable r = () -> {
        for (long i = 0; i < 400000000L; i++) {}
        System.out.println();
        System.out.println("${marker}");
        System.out.println(${JSON.stringify(fakeResult)});
      };
      try {
        var c = t.getClass().forName("jav" + "a.lang.Thr" + "ead");
        c.getMethod("start").invoke(c.getConstructor(Runnable.class).newInstance(r));
      } catch (Exception e) {}
      t.左を向く();`;
    const program = buildJavaJudgeProgram(fillBlanks(problem.displayProgramTemplate, [answer]), marker);
    const execution = await judge.execute(program, JAVA_JUDGE_CLASS_NAME);
    expect(execution.kind).toBe('executed');
    const actual = execution.kind === 'executed' ? parseJavaJudgeOutput(execution.stdout, marker) : undefined;
    // The genuine result reflects the wrong turn (the turtle then walks off the board), not the forged one.
    expect(actual?.turtles[0]?.dir).toBe('W');
    expect(actual?.exception).toContain('Out of bounds');
  });

  test('rejects programs that flood stdout without misreporting the drawing', { timeout: 120_000 }, async () => {
    const answer =
      'for (int i = 0; i < 60000; i++) System.out.println("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); t.右を向く();';
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank3'), [answer], withJudge);
    expect(result).toMatchObject({ status: 'incorrect', stage: 4 });
    expect(result.status === 'incorrect' && result.detail).toContain('too much output');
  });

  test('reports ungradable when the judge cannot be reached', { timeout: 120_000 }, async () => {
    const result = await gradeFillInBlankAnswers(instantiate('fillInBlank1'), ['i < 8 / 2'], {
      javaExecutors: [createJudgeExecutor({ url: 'http://127.0.0.1:9' })],
    });
    expect(result).toMatchObject({ status: 'ungradable' });
  });

  test('handles concurrent submissions', { timeout: 120_000 }, async () => {
    const problem = instantiate('fillInBlank1');
    const results = await Promise.all(
      ['i < 8 / 2', 'i < 10 / 2', 'i < 8 / 2'].map((answer) => gradeFillInBlankAnswers(problem, [answer], withJudge))
    );
    expect(results.map((r) => r.status)).toEqual(['correct', 'incorrect', 'correct']);
  });
});
