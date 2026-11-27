import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { checkAmbientExportTarget, exportEqualsTargetOf } from './ambientModuleExports';
import type { Checker } from './checker';
import type { Sym } from './scopes';
import { hasToken, named, stringValue } from './syntax';

/** Checks `export = Target` inside an ambient module declaration, including TS2300 and TS2309 module-wide conflicts. */
export function checkAmbientExportAssignment(c: Checker, node: TreeNode, assigned: TreeNode): void {
  checkAmbientExportTarget(c, assigned);
  const module = c.scopeOf(node).namespace;
  if (!module) return;
  if (countAmbientExportAssignments(module) > 1) {
    c.error(assigned, "識別子 'export=' が重複しています。");
  }
  if (hasOtherAmbientValueExports(c, module)) {
    c.error(node, 'エクスポートの代入は、エクスポートされた他の要素を含むモジュールでは使用できません。');
  }
}

function countAmbientExportAssignments(module: Sym): number {
  let count = 0;
  for (const declaration of module.valueDeclarations) {
    const body = declaration.childForFieldName('body');
    if (!body) continue;
    for (const child of named(body)) {
      if (child.type === 'export_statement' && exportEqualsTargetOf(child)) count++;
    }
  }
  return count;
}

function hasOtherAmbientValueExports(c: Checker, module: Sym): boolean {
  return hasDirectValueExports(c, module) || hasReExportedValues(c, module);
}

function hasDirectValueExports(c: Checker, module: Sym): boolean {
  for (const member of module.namespaceExports?.values.values() ?? []) {
    if (isExportedValueSymbol(c, member)) return true;
  }
  return false;
}

function isExportedValueSymbol(c: Checker, member: Sym): boolean {
  if (member.valueKind === 'namespace') return c.namespaces.isInstantiated(member);
  if (member.valueKind === 'importAlias' || member.valueKind === 'import') {
    const target = c.namespaces.imported(member, 'value');
    return Boolean(target && (target.valueKind !== 'namespace' || c.namespaces.isInstantiated(target)));
  }
  return true;
}

function hasReExportedValues(c: Checker, module: Sym): boolean {
  for (const declaration of module.valueDeclarations) {
    const body = declaration.childForFieldName('body');
    if (!body) continue;
    for (const child of named(body)) {
      if (child.type === 'export_statement' && statementReExportsValue(c, child)) return true;
    }
  }
  return false;
}

function statementReExportsValue(c: Checker, child: TreeNode): boolean {
  const source = child.childForFieldName('source');
  if (!source || hasToken(child, 'type')) return false;
  const dep = c.namespaces.moduleNamed(stringValue(source));
  if (!dep) return false;
  const clause = named(child).find((part) => part.type === 'export_clause');
  if (clause) return clauseReExportsValue(c, clause, dep);
  if (named(child).some((part) => part.type === 'namespace_export')) return true;
  return dep.exportEquals
    ? Boolean(c.namespaces.exportEqualsSymbol(dep, 'value'))
    : hasOtherAmbientValueExports(c, dep);
}

function clauseReExportsValue(c: Checker, clause: TreeNode, dep: Sym): boolean {
  for (const specifier of named(clause)) {
    if (hasToken(specifier, 'type')) continue;
    const nameNode = specifier.childForFieldName('name');
    if (!nameNode) continue;
    const exportName = nameNode.type === 'string' ? stringValue(nameNode) : nameNode.text;
    if (depExportsValueNamed(c, dep, exportName)) return true;
  }
  return false;
}

function depExportsValueNamed(c: Checker, dep: Sym, name: string): boolean {
  if (dep.exportEquals) {
    if (name === 'default') return Boolean(c.namespaces.exportEqualsSymbol(dep, 'value'));
    const container =
      c.namespaces.exportEqualsSymbol(dep, 'namespace') ?? c.namespaces.exportEqualsSymbol(dep, 'value');
    const member = container?.namespaceExports?.values.get(name);
    return Boolean(member && isExportedValueSymbol(c, member));
  }
  const member = dep.namespaceExports?.values.get(name);
  return Boolean(member && isExportedValueSymbol(c, member));
}
