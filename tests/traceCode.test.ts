import { expect, test } from 'vitest';

import { TURTLE_GRAPHICS_GRID_COLUMNS as GRID_COLUMNS, TURTLE_GRAPHICS_GRID_ROWS as GRID_ROWS } from '../src/constants';
import { generateProblem } from '../src/problems/generateProblem';
import type { TraceItem, CharacterTrace } from '../src/problems/traceProgram';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const cx = Math.floor(GRID_COLUMNS / 2);
const cy = Math.floor(GRID_ROWS / 2);
const defaultCharacter: CharacterTrace = {
  x: cx,
  y: cy,
  color: '#',
  dir: 'N',
};

test.each([
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

    public static int f(int x, int y) {
      return x * y;
    }
  }
}
`.trim(),
    expectedSidToLineIndex: {
      1: 5,
      2: 7,
      3: 8,
      4: 10,
      5: 13,
    },
    expectedCheckpointSids: [],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      { sid: 1, vars: { a: 1 }, board: defaultBoard },
      { sid: 2, vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, vars: { ret: 2 }, board: defaultBoard },
      { sid: 3, vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
    ] as TraceItem[],
  },
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
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: cy - 1 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: cy - 2 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: cy - 3 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx, y: cy - 3, color: '#' },
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
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: defaultCharacter, i: 0 },
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: cy - 1 }, i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: cy - 2 }, i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c: { ...defaultCharacter, y: cy - 2, dir: 'E' }, i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: cy - 2, dir: 'E' }, i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, x: cx + 1, y: cy - 2, dir: 'E' }, i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, x: cx + 2, y: cy - 2, dir: 'E' }, i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c: { ...defaultCharacter, x: cx + 2, y: cy - 2, dir: 'S' }, i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, x: cx + 2, y: cy - 2, dir: 'S' }, i: 2 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
        ]),
        last: true,
      },
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
    c1.turnLeft();
    c1.penUp();
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
      6: 8,
      7: 10,
      8: 11,
      9: 12,
      10: 13,
      11: 14,
      12: 15,
      13: 16,
    },
    expectedCheckpointSids: [],
    expectedTrace: [
      { sid: 0, vars: {}, board: defaultBoard },
      {
        sid: 1,
        vars: { c1: defaultCharacter },
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c1: { ...defaultCharacter, y: cy - 1 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c1: { ...defaultCharacter, y: cy - 1, dir: 'W' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c1: { ...defaultCharacter, y: cy - 1, dir: 'W', pen: false } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c1: { ...defaultCharacter, y: cy - 1, dir: 'W', pen: false }, i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 6,
        vars: { c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false }, i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 7,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 3, color: 'G' },
          i: 0,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
        ]),
      },
      {
        sid: 8,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 2, color: 'G' },
          i: 0,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
        ]),
      },
      {
        sid: 9,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 2, color: 'G' },
          i: 0,
          foo: 'あいうえお',
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
        ]),
      },
      {
        sid: 10,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 2, color: 'G' },
          i: 0,
          foo: 'あいうえお',
          bar: 79,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
        ]),
      },
      {
        sid: 11,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 2, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
        ]),
      },
      {
        sid: 12,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 1, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
          { x: 2, y: 1, color: 'G' },
        ]),
      },
      {
        sid: 13,
        vars: {
          c1: { ...defaultCharacter, x: cx - 1, y: cy - 1, dir: 'W', pen: false },
          c2: { ...defaultCharacter, x: 2, y: 0, color: 'G' },
          i: 80,
          foo: 'あいうえお',
          bar: 79,
        },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: 2, y: 3, color: 'G' },
          { x: 2, y: 2, color: 'G' },
          { x: 2, y: 1, color: 'G' },
          { x: 2, y: 0, color: 'G' },
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
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { c: { ...defaultCharacter, y: cy - 1 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { c: { ...defaultCharacter, y: cy - 2 } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { c: { ...defaultCharacter, y: cy - 2, dir: 'E' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { c: { ...defaultCharacter, x: cx + 1, y: cy - 2, dir: 'E' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 6,
        vars: { c: { ...defaultCharacter, x: cx + 2, y: cy - 2, dir: 'E' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 7,
        vars: { c: { ...defaultCharacter, x: cx + 3, y: cy - 2, dir: 'E' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
          { x: cx + 3, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 8,
        vars: { c: { ...defaultCharacter, x: cx + 4, y: cy - 2, dir: 'E' } },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
          { x: cx + 3, y: cy - 2, color: '#' },
          { x: cx + 4, y: cy - 2, color: '#' },
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
    const { checkpointSids, displayProgram, sidToLineIndex, traceItems } = generateProblem(problemId, languageId, '');
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
