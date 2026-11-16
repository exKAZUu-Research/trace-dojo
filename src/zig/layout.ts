import type { Type } from './types';

/** `@sizeOf` and `@alignOf` as on the reference toolchain's target (aarch64), which the library's growth depends on. */
export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

export function alignOf(type: Type): number {
  return layoutOf(type).align;
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

// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type.
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
      if (type.child.kind === 'pointer' && type.child.size === 'one') return { size: 8, align: 8 };
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
      const fields = (type.fields ?? []).map((field) => layoutOf(field.type));
      let size = Math.max(0, ...fields.map((field) => field.size));
      let align = Math.max(1, ...fields.map((field) => field.align));
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

function bitSizeOf(type: Type): number {
  if (type.kind === 'int') return type.bits;
  if (type.kind === 'bool') return 1;
  return sizeOf(type) * 8;
}
