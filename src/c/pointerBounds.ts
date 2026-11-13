import type { Scalar, Value } from './arith';
import type { BinaryOperator } from './ast';
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
interface PointerOrigin {
  representation: bigint;
  range: PointerRange;
}
interface PointerByte {
  origin: PointerOrigin;
  index: number;
}
export type PointerBytes = Map<number, PointerByte>;

export type MetadataReader = ((frame: Frame) => Evaluated) & { always?: boolean };

export type Evaluator = ((frame: Frame) => Value) & {
  pointer?: (frame: Frame) => Address;
  read?: MetadataReader;
};

export interface Evaluated {
  value: Value;
  range?: PointerRange;
  bytes?: PointerBytes;
}

export function resultOperand(type: CType, execute: (frame: Frame) => Evaluated, bitWidth?: number): Operand {
  return {
    type,
    bitWidth,
    read: Object.assign(execute, { always: true }),
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
  if (value.read && (value.read.always || frame.runtime.hasProvenance)) return value.read(frame);
  if (!value.pointer) return { value: value(frame) };
  const at = value.pointer(frame);
  return { value: addressOf(at), range: typeof at === 'number' ? undefined : { start: at.start, end: at.end } };
}

export function evaluatorOf(operand: Operand): Evaluator {
  return operand.type.kind === 'pointer'
    ? pointerEvaluator(operand)
    : Object.assign((frame: Frame) => operand.value(frame), { read: operand.read });
}

export function pointerEvaluator(operand: Operand): Evaluator {
  const pointer =
    operand.pointer ??
    ((frame: Frame) => {
      const address = operand.value(frame) as number;
      return operand.type.kind === 'pointer' ? boundPointer(frame, address, operand.type.to) : address;
    });
  const read =
    operand.read &&
    ((frame: Frame): Evaluated => {
      const result = operand.read!(frame);
      if (result.range || operand.type.kind !== 'pointer') return result;
      const at = boundPointer(frame, result.value as number, operand.type.to);
      return { ...result, range: typeof at === 'number' ? undefined : { start: at.start, end: at.end } };
    });
  return Object.assign((frame: Frame) => operand.value(frame), {
    pointer,
    read: read && Object.assign(read, { always: true }),
  });
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

export function slicePointerBytes(
  bytes: PointerBytes | undefined,
  offset: number,
  size: number
): PointerBytes | undefined {
  if (!bytes?.size) return;
  const result = new Map(
    [...bytes].filter(([at]) => at >= offset && at < offset + size).map(([at, byte]) => [at - offset, byte])
  );
  return result.size > 0 ? result : undefined;
}

export function replacePointerBytes(bytes: PointerBytes, offset: number, size: number, source?: PointerBytes): void {
  for (const at of bytes.keys()) if (at >= offset && at < offset + size) bytes.delete(at);
  for (const [at, byte] of source ?? []) if (at >= 0 && at < size) bytes.set(offset + at, byte);
}

export function pointerBytesOf(range: PointerRange, value: Scalar): PointerBytes {
  const origin = { range, representation: BigInt.asUintN(64, BigInt(value)) };
  return new Map(Array.from({ length: 8 }, (_, index) => [index, { origin, index }]));
}

export function rangeOfBytes(
  bytes: PointerBytes | undefined,
  offset: number,
  representation: Uint8Array
): PointerRange | undefined {
  const first = bytes?.get(offset);
  if (!first || first.index !== 0) return;
  for (let i = 0; i < 8; i++) {
    const byte = bytes!.get(offset + i);
    if (
      !byte ||
      byte.index !== i ||
      byte.origin.representation !== first.origin.representation ||
      byte.origin.range.start !== first.origin.range.start ||
      byte.origin.range.end !== first.origin.range.end ||
      representation[offset + i] !== Number((first.origin.representation >> BigInt(i * 8)) & 255n)
    )
      return;
  }
  return first.origin.range;
}

export function arithmeticResult(value: Scalar, operands: Evaluated[], operator?: BinaryOperator): Evaluated {
  const [left, right] = operands;
  if (operator === '-' && left?.range && right?.range) return { value };
  let range: PointerRange | undefined;
  let bytes: PointerBytes | undefined;
  let ambiguous = false;
  for (const operand of operands) {
    if (operand.range) {
      if (range && (range.start !== operand.range.start || range.end !== operand.range.end)) ambiguous = true;
      range ??= operand.range;
    }
    bytes ??= operand.bytes;
  }
  return { value, range: ambiguous ? undefined : range, bytes };
}
