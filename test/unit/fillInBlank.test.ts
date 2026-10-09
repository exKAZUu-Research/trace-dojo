import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, test } from 'vitest';

import { diagnosticVerdictSchema, withCompilerTransport } from '../helpers/compilerTransport';

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

test.each([
  {
    name: 'type mismatch with CRLF, leading blanks, tabs and Japanese identifiers',
    source:
      '\r\n\r\npublic class Main {\r\n\tpublic static void main(String[] args) {\r\n\t\tint 亀の数 = true;\r\n\t}\r\n}\r\n',
    line: 5,
    category: /^incompatible types: boolean cannot be converted to int$/,
  },
  {
    name: 'unresolved method',
    source: 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}',
    line: 3,
    category: /^cannot find symbol\nsymbol: method missing\(\)$/,
  },
  {
    name: 'missing semicolon',
    source: 'class Main {\n public static void main(String[] args) {\n  int count = 1\n }\n}',
    line: 3,
    category: /^';' expected$/,
  },
  {
    name: 'untaught constructor overload',
    source: 'class Main {\n public static void main(String[] args) {\n  Turtle t = new Turtle(true);\n }\n}',
    line: 3,
    category: /^no suitable constructor found for Turtle\(boolean\)$/,
  },
  { name: 'missing main', source: 'class Main {}', line: undefined, category: /main/ },
  {
    name: 'missing closing brace',
    source: 'class Main {\n public static void main(String[] args) {\n } // final comment',
    line: undefined,
    category: /括弧|かっこ|構文/,
  },
])('compiler diagnostics map $name through actual Java', { timeout: 180_000 }, async ({ source, line, category }) => {
  const grade = await loadGrade();
  const result = await grade(instantiate('fillInBlank1'), source, withJudge);
  expect(result.status, 'A provider outage is infrastructure failure, not an intentional diagnostics RED').toBe(
    'incorrect'
  );
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        [line ? 'originalMessage' : 'message']: expect.stringMatching(category),
        ...(line ? { line } : {}),
      }),
    ])
  );
  expect(verdict.diagnostics.every((diagnostic) => /[ぁ-ん]/.test(diagnostic.message))).toBe(true);
  if (!line) expect(verdict.diagnostics.every((diagnostic) => diagnostic.line === undefined)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /TraceDojoJudge|\.java|__TRACE_DOJO_RESULT_|constructor Turtle|actual and formal argument lists/
  );
});

test.each([
  'continuation',
  'recognized header',
  'unknown category',
  'oversize',
  'wrapper line',
  'out of range',
  'wrong filename',
  'many errors',
] as const)('compiler diagnostics discard hostile %s through the HTTP executor boundary', async (scenario) => {
  const source = 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}';
  const poison =
    'SECRET_PROVIDER_PATH /private/compiler.java __TRACE_DOJO_RESULT_secret__ <img src=x> \u001B[31m \u202E';
  const grade = await loadGrade();
  const result = await withCompilerTransport(
    (file, program) => {
      const userLine = program.split(/\r\n|\r|\n/).findIndex((line) => line.includes('missing();')) + 1;
      const line = scenario === 'wrapper line' ? 1 : scenario === 'out of range' ? 999_999_999 : userLine;
      const category =
        scenario === 'unknown category'
          ? 'unrecognized provider category'
          : scenario === 'recognized header'
            ? `incompatible types: ${poison} cannot be converted to int`
            : 'cannot find symbol';
      const header = `/private/${scenario === 'wrong filename' ? 'Unrelated.java' : file}:${line}: error: ${category}\n`;
      const compilerError =
        scenario === 'oversize'
          ? header + poison.repeat(3000)
          : scenario === 'many errors'
            ? (header + poison + '\n').repeat(50)
            : header + poison;
      return { status: '1', compiler_error: compilerError };
    },
    async (executor) => grade(instantiate('fillInBlank1'), source, { javaExecutors: [executor] })
  );
  expect(JSON.stringify(result)).not.toMatch(
    /SECRET_PROVIDER_PATH|private|\.java|TRACE_DOJO|img|\\u001b|\u202E|unrecognized provider/
  );
  const verdict = diagnosticVerdictSchema.parse(result);
  for (const diagnostic of verdict.diagnostics) {
    expect(diagnostic.message).toMatch(/[ぁ-ん]/);
    expect(diagnostic.message).not.toMatch(/^(?:コンパイル|構文)/);
    if (scenario === 'continuation' || scenario === 'many errors') {
      if (diagnostic.originalMessage !== undefined) expect(diagnostic.originalMessage).toBe('cannot find symbol');
    } else {
      expect(diagnostic.originalMessage).toBeUndefined();
    }
  }
  expect(new Set(verdict.diagnostics.map((diagnostic) => JSON.stringify(diagnostic))).size).toBe(
    verdict.diagnostics.length
  );
  if (
    scenario === 'wrapper line' ||
    scenario === 'out of range' ||
    scenario === 'oversize' ||
    scenario === 'wrong filename'
  ) {
    expect(verdict.diagnostics.every((diagnostic) => diagnostic.line === undefined)).toBe(true);
  } else {
    expect(verdict.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ line: 3 })]));
  }
});

