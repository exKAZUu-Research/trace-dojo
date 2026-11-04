import { expect, test } from 'vitest';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
} from '../../src/constants';
import { traceProgram } from '../../src/interpreter/program';
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

type TraceItemWithOptionalCallLines = Omit<TraceItem, 'callLines' | 'referenceVars'> & {
  callLines?: number[];
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
    expectedTrace: [
      { line: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        line: 3,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        line: 4,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 5,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 6,
        turtles: [{ ...defaultTurtle, y: sy + 3 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx, y: sy + 3, color: '#' },
        ]),
      },
    ] as TraceItemWithOptionalCallLines[],
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
    expectedTrace: [
      { line: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        line: 3,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        line: 4,
        turtles: [defaultTurtle],
        vars: { i: 0 },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        line: 5,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 6,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 7,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 4,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: { i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 5,
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
        line: 6,
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
        line: 7,
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
        line: 4,
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
    ] as TraceItemWithOptionalCallLines[],
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
    expectedTrace: [
      { line: 0, turtles: [], vars: {}, board: defaultBoard },
      { line: 3, turtles: [], vars: { a: 1 }, board: defaultBoard },
      { line: 5, turtles: [], vars: { a: 1, b: 2 }, board: defaultBoard },
      { line: 12, callLines: [6], turtles: [], vars: { a: 2, x: 1, y: 2 }, board: defaultBoard },
      { line: 6, turtles: [], vars: { a: 2, b: 2 }, board: defaultBoard },
      { line: 8, turtles: [], vars: { a: 2, c: 4 }, board: defaultBoard },
    ] as TraceItemWithOptionalCallLines[],
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
    expectedTrace: [
      { line: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        line: 3,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        line: 4,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 5,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 6,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 7,
        turtles: [{ ...defaultTurtle, x: sx + 1, y: sy + 1, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 9,
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
        line: 10,
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
        line: 11,
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
        line: 12,
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
        line: 13,
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
        line: 14,
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
        line: 15,
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
    ] as TraceItemWithOptionalCallLines[],
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
    expectedTrace: [
      { line: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        line: 3,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        line: 4,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        line: 5,
        turtles: [{ ...defaultTurtle, y: sy + 2 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 6,
        turtles: [{ ...defaultTurtle, y: sy + 2, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        line: 7,
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
        line: 8,
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
        line: 9,
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
        line: 10,
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
    ] as TraceItemWithOptionalCallLines[],
  },
] as const)('Trace a program', ({ expectedDisplayProgram, expectedTrace, problemId }) => {
  const problem = instantiateProblem(problemId, '');
  if (!problem) throw new Error('Failed to generate problem.');

  const { displayProgram, traceItems } = problem;
  expect(displayProgram).toEqual(expectedDisplayProgram);
  expect(normalizeLegacyTrace(traceItems)).toEqual(normalizeLegacyTrace(expectedTrace));
});

function normalizeLegacyTrace(trace: TraceItemWithOptionalCallLines[]): TraceItemWithOptionalCallLines[] {
  return trace.map((item) => {
    const legacyItem = { ...item, vars: { ...item.vars }, callLines: item.callLines ?? [] };
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
    Turtle t = new Turtle();
    int[] values = { 1, 2 };
    int[][] nested = { { 3, 4 }, { 5, 6 } };
    int[] alias = nested[0];
    values[0] = 9;
    nested[0][1] = 8;
    alias[0] = 7;
    nested[1] = new int[] { 10, 11 };
  }
}`;
  const result = traceProgram('java', program, program);
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

test('a trace records the statements outside atomic methods, leaving a call to the steps inside it', () => {
  const program = `public class Main {
  static int count = 0;
  public static void main(String[] args) {
    Turtle t = new Turtle();
    walk(t);
    int n = twice(2);
    spin(t);
    Turtle[] ts = { t };
    for (Turtle each : ts) {
      each.前に進む();
    }
  }
  static void walk(Turtle t) {
    t.前に進む();
  }
  static int twice(int a) {
    return a * 2;
  }
  static void spin(Turtle t) { // atomic
    t.右を向く();
    walk(t);
  }
}`;
  const trace = traceProgram('java', program, program);
  expect(trace.displayProgram).toBe(program.replace(' // atomic', ''));
  expect(trace.traceItems.map(({ line, callLines, vars }) => ({ line, callLines, vars }))).toEqual([
    { line: 0, callLines: [], vars: {} },
    { line: 4, callLines: [], vars: { 'Main.count': 0 } },
    { line: 14, callLines: [5], vars: { 'Main.count': 0 } },
    { line: 6, callLines: [], vars: { n: 4, 'Main.count': 0 } },
    { line: 7, callLines: [], vars: { n: 4, 'Main.count': 0 } },
    { line: 8, callLines: [], vars: { n: 4, 'Main.count': 0 } },
    { line: 10, callLines: [], vars: { n: 4, 'Main.count': 0 } },
  ]);
});

test('a call to an atomic method records its step even when its arguments record steps', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    keep(make());
  }
  static int make() {
    int x = 1;
    return x;
  }
  static void keep(int n) { // atomic
    int y = n + 1;
  }
}`;
  expect(traceProgram('java', program, program).traceItems.map(({ line }) => line)).toEqual([0, 6, 3]);
});

test('a turtle operation after steps in its arguments or receiver records its own step', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(position(), 0);
    pick(t).前に進む();
  }
  static int position() {
    int x = 2;
    return x;
  }
  static Turtle pick(Turtle t) {
    Turtle picked = t;
    return picked;
  }
}`;
  const trace = traceProgram('java', program, program);
  expect(trace.traceItems.map(({ line, turtles }) => ({ line, y: turtles[0]?.y }))).toEqual([
    { line: 0, y: undefined },
    { line: 7, y: undefined },
    { line: 3, y: 0 },
    { line: 11, y: 0 },
    { line: 4, y: 1 },
  ]);
});

test('a for-each loop over objects records a binding only when the turtles changed', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    Turtle a = new Turtle();
    for (Turtle t : new Turtle[] { a, new Turtle(2, 2) }) {
    }
  }
}`;
  expect(traceProgram('java', program, program).traceItems.map(({ line }) => line)).toEqual([0, 3, 4]);
});

test('a for-each loop keeps the turtles of an array that no variable holds', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    for (Turtle t : new Turtle[] { new Turtle(0, 0), new Turtle(2, 2) }) {
      t.前に進む();
    }
  }
}`;
  expect(traceProgram('java', program, program).traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 2, 2, 2]);
});

test('an atomic annotation outside a method declaration is rejected', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    int i = 0; // atomic
  }
}`;
  expect(() => traceProgram('java', program, program)).toThrow('// atomic は');
});

