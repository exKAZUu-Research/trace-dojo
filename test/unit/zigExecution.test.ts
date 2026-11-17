import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('std.debug.print writes to standard error and a stdout writer only what it flushed', () => {
  const program = `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    var buf: [8]u8 = undefined;
    var w = std.Io.File.stdout().writer(init.io, &buf);
    const out = &w.interface;
    try out.print("abc", .{});
    try out.print("defghijk", .{});
    try out.print("zz", .{});
    std.debug.print("{d:5}|{d:<5}|{d:0>6}|{x}\\n", .{ @as(i32, -42), @as(i32, 7), @as(i32, 7), @as(i32, -255) });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'abcdefghijk',
    stderr: '  -42|+7   |0000+7|-ff\n',
    uncaughtException: undefined,
  });
});

test('floats print as std.fmt renders their shortest digits, a comptime_float with f128 precision', () => {
  const program = `const std = @import("std");
pub fn main() void {
    var a: f64 = 0.1;
    a += 0.2;
    const b: f32 = 1.0 / 3.0;
    std.debug.print("{} {e} {d:.1} {d:.1} {d:.0} {}\\n", .{ a, a, 0.25, 0.35, 0.5, b });
    std.debug.print("{d} {}\\n", .{ 1.0 / 3.0, 1e100 });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    stderr: [
      '0.30000000000000004 3.0000000000000004e-1 0.3 0.4 1 0.33333334',
      `0.3333333333333333333333333333333333 1${'0'.repeat(100)}`,
      '',
    ].join('\n'),
  });
});

test('collections grow and iterate in Zig order, and seeded random numbers match', () => {
  const program = `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    var list: std.ArrayList(i32) = .empty;
    defer list.deinit(gpa);
    for (0..34) |i| try list.append(gpa, @intCast(i));
    var map = std.AutoHashMap(u32, u8).init(gpa);
    defer map.deinit();
    for ([_]u32{ 10, 3, 77, 1000, 5 }) |k| try map.put(k, 1);
    _ = map.remove(3);
    var it = map.keyIterator();
    while (it.next()) |k| std.debug.print("{} ", .{k.*});
    var prng = std.Random.DefaultPrng.init(42);
    const rand = prng.random();
    var deck = [_]u8{ 1, 2, 3, 4, 5, 6, 7, 8 };
    rand.shuffle(u8, &deck);
    std.debug.print("| {} {} {any}\\n", .{ list.capacity, rand.intRangeAtMost(i32, 1, 6), deck });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    stderr: '1000 5 10 77 | 83 1 { 7, 4, 8, 1, 3, 2, 6, 5 }\n',
  });
});

test('ranges with arithmetic ends, assignments after else, decl literals, and mixed int and float operands run', () => {
  const program = `const std = @import("std");
const S = struct {
    v: i32,
    fn init(v: i32) S {
        return .{ .v = v };
    }
};
fn check(n: usize) !usize {
    return if (n > 3) error.TooBig else n;
}
pub fn main() void {
    const a = [_]i32{ 1, 3, 5, 7, 9 };
    var n: usize = 3;
    _ = &n;
    for (0..n - 1) |i| std.debug.print("{d}", .{a[i + 1 ..][0]});
    var lo: usize = 0;
    var hi: usize = a.len;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        if (a[mid] < 7) lo = mid + 1 else hi = mid;
    }
    const s: S = .init(4);
    var x: f64 = 0.5;
    _ = &x;
    std.debug.print(" {d} {d} {d} {any} {!}\\n", .{ lo, s.v, x * s.v, a[n - 2 .. n + 1], check(n + 1) });
}`;
  expect(executeProgram('zig', program)).toMatchObject({ stderr: '35 3 4 2 { 3, 5, 7 } error.TooBig\n' });
});

test('format methods, copies of returned and looped values, and integer builtins follow Zig', () => {
  const program = `const std = @import("std");
const P = struct {
    x: i32,
    pub fn format(self: P, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.print("P({d})", .{self.x});
    }
};
fn pair() [2]i32 {
    var a = [_]i32{ 1, 1 };
    defer a[0] = 9;
    return a;
}
pub fn main() void {
    var sum: i32 = 0;
    for (0..4) |i| sum += @intCast(i);
    var o: ?u8 = 5;
    _ = &o;
    var arr = [_]i32{ 1, 2, 3 };
    for (arr) |v| {
        arr[2] = 100;
        sum += v;
    }
    std.debug.print("{f} {d} {d} {d} {} {any}\\n", .{ P{ .x = sum }, @rem(@as(i32, 10), -3), @mod(@as(i32, 10), -3), @min(@as(u8, 7), 1000), o == 5, pair() });
}`;
  expect(executeProgram('zig', program)).toMatchObject({ stderr: 'P(12) 1 -2 7 true { 1, 1 }\n' });
});

test('compile errors are reported on the rows Zig reports them', () => {
  const missingSemicolon = `const std = @import("std");
pub fn main() void {
    const a: i32 = 1
    std.debug.print("{d}\\n", .{a});
}`;
  const unusedAndTypeError = `pub fn main() void {
    const x = 5;
    const y: u8 = 300;
    _ = y;
}`;
  const pointlessDiscard = `const std = @import("std");
pub fn main() void {
    const x: i32 = 5;
    _ = x;
    std.debug.print("{d}\\n", .{x});
}`;
  expect(rows(missingSemicolon)).toEqual([2]);
  expect(rows(unusedAndTypeError)).toEqual([1, 2]);
  expect(rows(pointlessDiscard)).toEqual([3]);
});

test('unstable sorts leave equal elements in the order of pdqsort and heapsort in Zig', () => {
  const program = `const std = @import("std");
const P = struct { name: []const u8, age: u32 };
fn byAge(_: void, a: P, b: P) bool {
    return a.age < b.age;
}
pub fn main() void {
    var ps: [30]P = undefined;
    const names = "abcdefghijklmnopqrstuvwxyz0123";
    for (&ps, 0..) |*p, i| p.* = .{ .name = names[i..][0..1], .age = @intCast((i * 7) % 5) };
    var q = ps;
    std.sort.pdq(P, &q, {}, byAge);
    for (q) |p| std.debug.print("{s}", .{p.name});
    std.debug.print("\\n", .{});
    q = ps;
    std.sort.heap(P, &q, {}, byAge);
    for (q) |p| std.debug.print("{s}", .{p.name});
    std.debug.print("\\n", .{});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    stderr: 'ufzkap2dixnsb0gvlqotyje3rhwm1c\nfkzuapnx2isdg0lvbq3yeojt1cmwrh\n',
  });
});

test('assigning an anonymous literal writes each field in turn, as result locations do', () => {
  const program = `const std = @import("std");
pub fn main() void {
    var s: struct { x: i32, y: i32 } = .{ .x = 1, .y = 2 };
    s = .{ .x = s.y, .y = s.x };
    var m: i32 = 1;
    var n: i32 = 2;
    m, n = .{ n, m };
    std.debug.print("{} {} {} {}\\n", .{ s.x, s.y, m, n });
}`;
  expect(executeProgram('zig', program)).toMatchObject({ stderr: '2 2 2 2\n' });
});

test('safety checks and errors returned from main end the program with Zig messages', () => {
  const outOfBounds = `pub fn main() void {
    var a = [_]i32{ 1, 2, 3 };
    var i: usize = 3;
    i += 0;
    a[i] = 1;
}`;
  const overflow = `pub fn main() void {
    var x: u8 = 255;
    x += 1;
}`;
  const unwrap = `fn f() !i32 {
    return error.Bad;
}
pub fn main() void {
    _ = f() catch unreachable;
}`;
  const mainError = `pub fn main() !void {
    return error.Failed;
}`;
  expect(executeProgram('zig', outOfBounds)).toMatchObject({
    uncaughtException: 'panic: index out of bounds: index 3, len 3',
  });
  expect(executeProgram('zig', overflow)).toMatchObject({ uncaughtException: 'panic: integer overflow' });
  expect(executeProgram('zig', unwrap)).toMatchObject({ uncaughtException: 'panic: attempt to unwrap error: Bad' });
  expect(executeProgram('zig', mainError)).toMatchObject({ uncaughtException: 'error: Failed' });
});

test('AstGen errors stop every function, while type errors stop only the functions main uses', () => {
  const neverMutated = `fn unused() void {
    var x: i32 = 1;
    _ = x;
}
pub fn main() void {}`;
  const lazyTypeError = `fn unused() void {
    const x: u8 = 300;
    _ = x;
}
pub fn main() void {}`;
  const usedTypeError = `fn used() void {
    const x: u8 = 300;
    _ = x;
}
pub fn main() void {
    used();
}`;
  expect(executeProgram('zig', neverMutated)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 1 }] });
  expect(executeProgram('zig', lazyTypeError)).toMatchObject({ kind: 'executed' });
  expect(executeProgram('zig', usedTypeError)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 1 }] });
});

test('features this grader does not run are rejected with the stage message', () => {
  const thread = `const std = @import("std");
fn work() void {}
pub fn main() !void {
    const t = try std.Thread.spawn(.{}, work, .{});
    t.join();
}`;
  const comptimeParameter = `fn zero(comptime T: type) T {
    return 0;
}
pub fn main() void {
    _ = zero(i32);
}`;
  expect(executeProgram('zig', thread)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: 'スレッド（std.Thread）は、この採点環境では使えません。' }],
  });
  expect(executeProgram('zig', comptimeParameter)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'comptime の引数は、この採点環境では使えません。' }],
  });
});

function rows(program: string): number[] {
  const result = executeProgram('zig', program);
  return result.kind === 'compileError' ? result.diagnostics.map((diagnostic) => diagnostic.row) : [];
}

test('compilation bounds array storage before materializing undefined and repeated values', () => {
  const declarations = [
    'var a: [4294967296]u8 = undefined; _ = &a;',
    'var a: [1001][1000]u8 = undefined; _ = &a;',
    'const a: [4294967296]u8 = @splat(1); _ = a;',
    'const a: [1001][1000]u8 = @splat(undefined); _ = a;',
    'var a: [600000]u8 = undefined; var b: [600000]u8 = undefined; _ = &a; _ = &b;',
  ];
  for (const declaration of declarations) {
    expect(executeProgram('zig', `pub fn main() void { ${declaration} }`)).toEqual({
      kind: 'limitExceeded',
      limit: 'storage',
    });
  }
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");
pub fn main() void {
    var a: [2][3]u8 = undefined;
    _ = &a;
    const b: [3]u8 = @splat(2);
    const empty: [0]u8 = @splat(1);
    std.debug.print("{any} {any} {}", .{ a, b, empty.len });
}`
    )
  ).toMatchObject({
    kind: 'executed',
    stderr: '{ { 170, 170, 170 }, { 170, 170, 170 } } { 2, 2, 2 } 0',
    uncaughtException: undefined,
  });
});

test('UTF-8 output spans debug writes and independent file writer flushes', () => {
  const program = `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    var buf: [1]u8 = undefined;
    var w = std.Io.File.stdout().writer(init.io, &buf);
    const out = &w.interface;
    for ([_]u8{ 0xe3, 0x81, 0x82 }) |byte| {
        std.debug.print("{c}", .{byte});
        try out.writeByte(byte);
        try out.flush();
    }
    std.debug.print("{c}", .{@as(u8, 0xe3)});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'あ',
    stderr: 'あ�',
    uncaughtException: undefined,
  });
});

test('memory builtins copy aggregate values while preserving destination pointers', () => {
  const program = `const std = @import("std");
const P = struct { x: i32 };
pub fn main() void {
    var a = [_]P{ .{ .x = 1 }, .{ .x = 3 }, .{ .x = 5 } };
    var b: [3]P = undefined;
    const p = &b[0].x;
    @memcpy(&b, &a);
    b[0].x = 2;
    std.debug.print("{} {} {}|", .{ a[0].x, b[0].x, p.* });
    @memmove(a[1..3], a[0..2]);
    std.debug.print("{} {} {}|", .{ a[0].x, a[1].x, a[2].x });
    @memset(&b, .{ .x = 7 });
    b[0].x = 8;
    std.debug.print("{} {} {}", .{ p.*, b[1].x, b[2].x });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 2|1 1 3|8 7 7',
    uncaughtException: undefined,
  });
});

test('extended float library comparisons and remainder handle finite values, infinities, and NaN', () => {
  const program = `const std = @import("std");
pub fn main() void {
    const a = [_]f128{ 1.0, 2.0 };
    const b = [_]f128{ 1.0, 2.0 };
    const inf = std.math.inf(f128);
    const nan = std.math.nan(f128);
    std.debug.print("{} {} {} {} {} {} {} {d} {d}", .{
        std.mem.eql(f128, &a, &b), std.mem.indexOfScalar(f128, &a, 2.0).?,
        std.sort.asc(f128)({}, 1.0, 2.0), inf > @as(f128, 1.0), -inf < @as(f128, -1.0),
        std.sort.asc(f128)({}, nan, 1.0), std.mem.eql(f128, &[_]f128{nan}, &[_]f128{nan}),
        @rem(@as(f128, 1.0), inf), @rem(@as(f128, -1.0), -inf),
    });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true 1 true true true false false 1 -1',
    uncaughtException: undefined,
  });
});

test('ArrayList clones own aggregate elements and reject unbounded appendNTimes', () => {
  const program = `const std = @import("std");
const P = struct { x: [2]i32 };
pub fn main(init: std.process.Init) !void {
    var a: std.ArrayList(P) = .empty;
    defer a.deinit(init.gpa);
    try a.append(init.gpa, .{ .x = .{ 1, 3 } });
    var b = try a.clone(init.gpa);
    defer b.deinit(init.gpa);
    b.items[0].x[0] = 2;
    try b.appendNTimes(init.gpa, .{ .x = .{ 4, 5 } }, 2);
    b.items[1].x[0] = 6;
    std.debug.print("{} {} {} {}|", .{ a.items[0].x[0], b.items[0].x[0], b.items[1].x[0], b.items[2].x[0] });
    b.appendNTimes(init.gpa, .{ .x = .{ 0, 0 } }, 4294967296) catch |err| {
        std.debug.print("{s} {}", .{ @errorName(err), b.items.len });
    };
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 6 4|OutOfMemory 3',
    uncaughtException: undefined,
  });
});

test('native containers copy records and nominal map types stay independent across executions', () => {
  const program = `const std = @import("std");
const P = struct { x: i32 };
fn order(_: void, a: P, b: P) std.math.Order { return std.math.order(a.x, b.x); }
pub fn main(init: std.process.Init) !void {
    var p = P{ .x = 1 };
    var map = std.AutoHashMap(u8, P).init(init.gpa);
    defer map.deinit();
    try map.put(1, p);
    var queue: std.PriorityQueue(P, void, order) = .empty;
    defer queue.deinit(init.gpa);
    try queue.push(init.gpa, p);
    p.x = 3;
    std.debug.print("{} {}|", .{map.get(1).?.x, queue.peek().?.x});
    map.getPtr(1).?.x = 7;
    std.debug.print("{} {}", .{p.x, map.get(1).?.x});
}`;
  for (let run = 0; run < 3; run++) {
    expect(executeProgram('zig', program)).toMatchObject({
      kind: 'executed',
      stderr: '1 1|3 7',
      uncaughtException: undefined,
    });
  }
});

test('zeroed values reserve nested storage and integer square root scales to u64', () => {
  for (const type of ['[4294967296]u8', '[1001][1000]u8']) {
    expect(
      executeProgram(
        'zig',
        `const std = @import("std"); pub fn main() void { const a = std.mem.zeroes(${type}); _ = a; }`
      )
    ).toEqual({ kind: 'limitExceeded', limit: 'storage' });
  }
  const program = `const std = @import("std");
pub fn main() void {
    var x: u64 = 18446744073709551615;
    _ = &x;
    std.debug.print("{} {} {d}", .{
        std.math.sqrt(x), std.math.sqrt(@as(u64, 1000000000000000000)), std.mem.zeroes(f128),
    });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '4294967295 1000000000 0',
    uncaughtException: undefined,
  });
});

test('extended rounding keeps exact digits and fused multiply-add preserves special values', () => {
  const program = `const std = @import("std");
pub fn main() void {
    const x: f128 = 9007199254740993.5;
    const inf = std.math.inf(f64);
    const nan = std.math.nan(f64);
    std.debug.print("{d} {d} {d} {d}|{d} {d} {d} {d} {d}", .{
        @floor(x), @ceil(x), @trunc(-x), @round(-x),
        @mulAdd(f64, inf, 2.0, 3.0), @mulAdd(f64, 0, inf, 3.0),
        @mulAdd(f64, inf, 2, -inf), @mulAdd(f64, nan, 2, 3), @mulAdd(f64, 2, 3, inf),
    });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '9007199254740993 9007199254740994 -9007199254740993 -9007199254740994|inf nan nan nan inf',
    uncaughtException: undefined,
  });
});

test('assignments and aggregate coercions evaluate side-effecting sources once', () => {
  const program = `const std = @import("std");
var n: i32 = 0;
fn index(i: *usize) usize { const old = i.*; i.* += 1; return old; }
fn pair() struct { i32, i32 } { n += 1; return .{ n, n }; }
const P = struct { i32, i32 };
fn cast(x: u64) !?u8 { return @intCast(x); }
pub fn main() void {
    var a = [_]u8{ 10, 20, 30 };
    var i: usize = 0;
    a[index(&i)] += 1;
    const b: [2]i32 = pair();
    const c: P = pair();
    std.debug.print("{any} {}|{any} {} {} {}|{!?}", .{ a, i, b, c.@"0", c.@"1", n, cast(7) });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '{ 11, 20, 30 } 1|{ 1, 1 } 2 2 2|7',
    uncaughtException: undefined,
  });
});

test('tagged unions preserve explicit enum values and require the declared tag order', () => {
  const program = `const std = @import("std");
const E = enum(u8) { a = 5, b = 10 };
const U = union(E) { a: i32, b: i32 };
pub fn main() void {
    const x: U = .{ .b = 3 };
    const tag: E = x;
    std.debug.print("{} {} {}", .{ @intFromEnum(tag), tag == .b, @intFromEnum(x) });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '10 true 10',
    uncaughtException: undefined,
  });
});

test('source-controlled shifts, formatting, writer repetition, and inline expansion stay bounded', () => {
  const bodies = [
    ['const a = 1 << 100000000000000000000; _ = a;', 'storage'],
    ['std.debug.print("{d:>2000000000}", .{1});', 'output'],
    ['inline for (0..10000000000) |_| {}', 'operations'],
    [
      'var buf: [8]u8 = undefined; var w = std.Io.File.stdout().writer(init.io, &buf); try w.interface.splatByteAll(65, 4294967296);',
      'output',
    ],
    [
      'var buf: [8]u8 = undefined; var w = std.Io.File.stdout().writer(init.io, &buf); try w.interface.splatBytesAll("abc", 4294967296);',
      'output',
    ],
  ];
  for (const [body, limit] of bodies) {
    expect(
      executeProgram(
        'zig',
        `const std = @import("std"); pub fn main(init: std.process.Init) !void { _ = &init; ${body} }`
      )
    ).toEqual({ kind: 'limitExceeded', limit });
  }
});

test('allocator capacity includes nested element storage before construction', () => {
  const program = `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    _ = init.gpa.alloc([600000]u8, 2) catch |err| { std.debug.print("{s}", .{@errorName(err)}); return; };
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory',
    uncaughtException: undefined,
  });
});

test('destructuring, pointer captures, and writable slice lengths retain their result storage', () => {
  const program = `const std = @import("std");
var n: usize = 0;
fn next() usize { const i = n; n += 1; return i; }
fn pair() [2]?u8 { return .{ null, 2 }; }
pub fn main() void {
    var a: ??u8 = null;
    var b: ??u8 = null;
    a, b = pair();
    if (a) |*p| { std.debug.print("{} ", .{p.* == null}); p.* = null; }
    var data = [_]?u8{ 1, 2 };
    if (data[next()]) |*p| { p.* += 3; }
    var slice: []?u8 = &data;
    slice.len -= 1;
    std.debug.print("{} {} {} {} {}", .{a == null, b == null, n, slice.len, slice[0].?});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true false false 1 1 4',
    uncaughtException: undefined,
  });
});

test('loop else and catch results apply coercions and inline loops evaluate their operand once', () => {
  const program = `const std = @import("std");
var n: i32 = 0;
fn get() [2]i32 { n += 1; return .{ n, n }; }
fn f() !i32 { return 3; }
pub fn main() void {
    const x: f64 = while (false) {} else 1;
    const y = f() catch @as(f64, 1.5);
    const z: f64 = for ([_]u8{}) |_| {} else 2;
    std.debug.print("{} {} {}|", .{x, y, z});
    inline for (get()) |value| { std.debug.print("{} ", .{value}); }
    std.debug.print("{}", .{n});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '1 3 2|1 1 1',
    uncaughtException: undefined,
  });
});

test('function pointer equality and union dispatch use semantic identities', () => {
  const program = `const std = @import("std");
const E = enum(u8) { a = 5, b = 10 };
const U = union(E) { a: i32, b: i32 };
fn f() void {}
fn g() void {}
pub fn main() void {
    const p: *const fn () void = &f;
    const q: ?*const fn () void = &g;
    std.debug.print("{} {}|", .{p == p, q == p});
    const u: U = .{ .b = 3 };
    switch (u) { .a => {}, .b => |value| std.debug.print("{}", .{value}) }
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true false|3',
    uncaughtException: undefined,
  });
});

test('extended finite bounds and remainders use exact binary representations', () => {
  const program = `const std = @import("std");
pub fn main() void {
    const x: f128 = 0x1p120;
    std.debug.print("{} {} {d} {d}", .{
        std.math.isFinite(std.math.floatMax(f128)), std.math.isFinite(std.math.floatMax(f80)),
        @rem(x, @as(f128, 3)), @rem(-x, @as(f128, 5)),
    });
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true true 1 -1',
    uncaughtException: undefined,
  });
});

test('dupe, concat, and list removal preserve independent aggregate storage', () => {
  const program = `const std = @import("std");
const P = struct { x: i32 };
pub fn main(init: std.process.Init) !void {
    var a = [_]P{ .{ .x = 1 } };
    const b = try init.gpa.dupe(P, &a);
    defer init.gpa.free(b);
    b[0].x = 9;
    const c = try std.mem.concat(init.gpa, P, &.{ &a, b });
    defer init.gpa.free(c);
    c[0].x = 8;
    var list: std.ArrayList(P) = .empty;
    defer list.deinit(init.gpa);
    try list.append(init.gpa, .{ .x = 2 });
    try list.append(init.gpa, .{ .x = 3 });
    _ = list.orderedRemove(0);
    const added = try list.addOne(init.gpa);
    added.x = 5;
    std.debug.print("{} {} {} {} {}", .{a[0].x, b[0].x, c[0].x, list.items[0].x, list.items[1].x});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '1 9 8 3 5',
    uncaughtException: undefined,
  });
});

test('file writers expose the supplied backing buffer before flush', () => {
  const program = `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    var buf: [32]u8 = undefined;
    var w = std.Io.File.stdout().writer(init.io, &buf);
    try w.interface.writeAll("hello");
    std.debug.print("{s} {s}", .{w.interface.buffered(), buf[0..5]});
    try w.interface.flush();
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hello',
    stderr: 'hello hello',
    uncaughtException: undefined,
  });
});

test('temporary formatting tuples keep later turtles alive through custom format callbacks', () => {
  const program = `const std = @import("std");
const P = struct {
    t: Turtle,
    pub fn format(self: P, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        try writer.print("{} ", .{self.t.canMoveForward()});
    }
};
pub fn main() void {
    std.debug.print("{f}{f}", .{P{.t = Turtle.init(0, 0)}, P{.t = Turtle.init(0, 1)}});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'false true ',
    uncaughtException: undefined,
  });
});

test('hash maps find equal nested aggregate keys after independent construction', () => {
  const program = `const std = @import("std");
const Key = struct { parts: [2]u8 };
pub fn main(init: std.process.Init) !void {
    var map = std.AutoHashMap(Key, u8).init(init.gpa);
    defer map.deinit();
    try map.put(.{ .parts = .{ 1, 2 } }, 7);
    const key: Key = .{ .parts = .{ 1, 2 } };
    try map.put(key, 9);
    std.debug.print("{} {}", .{map.get(.{ .parts = .{ 1, 2 } }).?, map.count()});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '9 1',
    uncaughtException: undefined,
  });
});

test('memory copy directions preserve aggregate values and destination pointers', () => {
  const program = `const std = @import("std");
const P = struct { x: [2]i32 };
pub fn main() void {
    var source = [_]P{ .{ .x = .{ 1, 2 } }, .{ .x = .{ 3, 4 } } };
    var destination: [2]P = undefined;
    const p = &destination[0].x[0];
    std.mem.copyForwards(P, &destination, &source);
    destination[0].x[0] = 9;
    std.debug.print("{} {} {}|", .{source[0].x[0], destination[0].x[0], p.*});
    var values = [_]P{ .{ .x = .{ 1, 2 } }, .{ .x = .{ 3, 4 } }, .{ .x = .{ 5, 6 } } };
    std.mem.copyBackwards(P, values[1..3], values[0..2]);
    std.debug.print("{} {} {}", .{values[0].x[0], values[1].x[0], values[2].x[0]});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '1 9 9|1 1 3',
    uncaughtException: undefined,
  });
});

test('native allocation and I/O arguments execute once in source order', () => {
  const program = `const std = @import("std");
var calls: usize = 0;
fn allocator(a: std.mem.Allocator) std.mem.Allocator { calls += 1; return a; }
fn io(value: std.Io) std.Io { calls += 1; return value; }
pub fn main(init: std.process.Init) !void {
    var map: std.AutoHashMapUnmanaged(u8, u8) = .empty;
    defer map.deinit(init.gpa);
    try map.put(allocator(init.gpa), 1, 2);
    const upper = try std.ascii.allocUpperString(allocator(init.gpa), "abc");
    defer init.gpa.free(upper);
    const joined = try std.mem.join(allocator(init.gpa), ":", &.{ "x", "y" });
    defer init.gpa.free(joined);
    var buffer: [8]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io(init.io), &buffer);
    try writer.interface.writeAll("ok");
    try writer.interface.flush();
    try std.Io.File.stdout().writeStreamingAll(io(init.io), "!");
    std.debug.print("{s} {s} {}", .{upper, joined, calls});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ok!',
    stderr: 'ABC x:y 5',
    uncaughtException: undefined,
  });
});

test.each(['@memcpy(&b, &a)', '@memmove(&b, &a)', '@memset(&b, a[0])', 'b = a'])(
  'nested optional aggregate stores preserve existing pointers (%s)',
  (operation) => {
    const program = `const std = @import("std");
const P = struct { x: [2]i32 };
pub fn main() void {
    var a = [_]??P{P{ .x = .{ 1, 2 } }};
    _ = &a;
    var b = [_]??P{P{ .x = .{ 3, 4 } }};
    const p = &b[0].?.?.x[0];
    ${operation};
    p.* = 5;
    std.debug.print("{} {} {}", .{b[0].?.?.x[0], p.*, a[0].?.?.x[0]});
}`;
    expect(executeProgram('zig', program)).toMatchObject({
      kind: 'executed',
      stderr: '5 5 1',
      uncaughtException: undefined,
    });
  }
);

