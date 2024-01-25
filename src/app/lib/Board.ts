import type { Cell, CellColor } from '../../types';

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
        grid[i].push({ color: 'white' });
      }
    }
    return grid;
  }

  updateGrid(character: Character): void {
    const { color, penDown, x, y } = character;
    if (penDown) this.grid[y - 1][x - 1].color = color;
  }

  getCellColor(x: number, y: number): CellColor {
    return this.grid[x][y].color;
  }

  setCellColor(x: number, y: number, color: CellColor): void {
    this.grid[x][y].color = color;
  }
}
