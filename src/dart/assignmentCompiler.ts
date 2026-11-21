// code-gauge-allow-file fileNcss 677 -- Assignment targets share read and write dispatch.
import type { CascadeSelector, CollectionElement, Expression, ForInBinding, Span, SwitchExpressionCase } from './ast';
import type { ClassInfo, Member } from './classes';
import { at, type Compiled, type Eval, type ResolvedMember, typeName } from './compilerBase';
import { ControlCompiler } from './controlCompiler';
import type { GlobalVariable } from './environment';
import { checkExhaustive } from './exhaustiveness';
import { ExpressionCompiler, SHORTED } from './expressionCompiler';
import type { HashStore } from './hashStore';
import { forEachValue, implicitCast } from './library/nativeSupport';
import { wrap } from './operators';
import { PatternCache } from './patternCompiler';
import type { Frame } from './runtime';
import { Flow, type LocalVar } from './scope';
import { isAnsweredType } from './statementCompiler';
import { containsInferenceHole } from './typeInference';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  type InterfaceType,
  interfaceType,
  isPotentiallyNullable,
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
import { type Callable, Cell, type DartObject, NO_ARGUMENTS, UNINITIALIZED, type Value } from './values';

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

  protected compileAssignment(expression: Extract<Expression, { kind: 'assign' }>): Compiled {
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
      target = this.indexTarget(receiver, selector.index, selector.nullAware, selector, operator === '=');
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

  protected compileIncrement(operand: Expression, operator: '+' | '-', isPrefix: boolean, span: Span): Compiled {
    const target = this.assignableTarget(operand, false);
    const { readType } = target;
    if (!readType) return this.error(span, '増減演算には、値を読み取れる代入先が必要です。');
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
        return this.qualifiedMemberTarget(expression);
      }
      case 'index': {
        const receiver =
          expression.object.kind === 'super'
            ? this.superReceiver(expression.object)
            : this.compileChainPart(expression.object, undefined);
        return this.indexTarget(receiver, expression.index, expression.nullAware, expression, isPlainAssignment);
      }
      default: {
        return this.error(expression, 'この式には代入できません。');
      }
    }
  }

  private qualifiedMemberTarget(expression: Extract<Expression, { kind: 'member' }>): AssignableTarget {
    const staticTarget = this.staticTarget(expression.object);
    if (staticTarget?.kind === 'prefix') {
      return this.prefixedTarget(staticTarget.prefix, expression.name, expression);
    }
    if (staticTarget) {
      const owner = staticTarget.kind === 'class' ? staticTarget.cls : staticTarget.ext;
      const member = owner.staticSetters.get(expression.name) ?? owner.staticMembers.get(expression.name);
      if (!member)
        return this.error(
          expression,
          `${staticTarget.kind === 'class' ? 'クラス' : '拡張'} ${owner.name ?? ''} に static なメンバー ${expression.name} がありません。`
        );
      return this.staticMemberTarget(member, expression);
    }
    if (expression.object.kind === 'super') {
      return this.memberTarget(this.superReceiver(expression.object), expression.name, false, expression);
    }
    const receiver = this.compileChainPart(expression.object, undefined);
    return this.memberTarget(receiver, expression.name, expression.nullAware, expression);
  }

  private prefixedTarget(prefix: string, name: string, span: Span): AssignableTarget {
    const declaration = this.library.lookupPrefixed(prefix, name);
    if (!declaration) return this.undefinedName(span, name, prefix);
    if (declaration.kind === 'variable') return this.globalTarget(declaration.global, span);
    return this.error(span, `${prefix}.${name} には代入できません。`);
  }

  // code-gauge-allow duplicateLines 29 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionNcss 31 -- Locals, members of this, statics, and globals.
  private nameTarget(name: string, span: Span, isPlainAssignment: boolean): AssignableTarget {
    const resolution = this.resolveName(name, span);
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
        return this.staticMemberTarget(member, span);
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
    const write = this.localWriter(variable, span, !isPlainAssignment);
    const cell = this.cellAccess(variable);
    return {
      writeType: variable.type,
      readType: this.isPromotable(variable) ? this.promotedType(variable) : variable.type,
      prepare: () => {},
      read: (frame) => this.readLocalValue(frame, cell(frame), variable.name),
      write: (frame, _prepared, value) => write(frame, value),
      variable,
    };
  }

  // code-gauge-allow duplicateLines 24 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private staticMemberTarget(member: Member, span: Span): AssignableTarget {
    this.checkUnavailableStaticMember(member.owner, member.name, span);
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
      };
    }
    return this.error(span, `${member.name} には代入できません。`);
  }

  protected globalTarget(global: GlobalVariable, span: Span): AssignableTarget {
    if (global.isConst) this.error(span, `const の ${global.name} には代入できません。`);
    if (global.isFinal && (!global.isLate || global.hasInitializer))
      this.error(span, `final の ${global.name} には代入できません。`);
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
    };
  }

  // code-gauge-allow functionNcss 31 -- Static and dynamic property targets share the prepared receiver.
  private memberTarget(receiver: Compiled, name: string, nullAware: boolean, span: Span): AssignableTarget {
    const receiverType = receiver.type;
    this.skipOnNull(receiver, nullAware);
    const prepare = preparingReceiver(receiver.run, nullAware);
    const memberName = this.runtimeMemberName(name);
    const dispatchType = this.dynamicDispatchType(receiver);
    if (dispatchType) {
      return {
        writeType: DYNAMIC,
        readType: dispatchType,
        prepare,
        read: (frame, prepared) => frame.runtime.getProperty(prepared as Value, memberName, span.row),
        write: (frame, prepared, value) =>
          frame.runtime.setProperty(prepared as Value, memberName, value, span.row, true),
      };
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const setter = this.memberFor(receiver, lookupType, name, span, true);
    if (!setter) {
      this.checkUnavailableIoMember(lookupType, name, span);
      const getter = this.memberFor(receiver, lookupType, name, span);
      if (getter) return this.error(span, `${name} は final か getter だけなので、代入できません。`);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメンバーがありません。`);
    }
    if (!this.canAccessTarget(receiverType, nullAware, setter)) {
      this.error(span, `${typeName(receiverType)} 型の値は null かもしれないので、${name} に直接は代入できません。`);
    }
    const getter = this.memberFor(receiver, lookupType, name, undefined);
    const readType = getter && this.canAccessTarget(receiverType, nullAware, getter) ? getter.type : undefined;
    const target = { writeType: setter.type, readType, prepare };
    if (receiver.isSuper) {
      this.requireSuperImplementation(name, span, true);
      return { ...target, ...superAccessors(this.superclassOf(span).classAt, memberName, span.row) };
    }
    const extensionRead = this.extensionTargetCall(getter, span.row);
    const extensionWrite = this.extensionTargetCall(setter, span.row);
    return {
      ...target,
      read: (frame, prepared) =>
        extensionRead
          ? extensionRead(frame, prepared as Value, [])
          : frame.runtime.getProperty(prepared as Value, memberName, span.row),
      write: (frame, prepared, value) => {
        if (extensionWrite) extensionWrite(frame, prepared as Value, [value]);
        else frame.runtime.setProperty(prepared as Value, memberName, value, span.row);
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Resolve static operators, then build the prepared read and write for any receiver.
  // code-gauge-allow functionNcss 46 -- Resolve static operators, then build the prepared read and write for any receiver.
  private indexTarget(
    receiver: Compiled,
    indexSyntax: Expression,
    nullAware: boolean,
    span: Span,
    isPlainAssignment: boolean
  ): AssignableTarget {
    const receiverType = receiver.type;
    this.skipOnNull(receiver, nullAware);
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    let indexContext: DartType | undefined;
    let readContext: DartType | undefined;
    let writeType: DartType = DYNAMIC;
    const dispatchType = this.dynamicDispatchType(receiver);
    let readType: DartType | undefined = dispatchType ?? DYNAMIC;
    let setter: ResolvedMember | undefined;
    let getter: ResolvedMember | undefined;
    if (!dispatchType) {
      setter = this.memberFor(receiver, lookupType, '[]=', span);
      if (!setter || setter.member.kind !== 'method')
        return this.error(span, `${typeName(nonNullable(receiverType))} 型には演算子 []= がありません。`);
      if (!this.canAccessTarget(receiverType, nullAware, setter))
        this.error(span, `${typeName(receiverType)} 型の値は null かもしれないので、[ ] に直接は代入できません。`);
      const signature = setter.type as FunctionType;
      indexContext = signature.positional[0];
      writeType = signature.positional[1] ?? DYNAMIC;
      getter = isPlainAssignment ? undefined : this.memberFor(receiver, lookupType, '[]', undefined);
      const readSignature =
        getter?.member.kind === 'method' && this.canAccessTarget(receiverType, nullAware, getter)
          ? (getter.type as FunctionType)
          : undefined;
      readType = readSignature?.returnType;
      readContext = readSignature?.positional[0];
    }
    const indexKeys = this.prepareIndexKeys(indexSyntax, indexContext, readContext);
    const receiverRun = receiver.run;
    const read = !isPlainAssignment && readType ? this.indexOperatorCall(receiver, getter, '[]', span) : undefined;
    const write = this.indexOperatorCall(receiver, setter, '[]=', span);
    return {
      writeType,
      readType,
      prepare: (frame) => {
        const value = receiverRun(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        frame.temporaries.push(value);
        return [value, ...indexKeys(frame)];
      },
      read: (frame, prepared) => {
        const [object, , key] = prepared as [Value, Value, Value];
        return read?.(frame, object, [key]);
      },
      write: (frame, prepared, value) => {
        const [object, key] = prepared as [Value, Value];
        write(frame, object, [key, value]);
      },
    };
  }

  private canAccessTarget(receiverType: DartType, nullAware: boolean, member: ResolvedMember): boolean {
    return nullAware || !isPotentiallyNullable(receiverType) || this.acceptsNull(member);
  }

  private prepareIndexKeys(
    syntax: Expression,
    writeType: DartType | undefined,
    readType: DartType | undefined
  ): (frame: Frame) => [Value, Value] {
    const index = this.compileExpression(syntax, writeType);
    if (index.type.kind === 'void') this.error(syntax, 'void の値は、添字に使えません。');
    const coerce = (value: Compiled, type: DartType | undefined): Eval =>
      type
        ? this.coerce(value, type, syntax, (from, to) => `${from} 型の値は、添字の型 ${to} に合いません。`).run
        : value.run;
    if (!readType || (writeType && sameType(writeType, readType))) {
      const run = coerce(index, writeType);
      return (frame) => {
        const key = run(frame);
        frame.temporaries.push(key);
        return [key, key];
      };
    }
    const writeKey = coerce({ ...index, run: (frame) => frame.temporaries.at(-1) }, writeType);
    const readKey = coerce({ ...index, run: (frame) => frame.temporaries.at(-2) }, readType);
    return (frame) => {
      frame.temporaries.push(index.run(frame));
      const forWrite = writeKey(frame);
      frame.temporaries.push(forWrite);
      const forRead = readKey(frame);
      frame.temporaries.push(forRead);
      return [forWrite, forRead];
    };
  }

  private indexOperatorCall(
    receiver: Compiled,
    member: ResolvedMember | undefined,
    name: '[]' | '[]=',
    span: Span
  ): (frame: Frame, receiver: Value, positional: Value[]) => Value {
    if (receiver.isSuper) {
      const call = this.superMethodTarget(name, span, span.row);
      return (frame: Frame, _receiver: Value, positional: Value[]) => call(frame, { positional, named: undefined });
    }
    const extensionCall = this.extensionTargetCall(member, span.row);
    if (extensionCall) return extensionCall;
    const invocation = receiver.type.kind === 'dynamic' ? 'dynamic' : undefined;
    return (frame: Frame, object: Value, positional: Value[]) =>
      frame.runtime.invoke(object, name, { positional, named: undefined, invocation }, [], span.row);
  }

  private extensionTargetCall(
    resolved: ResolvedMember | undefined,
    row: number
  ): ((frame: Frame, receiver: Value, args: Value[]) => Value) | undefined {
    if (!resolved?.extension) return undefined;
    const { member } = resolved;
    const typeArgs = this.runtimeTypes(resolved.extension.typeArgs);
    return (frame, receiver, args) =>
      (member.impl as Callable)(frame.runtime, receiver, { positional: args, named: undefined }, typeArgs(frame), row);
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
          ...this.compileIfElement(element, kind, elementContext, valueContext, types),
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
    if (!target) return compiled;
    // A context still waiting for a call's type arguments only guides the element, instantiating a generic function to
    // fit it, and the element's own type then constrains them.
    if (containsInferenceHole(target)) return this.instantiateGeneric(compiled, target, true) ?? compiled;
    const elementName = collectionName(kind);
    return this.coerce(
      compiled,
      target,
      span,
      (from, to) => `${from} 型の値は、${to} 型の${elementName}の要素にできません。`
    );
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Compile and run both holders of a conditional map entry in source order.
  private compileMapEntryElement(
    element: Extract<CollectionElement, { kind: 'mapEntry' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean } {
    if (kind !== 'map') this.error(element, `${collectionName(kind)}のリテラルには、キーと値の組は書けません。`);
    const { nullAwareKey, nullAwareValue } = element;
    const keyContext = nullAwareKey ? nullableContext(elementContext) : elementContext;
    const mapValueContext = nullAwareValue ? nullableContext(valueContext) : valueContext;
    const key = this.coerceElement(
      this.compileExpression(element.key, keyContext),
      keyContext ?? DYNAMIC,
      element.key,
      kind
    );
    const keyBranches = nullAwareKey ? this.nullBranches(key) : undefined;
    if (keyBranches) this.flow = keyBranches.whenNonNull;
    const compiledValue = this.compileExpression(element.value, mapValueContext);
    if (keyBranches) this.flow = Flow.join(keyBranches.whenNull, this.flow);
    const valueType = nullAwareValue && mapValueContext?.kind === 'void' ? DYNAMIC : (mapValueContext ?? DYNAMIC);
    const value = this.coerceElement(compiledValue, valueType, element.value, kind);
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
    if (!element.nullAware && isPotentiallyNullable(compiled.type) && compiled.type.kind !== 'dynamic') {
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
    if (!spreadsNull && keyContext && !fitsContext(keyType, keyContext))
      this.error(element, `${typeName(keyType)} 型のキーは、${typeName(keyContext)} 型のマップに入れられません。`);
    if (!spreadsNull && valueContext && !fitsContext(valueType, valueContext))
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
      // The VM adds a spread map by the literal's `addAll`, whose hashing may run learner code while the map is unnamed.
      frame.runtime.withCallRoots(map, NO_ARGUMENTS, () =>
        frame.runtime.links.addAllToMap(frame.runtime, add.target as DartObject, map)
      );
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
    if (elementContext && !fitsContext(elementType, elementContext)) {
      this.error(element, `${typeName(elementType)} 型の要素は、${typeName(elementContext)} 型の要素にできません。`);
    }
    if (!spreadsNull) types.push({ key: elementType });
    const resolveElement =
      elementType.kind === 'dynamic' && elementContext && elementContext.kind !== 'dynamic'
        ? this.runtimeType(elementContext)
        : undefined;
    const { nullAware } = element;
    const run = this.iterableSource(compiled, nullAware);
    return (frame, add) => {
      const iterable = run(frame);
      if (nullAware && iterable === undefined) return;
      addIterableElements(frame, iterable, resolveElement?.(frame), add);
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
  ): { run: (frame: Frame, add: AddElement) => void; isConst: boolean } {
    if (element.casePattern) {
      const subject = this.compileExpression(element.condition);
      const casePattern = element.casePattern;
      const { result, slots } = this.withScope(() => {
        const { pattern, guard, whenFalse } = this.compileCasePattern(casePattern.pattern, subject, casePattern.guard);
        const body = this.compileCollectionElements([element.consequent], kind, elementContext, valueContext);
        return { pattern, guard, whenFalse, afterThen: this.flow, body };
      });
      this.flow = result.whenFalse;
      const otherwise = element.alternative
        ? this.compileCollectionElements([element.alternative], kind, elementContext, valueContext)
        : undefined;
      this.flow = Flow.join(result.afterThen, this.flow);
      types.push(...result.body.types, ...(otherwise?.types ?? []));
      const test = subject.run;
      return {
        isConst: false,
        run: (frame, add) => {
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
        },
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
    return {
      isConst: condition.isConst && consequent.isConst && (otherwise?.isConst ?? true),
      run: (frame, add) => {
        if (test(frame)) consequent.run(frame, add);
        else otherwise?.run(frame, add);
      },
    };
  }

  private compileForElement(
    element: Extract<CollectionElement, { kind: 'forElement' | 'forInElement' }>,
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined,
    types: ElementTypes[]
  ): (frame: Frame, add: AddElement) => void {
    const { result, slots } = this.withScope(() =>
      element.kind === 'forInElement'
        ? this.compileForInElement(element, kind, elementContext, valueContext, types)
        : this.compileCountedForElement(element, kind, elementContext, valueContext, types)
    );
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
    const afterSource = this.flow;
    const savedRecords = this.recordsSteps;
    this.recordsSteps = false;
    const bind = this.compileForInBinding(element.binding, elementType, element);
    this.recordsSteps = savedRecords;
    const body = this.compileCollectionElements([element.body], kind, elementContext, valueContext);
    types.push(...body.types);
    this.finishLoop(afterSource);
    const source = this.iterableSource(iterable);
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
    const { initExec, loopSlots } = this.compileForInit(element);
    this.enterLoop(element);
    const condition = element.condition ? this.compileCondition(element.condition) : undefined;
    const afterLoop = condition?.flow.whenFalse ?? this.flow.unreachable;
    if (condition) this.flow = condition.flow.whenTrue;
    const body = this.compileCollectionElements([element.body], kind, elementContext, valueContext);
    types.push(...body.types);
    const updates = element.updates.map((update) => this.compileExpression(update).run);
    const test = condition?.compiled.run;
    this.finishLoop(afterLoop);
    return (frame, add) => {
      initExec?.(frame);
      while (!test || test(frame)) {
        body.run(frame, add);
        // Each iteration has its own loop variables, which closures created in the body keep.
        for (const slot of loopSlots) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
        for (const update of updates) update(frame);
        frame.runtime.spend();
      }
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
    const patternSubject = this.switchSubject(subject, cases);
    let whenFalse = before;
    let after: Flow | undefined;
    let resultType: DartType | undefined;
    const compiledCases = cases.map((switchCase) => {
      this.flow = whenFalse;
      const { result, slots } = this.withScope(() => {
        const {
          pattern,
          guard,
          whenFalse: unmatched,
        } = this.compileCasePattern(switchCase.pattern, patternSubject, switchCase.guard);
        whenFalse = unmatched;
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
      run: (frame) =>
        PatternCache.run(frame, (cache) => {
          const value = test(frame);
          frame.temporaries.push(value);
          try {
            for (const switchCase of compiledCases) {
              try {
                if (
                  switchCase.pattern.match(frame, value, cache) &&
                  (!switchCase.guard || switchCase.guard(frame) === true)
                ) {
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
        }),
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

/** The accessors of `super.x`, which use the superclass's implementation of the member. */
function superAccessors(
  superclassAt: (frame: Frame) => ClassInfo,
  name: string,
  row: number
): Pick<AssignableTarget, 'read' | 'write'> {
  return {
    read: (frame, prepared) => {
      const member = frame.runtime.instanceMember(superclassAt(frame), name);
      return member ? frame.runtime.readMember(prepared as Value, member, row) : undefined;
    },
    write: (frame, prepared, value) => {
      const member = frame.runtime.instanceMember(superclassAt(frame), name, true);
      if (member?.kind === 'field') {
        const object = prepared as DartObject;
        frame.runtime.checkFieldWrite(object, member, value);
        object.fields[member.slot] = value;
      } else if (member)
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

function addIterableElements(frame: Frame, iterable: Value, elementType: DartType | undefined, add: AddElement): void {
  const { runtime } = frame;
  if (elementType === undefined && add.target && runtime.links.quickCopySet(runtime, add.target, iterable)) return;
  runtime.withCallRoots(iterable, NO_ARGUMENTS, () =>
    forEachValue(runtime, iterable, (value) => {
      if (elementType) implicitCast(runtime, value, elementType);
      add(value);
    })
  );
}

/**
 * Whether a spread's element type fits a collection's context. A context still waiting for a call's type arguments
 * only guides the elements, whose own types then constrain those arguments.
 */
function fitsContext(type: DartType, context: DartType): boolean {
  return containsInferenceHole(context) || type.kind === 'dynamic' || isSubtype(type, context);
}