test('while captures release their previous turtle before the next condition', () => {
  const program = `const std = @import("std");
var n: u8 = 0;
fn next() ?Turtle {
    if (n == 0) { n += 1; return Turtle.init(0, 1); }
    const t = Turtle.init(0, 0);
    std.debug.print("{}", .{t.canMoveForward()});
    return null;
}
pub fn main() void { while (next()) |t| { _ = t; } }`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true',
    uncaughtException: undefined,
  });
});

test('turtle collection traverses large aggregate roots without host argument limits', () => {
  const program = `pub fn main() void {
    var values: [200000]u8 = undefined;
    _ = &values;
    const t = Turtle.init();
    t.forward();
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [{ x: 0, y: 1, color: '#', dir: 'N' }],
    uncaughtException: undefined,
  });
});

test('virtual slice-length and optional payload addresses identify the same live storage', () => {
  const program = `const std = @import("std");
pub fn main() void {
    var data = [_]u8{ 1, 2, 3 };
    var slice: []u8 = &data;
    const p = &slice.len;
    const q = &slice.len;
    p.* = 2;
    var optional: ??u8 = @as(?u8, null);
    const a = &optional.?;
    const b = &optional.?;
    a.* = 7;
    std.debug.print("{} {} {} {}", .{p == q, q.*, a == b, b.*.?});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'true 2 true 7',
    uncaughtException: undefined,
  });
});

test.each([
  ['std.mem.reverse(P, &values)', 2],
  ['std.mem.rotate(P, &values, 1)', 1],
  ['std.mem.sort(P, &values, {}, less)', 1],
  ['std.sort.heap(P, &values, {}, less)', 1],
])('aggregate permutations preserve element field addresses (%s)', (operation, expected) => {
  const program = `const std = @import("std");
const P = struct { x: i32 };
fn less(_: void, a: P, b: P) bool { return a.x < b.x; }
pub fn main() void {
    var values = [_]P{ .{ .x = 3 }, .{ .x = 1 }, .{ .x = 2 } };
    const p = &values[0].x;
    ${operation};
    std.debug.print("{} {}", .{values[0].x, p.*});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: `${expected} ${expected}`,
    uncaughtException: undefined,
  });
});

test('swap, shuffle, and queue removal keep interior pointers attached to their locations', () => {
  const program = `const std = @import("std");
const P = struct { x: i32 };
fn order(_: void, a: P, b: P) std.math.Order { return std.math.order(a.x, b.x); }
pub fn main(init: std.process.Init) !void {
    var a = P{ .x = 1 };
    var b = P{ .x = 2 };
    const p = &a.x;
    std.mem.swap(P, &a, &b);
    var values = [_]P{ .{ .x = 1 }, .{ .x = 2 }, .{ .x = 3 } };
    const q = &values[0].x;
    var prng = std.Random.DefaultPrng.init(42);
    prng.random().shuffle(P, &values);
    var queue: std.PriorityQueue(P, void, order) = .empty;
    defer queue.deinit(init.gpa);
    try queue.push(init.gpa, .{ .x = 3 });
    try queue.push(init.gpa, .{ .x = 1 });
    try queue.push(init.gpa, .{ .x = 2 });
    const first = &queue.items[0].x;
    _ = queue.pop();
    std.debug.print("{} {} {} {}", .{a.x, p.*, values[0].x == q.*, first.*});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '2 2 true 2',
    uncaughtException: undefined,
  });
});

test('writer views and drains read the same authoritative backing storage', () => {
  const program = `const std = @import("std");
const P = struct {
    pub fn format(_: @This(), out: *std.Io.Writer) std.Io.Writer.Error!void {
        try out.writeAll("abc");
        const view = out.buffered();
        view[0] = 88;
    }
};
pub fn main(init: std.process.Init) !void {
    var buffer: [8]u8 = undefined;
    var w = std.Io.File.stdout().writer(init.io, &buffer);
    try w.interface.writeAll("abc");
    buffer[0] = 88;
    std.debug.print("{s}|", .{w.interface.buffered()});
    try w.interface.flush();
    try w.interface.writeAll("def");
    buffer[0] = 89;
    try w.interface.writeAll("0123456789");
    var fixedBuffer: [8]u8 = undefined;
    var fixed = std.Io.Writer.fixed(&fixedBuffer);
    try fixed.writeAll("abc");
    const view = fixed.buffered();
    view[1] = 90;
    std.debug.print("{s}|{f}", .{fixed.buffered(), P{}});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'XbcYef0123456789',
    stderr: 'Xbc|XZc|abc',
    uncaughtException: undefined,
  });
});

test('custom formatters share pending bytes with file, fixed, and allocation writers', () => {
  const program = `const std = @import("std");
const P = struct {
    pub fn format(_: @This(), out: *std.Io.Writer) std.Io.Writer.Error!void {
        try out.writeAll("abc");
        const bytes = out.buffered();
        bytes[0] = 88;
    }
};
pub fn main(init: std.process.Init) !void {
    var buffer: [32]u8 = undefined;
    var file = std.Io.File.stdout().writer(init.io, &buffer);
    try file.interface.writeAll("start");
    try file.interface.print("{f}", .{P{}});
    try file.interface.flush();
    var fixedBuffer: [8]u8 = undefined;
    var fixed = std.Io.Writer.fixed(&fixedBuffer);
    try fixed.writeAll("a");
    try fixed.print("{f}", .{P{}});
    var fmtBuffer: [8]u8 = undefined;
    const formatted = try std.fmt.bufPrint(&fmtBuffer, "a{f}", .{P{}});
    const allocated = try std.fmt.allocPrint(init.gpa, "a{f}", .{P{}});
    defer init.gpa.free(allocated);
    std.debug.print("{s}|{s}|{s}", .{fixed.buffered(), formatted, allocated});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Xtartabc',
    stderr: 'Xabc|Xabc|Xabc',
    uncaughtException: undefined,
  });
});

test('evaluates receivers, indices, comparisons, fields, and assignment locations in source order', () => {
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");var n:u8=0;fn rand(p:*std.Random.DefaultPrng)std.Random{n=n*10+1;return p.random();}fn buf(b:[]u8)[]u8{n=n*10+2;return b;}pub fn main()void{var p=std.Random.DefaultPrng.init(0);var b:[2]u8=undefined;rand(&p).bytes(buf(&b));std.debug.print("{}",.{n});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '12', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");var n:u8=0;fn base(a:*[2]u8)*[2]u8{n=n*10+1;return a;}fn idx()usize{n=n*10+2;return 0;}pub fn main()void{var a=[_]u8{3,4};const x=base(&a)[idx()];std.debug.print("{} {}",.{x,n});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '3 12', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");var n:u8=0;fn err()anyerror{n=n*10+1;return error.Bad;}fn result()anyerror!u8{n=n*10+2;return error.Bad;}pub fn main()void{const equal=err()==result();std.debug.print("{} {}",.{equal,n});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: 'true 12', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");var n:u8=0;fn mark(x:u8)u8{n=n*10+x;return n;}const P=struct{a:u8,b:u8};pub fn main()void{const p=P{.b=mark(2),.a=mark(1)};std.debug.print("{} {} {}",.{n,p.a,p.b});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '21 21 2', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");var n:u8=0;fn idx()usize{n=n*10+1;return 0;}fn val()u8{n=n*10+2;return 8;}pub fn main()void{var a=[_]u8{0};a[idx()]=val();std.debug.print("{} {}",.{n,a[0]});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '12 8', uncaughtException: undefined });
});

test('copies destructured arrays, inline loop values, and optional return payloads', () => {
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var a=[_]u8{1,2};a[1],a[0]=a;std.debug.print("{} {}",.{a[0],a[1]});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '2 1', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var a=[_]u8{1,2};inline for(a)|x|{std.debug.print("{} ",.{x});a[1]=9;}}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '1 2 ', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");const P=struct{x:u8};fn f()??P{var o:??P=P{.x=1};defer o.?.?.x=2;return o;}pub fn main()void{const r=f();std.debug.print("{}",.{r.?.?.x});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
});

test('preserves pointer identity through array views and specializes inline switch ranges', () => {
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var a=[_]u8{1,2,3};const p=&a[1];const q=&a[0..2][1];std.debug.print("{} {} {}",.{p==q,p.*,q.*});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: 'true 2 2', uncaughtException: undefined });
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var n:u8=2;_= &n;switch(n){inline 1...3=>|x|std.debug.print("{}",.{x}),else=>{}}}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '2', uncaughtException: undefined });
});

test('rejects invalid error propagation, duplicate result fields, and incompatible memory copies', () => {
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");const E=error{A};fn fail()E{return E.A;}pub fn main()E!void{try fail();}`
    ).kind
  ).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");const P=struct{x:u8};pub fn main()void{var p=P{.x=0};p=.{.x=1,.x=2};std.debug.print("{}",.{p.x});}`
    ).kind
  ).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");fn small()error{A}!u8{return 3;}fn wide()!f128{return small();}pub fn main()!void{const x=try wide();std.debug.print("{d}",.{x+0.5});}`
    ).kind
  ).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var a=[_]u8{0};const b=[_]u16{300};@memcpy(&a,&b);std.debug.print("{}",.{a[0]});}`
    ).kind
  ).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std");pub fn main()void{var a=[_]u16{0};const b=[_]u8{1};@memcpy(&a,&b);std.debug.print("{}",.{a[0]});}`
    ).kind
  ).toBe('compileError');
});

test('bare error-set catch executes effects while its constant result remains available', () => {
  const program = `const std = @import("std");
var n: u8 = 0;
fn fail() error{A} { n += 1; return error.A; }
pub fn main() void {
    const r = fail() catch 5;
    const x: u8 = r;
    var a: [r]u8 = undefined;
    _ = &a;
    const y: u8 = fail() catch 7;
    std.debug.print("{} {} {} {}", .{x, a.len, y, n});
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: '5 5 7 2',
    uncaughtException: undefined,
  });
});

test('retains earlier for operands while later operands call user code', () => {
  const program = `const std = @import("std");
fn other() [1]u8 {
    const t = Turtle.init(0, 0);
    std.debug.print("{}", .{t.canMoveForward()});
    return .{0};
}
pub fn main() void {
    for ([_]Turtle{Turtle.init(0, 1)}, other()) |t, x| { _ = t; _ = x; }
}`;
  expect(executeProgram('zig', program)).toMatchObject({
    kind: 'executed',
    stderr: 'false',
    uncaughtException: undefined,
  });
});

test('large string literals respect storage limits without overflowing the host call stack', () => {
  expect(executeProgram('zig', `pub fn main() void { const s = "${'a'.repeat(900_000)}"; _ = s; }`)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
  expect(executeProgram('zig', `pub fn main() void { const s = "${'a'.repeat(1_000_001)}"; _ = s; }`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('hashes union tags and payloads with Zig hash-map iteration order', () => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");
const K=union(enum){a:u8,b:u8,c:void};
pub fn main(init:std.process.Init)!void{
 var map:std.AutoHashMap(K,u8)=.init(init.gpa);defer map.deinit();
 try map.put(.{.a=1},1);try map.put(.{.b=1},2);try map.put(.{.a=2},3);try map.put(.{.c={}},4);
 var i=map.iterator();while(i.next())|e|std.debug.print("{} ",.{e.value_ptr.*});
}
`
    )
  ).toMatchObject({ kind: 'executed', stderr: '4 1 3 2 ', uncaughtException: undefined });
});

test('hexadecimal zero precision is bounded before allocating padding', () => {
  for (const value of ['0.0', '-0.0']) {
    const source = `const std = @import("std"); pub fn main() void { std.debug.print("{x:.999999999999}", .{@as(f128, ${value})}); }`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
  }
});

test('repeated prints into a large fixed writer stay within the execution budget', () => {
  const source = `const std = @import("std"); pub fn main() !void {
    var buffer: [50000]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    for (0..50000) |_| try writer.print("x", .{});
    std.debug.print("{}", .{writer.buffered().len});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '50000',
    uncaughtException: undefined,
  });
});

test('rejects known out-of-bounds arrays and slices before execution', () => {
  for (const body of [
    'var a = [_]u8{1, 2, 3}; _ = &a; _ = a[4..];',
    'const s: []const u8 = "abc"; _ = s[4];',
    'const s: []const u8 = "abc"; _ = s[0..4];',
    'const s = "abc"; _ = s[4..];',
  ])
    expect(executeProgram('zig', `pub fn main() void { ${body} }`).kind).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std"); pub fn main() void {
    const s: []const u8 = "abc"; std.debug.print("{s}", .{s[1..]});
  }`
    )
  ).toMatchObject({ kind: 'executed', stderr: 'bc', uncaughtException: undefined });
});

test('rejects statically unequal copy lengths before executing earlier output', () => {
  for (const builtin of ['@memcpy', '@memmove']) {
    const source = `const std = @import("std"); pub fn main() void {
      var destination: [2]u8 = undefined;
      const source = [_]u8{1};
      std.debug.print("before", .{});
      ${builtin}(&destination, &source);
    }`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test('multiline literals preserve empty lines, UTF-8, and literal backslashes', () => {
  const source = String.raw`const std = @import("std");
const banner =
    \\first
    \\
    \\日本語\n
;
pub fn main() void { std.debug.print("{s}", .{banner}); }`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'first\n\n日本語\\n',
    uncaughtException: undefined,
  });
});

test('whole aggregate stores snapshot nested overlapping array views', () => {
  const source = `const std = @import("std"); const P = struct { x: u8 };
pub fn main() void {
    var a = [_]P{.{.x=1}, .{.x=2}, .{.x=3}};
    const retained = &a[2].x;
    a[1..3].* = a[0..2].*;
    std.debug.print("{} {} {} {}", .{a[0].x, a[1].x, a[2].x, retained.*});
    a[0..2].* = a[1..3].*;
    std.debug.print("|{} {} {}", .{a[0].x, a[1].x, a[2].x});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 1 2 2|1 2 2',
    uncaughtException: undefined,
  });
});

test('pointer keys and pointer fields hash by location without collision chains', () => {
  const source = `const std = @import("std"); const Key = struct { pointer: *u8 };
pub fn main(init: std.process.Init) !void {
    var storage: [2000]u8 = undefined;
    var pointers = std.AutoHashMap(*u8, u8).init(init.gpa);
    defer pointers.deinit();
    var records = std.AutoHashMap(Key, u8).init(init.gpa);
    defer records.deinit();
    for (0..2000) |i| {
        try pointers.put(&storage[i], 1);
        try records.put(.{.pointer = &storage[i]}, 2);
    }
    try pointers.put(&storage[0..2][1], 3);
    std.debug.print("{} {} {} {}", .{pointers.count(), records.count(), pointers.get(&storage[1]).?, records.get(.{.pointer = &storage[1]}).?});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2000 2000 3 2',
    uncaughtException: undefined,
  });
});

test('known slice bounds survive pointer coercions and const aliases', () => {
  for (const tail of [
    'const s: []const i32 = &a; _ = s[3];',
    'const s: []const i32 = &a; _ = s[1..4];',
    'const s: []const i32 = &a; _ = s[4..];',
    'const s = @as([]const i32, &a); _ = s[3];',
    'const s: []const i32 = a[0..2]; const alias = s; _ = alias[2];',
  ])
    expect(executeProgram('zig', `pub fn main() void { const a = [_]i32{1,2,3}; ${tail} }`).kind).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std = @import("std"); pub fn main() void {
    const a = [_]u8{1,2,3}; const s: []const u8 = &a; var b: [s.len]u8 = undefined; _ = &b;
    var dynamic: []const u8 = s; dynamic.len = 1; var index: usize = 2; _ = &index; _ = dynamic[index];
  }`
    )
  ).toMatchObject({ kind: 'executed', uncaughtException: 'panic: index out of bounds: index 2, len 1' });
});

test('literal decoding rejects raw control bytes while accepting escaped controls', () => {
  for (const control of ['\t', '\u0007', '\u007F', '\r']) {
    for (const literal of [`"a${control}b"`, `'${control}'`, `\n    \\\\a${control}b\n`]) {
      expect(executeProgram('zig', `pub fn main() void { const value = ${literal}; _ = value; }`).kind).toBe(
        'compileError'
      );
    }
  }
  expect(
    executeProgram(
      'zig',
      String.raw`const std = @import("std"); pub fn main() void { std.debug.print("{s}", .{"a\tb\x7f"}); }`
    )
  ).toMatchObject({ kind: 'executed', stderr: 'a\tb\u007F', uncaughtException: undefined });
});

test('literal storage is bounded cumulatively and resets for each compilation', () => {
  const text = 'x'.repeat(600_000);
  for (const source of [
    `const a = "${text}"; const b = "${text}"; pub fn main() void {}`,
    `const @"${text}" = 1; const @"${text}y" = 2; pub fn main() void {}`,
  ]) {
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
  }
  expect(executeProgram('zig', `pub fn main() void { const text = "${text}"; _ = text; }`)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test('wide integer arrays and hash serialization respect native resource budgets', () => {
  expect(executeProgram('zig', wideIntegerMapProgram(90))).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
  expect(executeProgram('zig', wideIntegerMapProgram(1000))).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test('native lookups compare function pointer keys by the referenced function', () => {
  const source = `const std = @import("std"); fn f() void {}
pub fn main(init: std.process.Init) !void {
    var map = std.AutoHashMap(*const fn() void, u8).init(init.gpa);
    defer map.deinit();
    try map.put(&f, 3);
    std.debug.print("{} {}", .{map.count(), map.get(&f).?});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 3',
    uncaughtException: undefined,
  });
});

function wideIntegerMapProgram(count: number): string {
  return `const std = @import("std");
pub fn main(init: std.process.Init) !void {
    const key: [${count}]u65535 = @splat(0);
    var map = std.AutoHashMap(@TypeOf(key), u8).init(init.gpa);
    defer map.deinit();
    try map.put(key, 1);
}`;
}

test('approximate equality preserves extended precision and equal infinities', () => {
  const source = `const std = @import("std"); pub fn main() void {
    const x: f128 = 9007199254740992; const y: f128 = 9007199254740993;
    const inf = std.math.inf(f128);
    std.debug.print("{} {} {} {} {}", .{std.math.approxEqAbs(f128,x,y,0.5), std.math.approxEqRel(f128,x,y,0.00000000000000001), std.math.approxEqAbs(f128,inf,inf,0), std.math.approxEqAbs(f128,-inf,-inf,1), std.math.approxEqAbs(f128,std.math.nan(f128),std.math.nan(f128),1)});
  }`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false false true true false',
    uncaughtException: undefined,
  });
});

test('integer logarithms and empty-needle searches fail their Debug assertions promptly', () => {
  for (const expression of [
    'std.math.log(u8,1,2)',
    'std.math.log(u8,0,2)',
    'std.math.log(u8,2,0)',
    'std.mem.containsAtLeast(u8,"abc",18446744073709551615,"")',
  ]) {
    expect(
      executeProgram('zig', `const std=@import("std");pub fn main()void{const value=${expression};_=value;}`)
    ).toMatchObject({ kind: 'executed', uncaughtException: 'panic: reached unreachable code' });
  }
});

test('large ldexp exponents overflow or underflow without huge integer shifts', () => {
  const source = `const std=@import("std");pub fn main()void{
    std.debug.print("{} {} {}", .{std.math.ldexp(@as(f128,1),2147483647)==std.math.inf(f128),std.math.ldexp(@as(f80,1),-2147483648)==0,std.math.ldexp(@as(f64,-1),2147483647)==-std.math.inf(f64)});
  }`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true true true',
    uncaughtException: undefined,
  });
});

test('source-sized plain, quoted, and base64 output follows the output limit', () => {
  const text = 'a'.repeat(900_000);
  for (const source of [
    `const std=@import("std");pub fn main()void{std.debug.print("${text}",.{});}`,
    `const std=@import("std");pub fn main()void{std.debug.print("{q}",.{"${text}"});}`,
    `const std=@import("std");pub fn main()void{std.debug.print("{b64}",.{"${text}"});}`,
  ])
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
});

test('writer result types use the canonical usize and mutable byte slice', () => {
  const source = `const std=@import("std");fn less(n:usize,a:u8,b:u8)bool{return n>0 and a<b;}
pub fn main()!void{var b:[2]u8=undefined;var w=std.Io.Writer.fixed(&b);const n=try w.write("x");var a=[_]u8{2,1};std.sort.heap(u8,&a,n,less);std.debug.print("{} {} {}",.{a[0],a[1],@TypeOf(w.buffered())==[]u8});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 true',
    uncaughtException: undefined,
  });
});

test('array view pointers compare by region storage and offset', () => {
  const source = `const std=@import("std");pub fn main()void{var a=[_]u8{1,2,3,4};_= &a;const region=a[1..3];std.debug.print("{} {} {} {}",.{region==a[1..3],region!=a[1..3],region==a[2..4],&a==a[0..4]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false false true',
    uncaughtException: undefined,
  });
});

test('ArrayList append and insertion retain pointers into initBuffer storage', () => {
  const source = `const std=@import("std");const P=struct{x:u8};pub fn main(init:std.process.Init)!void{var buffer=[_]P{.{.x=1},.{.x=2},.{.x=3}};const p=&buffer[0].x;var list=std.ArrayList(P).initBuffer(&buffer);list.appendAssumeCapacity(.{.x=7});std.debug.print("{} {}|",.{p.*,buffer[0].x});try list.insert(init.gpa,0,.{.x=8});std.debug.print("{} {} {}",.{p.*,buffer[0].x,buffer[1].x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '7 7|8 8 7',
    uncaughtException: undefined,
  });
});

test('copied native headers are independent while backing storage remains shared', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{
    var a=std.AutoHashMap(u8,u8).init(init.gpa);defer a.deinit();try a.put(1,1);var b=a;try b.put(2,2);
    var u:std.AutoHashMapUnmanaged(u8,u8)=.empty;defer u.deinit(init.gpa);try u.put(init.gpa,1,1);var v=u;try v.put(init.gpa,2,2);
    var buffer:[8]u8=undefined;var first=std.Io.Writer.fixed(&buffer);try first.writeAll("a");var second=first;try second.writeAll("b");
    std.debug.print("{} {} {} {} {s}|{s}",.{a.count(),b.count(),u.count(),v.count(),first.buffered(),second.buffered()});
  }`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 1 2 a|ab',
    uncaughtException: undefined,
  });
});

test('runtime aggregate materializations share one storage budget across calls and frames', () => {
  const prefix = 'const std=@import("std");';
  const repeated =
    prefix +
    `fn make()[600000]u8{return @splat(1);}pub fn main()void{const a=make();const b=make();std.debug.print("{} {}",.{a.len,b.len});}`;
  const recursive =
    prefix +
    `fn retain(n:u8)u8{const a:[400000]u8=@splat(1);if(n==0)return a[0];return a[0]+retain(n-1);}pub fn main()void{std.debug.print("{}",.{retain(3)});}`;
  for (const source of [repeated, recursive])
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
  const reuse =
    prefix + `pub fn main()void{var a:[400000]u8=@splat(0);for(0..5)|_|{a=@splat(1);}std.debug.print("{}",.{a[0]});}`;
  expect(executeProgram('zig', reuse)).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
});

test('arguments snapshot aggregate values before later argument effects', () => {
  const source = `const std=@import("std");const P=struct{x:u8};var state=P{.x=1};fn mutate()u8{state.x=9;return 0;}fn observe(p:P,unused:u8)void{_=unused;std.debug.print("{}",.{p.x});}pub fn main()void{observe(state,mutate());}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
});

test('native receivers run before allocator and writer argument effects', () => {
  const programs = [
    `const std=@import("std");var n:u8=0;fn allocator()std.mem.Allocator{n=n*10+1;return std.heap.page_allocator;}fn size()usize{n=n*10+2;return 1;}pub fn main()!void{const b=try allocator().alloc(u8,size());std.heap.page_allocator.free(b);std.debug.print("{}",.{n});}`,
    `const std=@import("std");var n:u8=0;fn out(w:*std.Io.Writer)*std.Io.Writer{n=n*10+1;return w;}fn bytes()[]const u8{n=n*10+2;return "x";}pub fn main()!void{var b:[1]u8=undefined;var w=std.Io.Writer.fixed(&b);_=try out(&w).write(bytes());std.debug.print("{}",.{n});}`,
  ];
  for (const source of programs)
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '12',
      uncaughtException: undefined,
    });
});

test('replacement size queries and allocating transforms check expansion before building output', () => {
  const prefix = `const std=@import("std");pub fn main(init:std.process.Init)void{const input:[1000]u8=@splat(97);const replacement:[10000]u8=@splat(98);`;
  expect(
    executeProgram(
      'zig',
      prefix + `_=init;std.debug.print("{}",.{std.mem.replacementSize(u8,&input,"a",&replacement)});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '10000000', uncaughtException: undefined });
  for (const expression of [
    'std.mem.replaceOwned(u8,init.gpa,&input,"a",&replacement)',
    'std.mem.concat(init.gpa,u8,&parts)',
    'std.mem.join(init.gpa,",",&parts)',
  ]) {
    const source =
      prefix +
      `const parts:[1000][]const u8=@splat(&replacement);_= &parts;_= &input;const value=${expression} catch |err|{std.debug.print("{s}",.{@errorName(err)});return;};std.debug.print("{}",.{value.len});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'OutOfMemory',
      uncaughtException: undefined,
    });
  }
});

test('slices and concatenation retain temporary turtle operands through later calls', () => {
  for (const body of [
    `fn index()usize{const t=Turtle.init(0,0);std.debug.print("{}",.{t.canMoveForward()});return 0;}pub fn main()void{const a=(&[_]Turtle{Turtle.init(0,1)})[index()..];_=a;}`,
    `fn index()usize{const t=Turtle.init(0,0);std.debug.print("{}",.{t.canMoveForward()});return 1;}pub fn main()void{const a=(&[_]Turtle{Turtle.init(0,1)})[0..index()];_=a;}`,
    `fn later()[1]Turtle{const t=Turtle.init(0,0);std.debug.print("{}",.{t.canMoveForward()});return .{t};}pub fn main()void{const a=[_]Turtle{Turtle.init(0,1)} ++ later();_=a;}`,
  ])
    expect(executeProgram('zig', `const std=@import("std");${body}`)).toMatchObject({
      kind: 'executed',
      stderr: 'false',
      uncaughtException: undefined,
    });
});

test('tuple and named aggregate caches preserve distinct comparator specializations', () => {
  const prefix = `const std=@import("std");fn asc(_:void,a:u8,b:u8)std.math.Order{return std.math.order(a,b);}fn desc(_:void,a:u8,b:u8)std.math.Order{return std.math.order(b,a);}pub fn main(init:std.process.Init)!void{var a:std.PriorityQueue(u8,void,asc)=.empty;_= &a;var b:std.PriorityQueue(u8,void,desc)=.empty;_= &b;`;
  for (const body of [
    `const first=.{a};_=first;var second=.{b};try second[0].push(init.gpa,1);try second[0].push(init.gpa,3);std.debug.print("{}",.{second[0].pop().?});}`,
    `const first=.{.queue=a};_=first;var second=.{.queue=b};try second.queue.push(init.gpa,1);try second.queue.push(init.gpa,3);std.debug.print("{}",.{second.queue.pop().?});}`,
  ])
    expect(executeProgram('zig', prefix + body)).toMatchObject({
      kind: 'executed',
      stderr: '3',
      uncaughtException: undefined,
    });
});

test('insertion sort exposes Zig comparator order and live destination contents', () => {
  const source = `const std=@import("std");var data=[_]u8{3,2,1};fn less(_:void,a:u8,b:u8)bool{std.debug.print("{}<{}@{} ",.{a,b,data[0]});return a<b;}pub fn main()void{std.sort.insertion(u8,&data,{},less);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2<3@3 1<3@2 1<2@2 ',
    uncaughtException: undefined,
  });
});

