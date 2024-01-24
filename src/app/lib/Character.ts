import type { CellColor as Color } from '../../types';

export class Character {
  id: number;
  name: string;
  x: number;
  y: number;
  direction: string;
  color: Color;
  penDown: boolean;
  path: [number, number];

  constructor({
    color = 'red',
    direction = 'down',
    id = 1,
    name = 'Bear',
    path = [1, 1],
    penDown = true,
    x = 1,
    y = 1,
  }: {
    id?: number;
    name?: string;
    x?: number;
    y?: number;
    direction?: string;
    color?: Color;
    penDown?: boolean;
    path?: [number, number];
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
    switch (this.direction) {
      case 'up': {
        if (this.y <= 1) return;

        this.y -= 1;
        break;
      }
      case 'down': {
        if (this.y >= gridRows) return;

        this.y += 1;
        break;
      }
      case 'left': {
        if (this.x <= 1) return;

        this.x -= 1;
        break;
      }
      case 'right': {
        if (this.x >= gridColumns) return;

        this.x += 1;
        break;
      }
    }

    if (this.penDown) {
      this.path = [this.x, this.y];
    }
  }

  moveBack(gridColumns: number, gridRows: number): void {
    switch (this.direction) {
      case 'up': {
        if (this.y >= gridRows) return;

        this.y += 1;
        break;
      }
      case 'down': {
        if (this.y <= 1) return;

        this.y -= 1;
        break;
      }
      case 'left': {
        if (this.x >= gridColumns) return;

        this.x += 1;
        break;
      }
      case 'right': {
        if (this.x <= 1) return;

        this.x -= 1;
        break;
      }
    }

    if (this.penDown) {
      this.path = [this.x, this.y];
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

  putPen(): void {
    this.penDown = true;
  }

  upPen(): void {
    this.penDown = false;
  }
}
