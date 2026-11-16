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
import { Cell, ErrorValue, NativeHandle, Pointer, Slice, ZArray, ZStruct } from '../values';
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
interface AllocatorState extends Record<string, unknown> {
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
          if (!reserve(frame, allocator(frame), n, child)) return OUT_OF_MEMORY;
          const array = new ZArray(
            Array.from({ length: n }, () => undefinedValue(child)),
            0,
            n
          );
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
          if (!reserve(frame, allocator(frame), 1, child)) return OUT_OF_MEMORY;
          return new Pointer(new Cell(undefinedValue(child)), 0);
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
          if (!reserve(frame, allocator(frame), slice.length, child)) return OUT_OF_MEMORY;
          return new Slice(new ZArray(slice.values(), 0, slice.length), 0, slice.length);
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
      return nativeCall(VOID, [compiled], call.span, (_, frame) => {
        release(allocator(frame));
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
      return nativeCall(VOID, [compiled], call.span, (_, frame) => {
        release(allocator(frame));
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
          if (n > slice.length && !reserve(frame, allocator(frame), n - slice.length, child)) return OUT_OF_MEMORY;
          const values = slice.values().slice(0, n);
          while (values.length < n) values.push(undefinedValue(child));
          return new Slice(new ZArray(values, 0, n), 0, n);
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

/** Allocates `count` elements of a type, counting slots against the run's limit and bytes against a fixed buffer. */
function reserve(frame: Parameters<TExpr['eval']>[0], state: AllocatorState, count: number, type: Type): boolean {
  if (!frame.runtime.canAllocate(count)) return false;
  const owner = state.owner?.load();
  if (owner instanceof ZStruct && state.name === 'fixed') {
    const capacity = owner.slots[0] as bigint;
    const used = owner.slots[1] as bigint;
    const align = BigInt(alignOf(type));
    const start = ((used + align - 1n) / align) * align;
    const end = start + BigInt(sizeOf(type) * count);
    if (end > capacity) return false;
    owner.slots[1] = end;
  } else if (owner instanceof ZStruct && state.name === 'debug') {
    owner.slots[0] = (owner.slots[0] as bigint) + 1n;
  }
  frame.runtime.allocate(count);
  return true;
}

function release(state: AllocatorState): void {
  const owner = state.owner?.load();
  if (owner instanceof ZStruct && state.name === 'debug') owner.slots[0] = (owner.slots[0] as bigint) - 1n;
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
