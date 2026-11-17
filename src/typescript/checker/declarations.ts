import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Scope, Sym } from './scopes';
import { hasToken, named, propertyNameText } from './syntax';
import { type Type, undefinedType, unionOf } from './types';

/** Reports the declarations TypeScript rejects for declaring a name twice, at every declaration it involves. */
export function checkDuplicateDeclarations(c: Checker, scopes: Scope[]): void {
  for (const scope of scopes) {
    for (const symbol of scope.values.values())
      if (symbol.valueEntries.some((entry) => !c.isLibrary(entry.name))) checkValueDuplicates(c, symbol);
    for (const symbol of scope.types.values()) {
      if (!symbol.typeEntries.some((entry) => !c.isLibrary(entry.name))) continue;
      checkTypeDuplicates(c, symbol);
      checkReservedTypeName(c, symbol);
    }
  }
}

const blockScopedKinds = new Set(['let', 'const', 'class']);

// code-gauge-allow functionCognitiveComplexity 19 -- Distinguishes block-scoped conflicts, mixed function/var declarations, repeated implementations, and compatible var redeclarations.
function checkValueDuplicates(c: Checker, symbol: Sym): void {
  const entries = symbol.valueEntries;
  if (entries.length < 2) return;
  const name = symbol.name;
  if (entries.some((entry) => blockScopedKinds.has(entry.kind))) {
    const kinds = new Set(entries.map((entry) => entry.kind));
    for (const entry of entries) {
      c.error(
        entry.name,
        kinds.size === 1 && entry.kind === 'class'
          ? `${name} はすでに宣言されています。`
          : `ブロックスコープの変数 ${name} はすでに宣言されています。`
      );
    }
    return;
  }
  if (entries.some((entry) => entry.kind === 'function') && entries.some((entry) => entry.kind === 'var')) {
    for (const entry of entries) c.error(entry.name, `${name} はすでに宣言されています。`);
    return;
  }
  if (entries.every((entry) => entry.kind === 'function')) {
    const implementations = symbol.valueDeclarations.filter(
      (declaration) => declaration.type === 'function_declaration'
    );
    if (implementations.length > 1) {
      for (const implementation of implementations) {
        c.error(implementation.childForFieldName('name') ?? implementation, `関数 ${name} の実装が重複しています。`);
      }
    }
    return;
  }
  if (entries.every((entry) => entry.kind === 'var')) checkVarRedeclarations(c, symbol);
}

/** A `var` declared again must have the same type each time. */
function checkVarRedeclarations(c: Checker, symbol: Sym): void {
  const types = symbol.valueDeclarations.map((declaration) =>
    c.silently(() => c.statements.declaredVariableType(symbol, declaration))
  );
  const [first] = types;
  for (const [index, type] of types.entries()) {
    if (index === 0 || c.relations.identical(type, first)) continue;
    c.error(
      symbol.valueEntries[index].name,
      `後の変数の宣言は、同じ型でなければいけません。変数 ${symbol.name} の型は '${c.print(first)}' ですが、ここでは '${c.print(type)}' です。`
    );
  }
}

const reservedTypeNames = new Set([
  'any',
  'unknown',
  'never',
  'void',
  'undefined',
  'null',
  'string',
  'number',
  'bigint',
  'boolean',
  'symbol',
  'object',
]);
const declarationKindNames: Record<string, string> = {
  alias: '型の別名',
  interface: 'インターフェース',
  class: 'クラス',
};

/** Reports a type, interface, or class named as a predefined type, such as `type number = string`. */
function checkReservedTypeName(c: Checker, symbol: Sym): void {
  if (!reservedTypeNames.has(symbol.name)) return;
  for (const entry of symbol.typeEntries) {
    const kind = declarationKindNames[entry.kind];
    if (kind) c.error(entry.name, `${kind}の名前に '${symbol.name}' は使えません。`);
  }
}

function checkTypeDuplicates(c: Checker, symbol: Sym): void {
  const entries = symbol.typeEntries;
  if (entries.length < 2) return;
  const kinds = entries.map((entry) => entry.kind);
  // Interfaces merge with each other and with a class; any other pair declares the name twice.
  const merges =
    kinds.every((kind) => kind === 'interface' || kind === 'class') &&
    kinds.filter((kind) => kind === 'class').length <= 1;
  if (!merges) {
    // Two classes report as values.
    if (kinds.every((kind) => kind === 'class')) return;
    for (const entry of entries) c.error(entry.name, `${symbol.name} はすでに宣言されています。`);
    return;
  }
  checkMergedTypeParameters(c, symbol);
  checkMergedProperties(c, symbol);
}

// code-gauge-allow functionCognitiveComplexity 19 -- Validates parameter order, defaulted additions, and agreement of constraints and defaults across merged declarations.
function checkMergedTypeParameters(c: Checker, symbol: Sym): void {
  const lists = symbol.typeDeclarations.map((declaration) => {
    const parameters = declaration.childForFieldName('type_parameters');
    return parameters ? named(parameters) : [];
  });
  let mismatch = false;
  const seen = new Map<string, TreeNode>();
  for (const list of lists) {
    for (const [index, parameter] of list.entries()) {
      const name = parameter.childForFieldName('name')?.text ?? '';
      if (lists.some((other) => other[index] && other[index].childForFieldName('name')?.text !== name)) mismatch = true;
      if (lists.some((other) => other.length <= index) && !parameter.childForFieldName('value')) mismatch = true;
      if (!mergedParameterTypesAgree(c, parameter, name, seen)) mismatch = true;
    }
  }
  if (mismatch)
    for (const entry of symbol.typeEntries)
      c.error(entry.name, `同じ名前の型 ${symbol.name} の宣言は、同じ型パラメーターを持つ必要があります。`);
}

