import type { Expression, Span, Statement, SwitchGroup } from './ast';
import {
  type Compiled,
  type CompiledValue,
  type Completion,
  type Exec,
  type MethodContext,
  type Scope,
  type SwitchExpressionTarget,
} from './compilerBase';
import { nullMessage } from './nullMessages';
import { canCompleteNormally, exhaustiveSwitches } from './reachability';
import { type Frame, throwBuiltin, UNASSIGNED } from './runtime';
import { StatementCompiler } from './statementCompiler';
import { type ClassInfo, isReference, type JavaType, sameType, typeName } from './types';
import { JavaObject, JavaString, type Value } from './values';

/** Compiles switch statements and switch expressions with constant labels. */
export abstract class SwitchCompiler extends StatementCompiler {
  protected compileYield(context: MethodContext, statement: Extract<Statement, { kind: 'yield' }>): Exec {
    const target = context.switchExpressions.at(-1);
    if (!target) return this.error(statement, 'yield 文は switch 式の中にしか書けません。');
    const value = target.targetType
      ? this.compileValueFor(context, statement.value, target.targetType)
      : this.compileValue(context, statement.value);
    const index = target.values.push({ value, span: statement.value }) - 1;
    return (frame) => ({ kind: 'yield', value: target.converters[index](frame) });
  }

