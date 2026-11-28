import { normalize } from '../infer';
import { fieldTypes } from '../interpreter';
import { type AdtDef, type IntName, shallow, type Type } from '../types';

/**
 * A type's size and alignment as rustc lays it out on a 64-bit target, with its largest niche: the invalid values of
 * one of its scalars, which an enum around it may use for its other variants instead of a tag (`Option<bool>` is one
 * byte). Fields go in the order rustc gives them: by descending alignment in a struct, so that only the end pads, and
 * by ascending alignment after an enum's tag.
 */
export interface Layout {
  size: number;
  align: number;
  niche?: Niche;
}

interface Niche {
  /** The size in bytes of the scalar that has the niche. */
  size: number;
  /** How many invalid values the scalar has. */
  available: bigint;
}

const POINTER: Layout = { size: 8, align: 8, niche: { size: 8, available: 1n } };
const FAT_POINTER: Layout = { size: 16, align: 8, niche: { size: 8, available: 1n } };
/** `RawVec`'s capacity is at most `isize::MAX`, which leaves the values above it as a niche of `Vec` and `String`. */
const CAPACITY_NICHE: Niche = { size: 8, available: 2n ** 63n };

/** The layouts of the standard library's collections, which hold pointers and lengths. */
const COLLECTION_LAYOUTS: Partial<Record<string, Layout>> = {
  String: { size: 24, align: 8, niche: CAPACITY_NICHE },
  Vec: { size: 24, align: 8, niche: CAPACITY_NICHE },
  BinaryHeap: { size: 24, align: 8, niche: CAPACITY_NICHE },
  VecDeque: { size: 32, align: 8, niche: CAPACITY_NICHE },
  HashMap: { size: 48, align: 8, niche: { size: 8, available: 1n } },
  HashSet: { size: 48, align: 8, niche: { size: 8, available: 1n } },
  BTreeMap: { size: 24, align: 8 },
  BTreeSet: { size: 24, align: 8 },
};

/**
 * The layouts of std types whose declarations hide their storage (`Duration { inner: () }`), as rustc 1.99.1 lays them
 * out on a 64-bit target; a size of 0 would make them zero-sized, which sorting and the like skip.
 */
const OPAQUE_LAYOUTS: Partial<Record<string, Layout>> = {
  // `secs: u64` and `nanos: u32`, whose values past 999_999_999 are a niche.
  Duration: { size: 16, align: 8, niche: { size: 4, available: 2n ** 32n - 1_000_000_000n } },
  PathBuf: { size: 24, align: 8, niche: CAPACITY_NICHE },
  File: { size: 4, align: 4, niche: { size: 4, available: 1n } },
  JoinHandle: { size: 24, align: 8 },
  Sender: { size: 16, align: 8 },
  Receiver: { size: 16, align: 8 },
  Thread: { size: 8, align: 8, niche: { size: 8, available: 1n } },
  Instant: { size: 16, align: 8 },
};

export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

export function layoutOf(type: Type): Layout {
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'int': {
      return scalar(intBytes(t.name));
    }
    case 'float': {
      return scalar(t.name === 'f32' ? 4 : 8);
    }
    case 'bool': {
      return { size: 1, align: 1, niche: { size: 1, available: 254n } };
    }
    case 'char': {
      return { size: 4, align: 4, niche: { size: 4, available: 2n ** 32n - 0x11_00_00n } };
    }
    case 'ref': {
      return pointerTo(t.target);
    }
    case 'fn': {
      return t.item ? { size: 0, align: 1 } : POINTER;
    }
    case 'closure': {
      const captures = t.closure.captures ?? [];
      return structLayout(captures.map(({ type, mode }) => (mode === 'value' ? layoutOf(type) : pointerTo(type))));
    }
    case 'array': {
      const elem = layoutOf(t.elem);
      return { size: elem.size * t.len, align: elem.align, niche: t.len > 0 ? elem.niche : undefined };
    }
    case 'tuple': {
      return structLayout(t.elems.map((elem) => layoutOf(elem)));
    }
    case 'adt': {
      return builtinLayout(t.def.builtin, t.args) ?? adtLayout(t.def, t.args);
    }
    default: {
      return { size: 0, align: 1 };
    }
  }
}

/** The layout of a standard type whose declaration does not show its storage. */
function builtinLayout(builtin: string | undefined, args: Type[]): Layout | undefined {
  const collection = COLLECTION_LAYOUTS[builtin as string];
  if (collection) return collection;
  if (builtin === 'Box' || builtin === 'Rc' || builtin === 'Arc' || builtin === 'Weak') return pointerTo(args[0]);
  const opaque = OPAQUE_LAYOUTS[builtin as string];
  if (opaque) return opaque;
  // std's holds `start`, `end`, and `exhausted: bool`.
  if (builtin === 'RangeInclusive') {
    const bound = layoutOf(args[0]);
    return structLayout([bound, bound, layoutOf({ kind: 'bool' })]);
  }
  return undefined;
}

