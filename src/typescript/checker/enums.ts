import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { numberArithmetic } from '../../javascript/expressionEvaluator';
import { decodeTemplateFragment } from '../../javascript/literals';
import { isAmbient } from '../namespaceInstantiation';
import type { Checker } from './checker';
import { laterRunningTypes } from './expandos';
import type { Sym } from './scopes';
import {
  hasToken,
  isImmediatelyInvoked,
  isWithin,
  named,
  numberValue,
  propertyNameText,
  skipParentheses,
  stringValue,
} from './syntax';
import {
  anonymousObject,
  emptyStructure,
  type EnumMemberInfo,
  type LiteralType,
  newTypeId,
  numberType,
  type ObjectType,
  regularOf,
  simpleProperty,
  stringType,
  type Type,
  unionOf,
} from './types';

type EnumValue = number | string;

export const ENUM_MERGE_MESSAGE = '列挙型の宣言は、名前空間または他の列挙型の宣言とのみマージできます。';

/** What an enum initializer is evaluated in: its enum, the members evaluated before it, and the errors found. */
interface Evaluation {
  symbol: Sym;
  members: Map<string, EnumMember>;
  errors: EnumInfo['errors'];
}

interface EnumMember {
  name: string;
  /** The constant value, or undefined for a computed member, whose value only running the program gives. */
  value: EnumValue | undefined;
  type: Type;
  node: TreeNode;
}

interface EnumInfo {
  members: Map<string, EnumMember>;
  /** The type the enum's name stands for: the union of its members' enum literal types, or `number` when it has none. */
  type: Type;
  /** The type of the enum object, `typeof E`. */
  objectType: ObjectType;
  /** The errors the members' initializers have, which checking the declaration reports. */
  errors: { node: TreeNode; message: string }[];
}

/**
 * Enums: the values of their members, which TypeScript computes from constant initializers and by counting up, the
 * enum literal types of the members, and the type of the enum object.
 */
export class Enums {
  private readonly infos = new Map<number, EnumInfo>();
  private readonly computing = new Set<number>();
  private readonly evaluatingConstants = new Set<number>();

  constructor(private readonly c: Checker) {}

  /** The type an enum's name stands for as a type. */
  declaredType(symbol: Sym): Type {
    return this.infoOf(symbol)?.type ?? numberType;
  }

  /** The type of an enum's name as a value: the enum object. */
  objectType(symbol: Sym): Type {
    return this.infoOf(symbol)?.objectType ?? numberType;
  }

  /** The type `E.A` names, the type of the member `A` of the enum `E`. */
  memberTypeNamed(symbol: Sym, name: string): Type | undefined {
    const type = this.infoOf(symbol)?.members.get(name)?.type;
    return type && regularOf(type);
  }

  /** The type of a member's name inside the enum's initializers, which refer to the members before them. */
  memberType(member: TreeNode): Type {
    const declaration = member.parent?.parent;
    const name = declaration?.childForFieldName('name');
    const symbol = name ? this.c.scopeOf(declaration as TreeNode).lookupValue(name.text) : undefined;
    const memberName = memberNameOf(member);
    return (symbol && memberName !== undefined && this.infoOf(symbol)?.members.get(memberName)?.type) || numberType;
  }

  /** Resolves an identifier or import/import-alias symbol to its target enum symbol when it names an enum. */
  resolvedEnumSymbol(symbol: Sym | undefined): Sym | undefined {
    const resolved = this.unaliasedValue(symbol);
    return resolved?.valueKind === 'enum' ? resolved : undefined;
  }

  /** A `const enum` has no object to use as a value, only members to read, which TypeScript compiles to their values. */
  checkConstEnumUse(node: TreeNode, symbol: Sym): void {
    if (!isConstEnum(symbol)) return;
    const index = node.parent?.type === 'subscript_expression' ? node.parent.childForFieldName('index') : undefined;
    if (index && node.parent?.childForFieldName('object')?.id === node.id && !isStringLiteralIndex(index)) {
      this.c.error(index, "'const' enum のメンバーには、文字列リテラルでしかアクセスできません。");
      return;
    }
    if (isAllowedConstEnumUse(node)) return;
    this.c.error(
      node,
      "'const' enum は、プロパティやインデックスのアクセス式、import 宣言やエクスポート代入の右辺、型のクエリーでしか使えません。"
    );
  }

  checkDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name');
    const symbol = name ? this.c.scopeOf(node).lookupValue(name.text) : undefined;
    const info = symbol ? this.infoOf(symbol) : undefined;
    for (const { node: errorNode, message } of info?.errors ?? [])
      if (isWithin(errorNode, node)) this.c.error(errorNode, message);
    for (const member of named(node.childForFieldName('body') as TreeNode)) this.checkMember(member, symbol, info);
  }

  private checkMember(member: TreeNode, symbol: Sym | undefined, info: EnumInfo | undefined): void {
    const value = member.childForFieldName('value');
    const type = value && this.c.expressions.check(value);
    const name = memberNameOf(member);
    // An ambient enum's computed member is reported as not constant instead.
    const isComputed = name !== undefined && info?.members.get(name)?.value === undefined && !isAmbient(member);
    if (value && type && isComputed && !this.c.relations.isAssignable(type, numberType))
      this.c.error(
        value,
        `型 '${this.c.print(this.c.widen(type))}' は、計算で決まる enum メンバーの値に必要な型 'number' に代入できません。`
      );
    if (symbol) this.checkMergedNamespaceClash(member, symbol);
    const nameNode = member.type === 'enum_assignment' ? member.childForFieldName('name') : member;
    if (nameNode && isNumericName(nameNode)) this.c.error(nameNode, 'enum のメンバーには数値の名前を付けられません。');
  }

  /** Reports a member that a namespace merged with its enum also exports, at both declarations, as tsc does. */
  private checkMergedNamespaceClash(member: TreeNode, symbol: Sym): void {
    const name = memberNameOf(member);
    const exports = symbol.namespaceExports;
    if (name === undefined || !exports) return;
    const exported = [exports.values.get(name), exports.types.get(name), exports.namespaces.get(name)].filter(
      (other) => other !== undefined
    );
    if (exported.length === 0) return;
    const { node, message } = duplicateError(member, name);
    this.c.error(node, message);
    const seen = new Set<number>();
    for (const other of exported)
      for (const declaration of [
        ...other.valueDeclarations,
        ...other.typeDeclarations,
        ...other.namespaceDeclarations,
      ]) {
        if (seen.has(declaration.id)) continue;
        seen.add(declaration.id);
        this.c.error(declaration.childForFieldName('name') ?? declaration, message);
      }
  }

  private infoOf(symbol: Sym): EnumInfo | undefined {
    const cached = this.infos.get(symbol.id);
    if (cached) return cached;
    if (this.computing.has(symbol.id)) return undefined;
    this.computing.add(symbol.id);
    try {
      const info = this.computeInfo(symbol);
      this.infos.set(symbol.id, info);
      return info;
    } finally {
      this.computing.delete(symbol.id);
    }
  }

  private computeInfo(symbol: Sym): EnumInfo {
    const info = {} as EnumInfo;
    const { members, errors } = this.memberValues(symbol);
    const summary = new Map(
      [...members].map(([name, member]) => [name, { value: member.value, computed: member.value === undefined }])
    );
    const isConst = isConstEnum(symbol);
    const types = [...members.values()].map((member) => {
      member.type = enumLiteralType(member.value, {
        enumId: symbol.id,
        enumName: symbol.name,
        name: member.name,
        computed: member.value === undefined,
        isConst,
        members: () => summary,
        base: () => info.type,
      });
      return member.type;
    });
    const union =
      types.length > 0
        ? unionOf(types)
        : enumLiteralType(undefined, {
            enumId: symbol.id,
            enumName: symbol.name,
            name: '',
            computed: true,
            isConst,
            empty: true,
            members: () => summary,
            base: () => info.type,
          });
    if (union.kind === 'union') union.enumName = symbol.name;
    info.type = union;
    info.members = members;
    info.errors = errors;
    info.objectType = enumObjectType(symbol.name, members);
    return info;
  }

  /** Each member's value, from a constant initializer or by counting up from the member before, in order. */
  private memberValues(symbol: Sym): Pick<EnumInfo, 'members' | 'errors'> {
    const members = new Map<string, EnumMember>();
    const errors: EnumInfo['errors'] = [];
    const declarations = symbol.valueDeclarations.filter((declaration) => declaration.type === 'enum_declaration');
    const isConst = declarations.some((declaration) => hasToken(declaration, 'const'));
    if (isConst && !declarations.every((declaration) => hasToken(declaration, 'const')))
      for (const declaration of declarations)
        errors.push({
          node: declaration.childForFieldName('name') ?? declaration,
          message: ENUM_MERGE_MESSAGE,
        });
    for (const declaration of declarations) {
      let previous: EnumMember | undefined;
      for (const memberNode of named(declaration.childForFieldName('body') as TreeNode)) {
        const name = memberNameOf(memberNode);
        if (name === undefined) continue;
        const value = this.memberValue(memberNode, previous, { symbol, members, errors, isConst });
        const member: EnumMember = { name, value, type: numberType, node: memberNode };
        const duplicate = members.get(name);
        if (duplicate) errors.push(...[duplicate.node, memberNode].map((repeated) => duplicateError(repeated, name)));
        members.set(name, member);
        previous = member;
      }
    }
    errors.push(...countedFirstErrors(declarations));
    return { members, errors };
  }

  /** A member's value: its initializer's, 0 for the first member, or one more than the member before. */
  private memberValue(
    memberNode: TreeNode,
    previous: EnumMember | undefined,
    context: Evaluation & { isConst: boolean }
  ): EnumValue | undefined {
    const initializer = memberNode.childForFieldName('value');
    if (initializer) {
      const errorCount = context.errors.length;
      const value = this.evaluate(initializer, context);
      // An evaluation that reported its own error, such as a forward reference, gets no second one, as in tsc.
      const message =
        context.errors.length === errorCount
          ? initializerError(value, context.isConst, isAmbient(memberNode))
          : undefined;
      if (message) context.errors.push({ node: initializer, message });
      return value;
    }
    if (!context.isConst && isAmbient(memberNode)) return undefined;
    if (!previous) return 0;
    if (typeof previous.value === 'number') return previous.value + 1;
    context.errors.push({ node: memberNode, message: 'enum のメンバーには初期値が必要です。' });
    return undefined;
  }

  /** The value of a constant enum expression, as TypeScript's `evaluate` computes it, or undefined for another one. */
  // code-gauge-allow functionNcss -- Evaluates each kind of constant expression TypeScript allows in an enum.
  private evaluate(node: TreeNode, evaluation: Evaluation): EnumValue | undefined {
    const expression = skipParentheses(node);
    switch (expression.type) {
      case 'number': {
        const value = numberValue(expression.text);
        return typeof value === 'number' ? value : undefined;
      }
      case 'string': {
        return stringValue(expression);
      }
      case 'template_string': {
        return this.templateValue(expression, evaluation);
      }
      case 'identifier': {
        return (
          this.ownMemberValue(expression, expression.text, evaluation) ??
          this.identifierConstantValue(expression, evaluation)
        );
      }
      case 'member_expression':
      case 'subscript_expression': {
        return this.qualifiedMemberValue(expression, evaluation);
      }
      case 'unary_expression': {
        const operand = this.evaluate(expression.childForFieldName('argument') as TreeNode, evaluation);
        if (typeof operand !== 'number') return undefined;
        const operator = expression.childForFieldName('operator')?.text;
        if (operator === '-') return -operand;
        if (operator === '+') return operand;
        return operator === '~' ? ~operand : undefined;
      }
      case 'binary_expression': {
        const left = this.evaluate(expression.childForFieldName('left') as TreeNode, evaluation);
        const right = this.evaluate(expression.childForFieldName('right') as TreeNode, evaluation);
        if (left === undefined || right === undefined) return undefined;
        return binaryValue(expression.childForFieldName('operator')?.text ?? '', left, right);
      }
      default: {
        return undefined;
      }
    }
  }

  /** A template literal's string, when every substitution in it is a constant expression, as tsc evaluates it. */
  private templateValue(template: TreeNode, evaluation: Evaluation): string | undefined {
    let text = '';
    let position = template.startIndex + 1;
    for (const substitution of named(template).filter((child) => child.type === 'template_substitution')) {
      const inner = named(substitution)[0];
      const value = inner && this.evaluate(inner, evaluation);
      if (value === undefined) return undefined;
      text += decodeTemplateFragment(this.sliceOf(template, position, substitution.startIndex)) + String(value);
      position = substitution.endIndex;
    }
    return text + decodeTemplateFragment(this.sliceOf(template, position, template.endIndex - 1));
  }

  private sliceOf(node: TreeNode, start: number, end: number): string {
    return node.text.slice(start - node.startIndex, end - node.startIndex);
  }

  private identifierConstantValue(name: TreeNode, evaluation: Evaluation): EnumValue | undefined {
    const symbol = this.unaliasedValue(this.c.scopeOf(name).lookupValue(name.text));
    if (symbol?.valueKind === 'enumMember') return this.resolvedEnumMemberValue(name, symbol, evaluation);
    return symbol ? this.constantSymbolValue(name, symbol, evaluation) : undefined;
  }

  /** The value of an unannotated `const` declared before `reference`, when a constant expression initializes it. */
  private constantSymbolValue(reference: TreeNode, variable: Sym, evaluation: Evaluation): EnumValue | undefined {
    const declaration = variable.valueDeclaration;
    const value =
      declaration?.type === 'variable_declarator' && !declaration.childForFieldName('type')
        ? declaration.childForFieldName('value')
        : undefined;
    if (
      variable.valueKind !== 'const' ||
      !declaration ||
      !value ||
      (declaration.startIndex > reference.startIndex && !isDeferredFrom(reference, declaration)) ||
      this.evaluatingConstants.has(variable.id)
    )
      return undefined;
    this.evaluatingConstants.add(variable.id);
    try {
      return this.evaluate(value, { ...evaluation, members: new Map() });
    } finally {
      this.evaluatingConstants.delete(variable.id);
    }
  }

  /** The value of `E.A`, `Q.R.X`, or `C.base`, an enum member or exported constant along an entity-name path. */
  private qualifiedMemberValue(node: TreeNode, evaluation: Evaluation): EnumValue | undefined {
    const object = node.childForFieldName('object');
    const key = this.memberAccessKey(node, evaluation);
    const container = object ? this.resolveContainerSymbol(object) : undefined;
    if (!container || key === undefined) return undefined;
    if (container.valueKind === 'enum') {
      if (container.id === evaluation.symbol.id) return this.ownMemberValue(node, key, evaluation);
      const member = this.infoOf(container)?.members.get(key);
      if (member) return this.checkedEnumMemberValue(node, container, member, evaluation);
    }
    if (node.type !== 'member_expression') return undefined;
    const exported = this.unaliasedValue(container.namespaceExports?.values.get(key));
    if (exported?.valueKind === 'enumMember') return this.resolvedEnumMemberValue(node, exported, evaluation);
    return exported ? this.constantSymbolValue(node, exported, evaluation) : undefined;
  }

  private resolveContainerSymbol(node: TreeNode): Sym | undefined {
    if (node.type === 'identifier') return this.unaliasedValue(this.c.scopeOf(node).lookupValue(node.text));
    if (node.type !== 'member_expression') return undefined;
    const object = node.childForFieldName('object');
    const key = node.childForFieldName('property')?.text;
    const parent = object ? this.resolveContainerSymbol(object) : undefined;
    return key === undefined ? undefined : this.unaliasedValue(parent?.namespaceExports?.values.get(key));
  }

  private memberAccessKey(node: TreeNode, evaluation: Evaluation): string | undefined {
    if (node.type === 'member_expression') return node.childForFieldName('property')?.text;
    const index = node.childForFieldName('index');
    const value = index && isStringLiteralIndex(index) ? this.evaluate(index, evaluation) : undefined;
    return typeof value === 'string' ? value : undefined;
  }

  private unaliasedValue(symbol: Sym | undefined): Sym | undefined {
    return symbol && (symbol.valueKind === 'import' || symbol.valueKind === 'importAlias')
      ? this.c.namespaces.imported(symbol, 'value')
      : symbol;
  }

  private resolvedEnumMemberValue(
    reference: TreeNode,
    memberSymbol: Sym,
    evaluation: Evaluation
  ): EnumValue | undefined {
    const declaration = memberSymbol.valueDeclaration?.parent?.parent;
    const name = declaration?.childForFieldName('name');
    const enumSymbol = name ? this.c.scopeOf(declaration as TreeNode).lookupValue(name.text) : undefined;
    if (!enumSymbol) return undefined;
    if (enumSymbol.id === evaluation.symbol.id) return this.ownMemberValue(reference, memberSymbol.name, evaluation);
    const member = this.infoOf(enumSymbol)?.members.get(memberSymbol.name);
    return member ? this.checkedEnumMemberValue(reference, enumSymbol, member, evaluation) : undefined;
  }

  private checkedEnumMemberValue(
    reference: TreeNode,
    enumSymbol: Sym,
    member: EnumMember,
    evaluation: Evaluation
  ): EnumValue | undefined {
    if (
      member.node.startIndex > reference.startIndex &&
      !isConstEnum(enumSymbol) &&
      !isDeferredFrom(reference, member.node)
    ) {
      return this.forwardReference(reference, evaluation);
    }
    return member.value;
  }

  /** The value of a member of the enum being evaluated, which only a member declared before may read. */
  private ownMemberValue(reference: TreeNode, name: string, evaluation: Evaluation): EnumValue | undefined {
    const member = evaluation.members.get(name);
    if (member) return member.value;
    const declared = evaluation.symbol.enumMembers?.values.get(name);
    const isMember =
      declared !== undefined &&
      (reference.type !== 'identifier' || this.c.scopeOf(reference).lookupValue(name)?.id === declared.id);
    return isMember ? this.forwardReference(reference, evaluation) : undefined;
  }

  private forwardReference(reference: TreeNode, evaluation: Evaluation): undefined {
    evaluation.errors.push({
      node: reference,
      message:
        '列挙型宣言のメンバー初期化子は、他の列挙型で定義されたメンバーを含め、その後で宣言されたメンバーを参照できません。',
    });
    return undefined;
  }
}

