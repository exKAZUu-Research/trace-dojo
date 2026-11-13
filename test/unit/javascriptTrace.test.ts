import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { DisplayNode, TraceItem } from '../../src/problems/trace';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** Programs that behave alike in both languages, so JavaScript must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'moves, turns, and colors',
    java: javaMain(`
    Turtle 亀 = new Turtle(2, 1, "R");
    亀.前に進む();
    亀.右を向く();
    亀.forward();
    亀.turnLeft();
    亀.後に戻る();`),
    javascript: `
const 亀 = new Turtle(2, 1, 'R');
亀.前に進む();
亀.右を向く();
亀.forward();
亀.turnLeft();
亀.後に戻る();`,
  },
  {
    name: 'loops, conditions, and variables',
    java: javaMain(`
    Turtle t = new Turtle();
    int n = 4;
    for (int i = 0; i < n; i++) {
      if (i % 2 == 0) {
        t.forward();
      } else if (i == 3) {
        t.turnRight();
      } else {
        continue;
      }
      n = n - 0;
    }
    int k = 0;
    while (k < 2) {
      k++;
    }
    do {
      k--;
    } while (k > 0);
    String label = "k=" + k;
    boolean done = true;`),
    javascript: `
const t = new Turtle();
let n = 4;
for (let i = 0; i < n; i++) {
  if (i % 2 === 0) {
    t.forward();
  } else if (i === 3) {
    t.turnRight();
  } else {
    continue;
  }
  n = n - 0;
}
let k = 0;
while (k < 2) {
  k++;
}
do {
  k--;
} while (k > 0);
const label = 'k=' + k;
const done = true;`,
  },
  {
    name: 'switch, labeled break, and nested loops',
    java: javaMain(`
    Turtle t = new Turtle(1, 1);
    int total = 0;
    outer:
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 3; j++) {
        if (i + j > 2) break outer;
        total += i * j;
      }
    }
    switch (total) {
      case 1:
        t.forward();
        break;
      case 2:
        t.turnRight();
      default:
        t.forward();
    }`),
    javascript: `
const t = new Turtle(1, 1);
let total = 0;
outer:
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (i + j > 2) break outer;
    total += i * j;
  }
}
switch (total) {
  case 1:
    t.forward();
    break;
  case 2:
    t.turnRight();
  default:
    t.forward();
}`,
  },
  {
    name: 'arrays and strings',
    java: javaMain(`
    int[] values = { 3, 1, 2 };
    int[][] grid = { { 1, 2 }, { 3, 4 } };
    String[] names = { "a", null };
    values[1] = values[0] + values[2];
    grid[1][0] = 9;
    String text = "x" + values.length;`),
    javascript: `
const values = [3, 1, 2];
const grid = [[1, 2], [3, 4]];
const names = ['a', null];
values[1] = values[0] + values[2];
grid[1][0] = 9;
const text = 'x' + values.length;`,
  },
  {
    name: 'turtles that become unreachable disappear',
    java: javaMain(`
    Turtle t = new Turtle();
    t.forward();
    t = new Turtle(3, 3, "B");
    t.forward();
    Turtle u = new Turtle(5, 5);
    u.remove();`),
    javascript: `
let t = new Turtle();
t.forward();
t = new Turtle(3, 3, 'B');
t.forward();
const u = new Turtle(5, 5);
u.remove();`,
  },
  {
    name: 'turtles that block each other',
    java: javaMain(`
    Turtle a = new Turtle(0, 0);
    Turtle b = new Turtle(0, 2, "G");
    while (a.前に進めるか()) {
      a.前に進む();
    }
    boolean painted = a.前のマスが塗られているか();`),
    javascript: `
const a = new Turtle(0, 0);
const b = new Turtle(0, 2, 'G');
while (a.前に進めるか()) {
  a.前に進む();
}
const painted = a.前のマスが塗られているか();`,
  },
  {
    name: 'a for header written over several rows',
    java: javaMain(`
    Turtle t = new Turtle(0, 0);
    for (int i = 0;
         i < 2;
         i++) {
      t.forward();
    }`),
    javascript: `
const t = new Turtle(0, 0);
for (let i = 0;
     i < 2;
     i++) {
  t.forward();
}`,
  },
  {
    name: 'calls whose callee records steps',
    java: javaMain(
      `
    draw(new Turtle(1, 0), 2);
    draw(new Turtle(3, 0), 1);`,
      `
  static int draw(Turtle t, int length) {
    for (int i = 0; i < length; i++) {
      t.forward();
    }
    t.turnRight();
    return length * 2;
  }`
    ),
    javascript: `
draw(new Turtle(1, 0), 2);
draw(new Turtle(3, 0), 1);
function draw(t, length) {
  for (let i = 0; i < length; i++) {
    t.forward();
  }
  t.turnRight();
  return length * 2;
}`,
  },
  {
    name: 'a caught exception and an uncaught one',
    java: javaMain(`
    Turtle t = new Turtle(0, 5);
    try {
      t.forward();
      t.forward();
      t.forward();
    } catch (RuntimeException e) {
      t.turnRight();
    }
    t.turnRight();
    t.forward();
    t.turnRight();
    t.forward();
    t.forward();
    t.forward();
    t.forward();
    t.forward();
    t.forward();`),
    javascript: `
const t = new Turtle(0, 5);
try {
  t.forward();
  t.forward();
  t.forward();
} catch (e) {
  t.turnRight();
}
t.turnRight();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.forward();
t.forward();
t.forward();
t.forward();`,
  },
])('JavaScript traces $name as Java does', ({ java, javascript }) => {
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('javascript', javascript, javascript);
  expect(withoutLines(actual.traceItems)).toEqual(withoutLines(expected.traceItems));
  expect(actual.finalBoard).toBe(expected.finalBoard);
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
  expect(actual.finalVars).toEqual(expected.finalVars);
  expect(actual.uncaughtException === undefined).toBe(expected.uncaughtException === undefined);
});

