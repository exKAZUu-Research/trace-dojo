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
