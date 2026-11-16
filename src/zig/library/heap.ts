// code-gauge-allow-file duplicateLines 16 -- Library types repeat the same shape of method on purpose, each over its own state.
import { alignOf, sizeOf } from '../layout';
import {
  known,
  type NativeCall,
  runtime,
  type SemaApi,
  smallestUnsigned,
  type TExpr,
  undefinedValue,
} from '../semaBase';
import {
  type EnumType,
  errorSetOf,
  errorUnionOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  USIZE,
  VOID,
} from '../types';
import { Cell, ErrorValue, NativeHandle, Pointer, Slice, type Value, ZArray, ZStruct } from '../values';
import {
  compileArgs,
  expectArgs,
  fnMember,
  handle,
  type Member,
  nativeCall,
  nativeStruct,
  typeMember,
  unavailableMember,
} from './native';

export const ERROR_OUT_OF_MEMORY = ErrorValue.of('OutOfMemory');
const OUT_OF_MEMORY = ERROR_OUT_OF_MEMORY;
export const ALLOCATOR_ERROR = errorSetOf(['OutOfMemory']);

/** `std.mem.Allocator`, whose values are handles to an allocator's state. */
export const ALLOCATOR: StructType = nativeStruct('mem.Allocator', {});

/** What an allocator handle keeps: the bytes a fixed buffer allows, and the live allocations for leak checks. */
export interface AllocatorState extends Record<string, unknown> {
  name: string;
  /** The struct of an allocator instance (`DebugAllocator`, `FixedBufferAllocator`), whose fields count its use. */
  owner?: Pointer;
}

export function nativeEnum(name: string, fieldNames: string[]): EnumType {
  return {
    kind: 'enum',
    namespace: { name, decls: new Map() },
    tagType: smallestUnsigned(Math.max(fieldNames.length - 1, 0)),
    fields: fieldNames.map((field, index) => ({ name: field, value: BigInt(index) })),
    exhaustive: true,
  };
}

const CHECK = nativeEnum('heap.Check', ['ok', 'leak']);

export function allocatorMembers(): Record<string, () => Member> {
  return {
    Error: typeMember(() => ALLOCATOR_ERROR),
    alloc: fnMember('Allocator.alloc', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg, countArg] = expectArgs(sema, call, 2, 'alloc');
      const child = sema.compileType(typeArg);
      const [count] = compileArgs(sema, [countArg], [USIZE]);
      const evaluate = count.eval;
      return runtime(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        (frame) => {
          const n = Number(evaluate(frame) as bigint);
          if (!frame.runtime.canAllocate(n)) return OUT_OF_MEMORY;
          const array = new ZArray(
            Array.from({ length: n }, () => undefinedValue(child)),
            0,
            n
          );
          if (!allocateMemory(frame, allocator(frame), array, n, child)) return OUT_OF_MEMORY;
          return new Slice(array, 0, n);
        },
        call.span
      );
    }),
    create: fnMember('Allocator.create', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg] = expectArgs(sema, call, 1, 'create');
      const child = sema.compileType(typeArg);
      return runtime(
        errorUnionOf(ALLOCATOR_ERROR, pointerTo(child, false)),
        (frame) => {
          const cell = new Cell(undefinedValue(child));
          if (!allocateMemory(frame, allocator(frame), cell, 1, child)) return OUT_OF_MEMORY;
          return new Pointer(cell, 0);
        },
        call.span
      );
    }),
    dupe: fnMember('Allocator.dupe', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg, sliceArg] = expectArgs(sema, call, 2, 'dupe');
      const child = sema.compileType(typeArg);
      const [source] = compileArgs(sema, [sliceArg], [sliceOf(child, true)]);
      const evaluate = source.eval;
      return runtime(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        (frame) => {
          const slice = evaluate(frame) as Slice;
          const array = new ZArray(slice.values(), 0, slice.length);
          if (!allocateMemory(frame, allocator(frame), array, slice.length, child)) return OUT_OF_MEMORY;
          return new Slice(array, 0, slice.length);
        },
        call.span
      );
    }),
    free: fnMember('Allocator.free', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [memory] = expectArgs(sema, call, 1, 'free');
      const compiled = sema.compile(memory);
      if (compiled.type.kind !== 'pointer' || compiled.type.size !== 'slice') {
        sema.error(memory, `free にはスライスを渡してください（${typeName(compiled.type)} 型です）。`);
      }
      return nativeCall(VOID, [compiled], call.span, ([slice], frame) => {
        freeMemory(allocator(frame), (slice as Slice).target);
        return;
      });
    }),
    destroy: fnMember('Allocator.destroy', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [pointer] = expectArgs(sema, call, 1, 'destroy');
      const compiled = sema.compile(pointer);
      if (compiled.type.kind !== 'pointer' || compiled.type.size !== 'one') {
        sema.error(pointer, `destroy にはポインタを渡してください（${typeName(compiled.type)} 型です）。`);
      }
      return nativeCall(VOID, [compiled], call.span, ([pointer], frame) => {
        freeMemory(allocator(frame), (pointer as Pointer).target);
        return;
      });
    }),
    realloc: fnMember('Allocator.realloc', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [memory, countArg] = expectArgs(sema, call, 2, 'realloc');
      const compiled = sema.compile(memory);
      const type = compiled.type;
      if (type.kind !== 'pointer' || type.size !== 'slice')
        return sema.error(memory, 'realloc にはスライスを渡してください。');
      const [count] = compileArgs(sema, [countArg], [USIZE]);
      const child = type.child;
      return nativeCall(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        [compiled, count],
        call.span,
        ([value, size], frame) => {
          const slice = value as Slice;
          const n = Number(size as bigint);
          if (!frame.runtime.canAllocate(n)) return OUT_OF_MEMORY;
          const values = slice.values().slice(0, n);
          while (values.length < n) values.push(undefinedValue(child));
          const array = new ZArray(values, 0, n);
          if (!allocateMemory(frame, allocator(frame), array, n, child, slice.target)) return OUT_OF_MEMORY;
          return new Slice(array, 0, n);
        }
      );
    }),
  };
}

