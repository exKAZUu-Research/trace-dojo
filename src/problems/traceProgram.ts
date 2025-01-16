import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
} from '../constants';

import type { InstantiatedProblem } from './instantiateProblem';
import type { LanguageId } from './problemData';

import type { CellColor, ColorChar } from '@/types';

export interface TurtleTrace {
  x: number;
  y: number;
  /** 色を表現する1文字 */
  color: string;
  /** 方向を表現する1文字 */
  dir: string;
}

export interface TraceItem {
  depth: number;
  sid: number;
  /** caller id のスタック。 `// caller` のある行に caller id が付与される。 */
  callStack: number[];
  vars: TraceItemVariable;
  turtles: TurtleTrace[];
  board: string;
  /** Pythonなどの拡張for文しかない言語において、削除すべき更新式か否か。 */
  last?: boolean;
}

// できる限り、可能性のある型を具体的に列挙していきたい。
export type TraceItemVariable = Record<string, number | string | number[] | string[]>;

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

export function traceProgram(
  this: unknown,
  instrumented: string,
  rawDisplayProgram: string,
  languageId: LanguageId
): InstantiatedProblem {
  if (!instrumented.includes('Turtle')) {
    if (instrumented.includes(' = ')) {
      throw new Error('Instrumented program MUST NOT contain assignment operators (=).');
    }
    if (instrumented.includes('let ') || instrumented.includes('var ') || /(?<!for\s*\()const\s/.test(instrumented)) {
      throw new Error('Instrumented program MUST NOT contain variable declarations.');
    }
  }
  const modifiedCodeLines = modifyCode(instrumented);
  const modifiedCode = modifiedCodeLines.join('\n');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thisPropNames = Object.keys((this as any) || {});
  // 無理に難読化する必要はないが、コードの文量を減らす意識を持つ。
  const executableCode = `
let myGlobal = {};
const trace = [];
const _turtles = [];
const callStack = [];
const thisPropNames = ${JSON.stringify(thisPropNames)};
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
    throw new Error(\`\${varName} is not defined: \${JSON.stringify(s)}\`);
  }
  set(sid, self, varName, value) {
    this.vars[varName] = typeof value === 'number' ? Math.floor(value) : value;
    addTrace(sid, self);
  }
  enterNewScope(params) {
    s = new Scope(this);
    for (const [k, v] of params) {
      s.vars[k] = v;
    }
  }
  leaveScope() {
    if (!this.parent) throw new Error();
    s = this.parent;
  }
  getDepth() {
    let depth = 0;
    let currentScope = this;
    while (currentScope.parent) {
      depth++;
      currentScope = currentScope.parent;
    }
    return depth;
  }
}
const dirs = ['N', 'E', 'S', 'W'];
const dx = [0, 1, 0, -1];
const dy = [1, 0, -1, 0];
const board = Array.from({length: ${GRID_ROWS}}, () => Array.from({length: ${GRID_COLUMNS}}, () => '${EMPTY_COLOR}'));
class Turtle {
  constructor(x = 0, y = 0, color = '${DEFAULT_COLOR}') {
    this.x = x;
    this.y = y;
    if (this.x < 0 || ${GRID_COLUMNS} <= this.x || this.y < 0 || ${GRID_ROWS} <= this.y) {
      throw new Error(\`Out of bounds: (\${this.x}, \${this.y})\`);
    }
    this.color = color;
    this.dir = 'N';
    board[this.y][this.x] = this.color;
    _turtles.push(this);
  }
  前に進む() {
    const index = dirs.indexOf(this.dir);
    this.x += dx[index];
    this.y += dy[index];
    if (this.x < 0 || ${GRID_COLUMNS} <= this.x || this.y < 0 || ${GRID_ROWS} <= this.y) {
      throw new Error(\`Out of bounds: (\${this.x}, \${this.y})\`);
    }
    board[this.y][this.x] = this.color;
  }
  forward(sid, self) {
    this.前に進む();
    addTrace(sid, self);
  }
  後に戻る() {
    const index = dirs.indexOf(this.dir);
    this.x -= dx[index];
    this.y -= dy[index];
    if (this.x < 0 || ${GRID_COLUMNS} <= this.x || this.y < 0 || ${GRID_ROWS} <= this.y) {
      throw new Error(\`Out of bounds: (\${this.x}, \${this.y})\`);
    }
    board[this.y][this.x] = this.color;
  }
  backward(sid, self) {
    this.後に戻る();
    addTrace(sid, self);
  }
  前に進めるか() {
    const index = dirs.indexOf(this.dir);
    const nx = this.x + dx[index];
    const ny = this.y + dy[index];
    const isNoTurtle = !_turtles.some(t => t.x === nx && t.y === ny);
    return isNoTurtle && nx >= 0 && nx < ${GRID_COLUMNS} && ny >= 0 && ny < ${GRID_ROWS};
  }
  canMoveForward() {
    return this.前に進めるか();
  }
  前のマスが塗られているか() {
    const index = dirs.indexOf(this.dir);
    const nx = this.x + dx[index];
    const ny = this.y + dy[index];
    return board[ny][nx] && board[ny][nx] !== '${EMPTY_COLOR}';
  }
  remove() {
    _turtles.splice(_turtles.indexOf(this), 1);
  }
  右を向く() {
    this.dir = dirs[(dirs.indexOf(this.dir) + 1) % 4];
  }
  turnRight(sid, self) {
    this.右を向く();
    addTrace(sid, self);
  }
  左を向く() {
    this.dir = dirs[(dirs.indexOf(this.dir) + 3) % 4];
  }
  turnLeft(sid, self) {
    this.左を向く();
    addTrace(sid, self);
  }
}
function addTrace(sid, self) {
  const vars = {...s.vars, ...myGlobal};
  if (self && self !== globalThis) {
    vars['this'] = {...self};
    for (const name of thisPropNames) delete vars['this'][name];
  }
  flattenObjects(vars);
  trace.push({depth: s.getDepth(), sid, callStack: [...callStack], turtles: _turtles.map(t => ({...t})), vars, board: board.map(r => r.join('')).join('\\n')});
}
function flattenObjects(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Turtle) delete obj[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      delete obj[key];
      for (const [nestKey, nestValue] of Object.entries(value)) {
        if (!(nestValue instanceof Turtle)) obj[\`\${key}.\${nestKey}\`] = nestValue;
      }
    }
  }
}
function checkForCond(cond, sid) {
  if (!cond && trace.at(-1).sid === sid) {
    trace.at(-1).last = true;
  }
  return cond;
}
function call(cid, f, ...argNames) {
  return (...argValues) => {
    if (argNames.length !== argValues.length) {
      throw new Error(\`Expected \${argNames.length} arguments (\${argNames}), got \${argValues.length} (\${argValues}). Fix call() in instrumented code.\`);
    }
    try {
      callStack.push(cid);
      s.enterNewScope(argNames.map((n, i) => [n, argValues[i]]).filter(([n, v]) => !(v instanceof Turtle)));
      return isClass(f) ? new f(...argValues) : f(...argValues);
    } finally {
      callStack.pop();
      s.leaveScope();
    }
  };
}
function isClass(obj) {
  return typeof obj === 'function' && /^class\\s/.test(obj.toString());
}
trace.push({depth: 0, sid: 0, callStack: [], turtles: [], vars: {}, board: board.map(r => r.join('')).join('\\n')});
s = new Scope();
${modifiedCode.trim()}
({trace, finalVars: {...s.vars}});
`;

  const { finalVars, trace: rawTrace } = eval(executableCode) as { trace: TraceItem[]; finalVars: TraceItemVariable };
  const trace = (languageId as string) === 'python' ? rawTrace.filter((item: TraceItem) => !item.last) : rawTrace;

  const lines = rawDisplayProgram.split('\n');
  const refinedLines = [];
  const sidToLineIndex = new Map<number, number>();
  const callerIdToLineIndex = new Map<number, number>();
  let lastSid = 0;
  let lastCallerId = 0;
  for (const [index, line] of lines.entries()) {
    const refinedLine = line
      .replace(/\s*\/\/\s*step\s*(:\s*\d+|)\s*/, (_, sid) => {
        if (sid) {
          lastSid = Number(sid.slice(1));
        } else {
          lastSid++;
        }
        sidToLineIndex.set(lastSid, index + 1);
        return '';
      })
      .replace(/\s*\/\/\s*caller\s*/, (_) => {
        lastCallerId++;
        callerIdToLineIndex.set(lastCallerId, index + 1);
        return '';
      });
    refinedLines.push(refinedLine);
  }

  return {
    languageId,
    displayProgram: refinedLines.join('\n'),
    executableCode,
    traceItems: trace,
    sidToLineIndex,
    callerIdToLineIndex,
    finalVars,
  };
}

function modifyCode(instrumented: string): string[] {
  const modifiedCodeLines = [];
  let statementId = 1;
  let callerId = 1;
  for (const line of instrumented.split('\n')) {
    let statementReplaced = false;
    let callReplaced = false;
    const newLine = line
      // Python向けに最後のループの処理かどうかを判定するために checkForCond を挿入する。
      .replace(/for\s*\(([^;]*);\s*([^;]*);/, (_, init, cond) => `for (${init}; checkForCond(${cond}, ${statementId});`)
      .replaceAll(
        /(\.set|\.forward|\.backward|\.turnRight|\.turnLeft)\(([^\n;]*)\)(;|\)\s*{)/g,
        (_, newOrMethod, args, tail) => {
          statementReplaced = true;
          const delimiter = args === '' ? '' : ', ';
          return `${newOrMethod}(${statementId}, this${delimiter}${args})${tail}`;
        }
      )
      .replace(/\s*\/\/\s*step\s*/, (_) => {
        if ((line.includes('for ') || line.includes('for(')) && !line.includes('{')) {
          throw new Error('for statement must have {');
        }
        if (statementReplaced) return '';

        statementReplaced = true;
        return `addTrace(${statementId}, this);`;
      })
      .replaceAll('call(', (_) => {
        callReplaced = true;
        return `call(${callerId}, `;
      });
    if (statementReplaced) statementId++;
    if (callReplaced) callerId++;
    modifiedCodeLines.push(newLine);
  }
  return modifiedCodeLines;
}
