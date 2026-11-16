import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// Every expected output below is what `zig run` of Zig 0.17.1 (aarch64-macos, Debug) printed for the same program.

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
