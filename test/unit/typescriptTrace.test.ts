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
