import type { BoundDeconstruct, BoundDeconstructTarget, BoundExpression, BoundLValue, BoundPattern } from './bound';
import { CsDecimal } from './decimal';
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
      case 'list': {
        return this.matchesList(pattern, value, frame);
      }
    }
  }

  /** Matches a list pattern: a value of the length it needs whose elements, and slice, match their patterns. */
  private matchesList(pattern: Extract<BoundPattern, { kind: 'list' }>, value: Value, frame: Frame): boolean {
    if (value === undefined) return false;
    this.storeLocal(frame, pattern.list, value);
    const length = this.evaluate(pattern.length, frame) as number;
    const fixed = pattern.before.length + pattern.after.length;
    if (pattern.hasSlice ? length < fixed : length !== fixed) return false;
    const elementMatches = (sub: BoundPattern, index: number): boolean => {
      this.storeLocal(frame, pattern.index, index);
      return this.matches(sub, this.evaluate(pattern.element, frame), frame);
    };
    if (!pattern.before.every((sub, index) => elementMatches(sub, index))) return false;
    if (!pattern.after.every((sub, index) => elementMatches(sub, length - pattern.after.length + index))) return false;
    if (pattern.slice) {
      this.storeLocal(frame, pattern.start, pattern.before.length);
      this.storeLocal(frame, pattern.end, length - pattern.after.length);
      if (!this.matches(pattern.slice.pattern, this.evaluate(pattern.slice.value, frame), frame)) return false;
    }
    if (pattern.local) this.storeLocal(frame, pattern.local, value);
    return true;
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
    if (!this.isOfType(value, frame.resolve(pattern.inputType), type)) return false;
    if (pattern.local)
      this.storeLocal(frame, pattern.local, this.designated(value, frame.resolve(pattern.inputType), type));
    return true;
  }

  /** Whether an input value has a type, where a primitive, which carries no type, tests as its input type's box. */
  private isOfType(value: Value, inputType: Type, type: Type): boolean {
    const subject = this.asTestedValue(value, inputType);
    return (subject instanceof CsStruct && sameType(subject.type, type)) || this.isInstanceOf(subject, type);
  }

  /** A primitive input as the box of its input type that a type test sees; other values as they are. */
  private asTestedValue(value: Value, inputType: Type): Value {
    return !(value instanceof CsBox) && this.runtime.runtimeTypeOf(value) === undefined && isValueType(inputType)
      ? new CsBox(nullableUnderlying(inputType) ?? inputType, value)
      : value;
  }

  /** The value a pattern's variable of a type receives: the tested box for a reference type, else a copy unboxed. */
  private designated(value: Value, inputType: Type, type: Type): Value {
    // A struct reaches a variable of a reference type in a box of a copy, as any conversion to one boxes it.
    if (isReferenceType(type) && value instanceof CsStruct) return new CsBox(value.type, copyValue(value));
    if (isReferenceType(type)) return this.asTestedValue(value, inputType);
    return copyValue(value instanceof CsBox ? value.value : value);
  }

  private matchesRelational(
    pattern: Extract<BoundPattern, { kind: 'relational' }>,
    value: Value,
    frame: Frame
  ): boolean {
    if (value === undefined) return false;
    const inner = value instanceof CsBox ? value.value : value;
    if (value instanceof CsBox && !sameType(value.type, pattern.value.type)) return false;
    // An input of another type, such as a string an object holds, is never in a numeric range.
    if (typeof inner !== 'number' && typeof inner !== 'bigint' && !(inner instanceof CsDecimal)) return false;
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
    if (pattern.testType && !this.isOfType(value, frame.resolve(pattern.inputType), frame.resolve(pattern.testType)))
      return false;
    const target = value instanceof CsBox ? value.value : value;
    if (!this.matchesPositional(pattern, target, frame) || !this.matchesProperties(pattern, target, frame))
      return false;
    if (pattern.local)
      this.storeLocal(
        frame,
        pattern.local,
        this.designated(value, frame.resolve(pattern.inputType), frame.resolve(pattern.local.type))
      );
    return true;
  }

  private matchesPositional(
    pattern: Extract<BoundPattern, { kind: 'recursive' }>,
    target: Value,
    frame: Frame
  ): boolean {
    if (pattern.positional.length === 0) return true;
    if (pattern.isITuple) {
      const tuple = target instanceof CsBox ? target.value : target;
      if (
        !(tuple instanceof CsStruct) ||
        tuple.type.symbol.special !== 'valueTuple' ||
        tuple.fields.length !== pattern.positional.length
      )
        return false;
      return pattern.positional.every((sub, index) =>
        this.matches(sub, this.box(tuple.fields[index], tuple.type.args[index]), frame)
      );
    }
    const elements = pattern.isTuple
      ? (target as CsStruct).fields
      : this.deconstructedElements(pattern.deconstruct as BoundDeconstruct, target, pattern.positional.length, frame);
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
    const snapshot = elements.map((element) => copyValue(element));
    for (const [index, element] of targets.elements.entries()) this.deconstruct(element, snapshot[index], frame);
  }

  /** The values that a `Deconstruct` method gives through its `out` parameters. */
  private deconstructedElements(deconstruct: BoundDeconstruct, target: Value, count: number, frame: Frame): Value[] {
    const cells = Array.from({ length: count }, () => new Cell(undefined));
    const references = cells.map(
      (cell) =>
        new Reference(
          () => cell.value as Value,
          (stored) => (cell.value = stored)
        )
    );
    const { method: declared, typeArgs } = deconstruct;
    if (declared.isStatic) {
      // An extension method takes the value as its first argument.
      const environment = this.staticEnvironment(declared, typeArgs, frame);
      this.invoke(frame, declared, undefined, [target, ...references], undefined, environment);
    } else {
      const method = this.runtime.dispatch(declared, target);
      this.invoke(
        frame,
        method,
        target,
        references,
        undefined,
        this.environmentFor(method, this.runtime.runtimeTypeOf(target))
      );
    }
    return cells.map((cell) => cell.value as Value);
  }
}
