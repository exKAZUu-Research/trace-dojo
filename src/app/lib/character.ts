import { v4 as uuidv4 } from 'uuid';

import { GRID_COLUMNS, GRID_ROWS } from '../../components/organisms/TurtleGraphics';
import type { CellColor, CharacterDirection } from '../../types';

export class Character {
  id: string;
  name: string;
  x: number;
  y: number;
  direction: CharacterDirection;
  color: CellColor;
  penDown: boolean;

  constructor({
    color = 'red',
    direction = 'down',
    id = uuidv4(),
    name = 'Bear',
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
  }

  moveForward(): void {
    if (!this.canForward()) return;

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
  }

  moveBack(): void {
    if (!this.canMoveBack()) return;

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

  canForward(): boolean {
    switch (this.direction) {
      case 'up': {
        return this.y > 1;
      }
      case 'down': {
        return this.y < GRID_ROWS;
      }
      case 'left': {
        return this.x > 1;
      }
      case 'right': {
        return this.x < GRID_COLUMNS;
      }
    }
  }

  canMoveBack(): boolean {
    switch (this.direction) {
      case 'up': {
        return this.y < GRID_ROWS;
      }
      case 'down': {
        return this.y > 1;
      }
      case 'left': {
        return this.x < GRID_COLUMNS;
      }
      case 'right': {
        return this.x > 1;
      }
    }
  }
}

export function convertCharacterDirectionToCss(ch: Character): string {
  switch (ch.direction) {
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
}
