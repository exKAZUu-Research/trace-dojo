import type { BoundDeconstructTarget, BoundExpression, BoundLValue, BoundPattern } from './bound';
import type { Evaluator } from './evaluator';
import { EvaluatorBase, NULL_REFERENCE, type Place, Reference } from './evaluatorBase';
import { compareNumeric, type NumericValue } from './numeric';
import { valuesEqual } from './objects';
import type { Frame } from './runtime';
import {
  type FieldSymbol,
  isReferenceType,
  isValueType,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  type PropertySymbol,
  sameType,
  type Type,
  type TypeParameterSymbol,
} from './types';
import { Cell, copyValue, CsBox, CsStruct, type Value, type VariableReference } from './values';

/** The evaluator's matching of patterns and deconstruction of values into variables. */
export abstract class PatternMatcher extends EvaluatorBase {
  abstract evaluate(expression: BoundExpression, frame: Frame): Value;

  abstract invoke(
    caller: Frame,
    method: MethodSymbol,
    receiver: Value,
    args: (Value | VariableReference)[],
    callRow: number | undefined,
    typeEnvironment: Map<TypeParameterSymbol, Type>,
    captured?: Map<LocalSymbol, Cell>
  ): Value;

  abstract place(target: BoundLValue, frame: Frame): Place;

  /** This evaluator as the complete one, which the library's helpers take. */
  protected abstract evaluator(): Evaluator;

  matches(pattern: BoundPattern, value: Value, frame: Frame): boolean {
    switch (pattern.kind) {
      case 'any': {
        if (pattern.local) this.storeLocal(frame, pattern.local, copyValue(value));
        return true;
      }
      case 'constant': {
        return this.matchesConstant(pattern, value, frame);
      }
      case 'type': {
        return this.matchesType(pattern, value, frame);
      }
      case 'relational': {
        return this.matchesRelational(pattern, value, frame);
      }
      case 'not': {
        return !this.matches(pattern.pattern, value, frame);
      }
      case 'and': {
        return this.matches(pattern.left, value, frame) && this.matches(pattern.right, value, frame);
      }
      case 'or': {
        return this.matches(pattern.left, value, frame) || this.matches(pattern.right, value, frame);
      }
      case 'recursive': {
        return this.matchesRecursive(pattern, value, frame);
      }
    }
  }

  private matchesConstant(pattern: Extract<BoundPattern, { kind: 'constant' }>, value: Value, frame: Frame): boolean {
    const constant = this.evaluate(pattern.value, frame);
    if (constant === undefined) return value === undefined;
    if (value === undefined) return false;
    const inner = value instanceof CsBox ? value.value : value;
    if (value instanceof CsBox && !sameType(value.type, pattern.type) && !this.boxMatches(value.type, pattern.type))
      return false;
    return valuesEqual(this.evaluator(), inner, constant, frame);
  }

  private matchesType(pattern: Extract<BoundPattern, { kind: 'type' }>, value: Value, frame: Frame): boolean {
    if (value === undefined) return false;
    const type = frame.resolve(pattern.testType);
    // A primitive carries no type, so it tests as a box of the input's static type.
    const inputType = frame.resolve(pattern.inputType);
    const subject =
      !(value instanceof CsBox) && this.runtime.runtimeTypeOf(value) === undefined && isValueType(inputType)
        ? new CsBox(nullableUnderlying(inputType) ?? inputType, value)
        : value;
    if (!(subject instanceof CsStruct && sameType(subject.type, type)) && !this.isInstanceOf(subject, type))
      return false;
    if (pattern.local)
      this.storeLocal(
        frame,
        pattern.local,
        value instanceof CsBox && !isReferenceType(type) ? copyValue(value.value) : copyValue(value)
      );
    return true;
  }

  private matchesRelational(
    pattern: Extract<BoundPattern, { kind: 'relational' }>,
    value: Value,
    frame: Frame
  ): boolean {
    if (value === undefined) return false;
    const inner = value instanceof CsBox ? value.value : value;
    if (value instanceof CsBox && !sameType(value.type, pattern.value.type)) return false;
    const constant = this.evaluate(pattern.value, frame);
    if (typeof inner === 'number' && Number.isNaN(inner)) return false;
    return compareNumeric(
      pattern.operator,
      pattern.operandKind === 'enum' ? 'int' : pattern.operandKind,
      inner as NumericValue,
      constant as NumericValue
    );
  }

