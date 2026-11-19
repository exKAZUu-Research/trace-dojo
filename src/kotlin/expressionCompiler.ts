import type { Block, Expression, LambdaExpression, TypeRef } from './ast';
import { type ArgumentSyntax, CallCompiler, type Candidate, type ResolvedCall } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  Flow,
  FunctionContext,
  type PackageScope,
  ReceiverSymbol,
  type Repr,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import type { MemberRef } from './compilerCore';
import { unavailableMessage } from './convertSupport';
import { getPropertyValue, propertyRepr, receiverRepr } from './dispatch';
import { formatPrimitive, stringOf, valueEquals } from './format';
import {
  arithmeticOperation,
  type ArithmeticOperator,
  arithmeticResult,
  compareNumbers,
  negate,
  NUMBER_OPERATOR_NAMES,
  step,
  unaryResult,
  widen,
} from './operators';
import { type Frame, KotlinThrow, LoopSignal, ReturnSignal } from './runtime';
import {
  type ClassSymbol,
  type FunctionSymbol,
  type PropertySymbol,
  type TypeParameterSymbol,
  VariableSymbol,
} from './symbols';
import { instanceTest, throwCastFailure } from './typeChecks';
import { anyType, commonSupertype, isSubtype } from './typeRelations';
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

const identities = new WeakMap<object, number>();
let nextKey = 1;

/** A key that names a variable or property in the narrowed types of a flow. */
export function keyOf(item: object): string {
  let id = identities.get(item);
  if (id === undefined) {
    id = nextKey++;
    identities.set(item, id);
  }
  return `#${id}`;
}

/** A place to store a value, with its receiver and indexes evaluated. */
export interface BoundPlace {
  get(): Value;
  set(value: Value): void;
}

export interface Place {
  type: KType;
  repr: Repr;
  bind: (frame: Frame) => BoundPlace;
}

const INTEGER_KINDS = new Set<PrimitiveKind>(['Int', 'Long', 'Short', 'Byte']);
const NUMERIC_KINDS = new Set<PrimitiveKind>(['Int', 'Long', 'Short', 'Byte', 'Double', 'Float']);

export abstract class ExpressionCompiler extends CallCompiler {
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
      if (kind && kind !== this.primitiveOf(compiled.type) && this.literalFits(literal, kind)) {
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
        return this.compileCall(scope, context, expression, expected);
      }
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
        return this.compileInfix(scope, context, expression);
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
  private compileInteger(expression: Extract<Expression, { kind: 'integer' }>, expected: KType | undefined): Compiled {
    const { value, suffix, row } = expression;
    const isUnsigned = suffix === 'u' || suffix === 'uL';
    const literal = { value, isUnsigned, isLong: suffix === 'L' || suffix === 'uL' };
    const target = expected ? resolved(expected) : undefined;
    const expectedKind = target?.kind === 'class' ? this.core.primitives.get(target.cls) : undefined;
    let kind: PrimitiveKind;
    if (expectedKind && this.literalFits(literal, expectedKind)) kind = expectedKind;
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
    if (variable) return this.readVariable(context, variable, row);
    for (const receiver of this.receiversOf(scope)) {
      const property = this.findProperty(scope, this.receiverTypeOf(receiver), name);
      if (property) {
        const receiverCompiled: Compiled = {
          type: this.receiverTypeOf(receiver),
          repr: reprOf(this.core, receiver.type),
          eval: this.receiverAccess(context, receiver),
          stableKey: keyOf(receiver),
        };
        return this.readProperty(property, receiverCompiled, row);
      }
    }
    const staticMember = this.findStaticMember(scope, name);
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
    return this.error(row, `${name} が見つかりません。`);
  }

  /** The members of the companion objects and enum entries that a class's body reaches by their simple names. */
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

  // code-gauge-allow functionCognitiveComplexity 17 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private findStaticMember(scope: Scope, name: string): Compiled | undefined {
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
            property,
            { type: companion.type, repr: 'ref', eval: instance, stableKey: keyOf(companion) },
            -1
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

