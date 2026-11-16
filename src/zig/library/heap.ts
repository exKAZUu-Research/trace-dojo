import { allocationSlots } from '../allocation';
import {
  type AllocatorState,
  arenaCapacity,
  bindAllocatorBytes,
  deinitArena,
  freeAllocatorMemory as freeMemory,
  reserveAllocatorBytes,
  resetArena,
} from '../allocatorStorage';
// code-gauge-allow-file duplicateLines 23 -- Library types repeat the same shape of method on purpose, each over its own state.
import { alignOf, sizeOf } from '../layout';
import {
  copyForStorage,
  known,
  type NativeCall,
  runtime,
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
  type UnionType,
  USIZE,
  VOID,
} from '../types';
import {
  Cell,
  ErrorValue,
  NativeHandle,
  NULL,
  Pointer,
  Slice,
  type Value,
  ZArray,
  ZStruct,
  type ZUnion,
} from '../values';
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
export const ALLOCATOR: StructType = nativeStruct('mem.Allocator', {}, [], {
  kind: 'allocator',
  args: [],
  byteSize: 16,
});

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
          complete(array, 0);
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
          complete(cell, 0);
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
          complete(array, Math.min(slice.length, n));
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

export function reserveNativeAllocation(
  frame: Parameters<TExpr['eval']>[0],
  state: AllocatorState | undefined,
  count: number,
  type: Type,
  previous?: object
): ((memory: object, initialized?: number) => void) | undefined {
  const slots = allocationSlots(count, type);
  if (!frame.runtime.canAllocate(slots)) return undefined;
  frame.runtime.spend(1 + Math.floor(slots / 16));
  const bytes = reserveAllocatorBytes(frame, state, sizeOf(type) * count, alignOf(type), previous);
  if (!bytes) return undefined;
  frame.runtime.allocate(slots);
  return (memory, initialized = count) => bindAllocatorBytes(frame, bytes, memory, type, count, initialized);
}

/** A native type of an allocator instance, whose `allocator()` method gives an Allocator using it. */
function allocatorInstanceType(
  name: string,
  kind: string,
  fields: { name: string; type: Type; defaultValue?: Value }[],
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
    fields.map((field) => ({ ...field, hasDefault: 'defaultValue' in field }))
  );
  return type;
}

function instancePointer(sema: SemaApi, call: NativeCall, type: StructType): TExpr {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
  if (receiver.type.kind === 'pointer' && receiver.type.child === type) {
    if (receiver.type.isConst)
      return sema.error(call.span, `定数の ${type.namespace.name} は使えません（var で宣言してください）。`);
    return receiver;
  }
  if (receiver.type !== type) return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
  const address = sema.addressOf(receiver);
  if (address.type.kind === 'pointer' && address.type.isConst)
    sema.error(call.span, `定数の ${type.namespace.name} は使えません（var で宣言してください）。`);
  return address;
}

function instanceValue(sema: SemaApi, call: NativeCall, type: StructType): TExpr {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
  if (receiver.type === type) return receiver;
  if (receiver.type.kind === 'pointer' && receiver.type.child === type)
    return runtime(type, (frame) => (receiver.eval(frame) as Pointer).load(), call.span);
  return sema.error(call.span, `${type.namespace.name} の値に対して呼び出してください。`);
}

const DEBUG_ALLOCATOR: StructType = allocatorInstanceType(
  'heap.DebugAllocator',
  'debug',
  [{ name: 'live', type: USIZE, defaultValue: 0n }],
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

const ARENA_STATE = nativeStruct('heap.ArenaAllocator.State', {}, [], {
  kind: 'arenaState',
  args: [],
  storageSlots: 2,
  byteSize: 16,
});
const ARENA_RESET_TAG = nativeEnum('heap.ArenaAllocator.ResetMode', [
  'free_all',
  'retain_capacity',
  'retain_with_limit',
]);
const ARENA_RESET_MODE: UnionType = {
  kind: 'union',
  namespace: { name: 'heap.ArenaAllocator.ResetMode', decls: new Map() },
  fields: [
    { name: 'free_all', type: VOID },
    { name: 'retain_capacity', type: VOID },
    { name: 'retain_with_limit', type: USIZE },
  ],
  tagType: ARENA_RESET_TAG,
  layout: 'auto',
};

const ARENA_ALLOCATOR: StructType = allocatorInstanceType(
  'heap.ArenaAllocator',
  'arena',
  [
    { name: 'child_allocator', type: ALLOCATOR },
    { name: 'state', type: ARENA_STATE },
  ],
  {
    State: typeMember(() => ARENA_STATE),
    ResetMode: typeMember(() => ARENA_RESET_MODE),
    init: fnMember('ArenaAllocator.init', (sema, call) => {
      const [child] = compileArgs(sema, expectArgs(sema, call, 1, 'ArenaAllocator.init'), [ALLOCATOR]);
      return nativeCall(ARENA_ALLOCATOR, [child], call.span, ([value]) => arenaValue(value));
    }),
    deinit: fnMember('ArenaAllocator.deinit', (sema, call) => {
      expectArgs(sema, call, 0, 'deinit');
      const value = instanceValue(sema, call, ARENA_ALLOCATOR);
      return nativeCall(VOID, [value], call.span, ([arena], frame) => {
        deinitArena(frame, arena as ZStruct);
        return;
      });
    }),
    queryCapacity: fnMember('ArenaAllocator.queryCapacity', (sema, call) => {
      expectArgs(sema, call, 0, 'queryCapacity');
      const value = instanceValue(sema, call, ARENA_ALLOCATOR);
      return nativeCall(USIZE, [value], call.span, ([arena]) => BigInt(arenaCapacity(arena as ZStruct)));
    }),
    reset: fnMember('ArenaAllocator.reset', (sema, call) => {
      const owner = instancePointer(sema, call, ARENA_ALLOCATOR);
      const [mode] = compileArgs(sema, expectArgs(sema, call, 1, 'reset'), [ARENA_RESET_MODE]);
      return nativeCall(BOOL, [owner, mode], call.span, ([pointer, value], frame) => {
        const reset = value as ZUnion;
        const limit = reset.tag === 0 ? 0 : reset.tag === 2 ? Number(reset.slots[0] as bigint) : undefined;
        return resetArena(frame, (pointer as Pointer).load() as ZStruct, limit);
      });
    }),
  }
);

export function arenaValue(child: Value): ZStruct {
  return new ZStruct([child, new ZStruct([NULL, NULL])]);
}

const FIXED_BUFFER_ALLOCATOR: StructType = allocatorInstanceType(
  'heap.FixedBufferAllocator',
  'fixed',
  [
    { name: 'end_index', type: USIZE },
    { name: 'buffer', type: sliceOf(U8, false) },
  ],
  {
    init: fnMember('FixedBufferAllocator.init', (sema, call) => {
      const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'FixedBufferAllocator.init'), [sliceOf(U8, false)]);
      return nativeCall(FIXED_BUFFER_ALLOCATOR, [buffer], call.span, ([slice]) => new ZStruct([0n, slice]));
    }),
    reset: fnMember('FixedBufferAllocator.reset', (sema, call) => {
      expectArgs(sema, call, 0, 'reset');
      const owner = instancePointer(sema, call, FIXED_BUFFER_ALLOCATOR);
      return nativeCall(VOID, [owner], call.span, ([pointer]) => {
        ((pointer as Pointer).load() as ZStruct).slots[0] = 0n;
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

export { type AllocatorState, freeMemory };
