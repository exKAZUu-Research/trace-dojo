import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { decodeTemplateFragment } from '../../javascript/literals';
import type { Checker } from './checker';
import { named, stringValue } from './syntax';

/**
 * Checks an initializer written on an ambient variable or on an ambient or `declare` class field: TypeScript forbids
 * initializers in ambient contexts except unannotated `const` variables and `readonly` fields initialized with a
 * literal or an enum member reference.
 */
export function checkAmbientInitializer(c: Checker, node: TreeNode, isConstOrReadonly: boolean): void {
  const value = node.childForFieldName('value');
  if (!value) return;
  if (!isConstOrReadonly || node.childForFieldName('type') !== null) {
    c.error(value, '初期化子は環境コンテキストでは使用できません。');
    return;
  }
  if (!isAmbientConstInitializer(c, value)) {
    c.error(
      value,
      "環境コンテキストの 'const' 初期化子は、文字列または数値リテラル、もしくはリテラル列挙型の参照である必要があります。"
    );
  }
}

function isAmbientConstInitializer(c: Checker, value: TreeNode): boolean {
  if (value.type === 'string' || value.type === 'number' || value.type === 'true' || value.type === 'false')
    return true;
  if (value.type === 'template_string') return !named(value).some((child) => child.type === 'template_substitution');
  if (value.type === 'unary_expression')
    return value.childForFieldName('operator')?.text === '-' && value.childForFieldName('argument')?.type === 'number';
  if (value.type === 'member_expression') return c.namespaces.qualifiedValueSymbol(value)?.valueKind === 'enumMember';
  if (value.type === 'subscript_expression') return isAmbientEnumElementAccess(c, value);
  return false;
}

function isAmbientEnumElementAccess(c: Checker, value: TreeNode): boolean {
  const object = value.childForFieldName('object');
  const index = value.childForFieldName('index');
  const key = index ? staticLiteralKey(index) : undefined;
  const enumSymbol = object ? c.namespaces.qualifiedValueSymbol(object) : undefined;
  return key !== undefined && enumSymbol?.valueKind === 'enum' && enumSymbol.enumMembers?.values.has(key) === true;
}

function staticLiteralKey(node: TreeNode): string | undefined {
  if (node.type === 'string') return stringValue(node);
  if (node.type !== 'template_string' || named(node).some((child) => child.type === 'template_substitution'))
    return undefined;
  return decodeTemplateFragment(node.text.slice(1, -1));
}
