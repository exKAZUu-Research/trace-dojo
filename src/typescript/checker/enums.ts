import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { numberArithmetic } from '../../javascript/expressionEvaluator';
import { decodeTemplateFragment } from '../../javascript/literals';
import { isAmbient } from '../namespaceInstantiation';
import type { Checker } from './checker';
import type { Sym } from './scopes';
import { hasToken, isWithin, named, numberValue, propertyNameText, skipParentheses, stringValue } from './syntax';
import {
  anonymousObject,
  emptyStructure,
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
  /** The type the enum's name stands for: the union of its members' literal types, or `number` with a computed member. */
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

  /** A `const enum` has no object to use as a value, only members to read, which TypeScript compiles to their values. */
  checkConstEnumUse(node: TreeNode, symbol: Sym): void {
    if (!isConstEnum(symbol) || isAllowedConstEnumUse(node)) return;
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
    for (const member of named(node.childForFieldName('body') as TreeNode)) {
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
    }
  }

  /** Reports a member that a namespace merged with its enum also exports, at both declarations, as tsc does. */
  private checkMergedNamespaceClash(member: TreeNode, symbol: Sym): void {
    const name = memberNameOf(member);
    const exports = symbol.namespaceExports;
    if (name === undefined || !exports) return;
    const exported = [exports.values.get(name), exports.types.get(name)].filter((other) => other !== undefined);
    if (exported.length === 0) return;
    const { node, message } = duplicateError(member, name);
    this.c.error(node, message);
    for (const other of exported)
      for (const declaration of [...other.valueDeclarations, ...other.typeDeclarations])
        this.c.error(declaration.childForFieldName('name') ?? declaration, message);
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
    const literals = [...members.values()].filter((member) => member.value !== undefined);
    const types = literals.map((member) => {
      member.type = enumLiteralType(member.value as EnumValue, symbol.name, member.name, () => info.type);
      return member.type;
    });
    const isUnion = literals.length === members.size && types.length > 0;
    const union = isUnion ? unionOf(types) : numberType;
    if (union.kind === 'union') union.enumName = symbol.name;
    info.type = union;
    for (const member of members.values()) if (member.value === undefined) member.type = numberType;
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
          message: 'enum の宣言は、名前空間かほかの enum の宣言とだけ統合できます。',
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
      const value = this.evaluate(initializer, context);
      const message = initializerError(value, context.isConst, isAmbient(memberNode));
      if (message) context.errors.push({ node: initializer, message });
      return value;
    }
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
          this.constantVariableValue(expression, evaluation)
        );
      }
      case 'member_expression':
      case 'subscript_expression': {
        return this.otherEnumMember(expression, evaluation);
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

  /** The value of a `const` an initializer names, when a constant expression initializes it, as tsc evaluates it. */
  private constantVariableValue(name: TreeNode, evaluation: Evaluation): EnumValue | undefined {
    const variable = this.c.scopeOf(name).lookupValue(name.text);
    const declaration = variable?.valueDeclaration;
    const value = declaration?.type === 'variable_declarator' ? declaration.childForFieldName('value') : undefined;
    if (variable?.valueKind !== 'const' || !value || this.evaluatingConstants.has(variable.id)) return undefined;
    this.evaluatingConstants.add(variable.id);
    try {
      return this.evaluate(value, { ...evaluation, members: new Map() });
    } finally {
      this.evaluatingConstants.delete(variable.id);
    }
  }

  /** The value of `E.A` or `E["A"]`, a member of this or another enum. */
  private otherEnumMember(node: TreeNode, evaluation: Evaluation): EnumValue | undefined {
    const object = node.childForFieldName('object');
    if (object?.type !== 'identifier') return undefined;
    const key =
      node.type === 'member_expression'
        ? node.childForFieldName('property')?.text
        : (() => {
            const index = node.childForFieldName('index');
            return index?.type === 'string' ? stringValue(index) : undefined;
          })();
    if (key === undefined) return undefined;
    const other = this.c.scopeOf(object).lookupValue(object.text);
    if (other?.valueKind !== 'enum') return undefined;
    if (other.id === evaluation.symbol.id) return this.ownMemberValue(node, key, evaluation);
    const member = this.infoOf(other)?.members.get(key);
    if (member && member.node.startIndex > node.startIndex) return this.forwardReference(node, evaluation);
    return member?.value;
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
      if (hasNumericMember) structure.numberIndex = { type: stringType, readonly: true };
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

function enumLiteralType(value: EnumValue, enumName: string, name: string, base: () => Type): LiteralType {
  const enumMember = { enumName, name, base };
  const regular = { kind: 'literal', id: newTypeId(), value, fresh: false, enumMember } as LiteralType;
  const fresh = {
    kind: 'literal',
    id: newTypeId(),
    value,
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
