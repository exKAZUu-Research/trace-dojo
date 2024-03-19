import { DEFAULT_COLOR, EMPTY_COLOR, GRID_COLUMNS, GRID_ROWS } from '../components/organisms/TurtleGraphics';
import type { GeneratedProgram } from '../types';

export interface TurtleTrace {
  x: number;
  y: number;
  /** 色を表現する1文字 */
  color: string;
  /** 方向を表現する1文字 */
  dir: string;
  /** ペンが床に触れているか否か */
  pen: boolean;
}

export interface TraceItem {
  sid: number;
  // できる限り、可能性のある型を具体的に列挙していきたい。
  vars: Record<string, number | string | TurtleTrace>;
  board: string;
}

export function traceProgram(program: GeneratedProgram): TraceItem[] {
  if (program.instrumentedProgram.includes(' = ')) {
    throw new Error('Instrumented program MUST NOT contain assignment operators (=).');
  }
  if (
    program.instrumentedProgram.includes('const ') ||
    program.instrumentedProgram.includes('let ') ||
    program.instrumentedProgram.includes('var ')
  ) {
    throw new Error('Instrumented program MUST NOT contain variable declarations.');
  }

  let statementId = 1;
  const modifiedCode = program.instrumentedProgram.replaceAll(
    /\.(set|forward|penDown|penUp|rotateRight|rotateLeft)\(([^\n;]*)\)(;|\)\s*{)/g,
    (_, methodName, args, tail) => {
      const delimiter = args === '' ? '' : ', ';
      // for文の初期化式と更新式は同じステートメントIDを共有する
      if (tail !== ';') statementId--;
      return `.${methodName}(${args}${delimiter}${statementId++})${tail}`;
    }
  );
  // 無理に難読化する必要はないが、コードの文量を減らす意識を持つ。
  const executableCode = `
const trace = [];
let s;
class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = {};
  }
  get(varName) {
    if (this.vars[varName] !== undefined) {
      return this.vars[varName];
    }
    if (this.parent) {
      return this.parent.get(varName);
    }
    throw new Error();
  }
  set(varName, value, sid) {
    if (!this.update(varName, value)) {
      this.vars[varName] = value;
    }
    addTrace(sid);
  }
  update(varName, value) {
    if (this.vars[varName] !== undefined) {
      this.vars[varName] = value;
      return true;
    }
    return this.parent && this.parent.update(varName, value);
  }
  enterNewScope() {
    s = new Scope(this);
  }
  leaveScope() {
    if (!this.parent) throw new Error();
    s = this.parent;
  }
}
const dirs = ['N', 'E', 'S', 'W'];
const dx = [0, 1, 0, -1];
const dy = [-1, 0, 1, 0];
const board = Array.from({ length: ${GRID_ROWS} }, () => Array.from({ length: ${GRID_COLUMNS} }, () => '${EMPTY_COLOR}'));
class Turtle {
  constructor(sid, x = ${Math.floor(GRID_COLUMNS / 2)}, y = ${Math.floor(GRID_ROWS / 2)}, color = '${DEFAULT_COLOR}') {
    this.x = x;
    this.y = y;
    this.color = color;
    this.dir = 'N';
    this.pen = true;
    board[this.y][this.x] = this.color;
  }
  forward(sid) {
    const index = dirs.indexOf(this.dir);
    this.x += dx[index];
    this.y += dy[index];
    if (this.x < 0 || ${GRID_COLUMNS} <= this.x || this.y < 0 || ${GRID_ROWS} <= this.y) {
      throw new Error('Out of bounds');
    }
    board[this.y][this.x] = this.color;
    addTrace(sid);
  }
  penDown(sid) {
    this.pen = true;
    addTrace(sid);
  }
  penUp(sid) {
    this.pen = false;
    addTrace(sid);
  }
  rotateRight(sid) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 1) % 4];
    addTrace(sid);
  }
  rotateLeft(sid) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 3) % 4];
    addTrace(sid);
  }
}
function addTrace(sid) {
  const vars = { ...s.vars };
  for (const key in vars) {
    if (vars[key] instanceof Turtle) vars[key] = { ...vars[key] };
  }
  trace.push({ sid, vars, board: board.map(r => r.join('')).join('\\n') });
}
trace.push({board: board.map(r => r.join('')).join('\\n') });
s = new Scope();
${modifiedCode.trim()}
trace;
`;

  console.log(executableCode); // TODO: remove this later
  return eval(executableCode);
}
