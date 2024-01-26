import type { SolveProblemResult } from '../../types';

import { Board as BoardClass } from './Board';
import { Character as CharacterClass } from './Character';

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function executeEval(command: string): CharacterClass {
  const Character = CharacterClass; // eslint-disable-line
  const Board = BoardClass; // eslint-disable-line
  const characterVariableName = 'character';
  const semicolonEndedCommand = (() => {
    if (command.endsWith(';')) return command;
    return (command += ';');
  })();
  const returnValueCommand = `
    ${characterVariableName};
  `;

  const mergedCommand = semicolonEndedCommand + '\n' + returnValueCommand;

  return eval(mergedCommand);
}

export function solveProblem(program: string): SolveProblemResult {
  const commands = parseProgram(program);
  const character = new CharacterClass();
  const board = new BoardClass();
  const histories = [{ step: 0, character, board }];

  for (let i = 0; i < commands.length; i++) {
    if (i < commands.length) {
      let mergedCommand = '';

      for (let j = 0; j <= i; j++) {
        mergedCommand += commands[j];
      }

      const character = executeEval(mergedCommand);

      board.updateGrid(character);
      histories.push({ step: histories.length + 1, character, board });
    }
  }

  const result = {
    character: histories?.at(-1)?.character || character,
    board: histories?.at(-1)?.board || board,
    histories,
  };
  return result;
}
