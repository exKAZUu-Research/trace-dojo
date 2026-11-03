import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** Programs that behave alike in both languages, so JavaScript must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'moves, turns, and colors',
    java: javaMain(`
    Turtle 亀 = new Turtle(2, 1, "R"); // step
    亀.前に進む(); // step
    亀.右を向く(); // step
    亀.forward(); // step
    亀.turnLeft(); // step
    亀.後に戻る(); // step`),
    javascript: `
const 亀 = new Turtle(2, 1, 'R'); // step
亀.前に進む(); // step
亀.右を向く(); // step
亀.forward(); // step
亀.turnLeft(); // step
亀.後に戻る(); // step`,
  },
  {
    name: 'loops, conditions, and variables',
    java: javaMain(`
    Turtle t = new Turtle(); // step
    int n = 4; // step
    for (int i = 0; i < n; i++) { // step
      if (i % 2 == 0) {
        t.forward(); // step
      } else if (i == 3) {
        t.turnRight(); // step
      } else {
        continue;
      }
      n = n - 0; // step
    }
    int k = 0; // step
    while (k < 2) {
      k++; // step
    }
    do {
      k--; // step
    } while (k > 0);
    String label = "k=" + k; // step
    boolean done = true; // step`),
    javascript: `
const t = new Turtle(); // step
let n = 4; // step
for (let i = 0; i < n; i++) { // step
  if (i % 2 === 0) {
    t.forward(); // step
  } else if (i === 3) {
    t.turnRight(); // step
  } else {
    continue;
  }
  n = n - 0; // step
}
let k = 0; // step
while (k < 2) {
  k++; // step
}
do {
  k--; // step
} while (k > 0);
const label = 'k=' + k; // step
const done = true; // step`,
  },
  {
    name: 'switch, labeled break, and nested loops',
    java: javaMain(`
    Turtle t = new Turtle(1, 1); // step
    int total = 0; // step
    outer:
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 3; j++) {
        if (i + j > 2) break outer;
        total += i * j; // step
      }
    }
    switch (total) {
      case 1:
        t.forward(); // step
        break;
      case 2:
        t.turnRight(); // step
      default:
        t.forward(); // step
    }`),
    javascript: `
const t = new Turtle(1, 1); // step
let total = 0; // step
outer:
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (i + j > 2) break outer;
    total += i * j; // step
  }
}
switch (total) {
  case 1:
    t.forward(); // step
    break;
  case 2:
    t.turnRight(); // step
  default:
    t.forward(); // step
}`,
  },
  {
    name: 'arrays and strings',
    java: javaMain(`
    int[] values = { 3, 1, 2 }; // step
    int[][] grid = { { 1, 2 }, { 3, 4 } }; // step
    String[] names = { "a", null }; // step
    values[1] = values[0] + values[2]; // step
    grid[1][0] = 9; // step
    String text = "x" + values.length; // step`),
    javascript: `
const values = [3, 1, 2]; // step
const grid = [[1, 2], [3, 4]]; // step
const names = ['a', null]; // step
values[1] = values[0] + values[2]; // step
grid[1][0] = 9; // step
const text = 'x' + values.length; // step`,
  },
  {
    name: 'turtles that become unreachable disappear',
    java: javaMain(`
    Turtle t = new Turtle(); // step
    t.forward(); // step
    t = new Turtle(3, 3, "B"); // step
    t.forward(); // step
    Turtle u = new Turtle(5, 5); // step
    u.remove(); // step`),
    javascript: `
let t = new Turtle(); // step
t.forward(); // step
t = new Turtle(3, 3, 'B'); // step
t.forward(); // step
const u = new Turtle(5, 5); // step
u.remove(); // step`,
  },
  {
    name: 'turtles that block each other',
    java: javaMain(`
    Turtle a = new Turtle(0, 0); // step
    Turtle b = new Turtle(0, 2, "G"); // step
    while (a.前に進めるか()) {
      a.前に進む(); // step
    }
    boolean painted = a.前のマスが塗られているか(); // step`),
    javascript: `
const a = new Turtle(0, 0); // step
const b = new Turtle(0, 2, 'G'); // step
while (a.前に進めるか()) {
  a.前に進む(); // step
}
const painted = a.前のマスが塗られているか(); // step`,
  },
  {
    name: 'calls with caller annotations',
    java: javaMain(
      `
    draw(new Turtle(1, 0), 2); // caller // step
    draw(new Turtle(3, 0), 1); // caller // step`,
      `
  static int draw(Turtle t, int length) {
    for (int i = 0; i < length; i++) {
      t.forward(); // step
    }
    t.turnRight(); // step
    return length * 2; // step
  }`
    ),
    javascript: `
draw(new Turtle(1, 0), 2); // caller // step
draw(new Turtle(3, 0), 1); // caller // step
function draw(t, length) {
  for (let i = 0; i < length; i++) {
    t.forward(); // step
  }
  t.turnRight(); // step
  return length * 2; // step
}`,
  },
  {
    name: 'a caught exception and an uncaught one',
    java: javaMain(`
    Turtle t = new Turtle(0, 5); // step
    try {
      t.forward(); // step
      t.forward(); // step
      t.forward(); // step
    } catch (RuntimeException e) {
      t.turnRight(); // step
    }
    t.turnRight(); // step
    t.forward(); // step
    t.turnRight(); // step
    t.forward(); // step
    t.forward(); // step
    t.forward(); // step
    t.forward(); // step
    t.forward(); // step
    t.forward(); // step`),
    javascript: `
const t = new Turtle(0, 5); // step
try {
  t.forward(); // step
  t.forward(); // step
  t.forward(); // step
} catch (e) {
  t.turnRight(); // step
}
t.turnRight(); // step
t.forward(); // step
t.turnRight(); // step
t.forward(); // step
t.forward(); // step
t.forward(); // step
t.forward(); // step
t.forward(); // step
t.forward(); // step`,
  },
])('JavaScript traces $name as Java does', ({ java, javascript }) => {
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('javascript', javascript, javascript);
  expect(actual.traceItems).toEqual(expected.traceItems);
  expect(actual.finalBoard).toBe(expected.finalBoard);
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
  expect(actual.finalVars).toEqual(expected.finalVars);
  expect([...actual.sidToLineIndex.keys()]).toEqual([...expected.sidToLineIndex.keys()]);
  expect(actual.uncaughtException === undefined).toBe(expected.uncaughtException === undefined);
});

