import { expect, test } from 'vitest';

import { GRID_COLUMNS, GRID_ROWS } from '../src/components/organisms/TurtleGraphics';
import { generateProgram } from '../src/problems/generateProgram';
import type { TraceItem, CharacterTrace } from '../src/problems/traceProgram';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const cx = Math.floor(GRID_COLUMNS / 2);
const cy = Math.floor(GRID_ROWS / 2);
const defaultCharacter: CharacterTrace = {
  x: cx,
  y: cy,
  color: '#',
  dir: 'N',
  pen: true,
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
      1: 4,
      2: 6,
      3: 7,
      4: 9,
      5: 12,
    },
    expectedCheckpointSids: [],
    expectedTrace: [
      { sid: 1, vars: { a: 1 }, board: defaultBoard },
      { sid: 2, vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, vars: { ret: 2 }, board: defaultBoard },
      { sid: 3, vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
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
      1: 4,
      2: 5,
      3: 6,
      4: 7,
      5: 8,
    },
    expectedCheckpointSids: [4],
    expectedTrace: [
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
    const { checkpointSids, displayProgram, sidToLineIndex, traceItems } = generateProgram(problemId, languageId, '');
    expect(displayProgram).toEqual(expectedDisplayProgram);
    expect(sidToLineIndex).toEqual(
      new Map(Object.entries(expectedSidToLineIndex).map(([sid, lineIndex]) => [Number(sid), lineIndex]))
    );
    expect(checkpointSids).toEqual(expectedCheckpointSids);
    expect(stringifyObjects(traceItems)).toEqual(stringifyObjects(expectedTrace));
  }
);
test.each([
  {
    programId: 'testCheckpoints',
    expected: [2, 5, 6],
  },
] as const)('Get program checkpoint line numbers', ({ expected, programId }) => {
  expect(generateProgram(programId, 'js', '').checkpointSids).toEqual(expected);
});

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
