import { intType, type StructType, type Type, type UnionType } from './types';

/** `@sizeOf` and `@alignOf` as on the reference toolchain's target (aarch64), which the library's growth depends on. */
export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

export function alignOf(type: Type): number {
  return layoutOf(type).align;
}

export function fieldOffsets(type: StructType): number[] {
  const fields = type.fields ?? [];
  const offsets = fields.map(() => 0);
  const ordered = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.comptimeValue === undefined);
  if (type.layout === 'auto') ordered.sort((a, b) => alignOf(b.field.type) - alignOf(a.field.type));
  let offset = 0;
  for (const { field, index } of ordered) {
    if (type.layout === 'packed') {
      offsets[index] = offset;
      offset += bitSizeOf(field.type);
    } else {
      offset = alignTo(offset, alignOf(field.type));
      offsets[index] = offset * 8;
      offset += sizeOf(field.type);
    }
  }
  return offsets;
}

export function unionOffsets(type: UnionType): { payload: number; tag: number } {
  const { size: payloadSize, align: payloadAlign } = unionPayload(type);
  const tag = layoutOf(type.tagType ?? intType(false, 8));
  return tag.align >= payloadAlign
    ? { tag: 0, payload: alignTo(tag.size, payloadAlign) }
    : { payload: 0, tag: alignTo(payloadSize, tag.align) };
}

export function errorUnionOffsets(payload: Type): { payload: number; error: number } {
  return alignOf(payload) >= 2 ? { payload: 0, error: sizeOf(payload) } : { payload: 2, error: 0 };
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

// code-gauge-allow functionNcss 51 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
// code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
function layoutOf(type: Type): Layout {
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
      const child = layoutOf(type.child);
      return {
        size: child.size * (type.length + (type.sentinel === undefined ? 0 : 1)),
        align: child.align,
      };
    }
    case 'optional': {
      if (optionalNicheBits(type.child)) return layoutOf(type.child);
      const child = layoutOf(type.child);
      return { size: alignTo(child.size + 1, child.align), align: child.align };
    }
    case 'error_set': {
      return { size: 2, align: 2 };
    }
    case 'error_union': {
      const payload = layoutOf(type.payload);
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
        .map((field) => layoutOf(field.type));
      if (type.layout === 'packed') {
        return intLayout((type.fields ?? []).reduce((sum, field) => sum + bitSizeOf(field.type), 0));
      }
      const sorted = type.layout === 'extern' ? fields : fields.toSorted((a, b) => b.align - a.align);
      let size = 0;
      let align = 1;
      for (const field of sorted) {
        size = alignTo(size, field.align) + field.size;
        align = Math.max(align, field.align);
      }
      return { size: alignTo(size, align), align };
    }
    case 'union': {
      const payload = unionPayload(type);
      let size = payload.size;
      let align = payload.align;
      const tag = type.tagType ? intLayout(type.tagType.tagType?.bits ?? 0) : intLayout(8);
      if (tag.size > 0) {
        size = alignTo(size, tag.align) + tag.size;
        align = Math.max(align, tag.align);
      }
      return { size: alignTo(size, align), align };
    }
    default: {
      return { size: 0, align: 1 };
    }
  }
}

export function optionalNicheBits(child: Type): number | undefined {
  return child.kind === 'pointer' ? 64 : child.kind === 'error_set' ? 16 : undefined;
}

export function bitSizeOf(type: Type): number {
  if (type.kind === 'int') return type.bits;
  if (type.kind === 'bool') return 1;
  if (type.kind === 'enum') return type.tagType?.bits ?? 0;
  if (type.kind === 'struct' && type.layout === 'packed')
    return (type.fields ?? []).reduce((sum, field) => sum + bitSizeOf(field.type), 0);
  return sizeOf(type) * 8;
}

function unionPayload(type: UnionType): Layout {
  let size = 0;
  let align = 1;
  for (const field of type.fields ?? []) {
    const child = layoutOf(field.type);
    size = Math.max(size, child.size);
    align = Math.max(align, child.align);
  }
  return { size, align };
}