test.each([
  ['a parenthesized creation', 'Box b = (new Box());', 'const b = (new Box());'],
  ['a created array of created objects', 'Box[] b = new Box[] { new Box() };', 'const b = [(new Box())];'],
  ['an assigned creation', 'Box b;\n    b = (new Box());', 'let b;\n(b = new Box());'],
])('%s leaves its step to the constructor in both languages', (_, java, javascript) => {
  const javaProgram = javaMain(`    ${java}`, '').replace(/\}$/, '}\nclass Box {\n  int n = 1;\n}');
  const javascriptProgram = `class Box {\n  n = 1;\n}\n${javascript}`;
  const javaTrace = traceProgram('java', javaProgram, javaProgram).traceItems;
  expect(javaTrace.map(({ callLines }) => callLines.length)).toEqual([0, 1]);
  expect(
    traceProgram('javascript', javascriptProgram, javascriptProgram).traceItems.map(({ callLines }) => callLines.length)
  ).toEqual([0, 1]);
});

test.each(['const { n } = new Box();', 'let n;\n({ n } = new Box());', 'const [n] = [new Box()];'])(
  'destructuring a creation records its step after the constructor steps: %s',
  (statement) => {
    const program = `class Box {\n  n = 1;\n}\n${statement}`;
    expect(traceProgram('javascript', program, program).traceItems.at(-1)?.line).toBe(program.split('\n').length);
  }
);

test.each([
  ['for (const t of [new Turtle()]) {}', [0, 1]],
  ['for (const o of [{ n: 1 }, { n: 2 }]) {}', [0]],
  ['function f() {\n  for (const o of [{ n: 1 }]) {}\n}\nf();', [0, 4]],
  ['for (const [n] of [[1], [2]]) {}', [0, 1, 1]],
  ['for (const { n } of [{ n: 1 }]) {}', [0, 1]],
])(
  'a for-of loop records a binding when it stores values learners answer or the turtles changed: %s',
  (program, lines) => {
    expect(traceProgram('javascript', program, program).traceItems.map(({ line }) => line)).toEqual(lines);
  }
);

