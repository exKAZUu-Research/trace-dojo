import { FileSystemError, type FileSystemErrorCode } from '../../interpreter/programIo';
import type { SourceFile, Span } from '../ast';
import { parseZig } from '../parse';
import type { Frame } from '../runtime';
import { addDecls, runtime, type SemaApi } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  type Decl,
  type EnumType,
  errorSetOf,
  errorUnionOf,
  type Namespace,
  optionalOf,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  U8,
  USIZE,
  VOID,
} from '../types';
import { decodeUtf8 } from '../utf8';
import { ErrorValue, type NativeHandle, NULL, type Slice, type Value, ZStruct } from '../values';
import { compileArgs, expectArgs, fnMember, handle, type Member } from './native';
import { withPublicSurface } from './portedSurface';

/**
 * The parts of `std.Io` that read standard input and files and that manage files and directories, ported from Zig
 * 0.17's library. Native functions read and write the run's virtual file system, which Java's programs share.
 */
const SOURCE = `
const std = @import("std");

pub const Limit = enum(usize) {
    nothing = 0,
    unlimited = std.math.maxInt(usize),
    _,

    pub fn limited(n: usize) Limit {
        return @enumFromInt(n);
    }

    pub fn slice(l: Limit, s: []u8) []u8 {
        return s[0..@min(s.len, @intFromEnum(l))];
    }
};

pub const Reader = struct {
    buffer: []u8,
    seek: usize,
    end: usize,
    descriptor: ?usize,

    pub const Error = error{ ReadFailed, EndOfStream };
    pub const ShortError = error{ReadFailed};
    pub const DelimiterError = error{ ReadFailed, EndOfStream, StreamTooLong };
    pub const LimitedAllocError = std.mem.Allocator.Error || ShortError || error{StreamTooLong};
    pub const StreamError = error{ ReadFailed, WriteFailed, EndOfStream };
    pub const StreamRemainingError = error{ ReadFailed, WriteFailed };
    pub const StreamDelimiterLimitError = error{ ReadFailed, WriteFailed, StreamTooLong };
    pub const DiscardDelimiterLimitError = error{ ReadFailed, StreamTooLong };
    pub const ReadAllocError = Error || std.mem.Allocator.Error;
    pub const TakeEnumError = Error || error{InvalidEnumTag};

    pub fn fixed(bytes: []const u8) Reader {
        return .{ .buffer = @constCast(bytes), .seek = 0, .end = bytes.len, .descriptor = null };
    }

    pub fn buffered(r: *Reader) []u8 {
        return r.buffer[r.seek..r.end];
    }

    pub fn bufferedLen(r: *const Reader) usize {
        return r.end - r.seek;
    }

    pub fn toss(r: *Reader, n: usize) void {
        r.seek += n;
        if (r.seek > r.end) @panic("reached unreachable code");
    }

    pub fn tossBuffered(r: *Reader) void {
        r.seek = r.end;
    }

    fn readMore(r: *Reader) Error!void {
        const descriptor = r.descriptor orelse return error.EndOfStream;
        const n = try readInput(descriptor, r.buffer[r.end..]);
        if (n == 0) return error.EndOfStream;
        r.end += n;
    }

    pub fn rebase(r: *Reader, capacity: usize) Error!void {
        if (r.buffer.len - r.seek >= capacity) return;
        if (capacity > r.buffer.len) @panic("reached unreachable code");
        const data = r.buffer[r.seek..r.end];
        @memmove(r.buffer[0..data.len], data);
        r.seek = 0;
        r.end = data.len;
    }

    pub fn fill(r: *Reader, n: usize) Error!void {
        if (r.seek + n <= r.end) return;
        try r.rebase(n);
        while (r.end < r.seek + n) try r.readMore();
    }

    pub fn fillMore(r: *Reader) Error!void {
        try r.rebase(r.end - r.seek + 1);
        try r.readMore();
    }

    pub fn peek(r: *Reader, n: usize) Error![]u8 {
        try r.fill(n);
        return r.buffer[r.seek..][0..n];
    }

    pub fn peekGreedy(r: *Reader, n: usize) Error![]u8 {
        try r.fill(n);
        return r.buffer[r.seek..r.end];
    }

    pub fn take(r: *Reader, n: usize) Error![]u8 {
        const result = try r.peek(n);
        r.toss(n);
        return result;
    }

    pub fn takeArray(r: *Reader, comptime n: usize) Error!*[n]u8 {
        return (try r.take(n))[0..n];
    }

    pub fn peekArray(r: *Reader, comptime n: usize) Error!*[n]u8 {
        return (try r.peek(n))[0..n];
    }

    pub fn peekByte(r: *Reader) Error!u8 {
        if (r.seek < r.end) return r.buffer[r.seek];
        try r.fill(1);
        return r.buffer[r.seek];
    }

    pub fn takeByte(r: *Reader) Error!u8 {
        const result = try r.peekByte();
        r.seek += 1;
        return result;
    }

    pub fn takeByteSigned(r: *Reader) Error!i8 {
        return @bitCast(try r.takeByte());
    }

    pub fn discardAll(r: *Reader, n: usize) Error!void {
        if ((try r.discardShort(n)) != n) return error.EndOfStream;
    }

    pub fn discardShort(r: *Reader, n: usize) ShortError!usize {
        var remaining = n;
        while (remaining > 0) {
            if (r.seek == r.end) r.fillMore() catch |err| switch (err) {
                error.EndOfStream => return n - remaining,
                error.ReadFailed => return error.ReadFailed,
            };
            const step = @min(remaining, r.end - r.seek);
            r.seek += step;
            remaining -= step;
        }
        return n;
    }

    pub fn discardRemaining(r: *Reader) ShortError!usize {
        var count: usize = 0;
        while (true) {
            count += r.end - r.seek;
            r.seek = r.end;
            r.fillMore() catch |err| switch (err) {
                error.EndOfStream => return count,
                error.ReadFailed => return error.ReadFailed,
            };
        }
    }

    pub fn readSliceShort(r: *Reader, buffer: []u8) ShortError!usize {
        var i: usize = 0;
        while (i < buffer.len) {
            if (r.buffer.len == 0) {
                // An unbuffered reader reads straight into the destination.
                const n = try readInput(r.descriptor orelse return i, buffer[i..]);
                if (n == 0) return i;
                i += n;
                continue;
            }
            if (r.seek == r.end) r.fillMore() catch |err| switch (err) {
                error.EndOfStream => return i,
                error.ReadFailed => return error.ReadFailed,
            };
            const n = @min(buffer.len - i, r.end - r.seek);
            @memcpy(buffer[i..][0..n], r.buffer[r.seek..][0..n]);
            r.seek += n;
            i += n;
        }
        return i;
    }

    pub fn readSliceAll(r: *Reader, buffer: []u8) Error!void {
        const n = try r.readSliceShort(buffer);
        if (n != buffer.len) return error.EndOfStream;
    }

    pub fn peekDelimiterInclusive(r: *Reader, delimiter: u8) DelimiterError![]u8 {
        if (std.mem.findScalarPos(u8, r.buffer[0..r.end], r.seek, delimiter)) |end| return r.buffer[r.seek .. end + 1];
        while (true) {
            const content_len = r.end - r.seek;
            if (r.buffer.len - content_len == 0) break;
            try r.fillMore();
            if (std.mem.findScalarPos(u8, r.buffer[0..r.end], r.seek + content_len, delimiter)) |end|
                return r.buffer[r.seek .. end + 1];
        }
        const descriptor = r.descriptor orelse return error.EndOfStream;
        if (inputAtEnd(descriptor)) return error.EndOfStream;
        return error.StreamTooLong;
    }

    pub fn takeDelimiterInclusive(r: *Reader, delimiter: u8) DelimiterError![]u8 {
        const result = try r.peekDelimiterInclusive(delimiter);
        r.toss(result.len);
        return result;
    }

    pub fn peekDelimiterExclusive(r: *Reader, delimiter: u8) DelimiterError![]u8 {
        const result = r.peekDelimiterInclusive(delimiter) catch |err| switch (err) {
            error.EndOfStream => {
                const remaining = r.buffer[r.seek..r.end];
                if (remaining.len == 0) return error.EndOfStream;
                return remaining;
            },
            else => |e| return e,
        };
        return result[0 .. result.len - 1];
    }

    pub fn takeDelimiterExclusive(r: *Reader, delimiter: u8) DelimiterError![]u8 {
        const result = try r.peekDelimiterExclusive(delimiter);
        r.toss(result.len);
        return result;
    }

    pub fn takeDelimiter(r: *Reader, delimiter: u8) error{ ReadFailed, StreamTooLong }!?[]u8 {
        const inclusive = r.peekDelimiterInclusive(delimiter) catch |err| switch (err) {
            error.EndOfStream => {
                const remaining = r.buffer[r.seek..r.end];
                if (remaining.len == 0) return null;
                r.toss(remaining.len);
                return remaining;
            },
            else => |e| return e,
        };
        r.toss(inclusive.len);
        return inclusive[0 .. inclusive.len - 1];
    }

    pub fn discardDelimiterInclusive(r: *Reader, delimiter: u8) Error!usize {
        var count: usize = 0;
        while (true) {
            if (std.mem.findScalarPos(u8, r.buffer[0..r.end], r.seek, delimiter)) |end| {
                count += end + 1 - r.seek;
                r.seek = end + 1;
                return count;
            }
            count += r.end - r.seek;
            r.seek = r.end;
            try r.fillMore();
        }
    }

    pub fn stream(r: *Reader, w: *Io.Writer, limit: Limit) StreamError!usize {
        if (r.seek == r.end) try r.fillMore();
        const buffer = limit.slice(r.buffer[r.seek..r.end]);
        try w.writeAll(buffer);
        r.seek += buffer.len;
        return buffer.len;
    }

    pub fn streamExact(r: *Reader, w: *Io.Writer, n: usize) StreamError!void {
        var remaining = n;
        while (remaining != 0) remaining -= try r.stream(w, .limited(remaining));
    }

    pub fn streamExact64(r: *Reader, w: *Io.Writer, n: u64) StreamError!void {
        try r.streamExact(w, @intCast(n));
    }

    pub fn streamRemaining(r: *Reader, w: *Io.Writer) StreamRemainingError!usize {
        var offset: usize = 0;
        while (true) {
            offset += r.stream(w, .unlimited) catch |err| switch (err) {
                error.EndOfStream => return offset,
                else => |e| return e,
            };
        }
    }

    pub fn streamDelimiter(r: *Reader, w: *Io.Writer, delimiter: u8) StreamError!usize {
        const n = r.streamDelimiterLimit(w, delimiter, .unlimited) catch |err| switch (err) {
            error.StreamTooLong => unreachable,
            else => |e| return e,
        };
        if (r.seek == r.end) return error.EndOfStream;
        return n;
    }

    pub fn streamDelimiterEnding(r: *Reader, w: *Io.Writer, delimiter: u8) StreamRemainingError!usize {
        return r.streamDelimiterLimit(w, delimiter, .unlimited) catch |err| switch (err) {
            error.StreamTooLong => unreachable,
            else => |e| return e,
        };
    }

    pub fn streamDelimiterLimit(r: *Reader, w: *Io.Writer, delimiter: u8, limit: Limit) StreamDelimiterLimitError!usize {
        var remaining = @intFromEnum(limit);
        while (remaining != 0) {
            const available = Limit.limited(remaining).slice(r.peekGreedy(1) catch |err| switch (err) {
                error.ReadFailed => |e| return e,
                error.EndOfStream => return @intFromEnum(limit) - remaining,
            });
            if (std.mem.findScalar(u8, available, delimiter)) |delimiter_index| {
                try w.writeAll(available[0..delimiter_index]);
                r.toss(delimiter_index);
                remaining -= delimiter_index;
                return @intFromEnum(limit) - remaining;
            }
            try w.writeAll(available);
            r.toss(available.len);
            remaining -= available.len;
        }
        return error.StreamTooLong;
    }

    pub fn discardDelimiterExclusive(r: *Reader, delimiter: u8) ShortError!usize {
        return r.discardDelimiterLimit(delimiter, .unlimited) catch |err| switch (err) {
            error.StreamTooLong => unreachable,
            else => |e| return e,
        };
    }

    pub fn discardDelimiterLimit(r: *Reader, delimiter: u8, limit: Limit) DiscardDelimiterLimitError!usize {
        var remaining = @intFromEnum(limit);
        while (remaining != 0) {
            const available = Limit.limited(remaining).slice(r.peekGreedy(1) catch |err| switch (err) {
                error.ReadFailed => |e| return e,
                error.EndOfStream => return @intFromEnum(limit) - remaining,
            });
            if (std.mem.findScalar(u8, available, delimiter)) |delimiter_index| {
                r.toss(delimiter_index);
                remaining -= delimiter_index;
                return @intFromEnum(limit) - remaining;
            }
            r.toss(available.len);
            remaining -= available.len;
        }
        return error.StreamTooLong;
    }

    pub fn discard(r: *Reader, limit: Limit) Error!usize {
        if (r.seek == r.end) try r.fillMore();
        const n = @min(r.end - r.seek, @intFromEnum(limit));
        r.seek += n;
        return n;
    }

    pub fn discardAll64(r: *Reader, n: u64) Error!void {
        try r.discardAll(@intCast(n));
    }

    pub fn peekSentinel(r: *Reader, comptime sentinel: u8) DelimiterError![:sentinel]u8 {
        const result = try r.peekDelimiterInclusive(sentinel);
        return result[0 .. result.len - 1 :sentinel];
    }

    pub fn takeSentinel(r: *Reader, comptime sentinel: u8) DelimiterError![:sentinel]u8 {
        const result = try r.peekSentinel(sentinel);
        r.toss(result.len + 1);
        return result;
    }

    pub fn readAllocAll(r: *Reader, allocator: std.mem.Allocator, len: usize) ReadAllocError![]u8 {
        const dest = try allocator.alloc(u8, len);
        errdefer allocator.free(dest);
        try r.readSliceAll(dest);
        return dest;
    }

    pub fn readAllocShort(r: *Reader, allocator: std.mem.Allocator, len: usize) ReadAllocError![]u8 {
        const dest = try allocator.alloc(u8, len);
        errdefer allocator.free(dest);
        const n = try r.readSliceShort(dest);
        if (n == dest.len) return dest;
        return try allocator.realloc(dest, n);
    }

    pub fn appendRemaining(r: *Reader, gpa: std.mem.Allocator, list: *std.ArrayList(u8), limit: Limit) LimitedAllocError!void {
        const data = try r.allocRemaining(gpa, if (limit == .unlimited) limit else .limited(@intFromEnum(limit) -| list.items.len));
        defer gpa.free(data);
        try list.appendSlice(gpa, data);
    }

    pub fn appendExact(r: *Reader, gpa: std.mem.Allocator, list: *std.ArrayList(u8), n: usize) (std.mem.Allocator.Error || Error)!void {
        const data = try r.take(n);
        try list.appendSlice(gpa, data);
    }

    pub inline fn takeInt(r: *Reader, comptime T: type, endian: std.builtin.Endian) Error!T {
        const n = @divExact(@typeInfo(T).int.bits, 8);
        return readInt(T, try r.take(n), endian);
    }

    pub inline fn peekInt(r: *Reader, comptime T: type, endian: std.builtin.Endian) Error!T {
        const n = @divExact(@typeInfo(T).int.bits, 8);
        return readInt(T, try r.peek(n), endian);
    }

    pub fn takeVarInt(r: *Reader, comptime Int: type, endian: std.builtin.Endian, n: usize) Error!Int {
        return readInt(Int, try r.take(n), endian);
    }

    pub fn takeEnum(r: *Reader, comptime Enum: type, endian: std.builtin.Endian) TakeEnumError!Enum {
        const Tag = @typeInfo(Enum).@"enum".tag_type;
        const int = try r.takeInt(Tag, endian);
        return std.enums.fromInt(Enum, int) orelse return error.InvalidEnumTag;
    }

    fn readInt(comptime T: type, bytes: []const u8, endian: std.builtin.Endian) T {
        const U = @Int(.unsigned, @typeInfo(T).int.bits);
        var result: U = 0;
        for (0..bytes.len) |i| {
            const byte = if (endian == .little) bytes[bytes.len - 1 - i] else bytes[i];
            result = (result << 8) | byte;
        }
        return @bitCast(result);
    }

    pub fn allocRemaining(r: *Reader, gpa: std.mem.Allocator, limit: Limit) LimitedAllocError![]u8 {
        var list: std.ArrayList(u8) = .empty;
        errdefer list.deinit(gpa);
        var spare: [4096]u8 = undefined;
        while (true) {
            const data = if (r.buffer.len == 0) blk: {
                const descriptor = r.descriptor orelse break;
                const n = try readInput(descriptor, &spare);
                if (n == 0) break;
                break :blk spare[0..n];
            } else r.buffer[r.seek..r.end];
            if (limit != .unlimited and list.items.len + data.len > @intFromEnum(limit)) return error.StreamTooLong;
            try list.appendSlice(gpa, data);
            if (r.buffer.len == 0) continue;
            r.seek = r.end;
            r.fillMore() catch |err| switch (err) {
                error.EndOfStream => break,
                error.ReadFailed => return error.ReadFailed,
            };
        }
        return list.toOwnedSlice(gpa);
    }
};

pub const File = struct {
    pub const OpenError = error{
        SharingViolation,
        PipeBusy,
        NoDevice,
        PathAlreadyExists,
        FileNotFound,
        AccessDenied,
        PermissionDenied,
        FileTooBig,
        IsDir,
        SymLinkLoop,
        ProcessFdQuotaExceeded,
        SystemFdQuotaExceeded,
        NameTooLong,
        SystemResources,
        NoSpaceLeft,
        NotDir,
        DeviceBusy,
        FileLocksUnsupported,
        FileBusy,
        WouldBlock,
        BadPathName,
        NetworkNotFound,
        Unexpected,
        Canceled,
    };

    pub const Kind = enum {
        block_device,
        character_device,
        directory,
        named_pipe,
        sym_link,
        file,
        unix_domain_socket,
        whiteout,
        door,
        event_port,
        unknown,
    };

    pub const Stat = struct {
        size: u64,
        kind: Kind,
    };

    pub const Reader = struct {
        interface: Io.Reader,

        pub fn atEnd(r: *File.Reader) bool {
            return r.interface.bufferedLen() == 0 and inputAtEnd(r.interface.descriptor.?);
        }
    };
};

pub fn Future(Result: type) type {
    return struct {
        result: Result,

        pub fn cancel(f: *@This(), io: Io) Result {
            _ = io;
            return f.result;
        }

        pub fn await(f: *@This(), io: Io) Result {
            _ = io;
            return f.result;
        }
    };
}

/// Runs the function to its end when it is called, so that what runs asynchronously runs in the order it starts.
pub fn async(io: Io, function: anytype, args: anytype) Future(@typeInfo(@TypeOf(function)).@"fn".return_type.?) {
    _ = io;
    return .{ .result = @call(.auto, function, args) };
}

pub fn concurrent(io: Io, function: anytype, args: anytype) error{ConcurrencyUnavailable}!Future(@typeInfo(@TypeOf(function)).@"fn".return_type.?) {
    _ = io;
    return .{ .result = @call(.auto, function, args) };
}

pub const Group = struct {
    state: usize,

    pub const init: Group = .{ .state = 0 };

    pub fn async(g: *Group, io: Io, function: anytype, args: anytype) void {
        _ = g;
        _ = io;
        _ = @as(error{Canceled}!void, @call(.auto, function, args)) catch {};
    }

    pub fn concurrent(g: *Group, io: Io, function: anytype, args: anytype) error{ConcurrencyUnavailable}!void {
        g.async(io, function, args);
    }

    pub fn await(g: *Group, io: Io) error{Canceled}!void {
        _ = g;
        _ = io;
    }

    pub fn cancel(g: *Group, io: Io) void {
        _ = g;
        _ = io;
    }
};

/// The errors that the virtual file system gives, which each function below may return.
pub const FsError = error{ FileNotFound, PathAlreadyExists, IsDir, NotDir, DirNotEmpty, BadPathName };

pub const Dir = struct {
    path: []const u8,

    pub const OpenFileOptions = struct {
        mode: Mode = .read_only,

        pub const Mode = enum { read_only, write_only, read_write };
    };

    pub const CreateFileOptions = struct {
        read: bool = false,
        truncate: bool = true,
        exclusive: bool = false,
    };

    pub const WriteFileOptions = struct {
        sub_path: []const u8,
        data: []const u8,
        flags: CreateFileOptions = .{},
    };

    pub const OpenOptions = struct {
        access_sub_paths: bool = true,
        iterate: bool = false,
        follow_symlinks: bool = true,
    };

    pub const AccessOptions = struct {
        read: bool = false,
        write: bool = false,
        execute: bool = false,
        follow_symlinks: bool = true,
    };

    pub const StatFileOptions = struct {
        follow_symlinks: bool = true,
    };

    pub const Permissions = struct {
        bits: u32,

        pub const default_dir: Permissions = .{ .bits = 0o755 };
        pub const default_file: Permissions = .{ .bits = 0o644 };
    };

    pub const Entry = struct {
        name: []const u8,
        kind: File.Kind,
    };

    pub const Iterator = struct {
        dir: Dir,
        index: usize = 0,

        pub fn next(it: *Iterator, io: Io) error{ AccessDenied, PermissionDenied, SystemResources, Unexpected, Canceled }!?Entry {
            _ = io;
            const entry = listEntry(it.dir.path, it.index) orelse return null;
            it.index += 1;
            return .{ .name = entry, .kind = kindOf(it.dir.path, entry) };
        }

        pub fn reset(it: *Iterator) void {
            it.index = 0;
        }
    };

    pub fn cwd() Dir {
        return .{ .path = "." };
    }

    pub fn close(dir: Dir, io: Io) void {
        _ = dir;
        _ = io;
    }

    pub fn openFile(dir: Dir, io: Io, sub_path: []const u8, options: OpenFileOptions) (File.OpenError || FsError)!Io.File {
        _ = io;
        return openPath(dir.path, sub_path, @intFromEnum(options.mode), false, false, false);
    }

    pub fn createFile(dir: Dir, io: Io, sub_path: []const u8, flags: CreateFileOptions) (File.OpenError || FsError)!Io.File {
        _ = io;
        return openPath(dir.path, sub_path, if (flags.read) 2 else 1, true, flags.truncate, flags.exclusive);
    }

    pub fn writeFile(dir: Dir, io: Io, options: WriteFileOptions) (File.OpenError || FsError || Io.File.Writer.Error)!void {
        const file = try dir.createFile(io, options.sub_path, options.flags);
        defer file.close(io);
        try file.writeStreamingAll(io, options.data);
    }

    pub fn readFile(dir: Dir, io: Io, file_path: []const u8, buffer: []u8) (File.OpenError || FsError || Io.Reader.ShortError)![]u8 {
        const file = try dir.openFile(io, file_path, .{});
        defer file.close(io);
        var reader = file.reader(io, &.{});
        const n = try reader.interface.readSliceShort(buffer);
        return buffer[0..n];
    }

    pub fn readFileAlloc(dir: Dir, io: Io, file_path: []const u8, gpa: std.mem.Allocator, limit: Limit) (File.OpenError || FsError || Io.Reader.LimitedAllocError)![]u8 {
        const file = try dir.openFile(io, file_path, .{});
        defer file.close(io);
        var buffer: [4096]u8 = undefined;
        var reader = file.reader(io, &buffer);
        return reader.interface.allocRemaining(gpa, limit);
    }

    pub fn deleteFile(dir: Dir, io: Io, sub_path: []const u8) (FsError || error{ FileNotFound, IsDir, NotDir, AccessDenied, PermissionDenied, FileBusy, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!void {
        _ = io;
        return removePath(dir.path, sub_path, 0);
    }

    pub fn deleteDir(dir: Dir, io: Io, sub_path: []const u8) (FsError || error{ DirNotEmpty, FileNotFound, NotDir, AccessDenied, PermissionDenied, FileBusy, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!void {
        _ = io;
        return removePath(dir.path, sub_path, 1);
    }

    pub fn createDir(dir: Dir, io: Io, sub_path: []const u8, permissions: Permissions) (FsError || error{ PathAlreadyExists, FileNotFound, NotDir, AccessDenied, PermissionDenied, NoSpaceLeft, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!void {
        _ = io;
        _ = permissions;
        return makeDirectory(dir.path, sub_path, false);
    }

    pub fn createDirPath(dir: Dir, io: Io, sub_path: []const u8) (FsError || error{ PathAlreadyExists, FileNotFound, NotDir, AccessDenied, PermissionDenied, NoSpaceLeft, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!void {
        _ = io;
        return makeDirectory(dir.path, sub_path, true);
    }

    pub fn rename(old_dir: Dir, old_sub_path: []const u8, new_dir: Dir, new_sub_path: []const u8, io: Io) (FsError || error{ FileNotFound, PathAlreadyExists, IsDir, NotDir, DirNotEmpty, AccessDenied, PermissionDenied, FileBusy, NameTooLong, SystemResources, BadPathName, RenameAcrossMountPoints, Unexpected, Canceled })!void {
        _ = io;
        return renamePath(old_dir.path, old_sub_path, new_dir.path, new_sub_path);
    }

    pub fn access(dir: Dir, io: Io, sub_path: []const u8, options: AccessOptions) (FsError || error{ FileNotFound, AccessDenied, PermissionDenied, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!void {
        _ = io;
        _ = options;
        _ = try statPath(dir.path, sub_path);
    }

    pub fn statFile(dir: Dir, io: Io, sub_path: []const u8, options: StatFileOptions) (FsError || error{ FileNotFound, AccessDenied, PermissionDenied, NotDir, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!File.Stat {
        _ = io;
        _ = options;
        return statPath(dir.path, sub_path);
    }

    pub fn openDir(dir: Dir, io: Io, sub_path: []const u8, options: OpenOptions) (FsError || error{ FileNotFound, NotDir, AccessDenied, PermissionDenied, NameTooLong, SystemResources, BadPathName, Unexpected, Canceled })!Dir {
        _ = io;
        _ = options;
        const info = try statPath(dir.path, sub_path);
        if (info.kind != .directory) return error.NotDir;
        return .{ .path = joinPath(dir.path, sub_path) };
    }

    pub fn iterate(dir: Dir) Iterator {
        return .{ .dir = dir };
    }
};
`;