test('block sort matches reference callback and array hashes across cache boundaries', () => {
  const fixtures = [
    [9, '48 18022381761986048048 4122571923138513413'],
    [513, '8488 13682772094992509688 9485111683807006533'],
  ] as const;
  for (const [length, expected] of fixtures) {
    const source = `const std=@import("std");var data:[${length}]u16=undefined;var h:u64=0;var count:u64=0;fn less(_:void,a:u16,b:u16)bool{h=h*%1000003+%@as(u64,a)*%997+%@as(u64,b);h=h+%@as(u64,data[0]);count+=1;return a<b;}pub fn main()void{for(&data,0..)|*v,i|{v.*=@intCast((i*73+17)%97);}std.sort.block(u16,&data,{},less);var result:u64=0;for(data)|v|{result=result*%1009+%@as(u64,v);}std.debug.print("{} {} {}",.{count,h,result});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: expected,
      uncaughtException: undefined,
    });
  }
});

test('mutable-backed slices retain runtime bounds while arrays retain type bounds', () => {
  for (const tail of [
    'const s: []i32 = &a; _ = s[3];',
    'const s: []i32 = &a; _ = s[1..4];',
    'const s: []i32 = &a; _ = s[4..];',
    'const s: []i32 = a[1..]; _ = s[2];',
    'const s = @as([]i32, &a); _ = s[3];',
    'const p = &a; const s: []const i32 = p; _ = s[3];',
    'const s: []i32 = &a; var b: [4]i32 = undefined; @memcpy(&b, s);',
    'const s: []i32 = &a; for (s, 0..4) |x, i| { _ = x; _ = i; }',
  ]) {
    const result = executeProgram('zig', `pub fn main() void { var a = [_]i32{1,2,3}; ${tail} }`);
    expect(result).toMatchObject({ kind: 'executed', uncaughtException: expect.stringContaining('panic:') });
  }
  expect(executeProgram('zig', 'pub fn main() void { var a = [_]i32{1,2,3}; _ = &a; _ = a[3]; }').kind).toBe(
    'compileError'
  );
});

test('all comment kinds reject raw controls while ordinary whitespace and CRLF remain valid', () => {
  for (const prefix of ['//', '///', '//!']) {
    for (const control of ['\t', '\u0000', '\u0007', '\u007F', '\r']) {
      const source = `${prefix} a${control}b\npub fn main() void {}`;
      expect(executeProgram('zig', source).kind).toBe('compileError');
    }
    expect(executeProgram('zig', `${prefix} valid\r\npub fn main() void {}`).kind).toBe('executed');
  }
  expect(executeProgram('zig', 'pub fn main() void {\n\tconst\tx: u8 = 1; // valid\n\t_ = x;\n}').kind).toBe(
    'executed'
  );
});

test('UTF-8 counting preserves decoding errors and validation reports failure', () => {
  const source = String.raw`const std=@import("std");
fn report(s: []const u8) void {
    const count=std.unicode.utf8CountCodepoints(s) catch |e| {
        std.debug.print("{s} {}|", .{@errorName(e),std.unicode.utf8ValidateSlice(s)});
        return;
    };
    std.debug.print("{d} {}|", .{count,std.unicode.utf8ValidateSlice(s)});
}
pub fn main() void {
    report("\xC3"); report("\xE2\x82"); report("\xF0\x90\x80");
    report("\x80"); report("\xC3x"); report("\xC0\x80");
    report("\xED\xA0\x80"); report("\xF4\x90\x80\x80");
    report(""); report("aé日");
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr:
      'TruncatedInput false|TruncatedInput false|TruncatedInput false|Utf8InvalidStartByte false|Utf8ExpectedContinuation false|Utf8OverlongEncoding false|Utf8EncodesSurrogateHalf false|Utf8CodepointTooLarge false|0 true|3 true|',
    uncaughtException: undefined,
  });
});

test('native formatting evaluates receivers, allocator prefixes and value arguments once in order', () => {
  const source = `const std=@import("std");
var n:u32=0;
fn listOf(p:*std.ArrayList(u8)) *std.ArrayList(u8) { n=n*10+1; return p; }
fn allocator() std.mem.Allocator { n=n*10+2; return std.heap.page_allocator; }
fn buffer(p:[]u8) []u8 { n=n*10+2; return p; }
fn writerOf(p:*std.Io.Writer) *std.Io.Writer { n=n*10+2; return p; }
fn arg() u8 { n=n*10+3; return 7; }
pub fn main() !void {
    var list:std.ArrayList(u8)=.empty;
    defer list.deinit(std.heap.page_allocator);
    try listOf(&list).print(allocator(),"{}",.{arg()});
    std.debug.print("{} {s}|",.{n,list.items});
    n=0; try list.print(allocator(),"{}",.{arg()});
    std.debug.print("{} {s}|",.{n,list.items});
    n=0; const allocated=try std.fmt.allocPrint(allocator(),"{}",.{arg()});
    defer std.heap.page_allocator.free(allocated);
    std.debug.print("{} {s}|",.{n,allocated});
    var bytes:[8]u8=undefined;
    n=0; const text=try std.fmt.bufPrint(buffer(&bytes),"{}",.{arg()});
    std.debug.print("{} {s}|",.{n,text});
    var writer=std.Io.Writer.fixed(&bytes);
    n=0; try writerOf(&writer).print("{}",.{arg()});
    std.debug.print("{} {s}|",.{n,writer.buffered()});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '123 7|23 77|23 7|23 7|23 7|',
    uncaughtException: undefined,
  });
});

test('constant addresses preserve typed parent storage, offsets and hash identity', () => {
  const source = `const std=@import("std");
pub fn main(init:std.process.Init) !void {
    const a=[_]i32{1,1}; const b=[_]i32{1,1};
    const P=struct{x:u8,y:u8}; const p=P{.x=1,.y=1};
    const x:i32=7; const y:i32=7;
    const q=&a[1];
    std.debug.print("{} {} {} {} {} {} {} {}|", .{&a[0]==&a[1],&a[0]==&b[0],&p.x==&p.y,&x==&y,&@as(i32,5)==&@as(i32,5),&a==&b,q==&a[1],&p.x==&p.x});
    var map=std.AutoHashMap(*const i32,u8).init(init.gpa);
    defer map.deinit();
    try map.put(&a[1],1); try map.put(q,2); try map.put(&b[1],3);
    std.debug.print("{} {}", .{map.count(),map.get(q).?});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false true false true true true true true|1 3',
    uncaughtException: undefined,
  });
});

test('global variable addresses retain known slice bounds without folding mutable contents', () => {
  const header = 'const std=@import("std"); var g=[_]i32{1,2,3};';
  for (const tail of [
    'const s:[]i32=&g; _=s[3];',
    'const s:[]i32=&g; _=s[1..4];',
    'const s=@as([]i32,&g); _=s[3];',
    'const s:[]i32=&g; var b:[4]i32=undefined; @memcpy(&b,s);',
    'const s:[]i32=&g; for(s,0..4) |x,i| {_=x;_=i;}',
    'const s:[]i32=g[1..]; const alias=s; _=alias[2];',
  ])
    expect(executeProgram('zig', `${header} pub fn main() void {${tail}}`).kind).toBe('compileError');
  expect(
    executeProgram('zig', `${header} pub fn main() void { const s:[]i32=&g; g[0]=9; std.debug.print("{}",.{s[0]}); }`)
  ).toMatchObject({ kind: 'executed', stderr: '9', uncaughtException: undefined });
});

test('case-insensitive search scans repetitive compile-time and runtime data within the shared budget', () => {
  const text = 'a'.repeat(100_000);
  const pattern = 'a'.repeat(49_999) + 'b';
  for (const value of [`"${text}"`, 'input()']) {
    const source = `const std=@import("std"); fn input() []const u8 {return "${text}";} pub fn main() void {std.debug.print("{any}",.{std.ascii.findIgnoreCase(${value},"${pattern}")});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'null',
      uncaughtException: undefined,
    });
  }
  expect(
    executeProgram(
      'zig',
      `const std=@import("std"); pub fn main() void {std.debug.print("{any} {any} {any}", .{std.ascii.findIgnoreCase("aAaAB","aaab"),std.ascii.findIgnoreCase("x", ""),std.ascii.findIgnoreCase("a","longer")});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '1 0 null', uncaughtException: undefined });
});

test('non-power-of-two shift widths reject known invalid amounts and panic for runtime amounts', () => {
  for (const operator of ['<<', '>>']) {
    for (const width of [3, 5, 9]) {
      for (const declaration of [`const a: u${width} = 1;`, `var a: u${width} = 1; _ = &a;`]) {
        expect(executeProgram('zig', `pub fn main() void {${declaration} _=a ${operator} ${width};}`).kind).toBe(
          'compileError'
        );
      }
      expect(
        executeProgram(
          'zig',
          `pub fn main() void {const a: u${width}=1;var amount:u${Math.ceil(Math.log2(width))}=${width};_= &amount;_=a ${operator} amount;}`
        )
      ).toMatchObject({ kind: 'executed', uncaughtException: 'panic: shift amount is greater than the type size' });
    }
  }
});

test('optional slices use their pointer niche for list growth and fixed-buffer allocations', () => {
  const source = `const std=@import("std"); const P=struct{s:?[]const u8};
pub fn main(init:std.process.Init) !void {
    var list:std.ArrayList(?[]const u8)=.empty; defer list.deinit(init.gpa);
    try list.append(init.gpa,null);
    var records:std.ArrayList(P)=.empty; defer records.deinit(init.gpa);
    try records.append(init.gpa,.{.s=null});
    var bytes:[32]u8=undefined; var fba=std.heap.FixedBufferAllocator.init(&bytes);
    const slots=try fba.allocator().alloc(?[]const u8,2);
    std.debug.print("{} {} {}", .{list.capacity,records.capacity,slots.len});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '9 9 2',
    uncaughtException: undefined,
  });
});

test('sort queries read live storage while retaining the reference saved extrema', () => {
  const source = `const std=@import("std");
fn less(p:*[3]u8,a:u8,b:u8) bool {p[2]=0;return a<b;}
fn order(p:*[3]u8,a:u8) std.math.Order {p[0]=9;p[2]=0;return std.math.order(@as(u8,2),a);}
fn predicate(p:*[3]u8,a:u8) bool {p[0]=9;p[2]=0;return a<2;}
pub fn main() void {
 var a=[_]u8{1,2,3};
 std.debug.print("{}|", .{std.sort.isSorted(u8,&a,&a,less)});
 a=.{1,2,3};std.debug.print("{any}|", .{std.sort.argMin(u8,&a,&a,less)});
 a=.{1,2,3};std.debug.print("{any}|", .{std.sort.argMax(u8,&a,&a,less)});
 a=.{1,2,3};std.debug.print("{any}|", .{std.sort.min(u8,&a,&a,less)});
 a=.{1,2,3};std.debug.print("{any}|", .{std.sort.max(u8,&a,&a,less)});
 a=.{1,2,3};std.debug.print("{any}|", .{std.sort.binarySearch(u8,&a,&a,order)});
 a=.{1,2,3};std.debug.print("{}|", .{std.sort.lowerBound(u8,&a,&a,order)});
 a=.{1,2,3};std.debug.print("{}|", .{std.sort.upperBound(u8,&a,&a,order)});
 a=.{1,2,3};const range=std.sort.equalRange(u8,&a,&a,order);std.debug.print("{} {}|", .{range[0],range[1]});
 a=.{1,2,3};std.debug.print("{}|", .{std.sort.partitionPoint(u8,&a,&a,predicate)});
}
`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false|2|1|0|2|1|1|3|0 3|1|',
    uncaughtException: undefined,
  });
});

test('constant union and optional projections keep their parent addresses', () => {
  const source = `const std=@import("std");pub fn main() void {
    const U=union(enum){a:u8,b:u8}; const u:U=.{.a=5}; const o:?u8=5; const p:?u8=6;
    std.debug.print("{} {} {}", .{&u.a==&u.a,&o.?==&o.?,&o.?==&p.?});
}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true true false',
    uncaughtException: undefined,
  });
});

test('integer square roots retain integer types and reject invalid integer domains', () => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{const n=std.math.sqrt(9);std.debug.print("{} {}",.{n << 1,std.math.sqrt(@as(u8,255))});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '6 15', uncaughtException: undefined });
  for (const input of ['@as(i32,9)', '-1', '340282366920938463463374607431768211456'])
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.math.sqrt(${input});}`).kind).toBe(
      'compileError'
    );
});

test.each(['allocLowerString', 'allocUpperString'])('ASCII %s uses the supplied allocator', (method) => {
  const source = `const std=@import("std");pub fn main()void{var bytes:[2]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const text=std.ascii.${method}(f.allocator(),"HELLO") catch |err| {std.debug.print("{s}",.{@errorName(err)});return;};std.debug.print("{s}",.{text});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory',
    uncaughtException: undefined,
  });
});

test('escaped names preserve lexical meaning for primitives, keywords and the discard name', () => {
  const source = `const std=@import("std");const @"bool"=42;
fn echo(@"i32":u8)u8{return @"i32";}
pub fn main()void{const @"i32"=7;const @"_"=8;const value:i32=-1;std.debug.print("{} {} {} {} {}",.{@"bool",@"i32",@"_",value,echo(9)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '42 7 8 -1 9',
    uncaughtException: undefined,
  });
  expect(executeProgram('zig', 'pub fn main()void{_=@"i32";}').kind).toBe('compileError');
  expect(executeProgram('zig', 'pub fn main()void{const i32=7;_=i32;}').kind).toBe('compileError');
});

test('memory operations retain temporary operands through later argument calls', () => {
  const source = `const std=@import("std");
fn first(a:std.mem.Allocator)!*Turtle{const p=try a.create(Turtle);p.*=Turtle.init(0,1);return p;}
fn second(a:std.mem.Allocator)!*Turtle{const p=try a.create(Turtle);p.*=Turtle.init(0,0);std.debug.print("{}",.{p.canMoveForward()});return p;}
pub fn main(init:std.process.Init)!void{std.mem.swap(Turtle,try first(init.gpa),try second(init.gpa));}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false',
    uncaughtException: undefined,
  });
});

test('prefix and suffix cuts return generic views into the original slice', () => {
  const source = `const std=@import("std");pub fn main()void{
var bytes=[_]u8{'a','b','c'};const p=std.mem.cutPrefix(u8,&bytes,"a").?;const s=std.mem.cutSuffix(u8,&bytes,"c").?;bytes[1]='z';
var words=[_]u16{1,2,3};const w:[]const u16=std.mem.cutPrefix(u16,&words,&.{1}).?;words[1]=9;
std.debug.print("{s} {s} {}",.{p,s,w[0]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'zc az 9',
    uncaughtException: undefined,
  });
});

test('map replacement preserves aggregate pointers and snapshots fetched previous values', () => {
  const source = `const std=@import("std");const P=struct{x:i32};pub fn main(init:std.process.Init)!void{
var map=std.AutoHashMap(u8,P).init(init.gpa);defer map.deinit();try map.put(1,.{.x=1});const p=&map.getPtr(1).?.x;
const before=(try map.fetchPut(1,.{.x=9})).?;std.debug.print("{} {} {}",.{p.*,map.get(1).?.x,before.value.x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '9 9 1',
    uncaughtException: undefined,
  });
});

test('native optional results distinguish stored null from absent values', () => {
  const source = `const std=@import("std");fn less(_:void,a:?u8,b:?u8)bool{return (a orelse 0)<(b orelse 0);}
pub fn main(init:std.process.Init)!void{
var list:std.ArrayList(?u8)=.empty;defer list.deinit(init.gpa);try list.append(init.gpa,null);
std.debug.print("{} {} {} {}|",.{list.getLastOrNull()==null,list.last()==null,list.pop()==null,list.pop()==null});
var map=std.AutoHashMap(u8,?u8).init(init.gpa);defer map.deinit();try map.put(1,null);
const values=[_]?u8{null};std.debug.print("{} {} {}",.{map.get(1)==null,map.get(2)==null,std.sort.min(?u8,&values,{},less)==null});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false false false true|false true false',
    uncaughtException: undefined,
  });
});

test('array and pointer lengths retain receiver calls through arithmetic', () => {
  const source = `const std=@import("std");var calls:u8=0;var data=[_]u8{1,2,3};
fn make()[3]u8{calls+=1;return data;}fn ptr()*[3]u8{calls+=1;return &data;}
pub fn main()void{const n=make().len+ptr().len;std.debug.print("{} {}",.{n,calls});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '6 2',
    uncaughtException: undefined,
  });
});

test('global pointer contents stay dynamic after retargeting and native memory reads', () => {
  const source = `const std=@import("std");var a=[_]i32{1,2,3};var b=[_]i32{7,8,9};var pointer:*[3]i32=&a;var slice:[]i32=a[0..1];var text=[_]u8{'A','B','C'};
pub fn main()void{pointer=&b;const p=&pointer[1];p.*=100;slice=&a;std.debug.print("{} {} {}|{s}|",.{a[1],b[1],slice[2],text});_=std.ascii.lowerString(&text,&text);a[0]=9;std.debug.print("{s}|{}",.{text,std.mem.eql(i32,&a,&.{9,2,3})});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2 100 3|ABC|abc|true',
    uncaughtException: undefined,
  });
});

test('while continuation completions leave their target loop or function', () => {
  const source = `const std=@import("std");fn run()u8{var i:u8=0;while(i<3):({i+=1;if(i==2)return 9;}){}return i;}
pub fn main()void{var n:u8=0;while(n<3):({n+=1;if(n==2)break;}){}std.debug.print("{} {}",.{run(),n});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '9 2',
    uncaughtException: undefined,
  });
});

test.each(['clearRetainingCapacity()', 'shrinkRetainingCapacity(0)', 'pop()'])(
  'vacated list slots release turtles after %s',
  (operation) => {
    const statement = operation === 'pop()' ? '_ = list.pop();' : `list.${operation};`;
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var list:std.ArrayList(Turtle)=.empty;defer list.deinit(init.gpa);try list.append(init.gpa,Turtle.init(0,1));${statement}const t=Turtle.init(0,0);std.debug.print("{}",.{t.canMoveForward()});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'true',
      uncaughtException: undefined,
    });
  }
);

test('cleared maps release turtles while independently held values remain alive', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var map=std.AutoHashMap(u8,Turtle).init(init.gpa);defer map.deinit();const held=Turtle.init(0,2);try map.put(1,Turtle.init(0,1));try map.put(2,held);map.clearRetainingCapacity();const t=Turtle.init(0,0);std.debug.print("{} {}",.{t.canMoveForward(),held.canMoveForward()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true true',
    uncaughtException: undefined,
  });
});

test('container constants keep declaration identity distinct from interned local values', () => {
  const source = `const std=@import("std");const A=[_]u8{1,2};const B=A;const E=[_]u8{1,2};const gx:i32=7;const gy:i32=7;
pub fn main()void{const local=A;const twin=[_]u8{1,2};std.debug.print("{} {} {} {} {} {}",.{&A[0]==&A[0],&A[0]==&B[0],&A[0]==&E[0],&gx==&gy,&A[0]==&local[0],&local[0]==&twin[0]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false false false false true',
    uncaughtException: undefined,
  });
});

test('fixed writer errors preserve the prefix that fits for writes, repetitions and formatting', () => {
  const source = `const std=@import("std");pub fn main()void{var a:[3]u8=@splat('-');var w=std.Io.Writer.fixed(&a);w.writeAll("hello") catch {};std.debug.print("{s}|{s}|",.{w.buffered(),a});var b:[3]u8=@splat('-');var x=std.Io.Writer.fixed(&b);x.splatByteAll('x',10000000) catch {};std.debug.print("{s}|",.{x.buffered()});var c:[3]u8=@splat('-');_=std.fmt.bufPrint(&c,"{s}",.{"hello"}) catch {};std.debug.print("{s}",.{c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'hel|hel|xxx|hel',
    uncaughtException: undefined,
  });
});

test('fixed-width LCM results panic on overflow', () => {
  for (const [type, a, b] of [
    ['u8', 16, 17],
    ['u16', 256, 257],
  ])
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{std.debug.print("{}",.{std.math.lcm(@as(${type},${a}),@as(${type},${b}))});}`
      )
    ).toMatchObject({ kind: 'executed', uncaughtException: 'panic: integer overflow' });
});

test('anonymous struct duplicate names fail before execution in every expression context', () => {
  for (const body of [
    'const a=.{.x=1,.x=2};_=a;',
    'const a=.{.nested=.{.x=1,.x=2}};_=a;',
    'std.debug.print("{any}",.{.{.x=1,.x=2}});',
  ])
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{${body}}`).kind).toBe('compileError');
});

