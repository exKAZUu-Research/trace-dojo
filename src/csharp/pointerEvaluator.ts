import { AsyncExecutor } from './asyncExecutor';
import type { BoundExpression, BoundLValue } from './bound';
import { NULL_REFERENCE } from './evaluatorBase';
import { PendingException, relation } from './numeric';
import { CsPointer, layoutOf, type MemoryBlock, readAt, sizeOf } from './pointers';
import type { Frame } from './runtime';
import { isValueType, type Type } from './types';
import { copyValue, CsArray, CsObject, stringText, type Value } from './values';

export type PointerExpression = Extract<
  BoundExpression,
  { kind: 'addressOf' | 'deref' | 'pointerArith' | 'pointerDiff' | 'pointerCompare' | 'stackalloc' | 'fixedAddress' }
>;

const POINTER_KINDS: ReadonlySet<BoundExpression['kind']> = new Set([
  'addressOf',
  'deref',
  'pointerArith',
  'pointerDiff',
  'pointerCompare',
  'stackalloc',
  'fixedAddress',
]);

/** Whether an expression works on pointers, which unsafe code alone writes. */
export function isPointerExpression(expression: BoundExpression): expression is PointerExpression {
  return POINTER_KINDS.has(expression.kind);
}

/** The evaluator's operations on pointers and the storage they point into, which unsafe code alone uses. */
export abstract class PointerEvaluator extends AsyncExecutor {
  protected pointerValue(expression: BoundExpression, frame: Frame): CsPointer {
    const pointer = this.evaluate(expression, frame);
    if (!(pointer instanceof CsPointer)) throw NULL_REFERENCE();
    return pointer;
  }

  /** Evaluates the pointer operations of unsafe code. */
  // code-gauge-allow functionNcss -- One case per kind of pointer operation.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  protected evaluatePointer(expression: PointerExpression, frame: Frame): Value {
    switch (expression.kind) {
      case 'addressOf': {
        return this.addressOf(expression.target, frame);
      }
      case 'deref': {
        return readAt(this.pointerValue(expression.pointer, frame), frame.resolve(expression.type));
      }
      case 'pointerArith': {
        const pointer = this.pointerValue(expression.pointer, frame);
        const count = Number(this.evaluate(expression.offset, frame));
        return pointer.moved((expression.isSubtract ? -count : count) * expression.elementSize);
      }
      case 'pointerDiff': {
        const left = this.evaluate(expression.left, frame) as CsPointer | undefined;
        const right = this.evaluate(expression.right, frame) as CsPointer | undefined;
        const bytes = (left?.address ?? 0n) - (right?.address ?? 0n);
        return bytes / BigInt(expression.elementSize);
      }
      case 'pointerCompare': {
        const left = (this.evaluate(expression.left, frame) as CsPointer | undefined)?.address ?? 0n;
        const right = (this.evaluate(expression.right, frame) as CsPointer | undefined)?.address ?? 0n;
        return relation(expression.operator, left < right ? -1 : left > right ? 1 : 0);
      }
      case 'stackalloc': {
        const length = Number(this.evaluate(expression.length, frame));
        if (length < 0)
          throw new PendingException('System.OverflowException', 'Arithmetic operation resulted in an overflow.');
        const element = frame.resolve(expression.elementType);
        this.runtime.allocateSlots(length);
        const values = expression.values
          ? expression.values.map((value) => copyValue(this.evaluate(value, frame)))
          : Array.from({ length }, () => this.defaultOf(element));
        const block = this.runtime.memory.allocate({
          elementType: element,
          length,
          get: (index) => values[index],
          set: (index, value) => {
            values[index] = value;
          },
        });
        return new CsPointer(block, 0);
      }
      case 'fixedAddress': {
        const value = this.evaluate(expression.value, frame);
        if (value === undefined) return undefined;
        if (value instanceof CsArray)
          return value.values.length === 0 ? undefined : new CsPointer(this.arrayBlock(value), 0);
        const text = stringText(value as string);
        const block = this.runtime.memory.allocate({
          elementType: this.runtime.library.specials.get('char')?.declaredType as Type,
          length: text.length,
          // A string's characters may be read through the pointer; this grader does not let a program change them.
          // oxlint-disable-next-line unicorn/prefer-code-point -- A char is one UTF-16 code unit.
          get: (index) => text.charCodeAt(index),
          set: undefined,
        });
        return new CsPointer(block, 0);
      }
    }
  }

  private arrayBlock(array: CsArray): MemoryBlock {
    return this.runtime.memory.blockOf(array, 'elements', () => ({
      elementType: array.type.element,
      length: array.values.length,
      get: (index) => array.values[index],
      set: (index, value) => {
        this.runtime.chargeStore(array.values[index], value);
        array.values[index] = value;
      },
    }));
  }

  /** The pointer of `&x`: the block of storage the variable lies in, and its offset there. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  protected addressOf(target: BoundLValue, frame: Frame): CsPointer {
    switch (target.kind) {
      case 'local': {
        const { local } = target;
        const block = this.runtime.memory.blockOf(frame, local, () => ({
          elementType: frame.resolve(local.type),
          length: 1,
          get: () => this.readLocal(frame, local),
          set: (_index, value) => this.storeLocal(frame, local, value),
        }));
        return new CsPointer(block, 0);
      }
      case 'deref': {
        return this.pointerValue(target.pointer, frame);
      }
      case 'field': {
        const receiverType = frame.resolve(target.receiver.type);
        if (isValueType(receiverType)) {
          const field = layoutOf(receiverType).fields.find((candidate) => candidate.slot === target.field.slot);
          return this.addressOf(target.receiver as BoundLValue, frame).moved(field?.offset ?? 0);
        }
        const object = this.evaluate(target.receiver, frame);
        if (!(object instanceof CsObject)) throw NULL_REFERENCE();
        const { slot } = target.field;
        const block = this.runtime.memory.blockOf(object, target.field, () => ({
          elementType: frame.resolve(target.type),
          length: 1,
          get: () => object.fields[slot],
          set: (_index, value) => {
            object.fields[slot] = value;
          },
        }));
        return new CsPointer(block, 0);
      }
      case 'element': {
        const array = this.evaluate(target.array, frame);
        if (!(array instanceof CsArray)) throw NULL_REFERENCE();
        let offset = 0;
        for (const [dimension, indexExpression] of target.indices.entries()) {
          const index = Number(this.evaluate(indexExpression, frame));
          const length = array.lengths[dimension];
          if (index < 0 || index >= length)
            throw new PendingException('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
          offset = offset * length + index;
        }
        return new CsPointer(this.arrayBlock(array), offset * sizeOf(array.type.element));
      }
      default: {
        const place = this.place(target, frame);
        const key = target.kind === 'staticField' ? target.field : {};
        const block = this.runtime.memory.blockOf(this.runtime, key, () => ({
          elementType: frame.resolve(target.type),
          length: 1,
          get: () => place.get(),
          set: (_index, value) => place.set(value),
        }));
        return new CsPointer(block, 0);
      }
    }
  }
}
