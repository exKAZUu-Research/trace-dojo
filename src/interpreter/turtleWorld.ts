import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as ROWS,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
} from '../constants';
import { charToColor, type TurtleTrace } from '../problems/trace';

export interface TurtleState {
  x: number;
  y: number;
  color: string;
  dir: string;
  isAlive: boolean;
}

const DIRECTIONS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];
const validColors = new Set(Object.keys(charToColor));

/**
 * The board and the turtles on it, shared by every language's interpreter.
 *
 * Operations a program may get wrong return the message of the exception the interpreter throws, so that each
 * language reports it with its own exception type.
 */
export class TurtleWorld {
  readonly board: string[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, () => EMPTY_COLOR));
  private turtles: TurtleState[] = [];

  /** Places a new turtle facing north and paints its cell; `color` is undefined for the default color. */
  create(x: number, y: number, color: string | undefined): TurtleState | { error: string } {
    const colorText = color ?? DEFAULT_COLOR;
    if (!validColors.has(colorText) || colorText === EMPTY_COLOR) return { error: `Invalid color: ${colorText}` };
    const turtle: TurtleState = { x, y, color: colorText, dir: 'N', isAlive: true };
    const error = outOfBounds(turtle);
    if (error) return { error };
    this.board[y][x] = colorText;
    this.turtles.push(turtle);
    return turtle;
  }

  /** Moves a turtle one cell forward (`sign` 1) or backward (-1) and paints the cell it reaches. */
  move(turtle: TurtleState, sign: number): string | undefined {
    const index = DIRECTIONS.indexOf(turtle.dir);
    turtle.x += sign * DX[index];
    turtle.y += sign * DY[index];
    // The turtle keeps its position outside the board, as the exception leaves it.
    const error = outOfBounds(turtle);
    if (error) return error;
    this.board[turtle.y][turtle.x] = turtle.color;
  }

  /** Turns a turtle clockwise by `quarters` quarter turns. */
  turn(turtle: TurtleState, quarters: number): void {
    turtle.dir = DIRECTIONS[(DIRECTIONS.indexOf(turtle.dir) + quarters) % 4];
  }

  /** Whether the cell ahead is on the board and free of turtles, counting only those {@link retain} kept. */
  canMoveForward(turtle: TurtleState): boolean {
    const { x, y } = cellAhead(turtle);
    return isOnBoard(x, y) && !this.turtles.some((other) => other.x === x && other.y === y);
  }

  isFrontPainted(turtle: TurtleState): boolean {
    const { x, y } = cellAhead(turtle);
    return isOnBoard(x, y) && this.board[y][x] !== EMPTY_COLOR;
  }

  remove(turtle: TurtleState): void {
    turtle.isAlive = false;
    this.turtles = this.turtles.filter((other) => other !== turtle);
  }

  /** Removes the turtles a program can no longer reach. */
  retain(reached: (turtle: TurtleState) => boolean): void {
    for (const turtle of this.turtles) if (!reached(turtle)) turtle.isAlive = false;
    this.turtles = this.turtles.filter((turtle) => turtle.isAlive);
  }

  get hasTurtles(): boolean {
    return this.turtles.length > 0;
  }

  boardText(): string {
    return this.board.map((row) => row.join('')).join('\n');
  }

  turtleTraces(): TurtleTrace[] {
    return this.turtles.map(({ color, dir, x, y }) => ({ x, y, color, dir }));
  }
}

function cellAhead(turtle: TurtleState): { x: number; y: number } {
  const index = DIRECTIONS.indexOf(turtle.dir);
  return { x: turtle.x + DX[index], y: turtle.y + DY[index] };
}

function isOnBoard(x: number, y: number): boolean {
  return x >= 0 && x < COLUMNS && y >= 0 && y < ROWS;
}

function outOfBounds({ x, y }: TurtleState): string | undefined {
  if (!isOnBoard(x, y)) return `Out of bounds: (${x}, ${y})`;
}
