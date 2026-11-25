// code-gauge-allow-file fileNcss -- The memberBinder module keeps one stage of the C# interpreter together.
import type { Argument, Expression, Initializer, MemberInitializer, Position, TypeNode } from './ast';
import type { TypeContext } from './binderBase';
import type { BoundArgument, BoundExpression, BoundInitializerEntry, BoundLValue, BoundMemberInit } from './bound';
import { type ArgumentInfo, CallBinder, type CallDescription, type ResolvedCall } from './callBinder';
import type { BindContext } from './convertBinder';
import { displayMethodIn } from './declarations';
import type { MethodCandidate } from './lookup';
import type { NamespaceSymbol } from './namespaces';
import type { FunctionScope } from './scopes';
import {
  displayMethod,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  FieldSymbol,
  isReferenceType,
  isValueType,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
  PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  TypeSymbol,
} from './types';
import { isKnownLibraryMember } from './unavailable';

/** What a name or member access denotes when it is not a value. */
export type NonValue =
  | { kind: 'namespaceRef'; path: string[]; namespaces: NamespaceSymbol[]; row: number }
  | { kind: 'typeRef'; type: Type; row: number }
  | {
      kind: 'methodGroup';
      name: string;
      candidates: MethodCandidate[];
      /** The receiver of instance methods, or undefined for a static access through a type. */
      receiver: BoundExpression | undefined;
      /** Whether the group came from a simple name, whose instance methods take `this` and static ones need none. */
      isSimpleName: boolean;
      typeArgs: Type[] | undefined;
      /** Extension methods for a receiver that no instance method fits. */
      extensions: MethodCandidate[];
      isBaseAccess: boolean;
      /** For `T.M()` on a type parameter, the parameter whose type argument implements the static abstract method. */
      constrainedType?: Type;
      row: number;
    }
  | { kind: 'discard'; row: number };

export type BindResult = BoundExpression | NonValue;

export function isNonValue(result: BindResult): result is NonValue {
  return (
    result.kind === 'namespaceRef' ||
    result.kind === 'typeRef' ||
    result.kind === 'methodGroup' ||
    result.kind === 'discard'
  );
}

/** Binds names, member accesses, calls, indexers, and object creation. */
export abstract class MemberBinder extends CallBinder {
  /** Set while binding a call's callee, whose member lookup leaves out members that cannot be called. */
  protected isBindingCallee = false;

  /** The local functions each function refers to, whose captures it must capture too, as their callers lend them. */
  private readonly localFunctionUses: { fn: FunctionScope; callee: MethodSymbol }[] = [];

  /** How each lambda and local function bound in the current member stores its list of captures. */
  private readonly captureLists: { fn: FunctionScope; store: (captures: LocalSymbol[]) => void }[] = [];

  /** Records how a lambda or local function stores its captures, which a later local-function use may add to. */
  protected recordCaptureList(fn: FunctionScope, store: (captures: LocalSymbol[]) => void): void {
    this.captureLists.push({ fn, store });
  }

  /**
   * Gives every function the captures of the local functions it refers to, transitively, once a member's functions
   * are all bound: a function that calls a local function capturing `total` passes `total`'s cell along, so it and
   * the functions around it up to `total`'s owner capture it as well.
   */
  protected propagateLocalFunctionCaptures(): Map<MethodSymbol, MethodSymbol[]> {
    let isChanged = true;
    while (isChanged) {
      isChanged = false;
      for (const { fn, callee } of this.localFunctionUses) {
        for (const local of callee.captures) if (captureUpToOwner(fn, local)) isChanged = true;
      }
      for (const { fn, store } of this.captureLists) store([...fn.captures]);
    }
    // The local functions each function calls, which their flow analysis needs analyzed first.
    const callees = new Map<MethodSymbol, MethodSymbol[]>();
    for (const { fn, callee } of this.localFunctionUses)
      callees.set(fn.method, [...(callees.get(fn.method) ?? []), callee]);
    this.localFunctionUses.length = 0;
    this.captureLists.length = 0;
    return callees;
  }

  /** Set while binding `nameof`'s argument, which names members without reading the properties on its way. */
  private isBindingName = false;

  /** Whether the member being looked up is called, which consumes the flag so that inner lookups do not see it. */
  protected takeCallee(): boolean {
    const isCallee = this.isBindingCallee;
    this.isBindingCallee = false;
    return isCallee;
  }

  /** Binds an expression to its natural type, leaving target-typed expressions unbound. */
  abstract bindExpression(node: Expression, context: BindContext): BindResult;

  /** Reports a value without a type of its own whose consumer gives it no target type either. */
  protected abstract reportWithoutNaturalType(
    value: Extract<BoundExpression, { kind: 'unbound' }>,
    position: Expression
  ): void;

  /**
   * Binds a value whose consumer gives it no target type, such as a `switch` or `foreach` operand: one without a type
   * of its own (a lambda, `default`, `new()`, or a conditional without a common type) takes its natural type, or gets
   * its kind's diagnostic and the error type, so that no unbound value reaches the evaluator.
   */
  protected bindTypedValue(node: Expression, context: BindContext): BoundExpression {
    return this.typedValue(this.bindValue(node, context), node);
  }

  /** Gives a bound value its natural type as bindTypedValue does. */
  protected typedValue(value: BoundExpression, node: Expression): BoundExpression {
    if (value.kind !== 'unbound') return value;
    const natural = this.naturalTypeOf(value);
    if (natural) return this.convert(value, natural, node);
    this.reportWithoutNaturalType(value, node);
    return { kind: 'default', type: ERROR_TYPE, row: node.row };
  }

  /**
   * Binds the value a deconstruction takes apart. A tuple literal's elements convert to the types of their targets
   * where the targets have them, as in `(x, s) = (1, null)`, and otherwise need types of their own.
   */
  protected deconstructedValue(
    node: Expression,
    context: BindContext,
    targetTypes: (Type | undefined)[] = []
  ): BoundExpression {
    const value = this.bindValue(node, context);
    if (value.kind !== 'unbound') return value;
    if (value.node.kind !== 'tuple') return this.typedValue(value, node);
    const types = value.node.elements.map((element, index): Type => {
      const target = targetTypes[index];
      if (target && target.kind !== 'error') return target;
      const typed = this.quietly(() => this.bindTypedValue(element.value, context));
      if (typed && typed.type.kind !== 'error') return typed.type;
      return this.bindTypedValue(element.value, context).type;
    });
    if (types.some((type) => type.kind === 'error')) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    return this.convert(value, this.tupleType(types), node);
  }

  /** The target of the `+=` or `-=` being bound, the one expression that may name an event outside its type. */
  protected subscriptionTarget: Expression | undefined;

  /** Whether the member being bound is the one that subscriptionTarget names. */
  private isEventSubscriptionTarget = false;

  /** Binds the member that a name or member access names, once its receiver is bound. */
  protected namingMemberOf<T>(node: Expression, bind: () => T): T {
    const saved = this.isEventSubscriptionTarget;
    this.isEventSubscriptionTarget = this.subscriptionTarget === node;
    try {
      return bind();
    } finally {
      this.isEventSubscriptionTarget = saved;
    }
  }

  /** Binds an expression as a value. */
  bindValue(node: Expression, context: BindContext): BoundExpression {
    const value = this.toValue(this.bindExpression(node, context), node);
    this.checkReadable(value, node, context);
    return value;
  }

  /** Reports a read of a property that has no getter, or whose getter the code may not use. */
  protected checkReadable(value: BoundExpression, position: Position, context: BindContext): void {
    if (value.kind !== 'property') return;
    for (let current: PropertySymbol | undefined = value.property; current; current = current.overridden) {
      if (current.getter) {
        this.checkAccessorUse(value, current, current.getter, 'get', position, context);
        return;
      }
    }
    this.error(
      position,
      'CS0154',
      `get アクセサーがないため、プロパティまたはインデクサー '${displayTypeSymbol(value.owner.symbol)}.${value.property.name}' をこのコンテキストで使用することはできません`
    );
  }

  /**
   * The one check of the accessor that a property or indexer read or write uses, which every binding site that reads
   * or writes one goes through: the library must implement it, and the code must be able to use it on the receiver,
   * where `base` goes through the class's own instance, which a protected accessor allows, unlike another object.
   */
  protected checkAccessorUse(
    target: Extract<BoundExpression, { kind: 'property' }>,
    property: PropertySymbol,
    accessor: MethodSymbol,
    kind: 'get' | 'set',
    position: Position,
    context: BindContext
  ): void {
    this.rejectUnimplementedAccessor(property, accessor, position);
    const isBase = (target.receiver as { isBase?: boolean } | undefined)?.isBase === true;
    const through = isBase ? undefined : target.receiver?.type;
    if (this.isAccessible(accessor.access, property.owner, context.fn.typeContext, through)) return;
    this.error(
      position,
      kind === 'get' ? 'CS0271' : 'CS0272',
      `${kind} アクセサーにアクセスできないため、プロパティまたはインデクサー '${propertyDisplay(target)}' はこのコンテキストでは使用できません`
    );
  }

  /** Rejects a library property's accessor that the library declares without implementing, as calls reject methods. */
  private rejectUnimplementedAccessor(property: PropertySymbol, accessor: MethodSymbol, position: Position): void {
    if (
      !property.owner.isLibrary ||
      property.owner.kind === 'interface' ||
      property.backingField ||
      property.isAbstract ||
      accessor.native
    )
      return;
    this.unsupported(position, `${displayTypeSymbol(property.owner)}.${property.name}`);
  }

