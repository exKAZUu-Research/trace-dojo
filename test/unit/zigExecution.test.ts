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
      `const parts:[1000][]const u8=@splat(&replacement);_= &parts;_= &input;const value=${expression} catch|err|{std.debug.print("{s}",.{@errorName(err)});return;};std.debug.print("{}",.{value.len});}`;
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
