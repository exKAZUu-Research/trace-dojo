// code-gauge-allow-file fileNcss 999 -- expression compilation shares name resolution, call dispatch, and type inference.
import type { Block, Expression, LambdaExpression } from './ast';
import {
  type ArgumentSyntax,
  CallCompiler,
  type Candidate,
  type DelegateContext,
  type ResolvedCall,
} from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  type Flow,
  FunctionContext,
  nullableReceiverMessage,
  type PackageScope,
  ReceiverSymbol,
  type Repr,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import type { MemberRef } from './compilerCore';
import { getPropertyValue, propertyRepr, receiverRepr } from './dispatch';
import { keyOf } from './flowKeys';
import { stableLocal } from './flowWrites';
import { formatPrimitive, stringOf } from './format';
import { unavailableLibraryMember, unavailableQualifiedLibraryMember } from './libraryApi';
import { literalFits } from './literals';
import { floatRangeBounds } from './rangeBounds';
import { type Frame, type FunctionInfo, KotlinThrow, LoopSignal, ReturnSignal } from './runtime';
import {
  type ClassSymbol,
  type FunctionSymbol,
  type PropertySymbol,
  type TypeParameterSymbol,
  VariableSymbol,
} from './symbols';
import { anyType, commonSupertype, fixVariable, isSubtype, lambdaResultHint } from './typeRelations';
import {
  type ClassType,
  classType,
  type FunctionType,
  isNullable,
  type KType,
  nonNull,
  NOTHING,
  NULL_TYPE,
  nullable,
  resolved,
  substitute,
  typeToString,
} from './types';
import { box, Boxed, KObject, NULL, type PrimitiveKind, UNIT, type Value } from './values';

/** A place to store a value, with its receiver and indexes evaluated. */
export interface BoundPlace {
  get(): Value;
  set(value: Value): void;
  /** For `a?.b = c` with a null `a`, which skips the assignment and the evaluation of `c`. */
  isSkipped?: true;
}

const SKIPPED_PLACE: BoundPlace = { get: () => NULL, set: () => {}, isSkipped: true };

export interface Place {
  type: KType;
  readType?: KType;
  repr: Repr;
  bind: (frame: Frame) => BoundPlace;
  recordAssignment?: () => void;
}

export abstract class ExpressionCompiler extends CallCompiler {
  protected compileDelegateExpression(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    type: KType | undefined,
    isVar: boolean
  ): Compiled {
    let delegate = expression;
    while (delegate.kind === 'parenthesized') delegate = delegate.expression;
    if (!type || delegate.kind !== 'call') return this.compileExpression(scope, context, expression);
    const compiled = this.compileCall(scope, context, delegate, undefined, { type, isVar });
    return delegate === expression ? compiled : { ...compiled, isCall: false, isCreation: false };
  }

  /** Compiles a block, whose last expression gives its value, or `Unit` when it has none. */
  abstract compileBlockValue(
    scope: Scope,
    context: FunctionContext,
    block: Block,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled;

  /** Makes sure a property without a declared type has its type inferred from its initializer. */
  protected abstract ensurePropertyType(property: PropertySymbol, row: number): KType;

  /**
   * While a class's initializer compiles, the properties whose initializers come later, which kotlinc does not let it
   * read by their simple names.
   */
  protected uninitializedProperties: { context: FunctionContext; properties: Set<PropertySymbol> } | undefined;

  protected checkInitialized(context: FunctionContext, property: PropertySymbol, name: string, row: number): void {
    const pending = this.uninitializedProperties;
    if (pending?.context !== context) return;
    const awaitsAssignment =
      !property.isLateinit && this.mayInitializeVal(context, property) && !this.flow.assigned.has(property);
    if (awaitsAssignment || pending.properties.has(property))
      this.error(row, `プロパティ ${name} には、まだ値が入っていません。`);
  }

  protected abstract mayInitializeVal(context: FunctionContext, symbol: PropertySymbol): boolean;

  /** The instance of an object or companion object, created on first use. */
  protected abstract objectInstance(cls: ClassSymbol): (frame: Frame) => Value;

  protected primitiveOf(type: KType): PrimitiveKind | undefined {
    const actual = resolved(type);
    if (actual.kind !== 'class' || actual.nullable) return undefined;
    return this.core.primitives.get(actual.cls);
  }

  protected isClass(type: KType, cls: ClassSymbol): boolean {
    const actual = resolved(type);
    return actual.kind === 'class' && actual.cls === cls;
  }

  protected typeOfClass(cls: ClassSymbol, nullableType = false): ClassType {
    return classType(cls, [], nullableType);
  }

  protected get unitType(): ClassType {
    return this.core.unit.type;
  }

  protected get stringType(): ClassType {
    return this.core.string.type;
  }

  protected get booleanType(): ClassType {
    return this.core.boolean.type;
  }

  protected primitiveType(kind: PrimitiveKind): ClassType {
    return this.core.primitiveClasses[kind].type;
  }

  protected unitValue(eval_: Eval): Compiled {
    return {
      type: this.unitType,
      repr: 'ref',
      eval: (frame) => {
        eval_(frame);
        return UNIT;
      },
    };
  }

  /** Converts an expression's value to a type the checker accepted it for. */
  convertTo(compiled: Compiled, type: KType, _row: number): Eval {
    const target = resolved(type);
    const literal = compiled.integerLiteral;
    if (literal && target.kind === 'class') {
      const kind = this.core.primitives.get(target.cls);
      if (kind && kind !== this.primitiveOf(compiled.type) && literalFits(literal, kind)) {
        const value = kind === 'Long' || kind === 'ULong' ? literal.value : Number(literal.value);
        const constant = target.nullable ? box(kind, value) : value;
        return () => constant;
      }
    }
    return convertRepr(compiled.eval, compiled.repr, reprOf(this.core, target));
  }

  protected reprConvert(eval_: Eval, from: Repr, to: Repr): Eval {
    return convertRepr(eval_, from, to);
  }

  /** Checks that an expression's value may be used where `type` is expected, and converts it. */
  protected expectType(compiled: Compiled, type: KType, row: number): Eval {
    if (!this.acceptsArgument(compiled, type)) {
      if (
        isNullable(resolved(compiled.type)) &&
        this.acceptsArgument({ ...compiled, type: nonNull(compiled.type) }, type)
      ) {
        this.error(row, `null かもしれない値は、${typeToString(resolved(type))} には使えません。`);
      }
      this.error(row, typeMismatchMessage(type, compiled.type));
    }
    return this.convertTo(compiled, type, row);
  }

  /** Compiles an expression whose value is needed. */
  compileExpression(scope: Scope, context: FunctionContext, expression: Expression, expected?: KType): Compiled {
    return this.compileAny(scope, context, expression, expected, false);
  }

  /** Compiles an expression whose value is thrown away, where `if` and `when` need no `else`. */
  compileForEffect(scope: Scope, context: FunctionContext, expression: Expression): Compiled {
    return this.compileAny(scope, context, expression, undefined, true);
  }

  // code-gauge-allow functionNcss 42 -- one case per kind of expression.
  protected compileAny(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    switch (expression.kind) {
      case 'integer': {
        return this.compileInteger(expression, expected);
      }
      case 'real': {
        const type = this.primitiveType(expression.isFloat ? 'Float' : 'Double');
        const { value } = expression;
        return { type, repr: expression.isFloat ? 'Float' : 'Double', eval: () => value, constant: value };
      }
      case 'char': {
        const { value } = expression;
        return { type: this.primitiveType('Char'), repr: 'Char', eval: () => value, constant: value };
      }
      case 'boolean': {
        const { value } = expression;
        return { type: this.booleanType, repr: 'ref', eval: () => value, constant: value };
      }
      case 'null': {
        return { type: NULL_TYPE, repr: 'ref', eval: () => {}, constant: undefined };
      }
      case 'string': {
        return this.compileString(scope, context, expression);
      }
      case 'parenthesized': {
        const inner = this.compileAny(scope, context, expression.expression, expected, asStatement);
        return { ...inner, isCall: false, isCreation: false };
      }
      case 'name': {
        return this.compileName(scope, context, expression.name, expression.row);
      }
      case 'this': {
        return this.compileThis(scope, context, expression.row, expression.label);
      }
      case 'super': {
        return this.error(expression.row, 'super は、super.メンバー の形で使ってください。');
      }
      case 'member': {
        return this.compileMemberAccess(scope, context, expression);
      }
      case 'call': {
        return this.isLongConstant(expression, expected)
          ? this.toLongConstant(this.compileCall(scope, context, expression, undefined))
          : this.compileCall(scope, context, expression, expected);
      }
      case 'prefix':
      case 'postfix':
      case 'binary':
      case 'infix':
      case 'in':
      case 'is':
      case 'as':
      case 'index': {
        return this.compileOperatorExpression(scope, context, expression, expected);
      }
      default: {
        return this.compileControl(scope, context, expression, expected, asStatement);
      }
    }
  }

  /** Operators, indexes, and the `in`, `is`, and `as` tests. */
  private compileOperatorExpression(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'index' | 'prefix' | 'postfix' | 'binary' | 'infix' | 'in' | 'is' | 'as' }>,
    expected: KType | undefined
  ): Compiled {
    switch (expression.kind) {
      case 'index': {
        return this.compileIndex(scope, context, expression);
      }
      case 'prefix': {
        return this.compilePrefix(scope, context, expression, expected);
      }
      case 'postfix': {
        return this.compilePostfix(scope, context, expression);
      }
      case 'binary': {
        return this.compileBinary(scope, context, expression, expected);
      }
      case 'infix': {
        return this.compileInfix(scope, context, expression, expected);
      }
      case 'in': {
        return this.compileIn(scope, context, expression.left, expression.right, expression.negated, expression.row);
      }
      case 'is': {
        return this.compileIs(scope, context, expression);
      }
      case 'as': {
        return this.compileAs(scope, context, expression);
      }
    }
  }