/** Whether a function or instance field that does not enclose `target` defers `reference` until after `target` runs. */
function isDeferredFrom(reference: TreeNode, target: TreeNode): boolean {
  for (let child = reference, current = reference.parent; current; child = current, current = current.parent) {
    if (current.id === target.id) return false;
    if (child.type === 'decorator') continue;
    if (isDeferredBoundary(current, target)) return true;
  }
  return false;
}

function isDeferredBoundary(container: TreeNode, target: TreeNode): boolean {
  if (container.type === 'field_definition') return !hasToken(container, 'static');
  if (!laterRunningTypes.has(container.type) || isImmediatelyInvoked(container)) return false;
  return !(container.startIndex <= target.startIndex && target.endIndex <= container.endIndex);
}

/** Only one declaration of an enum may start counting from 0, as two would give their first members the same value. */
function countedFirstErrors(declarations: TreeNode[]): EnumInfo['errors'] {
  const counting = declarations.flatMap((declaration) => {
    const first = named(declaration.childForFieldName('body') as TreeNode).find(
      (member) => memberNameOf(member) !== undefined
    );
    return first && !first.childForFieldName('value') ? [first] : [];
  });
  return counting.slice(1).map((member) => ({
    node: member,
    message: '複数の宣言がある列挙型で、最初の列挙要素の初期化子を省略できる宣言は 1 つのみです。',
  }));
}

