import type { TurtleTrace } from '../trace';

export const MAX_JAVA_PROGRAM_LENGTH = 20_000;

export function isSameTurtleState(
  expected: { board: string; turtles: TurtleTrace[] },
  actual: { board: string; turtles: TurtleTrace[] }
): boolean {
  return (
    expected.board.trim() === actual.board.trim() &&
    JSON.stringify(expected.turtles.map(pickTurtleTrace)) === JSON.stringify(actual.turtles.map(pickTurtleTrace))
  );
}

function pickTurtleTrace({ color, dir, x, y }: TurtleTrace): TurtleTrace {
  return { x, y, color, dir };
}
