import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** The programs of two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

const stepsOf = (language: 'java' | 'javascript' | 'typescript', program: string): unknown[] =>
  withoutLines(traceProgram(language, program, program).traceItems);

test.each([
  {
    name: 'loops, conditions, and a switch that falls through',
    java: javaMain(`
    Turtle t = new Turtle(3, 3);
    int level = 2;
    for (int i = 0; i < 3; i++) {
      if (i == 1) continue;
      switch (level) {
        case 2: t.右を向く();
        case 1: t.前に進む(); break;
        default: t.左を向く();
      }
      level--;
    }
    int x = (level * 3) / 2;`),
    typescript: `
const t: Turtle = new Turtle(3, 3);
let level: number = 2;
for (let i = 0; i < 3; i++) {
  if (i === 1) continue;
  switch (level) {
    case 2:
      t.右を向く();
    case 1:
      t.前に進む();
      break;
    default:
      t.左を向く();
  }
  level--;
}
const x = Math.trunc((level * 3) / 2);`,
  },
  {
    name: 'a function that returns a value and a string it reads',
    java: javaMain(
      `
    Turtle t = new Turtle(2, 2);
    String text = "oxo";
    for (int i = text.length() - 1; i >= 0; i--) {
      boolean turn = reaches(text.charAt(i));
      if (turn) t.左を向く();
      else t.前に進む();
    }`,
      `  static boolean reaches(char c) {
    return c == 'x';
  }`
    ),
    typescript: `
const t = new Turtle(2, 2);
const text = "oxo";
for (let i = text.length - 1; i >= 0; i--) {
  const turn = reaches(text.charAt(i));
  if (turn) t.左を向く();
  else t.前に進む();
}
function reaches(c: string): boolean {
  return c === "x";
}`,
  },
  {
    name: 'static fields, which show as Java shows them',
    java: `public class Main {
  public static void main(String[] args) {
    Settings.value = 2;
    int x = Settings.value;
    Turtle t = new Turtle(x, 0);
  }
}
class Settings {
  static int value = 0;
}`,
    typescript: `class Settings {
  static value = 0;
}
Settings.value = 2;
const x = Settings.value;
const t = new Turtle(x, 0);`,
  },
])('$name trace as in Java', ({ java, typescript }) => {
  expect(stepsOf('typescript', typescript)).toEqual(stepsOf('java', java));
});

