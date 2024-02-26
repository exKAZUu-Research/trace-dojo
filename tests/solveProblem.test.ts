import { expect, test } from 'vitest';

import {
  parseProgram,
  extractVariableNames,
  executeEval,
  solveProblem,
  selectCharacterVariables,
} from '../src/app/lib/solveProblem';

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
  const characterVariables = extractVariableNames(command);

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
  const variables = executeEval(command);
  const characterVariables = selectCharacterVariables(variables);

  expect(characterVariables).not.toBeFalsy();
  expect(characterVariables[0].value.x).toEqual(1);
  expect(characterVariables[0].value.y).toEqual(6);
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
  const variables = executeEval(command);
  const characterVariables = selectCharacterVariables(variables);

  expect(characterVariables).not.toBeFalsy();
  expect(characterVariables[0].value.x).toEqual(1);
  expect(characterVariables[0].value.y).toEqual(3);
  expect(characterVariables[1].value.x).toEqual(2);
  expect(characterVariables[1].value.y).toEqual(3);
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
  expect(answer.characterVariables).not.toBeFalsy();
  expect(answer.characterVariables?.length).toEqual(1);
  expect(answer.board).not.toBeFalsy();
  expect(answer.characterVariables?.[0].value.color).toEqual('red');
  expect(answer.characterVariables?.[0].value.direction).toEqual('down');
  expect(answer.characterVariables?.[0].value.penDown).toEqual(true);

  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: "red" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
  ]);

  expect(answer.histories?.at(0)?.characterVariables?.length).toEqual(0);

  expect(answer.histories?.at(1)?.characterVariables?.length).toEqual(1);
  expect(answer.histories?.at(1)?.characterVariables?.[0]?.value.x).toEqual(1);
  expect(answer.histories?.at(1)?.characterVariables?.[0]?.value.y).toEqual(1);

  expect(answer.histories?.at(-1)?.characterVariables?.length).toEqual(1);
  expect(answer.histories?.at(-1)?.characterVariables?.[0]?.value.x).toEqual(2);
  expect(answer.histories?.at(-1)?.characterVariables?.[0]?.value.y).toEqual(3);

  // prettier-ignore
  expect(answer.histories?.at(0)?.board?.grid).toEqual([
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" },],
  ]);
  // prettier-ignore
  expect(answer.histories?.at(1)?.board?.grid).toEqual([
    [{ color: 'red' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
  ]);
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
  expect(answer.characterVariables).not.toBeFalsy();
  expect(answer.characterVariables?.length).toEqual(3);
  expect(answer.board).not.toBeFalsy();
  expect(answer.characterVariables?.[0].value.color).toEqual('red');
  expect(answer.characterVariables?.[0].value.direction).toEqual('down');
  expect(answer.characterVariables?.[0].value.penDown).toEqual(true);
  expect(answer.characterVariables?.[1].value.color).toEqual('green');
  expect(answer.characterVariables?.[1].value.direction).toEqual('down');
  expect(answer.characterVariables?.[1].value.penDown).toEqual(true);

  // prettier-ignore
  expect(answer.board.grid).toEqual([
    [{ color: 'red' }, { color: 'green' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: 'green' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: 'red' }, { color: 'green' }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
    [{ color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }, { color: "white" }],
  ]);
  expect(answer.histories?.at(-1)?.characterVariables?.length).toEqual(3);
  expect(answer.histories?.at(-1)?.characterVariables?.[0]?.value.x).toEqual(1);
  expect(answer.histories?.at(-1)?.characterVariables?.[0]?.value.y).toEqual(3);
  expect(answer.histories?.at(-1)?.characterVariables?.[1]?.value.x).toEqual(2);
  expect(answer.histories?.at(-1)?.characterVariables?.[1]?.value.y).toEqual(3);
});