let io: StructType | undefined;
let nativeTypes: { io: Type; file: Type } | undefined;

/** Gives the ported library the native `std.Io` and `std.Io.File` types, which its declarations refer to. */
export function configureFiles(ioType: Type, fileType: Type): void {
  nativeTypes = { io: ioType, file: fileType };
}

/** The namespace of the ported library, whose types the native `std.Io` members refer to. */
export function filesNamespace(): StructType {
  if (io) return io;
  const types = nativeTypes;
  if (!types) throw new Error('configureFiles has not run');
  const file: SourceFile = withPublicSurface(parseZig(SOURCE), 'Io', false);
  const namespace: Namespace = { name: 'Io', decls: new Map(), internal: true };
  addDecls(namespace, file.members);
  const native = (name: string, member: () => Member): void => {
    let resolved: Member | undefined;
    namespace.decls.set(name, {
      kind: 'native',
      name,
      resolve: () => {
        resolved ??= member();
        return resolved;
      },
    });
  };
  native('Io', () => ({ type: TYPE, value: types.io }));
  for (const [name, member] of Object.entries(nativeMembers(types.file))) native(name, member);
  io = { kind: 'struct', isTuple: false, namespace, layout: 'auto', fields: [] };
  return io;
}

/** A declaration of the ported library by its name, such as the function `async`. */
export function filesDecl(name: string): Decl {
  const decl = filesNamespace().namespace.decls.get(name);
  if (!decl) throw new Error(`Io.${name} is missing`);
  return decl;
}

