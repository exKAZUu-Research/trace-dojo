import type { Value } from './arith';
import type { Operand } from './compilerBase';
import { CRuntimeError } from './errors';
import type { Frame } from './runtime';
import { compatible, type CType, sizeOf } from './types';

export interface BoundedAddress {
  address: number;
  start: number;
  end: number;
}

export type Address = number | BoundedAddress;

export type PointerRange = Pick<BoundedAddress, 'start' | 'end'>;
export type PointerRanges = Map<number, PointerRange>;

export type Evaluator = ((frame: Frame) => Value) & { pointer?: (frame: Frame) => Address };

export interface Evaluated {
  value: Value;
  range?: PointerRange;
}

export function resultOperand(type: CType, execute: (frame: Frame) => Evaluated, bitWidth?: number): Operand {
  return {
    type,
    bitWidth,
    value: (frame) => execute(frame).value,
    pointer:
      type.kind === 'pointer'
        ? (frame) => {
            const result = execute(frame);
            return pointerAt(frame, result.value as number, type.to, result.range);
          }
        : undefined,
  };
}

export function evaluate(value: Evaluator, frame: Frame): Evaluated {
  if (!value.pointer) return { value: value(frame) };
  const at = value.pointer(frame);
  return { value: addressOf(at), range: typeof at === 'number' ? undefined : { start: at.start, end: at.end } };
}

export function pointerEvaluator(operand: Operand): Evaluator {
  const pointer =
    operand.pointer ??
    ((frame: Frame) => {
      const address = operand.value(frame) as number;
      return operand.type.kind === 'pointer' ? boundPointer(frame, address, operand.type.to) : address;
    });
  return Object.assign((frame: Frame) => operand.value(frame), { pointer });
}

export function pointerAt(frame: Frame, address: number, element: CType, range?: PointerRange): Address {
  return range ? { address, start: range.start, end: range.end } : boundPointer(frame, address, element);
}

export function checkAddress(location: Address, size: number): number {
  const address = addressOf(location);
  if (typeof location !== 'number' && (address < location.start || address + size > location.end))
    throw new CRuntimeError('outOfBounds');
  return address;
}

export function addressOf(location: Address): number {
  return typeof location === 'number' ? location : location.address;
}

export function boundPointer(frame: Frame, address: number, element: CType): Address {
  const block = frame.runtime.memory.find(address) ?? frame.runtime.memory.find(address - 1);
  if (!block) return address;
  const range = block.type ? subobjectRange(block.type, block.base, address, element) : undefined;
  return { address, ...(range ?? { start: block.base, end: block.end }) };
}

// code-gauge-allow functionCognitiveComplexity 19 -- Array and record recursion must preserve the same address and element-type context.
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
  return compatible(type, element, true) ? { start: base, end: base + sizeOf(type) } : undefined;
}

export function slicePointerRanges(ranges: PointerRanges | undefined, offset: number, size: number): PointerRanges {
  return new Map(
    [...(ranges ?? [])]
      .filter(([at]) => at >= offset && at + 8 <= offset + size)
      .map(([at, range]) => [at - offset, range])
  );
}

export function replacePointerRanges(
  ranges: PointerRanges,
  offset: number,
  size: number,
  source?: PointerRanges
): void {
  for (const at of ranges.keys()) if (at < offset + size && at + 8 > offset) ranges.delete(at);
  for (const [at, range] of source ?? []) if (at >= 0 && at + 8 <= size) ranges.set(offset + at, range);
}