test.each([
  { name: 'forged symbol', declaration: '', symbol: 'providerSecret' },
  {
    name: 'NUL-delimited identifier fragment',
    declaration: 'int prefix\u0000providerSecret;',
    symbol: 'providerSecret',
  },
  {
    name: 'DEL-delimited identifier fragment',
    declaration: 'int prefix\u007FproviderSecret;',
    symbol: 'providerSecret',
  },
  { name: 'comment-only symbol', declaration: '// commentSecret', symbol: 'commentSecret' },
  { name: 'string-only symbol', declaration: 'String text = "stringSecret";', symbol: 'stringSecret' },
  { name: 'unfinished string', declaration: 'String text = "brokenSecret', symbol: 'brokenSecret' },
  {
    name: 'unfinished character',
    declaration: "int brokenCharacter; char text = 'unterminated",
    symbol: 'brokenCharacter',
  },
  { name: 'reserved helper', declaration: 'int dump;', symbol: 'dump' },
  { name: 'reserved wrapper', declaration: 'int TraceDojoJudge;', symbol: 'TraceDojoJudge' },
  {
    name: 'reserved marker prefix',
    declaration: 'int __TRACE_DOJO_RESULT_forged;',
    symbol: '__TRACE_DOJO_RESULT_forged',
  },
  { name: 'bidi continuation', declaration: 'int visible;', symbol: 'visible\u202E' },
  { name: 'control continuation', declaration: 'int visible;', symbol: 'visible\u001B[31m' },
])('compiler diagnostics retain safe information while rejecting $name provenance', async ({ declaration, symbol }) => {
  const source = `class Main {\n public static void main(String[] args) {\n  ${declaration}\n  missing();\n }\n}`;
  const grade = await loadGrade();
  const result = await withCompilerTransport(
    (file, program) => {
      const line = program.split(/\r\n|\r|\n/).findIndex((text) => text.includes('missing();')) + 1;
      return {
        status: '1',
        compiler_error: `${file}:${line}: error: cannot find symbol\n  symbol: variable ${symbol}\n  location: class ProviderLocationSecret\n${file}:${line}: error: incompatible types: boolean cannot be converted to int`,
      };
    },
    async (executor) => grade(instantiate('fillInBlank1'), source, { javaExecutors: [executor] })
  );
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual([
    expect.objectContaining({
      line: 4,
      message: expect.stringMatching(/[ぁ-ん]/),
      originalMessage: 'cannot find symbol',
    }),
    expect.objectContaining({
      line: 4,
      message: expect.stringMatching(/[ぁ-ん]/),
      originalMessage: 'incompatible types: boolean cannot be converted to int',
    }),
  ]);
  expect(JSON.stringify(result)).not.toContain(symbol);
  expect(JSON.stringify(result)).not.toContain('ProviderLocationSecret');
});

