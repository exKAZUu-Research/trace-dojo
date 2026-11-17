import { expect, test } from 'vitest';

import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { gradeRegularAnswers, type RegularGradingResult } from '../../src/problems/regular/grade';
import type { TraceItem } from '../../src/problems/trace';
import { traceZigProgram } from '../../src/zig/trace';

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

test('reference library sorting records learner callbacks without internal frames or rows', () => {
  const program = `const std = @import("std");
fn less(_: void, a: u8, b: u8) bool {
    var t = Turtle.init(0, 0);
    t.forward();
    return a < b;
}
pub fn main() void {
    var values = [_]u8{3, 2, 1};
    std.sort.block(u8, &values, {}, less);
}`;
  const result = traceProgram('zig', program, program);
  const lines = program.split('\n');
  const sortLine = lines.findIndex((line) => line.includes('std.sort.block')) + 1;
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.some((item) => item.callLines.length > 0)).toBe(true);
  for (const item of result.traceItems) {
    expect(item.line).toBeLessThanOrEqual(lines.length);
    expect(item.callLines.every((line) => line === sortLine)).toBe(true);
    expect(item.callLines.length).toBeLessThanOrEqual(1);
  }
});

test.each([
  'fn make() Turtle { defer observe(); return Turtle.init(0,1); } pub fn main() void { const t=make(); t.forward(); }',
  'pub fn main() void { const t=blk:{ defer observe(); break :blk Turtle.init(0,1); }; t.forward(); }',
  'fn make(flag: bool) Turtle { defer observe(); return blk:{ defer observe(); if (flag) return Turtle.init(0,1); break :blk Turtle.init(0,1); }; } pub fn main() void { const t=make(true); t.forward(); }',
  'fn make() ?Turtle { defer observe(); return Turtle.init(0,1); } pub fn main() void { const t=make().?; t.forward(); }',
])('pending jump values remain reachable through deferred calls: %s', (body) => {
  const source = `const std=@import("std");
fn observe() void { const t=Turtle.init(0,0); std.debug.print("{}|", .{t.canMoveForward()}); }
${body}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.stderr).not.toContain('true');
  expect(result.stderr).toContain('false|');
  expect(result.finalTurtles).toEqual([{ x: 0, y: 2, color: '#', dir: 'N' }]);
});

test('cyclic slice graphs render without changing execution or losing later steps', () => {
  const source = `const std=@import("std");const Node=struct{children:[]Node};pub fn main()void{var nodes:[2]Node=undefined;nodes[0]=.{.children=nodes[1..2]};nodes[1]=.{.children=nodes[0..1]};const n=nodes[0].children.len;std.debug.print("{}",.{n});}`;
  const execution = executeProgram('zig', source);
  const recorded = traceProgram('zig', source, source);
  expect(recorded.stderr).toBe(execution.kind === 'executed' ? execution.stderr : undefined);
  expect(recorded.stderr).toBe('1');
  expect(recorded.uncaughtException).toBeUndefined();
  expect(recorded.traceItems.length).toBeGreaterThan(1);
});

test('optional and error union wrappers preserve aggregate and pointer trace children', () => {
  const source = `const Node=struct{v:u8,next:?*Node=null};pub fn main()void{var a=Node{.v=1};var b=Node{.v=2,.next=&a};const o:?*Node=&a;const s:?Node=.{.v=3,.next=&b};const e:error{Oops}!Node=.{.v=4,.next=&a};_=.{&b,o,s,e};}`;
  const result = traceProgram('zig', source, source);
  // oxlint-disable-next-line unicorn/no-null -- Trace nodes represent Zig null with JSON null.
  const leaf = { kind: 'object', entries: { v: { kind: 'value', value: 1 }, next: { kind: 'value', value: null } } };
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.at(-1)?.referenceVars).toMatchObject({
    b: { kind: 'object', entries: { v: { kind: 'value', value: 2 }, next: leaf } },
    o: leaf,
    s: {
      kind: 'object',
      entries: {
        v: { kind: 'value', value: 3 },
        next: { kind: 'object', entries: { v: { kind: 'value', value: 2 }, next: leaf } },
      },
    },
    e: { kind: 'object', entries: { v: { kind: 'value', value: 4 }, next: leaf } },
  });
});

test('prototype-like names survive trace dictionaries and snapshot comparisons', () => {
  const source = `pub fn main()void{
var __proto__:i32=1;
const valueOf:i32=2;
const constructor:i32=3;
const s=.{.__proto__=@as(i32,4),.valueOf=@as(i32,5),.constructor=@as(i32,6)};
__proto__+=1;
_=.{__proto__,valueOf,constructor,s};
}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalVars).toMatchObject({ ['__proto__']: 2, valueOf: 2, constructor: 3 });
  expect(result.traceItems.at(-1)?.referenceVars.s).toMatchObject({
    kind: 'object',
    entries: {
      ['__proto__']: { kind: 'value', value: 4 },
      valueOf: { kind: 'value', value: 5 },
      constructor: { kind: 'value', value: 6 },
    },
  });
});

