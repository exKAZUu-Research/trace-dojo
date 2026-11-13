import type { ExecutionBudget } from '../interpreter/limits';
import type { Scalar, Value } from './arith';
import type { BinaryOperator } from './ast';
import type { Operand } from './compilerBase';
import { CRuntimeError } from './errors';
import { MIN_ADDRESS } from './memory';
import { type ProvenanceAlgebra, provenanceAlgebra, type ProvenanceExpression } from './provenanceExpressions';
import type { Frame } from './runtime';
import { compatible, type CType, sizeOf } from './types';

export interface BoundedAddress {
  address: number;
  start: number;
  end: number;
}

export type Address = number | BoundedAddress;

export type PointerRange = Pick<BoundedAddress, 'start' | 'end'>;
export interface PointerOrigin {
  representation: bigint;
  key: string;
  range?: PointerRange;
  expression?: AddressTerms;
  proof?: ProvenanceExpression;
}
type AddressTerms = ReadonlyMap<string, { range: PointerRange; weight: bigint }>;
export interface PointerByte {
  origin: PointerOrigin;
  index: number;
  proof?: ProvenanceExpression;
}
export type PointerBytes = Map<number, ReadonlyMap<string, PointerByte>>;

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
  if (value.read && (value.read.always || frame.runtime.hasIntegerProvenance)) return value.read(frame);
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
  const representation = BigInt.asUintN(64, BigInt(value));
  const origin = { range, representation, key: `${representation}/${range.start}/${range.end}` };
  return new Map(
    Array.from({ length: 8 }, (_, index) => [index, new Map([[`${origin.key}/${index}`, { origin, index }]])])
  );
}

export function rangeOfBytes(
  bytes: PointerBytes | undefined,
  offset: number,
  representation: Uint8Array,
  budget: ExecutionBudget
): PointerRange | undefined {
  const origins = matchingOrigins(bytes, offset, representation, budget);
  const proven = origins.find((origin) => origin.proof?.source?.origin?.range)?.proof?.source?.origin?.range;
  if (proven) return proven;
  const expression = origins.find((origin) => origin.expression)?.expression;
  if (expression) {
    const range = rangeOfTerms(expression);
    const proof = origins.find((origin) => origin.expression === expression)?.proof;
    return (
      range ??
      (proof
        ? rangeOfProofSources(
            proof,
            new DataView(representation.buffer, representation.byteOffset).getBigUint64(offset, true),
            budget
          )
        : undefined)
    );
  }
  let range: PointerRange | undefined;
  for (const origin of origins) {
    if (!origin.range) continue;
    range = range
      ? { start: Math.max(range.start, origin.range.start), end: Math.min(range.end, origin.range.end) }
      : origin.range;
  }
  return range;
}

function matchingOrigins(
  bytes: PointerBytes | undefined,
  offset: number,
  representation: Uint8Array,
  budget: ExecutionBudget
): PointerOrigin[] {
  const origins: PointerOrigin[] = [];
  for (const { origin, index } of bytes?.get(offset)?.values() ?? []) {
    budget.spend(8);
    if (index === 0 && coherentOrigin(bytes!, offset, representation, origin)) origins.push(origin);
  }
  return origins;
}

