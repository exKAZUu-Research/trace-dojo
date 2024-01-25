import { v4 as uuidv4 } from 'uuid';

export const CharacterDirection = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
};
type Direction = (typeof CharacterDirection)[keyof typeof CharacterDirection];

export const CharacterColor = {
  Red: 'red',
  Blue: 'blue',
  Green: 'green',
  Yellow: 'yellow',
  Purple: 'purple',
  White: 'white',
};
type Color = (typeof CharacterColor)[keyof typeof CharacterColor];

export class Character {
  id: string;
  name: string;
  x: number;
  y: number;
  direction: Direction;
  color: Color;
  penDown: boolean;
  path: string[];

  constructor(name: string, x: number, y: number, direction: string, color: string, penDown: boolean, path: string[]) {
    this.id = uuidv4();
    this.name = name;
    this.x = x;
    this.y = y;
    this.direction = direction;
    this.color = color;
    this.penDown = penDown;
    this.path = path;
  }

  moveForward(gridColumns: number, gridRows: number): void {
    if (!this.canMoveForward(gridColumns, gridRows)) return;

    switch (this.direction) {
      case CharacterDirection.Up: {
        this.y -= 1;
        break;
      }
      case CharacterDirection.Down: {
        this.y += 1;
        break;
      }
      case CharacterDirection.Left: {
        this.x -= 1;
        break;
      }
      case CharacterDirection.Right: {
        this.x += 1;
        break;
      }
    }

    if (this.penDown) {
      this.path.push(`${this.x},${this.y}`);
    }
  }

  moveBack(gridColumns: number, gridRows: number): void {
    if (!this.canMoveBack(gridColumns, gridRows)) return;

    switch (this.direction) {
      case CharacterDirection.Up: {
        this.y += 1;
        break;
      }
      case CharacterDirection.Down: {
        this.y -= 1;
        break;
      }
      case CharacterDirection.Left: {
        this.x += 1;
        break;
      }
      case CharacterDirection.Right: {
        this.x -= 1;
        break;
      }
    }

    if (this.penDown) {
      this.path.push(`${this.x},${this.y}`);
    }
  }

  turnLeft(): void {
    switch (this.direction) {
      case CharacterDirection.Up: {
        this.direction = CharacterDirection.Left;
        break;
      }
      case CharacterDirection.Down: {
        this.direction = CharacterDirection.Right;
        break;
      }
      case CharacterDirection.Left: {
        this.direction = CharacterDirection.Down;
        break;
      }
      case CharacterDirection.Right: {
        this.direction = CharacterDirection.Up;
        break;
      }
    }
  }

  turnRight(): void {
    console.log(this.direction);
    switch (this.direction) {
      case CharacterDirection.Up: {
        this.direction = CharacterDirection.Right;
        break;
      }
      case CharacterDirection.Down: {
        this.direction = CharacterDirection.Left;
        break;
      }
      case CharacterDirection.Left: {
        this.direction = CharacterDirection.Up;
        break;
      }
      case CharacterDirection.Right: {
        this.direction = CharacterDirection.Down;
        break;
      }
    }
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setColor(color: Color): void {
    this.color = color;
  }

  putPen(): void {
    this.penDown = true;
  }

  upPen(): void {
    this.penDown = false;
  }

  rotateCss(): string {
    switch (this.direction) {
      case CharacterDirection.Up: {
        return 'rotate(180deg)';
      }
      case CharacterDirection.Down: {
        return 'rotate(0deg)';
      }
      case CharacterDirection.Left: {
        return 'rotate(90deg)';
      }
      case CharacterDirection.Right: {
        return 'rotate(270deg)';
      }
    }
    return '';
  }

  canMoveForward(gridColumns: number, gridRows: number): boolean {
    switch (this.direction) {
      case CharacterDirection.Up: {
        return this.y > 1;
      }
      case CharacterDirection.Down: {
        return this.y < gridRows;
      }
      case CharacterDirection.Left: {
        return this.x > 1;
      }
      case CharacterDirection.Right: {
        return this.x < gridColumns;
      }
    }
    return false;
  }

  canMoveBack(gridColumns: number, gridRows: number): boolean {
    switch (this.direction) {
      case CharacterDirection.Up: {
        return this.y < gridRows;
      }
      case CharacterDirection.Down: {
        return this.y > 1;
      }
      case CharacterDirection.Left: {
        return this.x < gridColumns;
      }
      case CharacterDirection.Right: {
        return this.x > 1;
      }
    }
    return false;
  }
}