test('a compound assignment of a creation records its step after the constructor steps in both languages', () => {
  const javaProgram = javaMain('    String s = "a";\n    s += new Box();', '').replace(
    /\}$/,
    '}\nclass Box {\n  int n = 1;\n}'
  );
  const javascriptProgram = 'class Box {\n  n = 1;\n}\nlet s = "a";\ns += new Box();';
  expect(traceProgram('java', javaProgram, javaProgram).traceItems.at(-1)?.line).toBe(4);
  expect(traceProgram('javascript', javascriptProgram, javascriptProgram).traceItems.at(-1)?.vars.s).toBe(
    'a[object Object]'
  );
});

const turtleCounts = (language: 'java' | 'javascript', program: string): number[] =>
  traceProgram(language, program, program).traceItems.map(({ turtles }) => turtles.length);

test('a turtle that only a Map, a Set, or an iterator over one refers to stays', () => {
  for (const collection of [
    "const m = new Map(); { m.set('a', new Turtle()); }",
    'const s = new Set(); { s.add(new Turtle()); }',
    'let i; { i = new Map([[1, new Turtle()]]).values(); }',
  ]) {
    expect(turtleCounts('javascript', `${collection}\nconst x = 1;`).at(-1)).toBe(1);
  }
  expect(
    turtleCounts('javascript', "let m = new Map(); { m.set('a', new Turtle()); }\nm = undefined;\nconst x = 1;").at(-1)
  ).toBe(0);
});

test('a value a finally block delays keeps its turtle in both languages', () => {
  const java = javaMain(
    '    Turtle t = make();\n    t.forward();',
    '  static Turtle make() {\n    try {\n      return new Turtle(3, 3);\n    } finally {\n      int done = 1;\n    }\n  }'
  );
  const javascript = `function make() {
  try {
    return new Turtle(3, 3);
  } finally {
    const done = 1;
  }
}
const t = make();
t.forward();`;
  expect(turtleCounts('java', java)).toEqual([0, 1, 1, 1]);
  expect(turtleCounts('javascript', javascript)).toEqual([0, 1, 1, 1]);
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
  const program = `const step = 2;
let count = 0;
class Walker {
  #moved = 0;
  constructor(turtle) {
    this.turtle = turtle;
  }
  walk(times) {
    for (let i = 0; i < times; i++) {
      this.turtle.forward();
      this.#moved += step;
      count++;
    }
  }
}
const walker = new Walker(new Turtle());
walker.walk(1);`;
  const trace = traceProgram('javascript', program, program);

  expect(
    trace.traceItems.map(({ line, callLines, vars, referenceVars }) => ({ line, callLines, vars, referenceVars }))
  ).toEqual([
    { line: 0, callLines: [], vars: {}, referenceVars: {} },
    { line: 1, callLines: [], vars: { step: 2 }, referenceVars: {} },
    { line: 2, callLines: [], vars: { step: 2, count: 0 }, referenceVars: {} },
    {
      line: 4,
      callLines: [16],
      vars: { step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { this: { kind: 'object', entries: { '#moved': { kind: 'value', value: 0 } } } },
    },
    {
      line: 6,
      callLines: [16],
      vars: { step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { turtle: turtle(0), this: walker(0, 0) },
    },
    {
      line: 9,
      callLines: [17],
      vars: { times: 1, i: 0, step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { walker: walker(0, 0), this: walker(0, 0) },
    },
    {
      line: 10,
      callLines: [17],
      vars: { times: 1, i: 0, step: 2, count: 0, 'this.#moved': 0 },
      referenceVars: { walker: walker(1, 0), this: walker(1, 0) },
    },
    {
      line: 11,
      callLines: [17],
      vars: { times: 1, i: 0, step: 2, count: 0, 'this.#moved': 2 },
      referenceVars: { walker: walker(1, 2), this: walker(1, 2) },
    },
    {
      line: 12,
      callLines: [17],
      vars: { times: 1, i: 0, step: 2, count: 1, 'this.#moved': 2 },
      referenceVars: { walker: walker(1, 2), this: walker(1, 2) },
    },
    {
      line: 9,
      callLines: [17],
      vars: { times: 1, i: 1, step: 2, count: 1, 'this.#moved': 2 },
      referenceVars: { walker: walker(1, 2), this: walker(1, 2) },
    },
  ]);
  expect(trace.finalVars).toEqual({ step: 2, count: 1 });
});

test('callbacks that builtins call count as calls from the row that called the builtin', () => {
  const program = `const t = new Turtle();
[1, 2].forEach((n) => {
  t.forward();
});`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ callLines, vars }) => ({ callLines, vars }))).toEqual([
    { callLines: [], vars: {} },
    { callLines: [], vars: {} },
    { callLines: [2], vars: { n: 1 } },
    { callLines: [2], vars: { n: 2 } },
  ]);
});

