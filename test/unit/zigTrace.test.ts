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
  {
    name: 'a turtle in a literal stays while the literal calls a function that records steps',
    java: javaMain(
      `
    Turtle[] pair = { new Turtle(0, 0), make(2, 0) };
    pair[1].forward();`,
      `
  static Turtle make(int x, int y) {
    Turtle t = new Turtle(x, y);
    t.forward();
    return t;
  }`
    ),
    zig: `pub fn main() void {
    const pair = [_]Turtle{ Turtle.init(0, 0), make(2, 0) };
    pair[1].forward();
}

fn make(x: i32, y: i32) Turtle {
    const t = Turtle.init(x, y);
    t.forward();
    return t;
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

test.each(['', 'return;'])('main retains its outer locals through final collection (%s)', (ending) => {
  const program = `pub fn main() void {
    const t = Turtle.init();
    t.forward();
    const n: i32 = 3;
    _ = n;
    { const gone = Turtle.init(3, 3); gone.forward(); }
    ${ending}
}`;
  const result = traceProgram('zig', program, program);
  expect(result.finalVars).toEqual({ n: 3 });
  expect(result.finalTurtles).toEqual([{ x: 0, y: 1, color: '#', dir: 'N' }]);
  expect(executeProgram('zig', program)).toMatchObject({ finalTurtles: result.finalTurtles });
});

test('capture variables leave traces when while, catch, switch, and inline-for scopes end', () => {
  const program = `const std = @import("std");
fn fail() error{Oops}!void { return error.Oops; }
pub fn main() void {
    const n: ?i32 = 1;
    while (n) |v| { std.debug.print("{}", .{v}); break; }
    fail() catch |err| { std.debug.print("{s}", .{@errorName(err)}); };
    switch (n.?) { 1 => |value| { std.debug.print("{}", .{value}); }, else => {} }
    inline for (.{ 1, 2 }) |item| { std.debug.print("{}", .{item}); }
    const after: i32 = 2;
    _ = after;
}`;
  const result = traceProgram('zig', program, program);
  expect(result.stderr).toBe('1Oops112');
  expect(result.traceItems.at(-1)?.vars).toEqual({ n: 1, after: 2 });
  expect(result.finalVars).toEqual({ n: 1, after: 2 });
});

test('atomic helpers in local containers and declaration-literal constructors keep their step rules', () => {
  const qualified = makeProgram('S.init');
  const inferred = makeProgram('.init');
  const result = traceProgram('zig', qualified, qualified);
  expect(result.finalTurtles).toEqual([{ x: 0, y: 3, color: '#', dir: 'N' }]);
  expect(withoutLines(traceProgram('zig', inferred, inferred).traceItems)).toEqual(withoutLines(result.traceItems));
  expect(result.traceItems.filter((item) => item.callLines.length > 0)).toEqual([]);
});

const makeProgram = (callee: string): string => `pub fn main() void {
    const S = struct {
        t: Turtle,
        fn init() @This() { // atomic
            const t = Turtle.init();
            t.forward();
            t.forward();
            return .{ .t = t };
        }
    };
    const s: S = ${callee}();
    s.t.forward();
}`;

test('narrow floats show shortest values and string and tag captures record their binding steps', () => {
  const program = `const std = @import("std");
const U = union(enum) { a: i32, b: i32 };
pub fn main() void {
    var x: f32 = 0.1;
    x += 0.2;
    const values = [_]f16{ 0.1, 0.2 };
    _ = values;
    for ([_][]const u8{ "a", "a" }) |s| {
        std.debug.print("{s}", .{s});
    }
    const u: U = .{ .a = 4 };
    switch (u) { inline .a, .b => |v, tag| { const y: i32 = v; _ = y; _ = tag; } }
}`;
  const result = traceProgram('zig', program, program);
  expect(result.finalVars).toMatchObject({ x: 0.3, values: [0.1, 0.2] });
  expect(result.traceItems.filter((item) => item.line === 8 && item.vars.s === 'a')).toHaveLength(2);
  expect(result.traceItems.some((item) => item.vars.tag === '.a' && item.vars.v === 4)).toBe(true);
  expect(result.finalVars).not.toHaveProperty('tag');
});

test('panic snapshots retain entry locals and clear nested scopes without running defers', () => {
  const program = `pub fn main() void {
    const t = Turtle.init();
    t.forward();
    const n: i32 = 3;
    _ = n;
    {
        const lost = Turtle.init(3, 3);
        defer lost.forward();
        @panic("stop");
    }
}`;
  const result = traceProgram('zig', program, program);
  expect(result.uncaughtException).toBe('panic: stop');
  expect(result.finalVars).toEqual({ n: 3 });
  expect(result.finalTurtles).toEqual([{ x: 0, y: 1, color: '#', dir: 'N' }]);
});

test.each(['std.mem.sort', 'std.sort.block', 'std.sort.heap', 'std.sort.isSorted'])(
  'native callbacks keep complete temporary operands alive (%s)',
  (sort) => {
    const program = `const std = @import("std");
fn make(g: std.mem.Allocator) ![]Turtle {
    const a = try g.alloc(Turtle, 3);
    a[0] = Turtle.init(0, 0);
    a[1] = Turtle.init(2, 0);
    a[2] = Turtle.init(4, 0);
    return a;
}
fn less(_: void, a: Turtle, b: Turtle) bool {
    _ = a;
    _ = b;
    const marker: i32 = 1;
    _ = marker;
    return false;
}
pub fn main(init: std.process.Init) !void { _ = ${sort}(Turtle, try make(init.gpa), {}, less); }`;
    const result = traceProgram('zig', program, program);
    const comparisons = result.traceItems.filter((item) => item.vars.marker === 1);
    expect(comparisons.length).toBeGreaterThan(0);
    expect(comparisons.every((item) => item.turtles.length === 3)).toBe(true);
    expect(result.uncaughtException).toBeUndefined();
  }
);