function duplicateError(member: TreeNode, name: string): { node: TreeNode; message: string } {
  return { node: member.childForFieldName('name') ?? member, message: `${name} はすでに宣言されています。` };
}

/** `typeof E`: the members as read-only properties, and the names of numeric members by their values. */
function enumObjectType(name: string, members: Map<string, EnumMember>): ObjectType {
  const hasNumericMember = [...members.values()].some((member) => typeof member.value !== 'string');
  return anonymousObject(
    () => {
      const structure = emptyStructure();
      for (const member of members.values()) {
        const type = member.type.kind === 'literal' ? member.type.counterpart : member.type;
        structure.properties.set(member.name, simpleProperty(member.name, type, { readonly: true }));
      }
      if (hasNumericMember) structure.numberIndex = { type: stringType, readonly: true, isEnumReverseMapping: true };
      return structure;
    },
    { valueName: name, nonGeneric: true }
  );
}

/** The name of an enum member, which an identifier or a string literal gives. */
export function memberNameOf(member: TreeNode): string | undefined {
  const name = member.type === 'enum_assignment' ? member.childForFieldName('name') : member;
  if (!name) return undefined;
  return name.type === 'string' ? stringValue(name) : propertyNameText(name);
}

function enumLiteralType(value: EnumValue | undefined, enumMember: EnumMemberInfo): LiteralType {
  // A computed member is a numeric enum member whose value is not known until run time.
  const stored = value ?? Number.NaN;
  const regular = { kind: 'literal', id: newTypeId(), value: stored, fresh: false, enumMember } as LiteralType;
  const fresh = {
    kind: 'literal',
    id: newTypeId(),
    value: stored,
    fresh: true,
    counterpart: regular,
    enumMember,
  } as LiteralType;
  regular.counterpart = fresh;
  return regular;
}