function mergedParameterTypesAgree(
  c: Checker,
  parameter: TreeNode,
  name: string,
  seen: Map<string, TreeNode>
): boolean {
  let matches = true;
  for (const field of ['constraint', 'value']) {
    const node = parameter.childForFieldName(field);
    if (!node) continue;
    const key = `${name}.${field}`;
    const previous = seen.get(key);
    if (
      previous &&
      !c.relations.identical(c.typeNodes.typeFromNode(named(previous)[0]), c.typeNodes.typeFromNode(named(node)[0]))
    )
      matches = false;
    else seen.set(key, node);
  }
  return matches;
}

/** A property declared again in a merged interface must have the same type. */
function checkMergedProperties(c: Checker, symbol: Sym): void {
  const seen = new Map<string, TreeNode>();
  for (const declaration of symbol.typeDeclarations) {
    if (declaration.type !== 'interface_declaration') continue;
    const body = declaration.childForFieldName('body');
    for (const member of body ? named(body) : []) {
      if (member.type === 'property_signature') checkMergedProperty(c, member, seen);
    }
  }
}

function checkMergedProperty(c: Checker, member: TreeNode, seen: Map<string, TreeNode>): void {
  const nameNode = member.childForFieldName('name');
  const name = nameNode ? propertyNameText(nameNode) : undefined;
  if (!nameNode || name === undefined) return;
  const previous = seen.get(name);
  if (!previous) {
    seen.set(name, member);
    return;
  }
  const modifiersDiffer = ['?', 'readonly'].some(
    (modifier) => hasToken(previous, modifier) !== hasToken(member, modifier)
  );
  if (modifiersDiffer) {
    for (const declaration of [previous, member])
      c.error(
        declaration.childForFieldName('name') ?? declaration,
        `プロパティ ${name} の宣言の修飾子は同じでなければいけません。`
      );
  }
  const effectiveType = (declaration: TreeNode): Type | undefined => {
    const type = c.typeNodes.annotationType(declaration.childForFieldName('type'));
    return type && hasToken(declaration, '?') ? unionOf([type, undefinedType]) : type;
  };
  const before = effectiveType(previous);
  const after = effectiveType(member);
  if (before && after && !c.relations.identical(before, after)) {
    c.error(
      nameNode,
      `後のプロパティの宣言は、同じ型でなければいけません。プロパティ ${name} の型は '${c.print(before)}' ですが、ここでは '${c.print(after)}' です。`
    );
  }
}

/** Reports class members declared twice: fields, method implementations, and constructors. */
export function checkDuplicateMembers(c: Checker, body: TreeNode): void {
  const groups = new Map<string, TreeNode[]>();
  for (const member of named(body)) {
    addParameterPropertyDuplicates(member, groups);
    const key = duplicateKeyOf(member);
    if (key === undefined) continue;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const accessorPair =
      members.length === 2 &&
      members.every((member) => member.type === 'method_definition') &&
      members.some((member) => hasToken(member, 'get')) &&
      members.some((member) => hasToken(member, 'set'));
    if (!accessorPair) reportDuplicateMembers(c, key, members);
  }
}

function addParameterPropertyDuplicates(member: TreeNode, groups: Map<string, TreeNode[]>): void {
  if (member.childForFieldName('name')?.text !== 'constructor') return;
  const parameters = member.childForFieldName('parameters');
  for (const parameter of parameters ? named(parameters) : []) {
    if (!hasToken(parameter, 'readonly') && !named(parameter).some((part) => part.type === 'accessibility_modifier'))
      continue;
    const pattern = parameter.childForFieldName('pattern');
    if (!pattern || pattern.type !== 'identifier') continue;
    const group = groups.get(pattern.text) ?? [];
    group.push(parameter);
    groups.set(pattern.text, group);
  }
}

/** The key under which a class member conflicts with others, or `undefined` if it cannot conflict. */
function duplicateKeyOf(member: TreeNode): string | undefined {
  if (!['field_definition', 'method_definition'].includes(member.type)) return undefined;
  const nameNode = member.childForFieldName('name');
  const name = nameNode ? propertyNameText(nameNode) : undefined;
  if (!nameNode || name === undefined) return undefined;
  // A method without a body is an overload signature, and a getter pairs with a setter.
  if (member.type === 'method_definition' && !member.childForFieldName('body')) return undefined;
  return `${hasToken(member, 'static') ? 'static ' : ''}${name}`;
}

function reportDuplicateMembers(c: Checker, key: string, members: TreeNode[]): void {
  const name = key.replace(/^static /, '');
  const isConstructor = name === 'constructor' && !key.startsWith('static ');
  for (const member of members) {
    const nameNode = member.childForFieldName('name') ?? member.childForFieldName('pattern') ?? member;
    if (isConstructor) c.error(nameNode, 'コンストラクタの実装は1つしか書けません。');
    else if (members.every((other) => other.type === 'method_definition'))
      c.error(nameNode, `メソッド ${name} の実装が重複しています。`);
    else c.error(nameNode, `${name} はすでに宣言されています。`);
  }
}