test('tracing undefined pointer metadata does not dereference it', () => {
  const source = `pub fn main()void{
var q:*i32=undefined;
_=&q;
}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalVars).toMatchObject({ q: 'undefined' });
  const faulting = source.replace('_=&q;', '_=&q; q.*=3;');
  expect(traceProgram('zig', faulting, faulting).uncaughtException).toBe('Segmentation fault');
});

test.each([false, true])('many atomic function headers are indexed (multiline: %s)', (multiline) => {
  const atomicAnnotations = new Map<number, number>();
  let offset = 0;
  let row = 0;
  const headers = Array.from({ length: 8000 }, (_, index) => {
    const header = multiline ? `fn fun${index}(\n) void // atomic\n{\n}\n` : `fn fun${index}() void { // atomic\n}\n`;
    atomicAnnotations.set(row + (multiline ? 1 : 0), offset + header.indexOf('// atomic'));
    offset += header.length;
    row += multiline ? 4 : 2;
    return header;
  }).join('');
  expect(traceZigProgram(`${headers}pub fn main()void{}`, { atomicAnnotations }).uncaughtException).toBeUndefined();
});

test.each([
  'var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const s=a.allocatedSlice();',
  'const s=try init.gpa.alloc(void,1000001);',
  'const s=try init.gpa.alloc(u0,1000001);',
])('virtual slice snapshots stay bounded and preserve execution: %s', (declaration) => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{\n${declaration}\nstd.debug.print("{}",.{s.len});\n}`;
  const result = traceProgram('zig', source, source);
  const execution = executeProgram('zig', source);
  expect(execution).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  expect(result.stderr).toBe(execution.kind === 'executed' ? execution.stderr : undefined);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.length).toBeGreaterThan(1);
  const preview = result.traceItems.at(-1)?.referenceVars.s;
  expect(preview?.kind).toBe('array');
  if (preview?.kind === 'array') {
    expect(Object.keys(preview.entries).length).toBeLessThanOrEqual(2000);
    expect(preview.entries['…']).toMatchObject({ kind: 'value', verbatim: true });
  }
  expect(result.finalVars).not.toHaveProperty('s');
});

test.each(['f80', 'f128'])('extended %s trace values retain integral changes and array elements', (type) => {
  const source = `const std=@import("std");pub fn main()void{\nvar x:${type}=9007199254740992;\nx+=1;\nconst a=[_]${type}{x};\n_=a;std.debug.print("{d}",.{x});\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.stderr).toBe('9007199254740993');
  expect(result.finalVars).toMatchObject({ x: 9_007_199_254_740_993n, a: [9_007_199_254_740_993n] });
  expect(result.traceItems.at(-1)?.referenceVars.a).toMatchObject({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 9_007_199_254_740_993n } },
  });
});

