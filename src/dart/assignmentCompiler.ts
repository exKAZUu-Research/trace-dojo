import type { CascadeSelector, CollectionElement, Expression, Span, SwitchExpressionCase } from './ast';
import type { Member } from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import type { GlobalVariable } from './environment';
import { checkExhaustive } from './exhaustiveness';
import { ExpressionCompiler, inferElementType, SHORTED } from './expressionCompiler';
import type { HashStore } from './hashStore';
import { doubleModulo, dynamicBinary, wrap } from './operators';
import type { Frame } from './runtime';
import { Flow, type LocalVar } from './scope';
import { StatementCompiler } from './statementCompiler';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  type InterfaceType,
  interfaceType,
  isNullable,
  isSubtype,
  iterableElementOf,
  makeNullable,
  nonNullable,
  numericClassOf,
  resolveBound,
  sameType,
  upperBound,
} from './types';
import { type Callable, Cell, DartList, type DartObject, UNASSIGNED, UNINITIALIZED, type Value } from './values';

/** How to read and write the target of an assignment once its receiver and index are evaluated. */
interface AssignableTarget {
  /** The type values written must have. */
  writeType: DartType;
  /** The type reading the target gives, for compound assignments. */
  readType: DartType | undefined;
  /** Evaluates the receiver and index, keeping them for the read and the write. */
  prepare: (frame: Frame) => unknown;
  read: (frame: Frame, prepared: unknown) => Value;
  write: (frame: Frame, prepared: unknown, value: Value) => void;
  /** The local a write assigns, for flow analysis. */
  variable?: LocalVar;
  /** Whether a null-aware access may skip the assignment. */
  shorting: boolean;
}

export abstract class AssignmentCompiler extends StatementCompiler {
  protected compileAssignment(
    expression: Extract<Expression, { kind: 'assign' }>,
    context: DartType | undefined
  ): Compiled {
    void context;
    const target = this.assignableTarget(expression.target, expression.operator === '=');
    return this.assignTo(target, expression.operator, expression.value, expression);
  }

