import type { AttributeNode, Position, TypeNode } from './ast';
import type { TypeContext } from './binderBase';
import type { BoundExpression } from './bound';
import type { ArgumentInfo } from './callBinder';
import type { BindContext } from './convertBinder';
import { FunctionScope, LocalScope } from './scopes';
import { StatementBinder } from './statementBinder';
import {
  displayType,
  type FieldSymbol,
  MethodSymbol,
  type NamedType,
  type ParameterSymbol,
  type PropertySymbol,
  type Type,
  TypeParameterSymbol,
  TypeSymbol,
  VOID_TYPE,
} from './types';

/** The `AttributeTargets` value of each kind of declaration that an attribute may apply to. */
export const ATTRIBUTE_TARGETS = {
  assembly: 1,
  module: 2,
  class: 4,
  struct: 8,
  enum: 16,
  constructor: 32,
  method: 64,
  property: 128,
  field: 256,
  event: 512,
  interface: 1024,
  parameter: 2048,
  delegate: 4096,
  returnValue: 8192,
  genericParameter: 16_384,
} as const;

export type AttributeTarget = keyof typeof ATTRIBUTE_TARGETS;

/** How Roslyn's CS0592 names each target. */
const TARGET_NAMES: Record<AttributeTarget, string> = {
  assembly: 'アセンブリ',
  module: 'モジュール',
  class: 'クラス',
  struct: '構造体',
  enum: '列挙型',
  constructor: 'コンストラクター',
  method: 'メソッド',
  property: 'プロパティ、インデクサー',
  field: 'フィールド',
  event: 'イベント',
  interface: 'インターフェイス',
  parameter: 'パラメーター',
  delegate: 'デリゲート',
  returnValue: '戻り値',
  genericParameter: '型パラメーター',
};

/** What a target specifier (`[return: ...]`) names. */
const SPECIFIER_TARGETS: Record<string, AttributeTarget> = {
  assembly: 'assembly',
  module: 'module',
  type: 'class',
  method: 'method',
  return: 'returnValue',
  field: 'field',
  property: 'property',
  event: 'event',
  param: 'parameter',
  typevar: 'genericParameter',
};

/** The symbol whose meaning a declaration's attributes set. */
export type AttributeOwner =
  | TypeSymbol
  | MethodSymbol
  | FieldSymbol
  | PropertySymbol
  | ParameterSymbol
  | TypeParameterSymbol;

/** A declaration's attributes, which the compiler binds once every type is declared. */
export interface PendingAttributes {
  attributes: AttributeNode[];
  /** The kind of declaration, and the targets that its attributes' specifiers may name instead. */
  target: AttributeTarget;
  specifiers: Partial<Record<string, AttributeOwner | undefined>>;
  owner: AttributeOwner | undefined;
  context: TypeContext;
  /** The parameters in scope, which `nameof` in a method's or a parameter's attribute may name (C# 11). */
  parameters?: readonly ParameterSymbol[];
}

/** An attribute bound to its type and constant arguments. */
interface BoundAttribute {
  node: AttributeNode;
  type: NamedType;
  args: unknown[];
  named: Map<string, unknown>;
}

/**
 * Binds the attributes of declarations (C# spec §23): their types, which must derive from `System.Attribute`, their
 * constructor and named arguments, which must be constants, `typeof`, or arrays of them, and the declarations they may
 * apply to; and gives the attributes the language and the library define their meaning.
 */
export abstract class AttributeBinder extends StatementBinder {
  /** The program's defined preprocessing symbols, which `[Conditional]` methods need for their calls to stay. */
  definedSymbols: ReadonlySet<string> = new Set();

  /** How many of the pending attributes are bound, which those of local functions and lambdas follow later. */
  private boundAttributeCount = 0;

  bindPendingAttributes(): void {
    const pending = this.pendingAttributes.slice(this.boundAttributeCount);
    this.boundAttributeCount = this.pendingAttributes.length;
    const bound = pending.map((entry) => ({ pending: entry, attributes: this.bindAttributeList(entry) }));
    // An attribute class's own `[AttributeUsage]` decides where others may use it, so usage applies once all are bound.
    for (const { pending, attributes } of bound)
      for (const { attribute, owner } of attributes) this.applyUsage(attribute, owner, pending);
    for (const { attributes } of bound) this.checkUsage(attributes);
  }

  private bindAttributeList(
    pending: PendingAttributes
  ): { attribute: BoundAttribute; owner: AttributeOwner | undefined; target: AttributeTarget }[] {
    const result: { attribute: BoundAttribute; owner: AttributeOwner | undefined; target: AttributeTarget }[] = [];
    for (const node of pending.attributes) {
      let target = pending.target;
      let owner = pending.owner;
      if (node.target !== undefined) {
        const named = SPECIFIER_TARGETS[node.target];
        // A specifier that the declaration does not allow makes Roslyn ignore the attribute with a warning (CS0657).
        if (!named || !(node.target in pending.specifiers)) continue;
        if (named !== 'class') target = named;
        owner = pending.specifiers[node.target];
      }
      const attribute = this.bindAttribute(node, pending.context, pending.parameters ?? []);
      if (attribute) result.push({ attribute, owner, target });
    }
    return result;
  }

