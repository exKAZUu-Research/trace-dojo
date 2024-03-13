import * as fs from 'node:fs';

import { expect, test } from 'vitest';

import { GRID_COLUMNS, GRID_ROWS } from '../src/components/organisms/TurtleGraphics';
import type { TurtleTrace } from '../src/tracer/traceProgram';
import { traceProgram } from '../src/tracer/traceProgram';

const defaultBoard = ('.'.repeat(GRID_COLUMNS) + '\n').repeat(GRID_ROWS).trim();
const cx = Math.floor(GRID_COLUMNS / 2);
const cy = Math.floor(GRID_ROWS / 2);
const defaultTurtle: TurtleTrace = {
  x: cx,
  y: cy,
  color: '#',
  dir: 'N',
  pen: true,
};

function getBoard(dots: { x: number; y: number; color: string }[]): string {
  const board = defaultBoard.split('\n').map((row) => [...row]);
  for (const dot of dots) {
    board[dot.y][dot.x] = dot.color;
  }
  return board.map((row) => row.join('')).join('\n');
}

test.each([
  {
    program: {
      displayProgram: 'TODO...',
      instrumentedProgram: fs.readFileSync('test-fixtures/no-turtle.js', { encoding: 'utf8' }),
    },
    expected: [
      { sid: 1, vars: { a: 1 }, board: defaultBoard },
      { sid: 2, vars: { a: 1, b: 2 }, board: defaultBoard },
      { sid: 5, vars: { ret: 2 }, board: defaultBoard },
      { sid: 3, vars: { a: 2, b: 2 }, board: defaultBoard },
      { sid: 4, vars: { a: 2, b: 2, c: 4 }, board: defaultBoard },
    ],
  },
  {
    program: {
      displayProgram: `
const t = new Turtle(); // sid: 1
for (let i = 0; i < 2; i++) { // sid: 2
  t.forward(); // sid: 3
  t.forward(); // sid: 4
  t.rotateRight(); // sid: 5
}
`.trim(),
      instrumentedProgram: `
s.set('t', new Turtle());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('t').forward();
  s.get('t').forward();
  s.get('t').rotateRight();
}`.trim(),
    },
    expected: [
      {
        sid: 1,
        vars: { t: JSON.stringify(defaultTurtle) },
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 2,
        vars: { t: JSON.stringify(defaultTurtle), i: 0 },
        board: getBoard([{ x: cx, y: cy, color: '#' }]),
      },
      {
        sid: 3,
        vars: { t: JSON.stringify({ ...defaultTurtle, y: cy - 1 }), i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { t: JSON.stringify({ ...defaultTurtle, y: cy - 2 }), i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 5,
        vars: { t: JSON.stringify({ ...defaultTurtle, y: cy - 2, dir: 'E' }), i: 0 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 2,
        vars: { t: JSON.stringify({ ...defaultTurtle, y: cy - 2, dir: 'E' }), i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 3,
        vars: { t: JSON.stringify({ ...defaultTurtle, x: cx + 1, y: cy - 2, dir: 'E' }), i: 1 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
        ]),
      },
      {
        sid: 4,
        vars: { t: JSON.stringify({ ...defaultTurtle, x: cx + 2, y: cy - 2, dir: 'E' }), i: 1 },
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
        vars: { t: JSON.stringify({ ...defaultTurtle, x: cx + 2, y: cy - 2, dir: 'S' }), i: 1 },
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
        vars: { t: JSON.stringify({ ...defaultTurtle, x: cx + 2, y: cy - 2, dir: 'S' }), i: 2 },
        board: getBoard([
          { x: cx, y: cy, color: '#' },
          { x: cx, y: cy - 1, color: '#' },
          { x: cx, y: cy - 2, color: '#' },
          { x: cx + 1, y: cy - 2, color: '#' },
          { x: cx + 2, y: cy - 2, color: '#' },
        ]),
      },
    ],
  },
] as const)('Trace a program', ({ expected, program }) => {
  expect(traceProgram(program)).toEqual(expected);
});
