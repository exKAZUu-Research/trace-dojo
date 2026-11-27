import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import type { Checker } from './checker';
import { unavailableNodeMember } from './nodeLibrary';
import { canonicalIdentifier, type MeaningSpace, type Scope, Sym } from './scopes';
import { named, stringValue } from './syntax';
import { anyType, errorType, type Type } from './types';

/** Binds an unnamed `export default class / abstract class / function` inside an ambient module under `'default'`. */
export function bindAnonymousDefaultDeclaration(
  declaration: TreeNode,
  scope: Scope,
  exportNamed: (exportName: string, symbol: Sym, meaning: MeaningSpace) => void
): void {
  if (declaration.type === 'class_declaration' || declaration.type === 'abstract_class_declaration') {
    const symbol = new Sym('default', scope);
    symbol.valueKind = 'class';
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind: 'class', name: declaration });
    symbol.typeKind = 'class';
    symbol.typeDeclarations.push(declaration);
    symbol.typeEntries.push({ kind: 'class', name: declaration });
    exportNamed('default', symbol, 'value');
    exportNamed('default', symbol, 'type');
    return;
  }
  if (
    declaration.type === 'function_signature' ||
    declaration.type === 'function_declaration' ||
    declaration.type === 'generator_function_declaration'
  ) {
    const existing = (scope.namespace as Sym).namespaceExports?.values.get('default');
    const symbol = existing?.valueKind === 'function' ? existing : new Sym('default', scope);
    symbol.valueKind = 'function';
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind: 'function', name: declaration });
    exportNamed('default', symbol, 'value');
  }
}

/** Binds `export default Local;` in an ambient body after all declarations in the body have been bound. */
export function bindAmbientDefaultValueExport(node: TreeNode, scope: Scope, exports: Scope): void {
  if (!node.children.some((part) => !part.isNamed && part.type === 'default')) return;
  const value = node.childForFieldName('value');
  if (value?.type !== 'identifier') return;
  const localName = canonicalIdentifier(value.text, value);
  const valueSymbol = scope.values.get(localName);
  if (valueSymbol) exports.exportViaClause('default', valueSymbol, 'value');
  const typeSymbol = scope.types.get(localName);
  if (typeSymbol) exports.exportViaClause('default', typeSymbol, 'type');
  const namespaceSymbol = scope.namespaces.get(localName);
  if (namespaceSymbol) exports.exportViaClause('default', namespaceSymbol, 'namespace');
  if (valueSymbol || typeSymbol || namespaceSymbol) {
    exports.recordClauseExport('default', value, {
      value: valueSymbol,
      type: typeSymbol,
      namespace: namespaceSymbol,
    });
  }
}

/** Checks the target of `export default X` or `export = X` in an ambient context, which may name a value, type, or namespace. */
export function checkAmbientExportTarget(c: Checker, target: TreeNode): void {
  const path = entityNamePath(target);
  if (!path) {
    c.error(target, 'エクスポートの代入の式は、環境コンテキストの識別子または修飾名にする必要があります。');
    return;
  }
  if (path.length === 1) {
    const [ident] = path;
    const scope = c.scopeOf(ident);
    if (!scope.lookupValue(ident.text) && !scope.lookupType(ident.text) && !scope.lookupNamespace(ident.text, c.budget))
      c.error(ident, `名前 ${ident.text} が見つかりません。`);
    return;
  }
  const resolved = c.namespaces.resolveEntityPath(path);
  if (!resolved.symbol && resolved.error) c.error(target, resolved.error);
}

function entityNamePath(node: TreeNode): TreeNode[] | undefined {
  if (node.type === 'identifier') return [node];
  if (node.type !== 'member_expression' && node.type !== 'nested_identifier') return undefined;
  const left = node.childForFieldName('object') ?? node.childForFieldName('module');
  const right = node.childForFieldName('property') ?? node.childForFieldName('name');
  if (!left || !right || (right.type !== 'property_identifier' && right.type !== 'identifier')) return undefined;
  const prefix = entityNamePath(left);
  return prefix ? [...prefix, right] : undefined;
}

export function exportEqualsTargetOf(node: TreeNode): TreeNode | undefined {
  if (node.childForFieldName('declaration') || node.childForFieldName('value') || node.childForFieldName('source'))
    return undefined;
  if (!node.children.some((child) => !child.isNamed && child.type === '=')) return undefined;
  return named(node).find((child) => child.type !== 'export_clause' && child.type !== 'comment');
}

export function isImportTypeCall(node: TreeNode): boolean {
  return node.type === 'call_expression' && node.childForFieldName('function')?.type === 'import';
}

