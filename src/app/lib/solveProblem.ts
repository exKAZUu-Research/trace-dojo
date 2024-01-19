import type { Character } from './Character';

interface Board {
  grid: Cell[][];
}
interface Cell {
  color: undefined | 'r' | 'g' | 'b';
}

export const createBoard = (numRows: number, numColumns: number): Board => {
  const grid: Cell[][] = [];
  for (let i = 0; i < numRows; i++) {
    grid.push([]);
    for (let j = 0; j < numColumns; j++) {
      grid[i].push({ color: undefined });
    }
  }
  return { grid };
};

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function solveProblem(
  program: string,
  character: Character,
  board: Board
): {
  character: Character;
  board: Board;
  histories: { step: number; character: Character; board: Board }[];
} {
  const commands = parseProgram(program);
  const histories: { step: number; character: Character; board: Board }[] = [];

  // コマンドを順番に実行
  for (const command of commands) {
    eval(command);
    histories.push({ step: histories.length + 1, character, board });
  }

  // 実行結果を返す
  const result = { character, board, histories };
  console.log('result');
  console.log(result);
  return result;
}
