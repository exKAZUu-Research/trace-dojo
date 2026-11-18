import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { intType, type StructType, type Type, type UnionType } from './types';

/** `@sizeOf` and `@alignOf` as on the reference toolchain's target (aarch64), which the library's growth depends on. */
export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

export function alignOf(type: Type): number {
  return layoutOf(type).align;
}

export function usesFieldLayout(type: StructType): boolean {
  return type.native?.storageSlots === undefined && type.native?.kind !== 'allocator';
}

export function fieldOffsets(type: StructType): number[] {
  return resolvedFields.get(type) ?? calculateFieldOffsets(type, new LayoutQuery());
}

function calculateFieldOffsets(type: StructType, query: LayoutQuery): number[] {
  if (type.native?.kind === 'writer') return [8 * 8, 24 * 8];
  const fields = type.fields ?? [];
  const offsets = fields.map(() => 0);
  const ordered = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.comptimeValue === undefined);
  if (type.layout === 'auto')
    ordered.sort((a, b) => {
      query.spend();
      return query.layout(b.field.type).align - query.layout(a.field.type).align;
    });
  let offset = 0;
  for (const { field, index } of ordered) {
    query.spend();
    if (type.layout === 'packed') {
      offsets[index] = offset;
      offset += query.bits(field.type);
    } else {
      offset = alignTo(offset, query.layout(field.type).align);
      offsets[index] = offset * 8;
      offset += query.layout(field.type).size;
    }
  }
  return offsets;
}

export function unionOffsets(type: UnionType): { payload: number; tag: number | undefined } {
  return resolvedUnions.get(type) ?? calculateUnionOffsets(type, new LayoutQuery());
}

function calculateUnionOffsets(type: UnionType, query: LayoutQuery): { payload: number; tag: number | undefined } {
  if (type.layout !== 'auto' || type.fields?.length === 1) return { payload: 0, tag: undefined };
  const { size: payloadSize, align: payloadAlign } = unionPayload(type, query);
  const tag = query.layout(type.tagType ?? intType(false, 8));
  return tag.align >= payloadAlign
    ? { tag: 0, payload: alignTo(tag.size, payloadAlign) }
    : { payload: 0, tag: alignTo(payloadSize, tag.align) };
}

export function errorUnionOffsets(payload: Type): { payload: number; error: number } {
  const layout = layoutOf(payload);
  return layout.align >= 2 ? { payload: 0, error: layout.size } : { payload: 2, error: 0 };
}

interface Layout {
  size: number;
  align: number;
}

function alignTo(value: number, align: number): number {
  return align === 0 ? value : Math.ceil(value / align) * align;
}

function intLayout(bits: number): Layout {
  if (bits === 0) return { size: 0, align: 1 };
  const bytes = Math.ceil(bits / 8);
  let size = 1;
  while (size < bytes) size *= 2;
  if (size > 16) size = alignTo(bytes, 16);
  return { size, align: Math.min(size, 16) };
}

const leafLayouts = new WeakMap<Type, Layout>();
const resolvedLayouts = new WeakMap<Type, Layout>();
const resolvedBits = new WeakMap<Type, number>();
const resolvedFields = new WeakMap<StructType, number[]>();
const resolvedUnions = new WeakMap<UnionType, { payload: number; tag: number | undefined }>();

export function hasResolvedLayout(type: Type): boolean {
  return resolvedLayouts.has(type);
}

export function resolveTypeLayout(type: Type, spend: () => void): void {
  const query = new LayoutQuery(spend);
  const layout = query.layout(type);
  const bits = query.bits(type);
  const fields = type.kind === 'struct' ? calculateFieldOffsets(type, query) : undefined;
  const union = type.kind === 'union' ? calculateUnionOffsets(type, query) : undefined;
  resolvedLayouts.set(type, layout);
  resolvedBits.set(type, bits);
  if (fields && type.kind === 'struct') resolvedFields.set(type, fields);
  if (union && type.kind === 'union') resolvedUnions.set(type, union);
}

class LayoutQuery {
  private readonly layouts = new Map<Type, Layout>();
  private readonly bitSizes = new Map<Type, number>();
  private readonly active = new Set<Type>();
  constructor(
    private readonly spendWork = (() => {
      const budget = new ExecutionBudget();
      return (): void => budget.spend();
    })()
  ) {}

  spend(): void {
    this.spendWork();
  }

  layout(type: Type): Layout {
    const cached = this.layouts.get(type) ?? resolvedLayouts.get(type) ?? leafLayouts.get(type);
    if (cached) return cached;
    this.enter(type);
    try {
      const result = computeLayout(type, this);
      this.layouts.set(type, result);
      if (['int', 'float', 'bool', 'pointer', 'error_set', 'void', 'noreturn'].includes(type.kind))
        leafLayouts.set(type, result);
      return result;
    } finally {
      this.active.delete(type);
    }
  }

