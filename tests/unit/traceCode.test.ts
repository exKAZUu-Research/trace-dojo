import { expect, test } from 'vitest';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
} from '../../src/constants';
import { generateProblem } from '../../src/problems/generateProblem';
import type { TraceItem, CharacterTrace } from '../../src/problems/traceProgram';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const sx = 0;
const sy = 0;
const defaultCharacter: CharacterTrace = {
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
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character();
    c.forward();
    c.forward();
    c.forward();
  }
}
`.trim(),
    expectedSidToLineIndex: {
      1: 5,
      2: 6,
      3: 7,
      4: 8,
    },
    expectedCheckpointSids: [3],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      {
        sid: 1,
        vars: { c: defaultCharacter },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: sy + 1 } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: sy + 2 } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: sy + 3 } },
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
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character();
    for (let i = 0; i < 2; i++) {
      c.forward();
      c.forward();
      c.turnRight();
    }
  }
}
  `.trim(),
    expectedSidToLineIndex: {
      1: 5,
      2: 6,
      3: 7,
      4: 8,
      5: 9,
    },
    expectedCheckpointSids: [4],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      {
        sid: 1,
        vars: { c: defaultCharacter },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: defaultCharacter, i: 0 },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: sy + 1 }, i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: sy + 2 }, i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c: { ...defaultCharacter, y: sy + 2, dir: 'E' }, i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: sy + 2, dir: 'E' }, i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, x: sx + 1, y: sy + 2, dir: 'E' }, i: 1 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, x: sx + 2, y: sy + 2, dir: 'E' }, i: 1 },
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
        vars: { c: { ...defaultCharacter, x: sx + 2, y: sy + 2, dir: 'S' }, i: 1 },
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
        vars: { c: { ...defaultCharacter, x: sx + 2, y: sy + 2, dir: 'S' }, i: 2 },
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
import net.exkazuu.Character;

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
      1: 5,
      2: 7,
      3: 8,
      4: 10,
      5: 14,
    },
    expectedCheckpointSids: [],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      { sid: 1, vars: { a: 1 }, board: defaultBoard },
      { sid: 2, vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, vars: { a: 2, x: 1, y: 2 }, board: defaultBoard },
      { sid: 3, vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
    ] as TraceItem[],
  },
  {
    languageId: 'java',
    problemId: 'test4',
    expectedDisplayProgram: `
public class Main {
  public static void main(String[] args) {
    Character c1 = new Character();
    c1.forward();
    c1.turnRight();
    int i = 0;
    c1.forward();

    Character c2 = new Character(2, 3, "green");
    c2.forward();
    String foo = "あいうえお";
    int bar = 79;
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
    expectedCheckpointSids: [],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      {
        sid: 1,
        vars: { c1: defaultCharacter },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c1: { ...defaultCharacter, y: sy + 1 } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c1: { ...defaultCharacter, y: sy + 1, dir: 'E' } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c1: { ...defaultCharacter, y: sy + 1, dir: 'E' }, i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' }, i: 0 },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 6,
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 3, color: 'G' },
          i: 0,
        },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx + 1, y: sy + 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
        ]),
      },
      {
        sid: 7,
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 4, color: 'G' },
          i: 0,
        },
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
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 4, color: 'G' },
          i: 0,
          foo: 'あいうえお',
        },
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
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 4, color: 'G' },
          i: 0,
          foo: 'あいうえお',
          bar: 79,
        },
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
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 4, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
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
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 5, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
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
        vars: {
          c1: { ...defaultCharacter, x: sx + 1, y: sy + 1, dir: 'E' },
          c2: { ...defaultCharacter, x: 2, y: 6, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
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
    var c = new Character();
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
    expectedCheckpointSids: [2, 5, 6],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      {
        sid: 1,
        vars: { c: defaultCharacter },
        board: getBoard([{ x: sx, y: sy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: sy + 1 } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: sy + 2 } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: sy + 2, dir: 'E' } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c: { ...defaultCharacter, x: sx + 1, y: sy + 2, dir: 'E' } },
        board: getBoard([
          { x: sx, y: sy, color: '#' },
          { x: sx, y: sy + 1, color: '#' },
          { x: sx, y: sy + 2, color: '#' },
          { x: sx + 1, y: sy + 2, color: '#' },
        ]),
      },
      {
        sid: 6,
        vars: { c: { ...defaultCharacter, x: sx + 2, y: sy + 2, dir: 'E' } },
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
        vars: { c: { ...defaultCharacter, x: sx + 3, y: sy + 2, dir: 'E' } },
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
        vars: { c: { ...defaultCharacter, x: sx + 4, y: sy + 2, dir: 'E' } },
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
  ({
    expectedCheckpointSids,
    expectedDisplayProgram,
    expectedSidToLineIndex,
    expectedTrace,
    languageId,
    problemId,
  }) => {
    const problem = generateProblem(problemId, languageId, '');
    if (!problem) throw new Error('Failed to generate problem.');

    const { checkpointSids, displayProgram, sidToLineIndex, traceItems } = problem;
    expect(displayProgram).toEqual(expectedDisplayProgram);
    expect(sidToLineIndex).toEqual(
      new Map(Object.entries(expectedSidToLineIndex).map(([sid, lineIndex]) => [Number(sid), lineIndex]))
    );
    expect(checkpointSids).toEqual(expectedCheckpointSids);
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
      if (typeof vars[key] === 'object' && 'x' in (vars[key] as CharacterTrace)) {
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
