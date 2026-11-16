import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Scope, Sym } from './scopes';
import { hasToken, named, propertyNameText } from './syntax';

/** Reports the declarations TypeScript rejects for declaring a name twice, at every declaration it involves. */
export function checkDuplicateDeclarations(c: Checker, scopes: Scope[]): void {
  for (const scope of scopes) {
    for (const symbol of scope.values.values()) checkValueDuplicates(c, symbol);
    for (const symbol of scope.types.values()) checkTypeDuplicates(c, symbol);
  }
}

const blockScopedKinds = new Set(['let', 'const', 'class']);

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
  checkMergedProperties(c, symbol);
}

/** A property declared again in a merged interface must have the same type. */
function checkMergedProperties(c: Checker, symbol: Sym): void {
  const seen = new Map<string, TreeNode>();
  for (const declaration of symbol.typeDeclarations) {
    if (declaration.type !== 'interface_declaration') continue;
    const body = declaration.childForFieldName('body');
    for (const member of body ? named(body) : []) {
      if (member.type !== 'property_signature') continue;
      const nameNode = member.childForFieldName('name');
      const name = nameNode ? propertyNameText(nameNode) : undefined;
      if (!nameNode || name === undefined) continue;
      const previous = seen.get(name);
      if (!previous) {
        seen.set(name, member);
        continue;
      }
      const before = c.annotationType(previous.childForFieldName('type'));
      const after = c.annotationType(member.childForFieldName('type'));
      if (before && after && !c.relations.identical(before, after)) {
        c.error(
          nameNode,
          `後のプロパティの宣言は、同じ型でなければいけません。プロパティ ${name} の型は '${c.print(before)}' ですが、ここでは '${c.print(after)}' です。`
        );
      }
    }
  }
}

/** Reports class members declared twice: fields, method implementations, and constructors. */
export function checkDuplicateMembers(c: Checker, body: TreeNode): void {
  const groups = new Map<string, TreeNode[]>();
  for (const member of named(body)) {
    if (!['public_field_definition', 'method_definition'].includes(member.type)) continue;
    const nameNode = member.childForFieldName('name');
    const name = nameNode ? propertyNameText(nameNode) : undefined;
    if (!nameNode || name === undefined) continue;
    // A method without a body is an overload signature, and a getter pairs with a setter.
    if (member.type === 'method_definition' && !member.childForFieldName('body')) continue;
    const accessor = hasToken(member, 'get') ? 'get' : hasToken(member, 'set') ? 'set' : '';
    const key = `${hasToken(member, 'static') ? 'static ' : ''}${name}${accessor ? ` ${accessor}` : ''}`;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const name = key.replace(/^static /, '').replace(/ [gs]et$/, '');
    const isConstructor = name === 'constructor' && !key.startsWith('static ');
    for (const member of members) {
      const nameNode = member.childForFieldName('name') ?? member;
      if (isConstructor) c.error(nameNode, 'コンストラクタの実装は1つしか書けません。');
      else if (members.every((other) => other.type === 'method_definition'))
        c.error(nameNode, `メソッド ${name} の実装が重複しています。`);
      else c.error(nameNode, `${name} はすでに宣言されています。`);
    }
  }
}