  /** Assigns through a cascade section's last selector. */
  protected compileAssignmentTo(
    receiver: Compiled,
    selector: CascadeSelector,
    operator: string,
    value: Expression,
    span: Span
  ): Compiled {
    let target: AssignableTarget;
    if (selector.kind === 'member') target = this.memberTarget(receiver, selector.name, selector.nullAware, selector);
    else if (selector.kind === 'index')
      target = this.indexTarget(receiver, selector.index, selector.nullAware, selector);
    else return this.error(span, 'この形には代入できません。');
    return this.assignTo(target, operator, value, span);
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Simple, compound, and null-aware assignments.
  private assignTo(target: AssignableTarget, operator: string, valueSyntax: Expression, span: Span): Compiled {
    const { prepare, read, write, variable, writeType } = target;
    if (operator === '=') {
      let value = this.compileExpression(valueSyntax, writeType);
      if (value.type.kind === 'void') this.error(valueSyntax, 'void の値は代入できません。');
      value = this.coerce(
        value,
        writeType,
        valueSyntax,
        (from, to) => `${from} 型の値は、${to} 型の${variable ? `変数 ${variable.name}` : '代入先'}に代入できません。`
      );
      this.afterWrite(variable, value.type);
      const run = value.run;
      return {
        type: value.type,
        run: (frame) => {
          const prepared = prepare(frame);
          if (prepared === SHORTED) return SHORTED;
          const result = run(frame);
          write(frame, prepared, result);
          return result;
        },
        isConst: false,
        variable: undefined,
        creates: value.creates,
      };
    }
    const readType = target.readType ?? DYNAMIC;
    const current: Compiled = { type: readType, run: (frame) => frame.temporaries.at(-1), isConst: false };
    if (operator === '??=') {
      const before = this.flow;
      let value = this.compileExpression(valueSyntax, writeType);
      value = this.coerce(
        value,
        writeType,
        valueSyntax,
        (from, to) => `${from} 型の値は、${to} 型の代入先に代入できません。`
      );
      this.flow = Flow.join(before, this.flow);
      if (variable) this.afterWrite(variable, upperBound(nonNullable(readType), value.type));
      const run = value.run;
      return {
        type: upperBound(nonNullable(readType), value.type),
        run: (frame) => {
          const prepared = prepare(frame);
          if (prepared === SHORTED) return SHORTED;
          const existing = read(frame, prepared);
          if (existing !== undefined) return existing;
          const result = run(frame);
          write(frame, prepared, result);
          return result;
        },
        isConst: false,
      };
    }
    const binary = ExpressionCompiler.COMPOUND_OPERATORS[operator];
    if (!binary) return this.error(span, `演算子 ${operator} は使えません。`);
    if (isNullable(readType) && readType.kind !== 'dynamic') {
      this.error(span, `${typeName(readType)} 型の値は null かもしれないので、${operator} を直接は使えません。`);
    }
    const combined = this.compileBinaryWithLeft(current, binary, valueSyntax, span, writeType);
    const coerced = this.coerce(
      combined,
      writeType,
      span,
      (from, to) => `${from} 型の値は、${to} 型の代入先に代入できません。`
    );
    this.afterWrite(variable, coerced.type);
    const run = coerced.run;
    return {
      type: coerced.type,
      run: (frame) => {
        const prepared = prepare(frame);
        if (prepared === SHORTED) return SHORTED;
        frame.temporaries.push(read(frame, prepared));
        let result: Value;
        try {
          result = run(frame);
        } finally {
          frame.temporaries.pop();
        }
        write(frame, prepared, result);
        return result;
      },
      isConst: false,
    };
  }

  /** Updates flow analysis after a local is assigned a value of `type`. */
  private afterWrite(variable: LocalVar | undefined, type: DartType): void {
    if (!variable) return;
    this.flow = this.flow.assign(variable).demote(variable);
    if (!this.isPromotable(variable)) return;
    if (type.kind !== 'dynamic' && isSubtype(type, variable.type) && !sameType(type, variable.type)) {
      // Assigning promotes a nullable variable to its non-nullable type, a type Dart always considers of interest.
      const nonNull = nonNullable(variable.type);
      if (isNullable(variable.type) && isSubtype(type, nonNull)) this.flow = this.flow.promote(variable, nonNull);
    }
  }

  protected compileIncrement(operand: Expression, operator: '+' | '-', isPrefix: boolean, span: Span): Compiled {
    const target = this.assignableTarget(operand, false);
    const readType = target.readType ?? DYNAMIC;
    if (isNullable(readType) && readType.kind !== 'dynamic') {
      this.error(
        span,
        `${typeName(readType)} 型の値は null かもしれないので、${operator}${operator} を直接は使えません。`
      );
    }
    const one: Expression = { ...at(span), kind: 'int', value: 1n, text: '1' };
    const current: Compiled = { type: readType, run: (frame) => frame.temporaries.at(-1), isConst: false };
    const combined = this.compileBinaryWithLeft(current, operator, one, span, undefined);
    const coerced = this.coerce(
      combined,
      target.writeType,
      span,
      (from, to) => `${from} 型の値は、${to} 型の代入先に代入できません。`
    );
    this.afterWrite(target.variable, coerced.type);
    const { prepare, read, write } = target;
    const numeric = numericClassOf(readType);
    const run = coerced.run;
    const step =
      numeric === 'int' ? (value: Value): Value => wrap((value as bigint) + (operator === '+' ? 1n : -1n)) : undefined;
    return {
      type: isPrefix ? coerced.type : readType,
      run: (frame) => {
        const prepared = prepare(frame);
        if (prepared === SHORTED) return SHORTED;
        const before = read(frame, prepared);
        let after: Value;
        if (step && typeof before === 'bigint') {
          after = step(before);
        } else {
          frame.temporaries.push(before);
          try {
            after = run(frame);
          } finally {
            frame.temporaries.pop();
          }
        }
        write(frame, prepared, after);
        return isPrefix ? after : before;
      },
      isConst: false,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of name an assignment may target.
  private assignableTarget(expression: Expression, isPlainAssignment: boolean): AssignableTarget {
    switch (expression.kind) {
      case 'identifier': {
        return this.nameTarget(expression.name, expression, isPlainAssignment);
      }
      case 'parenthesized': {
        return this.error(expression, '括弧で囲んだ式には代入できません。');
      }
      case 'member': {
        const staticTarget = this.staticTarget(expression.object);
        if (staticTarget?.kind === 'class') {
          const member =
            staticTarget.cls.staticSetters.get(expression.name) ?? staticTarget.cls.staticMembers.get(expression.name);
          if (!member)
            return this.error(
              expression,
              `クラス ${staticTarget.cls.name} に static なメンバー ${expression.name} がありません。`
            );
          return this.staticTarget2(member, expression);
        }
        if (staticTarget?.kind === 'prefix') {
          const declaration = this.library.lookupPrefixed(staticTarget.prefix, expression.name);
          if (declaration?.kind === 'variable') return this.globalTarget(declaration.global, expression);
          return this.error(expression, `${staticTarget.prefix}.${expression.name} には代入できません。`);
        }
        if (expression.object.kind === 'super') {
          return this.memberTarget(this.superReceiver(expression.object), expression.name, false, expression);
        }
        const receiver = this.compileChainPart(expression.object, undefined);
        return this.memberTarget(
          receiver,
          expression.name,
          expression.nullAware,
          expression,
          this.isShorting(expression.object)
        );
      }
      case 'index': {
        const receiver =
          expression.object.kind === 'super'
            ? this.superReceiver(expression.object)
            : this.compileChainPart(expression.object, undefined);
        return this.indexTarget(
          receiver,
          expression.index,
          expression.nullAware,
          expression,
          this.isShorting(expression.object)
        );
      }
      default: {
        return this.error(expression, 'この式には代入できません。');
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Locals, members of this, statics, and globals.
  private nameTarget(name: string, span: Span, isPlainAssignment: boolean): AssignableTarget {
    const resolution = this.resolveName(name);
    if (!resolution) return this.undefinedName(span, name);
    switch (resolution.kind) {
      case 'local': {
        const { variable } = resolution;
        return this.localTarget(variable, span, isPlainAssignment);
      }
      case 'thisMember':
      case 'extensionMember': {
        this.requireThis(span, name);
        const setter = this.lookupMember(this.fn.kind.extensionOn ?? this.fn.kind.thisType ?? DYNAMIC, name, true);
        if (!setter) {
          return this.error(span, `${name} は final か getter だけなので、代入できません。`);
        }
        return this.memberTarget(this.thisReceiver(span), name, false, span);
      }
      case 'staticMember': {
        const cls = resolution.cls;
        const member = cls.staticSetters.get(name) ?? resolution.member;
        return this.staticTarget2(member, span);
      }
      case 'declaration': {
        const { declaration } = resolution;
        if (declaration.kind === 'variable') return this.globalTarget(declaration.global, span);
        if (declaration.kind === 'accessor' && declaration.setter) {
          const setter = declaration.setter;
          const getter = declaration.getter;
          return {
            writeType: setter.type.positional[0] ?? DYNAMIC,
            readType: getter?.type.returnType,
            prepare: () => {},
            read: (frame) =>
              (getter?.impl as unknown as Callable | undefined)?.(
                frame.runtime,
                undefined,
                { positional: [], named: undefined },
                [],
                span.row
              ),
            write: (frame, _prepared, value) => {
              (setter.impl as Callable)(
                frame.runtime,
                undefined,
                { positional: [value], named: undefined },
                [],
                span.row
              );
            },
            shorting: false,
          };
        }
        return this.error(span, `${name} には代入できません。`);
      }
      default: {
        return this.error(span, `${name} には代入できません。`);
      }
    }
  }

  private localTarget(variable: LocalVar, span: Span, isPlainAssignment: boolean): AssignableTarget {
    const { options, name } = variable;
    if (options.isConst) this.error(span, `const の変数 ${name} には代入できません。`);
    if (options.isFinal && options.isLate && this.flow.assigned.has(variable)) {
      this.error(span, `late final の変数 ${name} には、もう値を代入できません。`);
    }
    if (options.isFinal && !options.isLate) {
      const assigned =
        options.hasInitializer ||
        options.isParameter ||
        this.flow.maybeAssigned.has(variable) ||
        variable.owner !== this.fn;
      if (assigned) this.error(span, `final の変数 ${name} には、もう値を代入できません。`);
    }
    if (!isPlainAssignment) this.checkDefinitelyAssigned(variable, span);
    if (variable.owner !== this.fn) variable.isWriteCaptured = true;
    const cell = this.cellAccess(variable);
    const isLateFinal = options.isLate && options.isFinal;
    const readType = this.isPromotable(variable) ? this.promotedType(variable) : variable.type;
    return {
      writeType: variable.type,
      readType,
      prepare: () => {},
      read: (frame) => {
        const value = cell(frame).v;
        if (value === UNINITIALIZED)
          frame.runtime.throwError('LateInitializationError', '', [`Local '${name}' has not been initialized.`]);
        return value === UNASSIGNED ? undefined : value;
      },
      write: isLateFinal
        ? (frame, _prepared, value) => {
            const target = cell(frame);
            if (target.v !== UNINITIALIZED)
              frame.runtime.throwError('LateInitializationError', '', [
                `Local '${name}' has already been initialized.`,
              ]);
            target.v = value;
          }
        : (frame, _prepared, value) => {
            cell(frame).v = value;
          },
      variable,
      shorting: false,
    };
  }

  private staticTarget2(member: Member, span: Span): AssignableTarget {
    if (member.kind === 'field') {
      const global = this.globals[member.slot];
      return this.globalTarget(global, span);
    }
    if (member.kind === 'setter') {
      const getter = member.owner.staticMembers.get(member.name);
      const setter = member;
      return {
        writeType: member.type,
        readType: getter?.kind === 'getter' ? getter.type : undefined,
        prepare: () => {},
        read: (frame) =>
          (getter?.impl as unknown as Callable | undefined)?.(
            frame.runtime,
            undefined,
            { positional: [], named: undefined },
            [],
            span.row
          ),
        write: (frame, _prepared, value) => {
          (setter.impl as Callable)(frame.runtime, undefined, { positional: [value], named: undefined }, [], span.row);
        },
        shorting: false,
      };
    }
    return this.error(span, `${member.name} には代入できません。`);
  }

  protected globalTarget(global: GlobalVariable, span: Span): AssignableTarget {
    if (global.isConst) this.error(span, `const の ${global.name} には代入できません。`);
    if (global.isFinal && !global.isLate) this.error(span, `final の ${global.name} には代入できません。`);
    const read = this.readGlobal(global);
    const { slot } = global;
    const isLateFinal = global.isLate && global.isFinal;
    return {
      writeType: global.type,
      readType: global.type,
      prepare: () => {},
      read: (frame) => read(frame),
      write: (frame, _prepared, value) => {
        const cell = frame.runtime.globals[slot];
        if (isLateFinal && cell.v !== UNINITIALIZED) {
          frame.runtime.throwError('LateInitializationError', '', [
            `Field '${global.name}' has already been initialized.`,
          ]);
        }
        cell.v = value;
      },
      shorting: false,
    };
  }

  private memberTarget(
    receiver: Compiled,
    name: string,
    nullAware: boolean,
    span: Span,
    shorting = false
  ): AssignableTarget {
    const receiverType = receiver.type;
    const { run } = receiver;
    if (receiverType.kind === 'dynamic') {
      return {
        writeType: DYNAMIC,
        readType: DYNAMIC,
        prepare: (frame) => {
          const value = run(frame);
          return value === SHORTED || (nullAware && value === undefined) ? SHORTED : value;
        },
        read: (frame, prepared) => frame.runtime.getProperty(prepared as Value, name, span.row),
        write: (frame, prepared, value) => frame.runtime.setProperty(prepared as Value, name, value, span.row),
        shorting: true,
      };
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const setter = this.lookupMember(lookupType, name, true);
    if (!setter) {
      const getter = this.lookupMember(lookupType, name, false);
      if (getter) return this.error(span, `${name} は final か getter だけなので、代入できません。`);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメンバーがありません。`);
    }
    if (!nullAware && isNullable(receiverType)) {
      this.error(span, `${typeName(receiverType)} 型の値は null かもしれないので、${name} に直接は代入できません。`);
    }
    const getter = this.lookupMember(lookupType, name, false);
    const isSuper = (receiver as { isSuper?: boolean }).isSuper === true;
    const superclassAt = isSuper ? this.superclassOf(span).classAt : undefined;
    if (setter.extension) {
      const setterMember = setter.member;
      const getterMember = getter?.member;
      const typeArgs = setter.extension.typeArgs;
      return {
        writeType: setter.type,
        readType: getter?.type,
        prepare: (frame) => {
          const value = run(frame);
          return value === SHORTED || (nullAware && value === undefined) ? SHORTED : value;
        },
        read: (frame, prepared) =>
          (getterMember?.impl as unknown as Callable | undefined)?.(
            frame.runtime,
            prepared as Value,
            { positional: [], named: undefined },
            typeArgs,
            span.row
          ),
        write: (frame, prepared, value) => {
          (setterMember.impl as unknown as Callable)(
            frame.runtime,
            prepared as Value,
            { positional: [value], named: undefined },
            typeArgs,
            span.row
          );
        },
        shorting: nullAware || shorting,
      };
    }
    return {
      writeType: setter.type,
      readType: getter?.type,
      prepare: (frame) => {
        const value = run(frame);
        return value === SHORTED || (nullAware && value === undefined) ? SHORTED : value;
      },
      read: (frame, prepared) => {
        if (superclassAt) {
          const member = superclassAt(frame).implementation(name);
          return member ? frame.runtime.readMember(prepared as Value, member, span.row) : undefined;
        }
        return frame.runtime.getProperty(prepared as Value, name, span.row);
      },
      write: (frame, prepared, value) => {
        if (superclassAt) {
          const member = superclassAt(frame).setterImplementation(name);
          if (member?.kind === 'field') (prepared as DartObject).fields[member.slot] = value;
          else if (member)
            (member.impl as Callable)(
              frame.runtime,
              prepared as Value,
              { positional: [value], named: undefined },
              [],
              span.row
            );
          return;
        }
        frame.runtime.setProperty(prepared as Value, name, value, span.row);
      },
      shorting: nullAware || shorting,
    };
  }

  private indexTarget(
    receiver: Compiled,
    indexSyntax: Expression,
    nullAware: boolean,
    span: Span,
    shorting = false
  ): AssignableTarget {
    const receiverType = receiver.type;
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    let indexContext: DartType | undefined;
    let writeType: DartType = DYNAMIC;
    let readType: DartType | undefined = DYNAMIC;
    if (receiverType.kind !== 'dynamic') {
      const setter = this.lookupMember(lookupType, '[]=', false);
      if (!setter || setter.member.kind !== 'method')
        return this.error(span, `${typeName(nonNullable(receiverType))} 型には演算子 []= がありません。`);
      if (!nullAware && isNullable(receiverType))
        this.error(span, `${typeName(receiverType)} 型の値は null かもしれないので、[ ] に直接は代入できません。`);
      const signature = setter.type as FunctionType;
      indexContext = signature.positional[0];
      writeType = signature.positional[1] ?? DYNAMIC;
      const getter = this.lookupMember(lookupType, '[]', false);
      readType = getter?.member.kind === 'method' ? (getter.type as FunctionType).returnType : undefined;
    }
    let index = this.compileExpression(indexSyntax, indexContext);
    if (indexContext)
      index = this.coerce(
        index,
        indexContext,
        indexSyntax,
        (from, to) => `${from} 型の値は、添字の型 ${to} に合いません。`
      );
    const receiverRun = receiver.run;
    const indexRun = index.run;
    return {
      writeType,
      readType,
      prepare: (frame) => {
        const value = receiverRun(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        frame.temporaries.push(value);
        try {
          return [value, indexRun(frame)];
        } finally {
          frame.temporaries.pop();
        }
      },
      read: (frame, prepared) => {
        const [object, key] = prepared as [Value, Value];
        return frame.runtime.invoke(object, '[]', { positional: [key], named: undefined }, [], span.row);
      },
      write: (frame, prepared, value) => {
        const [object, key] = prepared as [Value, Value];
        frame.runtime.invoke(
          object,
          '[]=',
          { positional: [key, value], named: undefined, isDynamic: receiverType.kind === 'dynamic' },
          [],
          span.row
        );
      },
      shorting: nullAware || shorting,
    };
  }

  // Collections

  // code-gauge-allow functionCognitiveComplexity 50 -- One case per kind of collection element.
  compileCollectionElements(
    elements: CollectionElement[],
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined
  ): {
    types: { key: DartType; value?: DartType }[];
    run: (frame: Frame, add: (key: Value, value?: Value) => void) => void;
    isConst: boolean;
    creates: boolean;
  } {
    const types: { key: DartType; value?: DartType }[] = [];
    let isConst = true;
    // A literal of objects being created counts as creating them, as Java's array initializers do.
    let creates = elements.length > 0;
    const runs: ((frame: Frame, add: (key: Value, value?: Value) => void) => void)[] = [];
    const elementName = kind === 'list' ? 'リスト' : kind === 'set' ? 'セット' : 'マップ';
    const coerceElement = (compiled: Compiled, target: DartType | undefined, span: Span): Compiled => {
      if (!target || target.kind === 'dynamic') return compiled;
      if (compiled.type.kind === 'void') this.error(span, `void の値は${elementName}に入れられません。`);
      return this.coerce(
        compiled,
        target,
        span,
        (from, to) => `${from} 型の値は、${to} 型の${elementName}の要素にできません。`
      );
    };
    for (const element of elements) {
      switch (element.kind) {
        case 'mapEntry': {
          if (kind !== 'map') this.error(element, `${elementName}のリテラルには、キーと値の組は書けません。`);
          const key = coerceElement(
            this.compileExpression(
              element.key,
              element.nullAwareKey ? (elementContext ? makeNullable(elementContext) : undefined) : elementContext
            ),
            element.nullAwareKey ? undefined : elementContext,
            element.key
          );
          const value = coerceElement(
            this.compileExpression(
              element.value,
              element.nullAwareValue ? (valueContext ? makeNullable(valueContext) : undefined) : valueContext
            ),
            element.nullAwareValue ? undefined : valueContext,
            element.value
          );
          isConst &&= key.isConst && value.isConst;
          types.push({
            key: element.nullAwareKey ? nonNullable(key.type) : key.type,
            value: element.nullAwareValue ? nonNullable(value.type) : value.type,
          });
          const keyRun = key.run;
          const valueRun = value.run;
          const { nullAwareKey, nullAwareValue } = element;
          runs.push((frame, add) => {
            const k = keyRun(frame);
            if (nullAwareKey && k === undefined) return;
            frame.temporaries.push(k);
            try {
              const v = valueRun(frame);
              if (nullAwareValue && v === undefined) return;
              add(k, v);
            } finally {
              frame.temporaries.pop();
            }
          });
          break;
        }
        case 'spread': {
          runs.push(this.compileSpread(element, kind, elementContext, valueContext, types));
          isConst = false;
          break;
        }
        case 'nullAwareElement': {
          if (kind === 'map') this.error(element, 'マップのリテラルには、キーと値の組を書いてください。');
          const compiled = this.compileExpression(
            element.value,
            elementContext ? makeNullable(elementContext) : undefined
          );
          if (
            elementContext &&
            !isSubtype(nonNullable(compiled.type), elementContext) &&
            compiled.type.kind !== 'dynamic'
          ) {
            {
              this.error(
                element,
                `${typeName(compiled.type)} 型の値は、${typeName(elementContext)} 型の${elementName}の要素にできません。`
              );
            }
          }
          isConst &&= compiled.isConst;
          types.push({ key: nonNullable(compiled.type) });
          const { run } = compiled;
          runs.push((frame, add) => {
            const value = run(frame);
            if (value !== undefined) add(value);
          });
          break;
        }
        case 'ifElement': {
          runs.push(this.compileIfElement(element, kind, elementContext, valueContext, types));
          isConst = false;
          break;
        }
        case 'forElement':
        case 'forInElement': {
          runs.push(this.compileForElement(element, kind, elementContext, valueContext, types));
          isConst = false;
          break;
        }
        default: {
          if (kind === 'map') this.error(element, 'マップのリテラルには、キーと値の組を書いてください。');
          const compiled = coerceElement(this.compileExpression(element, elementContext), elementContext, element);
          isConst &&= compiled.isConst;
          creates &&= compiled.creates === true;
          types.push({ key: compiled.type });
          const { run } = compiled;
          runs.push((frame, add) => add(run(frame)));
        }
      }
    }
    return {
      types,
      run: (frame, add) => {
        for (const run of runs) run(frame, add);
      },
      isConst,
      creates:
        creates &&
        elements.every(
          (element) =>
            !['mapEntry', 'spread', 'nullAwareElement', 'ifElement', 'forElement', 'forInElement'].includes(
              element.kind
            )
        ),
    };
  }

  private compileSpread(
    element: Extract<CollectionElement, { kind: 'spread' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: { key: DartType; value?: DartType }[]
  ): (frame: Frame, add: (key: Value, value?: Value) => void) => void {
    const contextType =
      kind === 'map'
        ? interfaceType(coreTypes.map, [elementContext ?? DYNAMIC, valueContext ?? DYNAMIC])
        : interfaceType(coreTypes.iterable, [elementContext ?? DYNAMIC]);
    const compiled = this.compileExpression(element.value, element.nullAware ? makeNullable(contextType) : contextType);
    const base = element.nullAware ? nonNullable(compiled.type) : compiled.type;
    if (!element.nullAware && isNullable(compiled.type) && compiled.type.kind !== 'dynamic') {
      this.error(
        element,
        `${typeName(compiled.type)} 型の値は null かもしれないので、... では展開できません。...? を使ってください。`
      );
    }
    const { run } = compiled;
    const { nullAware } = element;
    if (kind === 'map') {
      const resolved = resolveBound(base);
      const instance =
        resolved.kind === 'interface' ? asInstanceOf({ ...resolved, nullable: false }, coreTypes.map) : undefined;
      if (!instance && base.kind !== 'dynamic' && base.kind !== 'null')
        this.error(element, `${typeName(compiled.type)} 型の値は Map ではないので、マップの中では展開できません。`);
      const [keyType, valueType] = instance?.args ?? [DYNAMIC, DYNAMIC];
      if (elementContext && !isSubtype(keyType, elementContext))
        this.error(
          element,
          `${typeName(keyType)} 型のキーは、${typeName(elementContext)} 型のマップに入れられません。`
        );
      if (valueContext && !isSubtype(valueType, valueContext))
        this.error(element, `${typeName(valueType)} 型の値は、${typeName(valueContext)} 型のマップに入れられません。`);
      types.push({ key: keyType, value: valueType });
      return (frame, add) => {
        const map = run(frame);
        if (nullAware && map === undefined) return;
        const { runtime } = frame;
        const entries = runtime.getProperty(map, 'entries', undefined);
        const iterator = runtime.getProperty(entries, 'iterator', undefined);
        frame.temporaries.push(iterator);
        try {
          while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
            const entry = runtime.getProperty(iterator, 'current', undefined);
            add(runtime.getProperty(entry, 'key', undefined), runtime.getProperty(entry, 'value', undefined));
          }
        } finally {
          frame.temporaries.pop();
        }
      };
    }
    const elementType = base.kind === 'null' ? DYNAMIC : iterableElementOf(base);
    if (!elementType)
      this.error(element, `${typeName(compiled.type)} 型の値は Iterable ではないので、展開できません。`);
    if (elementContext && elementType.kind !== 'dynamic' && !isSubtype(elementType, elementContext)) {
      this.error(element, `${typeName(elementType)} 型の要素は、${typeName(elementContext)} 型の要素にできません。`);
    }
    types.push({ key: elementType });
    const castElements =
      elementType.kind === 'dynamic' && elementContext && elementContext.kind !== 'dynamic'
        ? this.runtimeCast((frame) => frame.temporaries.at(-1), elementContext, false)
        : undefined;
    return (frame, add) => {
      const iterable = run(frame);
      if (nullAware && iterable === undefined) return;
      const { runtime } = frame;
      if (iterable instanceof DartList && !castElements) {
        for (const value of iterable.elements) add(value);
        return;
      }
      const iterator = runtime.getProperty(iterable, 'iterator', undefined);
      frame.temporaries.push(iterator);
      try {
        while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
          const value = runtime.getProperty(iterator, 'current', undefined);
          if (castElements) {
            frame.temporaries.push(value);
            try {
              castElements(frame);
            } finally {
              frame.temporaries.pop();
            }
          }
          add(value);
        }
      } finally {
        frame.temporaries.pop();
      }
    };
  }

  private compileIfElement(
    element: Extract<CollectionElement, { kind: 'ifElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: { key: DartType; value?: DartType }[]
  ): (frame: Frame, add: (key: Value, value?: Value) => void) => void {
    if (element.casePattern) {
      const subject = this.compileExpression(element.condition);
      const casePattern = element.casePattern;
      const before = this.flow;
      const { result, slots } = this.withScope(() => {
        const pattern = this.compilePattern(casePattern.pattern, subject.type, { mode: 'match', isFinal: false });
        for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
        const guard = casePattern.guard ? this.compileCondition(casePattern.guard).compiled.run : undefined;
        const body = this.compileCollectionElements([element.consequent], kind, elementContext, valueContext);
        return { pattern, guard, body };
      });
      this.flow = before;
      const otherwise = element.alternative
        ? this.compileCollectionElements([element.alternative], kind, elementContext, valueContext)
        : undefined;
      this.flow = before;
      types.push(...result.body.types, ...(otherwise?.types ?? []));
      const test = subject.run;
      return (frame, add) => {
        const value = test(frame);
        try {
          if (result.pattern.match(frame, value) && (!result.guard || result.guard(frame) === true)) {
            result.body.run(frame, add);
            return;
          }
        } finally {
          for (const slot of slots) frame.locals[slot] = undefined;
        }
        otherwise?.run(frame, add);
      };
    }
    const { compiled: condition, flow } = this.compileCondition(element.condition);
    this.flow = flow.whenTrue;
    const consequent = this.compileCollectionElements([element.consequent], kind, elementContext, valueContext);
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const otherwise = element.alternative
      ? this.compileCollectionElements([element.alternative], kind, elementContext, valueContext)
      : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    types.push(...consequent.types, ...(otherwise?.types ?? []));
    const test = condition.run;
    return (frame, add) => {
      if (test(frame)) consequent.run(frame, add);
      else otherwise?.run(frame, add);
    };
  }

  private compileForElement(
    element: Extract<CollectionElement, { kind: 'forElement' | 'forInElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: { key: DartType; value?: DartType }[]
  ): (frame: Frame, add: (key: Value, value?: Value) => void) => void {
    const before = this.flow;
    const { result, slots } = this.withScope(() => {
      if (element.kind === 'forInElement') {
        const iterable = this.compileExpression(element.iterable);
        const elementType = this.elementTypeOfIterable(iterable, element.iterable);
        this.enterLoop(element);
        const savedRecords = this.recordsSteps;
        this.recordsSteps = false;
        const bind = this.compileForInBinding(element.binding, elementType, element);
        this.recordsSteps = savedRecords;
        const body = this.compileCollectionElements([element.body], kind, elementContext, valueContext);
        types.push(...body.types);
        const source = iterable.run;
        return (frame: Frame, add: (key: Value, value?: Value) => void) => {
          const { runtime } = frame;
          const iterator = runtime.getProperty(source(frame), 'iterator', undefined);
          frame.temporaries.push(iterator);
          try {
            while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
              bind(frame, runtime.getProperty(iterator, 'current', undefined));
              body.run(frame, add);
              runtime.spend();
            }
          } finally {
            frame.temporaries.pop();
          }
        };
      }
      const { init } = element;
      let initRun: ((frame: Frame) => void) | undefined;
      const loopSlots: number[] = [];
      if (init && !Array.isArray(init)) {
        const before = new Set(this.fn.scopes.at(-1)?.values());
        const exec = this.compileLocalDeclaration(init, false);
        for (const variable of this.fn.scopes.at(-1)?.values() ?? [])
          if (!before.has(variable)) loopSlots.push(variable.slot);
        initRun = (frame) => void exec(frame);
      } else if (init) {
        const runs = init.map((expression) => this.compileExpression(expression).run);
        initRun = (frame) => {
          for (const run of runs) run(frame);
        };
      }
      this.enterLoop(element);
      const condition = element.condition ? this.compileCondition(element.condition) : undefined;
      if (condition) this.flow = condition.flow.whenTrue;
      const body = this.compileCollectionElements([element.body], kind, elementContext, valueContext);
      types.push(...body.types);
      const updates = element.updates.map((update) => this.compileExpression(update).run);
      const test = condition?.compiled.run;
      return (frame: Frame, add: (key: Value, value?: Value) => void) => {
        initRun?.(frame);
        while (!test || test(frame)) {
          body.run(frame, add);
          // Each iteration has its own loop variables, which closures created in the body keep.
          for (const slot of loopSlots) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
          for (const update of updates) update(frame);
          frame.runtime.spend();
        }
      };
    });
    this.flow = before;
    return (frame, add) => {
      try {
        result(frame, add);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  protected buildSet(
    type: DartType,
    run: (frame: Frame, add: (key: Value) => void) => void,
    isConst: boolean
  ): Compiled {
    const elementType = (type as InterfaceType).args[0];
    const resolve = this.runtimeType(elementType);
    const build: Eval = (frame) => {
      const set = frame.runtime.links.newSet(frame.runtime, resolve(frame), isConst);
      frame.temporaries.push(set);
      try {
        const store = set.native as HashStore;
        run(frame, (key) => {
          store.set(key, undefined);
        });
      } finally {
        frame.temporaries.pop();
      }
      return set;
    };
    return { type, run: isConst ? this.canonicalized(build) : build, isConst };
  }

  protected buildMap(
    type: DartType,
    run: (frame: Frame, add: (key: Value, value?: Value) => void) => void,
    isConst: boolean
  ): Compiled {
    const [keyType, valueType] = (type as InterfaceType).args;
    const resolveKey = this.runtimeType(keyType);
    const resolveValue = this.runtimeType(valueType);
    const build: Eval = (frame) => {
      const map = frame.runtime.links.newMap(frame.runtime, resolveKey(frame), resolveValue(frame), isConst);
      frame.temporaries.push(map);
      try {
        const store = map.native as HashStore;
        run(frame, (key, value) => {
          store.set(key, value);
        });
      } finally {
        frame.temporaries.pop();
      }
      return map;
    };
    return { type, run: isConst ? this.canonicalized(build) : build, isConst };
  }

  // Switch expressions

  compileSwitchExpression(
    subjectSyntax: Expression,
    cases: SwitchExpressionCase[],
    span: Span,
    context: DartType | undefined
  ): Compiled {
    const subject = this.compileExpression(subjectSyntax);
    const before = this.flow;
    let after: Flow | undefined;
    let resultType: DartType | undefined;
    const compiledCases = cases.map((switchCase) => {
      this.flow = before;
      const { result, slots } = this.withScope(() => {
        const pattern = this.compilePattern(switchCase.pattern, subject.type, { mode: 'match', isFinal: false });
        for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
        let guard: Eval | undefined;
        if (switchCase.guard) {
          const compiled = this.compileCondition(switchCase.guard);
          guard = compiled.compiled.run;
          this.flow = compiled.flow.whenTrue;
        }
        const body = this.compileExpression(switchCase.body, context);
        return { pattern, guard, body };
      });
      after = after ? Flow.join(after, this.flow) : this.flow;
      const bodyType = result.body.type;
      if (!(bodyType.kind === 'never' && !bodyType.nullable))
        resultType = resultType ? upperBound(resultType, bodyType) : bodyType;
      return { ...result, slots };
    });
    checkExhaustive(
      this,
      subject.type,
      cases.filter((switchCase) => !switchCase.guard).map((switchCase) => switchCase.pattern),
      span,
      false
    );
    this.flow = after ?? before;
    const type = resultType ?? { kind: 'never', nullable: false };
    const test = subject.run;
    return {
      type,
      run: (frame) => {
        const value = test(frame);
        frame.temporaries.push(value);
        try {
          for (const switchCase of compiledCases) {
            try {
              if (switchCase.pattern.match(frame, value) && (!switchCase.guard || switchCase.guard(frame) === true)) {
                return switchCase.body.run(frame);
              }
            } finally {
              for (const slot of switchCase.slots) frame.locals[slot] = undefined;
            }
          }
        } finally {
          frame.temporaries.pop();
        }
        return frame.runtime.throwError('StateError', '', ['No switch case matched']);
      },
      isConst: false,
    };
  }

  static readonly UNUSED = [Cell, doubleModulo, dynamicBinary, inferElementType, DYNAMIC] as const;
}

export type { Member };
