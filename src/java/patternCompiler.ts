import type { Expression, Pattern, PatternBinding, PatternLabel, Span, SwitchGroup } from './ast';
import type { Compiled, Exec, MethodContext, Scope } from './compilerBase';
import { memberBindings, memberType } from './conversions';
import { bindingsOfPattern } from './patternBindings';
import { exhaustiveSwitches } from './reachability';
import { type Frame, throwBuiltin } from './runtime';
import { TryCompiler } from './tryCompiler';
import {
  BOOLEAN,
  type ClassInfo,
  erasure,
  isCastable,
  isPrimitive,
  isReference,
  isWidening,
  type JavaType,
  sameType,
  typeName,
  upperBound,
} from './types';
import { JavaArray, JavaObject, JavaString, type Value } from './values';

type Test = (frame: Frame, value: Value) => boolean;

/** A compiled pattern: its test, which binds its variables on success, and whether it matches every value of a type. */
interface CompiledPattern {
  test: Test;
  type: JavaType;
  /** Whether the pattern matches every non-null value of `type`. */
  isTotalFor: (type: JavaType) => boolean;
}

/** What compiling the labels of a pattern switch has found so far. */
interface PatternSwitchState {
  defaultIndex: number;
  nullIndex: number;
  /** The unguarded patterns, which decide whether the switch covers every value. */
  totalPatterns: CompiledPattern[];
  enumConstants: Set<string>;
  /** The unguarded type patterns, which match every value of their types that later labels may test. */
  dominating: { type: JavaType; span: Span }[];
}

/** Compiles the patterns of `instanceof` and of switches, which Java 21 matches against types and records. */
export abstract class PatternCompiler extends TryCompiler {
  /** The pattern variables each group of the switch being compiled binds, which its body sees. */
  private groupBindings: PatternBinding[][] | undefined;

