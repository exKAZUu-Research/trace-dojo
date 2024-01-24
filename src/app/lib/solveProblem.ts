import type { CellColor } from '../../types';

import { Character as CharacterClass } from './Character';

// TODO: move to Board.ts
class BoardClass {
  grid: Cell[][];
  constructor({
    gridSize = [8, 12],
  }: {
    gridSize?: [number, number];
  } = {}) {
    this.grid = createBoard(gridSize[1], gridSize[0]);
  }

  updateGrid(character: CharacterClass): void {
    const { color, penDown, x, y } = character;
    if (penDown) this.grid[y - 1][x - 1].color = color;
  }
}

// TODO: move to types?
type Cell = {
  color: CellColor | undefined;
};

type History = {
  step: number;
  character: CharacterClass;
  board: BoardClass;
};

type SolveProblemResult = {
  character: CharacterClass;
  board: BoardClass;
  histories: History[] | undefined;
};

export const createBoard = (numRows: number, numColumns: number): Cell[][] => {
  const grid: Cell[][] = [];
  for (let i = 0; i < numRows; i++) {
    grid.push([]);
    for (let j = 0; j < numColumns; j++) {
      grid[i].push({ color: undefined });
    }
  }
  return grid;
};

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
    command += ';';
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
