import type { Argument, Expression, Initializer, MemberInitializer, Position, TypeNode } from './ast';
import type { BoundArgument, BoundExpression, BoundInitializerEntry, BoundLValue, BoundMemberInit } from './bound';
import { type ArgumentInfo, CallBinder, type CallDescription, type ResolvedCall } from './callBinder';
import type { BindContext } from './convertBinder';
import { displayMethodIn } from './declarations';
import type { MethodCandidate } from './lookup';
import type { NamespaceSymbol } from './namespaces';
import {
  displayMethod,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  FieldSymbol,
  LocalSymbol,
  type MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
  PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  type TypeSymbol,
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

  /** Whether the member being looked up is called, which consumes the flag so that inner lookups do not see it. */
  protected takeCallee(): boolean {
    const isCallee = this.isBindingCallee;
    this.isBindingCallee = false;
    return isCallee;
  }

  /** Binds an expression to its natural type, leaving target-typed expressions unbound. */
  abstract bindExpression(node: Expression, context: BindContext): BindResult;

  /** Binds an expression as a value. */
  bindValue(node: Expression, context: BindContext): BoundExpression {
    return this.toValue(this.bindExpression(node, context), node);
  }

  /** Binds an expression and converts it to a type. */
  bindAs(node: Expression, type: Type, context: BindContext): BoundExpression {
    return this.convert(this.bindValue(node, context), type, node);
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
          `'${displayType(result.type)}' は 型 です。これは特定のコンテンツでは無効になります`
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

  // code-gauge-allow functionNcss 80 -- Each step of C#'s simple name lookup.
  /** Binds a simple name: a local, a member of an enclosing type, a type, or a namespace. */
  bindSimpleName(name: string, typeArgs: TypeNode[] | undefined, position: Position, context: BindContext): BindResult {
    const { scope, fn } = context;
    if (!typeArgs) {
      const found = scope.lookup(name);
      if (found?.isDeclaredLater) {
        this.error(position, 'CS0841', `宣言する前にローカル変数 '${name}' を使用できません`);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      if (found?.local) return this.localReference(found.local, position, context);
      if (found?.localFunction) {
        return {
          kind: 'methodGroup',
          name,
          candidates: [{ method: found.localFunction, owner: found.localFunction.owner.declaredType }],
          receiver: undefined,
          isSimpleName: true,
          typeArgs: undefined,
          extensions: [],
          isBaseAccess: false,
          row: position.row,
        };
      }
      const transparent = this.transparentMember(name, position, context);
      if (transparent) return transparent;
    }
    const typeContext = fn.typeContext;
    const isCallee = this.takeCallee();
    const resolvedTypeArgs = typeArgs?.map((arg) => this.resolveType(arg, typeContext));
    for (let type = typeContext.type; type; type = type.containing) {
      const primary = !typeArgs && fn.kind !== 'initializer' ? this.primaryParameterField(type, name) : undefined;
      const lookup = this.lookupMember(
        this.instanceTypeOf(type, context),
        name,
        typeContext,
        resolvedTypeArgs?.length ?? 0,
        isCallee
      );
      if (lookup.found) return this.memberOfEnclosing(lookup.found, type, resolvedTypeArgs, name, position, context);
      if (primary) return this.primaryParameterAccess(primary, position, context);
      if (lookup.inaccessible) {
        this.reportInaccessible(lookup.inaccessible, position);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
    }
    if (!typeArgs) {
      for (const parameter of typeContext.methodTypeParameters.toReversed())
        if (parameter.name === name) return { kind: 'typeRef', type: parameter.type, row: position.row };
      for (let type = typeContext.type; type; type = type.containing) {
        const parameter = type.typeParameters.find((candidate) => candidate.name === name);
        if (parameter) return { kind: 'typeRef', type: parameter.type, row: position.row };
      }
    }
    const symbol = this.findTypeInScope(name, resolvedTypeArgs?.length ?? 0, typeContext);
    if (symbol)
      return { kind: 'typeRef', type: this.construct(position, symbol, resolvedTypeArgs ?? []), row: position.row };
    const namespaces = this.namespacesAt([name]);
    if (namespaces.length > 0 && !typeArgs)
      return { kind: 'namespaceRef', path: [name], namespaces, row: position.row };
    if (name === '_' && !typeArgs) return { kind: 'discard', row: position.row };
    this.reportUndefinedName(name, position);
    return { kind: 'default', type: ERROR_TYPE, row: position.row };
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

  /** A local variable, recording that a lambda or local function captures it from an enclosing function. */
  protected localReference(local: LocalSymbol, position: Position, context: BindContext): BoundExpression {
    if (local.owner && local.owner !== context.fn.method) {
      local.isCaptured = true;
      for (let fn: typeof context.fn | undefined = context.fn; fn && fn.method !== local.owner; fn = fn.outer) {
        if (fn.kind === 'lambda' && (fn.method as { isStaticLambda?: boolean }).isStaticLambda) {
          this.error(position, 'CS8820', `静的な匿名関数に '${local.name}' への参照を含めることはできません。`);
        }
        fn.captures.add(local);
      }
    }
    local.isUsed = true;
    if (local.isConst) return { kind: 'constant', value: local.constantValue, type: local.type, row: position.row };
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

  /** A field or property of a receiver, or a static one when the receiver is undefined. */
  protected memberAccessOn(
    receiver: BoundExpression | undefined,
    found: Extract<NonNullable<ReturnType<MemberBinder['lookupMember']>['found']>, { kind: 'field' | 'property' }>,
    position: Position,
    context: BindContext
  ): BoundExpression {
    const substitution = substitutionOf(found.owner);
    if (found.kind === 'field') {
      const { field } = found;
      const type = substitute(field.type, substitution);
      if (field.isConst) return this.constantField(field, type, position);
      if (field.isStatic) return { kind: 'staticField', field, owner: found.owner, type, row: position.row };
      if (field.isEvent && context.fn.typeContext.type !== field.owner) {
        return { kind: 'field', receiver: receiver as BoundExpression, field, type, row: position.row };
      }
      return { kind: 'field', receiver: receiver as BoundExpression, field, type, row: position.row };
    }
    const { property } = found;
    const type = substitute(property.type, substitution);
    if (
      property.backingField &&
      !property.isStatic &&
      this.isInsideOwnInitialization(property, context) &&
      !property.setter
    ) {
      return {
        kind: 'field',
        receiver: receiver as BoundExpression,
        field: property.backingField,
        type,
        row: position.row,
      };
    }
    return { kind: 'property', receiver, property, args: [], owner: found.owner, type, row: position.row };
  }

  /** Whether a get-only auto-property is assigned in its type's constructor, which writes its backing field. */
  private isInsideOwnInitialization(property: PropertySymbol, context: BindContext): boolean {
    const method = context.fn.method;
    return (method.kind === 'constructor' || method.kind === 'staticConstructor') && method.owner === property.owner;
  }

  /** The value of a constant field, binding its initializer when it has not been bound yet. */
  protected abstract constantField(field: FieldSymbol, type: Type, position: Position): BoundExpression;

  protected reportInaccessible(member: FieldSymbol | PropertySymbol | MethodSymbol, position: Position): void {
    const name =
      member instanceof FieldSymbol || member instanceof PropertySymbol
        ? `${displayTypeSymbol(member.owner)}.${member.name}`
        : displayMethod(member);
    this.error(position, 'CS0122', `'${name}' はアクセスできない保護レベルになっています`);
  }

  // code-gauge-allow functionNcss 90 -- Each kind of target of a member access.
  /** Binds `target.name`, on a namespace, a type, or a value. */
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
      return this.bindStaticMember(target.type, node.name, typeArgs, position, context, isCallee);
    const receiver = target.kind === 'methodGroup' ? this.toValue(target, node.target) : target;
    if (receiver.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (receiver.kind === 'unbound' || receiver.type.kind === 'null' || receiver.type.kind === 'void') {
      this.error(
        position,
        'CS0023',
        `演算子 '.' は '${receiver.kind === 'unbound' ? (receiver.methodGroup ? 'メソッド グループ' : 'ラムダ式') : displayType(receiver.type)}' 型のオペランドに適用できません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return this.bindInstanceMember(receiver, node.name, typeArgs, position, context, isCallee);
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
    const receiver: BoundExpression = { kind: 'this', type: baseType, row: position.row };
    const result = this.bindInstanceMember(receiver, name, typeArgs, position, context, isCallee);
    if (result.kind === 'methodGroup') return { ...result, isBaseAccess: true };
    if (result.kind === 'property') return { ...result, receiver: { ...receiver, isBase: true } as BoundExpression };
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
      this.rejectUnknownLibraryMember(type, name, position);
      this.error(position, 'CS0117', `'${displayType(type)}' に '${name}' の定義がありません`);
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    if (found.kind === 'type') {
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
  bindInstanceMember(
    receiver: BoundExpression,
    name: string,
    typeArgs: Type[] | undefined,
    position: Position,
    context: BindContext,
    isCallee = false
  ): BindResult {
    const type = receiver.type;
    const lookupType =
      nullableUnderlying(type) &&
      !['HasValue', 'Value', 'GetValueOrDefault', 'ToString', 'Equals', 'GetHashCode'].includes(name)
        ? type
        : type;
    const { found, inaccessible } = this.lookupMember(
      lookupType,
      name,
      context.fn.typeContext,
      typeArgs?.length ?? 0,
      isCallee
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
        this.reportInaccessible(inaccessible, position);
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
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
      const instance = found.candidates.filter((candidate) => !candidate.method.isStatic);
      if (instance.length === 0) {
        const [first] = found.candidates;
        this.error(
          position,
          'CS0176',
          `インスタンス参照でメンバー '${displayMethodIn(first.method, first.owner).replace(/\(.*$/, '')}' にアクセスできません。代わりに型名を使用してください`
        );
        return { kind: 'default', type: ERROR_TYPE, row: position.row };
      }
      return {
        kind: 'methodGroup',
        name,
        candidates: instance,
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
      if (arg.modifier === 'in') this.unsupported(arg, '`in` 引数');
      return {
        expression: this.bindValue(arg.value, context),
        name: arg.name,
        refKind: undefined,
        row: arg.row,
        target: undefined,
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

  // code-gauge-allow functionNcss 60 -- Each kind of callee.
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
        this.error(
          node.target,
          'CS1955',
          `実行不可能なメンバー '${displayType(target.type)}' をメソッドのように使用することはできません。`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      this.toValue(target, node.target);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (target.type.kind === 'error') return this.failedAccess(target, node);
    const invoke = this.delegateInvokeOf(target.type);
    if (!invoke) {
      if (
        target.kind === 'local' ||
        target.kind === 'field' ||
        target.kind === 'property' ||
        target.kind === 'staticField'
      ) {
        this.error(node.target, 'CS0149', 'メソッド名が必要です');
      } else {
        this.error(node.target, 'CS0149', 'メソッド名が必要です');
      }
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
    const bound = this.bindExpression(value, context);
    void bound;
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
      if (!canFallBack) return { kind: 'default', type: ERROR_TYPE, row: node.row };
      this.diagnostics.length = saved;
    }
    const receiver = group.receiver as BoundExpression;
    const receiverArg: ArgumentInfo = {
      expression: receiver,
      name: undefined,
      refKind: undefined,
      row: receiver.row,
      target: undefined,
    };
    const resolved = this.resolveCall(group.extensions, [receiverArg, ...args], group.typeArgs, node.row, {
      ...description,
      isExtension: true,
    });
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    return this.callNode({ ...group, receiver: undefined }, resolved, node);
  }

  /** The call node for a resolved method, checking that an instance method has a receiver. */
  protected callNode(
    group: Extract<NonValue, { kind: 'methodGroup' }>,
    resolved: ResolvedCall,
    node: Position
  ): BoundExpression {
    const declared = resolved.candidate.method;
    // `base.M()` calls the implementation that the base class has, which may override the method found by name.
    const method =
      group.isBaseAccess && group.receiver ? this.implementationIn(group.receiver.type, declared) : declared;
    const substitution = this.callSubstitution(resolved.candidate, resolved.typeArgs);
    const returnType = substitute(method.returnType, substitution);
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
        `インスタンス参照でメンバー '${displayMethodIn(method, resolved.candidate.owner).replace(/\(.*$/, '')}' にアクセスできません。代わりに型名を使用してください`
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
      method.owner !== this.wellKnown.nullable
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
      row: node.row,
    };
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
    return {
      kind: 'call',
      method,
      receiver: undefined,
      args: resolved.args,
      typeArgs: [],
      owner: resolved.candidate.owner,
      isVirtual: false,
      type: substitute(method.returnType, substitutionOf(resolved.candidate.owner)),
      row,
    };
  }

  // code-gauge-allow functionNcss 60 -- Each kind of indexed value.
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

  // code-gauge-allow functionNcss 70 -- Each kind of created type.
  /** Binds `new T(args) { initializer }`. */
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
        objectType: type as never,
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
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
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
    if (!resolved) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const constructor = resolved.candidate.method;
    if (!constructor.native && symbol.isLibrary && !constructor.declaration && !(symbol.kind === 'struct'))
      this.unsupported(node, `${displayTypeSymbol(symbol)} のコンストラクター`);
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
    const placeholder: BoundExpression = { kind: 'compoundOperand', type, row: member.row };
    let target: BoundLValue;
    if (member.kind === 'memberAssign') {
      const { found, inaccessible } = this.lookupMember(type, member.name, context.fn.typeContext);
      if (!found || found.kind === 'methods' || found.kind === 'type') {
        if (inaccessible) this.reportInaccessible(inaccessible, member);
        else this.error(member, 'CS0117', `'${displayType(type)}' に '${member.name}' の定義がありません`);
        target = { kind: 'discard', type: ERROR_TYPE, row: member.row };
      } else {
        const access = this.memberAccessOn(placeholder, found, member, context);
        target = this.checkAssignable(access, member, context, 'initializer');
      }
    } else {
      target = this.bindElementAccess(placeholder, member.args, member, context) as BoundLValue;
    }
    if (member.value.kind === 'collectionInitializer' || member.value.kind === 'objectInitializer') {
      return {
        kind: 'memberInit',
        target,
        value: undefined,
        nested: this.bindInitializer(member.value, target.type, context),
      };
    }
    return { kind: 'memberInit', target, value: this.bindAs(member.value, target.type, context), nested: undefined };
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

export { LocalSymbol, PropertySymbol, FieldSymbol };
export type { BoundArgument };
