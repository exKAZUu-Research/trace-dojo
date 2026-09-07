import { z } from 'zod';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
} from '../../constants';
import { charToColor, type TurtleTrace } from '../traceProgram';

const validColorChars = Object.keys(charToColor).join('');

export const JAVA_JUDGE_CLASS_NAME = 'TraceDojoJudge';
export const MAX_JAVA_PROGRAM_LENGTH = 20_000;

const javaExecutionResultSchema = z.object({
  board: z.string(),
  turtles: z.array(z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.string() })),
  exception: z.string().optional(),
});
export type JavaTurtleState = z.infer<typeof javaExecutionResultSchema>;

/**
 * A cheap pre-filter for obviously hostile programs, and the only thing this application does about them: the
 * judge service runs every program on its own machines, so the isolation that matters is not this list. It is
 * deliberately not airtight — the audience is learners of `if` and `for`, and a submission that goes out of its
 * way to defeat the filter only affects its own grade.
 */
const forbiddenPatterns = [
  /\bimport\b/,
  /\bpackage\b/,
  /\bnative\b/,
  /\bjavax?\./,
  /\bsun\./,
  /\bjdk\./,
  /\b(?:Runtime|ProcessBuilder|Process|Thread|ThreadGroup|Class|ClassLoader|Reflect|Unsafe|File|Files|Path|Paths|Socket|URL|URI|Scanner|Console)\b/,
  /\bSystem\s*\.\s*(?!out\b)/,
  // Reflection is the one way an answer could rewrite the state it is judged on, and no answer to a blank needs it.
  /\b(?:getClass|forName|getDeclared\w*|setAccessible)\b/,
];

export function findForbiddenJavaPattern(userProgram: string): string | undefined {
  // Unicode escapes are checked on the raw text; the other names only matter in code, not in literals or comments.
  if (userProgram.includes(String.raw`\u`)) return String.raw`\u`;
  const code = userProgram
    .replaceAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
    .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  return forbiddenPatterns.find((pattern) => pattern.test(code))?.source;
}

function extractPublicClassName(program: string): string | undefined {
  return /\bpublic\s+(?:final\s+)?class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(program)?.[1];
}

/**
 * Builds a single-file Java program that runs the user's program and then reports the final turtle-graphics
 * state after `resultMarker` on standard error. Standard output stays the user's program's own, so whatever it
 * prints there — a learner's own debugging output included — cannot be mistaken for the result.
 */
export function buildJavaJudgeProgram(userProgram: string, resultMarker: string): string {
  const mainClassName = extractPublicClassName(userProgram) ?? 'Main';
  // Both executors run the class named after the source file, and javac allows a single public class per file,
  // so the wrapper is the public one and the template's own declaration — the first one, before the blanks —
  // loses its `public` modifier. A `public class` an answer declares keeps its modifier and fails to compile,
  // which is a verdict of its own.
  return `
public class ${JAVA_JUDGE_CLASS_NAME} {
  public static void main(String[] args) {
    String exception = null;
    try {
      // Launchers may append their own arguments (Wandbox passes the class name), so the program gets none.
      ${mainClassName}.main(new String[0]);
    } catch (Throwable e) {
      exception = e.toString();
    }
    System.out.flush();
    System.err.println();
    System.err.println("${resultMarker}");
    System.err.println(Turtle.dump(exception));
  }
}

${userProgram.trim().replace(/^public\s+(?=(?:abstract\s+|final\s+)*class\b)/m, '')}

class Turtle {
  static final int COLUMNS = ${GRID_COLUMNS};
  static final int ROWS = ${GRID_ROWS};
  private static final char[] DIRS = {'N', 'E', 'S', 'W'};
  private static final int[] DX = {0, 1, 0, -1};
  private static final int[] DY = {1, 0, -1, 0};
  private static final char[][] board = new char[ROWS][COLUMNS];
  private static final java.util.List<Turtle> turtles = new java.util.ArrayList<>();
  static {
    for (char[] row : board) java.util.Arrays.fill(row, '${EMPTY_COLOR}');
  }

  private int x;
  private int y;
  private final char color;
  private char dir = 'N';

  Turtle() { this(0, 0, "${DEFAULT_COLOR}"); }
  Turtle(int x, int y) { this(x, y, "${DEFAULT_COLOR}"); }
  Turtle(int x, int y, String color) {
    if (color == null || color.length() != 1 || "${validColorChars}".indexOf(color.charAt(0)) < 0) {
      throw new RuntimeException("Invalid color: " + color);
    }
    this.x = x;
    this.y = y;
    this.color = color.charAt(0);
    checkBounds();
    board[y][x] = this.color;
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
    board[y][x] = color;
  }
  void forward() { 前に進む(); }
  void 後に戻る() {
    x -= DX[dirIndex()];
    y -= DY[dirIndex()];
    checkBounds();
    board[y][x] = color;
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

export function parseJavaJudgeOutput(output: string, resultMarker: string): JavaTurtleState | undefined {
  const markerIndex = output.lastIndexOf(resultMarker);
  if (markerIndex === -1) return;
  // `Turtle.dump` writes one line, so a thread that outlives the program cannot append to the result.
  const json = output
    .slice(markerIndex + resultMarker.length)
    .trimStart()
    .split('\n')[0];
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
