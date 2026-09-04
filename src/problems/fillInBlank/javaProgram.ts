import { z } from 'zod';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
} from '../../constants';
import type { TurtleTrace } from '../traceProgram';

export const JAVA_JUDGE_CLASS_NAME = 'TraceDojoJudge';
export const JAVA_RESULT_MARKER = '__TRACE_DOJO_RESULT__';
export const MAX_JAVA_PROGRAM_LENGTH = 20_000;

const javaExecutionResultSchema = z.object({
  board: z.string(),
  turtles: z.array(z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.string() })),
  exception: z.string().optional(),
});
export type JavaTurtleState = z.infer<typeof javaExecutionResultSchema>;

// Only a closed set of turtle-graphics programs is expected, so anything touching the JDK beyond the basics is rejected.
const forbiddenPatterns = [
  /\bimport\b/,
  /\bpackage\b/,
  /\bnative\b/,
  /\bjavax?\./,
  /\bsun\./,
  /\bjdk\./,
  /\b(?:Runtime|ProcessBuilder|Process|Thread|ThreadGroup|Class|ClassLoader|Reflect|Unsafe|File|Files|Path|Paths|Socket|URL|URI|Scanner|Console)\b/,
  /\bSystem\s*\.\s*(?!out\b)/,
];

export function findForbiddenJavaPattern(userProgram: string): string | undefined {
  return forbiddenPatterns.find((pattern) => pattern.test(userProgram))?.source;
}

export function extractPublicClassName(program: string): string | undefined {
  return /\bpublic\s+(?:final\s+)?class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(program)?.[1];
}

/**
 * Builds a single-file Java program that runs the user's program and then prints the final turtle-graphics state.
 * The judge class is declared first so that `java <file>` (source-file mode) launches it.
 */
export function buildJavaJudgeProgram(userProgram: string): string {
  const mainClassName = extractPublicClassName(userProgram) ?? 'Main';
  return `
class ${JAVA_JUDGE_CLASS_NAME} {
  public static void main(String[] args) {
    String exception = null;
    try {
      ${mainClassName}.main(args);
    } catch (Throwable e) {
      exception = e.toString();
    }
    System.out.flush();
    System.out.println();
    System.out.println("${JAVA_RESULT_MARKER}");
    System.out.println(Turtle.dump(exception));
  }
}

${userProgram.trim()}

class Turtle {
  static final int COLUMNS = ${GRID_COLUMNS};
  static final int ROWS = ${GRID_ROWS};
  static final char[] DIRS = {'N', 'E', 'S', 'W'};
  static final int[] DX = {0, 1, 0, -1};
  static final int[] DY = {1, 0, -1, 0};
  static final char[][] board = new char[ROWS][COLUMNS];
  static final java.util.List<Turtle> turtles = new java.util.ArrayList<>();
  static {
    for (char[] row : board) java.util.Arrays.fill(row, '${EMPTY_COLOR}');
  }

  int x;
  int y;
  String color;
  char dir = 'N';

  Turtle() { this(0, 0, "${DEFAULT_COLOR}"); }
  Turtle(int x, int y) { this(x, y, "${DEFAULT_COLOR}"); }
  Turtle(int x, int y, String color) {
    this.x = x;
    this.y = y;
    this.color = color;
    checkBounds();
    board[y][x] = color.charAt(0);
    turtles.add(this);
  }

  private void checkBounds() {
    if (x < 0 || COLUMNS <= x || y < 0 || ROWS <= y) {
      throw new RuntimeException("Out of bounds: (" + x + ", " + y + ")");
    }
  }
  private int dirIndex() { return new String(DIRS).indexOf(dir); }

  void 前に進む() {
    x += DX[dirIndex()];
    y += DY[dirIndex()];
    checkBounds();
    board[y][x] = color.charAt(0);
  }
  void forward() { 前に進む(); }
  void 後に戻る() {
    x -= DX[dirIndex()];
    y -= DY[dirIndex()];
    checkBounds();
    board[y][x] = color.charAt(0);
  }
  void backward() { 後に戻る(); }
  boolean 前に進めるか() {
    int nx = x + DX[dirIndex()];
    int ny = y + DY[dirIndex()];
    for (Turtle t : turtles) if (t.x == nx && t.y == ny) return false;
    return nx >= 0 && nx < COLUMNS && ny >= 0 && ny < ROWS;
  }
  boolean canMoveForward() { return 前に進めるか(); }
  boolean 前のマスが塗られているか() {
    int nx = x + DX[dirIndex()];
    int ny = y + DY[dirIndex()];
    return nx >= 0 && nx < COLUMNS && ny >= 0 && ny < ROWS && board[ny][nx] != '${EMPTY_COLOR}';
  }
  void remove() { turtles.remove(this); }
  void 右を向く() { dir = DIRS[(dirIndex() + 1) % 4]; }
  void turnRight() { 右を向く(); }
  void 左を向く() { dir = DIRS[(dirIndex() + 3) % 4]; }
  void turnLeft() { 左を向く(); }

  static String dump(String exception) {
    StringBuilder sb = new StringBuilder("{\\"board\\":\\"");
    for (int i = 0; i < ROWS; i++) {
      if (i > 0) sb.append("\\\\n");
      sb.append(board[i]);
    }
    sb.append("\\",\\"turtles\\":[");
    for (int i = 0; i < turtles.size(); i++) {
      Turtle t = turtles.get(i);
      if (i > 0) sb.append(',');
      sb.append("{\\"x\\":").append(t.x).append(",\\"y\\":").append(t.y)
        .append(",\\"color\\":\\"").append(t.color).append("\\",\\"dir\\":\\"").append(t.dir).append("\\"}");
    }
    sb.append(']');
    if (exception != null) {
      sb.append(",\\"exception\\":\\"").append(exception.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replaceAll("[\\\\r\\\\n\\\\t]", " ")).append('"');
    }
    return sb.append('}').toString();
  }
}
`.trim();
}

export function parseJavaJudgeOutput(stdout: string): JavaTurtleState | undefined {
  const markerIndex = stdout.lastIndexOf(JAVA_RESULT_MARKER);
  if (markerIndex === -1) return;
  const json = stdout.slice(markerIndex + JAVA_RESULT_MARKER.length).trim();
  try {
    return javaExecutionResultSchema.parse(JSON.parse(json));
  } catch {
    return;
  }
}

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
