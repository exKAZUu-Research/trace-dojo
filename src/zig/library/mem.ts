// code-gauge-allow-file duplicateLines 25 -- Library types repeat the same shape of method on purpose, each over its own state.
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { Expression, Span } from '../ast';
import type { Frame } from '../runtime';
import { known, newArray, runtime, type SemaApi, type TExpr, undefinedValue } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  USIZE,
  VOID,
} from '../types';
import { NULL, type Pointer, Slice, type Value, ZStruct } from '../values';
import {
  allocating,
  allocatorArg,
  compareScalars,
  computed,
  constSlice,
  elements,
  equalValues,
  generic,
  mutableSlice,
  newSlice,
  OPTIONAL_USIZE,
  optionalIndex,
  ORDER,
  orderValue,
  subSlice,
} from './common';
import { ALLOCATOR, ERROR_OUT_OF_MEMORY } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeStruct, typeMember } from './native';
import { sortValues } from './sorting';

function findSequence(haystack: Value[], needle: Value[], from: number): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;
  outer: for (let index = from; index + needle.length <= haystack.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (!equalValues(haystack[index + offset], needle[offset])) continue outer;
    }
    return index;
  }
  return -1;
}

function findSequenceLast(haystack: Value[], needle: Value[]): number {
  for (let index = haystack.length - needle.length; index >= 0; index--) {
    if (needle.every((value, offset) => equalValues(haystack[index + offset], value))) return index;
  }
  return -1;
}

function startsWith(haystack: Value[], needle: Value[], at = 0): boolean {
  return (
    at + needle.length <= haystack.length && needle.every((value, offset) => equalValues(haystack[at + offset], value))
  );
}

/** `(T, slice, other)` functions that compare two slices or a slice and a scalar, known at compile time when both are. */
function sliceSearch(
  name: string,
  second: 'slice' | 'scalar',
  resultType: Type,
  compute: (haystack: Value[], operand: Value) => Value
): () => Member {
  return generic(name, 3, (sema, call, type, [haystack, operand]) => {
    const a = constSlice(sema, haystack, type);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    return computed(resultType, [a, b], call.span, ([x, y]) =>
      compute(elements(x), second === 'slice' ? (elements(y) as unknown as Value) : y)
    );
  });
}

function positionSearch(
  name: string,
  second: 'slice' | 'scalar',
  compute: (haystack: Value[], start: number, operand: Value) => number
): () => Member {
  return generic(name, 4, (sema, call, type, [haystack, startArg, operand]) => {
    const a = constSlice(sema, haystack, type);
    const [start] = compileArgs(sema, [startArg], [USIZE]);
    const b =
      second === 'slice' ? constSlice(sema, operand, type) : sema.coerce(sema.compile(operand, type), type, operand);
    return computed(OPTIONAL_USIZE, [a, start, b], call.span, ([x, s, y]) =>
      optionalIndex(
        compute(elements(x), Number(s as bigint), second === 'slice' ? (elements(y) as unknown as Value) : y)
      )
    );
  });
}

// code-gauge-allow functionCognitiveComplexity 16 -- Handles each kind of value the operation accepts.
function trimmer(name: string, start: boolean, end: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [sliceArg, stripArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    const strip = constSlice(sema, stripArg, type);
    return computed(sliceOf(type, true), [slice, strip], call.span, ([value, values]) => {
      const items = elements(value);
      const set = elements(values);
      let from = 0;
      let to = items.length;
      if (start) while (from < to && set.some((each) => equalValues(each, items[from]))) from++;
      if (end) while (to > from && set.some((each) => equalValues(each, items[to - 1]))) to--;
      return slicePart(value, from, to - from);
    });
  });
}

function slicePart(value: Value, start: number, length: number): Slice {
  if (value instanceof Slice) return subSlice(value, start, length);
  return newSlice(elements(value).slice(start, start + length));
}

// Iterators -----------------------------------------------------------------------------------------------------------

type DelimiterKind = 'scalar' | 'sequence' | 'any';

const iteratorTypes = new Map<string, StructType>();