const arithmeticOperators = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);

function binaryValue(operator: string, left: EnumValue, right: EnumValue): EnumValue | undefined {
  if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) return `${left}${right}`;
  if (typeof left !== 'number' || typeof right !== 'number' || !arithmeticOperators.has(operator)) return undefined;
  return numberArithmetic(operator, left, right);
}

export function isConstEnum(symbol: Sym): boolean {
  return symbol.valueDeclarations.some((declaration) => hasToken(declaration, 'const'));
}

/**
 * Whether a const enum's name is used where TypeScript allows it: as the object of an access, or as a whole type query,
 * though not as the object of one such as `typeof E.A`.
 */
export function isAllowedConstEnumUse(node: TreeNode): boolean {
  const parent = node.parent;
  if (parent?.type === 'type_query') return true;
  if (parent?.type !== 'member_expression' && parent?.type !== 'subscript_expression') return false;
  if (parent.childForFieldName('object')?.id !== node.id) return false;
  let outer: TreeNode | null = parent;
  while (outer?.type === 'member_expression') outer = outer.parent;
  return outer?.type !== 'type_query';
}

/** What tsc reports of a const or ambient enum member's evaluated initializer, if anything. */
function initializerError(value: EnumValue | undefined, isConst: boolean, isAmbientEnum: boolean): string | undefined {
  if (isConst && typeof value === 'number' && !Number.isFinite(value))
    return Number.isNaN(value)
      ? "'const' enum のメンバーの初期値が、使えない値 'NaN' になりました。"
      : "'const' enum のメンバーの初期値が、有限でない値になりました。";
  if (value !== undefined || !(isConst || isAmbientEnum)) return undefined;
  return isConst
    ? 'const enum のメンバーの初期値は、定数式でなければいけません。'
    : 'アンビエントの enum 宣言では、メンバーの初期値は定数式でなければいけません。';
}

/** Whether a member name is a number, or a string that spells a finite number the way JavaScript prints it. */
function isNumericName(name: TreeNode): boolean {
  if (name.type === 'number') return true;
  if (name.type !== 'string') return false;
  const text = stringValue(name);
  return Number.isFinite(Number(text)) && String(Number(text)) === text;
}

/** Whether an index is a string literal, or a template literal without substitutions, not in parentheses. */
function isStringLiteralIndex(index: TreeNode): boolean {
  return (
    index.type === 'string' ||
    (index.type === 'template_string' && !named(index).some((child) => child.type === 'template_substitution'))
  );
}