test('compiler diagnostics require the whole header grammar and independently validate continuations', async () => {
  const source = 'class Main {\n public static void main(String[] args) {\n\tint 亀の数; int\tcafé; missing();\n }\n}';
  const grade = await loadGrade();
  const result = await withCompilerTransport(
    (file, program) => {
      const line = program.split(/\r\n|\r|\n/).findIndex((text) => text.includes('missing();')) + 1;
      return {
        status: '1',
        compiler_error: `${file}:${line}: error: illegal start of expression /private/headerSecret\n${file}:${line}: error: incompatible types: boolean cannot be converted to int HEADER_SECRET\n${file}:${line}: error: cannot find symbol\n  symbol: variable 亀の数\n  location: class /private/locationSecret\n${file}:${line}: error: cannot find symbol\n  symbol: variable café`,
      };
    },
    async (executor) => grade(instantiate('fillInBlank1'), source, { javaExecutors: [executor] })
  );
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ line: 3, message: expect.stringMatching(/[ぁ-ん]/) }),
      expect.objectContaining({
        line: 3,
        message: expect.stringMatching(/亀の数/),
        originalMessage: 'cannot find symbol\nsymbol: variable 亀の数',
      }),
      expect.objectContaining({
        line: 3,
        message: expect.stringMatching(/café/),
        originalMessage: 'cannot find symbol\nsymbol: variable café',
      }),
    ])
  );
  expect(JSON.stringify(result)).not.toMatch(/private|Secret|HEADER_SECRET|illegal start|incompatible types/);
});

test('foreign compiler transport remains unavailable instead of blaming the learner', async () => {
  const grade = await loadGrade();
  await withCompilerTransport(
    () => ({ status: '1', compiler_error: 'toolchain offline: /private/secret', program_error: 'toolchain offline' }),
    async (executor) => {
      expect(await grade(instantiate('fillInBlank1'), 'class Main {}', { javaExecutors: [executor] })).toMatchObject({
        status: 'ungradable',
      });
    }
  );
});

test.each(['unfinished', 'exception'] as const)(
  'runtime %s does not disclose arbitrary provider text',
  async (scenario) => {
    const grade = await loadGrade();
    const poison = 'SECRET_RUNTIME /private/file __TRACE_DOJO_RESULT_forged__ <script> \u202E';
    const problem = instantiate('fillInBlank1');
    const result = await withCompilerTransport(
      (_, program) => {
        const marker = program.match(/__TRACE_DOJO_RESULT_[a-f0-9]+__/)?.[0];
        expect(marker).toBeDefined();
        return {
          status: '0',
          program_error:
            scenario === 'unfinished'
              ? poison
              : `${marker}\n${JSON.stringify({ board: problem.finalBoard, turtles: problem.finalTurtles, exception: poison })}`,
        };
      },
      async (executor) => grade(problem, modelCode(problem), { javaExecutors: [executor] })
    );
    expect(result).toMatchObject({
      status: 'incorrect',
      detail: expect.stringMatching(
        scenario === 'unfinished' ? /^The program did not finish normally/ : /^The program threw an exception/
      ),
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_RUNTIME|private|TRACE_DOJO|script|\u202E/);
  }
);

test('compiler diagnostics cap distinct valid learner locations independently of deduplication', async () => {
  const sourceLines = [
    'class Main {',
    ' public static void main(String[] args) {',
    ...Array.from({ length: 25 }, (_, index) => `  missing${index}();`),
    ' }',
    '}',
  ];
  const source = sourceLines.join('\n');
  const grade = await loadGrade();
  const result = await withCompilerTransport(
    (file, program) => {
      const compilerError = program
        .split(/\r\n|\r|\n/)
        .flatMap((line, index) =>
          /missing\d+\(\);/.test(line) ? [`${file}:${index + 1}: error: cannot find symbol`] : []
        )
        .join('\n');
      expect(compilerError.split('\n')).toHaveLength(25);
      return { status: '1', compiler_error: compilerError };
    },
    async (executor) => grade(instantiate('fillInBlank1'), source, { javaExecutors: [executor] })
  );
  const verdict = diagnosticVerdictSchema.parse(result);
  expect(verdict.diagnostics.length).toBeGreaterThan(1);
  expect(verdict.diagnostics.length).toBeLessThanOrEqual(20);
  const lines = verdict.diagnostics.map((diagnostic) => diagnostic.line);
  expect(new Set(lines).size).toBe(lines.length);
  expect(lines.every((line) => line !== undefined && line >= 3 && line <= 27)).toBe(true);
});