test('variables appear once their declaration runs, and functions and classes are not variables', () => {
  const program = `const t = new Turtle();
var later = 1;
function helper() {}
class Shape {}
const callback = () => helper();
let pending = undefined;`;
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
const values = getters.map((get) => get());`;
  expect(traceProgram('javascript', program, program).finalVars).toEqual({ values: [0, 1, 2] });
});

test('a call to an atomic function records its step even when its arguments record steps', () => {
  const program = `function make() {
  const x = 1;
  return x;
}
function keep(n) { // atomic
  const y = n + 1;
}
keep(make());`;
  expect(traceProgram('javascript', program, program).traceItems.map(({ line }) => line)).toEqual([0, 2, 8]);
});

test('a turtle operation after steps in its arguments or receiver records its own step', () => {
  const program = `function position() {
  const x = 2;
  return x;
}
function pick(t) {
  const picked = t;
  return picked;
}
const t = new Turtle(position(), 0);
pick(t).forward();`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ line, turtles }) => ({ line, y: turtles[0]?.y }))).toEqual([
    { line: 0, y: undefined },
    { line: 2, y: undefined },
    { line: 9, y: 0 },
    { line: 6, y: 0 },
    { line: 10, y: 1 },
  ]);
});

test('a call records its step when a return expression turns Infinity into -Infinity', () => {
  const program = `let count = 1 / 0;
function bump() {
  const seen = count;
  return count = -count;
}
bump();`;
  expect(traceProgram('javascript', program, program).traceItems.at(-1)?.vars.count).toBe(-Infinity);
});

test('a call records its step when a return expression updates a variable after the last step', () => {
  const program = `let count = 0;
function bump() {
  const seen = count;
  return count++;
}
bump();`;
  expect(
    traceProgram('javascript', program, program).traceItems.map(({ line, vars }) => ({ line, count: vars.count }))
  ).toEqual([
    { line: 0, count: undefined },
    { line: 1, count: 0 },
    { line: 3, count: 0 },
    { line: 6, count: 1 },
  ]);
});

test.each([
  'function outer(callback = () => 0) { // atomic',
  'function outer(callback = function inner() { return 0; }) { // atomic',
])('an atomic annotation after a one-line default callback marks the enclosing function: %s', (header) => {
  const program = `let total = 0;
${header}
  total += 1;
  callback();
  total += 2;
}
outer();`;
  expect(traceProgram('javascript', program, program).traceItems.map(({ line }) => line)).toEqual([0, 1, 7]);
});

test.each(['function inner() { // atomic', '() => { // atomic'])(
  'an atomic default callback leaves its enclosing function stepped: %s',
  (callback) => {
    const program = `let total = 0;
function outer(
  callback = ${callback}
    total += 10;
  }
) {
  total += 1;
  callback();
  total += 2;
}
outer();`;
    expect(traceProgram('javascript', program, program).traceItems.map(({ line }) => line)).toEqual([0, 1, 7, 8, 9]);
  }
);

test('display programs keep their placeholders and lose their annotations', () => {
  const program = `function move(t) { // atomic
  t.forward();
}
const t = new Turtle();
move(t);`;
  const displayProgram = program.replace('t.forward()', 't.【1】()');
  const trace = traceProgram('javascript', program, displayProgram);
  expect(trace.displayProgram).toBe(displayProgram.replace(' // atomic', ''));
  expect(trace.traceItems.map(({ line }) => line)).toEqual([0, 4, 5]);
});

test.each([
  ['an atomic annotation outside a function declaration', 'let i = 0; // atomic', '// atomic は'],
  [
    'an atomic annotation inside a default callback body',
    'function outer(\n  callback = () => {\n    let x = 1; // atomic\n  }\n) {\n  callback();\n}\nouter();',
    '// atomic は',
  ],
  ['invalid syntax', 'const t = new Turtle(;', '「)」が足りません'],
])('a model program with %s is rejected', (_, program, message) => {
  expect(() => traceProgram('javascript', program, program)).toThrow(message);
});

test('a value that a finally block delays keeps its turtle while the block records steps', () => {
  const program = `function make() {
  try {
    return new Turtle();
  } finally {
    const done = true;
  }
}
const t = make();`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 1]);
  expect(trace.finalTurtles).toHaveLength(1);
});

test.each([
  [
    'a bound function',
    'function move(t) {\n  t.forward();\n}\nconst run = move.bind(undefined, new Turtle());\nconst count = 1;\nrun();',
    1,
  ],
  [
    'an earlier spread element',
    'function check() {\n  const ready = true;\n  return 0;\n}\nconst a = [...[new Turtle()], check()];',
    1,
  ],
  [
    'Object.values so far',
    'const observer = new Turtle(0, 0);\nconst values = Object.values({\n  get first() {\n    return new Turtle(0, 1);\n  },\n  get second() {\n    const ready = true;\n    return 0;\n  },\n});',
    2,
  ],
  [
    'an object rest so far',
    'const { skip, ...rest } = {\n  get first() {\n    return new Turtle(0, 1);\n  },\n  get second() {\n    const ready = true;\n    return 0;\n  },\n};',
    1,
  ],
  [
    'super() arguments while the parent initializes its fields',
    'class A {\n  ready = true;\n  constructor(t) {\n    this.t = t;\n  }\n}\nclass B extends A {\n  constructor() {\n    super(new Turtle(3, 3));\n  }\n}\nconst b = new B();',
    1,
  ],
  [
    'the values sort is comparing',
    'const observer = new Turtle(6, 6);\nconst a = [new Turtle(0, 0), new Turtle(1, 0), new Turtle(2, 0)];\na.sort((x, y) => {\n  a.length = 0;\n  const ready = true;\n  return x.x - y.x;\n});',
    4,
  ],
  [
    'the results of map so far',
    'const turtles = [1, 2].map((n) => {\n  const t = new Turtle(n, 0);\n  const ready = true;\n  return t;\n});\nturtles[0].forward();',
    2,
  ],
])('a step keeps the turtles that %s holds', (_, program, count) => {
  expect(traceProgram('javascript', program, program).finalTurtles).toHaveLength(count);
});

test('a var declared without a value appears once its declaration runs', () => {
  const program = `const before = 1;