  /** Binds an expression and converts it to a type. */
  bindAs(node: Expression, type: Type, context: BindContext): BoundExpression {
    return this.convert(this.bindValue(node, context), type, node);
  }

  /**
   * Binds a boolean expression (C# spec §12.25), the condition of an `if`, a loop, or `?:`: a value of a type without
   * an implicit conversion to bool is true by its type's `operator true`.
   */
  bindCondition(node: Expression, context: BindContext): BoundExpression {
    const value = this.bindValue(node, context);
    if (value.kind !== 'unbound' && value.type.kind !== 'error' && !this.implicitConversionOf(value, this.boolType)) {
      const truth = this.userOperator('op_True', [value], node.row);
      if (truth) return truth;
    }
    return this.convert(value, this.boolType, node);
  }

  /** Turns what a name denotes into a value, reporting a type, a namespace, or a method group used as a value. */
  toValue(result: BindResult, position: Position): BoundExpression {
    switch (result.kind) {
      case 'namespaceRef': {
        this.error(position, 'CS0118', `'${result.path.join('.')}' は 名前空間 ですが、変数 のように使用されています`);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      case 'typeRef': {
        this.error(
          position,
          'CS0119',
          `'${displayType(result.type)}' は 種類 です。これは特定のコンテンツでは無効になります`
        );
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      case 'methodGroup': {
        return {
          kind: 'unbound',
          node: { kind: 'name', name: result.name, typeArgs: undefined, ...position },
          context: undefined,
          methodGroup: result,
          type: ERROR_TYPE,
          row: position.row,
        };
      }
      case 'discard': {
        this.error(position, 'CS0103', `現在のコンテキストに '_' という名前は存在しません`);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      default: {
        return result;
      }
    }
  }

  /** The type that `this` has in the context, reporting where `this` is unavailable. */
  protected thisValue(context: BindContext, position: Position): BoundExpression {
    const { fn } = context;
    if (fn.isStatic || !fn.thisType) {
      this.error(
        position,
        'CS0026',
        "キーワード 'this' は、静的プロパティ、静的メソッド、または静的フィールド初期化子では無効です"
      );
      return { kind: 'this', type: ERROR_TYPE, row: position.row };
    }
    return { kind: 'this', type: fn.thisType, row: position.row };
  }

  /** Binds a simple name: a local, a member of an enclosing type, a type, or a namespace. */
  bindSimpleName(name: string, typeArgs: TypeNode[] | undefined, position: Position, context: BindContext): BindResult {
    const local = this.bindLocalName(name, typeArgs, position, context);
    if (local) return local;
    const typeContext = context.fn.typeContext;
    const isCallee = this.takeCallee();
    const resolvedTypeArgs = typeArgs?.map((arg) => this.resolveType(arg, typeContext));
    this.inaccessibleNestedType = undefined;
    const member = this.bindEnclosingMember(name, typeArgs, resolvedTypeArgs, isCallee, position, context);
    if (member) return member;
    const inaccessibleType = this.inaccessibleNestedType;
    const parameter = typeArgs ? undefined : typeParameterNamed(name, typeContext);
    if (parameter) return { kind: 'typeRef', type: parameter, row: position.row };
    const alias = typeArgs ? undefined : typeContext.aliases?.get(name);
    if (alias?.kind === 'type') return { kind: 'typeRef', type: alias.type, row: position.row };
    if (alias) return { kind: 'namespaceRef', path: alias.path, namespaces: alias.namespaces, row: position.row };
    const symbol = this.findTypeInScope(name, resolvedTypeArgs?.length ?? 0, typeContext);
    // A call leaves out a type that a using imports, which is not invocable, for a method that `using static` imports.
    const imported =
      !symbol || (isCallee && symbol.isLibrary)
        ? this.bindStaticImport(name, resolvedTypeArgs, isCallee, position, context)
        : undefined;
    if (imported?.kind === 'methodGroup' || (imported && !symbol)) return imported;
    if (symbol)
      return { kind: 'typeRef', type: this.construct(position, symbol, resolvedTypeArgs ?? []), row: position.row };
    const namespaces = this.namespacesAt([name]);
    if (namespaces.length > 0 && !typeArgs)
      return { kind: 'namespaceRef', path: [name], namespaces, row: position.row };
    if (name === '_' && !typeArgs) return { kind: 'discard', row: position.row };
    if (inaccessibleType) {
      this.error(
        position,
        'CS0122',
        `'${displayTypeSymbol(inaccessibleType)}' はアクセスできない保護レベルになっています`
      );
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    this.reportUndefinedName(name, position);
    return { kind: 'default', type: ERROR_TYPE, row: position.row };
  }

  /**
   * Binds a static member that `using static` imports: the methods of every imported type join one method group, and
   * extension methods stay out of it, as C# spec §14.5.4 says.
   */
  private bindStaticImport(
    name: string,
    typeArgs: Type[] | undefined,
    isCallee: boolean,
    position: Position,
    context: BindContext
  ): BindResult | undefined {
    const typeContext = context.fn.typeContext;
    const candidates: MethodCandidate[] = [];
    for (const type of typeContext.staticUsings ?? []) {
      const { found } = this.lookupMember(type, name, typeContext, typeArgs?.length ?? 0, isCallee);
      if (!found) continue;
      if (found.kind === 'methods') {
        candidates.push(
          ...found.candidates.filter((candidate) => candidate.method.isStatic && !candidate.method.isExtension)
        );
        continue;
      }
      if (candidates.length > 0) continue;
      if (found.kind === 'type')
        return {
          kind: 'typeRef',
          type: this.construct(position, found.symbol, [...found.outerArgs, ...(typeArgs ?? [])]),
          row: position.row,
        };
      const isStatic = found.kind === 'field' ? found.field.isStatic || found.field.isConst : found.property.isStatic;
      if (isStatic) return this.memberAccessOn(undefined, found, position, context);
    }
    if (candidates.length === 0) return undefined;
    return {
      kind: 'methodGroup',
      name,
      candidates,
      receiver: undefined,
      isSimpleName: true,
      typeArgs,
      extensions: [],
      isBaseAccess: false,
      row: position.row,
    };
  }

  /** Binds `alias::name`, which names a type or a namespace in the namespace the alias names. */
  protected bindAliasQualified(
    node: Extract<Expression, { kind: 'aliasQualified' }>,
    context: BindContext
  ): BindResult {
    const typeContext = context.fn.typeContext;
    const outer = this.aliasNamespaces(node.alias, node, typeContext);
    if (!outer) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const typeArgs = node.typeArgs?.map((arg) => this.resolveType(arg, typeContext)) ?? [];
    for (const namespace of outer.namespaces) {
      const type = namespace.findType(node.name, typeArgs.length);
      if (type) return { kind: 'typeRef', type: this.construct(node, type, typeArgs), row: node.row };
    }
    const path = [...outer.path, node.name];
    const namespaces = this.namespacesAt(path);
    if (namespaces.length > 0 && !node.typeArgs) return { kind: 'namespaceRef', path, namespaces, row: node.row };
    return {
      kind: 'typeRef',
      type: this.resolveType(
        {
          kind: 'aliasQualifiedType',
          alias: node.alias,
          name: node.name,
          typeArgs: node.typeArgs,
          row: node.row,
          column: node.column,
        },
        typeContext
      ),
      row: node.row,
    };
  }

  /** Binds a name that a local scope declares: a local, a local function, or a query's range variable. */
  private bindLocalName(
    name: string,
    typeArgs: TypeNode[] | undefined,
    position: Position,
    context: BindContext
  ): BindResult | undefined {
    const found = context.scope.lookup(name);
    // Only a generic local function takes type arguments, as `Id<int>(3)` does.
    if (typeArgs && !found?.localFunction) return undefined;
    if (found?.isDeclaredLater) {
      this.error(position, 'CS0841', `宣言する前にローカル変数 '${name}' を使用できません`);
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    if (found?.local) return this.localReference(found.local, position, context);
    if (found?.localFunction) {
      // A name in nameof calls nothing, so it crosses no static boundary.
      if (!this.isBindingName) this.rejectStaticReference(found.localFunction, found.scope.owner, position, context);
      this.localFunctionUses.push({ fn: context.fn, callee: found.localFunction });
      return {
        kind: 'methodGroup',
        name,
        candidates: [{ method: found.localFunction, owner: found.localFunction.owner.declaredType }],
        receiver: undefined,
        isSimpleName: true,
        typeArgs: typeArgs?.map((arg) => this.resolveType(arg, context.fn.typeContext)),
        extensions: [],
        isBaseAccess: false,
        row: position.row,
      };
    }
    return this.transparentMember(name, position, context);
  }

  /** A nested type that a simple name found but may not use, reported only when nothing else gives the name. */
  private inaccessibleNestedType: TypeSymbol | undefined;

  /** Binds a member of the enclosing types, from the innermost out, or a primary constructor's parameter. */
  private bindEnclosingMember(
    name: string,
    typeArgs: TypeNode[] | undefined,
    resolvedTypeArgs: Type[] | undefined,
    isCallee: boolean,
    position: Position,
    context: BindContext
  ): BindResult | undefined {
    const { fn } = context;
    const typeContext = fn.typeContext;
    for (let type = typeContext.type; type; type = type.containing) {
      const primary = !typeArgs && fn.kind !== 'initializer' ? this.primaryParameterField(type, name) : undefined;
      const lookup = this.lookupMember(
        this.instanceTypeOf(type, context),
        name,
        typeContext,
        resolvedTypeArgs?.length ?? 0,
        isCallee
      );
      // An inaccessible nested type is left out, so that an enclosing scope or a type in scope may still give the name.
      if (lookup.found?.kind === 'type' && !this.canUseNestedType(lookup.found.symbol, typeContext)) {
        this.inaccessibleNestedType ??= lookup.found.symbol;
        continue;
      }
      if (lookup.found) return this.memberOfEnclosing(lookup.found, type, resolvedTypeArgs, name, position, context);
      if (primary) return this.primaryParameterAccess(primary, position, context);
      if (lookup.inaccessible) {
        this.reportInaccessible(lookup.inaccessible, position);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
    }
    return undefined;
  }

  /**
   * A range variable of a query that a transparent identifier carries: a member of the anonymous object that the
   * query's lambda parameter holds, as `from x in xs let y = f(x)` makes `y` such a member.
   */
  private transparentMember(name: string, position: Position, context: BindContext): BoundExpression | undefined {
    for (let scope: typeof context.scope | undefined = context.scope; scope; scope = scope.parent) {
      for (const local of scope.variables.values()) {
        if (!local.isTransparent) continue;
        const { found } = this.lookupMember(local.type, name, context.fn.typeContext);
        if (found?.kind !== 'property') continue;
        return this.memberAccessOn(this.localReference(local, position, context), found, position, context);
      }
    }
    return undefined;
  }

  protected reportUndefinedName(name: string, position: Position): void {
    this.rejectUnavailableName(name, position);
    this.error(position, 'CS0103', `現在のコンテキストに '${name}' という名前は存在しません`);
  }

  /** Rejects a name of the .NET library that this grader does not provide. */
  protected abstract rejectUnavailableName(name: string, position: Position): void;

  /** The type to look members up in from inside a type, which is the type with its own type parameters. */
  private instanceTypeOf(type: TypeSymbol, context: BindContext): NamedType {
    const thisType = context.fn.thisType;
    if (thisType && thisType.symbol === type) return thisType;
    return type.declaredType;
  }

  /**
   * Rejects a reference from inside a static lambda or local function to a non-static local function declared outside
   * it, as Roslyn does whether or not that function captures anything.
   */
  private rejectStaticReference(
    callee: MethodSymbol,
    declaringFn: FunctionScope,
    position: Position,
    context: BindContext
  ): void {
    // The callee's own static modifier, which its declaration has before its body is bound.
    const declaration = callee.declaration as { modifiers?: { set: Set<string> } } | undefined;
    if (declaration?.modifiers?.set.has('static')) return;
    for (let fn: FunctionScope | undefined = context.fn; fn && fn !== declaringFn; fn = fn.outer) {
      if (!(fn.method as { isStaticLambda?: boolean }).isStaticLambda) continue;
      if (fn.kind === 'lambda')
        this.error(position, 'CS8820', `静的な匿名関数に '${callee.name}' への参照を含めることはできません。`);
      else this.error(position, 'CS8421', `静的なローカル関数に '${callee.name}' への参照を含めることはできません。`);
      return;
    }
  }

  /** A local variable, recording that a lambda or local function captures it from an enclosing function. */
  protected localReference(local: LocalSymbol, position: Position, context: BindContext): BoundExpression {
    // A local constant is its value, which any function may use, static ones included, without capturing it.
    if (local.isConst) {
      local.isUsed = true;
      return { kind: 'constant', value: local.constantValue, type: local.type, row: position.row };
    }
    if (local.owner && local.owner !== context.fn.method) {
      // A ref local refers to a variable of its method's frame, which a lambda may outlive.
      if (local.isRefLocal)
        this.error(
          position,
          'CS8175',
          `匿名メソッド、ラムダ式、クエリ式内で ref ローカル変数 '${local.name}' は使用できません`
        );
      local.isCaptured = true;
      for (let fn: typeof context.fn | undefined = context.fn; fn && fn.method !== local.owner; fn = fn.outer) {
        // A static lambda or local function, nested at any depth, may not capture an enclosing local.
        if ((fn.method as { isStaticLambda?: boolean }).isStaticLambda) {
          if (fn.kind === 'lambda')
            this.error(position, 'CS8820', `静的な匿名関数に '${local.name}' への参照を含めることはできません。`);
          else
            this.error(position, 'CS8421', `静的なローカル関数に '${local.name}' への参照を含めることはできません。`);
        }
        fn.captures.add(local);
      }
    }
    local.isUsed = true;
    return { kind: 'local', local, type: local.type, row: position.row };
  }

  private primaryParameterField(type: TypeSymbol, name: string): FieldSymbol | undefined {
    if (!type.primaryParameters?.some((parameter) => parameter.name === name)) return undefined;
    if (type.isRecord) return undefined;
    let field = type.fields.find((candidate) => candidate.isPrimaryParameter && candidate.name === `<${name}>P`);
    if (!field) {
      const parameter = type.primaryParameters.find((candidate) => candidate.name === name);
      field = new FieldSymbol(`<${name}>P`, parameter?.type ?? ERROR_TYPE, type);
      field.isPrimaryParameter = true;
      field.slot = type.instanceFieldCount++;
      type.fields.push(field);
    }
    return field;
  }

  private primaryParameterAccess(field: FieldSymbol, position: Position, context: BindContext): BoundExpression {
    const receiver = this.thisValue(context, position);
    return { kind: 'field', receiver, field, type: field.type, row: position.row };
  }

  /** A member found by a simple name in an enclosing type, which takes `this` when it is an instance member. */
  private memberOfEnclosing(
    found: NonNullable<ReturnType<MemberBinder['lookupMember']>['found']>,
    type: TypeSymbol,
    typeArgs: Type[] | undefined,
    name: string,
    position: Position,
    context: BindContext
  ): BindResult {
    const isOwnType = context.fn.typeContext.type === type;
    switch (found.kind) {
      case 'type': {
        return {
          kind: 'typeRef',
          type: this.construct(position, found.symbol, [...found.outerArgs, ...(typeArgs ?? [])]),
          row: position.row,
        };
      }
      case 'methods': {
        const hasInstance = found.candidates.some((candidate) => !candidate.method.isStatic);
        const receiver =
          hasInstance && !context.fn.isStatic && context.fn.thisType && isOwnType
            ? { kind: 'this' as const, type: context.fn.thisType, row: position.row }
            : undefined;
        return {
          kind: 'methodGroup',
          name,
          candidates: found.candidates,
          receiver,
          isSimpleName: true,
          typeArgs,
          extensions: [],
          isBaseAccess: false,
          row: position.row,
        };
      }
      default: {
        const member = found.kind === 'field' ? found.field : found.property;
        if (member.isStatic) return this.memberAccessOn(undefined, found, position, context);
        if (context.fn.isStatic || !context.fn.thisType || !isOwnType) {
          const display =
            found.kind === 'field'
              ? `${displayTypeSymbol(found.owner.symbol, found.owner.args)}.${member.name}`
              : `${displayTypeSymbol(found.owner.symbol, found.owner.args)}.${member.name}`;
          this.error(
            position,
            'CS0120',
            `静的でないフィールド、メソッド、またはプロパティ '${display}' で、オブジェクト参照が必要です`
          );
          return { kind: 'default', type: ERROR_TYPE, row: position.row };
        }
        return this.memberAccessOn(this.thisValue(context, position), found, position, context);
      }
    }
  }

  /** Reports a use of a member or type that `[Obsolete(message, true)]` makes an error (CS0619). */
  protected checkObsolete(member: MethodSymbol | FieldSymbol | PropertySymbol | TypeSymbol, position: Position): void {
    if (member.obsoleteError === undefined) return;
    const name =
      member instanceof MethodSymbol
        ? displayMethod(member)
        : member instanceof TypeSymbol
          ? displayTypeSymbol(member)
          : `${displayTypeSymbol(member.owner)}.${member.name}`;
    this.error(position, 'CS0619', `'${name}' は旧形式です ('${member.obsoleteError}')`);
  }

  /** A field or property of a receiver, or a static one when the receiver is undefined. */
  protected memberAccessOn(
    receiver: BoundExpression | undefined,
    found: Extract<NonNullable<ReturnType<MemberBinder['lookupMember']>['found']>, { kind: 'field' | 'property' }>,
    position: Position,
    context: BindContext
  ): BoundExpression {
    const substitution = substitutionOf(found.owner);
    this.checkObsolete(found.kind === 'field' ? found.field : found.property, position);
    if (found.kind === 'field') {
      const { field } = found;
      const type = substitute(field.type, substitution);
      if (field.isConst) return this.constantField(field, type, position);
      // An event with its own accessors has no delegate to read, inside its type or out.
      if (field.eventAccessors && !this.isEventSubscriptionTarget && !this.isBindingName) {
        this.error(
          position,
          'CS0079',
          `イベント '${displayTypeSymbol(field.owner)}.${field.name}' は += または -= の左側にのみ使用できます`
        );
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      // Outside its declaring type, an event may only be subscribed to or unsubscribed from.
      if (
        field.isEvent &&
        context.fn.typeContext.type !== field.owner &&
        !this.isEventSubscriptionTarget &&
        !this.isBindingName
      ) {
        const owner = displayTypeSymbol(field.owner);
        this.error(
          position,
          'CS0070',
          `イベント '${owner}.${field.name}' は、+= または -= の左側にのみ表示されます (型 '${owner}' 内で使用する場合を除きます)`
        );
      }
      if (field.isStatic) return { kind: 'staticField', field, owner: found.owner, type, row: position.row };
      return { kind: 'field', receiver: receiver as BoundExpression, field, type, row: position.row };
    }
    const { property } = found;
    const type = substitute(property.type, substitution);
    return { kind: 'property', receiver, property, args: [], owner: found.owner, type, row: position.row };
  }

  /** The value of a constant field, binding its initializer when it has not been bound yet. */
  protected abstract constantField(field: FieldSymbol, type: Type, position: Position): BoundExpression;

  /**
   * Reports a member that the code may not access: as CS1540 when a derived class reads a protected member through
   * an instance of a type that is not its own (`through`), and as CS0122 otherwise.
   */
  protected reportInaccessible(
    member: FieldSymbol | PropertySymbol | MethodSymbol,
    position: Position,
    through?: Type,
    within?: TypeSymbol
  ): void {
    const name =
      member instanceof FieldSymbol || member instanceof PropertySymbol
        ? `${displayTypeSymbol(member.owner)}.${member.name}`
        : displayMethod(member);
    if (member.access === 'protected' && within && through && this.derivesFrom(within, member.owner)) {
      this.error(
        position,
        'CS1540',
        `'${displayType(through)}' 型の修飾子をとおしてプロテクト メンバー '${name}' にアクセスすることはできません。修飾子は '${displayTypeSymbol(within)}' 型、またはそれから派生したものでなければなりません`
      );
      return;
    }
    this.error(position, 'CS0122', `'${name}' はアクセスできない保護レベルになっています`);
  }

  // code-gauge-allow functionNcss -- Each kind of target of a member access.
  /** Binds `target.name`, on a namespace, a type, or a value. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  bindMemberAccess(node: Extract<Expression, { kind: 'memberAccess' }>, context: BindContext): BindResult {
    const position = { row: node.nameRow, column: node.column };
    const typeArgs = node.typeArgs?.map((arg) => this.resolveType(arg, context.fn.typeContext));
    const arity = typeArgs?.length ?? 0;
    const isCallee = this.takeCallee();
    if (node.target.kind === 'base') return this.bindBaseAccess(node.name, typeArgs, position, context, isCallee);
    const target = this.bindExpression(node.target, context);
    if (target.kind === 'discard') return this.toValue(target, node);
    if (target.kind === 'namespaceRef') {
      for (const namespace of target.namespaces) {
        const type = namespace.findType(node.name, arity);
        if (type) return { kind: 'typeRef', type: this.construct(position, type, typeArgs ?? []), row: node.row };
      }
      const path = [...target.path, node.name];
      const inner = this.namespacesAt(path);
      if (inner.length > 0) return { kind: 'namespaceRef', path, namespaces: inner, row: node.row };
      this.rejectUnavailableName(path.join('.'), position);
      this.error(
        position,
        'CS0234',
        `型または名前空間の名前 '${node.name}' が名前空間 '${target.path.join('.')}' に存在しません (アセンブリ参照があることを確認してください)`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (target.kind === 'typeRef')
      return this.namingMemberOf(node, () =>
        this.bindStaticMember(target.type, node.name, typeArgs, position, context, isCallee)
      );
    const receiver = target.kind === 'methodGroup' ? this.toValue(target, node.target) : target;
    // A property that a member is accessed on is read, as any value is, except in a name.
    if (!this.isBindingName) this.checkReadable(receiver, node.target, context);
    // A member is looked up on the receiver's own type, which a conditional without a common type lacks.
    if (receiver.kind === 'unbound' && receiver.node.kind === 'conditional') {
      this.reportConditionalWithoutType(receiver.node);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (receiver.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (receiver.kind === 'unbound' || receiver.type.kind === 'null' || receiver.type.kind === 'void') {
      this.error(
        position,
        'CS0023',
        `演算子 '.' は '${receiver.kind === 'unbound' ? (receiver.methodGroup ? 'メソッド グループ' : 'ラムダ式') : displayType(receiver.type)}' 型のオペランドに適用できません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (this.namesItsType(node.target, receiver, node.name, context))
      return this.namingMemberOf(node, () =>
        this.bindStaticMember(receiver.type as NamedType, node.name, typeArgs, position, context, isCallee)
      );
    return this.namingMemberOf(node, () =>
      this.bindInstanceMember(receiver, node.name, typeArgs, position, context, isCallee)
    );
  }

  /**
   * Whether `Color.Red` names a static member of the type `Color` though `Color` is also a property or variable of
   * that type, as C# allows (spec §12.8.7.2, "Color Color").
   */
  private namesItsType(target: Expression, receiver: BoundExpression, name: string, context: BindContext): boolean {
    if (target.kind !== 'name' || receiver.type.kind !== 'named' || receiver.type.symbol.name !== target.name)
      return false;
    const { found } = this.lookupMember(receiver.type, name, context.fn.typeContext);
    if (found?.kind === 'field') return found.field.isStatic || found.field.isConst;
    if (found?.kind === 'property') return found.property.isStatic;
    if (found?.kind === 'methods') return found.candidates.every((candidate) => candidate.method.isStatic);
    return found?.kind === 'type';
  }

  private bindBaseAccess(
    name: string,
    typeArgs: Type[] | undefined,
    position: Position,
    context: BindContext,
    isCallee = false
  ): BindResult {
    const thisType = context.fn.thisType;
    if (context.fn.isStatic || !thisType) {
      this.error(position, 'CS1511', "キーワード 'base' は静的メソッドでは使用できません");
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    const baseType = thisType.symbol.baseType
      ? (substitute(thisType.symbol.baseType, substitutionOf(thisType)) as NamedType)
      : this.objectType;
    // The receiver is the class's own instance seen as its base, which protected members of the base allow.
    const receiver = { kind: 'this', type: baseType, row: position.row, isBase: true } as BoundExpression;
    const result = this.bindInstanceMember(receiver, name, typeArgs, position, context, isCallee);
    if (result.kind === 'methodGroup') return { ...result, isBaseAccess: true };
    return result;
  }

  /** Binds a static member of a type, or a nested type. */
  bindStaticMember(
    type: Type,
    name: string,
    typeArgs: Type[] | undefined,
    position: Position,
    context: BindContext,
    isCallee = false
  ): BindResult {
    if (type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: position.row };
    if (type.kind === 'typeParameter') {
      const constrained = this.bindConstrainedMember(type, name, typeArgs, position, context, isCallee);
      if (constrained) return constrained;
      this.error(
        position,
        'CS0704',
        `'${displayType(type)}' で非 virtual メンバー参照を実行できません。これは型パラメーターであるためです`
      );
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    const { found, inaccessible } = this.lookupMember(
      type,
      name,
      context.fn.typeContext,
      typeArgs?.length ?? 0,
      isCallee
    );
    if (!found) {
      if (inaccessible) {
        this.reportInaccessible(inaccessible, position);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      if (isCallee && this.reportNonInvocable(type, name, position, context)) {
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      this.rejectUnknownLibraryMember(type, name, position);
      this.error(position, 'CS0117', `'${displayType(type)}' に '${name}' の定義がありません`);
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    if (found.kind === 'type') {
      if (!this.canUseNestedType(found.symbol, context.fn.typeContext))
        this.reportInaccessibleType(position, found.symbol);
      return {
        kind: 'typeRef',
        type: this.construct(position, found.symbol, [...found.outerArgs, ...(typeArgs ?? [])]),
        row: position.row,
      };
    }
    if (found.kind === 'methods') {
      return {
        kind: 'methodGroup',
        name,
        candidates: found.candidates,
        receiver: undefined,
        isSimpleName: false,
        typeArgs,
        extensions: [],
        isBaseAccess: false,
        row: position.row,
      };
    }
    const member = found.kind === 'field' ? found.field : found.property;
    if (!member.isStatic) {
      this.error(
        position,
        'CS0120',
        `静的でないフィールド、メソッド、またはプロパティ '${displayTypeSymbol(found.owner.symbol, found.owner.args)}.${member.name}' で、オブジェクト参照が必要です`
      );
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    return this.memberAccessOn(undefined, found, position, context);
  }

  /**
   * Binds `T.M()` or `T.P` on a type parameter to a static abstract or virtual member of its constraint interfaces
   * (C# spec §19.4.4), which the type argument's implementation answers at run time.
   */
  private bindConstrainedMember(
    type: Extract<Type, { kind: 'typeParameter' }>,
    name: string,
    typeArgs: Type[] | undefined,
    position: Position,
    context: BindContext,
    isCallee: boolean
  ): BindResult | undefined {
    const { found } = this.lookupMember(type, name, context.fn.typeContext, typeArgs?.length ?? 0, isCallee);
    if (found?.kind === 'methods') {
      const candidates = found.candidates.filter((candidate) => isConstrained(candidate.method));
      if (candidates.length === 0) return undefined;
      return {
        kind: 'methodGroup',
        name,
        candidates,
        receiver: undefined,
        isSimpleName: false,
        typeArgs,
        extensions: [],
        isBaseAccess: false,
        constrainedType: type,
        row: position.row,
      };
    }
    if (found?.kind === 'property' && isConstrained(found.property)) {
      const access = this.memberAccessOn(undefined, found, position, context);
      return { ...access, constrainedType: type } as BoundExpression;
    }
    return undefined;
  }

  /**
   * Reports a call of a field or a property, such as `s.Length()`, which the invoked lookup leaves out, naming the
   * member by the type that declares it, as `Array.Length`.
   */
  private reportNonInvocable(type: Type, name: string, position: Position, context: BindContext): boolean {
    const found = this.lookupMember(type, name, context.fn.typeContext).found;
    if (found?.kind !== 'field' && found?.kind !== 'property') return false;
    this.error(
      position,
      'CS1955',
      `実行不可能なメンバー '${displayTypeSymbol(found.owner.symbol, found.owner.args)}.${name}' をメソッドのように使用することはできません。`
    );
    return true;
  }

  /** Rejects a member that .NET's library type has but this grader's does not. */
  protected rejectUnknownLibraryMember(type: Type, name: string, position: Position): void {
    const symbol =
      type.kind === 'named' ? type.symbol : type.kind === 'array' ? this.wellKnown.array.symbol : undefined;
    if (!symbol?.isLibrary) return;
    for (let current: TypeSymbol | undefined = symbol; current; current = current.baseType?.symbol) {
      if (isKnownLibraryMember(current.fullName, name))
        this.unsupported(position, `${displayTypeSymbol(current)}.${name}`);
    }
  }

  /** An access that failed to bind, which keeps its receiver so that flow analysis still sees the receiver read. */
  protected failedAccess(receiver: BoundExpression, position: Position): BoundExpression {
    return {
      kind: 'sequence',
      locals: [],
      sideEffects: [receiver],
      value: { kind: 'default', type: ERROR_TYPE, row: position.row },
      type: ERROR_TYPE,
      row: position.row,
    };
  }

  /** Binds an instance member of a value, or an extension method that takes it. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  bindInstanceMember(
    receiver: BoundExpression,
    name: string,
    typeArgs: Type[] | undefined,
    position: Position,
    context: BindContext,
    isCallee = false
  ): BindResult {
    const type = receiver.type;
    const isBase = (receiver as { isBase?: boolean }).isBase === true;
    const { found, inaccessible } = this.lookupMember(
      type,
      name,
      context.fn.typeContext,
      typeArgs?.length ?? 0,
      isCallee,
      isBase && context.fn.thisType ? context.fn.thisType : type
    );
    const extensions = this.lookupExtensionMethods(name, context.fn.typeContext);
    if (!found) {
      if (extensions.length > 0) {
        return {
          kind: 'methodGroup',
          name,
          candidates: [],
          receiver,
          isSimpleName: false,
          typeArgs,
          extensions,
          isBaseAccess: false,
          row: position.row,
        };
      }
      if (inaccessible) {
        this.reportInaccessible(inaccessible, position, type, context.fn.typeContext.type);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      if (isCallee && this.reportNonInvocable(type, name, position, context))
        return this.failedAccess(receiver, position);
      this.rejectUnknownLibraryMember(type, name, position);
      this.error(
        position,
        'CS1061',
        `'${displayType(type)}' に '${name}' の定義が含まれておらず、型 '${displayType(type)}' の最初の引数を受け付けるアクセス可能な拡張メソッド '${name}' が見つかりませんでした。using ディレクティブまたはアセンブリ参照が不足していないことを確認してください`
      );
      return this.failedAccess(receiver, position);
    }
    if (found.kind === 'type') {
      this.error(
        position,
        'CS0572',
        `'${name}': 式から型を参照することはできません。'${displayTypeSymbol(found.symbol)}' を使用してください`
      );
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    if (found.kind === 'methods') {
      // Static methods do not apply to an instance, which then calls an extension method of the name, as
      // `array.Reverse()` calls Enumerable.Reverse rather than Array.Reverse; with none, the call or the conversion
      // reports the static method it chose.
      const instance = found.candidates.filter((candidate) => !candidate.method.isStatic);
      return {
        kind: 'methodGroup',
        name,
        candidates: instance.length === 0 && extensions.length === 0 ? found.candidates : instance,
        receiver,
        isSimpleName: false,
        typeArgs,
        extensions,
        isBaseAccess: false,
        row: position.row,
      };
    }
    const member = found.kind === 'field' ? found.field : found.property;
    if (member.isStatic) {
      this.error(
        position,
        'CS0176',
        `インスタンス参照でメンバー '${displayTypeSymbol(found.owner.symbol, found.owner.args)}.${member.name}' にアクセスできません。代わりに型名を使用してください`
      );
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    return this.memberAccessOn(receiver, found, position, context);
  }

  /** Binds the arguments of a call to their natural types, leaving lambdas and `out var` for overload resolution. */
  bindArguments(args: Argument[], context: BindContext): ArgumentInfo[] {
    return args.map((arg) => {
      if (arg.modifier === 'out' && arg.value.kind === 'declaration') return this.outDeclaration(arg, context);
      if (arg.modifier === 'out' && arg.value.kind === 'name' && arg.value.name === '_' && !context.scope.lookup('_')) {
        return {
          expression: { kind: 'default', type: ERROR_TYPE, row: arg.row },
          name: arg.name,
          refKind: 'out',
          row: arg.row,
          target: undefined,
          isOutVar: true,
          declareOut: (type) => ({ kind: 'discard', type, row: arg.row }),
        };
      }
      if (arg.modifier === 'ref' || arg.modifier === 'out') {
        const target = this.bindLValue(arg.value, context, arg.modifier === 'out' ? 'out' : 'ref');
        const expression: BoundExpression =
          target.kind === 'discard' ? { kind: 'default', type: target.type, row: arg.row } : target;
        const info: ArgumentInfo = { expression, name: arg.name, refKind: arg.modifier, row: arg.row, target };
        return info;
      }
      // An `in` argument passes its variable by reference, which this grader passes by value: the callee cannot assign
      // it, so only the caller's variable changing during the call, through a lambda, could tell the two apart.
      return {
        expression: this.bindValue(arg.value, context),
        name: arg.name,
        refKind: undefined,
        row: arg.row,
        target: undefined,
        text: arg.text,
      };
    });
  }

  /** An `out var x` or `out T x` argument, whose variable the call declares. */
  private outDeclaration(arg: Argument, context: BindContext): ArgumentInfo {
    const declaration = arg.value as Extract<Expression, { kind: 'declaration' }>;
    const designation = declaration.designation;
    const isVar = declaration.type.kind === 'varType';
    const declaredType = isVar ? undefined : this.resolveType(declaration.type, context.fn.typeContext);
    const declare = (type: Type): BoundLValue => {
      if (designation.kind !== 'single') return { kind: 'discard', type, row: arg.row };
      const local = this.declareLocal(designation.name, declaredType ?? type, designation, context);
      return { kind: 'local', local, type: local.type, row: arg.row };
    };
    if (declaredType) {
      const placeholder: BoundExpression = { kind: 'default', type: declaredType, row: arg.row };
      return {
        expression: placeholder,
        name: arg.name,
        refKind: 'out',
        row: arg.row,
        target: undefined,
        declareOut: declare,
        isOutVar: false,
      };
    }
    return {
      expression: { kind: 'default', type: ERROR_TYPE, row: arg.row },
      name: arg.name,
      refKind: 'out',
      row: arg.row,
      target: undefined,
      declareOut: declare,
      isOutVar: true,
    };
  }

  /** Declares a local in the current scope, reporting names that clash with others in scope. */
  abstract declareLocal(name: string, type: Type, position: Position, context: BindContext): LocalSymbol;

  /** Binds an expression as storage that an assignment or a `ref` argument writes. */
  abstract bindLValue(node: Expression, context: BindContext, use: 'assign' | 'ref' | 'out' | 'compound'): BoundLValue;

  /** Converts a method group to a delegate type, choosing the overload that its parameters select. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  protected bindMethodGroupConversion(
    group: Extract<NonValue, { kind: 'methodGroup' }>,
    target: Type,
    report: boolean,
    row: number
  ): BoundExpression | undefined {
    const invoke = this.delegateInvokeOf(target);
    if (!invoke) {
      if (report && target.kind !== 'error')
        this.error(
          row,
          'CS0428',
          `メソッド グループ '${group.name}' を非デリゲート型 '${displayType(target)}' に変換することはできません。このメソッドを呼び出しますか?`
        );
      return undefined;
    }
    const resolved = this.resolveDelegateOverload(group, invoke, row);
    if (!resolved) {
      if (report)
        this.error(
          row,
          'CS0123',
          `デリゲート '${displayType(target)}' に一致する '${group.name}' のオーバーロードはありません`
        );
      return undefined;
    }
    const method = resolved.candidate.method;
    const returnType =
      this.covariantReturn(group, method) ??
      substitute(method.returnType, this.callSubstitution(resolved.candidate, resolved.typeArgs));
    const returnsMatch =
      (returnType.kind === 'void' && invoke.returnType.kind === 'void') ||
      (returnType.kind !== 'void' &&
        invoke.returnType.kind !== 'void' &&
        (sameType(returnType, invoke.returnType) ||
          (isReferenceType(returnType) && this.conversions.isReferenceConvertible(returnType, invoke.returnType))));
    if (!returnsMatch) {
      if (report)
        this.error(
          row,
          'CS0407',
          `'${displayType(returnType)} ${displayTypeSymbol(method.owner)}.${method.name}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})' には、不適切な戻り値の型が指定されています`
        );
      return undefined;
    }
    if (!method.isStatic && !group.receiver && method.kind !== 'localFunction') {
      if (report)
        this.error(
          row,
          'CS0120',
          `静的でないフィールド、メソッド、またはプロパティ '${displayTypeSymbol(method.owner)}.${method.name}' で、オブジェクト参照が必要です`
        );
      return undefined;
    }
    if (
      method.isStatic &&
      group.receiver &&
      !group.isSimpleName &&
      !method.isExtension &&
      method.kind !== 'localFunction'
    ) {
      if (report)
        this.error(
          row,
          'CS0176',
          `インスタンス参照でメンバー '${displayMethodIn(method, resolved.candidate.owner)}' にアクセスできません。代わりに型名を使用してください`
        );
      return undefined;
    }
    const isVirtual =
      !group.isBaseAccess &&
      (method.isVirtual || method.isAbstract || method.isOverride || method.owner.kind === 'interface');
    return {
      kind: 'newDelegate',
      method,
      receiver: method.isStatic && !method.isExtension ? undefined : group.receiver,
      typeArgs: resolved.typeArgs,
      owner: resolved.candidate.owner,
      isVirtual,
      type: target,
      row,
    };
  }

  /** Chooses the overload of a method group that a delegate's parameters select, reporting nothing. */
  private resolveDelegateOverload(
    group: Extract<NonValue, { kind: 'methodGroup' }>,
    invoke: { parameterTypes: Type[]; refKinds: ('ref' | 'out' | 'in' | undefined)[] },
    row: number
  ): ResolvedCall | undefined {
    const args: ArgumentInfo[] = invoke.parameterTypes.map((type, index) => ({
      expression: { kind: 'default', type, row },
      name: undefined,
      refKind: invoke.refKinds[index],
      row,
      target: undefined,
    }));
    const saved = this.diagnostics.length;
    // A delegate passes exactly its own arguments: no optional parameter is left out, no params array expands, and
    // each argument goes as it is, which a method that is not generic shows before overload resolution chooses.
    let candidates = group.candidates.filter(
      (candidate) =>
        candidate.method.parameters.length === invoke.parameterTypes.length &&
        (candidate.method.typeParameters.length > 0 ||
          this.takesDelegateArguments({ candidate, typeArgs: [], args: [] }, invoke.parameterTypes, invoke.refKinds))
    );
    let resolved: ResolvedCall | undefined;
    // A generic method shows it only once its type arguments are inferred: one that cannot gives way to the others.
    while (candidates.length > 0) {
      resolved = this.resolveCall(candidates, args, group.typeArgs, row, { name: group.name, kind: 'method' });
      if (!resolved || this.takesDelegateArguments(resolved, invoke.parameterTypes, invoke.refKinds)) break;
      const rejected = resolved.candidate;
      candidates = candidates.filter((candidate) => candidate !== rejected);
      resolved = undefined;
    }
    if (!resolved && group.extensions.length > 0 && group.receiver) {
      this.diagnostics.length = saved;
      resolved = this.resolveCall(
        group.extensions,
        [{ expression: group.receiver, name: undefined, refKind: undefined, row, target: undefined }, ...args],
        group.typeArgs,
        row,
        { name: group.name, kind: 'method', isExtension: true }
      );
    }
    this.diagnostics.length = saved;
    if (resolved && !this.takesDelegateArguments(resolved, invoke.parameterTypes, invoke.refKinds)) return undefined;
    return resolved;
  }

  /** Binds a call: of a method group, a delegate, or `nameof`. */
  bindInvocation(node: Extract<Expression, { kind: 'invocation' }>, context: BindContext): BoundExpression {
    if (node.target.kind === 'name' && node.target.name === 'nameof' && !context.scope.lookup('nameof'))
      return this.bindNameof(node, context);
    this.isBindingCallee = true;
    const target = this.bindExpression(node.target, context);
    this.isBindingCallee = false;
    const args = this.bindArguments(node.args, context);
    if (target.kind === 'methodGroup') return this.invokeMethodGroup(target, args, node);
    if (target.kind === 'typeRef' || target.kind === 'namespaceRef' || target.kind === 'discard') {
      if (target.kind === 'typeRef') {
        // Roslyn names the type by its definition, as `List<T>`.
        const shown = target.type.kind === 'named' ? displayTypeSymbol(target.type.symbol) : displayType(target.type);
        this.error(
          node.target,
          'CS1955',
          `実行不可能なメンバー '${shown}' をメソッドのように使用することはできません。`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      this.toValue(target, node.target);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (target.type.kind === 'error') return this.failedAccess(target, node);
    this.checkReadable(target, node.target, context);
    const invoke = this.delegateInvokeOf(target.type);
    if (!invoke) {
      this.error(node.target, 'CS0149', 'メソッド名が必要です');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const delegateSymbol = (target.type as NamedType).symbol;
    const resolved = this.resolveCall(
      [{ method: delegateSymbol.invoke as MethodSymbol, owner: target.type as NamedType }],
      args,
      undefined,
      node.row,
      { name: displayType(target.type), kind: 'delegate' }
    );
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    return { kind: 'invokeDelegate', target, args: resolved.args, type: invoke.returnType, row: node.row };
  }

  private bindNameof(node: Extract<Expression, { kind: 'invocation' }>, context: BindContext): BoundExpression {
    const [arg] = node.args;
    if (node.args.length !== 1) {
      this.error(node, 'CS1501', `引数 ${node.args.length} を指定するメソッド 'nameof' のオーバーロードはありません`);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const value = arg.value;
    const name =
      value.kind === 'name'
        ? value.name
        : value.kind === 'memberAccess'
          ? value.name
          : value.kind === 'predefinedTypeName'
            ? undefined
            : undefined;
    if (!name) {
      this.error(arg, 'CS8081', '式に名前がありません。');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    this.isBindingName = true;
    try {
      this.bindExpression(value, context);
    } finally {
      this.isBindingName = false;
    }
    return this.constant(name, this.stringType, node.row);
  }

  /** Calls the best method of a group, falling back to extension methods when no instance method applies. */
  invokeMethodGroup(
    group: Extract<NonValue, { kind: 'methodGroup' }>,
    args: ArgumentInfo[],
    node: Position
  ): BoundExpression {
    const description: CallDescription = { name: group.name, kind: 'method' };
    if (group.candidates.length > 0) {
      const saved = this.diagnostics.length;
      const canFallBack = group.extensions.length > 0 && group.receiver !== undefined;
      const resolved = this.resolveCall(group.candidates, args, group.typeArgs, node.row, description);
      if (resolved) return this.callNode(group, resolved, node);
      if (!canFallBack) return this.failedCall(group.candidates, args, node);
      this.diagnostics.length = saved;
    }
    const receiver = group.receiver as BoundExpression;
    const isVariable =
      ['local', 'field', 'staticField', 'element'].includes(receiver.kind) ||
      (receiver.kind === 'this' && isValueType(receiver.type));
    const receiverArg: ArgumentInfo = {
      expression: receiver,
      name: undefined,
      refKind: undefined,
      row: receiver.row,
      target: isVariable ? (receiver as BoundLValue) : undefined,
      isReceiver: true,
    };
    const resolved = this.resolveCall(group.extensions, [receiverArg, ...args], group.typeArgs, node.row, {
      ...description,
      isExtension: true,
    });
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    return this.callNode({ ...group, receiver: undefined }, resolved, node);
  }

  /** A call whose arguments fit no candidate, which keeps the arguments for the flow analysis to read, as Roslyn's does. */
  private failedCall(candidates: MethodCandidate[], args: ArgumentInfo[], node: Position): BoundExpression {
    const type = this.failedCallType(candidates);
    const value: BoundExpression = { kind: 'default', failedCall: true, type, row: node.row };
    return { kind: 'sequence', locals: [], sideEffects: args.map((arg) => arg.expression), value, type, row: node.row };
  }

  /**
   * The type of a call whose arguments fit no candidate: a single candidate's non-generic return type, which Roslyn
   * keeps so that the later uses of the result are checked, and otherwise the error type.
   */
  private failedCallType(candidates: MethodCandidate[]): Type {
    if (candidates.length !== 1 || candidates[0].method.typeParameters.length > 0) return ERROR_TYPE;
    const [{ method, owner }] = candidates;
    // A void result has no later use, and an error type keeps the statement from reporting it as no statement.
    if (method.returnType.kind === 'void') return ERROR_TYPE;
    return substitute(method.returnType, substitutionOf(owner));
  }

  /** The call node for a resolved method, checking that an instance method has a receiver. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  protected callNode(
    group: Extract<NonValue, { kind: 'methodGroup' }>,
    resolved: ResolvedCall,
    node: Position
  ): BoundExpression {
    const declared = resolved.candidate.method;
    // `base.M()` calls the implementation that the base class has, which may override the method found by name.
    const method =
      group.isBaseAccess && group.receiver ? this.implementationIn(group.receiver.type, declared) : declared;
    this.checkObsolete(method, node);
    const substitution = this.callSubstitution(resolved.candidate, resolved.typeArgs);
    const returnType = this.covariantReturn(group, method) ?? substitute(method.returnType, substitution);
    const constrained = group.constrainedType ? { constrainedType: group.constrainedType } : {};
    let receiver = method.isStatic ? undefined : group.receiver;
    if (!method.isStatic && !receiver && method.kind !== 'localFunction') {
      this.error(
        node,
        'CS0120',
        `静的でないフィールド、メソッド、またはプロパティ '${displayMethodIn(method, resolved.candidate.owner)}' で、オブジェクト参照が必要です`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (
      method.isStatic &&
      group.receiver &&
      !group.isSimpleName &&
      method.kind !== 'localFunction' &&
      !method.isExtension
    ) {
      this.error(
        node,
        'CS0176',
        `インスタンス参照でメンバー '${displayMethodIn(method, resolved.candidate.owner)}' にアクセスできません。代わりに型名を使用してください`
      );
    }
    if (method.isAbstract && group.isBaseAccess) {
      this.error(
        node,
        'CS0205',
        `抽象基本メンバーを呼び出すことはできません:'${displayMethodIn(method, resolved.candidate.owner)}'`
      );
    }
    if (!method.native && method.owner.isLibrary && !method.isAbstract && method.kind !== 'delegateInvoke')
      this.unsupported(node, `${displayTypeSymbol(method.owner)}.${method.name}`);
    if (
      receiver &&
      receiver.kind !== 'this' &&
      nullableUnderlying(receiver.type) &&
      method.owner !== this.wellKnown.nullable &&
      // `ToString`, `Equals`, and `GetHashCode` run on the nullable value itself, which Nullable<T> overrides.
      !this.wellKnown.nullable.methods.some((override) => override.isOverride && override.name === method.name)
    ) {
      receiver = this.convert(receiver, this.objectType, node);
    }
    const isVirtual =
      !group.isBaseAccess &&
      (method.isVirtual || method.isAbstract || method.isOverride || method.owner.kind === 'interface');
    return {
      kind: 'call',
      method,
      receiver,
      args: resolved.args,
      typeArgs: resolved.typeArgs,
      owner: resolved.candidate.owner,
      isVirtual,
      type: returnType,
      ...constrained,
      row: node.row,
    };
  }

  /**
   * Whether a method takes a delegate's arguments as they are: each converts to its parameter by identity or an
   * implicit reference conversion, as the delegate passes them unconverted, with the same passing mode (C# spec §10.8).
   */
  private takesDelegateArguments(
    resolved: ResolvedCall,
    argumentTypes: Type[],
    refKinds: ('ref' | 'out' | 'in' | undefined)[]
  ): boolean {
    const { method } = resolved.candidate;
    const parameters = method.isExtension ? method.parameters.slice(1) : method.parameters;
    if (parameters.length !== argumentTypes.length) return false;
    const substitution = this.callSubstitution(resolved.candidate, resolved.typeArgs);
    return parameters.every((parameter, index) => {
      if (parameter.refKind !== refKinds[index]) return false;
      const parameterType = substitute(parameter.type, substitution);
      const argumentType = argumentTypes[index];
      return (
        sameType(parameterType, argumentType) ||
        (isReferenceType(argumentType) && this.conversions.isReferenceConvertible(argumentType, parameterType))
      );
    });
  }

  /**
   * The return type of the most derived override that the receiver's static type has, which a call gets when an
   * override returns a more derived reference type (C# 9 covariant returns); undefined to use the method's own.
   */
  private covariantReturn(group: Extract<NonValue, { kind: 'methodGroup' }>, method: MethodSymbol): Type | undefined {
    if (!group.receiver || method.isStatic || !(method.isVirtual || method.isAbstract || method.isOverride))
      return undefined;
    const override = this.implementationIn(group.receiver.type, method);
    // A generic class's override would need its own type arguments, which introductory programs do not combine with this.
    if (override === method || override.owner.typeParameters.length > 0) return undefined;
    return sameType(override.returnType, method.returnType) ? undefined : override.returnType;
  }

  /** The override of a virtual method that a type or its nearest base declares, for a non-virtual `base` call. */
  protected implementationIn(type: Type, method: MethodSymbol): MethodSymbol {
    if (!(method.isVirtual || method.isAbstract || method.isOverride)) return method;
    for (const owner of this.searchChain(type)) {
      for (const candidate of owner.symbol.methods) {
        for (let current: MethodSymbol | undefined = candidate; current; current = current.overridden) {
          if (current === method && candidate.name === method.name) return candidate;
        }
      }
    }
    return method;
  }

  /** Binds a user-defined operator call among candidates, if one applies. */
  protected bindOperatorCall(
    candidates: MethodCandidate[],
    operands: BoundExpression[],
    row: number
  ): BoundExpression | undefined {
    const args: ArgumentInfo[] = operands.map((operand) => ({
      expression: operand,
      name: undefined,
      refKind: undefined,
      row,
      target: undefined,
    }));
    const applicable = candidates.filter(
      (candidate) =>
        candidate.method.parameters.length === operands.length &&
        operands.every(
          (operand, index) =>
            this.implicitConversionOf(operand, this.operatorParameterType(candidate, index)) !== undefined
        )
    );
    if (applicable.length === 0) return undefined;
    const resolved = this.resolveCall(applicable, args, undefined, row, {
      name: candidates[0].method.name,
      kind: 'operator',
    });
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row };
    const method = resolved.candidate.method;
    // An interface's static abstract operator runs the one that the operand's type argument implements.
    const constrainedType =
      method.owner.kind === 'interface'
        ? operands.find((operand) => operand.type.kind === 'typeParameter')?.type
        : undefined;
    return {
      kind: 'call',
      method,
      receiver: undefined,
      args: resolved.args,
      typeArgs: [],
      owner: resolved.candidate.owner,
      isVirtual: false,
      type: substitute(method.returnType, substitutionOf(resolved.candidate.owner)),
      ...(constrainedType ? { constrainedType } : {}),
      row,
    };
  }

  /** Binds `target[args]`: an array element, or an indexer of the target's type. */
  bindElementAccess(
    target: BoundExpression,
    argNodes: Argument[],
    node: Position,
    context: BindContext
  ): BoundExpression {
    if (target.type.kind === 'error') {
      for (const arg of argNodes) this.bindValue(arg.value, context);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (target.type.kind === 'array') {
      const arrayType = target.type;
      if (argNodes.length !== arrayType.rank) {
        this.error(
          node,
          'CS0022',
          `角かっこ [] 内のインデックス数が正しくありません。正しい数は ${arrayType.rank} です`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      const indices = argNodes.map((arg) => {
        if (arg.name) this.error(arg, 'CS1742', '配列のアクセスには名前付き引数の指定子を指定できません');
        const index = this.bindValue(arg.value, context);
        const special = specialOf(index.type);
        const target = special === 'long' || special === 'ulong' || special === 'uint' ? index.type : this.intType;
        return this.convert(index, target, arg);
      });
      return { kind: 'element', array: target, indices, type: arrayType.element, row: node.row };
    }
    const indexers = this.lookupIndexers(target.type, context.fn.typeContext);
    if (indexers.length === 0) {
      this.error(
        node,
        'CS0021',
        `角かっこ [] 付きインデックスを '${displayType(target.type)}' 型の式に適用することはできません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const args = this.bindArguments(argNodes, context);
    const candidates = indexers.map(({ property, owner }) => ({ method: this.indexerSignature(property), owner }));
    const resolved = this.resolveCall(candidates, args, undefined, node.row, { name: 'this', kind: 'indexer' });
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const chosen = indexers[candidates.findIndex((candidate) => candidate.method === resolved.candidate.method)];
    const type = substitute(chosen.property.type, substitutionOf(chosen.owner));
    return {
      kind: 'property',
      receiver: target,
      property: chosen.property,
      args: resolved.args,
      owner: chosen.owner,
      type,
      row: node.row,
    };
  }

  /** A method that stands for an indexer's parameters, which overload resolution compares. */
  private indexerSignature(property: PropertySymbol): MethodSymbol {
    const accessor = (property.getter ?? property.setter) as MethodSymbol;
    if (accessor.kind === 'setter') {
      const signature = Object.create(accessor) as MethodSymbol;
      Object.defineProperty(signature, 'parameters', { value: accessor.parameters.slice(0, -1) });
      return signature;
    }
    return accessor;
  }

  // code-gauge-allow functionNcss -- Each kind of created type.
  /** Binds `new T(args) { initializer }`. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  bindCreation(
    type: Type,
    argNodes: Argument[] | undefined,
    initializer: Initializer | undefined,
    node: Position,
    context: BindContext
  ): BoundExpression {
    const args = this.bindArguments(argNodes ?? [], context);
    if (type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (type.kind === 'typeParameter') {
      if (!type.symbol.hasConstructorConstraint && !type.symbol.hasValueConstraint) {
        this.error(
          node,
          'CS0304',
          `変数型 '${type.symbol.name}' のインスタンスは、new() 制約を含まないため、作成できません`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      if (args.length > 0) {
        this.error(
          node,
          'CS0417',
          `'${type.symbol.name}': 変数型のインスタンスを作成するときに、引数を指定することはできません`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      return {
        kind: 'new',
        constructor: undefined,
        objectType: type,
        args: [],
        initializer: this.bindInitializer(initializer, type, context),
        type,
        row: node.row,
      };
    }
    if (type.kind !== 'named') {
      this.error(
        node,
        'CS1526',
        'new 式は、型の後に引数リストか、丸かっこ ()、角かっこ []、または波かっこ {} を必要とします'
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const symbol = type.symbol;
    if (symbol.kind === 'delegate') return this.bindDelegateCreation(type, argNodes ?? [], node, context);
    if (symbol.isStatic) {
      this.error(node, 'CS0712', `静的クラス '${displayType(type)}' のインスタンスを作成することはできません`);
      return { kind: 'default', failedCall: true, type, row: node.row };
    }
    if (symbol.isAbstract || symbol.kind === 'interface') {
      this.error(node, 'CS0144', `抽象型またはインターフェイス '${displayType(type)}' のインスタンスを作成できません`);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (
      symbol.kind === 'enum' ||
      (symbol.kind === 'struct' &&
        args.length === 0 &&
        !symbol.constructors.some((constructor) => constructor.parameters.length === 0 && constructor.declaration))
    ) {
      if (args.length > 0 && symbol.kind === 'enum') {
        this.error(
          node,
          'CS1729',
          `'${displayType(type)}' には、引数 ${args.length} を指定するコンストラクターは含まれていません`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      this.checkRequiredMembers(type, initializer, node);
      return {
        kind: 'new',
        constructor: undefined,
        objectType: type,
        args: [],
        initializer: this.bindInitializer(initializer, type, context),
        type,
        row: node.row,
      };
    }
    const candidates = symbol.constructors
      .filter((constructor) => this.isAccessible(constructor.access, symbol, context.fn.typeContext))
      .map((method) => ({ method, owner: type }));
    if (candidates.length === 0 && symbol.constructors.length > 0) {
      this.error(
        node,
        'CS0122',
        `'${displayMethod(symbol.constructors[0])}' はアクセスできない保護レベルになっています`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const resolved = this.resolveCall(candidates, args, undefined, node.row, {
      name: symbol.name,
      kind: 'constructor',
      typeName: displayType(type),
    });
    // A creation whose arguments fit no constructor still has its type, which later errors then use, as in Roslyn.
    if (!resolved)
      return {
        kind: 'new',
        constructor: undefined,
        objectType: type,
        args: [],
        initializer: undefined,
        type,
        row: node.row,
      };
    const constructor = resolved.candidate.method;
    if (!constructor.native && symbol.isLibrary && !constructor.declaration && !(symbol.kind === 'struct'))
      this.unsupported(node, `${displayTypeSymbol(symbol)} のコンストラクター`);
    if (!constructor.setsRequiredMembers) this.checkRequiredMembers(type, initializer, node);
    this.checkObsolete(constructor, node);
    return {
      kind: 'new',
      constructor,
      objectType: type,
      args: resolved.args,
      initializer: this.bindInitializer(initializer, type, context),
      type,
      row: node.row,
    };
  }

  /**
   * Reports each `required` member of a type and its bases that a creation's object initializer leaves unset (CS9035),
   * in the order the members are declared, base members first.
   */
  private checkRequiredMembers(type: NamedType, initializer: Initializer | undefined, node: Position): void {
    const assigned = new Set(
      initializer?.kind === 'objectInitializer'
        ? initializer.members.flatMap((member) => (member.kind === 'memberAssign' ? [member.name] : []))
        : []
    );
    const chain: TypeSymbol[] = [];
    for (let current: NamedType | undefined = type; current; current = current.symbol.baseType)
      chain.unshift(current.symbol);
    for (const symbol of chain) {
      const members = [...symbol.fields, ...symbol.properties]
        .filter((member) => member.isRequired && !assigned.has(member.name))
        .toSorted((a, b) => a.row - b.row || a.column - b.column);
      for (const member of members)
        this.error(
          node,
          'CS9035',
          `必要なメンバー '${displayTypeSymbol(member.owner)}.${member.name}' は、オブジェクト初期化子または属性コンストラクターに設定する必要があります。`
        );
    }
  }

  /** Binds `new D(method)`, which converts a method group or a delegate to a delegate type. */
  private bindDelegateCreation(
    type: NamedType,
    argNodes: Argument[],
    node: Position,
    context: BindContext
  ): BoundExpression {
    if (argNodes.length !== 1) {
      this.error(node, 'CS0149', 'メソッド名が必要です');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return this.convert(this.bindValue(argNodes[0].value, context), type, node);
  }

  /** Binds an object or collection initializer of a created value of a type. */
  bindInitializer(
    initializer: Initializer | undefined,
    type: Type,
    context: BindContext
  ): BoundInitializerEntry[] | undefined {
    if (!initializer) return undefined;
    if (initializer.kind === 'collectionInitializer')
      return this.bindCollectionInitializer(initializer.elements, type, initializer, context);
    return initializer.members.map((member) => this.bindMemberInitializer(member, type, context));
  }

  private bindMemberInitializer(member: MemberInitializer, type: Type, context: BindContext): BoundMemberInit {
    // `Xs = { 1, 2 }` reads the member and fills it, so it needs no setter.
    const { value } = member;
    const isNested = value.kind === 'collectionInitializer' || value.kind === 'objectInitializer';
    const target = this.bindInitializerTarget(member, type, isNested, context);
    if (isNested) {
      return {
        kind: 'memberInit',
        target,
        value: undefined,
        nested: this.bindInitializer(value, target.type, context),
      };
    }
    return { kind: 'memberInit', target, value: this.bindAs(value, target.type, context), nested: undefined };
  }

  private bindInitializerTarget(
    member: MemberInitializer,
    type: Type,
    isNested: boolean,
    context: BindContext
  ): BoundLValue {
    const placeholder: BoundExpression = { kind: 'compoundOperand', type, row: member.row };
    let access: BoundExpression;
    if (member.kind === 'memberAssign') {
      const { found, inaccessible } = this.lookupMember(type, member.name, context.fn.typeContext);
      if (!found || found.kind === 'methods' || found.kind === 'type') {
        if (inaccessible) this.reportInaccessible(inaccessible, member);
        else this.error(member, 'CS0117', `'${displayType(type)}' に '${member.name}' の定義がありません`);
        return { kind: 'discard', type: ERROR_TYPE, row: member.row };
      }
      access = this.memberAccessOn(placeholder, found, member, context);
    } else {
      access = this.bindElementAccess(placeholder, member.args, member, context);
    }
    // An assigned member or indexer is written, so it goes through the assignment's accessor checks, while a nested
    // initializer reads the member and fills what it holds, so the member must be readable.
    if (!isNested) return this.checkAssignable(access, member, context, 'initializer');
    this.checkReadable(access, member, context);
    return access as BoundLValue;
  }

  /** Binds collection initializer elements as `Add` calls, which `{ a, b }` makes for each element. */
  private bindCollectionInitializer(
    elements: Expression[],
    type: Type,
    position: Position,
    context: BindContext
  ): BoundInitializerEntry[] {
    const enumerable = this.library.typeNamed('System.Collections.IEnumerable');
    if (!this.conversions.implicit(type, namedType(enumerable)) && type.kind !== 'error') {
      this.error(
        position,
        'CS1922',
        `System.Collections.IEnumerable' を実装していないため、型 '${displayType(type)}' はコレクション初期化子で初期化することはできません。`
      );
      return [];
    }
    const receiver: BoundExpression = { kind: 'compoundOperand', type, row: position.row };
    return elements.map((element) => {
      const args: ArgumentInfo[] =
        element.kind === 'arrayInitializer'
          ? element.elements.map((item) => ({
              expression: this.bindValue(item as Expression, context),
              name: undefined,
              refKind: undefined,
              row: item.row,
              target: undefined,
            }))
          : [
              {
                expression: this.bindValue(element, context),
                name: undefined,
                refKind: undefined,
                row: element.row,
                target: undefined,
              },
            ];
      const group = this.bindInstanceMember(receiver, 'Add', undefined, element, context);
      if (group.kind !== 'methodGroup')
        return {
          kind: 'collectionAdd' as const,
          call: { kind: 'default' as const, type: ERROR_TYPE, row: element.row },
        };
      return { kind: 'collectionAdd' as const, call: this.invokeMethodGroup(group, args, element) };
    });
  }

  /** Checks that storage can be assigned, reporting read-only fields, properties without setters, and values that are not variables. */
  abstract checkAssignable(
    target: BoundExpression,
    position: Position,
    context: BindContext,
    use: 'assign' | 'ref' | 'out' | 'compound' | 'initializer'
  ): BoundLValue;

  /** Whether two bound expressions name the same variable, for checks that compare targets. */
  protected sameVariable(a: BoundExpression, b: BoundExpression): boolean {
    return a.kind === 'local' && b.kind === 'local' && a.local === b.local;
  }

  protected isSameMethodType(a: Type, b: Type): boolean {
    return sameType(a, b);
  }
}

/** The type parameter of a name that the enclosing method or types declare, from the innermost out. */
/** Whether a member is an interface's static abstract or virtual member, which a type parameter's argument implements. */
function isConstrained(member: MethodSymbol | PropertySymbol): boolean {
  return member.isStatic && member.owner.kind === 'interface' && (member.isAbstract || member.isVirtual);
}

function typeParameterNamed(name: string, typeContext: TypeContext): Type | undefined {
  for (const parameter of typeContext.methodTypeParameters.toReversed())
    if (parameter.name === name) return parameter.type;
  for (let type = typeContext.type; type; type = type.containing) {
    const parameter = type.typeParameters.find((candidate) => candidate.name === name);
    if (parameter) return parameter.type;
  }
  return undefined;
}

export { LocalSymbol, PropertySymbol, FieldSymbol };
export type { BoundArgument };

/** A property or indexer as Roslyn names it in diagnostics, as `C.P` or `C.this[int]`. */
export function propertyDisplay(target: Extract<BoundExpression, { kind: 'property' }>): string {
  const { property, owner } = target;
  const name = property.isIndexer
    ? `this[${property.parameters.map((parameter) => displayType(substitute(parameter.type, substitutionOf(owner)))).join(', ')}]`
    : property.name;
  return `${displayTypeSymbol(owner.symbol, owner.args)}.${name}`;
}

/** Makes a function and those around it up to a local's owner capture the local, returning whether any did not yet. */
function captureUpToOwner(fn: FunctionScope, local: LocalSymbol): boolean {
  let isChanged = false;
  for (
    let current: FunctionScope | undefined = fn;
    current && current.method !== local.owner;
    current = current.outer
  ) {
    if (current.captures.has(local)) continue;
    current.captures.add(local);
    local.isCaptured = true;
    isChanged = true;
  }
  return isChanged;
}
