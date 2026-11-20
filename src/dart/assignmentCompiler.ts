// code-gauge-allow-file fileNcss 655 -- One compiler phase per file; splitting it further would scatter the cases of one construct.
import type { CascadeSelector, CollectionElement, Expression, ForInBinding, Span, SwitchExpressionCase } from './ast';
import type { ClassInfo, Member } from './classes';
import { at, type Compiled, type Eval, type ResolvedMember, typeName } from './compilerBase';
import { ControlCompiler } from './controlCompiler';
import type { GlobalVariable } from './environment';
import { checkExhaustive } from './exhaustiveness';
import { ExpressionCompiler, SHORTED } from './expressionCompiler';
import type { HashStore } from './hashStore';
import { wrap } from './operators';
import type { Frame } from './runtime';
import { Flow, type LocalVar } from './scope';
import { isAnsweredType } from './statementCompiler';
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
  NEVER,
  nonNullable,
  numericClassOf,
  resolveBound,
  sameType,
  upperBound,
} from './types';
import { type Callable, Cell, DartList, type DartObject, UNINITIALIZED, type Value } from './values';

/** How to read and write the target of an assignment once its receiver and index are evaluated. */
interface AssignableTarget {
  /** The type values written must have. */
  writeType: DartType;
  /** The type reading the target gives, for compound assignments. */
  readType: DartType | undefined;
  /** Evaluates the receiver and index and appends them to the temporary roots. */
  prepare: (frame: Frame) => unknown;
  read: (frame: Frame, prepared: unknown) => Value;
  write: (frame: Frame, prepared: unknown, value: Value) => void;
  /** The local a write assigns, for flow analysis. */
  variable?: LocalVar;
  /** Whether a null-aware access may skip the assignment. */
  shorting: boolean;
}

export abstract class AssignmentCompiler extends ControlCompiler {
  protected compileExistingForInBinding(
    binding: Extract<ForInBinding, { kind: 'identifier' }>,
    elementType: DartType,
    row: number | undefined
  ): (frame: Frame, value: Value) => void {
    const target = this.nameTarget(binding.name, binding, true);
    if (target.variable?.options.isFinal) {
      this.error(binding, `final の変数 ${binding.name} には代入できません。`);
    }
    const item: Compiled = { type: elementType, run: (frame) => frame.temporaries.at(-1), isConst: false };
    const coerced = this.coerce(
      item,
      target.writeType,
      binding,
      (from, to) => `${from} 型の要素は、${to} 型の変数 ${binding.name} に代入できません。`
    );
    this.afterWrite(target.variable, coerced.type);
    const answered = isAnsweredType(target.writeType);
    return (frame, value) => {
      const mark = frame.temporaries.length;
      frame.temporaries.push(value);
      try {
        const prepared = target.prepare(frame);
        frame.temporaries.push(value);
        target.write(frame, prepared, coerced.run(frame));
      } finally {
        frame.temporaries.length = mark;
      }
      frame.runtime.steps.stepBinding(row, answered);
    };
  }

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

