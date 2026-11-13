import { CRuntimeError } from './errors';
import type { Frame } from './runtime';
import { compatible, type CType, sizeOf } from './types';

export interface BoundedAddress {
  address: number;
  start: number;
  end: number;
}

export type Address = number | BoundedAddress;

export function addressOf(location: Address): number {
  return typeof location === 'number' ? location : location.address;
}

export function checkAddress(location: Address, size: number): number {
  const address = addressOf(location);
  if (typeof location !== 'number' && (address < location.start || address + size > location.end))
    throw new CRuntimeError('outOfBounds');
  return address;
}

export function boundPointer(frame: Frame, address: number, element: CType): Address {
  const block = frame.runtime.memory.find(address) ?? frame.runtime.memory.find(address - 1);
  if (!block) return address;
  const range = block.type ? subobjectRange(block.type, block.base, address, element) : undefined;
  return { address, ...(range ?? { start: block.base, end: block.end }) };
}

// code-gauge-allow functionCognitiveComplexity 18 -- Array and record recursion must preserve the same address and element-type context.
function subobjectRange(
  type: CType,
  base: number,
  address: number,
  element: CType
): { start: number; end: number } | undefined {
  if (type.kind === 'array') {
    if (compatible(type.of, element, true)) return { start: base, end: base + sizeOf(type) };
    const stride = sizeOf(type.of);
    if (stride === 0) return undefined;
    const index = Math.min(Math.floor((address - base) / stride), (type.length ?? 0) - 1);
    return index < 0 ? undefined : subobjectRange(type.of, base + index * stride, address, element);
  }
  if (type.kind === 'record') {
    for (const field of type.info.fields ?? []) {
      const start = base + field.offset;
      if (address >= start && address < start + sizeOf(field.type)) {
        const range = subobjectRange(field.type, start, address, element);
        if (range) return range;
      }
    }
  }
  return undefined;
}