function coherentOrigin(
  bytes: PointerBytes,
  offset: number,
  representation: Uint8Array,
  origin: PointerOrigin
): boolean {
  for (let i = 0; i < 8; i++) {
    if (
      !bytes.get(offset + i)?.has(`${origin.key}/${i}`) ||
      representation[offset + i] !== Number((origin.representation >> BigInt(i * 8)) & 255n)
    )
      return false;
  }
  return true;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Byte identities and address roles are selected together before the resulting metadata is emitted.
export function arithmeticResult(
  value: Scalar,
  operands: Evaluated[],
  budget: ExecutionBudget,
  operator?: BinaryOperator | '~'
): Evaluated {
  if (!operands.some((operand) => !!operand.range || !!operand.bytes?.size)) return { value };
  const sources = operands.map(
    (operand) => operand.bytes ?? (operand.range ? pointerBytesOf(operand.range, operand.value as Scalar) : undefined)
  );
  const bytes = mergePointerBytes(sources, budget);
  const width = operands.every(
    (operand, index) =>
      !operand.range && (!sources[index]?.size || (sources[index]!.size === 1 && sources[index]!.has(0)))
  )
    ? 8
    : 64;
  const algebra = provenanceAlgebra(budget);
  const proof = algebra.combine({
    operator,
    value,
    width,
    inputs: operands.map((operand, index) => ({
      value: operand.value as Scalar,
      expression: operandProof(operand, sources[index], width, algebra, budget),
    })),
  });
  if (width === 8) return { value, bytes: bytesOfProof(proof, budget) };
  const terms = operands.map((operand) => termsOf(operand, budget));
  if (!terms.some((item) => item !== undefined))
    return { value, bytes: expressionBytes(bytes, value, new Map(), budget, proof) };
  const numeric = BigInt(value);
  const isAddress = numeric >= BigInt(MIN_ADDRESS) && numeric <= BigInt(Number.MAX_SAFE_INTEGER);
  let expression: AddressTerms;
  const proven = proof.source?.origin?.range;
  if (proven) expression = termsForRange(proven);
  else if (operator === '+' || operator === '-') expression = combineTerms(terms, operator, budget);
  else if (!isAddress) expression = new Map();
  else {
    const recovered = rangeOfBytes(bytes, 0, representationOf(value), budget);
    const range = recovered ?? rangeOfProofSources(proof, value, budget) ?? uniqueRange(operands);
    expression = range ? termsForRange(range) : new Map();
  }
  return {
    value,
    range: isAddress ? (rangeOfTerms(expression) ?? rangeOfProofSources(proof, value, budget)) : undefined,
    bytes: expressionBytes(bytes, value, expression, budget, proof),
  };
}

function operandProof(
  operand: Evaluated,
  bytes: PointerBytes | undefined,
  width: 8 | 64,
  algebra: ProvenanceAlgebra,
  budget: ExecutionBudget
): ProvenanceExpression {
  const value = operand.value as Scalar;
  if (!bytes?.size) return algebra.constant(value, width);
  if (width === 8) return byteOperandProof(value, bytes, algebra, budget);
  const matching = matchingOrigins(bytes, 0, representationOf(value), budget);
  const previous = matching.find((origin) => origin.proof)?.proof;
  if (previous) return previous;
  const inputs = matching.map((origin) => ({
    value,
    expression: algebra.source({ key: `p:${origin.key}`, value: origin.representation, origin }, 64),
  }));
  if (inputs.length === 1) return inputs[0].expression;
  if (inputs.length === 0) {
    for (const [offset, entries] of bytes) {
      budget.spend(entries.size);
      for (const byte of entries.values()) {
        const expression =
          byte.proof ??
          algebra.source(
            { key: `b:${byte.origin.key}/${byte.index}`, value: BigInt(representationOf(value)[offset] ?? 0), byte },
            8
          );
        inputs.push({ value, expression });
      }
    }
  }
  return algebra.combine({ value, inputs, width });
}

function byteOperandProof(
  value: Scalar,
  bytes: PointerBytes,
  algebra: ProvenanceAlgebra,
  budget: ExecutionBudget
): ProvenanceExpression {
  budget.spend(bytes.get(0)?.size ?? 0);
  const candidates = [...(bytes.get(0)?.values() ?? [])];
  const partial = candidates.find((byte) => byte.proof)?.proof;
  if (partial) return partial;
  const whole = candidates.find((byte) => byte.origin.proof);
  const selected = whole ? [whole] : candidates;
  const inputs = selected.map((byte) => ({
    value,
    expression: algebra.source(
      {
        key: `b:${byte.origin.key}/${byte.index}`,
        value: BigInt(value),
        byte: { origin: byte.origin, index: byte.index },
      },
      8
    ),
  }));
  return inputs.length === 1 ? inputs[0].expression : algebra.combine({ value, inputs, width: 8 });
}

function bytesOfProof(proof: ProvenanceExpression, budget: ExecutionBudget): PointerBytes | undefined {
  const candidates = new Map<string, PointerByte>();
  budget.spend(proof.sources.size);
  for (const source of proof.sources.values()) {
    if (source.byte) candidates.set(`${source.byte.origin.key}/${source.byte.index}`, { ...source.byte, proof });
  }
  return candidates.size > 0 ? new Map([[0, candidates]]) : undefined;
}

function rangeOfProofSources(
  proof: ProvenanceExpression,
  value: Scalar,
  budget: ExecutionBudget
): PointerRange | undefined {
  budget.spend(proof.sources.size);
  let range: PointerRange | undefined;
  for (const source of proof.sources.values()) {
    const candidate = source.origin?.range;
    if (!candidate || source.value !== BigInt.asUintN(64, BigInt(value))) continue;
    range = range
      ? { start: Math.max(range.start, candidate.start), end: Math.min(range.end, candidate.end) }
      : candidate;
  }
  return range;
}

function termsOf(operand: Evaluated, budget: ExecutionBudget): AddressTerms | undefined {
  const expression = matchingOrigins(operand.bytes, 0, representationOf(operand.value as Scalar), budget).find(
    (origin) => origin.expression
  )?.expression;
  return expression ?? (operand.range ? termsForRange(operand.range) : undefined);
}

function representationOf(value: Scalar): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);
  return bytes;
}