  private bindAttribute(
    node: AttributeNode,
    typeContext: TypeContext,
    parameters: readonly ParameterSymbol[]
  ): BoundAttribute | undefined {
    const type = this.resolveAttributeType(node.name, typeContext);
    if (!type) return undefined;
    const context = this.attributeContext(typeContext);
    for (const parameter of parameters) this.declareParameter(parameter, context);
    const args: ArgumentInfo[] = node.args.map((arg) => {
      const value = this.bindValue(arg.value, context);
      return { expression: value, name: arg.name, refKind: undefined, row: arg.row, target: undefined, text: arg.text };
    });
    const constructors = type.symbol.constructors
      .filter((constructor) => constructor.access === 'public')
      .map((method) => ({ method, owner: type }));
    const resolved = this.resolveCall(constructors, args, undefined, node.row, {
      name: type.symbol.name,
      kind: 'constructor',
      typeName: displayType(type),
    });
    if (!resolved) return undefined;
    const values = resolved.args.map((arg) => this.attributeValue(arg as BoundExpression, node));
    const named = new Map<string, unknown>();
    for (const assignment of node.assignments) {
      const { found } = this.lookupMember(type, assignment.name, typeContext);
      const memberType = this.namedArgumentType(found);
      if (!memberType) {
        if (found) {
          this.error(
            assignment,
            'CS0617',
            `'${assignment.name}' は有効な名前付き属性引数ではありません。名前付き属性引数は、読み取り専用、静的、または定数ではないフィールドか、public で静的ではない読み書き可能なプロパティでなければなりません。`
          );
        } else {
          this.error(
            assignment,
            'CS0246',
            `型または名前空間の名前 '${assignment.name}' が見つかりませんでした (using ディレクティブまたはアセンブリ参照が指定されていることを確認してください)`
          );
        }
        continue;
      }
      const value = this.convert(this.bindValue(assignment.value, context), memberType, assignment);
      named.set(assignment.name, this.attributeValue(value, assignment));
    }
    return { node, type, args: values, named };
  }

  /** The type of a field or property that a named attribute argument may set, or undefined for any other member. */
  private namedArgumentType(found: ReturnType<AttributeBinder['lookupMember']>['found']): Type | undefined {
    if (found?.kind === 'field' && !found.field.isStatic && !found.field.isReadonly && !found.field.isConst)
      return found.field.type;
    if (found?.kind === 'property' && !found.property.isStatic && found.property.setter?.access === 'public')
      return found.property.type;
    return undefined;
  }

  /**
   * An attribute's type by its name, which may leave out the `Attribute` suffix: the suffixed name is tried first, and
   * a name that finds neither reports both, as Roslyn does.
   */
  private resolveAttributeType(name: TypeNode, context: TypeContext): NamedType | undefined {
    const suffixed = withAttributeSuffix(name);
    const found = suffixed ? this.quietly(() => this.resolveType(suffixed, context)) : undefined;
    const type =
      found && found.kind !== 'error' && this.isAttributeType(found)
        ? found
        : this.resolveAttributeName(name, suffixed, context);
    if (!type || type.kind !== 'named') return undefined;
    if (!this.isAttributeType(type)) {
      this.error(name, 'CS0616', `'${displayType(type)}' は属性クラスではありません`);
      return undefined;
    }
    return type;
  }

  private resolveAttributeName(name: TypeNode, suffixed: TypeNode | undefined, context: TypeContext): Type | undefined {
    const plain = this.quietly(() => this.resolveType(name, context));
    if (plain && plain.kind !== 'error') return plain;
    if (suffixed) this.resolveType(suffixed, context);
    const type = this.resolveType(name, context);
    return type.kind === 'error' ? undefined : type;
  }

  private isAttributeType(type: Type): boolean {
    const attribute = this.library.typeNamed('System.Attribute');
    for (let current = type.kind === 'named' ? type : undefined; current; current = current.symbol.baseType)
      if (current.symbol === attribute) return true;
    return false;
  }

  /** A function scope for an attribute's arguments, which see the names of the declaration's type. */
  private attributeContext(typeContext: TypeContext): BindContext {
    const method = new MethodSymbol('<attribute>', typeContext.type ?? this.objectType.symbol, 'method');
    method.isStatic = true;
    const fn = new FunctionScope(method, undefined, typeContext, VOID_TYPE, true, undefined, 'initializer');
    return { scope: new LocalScope(undefined, fn), fn };
  }

  /** The constant value of an attribute argument, reporting one that is not a constant, `typeof`, or an array (CS0182). */
  private attributeValue(expression: BoundExpression, position: Position): unknown {
    switch (expression.kind) {
      case 'constant': {
        return expression.value;
      }
      case 'typeOf': {
        return expression.target;
      }
      case 'convert': {
        return this.attributeValue(expression.operand, position);
      }
      case 'newArray': {
        if (expression.elements) return expression.elements.map((element) => this.attributeValue(element, position));
        break;
      }
      default: {
        break;
      }
    }
    if (expression.type.kind !== 'error')
      this.error(
        position,
        'CS0182',
        '属性引数は、定数式、typeof 式、または属性パラメーター型の配列の作成式でなければなりません'
      );
    return undefined;
  }

