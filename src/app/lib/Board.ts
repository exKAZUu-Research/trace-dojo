import type { Cell } from '../../types';

import type { Character } from './Character';

export class Board {
  grid: Cell[][];
  constructor({
    gridSize = [8, 12],
  }: {
    gridSize?: [number, number];
  } = {}) {
    this.grid = this.createGrid(gridSize[1], gridSize[0]);
  }

  createGrid(numRows: number, numColumns: number): Cell[][] {
    const grid: Cell[][] = [];
    for (let i = 0; i < numRows; i++) {
      grid.push([]);
      for (let j = 0; j < numColumns; j++) {
        grid[i].push({ color: undefined });
      }
    }
    return grid;
  }

  updateGrid(character: Character): void {
    const { cellColor, penDown, x, y } = character;
    if (penDown) this.grid[y - 1][x - 1].color = cellColor;
  }
}