  // code-gauge-allow functionCognitiveComplexity 23 -- Simple, compound, and null-aware assignments.
  // code-gauge-allow functionNcss 56 -- Simple, compound, and null-aware assignments.
  private assignTo(target: AssignableTarget, operator: string, valueSyntax: Expression, span: Span): Compiled {
    const { read, write, variable, writeType } = target;
    if (operator === '=') {
      let value = this.compileExpression(valueSyntax, writeType);
      if (value.type.kind === 'void') this.error(valueSyntax, 'void の値は代入できません。');
      value = this.coerce(
        value,
        writeType,
        valueSyntax,
        (from, to) => `${from} 型の値は、${to} 型の${variable ? `変数 ${variable.name} ` : '代入先'}に代入できません。`
      );
      this.afterWrite(variable, value.type);
      const run = value.run;
      return {
        type: value.type,
        run: withPrepared(target, (frame, prepared) => {
          const result = run(frame);
          write(frame, prepared, result);
          return result;
        }),
        isConst: false,
        variable: undefined,
        creates: value.creates,
      };
    }
    const { readType } = target;
    if (!readType) return this.error(span, '複合代入には、値を読み取れる代入先が必要です。');
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
        run: withPrepared(target, (frame, prepared) => {
          const existing = read(frame, prepared);
          if (existing !== undefined) return existing;
          const result = run(frame);
          write(frame, prepared, result);
          return result;
        }),
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
      run: withPrepared(target, (frame, prepared) => {
        frame.temporaries.push(read(frame, prepared));
        let result: Value;
        try {
          result = run(frame);
        } finally {
          frame.temporaries.pop();
        }
        write(frame, prepared, result);
        return result;
      }),
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
    const { readType } = target;
    if (!readType) return this.error(span, '増減演算には、値を読み取れる代入先が必要です。');
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
    const { read, write } = target;
    const numeric = numericClassOf(readType);
    const run = coerced.run;
    const step =
      numeric === 'int' ? (value: Value): Value => wrap((value as bigint) + (operator === '+' ? 1n : -1n)) : undefined;
    return {
      type: isPrefix ? coerced.type : readType,
      run: withPrepared(target, (frame, prepared) => {
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
        frame.temporaries.push(before);
        write(frame, prepared, after);
        return isPrefix ? after : before;
      }),
      isConst: false,
    };
  }

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

  // code-gauge-allow duplicateLines 29 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionNcss 31 -- Locals, members of this, statics, and globals.
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Each branch is one of the cases Dart distinguishes for this construct.
  private localTarget(variable: LocalVar, span: Span, isPlainAssignment: boolean): AssignableTarget {
    const { options, name } = variable;
    if (variable.unavailable) this.error(span, variable.unavailable);
    if (variable.inPatternGuard) this.error(span, `パターン変数 ${name} には、when の中で代入できません。`);
    if (options.isConst) this.error(span, `const の変数 ${name} には代入できません。`);
    if (options.isFinal && options.isLate && (options.hasInitializer || this.flow.assigned.has(variable))) {
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
      read: (frame) => this.readLocalValue(frame, cell(frame), name),
      write: isLateFinal
        ? (frame, _prepared, value) => {
            const target = cell(frame);
            if (target.v !== UNINITIALIZED)
              frame.runtime.throwError('LateError', '', [`Local '${name}' has already been initialized.`]);
            target.v = value;
          }
        : (frame, _prepared, value) => {
            cell(frame).v = value;
          },
      variable,
      shorting: false,
    };
  }

