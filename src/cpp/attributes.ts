import { compileError, unsupported } from './errors';
import { fieldOf, type Syntax } from './syntax';

/** The attributes that change how objects are laid out, which the interpreter leaves out. */
const LAYOUT_ATTRIBUTES: Record<string, string> = {
  no_unique_address: '[[no_unique_address]]',
  packed: '__attribute__((packed))',
  aligned: '__attribute__((aligned))',
};

const ATTRIBUTE_NODES = new Set(['attribute_declaration', 'attribute_specifier']);

/**
 * Checks the attributes of a translation unit and removes them, since none of those the interpreter accepts changes
 * what a program does: they only ask for warnings (`[[nodiscard]]`, `[[fallthrough]]`) or optimizations
 * (`[[likely]]`).
 */
export function stripAttributes(root: Syntax): Syntax {
  return strip(root, false);
}

function strip(node: Syntax, inSwitch: boolean): Syntax {
  if (node.type === 'attributed_statement') {
    const names = attributeNames(node.children.filter((child) => ATTRIBUTE_NODES.has(child.type)));
    if (names.includes('fallthrough') && !inSwitch)
      compileError(node.row, '[[fallthrough]] は switch 文の中にしか書けません。');
    const statement = node.children.find((child) => !ATTRIBUTE_NODES.has(child.type)) as Syntax;
    return { ...strip(statement, inSwitch), field: node.field };
  }
  if (node.type === 'attributed_declarator') {
    const inner = node.children.find((child) => !ATTRIBUTE_NODES.has(child.type)) as Syntax;
    checkAttributes(
      node.children.filter((child) => ATTRIBUTE_NODES.has(child.type)),
      false
    );
    return { ...strip(inner, inSwitch), field: node.field };
  }
  const attributes = node.all.filter((child) => ATTRIBUTE_NODES.has(child.type));
  if (attributes.length > 0) checkAttributes(attributes, declaresFunction(node));
  if (attributes.length === 0 && !node.all.some(needsStripping)) return node;
  const childInSwitch = node.type === 'switch_statement' || (inSwitch && !isFunctionBoundary(node.type));
  const all = node.all.filter((child) => !ATTRIBUTE_NODES.has(child.type)).map((child) => strip(child, childInSwitch));
  return { ...node, all, children: all.filter((child) => child.isNamed) };
}

function needsStripping(node: Syntax): boolean {
  if (ATTRIBUTE_NODES.has(node.type) || node.type === 'attributed_statement' || node.type === 'attributed_declarator')
    return true;
  return node.all.some(needsStripping);
}

function isFunctionBoundary(type: string): boolean {
  return type === 'function_definition' || type === 'lambda_expression';
}

function declaresFunction(node: Syntax): boolean {
  if (node.type === 'function_definition') return true;
  const declarator = fieldOf(node, 'declarator');
  return declarator?.type === 'function_declarator';
}

function checkAttributes(attributes: readonly Syntax[], isFunction: boolean): void {
  for (const name of attributeNames(attributes)) {
    const layout = LAYOUT_ATTRIBUTES[name];
    if (layout) unsupported(attributes[0].row, layout);
    if (name === 'noreturn' && !isFunction)
      compileError(attributes[0].row, '[[noreturn]] は関数にしか付けられません。');
  }
}

function attributeNames(attributes: readonly Syntax[]): string[] {
  const names: string[] = [];
  for (const attribute of attributes) {
    if (attribute.type === 'attribute_specifier') {
      for (const argument of attribute.children[0]?.children ?? []) {
        const name = argument.type === 'call_expression' ? fieldOf(argument, 'function')?.text : argument.text;
        if (name) names.push(name.replace(/^__(.*)__$/, '$1'));
      }
      continue;
    }
    for (const child of attribute.children) {
      if (child.type === 'attribute') names.push((fieldOf(child, 'name') as Syntax).text.replace(/^__(.*)__$/, '$1'));
    }
  }
  return names;
}