var later;
const after = 2;`;
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

test('variables appear in the order the program declares them', () => {
  const program = `let total = 0;
for (var j = 0; j < 1; j++) {
  total += j;
}`;
  const header = traceProgram('javascript', program, program).traceItems.find(({ line }) => line === 2);
  expect(Object.keys(header?.vars ?? {})).toEqual(['total', 'j']);
});

test('a getter that records a step counts as a call from the row that reads or destructures it', () => {
  const program = `class Point {
  constructor(x) {
    this.x = x;
  }
  get double() {
    const d = this.x * 2;
    return d;
  }
}
const p = new Point(3);
const y = p.double;
const { double } = p;`;
  const calls = traceProgram('javascript', program, program).traceItems.flatMap(({ callLines }) =>
    callLines.length > 0 ? [callLines] : []
  );
  expect(calls).toEqual([[10], [11], [12]]);
});

test.each([
  ['let total = 0;\n[1, 2, 3].forEach((n) => { total += n; });', [undefined, 0, 1, 3, 6]],
  ['let total = 0;\n[1, 2, 3].forEach((n) => total += n);', [undefined, 0, 6]],
  ['let total = 0;\n[1, 2, 3].forEach((n) => {\n  total += n;\n});', [undefined, 0, 1, 3, 6]],
])(
  'the statements of a callback record steps, and the call that passed it records none after them: %s',
  (program, totals) => {
    expect(traceProgram('javascript', program, program).traceItems.map(({ vars }) => vars.total)).toEqual(totals);
  }
);

test.each([
  ['a literal', '1', false],
  ['a constant expression', '-(1 + 2) * 3', false],
  ['a template of constants', '`a${1 + 2}`', false],
  ['a created turtle', 'new Turtle()', true],
  ['an array of created turtles', '[new Turtle()]', true],
  ['a call', 'String(2)', true],
])(
  'a static field initialized with %s (%s) records a step only when evaluating it can have an effect',
  (_, initializer, recordsStep) => {
    const program = `class Main {
  static field = ${initializer};
}`;
    const trace = traceProgram('javascript', program, program);
    expect(trace.traceItems.map(({ line }) => line)).toEqual(recordsStep ? [0, 2] : [0]);
    expect(trace.traceItems.at(-1)?.turtles).toEqual(trace.finalTurtles);
  }
);

test('a one-line method of a longer object literal records a step each time it runs', () => {
  const program = `let total = 0;