  private matchesRecursive(pattern: Extract<BoundPattern, { kind: 'recursive' }>, value: Value, frame: Frame): boolean {
    if (value === undefined) return false;
    if (
      pattern.testType &&
      !this.isInstanceOf(value, frame.resolve(pattern.testType)) &&
      !(value instanceof CsStruct && sameType(value.type, frame.resolve(pattern.testType)))
    )
      return false;
    const target = value instanceof CsBox ? value.value : value;
    if (!this.matchesPositional(pattern, target, frame) || !this.matchesProperties(pattern, target, frame))
      return false;
    if (pattern.local) this.storeLocal(frame, pattern.local, copyValue(target));
    return true;
  }

  private matchesPositional(
    pattern: Extract<BoundPattern, { kind: 'recursive' }>,
    target: Value,
    frame: Frame
  ): boolean {
    if (pattern.positional.length === 0) return true;
    const elements = pattern.isTuple
      ? (target as CsStruct).fields
      : this.deconstructedElements(pattern.deconstruct as MethodSymbol, target, pattern.positional.length, frame);
    return pattern.positional.every((sub, index) => this.matches(sub, elements[index], frame));
  }

  private matchesProperties(
    pattern: Extract<BoundPattern, { kind: 'recursive' }>,
    target: Value,
    frame: Frame
  ): boolean {
    for (const property of pattern.properties) {
      let current: Value = target;
      for (const [index, member] of property.members.entries()) {
        if (current === undefined) return false;
        current = this.readMember(current, member, property.owners[index], frame);
      }
      if (!this.matches(property.pattern, current, frame)) return false;
    }
    return true;
  }

  private readMember(receiver: Value, member: FieldSymbol | PropertySymbol, owner: NamedType, frame: Frame): Value {
    if ('getter' in member) {
      const getter = this.getterOf(member) as MethodSymbol;
      const implementation = this.runtime.dispatch(getter, receiver);
      return this.invoke(
        frame,
        implementation,
        receiver,
        [],
        undefined,
        this.environmentFor(implementation, this.runtime.runtimeTypeOf(receiver) ?? owner)
      );
    }
    if (member.isStatic) return this.runtime.staticsOf(owner)[member.slot];
    return this.fieldsOf(receiver)[member.slot];
  }

  protected deconstruct(targets: BoundDeconstructTarget, value: Value, frame: Frame): void {
    if (targets.kind === 'single') {
      if (!targets.target) return;
      const converted = targets.conversion
        ? this.withOperand(frame, value, () => this.evaluate(targets.conversion as BoundExpression, frame))
        : value;
      this.place(targets.target, frame).set(copyValue(converted));
      return;
    }
    let elements: Value[];
    if (!targets.deconstruct) {
      if (!(value instanceof CsStruct)) throw NULL_REFERENCE();
      elements = value.fields;
    } else {
      if (value === undefined) throw NULL_REFERENCE();
      elements = this.deconstructedElements(targets.deconstruct, value, targets.elements.length, frame);
    }
    // Every element is evaluated before any target is assigned, as `(a, b) = (b, a)` swaps.
    const snapshot = [...elements];
    for (const [index, element] of targets.elements.entries()) this.deconstruct(element, snapshot[index], frame);
  }

  /** The values that a `Deconstruct` method gives through its `out` parameters. */
  private deconstructedElements(deconstruct: MethodSymbol, target: Value, count: number, frame: Frame): Value[] {
    const cells = Array.from({ length: count }, () => new Cell(undefined));
    const references = cells.map(
      (cell) =>
        new Reference(
          () => cell.value as Value,
          (stored) => (cell.value = stored)
        )
    );
    const method = this.runtime.dispatch(deconstruct, target);
    this.invoke(
      frame,
      method,
      target,
      references,
      undefined,
      this.environmentFor(method, this.runtime.runtimeTypeOf(target))
    );
    return cells.map((cell) => cell.value as Value);
  }
}