  protected readVariable(context: FunctionContext, variable: VariableSymbol, row: number): Compiled {
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
    const narrowed = variable.isCapturedAndModified ? undefined : this.flow.narrowed.get(key);
    const access = this.variableAccess(context, variable);
    return {
      type: narrowed ?? variable.type,
      repr: reprOf(this.core, variable.type),
      eval: access.read,
      stableKey: variable.isCapturedAndModified ? undefined : key,
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
    return substitution;
  }

  /** Reads a property on a compiled receiver, with smart casts for stable ones. */
  protected readProperty(member: MemberRef<PropertySymbol>, receiver: Compiled, row: number): Compiled {
    const { symbol, substitution } = member;
    const declaredType = this.ensurePropertyType(symbol, row);
    const type = resolved(substitute(declaredType, substitution));
    const receiverEval = convertRepr(receiver.eval, receiver.repr, receiverRepr(symbol));
    const isStable = receiver.stableKey !== undefined && this.isStableProperty(symbol);
    const key = isStable ? `${receiver.stableKey}.${keyOf(symbol)}` : undefined;
    const narrowed = key ? this.flow.narrowed.get(key) : undefined;
    return {
      type: narrowed ?? type,
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
    if (qualified) {
      if (qualified.kind === 'class') {
        const cls = qualified.cls;
        if (cls.kind === 'enum' && cls.enumEntries.some((entry) => entry.name === name))
          return this.readEnumEntry(cls, name);
        const nested = cls.nested.get(name);
        if (nested) {
          const value = this.classAsValue(nested, row);
          if (value) return value;
        }
        const holder = cls.isObject ? cls : cls.companion;
        if (holder) {
          const property = this.findProperty(scope, holder.type, name);
          if (property) {
            return this.readProperty(
              property,
              { type: holder.type, repr: 'ref', eval: this.objectInstance(holder), stableKey: keyOf(holder) },
              row
            );
          }
        }
        if (cls.kind === 'enum' && name === 'entries') {
          return this.compileEnumEntries(cls);
        }
        return this.error(row, `${cls.name}.${name} が見つかりません。`);
      }
      const property = qualified.scope.properties.get(name)?.find((candidate) => !candidate.extensionReceiver);
      if (property) return this.readTopLevelProperty(property, row);
      const cls = qualified.scope.classes.get(name);
      if (cls) {
        const value = this.classAsValue(cls, row);
        if (value) return value;
      }
      return this.error(row, `${name} が見つかりません。`);
    }
    if (expression.receiver.kind === 'super') return this.compileSuperProperty(scope, context, name, row);
    const receiver = this.compileExpression(scope, context, expression.receiver);
    return this.withSafeReceiver(receiver, isSafe, row, (target) => {
      const property = this.findProperty(scope, target.type, name);
      if (!property) {
        if (this.membersOf(target.type, name, 'function').length > 0) {
          this.error(row, `${name} は関数なので、${name}() のように呼び出してください。`);
        }
        this.error(row, `${typeToString(resolved(target.type))} には ${name} がありません。`);
      }
      const { extensionReceiver } = property.symbol;
      this.requireNonNullReceiver(
        target,
        row,
        extensionReceiver !== undefined && isNullable(resolved(extensionReceiver))
      );
      this.checkAccessible(scope, property.symbol, row, target.type);
      return this.readProperty(property, target, row);
    });
  }

  protected abstract compileEnumEntries(cls: ClassSymbol): Compiled;

  /** What a qualifier such as `Color` in `Color.RED` or `kotlin.math` in `kotlin.math.PI` names, if not a value. */
  protected compileQualifier(
    scope: Scope,
    expression: Expression
  ): { kind: 'class'; cls: ClassSymbol } | { kind: 'package'; scope: PackageScope } | undefined {
    if (expression.kind === 'name') {
      if (this.findVariable(scope, expression.name)) return undefined;
      for (const receiver of this.receiversOf(scope)) {
        if (this.findProperty(scope, this.receiverTypeOf(receiver), expression.name)) return undefined;
      }
      if (this.findStaticMember(scope, expression.name)) return undefined;
      if (this.topLevelProperties(expression.name).length > 0) return undefined;
      const cls = this.findClass(scope, expression.name);
      if (cls) return { kind: 'class', cls };
      const packageScope = this.packages.get(expression.name);
      if (packageScope) return { kind: 'package', scope: packageScope };
      return undefined;
    }
    if (expression.kind === 'member' && !expression.isSafe) {
      const outer = this.compileQualifier(scope, expression.receiver);
      if (!outer) return undefined;
      if (outer.kind === 'class') {
        const nested = outer.cls.nested.get(expression.name);
        return nested ? { kind: 'class', cls: nested } : undefined;
      }
      const path = this.packagePathOf(expression);
      if (path) {
        const packageScope = this.packages.get(path);
        if (packageScope) return { kind: 'package', scope: packageScope };
      }
      const cls = outer.scope.classes.get(expression.name);
      return cls ? { kind: 'class', cls } : undefined;
    }
    return undefined;
  }

  private packagePathOf(expression: Expression): string | undefined {
    if (expression.kind === 'name') return expression.name;
    if (expression.kind === 'member') {
      const outer = this.packagePathOf(expression.receiver);
      return outer === undefined ? undefined : `${outer}.${expression.name}`;
    }
    return undefined;
  }

  /** Evaluates a receiver once and, for `?.`, gives `null` without evaluating the rest when it is `null`. */
  protected withSafeReceiver(
    receiver: Compiled,
    isSafe: boolean,
    row: number,
    build: (target: Compiled) => Compiled
  ): Compiled {
    if (!isSafe) {
      if (isNullable(resolved(receiver.type))) {
        // Members of `Any?`, such as `toString()`, and extensions of nullable types accept it; `build` checks them.
        return build(receiver);
      }
      return build(receiver);
    }
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
    return {
      type: nullable(result.type),
      repr: 'ref',
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
      this.error(
        row,
        `null かもしれない ${typeToString(resolved(receiver.type))} の値には、?. か !! を使ってください。`
      );
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
    expected: KType | undefined
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
    const variable = this.findVariable(scope, name);
    if (variable && resolved(variable.type).kind === 'function') {
      return this.compileInvoke(
        scope,
        context,
        this.readVariable(context, variable, row),
        args,
        hasTrailingLambda,
        row
      );
    }
    const levels: { candidates: Candidate[]; receiver: Compiled | undefined }[] = [];
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
      if (
        property &&
        members.length === 0 &&
        extensions.length === 0 &&
        resolved(property.symbol.type ?? NOTHING).kind === 'function'
      ) {
        return this.compileInvoke(
          scope,
          context,
          this.readProperty(property, receiverCompiled, row),
          args,
          hasTrailingLambda,
          row
        );
      }
    }
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) {
        if (!cls.companion) continue;
        const companion = cls.companion;
        const members = this.memberCandidates(companion.type, name);
        if (members.length > 0) {
          levels.push({
            candidates: members,
            receiver: { type: companion.type, repr: 'ref', eval: this.objectInstance(companion) },
          });
        }
      }
    }
    for (const level of this.topLevelFunctions(name)) {
      const functions = level.filter((symbol) => !symbol.extensionReceiver);
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
    }
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
    if (levels.length === 0) {
      const property = this.topLevelProperties(name)[0]?.[0];
      if (property && resolved(this.ensurePropertyType(property, row)).kind === 'function') {
        return this.compileInvoke(
          scope,
          context,
          this.readTopLevelProperty(property, row),
          args,
          hasTrailingLambda,
          row
        );
      }
      if (variable) this.error(row, `${name} は関数ではないので、呼び出せません。`);
      this.reportUnknownFunction(name, row);
    }
    return this.resolveInLevels(scope, context, levels, args, hasTrailingLambda, typeArgs, expected, row, name);
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
    this.ensureContracts(call, row);
    return {
      type: call.type,
      repr: call.repr,
      eval: (frame) => invoke(frame, receiverEval(frame)),
      isCall: true,
      isCreation:
        call.candidate.kind === 'constructor' ||
        symbol.isConstructor ||
        (symbol.isLibrary && COLLECTION_FACTORIES.has(symbol.name) && call.argumentsCreateObjects),
    };
  }