  /** `if`, `when`, `try`, lambdas, and the jumps. */
  private compileControl(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<
      Expression,
      { kind: 'if' | 'when' | 'try' | 'lambda' | 'throw' | 'return' | 'break' | 'continue' }
    >,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    switch (expression.kind) {
      case 'if': {
        return this.compileIf(scope, context, expression, expected, asStatement);
      }
      case 'when': {
        return this.compileWhen(scope, context, expression, expected, asStatement);
      }
      case 'try': {
        return this.compileTry(scope, context, expression, expected, asStatement);
      }
      case 'lambda': {
        const expectedFunction =
          expected && resolved(expected).kind === 'function' ? (resolved(expected) as FunctionType) : undefined;
        return this.compileLambda(scope, context, expression, expectedFunction, false);
      }
      case 'throw': {
        return this.compileThrow(scope, context, expression);
      }
      case 'return': {
        return this.compileReturn(scope, context, expression);
      }
      case 'break':
      case 'continue': {
        return this.compileJump(context, expression.kind === 'break', expression.row);
      }
    }
  }

  // Literals.

  // code-gauge-allow functionCognitiveComplexity 19 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileInteger(
    expression: Extract<Expression, { kind: 'integer' }>,
    expected: KType | undefined
  ): Compiled {
    const { value, suffix, row } = expression;
    const isUnsigned = suffix === 'u' || suffix === 'uL';
    const literal = { value, isUnsigned, isLong: suffix === 'L' || suffix === 'uL' };
    const target = expected ? resolved(expected) : undefined;
    const expectedKind = target?.kind === 'class' ? this.core.primitives.get(target.cls) : undefined;
    let kind: PrimitiveKind;
    if (expectedKind && literalFits(literal, expectedKind)) kind = expectedKind;
    else if (suffix === 'L') kind = 'Long';
    else if (suffix === 'uL') kind = 'ULong';
    else if (isUnsigned) kind = value <= 0xff_ff_ff_ffn ? 'UInt' : 'ULong';
    else kind = BigInt.asIntN(32, value) === value ? 'Int' : 'Long';
    if (kind === 'Long' && BigInt.asIntN(64, value) !== value) this.error(row, '数が大きすぎます。');
    const runtimeValue = kind === 'Long' || kind === 'ULong' ? value : Number(value);
    return {
      type: this.primitiveType(kind),
      repr: kind,
      eval: () => runtimeValue,
      constant: runtimeValue,
      integerLiteral: suffix === 'L' ? undefined : literal,
    };
  }

  private compileString(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'string' }>
  ): Compiled {
    const parts = expression.parts.map((part) => {
      if (typeof part === 'string') return () => part;
      const compiled = this.compileExpression(scope, context, part);
      return this.stringConversion(compiled);
    });
    const constant = expression.parts.every((part) => typeof part === 'string') ? expression.parts.join('') : undefined;
    if (constant !== undefined) return { type: this.stringType, repr: 'ref', eval: () => constant, constant };
    return {
      type: this.stringType,
      repr: 'ref',
      eval: (frame) => {
        let text = '';
        for (const part of parts) text += part(frame);
        frame.runtime.allocateString(frame, text.length);
        return text;
      },
    };
  }

  /** Converts a value to a string as string templates and `toString()` do. */
  protected stringConversion(compiled: Compiled): (frame: Frame) => string {
    const { repr, eval: evaluate } = compiled;
    if (repr !== 'ref') return (frame) => formatPrimitive(repr, evaluate(frame) as number | bigint);
    return (frame) => stringOf(frame, evaluate(frame));
  }

  // Names.

  /** An implicit receiver's type where the code is, which a smart cast such as `if (this is List)` narrows. */
  protected receiverTypeOf(receiver: ReceiverSymbol): KType {
    return this.flow.narrowed.get(keyOf(receiver)) ?? receiver.type;
  }

  protected compileThis(scope: Scope, context: FunctionContext, row: number, label?: string): Compiled {
    const receivers = this.receiversOf(scope);
    const receiver = label === undefined ? receivers[0] : receivers.find((candidate) => candidate.label === label);
    if (!receiver)
      this.error(row, label === undefined ? 'ここでは this を使えません。' : `this@${label} が見つかりません。`);
    const key = keyOf(receiver);
    const narrowed = this.flow.narrowed.get(key);
    return {
      type: narrowed ?? receiver.type,
      repr: reprOf(this.core, receiver.type),
      eval: this.receiverAccess(context, receiver),
      stableKey: key,
    };
  }

  protected compileName(scope: Scope, context: FunctionContext, name: string, row: number): Compiled {
    const variable = this.findVariable(scope, name);
    if (variable) return this.readVariable(scope, context, variable, row);
    for (const receiver of this.receiversOf(scope)) {
      const property = this.findProperty(scope, this.receiverTypeOf(receiver), name);
      if (property) {
        this.checkInitialized(context, property.symbol, name, row);
        const receiverCompiled: Compiled = {
          type: this.receiverTypeOf(receiver),
          repr: reprOf(this.core, receiver.type),
          eval: this.receiverAccess(context, receiver),
          stableKey: keyOf(receiver),
        };
        return this.readProperty(scope, property, receiverCompiled, row);
      }
    }
    const staticMember = this.findStaticMember(scope, name, row);
    if (staticMember) return staticMember;
    const levels = this.topLevelProperties(name);
    for (const level of levels) {
      const property = level.find((candidate) => !candidate.extensionReceiver);
      if (property) return this.readTopLevelProperty(property, row);
    }
    const cls = this.findClass(scope, name);
    if (cls) {
      const value = this.classAsValue(cls, row);
      if (value) return value;
      this.error(row, `${name} はクラスなので、値としては使えません。`);
    }
    this.rejectUnavailableLibraryReference(name, row);
    return this.error(row, `${name} が見つかりません。`);
  }

  /** The companion object whose property a simple name in a class's body means, with the property. */
  protected findCompanionProperty(
    scope: Scope,
    name: string
  ): { holder: ClassSymbol; property: MemberRef<PropertySymbol> } | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) {
        const { companion } = cls;
        const property = companion ? this.findProperty(scope, companion.type, name) : undefined;
        if (companion && property) return { holder: companion, property };
      }
    }
    return undefined;
  }

  /** The enum class whose body, or whose nested declarations, hold the code of a scope. */
  private enclosingEnum(scope: Scope): ClassSymbol | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) if (cls.kind === 'enum') return cls;
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private findStaticMember(scope: Scope, name: string, row: number): Compiled | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) {
        if (cls.kind === 'enum' && cls.enumEntries.some((entry) => entry.name === name)) {
          return this.readEnumEntry(cls, name);
        }
        if (cls.kind === 'enum' && name === 'entries') return this.compileEnumEntries(cls);
        const { companion } = cls;
        if (!companion) continue;
        const property = this.findProperty(scope, companion.type, name);
        if (property) {
          const instance = this.objectInstance(companion);
          return this.readProperty(
            scope,
            property,
            { type: companion.type, repr: 'ref', eval: instance, stableKey: keyOf(companion) },
            row
          );
        }
      }
    }
    return undefined;
  }

  /** An object, a companion object through its class's name, or an enum entry used as a value. */
  protected classAsValue(cls: ClassSymbol, row: number): Compiled | undefined {
    if (cls.isObject) return { type: cls.type, repr: 'ref', eval: this.objectInstance(cls), stableKey: keyOf(cls) };
    if (cls.companion) {
      return {
        type: cls.companion.type,
        repr: 'ref',
        eval: this.objectInstance(cls.companion),
        stableKey: keyOf(cls.companion),
      };
    }
    void row;
    return undefined;
  }

  protected readEnumEntry(cls: ClassSymbol, name: string): Compiled {
    const companionLike = this.objectInstance(cls);
    const ordinal = cls.enumEntries.findIndex((entry) => entry.name === name);
    return {
      type: cls.type,
      repr: 'ref',
      eval: (frame) => {
        companionLike(frame);
        return (frame.runtime.enumEntries.get(cls) as Value[])[ordinal];
      },
      stableKey: `${keyOf(cls)}.${name}`,
    };
  }

  protected readVariable(scope: Scope, context: FunctionContext, variable: VariableSymbol, row: number): Compiled {
    const { delegateRead } = variable;
    if (delegateRead) {
      if (variable.owner !== context && variable.slot >= 0)
        this.unavailable(row, 'ラムダ式の中から、委譲したローカル変数を読むこと');
      return { type: variable.type, repr: reprOf(this.core, variable.type), eval: delegateRead };
    }
    if (!this.flow.assigned.has(variable) && !this.flow.isDead) {
      this.error(row, `変数 ${variable.name} に値が入っていません。`);
    }
    const key = keyOf(variable);
    const stable = stableLocal(scope, context, variable);
    const narrowed = stable ? this.flow.narrowed.get(key) : undefined;
    const access = this.variableAccess(context, variable);
    return {
      type: narrowed ?? variable.type,
      repr: reprOf(this.core, variable.type),
      eval: access.read,
      stableKey: stable ? key : undefined,
      unnarrowedType: narrowed && variable.type,
    };
  }

  /** The property a name means on a receiver: a member, or an extension visible in the file. */
  protected findProperty(scope: Scope, receiverType: KType, name: string): MemberRef<PropertySymbol> | undefined {
    const member = this.membersOf<PropertySymbol>(receiverType, name, 'property')[0];
    if (member) return member;
    return this.findExtensionProperty(scope, receiverType, name);
  }

  protected findExtensionProperty(
    scope: Scope,
    receiverType: KType,
    name: string
  ): MemberRef<PropertySymbol> | undefined {
    void scope;
    for (const level of this.topLevelProperties(name)) {
      for (const property of level) {
        if (!property.extensionReceiver) continue;
        const substitution = this.matchExtensionReceiver(
          property.typeParameters,
          property.extensionReceiver,
          receiverType
        );
        if (substitution) return { symbol: property, substitution };
      }
    }
    return undefined;
  }

  /** Infers an extension's type parameters from its receiver, or returns `undefined` when the receiver does not fit. */
  protected matchExtensionReceiver(
    typeParameters: TypeParameterSymbol[],
    declared: KType,
    receiverType: KType
  ): Map<TypeParameterSymbol, KType> | undefined {
    const variables = typeParameters.map((param) => ({
      param,
      lower: [] as KType[],
      upper: [] as KType[],
      fixed: undefined as KType | undefined,
    }));
    const substitution = new Map<TypeParameterSymbol, KType>();
    for (const variable of variables) substitution.set(variable.param, { kind: 'variable', variable, nullable: false });
    if (!isSubtype(receiverType, substitute(declared, substitution))) return undefined;
    for (const variable of variables) {
      const lower = variable.lower.map(resolved);
      variable.fixed = lower.length > 0 ? commonSupertype(lower) : (variable.upper[0] ?? anyType(true));
      substitution.set(variable.param, variable.fixed);
    }
    // A receiver must meet the bounds of the type parameter it gives, as `C : Collection<*>` of a collection's ifEmpty.
    for (const variable of variables) {
      const fixed = variable.fixed as KType;
      if (
        variable.lower.length > 0 &&
        variable.param.bounds.some((bound) => !isSubtype(fixed, substitute(bound, substitution)))
      )
        return undefined;
    }
    return substitution;
  }

  /** Reads a property on a compiled receiver, with smart casts for stable ones. */
  protected readProperty(scope: Scope, member: MemberRef<PropertySymbol>, receiver: Compiled, row: number): Compiled {
    const { symbol, substitution } = member;
    this.checkAccessible(scope, symbol, row, receiver.type);
    const declaredType = this.ensurePropertyType(symbol, row);
    const type = resolved(substitute(declaredType, substitution));
    const receiverEval = convertRepr(receiver.eval, receiver.repr, receiverRepr(symbol));
    const isStable = receiver.stableKey !== undefined && this.isStableProperty(symbol);
    const key = isStable ? `${receiver.stableKey}.${keyOf(symbol)}` : undefined;
    const narrowed = key ? this.flow.narrowed.get(key) : undefined;
    return {
      type: narrowed ?? type,
      unnarrowedType: narrowed && type,
      repr: propertyRepr(symbol),
      eval: (frame) => getPropertyValue(symbol, frame, receiverEval(frame)),
      stableKey: key,
    };
  }

  /** Whether a property always reads the value last stored, so that a smart cast of it holds. */
  protected isStableProperty(symbol: PropertySymbol): boolean {
    return !symbol.isVar && !symbol.hasCustomGetter && !symbol.isOpen && !symbol.isAbstract && !symbol.isLibrary;
  }

  protected readTopLevelProperty(symbol: PropertySymbol, row: number): Compiled {
    const type = this.ensurePropertyType(symbol, row);
    const key = keyOf(symbol);
    const narrowed = this.isStableProperty(symbol) ? this.flow.narrowed.get(key) : undefined;
    return {
      type: narrowed ?? type,
      repr: propertyRepr(symbol),
      eval: (frame) => getPropertyValue(symbol, frame, undefined),
      stableKey: this.isStableProperty(symbol) ? key : undefined,
    };
  }

  // Members.

  protected compileMemberAccess(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'member' }>
  ): Compiled {
    const { name, row, isSafe } = expression;
    const qualified = this.compileQualifier(scope, expression.receiver);
    if (qualified?.kind === 'class') return this.compileClassMember(scope, qualified.cls, name, row);
    if (qualified) return this.compilePackageMember(qualified, name, row);
    if (expression.receiver.kind === 'super') return this.compileSuperProperty(scope, context, name, row);
    const receiver = this.compileExpression(scope, context, expression.receiver);
    return this.withSafeReceiver(receiver, isSafe, row, (target) => {
      const property = this.findProperty(scope, target.type, name);
      if (!property) {
        if (this.membersOf(target.type, name, 'function').length > 0) {
          this.error(row, `${name} は関数なので、${name}() のように呼び出してください。`);
        }
        this.reportMissingMember(target.type, name, row);
      }
      const { extensionReceiver } = property.symbol;
      this.requireNonNullReceiver(
        target,
        row,
        extensionReceiver !== undefined && isNullable(resolved(extensionReceiver))
      );
      if (expression.receiver.kind === 'this' && !expression.receiver.label)
        this.checkInitialized(context, property.symbol, name, row);
      return this.readProperty(scope, property, target, row);
    });
  }

  /** `C.name` for a class `C`: an enum entry, a nested class or object, a member of an object or companion, or entries. */
  private compileClassMember(scope: Scope, cls: ClassSymbol, name: string, row: number): Compiled {
    if (cls.kind === 'enum' && cls.enumEntries.some((entry) => entry.name === name))
      return this.readEnumEntry(cls, name);
    const nested = cls.nested.get(name);
    const nestedValue = nested && this.classAsValue(nested, row);
    if (nestedValue) return nestedValue;
    const holder = cls.isObject ? cls : cls.companion;
    const property = holder && this.findProperty(scope, holder.type, name);
    if (holder && property) {
      return this.readProperty(
        scope,
        property,
        { type: holder.type, repr: 'ref', eval: this.objectInstance(holder), stableKey: keyOf(holder) },
        row
      );
    }
    if (cls.kind === 'enum' && name === 'entries') return this.compileEnumEntries(cls);
    return this.reportMissingQualifiedMember(cls, holder, name, row);
  }

  /** `p.name` for a package `p`: a top-level property or an object. */
  private compilePackageMember({ scope, path }: PackageQualifier, name: string, row: number): Compiled {
    const property = scope?.properties.get(name)?.find((candidate) => !candidate.extensionReceiver);
    if (property) return this.readTopLevelProperty(property, row);
    const cls = scope?.classes.get(name);
    const value = cls && this.classAsValue(cls, row);
    if (value) return value;
    if (!cls) this.rejectUnavailableLibraryReference(`${path}.${name}`, row);
    return this.error(row, `${name} が見つかりません。`);
  }

  protected abstract isLongConstant(expression: Expression, expected: KType | undefined): boolean;

  protected abstract toLongConstant(compiled: Compiled): Compiled;

  protected abstract compilePrefix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'prefix' }>,
    expected: KType | undefined
  ): Compiled;

  protected abstract compilePostfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'postfix' }>
  ): Compiled;

  protected abstract compileBinary(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>,
    expected: KType | undefined
  ): Compiled;

  protected abstract compileInfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'infix' }>,
    expected: KType | undefined
  ): Compiled;

  protected abstract compileIn(
    scope: Scope,
    context: FunctionContext,
    left: Expression,
    right: Expression,
    negated: boolean,
    row: number
  ): Compiled;

  protected abstract compileIs(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'is' }>
  ): Compiled;

  protected abstract compileAs(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'as' }>
  ): Compiled;

  protected abstract compileEnumEntries(cls: ClassSymbol): Compiled;

  /** What a qualifier such as `Color` in `Color.RED` or `kotlin.math` in `kotlin.math.PI` names, if not a value. */
  protected compileQualifier(scope: Scope, expression: Expression): Qualifier | undefined {
    if (expression.kind === 'name') return this.nameQualifier(scope, expression.name, expression.row);
    if (expression.kind !== 'member' || expression.isSafe) return undefined;
    const outer = this.compileQualifier(scope, expression.receiver);
    if (!outer) return undefined;
    if (outer.kind === 'class') {
      const nested = outer.cls.nested.get(expression.name);
      if (nested) this.checkNestedAccessible(scope, nested, expression.row);
      return nested ? { kind: 'class', cls: nested } : undefined;
    }
    const path = `${outer.path}.${expression.name}`;
    const packageScope = this.packages.get(path);
    if (packageScope) return { kind: 'package', path, scope: packageScope };
    const cls = outer.scope?.classes.get(expression.name);
    if (cls) return { kind: 'class', cls };
    this.rejectUnavailableLibraryReference(path, expression.row);
    return undefined;
  }

  /** What a simple name names as a qualifier: a class or a package, unless a value of that name hides it. */
  private nameQualifier(scope: Scope, name: string, row: number): Qualifier | undefined {
    if (this.findVariable(scope, name)) return undefined;
    for (const receiver of this.receiversOf(scope)) {
      if (this.findProperty(scope, this.receiverTypeOf(receiver), name)) return undefined;
    }
    if (this.findStaticMember(scope, name, row)) return undefined;
    if (this.topLevelProperties(name).length > 0) return undefined;
    const cls = this.findClass(scope, name);
    if (cls) return { kind: 'class', cls };
    const packageScope = this.packages.get(name);
    if (packageScope || name === 'java' || name === 'javax')
      return { kind: 'package', path: name, scope: packageScope };
    return undefined;
  }

  /** Evaluates a receiver once and, for `?.`, gives `null` without evaluating the rest when it is `null`. */
  /** The place of `a?.b`, which binds to nothing when `a` is null. */
  protected safePlace(receiver: Compiled, place: (holder: Compiled) => Place): Place {
    let held: Value;
    const holder: Compiled = { type: nonNull(receiver.type), repr: 'ref', eval: () => held };
    const inner = place(holder);
    const receiverEval = convertRepr(receiver.eval, receiver.repr, 'ref');
    return {
      ...inner,
      bind: (frame) => {
        const value = receiverEval(frame);
        if (value === NULL) return SKIPPED_PLACE;
        held = value;
        return inner.bind(frame);
      },
    };
  }

  protected withSafeReceiver(
    receiver: Compiled,
    isSafe: boolean,
    row: number,
    build: (target: Compiled) => Compiled
  ): Compiled {
    // Members of `Any?`, such as `toString()`, and extensions of nullable types accept a nullable receiver; `build` checks them.
    if (!isSafe) return build(receiver);
    let held: Value;
    const target: Compiled = {
      type: nonNull(receiver.type),
      repr: receiver.repr,
      eval: () => held,
      stableKey: receiver.stableKey,
    };
    const narrowed = new Map(this.flow.narrowed);
    if (receiver.stableKey) this.flow.narrowed.set(receiver.stableKey, nonNull(receiver.type));
    let result: Compiled;
    try {
      result = build(target);
    } finally {
      this.flow.narrowed.clear();
      for (const [key, type] of narrowed) this.flow.narrowed.set(key, type);
    }
    void row;
    const resultEval = convertRepr(result.eval, result.repr, 'ref');
    const receiverEval = receiver.eval;
    const whenNonNull = new Map(receiver.whenNonNull);
    if (receiver.stableKey) whenNonNull.set(receiver.stableKey, nonNull(receiver.type));
    return {
      type: nullable(result.type),
      repr: 'ref',
      whenNonNull,
      eval: (frame) => {
        const value = receiverEval(frame);
        if (value === undefined) return;
        const previous = held;
        held = value;
        try {
          return resultEval(frame);
        } finally {
          held = previous;
        }
      },
      isCall: result.isCall,
    };
  }

  /** Rejects a member access on a value that may be `null`, unless the member accepts `null`. */
  protected requireNonNullReceiver(receiver: Compiled, row: number, acceptsNull: boolean): void {
    if (!acceptsNull && isNullable(resolved(receiver.type))) {
      this.error(row, nullableReceiverMessage(receiver.type));
    }
  }

  private compileSuperProperty(scope: Scope, context: FunctionContext, name: string, row: number): Compiled {
    const { superType, receiver } = this.superOf(scope, context, row);
    const property = this.membersOf<PropertySymbol>(superType, name, 'property')[0];
    if (!property) this.error(row, `super には ${name} がありません。`);
    const type = resolved(substitute(this.ensurePropertyType(property.symbol, row), property.substitution));
    const { symbol } = property;
    return {
      type,
      repr: propertyRepr(symbol),
      eval: (frame) => {
        const { get } = symbol;
        if (!get) return frame.runtime.throwError(frame, 'java.lang.AbstractMethodError', name);
        return get(frame, receiver(frame));
      },
    };
  }

  protected superOf(
    scope: Scope,
    context: FunctionContext,
    row: number
  ): { superType: ClassType; receiver: Eval; cls: ClassSymbol } {
    const receiver = this.receiversOf(scope).find((candidate) => candidate.cls !== undefined);
    if (!receiver?.cls) this.error(row, 'ここでは super を使えません。');
    const { cls } = receiver;
    const superType = cls.superclass ?? cls.interfaces[0] ?? anyType();
    return { superType, receiver: this.receiverAccess(context, receiver), cls };
  }

  // Calls.

  protected compileCall(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'call' }>,
    expected: KType | undefined,
    delegate?: DelegateContext
  ): Compiled {
    const { callee, row } = expression;
    const args: ArgumentSyntax[] = expression.args.map((argument) => ({
      row: argument.row,
      name: argument.name,
      value: argument.value,
      isSpread: argument.isSpread,
    }));
    if (expression.trailingLambda)
      args.push({ row: expression.trailingLambda.row, name: undefined, value: expression.trailingLambda });
    if (delegate) this.delegateCalls.set(args, delegate);
    const hasTrailingLambda = expression.trailingLambda !== undefined;
    const typeArgs = expression.typeArgs.map((ref) => this.resolveType(scope, ref));
    if (callee.kind === 'name') {
      return this.compileNamedCall(scope, context, callee.name, args, hasTrailingLambda, typeArgs, expected, row);
    }
    if (callee.kind === 'member') {
      if (callee.receiver.kind === 'super') {
        return this.compileSuperCall(scope, context, callee.name, args, hasTrailingLambda, typeArgs, expected, row);
      }
      const qualified = this.compileQualifier(scope, callee.receiver);
      if (qualified)
        return this.compileQualifiedCall(
          scope,
          context,
          qualified,
          callee.name,
          args,
          hasTrailingLambda,
          typeArgs,
          expected,
          row
        );
      const receiver = this.compileExpression(scope, context, callee.receiver);
      return this.withSafeReceiver(receiver, callee.isSafe, row, (target) =>
        this.compileMethodCall(scope, context, target, callee.name, args, hasTrailingLambda, typeArgs, expected, row)
      );
    }
    const functionValue = this.compileExpression(scope, context, callee);
    return this.compileInvoke(scope, context, functionValue, args, hasTrailingLambda, row);
  }

  // code-gauge-allow functionParameterCount 8 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private compileNamedCall(
    scope: Scope,
    context: FunctionContext,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    typeArgs: KType[],
    expected: KType | undefined,
    row: number
  ): Compiled {
    const enumCall = this.reifiedEnumCall(scope, context, name, args, typeArgs, row);
    if (enumCall) return enumCall;
    const variable = this.findVariable(scope, name);
    if (variable && resolved(variable.type).kind === 'function') {
      return this.compileInvoke(
        scope,
        context,
        this.readVariable(scope, context, variable, row),
        args,
        hasTrailingLambda,
        row
      );
    }
    const receiverLevels = this.receiverLevels(scope, context, name, row);
    if (!Array.isArray(receiverLevels))
      return this.compileInvoke(scope, context, receiverLevels, args, hasTrailingLambda, row);
    const levels = [...receiverLevels, ...this.companionLevels(scope, name), ...this.topLevelFunctionLevels(name)];
    const cls = this.findClass(scope, name);
    if (
      cls?.isFunInterface &&
      args.length === 1 &&
      args[0].value.kind === 'lambda' &&
      typeArgs.length <= cls.typeParameters.length
    ) {
      return this.compileSamConstructor(scope, context, cls, args[0].value, typeArgs, expected);
    }
    const instantiable = cls !== undefined && !cls.isInterface && !cls.isAbstract && cls.kind !== 'enum';
    if (cls && (instantiable || levels.length === 0)) {
      const constructors = this.constructorCandidates(cls, row);
      if (constructors.length > 0) levels.push({ candidates: constructors, receiver: undefined });
    }
    if (levels.length === 0)
      return this.compileUnresolvedCall(scope, context, name, args, hasTrailingLambda, variable !== undefined, row);
    return this.resolveInLevels(scope, context, levels, args, hasTrailingLambda, typeArgs, expected, row, name);
  }

  /** The reified enumValues<E>() and enumValueOf<E>(name), which are the enum's own values() and valueOf(name). */
  private reifiedEnumCall(
    scope: Scope,
    context: FunctionContext,
    name: string,
    args: ArgumentSyntax[],
    typeArgs: KType[],
    row: number
  ): Compiled | undefined {
    if (name !== 'enumValues' && name !== 'enumValueOf') return undefined;
    const argument = typeArgs.length === 1 ? resolved(typeArgs[0]) : undefined;
    if (argument?.kind !== 'class' || argument.cls.kind !== 'enum') return undefined;
    return this.compileEnumFunction(
      scope,
      context,
      argument.cls,
      name === 'enumValues' ? 'values' : 'valueOf',
      args,
      row
    );
  }

  /**
   * The members and extensions of the implicit receivers that a call by name may call, the nearest first; or the value
   * of a property of a function type to invoke, for a receiver with no function of the name.
   */
  private receiverLevels(
    scope: Scope,
    context: FunctionContext,
    name: string,
    row: number
  ): CandidateLevel[] | Compiled {
    const levels: CandidateLevel[] = [];
    for (const receiver of this.receiversOf(scope)) {
      const receiverCompiled: Compiled = {
        type: this.receiverTypeOf(receiver),
        repr: reprOf(this.core, receiver.type),
        eval: this.receiverAccess(context, receiver),
        stableKey: keyOf(receiver),
      };
      const members = this.memberCandidates(receiverCompiled.type, name);
      if (members.length > 0) levels.push({ candidates: members, receiver: receiverCompiled });
      const extensions = this.extensionCandidates(receiverCompiled.type, name);
      if (extensions.length > 0) levels.push({ candidates: extensions, receiver: receiverCompiled });
      const property = this.findProperty(scope, receiverCompiled.type, name);
      const isFunctionValue = property && resolved(property.symbol.type ?? NOTHING).kind === 'function';
      if (isFunctionValue && members.length === 0 && extensions.length === 0)
        return this.readProperty(scope, property, receiverCompiled, row);
    }
    return levels;
  }

  /** The functions of the companion objects of the classes around a call by name. */
  private companionLevels(scope: Scope, name: string): CandidateLevel[] {
    const levels: CandidateLevel[] = [];
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) {
        const { companion } = cls;
        const members = companion ? this.memberCandidates(companion.type, name) : [];
        if (companion && members.length > 0) {
          levels.push({
            candidates: members,
            receiver: { type: companion.type, repr: 'ref', eval: this.objectInstance(companion) },
          });
        }
      }
    }
    return levels;
  }

  private topLevelFunctionLevels(name: string): CandidateLevel[] {
    return this.topLevelFunctions(name).flatMap((level) => {
      const functions = level.filter((symbol) => !symbol.extensionReceiver);
      if (functions.length === 0) return [];
      const candidates = functions.map((symbol): Candidate => ({
        symbol,
        kind: 'function',
        substitution: new Map(),
        receiverType: undefined,
      }));
      return [{ candidates, receiver: undefined }];
    });
  }

  /** A call by a name that no function has: a top-level value of a function type, values() of an enum, or an error. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private compileUnresolvedCall(
    scope: Scope,
    context: FunctionContext,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    isVariable: boolean,
    row: number
  ): Compiled {
    const property = this.topLevelProperties(name)[0]?.[0];
    if (property && resolved(this.ensurePropertyType(property, row)).kind === 'function') {
      return this.compileInvoke(scope, context, this.readTopLevelProperty(property, row), args, hasTrailingLambda, row);
    }
    if (isVariable) this.error(row, `${name} は関数ではないので、呼び出せません。`);
    const enumClass = this.enclosingEnum(scope);
    if (enumClass && (name === 'values' || name === 'valueOf'))
      return this.compileEnumFunction(scope, context, enumClass, name, args, row);
    return this.reportUnknownFunction(name, row);
  }

  /** `Comparator { a, b -> ... }`: a lambda converted to a `fun interface`, whose type arguments it may infer. */
  private compileSamConstructor(
    scope: Scope,
    context: FunctionContext,
    cls: ClassSymbol,
    lambda: LambdaExpression,
    typeArgs: KType[],
    expected: KType | undefined
  ): Compiled {
    let type: KType;
    const expectedType = expected ? resolved(expected) : undefined;
    if (typeArgs.length === cls.typeParameters.length) type = classType(cls, typeArgs);
    else if (expectedType?.kind === 'class' && expectedType.cls === cls) type = withNullabilityOf(expectedType, false);
    else
      type = classType(
        cls,
        cls.typeParameters.map(
          (param) =>
            ({
              kind: 'variable',
              variable: { param, lower: [], upper: [], fixed: undefined },
              nullable: false,
            }) as KType
        )
      );
    const sam = this.samOf(type) as NonNullable<ReturnType<ExpressionCompiler['samOf']>>;
    // The lambda's parameters need their types, which variables of an expected type such as `Comparator<in T>` give.
    for (const param of sam.functionType.params) {
      const actual = resolved(param);
      if (actual.kind === 'variable' && !actual.variable.fixed) fixVariable(actual.variable);
    }
    const compiled = this.compileLambda(scope, context, lambda, resolved(sam.functionType) as FunctionType, false);
    const bodyType = (resolved(compiled.type) as FunctionType).returnType;
    if (
      !isSubtype(bodyType, sam.functionType.returnType) &&
      !this.isClass(sam.functionType.returnType, this.core.unit)
    ) {
      this.error(lambda.row, typeMismatchMessage(sam.functionType.returnType, bodyType));
    }
    for (const argument of (resolved(type) as ClassType).args) {
      if (argument.variance !== 'star' && argument.type.kind === 'variable' && !argument.type.variable.fixed) {
        argument.type.variable.fixed =
          argument.type.variable.lower[0] ?? argument.type.variable.upper[0] ?? anyType(true);
      }
    }
    return { ...this.samWrap(compiled, sam, resolved(type)), isCreation: true };
  }

  /** Reports a call of a function that the program cannot use, naming the features that this environment lacks. */
  protected abstract reportUnknownFunction(name: string, row: number): never;

  /** Resolves a call whose candidates come with different receivers, the nearest level first. */
  // code-gauge-allow functionParameterCount 9 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  protected resolveInLevels(
    scope: Scope,
    context: FunctionContext,
    levels: { candidates: Candidate[]; receiver: Compiled | undefined }[],
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    typeArgs: KType[],
    expected: KType | undefined,
    row: number,
    name: string
  ): Compiled {
    // Each level resolves with its own receiver; the first level with an applicable candidate decides.
    const receiverOf = new Map<Candidate, Compiled | undefined>();
    for (const level of levels) {
      for (const candidate of level.candidates) {
        // A member of an object imported by name, as `observable` from `Delegates`, is called on the object.
        const owner = candidate.symbol.owner;
        const objectReceiver: Compiled | undefined =
          !level.receiver && owner?.isObject && candidate.kind !== 'constructor'
            ? { type: owner.type, repr: 'ref', eval: this.objectInstance(owner) }
            : undefined;
        receiverOf.set(candidate, level.receiver ?? objectReceiver);
      }
    }
    const resolvedCall = this.resolveCall(
      scope,
      context,
      levels.map((level) => level.candidates),
      args,
      hasTrailingLambda,
      typeArgs,
      expected,
      (candidate) => receiverOf.get(candidate),
      row,
      name
    );
    return this.finishCall(resolvedCall, receiverOf.get(resolvedCall.candidate), row);
  }

  protected memberCandidates(receiverType: KType, name: string): Candidate[] {
    return this.membersOf<FunctionSymbol>(receiverType, name, 'function').map(({ symbol, substitution }) => ({
      symbol,
      kind: 'member',
      substitution,
      receiverType,
    }));
  }

  /** The extension functions of a name visible in the file whose receiver type the receiver fits. */
  protected extensionCandidates(receiverType: KType, name: string): Candidate[] {
    const candidates: Candidate[] = [];
    for (const level of this.topLevelFunctions(name)) {
      const fitting = level.filter((symbol) => symbol.extensionReceiver && this.receiverFits(symbol, receiverType));
      if (fitting.length > 0) {
        candidates.push(
          ...fitting.map((symbol): Candidate => ({ symbol, kind: 'extension', substitution: new Map(), receiverType }))
        );
        break;
      }
    }
    return candidates;
  }

  /** Whether a receiver fits an extension's receiver type, `null` included when the extension accepts it. */
  private receiverFits(symbol: FunctionSymbol, receiverType: KType): boolean {
    return (
      this.matchExtensionReceiver(symbol.typeParameters, symbol.extensionReceiver as KType, receiverType) !== undefined
    );
  }

  protected abstract constructorCandidates(cls: ClassSymbol, row: number): Candidate[];

  /** Calls a resolved function on its receiver, checking that a receiver that may be `null` is accepted. */
  protected finishCall(call: ResolvedCall, receiver: Compiled | undefined, row: number): Compiled {
    const { symbol } = call;
    if (receiver && call.candidate.kind === 'member') {
      this.requireNonNullReceiver(receiver, row, false);
    }
    const receiverEval: Eval = receiver ? convertRepr(receiver.eval, receiver.repr, call.receiverRepr) : () => NULL;
    const invoke = call.call;
    const returnsNothing = resolved(call.type).kind === 'nothing' && !resolved(call.type).nullable;
    if (returnsNothing) this.flow.isDead = true;
    this.applyContracts(call);
    return {
      type: call.type,
      repr: call.repr,
      eval: (frame) => invoke(frame, receiverEval(frame)),
      narrowing: nullOrEmptyNarrowing(call, receiver),
      floatRangeBounds: floatRangeBounds(call, receiverEval),
      isCall: true,
      isCreation:
        call.candidate.kind === 'constructor' ||
        symbol.isConstructor ||
        (symbol.isLibrary && COLLECTION_FACTORIES.has(symbol.name) && call.argumentsCreateObjects),
    };
  }

  /**
   * Applies the smart casts that the standard library's contracts promise after a call returns: the condition of
   * `require` and `check` holds, and the argument of `requireNotNull` and `checkNotNull` is not null.
   */
  private applyContracts(call: ResolvedCall): void {
    const { symbol, compiledArgs } = call;
    if (!symbol.isLibrary || symbol.packageName !== 'kotlin' || symbol.extensionReceiver) return;
    const [first] = compiledArgs;
    if (symbol.name === 'require' || symbol.name === 'check') {
      for (const [key, type] of first?.narrowing?.whenTrue ?? []) this.flow.narrowed.set(key, type);
    }
    if ((symbol.name === 'requireNotNull' || symbol.name === 'checkNotNull') && first?.stableKey) {
      this.flow.narrowed.set(first.stableKey, nonNull(first.type));
    }
  }

  /** A local or top-level value of a function type with a receiver, which `x.name()` calls as an extension. */
  private extensionFunctionValue(
    context: FunctionContext,
    scope: Scope,
    name: string,
    row: number
  ): Compiled | undefined {
    const variable = this.findVariable(scope, name);
    if (variable) {
      const type = resolved(variable.type);
      return type.kind === 'function' && type.receiver ? this.readVariable(scope, context, variable, row) : undefined;
    }
    const property = this.topLevelProperties(name)[0]?.find((candidate) => !candidate.extensionReceiver);
    if (!property) return undefined;
    const type = resolved(this.ensurePropertyType(property, row));
    return type.kind === 'function' && type.receiver ? this.readTopLevelProperty(property, row) : undefined;
  }

  // code-gauge-allow functionParameterCount 9 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private compileMethodCall(
    scope: Scope,
    context: FunctionContext,
    receiver: Compiled,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    typeArgs: KType[],
    expected: KType | undefined,
    row: number
  ): Compiled {
    const members = this.memberCandidates(nonNull(receiver.type), name);
    const extensions = this.extensionCandidates(receiver.type, name);
    const levels: { candidates: Candidate[]; receiver: Compiled }[] = [];
    // On a receiver that may be null, an extension that accepts null, such as `Any?.toString()`, comes before members.
    const receiverMayBeNull = isNullable(resolved(receiver.type));
    if (receiverMayBeNull && extensions.length > 0) levels.push({ candidates: extensions, receiver });
    if (members.length > 0) levels.push({ candidates: members, receiver });
    if (!receiverMayBeNull && extensions.length > 0) levels.push({ candidates: extensions, receiver });
    if (levels.length === 0)
      return this.compileFunctionValueCall(scope, context, receiver, name, args, hasTrailingLambda, row);
    const memberOnly = members.length > 0 && extensions.length === 0;
    if (memberOnly) this.requireNonNullReceiver(receiver, row, false);
    const resolvedCall = this.resolveCall(
      scope,
      context,
      levels.map((level) => level.candidates),
      args,
      hasTrailingLambda,
      typeArgs,
      expected,
      receiver,
      row,
      name
    );
    return this.finishCall(resolvedCall, receiver, row);
  }

  /**
   * `x.name(...)` without a function `name` for `x`: `invoke` of a function value, a value of a function type with a
   * receiver, or a property of a function type; anything else is an error.
   */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private compileFunctionValueCall(
    scope: Scope,
    context: FunctionContext,
    receiver: Compiled,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    row: number
  ): Compiled {
    if (name === 'invoke' && resolved(receiver.type).kind === 'function') {
      this.requireNonNullReceiver(receiver, row, false);
      return this.compileInvoke(scope, context, receiver, args, hasTrailingLambda, row);
    }
    const extensionValue = this.extensionFunctionValue(context, scope, name, row);
    if (extensionValue)
      return this.compileInvoke(scope, context, extensionValue, args, hasTrailingLambda, row, receiver);
    const property = this.findProperty(scope, receiver.type, name);
    const propertyType = property && substitute(this.ensurePropertyType(property.symbol, row), property.substitution);
    if (property && propertyType && resolved(propertyType).kind === 'function') {
      return this.compileInvoke(
        scope,
        context,
        this.readProperty(scope, property, receiver, row),
        args,
        hasTrailingLambda,
        row
      );
    }
    if (isNullable(resolved(receiver.type)) && this.extensionCandidates(nonNull(receiver.type), name).length > 0) {
      this.requireNonNullReceiver(receiver, row, false);
    }
    return this.reportMissingMember(receiver.type, name, row);
  }

  private reportMissingMember(type: KType, name: string, row: number): never {
    const unavailable = unavailableLibraryMember(type, name);
    if (unavailable) this.unavailable(row, unavailable);
    return this.error(row, `${typeToString(type)} には ${name} がありません。`);
  }

  private reportMissingQualifiedMember(
    cls: ClassSymbol,
    holder: ClassSymbol | undefined,
    name: string,
    row: number
  ): never {
    const label = unavailableQualifiedLibraryMember(cls, holder, name);
    if (label) this.unavailable(row, label);
    return this.error(row, `${cls.name}.${name} が見つかりません。`);
  }

  // code-gauge-allow functionParameterCount 9 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionNcss 34 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow functionCognitiveComplexity 21 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileQualifiedCall(
    scope: Scope,
    context: FunctionContext,
    qualified: NonNullable<ReturnType<ExpressionCompiler['compileQualifier']>>,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    typeArgs: KType[],
    expected: KType | undefined,
    row: number
  ): Compiled {
    if (qualified.kind === 'package') {
      const functions = qualified.scope?.functions.get(name)?.filter((symbol) => !symbol.extensionReceiver) ?? [];
      const levels: { candidates: Candidate[]; receiver: Compiled | undefined }[] = [];
      if (functions.length > 0) {
        levels.push({
          candidates: functions.map((symbol) => ({
            symbol,
            kind: 'function',
            substitution: new Map(),
            receiverType: undefined,
          })),
          receiver: undefined,
        });
      }
      const cls = qualified.scope?.classes.get(name);
      // `kotlin.random.Random(1)` calls the function, since the abstract class of the same name has no constructor to call.
      if (cls && !(cls.isAbstract && functions.length > 0)) {
        levels.push({ candidates: this.constructorCandidates(cls, row), receiver: undefined });
      }
      if (levels.length === 0) {
        this.rejectUnavailableLibraryReference(`${qualified.path}.${name}`, row);
        this.error(row, `${name} が見つかりません。`);
      }
      return this.resolveInLevels(scope, context, levels, args, hasTrailingLambda, typeArgs, expected, row, name);
    }
    const { cls } = qualified;
    const nested = cls.nested.get(name);
    if (nested) this.checkNestedAccessible(scope, nested, row);
    const levels: { candidates: Candidate[]; receiver: Compiled | undefined }[] = [];
    const holder = cls.isObject ? cls : cls.companion;
    if (holder) {
      const receiver: Compiled = {
        type: holder.type,
        repr: 'ref',
        eval: this.objectInstance(holder),
        stableKey: keyOf(holder),
      };
      const members = this.memberCandidates(holder.type, name);
      if (members.length > 0) levels.push({ candidates: members, receiver });
      const extensions = this.extensionCandidates(holder.type, name);
      if (extensions.length > 0) levels.push({ candidates: extensions, receiver });
    }
    if (nested) levels.push({ candidates: this.constructorCandidates(nested, row), receiver: undefined });
    if (cls.kind === 'enum' && (name === 'values' || name === 'valueOf')) {
      return this.compileEnumFunction(scope, context, cls, name, args, row);
    }
    if (levels.length === 0) return this.reportMissingQualifiedMember(cls, holder, name, row);
    return this.resolveInLevels(scope, context, levels, args, hasTrailingLambda, typeArgs, expected, row, name);
  }

  protected abstract compileEnumFunction(
    scope: Scope,
    context: FunctionContext,
    cls: ClassSymbol,
    name: string,
    args: ArgumentSyntax[],
    row: number
  ): Compiled;

  // code-gauge-allow functionParameterCount 8 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private compileSuperCall(
    scope: Scope,
    context: FunctionContext,
    name: string,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    typeArgs: KType[],
    expected: KType | undefined,
    row: number
  ): Compiled {
    const { cls, receiver } = this.superOf(scope, context, row);
    const supertypes = cls.supertypes.length > 0 ? cls.supertypes : [anyType()];
    const candidates = supertypes
      .flatMap((type) => this.memberCandidates(type, name))
      .filter((candidate) => !candidate.symbol.isAbstract)
      // Through super, a subclass may use the protected members of its parent.
      .map((candidate) => ({ ...candidate, receiverType: undefined }));
    if (candidates.length === 0) this.error(row, `super には ${name} がありません。`);
    const resolvedCall = this.resolveCall(
      scope,
      context,
      [candidates],
      args,
      hasTrailingLambda,
      typeArgs,
      expected,
      undefined,
      row,
      name
    );
    if (resolvedCall.usesDefaultArguments) this.error(row, 'super の呼び出しで引数を省略できません。');
    // `super.f()` calls the superclass's implementation itself, without dispatching on the instance's class.
    const symbol = resolvedCall.symbol;
    const staticCall = this.nonVirtualCall(resolvedCall);
    const receiverEval = convertRepr(receiver, 'ref', resolvedCall.receiverRepr);
    return {
      type: resolvedCall.type,
      repr: resolvedCall.repr,
      eval: (frame) => staticCall(frame, receiverEval(frame)),
      isCall: true,
      isCreation: symbol.isConstructor,
    };
  }

  /** The call of a resolved function on a receiver, without virtual dispatch, as `super.f()` makes. */
  protected abstract nonVirtualCall(call: ResolvedCall): (frame: Frame, receiver: Value) => Value;

  /** Calls a value of a function type, such as a lambda held in a variable. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionNcss 40 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow functionCognitiveComplexity 22 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileInvoke(
    scope: Scope,
    context: FunctionContext,
    functionValue: Compiled,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    row: number,
    explicitReceiver?: Compiled
  ): Compiled {
    void hasTrailingLambda;
    const type = resolved(functionValue.type);
    if (type.kind !== 'function') {
      if (type.kind === 'class' && type.nullable)
        this.error(row, 'null かもしれない関数は、?.invoke() か !! を使って呼び出してください。');
      return this.error(row, `${typeToString(type)} の値は呼び出せません。`);
    }
    if (type.nullable) this.error(row, 'null かもしれない関数は、?.invoke() か !! を使って呼び出してください。');
    if (args.some((argument) => argument.name !== undefined))
      this.error(row, '関数型の値の呼び出しには、引数の名前を書けません。');
    // A function type with a receiver takes it before its arguments: written as `r.f(x)`, or implicit as `f(x)`.
    let receiverEval: Eval | undefined;
    if (type.receiver) {
      const receiverType = type.receiver;
      const receiver =
        explicitReceiver ??
        (args.length === type.params.length
          ? this.receiversOf(scope)
              .map((candidate): Compiled => ({
                type: this.flow.narrowed.get(keyOf(candidate)) ?? candidate.type,
                repr: reprOf(this.core, candidate.type),
                eval: this.receiverAccess(context, candidate),
              }))
              .find((candidate) => isSubtype(candidate.type, receiverType))
          : undefined);
      if (receiver)
        receiverEval = convertRepr(
          this.expectType(receiver, receiverType, row),
          reprOf(this.core, receiverType),
          'ref'
        );
    }
    const params = type.receiver && !receiverEval ? [type.receiver, ...type.params] : type.params;
    if (args.length !== params.length) this.error(row, `引数の数が違います。${params.length} 個必要です。`);
    const argumentEvals = args.map((argument, index) => {
      const paramType = params[index];
      const compiled =
        argument.value.kind === 'lambda'
          ? this.compileLambda(
              scope,
              context,
              argument.value,
              resolved(paramType).kind === 'function' ? (resolved(paramType) as FunctionType) : undefined,
              false
            )
          : this.compileExpression(scope, context, argument.value, paramType);
      const converted = this.expectType(compiled, paramType, argument.row);
      return convertRepr(converted, reprOf(this.core, paramType), 'ref');
    });
    const evals = receiverEval ? [receiverEval, ...argumentEvals] : argumentEvals;
    const target = functionValue.eval;
    return {
      type: type.returnType,
      repr: 'ref',
      eval: (frame) => {
        const fn = target(frame) as KObject;
        const { temporaries } = frame;
        const mark = temporaries.length;
        temporaries.push(fn);
        try {
          const values = evals.map((evaluate) => {
            const value = evaluate(frame);
            temporaries.push(value);
            return value;
          });
          return invokeFunctionValue(frame, fn, values);
        } finally {
          temporaries.length = mark;
        }
      },
      isCall: true,
    };
  }

  // Operators.

  private compileIndex(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'index' }>
  ): Compiled {
    const receiver = this.compileExpression(scope, context, expression.receiver);
    const args: ArgumentSyntax[] = expression.indices.map((index) => ({
      row: index.row,
      name: undefined,
      value: index,
    }));
    return this.compileOperatorCall(scope, context, receiver, 'get', args, expression.row, '[]');
  }

  /** Calls an operator function such as `get` or `contains` on a compiled receiver. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  protected compileOperatorCall(
    scope: Scope,
    context: FunctionContext,
    receiver: Compiled,
    name: string,
    args: ArgumentSyntax[],
    row: number,
    shown: string
  ): Compiled {
    const members = this.memberCandidates(nonNull(receiver.type), name).filter(
      (candidate) => candidate.symbol.isOperator
    );
    const extensions = this.extensionCandidates(receiver.type, name).filter((candidate) => candidate.symbol.isOperator);
    // On a nullable receiver, only extensions that take one apply, as String?.plus does to `s + "x"`.
    const isNullableReceiver = isNullable(resolved(receiver.type));
    const levels = [isNullableReceiver ? [] : members, extensions].filter((level) => level.length > 0);
    if (isNullableReceiver && extensions.length === 0 && members.length > 0)
      this.requireNonNullReceiver(receiver, row, false);
    if (levels.length === 0) {
      this.error(row, `${typeToString(resolved(receiver.type))} には ${shown} を使えません。`);
    }
    const call = this.resolveCall(scope, context, levels, args, false, [], undefined, receiver, row, shown);
    return { ...this.finishCall(call, receiver, row), isCall: false };
  }

  /** Resolves an operator call, giving both the resolved function and its compiled call. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  protected resolveOperator(
    scope: Scope,
    context: FunctionContext,
    receiver: Compiled,
    name: string,
    args: ArgumentSyntax[],
    row: number,
    shown: string
  ): { call: ResolvedCall; compiled: Compiled } {
    const members = this.memberCandidates(nonNull(receiver.type), name).filter(
      (candidate) => candidate.symbol.isOperator
    );
    const extensions = this.extensionCandidates(receiver.type, name).filter((candidate) => candidate.symbol.isOperator);
    const levels = [members, extensions].filter((level) => level.length > 0);
    if (levels.length === 0) this.error(row, `${typeToString(resolved(receiver.type))} には ${shown} を使えません。`);
    if (extensions.length === 0 || members.length > 0) this.requireNonNullReceiver(receiver, row, false);
    const call = this.resolveCall(scope, context, levels, args, false, [], undefined, receiver, row, shown);
    return { call, compiled: { ...this.finishCall(call, receiver, row), isCall: false } };
  }

  // Jumps.

  private compileThrow(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'throw' }>
  ): Compiled {
    const value = this.compileExpression(scope, context, expression.value);
    if (!isSubtype(value.type, this.core.throwable.type))
      this.error(expression.row, typeMismatchMessage(this.core.throwable.type, value.type));
    const evaluate = value.eval;
    this.flow.isDead = true;
    return {
      type: NOTHING,
      repr: 'ref',
      eval: (frame) => {
        const thrown = evaluate(frame);
        if (thrown === undefined) return frame.runtime.throwError(frame, 'java.lang.NullPointerException');
        throw new KotlinThrow(thrown as KObject);
      },
    };
  }

  private compileReturn(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'return' }>
  ): Compiled {
    const target = context.isLambda ? context.returnTarget : context;
    if (!target) this.error(expression.row, 'ここでは return を書けません。ラムダ式の値は、最後の式に書いてください。');
    const returnType = target.returnType;
    let evaluate: Eval = returnUnit;
    if (expression.value) {
      const value = this.compileExpression(scope, context, expression.value, returnType);
      if (returnType) {
        if (this.isClass(returnType, this.core.unit) && !this.isClass(value.type, this.core.unit)) {
          this.error(expression.row, '戻り値の型が Unit の関数は、値を返せません。');
        }
        evaluate = convertRepr(
          this.expectType(value, returnType, expression.value.row),
          reprOf(this.core, returnType),
          target.returnRepr ?? reprOf(this.core, returnType)
        );
      } else {
        target.returnedTypes.push(value.type);
        evaluate = value.eval;
      }
    } else if (returnType && !this.isClass(returnType, this.core.unit)) {
      this.error(expression.row, 'return に値が必要です。');
    } else if (!returnType) {
      target.returnedTypes.push(this.unitType);
    }
    const frameOf = this.frameAccess(context, target);
    this.flow.isDead = true;
    return {
      type: NOTHING,
      repr: 'ref',
      eval: (frame) => {
        throw new ReturnSignal(frameOf(frame), evaluate(frame));
      },
    };
  }

  private compileJump(context: FunctionContext, isBreak: boolean, row: number): Compiled {
    const loop = context.loops.at(-1);
    if (!loop) this.error(row, `${isBreak ? 'break' : 'continue'} は、ループの中に書いてください。`);
    const exits = isBreak ? loop.breaks : loop.continues;
    if (!this.flow.isDead) exits.push(this.flow.copy());
    const signal = new LoopSignal(loop.identity, isBreak);
    this.flow.isDead = true;
    return {
      type: NOTHING,
      repr: 'ref',
      eval: () => {
        throw signal;
      },
    };
  }

  // Lambdas.

  // code-gauge-allow functionNcss 32 -- the parts of a lambda, from its parameters to its function value, which follow one another.
  compileLambda(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    expected: FunctionType | undefined,
    isInline: boolean
  ): Compiled {
    const lambdaContext = new FunctionContext(
      context,
      true,
      'lambda',
      context.info.isLibrary,
      isInline ? (context.returnTarget ?? (context.isLambda ? undefined : context)) : undefined
    );
    lambdaContext.inlineLambda = isInline;
    if (isInline) lambdaContext.loops = [...context.loops];
    const lambdaScope = new Scope(scope, lambdaContext);
    const params = this.lambdaParameters(scope, lambda, expected?.params);
    const receiverType = expected?.receiver;
    if (receiverType) lambdaScope.receiver = new ReceiverSymbol(receiverType, lambdaContext, undefined);
    const outerFlow = this.flow;
    this.flow = outerFlow.copy();
    const variables = params.map((param) => {
      const variable = this.newParameter(lambdaScope, lambdaContext, param.name ?? '_', param.type, param.row);
      if (param.name === undefined) lambdaScope.variables.delete('_');
      this.flow.assigned.add(variable);
      return variable;
    });
    const expectedReturn = expected ? resolved(expected.returnType) : undefined;
    const returnsUnit = expectedReturn?.kind === 'class' && expectedReturn.cls === this.core.unit;
    const bodyBlock: Block = { row: lambda.row, endRow: lambda.endRow, statements: lambda.statements, isBraced: true };
    const body = this.compileBlockValue(
      lambdaScope,
      lambdaContext,
      bodyBlock,
      returnsUnit ? undefined : lambdaResultHint(expectedReturn),
      returnsUnit
    );
    this.markCapturedAssignments(lambdaContext, outerFlow);
    this.flow = outerFlow;
    const resultType = returnsUnit ? this.unitType : body.type;
    const resultEval = returnsUnit
      ? (frame: Frame): Value => {
          body.eval(frame);
          return UNIT;
        }
      : convertRepr(body.eval, body.repr, 'ref');
    const hasReceiver = receiverType !== undefined;
    const type: FunctionType = {
      kind: 'function',
      receiver: receiverType,
      params: params.map((param) => param.type),
      returnType: resultType,
      nullable: false,
    };
    const evaluate = lambdaValue({
      captureBuilder: this.captureBuilder(context, lambdaContext),
      info: lambdaContext.info,
      arity: params.length + (hasReceiver ? 1 : 0),
      hasReceiver,
      receiverIsUnboxed: hasReceiver && reprOf(this.core, receiverType) !== 'ref',
      paramReprs: variables.map((variable) => reprOf(this.core, variable.type)),
      resultEval,
      functionClass: this.core.function,
    });
    return { type, repr: 'ref', eval: evaluate };
  }

  /** The parameters of a lambda, declared or `it`, with the types that they declare or the expected type gives them. */
  // code-gauge-allow functionCognitiveComplexity 16 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private lambdaParameters(
    scope: Scope,
    lambda: LambdaExpression,
    expectedParams: KType[] | undefined
  ): { name: string | undefined; type: KType; row: number }[] {
    if (lambda.params === undefined) {
      if (expectedParams && expectedParams.length > 1)
        this.error(lambda.row, `このラムダ式には引数が ${expectedParams.length} 個要ります。`);
      return expectedParams?.length === 1 ? [{ name: 'it', type: expectedParams[0], row: lambda.row }] : [];
    }
    if (expectedParams && expectedParams.length !== lambda.params.length)
      this.error(lambda.row, `このラムダ式には引数が ${expectedParams.length} 個要ります。`);
    return lambda.params.map((param, index) => {
      const declared = param.type ? this.resolveType(scope, param.type) : undefined;
      const expectedType = expectedParams?.[index];
      if (!declared && !expectedType)
        this.error(param.row, `ラムダ式の引数 ${param.name ?? '_'} の型を書いてください。`);
      if (declared && expectedType && !isSubtype(expectedType, declared))
        this.error(param.row, typeMismatchMessage(declared, expectedType));
      return { name: param.name, type: declared ?? (expectedType as KType), row: param.row };
    });
  }

  /** Marks the variables a lambda assigns, whose smart casts then no longer hold. */
  protected markCapturedAssignments(lambda: FunctionContext, outerFlow: Flow): void {
    void outerFlow;
    for (const source of lambda.captures) {
      if (source instanceof VariableSymbol && source.isVar && lambda.assignedCaptures.has(source))
        source.isCapturedAndModified = true;
    }
  }

  protected compileLambdaProbe(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    type: FunctionType
  ): KType | undefined {
    const savedFlow = this.flow.copy();
    try {
      const compiled = this.compileLambda(
        scope,
        this.probeContext(context),
        lambda,
        {
          ...type,
          returnType: {
            kind: 'variable',
            variable: { param: PROBE_PARAM, lower: [], upper: [], fixed: undefined },
            nullable: false,
          },
        },
        false
      );
      return (resolved(compiled.type) as FunctionType).returnType;
    } catch {
      return undefined;
    } finally {
      this.flow = savedFlow;
    }
  }

  protected abstract compileIf(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'if' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled;
  protected abstract compileWhen(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'when' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled;
  protected abstract compileTry(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'try' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled;
}

function withNullabilityOf<T extends KType>(type: T, isNullable: boolean): T {
  return type.nullable === isNullable ? type : { ...type, nullable: isNullable };
}

function returnUnit(): Value {
  return UNIT;
}

/** The library's functions that collect their arguments, which only create objects when every argument does. */
const COLLECTION_FACTORIES = new Set(['arrayOf', 'listOf', 'mutableListOf', 'arrayListOf', 'setOf', 'mutableSetOf']);

const PROBE_PARAM = new (class extends Object {})() as unknown as TypeParameterSymbol;

/** Calls a function value with arguments held as references. */
function invokeFunctionValue(frame: Frame, fn: KObject, args: Value[]): Value {
  const { function: callable } = fn;
  if (!callable) throw new Error('A function value without its function');
  return callable.call(frame, args);
}

/** Function values receive their arguments boxed, while a parameter of a primitive type holds the bare value. */
function unboxedIf(unboxed: boolean, value: Value): Value {
  return unboxed && value instanceof Boxed ? value.value : value;
}

/** `s.isNullOrEmpty()` and `s.isNullOrBlank()` are false only for a receiver that is not null, as their contracts say. */
function nullOrEmptyNarrowing(call: ResolvedCall, receiver: Compiled | undefined): Compiled['narrowing'] {
  const { symbol } = call;
  const isNullCheck = symbol.isLibrary && (symbol.name === 'isNullOrEmpty' || symbol.name === 'isNullOrBlank');
  if (!isNullCheck || !receiver?.stableKey) return undefined;
  return { whenTrue: new Map(), whenFalse: new Map([[receiver.stableKey, nonNull(receiver.type)]]) };
}

/** A class or a package that a qualifier names. */
interface PackageQualifier {
  kind: 'package';
  path: string;
  scope: PackageScope | undefined;
}

type Qualifier = { kind: 'class'; cls: ClassSymbol } | PackageQualifier;

/** The candidates of one level of a call, with the receiver they are called on. */
interface CandidateLevel {
  candidates: Candidate[];
  receiver: Compiled | undefined;
}

/**
 * Makes a lambda's function value, which captures its environment and calls the lambda's body with the receiver and
 * the arguments, unboxing those that the lambda holds as primitives.
 */
function lambdaValue(lambda: {
  captureBuilder: (frame: Frame) => unknown[];
  info: FunctionInfo;
  arity: number;
  hasReceiver: boolean;
  receiverIsUnboxed: boolean;
  paramReprs: Repr[];
  resultEval: Eval;
  functionClass: ClassSymbol;
}): Eval {
  const { captureBuilder, info, arity, hasReceiver, receiverIsUnboxed, paramReprs, resultEval, functionClass } = lambda;
  return (frame) => {
    const env = captureBuilder(frame);
    const value = new KObject(functionClass, 0);
    value.env = env;
    value.function = {
      arity,
      call: (caller, args) => {
        const receiver = hasReceiver ? unboxedIf(receiverIsUnboxed, args[0]) : undefined;
        const values = hasReceiver ? args.slice(1) : args;
        const converted = values.map((arg, index) => unboxedIf(paramReprs[index] !== 'ref', arg));
        return frame.runtime.call(info, caller, env, receiver, converted, undefined, resultEval);
      },
    };
    return value;
  };
}