test('long float input and import paths return controlled results', () => {
  const digits = '1'.repeat(900_000);
  expect(() =>
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{const x=std.fmt.parseFloat(f64,"${digits}") catch 0;_=x;}`
    )
  ).not.toThrow();
  expect(executeProgram('zig', `const value=@import("${'x'.repeat(900_000)}");pub fn main()void{_=value;}`).kind).toBe(
    'compileError'
  );
});

test('exact and overflow shift builtins validate spare shift-amount values', () => {
  for (const builtin of ['@shlExact', '@shrExact', '@shlWithOverflow']) {
    expect(executeProgram('zig', `pub fn main()void{_=${builtin}(@as(u3,0),3);}`).kind).toBe('compileError');
    expect(
      executeProgram('zig', `pub fn main()void{var x:u3=0;var amount:u2=3;_=&x;_=&amount;_=${builtin}(x,amount);}`)
    ).toMatchObject({ kind: 'executed', uncaughtException: 'panic: shift amount is greater than the type size' });
  }
});

test('memory searches, cuts and delimiter iterators meter unsuccessful comparisons', () => {
  const text = 'a'.repeat(100_000);
  const pattern = 'a'.repeat(49_999) + 'b';
  for (const operation of [
    'std.mem.indexOf(u8,input(),pattern)',
    'std.mem.findLast(u8,input(),pattern)',
    'std.mem.findPos(u8,input(),0,pattern)',
    'std.mem.cut(u8,input(),pattern)',
    'std.mem.cutLast(u8,input(),pattern)',
  ]) {
    const source = `const std=@import("std");const pattern="${pattern}";fn input()[]const u8{return "${text}";}pub fn main()void{_=${operation};}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
  for (const method of ['splitSequence', 'tokenizeSequence']) {
    const source = `const std=@import("std");pub fn main()void{var it=std.mem.${method}(u8,"${text}","${pattern}");_=it.next();}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
  expect(
    executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.mem.indexOf(u8,"${text}","${pattern}");}`)
  ).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('meta equality compares slice backing locations through aggregate views', () => {
  const source = `const std=@import("std");const P=struct{items:[]const u8};pub fn main()void{var a=[_]u8{1,2,3};const x:[]const u8=&a;const y:[]const u8=a[0..3];const other:[]const u8=a[1..3];const p=P{.items=x};const q=P{.items=y};std.debug.print("{} {} {}",.{std.meta.eql(x,y),std.meta.eql(p,q),std.meta.eql(x,other)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true true false',
    uncaughtException: undefined,
  });
});

test('undefined optional presence follows Debug poison tags through conditional initialization', () => {
  const source = `const std=@import("std");const S=struct{value:?i32,bytes:[2]u8};fn inspect(fill:bool)void{var s:S=undefined;if(fill)s.value=3;std.debug.print("{} {}|",.{s.value orelse 9,s.bytes[0]});}pub fn main()void{inspect(false);inspect(true);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '9 170|3 170|',
    uncaughtException: undefined,
  });
});

test.each(['false', '@as(u8,1)>2'])(
  'known false assertions retain earlier output before their runtime panic: %s',
  (condition) => {
    const source = `const std=@import("std");pub fn main()void{std.debug.print("checking",.{});std.debug.assert(${condition});std.debug.print("after",.{});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'checking',
      uncaughtException: 'panic: reached unreachable code',
    });
  }
);

test('narrow error casts report the rejected error name', () => {
  const source = `const std=@import("std");const A=error{One,Two};const B=error{One,Three};fn cast(value:A)B{return @errorCast(value);}pub fn main()void{std.debug.print("before|",.{});std.debug.print("{any}",.{cast(A.Two)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'before|',
    uncaughtException: 'panic: unexpected error code, found error.Two',
  });
});

test.each([
  {
    name: 'integers',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().alloc(u16,2);p[0]=0x1234;bytes[2]=0x78;bytes[3]=0x56;std.debug.print("{x} {x} {x} {x}",.{bytes[0],bytes[1],p[0],p[1]});`,
    output: '34 12 1234 5678',
  },
  {
    name: 'narrow',
    body: `var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().alloc(u3,2);p[0]=5;std.debug.print("{} {}",.{bytes[0],p[0]});`,
    output: '5 5',
  },
  {
    name: 'packed',
    body: `const P=packed struct{x:u3,y:u5};var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(P);p.*=.{.x=5,.y=17};std.debug.print("{x}|",.{bytes[0]});bytes[0]=0xe3;std.debug.print("{} {}",.{p.x,p.y});`,
    output: '8d|3 28',
  },
  {
    name: 'record',
    body: `const P=struct{a:u8,b:u32,c:u16};var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(P);p.*=.{.a=1,.b=0x12345678,.c=0x90ab};std.debug.print("{} {} {} {}",.{bytes[0],bytes[4],bytes[6],p.b});`,
    output: '120 171 1 305419896',
  },
  {
    name: 'f64',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(f64);p.*=1.5;std.debug.print("{} {}|",.{bytes[6],bytes[7]});bytes[7]=191;std.debug.print("{d}",.{p.*});`,
    output: '248 63|-1.5',
  },
  {
    name: 'f80',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(f80);p.*=1.5;std.debug.print("{} {}|{d}",.{bytes[8],bytes[9],p.*});`,
    output: '255 63|1.5',
  },
  {
    name: 'f128',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(f128);p.*=1.5;std.debug.print("{} {}|{d}",.{bytes[14],bytes[15],p.*});`,
    output: '255 63|1.5',
  },
  {
    name: 'optional',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(?u16);p.*=3;std.debug.print("{} {}|",.{p.*.?,bytes[2]});p.*=null;std.debug.print("{} {}",.{p.*==null,bytes[2]});`,
    output: '3 1|true 0',
  },
  {
    name: 'nested',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(??u16);p.*=@as(?u16,null);std.debug.print("{} {}|",.{p.*==null,p.*.?==null});p.*.?=3;std.debug.print("{}",.{p.*.?.?});`,
    output: 'false true|3',
  },
  {
    name: 'pointer',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(?*u8);var n:u8=7;p.*=&n;std.debug.print("{} ",.{p.*.?.*});n=8;std.debug.print("{} {} ",.{p.*.?.*,p.*.?==&n});p.*=null;std.debug.print("{}",.{p.*==null});`,
    output: '7 8 true true',
  },
  {
    name: 'enumeration',
    body: `const E=enum(u16){a=0x10,b=0x200};var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(E);p.*=.b;std.debug.print("{} {}",.{@intFromEnum(p.*),bytes[1]});`,
    output: '512 2',
  },
  {
    name: 'unionSmallTag',
    body: `const U=union(enum){a:u32,b:u8};var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(U);p.*=.{.a=7};std.debug.print("{} {} {}",.{bytes[0],bytes[4],p.a});`,
    output: '7 0 7',
  },
  {
    name: 'unionBigTag',
    body: `const U=union(enum(u32)){a:u8,b:u8};var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(U);p.*=.{.b=7};std.debug.print("{} {} {}",.{bytes[0],bytes[4],p.b});`,
    output: '1 7 7',
  },
])('fixed buffer typed storage aliases bytes: $name', ({ body, output }) => {
  const source = `const std=@import("std");pub fn main()!void{${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each([
  {
    name: 'arena',
    body: `var b:[512]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);var a=std.heap.ArenaAllocator.init(f.allocator());const g=a.allocator();const p=try g.alloc(u8,10);p[0]=9;std.debug.print("{} {} {}|",.{f.end_index,a.queryCapacity(),p[0]});_=try g.alloc(u64,8);std.debug.print("{} {}|",.{f.end_index,a.queryCapacity()});std.debug.print("{}|",.{a.reset(.retain_capacity)});std.debug.print("{} {}|",.{f.end_index,a.queryCapacity()});_=try g.alloc(u8,10);a.deinit();std.debug.print("{}",.{f.end_index});`,
    output: '76 52 9|168 144|true|168 144|0',
  },
  {
    name: 'arenaLimit',
    body: `var b:[512]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);var a=std.heap.ArenaAllocator.init(f.allocator());_=try a.allocator().alloc(u8,10);std.debug.print("{}|",.{a.reset(.{.retain_with_limit=10})});std.debug.print("{} {}|",.{f.end_index,a.queryCapacity()});_=a.reset(.free_all);std.debug.print("{} {}",.{f.end_index,a.queryCapacity()});`,
    output: 'true|34 10|0 0',
  },
  {
    name: 'arenaLeak',
    body: `var d=std.heap.DebugAllocator(.{}).init;var a=std.heap.ArenaAllocator.init(d.allocator());_=try a.allocator().alloc(u8,100);_=try a.allocator().alloc(u8,1000);a.deinit();std.debug.print("{}",.{d.deinit()});`,
    output: '.ok',
  },
  {
    name: 'collections',
    body: `var bytes:[4096]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);var m=std.AutoHashMap(u8,u16).init(f.allocator());try m.put(1,500);try m.put(2,900);std.debug.print("{} {} {}|",.{m.get(1).?,m.get(2).?,f.end_index});m.deinit();std.debug.print("{}|",.{f.end_index});var q:std.PriorityQueue(u8,void,order)=.empty;try q.push(f.allocator(),9);try q.push(f.allocator(),3);std.debug.print("{} {} {}|",.{q.pop().?,q.pop().?,f.end_index});q.deinit(f.allocator());std.debug.print("{}",.{f.end_index});`,
    output: '500 900 56|0|3 9 8|0',
  },
  {
    name: 'unmanaged',
    body: `var bytes:[4096]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);var m:std.AutoHashMapUnmanaged(u8,u8)=.empty;try m.put(f.allocator(),1,5);std.debug.print("{} {}|",.{m.get(1).?,f.end_index});m.deinit(f.allocator());std.debug.print("{}",.{f.end_index});`,
    output: '5 48|0',
  },
  {
    name: 'debugCollections',
    body: `var d=std.heap.DebugAllocator(.{}).init;const g=d.allocator();var m=std.AutoHashMap(u8,u8).init(g);for(0..100)|i|try m.put(@intCast(i),@intCast(i));var q:std.PriorityQueue(u8,void,order)=.empty;for(0..100)|i|try q.push(g,@intCast(i));std.debug.print("{} {}|",.{m.count(),q.count()});m.deinit();q.deinit(g);std.debug.print("{}",.{d.deinit()});`,
    output: '100 100|.ok',
  },
  {
    name: 'realloc',
    body: `var bytes:[64]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const g=f.allocator();var p=try g.alloc(u16,2);p[0]=12;p[1]=34;p=try g.realloc(p,4);std.debug.print("{} {} {}|",.{p[0],p[1],f.end_index});g.free(p);std.debug.print("{}",.{f.end_index});`,
    output: '12 34 8|0',
  },
])('allocator lifecycle follows its supplied backing: $name', ({ body, output }) => {
  const source = `const std=@import("std");fn order(_:void,a:u8,b:u8)std.math.Order{return std.math.order(a,b);}pub fn main()!void{${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test('collections propagate exhaustion from managed and unmanaged supplied allocators', () => {
  const source = `const std=@import("std");fn order(_:void,a:u8,b:u8)std.math.Order{return std.math.order(a,b);}pub fn main()void{var bytes:[1]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const g=f.allocator();var m=std.AutoHashMap(u8,u8).init(g);m.put(1,2) catch |e| std.debug.print("{s}|",.{@errorName(e)});var u:std.AutoHashMapUnmanaged(u8,u8)=.empty;u.put(g,1,2) catch |e| std.debug.print("{s}|",.{@errorName(e)});var q:std.PriorityQueue(u8,void,order)=.empty;q.push(g,1) catch |e| std.debug.print("{s}|",.{@errorName(e)});std.debug.print("{} {} {}",.{m.count(),u.count(),q.count()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory|OutOfMemory|OutOfMemory|0 0 0',
    uncaughtException: undefined,
  });
});

test('arena exhaustion comes from its child allocator', () => {
  const source = `const std=@import("std");pub fn main()void{var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);var a=std.heap.ArenaAllocator.init(f.allocator());defer a.deinit();_=a.allocator().alloc(u8,100) catch |e|{std.debug.print("{s} {}",.{@errorName(e),f.end_index});return;};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory 0',
    uncaughtException: undefined,
  });
});

test('tuple element types resolve identifiers and repeated aliases', () => {
  const source = `const std=@import("std");const Q=struct{x:u8};const T=struct{f64,Q,Q};pub fn main()void{var t:T=.{1.5,.{.x=2},.{.x=3}};t[1].x+=4;std.debug.print("{d} {} {}",.{t[0],t[1].x,t[2].x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1.5 6 3',
    uncaughtException: undefined,
  });
});

test('temporary numeric addresses receive their result pointer type', () => {
  const source = `const std=@import("std");fn make()*const i32{return &5;}pub fn main()void{const a:*const i32=&-5;const b:?*const i32=&(1+2);const c:*const f64=&1.5;std.debug.print("{} {} {} {d}",.{make().*,a.*,b.?.*,c.*});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '5 -5 3 1.5',
    uncaughtException: undefined,
  });
});

test('parenthesized zero and floating negative zero remain distinct', () => {
  const source = `const std=@import("std");pub fn main()void{const x=-(0);const y=-0.0;const z=-%0;std.debug.print("{} {d} {}",.{x,y,z});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0 -0 0',
    uncaughtException: undefined,
  });
});

test.each(['-0', '- 0x0'])('direct negative integer zero is ambiguous: %s', (literal) => {
  expect(executeProgram('zig', `pub fn main()void{const x=${literal};_=x;}`).kind).toBe('compileError');
});

test('typed temporary addresses keep named comptime constants distinct', () => {
  expect(executeProgram('zig', `pub fn main()void{const n=5;const p:*const i32=&n;_=p;}`).kind).toBe('compileError');
});

test('fetchRemove snapshots aggregate keys and values before clearing map storage', () => {
  const source = `const std=@import("std");const Key=struct{x:u8};const Value=struct{a:[2]u8,p:*u8};pub fn main(init:std.process.Init)!void{var m=std.AutoHashMap(Key,Value).init(init.gpa);defer m.deinit();var n:u8=7;try m.put(.{.x=3},.{.a=.{9,8},.p=&n});const removed=m.fetchRemove(.{.x=3}).?;n=6;std.debug.print("{} {} {} {} {}",.{removed.key.x,removed.value.a[0],removed.value.a[1],removed.value.p.*,m.count()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '3 9 8 6 0',
    uncaughtException: undefined,
  });
});

test.each([
  {
    name: 'errorUnion',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(error{Oops}!u64);p.*=0x1234;std.debug.print("{} {} {} {}",.{bytes[0],bytes[1],bytes[8],try p.*});`,
    output: '52 18 0 4660',
  },
  {
    name: 'errorUnion16',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(error{Oops}!u16);p.*=0x1234;std.debug.print("{} {} {} {}",.{bytes[0],bytes[1],bytes[2],try p.*});`,
    output: '52 18 0 4660',
  },
  {
    name: 'errorUnion8',
    body: `var bytes:[32]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(error{Oops}!u8);p.*=52;std.debug.print("{} {} {} {}",.{bytes[0],bytes[1],bytes[2],try p.*});`,
    output: '0 0 52 52',
  },
])('fixed buffer error unions place payloads and errors according to alignment: $name', ({ body, output }) => {
  const source = `const std=@import("std");pub fn main()!void{${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test('UTF-8 BOM data survives separate and split output streams', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var buffer:[1]u8=undefined;var w=std.Io.File.stdout().writer(init.io,&buffer);try w.interface.writeByte(0xef);try w.interface.flush();std.debug.print("\\xef",.{});try w.interface.writeByte(0xbb);try w.interface.flush();std.debug.print("\\xbb\\xbferr",.{});try w.interface.writeByte(0xbf);try w.interface.writeAll("out");try w.interface.flush();}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stdout: '\uFEFFout',
    stderr: '\uFEFFerr',
    uncaughtException: undefined,
  });
});

test('BOM-prefixed data stays present during numeric parsing and import validation', () => {
  const source = `const std=@import("std");pub fn main()void{_=std.fmt.parseFloat(f64,"\\xef\\xbb\\xbf1.5") catch |e|{std.debug.print("{s}",.{@errorName(e)});return;};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'InvalidCharacter',
    uncaughtException: undefined,
  });
  expect(executeProgram('zig', `const std=@import("\\xef\\xbb\\xbfstd");pub fn main()void{_=std;}`).kind).toBe(
    'compileError'
  );
});

test.each([
  'const e:A=A.Two;const r:B=@errorCast(e);',
  'const e:A!u8=A.Two;const r:B!u8=@errorCast(e);',
  'const e:anyerror=error.Two;const r:B=@errorCast(e);',
  'const e:u8=7;const r:B!u8=@errorCast(e);',
  'const e:A!u8=A.One;const r:B=@errorCast(e);',
  'const e:A!u8=7;const r:B!u16=@errorCast(e);',
])('error casts validate known errors and operand types before execution: %s', (body) => {
  const source = `const std=@import("std");const A=error{One,Two};const B=error{One,Three};pub fn main()void{std.debug.print("pre|",.{});${body}std.debug.print("{any}",.{r});}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test.each([
  { body: 'const e:A=A.One;const r:B=@errorCast(e);', output: 'error.One' },
  { body: 'const e:A!u8=7;const r:B!u8=@errorCast(e);', output: '7' },
  { body: 'const e:A=A.One;const r:B!u8=@errorCast(e);', output: 'error.One' },
])('valid known error casts retain their error or payload: $body', ({ body, output }) => {
  const source = `const std=@import("std");const A=error{One,Two};const B=error{One,Three};pub fn main()void{${body}std.debug.print("{any}",.{r});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each(['anyerror', 'error{One,Two}!u8'])('dynamic error casts retain their runtime panic for %s', (inputType) => {
  const source = `const std=@import("std");const B=error{One,Three};fn cast(value:${inputType})${inputType.includes('!') ? 'B!u8' : 'B'}{return @errorCast(value);}pub fn main()void{std.debug.print("before|",.{});std.debug.print("{any}",.{cast(error.Two)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'before|',
    uncaughtException: 'panic: unexpected error code, found error.Two',
  });
});

test.each([
  {
    name: 'forward',
    body: `const P=struct{p:*u8,q:*[2]u8};var a=[_]u8{7,8};const p=try f.allocator().create(P);p.*=.{.p=&a[0],.q=&a};std.debug.print("{} {} {} {}",.{p.p.*,p.q[0],p.q[1],p.p==&p.q[0]});`,
    output: '7 7 8 true',
  },
  {
    name: 'reverse',
    body: `const P=struct{q:*[2]u8,p:*u8};var a=[_]u8{7,8};const p=try f.allocator().create(P);p.*=.{.q=&a,.p=&a[0]};std.debug.print("{} {} {} {}",.{p.p.*,p.q[0],p.q[1],p.p==&p.q[0]});`,
    output: '7 7 8 true',
  },
  {
    name: 'slices',
    body: `const P=struct{s:[]u8,q:*[2]u8,p:*const u8};var a=[_]u8{7,8};const p=try f.allocator().create(P);p.*=.{.s=&a,.q=&a,.p=&a[0]};p.s[1]=9;std.debug.print("{} {} {} {}",.{p.p.*,p.q[0],p.q[1],p.p==&p.q[0]});`,
    output: '7 7 9 true',
  },
])('fixed buffer pointer serialization preserves projections sharing an address: $name', ({ body, output }) => {
  const source = `const std=@import("std");pub fn main()!void{var buf:[256]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&buf);${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each([
  ['0x.8p1', '1'],
  ['0x1p1_0', '1024'],
  ['.5e1_0', '5000000000'],
  ['0X.A_BP+1_0', '684'],
  ['0x1.', '1'],
  ['0x1', '1'],
  ['0x1_e', '30'],
  ['-0x.8p1', '-1'],
])('float parsing accepts fractional and separated significands and exponents: %s', (text, output) => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{!}",.{std.fmt.parseFloat(f64,"${text}")});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each(['0x.', '0x1p', '0x1p_1', '0x1p1__0', '0x1_.0', '0x1._0'])(
  'float parsing rejects missing digits and misplaced separators: %s',
  (text) => {
    const source = `const std=@import("std");pub fn main()void{std.debug.print("{!}",.{std.fmt.parseFloat(f64,"${text}")});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'error.InvalidCharacter',
      uncaughtException: undefined,
    });
  }
);

test.each([
  'r.uintLessThan(u8,3)',
  'r.uintAtMost(u8,4)',
  'r.intRangeLessThan(i8,-1,2)',
  'r.weightedIndex(u8,&.{1,2})',
  'r.enumValue(enum{a,b,c})',
])('zero-state random rejection sampling respects execution limits: %s', (expression) => {
  const source = `const std=@import("std");pub fn main()void{var p=std.Random.DefaultPrng{.s=.{0,0,0,0}};const r=p.random();_= ${expression};}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded' });
});

test.each([
  '_=error.Foo;',
  'const e:anyerror=error.Foo;_=e;',
  'const A=error{One,Two};const e:A=A.One;_=e;',
  'f() catch |err|{_=err;};',
  'const e:error{Foo}!u8=error.Foo;_=e catch |err| err;',
])('discarding an error set is a compile error in every expression context: %s', (body) => {
  const source = `fn f()error{Foo}!void{return error.Foo;}pub fn main()void{${body}}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test('catch handlers can omit errors or use them while ordinary values remain discardable', () => {
  const source = `const std=@import("std");fn f()error{Foo}!u8{return error.Foo;}pub fn main()void{_=f() catch 0;_=f() catch |err|{std.debug.print("{s}",.{@errorName(err)});return;};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'Foo',
    uncaughtException: undefined,
  });
});

test.each(['f64', 'f128'])('slice ordering panics on distinct unordered values in %s', (type) => {
  for (const operation of ['order', 'lessThan']) {
    const source = `const std=@import("std");pub fn main()void{var n=std.math.nan(${type});_=&n;const a=[_]${type}{n};const b=[_]${type}{1};std.debug.print("before|",.{});std.debug.print("{any}",.{std.mem.${operation}(${type},&a,&b)});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'before|',
      uncaughtException: 'panic: reached unreachable code',
    });
  }
});

test.each(['f64', 'f128'])('slice ordering skips element reads at the same backing address in %s', (type) => {
  const source = `const std=@import("std");pub fn main()void{var n=std.math.nan(${type});_=&n;const a=[_]${type}{n,1};std.debug.print("{} {} {}",.{std.mem.order(${type},&a,&a),std.mem.order(${type},a[0..1],&a),std.mem.lessThan(${type},&a,&a)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '.eq .lt false',
    uncaughtException: undefined,
  });
});

test.each(['f64', 'f128'])('slice extrema select numeric values around NaN in %s', (type) => {
  for (const items of ['n,1,2', '1,n,2', '1,2,n']) {
    const source = `const std=@import("std");pub fn main()void{var n=std.math.nan(${type});_=&n;const a=[_]${type}{${items}};const low,const high=std.mem.minMax(${type},&a);std.debug.print("{d} {d}|{d} {d}",.{std.mem.min(${type},&a),std.mem.max(${type},&a),low,high});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '1 2|1 2',
      uncaughtException: undefined,
    });
  }
});

test.each(['0.0,-0.0', '-0.0,0.0'])('slice extrema preserve signed-zero ordering: %s', (items) => {
  const source = `const std=@import("std");pub fn main()void{const a=[_]f64{${items}};std.debug.print("{d} {d}",.{std.mem.min(f64,&a),std.mem.max(f64,&a)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '-0 0',
    uncaughtException: undefined,
  });
});

test.each([
  ['[_]u8{97}', '[_:0]u8{98}', 'ab'],
  ['[_:0]u8{97}', '[_]u8{98}', 'ab'],
  ['[_:0]u8{97}', '[_:0]u8{98}', 'ab'],
  ['[_]u8{97}', '"bc".*', 'abc'],
])('array concatenation combines compatible sentinel information: %s ++ %s', (left, right, output) => {
  const source = `const std=@import("std");pub fn main()void{const a=${left} ++ ${right};const s:[:0]const u8=&a;std.debug.print("{s}",.{s});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test('conflicting concatenation sentinels require an ordinary slice', () => {
  expect(
    executeProgram('zig', `pub fn main()void{const a=[_:1]u8{97} ++ [_:0]u8{98};const s:[:0]const u8=&a;_=s;}`).kind
  ).toBe('compileError');
});

test.each(['findLastNone', 'lastIndexOfNone'])('reverse set exclusion searches meter both phases: %s', (operation) => {
  const input = 'a'.repeat(1000);
  const set = 'b'.repeat(1999) + 'a';
  for (const receiver of ['input', 'getInput()']) {
    const source = `const std=@import("std");const input="${input}";fn getInput()[]const u8{return input;}pub fn main()void{_=std.mem.${operation}(u8,${receiver},"${set}");}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
});

test('allocated opaque native values preserve their state and supported fields', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var bytes:[1024]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const g=f.allocator();var a=std.Random.DefaultPrng.init(7);var b=std.Random.DefaultPrng.init(7);const r=try g.create(std.Random);r.*=a.random();std.debug.print("{}|",.{r.int(u8)==b.random().int(u8)});var m=std.AutoHashMap(u8,u8).init(init.gpa);defer m.deinit();try m.put(1,9);const it=try g.create(@TypeOf(m.iterator()));it.*=m.iterator();const ki=try g.create(@TypeOf(m.keyIterator()));ki.*=m.keyIterator();const vi=try g.create(@TypeOf(m.valueIterator()));vi.*=m.valueIterator();std.debug.print("{} {} {}|",.{it.next().?.value_ptr.*,ki.next().?.*,vi.next().?.*});const saved=try g.create(std.process.Init);saved.*=init;const io=try g.create(std.Io);io.*=saved.io;const file=try g.create(std.Io.File);file.*=std.Io.File.stdout();var buffer:[8]u8=undefined;const w=try g.create(std.Io.File.Writer);w.*=file.writer(io.*,&buffer);try w.interface.writeAll("ok");try w.interface.flush();}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stdout: 'ok',
    stderr: 'true|9 1 9|',
    uncaughtException: undefined,
  });
});

test.each(['rotl', 'rotr'])('rotation arguments must be integers before native evaluation: %s', (operation) => {
  for (const amount of ['true', '2.0', '"x"'])
    expect(
      executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.math.${operation}(u8,1,${amount});}`).kind
    ).toBe('compileError');
});

test.each(['gcd', 'lcm'])(
  'integer number theory rejects float operands without entering native loops: %s',
  (operation) => {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{_=std.math.${operation}(@as(f64,1),@as(f64,2));}`
      ).kind
    ).toBe('compileError');
  }
);

test('gcd validates its unsigned domain and lcm preserves absolute signed results', () => {
  expect(
    executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.math.gcd(@as(i32,1),@as(i32,2));}`).kind
  ).toBe('compileError');
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{} {} {}",.{std.math.gcd(@as(u32,48),18),std.math.lcm(@as(i32,-3),4),std.math.lcm(0,0)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '6 12 0',
    uncaughtException: undefined,
  });
});

test.each(['anyerror!struct{bytes:[100]u8}', 'enum(u64){a}', '?anyerror!struct{bytes:[100]u8}'])(
  'allocator accounting resolves complete previously unused layouts: %s',
  (type) => {
    const source = `const std=@import("std");const T=${type};pub fn main()void{var bytes:[0]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);_=f.allocator().alloc(T,1) catch |err|{std.debug.print("{s}",.{@errorName(err)});return;};std.debug.print("allocated",.{});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'OutOfMemory',
      uncaughtException: undefined,
    });
  }
);

test('recursive by-value types through error unions fail before materializing storage', () => {
  const source = `const std=@import("std");const S=struct{x:anyerror!S};pub fn main()void{var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);_=f.allocator().create(S) catch return;}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test.each([
  '@memcpy(bytes[1..3],p[0..2])',
  '@memcpy(p[1..3],bytes[0..2])',
  '_=std.mem.replace(u8,"aa","a",p[0..2],bytes[1..5])',
])('overlap checks normalize allocated and caller-backed views: %s', (operation) => {
  const source = `const std=@import("std");pub fn main()!void{var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().alloc(u8,4);@memset(p,97);${operation};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'panic: @memcpy arguments alias',
  });
});

test('disjoint multi-byte memory ranges remain copyable', () => {
  const source = `const std=@import("std");pub fn main()void{var a=[_]u16{1,2,3,4};@memcpy(a[2..4],a[0..2]);@memcpy(a[0..0],a[0..0]);std.debug.print("{any}",.{a});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '{ 1, 2, 1, 2 }',
    uncaughtException: undefined,
  });
});

test('contextual addresses coerce complete temporary values into optional and error-union pointees', () => {
  const source = `const std=@import("std");fn make()u8{return 6;}pub fn main()void{const a:*const ?u8=&null;const b:*const ?u8=&@as(u8,3);const c:*const error{A}!u8=&@as(u8,1);const d:*const ?[]const u8=&"ab";const e:*const ?i32=&(1+2);const f:*const ?u8=&make();std.debug.print("{} {} {!} {s} {} {}",.{a.*==null,b.*.?,c.*,d.*.?,e.*.?,f.*.?});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true 3 1 ab 3 6',
    uncaughtException: undefined,
  });
  expect(executeProgram('zig', `pub fn main()void{var n:u8=3;const p:*const ?u8=&n;_=p;}`).kind).toBe('compileError');
});

test.each(['&a', 's'])('for pointer captures preserve read-only element types: %s', (operand) => {
  const source = `const std=@import("std");pub fn main()void{const a=[_]u8{1,2};${operand === 's' ? 'const s:[]const u8=&a;' : ''}for(${operand})|*p|std.debug.print("{} ",.{p.*});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 ',
    uncaughtException: undefined,
  });
  expect(executeProgram('zig', `pub fn main()void{const a=[_]u8{1,2};for(&a)|*p|p.*=3;}`).kind).toBe('compileError');
});

test('composed return and break values are snapshotted before deferred source mutation', () => {
  const source = `const std=@import("std");const S=struct{x:u8};fn returned(flag:bool)S{var a:S=.{.x=1};defer a.x=9;return if(flag)a else S{.x=2};}fn broken(flag:bool)S{return blk:{var a:S=.{.x=3};defer a.x=9;break :blk if(flag)a else S{.x=4};};}pub fn main()void{std.debug.print("{} {}",.{returned(true).x,broken(true).x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 3',
    uncaughtException: undefined,
  });
});

test('computed native calls snapshot aggregate operands before later argument effects', () => {
  const source = `const std=@import("std");const S=struct{x:u8};fn change(p:*S)S{p.x=2;return p.*;}fn array(p:*[2]u8)[2]u8{p[0]=2;return p.*;}pub fn main()void{var a=S{.x=1};var b=[_]u8{1,3};std.debug.print("{} {}",.{std.meta.eql(a,change(&a)),std.meta.eql(b,array(&b))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false false',
    uncaughtException: undefined,
  });
});

test.each(['list.shrinkAndFree(g,0);', 'list.clearRetainingCapacity();_=try list.toOwnedSlice(g);'])(
  'zero-sized list replacements release prior allocator reservations: %s',
  (operation) => {
    const source = `const std=@import("std");pub fn main()!void{var bytes:[256]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const g=f.allocator();var list:std.ArrayList(u8)=.empty;try list.append(g,1);${operation}const p=try g.alloc(u8,200);std.debug.print("{} {}",.{p.len,f.end_index});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '200 200',
      uncaughtException: undefined,
    });
  }
);

test.each(['f64', 'f128'])('clamp shares numeric min/max semantics and rejects unordered bounds: %s', (type) => {
  const source = `const std=@import("std");pub fn main()void{const n=std.math.nan(${type});std.debug.print("{d}|",.{std.math.clamp(n,@as(${type},0),@as(${type},1))});std.debug.print("{d}",.{std.math.clamp(@as(${type},0.5),n,@as(${type},1))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1|',
    uncaughtException: 'panic: reached unreachable code',
  });
});

test('large unreachable binding lists obey compilation limits and leave the parser reusable', () => {
  const declarations = Array.from({ length: 80_000 }, (_, i) => `const x${i}=0;_=x${i};`).join('');
  expect(executeProgram('zig', `fn never()void{${declarations}}pub fn main()void{}`)).toMatchObject({
    kind: 'limitExceeded',
  });
  expect(executeProgram('zig', 'pub fn main()void{}')).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test.each(['error{One,Two,One}', 'enum(u8){one=1,two=1}', 'union(enum{one,two}){one:u8,three:u8}'])(
  'indexed declaration validation retains duplicate and missing-tag diagnostics: %s',
  (type) => {
    const source = `const std=@import("std");const T=${type};pub fn main()void{var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);_=f.allocator().create(T) catch return;}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
);

test('native aggregate selections snapshot on return while slice results retain shared backing', () => {
  const source = `const std=@import("std");const S=struct{x:u8};var global=[_]u8{1};fn less(_:void,a:S,b:S)bool{return a.x<b.x;}fn selected()S{var a=[_]S{.{.x=1}};defer a[0].x=9;return std.sort.min(S,&a,{},less).?;}fn view()[]u8{defer global[0]=9;return &global;}pub fn main()void{std.debug.print("{} {}",.{selected().x,view()[0]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 9',
    uncaughtException: undefined,
  });
});

test('zero-sized allocator replacements and empty allocations do not leak debug reservations', () => {
  const source = `const std=@import("std");pub fn main()!void{var d=std.heap.DebugAllocator(.{}).init;const g=d.allocator();const p=try g.alloc(u8,2);_=try g.realloc(p,0);_=try g.alloc(u8,0);std.debug.print("{}",.{d.deinit()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '.ok',
    uncaughtException: undefined,
  });
});

test.each(['f32', 'f64', 'f128', 'comptime_float'])(
  'known min/max signed-zero ties retain the second operand in %s',
  (type) => {
    const source = `const std=@import("std");pub fn main()void{const a=@min(@as(${type},-0.0),@as(${type},0.0));const b=@max(@as(${type},0.0),@as(${type},-0.0));std.debug.print("{d} {d}",.{a,b});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '0 -0',
      uncaughtException: undefined,
    });
  }
);

test.each(['f32', 'f64', 'f128'])('runtime min/max signed-zero ties retain instruction semantics in %s', (type) => {
  const source = `const std=@import("std");pub fn main()void{var a:${type}=-0.0;var b:${type}=0.0;_=&a;_=&b;std.debug.print("{d} {d}",.{@min(a,b),@max(b,a)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '-0 0',
    uncaughtException: undefined,
  });
});

test.each([
  ['@"a,b"', 'a,b', 'b', 'a,b b'],
  ['@"a,b,c"', 'a,@"b,c"', '@"b,c"', 'a,b,c b,c'],
])('quoted comma names cannot collide with multiple error-set members: %s', (first, second, member, output) => {
  const source = `const std=@import("std");const A=error{${first}};const B=error{${second}};fn f()B{return error.${member};}pub fn main()void{const a:A=error.${first};std.debug.print("{s} {s}",.{@errorName(a),@errorName(f())});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test('float sentinels preserve distinct values and readable array and slice type names', () => {
  const source = `const std=@import("std");pub fn main()void{const a=[_:1.0]f128{3};const b=[_:2.0]f128{3};std.debug.print("{d} {d}|{} {}",.{a[1],b[1],@TypeOf(a),@TypeOf(@as([:1.0]const f128,&a))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2|[1:1]f128 [:1]const f128',
    uncaughtException: undefined,
  });
});

test('error sentinels preserve distinct values and readable array and slice type names', () => {
  const source = `const std=@import("std");const E=error{A,B};pub fn main()void{const a=[_:error.A]E{error.B};const b=[_:error.B]E{error.A};std.debug.print("{s} {s}|{} {}",.{@errorName(a[1]),@errorName(b[1]),@TypeOf(a),@TypeOf(@as([:error.A]const E,&a))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'A B|[1:error.A]error{A,B} [:error.A]const error{A,B}',
    uncaughtException: undefined,
  });
});

test('byte-backed sentinel arrays initialize and compare float sentinels by value', () => {
  const source = `const std=@import("std");pub fn main()!void{var bytes:[64]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create([1:1.0]f128);p.*=.{3};const s=p[0..1:1.0];std.debug.print("{d} {d}",.{s[0],p[1]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '3 1',
    uncaughtException: undefined,
  });
});

test('process init exposes a usable arena allocator and capacity state', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{std.debug.print("{}|",.{init.arena.queryCapacity()});const a=try init.arena.allocator().alloc(u8,3);a[0]=42;std.debug.print("{} {}",.{a[0],init.arena.queryCapacity()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0|42 42',
    uncaughtException: undefined,
  });
});

test('constant writer values and pointers permit buffered inspection and reject mutation', () => {
  const source = `const std=@import("std");pub fn main()void{var b:[8]u8=undefined;const w=std.Io.Writer.fixed(&b);const p=&w;std.debug.print("{} {}",.{w.buffered().len,p.buffered().len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0 0',
    uncaughtException: undefined,
  });
  for (const receiver of ['w', 'p'])
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{var b:[8]u8=undefined;const w=std.Io.Writer.fixed(&b);${receiver === 'p' ? 'const p=&w;' : ''}${receiver}.writeAll("x") catch unreachable;}`
      ).kind
    ).toBe('compileError');
});

test('known optional captures retain compile-time payloads and skip unselected semantic branches', () => {
  const source = `const std=@import("std");pub fn main()void{const size:?usize=3;if(size)|len|{const a:[len]u8=@splat(7);std.debug.print("{any}",.{a});}else{const bad:u8=300;_=bad;}const none:?u8=null;if(none)|x|{const bad:u8=300;_=bad;_=x;}else{std.debug.print(" null",.{});}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '{ 7, 7, 7 } null',
    uncaughtException: undefined,
  });
});

test('known error unions select handlers with their own payload type and known captures', () => {
  const source = `const std=@import("std");pub fn main()void{const ok:error{Bad}!u8=1;if(ok)|x|{std.debug.print("{} ",.{x});}else|err|{const bad:u8=300;_=bad;_=err;}const e:error{Bad}!u8=error.Bad;const a=e catch 1000;const b=e catch |err| @errorName(err);std.debug.print("{} {s}",.{a,b});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 1000 Bad',
    uncaughtException: undefined,
  });
});

test('resolved empty error sets skip catch and if handlers while retaining calls', () => {
  const source = `const std=@import("std");fn inferred()!void{std.debug.print("a",.{});}fn explicit()error{}!u8{std.debug.print("b",.{});return 4;}pub fn main()void{inferred() catch |err|{_=err;};if(explicit())|x|{std.debug.print("{}",.{x});}else|err|{_=err;}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'ab4',
    uncaughtException: undefined,
  });
});

test('recursive inferred error sets retain reachable handlers', () => {
  const source = `const std=@import("std");fn recurse(n:u8)!void{if(n==0)return error.Bad;try recurse(n-1);}pub fn main()void{recurse(2) catch |err|{std.debug.print("{s}",.{@errorName(err)});};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'Bad',
    uncaughtException: undefined,
  });
});

test('anytype specializes numeric literals by value and keeps void helpers at runtime', () => {
  const source = `const std=@import("std");fn tw(v:anytype)@TypeOf(v){return v+v;}fn show(v:anytype)void{std.debug.print("{d}",.{v});}fn make(n:anytype)[n]u8{return @splat(7);}pub fn main()void{std.debug.print("{d} {d} {d} {any}|",.{tw(3),tw(5),tw(1.5),make(2)});show(5);show(7);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '6 10 3 { 7, 7 }|57',
    uncaughtException: undefined,
  });
});

test.each([
  'var t:u32=100;const c:u32=t;',
  'const c:u32=t;var t:u32=100;',
  'var t:u32=100;var c:u32=t+1;',
  'var t:u32=100;const p=&t;const c:u32=p.*;',
  'var a:[2]u8=.{1,2};const c:u8=a[0];',
  'const S=struct{x:u8};var s:S=.{.x=3};const c:u8=s.x;',
  'var t:u32=100;fn read()u32{return t;}const c:u32=read();',
])('container initializers reject runtime memory reads: %s', (declarations) => {
  expect(
    executeProgram('zig', `const std=@import("std");${declarations}pub fn main()void{std.debug.print("{any}",.{c});}`)
      .kind
  ).toBe('compileError');
});

test('container initializers allow pure calls, constant storage, addresses and array type lengths', () => {
  const source = `const std=@import("std");fn pure(x:u32)u32{return x+1;}var t:u32=pure(4);var a:[2]u8=.{1,2};const p=&a;const n=a.len;const m=p.len;const same=&t==&t;const s:[]const u8="abc";var count:usize=s.len;pub fn main()void{std.debug.print("{} {} {} {} {}",.{t,n,m,same,count});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '5 2 2 true 3',
    uncaughtException: undefined,
  });
});

test('comptime-only return values reject runtime argument reads and output effects', () => {
  for (const body of [
    'fn f(v:u8)comptime_int{_=v;return 3;}pub fn main()void{var v:u8=2;_=&v;std.debug.print("{}",.{f(v)});}',
    'fn f(v:anytype)@TypeOf(v){std.debug.print("x",.{});return v;}pub fn main()void{std.debug.print("{}",.{f(3)});}',
  ])
    expect(executeProgram('zig', `const std=@import("std");${body}`).kind).toBe('compileError');
});

test.each(['void', 'struct{}'])('zero-sized ArrayList %s capacity is virtual across growth and shrinking', (type) => {
  const value = type === 'void' ? '{}' : '.{}';
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var l:std.ArrayList(${type})=.empty;try l.append(init.gpa,${value});try l.resize(init.gpa,3);std.debug.print("{} {}|",.{l.capacity,l.items.len});try l.ensureTotalCapacityPrecise(init.gpa,0);l.shrinkAndFree(init.gpa,1);const c=try l.clone(init.gpa);std.debug.print("{} {} {}",.{l.capacity,c.capacity,c.items.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615 3|18446744073709551615 18446744073709551615 1',
    uncaughtException: undefined,
  });
});

test('zero-sized ArrayList initialization and growth need no element storage', () => {
  const source = `const std=@import("std");pub fn main()!void{var b:[0]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);const g=f.allocator();var l=try std.ArrayList(void).initCapacity(g,0);try l.appendNTimes(g,{},4);l.appendAssumeCapacity({});std.debug.print("{} {} {}",.{l.capacity,l.items.len,f.end_index});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615 5 0',
    uncaughtException: undefined,
  });
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main(init:std.process.Init)!void{var l:std.ArrayList(void)=.empty;try l.appendNTimes(init.gpa,{},1000000000);std.debug.print("{}",.{l.items.len});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '1000000000', uncaughtException: undefined });
});

test('ArrayList print reserves before custom formatting while arguments are evaluated first', () => {
  const source = `const std=@import("std");const S=struct{pub fn format(_:S,w:*std.Io.Writer)std.Io.Writer.Error!void{std.debug.print("format",.{});try w.writeAll("");}};fn argument()S{std.debug.print("arg|",.{});return .{};}pub fn main()void{var b:[1]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);var l:std.ArrayList(u8)=.empty;l.print(f.allocator(),"{f}",.{argument()}) catch |e|{std.debug.print("{s}",.{@errorName(e)});};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'arg|OutOfMemory',
    uncaughtException: undefined,
  });
});

test('ArrayList allocating writer retains partial output when later growth fails', () => {
  const source = `const std=@import("std");const S=struct{pub fn format(_:S,w:*std.Io.Writer)std.Io.Writer.Error!void{try w.writeAll("abc");try w.writeAll("${'x'.repeat(180)}");}};pub fn main()void{var b:[150]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);var l:std.ArrayList(u8)=.empty;l.print(f.allocator(),"{f}",.{S{}}) catch |e|{std.debug.print("{s}|{s}|{}",.{@errorName(e),l.items,l.capacity});};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory|abc|132',
    uncaughtException: undefined,
  });
});

test.each([
  'const x=std.fmt.parseInt(u8,"12",10) catch "bad";_=x;',
  'std.fmt.parseInt(u8,"12",10) catch |err|{_=err;return;};',
  'if(std.fmt.parseInt(u8,"12",10))|x|{_=x;}else|err|{_=err;}',
  'if(std.mem.indexOf(u8,"abc","b"))|i|{_=i;}else{const z:u8=300;_=z;}',
])('native calls with runtime result types retain semantic branch checks: %s', (body) => {
  expect(executeProgram('zig', `const std=@import("std");pub fn main()void{${body}}`).kind).toBe('compileError');
});

test.each(['f64', 'f128'])('opposite signed-zero %s sentinels conflict during concatenation', (type) => {
  for (const [left, right] of [
    ['0.0', '-0.0'],
    ['-0.0', '0.0'],
  ]) {
    const source = `const std=@import("std");pub fn main()void{const a=[_:${left}]${type}{1};const b=[_:${right}]${type}{2};std.debug.print("{}",.{@TypeOf(a++b)});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: `[2]${type}`,
      uncaughtException: undefined,
    });
  }
});

test('clamp numeric folds preserve compile-time and runtime signed-zero rules', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{d} {d}|{d}",.{std.math.clamp(-0.0,-0.0,0.0),std.math.clamp(-0.0,0.0,0.1),std.math.clamp(@as(f64,-0.0),@as(f64,-0.0),@as(f64,0.0))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0 -0|-0',
    uncaughtException: undefined,
  });
});

test.each(['v', 'if(flag) v else other'])('switch continue snapshots %s before deferred mutation', (value) => {
  const source = `const std=@import("std");const S=struct{x:u8};const U=union(enum){start:void,next:S};pub fn main()void{const u=U{.start={}};sw:switch(u){.start=>{var v=U{.next=.{.x=1}};${value === 'v' ? '' : 'const other=U{.next=.{.x=2}};var flag=true;_=&flag;'}defer v.next.x=9;continue :sw ${value};},.next=>|s|std.debug.print("{}",.{s.x}),}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
});

test('optional error sets use their null niche in allocation layout and fixed-buffer storage', () => {
  const source = `const std=@import("std");const E=error{A,B};const S=struct{e:?E};pub fn main(init:std.process.Init)!void{var l:std.ArrayList(?E)=.empty;try l.append(init.gpa,null);var b:[4]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);const p=try f.allocator().create(S);p.*=.{.e=error.A};std.debug.print("{} {s}|",.{l.capacity,@errorName(p.e.?)});p.e=null;std.debug.print("{} {}",.{p.e==null,f.end_index});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '65 A|true 2',
    uncaughtException: undefined,
  });
});

test.each([
  ['upperString', 'a', 'b', 'c', 'd', 'aAAA'],
  ['lowerString', 'A', 'B', 'C', 'D', 'Aaaa'],
])('ascii %s observes forward-overlapping writes', (method, a, b, c, d, expected) => {
  const source = `const std=@import("std");pub fn main()void{var a=[_]u8{'${a}','${b}','${c}','${d}'};_=std.ascii.${method}(a[1..4],a[0..3]);std.debug.print("{s}",.{a});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test.each(['rotl', 'rotr'])('%s checks signed amount peer types against u16', (name) => {
  for (const type of ['i8', 'i16'])
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{var n:${type}=-1;_=&n;std.debug.print("{}",.{std.math.${name}(u8,1,n)});}`
      ).kind
    ).toBe('compileError');
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{var n:i32=-1;_=&n;std.debug.print("{}",.{std.math.${name}(u8,1,n)});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: name === 'rotl' ? '128' : '2', uncaughtException: undefined });
});

test.each(['uintLessThan', 'uintAtMost', 'uintLessThanBiased', 'uintAtMostBiased'])(
  '%s rejects signed result types',
  (name) => {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{var p=std.Random.DefaultPrng.init(1);std.debug.print("{}",.{p.random().${name}(i8,10)});}`
      ).kind
    ).toBe('compileError');
  }
);

test.each(['u', 'U{.a=1}'])('union switches allow readonly pointer captures from %s', (operand) => {
  const source = `const std=@import("std");const U=union(enum){a:u8,b:u8};pub fn main()void{${operand === 'u' ? 'const u:U=.{.a=1};' : ''}switch(${operand}){.a=>|*p|std.debug.print("{}",.{p.*}),.b=>{}}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
  expect(executeProgram('zig', source.replace('std.debug.print("{}",.{p.*})', '{p.*=2;}')).kind).toBe('compileError');
});

test.each(['if(flag) a else b', 'switch(flag){true=>a,false=>b}'])('for loops snapshot array-valued %s', (operand) => {
  const source = `const std=@import("std");pub fn main()void{var a=[_]u8{1,2};const b=[_]u8{3,4};var flag=true;_=&flag;for(${operand})|x|{std.debug.print("{} ",.{x});a[1]=9;}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2 ',
    uncaughtException: undefined,
  });
});

test.each(['.{}', 'std.AutoHashMapUnmanaged(u8,u8){}'])(
  'unmanaged map default initializer %s produces an independent usable header',
  (initializer) => {
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.AutoHashMapUnmanaged(u8,u8)=${initializer};var b:std.AutoHashMapUnmanaged(u8,u8)=.{};try a.put(init.gpa,1,3);std.debug.print("{} {}",.{a.get(1).?,b.count()});b.deinit(init.gpa);a.deinit(init.gpa);}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '3 0',
      uncaughtException: undefined,
    });
  }
);

test('string unmanaged maps and debug allocators accept reference default initialization', () => {
  const source = `const std=@import("std");pub fn main()!void{var d=std.heap.DebugAllocator(.{}){};const g=d.allocator();var m:std.StringHashMapUnmanaged(u8)=.{};try m.put(g,"a",3);std.debug.print("{} ",.{m.get("a").?});m.deinit(g);std.debug.print("{}",.{d.deinit()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '3 .ok',
    uncaughtException: undefined,
  });
});

test.each(['std.AutoHashMap(u8,u8)', 'std.Io.Writer', 'std.Random'])(
  'native type %s requires its reference initializer',
  (type) => {
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{const x:${type}=.{};_=x;}`).kind).toBe(
      'compileError'
    );
  }
);

test.each([
  ['u8', '5', 'i8', '-1'],
  ['u64', '7', 'i32', '-2'],
  ['u32', '5', 'i16', '-1'],
])('mixed known integers choose one peer type: %s and %s', (first, a, second, b) => {
  const source = `const std=@import("std");pub fn main()void{const a:${first}=${a};const b:${second}=${b};std.debug.print("{}",.{a+b});}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test('known mixed integer peer selection preserves signed-first ties and wider signed types', () => {
  const source = `const std=@import("std");pub fn main()void{const a:i8=-1;const b:u8=5;const c:i64=-2;const d:u32=7;std.debug.print("{} {}",.{a+b,c+d});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '4 5',
    uncaughtException: undefined,
  });
});

test('anytype type arguments specialize dependent values and returned containers by identity', () => {
  const source = `const std=@import("std");fn show(t:anytype)void{std.debug.print("{} ",.{t});}fn zero(T:anytype)T{return 0;}fn Box(T:anytype)type{return struct{x:T};}pub fn main()void{show(u8);show(i32);const A=Box(u8);const B=Box(u16);const a=A{.x=3};const b=B{.x=4};std.debug.print("{} {} {}",.{zero(u8),a.x,b.x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'u8 i32 0 3 4',
    uncaughtException: undefined,
  });
});

test.each([
  ['==', 'false false'],
  ['!=', 'false true'],
])('comparison %s retains the first temporary turtle through the second operand', (operator, output) => {
  const source = `const std=@import("std");fn first(a:std.mem.Allocator)!*Turtle{const p=try a.create(Turtle);p.*=Turtle.init(0,1);return p;}fn second(a:std.mem.Allocator)!*Turtle{const p=try a.create(Turtle);p.*=Turtle.init(0,0);std.debug.print("{} ",.{p.canMoveForward()});return p;}pub fn main(init:std.process.Init)!void{const same=(try first(init.gpa))${operator}(try second(init.gpa));std.debug.print("{}",.{same});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each(['==', '!='])('direct tagged union %s is rejected, including optional payloads', (operator) => {
  for (const type of ['U', '?U']) {
    const source = `const std=@import("std");const U=union(enum){a:u8,b:u8};pub fn main()void{const x:${type}=U{.a=1};const y:${type}=U{.a=2};std.debug.print("{}",.{x${operator}y});}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test('concatenation snapshots array values before later operand mutations', () => {
  const source = `const std=@import("std");const S=struct{x:u8};fn other(a:*[1]S)[1]S{a[0].x=9;return .{.{.x=3}};}pub fn main()void{var a=[_]S{.{.x=1}};const b=a++other(&a);std.debug.print("{} {} {}",.{b[0].x,b[1].x,a[0].x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 3 9',
    uncaughtException: undefined,
  });
});

test.each([
  'if(std.mem.eql(u8,"a","a")){}else{const z:u8=300;_=z;}',
  'const r=if(std.mem.eql(u8,"a","a")) @as(u8,1) else "x";_=r;',
  'switch(std.mem.count(u8,"aa","a")){2=>{},else=>{const z:u8=300;_=z;}}',
  'while(std.mem.eql(u8,"a","b")){const z:u8=300;_=z;}',
  "const b=std.ascii.isDigit('5');if(b){}else{const z:u8=300;_=z;}",
])('runtime native conditions retain all branch checks: %s', (body) => {
  expect(executeProgram('zig', `const std=@import("std");pub fn main()void{${body}}`).kind).toBe('compileError');
});

test.each(['300', '-1', 'true', '1.5'])(
  'enumFromInt rejects nonrepresentable or noninteger known input %s',
  (value) => {
    const source = `const std=@import("std");const E=enum(u8){a,_};pub fn main()void{const x:E=@enumFromInt(${value});std.debug.print("{}",.{@intFromEnum(x)});}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
);

test('enumFromInt retains valid nonexhaustive tags and dynamic range panics', () => {
  const valid = `const std=@import("std");const E=enum(u8){a,_};pub fn main()void{const x:E=@enumFromInt(255);std.debug.print("{}",.{@intFromEnum(x)});}`;
  expect(executeProgram('zig', valid)).toMatchObject({ kind: 'executed', stderr: '255', uncaughtException: undefined });
  const dynamic = valid.replace('const x:E=@enumFromInt(255);', 'var n:u16=300;_=&n;const x:E=@enumFromInt(n);');
  expect(executeProgram('zig', dynamic)).toMatchObject({ kind: 'executed', uncaughtException: expect.any(String) });
});

test.each(['[]Turtle', '*[1]Turtle'])('memset roots its temporary %s destination through filler evaluation', (type) => {
  const source = `const std=@import("std");fn first(a:std.mem.Allocator)!${type}{const p=try a.${type === '[]Turtle' ? 'alloc(Turtle,1)' : 'create([1]Turtle)'};p[0]=Turtle.init(0,1);return p;}fn fill()Turtle{const t=Turtle.init(0,0);std.debug.print("{}",.{t.canMoveForward()});return t;}pub fn main(init:std.process.Init)!void{@memset(try first(init.gpa),fill());}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false',
    uncaughtException: undefined,
  });
});

test.each([
  ['fn next()!u8{std.debug.print("call|",.{});return 3;}', 'next()', 'call|3'],
  ['fn next()error{}!u8{return 3;}', 'next()', '3'],
  ['', 'e', '3'],
])('infallible error-union while conditions skip dead handlers: %s', (declaration, condition, output) => {
  const source = `const std=@import("std");${declaration}pub fn main()void{${condition === 'e' ? 'const e:error{Bad}!u8=3;' : ''}while(${condition})|x|{std.debug.print("{}",.{x});break;}else|err|{_=err;}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test('fallible error-union while conditions retain handler validation', () => {
  const source = `fn next()error{Bad}!u8{return error.Bad;}pub fn main()void{while(next())|x|{_=x;break;}else|err|{_=err;}}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test.each([
  ['const n:u16=if(get()) |_| @as(u8,3) else |_| unreachable;', '3'],
  ['const n=(if(get()) |_| @as(u8,3) else |_| unreachable)+1;', '4'],
])(
  'selected known results retain runtime condition effects through coercion and arithmetic: %s',
  (declaration, output) => {
    const source = `const std=@import("std");fn get()error{}!u8{std.debug.print("call|",.{});return 1;}pub fn main()void{${declaration}std.debug.print("{}",.{n});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: `call|${output}`,
      uncaughtException: undefined,
    });
  }
);

test.each([
  'std.math.isPowerOfTwo(true)',
  'std.math.isPowerOfTwo(1.5)',
  'std.math.cast(u8,true)',
  'std.math.cast(u8,1.5)',
  'std.math.lossyCast(u8,true)',
  'std.math.lossyCast(f64,true)',
  'std.math.lossyCast(u8,"abc")',
])('math rejects nonnumeric or noninteger inputs before evaluation: %s', (expression) => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{const x=${expression};std.debug.print("{any}",.{x});}`
    ).kind
  ).toBe('compileError');
});

test.each(['anytype', 'usize'])(
  'compile-time type contexts evaluate pure helper calls with %s parameters',
  (parameter) => {
    const source = `const std=@import("std");fn half(v:${parameter})usize{return v/2;}pub fn main()void{const a:[half(4)]u8=@splat(0);std.debug.print("{} {}",.{a.len,@as([half(4)]u8,@splat(0)).len});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '2 2',
      uncaughtException: undefined,
    });
  }
);

test('compile-time helper evaluation rejects runtime reads and output in type contexts', () => {
  for (const declarations of [
    'var n:usize=4;fn count()usize{return n;}',
    'fn count()usize{std.debug.print("x",.{});return 4;}',
  ]) {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");${declarations}pub fn main()void{const a:[count()]u8=@splat(0);std.debug.print("{}",.{a.len});}`
      ).kind
    ).toBe('compileError');
  }
});

test('allocator instance methods reject const pointer receivers', () => {
  for (const call of ['p.reset();', '_=p.allocator();']) {
    const source = `const std=@import("std");pub fn main()void{var b:[16]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&b);const p:*const std.heap.FixedBufferAllocator=&f;${call}}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test.each([
  'std.debug.print("{f}",.{P{}});',
  'var b:[32]u8=undefined;_=std.fmt.bufPrint(&b,"{f}",.{P{}}) catch unreachable;',
])('custom format rejects foreign errors for every print destination: %s', (statement) => {
  for (const errorType of ['!void', 'error{Bad}!void']) {
    const source = `const std=@import("std");const P=struct{pub fn format(_:P,w:*std.Io.Writer)${errorType}{_=w;return error.Bad;}};pub fn main()void{${statement}}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test.each(['sort', 'sortUnstable'])(
  'mem.%s shares the exact comparator signature contract with sort adapters',
  (name) => {
    for (const signature of ['_:void,a:i64,b:i64', '_:u8,a:i32,b:i32']) {
      const source = `const std=@import("std");fn less(${signature})bool{return a<b;}pub fn main()void{var a=[_]i32{3,2,1};std.mem.${name}(i32,&a,{},less);std.debug.print("{any}",.{a});}`;
      expect(executeProgram('zig', source).kind).toBe('compileError');
    }
  }
);

test.each(['void', 'struct{}'])(
  'zero-sized %s capacity slices preserve exact logical lengths and bounded access',
  (type) => {
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var l:std.ArrayList(${type})=.empty;try l.append(init.gpa,${type === 'void' ? '{}' : '.{}'});const u=l.unusedCapacitySlice();const all=l.allocatedSlice();const tail=u[1..];const part=u[0..2];_=part[1];std.debug.print("{} {} {} {}",.{u.len,all.len,tail.len,part.len});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '18446744073709551614 18446744073709551615 18446744073709551613 2',
      uncaughtException: undefined,
    });
  }
);

test.each(['put', 'fetchPut'])('StringHashMap %s preserves the original stored key on update', (method) => {
  const update =
    method === 'put'
      ? 'try m.put(&b,2);'
      : 'const old=(try m.fetchPut(&b,2)).?;std.debug.print("{} {}|",.{&old.key[0]==&a[0],old.value});';
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a=[_]u8{97,98,99};var b=[_]u8{97,98,99};var m=std.StringHashMap(u8).init(init.gpa);try m.put(&a,1);${update}var it=m.iterator();const e=it.next().?;std.debug.print("{} {}",.{&e.key_ptr.*[0]==&a[0],e.value_ptr.*});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: method === 'put' ? 'true 2' : 'true 1|true 2',
    uncaughtException: undefined,
  });
});

test('split readonly queries and token rest accept constant iterators', () => {
  const source = `const std=@import("std");pub fn main()void{const s=std.mem.splitScalar(u8,"a,b",44);const t=std.mem.tokenizeScalar(u8," a b",32);std.debug.print("{s}|{s}|{s}",.{s.peek().?,s.rest(),t.rest()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'a|a,b|a b',
    uncaughtException: undefined,
  });
});

test.each(['next', 'first', 'reset'])('split %s rejects a const pointer receiver', (method) => {
  const call = method === 'reset' ? 'p.reset();' : `_=p.${method}();`;
  const source = `const std=@import("std");pub fn main()void{var it=std.mem.splitScalar(u8,"a,b",44);const p:*const @TypeOf(it)=&it;${call}}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test.each(['_=it.next();', '_=it.next();_=it.next();'])(
  'split first checks the current iteration state: %s',
  (advance) => {
    const source = `const std=@import("std");pub fn main()void{var it=std.mem.splitScalar(u8,"a,b",44);${advance}std.debug.print("{s}",.{it.first()});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '',
      uncaughtException: expect.stringContaining(
        advance.includes('_=it.next();_=it.next();') ? 'attempt to use null value' : 'reached unreachable code'
      ),
    });
  }
);

test('containsAtLeastScalar checks thresholds during iteration and returns false for empty input', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{} {} {} {}",.{std.mem.containsAtLeastScalar(u8,"",97,0),std.mem.containsAtLeastScalar(u8,"b",97,0),std.mem.containsAtLeastScalar(u8,"a",97,1),std.mem.containsAtLeastScalar(u8,"b",97,1)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false true true false',
    uncaughtException: undefined,
  });
});

test.each([
  ['isSorted', 'fn compare(_:void,a:u8,b:u8)u8{return @intFromBool(a<b);}'],
  ['binarySearch', 'fn compare(_:void,a:u8)bool{return a<2;}'],
  ['partitionPoint', 'fn compare(_:void,a:u8)std.math.Order{return std.math.order(a,2);}'],
  ['equalRange', 'fn compare(_:void,a:u8)bool{return a<2;}'],
])('sort query %s requires its complete callback signature', (method, compare) => {
  const source = `const std=@import("std");${compare}pub fn main()void{const a=[_]u8{1,2};_=std.sort.${method}(u8,&a,{},compare);}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test('enums fromInt accepts representable unnamed tags and retains exhaustive membership checks', () => {
  const source = `const std=@import("std");const E=enum(u8){a=1,_};const S=enum(i8){a=1,_};const F=enum(u8){a=1};pub fn main()void{std.debug.print("{} {} {} {}",.{@intFromEnum(std.enums.fromInt(E,2).?),@intFromEnum(std.enums.fromInt(S,-2).?),std.enums.fromInt(S,200)==null,std.enums.fromInt(F,2)==null});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2 -2 true true',
    uncaughtException: undefined,
  });
});

test.each(['push(init.gpa,1)', 'pop()'])('priority queue %s rejects const value and pointer receivers', (operation) => {
  for (const receiver of ['q', 'p']) {
    const source = `const std=@import("std");fn cmp(_:void,a:u8,b:u8)std.math.Order{return std.math.order(a,b);}pub fn main(init:std.process.Init)!void{${operation === 'pop()' ? '_=init;' : ''}const q:std.PriorityQueue(u8,void,cmp)=.empty;${receiver === 'p' ? 'const p=&q;' : ''}${operation === 'pop()' ? '_=' : 'try '}${receiver}.${operation};}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test('priority queue readonly queries accept constant values and pointers', () => {
  const source = `const std=@import("std");fn cmp(_:void,a:u8,b:u8)std.math.Order{return std.math.order(a,b);}pub fn main()void{const q:std.PriorityQueue(u8,void,cmp)=.empty;const p=&q;std.debug.print("{} {} {}",.{q.count(),p.capacity(),p.peek()==null});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0 0 true',
    uncaughtException: undefined,
  });
});

test.each(['u8', '*P'])('custom format rejects an incompatible receiver type %s', (self) => {
  const source = `const std=@import("std");const P=struct{pub fn format(self:${self},w:*std.Io.Writer)void{_=self;_=w;}};pub fn main()void{std.debug.print("{f}",.{P{}});}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test('custom format permits a const pointer receiver', () => {
  const source = `const std=@import("std");const P=struct{x:u8,pub fn format(self:*const P,w:*std.Io.Writer)std.Io.Writer.Error!void{try w.print("{}",.{self.x});}};pub fn main()void{std.debug.print("{f}",.{P{.x=3}});}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: '3', uncaughtException: undefined });
});

test('priority queue comparator requires the declared context, element and Order types', () => {
  for (const compare of [
    'fn cmp(_:void,a:u8,b:u8)bool{return a<b;}',
    'fn cmp(_:void,a:u16,b:u16)std.math.Order{return std.math.order(a,b);}',
  ]) {
    const source = `const std=@import("std");${compare}pub fn main()void{const q:std.PriorityQueue(u8,void,cmp)=.empty;_=q;}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
});

test.each(['std.mem.sort', 'std.sort.block', 'std.sort.isSorted'])(
  '%s requires a function value rather than a function pointer',
  (method) => {
    const source = `const std=@import("std");fn less(_:void,a:i32,b:i32)bool{return a<b;}pub fn main()void{var a=[_]i32{3,2,1};${method.endsWith('isSorted') ? '_=' : ''}${method}(i32,&a,{},&less);}`;
    expect(executeProgram('zig', source).kind).toBe('compileError');
  }
);

test('custom formatting requires a public format method', () => {
  const source = `const std=@import("std");const P=struct{fn format(_:P,w:*std.Io.Writer)std.Io.Writer.Error!void{try w.writeAll("x");}};pub fn main()void{std.debug.print("{f}",.{P{}});}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test.each([
  'const n=if(get()) |_| @as(u8,3) else |_| unreachable;',
  'const n:u16=if(get()) |_| @as(u8,3) else |_| unreachable;',
  'const n=(if(get()) |_| @as(u8,2) else |_| unreachable)+1;',
  'const n=@as(u16,if(get()) |_| @as(u8,3) else |_| unreachable);',
])('constant result facts remain available after required effects: %s', (declaration) => {
  const source = `const std=@import("std");fn get()error{}!u8{std.debug.print("call|",.{});return 1;}pub fn main()void{${declaration}const a:[n]u8=@splat(7);std.debug.print("{any}",.{a});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'call|{ 7, 7, 7 }',
    uncaughtException: undefined,
  });
});

test.each([
  ['3.5', '3'],
  ['-3.5', '-3'],
  ['-0.0', '0'],
])('intFromFloat converts %s to an exact comptime integer', (value, output) => {
  const source = `const std=@import("std");pub fn main()void{const x=@as(comptime_int,@intFromFloat(${value}));std.debug.print("{}",.{x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: output,
    uncaughtException: undefined,
  });
});

test.each(['std.math.inf(f64)', 'std.math.nan(f64)'])(
  'intFromFloat rejects nonfinite comptime integer input %s',
  (value) => {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{const x=@as(comptime_int,@intFromFloat(${value}));std.debug.print("{}",.{x});}`
      ).kind
    ).toBe('compileError');
  }
);

test('truncate distinguishes unbounded comptime integers from fixed-width wrapping', () => {
  const source = `const std=@import("std");pub fn main()void{const a:comptime_int=@truncate(400);const b:comptime_int=@truncate(-7);const c:u8=@truncate(300);std.debug.print("{} {} {}",.{a,b,c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '400 -7 44',
    uncaughtException: undefined,
  });
});

test('floatCast preserves exact source values when targeting comptime_float', () => {
  const source = `const std=@import("std");pub fn main()void{const a:comptime_float=@floatCast(@as(f16,0.1));const b:comptime_float=@floatCast(@as(f64,1.5));const c:comptime_float=@floatCast(3.5);std.debug.print("{d} {d} {d}",.{a,b,c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0.0999755859375 1.5 3.5',
    uncaughtException: undefined,
  });
});

test.each([
  ['u8', '3', 'comptime_int', '@truncate'],
  ['u8', '3', 'comptime_float', '@floatFromInt'],
  ['f64', '3.5', 'comptime_float', '@floatCast'],
  ['f64', '3.5', 'comptime_int', '@intFromFloat'],
])('%s runtime values cannot supply %s casts to %s', (sourceType, value, target, builtin) => {
  const source = `const std=@import("std");pub fn main()void{var v:${sourceType}=${value};_=&v;const x:${target}=${builtin}(v);std.debug.print("{any}",.{x});}`;
  expect(executeProgram('zig', source).kind).toBe('compileError');
});

test('list constructors preserve exact lengths of zero-sized virtual capacity views', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const b=std.ArrayList(void).initBuffer(a.allocatedSlice());const c=std.ArrayList(void).fromOwnedSlice(a.unusedCapacitySlice());std.debug.print("{} {} {}",.{b.capacity,c.capacity,c.items.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615 18446744073709551614 18446744073709551614',
    uncaughtException: undefined,
  });
});

test.each([
  '',
  String.raw`\x7f\xbf`,
  String.raw`\x1f\x80\x80`,
  String.raw`\x7f\x80\x80\x80`,
  String.raw`\xf0\x90\x80\x80a`,
])('unicode decode panics on invalid sequence shape %s', (bytes) => {
  const source = `const std=@import("std");pub fn main()void{const c=std.unicode.utf8Decode("${bytes}") catch 0;std.debug.print("{}",.{c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '',
    uncaughtException: expect.stringContaining('reached unreachable code'),
  });
});

test('unicode decode retains valid sequences and recoverable encoding errors', () => {
  const source = String.raw`const std=@import("std");pub fn main()void{std.debug.print("{}|",.{std.unicode.utf8Decode("\xc2\x80") catch 0});_=std.unicode.utf8Decode("\xc2x") catch |err|{std.debug.print("{s}|",.{@errorName(err)});};_=std.unicode.utf8Decode("\xc0\x80") catch |err|{std.debug.print("{s}",.{@errorName(err)});};}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '128|Utf8ExpectedContinuation|Utf8OverlongEncoding',
    uncaughtException: undefined,
  });
});

test('width formatting does not add a positive sign to unbounded integer magnitudes', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("[{d:5}] [{d:5}] [{d:5}] [{d:5}] [{d:5}]",.{3,-3,18446744073709551616,123456789012345678901234567890,@as(i64,3)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '[    3] [   -3] [18446744073709551616] [123456789012345678901234567890] [   +3]',
    uncaughtException: undefined,
  });
});

test.each(['next', 'peek', 'rest'])(
  'tokenizeSequence %s avoids repeated oversized delimiter copies and meters scanning',
  (method) => {
    const source = `const std=@import("std");pub fn main()void{var it=std.mem.tokenizeSequence(u8,"${'a'.repeat(100_000)}","${'b'.repeat(100_001)}");const token=it.${method}();std.debug.print("{}",.{${method === 'rest' ? 'token.len' : 'token.?.len'}});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '100000',
      uncaughtException: undefined,
    });
  }
);

test.each([
  ['i8', '-128', '128'],
  ['i64', '-9223372036854775808', '9223372036854775808'],
])('constant %s division overflow reports the mathematical result', (type, value, result) => {
  const source = `pub fn main()void{const x=@as(${type},${value})/(-1);_=x;}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining(result) }],
  });
});