  /** Applies what the standard library's contracts promise after a call, such as `require` and `check`. */
  protected ensureContracts(call: ResolvedCall, row: number): void {
    void call;
    void row;
  }

  // code-gauge-allow functionParameterCount 9 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionCognitiveComplexity 21 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
    if (levels.length === 0) {
      const variable = this.findVariable(scope, name);
      const variableType = variable ? resolved(variable.type) : undefined;
      if (variable && variableType?.kind === 'function' && variableType.receiver) {
        return this.compileInvoke(
          scope,
          context,
          this.readVariable(context, variable, row),
          args,
          hasTrailingLambda,
          row,
          receiver
        );
      }
      const property = this.findProperty(scope, receiver.type, name);
      if (property && resolved(this.ensurePropertyType(property.symbol, row)).kind === 'function') {
        return this.compileInvoke(
          scope,
          context,
          this.readProperty(property, receiver, row),
          args,
          hasTrailingLambda,
          row
        );
      }
      if (isNullable(resolved(receiver.type)) && this.extensionCandidates(nonNull(receiver.type), name).length > 0) {
        this.requireNonNullReceiver(receiver, row, false);
      }
      const what = UNAVAILABLE_MEMBER_FUNCTIONS[name];
      if (what) this.error(row, unavailableMessage(what));
      this.error(row, `${typeToString(resolved(receiver.type))} には ${name} がありません。`);
    }
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