const handlers = {
  add(n) { total += n; },
};
handlers.add(1);
handlers.add(2);`;
  expect(traceProgram('javascript', program, program).traceItems.map(({ vars }) => vars.total)).toEqual([
    undefined,
    0,
    0,
    1,
    3,
  ]);
});

test('private fields of the same name in a class and its subclass stay apart', () => {
  const program = `class A {
  #x = 1;
  get() {
    const n = this.#x;
    return n;
  }
}
class B extends A {
  #x = 2;
}
new B().get();`;
  expect(traceProgram('javascript', program, program).traceItems.find(({ line }) => line === 4)?.vars).toEqual({
    n: 1,
    'this.A.#x': 1,
    'this.B.#x': 2,
  });
});

test('private fields from two evaluations of one class stay apart', () => {
  const program = `function layer(Base, n) {
  return class Layer extends Base {
    #x = n;
    get() {
      const value = this.#x;
      return value;
    }
  };
}
class Root {}
const C = layer(layer(Root, 1), 2);
new C().get();`;
  expect(traceProgram('javascript', program, program).traceItems.find(({ line }) => line === 5)?.vars).toEqual({
    value: 2,
    n: 2,
    'this.Layer.#x (1)': 1,
    'this.Layer.#x (2)': 2,
  });
});

test('both operands of an operator keep their turtles while a conversion records a step', () => {
  const program = `const left = {
  valueOf() {
    const ready = true;
    return 1;
  },
};
const total = left + { turtle: new Turtle(), valueOf: () => 2 };`;
  expect(traceProgram('javascript', program, program).traceItems.find(({ line }) => line === 3)?.turtles).toHaveLength(
    1
  );
});

test('a BigInt too large for a number stays a bigint and a symbol shows its text unquoted inside an object', () => {
  const program = "const o = { big: 9007199254740993n, small: 5n, s: Symbol('k') };";
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.at(-1)?.referenceVars).toEqual({
    o: {
      kind: 'object',
      entries: {
        big: { kind: 'value', value: 9_007_199_254_740_993n },
        small: { kind: 'value', value: 5 },
        s: { kind: 'value', value: 'Symbol(k)', verbatim: true },
      },
    },
  });
});

const value = (v: string | number): DisplayNode => ({ kind: 'value', value: v });

test('a trace shows the contents of Maps and Sets and the text of Dates and regular expressions', () => {
  const program = `const m = new Map([['a', 1]]);
const n = new Map([[2, 'b']]);
const s = new Set([1, 'b']);
const d = new Date(0);
const r = /a+/g;
const k = new Map([[new Date(0), 1]]);`;
  const trace = traceProgram('javascript', program, program);
  expect(trace.traceItems.at(-1)?.referenceVars).toEqual({
    m: { kind: 'object', entries: { a: value(1) } },
    n: { kind: 'array', entries: { 0: { kind: 'array', entries: { 0: value(2), 1: value('b') } } } },
    s: { kind: 'array', entries: { 0: value(1), 1: value('b') } },
    d: { kind: 'value', value: '1970-01-01T00:00:00.000Z', verbatim: true },
    r: { kind: 'value', value: '/a+/g', verbatim: true },
    k: {
      kind: 'array',
      entries: {
        0: {
          kind: 'array',
          entries: { 0: { kind: 'value', value: '1970-01-01T00:00:00.000Z', verbatim: true }, 1: value(1) },
        },
      },
    },
  });
  expect(traceProgram('javascript', 'const x = new Number(3);', 'const x = new Number(3);').finalVars).toEqual({
    x: 3,
  });
});