  protected compileSwitchExpression(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'switchExpression' }>
  ): Compiled {
    const targetType = this.takeTargetType();
    const selector = this.compileSwitchSelector(context, expression);
    const target: SwitchExpressionTarget = { targetType, values: [], converters: [] };
    // Jumps cannot leave a switch expression, which completes only with a value or an exception.
    const outer = { ...context };
    Object.assign(context, { labels: [], loopLabels: [], continueLabels: [], loopDepth: 0, switchDepth: 0 });
    context.isInSwitchExpression = true;
    context.switchExpressions.push(target);
    let groups: { groups: Exec[]; slots: number[] };
    try {
      groups = this.compileSwitchBody(context, expression);
    } finally {
      context.switchExpressions.pop();
      Object.assign(context, {
        labels: outer.labels,
        loopLabels: outer.loopLabels,
        continueLabels: outer.continueLabels,
        loopDepth: outer.loopDepth,
        switchDepth: outer.switchDepth,
        isInSwitchExpression: outer.isInSwitchExpression,
      });
    }
    this.checkSwitchExpressionBody(expression, selector.type);
    if (target.values.length === 0) this.error(expression, 'switch 式には値を返す case が必要です。');
    const type = this.switchExpressionType(expression, target.values);
    for (const { value, span } of target.values) {
      target.converters.push(
        isReference(type) ? this.checkErased(value, type).run : this.convert(value, type, 'assignment', span).run
      );
    }
    const runFrom = this.compileSwitchRunner(expression, groups.groups, groups.slots);
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const start = selector.run(frame);
        const completion = start === -1 ? undefined : runFrom(frame, start);
        if (completion?.kind !== 'yield') throw new Error('A switch expression completed without a value');
        return completion.value;
      },
    };
  }

  /** Rejects a switch expression that may complete without a value, as an incomplete set of cases would. */
  protected checkSwitchExpressionBody(
    expression: Extract<Expression, { kind: 'switchExpression' }>,
    selectorType: JavaType
  ): void {
    const hasDefault = expression.groups.some((group) => group.labels.includes(undefined));
    const enumClass = selectorType.kind === 'class' && selectorType.cls.kind === 'enum' ? selectorType.cls : undefined;
    const coversEnum =
      enumClass !== undefined &&
      enumClass.staticFields
        .filter((field) => field.enumConstant)
        .every((field) =>
          expression.groups.some((group) =>
            group.labels.some((label) =>
              label?.kind === 'name'
                ? label.name === field.name
                : label?.kind === 'fieldAccess' && label.name === field.name
            )
          )
        );
    if (!hasDefault && !coversEnum && !exhaustiveSwitches.has(expression))
      this.error(expression, 'switch 式がすべての場合を網羅していません。default を書いてください。');
    const groupsEnding = expression.isArrowForm ? expression.groups : expression.groups.slice(-1);
    for (const group of groupsEnding) {
      if (group.statements.every((statement) => canCompleteNormally(statement))) {
        this.error(group, 'switch 式の case の処理が、値を返さずに終わっています。yield で値を返してください。');
      }
    }
  }

  /** The type of a switch expression, which joins the types of its results as a conditional joins two. */
  protected switchExpressionType(span: Span, values: readonly { value: CompiledValue }[]): JavaType {
    let result = values[0].value;
    for (const { value } of values.slice(1)) {
      // Results combine as a conditional's operands do, a wrapper and a primitive by unboxing.
      const type = this.conditionalType(span, ...this.conditionalOperands(result, value));
      result = {
        kind: 'value',
        type,
        run: result.run,
        constant:
          result.constant !== undefined && value.constant !== undefined && sameType(type, result.type)
            ? result.constant
            : undefined,
      };
    }
    return result.type;
  }

  protected compileSwitch(context: MethodContext, statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const selector = this.compileSwitchSelector(context, statement);
    context.switchDepth++;
    let runFrom: (frame: Frame, start: number) => Completion | undefined;
    try {
      const { groups, slots } = this.compileSwitchBody(context, statement);
      runFrom = this.compileSwitchRunner(statement, groups, slots);
    } finally {
      context.switchDepth--;
    }
    return (frame) => {
      const start = selector.run(frame);
      if (start === -1) return;
      const completion = runFrom(frame, start);
      return completion?.kind === 'break' && completion.label === undefined ? undefined : completion;
    };
  }

  /** Compiles a switch's selector and labels into the index of the group where execution starts, or -1. */
  protected compileSwitchSelector(
    context: MethodContext,
    statement: { selector: Expression; groups: SwitchGroup[] }
  ): { type: JavaType; run: (frame: Frame) => number } {
    const selector = this.operand(this.compileValue(context, statement.selector));
    const isString = selector.type.kind === 'class' && selector.type.cls === this.builtins.stringClass;
    const isEnum = selector.type.kind === 'class' && selector.type.cls.kind === 'enum';
    if (!isString && !isEnum && !['byte', 'short', 'char', 'int'].includes(selector.type.kind)) {
      this.error(statement.selector, `switch では ${typeName(selector.type)} 型の値を使えません。`);
    }
    const { labelValues, defaultIndex } = this.compileSwitchLabels(context, statement, selector.type);
    const matches = (candidate: Value, value: Value): boolean =>
      isString ? (candidate as JavaString).value === (value as JavaString).value : candidate === value;
    // Java switches on a string's hash code and an enum constant's ordinal.
    const selectingMethod =
      selector.type.kind === 'class' && isEnum ? `${selector.type.cls.binaryName}.ordinal()` : 'String.hashCode()';
    const message = nullMessage(`Cannot invoke "${selectingMethod}"`, selector.source);
    return {
      type: selector.type,
      run: (frame) => {
        const selected = selector.run(frame);
        if (selected === undefined) throwBuiltin(frame, 'NullPointerException', message);
        // Enum labels hold the ordinals of their constants.
        const value = isEnum && selected instanceof JavaObject ? selected.enumConstant?.ordinal : selected;
        const matched = labelValues.findIndex((values) => values.some((candidate) => matches(candidate, value)));
        return matched === -1 ? defaultIndex : matched;
      },
    };
  }

  /** The constants of each group's case labels, and the index of the group holding `default` (or -1). */
  protected compileSwitchLabels(
    context: MethodContext,
    statement: { groups: SwitchGroup[] },
    selectorType: JavaType
  ): { labelValues: Value[][]; defaultIndex: number } {
    const seen = new Set<unknown>();
    let defaultIndex = -1;
    const labelValues = statement.groups.map((group, index) =>
      group.labels.flatMap((label) => {
        // A classic switch has no patterns, which select the pattern switch instead.
        if (label) return [this.compileCaseConstant(context, label as Expression, selectorType, seen)];
        if (defaultIndex !== -1) this.error(group, 'default が複数あります。');
        defaultIndex = index;
        return [];
      })
    );
    return { labelValues, defaultIndex };
  }

  protected compileCaseConstant(
    context: MethodContext,
    label: Expression,
    selectorType: JavaType,
    seen: Set<unknown>
  ): Value {
    if (selectorType.kind === 'class' && selectorType.cls.kind === 'enum') {
      const ordinal = this.enumOrdinalOf(context, label, selectorType.cls);
      if (seen.has(ordinal)) this.error(label, 'case の値が重複しています。');
      seen.add(ordinal);
      return ordinal;
    }
    const { constant } = this.convert(this.compileValue(context, label), selectorType, 'assignment', label);
    if (constant === undefined) this.error(label, 'case には定数を書いてください。');
    const key = constant instanceof JavaString ? `s:${constant.value}` : constant;
    if (seen.has(key)) this.error(label, 'case の値が重複しています。');
    seen.add(key);
    return constant;
  }

  /** The ordinal of the constant of `enumClass` that a case label names, by its simple or qualified name. */
  protected enumOrdinalOf(context: MethodContext, label: Expression, enumClass: ClassInfo): number {
    let name: string | undefined;
    if (label.kind === 'name') name = label.name;
    else if (label.kind === 'fieldAccess' && label.object !== 'super') {
      const owner = this.compileExpression(context, label.object);
      if (owner.kind === 'class' && owner.cls === enumClass) name = label.name;
    }
    const constants = enumClass.staticFields.filter((field) => field.enumConstant);
    const ordinal = constants.findIndex((field) => field.name === name);
    if (ordinal === -1) this.error(label, `case には列挙型 ${enumClass.name} の定数を書いてください。`);
    return ordinal;
  }

  /** Compiles the groups of a switch, whose classic groups share one scope, returning that scope's slots. */
  protected compileSwitchBody(
    context: MethodContext,
    statement: { isArrowForm: boolean; groups: SwitchGroup[] }
  ): { groups: Exec[]; slots: number[] } {
    if (statement.isArrowForm) {
      const groups = statement.groups.map((group) =>
        this.withScope(context, () => this.compileStatements(context, group.statements))
      );
      return { groups, slots: [] };
    }
    const scope: Scope = { names: new Map(), slots: [] };
    context.scopes.push(scope);
    try {
      return {
        groups: statement.groups.map((group) => this.compileStatements(context, group.statements)),
        slots: scope.slots,
      };
    } finally {
      context.scopes.pop();
    }
  }

  /** A runner that starts at a group and falls through the classic groups in order. */
  protected compileSwitchRunner(
    statement: { isArrowForm: boolean },
    groups: Exec[],
    slots: number[]
  ): (frame: Frame, start: number) => Completion | undefined {
    const { isArrowForm } = statement;
    return (frame, start) => {
      try {
        for (let index = start; index < groups.length; index++) {
          const completion = groups[index](frame);
          if (completion || isArrowForm) return completion;
        }
        return;
      } finally {
        for (const slot of slots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }
}