  bits(type: Type): number {
    const cached = this.bitSizes.get(type) ?? resolvedBits.get(type);
    if (cached !== undefined) return cached;
    let result: number;
    if ((type.kind === 'struct' || type.kind === 'union') && type.layout === 'packed') {
      this.enter(type);
      try {
        result = 0;
        const fields = type.kind === 'union' ? type.fields?.slice(0, 1) : type.fields;
        for (const field of fields ?? []) {
          this.spend();
          result += this.bits(field.type);
        }
      } finally {
        this.active.delete(type);
      }
    } else if (type.kind === 'int' || type.kind === 'float') result = type.bits;
    else if (type.kind === 'bool') result = 1;
    else if (type.kind === 'enum') result = type.tagType?.bits ?? 0;
    else result = this.layout(type).size * 8;
    this.bitSizes.set(type, result);
    return result;
  }

  private enter(type: Type): void {
    this.spend();
    if (this.active.has(type) || this.active.size >= LIMITS.maxCallDepth) throw new ExecutionLimitError('storage');
    this.active.add(type);
  }
}

function layoutOf(type: Type): Layout {
  return resolvedLayouts.get(type) ?? leafLayouts.get(type) ?? new LayoutQuery().layout(type);
}

// code-gauge-allow functionNcss 59 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
function computeLayout(type: Type, query: LayoutQuery): Layout {
  switch (type.kind) {
    case 'int': {
      return intLayout(type.bits);
    }
    case 'float': {
      const size = type.bits === 80 ? 16 : type.bits / 8;
      return { size, align: size };
    }
    case 'bool': {
      return { size: 1, align: 1 };
    }
    case 'pointer': {
      return type.size === 'slice' ? { size: 16, align: 8 } : { size: 8, align: 8 };
    }
    case 'array': {
      const child = query.layout(type.child);
      return {
        size: child.size * Number(type.length + (type.sentinel === undefined ? 0n : 1n)),
        align: child.align,
      };
    }
    case 'optional': {
      if (optionalNicheBits(type.child)) return query.layout(type.child);
      const child = query.layout(type.child);
      return { size: alignTo(child.size + 1, child.align), align: child.align };
    }
    case 'error_set': {
      return { size: 2, align: 2 };
    }
    case 'error_union': {
      const payload = query.layout(type.payload);
      const align = Math.max(payload.align, 2);
      return { size: alignTo(payload.size + 2, align), align };
    }
    case 'enum': {
      return intLayout(type.tagType?.bits ?? 0);
    }
    case 'struct': {
      if (type.native?.byteSize !== undefined)
        return { size: type.native.byteSize, align: type.native.byteAlignment ?? 8 };
      const fields = (type.fields ?? [])
        .filter((field) => field.comptimeValue === undefined)
        .map((field) => {
          query.spend();
          return query.layout(field.type);
        });
      if (type.layout === 'packed') {
        let bits = 0;
        for (const field of type.fields ?? []) {
          query.spend();
          bits += query.bits(field.type);
        }
        return intLayout(bits);
      }
      const sorted =
        type.layout === 'extern'
          ? fields
          : fields.toSorted((a, b) => {
              query.spend();
              return b.align - a.align;
            });
      let size = 0;
      let align = 1;
      for (const field of sorted) {
        size = alignTo(size, field.align) + field.size;
        align = Math.max(align, field.align);
      }
      return { size: alignTo(size, align), align };
    }
    case 'union': {
      return unionLayout(type, query);
    }
    default: {
      return { size: 0, align: 1 };
    }
  }
}

function unionLayout(type: UnionType, query: LayoutQuery): Layout {
  const payload = unionPayload(type, query);
  if (type.layout !== 'auto' || type.fields?.length === 1)
    return { size: alignTo(payload.size, payload.align), align: payload.align };
  let { size, align } = payload;
  const tag = type.tagType ? intLayout(type.tagType.tagType?.bits ?? 0) : intLayout(8);
  if (tag.size > 0) {
    size = alignTo(size, tag.align) + tag.size;
    align = Math.max(align, tag.align);
  }
  return { size: alignTo(size, align), align };
}

export function optionalNicheBits(child: Type): number | undefined {
  return child.kind === 'pointer' ? 64 : child.kind === 'error_set' ? 16 : undefined;
}

const valueDependentWrites = new WeakMap<Type, boolean>();

export function hasValueDependentWrites(type: Type, spend: () => void): boolean {
  spend();
  const cached = valueDependentWrites.get(type);
  if (cached !== undefined) return cached;
  const result = valueDependentWriteLayout(type, spend);
  valueDependentWrites.set(type, result);
  return result;
}

function valueDependentWriteLayout(type: Type, spend: () => void): boolean {
  switch (type.kind) {
    case 'error_union':
    case 'union': {
      return true;
    }
    case 'optional': {
      return optionalNicheBits(type.child) === undefined;
    }
    case 'array': {
      return hasValueDependentWrites(type.child, spend);
    }
    case 'struct': {
      return Boolean(type.fields?.some((field) => !field.comptimeValue && hasValueDependentWrites(field.type, spend)));
    }
    default: {
      return false;
    }
  }
}

export function bitSizeOf(type: Type, spendWork?: () => void): number {
  return resolvedBits.get(type) ?? new LayoutQuery(spendWork).bits(type);
}

function unionPayload(type: UnionType, query: LayoutQuery): Layout {
  let size = 0;
  let align = 1;
  for (const field of type.fields ?? []) {
    query.spend();
    const child = query.layout(field.type);
    size = Math.max(size, child.size);
    align = Math.max(align, child.align);
  }
  return { size, align };
}