  /** Gives an attribute the meaning that the language or the library defines for it. */
  // code-gauge-allow functionCognitiveComplexity -- One branch per attribute with a meaning.
  private applyUsage(attribute: BoundAttribute, owner: AttributeOwner | undefined, pending: PendingAttributes): void {
    const { type, args, named } = attribute;
    switch (type.symbol.fullName) {
      case 'System.AttributeUsageAttribute': {
        if (owner instanceof TypeSymbol)
          owner.attributeUsage = {
            validOn: Number(args[0] ?? 32_767),
            allowMultiple: named.get('AllowMultiple') === true,
          };
        return;
      }
      case 'System.FlagsAttribute': {
        if (owner instanceof TypeSymbol) owner.isFlags = true;
        return;
      }
      case 'System.ObsoleteAttribute': {
        if (args[1] === true && owner && !(owner instanceof TypeParameterSymbol) && !('refKind' in owner))
          owner.obsoleteError = (args[0] as string | undefined) ?? '';
        return;
      }
      case 'System.Diagnostics.ConditionalAttribute': {
        if (owner instanceof MethodSymbol)
          owner.conditionalSymbols = [...(owner.conditionalSymbols ?? []), String(args[0])];
        return;
      }
      case 'System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute': {
        if (owner instanceof MethodSymbol) owner.setsRequiredMembers = true;
        return;
      }
      case 'System.Runtime.CompilerServices.ModuleInitializerAttribute': {
        if (owner instanceof MethodSymbol) owner.isModuleInitializer = true;
        return;
      }
      case 'System.Runtime.CompilerServices.CallerMemberNameAttribute':
      case 'System.Runtime.CompilerServices.CallerLineNumberAttribute':
      case 'System.Runtime.CompilerServices.CallerFilePathAttribute':
      case 'System.Runtime.CompilerServices.CallerArgumentExpressionAttribute': {
        if (owner && 'refKind' in owner && pending.target === 'parameter') {
          const kind = type.symbol.name.replaceAll(/^Caller|Attribute$/g, '') as CallerInfo['kind'];
          owner.callerInfo = { kind, parameterName: args[0] as string | undefined };
        }
        return;
      }
      default: {
        return;
      }
    }
  }

  /** Reports attributes on declarations their `[AttributeUsage]` does not allow (CS0592), or repeated (CS0579). */
  private checkUsage(attributes: { attribute: BoundAttribute; target: AttributeTarget }[]): void {
    const seen = new Set<TypeSymbol>();
    for (const { attribute, target } of attributes) {
      const usage = attribute.type.symbol.attributeUsage ?? { validOn: 32_767, allowMultiple: false };
      const written = displayTypeNode(attribute.node.name);
      if ((usage.validOn & ATTRIBUTE_TARGETS[target]) === 0) {
        const valid = (Object.keys(ATTRIBUTE_TARGETS) as AttributeTarget[])
          .filter((name) => (usage.validOn & ATTRIBUTE_TARGETS[name]) !== 0)
          .map((name) => TARGET_NAMES[name])
          .join(', ');
        this.error(
          attribute.node.name,
          'CS0592',
          `属性 '${written}' はこの宣言型では無効です。'${valid}' 宣言でのみ有効です。`
        );
        continue;
      }
      if (seen.has(attribute.type.symbol) && !usage.allowMultiple)
        this.error(attribute.node.name, 'CS0579', `'${written}' 属性が重複しています`);
      seen.add(attribute.type.symbol);
    }
  }
}

/** What a `[Caller...]` attribute on an optional parameter makes an omitted argument receive. */
export interface CallerInfo {
  kind: 'MemberName' | 'LineNumber' | 'FilePath' | 'ArgumentExpression';
  /** For `[CallerArgumentExpression]`, the parameter whose argument's text it receives. */
  parameterName: string | undefined;
}

/** The name with `Attribute` added, unless it already ends with it. */
function withAttributeSuffix(node: TypeNode): TypeNode | undefined {
  if (node.kind === 'namedType' && !node.name.endsWith('Attribute')) return { ...node, name: `${node.name}Attribute` };
  if (node.kind === 'qualifiedType' && !node.name.endsWith('Attribute'))
    return { ...node, name: `${node.name}Attribute` };
  if (node.kind === 'aliasQualifiedType' && !node.name.endsWith('Attribute'))
    return { ...node, name: `${node.name}Attribute` };
  return undefined;
}

/** An attribute's name as written, which Roslyn's attribute messages show. */
function displayTypeNode(node: TypeNode): string {
  switch (node.kind) {
    case 'namedType': {
      return node.name;
    }
    case 'qualifiedType': {
      return `${displayTypeNode(node.left)}.${node.name}`;
    }
    case 'aliasQualifiedType': {
      return `${node.alias}::${node.name}`;
    }
    default: {
      return '';
    }
  }
}
