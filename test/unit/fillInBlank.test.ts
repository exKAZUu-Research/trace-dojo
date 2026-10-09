import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, test } from 'vitest';

import { fillBlanks } from '../../src/problems/fillInBlank/blanks';
import { fillInBlankProblemDefinitions } from '../../src/problems/fillInBlank/definitions';
import type { FillInBlankGradingResult, GradingOptions } from '../../src/problems/fillInBlank/grade';
import { createJudgeExecutor, createWandboxExecutor } from '../../src/problems/fillInBlank/javaExecutors';
import type { InstantiatedProblem } from '../../src/problems/instantiateProblem';
import { instantiateProblem } from '../../src/problems/instantiateProblem';

const judge = createJudgeExecutor();
const withJudge = { javaExecutors: [judge] };
type GradeCode = (
  problem: InstantiatedProblem,
  code: string,
  options?: GradingOptions
) => Promise<FillInBlankGradingResult>;
const catalogIds = Object.keys(fillInBlankProblemDefinitions);

describe('trusted model catalog', () => {
  test.each(catalogIds)('%s contains blanks only in Java and instantiates a complete expected drawing', (id) => {
    const definition = fillInBlankProblemDefinitions[id as keyof typeof fillInBlankProblemDefinitions];
    expect(definition.java).toContain('@[');
    expect(definition.instrumented).not.toMatch(/@\[|\]@/);
    const problem = instantiate(id);
    expect(problem.displayProgram).toMatch(/【\d+】/);
    expect(problem.displayProgram).not.toContain('@[');
    expect(problem.instrumentedTemplate).not.toContain('@[');
    expect(problem.finalBoard.split('\n')).toHaveLength(7);
    expect(instantiate(id)).toMatchObject({ finalBoard: problem.finalBoard, finalTurtles: problem.finalTurtles });
  });

  test.each(catalogIds)('%s Java model agrees with trusted JavaScript', { timeout: 180_000 }, async (id) => {
    const grade = await loadGrade();
    const problem = instantiate(id);
    expect(await grade(problem, modelCode(problem), withJudge)).toMatchObject({ status: 'correct' });
  });

  test.each([
    ['fillInBlank2', 'alternate-model-seed'],
    ['doubleLoop1Blank', 'second-random-seed'],
    ['while1Blank', 'third-random-seed'],
  ])('%s model remains consistent at seed %s', { timeout: 180_000 }, async (id, seed) => {
    const grade = await loadGrade();
    const problem = instantiate(id, seed);
    expect(await grade(problem, modelCode(problem), withJudge)).toMatchObject({ status: 'correct' });
  });
});

test('exact complete model is ungradable without Java, including a later identical retry', async () => {
  const grade = await loadGrade();
  const problem = instantiate('fillInBlank1');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(await grade(problem, modelCode(problem), { javaExecutors: [] })).toMatchObject({ status: 'ungradable' });
  }
});

test(
  'accepts edited full source with renamed variables, extra locals, a helper and Java integer semantics',
  { timeout: 180_000 },
  async () => {
    const grade = await loadGrade();
    const code = `
// public class Decoy { public static void main(String[] args) {} }
// import java.lang.Runtime; package harmless; Thread
class Helper { static int distance() { return Integer.MAX_VALUE + Integer.MAX_VALUE + 6; } }
  public final class Drawing {
    public static void main(String[] arguments) {
      String decoy = "public class AnotherDecoy {} Runtime Thread import package";
      String explanation = """
        Runtime.getRuntime() is text here.
        Thread and import java.lang.Runtime; are also text.
        """;
      int unrelated = 100;
      Turtle turtle = new Turtle();
      for (int renamed = 0; renamed < Helper.distance(); renamed++) turtle.前に進む();
    }
  }
`;
    expect(await grade(instantiate('fillInBlank1'), code, withJudge)).toMatchObject({ status: 'correct' });
  }
);

test('changing source outside the former blank changes the drawing', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const problem = instantiate('fillInBlank1');
  const code = modelCode(problem).replace('new Turtle()', 'new Turtle(1, 0)');
  expect(await grade(problem, code, withJudge)).toMatchObject({
    status: 'incorrect',
    detail: expect.stringMatching(/state differs/i),
  });
});

test('an unchanged board with a different final turtle direction is incorrect', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const problem = instantiate('fillInBlank3');
  const code = modelCode(problem).replace(/\n  }\n}/, '\n    t.右を向く();\n  }\n}');
  expect(await grade(problem, code, withJudge)).toMatchObject({
    status: 'incorrect',
    detail: expect.stringMatching(/state differs/i),
  });
});

test.each([
  { name: 'invalid Java type', body: 'int value = true;', diagnostic: /compile/i },
  { name: 'runtime exception', body: 'int zero = 0; int value = 1 / zero;', diagnostic: /exception/i },
  { name: 'missing entry method', code: 'public class Renamed {}', diagnostic: /compile/i },
  {
    name: 'invalid entry method',
    code: 'public class Renamed { public void main(String[] args) {} }',
    diagnostic: /compile/i,
  },
  { name: 'private turtle state access', body: 'Turtle t = new Turtle(); t.x = 3;', diagnostic: /compile/i },
])('$name produces a diagnostic verdict', { timeout: 180_000 }, async ({ body, code, diagnostic }) => {
  const grade = await loadGrade();
  const result = await grade(
    instantiate('fillInBlank1'),
    code ?? `public class Main { public static void main(String[] args) { ${body} } }`,
    withJudge
  );
  expect(result).toMatchObject({ status: 'incorrect', detail: expect.stringMatching(diagnostic) });
});