test('constant results select control-flow branches without erasing condition effects', () => {
  const source = `const std=@import("std");fn get()error{}!u8{std.debug.print("c",.{});return 1;}pub fn main()void{if((if(get()) |_| @as(u8,3) else |_| unreachable)==3){std.debug.print("i",.{});}else{const bad:u8=300;_=bad;}switch(if(get()) |_| @as(u8,3) else |_| unreachable){3=>std.debug.print("s",.{}),else=>{const bad:u8=300;_=bad;}}while((if(get()) |_| @as(u8,3) else |_| unreachable)==4){const bad:u8=300;_=bad;}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'cicsc',
    uncaughtException: undefined,
  });
});

test('indexed struct initialization preserves source order and defaults', () => {
  const source = `const std=@import("std");const S=struct{a:u8=9,b:u8,c:u8=7};pub fn main()void{var s:S=.{.b=2};s=.{.b=s.a,.a=4};const w:S=.{.b=3,.a=8,.c=6};std.debug.print("{} {} {}|{} {} {}",.{s.a,s.b,s.c,w.a,w.b,w.c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '4 9 7|8 3 6',
    uncaughtException: undefined,
  });
});

test.each(['typed', 'store'])('large %s struct matching uses indexed field positions', (mode) => {
  const n = 3000;
  const fields = Array.from({ length: n }, (_, index) => `f${index}:u8`).join(',');
  const values = Array.from({ length: n }, (_, index) => `.f${n - 1 - index}=@as(u8,${index % 251})`).join(',');
  const statement = mode === 'typed' ? `const x=S{${values}};` : `var x:S=undefined;x=.{${values}};`;
  const source = `const std=@import("std");const S=struct{${fields}};pub fn main()void{${statement}std.debug.print("{} {}",.{x.f0,x.f${n - 1}});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: `${(n - 1) % 251} 0`,
    uncaughtException: undefined,
  });
});

test('union switch captures use declared tag values rather than field positions', () => {
  const source = `const std=@import("std");const Tag=enum(u16){a=19,b=401,c=67};const U=union(Tag){a:u8,b:i16,c:u8};pub fn main()void{var u:U=.{.b=9};_=&u;switch(u){.a,.c=>|x|std.debug.print("{}",.{x}),.b=>|x|std.debug.print("{}:{}|",.{@TypeOf(x),x})}switch(u){inline else=>|x,tag|std.debug.print("{}:{s}",.{@TypeOf(x),@tagName(tag)})}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'i16:9|i16:b',
    uncaughtException: undefined,
  });
});