/** `std.mem.SplitIterator(T, kind)` or `TokenIterator`: fields `buffer`, `index`, and `delimiter`, as in Zig. */
function iteratorType(kind: 'split' | 'token', delimiter: DelimiterKind, child: Type): StructType {
  const key = `${kind} ${delimiter} ${typeName(child)}`;
  let type = iteratorTypes.get(key);
  if (type) return type;
  const delimiterType = delimiter === 'scalar' ? child : sliceOf(child, true);
  const resultSlice = sliceOf(child, true);
  const created: StructType = nativeStruct(
    `mem.${kind === 'split' ? 'SplitIterator' : 'TokenIterator'}(${typeName(child)},.${delimiter})`,
    {},
    [
      { name: 'buffer', type: resultSlice, hasDefault: false },
      { name: 'index', type: kind === 'split' ? optionalOf(USIZE) : USIZE, hasDefault: false },
      { name: 'delimiter', type: delimiterType, hasDefault: false },
    ]
  );
  type = created;
  iteratorTypes.set(key, type);
  const isDelimiter = (buffer: Value[], index: number, value: Value): boolean => {
    if (delimiter === 'scalar') return equalValues(buffer[index], value);
    const set = elements(value);
    if (delimiter === 'any') return set.some((each) => equalValues(each, buffer[index]));
    return startsWith(buffer, set, index);
  };
  const delimiterLength = (value: Value): number => (delimiter === 'sequence' ? elements(value).length : 1);
  const method = (name: string, returnType: Type, run: (state: ZStruct) => Value): (() => Member) =>
    fnMember(`${key}.${name}`, (sema, call) => {
      expectArgs(sema, call, 0, name);
      const state = iteratorState(sema, call.receiver, created, call.span);
      return runtime(
        returnType,
        (frame) => {
          frame.runtime.spend();
          return run(state(frame));
        },
        call.span
      );
    });
  const tokenPeek = (state: ZStruct): { start: number; end: number } | undefined => {
    const buffer = elements(state.slots[0]);
    let index = Number(state.slots[1] as bigint);
    while (index < buffer.length && isDelimiter(buffer, index, state.slots[2]))
      index += delimiterLength(state.slots[2]);
    state.slots[1] = BigInt(index);
    if (index === buffer.length) return undefined;
    let end = index;
    while (end < buffer.length && !isDelimiter(buffer, end, state.slots[2])) end++;
    return { start: index, end };
  };
  const members: Record<string, () => Member> =
    kind === 'split'
      ? {
          next: method('next', optionalOf(resultSlice), (state) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            let found = -1;
            for (let index = start; index < buffer.length; index++) {
              if (
                delimiter === 'sequence'
                  ? startsWith(buffer, elements(state.slots[2]), index)
                  : isDelimiter(buffer, index, state.slots[2])
              ) {
                found = index;
                break;
              }
            }
            if (delimiter === 'sequence' && found === -1 && elements(state.slots[2]).length === 0) found = start;
            if (found === -1) {
              state.slots[1] = NULL;
            } else {
              state.slots[1] = BigInt(found + delimiterLength(state.slots[2]));
              end = found;
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          first: method('first', resultSlice, (state) => {
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            for (let index = 0; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2])) {
                end = index;
                break;
              }
            }
            state.slots[1] = end === buffer.length ? NULL : BigInt(end + delimiterLength(state.slots[2]));
            return subSlice(state.slots[0] as Slice, 0, end);
          }),
          peek: method('peek', optionalOf(resultSlice), (state) => {
            const startValue = state.slots[1];
            if (startValue === NULL) return NULL;
            const start = Number(startValue as bigint);
            const buffer = elements(state.slots[0]);
            let end = buffer.length;
            for (let index = start; index < buffer.length; index++) {
              if (isDelimiter(buffer, index, state.slots[2])) {
                end = index;
                break;
              }
            }
            return subSlice(state.slots[0] as Slice, start, end - start);
          }),
          rest: method('rest', resultSlice, (state) => {
            const buffer = state.slots[0] as Slice;
            const startValue = state.slots[1];
            const start = startValue === NULL ? buffer.length : Number(startValue as bigint);
            return subSlice(buffer, start, buffer.length - start);
          }),
          reset: method('reset', VOID, (state) => {
            state.slots[1] = 0n;
            return;
          }),
        }
      : {
          next: method('next', optionalOf(resultSlice), (state) => {
            const token = tokenPeek(state);
            if (!token) return NULL;
            state.slots[1] = BigInt(token.end);
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          peek: method('peek', optionalOf(resultSlice), (state) => {
            const token = tokenPeek(state);
            if (!token) return NULL;
            return subSlice(state.slots[0] as Slice, token.start, token.end - token.start);
          }),
          rest: method('rest', resultSlice, (state) => {
            const buffer = elements(state.slots[0]);
            let index = Number(state.slots[1] as bigint);
            while (index < buffer.length && isDelimiter(buffer, index, state.slots[2]))
              index += delimiterLength(state.slots[2]);
            return subSlice(state.slots[0] as Slice, index, buffer.length - index);
          }),
          reset: method('reset', VOID, (state) => {
            state.slots[1] = 0n;
            return;
          }),
        };
  for (const [name, resolve] of Object.entries(members)) {
    let resolved: Member | undefined;
    created.namespace.decls.set(name, {
      kind: 'native',
      name,
      resolve: () => {
        resolved ??= resolve();
        return resolved;
      },
    });
  }
  return created;
}

function iteratorState(
  sema: SemaApi,
  receiver: TExpr | undefined,
  type: StructType,
  span: Span
): (frame: Frame) => ZStruct {
  if (!receiver) return sema.error(span, 'イテレータの値に対して呼び出してください。');
  const evaluate = receiver.eval;
  if (receiver.type.kind === 'pointer' && receiver.type.child === type)
    return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
  if (receiver.type !== type) return sema.error(span, 'イテレータの値に対して呼び出してください。');
  const address = sema.addressOf(receiver);
  if (address.type.kind === 'pointer' && address.type.isConst)
    sema.error(span, 'イテレータは var で宣言してください。');
  const locate = address.eval;
  return (frame) => (locate(frame) as Pointer).load() as ZStruct;
}

function iteratorFactory(name: string, kind: 'split' | 'token', delimiter: DelimiterKind): () => Member {
  return generic(name, 3, (sema, call, type, [bufferArg, delimiterArg]) => {
    const buffer = constSlice(sema, bufferArg, type);
    const delimiterValue =
      delimiter === 'scalar'
        ? sema.coerce(sema.compile(delimiterArg, type), type, delimiterArg)
        : constSlice(sema, delimiterArg, type);
    const iterator = iteratorType(kind, delimiter, type);
    return computed(iterator, [buffer, delimiterValue], call.span, ([value, separator]) => {
      if (delimiter === 'sequence' && elements(separator).length === 0) panic('reached unreachable code');
      return new ZStruct([value, 0n, separator]);
    });
  });
}

// The namespace ---------------------------------------------------------------------------------------------------------

const MEMBERS: Record<string, () => Member> = {
  Allocator: typeMember(() => ALLOCATOR),
  eql: generic('std.mem.eql', 3, (sema, call, type, [a, b]) => {
    const left = constSlice(sema, a, type);
    const right = constSlice(sema, b, type);
    return computed(BOOL, [left, right], call.span, ([x, y]) => {
      const xs = elements(x);
      const ys = elements(y);
      return xs.length === ys.length && xs.every((value, index) => equalValues(value, ys[index]));
    });
  }),
  startsWith: sliceSearch('std.mem.startsWith', 'slice', BOOL, (haystack, needle) =>
    startsWith(haystack, needle as unknown as Value[])
  ),
  endsWith: sliceSearch('std.mem.endsWith', 'slice', BOOL, (haystack, needle) => {
    const values = needle as unknown as Value[];
    return startsWith(haystack, values, haystack.length - values.length) && values.length <= haystack.length;
  }),
  indexOf: sliceSearch('std.mem.indexOf', 'slice', OPTIONAL_USIZE, (h, n) =>
    optionalIndex(findSequence(h, n as unknown as Value[], 0))
  ),
  find: sliceSearch('std.mem.find', 'slice', OPTIONAL_USIZE, (h, n) =>
    optionalIndex(findSequence(h, n as unknown as Value[], 0))
  ),
  lastIndexOf: sliceSearch('std.mem.lastIndexOf', 'slice', OPTIONAL_USIZE, (h, n) =>
    optionalIndex(findSequenceLast(h, n as unknown as Value[]))
  ),
  findLast: sliceSearch('std.mem.findLast', 'slice', OPTIONAL_USIZE, (h, n) =>
    optionalIndex(findSequenceLast(h, n as unknown as Value[]))
  ),
  indexOfScalar: sliceSearch('std.mem.indexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v) =>
    optionalIndex(h.findIndex((x) => equalValues(x, v)))
  ),
  findScalar: sliceSearch('std.mem.findScalar', 'scalar', OPTIONAL_USIZE, (h, v) =>
    optionalIndex(h.findIndex((x) => equalValues(x, v)))
  ),
  lastIndexOfScalar: sliceSearch('std.mem.lastIndexOfScalar', 'scalar', OPTIONAL_USIZE, (h, v) =>
    optionalIndex(h.findLastIndex((x) => equalValues(x, v)))
  ),
  findScalarLast: sliceSearch('std.mem.findScalarLast', 'scalar', OPTIONAL_USIZE, (h, v) =>
    optionalIndex(h.findLastIndex((x) => equalValues(x, v)))
  ),
  indexOfAny: sliceSearch('std.mem.indexOfAny', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findIndex((x) => (set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  findAny: sliceSearch('std.mem.findAny', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findIndex((x) => (set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  lastIndexOfAny: sliceSearch('std.mem.lastIndexOfAny', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findLastIndex((x) => (set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  findLastAny: sliceSearch('std.mem.findLastAny', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findLastIndex((x) => (set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  indexOfNone: sliceSearch('std.mem.indexOfNone', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findIndex((x) => !(set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  findNone: sliceSearch('std.mem.findNone', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findIndex((x) => !(set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  indexOfPos: positionSearch('std.mem.indexOfPos', 'slice', (h, start, n) =>
    findSequence(h, n as unknown as Value[], start)
  ),
  findPos: positionSearch('std.mem.findPos', 'slice', (h, start, n) => findSequence(h, n as unknown as Value[], start)),
  indexOfScalarPos: positionSearch('std.mem.indexOfScalarPos', 'scalar', (h, start, v) => {
    for (let index = start; index < h.length; index++) if (equalValues(h[index], v)) return index;
    return -1;
  }),
  findScalarPos: positionSearch('std.mem.findScalarPos', 'scalar', (h, start, v) => {
    for (let index = start; index < h.length; index++) if (equalValues(h[index], v)) return index;
    return -1;
  }),
  count: sliceSearch('std.mem.count', 'slice', USIZE, (h, n) => {
    const needle = n as unknown as Value[];
    if (needle.length === 0) panic(PANIC.unreachable);
    let found = 0n;
    for (let index = findSequence(h, needle, 0); index !== -1; index = findSequence(h, needle, index + needle.length))
      found++;
    return found;
  }),
  countScalar: sliceSearch('std.mem.countScalar', 'scalar', USIZE, (h, v) =>
    BigInt(h.filter((x) => equalValues(x, v)).length)
  ),
  containsAtLeast: generic('std.mem.containsAtLeast', 4, (sema, call, type, [h, countArg, n]) => {
    const haystack = constSlice(sema, h, type);
    const [count] = compileArgs(sema, [countArg], [USIZE]);
    const needle = constSlice(sema, n, type);
    return computed(BOOL, [haystack, count, needle], call.span, ([x, c, y]) => {
      const values = elements(y);
      let found = 0n;
      for (
        let index = findSequence(elements(x), values, 0);
        index !== -1;
        index = findSequence(elements(x), values, index + values.length)
      ) {
        found++;
        if (found >= (c as bigint)) return true;
      }
      return found >= (c as bigint);
    });
  }),
  trim: trimmer('std.mem.trim', true, true),
  trimStart: trimmer('std.mem.trimStart', true, false),
  trimEnd: trimmer('std.mem.trimEnd', false, true),
  allEqual: sliceSearch('std.mem.allEqual', 'scalar', BOOL, (h, v) => h.every((x) => equalValues(x, v))),
  lessThan: sliceSearch('std.mem.lessThan', 'slice', BOOL, (a, b) => lexicographic(a, b as unknown as Value[]) < 0),
  order: sliceSearch('std.mem.order', 'slice', ORDER, (a, b) => orderValue(lexicographic(a, b as unknown as Value[]))),
  max: generic('std.mem.max', 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value]) => extreme(elements(value), 1));
  }),
  min: generic('std.mem.min', 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(type, [slice], call.span, ([value]) => extreme(elements(value), -1));
  }),
  indexOfMax: extremeIndex('std.mem.indexOfMax', 1),
  findMax: extremeIndex('std.mem.findMax', 1),
  indexOfMin: extremeIndex('std.mem.indexOfMin', -1),
  findMin: extremeIndex('std.mem.findMin', -1),
  indexOfDiff: () => diffMember('std.mem.indexOfDiff'),
  findDiff: () => diffMember('std.mem.findDiff'),
  lastIndexOfNone: sliceSearch('std.mem.lastIndexOfNone', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findLastIndex((x) => !(set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  findLastNone: sliceSearch('std.mem.findLastNone', 'slice', OPTIONAL_USIZE, (h, set) =>
    optionalIndex(h.findLastIndex((x) => !(set as unknown as Value[]).some((y) => equalValues(x, y))))
  ),
  containsAtLeastScalar: generic(
    'std.mem.containsAtLeastScalar',
    4,
    (sema, call, type, [listArg, elementArg, minArg]) => {
      const list = constSlice(sema, listArg, type);
      const element = sema.coerce(sema.compile(elementArg, type), type, elementArg);
      const minimum = sema.coerce(sema.compile(minArg, USIZE), USIZE, minArg);
      return computed(
        BOOL,
        [list, element, minimum],
        call.span,
        ([value, x, n]) => BigInt(elements(value).filter((item) => equalValues(item, x)).length) >= (n as bigint)
      );
    }
  ),
  rotate: generic('std.mem.rotate', 3, (sema, call, type, [itemsArg, amountArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const amount = sema.coerce(sema.compile(amountArg, USIZE), USIZE, amountArg);
    const evaluateItems = items.eval;
    const evaluateAmount = amount.eval;
    return runtime(
      VOID,
      (frame) => {
        const slice = evaluateItems(frame) as Slice;
        const shift = Number(evaluateAmount(frame) as bigint);
        // `items[0..amount]` panics as Zig's slicing does when the amount is past the end.
        if (shift > slice.length) panic(`end index ${shift} out of bounds for slice of length ${slice.length}`);
        const values = slice.values();
        frame.runtime.spend(values.length);
        for (const [index, value] of [...values.slice(shift), ...values.slice(0, shift)].entries())
          slice.set(index, value);
        return;
      },
      call.span
    );
  }),
  reverse: generic('std.mem.reverse', 2, (sema, call, type, [itemsArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const evaluate = items.eval;
    return runtime(
      VOID,
      (frame) => {
        const slice = evaluate(frame) as Slice;
        const values = slice.values().toReversed();
        frame.runtime.spend(values.length);
        for (const [index, value] of values.entries()) slice.set(index, value);
        return;
      },
      call.span
    );
  }),
  swap: generic('std.mem.swap', 3, (sema, call, type, [aArg, bArg]) => {
    const [a, b] = compileArgs(sema, [aArg, bArg], [pointerTo(type, false), pointerTo(type, false)]);
    const evaluateA = a.eval;
    const evaluateB = b.eval;
    return runtime(
      VOID,
      (frame) => {
        const x = evaluateA(frame) as Pointer;
        const y = evaluateB(frame) as Pointer;
        const temporary = x.load();
        x.target.slots[x.index] = y.load();
        y.target.slots[y.index] = temporary;
        return;
      },
      call.span
    );
  }),
  copyForwards: copier('std.mem.copyForwards'),
  copyBackwards: copier('std.mem.copyBackwards'),
  replaceScalar: generic('std.mem.replaceScalar', 4, (sema, call, type, [sliceArg, matchArg, replacementArg]) => {
    const slice = mutableSlice(sema, sliceArg, type);
    const [match, replacement] = compileArgs(sema, [matchArg, replacementArg], [type, type]);
    return computed(VOID, [slice, match, replacement], call.span, ([value, from, to]) => {
      const target = value as Slice;
      for (let index = 0; index < target.length; index++)
        if (equalValues(target.get(index), from)) target.set(index, to);
      return;
    });
  }),
  replacementSize: generic('std.mem.replacementSize', 4, (sema, call, type, [inputArg, needleArg, replacementArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    return computed(USIZE, [input, needle, replacement], call.span, ([x, n, r]) =>
      BigInt(replaced(elements(x), elements(n), elements(r)).values.length)
    );
  }),
  replace: generic('std.mem.replace', 5, (sema, call, type, [inputArg, needleArg, replacementArg, outputArg]) => {
    const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
      constSlice(sema, arg, type)
    );
    const output = mutableSlice(sema, outputArg, type);
    return computed(USIZE, [input, needle, replacement, output], call.span, ([x, n, r, out]) => {
      const { values, count } = replaced(elements(x), elements(n), elements(r));
      const target = out as Slice;
      if (values.length > target.length) indexOutOfBounds(values.length - 1, target.length);
      for (const [index, value] of values.entries()) target.set(index, value);
      return BigInt(count);
    });
  }),
  replaceOwned: generic(
    'std.mem.replaceOwned',
    5,
    (sema, call, type, [allocatorArgument, inputArg, needleArg, replacementArg]) => {
      allocatorArg(sema, allocatorArgument);
      const [input, needle, replacement] = [inputArg, needleArg, replacementArg].map((arg) =>
        constSlice(sema, arg, type)
      );
      return allocatingCall(
        sliceOf(type, false),
        [input, needle, replacement],
        call.span,
        ([x, n, r]) => replaced(elements(x), elements(n), elements(r)).values
      );
    }
  ),
  concat: fnMember('std.mem.concat', (sema, call) => {
    const [allocatorArgument, typeArg, slicesArg] = expectArgs(sema, call, 3, 'std.mem.concat');
    allocatorArg(sema, allocatorArgument);
    const type = sema.compileType(typeArg);
    const slices = sema.coerce(
      sema.compile(slicesArg, sliceOf(sliceOf(type, true), true)),
      sliceOf(sliceOf(type, true), true),
      slicesArg
    );
    return allocatingCall(sliceOf(type, false), [slices], call.span, ([value]) =>
      elements(value).flatMap((part) => elements(part))
    );
  }),
  join: fnMember('std.mem.join', (sema, call) => {
    const [allocatorArgument, separatorArg, slicesArg] = expectArgs(sema, call, 3, 'std.mem.join');
    allocatorArg(sema, allocatorArgument);
    const separator = constSlice(sema, separatorArg, U8);
    const slices = sema.coerce(
      sema.compile(slicesArg, sliceOf(CONST_U8_SLICE, true)),
      sliceOf(CONST_U8_SLICE, true),
      slicesArg
    );
    return allocatingCall(sliceOf(U8, false), [separator, slices], call.span, ([sep, value]) => {
      const parts = elements(value).map((part) => elements(part));
      const glue = elements(sep);
      return parts.flatMap((part, index) => (index === 0 ? part : [...glue, ...part]));
    });
  }),
  sort: sorter('std.mem.sort', true),
  sortUnstable: sorter('std.mem.sortUnstable', false),
  zeroes: fnMember('std.mem.zeroes', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'std.mem.zeroes');
    const type = sema.compileType(typeArg);
    return known(
      type,
      zeroValue(type, (struct) => sema.structFields(struct, call.span)),
      call.span
    );
  }),
  cutPrefix: sliceSearch('std.mem.cutPrefix', 'slice', optionalOf(CONST_U8_SLICE), (h, n) => {
    const needle = n as unknown as Value[];
    return startsWith(h, needle) ? newSlice(h.slice(needle.length)) : NULL;
  }),
  cutSuffix: sliceSearch('std.mem.cutSuffix', 'slice', optionalOf(CONST_U8_SLICE), (h, n) => {
    const needle = n as unknown as Value[];
    return needle.length <= h.length && startsWith(h, needle, h.length - needle.length)
      ? newSlice(h.slice(0, h.length - needle.length))
      : NULL;
  }),
  splitScalar: iteratorFactory('std.mem.splitScalar', 'split', 'scalar'),
  splitSequence: iteratorFactory('std.mem.splitSequence', 'split', 'sequence'),
  splitAny: iteratorFactory('std.mem.splitAny', 'split', 'any'),
  tokenizeScalar: iteratorFactory('std.mem.tokenizeScalar', 'token', 'scalar'),
  tokenizeSequence: iteratorFactory('std.mem.tokenizeSequence', 'token', 'sequence'),
  tokenizeAny: iteratorFactory('std.mem.tokenizeAny', 'token', 'any'),
};

function lexicographic(a: Value[], b: Value[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareScalars(a[index], b[index]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function extreme(values: Value[], direction: number): Value {
  if (values.length === 0) panic(PANIC.unreachable);
  let best = values[0];
  for (const value of values.slice(1)) if (compareScalars(value, best) * direction > 0) best = value;
  return best;
}

function extremeIndex(name: string, direction: number): () => Member {
  return generic(name, 2, (sema, call, type, [sliceArg]) => {
    const slice = constSlice(sema, sliceArg, type);
    return computed(USIZE, [slice], call.span, ([value]) => {
      const values = elements(value);
      if (values.length === 0) panic(PANIC.unreachable);
      let best = 0;
      for (let index = 1; index < values.length; index++)
        if (compareScalars(values[index], values[best]) * direction > 0) best = index;
      return BigInt(best);
    });
  });
}

function copier(name: string): () => Member {
  return generic(name, 3, (sema, call, type, [destinationArg, sourceArg]) => {
    const destination = mutableSlice(sema, destinationArg, type);
    const source = constSlice(sema, sourceArg, type);
    return computed(VOID, [destination, source], call.span, ([out, input]) => {
      const values = elements(input);
      const target = out as Slice;
      if (values.length > target.length) panic('reached unreachable code');
      for (const [index, value] of values.entries()) target.set(index, value);
      return;
    });
  });
}

function replaced(input: Value[], needle: Value[], replacement: Value[]): { values: Value[]; count: number } {
  const values: Value[] = [];
  let count = 0;
  let index = 0;
  while (index < input.length) {
    if (needle.length > 0 && startsWith(input, needle, index)) {
      values.push(...replacement);
      index += needle.length;
      count++;
    } else {
      values.push(input[index]);
      index++;
    }
  }
  return { values, count };
}

/** A call that allocates its result, returning `error.OutOfMemory` when the run's slots run out. */
function allocatingCall(type: Type, args: readonly TExpr[], span: Span, compute: (values: Value[]) => Value[]): TExpr {
  const evaluators = args.map((arg) => arg.eval);
  return runtime(
    allocating(type),
    (frame) => {
      const values = compute(evaluators.map((evaluate) => evaluate(frame)));
      frame.runtime.spend(1 + Math.floor(values.length / 16));
      if (!frame.runtime.canAllocate(values.length)) return ERROR_OUT_OF_MEMORY;
      frame.runtime.allocate(values.length);
      return newSlice(values);
    },
    span
  );
}

function sorter(name: string, stable: boolean): () => Member {
  return generic(name, 4, (sema, call, type, [itemsArg, contextArg, lessThanArg]) => {
    const items = mutableSlice(sema, itemsArg, type);
    const context = sema.compile(contextArg);
    const lessThan = sema.functionOf(sema.compile(lessThanArg), lessThanArg);
    if (lessThan.params.length !== 3)
      sema.error(lessThanArg, '比べる関数は fn (context, a, b) bool の形にしてください。');
    const evaluateItems = items.eval;
    const evaluateContext = context.eval;
    return runtime(
      VOID,
      (frame) => {
        const slice = evaluateItems(frame) as Slice;
        const contextValue = evaluateContext(frame);
        const sorted = sortValues(
          slice.values(),
          (a, b) => lessThan.call(frame, [contextValue, a, b]) as boolean,
          stable,
          frame
        );
        for (const [index, value] of sorted.entries()) slice.set(index, value);
        return;
      },
      call.span
    );
  });
}

/** `std.mem.zeroes`: a value whose bits are all zero. */
export function zeroValue(type: Type, fieldsOf: (type: StructType) => readonly StructField[]): Value {
  switch (type.kind) {
    case 'int':
    case 'enum': {
      return 0n;
    }
    case 'float': {
      return type.bits <= 64 ? 0 : undefinedValue(type);
    }
    case 'bool': {
      return false;
    }
    case 'optional': {
      return NULL;
    }
    case 'array': {
      return newArray(
        Array.from({ length: type.length }, () => zeroValue(type.child, fieldsOf)),
        type.sentinel
      );
    }
    case 'struct': {
      return new ZStruct(fieldsOf(type).map((field) => zeroValue(field.type, fieldsOf)));
    }
    default: {
      return undefinedValue(type);
    }
  }
}

/** `findDiff(T, a, b)`: the first index where two slices differ, or where the shorter one ends. */
function diffMember(name: string): Member {
  return generic(name, 3, (sema, call, type, [aArg, bArg]) => {
    const a = constSlice(sema, aArg, type);
    const b = constSlice(sema, bArg, type);
    return computed(OPTIONAL_USIZE, [a, b], call.span, ([x, y]) => {
      const xs = elements(x);
      const ys = elements(y);
      const shorter = Math.min(xs.length, ys.length);
      for (let index = 0; index < shorter; index++) if (!equalValues(xs[index], ys[index])) return BigInt(index);
      return xs.length === ys.length ? NULL : BigInt(shorter);
    });
  })();
}

let mem: StructType | undefined;

export function memNamespace(): StructType {
  mem ??= nativeStruct('std.mem', MEMBERS);
  return mem;
}

export { TYPE };
export type { Expression };
