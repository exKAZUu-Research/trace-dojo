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

test('Execute eval (1character)', () => {
  const command = `
    const character1 = new Character();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
  `;
  const characters = executeEval(command);

  expect(characters).not.toBeFalsy();
  expect(characters[0].x).toEqual(1);
  expect(characters[0].y).toEqual(6);
});

test('Execute eval (2characters)', () => {
  const command = `
    const character1 = new Character();
    const character2 = new Character({x: 2, y: 1});
    character1.moveForward();
    character1.moveForward();
    character2.moveForward();
    character2.moveForward();
  `;
  const characters = executeEval(command);

  expect(characters).not.toBeFalsy();
  expect(characters[0].x).toEqual(1);
  expect(characters[0].y).toEqual(3);
  expect(characters[1].x).toEqual(2);
  expect(characters[1].y).toEqual(3);
});

test('Solve a problem (1character)', () => {
  const problemProgram = `
    const character1 = new Character();
    character1.moveBack();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.turnLeft();
    character1.moveForward();
    character1.turnRight();
    character1.moveBack();
    character1.upPen();
    character1.moveBack();
    character1.moveBack();
    character1.putPen();
  `;

  const answer = solveProblem(problemProgram);

  expect(answer).not.toBeFalsy();
  expect(answer.characters).not.toBeFalsy();
  expect(answer.characters?.length).toEqual(1);
  expect(answer.board).not.toBeFalsy();
  expect(answer.characters?.[0].color).toEqual('red');
  expect(answer.characters?.[0].direction).toEqual('down');
  expect(answer.characters?.[0].penDown).toEqual(true);

  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: 'red' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: "red" }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
  ]);
  expect(answer.histories?.at(-1)?.characters?.length).toEqual(1);
  expect(answer.histories?.at(-1)?.characters?.[0]?.x).toEqual(2);
  expect(answer.histories?.at(-1)?.characters?.[0]?.y).toEqual(3);
});

test('Solve a problem (multiple characters)', () => {
  const problemProgram = `
    const character1 = new Character();
    const character2 = new Character({color: 'green', x: 2, y: 1});
    character1.moveForward();
    character1.moveForward();
    character2.moveForward();
    character2.moveForward();
    const character3 = new Character({color: 'yellow', penDown: false, x: 3, y: 1});
  `;

  const answer = solveProblem(problemProgram);

  expect(answer).not.toBeFalsy();
  expect(answer.characters).not.toBeFalsy();
  expect(answer.characters?.length).toEqual(3);
  expect(answer.board).not.toBeFalsy();
  expect(answer.characters?.[0].color).toEqual('red');
  expect(answer.characters?.[0].direction).toEqual('down');
  expect(answer.characters?.[0].penDown).toEqual(true);
  expect(answer.characters?.[1].color).toEqual('green');
  expect(answer.characters?.[1].direction).toEqual('down');
  expect(answer.characters?.[1].penDown).toEqual(true);

  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: 'red' }, { color: 'green' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: 'green' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: 'red' }, { color: 'green' }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
    [{ color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }, { color: undefined }],
  ]);
  expect(answer.histories?.at(-1)?.characters?.length).toEqual(3);
  expect(answer.histories?.at(-1)?.characters?.[0]?.x).toEqual(1);
  expect(answer.histories?.at(-1)?.characters?.[0]?.y).toEqual(3);
  expect(answer.histories?.at(-1)?.characters?.[1]?.x).toEqual(2);
  expect(answer.histories?.at(-1)?.characters?.[1]?.y).toEqual(3);
});