test.each([
  ['f80', '0x1.0000000000000002p0', '1.0000000000000000001'],
  ['f128', '0x1.0000000000000000000000000001p0', '1.0000000000000000000000000000000002'],
])('extended %s fractional traces keep shortest round-trip decimals', (type, literal, expected) => {
  const source = `pub fn main()void{\nconst x:${type}=${literal};\nconst a=[_]${type}{x};\n_=a;\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.finalVars).toMatchObject({ x: expected, a: [expected] });
  const grade = (answer: string): RegularGradingResult =>
    gradeRegularAnswers({
      expectedBoard: result.finalBoard,
      expectedTurtles: result.finalTurtles,
      expectedVariables: result.finalVars,
      answerBoard: Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => '.' as const)),
      answerTurtles: [],
      answerVariables: { x: answer },
      initialVariables: {},
    });
  expect(grade(expected).status).toBe('correct');
  expect(grade('1').status).toBe('incorrect');
  expect(result.traceItems.at(-1)?.referenceVars.a).toMatchObject({
    kind: 'array',
    entries: { 0: { kind: 'value', value: expected, verbatim: true } },
  });
});

test('large byte strings and nested numeric arrays use bounded reference previews', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{\nconst s=try init.gpa.alloc(u8,20000);\n@memset(s,120);\nconst a:[20000]u0=@splat(0);\n_=.{s,a};\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalVars).not.toHaveProperty('s');
  expect(result.finalVars).not.toHaveProperty('a');
  const previews = result.traceItems.at(-1)?.referenceVars;
  expect(previews?.s).toMatchObject({ kind: 'value' });
  if (previews?.s.kind === 'value') expect(String(previews.s.value)).toContain('… (20000 bytes)');
  expect(previews?.a).toMatchObject({ kind: 'array', entries: { '…': { kind: 'value', value: '… (20000 items)' } } });
});

test.each(['u8', 'u16'])('repeated %s array views report an exhausted trace allowance', (type) => {
  const views = Array.from({ length: 100 }, (_, i) => `const a${i}:[]const ${type}=&a;`).join('');
  const uses = Array.from({ length: 100 }, (_, i) => `_=a${i};`).join('');
  const source = `const std=@import("std");pub fn main()void{var a:[9999]${type}=@splat(97);_=&a;${views}${uses}std.debug.print("done",.{});}`;
  expect(() => traceProgram('zig', source, source)).toThrow(new ExecutionLimitError('trace'));
});

test('oversized numeric preview work reports a trace limit', () => {
  const source = `pub fn main()void{const x:u65535=1<<65534;for(0..100)|_|{_=x;}}`;
  expect(() => traceProgram('zig', source, source)).toThrow(new ExecutionLimitError('trace'));
});

test.each([
  ['[0]u8', '[]u8', ''],
  ['[2]u0', '[]u0', [0, 0]],
])('constructed %s slices trace their valid zero-byte values', (array, slice, expected) => {
  const source = `pub fn main()void{\nconst p:*[1]${array}=undefined;\nfor(p)|*item|{\nconst s:${slice}=item;\n_=s;\n}\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(
    result.traceItems.some(
      (item) => Object.hasOwn(item.vars, 's') && JSON.stringify(item.vars.s) === JSON.stringify(expected)
    )
  ).toBe(true);
});

test.each(['|p,n|', '|_,n|'])('mixed for captures record repeated numeric bindings: %s', (captures) => {
  const source = `const P=struct{x:u8};\npub fn main()void{\nfor([_]P{.{.x=1},.{.x=1}},[_]u8{7,7}) ${captures} {\n${captures === '|p,n|' ? '_=p;' : ''}_=n;\n}\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.traceItems.map((item) => item.line)).toEqual(
    captures === '|p,n|' ? [0, 3, 4, 4, 3, 4, 4] : [0, 3, 4, 3, 4]
  );
});

test('discarded loop captures produce no binding steps', () => {
  const source = `pub fn main()void{\nfor([_]u8{7,7},[_]u8{7,7})|_,_|{\n}\n}`;
  expect(traceProgram('zig', source, source).traceItems.map((item) => item.line)).toEqual([0]);
});

test.each(['u8', 'u16'])('single %s pointer captures remain reference-only bindings', (type) => {
  const source = `pub fn main()void{\nvar a=[_]${type}{1,1};\nfor(&a)|*p|{\n_=p;\n}\n}`;
  expect(traceProgram('zig', source, source).traceItems.map((item) => item.line)).toEqual([0, 2, 4, 4]);
});

test('quoted underscore locals, parameters and captures remain visible trace variables', () => {
  const source = `fn add(@"_":u8)u8{\nreturn @"_"+1;\n}\nfn capture()void{\nfor([_]u8{9})|@"_"|{\n_=@"_";\n}\n}\npub fn main()void{\nvar @"_":u8=7;\n@"_"=add(@"_");\ncapture();\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalVars).toHaveProperty('_', 8);
  expect(result.traceItems.some((item) => item.vars._ === 7)).toBe(true);
  expect(result.traceItems.some((item) => item.vars._ === 9)).toBe(true);
});

test.each(['for', 'inline for'])('%s discarded captures add no binding steps', (loop) => {
  const source = `pub fn main()void{\n${loop}(0..2)|_|{}\n}`;
  expect(traceProgram('zig', source, source).traceItems.map((item) => item.line)).toEqual([0]);
});

test('inline for quoted underscore captures retain actual answer binding steps', () => {
  const source = `pub fn main()void{\ninline for([_]u8{7,7})|@"_"|{\n_=@"_";\n}\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 2, 3, 2, 3]);
  expect(result.traceItems.filter((item) => item.line === 2).map((item) => item.vars._)).toEqual([7, 7]);
});

test('wide enum snapshots retain late names in scalars, arrays and optionals', () => {
  const fields = Array.from({ length: 30_000 }, (_, i) => `f${i}`).join(',');
  const source = `const E=enum{${fields}};pub fn main()void{\nconst e:E=.f29999;\nconst a=[_]E{.f29999,.f29998};\nconst o:?E=.f29997;\nfor(0..1000)|i|{\n_=i;\n}\n_=e;_=a;_=o;\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.finalVars).toMatchObject({ e: '.f29999', a: ['.f29999', '.f29998'], o: '.f29997' });
  expect(result.traceItems.filter((item) => item.vars.e === '.f29999').length).toBeGreaterThan(1000);
});

test.each(['x:u8,', ''])('receiver previews do not dereference undefined pointers with fields %s', (fields) => {
  const source = `const std=@import("std");const S=struct{${fields}fn f(self:*S)void{_=self;std.debug.print("ok",.{});}};fn ptr()*S{return undefined;}pub fn main()void{ptr().f();}`;
  const result = traceProgram('zig', source, source);
  expect(result).toMatchObject({ stderr: 'ok', uncaughtException: undefined });
  expect(result.traceItems.length).toBeGreaterThan(0);
});

test('scalar trace answers survive optional and error-union wrappers', () => {
  const source = `pub fn main()void{\nconst e:error{Bad}!u8=1;\nconst a=[_]error{Bad}!u8{1,error.Bad};\nconst o:?comptime_int=2;\n_=.{e,a,o};\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.finalVars).toMatchObject({ e: 1, a: [1, 'error.Bad'], o: 2 });
});

test('repeated error-union scalar captures retain binding steps', () => {
  const source = `pub fn main()void{\nfor([_]error{Bad}!u8{1,1})|x|{\n_=x catch unreachable;\n}\n}`;
  const result = traceProgram('zig', source, source);
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 2, 3, 2, 3]);
});

test.each([
  [100, 1000],
  [200, 500],
])('repeated %s-element array snapshots retain final answers after %s updates', (length, count) => {
  const source = `pub fn main()void{
var a:[${length}]u32=@splat(0);
var i:usize=0;
while(i<${count}):(i+=1){a[i%${length}]+=1;}
}`;
  const result = traceProgram('zig', source, source);
  expect(result.finalVars).toMatchObject({
    a: Array.from({ length }, (_, i) => Math.floor(count / length) + (i < count % length ? 1 : 0)),
    i: count,
  });
  expect(result.traceItems).toHaveLength(count * 2 + 3);
  expect(result.traceItems.every((item) => item.referenceVars['…'] === undefined)).toBe(true);
});

test('stored native methods preserve callback call lines without adapter frames', () => {
  const source = `const std=@import("std");
fn compare(_:void,a:u8,b:u8)std.math.Order{
    const marker:u8=1;
    _=marker;
    return std.math.order(a,b);
}
const Q=std.PriorityQueue(u8,void,compare);
pub fn main(init:std.process.Init)!void{
    var q:Q=.empty;
    defer q.deinit(init.gpa);
    const append:*const fn(*Q,std.mem.Allocator,u8)std.mem.Allocator.Error!void=Q.push;
    try append(&q,init.gpa,2);
    try append(&q,init.gpa,1);
}`;
  const result = traceProgram('zig', source, source);
  const callLine = source.split('\n').findIndex((line) => line.includes('try append(&q,init.gpa,1)')) + 1;
  expect(result.uncaughtException).toBeUndefined();
  const callbacks = result.traceItems.filter((item) => item.vars.marker === 1);
  expect(callbacks.length).toBeGreaterThan(0);
  expect(callbacks.every((item) => item.callLines.length === 1 && item.callLines[0] === callLine)).toBe(true);
});
