import { expect, test } from 'vitest';

import { solveProblem, parseProgram } from '../src/app/lib/solveProblem';

test('Parse a program', () => {
  const program = `
    const character = new Character();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
  `;
  const parsedProgram = parseProgram(program);

  expect(parsedProgram).not.toBeFalsy();
  expect(parsedProgram).toEqual([
    'const character = new Character();',
    'character.moveForward();',
    'character.moveForward();',
    'character.moveForward();',
    'character.moveForward();',
    'character.moveForward();',
  ]);
});

test('Solve a problem', () => {
  const problemProgram = `
    const character = new Character();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
  `;

  const answer = solveProblem(problemProgram);

  expect(answer).not.toBeFalsy();
  expect(answer.character).not.toBeFalsy();
  expect(answer.board).not.toBeFalsy();
  expect(answer.character.direction).toEqual('down');
  expect(answer.character.penDown).toEqual(true);

  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
  ]);
  expect(answer.histories).not.toBeFalsy();
  expect(answer.histories?.at(-1)?.character.path).toEqual([1, 6]);
});
