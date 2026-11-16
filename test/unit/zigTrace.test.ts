import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
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

/** Programs that behave alike in both languages, so Zig must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'loops, conditions, and variables',
    java: javaMain(`
    Turtle t = new Turtle();
    int n = 4;
    int i = 0;
    while (i < n) {
      if (i % 2 == 0) {
        t.forward();
      } else {
        t.turnRight();
      }
      i++;
    }`),
    zig: `pub fn main() void {
    var t = Turtle.init();
    const n: i32 = 4;
    var i: i32 = 0;
    while (i < n) {
        if (@rem(i, 2) == 0) {
            t.forward();
        } else {
            t.turnRight();
        }
        i += 1;
    }
}`,
  },
  {
    name: 'a for-each over numbers and a static method',
    java: javaMain(
      `
    Turtle t = new Turtle(1, 1);
    int[] steps = {1, 2};
    for (int s : steps) {
      walk(t, s);
    }`,
      `
  static void walk(Turtle t, int n) {
    for (int i = 0; i < n; i++) {
      t.前に進む();
    }
  }`
    ),
    zig: `pub fn main() void {
    const t = Turtle.init(1, 1);
    const steps = [_]i32{ 1, 2 };
    for (steps) |s| {
        walk(t, s);
    }
}

fn walk(t: Turtle, n: i32) void {
    var i: i32 = 0;
    while (i < n) : (i += 1) {
        t.@"前に進む"();
    }
}`,
  },
  {
    name: 'a turtle that no variable reaches any longer disappears, including after a loop over turtles',
    java: javaMain(`
    Turtle[] turtles = new Turtle[2];
    turtles[0] = new Turtle(0, 0);
    turtles[1] = new Turtle(2, 0);
    for (Turtle t : turtles) {
      t.forward();
    }
    turtles[1] = null;
    turtles[0].forward();`),
    zig: `pub fn main() void {
    var turtles: [2]?Turtle = @splat(null);
    turtles[0] = Turtle.init(0, 0);
    turtles[1] = Turtle.init(2, 0);
    for (turtles) |t| {
        t.?.forward();
    }
    turtles[1] = null;
    turtles[0].?.forward();
}`,
  },
])('$name', ({ java, zig }) => {
  const javaTrace = traceProgram('java', java, java);
  const zigTrace = traceProgram('zig', zig, zig);
  expect(withoutLines(zigTrace.traceItems)).toEqual(withoutLines(javaTrace.traceItems));
});

test('an atomic function counts as one step of its caller, and a method shows its receiver fields as self.x', () => {
  const program = `pub fn main() void {
    var w = Walker{ .t = Turtle.init(), .speed = 2 };
    w.walk();
    twice(w.t);
}

const Walker = struct {
    t: Turtle,
    speed: i32,

    fn walk(self: *Walker) void {
        self.t.forward();
    }
};

fn twice(t: Turtle) void { // atomic
    t.forward();
    t.forward();
}`;
  const trace = traceProgram('zig', program, program);
  expect(trace.traceItems.map(({ line, callLines, vars }) => ({ line, callLines, vars }))).toEqual([
    { line: 0, callLines: [], vars: {} },
    { line: 2, callLines: [], vars: {} },
    { line: 12, callLines: [3], vars: { 'self.speed': 2 } },
    { line: 4, callLines: [], vars: {} },
  ]);
  expect(trace.traceItems.at(-1)?.turtles).toEqual([{ x: 0, y: 3, color: '#', dir: 'N' }]);
});

test('an atomic annotation outside a function header is a compile error', () => {
  const program = `pub fn main() void {
    const t = Turtle.init(); // atomic
    t.forward();
}`;
  expect(() => traceProgram('zig', program, program)).toThrow(/atomic/);
  expect(executeProgram('zig', program)).toMatchObject({ kind: 'executed' });
});