function intBytes(name: IntName): number {
  return name === 'isize' || name === 'usize' ? 8 : Number(name.slice(1)) / 8;
}

function scalar(size: number): Layout {
  return { size, align: size };
}

/** A reference or a `Box`: a pointer that is never null, with a length or a vtable after it for unsized targets. */
function pointerTo(target: Type): Layout {
  const t = normalize(shallow(target));
  return t.kind === 'str' || t.kind === 'slice' || t.kind === 'dyn' ? FAT_POINTER : POINTER;
}

function adtLayout(def: AdtDef, args: Type[]): Layout {
  const variants = def.variants.map((_, index) => fieldTypes(def, args, index).map((field) => layoutOf(field)));
  if (def.kind === 'struct' || variants.length === 1) return structLayout(variants[0] ?? []);
  if (variants.length === 0) return { size: 0, align: 1 };
  const tagged = taggedLayout(def, variants);
  const nicheFilling = nicheFillingLayout(variants.map((fields) => structLayout(fields)));
  if (!nicheFilling) return tagged;
  // rustc keeps the tag unless the niche makes the enum smaller, or as small with more invalid values left.
  const nicheIsLarger = (nicheFilling.niche?.available ?? 0n) > (tagged.niche?.available ?? 0n);
  return nicheFilling.size < tagged.size || (nicheFilling.size === tagged.size && nicheIsLarger)
    ? nicheFilling
    : tagged;
}

/** Fields in descending alignment: none pads but the end, and the struct's niche is its fields' largest. */
function structLayout(fields: Layout[]): Layout {
  const align = Math.max(1, ...fields.map((field) => field.align));
  const size = alignUp(
    fields.reduce((sum, field) => sum + field.size, 0),
    align
  );
  return { size, align, niche: largestNiche(fields.map((field) => field.niche)) };
}

/** A tag of the smallest integer that holds the discriminants, then each variant's fields by ascending alignment. */
function taggedLayout(def: AdtDef, variants: Layout[][]): Layout {
  let min = def.variants[0].discriminant;
  let max = min;
  for (const { discriminant } of def.variants) {
    if (discriminant < min) min = discriminant;
    if (discriminant > max) max = discriminant;
  }
  const tagSize = [1, 2, 4, 8].find((bytes) => fitsInt(min, max, bytes)) ?? 16;
  let align = tagSize;
  let size = tagSize;
  for (const fields of variants) {
    let offset = tagSize;
    for (const field of fields.toSorted((a, b) => a.align - b.align))
      offset = alignUp(offset, field.align) + field.size;
    size = Math.max(size, offset);
    align = Math.max(align, ...fields.map((field) => field.align));
  }
  const tagValues = 2n ** BigInt(8 * tagSize);
  return { size: alignUp(size, align), align, niche: { size: tagSize, available: tagValues - (max - min + 1n) } };
}

function fitsInt(min: bigint, max: bigint, bytes: number): boolean {
  const bits = BigInt(8 * bytes);
  return min < 0n ? min >= -(2n ** (bits - 1n)) && max < 2n ** (bits - 1n) : max < 2n ** bits;
}

/**
 * The other variants in the niche of the largest one (the last of the largest), as rustc places them when its niche
 * has values for all of them and each fits beside the niche: before it or after it.
 */
function nicheFillingLayout(variants: Layout[]): Layout | undefined {
  let largest = 0;
  for (const [index, variant] of variants.entries()) if (variant.size >= variants[largest].size) largest = index;
  const others = variants.flatMap((_, index) => (index === largest ? [] : [index]));
  const count = BigInt(Math.max(...others) - Math.min(...others) + 1);
  const { niche } = variants[largest];
  if (!niche || niche.available < count) return undefined;
  const align = Math.max(...variants.map((variant) => variant.align));
  const size = alignUp(variants[largest].size, align);
  const fits = others.every((index) => {
    const variant = variants[index];
    const fitsBefore = variant.size <= variants[largest].size - niche.size;
    return fitsBefore || alignUp(niche.size, variant.align) + variant.size <= size;
  });
  return fits ? { size, align, niche: { size: niche.size, available: niche.available - count } } : undefined;
}

function largestNiche(niches: (Niche | undefined)[]): Niche | undefined {
  let largest: Niche | undefined;
  for (const niche of niches) if (niche && (!largest || niche.available > largest.available)) largest = niche;
  return largest;
}

function alignUp(offset: number, align: number): number {
  return Math.ceil(offset / align) * align;
}
