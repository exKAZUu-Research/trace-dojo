import { expect, test } from 'vitest';

import { parseProgram, extractVariables, executeEval, solveProblem } from '../src/app/lib/solveProblem';

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

test('Extract variables', () => {
  const variableName = 'character';
  const command = `
    const character1 = new Character();
    const character2 = new Character();
    const character3 = new Character();
    const character4 = new Character();
    const character5 = new Character();
    character1.moveForward();
    character2.moveForward();
    character3.moveForward();
    character4.moveForward();
    character5.moveForward();
  `;
  const characterVariables = extractVariables(variableName, command);

  expect(characterVariables).not.toBeFalsy();
  expect(characterVariables).toEqual(['character1', 'character2', 'character3', 'character4', 'character5']);
});

test('Execute eval', () => {
  const command = `
    const character = new Character();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
    character.moveForward();
  `;
  const character = executeEval(command);

  expect(character).not.toBeFalsy();
  expect(character.x).toEqual(1);
  expect(character.y).toEqual(6);
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
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
  ]);
  expect(answer.histories).not.toBeFalsy();
  expect(answer.histories?.at(-1)?.character.x).toEqual(1);
  expect(answer.histories?.at(-1)?.character.y).toEqual(6);
});
