import { expect, test } from 'vitest';

import { Character } from '../src/app/lib/Character';
import { solveProblem, parseProgram, createBoard } from '../src/app/lib/solveProblem';

test('Parse a program', () => {
  const program = `
    const turtle = new Turtle();
    turtle.moveForward(5);
  `;
  const parsedProgram = parseProgram(program);

  expect(parsedProgram).not.toBeFalsy();
  expect(parsedProgram).toEqual(['const turtle = new Turtle();', 'turtle.moveForward(5);']);
});

test('Solve a problem', () => {
  const problemProgram = `
    const turtle = new Turtle();
    turtle.moveForward(5);
  `;
  const character = new Character({
    name: 'Turtle',
    id: 1,
    x: 1,
    y: 1,
    path: ['1,1'],
    direction: 'down',
    color: 'red',
    penDown: true,
  });
  const board = createBoard(8, 12);

  const answer = solveProblem(problemProgram, character, board);

  expect(answer).not.toBeFalsy();
  expect(answer.character).not.toBeFalsy();
  expect(answer.board).not.toBeFalsy();
  expect(answer.character.path).toEqual([1, 6]);
  expect(answer.character.direction).toEqual('down');
  expect(answer.character.penDown).toEqual(true);
  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
  ]);
});
