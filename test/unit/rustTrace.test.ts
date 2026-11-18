import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** Java's `this.x` is Rust's `self.x`. */
const rename = (items: unknown[]): string =>
  JSON.stringify(items).replaceAll('"this.', '"self.').replaceAll('"this"', '"self"');

/** Programs that behave alike in both languages, so Rust must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'variables, conditions, and while loops',
    java: javaMain(`
    Turtle t = new Turtle();
    int n = 4;
    int i = 0;
    while (i < n) {
      if (i % 2 == 0) {
        t.前に進む();
      } else {
        t.右を向く();
      }
      i++;
    }`),
    rust: `fn main() {
    let mut t = Turtle::new();
    let n = 4;
    let mut i = 0;
    while i < n {
        if i % 2 == 0 {
            t.前に進む();
        } else {
            t.右を向く();
        }
        i += 1;
    }
}`,
  },
  {
    name: 'a method marked atomic and a function that returns a value',
    java: javaMain(
      `
    Turtle t = new Turtle(1, 1);
    int x = twice(2);
    walk(t, x);
    t.turnLeft();`,
      `
  static void walk(Turtle t, int n) { // atomic
    for (int i = 0; i < n; i++) {
      t.forward();
    }
  }
  static int twice(int a) {
    return a * 2;
  }`
    ),
    rust: `fn main() {
    let mut t = Turtle::new(1, 1);
    let x = twice(2);
    walk(&mut t, x);
    t.turnLeft();
}

fn walk(t: &mut Turtle, n: i32) { // atomic
    for _ in 0..n {
        t.forward();
    }
}

fn twice(a: i32) -> i32 {
    return a * 2;
}`,
  },
])('Rust traces as Java does: $name', ({ java, rust }) => {
  const javaTrace = traceProgram('java', java, java);
  const rustTrace = traceProgram('rust', rust, rust);
  expect(rename(withoutLines(rustTrace.traceItems))).toBe(rename(withoutLines(javaTrace.traceItems)));
  expect(rustTrace.traceItems.at(-1)?.board).toBe(javaTrace.traceItems.at(-1)?.board);
});

test("a method's receiver shows its fields as self.x, as Java shows this.x", () => {
  const program = `fn main() {
    let mut s = Signal { t: Turtle::new(2, 2), turn: false };
    s.act();
    s.turn = true;
    s.act();
}

struct Signal {
    t: Turtle,
    turn: bool,
}

impl Signal {
    fn act(&mut self) {
        if self.turn {
            self.t.右を向く();
        }
        self.t.前に進む();
    }
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [2, {}],
    [18, { 'self.turn': false }],
    [4, {}],
    [16, { 'self.turn': true }],
    [18, { 'self.turn': true }],
  ]);
});

test('a turtle disappears at the step that drops it', () => {
  const program = `fn main() {
    let mut t1 = Turtle::new(1, 1);
    let mut t2 = Turtle::new(3, 3);
    t2 = t1;
    t2.前に進む();
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, turtles }) => [line, turtles.map(({ x, y }) => `${x},${y}`).join(' ')])).toEqual([
    [0, ''],
    [2, '1,1'],
    [3, '1,1 3,3'],
    [4, '1,1'],
    [5, '1,2'],
  ]);
});

test('a for loop records a step at each binding of its variable, and none after the last', () => {
  const program = `fn main() {
    let mut t = Turtle::new();
    for i in 0..2 {
        t.前に進む();
    }
}`;
  const { traceItems } = traceProgram('rust', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [2, {}],
    [3, { i: 0 }],
    [4, { i: 0 }],
    [3, { i: 1 }],
    [4, { i: 1 }],
  ]);
});