test('an uncaught exception is described as JavaScript prints it', () => {
  const program = `const t = new Turtle(0, 6);
t.forward();`;
  expect(traceProgram('javascript', program, program).uncaughtException).toBe('Error: Out of bounds: (0, 7)');
});

const turtle = (y: number): unknown => ({
  kind: 'object',
  entries: { x: { kind: 'value', value: 0 }, y: { kind: 'value', value: y } },
});
const walker = (y: number, moved: number): unknown => ({
  kind: 'object',
  entries: { turtle: turtle(y), '#moved': { kind: 'value', value: moved } },
});
test('a function shows its own variables, then the outer variables it can see, then the fields of this', () => {
  const program = `const step = 2; // step
let count = 0; // step
class Walker {
  #moved = 0;
  constructor(turtle) {
    this.turtle = turtle; // step
  }
  walk(times) {
    for (let i = 0; i < times; i++) {
      this.turtle.forward(); // step
      this.#moved += step; // step
      count++; // step
    }
  }
}
const walker = new Walker(new Turtle()); // caller // step
walker.walk(1); // caller // step`;
  const trace = traceProgram('javascript', program, program);

  expect(
    trace.traceItems.map(({ depth, sid, callStack, vars, referenceVars }) => ({
      depth,
      sid,
      callStack,
      vars,
      referenceVars,
    }))
  ).toEqual([
    { depth: 0, sid: 0, callStack: [], vars: {}, referenceVars: {} },
    { depth: 0, sid: 1, callStack: [], vars: { step: 2 }, referenceVars: {} },
    { depth: 0, sid: 2, callStack: [], vars: { step: 2, count: 0 }, referenceVars: {} },
    {
      depth: 1,
      sid: 3,
      callStack: [1],
      vars: { step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { turtle: turtle(0), this: walker(0, 0) },
    },
    {
      depth: 0,
      sid: 7,
      callStack: [],
      vars: { step: 2, count: 0 },
      referenceVars: { walker: walker(0, 0) },
    },
    {
      depth: 1,
      sid: 4,
      callStack: [2],
      vars: { times: 1, i: 0, step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { walker: walker(1, 0), this: walker(1, 0) },
    },
    {
      depth: 1,
      sid: 5,
      callStack: [2],
      vars: { times: 1, i: 0, step: 2, count: 0, 'this.#moved': 2 },
      referenceVars: { walker: walker(1, 2), this: walker(1, 2) },
    },
    {
      depth: 1,
      sid: 6,
      callStack: [2],
      vars: { times: 1, i: 0, step: 2, count: 1, 'this.#moved': 2 },
      referenceVars: { walker: walker(1, 2), this: walker(1, 2) },
    },
    {
      depth: 0,
      sid: 8,
      callStack: [],
      vars: { step: 2, count: 1 },
      referenceVars: { walker: walker(1, 2) },
    },
  ]);
  expect(trace.finalVars).toEqual({ step: 2, count: 1 });
});

test('callbacks that builtins call count as calls from the row that called the builtin', () => {
  const program = `const t = new Turtle();
[1, 2].forEach((n) => { // caller
  t.forward(); // step
});`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ depth, callStack, vars }) => ({ depth, callStack, vars }))).toEqual([
    { depth: 0, callStack: [], vars: {} },
    { depth: 1, callStack: [1], vars: { n: 1 } },
    { depth: 1, callStack: [1], vars: { n: 2 } },
  ]);
});