test.each(['eql', 'replaceScalar'])('native %s scans charge every visited element', (method) => {
  const setup = method === 'eql' ? 'var b:[300000]u8=@splat(7);_=&b;' : '';
  const operation = method === 'eql' ? '_=std.mem.eql(u8,&a,&b);' : 'std.mem.replaceScalar(u8,&a,7,8);';
  const source = `const std=@import("std");pub fn main()void{var a:[300000]u8=@splat(7);_=&a;${setup}for(0..4) |_|{${operation}}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('memory equality retains the reference self-address shortcut except for floats', () => {
  const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(7);for(0..4) |_|{_=std.mem.eql(u8,&a,&a);}var f=[_]f64{std.math.nan(f64)};_=&f;std.debug.print("{}",.{std.mem.eql(f64,&f,&f)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false',
    uncaughtException: undefined,
  });
});

test.each(['1.' + '0'.repeat(10_001), '1' + '0'.repeat(10_001) + 'e-10001', '0.' + '0'.repeat(10_001) + '1e10002'])(
  'long decimal spellings retain their full magnitude (%#)',
  (spelling) => {
    const source = `const std=@import("std");pub fn main()void{std.debug.print("{d} {d}",.{@as(f128,${spelling}),std.fmt.parseFloat(f128,"${spelling}") catch 0});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '1 1',
      uncaughtException: undefined,
    });
  }
);

test('identifier byte identities survive lookup, tag names, fields, and formatting', () => {
  const source = String.raw`const std=@import("std");const E=enum{@"\xff",@"\u{fffd}",@"\xef\xbb\xbf",@"a\xffb"};const U=union(E){@"\xff":u8,@"\u{fffd}":u8,@"\xef\xbb\xbf":u8,@"a\xffb":u8};pub fn main()void{const a=std.meta.stringToEnum(E,"\xff").?;const b=std.meta.stringToEnum(E,"\u{fffd}").?;const u=@unionInit(U,"\xff",7);std.debug.print("{} {} {} {} {} {}",.{a!=b,std.mem.eql(u8,@tagName(a),"\xff"),std.mem.eql(u8,std.enums.tagName(E,a).?,"\xff"),std.meta.stringToEnum(E,"\xfe")==null,u.@"\xff",std.meta.stringToEnum(E,"a\xffb").?==E.@"a\xffb"});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true true true true 7 true',
    uncaughtException: undefined,
  });
});

test.each(['0xFE-1', '0xAE+1', '0x1E-2', '0xe-1', '0xBE+0xE'])(
  'hexadecimal e cannot be followed immediately by a sign: %s',
  (value) => {
    expect(executeProgram('zig', `pub fn main()void{const x=${value};_=x;}`)).toMatchObject({ kind: 'compileError' });
  }
);

test('hexadecimal signs retain ordinary spaced and decimal-exponent expressions', () => {
  expect(
    executeProgram(
      'zig',
      'const std=@import("std");pub fn main()void{std.debug.print("{} {} {}",.{0xFE - 1,0x1e5+1,1e-3});}'
    )
  ).toMatchObject({ kind: 'executed', stderr: '253 486 0.001', uncaughtException: undefined });
});

test.each([
  ['shift', '(if(get()) |_| @as(u8,3) else |_| unreachable) << 1', 6],
  ['logical', 'if((if(get()) |_| true else |_| unreachable) and true) @as(u8,3) else @as(u8,4)', 3],
  ['switch', 'switch(if(get()) |_| @as(u8,3) else |_| unreachable){3=>@as(u8,3),else=>@as(u8,4)}', 3],
  ['unwrap', '(if(get()) |_| @as(?u8,3) else |_| unreachable).?', 3],
  ['orelse', '(if(get()) |_| @as(?u8,3) else |_| unreachable) orelse 4', 3],
  ['field', '(if(get()) |_| S{.x=3} else |_| unreachable).x', 3],
  ['index', '(if(get()) |_| [_]u8{3} else |_| unreachable)[0]', 3],
])('effectful constant results survive %s composition', (_name, expression, length) => {
  const source = `const std=@import("std");const S=struct{x:u8};fn get()error{}!u8{std.debug.print("call|",.{});return 1;}pub fn main()void{const n=${expression};const a:[n]u8=@splat(7);std.debug.print("{}",.{a.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: `call|${length}`,
    uncaughtException: undefined,
  });
});

test.each(['error{}', 'error{E}'])(
  'a single returning branch retains its constant result through %s conditions',
  (errors) => {
    const source = `const std=@import("std");fn get()${errors}!u8{std.debug.print("c",.{});return 1;}pub fn main()void{const n=if(get()) |_| @as(u8,3) else |_| unreachable;const a:[n]u8=@splat(7);const d:comptime_int=@truncate(n);std.debug.print("{} {}",.{a.len,d});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'c3 3',
      uncaughtException: undefined,
    });
  }
);

test('constant branch facts preserve short-circuit effects', () => {
  const source = `const std=@import("std");fn get()error{E}!u8{std.debug.print("c",.{});return 1;}fn yes()bool{std.debug.print("y",.{});return true;}pub fn main()void{const n=if(get()) |_| @as(u8,3) else |_| unreachable;const a:[n]u8=@splat(7);const b=(if(get()) |_| false else |_| unreachable) and yes();const c=(if(get()) |_| true else |_| unreachable) or yes();std.debug.print("{} {} {}",.{a.len,b,c});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'ccc3 false true',
    uncaughtException: undefined,
  });
});

test.each(['const u:T=t;_=u;', 'f(t);', 'const u=g();_=u;'])(
  'stored anonymous structs do not coerce to named structs: %s',
  (statement) => {
    const source = `const T=struct{a:i32,b:f32};fn f(t:T)void{_=t;}fn g()T{const t=.{.a=1,.b=2};return t;}pub fn main()void{const t=.{.a=@as(i32,1),.b=@as(f32,2)};_=t;${statement}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
  }
);

test('struct literals retain result locations while stored tuples coerce to arrays', () => {
  const source = `const std=@import("std");const T=struct{a:i32,b:f32};fn f(t:T)void{std.debug.print("{} {d}|",.{t.a,t.b});}pub fn main()void{f(.{.a=1,.b=2});const tuple=.{@as(u8,3),@as(u8,4)};const array:[2]u8=tuple;std.debug.print("{any}",.{array});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 2|{ 3, 4 }',
    uncaughtException: undefined,
  });
});

test('known floats coerce exactly to narrower floats and integral destinations', () => {
  const source = `const std=@import("std");const k:f64=0.25;fn f(x:f32)f32{return x;}pub fn main()void{const a:f64=0.5;const b:f32=a;const c:f64=3;const d:i32=c;var x:f16=k;x+=1;std.debug.print("{d} {d} {} {d} {d}",.{b,f(a),d,x,@as(f32,@as(f128,0.125))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '0.5 0.5 3 1.25 0.125',
    uncaughtException: undefined,
  });
});

test.each([
  ['f64', '0.1', 'f32'],
  ['f64', '2.5', 'i32'],
  ['f64', '3e10', 'i32'],
  ['f64', '65520', 'f16'],
  ['f64', '1e300', 'f32'],
])('known %s value %s cannot coerce inexactly to %s', (from, value, to) => {
  expect(executeProgram('zig', `pub fn main()void{const a:${from}=${value};const b:${to}=a;_=b;}`)).toMatchObject({
    kind: 'compileError',
  });
});

test.each(['if(get()) @as(u8,3) else @as(u8,3)', 'switch(get()){true=>@as(u8,3),false=>@as(u8,3)}'])(
  'equal runtime branches do not acquire a compile-time result: %s',
  (expression) => {
    const source = `fn get()bool{return true;}pub fn main()void{const n=${expression};const a:[n]u8=@splat(7);_=a;}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
  }
);

test.each(['allocatedSlice', 'unusedCapacitySlice'])(
  'virtual %s lengths survive fixed-buffer storage and meta equality',
  (method) => {
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});var bytes:[128]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create([]void);const view=a.${method}();p.*=view;std.debug.print("{} {} {} {}",.{view.len,p.*.len,std.meta.eql(view,p.*),std.meta.eql(a.allocatedSlice(),a.unusedCapacitySlice())});}`;
    const length = method === 'allocatedSlice' ? '18446744073709551615' : '18446744073709551614';
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: `${length} ${length} true false`,
      uncaughtException: undefined,
    });
  }
);

test.each([
  'std.math.cbrt(8.0)',
  'std.math.atan2(1.0,2.0)',
  'std.math.isFinite(1.0)',
  'std.math.copysign(1.0,-2.0)',
  'std.math.ldexp(1.0,3)',
  'std.math.cbrt(@as(f16,8))',
  'std.math.hypot(3,4)',
])('math operand domains reject unsupported calls: %s', (call) => {
  expect(executeProgram('zig', `const std=@import("std");pub fn main()void{const x=${call};_=x;}`)).toMatchObject({
    kind: 'compileError',
  });
});

test('a destination float type does not specialize an anytype math argument', () => {
  expect(
    executeProgram('zig', 'const std=@import("std");pub fn main()void{const x:f64=std.math.cbrt(8.0);_=x;}')
  ).toMatchObject({ kind: 'compileError' });
});

test('math domains retain explicit float widths, comptime hypot, and numeric predicates', () => {
  const source = `const std=@import("std");pub fn main()void{var i:i64=-7;_=&i;std.debug.print("{d} {d} {d} {} {} {} {d}",.{std.math.cbrt(@as(f32,8)),std.math.hypot(3.0,4.0),std.math.asin(@as(f80,0)),std.math.isFinite(@as(f16,1)),std.math.signbit(i),std.math.isNan(i),std.math.copysign(@as(f16,1),-1)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2 5 0 true true false -1',
    uncaughtException: undefined,
  });
});

test.each([
  ['unbounded value', '(if(get()) |_| 3 else |_| unreachable)<<1', 6],
  ['unbounded amount', '1<<(if(get()) |_| 2 else |_| unreachable)', 4],
  ['union payload', '(if(get()) |_| U{.x=3} else |_| unreachable).x', 3],
  ['constant pointer', '(if(get()) |_| &value else |_| unreachable).*', 3],
  ['readonly slice', '(if(get()) |_| @as([]const u8,&[_]u8{3}) else |_| unreachable)[0]', 3],
  ['slice view', '((if(get()) |_| [_]u8{3,4} else |_| unreachable)[0..1])[0]', 3],
  ['concatenation', '((if(get()) |_| [_]u8{3} else |_| unreachable) ++ [_]u8{4})[0]', 3],
  ['signed division', '(if(get()) |_| @as(i32,6) else |_| unreachable) / 2', 3],
  ['temporary address', '(&(if(get()) |_| @as(u8,3) else |_| unreachable)).*', 3],
])('effectful facts survive %s without running effects at compilation', (_name, expression, length) => {
  const source = `const std=@import("std");const value:u8=3;const U=union(enum){x:u8,y:void};fn get()error{}!u8{std.debug.print("call|",.{});return 1;}pub fn main()void{const n=${expression};const a:[n]u8=@splat(7);std.debug.print("{}",.{a.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: `call|${length}`,
    uncaughtException: undefined,
  });
});

test.each([
  '(if(get()) |_| @as(*const u8,&value) else |_| unreachable).*',
  '(if(get()) |_| @as([]const u8,&values) else |_| unreachable)[0]',
])('readonly views of mutable backing do not acquire load facts: %s', (expression) => {
  const source = `const std=@import("std");var value:u8=3;var values=[_]u8{3};fn get()error{}!u8{std.debug.print("call|",.{});value=9;values[0]=9;return 1;}pub fn main()void{const n=${expression};std.debug.print("{}",.{n});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'call|9',
    uncaughtException: undefined,
  });
  const requiringFact = source.replace('std.debug.print("{}",.{n});', 'const a:[n]u8=@splat(7);_=a;');
  expect(executeProgram('zig', requiringFact)).toMatchObject({ kind: 'compileError' });
});

test.each([
  ['void', '{}'],
  ['struct{}', '.{ }'],
  ['u0', '0'],
])('virtual lists of %s retain exact lengths through removal and shrinking', (type, value) => {
  const source = `const std=@import("std");const T=${type};const M=std.math.maxInt(usize);pub fn main(init:std.process.Init)!void{var a:std.ArrayList(T)=.empty;try a.append(init.gpa,${value});var b=std.ArrayList(T).fromOwnedSlice(a.unusedCapacitySlice());_=b.pop();_=b.swapRemove(0);_=b.orderedRemove(M-4);b.orderedRemoveMany(&[_]usize{0,0,1});std.debug.print("{}|",.{b.items.len});b.shrinkRetainingCapacity(M-10);b.shrinkAndFree(init.gpa,M-11);std.debug.print("{} {}",.{b.items.len,b.capacity});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551609|18446744073709551604 18446744073709551614',
    uncaughtException: undefined,
  });
});

test('virtual list growth preserves usize overflow and bounded append behavior', () => {
  const source = `const std=@import("std");const M=std.math.maxInt(usize);pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});var b=std.ArrayList(void).fromOwnedSlice(a.unusedCapacitySlice());_=b.pop();try b.appendNTimes(init.gpa,{},1);try b.insertSlice(init.gpa,1,a.items);b.appendNTimes(init.gpa,{},2) catch |e| std.debug.print("{s}|",.{@errorName(e)});b.ensureUnusedCapacity(init.gpa,1) catch |e| std.debug.print("{s}|",.{@errorName(e)});try b.resize(init.gpa,M-4);const s=try b.addManyAsSlice(init.gpa,2);try b.appendBounded({});std.debug.print("{} {} {}",.{b.items.len,b.capacity,s.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'OutOfMemory|OutOfMemory|18446744073709551614 18446744073709551615 2',
    uncaughtException: undefined,
  });
});

test('virtual list replacement, cloning, and ownership transfer preserve metadata', () => {
  const source = `const std=@import("std");const M=std.math.maxInt(usize);pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});var b=std.ArrayList(void).fromOwnedSlice(a.unusedCapacitySlice());try b.replaceRange(init.gpa,0,M-2,a.items);std.debug.print("{}|",.{b.items.len});b.expandToCapacity();var c=try b.clone(init.gpa);const owned=try c.toOwnedSlice(init.gpa);std.debug.print("{} {} {} {}",.{b.items.len,owned.len,c.items.len,c.capacity});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2|18446744073709551614 18446744073709551614 0 0',
    uncaughtException: undefined,
  });
});

test('formatting a virtual zero-sized list obeys the output budget', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var l:std.ArrayList(void)=.empty;try l.appendNTimes(init.gpa,{},1000000000);std.debug.print("{any}",.{l.items});}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
});

test.each(['parseInt', 'parseUnsigned'])('native %s digit visits share the work budget', (method) => {
  const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(48);for(0..4)|_|{_=std.fmt.${method}(u8,&a,10) catch 0;}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('integer parsing rejects early without copying an unvisited suffix', () => {
  const source = `const std=@import("std");pub fn main()void{var a:[300000]u8=@splat(48);a[0]=33;for(0..4)|_|{_=std.fmt.parseInt(u8,&a,10) catch 0;}std.debug.print("ok",.{});}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: 'ok', uncaughtException: undefined });
});