  protected override compileInstanceOf(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'instanceOf' }>
  ): Compiled {
    const { pattern } = expression;
    if (!pattern) return super.compileInstanceOf(context, expression);
    const value = this.compileValue(context, expression.value);
    if (!isReference(value.type))
      this.error(expression, `${typeName(value.type)} 型の値は instanceof で調べられません。`);
    const { test } = this.compilePattern(context, pattern, value.type);
    return { kind: 'value', type: BOOLEAN, run: (frame) => test(frame, value.run(frame)) };
  }

  /** Compiles a pattern matched against values of `inputType`, allocating the slots of its variables. */
  protected compilePattern(context: MethodContext, pattern: Pattern, inputType: JavaType): CompiledPattern {
    if (pattern.kind === 'typePattern') return this.compileTypePattern(context, pattern, inputType);
    const type = this.resolveType(pattern.type);
    const cls = type.kind === 'class' ? type.cls : undefined;
    const components = cls?.recordComponents;
    if (!cls || !components)
      return this.error(pattern, `${typeName(type)} はレコードではないので、レコードのパターンには使えません。`);
    if (!isCastable(inputType, type, this.builtins.objectClass)) {
      this.error(pattern, `${typeName(inputType)} 型の値は ${typeName(type)} 型になりえません。`);
    }
    if (components.length !== pattern.components.length) {
      this.error(
        pattern,
        `レコード ${cls.name} の要素は ${components.length} 個ですが、パターンには ${pattern.components.length} 個書かれています。`
      );
    }
    const bindings = memberBindings(type, cls);
    const parts = components.map((field, index) =>
      this.compilePattern(context, pattern.components[index], memberType(field.type, bindings))
    );
    return {
      type,
      test: (frame, value) =>
        frame.runtime.isInstance(value, cls) &&
        components.every((field, index) => parts[index].test(frame, (value as JavaObject).fields[field.slot])),
      isTotalFor: (target) =>
        isWidening(erasure(target), erasure(type), this.builtins.objectClass) &&
        parts.every((part, index) => part.isTotalFor(memberType(components[index].type, bindings))),
    };
  }

  protected compileTypePattern(
    context: MethodContext,
    pattern: Extract<Pattern, { kind: 'typePattern' }>,
    inputType: JavaType
  ): CompiledPattern {
    // `var` takes the type of what it matches, as do record components.
    const type = pattern.type ? this.resolveType(pattern.type) : inputType;
    const isPrimitivePattern = isPrimitive(type) || isPrimitive(inputType);
    if (isPrimitivePattern ? !sameType(type, inputType) : !isCastable(inputType, type, this.builtins.objectClass)) {
      this.error(pattern, `${typeName(inputType)} 型の値は ${typeName(type)} 型になりえません。`);
    }
    const slot = context.locals.length;
    context.locals.push({ name: pattern.binding.name, type });
    context.patternSlots.push(slot);
    this.bindingSlots.set(pattern.binding, slot);
    const matches = (frame: Frame, value: Value): boolean => {
      if (isPrimitivePattern) return true;
      if (type.kind === 'class') return frame.runtime.isInstance(value, type.cls);
      if (type.kind === 'array') {
        return (
          value instanceof JavaArray &&
          isWidening({ kind: 'array', element: value.elementType }, type, this.builtins.objectClass)
        );
      }
      return value !== undefined;
    };
    return {
      type,
      test: (frame, value) => {
        if (!matches(frame, value)) return false;
        frame.locals[slot] = value;
        return true;
      },
      isTotalFor: (target) => isWidening(erasure(target), erasure(type), this.builtins.objectClass),
    };
  }

  protected override compileSwitchSelector(
    context: MethodContext,
    statement: { selector: Expression; groups: SwitchGroup[] }
  ): { type: JavaType; run: (frame: Frame) => number } {
    this.groupBindings = undefined;
    const usesPatterns = statement.groups.some((group) =>
      group.labels.some((label) => label?.kind === 'patternLabel' || isNullLabel(label))
    );
    const selector = this.compileValue(context, statement.selector);
    const unboxed = this.operand(selector).type;
    const isClassic =
      ['byte', 'short', 'char', 'int'].includes(unboxed.kind) ||
      (unboxed.kind === 'class' && (unboxed.cls === this.builtins.stringClass || unboxed.cls.kind === 'enum'));
    if (!usesPatterns && isClassic) return super.compileSwitchSelector(context, statement);
    if (!isReference(selector.type)) {
      this.error(statement.selector, `switch では ${typeName(selector.type)} 型の値を使えません。`);
    }
    return this.compilePatternSwitch(context, statement, selector);
  }

  /** Compiles a switch whose cases match patterns or null, trying them in order. */
  protected compilePatternSwitch(
    context: MethodContext,
    statement: { selector: Expression; groups: SwitchGroup[] },
    selector: { type: JavaType; run: (frame: Frame) => Value }
  ): { type: JavaType; run: (frame: Frame) => number } {
    const state: PatternSwitchState = {
      defaultIndex: -1,
      nullIndex: -1,
      totalPatterns: [],
      enumConstants: new Set(),
      dominating: [],
    };
    const groupBindings: PatternBinding[][] = statement.groups.map(() => []);
    const tests = statement.groups.map((group, index) =>
      group.labels.flatMap((label) =>
        this.compileSwitchCase(context, state, group, index, label, selector.type, groupBindings[index])
      )
    );
    const { defaultIndex, nullIndex } = state;
    if (defaultIndex === -1 && !this.covers(selector.type, state.totalPatterns, state.enumConstants, new Set())) {
      this.error(
        statement.selector,
        'switch がすべての場合を網羅していません。default か、残りの型の case を書いてください。'
      );
    }
    exhaustiveSwitches.add(statement);
    this.groupBindings = groupBindings;
    return {
      type: selector.type,
      run: (frame) => {
        const value = selector.run(frame);
        if (value === undefined) {
          if (nullIndex === -1) throwBuiltin(frame, 'NullPointerException');
          return nullIndex;
        }
        const matched = tests.findIndex((groupTests) => groupTests.some((test) => test(frame, value)));
        return matched === -1 ? defaultIndex : matched;
      },
    };
  }

  /** Compiles one label of a pattern switch's group into the tests that select the group. */
  protected compileSwitchCase(
    context: MethodContext,
    state: PatternSwitchState,
    group: SwitchGroup,
    index: number,
    label: SwitchGroup['labels'][number],
    selectorType: JavaType,
    bindings: PatternBinding[]
  ): Test[] {
    if (label === undefined || isNullLabel(label)) {
      const key = label === undefined ? 'defaultIndex' : 'nullIndex';
      if (state[key] !== -1)
        this.error(label ?? group, label === undefined ? 'default が複数あります。' : 'case null が複数あります。');
      state[key] = index;
      return [];
    }
    if (label.kind !== 'patternLabel')
      return [this.compileConstantTest(context, label, selectorType, state.enumConstants)];
    const patternBindings = bindingsOfPattern(label.pattern);
    if (group.labels.length > 1 && patternBindings.length > 0) {
      this.error(label, '変数を宣言するパターンは、他のラベルと同じ case には書けません。');
    }
    const compiled = this.compilePattern(context, label.pattern, selectorType);
    this.checkDominance(state.dominating, compiled.type, label);
    bindings.push(...patternBindings);
    const { guard } = label;
    if (!guard) {
      state.totalPatterns.push(compiled);
      if (label.pattern.kind === 'typePattern') state.dominating.push({ type: compiled.type, span: label });
      return [compiled.test];
    }
    const guardTest = this.withBindings(context, patternBindings, () => this.compileCondition(context, guard));
    return [(frame, value) => compiled.test(frame, value) && guardTest(frame)];
  }

  /** Compiles a constant label of a pattern switch: an enum constant, a string, or a boxed number. */
  protected compileConstantTest(
    context: MethodContext,
    label: Expression,
    selectorType: JavaType,
    enumConstants: Set<string>
  ): Test {
    const bound = upperBound(selectorType);
    if (bound.kind === 'class' && bound.cls.kind === 'enum') {
      const ordinal = this.enumOrdinalOf(context, label, bound.cls);
      const name = bound.cls.staticFields.filter((field) => field.enumConstant)[ordinal].name;
      if (enumConstants.has(name)) this.error(label, 'case の値が重複しています。');
      enumConstants.add(name);
      return (_, value) => value instanceof JavaObject && value.enumConstant?.ordinal === ordinal;
    }
    const value = this.compileValue(context, label);
    const constant = value.constant;
    if (constant === undefined) this.error(label, 'case には定数を書いてください。');
    if (constant instanceof JavaString) {
      return (_, tested) => tested instanceof JavaString && tested.value === constant.value;
    }
    return (_, tested) => tested instanceof JavaObject && tested.boxed === constant;
  }

  /** Rejects a pattern that an earlier unguarded type pattern already matches, which would never run. */
  protected checkDominance(dominating: readonly { type: JavaType; span: Span }[], type: JavaType, span: Span): void {
    for (const earlier of dominating) {
      if (isWidening(erasure(type), erasure(earlier.type), this.builtins.objectClass)) {
        this.error(
          span,
          'この case のパターンは、前の case のパターンにすでに含まれているため、実行されることがありません。'
        );
      }
    }
  }

  /**
   * Whether the patterns match every value of `type`: a total pattern does, enum constants may cover an enum, and a
   * sealed class is covered when each class it permits is.
   */
  protected covers(
    type: JavaType,
    patterns: readonly CompiledPattern[],
    enumConstants: ReadonlySet<string>,
    visiting: Set<ClassInfo>
  ): boolean {
    if (patterns.some((pattern) => pattern.isTotalFor(type))) return true;
    const bound = upperBound(type);
    if (bound.kind !== 'class' || visiting.has(bound.cls)) return false;
    const { cls } = bound;
    if (cls.kind === 'enum') {
      const constants = cls.staticFields.filter((field) => field.enumConstant);
      return constants.length > 0 && constants.every((field) => enumConstants.has(field.name));
    }
    if (!cls.permits) return false;
    visiting.add(cls);
    try {
      return cls.permits.every((permitted) => this.covers(permitted.type, patterns, enumConstants, visiting));
    } finally {
      visiting.delete(cls);
    }
  }

  protected override compileSwitchBody(
    context: MethodContext,
    statement: { isArrowForm: boolean; groups: SwitchGroup[] }
  ): { groups: Exec[]; slots: number[] } {
    const groupBindings = this.groupBindings;
    this.groupBindings = undefined;
    if (!groupBindings) return super.compileSwitchBody(context, statement);
    const compileGroup = (group: SwitchGroup, index: number): Exec =>
      this.withBindings(context, groupBindings[index], () => this.compileStatements(context, group.statements));
    if (statement.isArrowForm) {
      return {
        groups: statement.groups.map((group, index) => this.withScope(context, () => compileGroup(group, index))),
        slots: [],
      };
    }
    const scope: Scope = { names: new Map(), slots: [] };
    context.scopes.push(scope);
    try {
      return { groups: statement.groups.map((group, index) => compileGroup(group, index)), slots: scope.slots };
    } finally {
      context.scopes.pop();
    }
  }
}

function isNullLabel(label: Expression | PatternLabel | undefined): boolean {
  return label?.kind === 'literal' && label.literal.type === 'null';
}
