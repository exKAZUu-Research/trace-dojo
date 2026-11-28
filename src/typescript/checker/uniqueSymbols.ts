import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken } from './syntax';
import { isIntrinsic, type LiteralType, symbolType, type Type, uniqueSymbolType } from './types';

/** Gives a `Symbol()` call that declares a `const` or a `static readonly` property its unique symbol type, as tsc does. */
export class UniqueSymbols {
  /** The unique symbol type of each declaration, by its node. */
  private readonly types = new Map<number, LiteralType>();

  constructor(private readonly c: Checker) {}

  /** The type of a call that returns `callType`, which is a unique symbol when the call declares one. */
  typeOfCall(call: TreeNode, callType: Type): Type {
    if (!isIntrinsic(callType, 'symbol') || !this.isSymbolCall(call)) return callType;
    const declaration = uniqueSymbolDeclaration(call);
    return declaration ? (this.typeOfDeclaration(declaration) ?? callType) : callType;
  }

  /**
   * The type `unique symbol` stands for in the annotation of a declaration: that of the `const` or `static readonly`
   * property it declares, which is an error anywhere else.
   */
  typeOfAnnotation(node: TreeNode): Type {
    const declaration = node.parent?.type === 'type_annotation' ? node.parent.parent : undefined;
    const statement = declaration?.parent;
    if (declaration?.type === 'variable_declarator') {
      const isConst =
        statement?.type === 'lexical_declaration' && statement.childForFieldName('kind')?.text === 'const';
      if (!isConst) this.c.error(node, "型が 'unique symbol' の変数は、'const' で宣言しなければいけません。");
      return (isConst && this.typeOfDeclaration(declaration)) || symbolType;
    }
    if (declaration?.type === 'field_definition' || declaration?.type === 'property_signature') {
      const isClassField = declaration.type === 'field_definition';
      if ((!isClassField || hasToken(declaration, 'static')) && hasToken(declaration, 'readonly'))
        return this.typeOfDeclaration(declaration) ?? symbolType;
      this.c.error(
        node,
        isClassField
          ? "クラスのプロパティで型が 'unique symbol' のものは、'static' かつ 'readonly' でなければいけません。"
          : "インターフェースや型リテラルのプロパティで型が 'unique symbol' のものは、'readonly' でなければいけません。"
      );
      return symbolType;
    }
    this.c.error(node, "'unique symbol' 型は、ここでは使えません。");
    return symbolType;
  }

  private typeOfDeclaration(declaration: TreeNode): LiteralType | undefined {
    const name = declaration.childForFieldName('name')?.text;
    if (name === undefined) return undefined;
    let type = this.types.get(declaration.id);
    if (!type) {
      type = uniqueSymbolType(name);
      this.types.set(declaration.id, type);
    }
    return type;
  }

  /** Whether a call is `Symbol(…)` or `Symbol.for(…)` of the library's `Symbol`. */
  private isSymbolCall(call: TreeNode): boolean {
    if (call.childForFieldName('optional_chain')) return false;
    const callee = call.childForFieldName('function');
    const symbolNode =
      callee?.type === 'member_expression' && callee.childForFieldName('property')?.text === 'for'
        ? callee.childForFieldName('object')
        : callee;
    if (symbolNode?.type !== 'identifier' || symbolNode.text !== 'Symbol') return false;
    const declaration = this.c.scopeOf(symbolNode).lookupValue('Symbol')?.valueDeclaration;
    return declaration !== undefined && this.c.isLibrary(declaration);
  }
}

/**
 * The declaration a call initializes when it may declare a unique symbol: a `const` outside a `for` head, or a
 * `static readonly` property.
 */
function uniqueSymbolDeclaration(call: TreeNode): TreeNode | undefined {
  let value = call;
  while (value.parent?.type === 'parenthesized_expression') value = value.parent;
  const declaration = value.parent;
  if (declaration?.childForFieldName('value')?.id !== value.id) return undefined;
  if (declaration.type === 'variable_declarator') {
    const statement = declaration.parent;
    const isConst = statement?.type === 'lexical_declaration' && statement.childForFieldName('kind')?.text === 'const';
    const inStatement = statement?.parent?.type !== 'for_statement';
    return isConst && inStatement && declaration.childForFieldName('name')?.type === 'identifier'
      ? declaration
      : undefined;
  }
  const isStaticReadonly =
    declaration.type === 'field_definition' && hasToken(declaration, 'static') && hasToken(declaration, 'readonly');
  return isStaticReadonly ? declaration : undefined;
}