test.each(['upperString', 'lowerString'])('native ASCII %s visits share the work budget', (method) => {
  const source = `const std=@import("std");pub fn main()void{var a:[300000]u8=@splat(97);for(0..4)|_|{_=std.ascii.${method}(&a,&a);}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('parseUnsigned supports signed targets while retaining range and sign errors', () => {
  const source = `const std=@import("std");pub fn main()!void{std.debug.print("{} {}|",.{try std.fmt.parseUnsigned(i32,"42",10),try std.fmt.parseUnsigned(i8,"7_f",16)});for([_] []const u8{"128","+1","-1"})|text|{_=std.fmt.parseUnsigned(i8,text,10) catch |e|{std.debug.print("{s}|",.{@errorName(e)});continue;};}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '42 127|Overflow|InvalidCharacter|InvalidCharacter|',
    uncaughtException: undefined,
  });
});

test('digitToChar accepts a runtime case and panics outside the digit range', () => {
  const source = `const std=@import("std");pub fn main()void{var c:std.fmt.Case=.lower;std.debug.print("{c}",.{std.fmt.digitToChar(10,c)});c=.upper;std.debug.print("{c}",.{std.fmt.digitToChar(35,c)});var n:u8=36;_=&n;_=std.fmt.digitToChar(n,c);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'aZ',
    uncaughtException: 'panic: reached unreachable code',
  });
});

test('Writer.buffered rejects extra arguments', () => {
  const source = `const std=@import("std");pub fn main()void{var b:[8]u8=undefined;const w=std.Io.Writer.fixed(&b);_=w.buffered(1);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
});

test.each(['splatByteAll(65,200)', 'splatBytesAll("ab",100)'])(
  'allocating Writer.%s grows and retains prefixes on allocation failure',
  (operation) => {
    const declaration = `const std=@import("std");const P=struct{pub fn format(_:P,w:*std.Io.Writer)std.Io.Writer.Error!void{try w.writeByte(120);try w.${operation};}};`;
    const success = `${declaration}pub fn main(init:std.process.Init)!void{const g=init.gpa;var l:std.ArrayList(u8)=.empty;defer l.deinit(g);try l.print(g,"{f}",.{P{}});std.debug.print("ok {} {}",.{l.items.len,l.capacity});}`;
    expect(executeProgram('zig', success)).toMatchObject({
      kind: 'executed',
      stderr: 'ok 201 431',
      uncaughtException: undefined,
    });
    const failure = `${declaration}pub fn main()!void{var bytes:[200]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const g=f.allocator();var l:std.ArrayList(u8)=.empty;defer l.deinit(g);l.print(g,"{f}",.{P{}}) catch |e|{std.debug.print("{s}|{} {} {s}",.{@errorName(e),l.items.len,l.capacity,l.items});return;};}`;
    expect(executeProgram('zig', failure)).toMatchObject({
      kind: 'executed',
      stderr: 'OutOfMemory|1 132 x',
      uncaughtException: undefined,
    });
  }
);

test.each([
  'const value:u8=3;const n=(&(if(get()) |_| value else |_| unreachable)).*;',
  'const values=[_]u8{3,4};const n=(if(get()) |_| values else |_| unreachable)[0..1][0];',
])('address and slice composition retain effects around named constants: %s', (statement) => {
  const source = `const std=@import("std");fn get()error{}!u8{std.debug.print("c",.{});return 1;}pub fn main()void{${statement}std.debug.print("{}",.{n});}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: 'c3', uncaughtException: undefined });
});

test.each([
  '0x1' + '0'.repeat(250_001),
  '0o1' + '0'.repeat(333_334),
  '1' + '0'.repeat(301_030),
  '0b1' + '0'.repeat(1_000_004),
])('oversized integer literal storage is bounded before conversion (%#)', (literal) => {
  expect(executeProgram('zig', `pub fn main()void{const x=${literal};_=x;}`)).toMatchObject({ kind: 'limitExceeded' });
});

test('integer magnitude checks retain boundary values and insignificant leading zeros', () => {
  const boundary = '0x8' + '0'.repeat(249_999);
  expect(executeProgram('zig', `pub fn main()void{const x=${boundary};_=x;}`)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{std.debug.print("{}",.{0x${'0'.repeat(10_000)}1});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: '1', uncaughtException: undefined });
});

test.each([
  '[_]u8{1} ++ [_]comptime_int{300}',
  '[_]comptime_int{300} ++ [_]u8{1}',
  '[_]u8{1} ++ [_]comptime_int{2}',
  '[_]comptime_int{2} ++ [_]u8{1}',
])('concatenation requires matching element types: %s', (expression) => {
  expect(executeProgram('zig', `pub fn main()void{const x=${expression};_=x;}`)).toMatchObject({
    kind: 'compileError',
  });
});

test('quoted field names and constant values have unambiguous structural identities', () => {
  const source = String.raw`const std=@import("std");pub fn main()void{const a=.{.@"a:1,b"=@as(u8,1)};const b=.{.a=@as(u8,2),.b=@as(u8,3)};const c=.{.@"x=ErrorValue.a,b"=error.@"a,b"};const d=.{.x=error.a,.b=error.b};std.debug.print("{} {} {s} {s}",.{a.@"a:1,b",b.b,@errorName(c.@"x=ErrorValue.a,b"),@errorName(d.b)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 3 a,b b',
    uncaughtException: undefined,
  });
});

test.each(['@memset', '@memcpy', '@memmove'])('%s meters actual nonzero-element work', (method) => {
  const setup = method === '@memset' ? '' : 'var b:[300000]u8=@splat(1);_=&b;';
  const second = method === '@memset' ? '0' : '&b';
  const source = `pub fn main()void{var a:[300000]u8=@splat(0);${setup}for(0..4)|_|{${method}(&a,${second});}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('zero-sized memory builtins evaluate operands without materializing or scanning storage', () => {
  const source = `const std=@import("std");fn value()void{std.debug.print("v",.{});}fn view(items:[]void)[]void{std.debug.print("s",.{});return items;}pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.appendNTimes(init.gpa,{},1000000000);@memset(view(a.items),value());@memcpy(view(a.items),view(a.items));@memmove(view(a.items),view(a.items));std.debug.print("{}",.{a.items.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'svssss1000000000',
    uncaughtException: undefined,
  });
});

test.each(['@memcpy', '@memmove'])('%s checks exact virtual lengths before zero-sized elision', (method) => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});${method}(a.allocatedSlice(),a.unusedCapacitySlice());}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'panic: source and destination arguments have non-equal lengths',
  });
});

test('tuple type names render typed scalar constants rather than host objects', () => {
  const source = `const std=@import("std");pub fn main()void{const t=.{1.5,error.Bad,@as(f128,1.5),true,null,@as(?u8,3),@as(?u8,null),@as(u8,9),u8,{},undefined};std.debug.print("{}",.{@TypeOf(t)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr:
      'struct { comptime comptime_float = 1.5, comptime error{Bad} = error.Bad, comptime f128 = 1.5, comptime bool = true, comptime @TypeOf(null) = null, comptime ?u8 = 3, comptime ?u8 = null, comptime u8 = 9, comptime type = u8, comptime void = {}, comptime @TypeOf(undefined) = undefined }',
    uncaughtException: undefined,
  });
});

test('tuple type names render byte strings, arrays, slices, and quoted identifiers', () => {
  const source = String.raw`const std=@import("std");pub fn main()void{const t=.{"日本",[_]u8{1,2},[_]u16{1,2},@as([]const u8,"ab"),error.@"a,b"};std.debug.print("{}",.{@TypeOf(t)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: String.raw`struct { comptime *const [6:0]u8 = "日本", comptime [2]u8 = "\x01\x02".*, comptime [2]u16 = .{ 1, 2 }, comptime []const u8 = "ab"[0..2], comptime error{a,b} = error.a,b }`,
    uncaughtException: undefined,
  });
});

test('tuple type identity includes structured constant values and undefined presence', () => {
  const source = `const std=@import("std");pub fn main()void{const a=.{[_]u8{1,2},undefined};const b=.{[_]u8{1,2},undefined};const c=.{[_]u8{1,3},undefined};std.debug.print("{} {}",.{@TypeOf(a)==@TypeOf(b),@TypeOf(a)==@TypeOf(c)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false',
    uncaughtException: undefined,
  });
});

test('source identifiers can name prototype-like locals and methods', () => {
  const source = `const std=@import("std");
const S=struct{x:i32,fn toString(self:S)i32{return self.x;}};
pub fn main()void{const constructor:i32=5;const valueOf:i32=7;const __proto__:i32=9;const s=S{.x=3};std.debug.print("{} {} {} {}",.{s.toString(),constructor,valueOf,__proto__});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '3 5 7 9',
    uncaughtException: undefined,
  });
});

test.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty'])(
  'prototype-like names require declarations and valid format specifiers: %s',
  (name) => {
    for (const body of [`const x=${name};_=x;`, `const x:${name}=1;_=x;`, `std.debug.print("{${name}}",.{1});`]) {
      expect(executeProgram('zig', `const std=@import("std");pub fn main()void{${body}}`)).toMatchObject({
        kind: 'compileError',
      });
    }
  }
);

test.each([
  'var q:*i32=undefined;_=&q;q.*+=1;',
  'var p:?*i32=undefined;_=&p;std.debug.print("{}",.{p.?.*});',
  'var a:[3]*i32=undefined;_=&a;_=a[1].*;',
  'var s:[]i32=undefined;_=&s;s[0]=1;',
  'var f:*const fn()void=undefined;_=&f;f();',
  'var f:*const fn()void=undefined;_=&f;f.*();',
  'var p:*struct{x:i32}=undefined;_=&p;p.x=2;',
])('undefined runtime memory faults without running defers: %s', (body) => {
  const source = `const std=@import("std");pub fn main()void{defer std.debug.print("deferred",.{});${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '',
    uncaughtException: 'Segmentation fault',
  });
});

test('undefined memory cannot transfer writes between executions', () => {
  for (const body of ['_=q.*;', 'q.*=3;', '_=q.*;']) {
    expect(executeProgram('zig', `pub fn main()void{var q:*i32=undefined;_=&q;${body}}`)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'Segmentation fault',
    });
  }
  expect(executeProgram('zig', 'pub fn main()void{var n:i32=1;const p=&n;p.*+=1;}')).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test.each([
  'const p:*const i32=undefined;_=p.*;',
  'const s:[]void=undefined;_=s[0];',
  'const f:*const fn()void=undefined;f();',
  'const p:*[0]u8=undefined;@memcpy(p,p);',
])('known undefined memory use is a compile error: %s', (body) => {
  expect(executeProgram('zig', `pub fn main()void{${body}}`)).toMatchObject({ kind: 'compileError' });
});

test('undefined pointers retain metadata and permit operations with no memory access', () => {
  const source = `const std=@import("std");pub fn main()void{
const p:*void=undefined;_=p.*;p.*={};
const a:*[2]void=undefined;_=a[0];
var b:*[2]u8=undefined;_=&b;const view=b[0..];
var s:[]u8=undefined;_=&s;
const z:[]void=undefined;@memset(z,{});
var empty:*[0]u8=undefined;_=&empty;@memcpy(empty,empty);
std.debug.print("{} {} {}",.{view.len,s.len,empty[0..].len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2 12297829382473034410 0',
    uncaughtException: undefined,
  });
});

test.each(['log2', 'log10'])('large comptime integer %s is bounded without repeated division', (name) => {
  const source = `const std=@import("std");pub fn main()void{const n=std.math.${name}(0x${'f'.repeat(250_000)});_=n;}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  'std.mem.findDiff(u8,&a,&a)',
  'std.mem.indexOfDiff(u8,&a,&a)',
  'std.mem.findMinMax(u8,&a)',
  'std.mem.indexOfMinMax(u8,&a)',
  'try std.unicode.utf8CountCodepoints(&a)',
  'std.unicode.utf8ValidateSlice(&a)',
  'try std.unicode.Utf8View.init(&a)',
])('native scans share the operation budget: %s', (call) => {
  const source = `const std=@import("std");pub fn main()!void{const a:[300000]u8=@splat('a');for(0..4)|_|{_=${call};}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('random byte generation and stores share the operation budget', () => {
  const source = `const std=@import("std");pub fn main()void{var a:[300000]u8=undefined;var p=std.Random.DefaultPrng.init(1);for(0..4)|_|{p.random().bytes(&a);}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each(['order(true,false)', 'compare(true,.eq,false)', 'order(.a,.b)', 'compare("a",.lt,"b")'])(
  'native mathematical comparisons reject nonnumeric operands: %s',
  (call) => {
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.math.${call};}`)).toMatchObject({
      kind: 'compileError',
    });
  }
);

test('mathematical comparisons preserve mixed integer values and floating peer coercions', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{} {} {} {}",.{std.math.order(@as(i8,-1),@as(u8,255)),std.math.compare(@as(u8,255),.gt,@as(i8,-1)),std.math.order(1,@as(f32,1.5)),std.math.compare(@as(f64,2),.eq,2)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '.lt true .lt true',
    uncaughtException: undefined,
  });
});

