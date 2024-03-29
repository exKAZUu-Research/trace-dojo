import {
  TURTLE_GRAPHICS_GRID_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_GRID_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
} from '../constants';
import type { CellColor, ColorChar } from '../types';

import type { Problem } from './generateProblem';
import type { LanguageId } from './problemData';

export interface CharacterTrace {
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
  vars: TraceItemVar;
  board: string;
  /** Pythonなどの拡張for文しかない言語において、削除すべき更新式か否か。 */
  last?: boolean;
}

// できる限り、可能性のある型を具体的に列挙していきたい。
export type TraceItemVar = Record<string, number | string | CharacterTrace>;

export const charToColor = {
  '#': 'black',
  '.': 'white',
  R: 'red',
  G: 'green',
  B: 'blue',
  Y: 'yellow',
  P: 'purple',
} as const;

export const colorToChar = Object.fromEntries(
  Object.entries(charToColor).map(([char, color]) => [color, char])
) as Record<CellColor, ColorChar>;

export function traceProgram(instrumented: string, rawDisplayProgram: string, languageId: LanguageId): Problem {
  if (instrumented.includes(' = ')) {
    throw new Error('Instrumented program MUST NOT contain assignment operators (=).');
  }
  if (instrumented.includes('const ') || instrumented.includes('let ') || instrumented.includes('var ')) {
    throw new Error('Instrumented program MUST NOT contain variable declarations.');
  }

  const checkpointSids: number[] = [];

  let statementId = 1;
  const modifiedCodeLines = [];
  for (const line of instrumented.split('\n')) {
    let replaced = false;
    const newLine = line
      .replace(/for\s*\(([^;]*);\s*([^;]*);/, (_, init, cond) => `for (${init}; checkForCond(${cond}, ${statementId});`)
      .replaceAll(
        /\.(set|forward|penDown|penUp|turnRight|turnLeft)\(([^\n;]*)\)(;|\)\s*{)/g,
        (_, methodName, args, tail) => {
          replaced = true;
          const delimiter = args === '' ? '' : ', ';
          return `.${methodName}(${args}${delimiter}${statementId})${tail}`;
        }
      )
      .replace(/\/\/\s*CP.*/, () => {
        checkpointSids.push(statementId);
        return '';
      });
    if (replaced) statementId++;
    modifiedCodeLines.push(newLine);
  }
  const modifiedCode = modifiedCodeLines.join('\n');
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
class Character {
  constructor(x = ${Math.floor(GRID_COLUMNS / 2)}, y = ${Math.floor(GRID_ROWS / 2)}, color = '${DEFAULT_COLOR}') {
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
    if (this.pen) board[this.y][this.x] = this.color;
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
  turnRight(sid) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 1) % 4];
    addTrace(sid);
  }
  turnLeft(sid) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 3) % 4];
    addTrace(sid);
  }
}
function addTrace(sid) {
  const vars = { ...s.vars };
  for (const key in vars) {
    if (vars[key] instanceof Character) vars[key] = { ...vars[key] };
  }
  trace.push({ sid, vars, board: board.map(r => r.join('')).join('\\n') });
}
function checkForCond(cond, sid) {
  if (!cond && trace.at(-1).sid === sid) {
    trace.at(-1).last = true;
  }
  return cond;
}
trace.push({sid: 0, board: board.map(r => r.join('')).join('\\n') });
s = new Scope();
${modifiedCode.trim()}
trace;
`;
  console.log(executableCode); // TODO: remove this later

  let trace = eval(executableCode) as TraceItem[];
  if ((languageId as string) === 'python') {
    trace = trace.filter((item: TraceItem) => !item.last);
  }

  const lines = rawDisplayProgram.split('\n');
  const refinedLines = [];
  const sidToLineIndex = new Map<number, number>();
  let lastSid = 0;
  for (const [index, line] of lines.entries()) {
    const refinedLine = line.replace(/\s*\/\/\s*sid\s*(:\s*\d+|)\s*/, (_, sid) => {
      if (sid) {
        lastSid = Number(sid.slice(1));
      } else {
        lastSid++;
      }
      sidToLineIndex.set(lastSid, index + 1);
      return '';
    });
    refinedLines.push(refinedLine);
  }

  return { languageId, displayProgram: refinedLines.join('\n'), traceItems: trace, sidToLineIndex, checkpointSids };
}