for (const [name, resolve] of Object.entries(allocatorMembers())) {
  let resolved: Member | undefined;
  ALLOCATOR.namespace.decls.set(name, {
    kind: 'native',
    name,
    resolve: () => {
      resolved ??= resolve();
      return resolved;
    },
  });
}

function allocatorOf(sema: SemaApi, call: NativeCall): (frame: Parameters<TExpr['eval']>[0]) => AllocatorState {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, 'std.mem.Allocator の値に対して呼び出してください。');
  const evaluate = receiver.eval;
  if (receiver.type === ALLOCATOR) return (frame) => (evaluate(frame) as NativeHandle).state as AllocatorState;
  if (receiver.type.kind === 'pointer' && receiver.type.child === ALLOCATOR) {
    return (frame) => ((evaluate(frame) as Pointer).load() as NativeHandle).state as AllocatorState;
  }
  return sema.error(call.span, 'std.mem.Allocator の値に対して呼び出してください。');
}

/** The state of an `Allocator` value. */
export function allocatorState(value: Value): AllocatorState {
  return (value as NativeHandle).state as AllocatorState;
}

/** Where an allocation of a fixed buffer allocator lies in its buffer, by the object that holds the memory. */
const fixedPlaces = new WeakMap<object, { start: bigint; end: bigint }>();

/**
 * Allocates `count` elements of a type held by `memory`, counting slots against the run's limit and bytes against a
 * fixed buffer. With `previous`, the memory replaces it as `remap` or `realloc` does: a fixed buffer resizes its last
 * allocation in place, and otherwise allocates anew and frees the previous memory. False when memory runs out.
 */
export function allocateMemory(
  frame: Parameters<TExpr['eval']>[0],
  state: AllocatorState | undefined,
  memory: object,
  count: number,
  type: Type,
  previous?: object
): boolean {
  if (!frame.runtime.canAllocate(count)) return false;
  const owner = state?.owner?.load();
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    const capacity = owner.slots[0] as bigint;
    const used = owner.slots[1] as bigint;
    const size = BigInt(sizeOf(type) * count);
    const place = previous ? fixedPlaces.get(previous) : undefined;
    if (place && place.end === used && place.start + size <= capacity) {
      owner.slots[1] = place.start + size;
      fixedPlaces.set(memory, { start: place.start, end: place.start + size });
    } else {
      const align = BigInt(alignOf(type));
      const start = ((used + align - 1n) / align) * align;
      if (start + size > capacity) return false;
      owner.slots[1] = start + size;
      fixedPlaces.set(memory, { start, end: start + size });
    }
  } else if (owner instanceof ZStruct && state?.name === 'debug' && !previous) {
    owner.slots[0] = (owner.slots[0] as bigint) + 1n;
  }
  frame.runtime.allocate(count);
  return true;
}

/** Frees memory: a fixed buffer takes back its last allocation, and a debug allocator counts one fewer live one. */
export function freeMemory(state: AllocatorState | undefined, memory: object): void {
  const owner = state?.owner?.load();
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    const place = fixedPlaces.get(memory);
    if (place && place.end === owner.slots[1]) owner.slots[1] = place.start;
  } else if (owner instanceof ZStruct && state?.name === 'debug') {
    owner.slots[0] = (owner.slots[0] as bigint) - 1n;
  }
}

