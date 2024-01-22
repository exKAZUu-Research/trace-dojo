import type { CharacterColor } from './Character';

type Color = (typeof CharacterColor)[keyof typeof CharacterColor];

export class TurtleGraphicsCell {
  id: number;
  x: number;
  y: number;
  backgroundColor: string;

  constructor(id: number, x: number, y: number, backgroundColor: string) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.backgroundColor = backgroundColor;
  }

  setBackgroundColor(color: Color): void {
    this.backgroundColor = color;
  }
}