test('a statement with several parts records one step after the whole statement', () => {
  const program = `public class Main {
  static int a = 1, b = a + 1;
  public static void main(String[] args) {
    int x = 3, y = 4;
    for (x = 0, y = 5; x < 1; x++, y--) {
    }
  }
}`;
  const trace = traceProgram('java', program, program);
  expect(trace.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 2, vars: { 'Main.a': 1, 'Main.b': 2 } },
    { line: 4, vars: { x: 3, y: 4, 'Main.a': 1, 'Main.b': 2 } },
    { line: 5, vars: { x: 0, y: 5, 'Main.a': 1, 'Main.b': 2 } },
    { line: 5, vars: { x: 1, y: 4, 'Main.a': 1, 'Main.b': 2 } },
  ]);
});

test('a field declaration that only creates objects leaves its step to constructors that record one', () => {
  const program = `public class Main {
  Box first = new Box(true), second = new Box(false);
  public static void main(String[] args) {
    Main m = new Main();
  }
}
class Box {
  int n;
  Box(boolean set) {
    if (set) n = 1;
  }
}`;
  expect(traceProgram('java', program, program).traceItems.map(({ line }) => line)).toEqual([0, 10]);
});

test('a for statement records no step for an absent init or update', () => {
  const program = `public class Main {
  public static void main(String[] args) {
    int i = 0;
    for (; i < 1; i++) {
    }
    for (int j = 0; j < 1;) {
      j++;
    }
  }
}`;
  const trace = traceProgram('java', program, program);
  expect(trace.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 3, vars: { i: 0 } },
    { line: 4, vars: { i: 1 } },
    { line: 6, vars: { i: 1, j: 0 } },
    { line: 7, vars: { i: 1, j: 1 } },
  ]);
});