test('never evaluates a submitted JavaScript payload on the server', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const result = await grade(instantiate('fillInBlank1'), 'globalThis.__fullJavaTestExecuted = true;', withJudge);
  expect((globalThis as { __fullJavaTestExecuted?: boolean }).__fullJavaTestExecuted).toBeUndefined();
  expect(result).toMatchObject({ status: 'incorrect' });
});

test('forged drawing JSON printed on stdout cannot determine the verdict', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const problem = instantiate('fillInBlank1');
  const printed = JSON.stringify(JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles }));
  const code = `public class Main { public static void main(String[] args) { System.out.println(${printed}); System.out.close(); } }`;
  expect(await grade(problem, code, withJudge)).toMatchObject({ status: 'incorrect' });
});

test('unbounded execution returns a time-limit verdict', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const code = 'public class Main { public static void main(String[] args) { while (true) {} } }';
  expect(await grade(instantiate('fillInBlank1'), code, withJudge)).toMatchObject({
    status: 'incorrect',
    detail: expect.stringMatching(/time limit/i),
  });
});

test('wrapped source length is bounded before calling an executor', async () => {
  const grade = await loadGrade();
  const problem = instantiate('fillInBlank1');
  const code = `${modelCode(problem)}\n/*${'x'.repeat(19_000)}*/`;
  expect(code.length).toBeLessThan(20_000);
  expect(await grade(problem, code, { javaExecutors: [] })).toMatchObject({
    status: 'incorrect',
    detail: expect.stringMatching(/too long/i),
  });
});

test('a provider outage falls through to real Java without a JavaScript fallback', { timeout: 180_000 }, async () => {
  const grade = await loadGrade();
  const server = createServer((_, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const unavailable = createWandboxExecutor({ compileUrl: `http://127.0.0.1:${port}/compile` });
    const problem = instantiate('fillInBlank1');
    expect(await grade(problem, modelCode(problem), { javaExecutors: [unavailable, judge] })).toMatchObject({
      status: 'correct',
    });
    expect(await grade(problem, modelCode(problem), { javaExecutors: [unavailable] })).toMatchObject({
      status: 'ungradable',
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test.each([
  { name: 'imports', code: 'import java.util.List; public class Main { public static void main(String[] args) {} }' },
  { name: 'packages', code: 'package example; public class Main { public static void main(String[] args) {} }' },
  {
    name: 'restricted runtime capability',
    code: 'public class Main { public static void main(String[] args) { Runtime.getRuntime(); } }',
  },
  {
    name: 'raw Unicode escapes',
    code: String.raw`public class Main { public static void main(String[] args) { String value = "\u0041"; } }`,
  },
])('rejects $name locally before any Java execution', async ({ code }) => {
  const grade = await loadGrade();
  expect(await grade(instantiate('fillInBlank1'), code, { javaExecutors: [] })).toMatchObject({
    status: 'incorrect',
    detail: expect.stringMatching(/forbidden/i),
  });
});

test(
  'a successful HTTP response reporting JVM startup failure falls through to the actual judge',
  { timeout: 180_000 },
  async () => {
    const grade = await loadGrade();
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
      const problem = instantiate('fillInBlank1');
      expect(
        await grade(problem, modelCode(problem), {
          javaExecutors: [createWandboxExecutor({ compileUrl: `http://127.0.0.1:${port}/compile` }), judge],
        })
      ).toMatchObject({ status: 'correct' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
);

test(
  'excessive stdout is an output-limit verdict even when the Java drawing is correct',
  { timeout: 180_000 },
  async () => {
    const grade = await loadGrade();
    const problem = instantiate('fillInBlank1');
    const code = modelCode(problem).replace(
      'Turtle t =',
      `for (int line = 0; line < 60000; line++) System.out.println("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    Turtle t =`
    );
    expect(await grade(problem, code, withJudge)).toMatchObject({
      status: 'incorrect',
      detail: expect.stringMatching(/too much output/i),
    });
  }
);

async function loadGrade(): Promise<GradeCode> {
  const module = await import('../../src/problems/fillInBlank/grade');
  const grade: unknown = Reflect.get(module, 'gradeFillInBlankCode');
  expect(
    grade,
    'API-presence RED: gradeFillInBlankCode must exist before Java semantic assertions can execute'
  ).toBeTypeOf('function');
  return grade as GradeCode;
}

function instantiate(id: string, seed = 'catalog-model-agreement'): InstantiatedProblem {
  const problem = instantiateProblem(id, 'java', seed);
  if (!problem) throw new Error(`Failed to instantiate ${id}`);
  return problem;
}

function modelCode(problem: InstantiatedProblem): string {
  return fillBlanks(problem.displayProgramTemplate, problem.blankAnswers);
}
