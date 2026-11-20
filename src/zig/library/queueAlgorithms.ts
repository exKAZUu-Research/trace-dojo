/*
Adapted from Zig 0.17.1 lib/std/priority_queue.zig movement bodies; T is bound by the caller.
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

import type { SourceFile, Span } from '../ast';
import { parseZig } from '../parse';
import type { Frame } from '../runtime';
import type { SemaApi, TExpr } from '../semaBase';
import { pointerTo, type StructType, TYPE, type Type, USIZE } from '../types';
import { Pointer, type Value, type ZStruct } from '../values';

const SOURCE = `const std = @import("std");
const assert = std.debug.assert;
fn pushUnchecked(self: *Self, elem: T) void {
    self.items.len += 1;
    self.items[self.items.len - 1] = elem;
    siftUp(self, self.items.len - 1);
}
fn siftUp(self: *Self, start_index: usize) void {
    const child = self.items[start_index];
    var child_index = start_index;
    while (child_index > 0) {
        const parent_index = ((child_index - 1) >> 1);
        const parent = self.items[parent_index];
        if (compareFn(self.context, child, parent) != .lt) break;
        self.items[child_index] = parent;
        child_index = parent_index;
    }
    self.items[child_index] = child;
}
fn popIndex(self: *Self, index: usize) T {
    assert(self.items.len > index);
    const last = self.items[self.items.len - 1];
    const item = self.items[index];
    self.items[index] = last;
    self.items.len -= 1;

    if (index == self.items.len) {
    } else if (index == 0) {
        siftDown(self, index);
    } else {
        const parent_index = ((index - 1) >> 1);
        const parent = self.items[parent_index];
        if (compareFn(self.context, last, parent) == .gt) {
            siftDown(self, index);
        } else {
            siftUp(self, index);
        }
    }

    return item;
}
fn siftDown(self: *Self, target_index: usize) void {
    const target_element = self.items[target_index];
    var index = target_index;
    while (true) {
        var lesser_child_i = (std.math.mul(usize, index, 2) catch break) | 1;
        if (!(lesser_child_i < self.items.len)) break;

        const next_child_i = lesser_child_i + 1;
        if (next_child_i < self.items.len and compareFn(self.context, self.items[next_child_i], self.items[lesser_child_i]) == .lt) {
            lesser_child_i = next_child_i;
        }

        if (compareFn(self.context, target_element, self.items[lesser_child_i]) == .lt) break;

        self.items[index] = self.items[lesser_child_i];
        index = lesser_child_i;
    }
    self.items[index] = target_element;
}
`;

const files = new WeakMap<StructType, SourceFile>();

export interface QueueAlgorithms {
  push: (frame: Frame, queue: ZStruct, value: Value) => Value;
  popIndex: (frame: Frame, queue: ZStruct, index: bigint) => Value;
}

export function queueAlgorithms(
  sema: SemaApi,
  queue: StructType,
  element: Type,
  comparator: TExpr,
  span: Span
): QueueAlgorithms {
  const value = sema.knownFunctionValue(comparator, span);
  let file = files.get(queue);
  if (!file) {
    file = parseZig(SOURCE);
    files.set(queue, file);
  }
  const members = { Self: { type: TYPE, value: queue }, compareFn: { type: comparator.type, value } };
  const options = { namespaceName: 'std.priority_queue', members };
  const pointer = pointerTo(queue, false);
  const push = sema.libraryFunction(file, element, 'pushUnchecked', [pointer, element], span, options);
  const pop = sema.libraryFunction(file, element, 'popIndex', [pointer, USIZE], span, options);
  const invoke = (frame: Frame, queue: ZStruct, argument: Value, fn: typeof push): Value =>
    sema.callFunction(fn, [new Pointer({ slots: [queue] }, 0), argument], frame, span.row);
  return {
    push: (frame, queue, value) => invoke(frame, queue, value, push),
    popIndex: (frame, queue, index) => invoke(frame, queue, index, pop),
  };
}
