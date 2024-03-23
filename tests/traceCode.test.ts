import { expect, test } from 'vitest';

import { GRID_COLUMNS, GRID_ROWS } from '../src/components/organisms/TurtleGraphics';
import type { TraceItem, CharacterTrace } from '../src/tracer/traceProgram';
import { traceProgram } from '../src/tracer/traceProgram';

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
    program: {
      languageId: 'java',
      rawDisplayProgram: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    int a = 1; // sid: 1
    if (a > 0) {
      int b = 2; // sid: 2
      a = f(a, b); // sid: 3
    }
    int c = a * 2; // sid: 4

    public static int f(int x, int y) {
      return x * y; // sid: 5
    }
  }
}
`.trim(),
      instrumentedProgram: `
s.set('a', 1);
if (s.get('a') > 0) {
  s.set('b', 2);
  s.set('a', f(s.get('a'), s.get('b')));
}
s.set('c', s.get('a') * 2);

function f(x, y) {
  try {
    s.enterNewScope();
    s.set('ret', x * y);
    return s.get('ret');
  } finally {
    s.leaveScope();
  }
}`.trim(),
    },
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
}`.trim(),
    expectedSidToLineIndex: {
      1: 4,
      2: 6,
      3: 7,
      4: 9,
      5: 12,
    },
    expectedTrace: [
      { sid: 1, vars: { a: 1 }, board: defaultBoard },
      { sid: 2, vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, vars: { ret: 2 }, board: defaultBoard },
      { sid: 3, vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
    ] as TraceItem[],
  },
  {
    program: {
      languageId: 'java',
      rawDisplayProgram: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character(); // sid: 1
    for (let i = 0; i < 2; i++) { // sid: 2
      c.forward(); // sid: 3
      c.forward(); // sid: 4
      c.turnRight(); // sid: 5
    }
  }
}
`.trim(),
      instrumentedProgram: `
s.set('c', new Character());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('c').forward();
  s.get('c').forward();
  s.get('c').turnRight();
}`.trim(),
    },
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
] as const)('Trace a program', ({ expectedDisplayProgram, expectedSidToLineIndex, expectedTrace, program }) => {
  const { displayProgram, sidToLineIndex, traceItems } = traceProgram(program);
  expect(displayProgram).toEqual(expectedDisplayProgram);
  expect(sidToLineIndex).toEqual(
    new Map(Object.entries(expectedSidToLineIndex).map(([sid, lineIndex]) => [Number(sid), lineIndex]))
  );
  expect(stringifyObjects(traceItems)).toEqual(stringifyObjects(expectedTrace));
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
