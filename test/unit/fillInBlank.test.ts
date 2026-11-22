import { describe, expect, test } from 'vitest';

import { fillBlanks } from '../../src/problems/fillInBlank/blanks';
import { fillInBlankProblemDefinitions } from '../../src/problems/fillInBlank/definitions';
import { gradeFillInBlankCode } from '../../src/problems/fillInBlank/grade';
import type { InstantiatedProblem } from '../../src/problems/instantiateTemplate';
import { instantiateProblem, nodeRunner } from '../helpers/nodeProblems';

const catalogIds = Object.keys(fillInBlankProblemDefinitions);

describe('trusted model catalog', () => {
  test.each(catalogIds)('%s contains blanks and instantiates a complete expected drawing', async (id) => {
    expect(fillInBlankProblemDefinitions[id as keyof typeof fillInBlankProblemDefinitions]).toContain('@[');
    const problem = await instantiate(id);
    expect(problem.displayProgram).toMatch(/【\d+】/);
    expect(problem.displayProgram).not.toContain('@[');
    expect(problem.finalBoard.split('\n')).toHaveLength(7);
    expect(await instantiate(id)).toMatchObject({ finalBoard: problem.finalBoard, finalTurtles: problem.finalTurtles });
  });

  test.each(catalogIds)('%s Java model reaches its traced final state', async (id) => {
    const problem = await instantiate(id);
    expect(await gradeFillInBlankCode(nodeRunner, problem, modelCode(problem))).toEqual({ status: 'correct' });
  });

  test.each([
    ['fillInBlank2', 'alternate-model-seed'],
    ['doubleLoop1Blank', 'second-random-seed'],
    ['while1Blank', 'third-random-seed'],
  ])('%s model remains consistent at seed %s', async (id, seed) => {
    const problem = await instantiate(id, seed);
    expect(await gradeFillInBlankCode(nodeRunner, problem, modelCode(problem))).toEqual({ status: 'correct' });
  });
});

test('accepts edited full source with renamed variables, extra locals, a helper and Java integer semantics', async () => {
  const code = `
// public class Decoy { public static void main(String[] args) {} }
class Helper { static int distance() { return Integer.MAX_VALUE + Integer.MAX_VALUE + 6; } }
  public final class Drawing {
    public static void main(String[] arguments) {
      String decoy = "public class AnotherDecoy {} Runtime Thread import package";
      int unrelated = 100;
      Turtle turtle = new Turtle();
      for (int renamed = 0; renamed < Helper.distance(); renamed++) turtle.前に進む();
    }
  }
`;
  expect(await gradeFillInBlankCode(nodeRunner, await instantiate('fillInBlank1'), code)).toEqual({ status: 'correct' });
});

test('changing source outside the former blank changes the drawing', async () => {
  const problem = await instantiate('fillInBlank1');
  const code = modelCode(problem).replace('new Turtle()', 'new Turtle(1, 0)');
  expect(await gradeFillInBlankCode(nodeRunner, problem, code)).toEqual({
    status: 'incorrect',
    detail: 'The final state differs from the expected one.',
  });
});

test('an unchanged board with a different final turtle direction is incorrect', async () => {
  const problem = await instantiate('fillInBlank3');
  const code = modelCode(problem).replace(/\n  }\n}/, '\n    t.右を向く();\n  }\n}');
  expect(await gradeFillInBlankCode(nodeRunner, problem, code)).toEqual({
    status: 'incorrect',
    detail: 'The final state differs from the expected one.',
  });
});

test.each([
  { name: 'invalid Java type', body: 'int value = true;', detail: 'Compile error.' },
  { name: 'restricted runtime capability', body: 'Runtime.getRuntime();', detail: 'Compile error.' },
  { name: 'private turtle state access', body: 'Turtle t = new Turtle(); t.x = 3;', detail: 'Compile error.' },
  { name: 'missing entry method', code: 'public class Renamed {}', detail: 'Compile error.' },
  {
    name: 'invalid entry method',
    code: 'public class Renamed { public static int main(String[] args) { return 0; } }',
    detail: 'Compile error.',
  },
  { name: 'JavaScript payload', code: 'globalThis.__fullJavaTestExecuted = true;', detail: 'Compile error.' },
  {
    name: 'uncaught exception',
    body: 'int zero = 0; int value = 1 / zero;',
    detail: 'The program threw an exception.',
  },
  { name: 'unbounded execution', body: 'while (true) {}', detail: 'Time limit exceeded.' },
])('$name is incorrect with its own detail', async ({ body, code, detail }) => {
  const result = await gradeFillInBlankCode(
    nodeRunner,
    await instantiate('fillInBlank1'),
    code ?? `public class Main { public static void main(String[] args) { ${body} } }`
  );
  expect(result).toMatchObject({ status: 'incorrect', detail });
  expect((globalThis as { __fullJavaTestExecuted?: boolean }).__fullJavaTestExecuted).toBeUndefined();
});

test('excessive output is an output-limit verdict even when the drawing is correct', async () => {
  const problem = await instantiate('fillInBlank1');
  const code = modelCode(problem).replace(
    'Turtle t =',
    `for (int line = 0; line < 60000; line++) System.out.println("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    Turtle t =`
  );
  expect(await gradeFillInBlankCode(nodeRunner, problem, code)).toEqual({
    status: 'incorrect',
    detail: 'The program printed too much output.',
  });
});

test('forged drawing JSON printed on stdout cannot determine the verdict', async () => {
  const problem = await instantiate('fillInBlank1');
  const printed = JSON.stringify(JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles }));
  const code = `public class Main { public static void main(String[] args) { System.out.println(${printed}); } }`;
  expect(await gradeFillInBlankCode(nodeRunner, problem, code)).toMatchObject({ status: 'incorrect' });
});

test.each([
  {
    name: 'type mismatch with CRLF, leading blanks, tabs and Japanese identifiers',
    source:
      '\r\n\r\npublic class Main {\r\n\tpublic static void main(String[] args) {\r\n\t\tint 亀の数 = true;\r\n\t}\r\n}\r\n',
    line: 5,
  },
  {
    name: 'unresolved method',
    source: 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}',
    line: 3,
  },
  {
    name: 'untaught constructor overload',
    source: 'class Main {\n public static void main(String[] args) {\n  Turtle t = new Turtle(true);\n }\n}',
    line: 3,
  },
])('compile errors report a Japanese diagnostic on the learner line: $name', async ({ source, line }) => {
  expect(await gradeFillInBlankCode(nodeRunner, await instantiate('fillInBlank1'), source)).toEqual({
    status: 'incorrect',
    detail: 'Compile error.',
    diagnostics: [{ line, message: expect.stringMatching(/[ぁ-ん]/) }],
  });
});

async function instantiate(id: string, seed = 'catalog-model-agreement'): Promise<InstantiatedProblem> {
  return await instantiateProblem(id, seed);
}

function modelCode(problem: InstantiatedProblem): string {
  return fillBlanks(problem.displayProgramTemplate, problem.blankAnswers);
}
