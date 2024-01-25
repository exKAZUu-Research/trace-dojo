import { v4 as uuidv4 } from 'uuid';

import type { CellColor, CharacterDirection } from '../../types';

export class Character {
  id: string;
  name: string;
  x: number;
  y: number;
  direction: CharacterDirection;
  color: CellColor;
  penDown: boolean;
  path: string[];

  constructor({
    color = 'red',
    direction = 'down',
    id = uuidv4(),
    name = 'Bear',
    path = ['1,1'],
    penDown = true,
    x = 1,
    y = 1,
  }: {
    id?: string;
    name?: string;
    x?: number;
    y?: number;
    direction?: CharacterDirection;
    color?: CellColor;
    penDown?: boolean;
    path?: string[];
  } = {}) {
    this.id = id;
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
      case 'up': {
        this.y -= 1;
        break;
      }
      case 'down': {
        this.y += 1;
        break;
      }
      case 'left': {
        this.x -= 1;
        break;
      }
      case 'right': {
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
      case 'up': {
        this.y += 1;
        break;
      }
      case 'down': {
        this.y -= 1;
        break;
      }
      case 'left': {
        this.x += 1;
        break;
      }
      case 'right': {
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
      case 'up': {
        this.direction = 'left';
        break;
      }
      case 'down': {
        this.direction = 'right';
        break;
      }
      case 'left': {
        this.direction = 'down';
        break;
      }
      case 'right': {
        this.direction = 'up';
        break;
      }
    }
  }

  turnRight(): void {
    switch (this.direction) {
      case 'up': {
        this.direction = 'right';
        break;
      }
      case 'down': {
        this.direction = 'left';
        break;
      }
      case 'left': {
        this.direction = 'up';
        break;
      }
      case 'right': {
        this.direction = 'down';
        break;
      }
    }
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setColor(color: CellColor): void {
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
      case 'up': {
        return 'rotate(180deg)';
      }
      case 'down': {
        return 'rotate(0deg)';
      }
      case 'left': {
        return 'rotate(90deg)';
      }
      case 'right': {
        return 'rotate(270deg)';
      }
    }
    return '';
  }

  canMoveForward(gridColumns: number, gridRows: number): boolean {
    switch (this.direction) {
      case 'up': {
        return this.y > 1;
      }
      case 'down': {
        return this.y < gridRows;
      }
      case 'left': {
        return this.x > 1;
      }
      case 'right': {
        return this.x < gridColumns;
      }
    }
    return false;
  }

  canMoveBack(gridColumns: number, gridRows: number): boolean {
    switch (this.direction) {
      case 'up': {
        return this.y < gridRows;
      }
      case 'down': {
        return this.y > 1;
      }
      case 'left': {
        return this.x < gridColumns;
      }
      case 'right': {
        return this.x > 1;
      }
    }
    return false;
  }
}
