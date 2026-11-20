/*
Adapted from Zig 0.17.1 lib/std/sort/block.zig; T is bound by the caller.
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

export const BLOCK_SORT_SOURCE = String.raw`const std = @import("std");
const sort = std.sort;
const math = std.math;
const mem = std.mem;
const Range = struct {
    start: usize,
    end: usize,
    fn init(start: usize, end: usize) Range {
        return Range{
            .start = start,
            .end = end,
        };
    }
    fn length(self: Range) usize {
        return self.end - self.start;
    }
};
const Iterator = struct {
    size: usize,
    power_of_two: usize,
    numerator: usize,
    decimal: usize,
    denominator: usize,
    decimal_step: usize,
    numerator_step: usize,
    fn init(size2: usize, min_level: usize) Iterator {
        const power_of_two = math.floorPowerOfTwo(usize, size2);
        const denominator = power_of_two / min_level;
        return Iterator{
            .numerator = 0,
            .decimal = 0,
            .size = size2,
            .power_of_two = power_of_two,
            .denominator = denominator,
            .decimal_step = size2 / denominator,
            .numerator_step = size2 % denominator,
        };
    }
    fn begin(self: *Iterator) void {
        self.numerator = 0;
        self.decimal = 0;
    }
    fn nextRange(self: *Iterator) Range {
        const start = self.decimal;
        self.decimal += self.decimal_step;
        self.numerator += self.numerator_step;
        if (self.numerator >= self.denominator) {
            self.numerator -= self.denominator;
            self.decimal += 1;
        }
        return Range{
            .start = start,
            .end = self.decimal,
        };
    }
    fn finished(self: *Iterator) bool {
        return self.decimal >= self.size;
    }
    fn nextLevel(self: *Iterator) bool {
        self.decimal_step += self.decimal_step;
        self.numerator_step += self.numerator_step;
        if (self.numerator_step >= self.denominator) {
            self.numerator_step -= self.denominator;
            self.decimal_step += 1;
        }
        return (self.decimal_step < self.size);
    }
    fn length(self: *Iterator) usize {
        return self.decimal_step;
    }
};
const Pull = struct {
    from: usize,
    to: usize,
    count: usize,
    range: Range,
};
pub fn block(
    items: []T,
    context: anytype,
    lessThanFn: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    const lessThan = lessThanFn;
    var cache: [512]T = undefined;
    if (items.len < 4) {
        if (items.len == 3) {
            if (lessThan(context, items[1], items[0])) mem.swap(T, &items[0], &items[1]);
            if (lessThan(context, items[2], items[1])) {
                mem.swap(T, &items[1], &items[2]);
                if (lessThan(context, items[1], items[0])) mem.swap(T, &items[0], &items[1]);
            }
        } else if (items.len == 2) {
            if (lessThan(context, items[1], items[0])) mem.swap(T, &items[0], &items[1]);
        }
        return;
    }
    var iterator = Iterator.init(items.len, 4);
    while (!iterator.finished()) {
        var order = [_]u8{ 0, 1, 2, 3, 4, 5, 6, 7 };
        const range = iterator.nextRange();
        const sliced_items = items[range.start..];
        switch (range.length()) {
            8 => {
                swap(sliced_items, &order, 0, 1, context, lessThan);
                swap(sliced_items, &order, 2, 3, context, lessThan);
                swap(sliced_items, &order, 4, 5, context, lessThan);
                swap(sliced_items, &order, 6, 7, context, lessThan);
                swap(sliced_items, &order, 0, 2, context, lessThan);
                swap(sliced_items, &order, 1, 3, context, lessThan);
                swap(sliced_items, &order, 4, 6, context, lessThan);
                swap(sliced_items, &order, 5, 7, context, lessThan);
                swap(sliced_items, &order, 1, 2, context, lessThan);
                swap(sliced_items, &order, 5, 6, context, lessThan);
                swap(sliced_items, &order, 0, 4, context, lessThan);
                swap(sliced_items, &order, 3, 7, context, lessThan);
                swap(sliced_items, &order, 1, 5, context, lessThan);
                swap(sliced_items, &order, 2, 6, context, lessThan);
                swap(sliced_items, &order, 1, 4, context, lessThan);
                swap(sliced_items, &order, 3, 6, context, lessThan);
                swap(sliced_items, &order, 2, 4, context, lessThan);
                swap(sliced_items, &order, 3, 5, context, lessThan);
                swap(sliced_items, &order, 3, 4, context, lessThan);
            },
            7 => {
                swap(sliced_items, &order, 1, 2, context, lessThan);
                swap(sliced_items, &order, 3, 4, context, lessThan);
                swap(sliced_items, &order, 5, 6, context, lessThan);
                swap(sliced_items, &order, 0, 2, context, lessThan);
                swap(sliced_items, &order, 3, 5, context, lessThan);
                swap(sliced_items, &order, 4, 6, context, lessThan);
                swap(sliced_items, &order, 0, 1, context, lessThan);
                swap(sliced_items, &order, 4, 5, context, lessThan);
                swap(sliced_items, &order, 2, 6, context, lessThan);
                swap(sliced_items, &order, 0, 4, context, lessThan);
                swap(sliced_items, &order, 1, 5, context, lessThan);
                swap(sliced_items, &order, 0, 3, context, lessThan);
                swap(sliced_items, &order, 2, 5, context, lessThan);
                swap(sliced_items, &order, 1, 3, context, lessThan);
                swap(sliced_items, &order, 2, 4, context, lessThan);
                swap(sliced_items, &order, 2, 3, context, lessThan);
            },
            6 => {
                swap(sliced_items, &order, 1, 2, context, lessThan);
                swap(sliced_items, &order, 4, 5, context, lessThan);
                swap(sliced_items, &order, 0, 2, context, lessThan);
                swap(sliced_items, &order, 3, 5, context, lessThan);
                swap(sliced_items, &order, 0, 1, context, lessThan);
                swap(sliced_items, &order, 3, 4, context, lessThan);
                swap(sliced_items, &order, 2, 5, context, lessThan);
                swap(sliced_items, &order, 0, 3, context, lessThan);
                swap(sliced_items, &order, 1, 4, context, lessThan);
                swap(sliced_items, &order, 2, 4, context, lessThan);
                swap(sliced_items, &order, 1, 3, context, lessThan);
                swap(sliced_items, &order, 2, 3, context, lessThan);
            },
            5 => {
                swap(sliced_items, &order, 0, 1, context, lessThan);
                swap(sliced_items, &order, 3, 4, context, lessThan);
                swap(sliced_items, &order, 2, 4, context, lessThan);
                swap(sliced_items, &order, 2, 3, context, lessThan);
                swap(sliced_items, &order, 1, 4, context, lessThan);
                swap(sliced_items, &order, 0, 3, context, lessThan);
                swap(sliced_items, &order, 0, 2, context, lessThan);
                swap(sliced_items, &order, 1, 3, context, lessThan);
                swap(sliced_items, &order, 1, 2, context, lessThan);
            },
            4 => {
                swap(sliced_items, &order, 0, 1, context, lessThan);
                swap(sliced_items, &order, 2, 3, context, lessThan);
                swap(sliced_items, &order, 0, 2, context, lessThan);
                swap(sliced_items, &order, 1, 3, context, lessThan);
                swap(sliced_items, &order, 1, 2, context, lessThan);
            },
            else => {},
        }
    }
    if (items.len < 8) return;
    while (true) {
        if (iterator.length() < cache.len) {
            if ((iterator.length() + 1) * 4 <= cache.len and iterator.length() * 4 <= items.len) {
                iterator.begin();
                while (!iterator.finished()) {
                    var A1 = iterator.nextRange();
                    var B1 = iterator.nextRange();
                    var A2 = iterator.nextRange();
                    var B2 = iterator.nextRange();
                    if (lessThan(context, items[B1.end - 1], items[A1.start])) {
                        const a1_items = items[A1.start..A1.end];
                        @memcpy(cache[B1.length()..][0..a1_items.len], a1_items);
                        const b1_items = items[B1.start..B1.end];
                        @memcpy(cache[0..b1_items.len], b1_items);
                    } else if (lessThan(context, items[B1.start], items[A1.end - 1])) {
                        mergeInto(items, A1, B1, cache[0..], context, lessThan);
                    } else {
                        if (!lessThan(context, items[B2.start], items[A2.end - 1]) and !lessThan(context, items[A2.start], items[B1.end - 1])) continue;
                        const a1_items = items[A1.start..A1.end];
                        @memcpy(cache[0..a1_items.len], a1_items);
                        const b1_items = items[B1.start..B1.end];
                        @memcpy(cache[A1.length()..][0..b1_items.len], b1_items);
                    }
                    A1 = Range.init(A1.start, B1.end);
                    if (lessThan(context, items[B2.end - 1], items[A2.start])) {
                        const a2_items = items[A2.start..A2.end];
                        @memcpy(cache[A1.length() + B2.length() ..][0..a2_items.len], a2_items);
                        const b2_items = items[B2.start..B2.end];
                        @memcpy(cache[A1.length()..][0..b2_items.len], b2_items);
                    } else if (lessThan(context, items[B2.start], items[A2.end - 1])) {
                        mergeInto(items, A2, B2, cache[A1.length()..], context, lessThan);
                    } else {
                        const a2_items = items[A2.start..A2.end];
                        @memcpy(cache[A1.length()..][0..a2_items.len], a2_items);
                        const b2_items = items[B2.start..B2.end];
                        @memcpy(cache[A1.length() + A2.length() ..][0..b2_items.len], b2_items);
                    }
                    A2 = Range.init(A2.start, B2.end);
                    const A3 = Range.init(0, A1.length());
                    const B3 = Range.init(A1.length(), A1.length() + A2.length());
                    if (lessThan(context, cache[B3.end - 1], cache[A3.start])) {
                        const a3_items = cache[A3.start..A3.end];
                        @memcpy(items[A1.start + A2.length() ..][0..a3_items.len], a3_items);
                        const b3_items = cache[B3.start..B3.end];
                        @memcpy(items[A1.start..][0..b3_items.len], b3_items);
                    } else if (lessThan(context, cache[B3.start], cache[A3.end - 1])) {
                        mergeInto(cache[0..], A3, B3, items[A1.start..], context, lessThan);
                    } else {
                        const a3_items = cache[A3.start..A3.end];
                        @memcpy(items[A1.start..][0..a3_items.len], a3_items);
                        const b3_items = cache[B3.start..B3.end];
                        @memcpy(items[A1.start + A1.length() ..][0..b3_items.len], b3_items);
                    }
                }
                _ = iterator.nextLevel();
            } else {
                iterator.begin();
                while (!iterator.finished()) {
                    const A = iterator.nextRange();
                    const B = iterator.nextRange();
                    if (lessThan(context, items[B.end - 1], items[A.start])) {
                        mem.rotate(T, items[A.start..B.end], A.length());
                    } else if (lessThan(context, items[B.start], items[A.end - 1])) {
                        const a_items = items[A.start..A.end];
                        @memcpy(cache[0..a_items.len], a_items);
                        mergeExternal(items, A, B, cache[0..], context, lessThan);
                    }
                }
            }
        } else {
            var block_size: usize = math.sqrt(iterator.length());
            var buffer_size = iterator.length() / block_size + 1;
            var A: Range = undefined;
            var B: Range = undefined;
            var index: usize = 0;
            var last: usize = 0;
            var count: usize = 0;
            var find: usize = 0;
            var start: usize = 0;
            var pull_index: usize = 0;
            var pull = [_]Pull{
                Pull{
                    .from = 0,
                    .to = 0,
                    .count = 0,
                    .range = Range.init(0, 0),
                },
                Pull{
                    .from = 0,
                    .to = 0,
                    .count = 0,
                    .range = Range.init(0, 0),
                },
            };
            var buffer1 = Range.init(0, 0);
            var buffer2 = Range.init(0, 0);
            find = buffer_size + buffer_size;
            var find_separately = false;
            if (block_size <= cache.len) {
                find = buffer_size;
            } else if (find > iterator.length()) {
                find = buffer_size;
                find_separately = true;
            }
            iterator.begin();
            while (!iterator.finished()) {
                A = iterator.nextRange();
                B = iterator.nextRange();
                last = A.start;
                count = 1;
                while (count < find) : ({
                    last = index;
                    count += 1;
                }) {
                    index = findLastForward(items, items[last], Range.init(last + 1, A.end), find - count, context, lessThan);
                    if (index == A.end) break;
                }
                index = last;
                if (count >= buffer_size) {
                    pull[pull_index] = Pull{
                        .range = Range.init(A.start, B.end),
                        .count = count,
                        .from = index,
                        .to = A.start,
                    };
                    pull_index = 1;
                    if (count == buffer_size + buffer_size) {
                        buffer1 = Range.init(A.start, A.start + buffer_size);
                        buffer2 = Range.init(A.start + buffer_size, A.start + count);
                        break;
                    } else if (find == buffer_size + buffer_size) {
                        buffer1 = Range.init(A.start, A.start + count);
                        find = buffer_size;
                    } else if (block_size <= cache.len) {
                        buffer1 = Range.init(A.start, A.start + count);
                        break;
                    } else if (find_separately) {
                        buffer1 = Range.init(A.start, A.start + count);
                        find_separately = false;
                    } else {
                        buffer2 = Range.init(A.start, A.start + count);
                        break;
                    }
                } else if (pull_index == 0 and count > buffer1.length()) {
                    buffer1 = Range.init(A.start, A.start + count);
                    pull[pull_index] = Pull{
                        .range = Range.init(A.start, B.end),
                        .count = count,
                        .from = index,
                        .to = A.start,
                    };
                }
                last = B.end - 1;
                count = 1;
                while (count < find) : ({
                    last = index - 1;
                    count += 1;
                }) {
                    index = findFirstBackward(items, items[last], Range.init(B.start, last), find - count, context, lessThan);
                    if (index == B.start) break;
                }
                index = last;
                if (count >= buffer_size) {
                    pull[pull_index] = Pull{
                        .range = Range.init(A.start, B.end),
                        .count = count,
                        .from = index,
                        .to = B.end,
                    };
                    pull_index = 1;
                    if (count == buffer_size + buffer_size) {
                        buffer1 = Range.init(B.end - count, B.end - buffer_size);
                        buffer2 = Range.init(B.end - buffer_size, B.end);
                        break;
                    } else if (find == buffer_size + buffer_size) {
                        buffer1 = Range.init(B.end - count, B.end);
                        find = buffer_size;
                    } else if (block_size <= cache.len) {
                        buffer1 = Range.init(B.end - count, B.end);
                        break;
                    } else if (find_separately) {
                        buffer1 = Range.init(B.end - count, B.end);
                        find_separately = false;
                    } else {
                        if (pull[0].range.start == A.start) pull[0].range.end -= pull[1].count;
                        buffer2 = Range.init(B.end - count, B.end);
                        break;
                    }
                } else if (pull_index == 0 and count > buffer1.length()) {
                    buffer1 = Range.init(B.end - count, B.end);
                    pull[pull_index] = Pull{
                        .range = Range.init(A.start, B.end),
                        .count = count,
                        .from = index,
                        .to = B.end,
                    };
                }
            }
            pull_index = 0;
            while (pull_index < 2) : (pull_index += 1) {
                const length = pull[pull_index].count;
                if (pull[pull_index].to < pull[pull_index].from) {
                    index = pull[pull_index].from;
                    count = 1;
                    while (count < length) : (count += 1) {
                        index = findFirstBackward(items, items[index - 1], Range.init(pull[pull_index].to, pull[pull_index].from - (count - 1)), length - count, context, lessThan);
                        const range = Range.init(index + 1, pull[pull_index].from + 1);
                        mem.rotate(T, items[range.start..range.end], range.length() - count);
                        pull[pull_index].from = index + count;
                    }
                } else if (pull[pull_index].to > pull[pull_index].from) {
                    index = pull[pull_index].from + 1;
                    count = 1;
                    while (count < length) : (count += 1) {
                        index = findLastForward(items, items[index], Range.init(index, pull[pull_index].to), length - count, context, lessThan);
                        const range = Range.init(pull[pull_index].from, index - 1);
                        mem.rotate(T, items[range.start..range.end], count);
                        pull[pull_index].from = index - 1 - count;
                    }
                }
            }
            buffer_size = buffer1.length();
            block_size = iterator.length() / buffer_size + 1;
            iterator.begin();
            while (!iterator.finished()) {
                A = iterator.nextRange();
                B = iterator.nextRange();
                start = A.start;
                if (start == pull[0].range.start) {
                    if (pull[0].from > pull[0].to) {
                        A.start += pull[0].count;
                        if (A.length() == 0) continue;
                    } else if (pull[0].from < pull[0].to) {
                        B.end -= pull[0].count;
                        if (B.length() == 0) continue;
                    }
                }
                if (start == pull[1].range.start) {
                    if (pull[1].from > pull[1].to) {
                        A.start += pull[1].count;
                        if (A.length() == 0) continue;
                    } else if (pull[1].from < pull[1].to) {
                        B.end -= pull[1].count;
                        if (B.length() == 0) continue;
                    }
                }
                if (lessThan(context, items[B.end - 1], items[A.start])) {
                    mem.rotate(T, items[A.start..B.end], A.length());
                } else if (lessThan(context, items[A.end], items[A.end - 1])) {
                    var findA: usize = undefined;
                    var blockA = Range.init(A.start, A.end);
                    var firstA = Range.init(A.start, A.start + blockA.length() % block_size);
                    var indexA = buffer1.start;
                    index = firstA.end;
                    while (index < blockA.end) : ({
                        indexA += 1;
                        index += block_size;
                    }) {
                        mem.swap(T, &items[indexA], &items[index]);
                    }
                    var lastA = firstA;
                    var lastB = Range.init(0, 0);
                    var blockB = Range.init(B.start, B.start + @min(block_size, B.length()));
                    blockA.start += firstA.length();
                    indexA = buffer1.start;
                    if (lastA.length() <= cache.len) {
                        const last_a_items = items[lastA.start..lastA.end];
                        @memcpy(cache[0..last_a_items.len], last_a_items);
                    } else if (buffer2.length() > 0) {
                        blockSwap(items, lastA.start, buffer2.start, lastA.length());
                    }
                    if (blockA.length() > 0) {
                        while (true) {
                            if ((lastB.length() > 0 and !lessThan(context, items[lastB.end - 1], items[indexA])) or blockB.length() == 0) {
                                const B_split = binaryFirst(items, items[indexA], lastB, context, lessThan);
                                const B_remaining = lastB.end - B_split;
                                var minA = blockA.start;
                                findA = minA + block_size;
                                while (findA < blockA.end) : (findA += block_size) {
                                    if (lessThan(context, items[findA], items[minA])) {
                                        minA = findA;
                                    }
                                }
                                blockSwap(items, blockA.start, minA, block_size);
                                mem.swap(T, &items[blockA.start], &items[indexA]);
                                indexA += 1;
                                if (lastA.length() <= cache.len) {
                                    mergeExternal(items, lastA, Range.init(lastA.end, B_split), cache[0..], context, lessThan);
                                } else if (buffer2.length() > 0) {
                                    mergeInternal(items, lastA, Range.init(lastA.end, B_split), buffer2, context, lessThan);
                                } else {
                                    mergeInPlace(items, lastA, Range.init(lastA.end, B_split), context, lessThan);
                                }
                                if (buffer2.length() > 0 or block_size <= cache.len) {
                                    if (block_size <= cache.len) {
                                        @memcpy(cache[0..block_size], items[blockA.start..][0..block_size]);
                                    } else {
                                        blockSwap(items, blockA.start, buffer2.start, block_size);
                                    }
                                    blockSwap(items, B_split, blockA.start + block_size - B_remaining, B_remaining);
                                } else {
                                    mem.rotate(T, items[B_split .. blockA.start + block_size], blockA.start - B_split);
                                }
                                lastA = Range.init(blockA.start - B_remaining, blockA.start - B_remaining + block_size);
                                lastB = Range.init(lastA.end, lastA.end + B_remaining);
                                blockA.start += block_size;
                                if (blockA.length() == 0) break;
                            } else if (blockB.length() < block_size) {
                                mem.rotate(T, items[blockA.start..blockB.end], blockB.start - blockA.start);
                                lastB = Range.init(blockA.start, blockA.start + blockB.length());
                                blockA.start += blockB.length();
                                blockA.end += blockB.length();
                                blockB.end = blockB.start;
                            } else {
                                blockSwap(items, blockA.start, blockB.start, block_size);
                                lastB = Range.init(blockA.start, blockA.start + block_size);
                                blockA.start += block_size;
                                blockA.end += block_size;
                                blockB.start += block_size;
                                if (blockB.end > B.end - block_size) {
                                    blockB.end = B.end;
                                } else {
                                    blockB.end += block_size;
                                }
                            }
                        }
                    }
                    if (lastA.length() <= cache.len) {
                        mergeExternal(items, lastA, Range.init(lastA.end, B.end), cache[0..], context, lessThan);
                    } else if (buffer2.length() > 0) {
                        mergeInternal(items, lastA, Range.init(lastA.end, B.end), buffer2, context, lessThan);
                    } else {
                        mergeInPlace(items, lastA, Range.init(lastA.end, B.end), context, lessThan);
                    }
                }
            }
            sort.insertion(T, items[buffer2.start..buffer2.end], context, lessThan);
            pull_index = 0;
            while (pull_index < 2) : (pull_index += 1) {
                var unique = pull[pull_index].count * 2;
                if (pull[pull_index].from > pull[pull_index].to) {
                    var buffer = Range.init(pull[pull_index].range.start, pull[pull_index].range.start + pull[pull_index].count);
                    while (buffer.length() > 0) {
                        index = findFirstForward(items, items[buffer.start], Range.init(buffer.end, pull[pull_index].range.end), unique, context, lessThan);
                        const amount = index - buffer.end;
                        mem.rotate(T, items[buffer.start..index], buffer.length());
                        buffer.start += (amount + 1);
                        buffer.end += amount;
                        unique -= 2;
                    }
                } else if (pull[pull_index].from < pull[pull_index].to) {
                    var buffer = Range.init(pull[pull_index].range.end - pull[pull_index].count, pull[pull_index].range.end);
                    while (buffer.length() > 0) {
                        index = findLastBackward(items, items[buffer.end - 1], Range.init(pull[pull_index].range.start, buffer.start), unique, context, lessThan);
                        const amount = buffer.start - index;
                        mem.rotate(T, items[index..buffer.end], amount);
                        buffer.start -= amount;
                        buffer.end -= (amount + 1);
                        unique -= 2;
                    }
                }
            }
        }
        if (!iterator.nextLevel()) break;
    }
}
fn mergeInPlace(
    items: []T,
    A_arg: Range,
    B_arg: Range,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    if (A_arg.length() == 0 or B_arg.length() == 0) return;
    var A = A_arg;
    var B = B_arg;
    while (true) {
        const mid = binaryFirst(items, items[A.start], B, context, lessThan);
        const amount = mid - A.end;
        mem.rotate(T, items[A.start..mid], A.length());
        if (B.end == mid) break;
        B.start = mid;
        A = Range.init(A.start + amount, B.start);
        A.start = binaryLast(items, items[A.start], A, context, lessThan);
        if (A.length() == 0) break;
    }
}
fn mergeInternal(
    items: []T,
    A: Range,
    B: Range,
    buffer: Range,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    var A_count: usize = 0;
    var B_count: usize = 0;
    var insert: usize = 0;
    if (B.length() > 0 and A.length() > 0) {
        while (true) {
            if (!lessThan(context, items[B.start + B_count], items[buffer.start + A_count])) {
                mem.swap(T, &items[A.start + insert], &items[buffer.start + A_count]);
                A_count += 1;
                insert += 1;
                if (A_count >= A.length()) break;
            } else {
                mem.swap(T, &items[A.start + insert], &items[B.start + B_count]);
                B_count += 1;
                insert += 1;
                if (B_count >= B.length()) break;
            }
        }
    }
    blockSwap(items, buffer.start + A_count, A.start + insert, A.length() - A_count);
}
fn blockSwap(items: []T, start1: usize, start2: usize, block_size: usize) void {
    var index: usize = 0;
    while (index < block_size) : (index += 1) {
        mem.swap(T, &items[start1 + index], &items[start2 + index]);
    }
}
fn findFirstForward(
    items: []T,
    value: T,
    range: Range,
    unique: usize,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    if (range.length() == 0) return range.start;
    const skip = @max(range.length() / unique, @as(usize, 1));
    var index = range.start + skip;
    while (lessThan(context, items[index - 1], value)) : (index += skip) {
        if (index >= range.end - skip) {
            return binaryFirst(items, value, Range.init(index, range.end), context, lessThan);
        }
    }
    return binaryFirst(items, value, Range.init(index - skip, index), context, lessThan);
}
fn findFirstBackward(
    items: []T,
    value: T,
    range: Range,
    unique: usize,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    if (range.length() == 0) return range.start;
    const skip = @max(range.length() / unique, @as(usize, 1));
    var index = range.end - skip;
    while (index > range.start and !lessThan(context, items[index - 1], value)) : (index -= skip) {
        if (index < range.start + skip) {
            return binaryFirst(items, value, Range.init(range.start, index), context, lessThan);
        }
    }
    return binaryFirst(items, value, Range.init(index, index + skip), context, lessThan);
}
fn findLastForward(
    items: []T,
    value: T,
    range: Range,
    unique: usize,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    if (range.length() == 0) return range.start;
    const skip = @max(range.length() / unique, @as(usize, 1));
    var index = range.start + skip;
    while (!lessThan(context, value, items[index - 1])) : (index += skip) {
        if (index >= range.end - skip) {
            return binaryLast(items, value, Range.init(index, range.end), context, lessThan);
        }
    }
    return binaryLast(items, value, Range.init(index - skip, index), context, lessThan);
}
fn findLastBackward(
    items: []T,
    value: T,
    range: Range,
    unique: usize,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    if (range.length() == 0) return range.start;
    const skip = @max(range.length() / unique, @as(usize, 1));
    var index = range.end - skip;
    while (index > range.start and lessThan(context, value, items[index - 1])) : (index -= skip) {
        if (index < range.start + skip) {
            return binaryLast(items, value, Range.init(range.start, index), context, lessThan);
        }
    }
    return binaryLast(items, value, Range.init(index, index + skip), context, lessThan);
}
fn binaryFirst(
    items: []T,
    value: T,
    range: Range,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    var curr = range.start;
    var size = range.length();
    if (range.start >= range.end) return range.end;
    while (size > 0) {
        const offset = size % 2;
        size /= 2;
        const mid_item = items[curr + size];
        if (lessThan(context, mid_item, value)) {
            curr += size + offset;
        }
    }
    return curr;
}
fn binaryLast(
    items: []T,
    value: T,
    range: Range,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) usize {
    var curr = range.start;
    var size = range.length();
    if (range.start >= range.end) return range.end;
    while (size > 0) {
        const offset = size % 2;
        size /= 2;
        const mid_item = items[curr + size];
        if (!lessThan(context, value, mid_item)) {
            curr += size + offset;
        }
    }
    return curr;
}
fn mergeInto(
    from: []T,
    A: Range,
    B: Range,
    into: []T,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    var A_index: usize = A.start;
    var B_index: usize = B.start;
    const A_last = A.end;
    const B_last = B.end;
    var insert_index: usize = 0;
    while (true) {
        if (!lessThan(context, from[B_index], from[A_index])) {
            into[insert_index] = from[A_index];
            A_index += 1;
            insert_index += 1;
            if (A_index == A_last) {
                const from_b = from[B_index..B_last];
                @memcpy(into[insert_index..][0..from_b.len], from_b);
                break;
            }
        } else {
            into[insert_index] = from[B_index];
            B_index += 1;
            insert_index += 1;
            if (B_index == B_last) {
                const from_a = from[A_index..A_last];
                @memcpy(into[insert_index..][0..from_a.len], from_a);
                break;
            }
        }
    }
}
fn mergeExternal(
    items: []T,
    A: Range,
    B: Range,
    cache: []T,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    var A_index: usize = 0;
    var B_index: usize = B.start;
    var insert_index: usize = A.start;
    const A_last = A.length();
    const B_last = B.end;
    if (B.length() > 0 and A.length() > 0) {
        while (true) {
            if (!lessThan(context, items[B_index], cache[A_index])) {
                items[insert_index] = cache[A_index];
                A_index += 1;
                insert_index += 1;
                if (A_index == A_last) break;
            } else {
                items[insert_index] = items[B_index];
                B_index += 1;
                insert_index += 1;
                if (B_index == B_last) break;
            }
        }
    }
    const cache_a = cache[A_index..A_last];
    @memcpy(items[insert_index..][0..cache_a.len], cache_a);
}
fn swap(
    items: []T,
    order: *[8]u8,
    x: usize,
    y: usize,
    context: anytype,
    lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    if (lessThan(context, items[y], items[x]) or ((order.*)[x] > (order.*)[y] and !lessThan(context, items[x], items[y]))) {
        mem.swap(T, &items[x], &items[y]);
        mem.swap(u8, &(order.*)[x], &(order.*)[y]);
    }
}`;
