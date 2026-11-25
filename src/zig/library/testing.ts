import type { SourceFile } from '../ast';
import { parseZig } from '../parse';
import { addDecls } from '../semaBase';
import type { Namespace, StructType } from '../types';
import { withPublicSurface } from './portedSurface';

/**
 * `std.testing` ported from Zig 0.17's library, which a program may call outside a test as well. The failure reports
 * are those of a standard error that is not a terminal, which colors nothing. `allocator`, `io`, and `environ` exist
 * only in test builds, so referring to them fails to compile as it does under `zig run`.
 */
const SOURCE = `
const std = @import("std");

pub const allocator = @compileError("not testing");
pub const io = @compileError("not testing");
pub const environ = @compileError("not testing");

pub fn failPrint(comptime fmt: []const u8, args: anytype) void {
    std.debug.print(fmt, args);
}

pub fn expect(ok: bool) !void {
    if (!ok) return error.TestUnexpectedResult;
}

pub inline fn expectEqual(expected: anytype, actual: anytype) !void {
    const T = @TypeOf(expected, actual);
    return expectEqualInner(T, expected, actual);
}

fn expectEqualInner(comptime T: type, expected: T, actual: T) !void {
    switch (@typeInfo(@TypeOf(actual))) {
        .noreturn,
        .@"opaque",
        .spirv,
        .frame,
        .@"anyframe",
        => @compileError("value of type " ++ @typeName(@TypeOf(actual)) ++ " encountered"),

        .undefined,
        .null,
        .void,
        => return,

        .type => {
            if (actual != expected) {
                failPrint("expected type {s}, found type {s}\\n", .{ @typeName(expected), @typeName(actual) });
                return error.TestExpectedEqual;
            }
        },

        .bool,
        .int,
        .float,
        .comptime_float,
        .comptime_int,
        .enum_literal,
        .@"enum",
        .@"fn",
        .error_set,
        => {
            if (actual != expected) {
                failPrint("expected {any}, found {any}\\n", .{ expected, actual });
                return error.TestExpectedEqual;
            }
        },

        .pointer => |pointer| {
            switch (pointer.size) {
                .one, .many, .c => {
                    if (actual != expected) {
                        failPrint("expected {*}, found {*}\\n", .{ expected, actual });
                        return error.TestExpectedEqual;
                    }
                },
                .slice => {
                    if (actual.ptr != expected.ptr) {
                        failPrint("expected slice ptr {*}, found {*}\\n", .{ expected.ptr, actual.ptr });
                        return error.TestExpectedEqual;
                    }
                    if (actual.len != expected.len) {
                        failPrint("expected slice len {}, found {}\\n", .{ expected.len, actual.len });
                        return error.TestExpectedEqual;
                    }
                },
            }
        },

        .array => |array| try expectEqualSlices(array.child, &expected, &actual),

        .vector => |info| {
            const expect_array: [info.len]info.child = expected;
            const actual_array: [info.len]info.child = actual;
            try expectEqualSlices(info.child, &expect_array, &actual_array);
        },

        .@"struct" => |@"struct"| {
            inline for (@"struct".field_names) |field_name| {
                try expectEqual(@field(expected, field_name), @field(actual, field_name));
            }
        },

        .@"union" => |@"union"| if (@"union".backing_integer) |Int| {
            try expectEqual(@as(Int, @bitCast(expected)), @as(Int, @bitCast(actual)));
        } else switch (@"union".layout) {
            .@"packed" => {
                const Int = @Int(.unsigned, @bitSizeOf(T));
                try expectEqual(@as(Int, @bitCast(expected)), @as(Int, @bitCast(actual)));
            },
            .@"extern" => {
                const first_size = @bitSizeOf(@"union".field_types[0]);
                inline for (@"union".field_types) |field_type| {
                    if (@bitSizeOf(field_type) != first_size) {
                        @compileError("Unable to compare extern unions with varying field sizes for type " ++ @typeName(T));
                    }
                }
                const FieldInt = @Int(.unsigned, first_size);
                const expected_field = @field(expected, @"union".field_names[0]);
                const actual_field = @field(actual, @"union".field_names[0]);
                return expectEqual(
                    @as(FieldInt, @bitCast(expected_field)),
                    @as(FieldInt, @bitCast(actual_field)),
                );
            },
            .auto => {
                const Tag = @"union".tag_type orelse @compileError("byteSwapAllFields expects packed, extern, or tagged union");

                try expectEqual(@as(Tag, expected), @as(Tag, actual));
                switch (expected) {
                    inline else => |expected_payload, tag| {
                        const actual_payload = @field(actual, @tagName(tag));
                        try expectEqual(expected_payload, actual_payload);
                    },
                }
            },
        },

        .optional => {
            if (expected) |expected_payload| {
                if (actual) |actual_payload| {
                    try expectEqual(expected_payload, actual_payload);
                } else {
                    failPrint("expected {any}, found null\\n", .{expected_payload});
                    return error.TestExpectedEqual;
                }
            } else {
                if (actual) |actual_payload| {
                    failPrint("expected null, found {any}\\n", .{actual_payload});
                    return error.TestExpectedEqual;
                }
            }
        },

        .error_union => {
            if (expected) |expected_payload| {
                if (actual) |actual_payload| {
                    try expectEqual(expected_payload, actual_payload);
                } else |actual_err| {
                    failPrint("expected {any}, found {}\\n", .{ expected_payload, actual_err });
                    return error.TestExpectedEqual;
                }
            } else |expected_err| {
                if (actual) |actual_payload| {
                    failPrint("expected {}, found {any}\\n", .{ expected_err, actual_payload });
                    return error.TestExpectedEqual;
                } else |actual_err| {
                    try expectEqual(expected_err, actual_err);
                }
            }
        },
    }
}

pub inline fn expectApproxEqAbs(expected: anytype, actual: anytype, tolerance: anytype) !void {
    const T = @TypeOf(expected, actual, tolerance);
    return expectApproxEqAbsInner(T, expected, actual, tolerance);
}

fn expectApproxEqAbsInner(comptime T: type, expected: T, actual: T, tolerance: T) !void {
    switch (@typeInfo(T)) {
        .float => if (!std.math.approxEqAbs(T, expected, actual, tolerance)) {
            failPrint("actual {}, not within absolute tolerance {} of expected {}\\n", .{ actual, tolerance, expected });
            return error.TestExpectedApproxEqAbs;
        },
        .comptime_float => @compileError("Cannot approximately compare two comptime_float values"),
        else => @compileError("Unable to compare non floating point values"),
    }
}

pub inline fn expectApproxEqRel(expected: anytype, actual: anytype, tolerance: anytype) !void {
    const T = @TypeOf(expected, actual, tolerance);
    return expectApproxEqRelInner(T, expected, actual, tolerance);
}

fn expectApproxEqRelInner(comptime T: type, expected: T, actual: T, tolerance: T) !void {
    switch (@typeInfo(T)) {
        .float => if (!std.math.approxEqRel(T, expected, actual, tolerance)) {
            failPrint("actual {}, not within relative tolerance {} of expected {}\\n", .{ actual, tolerance, expected });
            return error.TestExpectedApproxEqRel;
        },
        .comptime_float => @compileError("Cannot approximately compare two comptime_float values"),
        else => @compileError("Unable to compare non floating point values"),
    }
}

pub fn expectEqualSlices(comptime T: type, expected: []const T, actual: []const T) !void {
    const diff_index: usize = diff_index: {
        const shortest = @min(expected.len, actual.len);
        var index: usize = 0;
        while (index < shortest) : (index += 1) {
            if (!std.meta.eql(actual[index], expected[index])) break :diff_index index;
        }
        break :diff_index if (expected.len == actual.len) return else shortest;
    };
    failEqualSlices(T, expected, actual, diff_index);
    return error.TestExpectedEqual;
}

fn failEqualSlices(comptime T: type, expected: []const T, actual: []const T, diff_index: usize) void {
    std.debug.print("slices differ. first difference occurs at index {d} (0x{X})\\n", .{ diff_index, diff_index });
    const max_lines: usize = 16;
    const max_window_size: usize = if (T == u8) max_lines * 16 else max_lines;
    var window_start: usize = 0;
    if (@max(actual.len, expected.len) > max_window_size) {
        const alignment: usize = if (T == u8) 16 else 2;
        const back = diff_index - @min(diff_index, alignment);
        window_start = back - back % alignment;
    }
    const expected_window = expected[window_start..@min(expected.len, window_start + max_window_size)];
    const expected_truncated = window_start + expected_window.len < expected.len;
    const actual_window = actual[window_start..@min(actual.len, window_start + max_window_size)];
    const actual_truncated = window_start + actual_window.len < actual.len;
    const index_fmt = if (T == u8) "0x{X}" else "{}";
    std.debug.print("\\n============ expected this output: =============  len: {} (0x{X})\\n\\n", .{ expected.len, expected.len });
    printTruncatedStart(T, window_start);
    writeDiffer(T, window_start, expected_window, actual_window);
    if (expected_truncated) {
        const end_offset = window_start + expected_window.len;
        const num_missing_items = expected.len - (window_start + expected_window.len);
        if (T == u8) {
            std.debug.print("... truncated, indexes [" ++ index_fmt ++ "..] not shown, remaining bytes: " ++ index_fmt ++ " ...\\n", .{ end_offset, num_missing_items });
        } else {
            std.debug.print("... truncated, remaining items: " ++ index_fmt ++ " ...\\n", .{num_missing_items});
        }
    }
    std.debug.print("\\n============= instead found this: ==============  len: {} (0x{X})\\n\\n", .{ actual.len, actual.len });
    printTruncatedStart(T, window_start);
    writeDiffer(T, window_start, actual_window, expected_window);
    if (actual_truncated) {
        const end_offset = window_start + actual_window.len;
        const num_missing_items = actual.len - (window_start + actual_window.len);
        if (T == u8) {
            std.debug.print("... truncated, indexes [" ++ index_fmt ++ "..] not shown, remaining bytes: " ++ index_fmt ++ " ...\\n", .{ end_offset, num_missing_items });
        } else {
            std.debug.print("... truncated, remaining items: " ++ index_fmt ++ " ...\\n", .{num_missing_items});
        }
    }
    std.debug.print("\\n================================================\\n\\n", .{});
}

fn printTruncatedStart(comptime T: type, window_start: usize) void {
    if (window_start == 0) return;
    if (T == u8) {
        std.debug.print("... truncated, start index: 0x{X} ...\\n", .{window_start});
    } else {
        std.debug.print("... truncated ...\\n", .{});
    }
}

fn writeDiffer(comptime T: type, start_index: usize, expected: []const T, actual: []const T) void {
    if (T == u8) return writeBytes(expected);
    for (expected, 0..) |value, i| {
        if (@typeInfo(T) == .pointer) {
            std.debug.print("[{}]{*}: {any}\\n", .{ start_index + i, value, value });
        } else {
            std.debug.print("[{}]: {any}\\n", .{ start_index + i, value });
        }
    }
}

fn writeBytes(expected: []const u8) void {
    var row: usize = 0;
    while (row * 16 < expected.len) : (row += 1) {
        const chunk = expected[row * 16 .. @min(expected.len, row * 16 + 16)];
        for (chunk, 0..) |byte, col| {
            std.debug.print("{X:0>2} ", .{byte});
            if (col == 7) std.debug.print(" ", .{});
        }
        std.debug.print(" ", .{});
        if (chunk.len < 16) {
            var missing_columns = (16 - chunk.len) * 3;
            if (chunk.len < 8) missing_columns += 1;
            for (0..missing_columns) |_| std.debug.print(" ", .{});
        }
        for (chunk) |byte| {
            if (std.ascii.isPrint(byte)) {
                std.debug.print("{c}", .{byte});
            } else switch (byte) {
                '\\n' => std.debug.print("␊", .{}),
                '\\r' => std.debug.print("␍", .{}),
                '\\t' => std.debug.print("␉", .{}),
                else => std.debug.print(".", .{}),
            }
        }
        std.debug.print("\\n", .{});
    }
}

pub fn expectEqualSentinel(comptime T: type, comptime sentinel: T, expected: [:sentinel]const T, actual: [:sentinel]const T) !void {
    try expectEqualSlices(T, expected, actual);
    if (expected[expected.len] != actual[actual.len]) {
        failPrint("expected sentinel {any}, found {any}\\n", .{ expected[expected.len], actual[actual.len] });
        return error.TestExpectedEqual;
    }
}

pub fn expectError(expected_error: anyerror, actual_error_union: anytype) !void {
    if (actual_error_union) |actual_payload| {
        failPrint("expected error.{s}, found {any}\\n", .{ @errorName(expected_error), actual_payload });
        return error.TestExpectedError;
    } else |actual_error| {
        if (expected_error != actual_error) {
            failPrint("expected error.{s}, found error.{s}\\n", .{
                @errorName(expected_error),
                @errorName(actual_error),
            });
            return error.TestUnexpectedError;
        }
    }
}

pub fn expectFmt(expected: []const u8, comptime template: []const u8, args: anytype) !void {
    const actual = try std.fmt.allocPrint(allocator, template, args);
    defer allocator.free(actual);
    return expectEqualStrings(expected, actual);
}

pub fn expectEqualStrings(expected: []const u8, actual: []const u8) !void {
    if (findDiff(actual, expected)) |diff_index| {
        failPrint("\\n====== expected this output: =========\\n", .{});
        failPrintWithVisibleNewlines(expected);
        failPrint("\\n======== instead found this: =========\\n", .{});
        failPrintWithVisibleNewlines(actual);
        failPrint("\\n======================================\\n", .{});
        var diff_line_number: usize = 1;
        for (expected[0..diff_index]) |value| {
            if (value == '\\n') diff_line_number += 1;
        }
        failPrint("First difference occurs on line {d}:\\n", .{diff_line_number});
        failPrint("expected:\\n", .{});
        failPrintIndicatorLine(expected, diff_index);
        failPrint("found:\\n", .{});
        failPrintIndicatorLine(actual, diff_index);
        return error.TestExpectedEqual;
    }
}

fn findDiff(a: []const u8, b: []const u8) ?usize {
    const shortest = @min(a.len, b.len);
    var index: usize = 0;
    while (index < shortest) : (index += 1) {
        if (a[index] != b[index]) return index;
    }
    return if (a.len == b.len) null else shortest;
}

pub fn expectStringStartsWith(actual: []const u8, expected_starts_with: []const u8) !void {
    if (std.mem.startsWith(u8, actual, expected_starts_with)) return;
    const shortened_actual = if (actual.len >= expected_starts_with.len) actual[0..expected_starts_with.len] else actual;
    failPrint("\\n====== expected to start with: =========\\n", .{});
    failPrintWithVisibleNewlines(expected_starts_with);
    failPrint("\\n====== instead started with: ===========\\n", .{});
    failPrintWithVisibleNewlines(shortened_actual);
    failPrint("\\n========= full output: ==============\\n", .{});
    failPrintWithVisibleNewlines(actual);
    failPrint("\\n======================================\\n", .{});
    return error.TestExpectedStartsWith;
}

pub fn expectStringEndsWith(actual: []const u8, expected_ends_with: []const u8) !void {
    if (std.mem.endsWith(u8, actual, expected_ends_with)) return;
    const shortened_actual = if (actual.len >= expected_ends_with.len) actual[(actual.len - expected_ends_with.len)..] else actual;
    failPrint("\\n====== expected to end with: =========\\n", .{});
    failPrintWithVisibleNewlines(expected_ends_with);
    failPrint("\\n====== instead ended with: ===========\\n", .{});
    failPrintWithVisibleNewlines(shortened_actual);
    failPrint("\\n========= full output: ==============\\n", .{});
    failPrintWithVisibleNewlines(actual);
    failPrint("\\n======================================\\n", .{});
    return error.TestExpectedEndsWith;
}

pub fn failPrintIndicatorLine(source: []const u8, indicator_index: usize) void {
    const line_begin_index = if (std.mem.findScalarLast(u8, source[0..indicator_index], '\\n')) |line_begin|
        line_begin + 1
    else
        0;
    const line_end_index = if (std.mem.findScalar(u8, source[indicator_index..], '\\n')) |line_end|
        (indicator_index + line_end)
    else
        source.len;
    failPrintLine(source[line_begin_index..line_end_index]);
    for (line_begin_index..indicator_index) |_|
        failPrint(" ", .{});
    if (indicator_index >= source.len)
        failPrint("^ (end of string)\\n", .{})
    else
        failPrint("^ ('\\\\x{x:0>2}')\\n", .{source[indicator_index]});
}

pub fn failPrintWithVisibleNewlines(source: []const u8) void {
    var i: usize = 0;
    while (std.mem.findScalar(u8, source[i..], '\\n')) |nl| : (i += nl + 1) {
        failPrintLine(source[i..][0..nl]);
    }
    failPrint("{s}␃\\n", .{source[i..]});
}

pub fn failPrintLine(line: []const u8) void {
    if (line.len != 0) switch (line[line.len - 1]) {
        ' ', '\\t' => return failPrint("{s}⏎\\n", .{line}),
        else => {},
    };
    failPrint("{s}\\n", .{line});
}
`;

let testing: StructType | undefined;

/** `std.testing`, whose declarations the compiler analyzes from their source on first use. */
export function testingNamespace(): StructType {
  if (testing) return testing;
  const file: SourceFile = withPublicSurface(parseZig(SOURCE), 'testing');
  const namespace: Namespace = { name: 'testing', decls: new Map(), internal: true };
  addDecls(namespace, file.members);
  testing = { kind: 'struct', isTuple: false, namespace, layout: 'auto', fields: [] };
  return testing;
}
