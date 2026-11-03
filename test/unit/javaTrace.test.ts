import { expect, test } from 'vitest';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
} from '../../src/constants';
import { traceJavaProgram } from '../../src/java/trace';
import { instantiateProblem } from '../../src/problems/instantiateProblem';
import type { TraceItem, TurtleTrace } from '../../src/problems/trace';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const sx = 0;
const sy = 0;
const defaultTurtle: TurtleTrace = {
  x: sx,
  y: sy,
  color: '#',
  dir: 'N',
};

type TraceItemWithOptionalCallStack = Omit<TraceItem, 'callStack' | 'referenceVars'> & {
  callStack?: number[];
  referenceVars?: TraceItem['referenceVars'];
};

test.each([
  {
    problemId: 'test1',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle();
    c.forward();
    c.forward();
    c.forward();
  }
}
`.trim(),
    expectedSidToLineIndex: {
      1: 3,
      2: 4,
      3: 5,
      4: 6,
    },
    expectedTrace: [
      { depth: 0, sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        depth: 0,
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 4,
        turtles: [{ ...defaultTurtle, y: sy + 3 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx, y: sy + 3, color: '#' },
        ]),
      },
    ] as TraceItemWithOptionalCallStack[],
  },
  {
    problemId: 'test2',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle();
    for (int i = 0; i < 2; i++) {
      c.forward();
      c.forward();
      c.turnRight();
    }
  }
}
  `.trim(),
    expectedSidToLineIndex: {
      1: 3,
      2: 4,
      3: 5,
      4: 6,
      5: 7,
    },
    expectedTrace: [
      { depth: 0, sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        depth: 0,
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [defaultTurtle],
        vars: { i: 0 },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        depth: 0,
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 4,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 5,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: { i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 3,
        turtles: [{ ...defaultTurtle, x: sx + 1, y: sy + 2, dir: 'E' }],
        vars: { i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 4,
        turtles: [{ ...defaultTurtle, x: sx + 2, y: sy + 2, dir: 'E' }],
        vars: { i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 5,
        turtles: [{ ...defaultTurtle, x: sx + 2, y: sy + 2, dir: 'S' }],
        vars: { i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [{ ...defaultTurtle, x: sx + 2, y: sy + 2, dir: 'S' }],
        vars: { i: 2 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
        ]),
      },
    ] as TraceItemWithOptionalCallStack[],
  },
  {
    problemId: 'test3',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    int a = 1;
    if (a > 0) {
      int b = 2;
      a = f(a, b);
    }
    int c = a * 2;
  }

  public static int f(int x, int y) {
    int a = x * y;
    return a;
  }
}
  `.trim(),
    expectedSidToLineIndex: {
      1: 3,
      2: 5,
      3: 6,
      4: 8,
      5: 12,
    },
    expectedTrace: [
      { depth: 0, sid: 0, turtles: [], vars: {}, board: defaultBoard },
      { depth: 0, sid: 1, turtles: [], vars: { a: 1 }, board: defaultBoard },
      { depth: 0, sid: 2, turtles: [], vars: { a: 1, b: 2 }, board: defaultBoard },
      { depth: 1, sid: 5, callStack: [1], turtles: [], vars: { a: 2, x: 1, y: 2 }, board: defaultBoard },
      { depth: 0, sid: 3, turtles: [], vars: { a: 2, b: 2 }, board: defaultBoard },
      { depth: 0, sid: 4, turtles: [], vars: { a: 2, c: 4 }, board: defaultBoard },
    ] as TraceItemWithOptionalCallStack[],
  },
  {
    problemId: 'test4',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle();
    c1.forward();
    c1.turnRight();
    int i = 0;
    c1.forward();

    Turtle c2 = new Turtle(2, 3, "G");
    c2.forward();
    String foo = "あいうえお";
    int bar = 23;
    i = bar + 1;
    c2.forward();
    c2.forward();
  }
}
  `.trim(),
    expectedSidToLineIndex: {
      1: 3,
      2: 4,
      3: 5,
      4: 6,
      5: 7,
      6: 9,
      7: 10,
      8: 11,
      9: 12,
      10: 13,
      11: 14,
      12: 15,
    },
    expectedTrace: [
      { depth: 0, sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        depth: 0,
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 4,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 5,
        turtles: [{ ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 6,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 3, color: 'G' },
        ],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 7,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 4, color: 'G' },
        ],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 8,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 4, color: 'G' },
        ],
        vars: { i: 0, foo: 'あいうえお' },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 9,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 4, color: 'G' },
        ],
        vars: { i: 0, foo: 'あいうえお', bar: 23 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 10,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 4, color: 'G' },
        ],
        vars: { i: 24, foo: 'あいうえお', bar: 23 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 11,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 5, color: 'G' },
        ],
        vars: { i: 24, foo: 'あいうえお', bar: 23 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
          { x: 2, y: 5, color: 'G' },
        ]),
      },
      {
        depth: 0,
        sid: 12,
        turtles: [
          { ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' },
          { ...defaultTurtle, x: 2, y: 6, color: 'G' },
        ],
        vars: { i: 24, foo: 'あいうえお', bar: 23 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 4, color: 'G' },
          { x: 2, y: 5, color: 'G' },
          { x: 2, y: 6, color: 'G' },
        ]),
      },
    ] as TraceItemWithOptionalCallStack[],
  },
  {
    problemId: 'test5',
    expectedDisplayProgram: `
public class Straight {
  public static void main(String[] args) {
    var c = new Turtle();
    c.前に進む();
    c.前に進む();
    c.右を向く();
    c.前に進む();
    c.前に進む();
    c.前に進む();
    c.前に進む();
  }
}
  `.trim(),
    expectedSidToLineIndex: {
      1: 3,
      2: 4,
      3: 5,
      4: 6,
      5: 7,
      6: 8,
      7: 9,
      8: 10,
    },
    expectedTrace: [
      { depth: 0, sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        depth: 0,
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        depth: 0,
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 4,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 5,
        turtles: [{ ...defaultTurtle, x: sx + 1, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 6,
        turtles: [{ ...defaultTurtle, x: sx + 2, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 7,
        turtles: [{ ...defaultTurtle, x: sx + 3, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
          { x: sx + 3, y: sy + 2, color: '#' },
        ]),
      },
      {
        depth: 0,
        sid: 8,
        turtles: [{ ...defaultTurtle, x: sx + 4, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
          { x: sx + 2, y: sy + 2, color: '#' },
          { x: sx + 3, y: sy + 2, color: '#' },
          { x: sx + 4, y: sy + 2, color: '#' },
        ]),
      },
    ] as TraceItemWithOptionalCallStack[],
  },
] as const)('Trace a program', ({ expectedDisplayProgram, expectedSidToLineIndex, expectedTrace, problemId }) => {
  const problem = instantiateProblem(problemId, '');
  if (!problem) throw new Error('Failed to generate problem.');

  const { displayProgram, sidToLineIndex, traceItems } = problem;
  expect(displayProgram).toEqual(expectedDisplayProgram);
  expect(sidToLineIndex).toEqual(
    new Map(Object.entries(expectedSidToLineIndex).map(([sid, lineIndex]) => [Number(sid), lineIndex]))
  );
  expect(normalizeLegacyTrace(traceItems)).toEqual(normalizeLegacyTrace(expectedTrace));
});

function normalizeLegacyTrace(trace: TraceItemWithOptionalCallStack[]): TraceItemWithOptionalCallStack[] {
  return trace.map((item) => {
    const legacyItem = { ...item, vars: { ...item.vars }, callStack: item.callStack ?? [] };
    delete legacyItem.referenceVars;
    return legacyItem;
  });
}

function getBoard(dots: { x: number; y: number; color: string }[]): string {
  const board = defaultBoard
    .split('\n')
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    .map((row) => [...row]);
  for (const dot of dots) {
    board[dot.y][dot.x] = dot.color;
  }
  return board.map((row) => row.join('')).join('\n');
}

test('earlier array traces preserve values through alias mutation and nested row replacement', () => {
  const program = `class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    int[] values = { 1, 2 }; // step
    int[][] nested = { { 3, 4 }, { 5, 6 } }; // step
    int[] alias = nested[0]; // step
    values[0] = 9; // step
    nested[0][1] = 8; // step
    alias[0] = 7; // step
    nested[1] = new int[] { 10, 11 }; // step
  }
}`;
  const result = traceJavaProgram(program, program);
  expect(result.traceItems.map(({ vars }) => vars)).toEqual([
    {},
    {},
    { values: [1, 2] },
    {
      values: [1, 2],
      nested: [
        [3, 4],
        [5, 6],
      ],
    },
    {
      values: [1, 2],
      nested: [
        [3, 4],
        [5, 6],
      ],
      alias: [3, 4],
    },
    {
      values: [9, 2],
      nested: [
        [3, 4],
        [5, 6],
      ],
      alias: [3, 4],
    },
    {
      values: [9, 2],
      nested: [
        [3, 8],
        [5, 6],
      ],
      alias: [3, 8],
    },
    {
      values: [9, 2],
      nested: [
        [7, 8],
        [5, 6],
      ],
      alias: [7, 8],
    },
    {
      values: [9, 2],
      nested: [
        [7, 8],
        [10, 11],
      ],
      alias: [7, 8],
    },
  ]);
});

test('a step annotation on a statement that records no step is rejected', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    int i = 0;
    while (i < 3) { // step
      i++;
    }
  }
}`;
  expect(() => traceJavaProgram(program, program)).toThrow('// step は');
});

test.each(['int i; // step\n    i = 3;', 'Counter counter = new Counter();'])(
  'a step annotation on a declaration without an initializer is rejected: %s',
  (body) => {
    const program = `public class Main {
  public static void main(String[] args) {
    ${body}
  }
}
class Counter {
  int count; // step
}`;
    const annotated = body.includes('// step') ? program.replace('int count; // step', 'int count;') : program;
    expect(() => traceJavaProgram(annotated, annotated)).toThrow('// step は');
  }
);

test('a step annotation on a statement with several parts records one step after the whole statement', () => {
  const program = `public class Main {
  static int a = 1, b = 2; // step
  public static void main(String[] args) {
    int x = 3, y = 4; // step
    for (x = 0, y = 5; x < 1; x++, y--) { // step
    }
  }
}`;
  const trace = traceJavaProgram(program, program);
  expect(trace.traceItems.map(({ sid, vars }) => ({ sid, vars }))).toEqual([
    { sid: 0, vars: {} },
    { sid: 1, vars: { 'Main.a': 1, 'Main.b': 2 } },
    { sid: 2, vars: { x: 3, y: 4, 'Main.a': 1, 'Main.b': 2 } },
    { sid: 3, vars: { x: 0, y: 5, 'Main.a': 1, 'Main.b': 2 } },
    { sid: 3, vars: { x: 1, y: 4, 'Main.a': 1, 'Main.b': 2 } },
  ]);
});
