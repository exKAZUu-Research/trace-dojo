import { allocationSlots } from '../allocation';
// code-gauge-allow-file duplicateLines 23 -- Library types repeat the same shape of method on purpose, each over its own state.
import { alignOf, sizeOf } from '../layout';
import {
  copyForStorage,
  known,
  type NativeCall,
  type SemaApi,
  smallestUnsigned,
  type TExpr,
  undefinedValue,
} from '../semaBase';
import {
  BOOL,
  type EnumType,
  errorSetOf,
  errorUnionOf,
  pointerTo,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  U8,
  USIZE,
  VOID,
} from '../types';
import { Cell, ErrorValue, NativeHandle, Pointer, Slice, type Value, ZArray, ZStruct } from '../values';
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  handle,
  type Member,
  nativeCall,
  nativeStateCall,
  nativeStruct,
  typeMember,
  unavailableDeclarations,
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
  const type: EnumType = {
    kind: 'enum',
    namespace: { name, decls: new Map() },
    tagType: smallestUnsigned(Math.max(fieldNames.length - 1, 0)),
    fields: fieldNames.map((field, index) => ({ name: field, value: BigInt(index) })),
    exhaustive: true,
  };
  addMembers(type, unavailableDeclarations(name));
  return type;
}

const CHECK = nativeEnum('heap.Check', ['ok', 'leak']);

// code-gauge-allow functionNcss 59 -- Defines the allocator methods as closures over their receiver and element type.
// code-gauge-allow functionCognitiveComplexity 18 -- Defines the allocator methods as closures over their receiver and element type.
export function allocatorMembers(): Record<string, () => Member> {
  return {
    Error: typeMember(() => ALLOCATOR_ERROR),
    alloc: fnMember('Allocator.alloc', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg, countArg] = expectArgs(sema, call, 2, 'alloc');
      const child = sema.compileType(typeArg);
      sema.resolveStorage(child, call.span);
      const [count] = compileArgs(sema, [countArg], [USIZE]);
      return nativeStateCall(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        [count],
        call.span,
        allocator,
        (state, [count], frame) => {
          const n = Number(count as bigint);
          const complete = reserveNativeAllocation(frame, state, n, child);
          if (!complete) return OUT_OF_MEMORY;
          const array = new ZArray(
            Array.from({ length: n }, () => undefinedValue(child)),
            0,
            n
          );
          complete(array);
          return new Slice(array, 0, n);
        }
      );
    }),
    create: fnMember('Allocator.create', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg] = expectArgs(sema, call, 1, 'create');
      const child = sema.compileType(typeArg);
      sema.resolveStorage(child, call.span);
      return nativeStateCall(
        errorUnionOf(ALLOCATOR_ERROR, pointerTo(child, false)),
        [],
        call.span,
        allocator,
        (state, _args, frame) => {
          const complete = reserveNativeAllocation(frame, state, 1, child);
          if (!complete) return OUT_OF_MEMORY;
          const cell = new Cell(undefinedValue(child));
          complete(cell);
          return new Pointer(cell, 0);
        }
      );
    }),
    dupe: fnMember('Allocator.dupe', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [typeArg, sliceArg] = expectArgs(sema, call, 2, 'dupe');
      const child = sema.compileType(typeArg);
      sema.resolveStorage(child, call.span);
      const [source] = compileArgs(sema, [sliceArg], [sliceOf(child, true)]);
      return nativeStateCall(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        [source],
        call.span,
        allocator,
        (state, [value], frame) => {
          const slice = value as Slice;
          const complete = reserveNativeAllocation(frame, state, slice.length, child);
          if (!complete) return OUT_OF_MEMORY;
          const array = new ZArray(slice.values().map(copyForStorage), 0, slice.length);
          complete(array);
          return new Slice(array, 0, slice.length);
        }
      );
    }),
    free: freeMember('free', 'slice'),
    destroy: freeMember('destroy', 'one'),
    realloc: fnMember('Allocator.realloc', (sema, call) => {
      const allocator = allocatorOf(sema, call);
      const [memory, countArg] = expectArgs(sema, call, 2, 'realloc');
      const compiled = sema.compile(memory);
      const type = compiled.type;
      if (type.kind !== 'pointer' || type.size !== 'slice')
        return sema.error(memory, 'realloc にはスライスを渡してください。');
      const [count] = compileArgs(sema, [countArg], [USIZE]);
      const child = type.child;
      sema.resolveStorage(child, call.span);
      return nativeStateCall(
        errorUnionOf(ALLOCATOR_ERROR, sliceOf(child, false)),
        [compiled, count],
        call.span,
        allocator,
        (state, [value, size], frame) => {
          const slice = value as Slice,
            n = Number(size as bigint);
          const complete = reserveNativeAllocation(frame, state, n, child, slice.target);
          if (!complete) return OUT_OF_MEMORY;
          const values = slice.values().slice(0, n).map(copyForStorage);
          while (values.length < n) values.push(undefinedValue(child));
          const array = new ZArray(values, 0, n);
          complete(array);
          return new Slice(array, 0, n);
        }
      );
    }),
  };
}

function freeMember(name: 'free' | 'destroy', size: 'slice' | 'one'): () => Member {
  return fnMember(`Allocator.${name}`, (sema, call) => {
    const allocator = allocatorOf(sema, call);
    const [memory] = expectArgs(sema, call, 1, name);
    const compiled = sema.compile(memory);
    if (compiled.type.kind !== 'pointer' || compiled.type.size !== size)
      sema.error(memory, `${name} に渡すメモリの型が違います。`);
    return nativeStateCall(VOID, [compiled], call.span, allocator, (state, [value]) => {
      freeMemory(state, size === 'slice' ? (value as Slice).target : (value as Pointer).target);
      return;
    });
  });
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

// code-gauge-allow functionCognitiveComplexity 16 -- Reserves shared and allocator-specific capacity before construction.
export function reserveNativeAllocation(
  frame: Parameters<TExpr['eval']>[0],
  state: AllocatorState | undefined,
  count: number,
  type: Type,
  previous?: object
): ((memory: object) => void) | undefined {
  const slots = allocationSlots(count, type);
  if (!frame.runtime.canAllocate(slots)) return undefined;
  frame.runtime.spend(1 + Math.floor(slots / 16));
  const owner = state?.owner?.load();
  let reserved: { start: bigint; end: bigint } | undefined;
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    const capacity = owner.slots[0] as bigint,
      used = owner.slots[1] as bigint;
    const size = BigInt(sizeOf(type) * count);
    const place = previous ? fixedPlaces.get(previous) : undefined;
    if (place && place.end === used && place.start + size <= capacity)
      reserved = { start: place.start, end: place.start + size };
    else {
      const alignment = BigInt(alignOf(type));
      const start = ((used + alignment - 1n) / alignment) * alignment;
      if (start + size > capacity) return undefined;
      reserved = { start, end: start + size };
    }
    owner.slots[1] = reserved.end;
  } else if (owner instanceof ZStruct && state?.name === 'debug' && !previous)
    owner.slots[0] = (owner.slots[0] as bigint) + 1n;
  frame.runtime.allocate(slots);
  return (memory) => {
    if (reserved) fixedPlaces.set(memory, reserved);
  };
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
  reset: fnMember('ArenaAllocator.reset', (sema, call) => {
    // Any `ResetMode` succeeds: the arena keeps no memory of its own to give back or retain.
    const [mode] = expectArgs(sema, call, 1, 'reset');
    sema.compile(mode);
    return known(BOOL, true, call.span);
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