test.each([
  ['enum(i8){minus=-1,plus=1}', 'E', '.minus', 'p.*', '.minus true'],
  ['enum(i16){minus=-257,plus=1}', 'struct{value:E}', '.{.value=.minus}', 'p.value', '.minus true'],
])('fixed-buffer enum tags retain their signed backing values: %s', (definition, type, value, access, expected) => {
  const source = `const std=@import("std");const E=${definition};pub fn main()!void{var bytes:[64]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(${type});p.*=${value};std.debug.print("{} {}",.{${access},${access}==E.minus});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test.each([
  ['enum(u2){a,b,c,d}', 'packed struct{mode:E,count:u6}', '.{.mode=.b,.count=5}', 'p.mode', '1 .b 5 21'],
  [
    'enum(u2){a,b,c,d}',
    'packed struct{inner:packed struct{a:u3},count:u5}',
    '.{.inner=.{.a=1},.count=5}',
    'p.inner.a',
    '1 1 5 41',
  ],
])('packed fields use exact recursive bit offsets: %s %s', (definition, type, value, access, expected) => {
  const source = `const std=@import("std");const E=${definition};const S=${type};pub fn main()!void{var bytes:[1]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(S);p.*=${value};std.debug.print("{} {} {} {}",.{f.end_index,${access},p.count,bytes[0]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test.each(['u8', 'struct{value:u8}'])('serialized buffer references cannot address another execution: %s', (type) => {
  const initial = type === 'u8' ? '73' : '.{.value=73}';
  const access = type === 'u8' ? 'p.*.*' : 'p.*.value';
  const victim = `const std=@import("std");const T=${type};pub fn main()!void{var secret:T=${initial};_=&secret;var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(*T);p.*=&secret;}`;
  const attacker = `const std=@import("std");const T=${type};pub fn main()!void{var bytes:[8]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(*T);@memset(&bytes,0);bytes[5]=1;std.debug.print("{}",.{${access}});}`;
  expect(executeProgram('zig', victim)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  expect(executeProgram('zig', attacker)).toMatchObject({
    kind: 'executed',
    stderr: '',
    uncaughtException: 'Segmentation fault',
  });
  expect(executeProgram('zig', attacker)).toMatchObject({
    kind: 'executed',
    stderr: '',
    uncaughtException: 'Segmentation fault',
  });
});

test('serialized references can cross distinct fixed buffers within one execution', () => {
  const source = `const std=@import("std");pub fn main()!void{var n:u8=73;var first:[8]u8=undefined;var second:[8]u8=undefined;var a=std.heap.FixedBufferAllocator.init(&first);var b=std.heap.FixedBufferAllocator.init(&second);const p=try a.allocator().create(*u8);const q=try b.allocator().create(*u8);p.*=&n;@memcpy(&second,&first);q.*.*+=1;std.debug.print("{} {}",.{n,p.*.*});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '74 74',
    uncaughtException: undefined,
  });
});

test.each(['a.allocatedSlice(),a.unusedCapacitySlice()', '0..18446744073709551615,a.unusedCapacitySlice()'])(
  'for compares virtual slice lengths exactly before the body: %s',
  (operands) => {
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});for(${operands})|_,_|{std.debug.print("body",.{});break;}}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '',
      uncaughtException: 'panic: for loop over objects with non-equal lengths',
    });
  }
);

test.each(['5..3', '1..0'])('descending inline ranges are compile errors: %s', (range) => {
  expect(executeProgram('zig', `pub fn main()void{inline for(${range})|_|{}}`)).toMatchObject({ kind: 'compileError' });
});

test.each([false, true])('large disjoint switch cases compile with bounded indexing (ranges: %s)', (ranges) => {
  const cases = Array.from({ length: 8000 }, (_, index) =>
    ranges ? `${index * 2}...${index * 2 + 1}=>{},` : `${index}=>{},`
  ).join('');
  expect(executeProgram('zig', `pub fn main()void{var x:u32=0;_=&x;switch(x){${cases}else=>{}}}`)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test.each(['1...4=>{},3=>{},', '3=>{},1...4=>{},', '1...4=>{},4...8=>{},', '1=>{},1=>{},'])(
  'switch interval validation rejects overlapping cases: %s',
  (cases) => {
    expect(executeProgram('zig', `pub fn main()void{var x:u8=0;_=&x;switch(x){${cases}else=>{}}}`)).toMatchObject({
      kind: 'compileError',
    });
  }
);

test.each([
  ['struct{value:T}', 'b.value'],
  ['union(enum){value:T,none}', 'b.value'],
])('generic container factories retain specialization identity: %s', (container, field) => {
  const source = `const std=@import("std");fn Box(T:anytype)type{return ${container};}pub fn main()void{const A=Box(u8);const Again=Box(u8);const B=Box(u16);const b:B=.{.value=300};std.debug.print("{} {} {} {}",.{A==Again,A==B,@TypeOf(${field}),${field}});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false u16 300',
    uncaughtException: undefined,
  });
});

test('local containers carry the declaring function name', () => {
  const source = `const std=@import("std");pub fn main()void{const S=struct{x:u8};const E=enum{a};const U=union(enum){a:u8};std.debug.print("{} {} {}",.{S,E,U});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'main.main.S main.main.E main.main.U',
    uncaughtException: undefined,
  });
});

test('function type observations resolve signatures without analyzing bodies', () => {
  const source = `const std=@import("std");fn add(a:i32,b:i32)i32{return a+b;}fn unused(a:u8)u16{_=a;return true;}pub fn main()void{const f=add;std.debug.print("{} {} {}",.{@TypeOf(f),@TypeOf(&add),@TypeOf(unused)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'fn (i32, i32) i32 *const fn (i32, i32) i32 fn (u8) u16',
    uncaughtException: undefined,
  });
});

test('generic function signatures preserve anytype dependencies and fixed types', () => {
  const source = `const std=@import("std");fn id(x:anytype)@TypeOf(x){return x;}fn add(x:anytype,y:i32)u8{_=.{x,y};return 1;}fn take(T:anytype,x:T)T{return x;}pub fn main()void{std.debug.print("{} {} {}",.{@TypeOf(id),@TypeOf(add),@TypeOf(take)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'fn (anytype) anytype fn (anytype, i32) u8 fn (anytype, anytype) anytype',
    uncaughtException: undefined,
  });
});

test('tuple concatenation preserves heterogeneous fields, constants and operand effects', () => {
  const source = `const std=@import("std");fn make(n:u8)struct{u8,bool}{std.debug.print("{}",.{n});return .{n,true};}pub fn main()void{const x=.{@as(u8,1),true} ++ .{@as(u8,2),false};const b:bool=x[1];std.debug.print("{} {}|",.{b,@TypeOf(x)});const y=make(3) ++ make(4);std.debug.print("|{} {} {} {}",.{y[0],y[1],y[2],y[3]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr:
      'true struct { comptime u8 = 1, comptime bool = true, comptime u8 = 2, comptime bool = false }|34|3 true 4 true',
    uncaughtException: undefined,
  });
});

test.each([
  ['.{1} ++ [_]u8{2}', '[2]u8 { 1, 2 }'],
  ['[_]u8{1} ++ .{2}', '[2]u8 { 1, 2 }'],
  ['.{} ++ [_]u8{2}', '[1]u8 { 2 }'],
  ['[_]u8{1} ++ .{}', '[1]u8 { 1 }'],
])('tuple and array concatenation coerces each element: %s', (expression, expected) => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{const x=${expression};std.debug.print("{} {any}",.{@TypeOf(x),x});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: expected, uncaughtException: undefined });
});

test.each(['.{@as(u8,1),true} ++ [_]u8{2}', '[_]u8{1} ++ .{true}'])(
  'tuple and array concatenation rejects an incompatible field: %s',
  (expression) => {
    expect(executeProgram('zig', `pub fn main()void{const x=${expression};_=x;}`)).toMatchObject({
      kind: 'compileError',
    });
  }
);

test.each(['void', 'struct{}', 'u0'])('fixed zero-sized slices retain exact array and slice lengths: %s', (type) => {
  const item = type === 'void' ? '{}' : type === 'u0' ? '0' : '.{}';
  const source = `const std=@import("std");const T=${type};pub fn main(init:std.process.Init)!void{var a:std.ArrayList(T)=.empty;try a.append(init.gpa,${item});const x=a.allocatedSlice()[0..9007199254740993];const y=a.allocatedSlice()[1..9007199254740994];const z=a.allocatedSlice()[0..9007199254740992];const s:[]T=x;_=x[9007199254740992];const tail=x[1..];std.debug.print("{} {} {} {} {}",.{x.len,y.len,s.len,tail.len,@TypeOf(x)==@TypeOf(z)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '9007199254740993 9007199254740993 9007199254740993 9007199254740992 false',
    uncaughtException: undefined,
  });
});

test('fixed zero-sized slice lengths stay exact through runtime views and memory checks', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const x=a.allocatedSlice()[0..9007199254740993];var n:usize=9007199254740992;_=&n;const short=x[0..n];std.debug.print("{} {}|",.{@TypeOf(x),short.len});@memcpy(x,short);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '*[9007199254740993]void 9007199254740992|',
    uncaughtException: 'panic: source and destination arguments have non-equal lengths',
  });
});

test('fixed zero-sized slice bounds reject the exact end index', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const x=a.allocatedSlice()[0..9007199254740993];_=x[9007199254740993];}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
});

test.each([
  ['struct{a:u8,b:u16,c:u8}', '.{.a=@intCast(i),.b=123,.c=45}', 'k.a', '0 2 3 5 1 4 '],
  ['packed struct{a:u4,b:u4}', '.{.a=@intCast(i),.b=7}', 'k.a', '3 2 0 1 4 5 '],
  ['struct{a:u8,b:u32}', '.{.a=@intCast(i),.b=123}', 'k.a', '2 5 1 3 0 4 '],
  [
    'struct{inner:struct{a:u8,b:u16,c:u8},tail:u32}',
    '.{.inner=.{.a=@intCast(i),.b=123,.c=45},.tail=99}',
    'k.inner.a',
    '5 0 1 4 2 3 ',
  ],
  ['packed struct{inner:packed struct{a:u3},b:u5}', '.{.inner=.{.a=@intCast(i)},.b=7}', 'k.inner.a', '2 1 4 3 5 0 '],
  ['packed struct{a:f32,b:u32}', '.{.a=@floatFromInt(i),.b=7}', '@as(u32,@intFromFloat(k.a))', '1 5 0 3 4 2 '],
])('aggregate map keys hash the reference physical layout: %s', (definition, initializer, access, expected) => {
  const source = `const std=@import("std");const K=${definition};pub fn main(init:std.process.Init)!void{var map=std.AutoHashMap(K,u8).init(init.gpa);defer map.deinit();for(0..6)|i|try map.put(${initializer},0);var it=map.keyIterator();while(it.next())|k|std.debug.print("{} ",.{${access}});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test.each([
  ['[_]u8{1} ++ "ab"', '*const [3:0]u8'],
  ['"ab" ++ [_]u8{1}', '*const [3:0]u8'],
  ['.{@as(u8,1)} ++ "ab"', '*const [3:0]u8'],
  ['"ab" ++ .{@as(u8,1)}', '*const [3:0]u8'],
  ['[_]u8{1} ++ "ab" ++ [_]u8{4}', '*const [4:0]u8'],
])('either pointer concatenation operand makes a pointer result: %s', (expression, expected) => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()void{const x=${expression};std.debug.print("{}",.{@TypeOf(x)});}`
    )
  ).toMatchObject({ kind: 'executed', stderr: expected, uncaughtException: undefined });
});

test('a right array pointer preserves left value snapshots and runtime reads', () => {
  const source = `const std=@import("std");fn bump(a:*[2]u8)*[2]u8{a[0]=9;return a;}pub fn main()void{var a=[_]u8{1,2};const x=a ++ bump(&a);std.debug.print("{any} {}",.{x,@TypeOf(x)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '{ 1, 2, 9, 2 } *const [4]u8',
    uncaughtException: undefined,
  });
});

test('a concatenated pointer does not implicitly become an array value', () => {
  expect(executeProgram('zig', 'pub fn main()void{const x=[_]u8{1} ++ "ab";const y:[3:0]u8=x;_=y;}')).toMatchObject({
    kind: 'compileError',
  });
});

test.each(['writeAll(&a)', 'write(&a)', 'splatByteAll(97,300000)', 'splatBytesAll("ab",150000)'])(
  'writer reads, expansion and stores share the operation budget: %s',
  (call) => {
    const source = `const std=@import("std");pub fn main()!void{var a:[300000]u8=@splat(97);var b:[300000]u8=undefined;for(0..4)|_|{var w=std.Io.Writer.fixed(&b);_ = try w.${call};}_=&a;}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test('writer source memory faults before reserving its impossible copy length', () => {
  const source = `const std=@import("std");pub fn main()!void{var s:[]u8=undefined;_=&s;var bytes:[2]u8=undefined;var w=std.Io.Writer.fixed(&bytes);try w.writeAll(s);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', uncaughtException: 'Segmentation fault' });
});

test.each([
  'const a=id(.{.value=7});const b=id(.{.value=8});std.debug.print("{} {} {}",.{@TypeOf(a)==@TypeOf(b),a.value,b.value});',
  'const a=id(.{.value=7});const b=id(a);std.debug.print("{}",.{b.value});',
  'const a=id(id(.{.value=7}));std.debug.print("{}",.{a.value});',
])('repeated signature analysis preserves anonymous parameter identity: %s', (body) => {
  const source = `const std=@import("std");fn id(x:struct{value:u8})@TypeOf(x){return x;}pub fn main()void{${body}}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: body.includes('@TypeOf') ? 'true 7 8' : '7',
    uncaughtException: undefined,
  });
});

test('signature containers share stable captured type arguments and separate specializations', () => {
  const source = `const std=@import("std");fn id(T:anytype,x:struct{value:T})@TypeOf(x){return x;}pub fn main()void{const a=id(u8,.{.value=7});const b=id(u8,a);const c=id(u16,.{.value=300});std.debug.print("{} {} {} {}",.{@TypeOf(a)==@TypeOf(b),@TypeOf(a)==@TypeOf(c),b.value,c.value});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false 7 300',
    uncaughtException: undefined,
  });
});

test('signature containers independent of generic arguments retain declared identity', () => {
  const source = `const std=@import("std");fn id(x:anytype,y:struct{value:u8})@TypeOf(y){_=x;return y;}pub fn main()void{const a=id(@as(u8,1),.{.value=7});const b=id(@as(u16,1),a);std.debug.print("{} {}",.{@TypeOf(a)==@TypeOf(b),b.value});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true 7',
    uncaughtException: undefined,
  });
});

test('generic container contexts canonicalize function declaration arguments', () => {
  const source = `const std=@import("std");fn value()u8{return 7;}fn Factory(f:anytype)type{return struct{pub fn run()u8{return f();}};}pub fn main()void{const A=Factory(value);const B=Factory(value);std.debug.print("{} {}",.{A==B,B.run()});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true 7',
    uncaughtException: undefined,
  });
});

test.each([
  ['packed struct{a:f80,b:u48}', '.{.a=1.5,.b=0x123456789abc}', 'p.a'],
  ['packed struct{inner:packed struct{a:f80},b:u48}', '.{.inner=.{.a=1.5},.b=0x123456789abc}', 'p.inner.a'],
])('packed f80 fields use their logical width: %s', (type, value, access) => {
  const source = `const std=@import("std");const S=${type};pub fn main()!void{var bytes:[31]u8=undefined;var f=std.heap.FixedBufferAllocator.init(&bytes);const p=try f.allocator().create(S);p.*=${value};std.debug.print("allocated {d} {x}",.{${access},p.b});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'allocated 1.5 123456789abc',
    uncaughtException: undefined,
  });
});

test.each([
  ['u8', 'x'],
  ['bool', 'x==7'],
  ['*const u8', '&x'],
])('nested functions cannot capture an outer runtime constant as %s', (type, value) => {
  const source = `const std=@import("std");fn outer(n:u8)${type}{const x=n;const S=struct{fn get()${type}{return ${value};}};return S.get();}pub fn main()void{_=outer(7);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
});

test('nested functions retain compile-time values without reading another frame', () => {
  const source = `const std=@import("std");pub fn main()void{const x:u8=7;const S=struct{fn get()*const u8{return &x;}};std.debug.print("{} {}",.{S.get().*,S.get()==&x});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '7 true',
    uncaughtException: undefined,
  });
});

test.each([
  ['*[0]u8', '|_|{n+=1;}', '0'],
  ['*[2]void', '|_|{n+=1;}', '2'],
  ['*[2]void', '|*item|{item.*={};n+=1;}', '2'],
])('array pointer loops avoid zero-byte dereferences: %s %s', (type, body, expected) => {
  const source = `const std=@import("std");pub fn main()void{var p:${type}=undefined;_=&p;var n:usize=0;for(p)${body}std.debug.print("{}",.{n});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test('array pointer loops still fault when they actually read memory', () => {
  expect(executeProgram('zig', 'pub fn main()void{var p:*[2]u8=undefined;_=&p;for(p)|item|{_=item;}}')).toMatchObject({
    kind: 'executed',
    uncaughtException: 'Segmentation fault',
  });
});

test.each([
  [String.raw`\xff\x80\x80`, String.raw`"\xff\x80\x80"`],
  [String.raw`\xf8\x80\x80`, String.raw`"\xf8\x80\x80"`],
  [String.raw`\xf5\x80\x80\x80`, String.raw`"\xf5\x80\x80\x80"`],
  [String.raw`\xc0\x80`, String.raw`"\xc0\x80"`],
  [String.raw`\xe3\x81`, String.raw`"\xe3\x81"`],
  [String.raw`\xe3\x81\x82`, '"あ"'],
  [String.raw`\xf0\x9f\x98\x80`, '"😀"'],
  [String.raw`\xef\xbb\xbf`, String.raw`"\xef\xbb\xbf"`],
])('quoted strings retain malformed UTF-8 byte identity: %s', (bytes, expected) => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{q}",.{"${bytes}"});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: expected,
    uncaughtException: undefined,
  });
});

test.each(['cutPrefix', 'cutSuffix'])('memory cuts retain exact zero-sized view lengths: %s', (method) => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const x=std.mem.${method}(void,a.allocatedSlice(),&[_]void{}).?;const y=std.mem.${method}(void,a.unusedCapacitySlice(),&[_]void{{},{}}).?;std.debug.print("{} {}",.{x.len,y.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615 18446744073709551612',
    uncaughtException: undefined,
  });
});

test.each(['findMin', 'findMax', 'indexOfMin', 'indexOfMax', 'min', 'max', 'minMax'])(
  'memory extrema share the operation budget: %s',
  (method) => {
    const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(7);for(0..4)|_|{_=std.mem.${method}(u8,&a);}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each(['findMin', 'findMax', 'findMinMax', 'indexOfMin', 'indexOfMax', 'indexOfMinMax', 'min', 'max', 'minMax'])(
  'memory extrema reject unsupported element ordering: %s',
  (method) => {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{const a=[_]bool{true,false};_=std.mem.${method}(bool,&a);}`
      )
    ).toMatchObject({ kind: 'compileError' });
  }
);

test.each(['copyForwards', 'copyBackwards'])('memory copies charge reads and stores: %s', (method) => {
  const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(7);var b:[300000]u8=undefined;for(0..4)|_|{std.mem.${method}(u8,&b,&a);}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('memory copies preserve directional live overlap', () => {
  const source = `const std=@import("std");pub fn main()void{var a=[_]u8{1,2,3,4};var b=a;std.mem.copyForwards(u8,a[1..],a[0..3]);std.mem.copyBackwards(u8,b[0..3],b[1..]);std.debug.print("{any} {any}",.{a,b});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '{ 1, 1, 1, 1 } { 4, 4, 4, 4 }',
    uncaughtException: undefined,
  });
});

test('zero-sized memory permutations and copies stay virtual after their checks', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:std.ArrayList(void)=.empty;try a.append(init.gpa,{});const all=a.allocatedSlice();const tail=a.unusedCapacitySlice();std.mem.reverse(void,all);std.mem.rotate(void,all,18446744073709551615);std.mem.copyForwards(void,all,tail);std.mem.copyBackwards(void,all,tail);std.debug.print("{} {}",.{all.len,tail.len});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615 18446744073709551614',
    uncaughtException: undefined,
  });
});

test('zero-sized rotation validates its bound before eliding data work', () => {
  const source = `const std=@import("std");pub fn main()void{std.mem.rotate(void,&[_]void{},1);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'panic: end index 1 out of bounds for slice of length 0',
  });
});

test.each([
  ['[300000]u8', '@splat(1)', '@splat(2)'],
  ['struct{values:[150000]u8}', '.{.values=@splat(1)}', '.{.values=@splat(2)}'],
])('memory swaps charge nested aggregate transfers: %s', (type, first, second) => {
  const source = `const std=@import("std");const T=${type};pub fn main()void{var a:T=${first};var b:T=${second};for(0..4)|_|std.mem.swap(T,&a,&b);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('memory replacement charges each transferred replacement element', () => {
  const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(97);var b:[300000]u8=undefined;for(0..4)|_|{_=std.mem.replace(u8,"x","x",&a,&b);}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each(['@ctz', '@clz', '@popCount', '@bitReverse', '@byteSwap'])(
  'wide bit traversal shares the work budget: %s',
  (method) => {
    const source = `pub fn main()void{var n:u65528=1<<65527;_=&n;for(0..20)|_|{_=${method}(n);}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each([
  'log2_int(u65535,n)',
  'log2_int_ceil(u65535,n)',
  'log10_int(n)',
  'floorPowerOfTwo(u65535,n)',
  'ceilPowerOfTwo(u65535,n)',
])('wide integer library conversions share the work budget: %s', (method) => {
  const source = `const std=@import("std");pub fn main()void{var n:u65535=1<<65534;_=&n;for(0..60)|_|{_=std.math.${method}${method.startsWith('ceilPowerOfTwo') ? ' catch unreachable' : ''};}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each(['0..2', '1..3'])('constant array keys exclude trailing backing storage: %s', (range) => {
  const backing = range === '0..2' ? '1,2,9,5' : '1,2,3,5';
  const source = `const std=@import("std");pub fn main()void{const a=[_]u8{1,2,3,4};const b=[_]u8{${backing}};const x=.{a[${range}].*};const y=.{b[${range}].*};std.debug.print("{}",.{@TypeOf(x)==@TypeOf(y)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true',
    uncaughtException: undefined,
  });
});

test('saturating shifts accept unrestricted unsigned counts without materializing huge integers', () => {
  const source = `const std=@import("std");pub fn main()void{var x:u8=1;_=&x;var n:u8=8;_=&n;var neg:i8=-1;_=&neg;std.debug.print("{} {} {} {} {} {}",.{x<<|8,x<<|255,x<<|n,x<<|@as(u64,18446744073709551615),neg<<|255,@as(u8,0)<<|255});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '255 255 255 255 -128 0',
    uncaughtException: undefined,
  });
});

test.each(['@as(i8,1)', '-1'])('saturating shifts reject invalid count domains: %s', (amount) => {
  expect(
    executeProgram(
      'zig',
      `pub fn main()void{var x:u8=1;_=&x;${amount.startsWith('@as') ? `var n=${amount};_=&n;` : ''}_=x<<|${amount.startsWith('@as') ? 'n' : amount};}`
    )
  ).toMatchObject({
    kind: 'compileError',
  });
});

test('named format arguments preserve byte identity for values, width and precision', () => {
  const source = String.raw`const std=@import("std");pub fn main()void{std.debug.print("{[\xff]:[\xfe].[\xfd]}|{[�]}",.{.@"\xff"=@as(f32,1.5),.@"\xfe"=5,.@"\xfd"=1,.@"�"=7});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '  1.5|7',
    uncaughtException: undefined,
  });
});

test.each(['clearRetainingCapacity', 'keyIterator', 'valueIterator', 'iterator'])(
  'hash map capacity scans consume the work budget: %s',
  (method) => {
    const body =
      method === 'clearRetainingCapacity'
        ? 'map.clearRetainingCapacity();'
        : `var it=map.${method}();while(it.next())|_|{}`;
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var map=std.AutoHashMap(u32,u8).init(init.gpa);try map.ensureTotalCapacity(100000);try map.put(1,1);for(0..8)|_|{${body}}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test('range-heavy switch dispatch uses an indexed live lookup', () => {
  const cases = Array.from({ length: 2000 }, (_, i) => `${i * 3}...${i * 3 + 1}=>{},`).join('');
  const source = `pub fn main()void{var n:u32=100000;_=&n;for(0..600)|_|{switch(n){${cases}else=>{},}}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each(['binarySearch', 'lowerBound', 'upperBound', 'partitionPoint', 'equalRange'])(
  'sort query indices retain exact virtual lengths: %s',
  (method) => {
    const predicate = method === 'partitionPoint' ? 'bool{return true;}' : 'std.math.Order{return .gt;}';
    const output =
      method === 'binarySearch'
        ? 'result==null'
        : method === 'equalRange'
          ? 'result[0]==18446744073709551615 and result[1]==18446744073709551615'
          : 'result==18446744073709551615';
    const source = `const std=@import("std");fn compare(count:*usize,_:void)${predicate.replace('return', 'count.*+=1;return')}pub fn main(init:std.process.Init)!void{var list:std.ArrayList(void)=.empty;try list.append(init.gpa,{});var calls:usize=0;const result=std.sort.${method}(void,list.allocatedSlice(),&calls,compare);std.debug.print("{}",.{${output} and calls>0});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'true',
      uncaughtException: undefined,
    });
  }
);

test.each(['@as(?usize,3)', '@as(?usize,null)', 'null'])(
  'format options use the optional usize contract: %s',
  (width) => {
    const source = `const std=@import("std");pub fn main()void{${width === 'null' ? 'const' : 'var'} n=${width};_=&n;std.debug.print("{0d:[1]}|{0d:.[1]}",.{3,n});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: width === '@as(?usize,3)' ? '  3|3' : '3|3',
      uncaughtException: undefined,
    });
  }
);

test.each(['@as(i32,-1)', '@as(u128,3)', '-1', '18446744073709551616'])(
  'format options reject values outside optional usize: %s',
  (width) => {
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{${width.startsWith('@as') ? `var n=${width};_=&n;` : ''}std.debug.print("{d:[1]}",.{3,${width.startsWith('@as') ? 'n' : width}});}`
      )
    ).toMatchObject({ kind: 'compileError' });
  }
);

test.each(['B', 'Bi'])('byte-size formats apply their u64 argument contract: %s', (spec) => {
  for (const value of ['@as(i32,-5)', '@as(u128,3)', '-1', '18446744073709551616'])
    expect(
      executeProgram(
        'zig',
        `const std=@import("std");pub fn main()void{${value.startsWith('@as') ? `var n=${value};_=&n;` : ''}std.debug.print("{${spec}}",.{${value.startsWith('@as') ? 'n' : value}});}`
      )
    ).toMatchObject({ kind: 'compileError' });
  expect(
    executeProgram('zig', `const std=@import("std");pub fn main()void{std.debug.print("{${spec}}",.{@as(u32,5)});}`)
  ).toMatchObject({ kind: 'executed', stderr: '5B', uncaughtException: undefined });
});

test('large named format tables share the compilation budget', () => {
  const count = 60_000;
  const format = Array.from({ length: count }, (_, index) => `{[f${index}]}`).join('');
  const args = Array.from({ length: count }, (_, index) => `.f${index}=0`).join(',');
  expect(
    executeProgram('zig', `const std=@import("std");pub fn main()void{std.debug.print("${format}",.{${args}});}`)
  ).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('known widths retain value coercion while byte-size parameters enforce typed ranges', () => {
  expect(
    executeProgram('zig', 'const std=@import("std");pub fn main()void{std.debug.print("{d:[1]}",.{3,@as(u128,3)});}')
  ).toMatchObject({ kind: 'executed', stderr: '  3', uncaughtException: undefined });
  for (const spec of ['B', 'Bi'])
    expect(
      executeProgram('zig', `const std=@import("std");pub fn main()void{std.debug.print("{${spec}}",.{@as(u128,5)});}`)
    ).toMatchObject({ kind: 'compileError' });
});

test('known signed nonnegative shift counts coerce by value', () => {
  expect(
    executeProgram(
      'zig',
      'const std=@import("std");pub fn main()void{var x:u8=1;_=&x;std.debug.print("{}",.{x<<|@as(i8,1)});}'
    )
  ).toMatchObject({ kind: 'executed', stderr: '2', uncaughtException: undefined });
});
test.each(['find', 'findLast', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'cut', 'cutLast'])(
  'empty memory searches inspect only view metadata: %s',
  (method) => {
    const expression =
      method === 'cut' || method === 'cutLast'
        ? `result.?[1].len==${method === 'cutLast' ? 0 : 18_446_744_073_709_551_615n}`
        : method === 'startsWith' || method === 'endsWith'
          ? 'result'
          : method === 'findLast' || method === 'lastIndexOf'
            ? 'result.?==18446744073709551615'
            : 'result.?==0';
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var list:std.ArrayList(void)=.empty;try list.append(init.gpa,{});const result=std.mem.${method}(void,list.allocatedSlice(),&[_]void{});std.debug.print("{}",.{${expression}});}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: 'true',
      uncaughtException: undefined,
    });
  }
);

test.each(['findScalar', 'findScalarLast', 'countScalar', 'allEqual'])(
  'live scalar searches meter every visited element: %s',
  (method) => {
    const source = `const std=@import("std");pub fn main()void{const a:[300000]u8=@splat(0);for(0..4)|_|{_=std.mem.${method}(u8,&a,${method === 'allEqual' ? 0 : 1});}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test('memory search positions retain exact indices near the usize boundary', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var list:std.ArrayList(void)=.empty;try list.append(init.gpa,{});std.debug.print("{} {}",.{std.mem.findScalarPos(void,list.allocatedSlice(),18446744073709551614,{}).?,std.mem.findPos(void,list.allocatedSlice(),18446744073709551614,&[_]void{}).?});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551614 18446744073709551614',
    uncaughtException: undefined,
  });
});

test('containsAtLeast preserves scalar delegation at zero threshold', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{} {} {} {}",.{std.mem.containsAtLeast(u8,"",0,"a"),std.mem.containsAtLeast(u8,"",0,"ab"),std.mem.containsAtLeast(u8,"b",0,"a"),std.mem.containsAtLeast(u8,"aba",2,"a")});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'false true true true',
    uncaughtException: undefined,
  });
});

test.each([
  'eql(S,&a,&a)',
  'find(S,&a,&a)',
  'countScalar(S,&a,.{})',
  'startsWith(S,&a,&a)',
  'cutPrefix(S,&a,&a)',
  'containsAtLeast(S,&a,0,&a)',
  'trim(S,&a,&a)',
  'replaceScalar(S,&a,.{},.{})',
  'findDiff(S,&a,&a)',
])('memory equality validates the element domain before shortcuts: %s', (call) => {
  const source = `const std=@import("std");const S=struct{};pub fn main()void{var a=[_]S{.{}};_=&a;_=std.mem.${call};}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
});

test('memory equality uses nested optional payload semantics', () => {
  const source = `const std=@import("std");pub fn main()void{const a=[_]??u8{@as(?u8,3),null};const b=[_]??u8{@as(?u8,3),null};const c=[_]??u8{@as(?u8,4),null};std.debug.print("{} {} {}",.{std.mem.eql(??u8,&a,&b),std.mem.eql(??u8,&a,&c),std.mem.countScalar(??u8,&a,@as(?u8,3))});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true false 1',
    uncaughtException: undefined,
  });
});

test.each(['void', 'struct{}', '[0]u64'])(
  'allocator zero-sized slices retain virtual exact lengths and typed reads: %s',
  (type) => {
    const source = `const std=@import("std");const T=${type};pub fn main(init:std.process.Init)!void{const a=try init.gpa.alloc(T,18446744073709551615);const b=try init.gpa.dupe(T,a);const c=try init.gpa.create(T);const d=try init.gpa.create(T);a[18446744073709551614]=undefined;std.debug.print("{} {} {} {}",.{a.len,b.len,a[0..0]==b[0..0],c==d});init.gpa.free(a);init.gpa.free(b);init.gpa.destroy(c);init.gpa.destroy(d);}`;
    expect(executeProgram('zig', source)).toMatchObject({
      kind: 'executed',
      stderr: '18446744073709551615 18446744073709551615 true true',
      uncaughtException: undefined,
    });
  }
);

test.each(['void', '[0]u8'])('allocator realloc rejects nonempty zero-bit slices as Zig does: %s', (type) => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{const a=try init.gpa.alloc(${type},1);_=try init.gpa.realloc(a,1000000000);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'compileError' });
});

test('allocator realloc from a fixed empty zero-bit array allocates a virtual slice', () => {
  const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{var a:[0]void=.{};const b=try init.gpa.realloc(&a,18446744073709551615);std.debug.print("{}",.{b.len});init.gpa.free(b);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '18446744073709551615',
    uncaughtException: undefined,
  });
});

test('allocator fixed-array views retain allocation identity through resize and free', () => {
  const source = `const std=@import("std");pub fn main()!void{var buffer:[8]u8=undefined;var fba=std.heap.FixedBufferAllocator.init(&buffer);const gpa=fba.allocator();const a=try gpa.alloc(u8,2);a[0]=7;a[1]=9;const b=try gpa.realloc(a[0..2],3);std.debug.print("{} {} {}|",.{b.len,b[0],b[1]});gpa.free(b[0..3]);const c=try gpa.alloc(u8,8);std.debug.print("{}",.{c.len});gpa.free(c);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '3 7 9|8',
    uncaughtException: undefined,
  });
});

test.each(['appendSlice', 'appendNTimes', 'orderedRemove', 'replaceRange', 'shrinkRetainingCapacity'])(
  'ArrayList transfers and shrinking consume the work budget: %s',
  (method) => {
    const initialization = ['orderedRemove', 'replaceRange', 'shrinkRetainingCapacity'].includes(method)
      ? 'fromOwnedSlice'
      : 'initBuffer';
    const body =
      method === 'appendSlice'
        ? 'try list.appendSlice(init.gpa,&input);list.clearRetainingCapacity();'
        : method === 'appendNTimes'
          ? 'try list.appendNTimes(init.gpa,1,300000);list.clearRetainingCapacity();'
          : method === 'orderedRemove'
            ? '_=list.orderedRemove(0);'
            : method === 'replaceRange'
              ? 'try list.replaceRange(init.gpa,0,300000,&input);'
              : 'list.shrinkRetainingCapacity(0);list.expandToCapacity();';
    const source = `const std=@import("std");pub fn main(init:std.process.Init)!void{${['orderedRemove', 'shrinkRetainingCapacity'].includes(method) ? '_=init;' : ''}var buffer:[300000]u8=undefined;var list=std.ArrayList(u8).${initialization}(&buffer);${['appendSlice', 'replaceRange'].includes(method) ? 'const input:[300000]u8=@splat(1);' : ''}for(0..4)|_|{${body}}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test('ArrayList transfers account for nested aggregate storage', () => {
  const source = `const std=@import("std");pub fn main()void{var buffer:[3][100000]u8=undefined;var list=std.ArrayList([100000]u8).initBuffer(&buffer);const item:[100000]u8=@splat(1);for(0..4)|_|{list.appendAssumeCapacity(item);list.clearRetainingCapacity();}}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('slices of array elements retain their header and shared backing storage', () => {
  const source = `const std=@import("std");pub fn main()void{var data=[_][2]u8{.{1,2},.{3,4}};const slice:[][2]u8=&data;const selected=slice[1..2];selected[0][0]=7;std.debug.print("{} {any}",.{selected.len,data[1]});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '1 { 7, 4 }',
    uncaughtException: undefined,
  });
});

test('allocator fixed sentinel views absorb their sentinel when resizing', () => {
  const source = `const std=@import("std");pub fn main()!void{var buffer:[8]u8=undefined;var fba=std.heap.FixedBufferAllocator.init(&buffer);const gpa=fba.allocator();const a=try gpa.alloc(u8,3);a[0]=7;a[1]=9;a[2]=0;const b=try gpa.realloc(a[0..2:0],4);std.debug.print("{} {} {} {}|",.{b.len,b[0],b[1],b[2]});gpa.free(b);const c=try gpa.alloc(u8,8);std.debug.print("{}",.{c.len});gpa.free(c);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '4 7 9 0|8',
    uncaughtException: undefined,
  });
});

test('allocator empty array views use metadata without dereferencing their pointer', () => {
  const source = `const std=@import("std");pub fn main()!void{var buffer:[5]u8=undefined;var fba=std.heap.FixedBufferAllocator.init(&buffer);const gpa=fba.allocator();const p:*[0]u8=undefined;const a=try gpa.realloc(p,3);gpa.free(p);std.debug.print("{}",.{a.len});gpa.free(a);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'executed', stderr: '3', uncaughtException: undefined });
});

test('allocator empty sentinel views allocate independently without copying the sentinel', () => {
  const source = `const std=@import("std");pub fn main()!void{var buffer:[6]u8=undefined;var fba=std.heap.FixedBufferAllocator.init(&buffer);const gpa=fba.allocator();const a=try gpa.alloc(u8,1);a[0]=0;const b=try gpa.realloc(a[0..0:0],2);std.debug.print("{} {} {}|",.{b.len,b[0],a[0]});gpa.free(b);gpa.free(a);const c=try gpa.alloc(u8,6);std.debug.print("{}",.{c.len});gpa.free(c);}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '2 170 0|6',
    uncaughtException: undefined,
  });
});

test.each(['asc', 'desc'])('sort comparators retain lazy analysis and enforce ordering when used: %s', (direction) => {
  const unused = `const std=@import("std");pub fn main()void{const f=std.sort.${direction}(bool);_=f;std.debug.print("unused",.{});}`;
  expect(executeProgram('zig', unused)).toMatchObject({
    kind: 'executed',
    stderr: 'unused',
    uncaughtException: undefined,
  });
  for (const call of [
    `const f=std.sort.${direction}(bool);const p=&f;_=p;`,
    `_=std.sort.${direction}(bool)({},true,false);`,
    `var a=[_]bool{true,false};std.sort.insertion(bool,&a,{},std.sort.${direction}(bool));`,
    `var flag=false;_=&flag;if(flag){_=std.sort.${direction}(bool)({},true,false);}`,
  ])
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{${call}}`)).toMatchObject({
      kind: 'compileError',
    });
});

test.each(['insertion', 'heap', 'pdq'])(
  'sorting charges nested aggregate transfers across algorithms: %s',
  (algorithm) => {
    const source = `const std=@import("std");const P=struct{x:u8,data:[1000]u8};fn less(_:void,a:P,b:P)bool{return a.x<b.x;}pub fn main()void{var a=[_]P{.{.x=2,.data=@splat(1)},.{.x=1,.data=@splat(2)}};for(0..300)|_|{std.sort.${algorithm}(P,&a,{},less);a[0].x=2;a[1].x=1;}}`;
    expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each(['struct{a:[1000]u8}', '[1000]u8'])('shuffling charges typed aggregate transfers: %s', (type) => {
  const value = type.startsWith('struct') ? '.{.a=@splat(1)}' : '@splat(1)';
  const source = `const std=@import("std");const P=${type};pub fn main()void{var p=std.Random.DefaultPrng.init(1);var a=[_]P{${value},${value}};for(0..300)|_|p.random().shuffle(P,&a);}`;
  expect(executeProgram('zig', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('zero-sized shuffle keeps random draws while eliding data transfers', () => {
  const source = `const std=@import("std");pub fn main()void{var p=std.Random.DefaultPrng.init(42);var q=std.Random.DefaultPrng.init(42);var a:[4]void=undefined;var b=[_]u8{1,2,3,4};p.random().shuffle(void,&a);q.random().shuffle(u8,&b);std.debug.print("{}",.{p.random().int(u64)==q.random().int(u64)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: 'true',
    uncaughtException: undefined,
  });
});

test.each([
  ['add', '7'],
  ['sub', '-1'],
  ['mul', '12'],
])('checked comptime integer math preserves error-union results: %s', (method, result) => {
  const source = `const std=@import("std");pub fn main()!void{const value=std.math.${method}(comptime_int,3,4);std.debug.print("{} {}",.{@TypeOf(value),try value});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: `error{Overflow}!comptime_int ${result}`,
    uncaughtException: undefined,
  });
});

test.each([
  'mul(comptime_int,1<<600000,1<<600000)',
  'add(comptime_int,1<<999999,1<<999999)',
  'sub(comptime_int,-(1<<999998),1<<999999)',
])('checked comptime math bounds results before materialization: %s', (expression) => {
  expect(
    executeProgram(
      'zig',
      `const std=@import("std");pub fn main()!void{const value=try std.math.${expression};_=value;}`
    )
  ).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test.each(['1<<600000,(1<<600000)-1', '(1<<600000)-1,(1<<600000)+1'])(
  'comptime LCM bounds its final multiplication: %s',
  (args) => {
    expect(
      executeProgram('zig', `const std=@import("std");pub fn main()void{const value=std.math.lcm(${args});_=value;}`)
    ).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
  }
);

test.each(['bool,true,true', '[]const u8,"a","b"', 'f80,2,4', 'f128,2,4', 'f16,2,4'])(
  'logarithm rejects unsupported type domains: %s',
  (args) => {
    expect(executeProgram('zig', `const std=@import("std");pub fn main()void{_=std.math.log(${args});}`)).toMatchObject(
      { kind: 'compileError' }
    );
  }
);

test('comptime integer logarithms use exact integer evaluation', () => {
  const source = `const std=@import("std");pub fn main()void{std.debug.print("{} {} {}",.{std.math.log(comptime_int,3,81),std.math.log(comptime_int,2,1024),std.math.log(comptime_int,10,999)});}`;
  expect(executeProgram('zig', source)).toMatchObject({
    kind: 'executed',
    stderr: '4 10 2',
    uncaughtException: undefined,
  });
});
