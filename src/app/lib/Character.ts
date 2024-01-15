export class Character {
  id: number;
  name: string;
  x: number;
  y: number;
  direction: string;
  color: string;
  penDown: boolean;
  path: string[];

  constructor(
    id: number,
    name: string,
    x: number,
    y: number,
    direction: string,
    color: string,
    penDown: boolean,
    path: string[]
  ) {
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
        if (this.y <= 0) return;

        this.y -= 1;
        break;
      }
      case 'down': {
        if (this.y >= gridRows - 1) return;

        this.y += 1;
        break;
      }
      case 'left': {
        if (this.x <= 0) return;

        this.x -= 1;
        break;
      }
      case 'right': {
        if (this.x >= gridColumns - 1) return;

        this.x += 1;
        break;
      }
    }

    if (this.penDown) {
      this.path.push(`${this.x},${this.y}`);
    }
  }

  moveBack(gridColumns: number, gridRows: number): void {
    switch (this.direction) {
      case 'up': {
        if (this.y >= gridRows - 1) return;

        this.y += 1;
        break;
      }
      case 'down': {
        if (this.y <= 0) return;

        this.y -= 1;
        break;
      }
      case 'left': {
        if (this.x >= gridColumns - 1) return;

        this.x += 1;
        break;
      }
      case 'right': {
        if (this.x <= 0) return;

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

  putPen(): void {
    this.penDown = true;
  }

  upPen(): void {
    this.penDown = false;
  }
}
