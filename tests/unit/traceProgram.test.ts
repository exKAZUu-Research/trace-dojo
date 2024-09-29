import { expect, test } from 'vitest';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
} from '../../src/constants';
import { instantiateProblem } from '../../src/problems/instantiateProblem';
import type { TraceItem, TurtleTrace } from '../../src/problems/traceProgram';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const sx = 0;
const sy = 0;
const defaultTurtle: TurtleTrace = {
  x: sx,
  y: sy,
  color: '#',
  dir: 'N',
};

test.each([
  {
    languageId: 'java',
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
      { sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
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
    ] as TraceItem[],
  },
  {
    languageId: 'java',
    problemId: 'test2',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle();
    for (let i = 0; i < 2; i++) {
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
      { sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        turtles: [defaultTurtle],
        vars: { i: 0 },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
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
        last: true,
      },
    ] as TraceItem[],
  },
  {
    languageId: 'java',
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
      { sid: 0, turtles: [], vars: {}, board: defaultBoard },
      { sid: 1, turtles: [], vars: { a: 1 }, board: defaultBoard },
      { sid: 2, turtles: [], vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, turtles: [], vars: { a: 2, x: 1, y: 2 }, board: defaultBoard },
      { sid: 3, turtles: [], vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, turtles: [], vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
    ] as TraceItem[],
  },
  {
    languageId: 'java',
    problemId: 'test4',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Turtle c1 = new Turtle();
    c1.forward();
    c1.turnRight();
    int i = 0;
    c1.forward();

    Turtle c2 = new Turtle(2, 3, "green");
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
      { sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        turtles: [{ ...defaultTurtle, y: sy + 1, dir: 'E' }],
        vars: { i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
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
    ] as TraceItem[],
  },
  {
    languageId: 'java',
    problemId: 'test5',
    expectedDisplayProgram: `
public class Straight {
  public static void main(String[] args) {
    var c = new Turtle();
    c.forward();
    c.forward();
    c.turnRight();
    c.forward();
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
      5: 7,
      6: 8,
      7: 9,
      8: 10,
    },
    expectedTrace: [
      { sid: 0, turtles: [], vars: {}, board: defaultBoard },
      {
        sid: 1,
        turtles: [defaultTurtle],
        vars: {},
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        turtles: [{ ...defaultTurtle, y: sy + 1 }],
        vars: {},
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
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
    ] as TraceItem[],
  },
] as const)(
  'Trace a program',
  ({ expectedDisplayProgram, expectedSidToLineIndex, expectedTrace, languageId, problemId }) => {
    const problem = instantiateProblem(problemId, languageId, '');
    if (!problem) throw new Error('Failed to generate problem.');

    const { displayProgram, sidToLineIndex, traceItems } = problem;
    expect(displayProgram).toEqual(expectedDisplayProgram);
    expect(sidToLineIndex).toEqual(
      new Map(Object.entries(expectedSidToLineIndex).map(([sid, lineIndex]) => [Number(sid), lineIndex]))
    );
    expect(stringifyObjects(traceItems)).toEqual(stringifyObjects(expectedTrace));
  }
);

/**
 * テストに失敗した際に、WebStorm上で期待値との差異を確認しやすくするために、文字列化しておく。
 */
function stringifyObjects(trace: TraceItem[]): TraceItem[] {
  // 目視で差異を確認しやすくするために文字列化する。
  for (const item of trace) {
    const vars = { ...item.vars };
    for (const key in vars) {
      if (typeof vars[key] === 'object' && 'x' in (vars[key] as TurtleTrace)) {
        vars[key] = JSON.stringify(vars[key]);
      }
    }
    item.vars = vars;
  }
  console.log(trace); // TODO: remove this later
  return trace;
}

function getBoard(dots: { x: number; y: number; color: string }[]): string {
  const board = defaultBoard.split('\n').map((row) => [...row]);
  for (const dot of dots) {
    board[dot.y][dot.x] = dot.color;
  }
  return board.map((row) => row.join('')).join('\n');
}