test('a step annotation belongs to the innermost statement on its row', () => {
  const program = `const t = new Turtle();
const moves = [1, 2].map((n) => {
  t.forward(); // step
  return n * 2;
}); // step`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ sid, vars }) => ({ sid, vars }))).toEqual([
    { sid: 0, vars: {} },
    { sid: 1, vars: { n: 1 } },
    { sid: 1, vars: { n: 2 } },
    { sid: 2, vars: { moves: [2, 4] } },
  ]);
});

test('variables appear once their declaration runs, and functions and classes are not variables', () => {
  const program = `const t = new Turtle(); // step
var later = 1; // step
function helper() {}
class Shape {}
const callback = () => helper(); // step
let pending = undefined; // step`;
  const trace = traceProgram('javascript', program, program);
  expect(
    trace.traceItems.map(({ vars, referenceVars }) => ({ vars, referenceVars: Object.keys(referenceVars) }))
  ).toEqual([
    { vars: {}, referenceVars: [] },
    { vars: {}, referenceVars: ['t'] },
    { vars: { later: 1 }, referenceVars: ['t'] },
    { vars: { later: 1 }, referenceVars: ['t'] },
    { vars: { later: 1 }, referenceVars: ['t', 'pending'] },
  ]);
});

test('each loop iteration keeps its own let variable, which closures capture', () => {
  const program = `const getters = [];
for (let i = 0; i < 3; i++) {
  getters.push(() => i);
}
const values = getters.map((get) => get()); // step`;
  expect(traceProgram('javascript', program, program).finalVars).toEqual({ values: [0, 1, 2] });
});

test('display programs keep their placeholders and lose their annotations', () => {
  const program = `const t = new Turtle(); // step
t.forward(); // caller // step`;
  const displayProgram = `const t = new Turtle(); // step
t.【1】(); // caller // step`;
  const trace = traceProgram('javascript', program, displayProgram);
  expect(trace.displayProgram).toBe('const t = new Turtle();\nt.【1】();');
  expect([...trace.sidToLineIndex]).toEqual([
    [1, 1],
    [2, 2],
  ]);
  expect([...trace.callerIdToLineIndex]).toEqual([[1, 2]]);
});

test.each([
  ['a row without a statement that records a step', 'let i = 0;\nwhile (i < 3) { // step\n  i++;\n}', '// step は'],
  ['a declaration without an initializer', 'let i; // step', '// step は'],
  ['invalid syntax', 'const t = new Turtle(;', '「)」が足りません'],
])('a model program with %s is rejected', (_, program, message) => {
  expect(() => traceProgram('javascript', program, program)).toThrow(message);
});

test('a value that a finally block delays keeps its turtle while the block records steps', () => {
  const program = `function make() {
  try {
    return new Turtle();
  } finally {
    const done = true; // step
  }
}
const t = make(); // step`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 1]);
  expect(trace.finalTurtles).toHaveLength(1);
});

test.each([
  [
    'a bound function',
    'function move(t) {\n  t.forward();\n}\nconst run = move.bind(undefined, new Turtle());\nconst count = 1; // step\nrun();',
    1,
  ],
  [
    'a value a stepped return statement returns',
    'function make() {\n  return new Turtle(); // step\n}\nconst t = make();',
    1,
  ],
  [
    'an earlier spread element',
    'function check() {\n  const ready = true; // step\n  return 0;\n}\nconst a = [...[new Turtle()], check()];',
    1,
  ],
  [
    'the results of map so far',
    'const turtles = [1, 2].map((n) => {\n  const t = new Turtle(n, 0);\n  const ready = true; // step\n  return t;\n});\nturtles[0].forward();',
    2,
  ],
])('a step keeps the turtles that %s holds', (_, program, count) => {
  expect(traceProgram('javascript', program, program).finalTurtles).toHaveLength(count);
});

test('a var declared without a value appears once its declaration runs', () => {
  const program = `const before = 1; // step
var later;
const after = 2; // step`;
  expect(
    traceProgram('javascript', program, program).traceItems.map(({ vars, referenceVars }) => ({
      ...vars,
      ...referenceVars,
    }))
  ).toEqual([
    {},
    { before: 1 },
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows undefined as null.
    { before: 1, later: { kind: 'value', value: null }, after: 2 },
  ]);
});