export function importTypeMemberChain(node: TreeNode): { call: TreeNode; members: TreeNode[] } | undefined {
  const members: TreeNode[] = [];
  let current = node;
  while (current.type === 'member_expression') {
    const object = current.childForFieldName('object');
    const property = current.childForFieldName('property');
    if (!object || !property) return undefined;
    members.unshift(property);
    current = object;
  }
  return isImportTypeCall(current) && members.length > 0 ? { call: current, members } : undefined;
}

export function resolveImportTypeModuleOf(c: Checker, callNode: TreeNode): Sym | undefined {
  const argumentsNode = callNode.childForFieldName('arguments');
  const first = argumentsNode ? named(argumentsNode)[0] : undefined;
  const literal = importSpecifierLiteral(first);
  if (!literal) {
    c.error(first ?? callNode, '文字列リテラルが必要です。');
    return undefined;
  }
  const specifier = stringValue(literal);
  const module = c.namespaces.moduleNamed(specifier);
  if (!module) {
    c.error(first ?? literal, `モジュール '${specifier}' またはそれに対応する型宣言が見つかりません。`);
    return undefined;
  }
  return module;
}

function importSpecifierLiteral(first: TreeNode | undefined): TreeNode | undefined {
  if (first?.type === 'string') return first;
  return first?.type === 'literal_type' && named(first)[0]?.type === 'string' ? named(first)[0] : undefined;
}

export function importTypeQueryOf(c: Checker, callNode: TreeNode): Type {
  const module = resolveImportTypeModuleOf(c, callNode);
  if (!module) return errorType;
  if (isShorthandAmbientModule(module)) return anyType;
  if (!module.exportEquals) return c.namespaces.objectType(module);
  const valueSymbol = c.namespaces.exportEqualsSymbol(module, 'value');
  if (valueSymbol) return c.expressions.valueTypeOf(valueSymbol);
  const namespaceSymbol = c.namespaces.exportEqualsSymbol(module, 'namespace');
  if (namespaceSymbol && c.namespaces.isInstantiated(namespaceSymbol)) return c.namespaces.objectType(namespaceSymbol);
  c.error(callNode, `モジュール '"${module.name}"' は値に解決されません。`);
  return errorType;
}

export function resolveImportTypeMemberOf(
  c: Checker,
  node: TreeNode,
  stepMember: (current: Sym, name: string, isLast: boolean) => Sym | undefined
): { symbol?: Sym; error?: string; site?: TreeNode } {
  const parts = importTypeMemberChain(node);
  if (!parts) return {};
  const { call, members } = parts;
  const module = resolveImportTypeModuleOf(c, call);
  if (!module) return {};
  const isLibrary = c.libraryBinder.ambientModules.get(module.name) === module;
  const firstUnavailable = isLibrary && unavailableNodeMember(`"${module.name}"`, members[0].text);
  if (firstUnavailable) {
    c.error(members[0], unsupportedMessage(firstUnavailable));
    return {};
  }
  const root = module.exportEquals
    ? (c.namespaces.exportEqualsSymbol(module, 'namespace') ?? c.namespaces.exportEqualsSymbol(module, 'value'))
    : module;
  if (!root) return missingNamespaceMember(`"${module.name}"`, members[0]);
  return walkImportTypeMembers(root, `"${module.name}"`, members, stepMember);
}

function walkImportTypeMembers(
  root: Sym,
  rootLabel: string,
  members: TreeNode[],
  stepMember: (current: Sym, name: string, isLast: boolean) => Sym | undefined
): { symbol?: Sym; error?: string; site?: TreeNode } {
  let current = root;
  let label = rootLabel;
  for (const [index, part] of members.entries()) {
    const isLast = index === members.length - 1;
    const member = stepMember(current, part.text, isLast);
    const canContinue =
      isLast || Boolean(member?.namespaceExports) || (member?.valueKind === 'enum' && index === members.length - 2);
    if (!member || !canContinue) return missingNamespaceMember(label, part);
    current = member;
    label = `${label}.${part.text}`;
  }
  return { symbol: current };
}

function missingNamespaceMember(label: string, site: TreeNode): { error: string; site: TreeNode } {
  return { error: `名前空間 '${label}' にエクスポートされたメンバー '${site.text}' がありません。`, site };
}

function isShorthandAmbientModule(module: Sym): boolean {
  return (
    module.valueDeclarations.length > 0 && module.valueDeclarations.every((decl) => !decl.childForFieldName('body'))
  );
}

export function matchWildcardAmbientModule(modules: ReadonlyMap<string, Sym>, specifier: string): Sym | undefined {
  let best: Sym | undefined;
  let bestPrefixLength = -1;
  for (const [pattern, symbol] of modules) {
    const star = pattern.indexOf('*');
    if (star === -1 || pattern.includes('*', star + 1)) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      prefix.length > bestPrefixLength
    ) {
      bestPrefixLength = prefix.length;
      best = symbol;
    }
  }
  return best;
}