  // code-gauge-allow functionParameterCount 9 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionNcss 31 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow functionCognitiveComplexity 20 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
      const functions = qualified.scope.functions.get(name)?.filter((symbol) => !symbol.extensionReceiver) ?? [];
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
      const cls = qualified.scope.classes.get(name);
      // `kotlin.random.Random(1)` calls the function, since the abstract class of the same name has no constructor to call.
      if (cls && !(cls.isAbstract && functions.length > 0)) {
        levels.push({ candidates: this.constructorCandidates(cls, row), receiver: undefined });
      }
      if (levels.length === 0) this.error(row, `${name} が見つかりません。`);
      return this.resolveInLevels(scope, context, levels, args, hasTrailingLambda, typeArgs, expected, row, name);
    }
    const { cls } = qualified;
    const nested = cls.nested.get(name);
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
    if (levels.length === 0) this.error(row, `${cls.name}.${name} が見つかりません。`);
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
    const callRow = this.recordsSteps && !this.file.isLibrary ? row : undefined;
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
          return invokeFunctionValue(frame, fn, values, callRow);
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
    const levels = [members, extensions].filter((level) => level.length > 0);
    if (levels.length === 0) {
      this.error(row, `${typeToString(resolved(receiver.type))} には ${shown} を使えません。`);
    }
    if (extensions.length === 0 || members.length > 0) this.requireNonNullReceiver(receiver, row, false);
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

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per unary operator.
  private compilePrefix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'prefix' }>,
    expected: KType | undefined
  ): Compiled {
    const { operator, row } = expression;
    if (operator === '++' || operator === '--')
      return this.compileIncrement(scope, context, expression.operand, operator === '++' ? 1 : -1, true, row);
    if (
      operator === '-' &&
      expression.operand.kind === 'integer' &&
      expression.operand.suffix !== 'u' &&
      expression.operand.suffix !== 'uL'
    ) {
      const negated = { ...expression.operand, value: -expression.operand.value };
      return this.compileInteger(negated, expected);
    }
    if (operator === '-' && expression.operand.kind === 'real') {
      const value = -expression.operand.value;
      const kind = expression.operand.isFloat ? 'Float' : 'Double';
      return { type: this.primitiveType(kind), repr: kind, eval: () => value, constant: value };
    }
    const operand = this.compileExpression(scope, context, expression.operand);
    if (operator === '!') {
      if (!isSubtype(operand.type, this.booleanType))
        this.error(row, typeMismatchMessage(this.booleanType, operand.type));
      const evaluate = operand.eval;
      return {
        type: this.booleanType,
        repr: 'ref',
        eval: (frame) => !(evaluate(frame) as boolean),
        constant: operand.constant === undefined ? undefined : !operand.constant,
      };
    }
    const kind = this.primitiveOf(operand.type);
    const result = kind ? unaryResult(kind) : undefined;
    if (!kind || !result) {
      return this.compileOperatorCall(
        scope,
        context,
        operand,
        operator === '-' ? 'unaryMinus' : 'unaryPlus',
        [],
        row,
        operator
      );
    }
    const evaluate = this.convertTo(operand, operand.type, row);
    if (operator === '+')
      return {
        type: this.primitiveType(result),
        repr: result,
        eval: (frame) => widen(evaluate(frame) as number, kind, result),
      };
    return {
      type: this.primitiveType(result),
      repr: result,
      eval: (frame) => negate(result, widen(evaluate(frame) as number | bigint, kind, result)),
    };
  }

  private compilePostfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'postfix' }>
  ): Compiled {
    const { operator, row } = expression;
    if (operator === '++' || operator === '--')
      return this.compileIncrement(scope, context, expression.operand, operator === '++' ? 1 : -1, false, row);
    const operand = this.compileExpression(scope, context, expression.operand);
    const evaluate = operand.eval;
    if (operand.stableKey) this.flow.narrowed.set(operand.stableKey, nonNull(operand.type));
    return {
      type: nonNull(operand.type),
      repr: operand.repr,
      eval: (frame) => {
        const value = evaluate(frame);
        if (value === undefined) return frame.runtime.throwError(frame, 'java.lang.NullPointerException');
        return value;
      },
      isCall: operand.isCall,
    };
  }

  /** `++` and `--`, which store the incremented value and give the new value (prefix) or the old one (postfix). */
  protected compileIncrement(
    scope: Scope,
    context: FunctionContext,
    target: Expression,
    delta: 1 | -1,
    isPrefix: boolean,
    row: number
  ): Compiled {
    const place = this.compilePlace(scope, context, target, row, true);
    const kind = this.primitiveOf(place.type);
    if (!kind)
      this.error(row, `${typeToString(resolved(place.type))} には ${delta === 1 ? '++' : '--'} を使えません。`);
    const toPlace = (value: number | bigint): Value => (place.repr === 'ref' ? box(kind, value) : value);
    return {
      type: this.primitiveType(kind),
      repr: kind,
      eval: (frame) => {
        const bound = place.bind(frame);
        const old = unboxNumber(bound.get());
        const next = step(kind, old, delta);
        bound.set(toPlace(next));
        return isPrefix ? next : old;
      },
    };
  }

  /**
   * An assignable place: a variable, a property, or an indexed element. `bind` evaluates the receiver and indexes once,
   * so that reading and writing the place evaluate them once, as compound assignments do.
   */
  abstract compilePlace(
    scope: Scope,
    context: FunctionContext,
    target: Expression,
    row: number,
    isCompound: boolean
  ): Place;

  protected compileBinary(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>,
    expected: KType | undefined
  ): Compiled {
    const { operator, row } = expression;
    switch (operator) {
      case '&&':
      case '||': {
        return this.compileLogical(scope, context, expression);
      }
      case '?:': {
        return this.compileElvis(scope, context, expression, expected);
      }
      case '==':
      case '!=':
      case '===':
      case '!==': {
        return this.compileEquality(scope, context, expression);
      }
      case '..':
      case '..<': {
        const left = this.compileExpression(scope, context, expression.left);
        const args: ArgumentSyntax[] = [{ row: expression.right.row, name: undefined, value: expression.right }];
        return this.compileOperatorCall(
          scope,
          context,
          left,
          operator === '..' ? 'rangeTo' : 'rangeUntil',
          args,
          row,
          operator
        );
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        return this.compileComparison(scope, context, expression);
      }
      default: {
        return this.compileArithmetic(scope, context, operator, expression.left, expression.right, row);
      }
    }
  }

  protected compileArithmetic(
    scope: Scope,
    context: FunctionContext,
    operator: ArithmeticOperator,
    leftExpression: Expression,
    rightExpression: Expression,
    row: number
  ): Compiled {
    const left = this.compileExpression(scope, context, leftExpression);
    return this.compileArithmeticWith(scope, context, operator, left, rightExpression, row);
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileArithmeticWith(
    scope: Scope,
    context: FunctionContext,
    operator: ArithmeticOperator,
    left: Compiled,
    rightExpression: Expression,
    row: number
  ): Compiled {
    const leftKind = this.primitiveOf(left.type);
    if (operator === '+' && this.isClass(left.type, this.core.string) && !isNullable(resolved(left.type))) {
      const right = this.compileExpression(scope, context, rightExpression);
      const leftText = left.eval;
      const rightText = this.stringConversion(right);
      const constant =
        typeof left.constant === 'string' &&
        right.constant !== undefined &&
        right.repr === 'ref' &&
        typeof right.constant === 'string'
          ? left.constant + right.constant
          : undefined;
      return {
        type: this.stringType,
        repr: 'ref',
        eval: (frame) => {
          const text = (leftText(frame) as string) + rightText(frame);
          frame.runtime.allocateString(frame, text.length);
          return text;
        },
        constant,
      };
    }
    if (leftKind) {
      const right = this.compileExpression(scope, context, rightExpression);
      const rightKind = this.primitiveOf(right.type);
      const result = rightKind ? arithmeticResult(leftKind, rightKind, operator) : undefined;
      if (rightKind && result) {
        const operation = arithmeticOperation(result, operator);
        const leftEval = this.convertTo(left, left.type, row);
        const rightEval = this.convertTo(right, right.type, row);
        const leftTo: PrimitiveKind = result === 'Char' ? 'Char' : result;
        const rightTo: PrimitiveKind =
          result === 'Char' ? 'Int' : leftKind === 'Char' && rightKind === 'Char' ? 'Int' : result;
        const leftFrom = leftKind;
        const rightFrom = rightKind;
        const leftFinal: PrimitiveKind = leftKind === 'Char' && rightKind === 'Char' ? 'Int' : leftTo;
        return {
          type: this.primitiveType(result),
          repr: result,
          eval: (frame) =>
            operation(
              frame,
              widen(leftEval(frame) as number | bigint, leftFrom, leftFinal),
              widen(rightEval(frame) as number | bigint, rightFrom, rightTo)
            ),
        };
      }
      if (rightKind || !NUMERIC_KINDS.has(leftKind)) {
        this.error(
          row,
          `演算子 ${operator} は ${typeToString(resolved(left.type))} と ${typeToString(resolved(right.type))} には使えません。`
        );
      }
    }
    const args: ArgumentSyntax[] = [{ row: rightExpression.row, name: undefined, value: rightExpression }];
    return this.compileOperatorCall(scope, context, left, NUMBER_OPERATOR_NAMES[operator], args, row, operator);
  }

  private compileLogical(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const isAnd = expression.operator === '&&';
    const condition = this.compileCondition(scope, context, expression.left);
    const before = this.flow.copy();
    this.applyNarrowing(isAnd ? condition.whenTrue : condition.whenFalse);
    const right = this.compileCondition(scope, context, expression.right);
    const afterRight = this.flow;
    this.flow = Flow_merge([afterRight, this.withNarrowing(before, isAnd ? condition.whenFalse : condition.whenTrue)]);
    const leftEval = condition.compiled.eval;
    const rightEval = right.compiled.eval;
    const whenTrue = isAnd
      ? new Map([...condition.whenTrue, ...right.whenTrue])
      : intersectNarrowing(condition.whenTrue, right.whenTrue);
    const whenFalse = isAnd
      ? intersectNarrowing(condition.whenFalse, right.whenFalse)
      : new Map([...condition.whenFalse, ...right.whenFalse]);
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: isAnd
        ? (frame) => (leftEval(frame) as boolean) && (rightEval(frame) as boolean)
        : (frame) => (leftEval(frame) as boolean) || (rightEval(frame) as boolean),
      narrowing: { whenTrue, whenFalse },
    };
  }

  /** A flow that has the narrowing of a condition applied, without changing `flow`. */
  protected withNarrowing(flow: Flow, narrowing: Map<string, KType>): Flow {
    const copy = flow.copy();
    for (const [key, type] of narrowing) copy.narrowed.set(key, type);
    return copy;
  }

  protected applyNarrowing(narrowing: Map<string, KType>): void {
    for (const [key, type] of narrowing) this.flow.narrowed.set(key, type);
  }

  /** Compiles a condition, with the smart casts that hold when it is true and when it is false. */
  compileCondition(
    scope: Scope,
    context: FunctionContext,
    expression: Expression
  ): { compiled: Compiled; whenTrue: Map<string, KType>; whenFalse: Map<string, KType> } {
    const compiled = this.compileExpression(scope, context, expression, this.booleanType);
    if (!isSubtype(compiled.type, this.booleanType))
      this.error(expression.row, typeMismatchMessage(this.booleanType, compiled.type));
    const { narrowing } = compiled;
    const evaluate = convertRepr(compiled.eval, compiled.repr, 'ref');
    return {
      compiled: { ...compiled, eval: evaluate },
      whenTrue: narrowing?.whenTrue ?? new Map(),
      whenFalse: narrowing?.whenFalse ?? new Map(),
    };
  }

  private compileElvis(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>,
    expected: KType | undefined
  ): Compiled {
    const left = this.compileExpression(scope, context, expression.left, expected ? nullable(expected) : undefined);
    const before = this.flow.copy();
    const right = this.compileExpression(scope, context, expression.right, expected);
    const rightIsNothing = resolved(right.type).kind === 'nothing' && !resolved(right.type).nullable;
    this.flow = rightIsNothing ? before : Flow_merge([before, this.flow]);
    if (rightIsNothing && left.stableKey) this.flow.narrowed.set(left.stableKey, nonNull(left.type));
    const type = rightIsNothing ? nonNull(left.type) : commonSupertype([nonNull(left.type), right.type]);
    const repr = reprOf(this.core, type);
    const leftEval = convertRepr(left.eval, left.repr, 'ref');
    const rightEval = convertRepr(
      this.convertTo(right, right.type, expression.row),
      reprOf(this.core, right.type),
      'ref'
    );
    const choose: Eval = (frame) => {
      const value = leftEval(frame);
      return value ?? rightEval(frame);
    };
    return { type, repr, eval: convertRepr(choose, 'ref', repr) };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Kotlin's rules of equality by the operands' types.
  // code-gauge-allow functionNcss 38 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileEquality(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const { operator, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const right = this.compileExpression(scope, context, expression.right);
    const negated = operator === '!=' || operator === '!==';
    const isIdentity = operator === '===' || operator === '!==';
    this.checkEqualityApplicable(left, right, row, operator);
    const leftKind = this.primitiveOf(nonNull(left.type));
    const rightKind = this.primitiveOf(nonNull(right.type));
    let test: (frame: Frame) => boolean;
    if (!isIdentity && leftKind && leftKind === rightKind) {
      // Values statically known as numbers or characters compare by value, IEEE 754's way for floating point.
      const leftEval = convertRepr(left.eval, left.repr, 'ref');
      const rightEval = convertRepr(right.eval, right.repr, 'ref');
      if (left.repr !== 'ref' && right.repr !== 'ref') {
        const a = left.eval;
        const b = right.eval;
        test = (frame) => a(frame) === b(frame);
      } else {
        test = (frame) => {
          const a = leftEval(frame);
          const b = rightEval(frame);
          if (a === undefined || b === undefined) return a === b;
          return (a as Boxed).value === (b as Boxed).value;
        };
      }
    } else {
      const leftEval = convertRepr(left.eval, left.repr, 'ref');
      const rightEval = convertRepr(this.convertTo(right, right.type, row), reprOf(this.core, right.type), 'ref');
      test = isIdentity
        ? (frame) => {
            const a = leftEval(frame);
            const b = rightEval(frame);
            return a === b;
          }
        : (frame) => valueEquals(frame, leftEval(frame), rightEval(frame));
    }
    // `x != null` and `x == null` narrow a stable `x`.
    const whenNonNull = new Map<string, KType>();
    if (resolved(right.type).kind === 'nothing' && left.stableKey) whenNonNull.set(left.stableKey, nonNull(left.type));
    if (resolved(left.type).kind === 'nothing' && right.stableKey)
      whenNonNull.set(right.stableKey, nonNull(right.type));
    const narrowing = negated
      ? { whenTrue: whenNonNull, whenFalse: new Map<string, KType>() }
      : { whenTrue: new Map<string, KType>(), whenFalse: whenNonNull };
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: negated ? (frame) => !test(frame) : test,
      narrowing,
    };
  }

  /** Rejects `==` between types that can never be equal, as Kotlin's compiler does. */
  private checkEqualityApplicable(left: Compiled, right: Compiled, row: number, operator: string): void {
    const a = nonNull(resolved(left.type));
    const b = nonNull(resolved(right.type));
    if (a.kind === 'nothing' || b.kind === 'nothing') return;
    if (isSubtype(a, b) || isSubtype(b, a)) return;
    // Values of the standard library's final value types never equal values of unrelated types, which Kotlin rejects;
    // two unrelated classes of the program only draw a warning.
    const isValueType = (type: KType): boolean =>
      this.primitiveOf(type) !== undefined ||
      this.isClass(type, this.core.boolean) ||
      this.isClass(type, this.core.string) ||
      (type.kind === 'class' && type.cls.kind === 'enum');
    if (isValueType(a) || isValueType(b)) {
      this.error(row, `演算子 ${operator} は ${typeToString(a)} と ${typeToString(b)} には使えません。`);
    }
  }

  private compileComparison(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const { operator, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const right = this.compileExpression(scope, context, expression.right);
    const leftKind = this.primitiveOf(left.type);
    const rightKind = this.primitiveOf(right.type);
    const test = COMPARISON_TESTS[operator as '<' | '<=' | '>' | '>='];
    if (leftKind && rightKind) {
      const isChar = leftKind === 'Char' || rightKind === 'Char';
      const isUnsigned = leftKind.startsWith('U') || rightKind.startsWith('U');
      if (
        (isChar && leftKind !== rightKind) ||
        (isUnsigned && !(leftKind.startsWith('U') && rightKind.startsWith('U')))
      ) {
        this.error(
          row,
          `演算子 ${operator} は ${typeToString(resolved(left.type))} と ${typeToString(resolved(right.type))} には使えません。`
        );
      }
      const leftEval = this.convertTo(left, left.type, row);
      const rightEval = this.convertTo(right, right.type, row);
      const isFloating = ['Double', 'Float'].includes(leftKind) || ['Double', 'Float'].includes(rightKind);
      if (isFloating) {
        // Comparison operators on floating-point numbers follow IEEE 754, where NaN compares false.
        const compare = COMPARISON_IEEE[operator as '<' | '<=' | '>' | '>='];
        return {
          type: this.booleanType,
          repr: 'ref',
          eval: (frame) => compare(Number(leftEval(frame)), Number(rightEval(frame))),
        };
      }
      return {
        type: this.booleanType,
        repr: 'ref',
        eval: (frame) => test(compareNumbers(leftEval(frame) as number | bigint, rightEval(frame) as number | bigint)),
      };
    }
    void INTEGER_KINDS;
    const args: ArgumentSyntax[] = [{ row: expression.right.row, name: undefined, value: expression.right }];
    const compared = this.compileOperatorCall(scope, context, left, 'compareTo', args, row, operator);
    const evaluate = convertRepr(compared.eval, compared.repr, 'Int');
    return { type: this.booleanType, repr: 'ref', eval: (frame) => test(evaluate(frame) as number) };
  }

  private compileInfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'infix' }>
  ): Compiled {
    const { name, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const members = this.memberCandidates(nonNull(left.type), name).filter((candidate) => candidate.symbol.isInfix);
    const extensions = this.extensionCandidates(left.type, name).filter((candidate) => candidate.symbol.isInfix);
    const levels = [members, extensions].filter((level) => level.length > 0);
    if (levels.length === 0) this.error(row, `${typeToString(resolved(left.type))} には ${name} を使えません。`);
    if (extensions.length === 0) this.requireNonNullReceiver(left, row, false);
    const args: ArgumentSyntax[] = [{ row: expression.right.row, name: undefined, value: expression.right }];
    const call = this.resolveCall(scope, context, levels, args, false, [], undefined, left, row, name);
    return { ...this.finishCall(call, left, row), isCall: false };
  }

  protected compileIn(
    scope: Scope,
    context: FunctionContext,
    element: Expression,
    container: Expression,
    negated: boolean,
    row: number
  ): Compiled {
    const containerCompiled = this.compileExpression(scope, context, container);
    const args: ArgumentSyntax[] = [{ row: element.row, name: undefined, value: element }];
    const contains = this.compileOperatorCall(scope, context, containerCompiled, 'contains', args, row, 'in');
    const evaluate = convertRepr(contains.eval, contains.repr, 'ref');
    return { type: this.booleanType, repr: 'ref', eval: negated ? (frame) => !(evaluate(frame) as boolean) : evaluate };
  }

  // Types.

  /**
   * The type of an `is` check, which may name type arguments only where the subject's type implies them, as
   * `iterable is Collection<T>` does for an `Iterable<T>`, since type arguments are erased at run time.
   */
  protected checkableType(scope: Scope, ref: TypeRef, row: number, subjectType: KType): KType {
    const type = this.resolveType(scope, ref, true);
    const actual = resolved(type);
    const implied =
      actual.kind === 'class'
        ? resolved(
            this.narrowedType(subjectType, { ...actual, args: actual.args.map(() => ({ variance: 'star' as const })) })
          )
        : undefined;
    const isImplied = implied !== undefined && isSubtype(implied, actual) && isSubtype(actual, implied);
    if (actual.kind === 'class' && !isImplied && actual.args.some((argument) => argument.variance !== 'star')) {
      this.error(
        row,
        `型引数は実行時には消えるので、${typeToString(actual)} かどうかは調べられません。* を使ってください。`
      );
    }
    if (actual.kind === 'param' && !actual.param.isReified)
      this.error(row, `型引数 ${actual.param.name} かどうかは調べられません。`);
    return type;
  }

  /** Whether a type is a generic class written without arguments, as in `x is List`. */
  protected isBare(type: KType): boolean {
    const actual = resolved(type);
    return (
      actual.kind === 'class' && actual.args.length > 0 && actual.args.every((argument) => argument.variance === 'star')
    );
  }

  /** The type `is` narrows to: the class type with the arguments the value's static type gives it. */
  // code-gauge-allow functionCognitiveComplexity 20 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected narrowedType(staticType: KType, checked: KType): KType {
    const target = resolved(checked);
    const source = nonNull(resolved(staticType));
    if (target.kind === 'class' && target.cls.typeParameters.length > 0 && source.kind === 'class') {
      // A subtype's arguments come from the supertype's, as `List<Int>` checked against `ArrayList<*>` gives `ArrayList<Int>`.
      const substitution = new Map<TypeParameterSymbol, KType>();
      const up = this.supertypeAs(target.cls.selfType, source.cls);
      if (up) {
        for (const [index, argument] of up.args.entries()) {
          if (argument.variance !== 'star' && argument.type.kind === 'param') {
            const sourceArg = source.args[index];
            if (sourceArg && sourceArg.variance !== 'star') substitution.set(argument.type.param, sourceArg.type);
          }
        }
        return substitute(target.cls.selfType, substitution);
      }
    }
    if (isSubtype(source, target) && !isNullable(target)) return source;
    return nonNull(target);
  }

  private compileIs(scope: Scope, context: FunctionContext, expression: Extract<Expression, { kind: 'is' }>): Compiled {
    const operand = this.compileExpression(scope, context, expression.operand);
    const type = this.checkableType(scope, expression.type, expression.row, operand.type);
    const test = instanceTest(this.core, type);
    const evaluate = convertRepr(operand.eval, operand.repr, 'ref');
    const narrowing = new Map<string, KType>();
    if (operand.stableKey) narrowing.set(operand.stableKey, this.narrowedType(operand.type, type));
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: expression.negated ? (frame) => !test(evaluate(frame)) : (frame) => test(evaluate(frame)),
      narrowing: expression.negated
        ? { whenTrue: new Map(), whenFalse: narrowing }
        : { whenTrue: narrowing, whenFalse: new Map() },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileAs(scope: Scope, context: FunctionContext, expression: Extract<Expression, { kind: 'as' }>): Compiled {
    const operand = this.compileExpression(scope, context, expression.operand);
    const written = this.resolveType(scope, expression.type, true);
    const type = this.isBare(written) ? this.narrowedType(operand.type, written) : written;
    const actual = resolved(type);
    const isErased =
      (actual.kind === 'class' && actual.args.some((argument) => argument.variance !== 'star')) ||
      actual.kind === 'param';
    const checkType =
      isErased && actual.kind === 'class'
        ? { ...actual, args: actual.args.map(() => ({ variance: 'star' as const })) }
        : type;
    const test = actual.kind === 'param' ? () => true : instanceTest(this.core, checkType);
    const evaluate = convertRepr(operand.eval, operand.repr, 'ref');
    const resultType = expression.isSafe ? nullable(type) : type;
    const repr = reprOf(this.core, resultType);
    if (operand.stableKey && !expression.isSafe) this.flow.narrowed.set(operand.stableKey, type);
    const cast: Eval = expression.isSafe
      ? (frame) => {
          const value = evaluate(frame);
          return test(value) ? value : undefined;
        }
      : (frame) => {
          const value = evaluate(frame);
          if (!test(value)) throwCastFailure(frame, value, type);
          return value;
        };
    return { type: resultType, repr, eval: convertRepr(cast, 'ref', repr) };
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
    if (isBreak) loop.hasBreak = true;
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
    lambdaContext.info.isAtomic = false;
    if (isInline) lambdaContext.loops = [...context.loops];
    const lambdaScope = new Scope(scope, lambdaContext);
    const expectedParams = expected?.params;
    let params: { name: string | undefined; type: KType; row: number }[];
    if (lambda.params === undefined) {
      if (expectedParams && expectedParams.length > 1)
        this.error(lambda.row, `このラムダ式には引数が ${expectedParams.length} 個要ります。`);
      params =
        expectedParams && expectedParams.length === 1 ? [{ name: 'it', type: expectedParams[0], row: lambda.row }] : [];
    } else {
      if (expectedParams && expectedParams.length !== lambda.params.length)
        this.error(lambda.row, `このラムダ式には引数が ${expectedParams.length} 個要ります。`);
      params = lambda.params.map((param, index) => {
        const declared = param.type ? this.resolveType(scope, param.type) : undefined;
        const expectedType = expectedParams?.[index];
        if (!declared && !expectedType)
          this.error(param.row, `ラムダ式の引数 ${param.name ?? '_'} の型を書いてください。`);
        if (declared && expectedType && !isSubtype(expectedType, declared))
          this.error(param.row, typeMismatchMessage(declared, expectedType));
        return { name: param.name, type: declared ?? (expectedType as KType), row: param.row };
      });
    }
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
      expectedReturn && expectedReturn.kind !== 'variable' && !returnsUnit ? expectedReturn : undefined,
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
    const paramReprs = variables.map((variable) => reprOf(this.core, variable.type));
    const captureBuilder = this.captureBuilder(context, lambdaContext);
    const { info } = lambdaContext;
    const hasReceiver = receiverType !== undefined;
    const receiverIsUnboxed = hasReceiver && reprOf(this.core, receiverType) !== 'ref';
    const arity = params.length + (hasReceiver ? 1 : 0);
    const functionClass = this.core.function;
    const type: FunctionType = {
      kind: 'function',
      receiver: receiverType,
      params: params.map((param) => param.type),
      returnType: resultType,
      nullable: false,
    };
    return {
      type,
      repr: 'ref',
      eval: (frame) => {
        const env = captureBuilder(frame);
        const value = new KObject(functionClass, 0);
        value.env = env;
        value.function = {
          arity,
          call: (caller, args, callRow?: number) => {
            const receiver = hasReceiver ? unboxedIf(receiverIsUnboxed, args[0]) : undefined;
            const values = hasReceiver ? args.slice(1) : args;
            const converted = values.map((arg, index) => unboxedIf(paramReprs[index] !== 'ref', arg));
            return frame.runtime.call(info, caller, env, receiver, converted, callRow, resultEval);
          },
        };
        return value;
      },
    };
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

function unboxNumber(value: Value): number | bigint {
  return value instanceof Boxed ? value.value : (value as number | bigint);
}

function returnUnit(): Value {
  return UNIT;
}

/** Functions of the standard library's classes that this environment does not provide, by what they are for. */
const UNAVAILABLE_MEMBER_FUNCTIONS: Record<string, string> = {
  asSequence: 'シーケンス（asSequence）',
  toRegex: '正規表現（toRegex）',
  toSortedMap: '並べ替えた Map（toSortedMap）',
  toSortedSet: '並べ替えた Set（toSortedSet）',
};

/** The library's functions that collect their arguments, which only create objects when every argument does. */
const COLLECTION_FACTORIES = new Set(['arrayOf', 'listOf', 'mutableListOf', 'arrayListOf', 'setOf', 'mutableSetOf']);

const PROBE_PARAM = new (class extends Object {})() as unknown as TypeParameterSymbol;

const COMPARISON_TESTS: Record<'<' | '<=' | '>' | '>=', (order: number) => boolean> = {
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
};

const COMPARISON_IEEE: Record<'<' | '<=' | '>' | '>=', (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

function intersectNarrowing(a: Map<string, KType>, b: Map<string, KType>): Map<string, KType> {
  const result = new Map<string, KType>();
  for (const [key, type] of a) {
    const other = b.get(key);
    if (other && isSubtype(type, other) && isSubtype(other, type)) result.set(key, type);
  }
  return result;
}

/** Calls a function value with arguments held as references. */
export function invokeFunctionValue(frame: Frame, fn: KObject, args: Value[], callRow: number | undefined): Value {
  const { function: callable } = fn;
  if (!callable) throw new Error('A function value without its function');
  return (callable.call as (caller: Frame, args: Value[], callRow?: number) => Value)(frame, args, callRow);
}

function Flow_merge(flows: Flow[]): Flow {
  return Flow.merge(flows);
}

/** Function values receive their arguments boxed, while a parameter of a primitive type holds the bare value. */
function unboxedIf(unboxed: boolean, value: Value): Value {
  return unboxed && value instanceof Boxed ? value.value : value;
}