  // code-gauge-allow duplicateLines 24 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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
          frame.runtime.throwError('LateError', '', [`Field '${global.name}' has already been initialized.`]);
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
    const prepare = preparingReceiver(receiver.run, nullAware);
    if (receiverType.kind === 'dynamic') {
      return {
        writeType: DYNAMIC,
        readType: DYNAMIC,
        prepare,
        read: (frame, prepared) => frame.runtime.getProperty(prepared as Value, name, span.row),
        write: (frame, prepared, value) => frame.runtime.setProperty(prepared as Value, name, value, span.row, true),
        shorting: true,
      };
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const setter = this.lookupMember(lookupType, name, true);
    if (!setter) {
      this.checkUnavailableIoMember(lookupType, name, span);
      const getter = this.lookupMember(lookupType, name, false);
      if (getter) return this.error(span, `${name} は final か getter だけなので、代入できません。`);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメンバーがありません。`);
    }
    if (!nullAware && isNullable(receiverType)) {
      this.error(span, `${typeName(receiverType)} 型の値は null かもしれないので、${name} に直接は代入できません。`);
    }
    const getter = this.lookupMember(lookupType, name, false);
    const target = { writeType: setter.type, readType: getter?.type, prepare, shorting: nullAware || shorting };
    if (setter.extension) return { ...target, ...extensionAccessors(setter, getter, span.row) };
    const isSuper = (receiver as { isSuper?: boolean }).isSuper === true;
    if (isSuper) return { ...target, ...superAccessors(this.superclassOf(span).classAt, name, span.row) };
    return {
      ...target,
      read: (frame, prepared) => frame.runtime.getProperty(prepared as Value, name, span.row),
      write: (frame, prepared, value) => frame.runtime.setProperty(prepared as Value, name, value, span.row),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 34 -- One case per form of the construct, which reads best together.
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
        const key = indexRun(frame);
        frame.temporaries.push(key);
        return [value, key];
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

  compileCollectionElements(
    elements: CollectionElement[],
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined
  ): {
    types: ElementTypes[];
    run: (frame: Frame, add: AddElement) => void;
    isConst: boolean;
    creates: boolean;
  } {
    const types: ElementTypes[] = [];
    let isConst = true;
    // A literal of objects being created counts as creating them, as Java's array initializers do.
    let creates = elements.length > 0;
    const runs: ((frame: Frame, add: AddElement) => void)[] = [];
    for (const element of elements) {
      const compiled = this.compileCollectionElement(element, kind, elementContext, valueContext, types);
      runs.push(compiled.run);
      isConst &&= compiled.isConst;
      creates &&= compiled.creates;
    }
    return {
      types,
      run: (frame, add) => {
        for (const run of runs) run(frame, add);
      },
      isConst,
      creates,
    };
  }

  /** One element of a collection literal; only plain elements that create objects count as creating them. */
  private compileCollectionElement(
    element: CollectionElement,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean; creates: boolean } {
    switch (element.kind) {
      case 'mapEntry': {
        return { ...this.compileMapEntryElement(element, kind, elementContext, valueContext, types), creates: false };
      }
      case 'spread': {
        return { ...this.compileSpread(element, kind, elementContext, valueContext, types), creates: false };
      }
      case 'nullAwareElement': {
        return { ...this.compileNullAwareElement(element, kind, elementContext, types), creates: false };
      }
      case 'ifElement': {
        return {
          run: this.compileIfElement(element, kind, elementContext, valueContext, types),
          isConst: false,
          creates: false,
        };
      }
      case 'forElement':
      case 'forInElement': {
        return {
          run: this.compileForElement(element, kind, elementContext, valueContext, types),
          isConst: false,
          creates: false,
        };
      }
      default: {
        if (kind === 'map') this.error(element, 'マップのリテラルには、キーと値の組を書いてください。');
        const compiled = this.coerceElement(
          this.compileExpression(element, elementContext),
          elementContext,
          element,
          kind
        );
        types.push({ key: compiled.type });
        const { run } = compiled;
        return { run: (frame, add) => add(run(frame)), isConst: compiled.isConst, creates: compiled.creates === true };
      }
    }
  }

  private coerceElement(
    compiled: Compiled,
    target: DartType | undefined,
    span: Span,
    kind: 'list' | 'set' | 'map'
  ): Compiled {
    if (!target || target.kind === 'dynamic') return compiled;
    const elementName = collectionName(kind);
    if (compiled.type.kind === 'void') this.error(span, `void の値は${elementName}に入れられません。`);
    return this.coerce(
      compiled,
      target,
      span,
      (from, to) => `${from} 型の値は、${to} 型の${elementName}の要素にできません。`
    );
  }

  private compileMapEntryElement(
    element: Extract<CollectionElement, { kind: 'mapEntry' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean } {
    if (kind !== 'map') this.error(element, `${collectionName(kind)}のリテラルには、キーと値の組は書けません。`);
    const { nullAwareKey, nullAwareValue } = element;
    const key = this.coerceElement(
      this.compileExpression(element.key, nullAwareKey ? nullableContext(elementContext) : elementContext),
      nullAwareKey ? nullableContext(elementContext) : elementContext,
      element.key,
      kind
    );
    const value = this.coerceElement(
      this.compileExpression(element.value, nullAwareValue ? nullableContext(valueContext) : valueContext),
      nullAwareValue ? nullableContext(valueContext) : valueContext,
      element.value,
      kind
    );
    types.push({
      key: nullAwareKey ? nonNullable(key.type) : key.type,
      value: nullAwareValue ? nonNullable(value.type) : value.type,
    });
    const keyRun = key.run;
    const valueRun = value.run;
    return {
      run: (frame, add) => {
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
      },
      isConst: key.isConst && value.isConst,
    };
  }

  private compileNullAwareElement(
    element: Extract<CollectionElement, { kind: 'nullAwareElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    types: ElementTypes[]
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean } {
    if (kind === 'map') this.error(element, 'マップのリテラルには、キーと値の組を書いてください。');
    const context = nullableContext(elementContext);
    const compiled = this.coerceElement(this.compileExpression(element.value, context), context, element, kind);
    types.push({ key: nonNullable(compiled.type) });
    const { run } = compiled;
    return {
      run: (frame, add) => {
        const value = run(frame);
        if (value !== undefined) add(value);
      },
      isConst: compiled.isConst,
    };
  }

  private compileSpread(
    element: Extract<CollectionElement, { kind: 'spread' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean } {
    // Without a context of its own, the spread value is inferred alone, as `[...[1], ...[2.0]]` makes List<num>.
    const hasContext =
      kind === 'map' ? elementContext !== undefined || valueContext !== undefined : elementContext !== undefined;
    const contextType = !hasContext
      ? undefined
      : kind === 'map'
        ? interfaceType(coreTypes.map, [elementContext ?? DYNAMIC, valueContext ?? DYNAMIC])
        : interfaceType(coreTypes.iterable, [elementContext ?? DYNAMIC]);
    const compiled = this.compileExpression(
      element.value,
      contextType && element.nullAware ? makeNullable(contextType) : contextType
    );
    if (!element.nullAware && isNullable(compiled.type) && compiled.type.kind !== 'dynamic') {
      this.error(
        element,
        `${typeName(compiled.type)} 型の値は null かもしれないので、... では展開できません。...? を使ってください。`
      );
    }
    // A spread of a constant is constant, as `const b = {...a}` with a constant `a`.
    const run =
      kind === 'map'
        ? this.compileMapSpread(element, compiled, elementContext, valueContext, types)
        : this.compileIterableSpread(element, compiled, elementContext, types);
    return { run, isConst: compiled.isConst };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Validate both map type arguments before configuring the spread.
  private compileMapSpread(
    element: Extract<CollectionElement, { kind: 'spread' }>,
    compiled: Compiled,
    keyContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
    const base = element.nullAware ? nonNullable(compiled.type) : compiled.type;
    const resolved = resolveBound(base);
    const instance =
      resolved.kind === 'interface' ? asInstanceOf({ ...resolved, nullable: false }, coreTypes.map) : undefined;
    const spreadsNull = base.kind === 'null' || base.kind === 'never';
    if (!instance && base.kind !== 'dynamic' && !spreadsNull)
      this.error(element, `${typeName(compiled.type)} 型の値は Map ではないので、マップの中では展開できません。`);
    const [keyType, valueType] = instance?.args ?? [DYNAMIC, DYNAMIC];
    if (!spreadsNull && keyContext && keyType.kind !== 'dynamic' && !isSubtype(keyType, keyContext))
      this.error(element, `${typeName(keyType)} 型のキーは、${typeName(keyContext)} 型のマップに入れられません。`);
    if (!spreadsNull && valueContext && valueType.kind !== 'dynamic' && !isSubtype(valueType, valueContext))
      this.error(element, `${typeName(valueType)} 型の値は、${typeName(valueContext)} 型のマップに入れられません。`);
    if (!spreadsNull) types.push({ key: keyType, value: valueType });
    const mapType = interfaceType(coreTypes.map, [DYNAMIC, DYNAMIC]);
    const run =
      base.kind === 'dynamic'
        ? this.runtimeCast(compiled.run, element.nullAware ? makeNullable(mapType) : mapType, false)
        : compiled.run;
    const { nullAware } = element;
    return (frame, add) => {
      const map = run(frame);
      if (nullAware && map === undefined) return;
      // The VM adds a spread map by the literal's `addAll`.
      frame.runtime.links.addAllToMap(frame.runtime, add.target as DartObject, map);
    };
  }

  private compileIterableSpread(
    element: Extract<CollectionElement, { kind: 'spread' }>,
    compiled: Compiled,
    elementContext: DartType | undefined,
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
    const base = element.nullAware ? nonNullable(compiled.type) : compiled.type;
    // `...?null` adds nothing, so it constrains nothing.
    const spreadsNull = base.kind === 'null' || base.kind === 'never';
    const elementType = spreadsNull ? NEVER : iterableElementOf(base);
    if (!elementType)
      this.error(element, `${typeName(compiled.type)} 型の値は Iterable ではないので、展開できません。`);
    if (elementContext && elementType.kind !== 'dynamic' && !isSubtype(elementType, elementContext)) {
      this.error(element, `${typeName(elementType)} 型の要素は、${typeName(elementContext)} 型の要素にできません。`);
    }
    if (!spreadsNull) types.push({ key: elementType });
    const castElements =
      elementType.kind === 'dynamic' && elementContext && elementContext.kind !== 'dynamic'
        ? this.runtimeCast((frame) => frame.temporaries.at(-1), elementContext, false)
        : undefined;
    const { run } = compiled;
    const { nullAware } = element;
    return (frame, add) => {
      const iterable = run(frame);
      if (nullAware && iterable === undefined) return;
      addIterableElements(frame, iterable, castElements, add);
    };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 40 -- One case per form of the construct, which reads best together.
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
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
    const before = this.flow;
    const { result, slots } = this.withScope(() =>
      element.kind === 'forInElement'
        ? this.compileForInElement(element, kind, elementContext, valueContext, types)
        : this.compileCountedForElement(element, kind, elementContext, valueContext, types)
    );
    this.flow = before;
    return (frame, add) => {
      try {
        result(frame, add);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileForInElement(
    element: Extract<CollectionElement, { kind: 'forInElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
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
    return (frame, add) => {
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

  private compileCountedForElement(
    element: Extract<CollectionElement, { kind: 'forElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
    const { initRun, loopSlots } = this.compileForElementInit(element);
    this.enterLoop(element);
    const condition = element.condition ? this.compileCondition(element.condition) : undefined;
    if (condition) this.flow = condition.flow.whenTrue;
    const body = this.compileCollectionElements([element.body], kind, elementContext, valueContext);
    types.push(...body.types);
    const updates = element.updates.map((update) => this.compileExpression(update).run);
    const test = condition?.compiled.run;
    return (frame, add) => {
      initRun?.(frame);
      while (!test || test(frame)) {
        body.run(frame, add);
        // Each iteration has its own loop variables, which closures created in the body keep.
        for (const slot of loopSlots) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
        for (const update of updates) update(frame);
        frame.runtime.spend();
      }
    };
  }

  private compileForElementInit(element: Extract<CollectionElement, { kind: 'forElement' }>): {
    initRun: ((frame: Frame) => void) | undefined;
    loopSlots: number[];
  } {
    const { init } = element;
    const loopSlots: number[] = [];
    if (init && !Array.isArray(init)) {
      const before = new Set(this.fn.scopes.at(-1)?.values());
      const exec = this.compileLocalDeclaration(init, false);
      for (const variable of this.fn.scopes.at(-1)?.values() ?? [])
        if (!before.has(variable)) loopSlots.push(variable.slot);
      return { initRun: (frame) => void exec(frame), loopSlots };
    }
    if (!init) return { initRun: undefined, loopSlots };
    const runs = init.map((expression) => this.compileExpression(expression).run);
    return {
      initRun: (frame) => {
        for (const run of runs) run(frame);
      },
      loopSlots,
    };
  }

  // code-gauge-allow duplicateLines 18 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  protected buildSet(type: DartType, run: (frame: Frame, add: AddElement) => void, isConst: boolean): Compiled {
    const elementType = (type as InterfaceType).args[0];
    const resolve = this.runtimeType(elementType);
    const build: Eval = (frame) => {
      const set = frame.runtime.links.newSet(frame.runtime, resolve(frame), isConst);
      frame.temporaries.push(set);
      try {
        const store = set.native as HashStore;
        run(
          frame,
          Object.assign((key: Value) => store.set(key, undefined), { target: set })
        );
      } finally {
        frame.temporaries.pop();
      }
      return set;
    };
    return { type, run: isConst ? this.canonicalized(build) : build, isConst };
  }

  // code-gauge-allow duplicateLines 18 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  protected buildMap(type: DartType, run: (frame: Frame, add: AddElement) => void, isConst: boolean): Compiled {
    const [keyType, valueType] = (type as InterfaceType).args;
    const resolveKey = this.runtimeType(keyType);
    const resolveValue = this.runtimeType(valueType);
    const build: Eval = (frame) => {
      const map = frame.runtime.links.newMap(frame.runtime, resolveKey(frame), resolveValue(frame), isConst);
      frame.temporaries.push(map);
      try {
        const store = map.native as HashStore;
        run(
          frame,
          Object.assign((key: Value, value?: Value) => store.set(key, value), { target: map })
        );
      } finally {
        frame.temporaries.pop();
      }
      return map;
    };
    return { type, run: isConst ? this.canonicalized(build) : build, isConst };
  }

  // Switch expressions

  // code-gauge-allow functionCognitiveComplexity 24 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 39 -- One case per form of the construct, which reads best together.
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
}

export type { Member };

function withPrepared(target: AssignableTarget, action: (frame: Frame, prepared: unknown) => Value): Eval {
  return (frame) => {
    const count = frame.temporaries.length;
    try {
      const prepared = target.prepare(frame);
      return prepared === SHORTED ? SHORTED : action(frame, prepared);
    } finally {
      frame.temporaries.length = count;
    }
  };
}

/** Evaluates a target's receiver, giving SHORTED where a null-aware access short-circuits. */
function preparingReceiver(run: Eval, nullAware: boolean): AssignableTarget['prepare'] {
  return (frame) => {
    const value = run(frame);
    if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
    frame.temporaries.push(value);
    return value;
  };
}

/** The accessors of an extension's setter and getter, which run on the receiver without dispatch. */
function extensionAccessors(
  setter: ResolvedMember,
  getter: ResolvedMember | undefined,
  row: number
): Pick<AssignableTarget, 'read' | 'write'> {
  const setterMember = setter.member;
  const getterMember = getter?.member;
  const typeArgs = setter.extension?.typeArgs ?? [];
  return {
    read: (frame, prepared) =>
      (getterMember?.impl as unknown as Callable | undefined)?.(
        frame.runtime,
        prepared as Value,
        { positional: [], named: undefined },
        typeArgs,
        row
      ),
    write: (frame, prepared, value) => {
      (setterMember.impl as unknown as Callable)(
        frame.runtime,
        prepared as Value,
        { positional: [value], named: undefined },
        typeArgs,
        row
      );
    },
  };
}

/** The accessors of `super.x`, which use the superclass's implementation of the member. */
function superAccessors(
  superclassAt: (frame: Frame) => ClassInfo,
  name: string,
  row: number
): Pick<AssignableTarget, 'read' | 'write'> {
  return {
    read: (frame, prepared) => {
      const member = superclassAt(frame).implementation(name);
      return member ? frame.runtime.readMember(prepared as Value, member, row) : undefined;
    },
    write: (frame, prepared, value) => {
      const member = superclassAt(frame).setterImplementation(name);
      if (member?.kind === 'field') (prepared as DartObject).fields[member.slot] = value;
      else if (member)
        (member.impl as Callable)(frame.runtime, prepared as Value, { positional: [value], named: undefined }, [], row);
    },
  };
}

interface ElementTypes {
  key: DartType;
  value?: DartType;
}
/** Adds an element to a collection literal being built; a set or map literal names itself as the target. */
type AddElement = ((key: Value, value?: Value) => void) & { target?: DartObject };

function collectionName(kind: 'list' | 'set' | 'map'): string {
  return kind === 'list' ? 'リスト' : kind === 'set' ? 'セット' : 'マップ';
}

function nullableContext(context: DartType | undefined): DartType | undefined {
  return context ? makeNullable(context) : undefined;
}

function addIterableElements(frame: Frame, iterable: Value, castElements: Eval | undefined, add: AddElement): void {
  const { runtime } = frame;
  if (!castElements) {
    // A set literal adds a spread set by `addAll`, which copies a plain set's table into an empty literal.
    if (add.target && runtime.links.quickCopySet(runtime, add.target, iterable)) return;
    if (iterable instanceof DartList) {
      for (const value of iterable.elements) add(value);
      return;
    }
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
}