/** A declaration of the ported library, such as `Reader` or `File.Reader`, as a type. */
export function filesType(sema: SemaApi, path: string, span: Span): Type {
  let type: Type = filesNamespace();
  for (const name of path.split('.')) {
    const decl = sema.findDecl(type, name);
    if (!decl) throw new Error(`Io.${path} is missing`);
    type = sema.knownValue(sema.resolveDecl(decl, span), '型') as Type;
  }
  return type;
}

const ERROR_NAMES: Record<FileSystemErrorCode, string> = {
  ENOENT: 'FileNotFound',
  EEXIST: 'PathAlreadyExists',
  EISDIR: 'IsDir',
  ENOTDIR: 'NotDir',
  ENOTEMPTY: 'DirNotEmpty',
  EINVAL: 'BadPathName',
};

/** Runs a file system operation, giving the Zig error that a failure of it returns. */
function attempt(run: () => Value): Value {
  try {
    return run();
  } catch (error) {
    if (error instanceof FileSystemError) return ErrorValue.of(ERROR_NAMES[error.code]);
    throw error;
  }
}

function text(value: Value, frame: Frame): string {
  const slice = value as Slice;
  frame.runtime.spend(slice.length);
  return decodeUtf8(slice.values().map(Number));
}

function joined(directory: string, path: string): string {
  return path.startsWith('/') || directory === '.' ? path : `${directory}/${path}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The errors that the virtual file system's failures give, which every function of the library may return. */
const FILE_SYSTEM_ERROR = errorSetOf(Object.values(ERROR_NAMES));
const ANY_ERROR_UNION = (payload: Type): Type => errorUnionOf(FILE_SYSTEM_ERROR, payload);

/** A native function of the library, which compiles its arguments to the parameter types and runs `run`. */
function call(
  name: string,
  params: readonly Type[],
  result: (sema: SemaApi, span: Span) => Type,
  run: (frame: Frame, values: Value[], sema: SemaApi) => Value
): () => Member {
  return fnMember(name, (sema, nativeCall) => {
    const args = compileArgs(sema, expectArgs(sema, nativeCall, params.length, name), params);
    const evaluators = args.map((arg) => arg.eval);
    return runtime(
      result(sema, nativeCall.span),
      (frame) =>
        run(
          frame,
          evaluators.map((evaluate) => evaluate(frame)),
          sema
        ),
      nativeCall.span
    );
  });
}

/** The value of a field of `File.Kind` by its name. */
function kindValue(sema: SemaApi, span: Span): (name: string) => bigint {
  const fields = sema.enumFields(filesType(sema, 'File.Kind', span) as EnumType);
  return (name) => (fields.find((field) => field.name === name) as { value: bigint }).value;
}

/**
 * Opens a file for `std.Io.File`: to read when `mode` is 0, to write when 1, and both when 2, creating it with
 * `create`, as `openFile` and `createFile` do.
 */
function openPath(
  frame: Frame,
  target: string,
  mode: number,
  flags: { create: boolean; truncate: boolean; exclusive: boolean }
): Value {
  const files = frame.runtime.io.files;
  const writes = mode !== 0;
  if (files.kindOf(target) === 'directory' && (writes || flags.create)) throw new FileSystemError('EISDIR', target);
  const create = flags.create ? (flags.exclusive ? 'exclusive' : 'always') : 'never';
  const write = writes
    ? files.open(target, { create, truncate: flags.create && flags.truncate, append: false })
    : undefined;
  const read = mode === 1 ? undefined : files.openForReading(target);
  const descriptor = frame.runtime.openFile({ path: target, read, position: 0, write, decoder: new TextDecoder() });
  return handle('file', { fd: descriptor });
}

/** The native functions that the ported library calls, which reach the run's standard input and files. */
// code-gauge-allow functionNcss -- Each native is a short closure over the run's file system.
// code-gauge-allow functionCognitiveComplexity -- Each native is a short closure over the run's file system.
function nativeMembers(fileType: Type): Record<string, () => Member> {
  return {
    readInput: call(
      'readInput',
      [USIZE, sliceOf(U8, false)],
      () => errorUnionOf(errorSetOf(['ReadFailed']), USIZE),
      (frame, [descriptor, destination]) => {
        const slice = destination as Slice;
        const bytes = frame.runtime.readInput(Number(descriptor as bigint), slice.length);
        if (!bytes) return ErrorValue.of('ReadFailed');
        for (const [index, byte] of bytes.entries()) slice.set(index, BigInt(byte));
        return BigInt(bytes.length);
      }
    ),
    inputAtEnd: call(
      'inputAtEnd',
      [USIZE],
      () => BOOL,
      (frame, [descriptor]) => frame.runtime.inputAtEnd(Number(descriptor as bigint))
    ),
    openPath: call(
      'openPath',
      [CONST_U8_SLICE, CONST_U8_SLICE, U8, BOOL, BOOL, BOOL],
      () => ANY_ERROR_UNION(fileType),
      (frame, [directory, path, mode, create, truncate, exclusive]) =>
        attempt(() =>
          openPath(frame, joined(text(directory, frame), text(path, frame)), Number(mode as bigint), {
            create: create === true,
            truncate: truncate === true,
            exclusive: exclusive === true,
          })
        )
    ),
    removePath: call(
      'removePath',
      [CONST_U8_SLICE, CONST_U8_SLICE, U8],
      () => ANY_ERROR_UNION(VOID),
      (frame, args) =>
        attempt(() => {
          const [directory, path, kind] = args;
          frame.runtime.io.files.remove(
            joined(text(directory, frame), text(path, frame)),
            kind === 0n ? 'file' : 'directory'
          );
          return;
        })
    ),
    makeDirectory: call(
      'makeDirectory',
      [CONST_U8_SLICE, CONST_U8_SLICE, BOOL],
      () => ANY_ERROR_UNION(VOID),
      (frame, [directory, path, recursive]) =>
        attempt(() => {
          const target = joined(text(directory, frame), text(path, frame));
          const files = frame.runtime.io.files;
          // `createDirPath` succeeds when the directory exists already, as `mkdir -p` does.
          if (recursive === true && files.kindOf(target) === 'directory') return;
          files.createDirectory(target, recursive as boolean);
          return;
        })
    ),
    renamePath: call(
      'renamePath',
      [CONST_U8_SLICE, CONST_U8_SLICE, CONST_U8_SLICE, CONST_U8_SLICE],
      () => ANY_ERROR_UNION(VOID),
      (frame, [fromDirectory, from, toDirectory, to]) =>
        attempt(() => {
          frame.runtime.io.files.rename(
            joined(text(fromDirectory, frame), text(from, frame)),
            joined(text(toDirectory, frame), text(to, frame))
          );
          return;
        })
    ),
    statPath: fnMember('statPath', (sema, nativeCall) => {
      const args = compileArgs(sema, expectArgs(sema, nativeCall, 2, 'statPath'), [CONST_U8_SLICE, CONST_U8_SLICE]);
      const statType = filesType(sema, 'File.Stat', nativeCall.span);
      const kindOf = kindValue(sema, nativeCall.span);
      const [directory, path] = args.map((arg) => arg.eval);
      return runtime(
        ANY_ERROR_UNION(statType),
        (frame) => {
          const target = joined(text(directory(frame), frame), text(path(frame), frame));
          const files = frame.runtime.io.files;
          const kind = files.kindOf(target);
          if (!kind) return ErrorValue.of('FileNotFound');
          const size = kind === 'file' ? byteLength(files.readFile(target)) : 0;
          return new ZStruct([BigInt(size), kindOf(kind === 'directory' ? 'directory' : 'file')]);
        },
        nativeCall.span
      );
    }),
    kindOf: fnMember('kindOf', (sema, nativeCall) => {
      const args = compileArgs(sema, expectArgs(sema, nativeCall, 2, 'kindOf'), [CONST_U8_SLICE, CONST_U8_SLICE]);
      const kindType = filesType(sema, 'File.Kind', nativeCall.span);
      const kindOf = kindValue(sema, nativeCall.span);
      const [directory, name] = args.map((arg) => arg.eval);
      return runtime(
        kindType,
        (frame) => {
          const kind = frame.runtime.io.files.kindOf(joined(text(directory(frame), frame), text(name(frame), frame)));
          return kindOf(kind === 'directory' ? 'directory' : kind === 'file' ? 'file' : 'unknown');
        },
        nativeCall.span
      );
    }),
    listEntry: call(
      'listEntry',
      [CONST_U8_SLICE, USIZE],
      () => optionalOf(CONST_U8_SLICE),
      (frame, args, sema) =>
        attempt(() => {
          const [directory, index] = args;
          const name = frame.runtime.io.files.list(text(directory, frame))[Number(index as bigint)];
          return name === undefined ? NULL : sema.nameSlice(name, frame);
        })
    ),
    joinPath: call(
      'joinPath',
      [CONST_U8_SLICE, CONST_U8_SLICE],
      () => CONST_U8_SLICE,
      (frame, [directory, path], sema) => sema.nameSlice(joined(text(directory, frame), text(path, frame)), frame)
    ),
  };
}

/** The descriptor of a `std.Io.File`: 0 to 2 for the standard streams, and more for the files the program opened. */
export function fileDescriptor(value: Value): number {
  return (value as NativeHandle).state.fd as number;
}

/** The length of an open file in bytes. */
export function openFileLength(frame: Frame, descriptor: number): bigint {
  const file = frame.runtime.openFileAt(descriptor);
  return BigInt(file ? byteLength(frame.runtime.io.files.readFile(file.path)) : 0);
}