/** A native type of an allocator instance, whose `allocator()` method gives an Allocator using it. */
function allocatorInstanceType(
  name: string,
  kind: string,
  fields: { name: string; type: Type }[],
  members: Record<string, () => Member>
): StructType {
  const type = nativeStruct(
    name,
    {
      allocator: fnMember(`${name}.allocator`, (sema, call) => {
        expectArgs(sema, call, 0, 'allocator');
        const owner = instancePointer(sema, call, type);
        return nativeCall(ALLOCATOR, [owner], call.span, ([pointer]) =>
          handle('allocator', { name: kind, owner: pointer as Pointer })
        );
      }),
      ...members,
    },
    fields.map((field) => ({ ...field, hasDefault: false }))
  );
  return type;
}

function instancePointer(sema: SemaApi, call: NativeCall, type: StructType): TExpr {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
  if (receiver.type.kind === 'pointer' && receiver.type.child === type) return receiver;
  if (receiver.type !== type) return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
  const address = sema.addressOf(receiver);
  if (address.type.kind === 'pointer' && address.type.isConst)
    sema.error(call.span, `定数の ${type.namespace.name} は使えません（var で宣言してください）。`);
  return address;
}

const DEBUG_ALLOCATOR: StructType = allocatorInstanceType(
  'heap.DebugAllocator',
  'debug',
  [{ name: 'live', type: USIZE }],
  {
    init: () => ({ type: DEBUG_ALLOCATOR_TYPE(), value: new ZStruct([0n]) }),
    deinit: fnMember('DebugAllocator.deinit', (sema, call) => {
      expectArgs(sema, call, 0, 'deinit');
      const owner = instancePointer(sema, call, DEBUG_ALLOCATOR);
      return nativeCall(CHECK, [owner], call.span, ([pointer]) => {
        const struct = (pointer as Pointer).load() as ZStruct;
        return (struct.slots[0] as bigint) > 0n ? 1n : 0n;
      });
    }),
  }
);

function DEBUG_ALLOCATOR_TYPE(): StructType {
  return DEBUG_ALLOCATOR;
}

const ARENA_ALLOCATOR: StructType = allocatorInstanceType('heap.ArenaAllocator', 'arena', [], {
  init: fnMember('ArenaAllocator.init', (sema, call) => {
    const [child] = compileArgs(sema, expectArgs(sema, call, 1, 'ArenaAllocator.init'), [ALLOCATOR]);
    return nativeCall(ARENA_ALLOCATOR, [child], call.span, () => new ZStruct([]));
  }),
  deinit: fnMember('ArenaAllocator.deinit', (sema, call) => {
    expectArgs(sema, call, 0, 'deinit');
    return known(VOID, undefined, call.span);
  }),
});

const FIXED_BUFFER_ALLOCATOR: StructType = allocatorInstanceType(
  'heap.FixedBufferAllocator',
  'fixed',
  [
    { name: 'capacity', type: USIZE },
    { name: 'end_index', type: USIZE },
  ],
  {
    init: fnMember('FixedBufferAllocator.init', (sema, call) => {
      const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'FixedBufferAllocator.init'), [sliceOf(U8, false)]);
      return nativeCall(
        FIXED_BUFFER_ALLOCATOR,
        [buffer],
        call.span,
        ([slice]) => new ZStruct([BigInt((slice as Slice).length), 0n])
      );
    }),
    reset: fnMember('FixedBufferAllocator.reset', (sema, call) => {
      expectArgs(sema, call, 0, 'reset');
      const owner = instancePointer(sema, call, FIXED_BUFFER_ALLOCATOR);
      return nativeCall(VOID, [owner], call.span, ([pointer]) => {
        ((pointer as Pointer).load() as ZStruct).slots[1] = 0n;
        return;
      });
    }),
  }
);

let heap: StructType | undefined;

export function heapNamespace(): StructType {
  heap ??= nativeStruct('std.heap', {
    page_allocator: () => ({ type: ALLOCATOR, value: handle('allocator', { name: 'page' }) }),
    smp_allocator: () => ({ type: ALLOCATOR, value: handle('allocator', { name: 'smp' }) }),
    DebugAllocator: fnMember('std.heap.DebugAllocator', (sema, call) => {
      const [config] = expectArgs(sema, call, 1, 'std.heap.DebugAllocator');
      sema.compile(config);
      return known(TYPE, DEBUG_ALLOCATOR, call.span);
    }),
    ArenaAllocator: typeMember(() => ARENA_ALLOCATOR),
    FixedBufferAllocator: typeMember(() => FIXED_BUFFER_ALLOCATOR),
    Check: typeMember(() => CHECK),
    c_allocator: unavailableMember('C との連携（std.heap.c_allocator）'),
  });
  return heap;
}

export { ARENA_ALLOCATOR, NativeHandle };