test('records scalar and reference bindings named __proto__', () => {
  const source = `
function read() {
  const __proto__ = { value: 7 };
  console.log(__proto__.value);
}
const __proto__ = 5;
read();
console.log(__proto__);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('7\n5\n');
  expect(Object.entries(recording.finalVars)).toEqual([['__proto__', 5]]);
  expect(recording.traceItems.flatMap((step) => Object.entries(step.referenceVars))).toContainEqual([
    '__proto__',
    { kind: 'object', entries: { value: { kind: 'value', value: 7 } } },
  ]);
});

test('static compile-time constants stay out of the trace as they do in Java', () => {
  const java = `public class Main {
  public static void main(String[] args) {
    int result = Settings.count;
    String text = Settings.title;
  }
}
class Settings {
  static final int count = 1 + 2;
  static final String title = "ready";
}`;
  const typescript = `class Settings {
  static readonly count = 1 + 2;
  static readonly title = "ready";
}
const result = Settings.count;
const text = Settings.title;`;
  expect(stepsOf('typescript', typescript)).toEqual(stepsOf('java', java));
});

test('only declared class bindings supply static field traces', () => {
  const source = `function build() { return 10; }
class Counter {
  static count = 1;
  static readonly dynamic = build();
  static readonly empty = null;
}
const alias = Counter;
alias.count++;
const value = alias.count;`;
  const { traceItems } = traceProgram('typescript', source, source);
  expect(traceItems.at(-1)?.vars).toEqual({
    value: 2,
    'Counter.count': 2,
    'Counter.dynamic': 10,
  });
  // oxlint-disable-next-line unicorn/no-null -- The trace retains the source language null.
  expect(traceItems.at(-1)?.referenceVars['Counter.empty']).toEqual({ kind: 'value', value: null });
});

test('a runtime write makes a static readonly constant visible in the trace', () => {
  const source = `class Counter {
  static readonly count = 1;
  static readonly title = 'initial';
  static readonly #hidden = 2;
  static bump() { (this as any).count++; (this.#hidden as number)++; }
}
Object.assign(Counter, { title: 'updated' });
Counter.bump();
console.log(Counter.count, Counter.title);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('2 updated\n');
  const first = recording.traceItems.find(({ vars }) => vars['Counter.title'] === 'updated');
  expect(first?.vars['Counter.count']).toBeUndefined();
  expect(first?.vars['Counter.#hidden']).toBeUndefined();
  expect(recording.traceItems.at(-1)?.vars).toMatchObject({
    'Counter.count': 2,
    'Counter.title': 'updated',
    'Counter.#hidden': 3,
  });
});

test('static accessor replacements trace their descriptors without invoking getters', () => {
  const source = `class Fields {
  static readonly one = 1;
  static readonly two = 2;
  static ordinary = 3;
}
let calls = 0;
Object.defineProperty(Fields, 'one', { get() { calls++; return 4; } });
Object.defineProperty(Fields, 'two', { get() { calls++; return 5; }, set(value: number) { calls++; } });
Object.defineProperty(Fields, 'ordinary', { set(value: number) { calls++; } });
console.log(calls, Fields.one, Fields.two, Fields.ordinary, calls);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('0 4 5 undefined 2\n');
  expect(recording.finalVars.calls).toBe(2);
  expect(recording.traceItems.at(-1)?.referenceVars).toMatchObject({
    'Fields.one': { kind: 'value', value: '[Getter]', verbatim: true },
    'Fields.two': { kind: 'value', value: '[Getter/Setter]', verbatim: true },
    'Fields.ordinary': { kind: 'value', value: '[Setter]', verbatim: true },
  });
});

test('changed static constants stay visible through restoration and redefinition', () => {
  const source = `class Counter {
  static readonly count = 1;
  static readonly title = 'initial';
  static readonly replaced = 3;
  static readonly untouched = 4;
  static readonly #hidden = 2;
  static resetPrivate() { (this.#hidden as number) = 5; (this.#hidden as number) = 2; }
}
const alias = Counter;
(alias as any).untouched = 4;
(alias as any).count = 8;
(alias as any).count = 1;
Object.assign(alias, { title: 'updated' });
Object.defineProperty(alias, 'title', { value: 'initial' });
delete (alias as any).replaced;
(alias as any).replaced = 3;
Counter.resetPrivate();
console.log(Counter.count, Counter.title, Counter.replaced);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('1 initial 3\n');
  expect(recording.traceItems.at(-1)?.vars).toEqual({
    'Counter.count': 1,
    'Counter.title': 'initial',
    'Counter.replaced': 3,
    'Counter.#hidden': 2,
  });
});

test('ordinary object snapshots retain enumerable accessors without reading them', () => {
  const source = `let reads = 0;
const item = {
  value: 1,
  get original() { reads++; return 2; },
  set input(value: number) { reads++; }
};
Object.defineProperty(item, 'value', {
  get() { reads++; return 3; },
  set(value: number) { reads++; }
});
Object.defineProperty(item, 'empty', { enumerable: true, get: undefined, set: undefined });
Object.defineProperty(item, 'hidden', { get() { reads++; return 4; } });
console.log(reads);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('0\n');
  expect(recording.traceItems.map((step) => step.referenceVars.item)).toContainEqual(
    expect.objectContaining({ entries: expect.objectContaining({ value: { kind: 'value', value: 1 } }) })
  );
  expect(recording.traceItems.at(-1)?.referenceVars.item).toEqual({
    kind: 'object',
    entries: {
      value: { kind: 'value', value: '[Getter/Setter]', verbatim: true },
      original: { kind: 'value', value: '[Getter]', verbatim: true },
      input: { kind: 'value', value: '[Setter]', verbatim: true },
      // oxlint-disable-next-line unicorn/no-null -- An accessor with no getter reads as undefined.
      empty: { kind: 'value', value: null },
    },
  });
});

test('displayed object entries retain own __proto__ keys', () => {
  const source = `const parsed = JSON.parse('{"__proto__":7,"name":"item"}');
const literal = {["__proto__"]: 8};
console.log(parsed["__proto__"], literal["__proto__"]);`;
  const result = traceProgram('typescript', source, source);
  expect(result.stdout).toBe('7 8\n');
  const entries = result.traceItems.at(-1)?.referenceVars;
  expect(entries?.parsed).toMatchObject({ entries: { ['__proto__']: { kind: 'value', value: 7 } } });
  expect(entries?.literal).toMatchObject({ entries: { ['__proto__']: { kind: 'value', value: 8 } } });
});

test('a private static field traces under its private name', () => {
  const typescript = `class Settings {
  static #value = 0;
  static bump() {
    Settings.#value = 2;
  }
}
Settings.bump();
const t = new Turtle(1, 0);`;
  const steps = traceProgram('typescript', typescript, typescript).traceItems;
  expect(steps.at(-1)?.vars).toEqual({ 'Settings.#value': 2 });
});

test('a class shows each static field in its initializer step', () => {
  const source = `const initial = 2;
class Counter {
  static count = initial;
  static next = Counter.count + 1;
}
const result = Counter.next;`;
  const { traceItems } = traceProgram('typescript', source, source);
  expect(traceItems.find((item) => item.line === 3)?.vars).toEqual({ initial: 2, 'Counter.count': 2 });
  expect(traceItems.find((item) => item.line === 4)?.vars).toEqual({
    initial: 2,
    'Counter.count': 2,
    'Counter.next': 3,
  });
});

// A parameter property is a field declared before the others, which the constructor assigns on the parameter's row.
test('a program traces as the JavaScript its types erase to', () => {
  const typescript = `interface Mover {
  move(times: number): void;
}
type Steps = number;
function count(steps: Steps): number;
function count(steps: string): number;
function count(steps: Steps | string): number {
  return typeof steps === "number" ? steps : steps.length;
}
abstract class Walker implements Mover {
  #moved: number = 0;
  constructor(protected readonly turtle: Turtle) {}
  abstract direction(): void;
  move(times: number): void {
    for (let i = 0; i < times; i++) {
      this.direction();
      this.turtle.前に進む();
      this.#moved++;
    }
  }
}
class RightWalker extends Walker {
  direction(): void {
    this.turtle.右を向く();
  }
}
const walker: Walker = new RightWalker(new Turtle(3, 3));
walker.move(count("ab") as number);
const total = <number>count(2)!;`;
  const javascript = `
function count(steps) {
  return typeof steps === "number" ? steps : steps.length;
}
class Walker {
  turtle;
  #moved = 0;
  constructor(turtle) {
    this.turtle = turtle;
  }
  move(times) {
    for (let i = 0; i < times; i++) {
      this.direction();
      this.turtle.前に進む();
      this.#moved++;
    }
  }
}
class RightWalker extends Walker {
  direction() {
    this.turtle.右を向く();
  }
}
const walker = new RightWalker(new Turtle(3, 3));
walker.move(count("ab"));
const total = count(2);`;
  expect(stepsOf('typescript', typescript)).toEqual(stepsOf('javascript', javascript));
});

test('// atomic marks a function whose steps are not recorded', () => {
  const program = `const t = new Turtle();
function twice(turtle: Turtle): void { // atomic
  turtle.前に進む();
  turtle.前に進む();
}
twice(t);
t.右を向く();`;
  expect(traceProgram('typescript', program, program).traceItems.map((item) => item.line)).toEqual([0, 1, 6, 7]);
});

test('static object and turtle array fields stay visible after a move', () => {
  const source = `class Shared {
  static turtle = new Turtle();
  static turtles = [Shared.turtle];
}
Shared.turtle.forward();`;
  const recording = traceProgram('typescript', source, source);
  const turtle = { kind: 'object', entries: { x: { kind: 'value', value: 0 }, y: { kind: 'value', value: 1 } } };
  expect(recording.traceItems.at(-1)?.referenceVars).toEqual({
    'Shared.turtle': turtle,
    'Shared.turtles': { kind: 'array', entries: { 0: turtle } },
  });
});

test('class expression statics follow the primary binding through aliases', () => {
  const source = `let early: { count: number };
const Counter = class {
  static count = 1;
  static next = this.count + 1;
};
early = Counter;
early.count++;
const Other = (class Named { static count = 3; });
const alias = Other;
alias.count++;
function make() { return class { static count = 5; }; }
const Returned = make();
Returned.count++;`;
  const { traceItems } = traceProgram('typescript', source, source);
  expect(traceItems.at(-1)?.vars).toEqual({
    'Counter.count': 2,
    'Counter.next': 2,
    'Other.count': 4,
    'Returned.count': 6,
  });
});
