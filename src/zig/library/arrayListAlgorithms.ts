/*
Adapted from Zig 0.17.1 lib/std/array_list.zig mutation bodies; T is bound by the caller.
The MIT License (Expat)

Copyright (c) Zig contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

import type { Span } from '../ast';
import type { FunctionInstance } from '../functions';
import { parseZig } from '../parse';
import type { SemaApi } from '../semaBase';
import { pointerTo, sliceOf, type StructType, type Type, USIZE } from '../types';

const SOURCE = `const std = @import("std");
fn orderedRemoveMany(self: *std.ArrayList(T), sorted_indexes: []const usize) void {
    if (self.pointer_stability.state != .unlocked) unreachable;
    if (sorted_indexes.len == 0) return;
    var shift: usize = 1;
    for (sorted_indexes[0 .. sorted_indexes.len - 1], sorted_indexes[1..]) |removed, end| {
        if (removed == end) continue;
        const start = removed + 1;
        const len = end - start;
        @memmove(self.items[start - shift ..][0..len], self.items[start..][0..len]);
        shift += 1;
    }
    const start = sorted_indexes[sorted_indexes.len - 1] + 1;
    const end = self.items.len;
    const len = end - start;
    @memmove(self.items[start - shift ..][0..len], self.items[start..][0..len]);
    self.items.len = end - shift;
}
fn addManyAtAssumeCapacity(self: *std.ArrayList(T), index: usize, count: usize) []T {
    if (self.pointer_stability.state != .unlocked) unreachable;
    const new_len = self.items.len + count;
    std.debug.assert(self.capacity >= new_len);
    const to_move = self.items[index..];
    self.items.len = new_len;
    @memmove(self.items[index + count ..][0..to_move.len], to_move);
    const result = self.items[index..][0..count];
    @memset(result, undefined);
    return result;
}
fn appendSliceAssumeCapacity(self: *std.ArrayList(T), items: []const T) void {
    const old_len = self.items.len;
    const new_len = old_len + items.len;
    std.debug.assert(new_len <= self.capacity);
    self.items.len = new_len;
    @memcpy(self.items[old_len..][0..items.len], items);
}
fn insertSliceAssumeCapacity(self: *std.ArrayList(T), index: usize, items: []const T) void {
    const dst = addManyAtAssumeCapacity(self, index, items.len);
    @memcpy(dst, items);
}
fn replaceRangeAssumeCapacity(self: *std.ArrayList(T), start: usize, len: usize, new_items: []const T) void {
    std.debug.assert(self.capacity - self.items.len >= new_items.len -| len);
    if (self.pointer_stability.state != .unlocked) unreachable;
    const tail = self.items[start + len ..];
    const vacated = self.items[self.items.len - (len -| new_items.len) ..];
    self.items.len = self.items.len - len + new_items.len;
    @memmove(self.items[start + new_items.len ..], tail);
    @memcpy(self.items[start..][0..new_items.len], new_items);
    @memset(vacated, undefined);
}

`;

let file: ReturnType<typeof parseZig> | undefined;

export function orderedRemover(sema: SemaApi, child: Type, list: StructType, span: Span): FunctionInstance {
  file ??= parseZig(SOURCE);
  return sema.libraryFunction(file, child, 'orderedRemoveMany', [pointerTo(list, false), sliceOf(USIZE, true)], span, {
    namespaceName: 'std.array_list',
  });
}

export function sliceMutator(
  sema: SemaApi,
  child: Type,
  list: StructType,
  name: 'appendSlice' | 'insertSlice' | 'replaceRange',
  span: Span
): FunctionInstance {
  file ??= parseZig(SOURCE);
  const params = [
    pointerTo(list, false),
    ...(name === 'appendSlice' ? [] : [USIZE]),
    ...(name === 'replaceRange' ? [USIZE] : []),
    sliceOf(child, true),
  ];
  return sema.libraryFunction(file, child, `${name}AssumeCapacity`, params, span, { namespaceName: 'std.array_list' });
}
