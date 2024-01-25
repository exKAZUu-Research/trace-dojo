import type { CellColor } from '../../types';

export class TurtleGraphicsCell {
  id: number;
  x: number;
  y: number;
  backgroundColor: CellColor;

  constructor(id: number, x: number, y: number, backgroundColor: CellColor) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.backgroundColor = backgroundColor;
  }

  setBackgroundColor(color: CellColor): void {
    this.backgroundColor = color;
  }
}
