const trace = [];
const turtles = [];
const callStack = [];
const thisPropNames = ['charToColor', 'colorToChar', 'traceProgram'];
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
    throw new Error(`${varName} is not defined: ${JSON.stringify(s)}`);
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
const board = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => '.'));
class Turtle {
  constructor(x = 0, y = 0, color = '#') {
    this.x = x;
    this.y = y;
    this.color = color;
    this.dir = 'N';
    board[this.y][this.x] = this.color;
    turtles.push(this);
  }
  forward(sid, self) {
    const index = dirs.indexOf(this.dir);
    this.x += dx[index];
    this.y += dy[index];
    if (this.x < 0 || 7 <= this.x || this.y < 0 || 7 <= this.y) {
      throw new Error(`Out of bounds: (${this.x}, ${this.y})`);
    }
    board[this.y][this.x] = this.color;
    addTrace(sid, self);
  }
  backward(sid, self) {
    const index = dirs.indexOf(this.dir);
    this.x -= dx[index];
    this.y -= dy[index];
    if (this.x < 0 || 7 <= this.x || this.y < 0 || 7 <= this.y) {
      throw new Error(`Out of bounds: (${this.x}, ${this.y})`);
    }
    board[this.y][this.x] = this.color;
    addTrace(sid, self);
  }
  canMoveForward() {
    const index = dirs.indexOf(this.dir);
    const nx = this.x + dx[index];
    const ny = this.y + dy[index];
    return nx >= 0 && nx < 7 && ny >= 0 && ny < 7;
  }
  turnRight(sid, self) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 1) % 4];
    addTrace(sid, self);
  }
  turnLeft(sid, self) {
    this.dir = dirs[(dirs.indexOf(this.dir) + 3) % 4];
    addTrace(sid, self);
  }
}
function addTrace(sid, self) {
  const vars = { ...s.vars, ...(typeof myGlobal !== 'undefined' && myGlobal) };
  if (self && self !== globalThis) {
    vars['this'] = { ...self };
    for (const name of thisPropNames) delete vars['this'][name];
  }
  flattenObjects(vars);
  trace.push({
    depth: s.getDepth(),
    sid,
    callStack: [...callStack],
    turtles: turtles.map((t) => ({ ...t })),
    vars,
    board: board.map((r) => r.join('')).join('\n'),
  });
}
function flattenObjects(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Turtle) delete obj[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      delete obj[key];
      for (const [nestKey, nestValue] of Object.entries(value)) {
        if (!(nestValue instanceof Turtle)) obj[`${key}.${nestKey}`] = nestValue;
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
      throw new Error(
        `Expected ${argNames.length} arguments (${argNames}), got ${argValues.length} (${argValues}). Fix call() in instrumented code.`
      );
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
  return typeof obj === 'function' && /^class\s/.test(obj.toString());
}
trace.push({ depth: 0, sid: 0, callStack: [], turtles: [], vars: {}, board: board.map((r) => r.join('')).join('\n') });
s = new Scope();
myGlobal = { Settings: { speed: 3 } };

function main() {
  const t1 = call(1, MyTurtle)();
  addTrace(1, this);
  call(2, t1.moveForward.bind(t1))();
  myGlobal.Settings.speed = 2;
  addTrace(2, this);
  const t2 = call(3, MyTurtle)();
  addTrace(3, this);
  call(4, t1.moveForward.bind(t1))();
  call(5, t2.moveForward.bind(t2))();
}

class MyTurtle {
  constructor() {
    this.t = new Turtle();
  }
  moveForward() {
    for (
      s.set(4, this, 'i', 0);
      checkForCond(s.get('i') < myGlobal.Settings.speed, 4);
      s.set(4, this, 'i', s.get('i') + 1)
    ) {
      this.t.forward(5, this);
    }
    delete s.vars['i'];
  }
}

main();
console.log({ trace, finalVars: { ...s.vars } });