function termsForRange(range: PointerRange): AddressTerms {
  return new Map([[`${range.start}/${range.end}`, { range, weight: 1n }]]);
}

function rangeOfTerms(terms: AddressTerms): PointerRange | undefined {
  if (terms.size !== 1) return;
  const [term] = terms.values();
  return term.weight === 1n ? term.range : undefined;
}

function combineTerms(
  operands: (AddressTerms | undefined)[],
  operator: '+' | '-',
  budget: ExecutionBudget
): AddressTerms {
  const terms = new Map<string, { range: PointerRange; weight: bigint }>();
  for (const [index, operand] of operands.entries()) {
    for (const [key, term] of operand ?? []) {
      budget.spend();
      const weight = (terms.get(key)?.weight ?? 0n) + term.weight * (operator === '-' && index > 0 ? -1n : 1n);
      if (weight === 0n) terms.delete(key);
      else terms.set(key, { range: term.range, weight });
    }
  }
  return terms;
}

function uniqueRange(operands: Evaluated[]): PointerRange | undefined {
  let range: PointerRange | undefined;
  for (const operand of operands) {
    if (!operand.range) continue;
    if (range && (range.start !== operand.range.start || range.end !== operand.range.end)) return;
    range = operand.range;
  }
  return range;
}

function expressionBytes(
  bytes: PointerBytes | undefined,
  value: Scalar,
  expression: AddressTerms,
  budget: ExecutionBudget,
  proof: ProvenanceExpression
): PointerBytes {
  const representation = BigInt.asUintN(64, BigInt(value));
  budget.spend(expression.size);
  const key =
    `e:${representation}/p:${proof.id}/` +
    [...expression]
      .map(([at, term]) => `${at}=${term.weight}`)
      .toSorted()
      .join(',');
  const origin: PointerOrigin = { representation, key, expression, proof };
  const result: PointerBytes = new Map();
  for (const [offset, candidates] of bytes ?? []) {
    budget.spend(candidates.size);
    result.set(
      offset,
      new Map(
        [...candidates]
          .filter(([, byte]) => !byte.origin.expression)
          .map(([at, byte]) => [at, { origin: byte.origin, index: byte.index }])
      )
    );
  }
  for (let index = 0; index < 8; index++) {
    result.set(
      index,
      new Map<string, PointerByte>([...(result.get(index) ?? []), [`${key}/${index}`, { origin, index }]])
    );
  }
  return result;
}

export function mergePointerBytes(
  sources: (PointerBytes | undefined)[],
  budget: ExecutionBudget
): PointerBytes | undefined {
  const present = sources.filter((source): source is PointerBytes => !!source?.size);
  if (present.length < 2) return present[0];
  const result: PointerBytes = new Map();
  for (const source of present) {
    for (const [offset, candidates] of source) {
      budget.spend(candidates.size + (result.get(offset)?.size ?? 0));
      const combined = new Map(result.get(offset));
      for (const [key, byte] of candidates) combined.set(key, byte);
      result.set(offset, combined);
    }
  }
  return result;
}

export function storedPointerBytes(
  range: PointerRange,
  value: Scalar,
  bytes: PointerBytes | undefined,
  budget: ExecutionBudget
): PointerBytes {
  const retained: PointerBytes = new Map();
  const proofs = new Set(
    matchingOrigins(bytes, 0, representationOf(value), budget)
      .filter((origin) => origin.proof)
      .map((origin) => origin.key)
  );
  for (const [offset, candidates] of bytes ?? []) {
    budget.spend(candidates.size);
    const other = new Map(
      [...candidates].filter(
        ([, byte]) =>
          proofs.has(byte.origin.key) ||
          (proofs.size === 0 &&
            byte.origin.range !== undefined &&
            (byte.origin.range.start !== range.start || byte.origin.range.end !== range.end))
      )
    );
    if (other.size > 0) retained.set(offset, other);
  }
  return mergePointerBytes([pointerBytesOf(range, value), retained], budget)!;
}
