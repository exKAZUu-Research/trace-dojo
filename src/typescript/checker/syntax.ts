import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CompileError } from '../../interpreter/diagnostics';

/** The named children of a node, without comments. */
export function named(node: TreeNode): TreeNode[] {
  return node.namedChildren.filter((child): child is TreeNode => child !== null && child.type !== 'comment');
}

const typeNameContainers = new Set([
  'abstract_class_declaration',
  'class',
  'class_declaration',
  'generic_type',
  'interface_declaration',
  'mapped_type_clause',
  'type_alias_declaration',
  'type_parameter',
]);

export function isStandaloneTypeReference(node: TreeNode): boolean {
  if (node.type !== 'type_identifier') return false;
  const parent = node.parent;
  if (!parent) return true;
  if (parent.type === 'nested_type_identifier') return false;
  if (parent.type === 'infer_type') return named(parent)[0]?.id !== node.id;
  return !typeNameContainers.has(parent.type) || parent.childForFieldName('name')?.id !== node.id;
}

export function* bigIntPropertyNames(root: TreeNode): Iterable<TreeNode> {
  for (const property of root.descendantsOfType(['pair', 'field_definition', 'property_signature'])) {
    const name = property.childForFieldName(property.type === 'pair' ? 'key' : 'name');
    if (name?.type === 'number' && name.text.endsWith('n')) yield name;
  }
}

export function hasToken(node: TreeNode, token: string): boolean {
  return node.children.some((child) => child !== null && !child.isNamed && child.type === token);
}

export function isWithin(node: TreeNode, ancestor: TreeNode): boolean {
  for (let current: TreeNode | null = node; current; current = current.parent)
    if (current.id === ancestor.id) return true;
  return false;
}

export function childOfType(node: TreeNode, type: string): TreeNode | undefined {
  return node.namedChildren.find((child): child is TreeNode => child?.type === type);
}

/** The identifiers a binding pattern declares, in order. */
export function patternIdentifiers(pattern: TreeNode): TreeNode[] {
  switch (pattern.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
    case 'shorthand_property_identifier': {
      return [pattern];
    }
    case 'assignment_pattern':
    case 'object_assignment_pattern':
    case 'assignment_expression': {
      const left = pattern.childForFieldName('left');
      return left ? patternIdentifiers(left) : [];
    }
    case 'pair_pattern':
    case 'pair': {
      const value = pattern.childForFieldName('value');
      return value ? patternIdentifiers(value) : [];
    }
    case 'rest_pattern':
    case 'spread_element':
    case 'array_pattern':
    case 'object_pattern':
    case 'array':
    case 'object': {
      return named(pattern).flatMap((child) => patternIdentifiers(child));
    }
    default: {
      return [];
    }
  }
}

/**
 * The number of positions of an array literal, holes included: every comma ends a position, and only the last comma,
 * when nothing follows it, ends none of its own.
 */
export function arrayLiteralLength(array: TreeNode): number {
  const parts = array.children.filter((child) => child && !['[', ']', 'comment'].includes(child.type));
  const commas = parts.filter((child) => child?.type === ',').length;
  return parts.length === 0 || parts.at(-1)?.type === ',' ? commas : commas + 1;
}

export function isDirectEmptyArray(node: TreeNode | null | undefined): boolean {
  return node?.type === 'array' && arrayLiteralLength(node) === 0;
}

/** The elements of an array literal or pattern with their positions, which holes such as `[, x]` skip. */
export function arrayPatternElements(pattern: TreeNode): { element: TreeNode; index: number }[] {
  const elements: { element: TreeNode; index: number }[] = [];
  let index = 0;
  for (const child of pattern.children) {
    if (!child || child.type === '[' || child.type === ']' || child.type === 'comment') continue;
    if (child.type === ',') index++;
    else elements.push({ element: child, index });
  }
  return elements;
}

/**
 * How an assignment changes a node, as tsc's `getAssignmentTargetKind` tells: an update or an arithmetic compound
 * assignment reads it first, while `=` and the logical assignments count as assigning it outright.
 */
export function assignmentKind(node: TreeNode): 'definite' | 'compound' | undefined {
  let target = node;
  while (target.parent?.type === 'parenthesized_expression') target = target.parent;
  const { parent } = target;
  if (parent?.type === 'update_expression') return 'compound';
  if (parent?.childForFieldName('left')?.id !== target.id) return undefined;
  if (parent.type === 'assignment_expression') return 'definite';
  if (parent.type !== 'augmented_assignment_expression') return undefined;
  return ['&&=', '||=', '??='].includes(parent.childForFieldName('operator')?.text ?? '') ? 'definite' : 'compound';
}

/** An expression without the type assertions and parentheses around it, which do not change its value. */
export function withoutAssertions(node: TreeNode): TreeNode {
  let expression = node;
  for (;;) {
    expression = skipParentheses(expression);
    if (['as_expression', 'satisfies_expression', 'non_null_expression'].includes(expression.type))
      expression = named(expression)[0];
    else if (expression.type === 'type_assertion') expression = named(expression).at(-1) as TreeNode;
    else return expression;
  }
}

export function skipNonNullAssertions(node: TreeNode): TreeNode {
  let current = skipParentheses(node);
  while (current.type === 'non_null_expression') current = skipParentheses(named(current)[0]);
  return current;
}

/** The expression inside parentheses. */
export function skipParentheses(node: TreeNode): TreeNode {
  let current = node;
  while (current.type === 'parenthesized_expression') {
    const inner = named(current)[0];
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/** The name of a property name node, or undefined for a computed one that is not a literal. */
export function propertyNameText(node: TreeNode): string | undefined {
  switch (node.type) {
    case 'property_identifier':
    case 'identifier':
    case 'type_identifier':
    case 'private_property_identifier':
    case 'shorthand_property_identifier': {
      return node.text;
    }
    case 'string': {
      return stringValue(node);
    }
    case 'number': {
      const value = numberValue(node.text);
      return value !== undefined ? String(value) : undefined;
    }
    case 'computed_property_name': {
      const inner = named(node)[0];
      if (inner?.type === 'string') return stringValue(inner);
      if (inner?.type === 'number') {
        const value = numberValue(inner.text);
        return value !== undefined ? String(value) : undefined;
      }
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/** Whether a node is a class's constructor, not an object literal's method named `constructor`. */
export function isClassConstructor(node: TreeNode): boolean {
  return (
    node.type === 'method_definition' &&
    node.parent?.type === 'class_body' &&
    isConstructorName(node.childForFieldName('name'))
  );
}

/**
 * The parameters that take arguments: all but a first `this` parameter, which types the receiver. tsc reads a `this`
 * parameter in a later position as an ordinary parameter, after reporting it.
 */
export function argumentParameters(parameters: TreeNode[]): TreeNode[] {
  return parameters.length > 0 && isThisParameter(parameters[0]) ? parameters.slice(1) : parameters;
}

export function isThisParameter(parameter: TreeNode): boolean {
  return (parameter.childForFieldName('pattern') ?? parameter).type === 'this';
}

/** Whether a parameter carries a modifier that makes it a parameter property, as `private x: number`. */
export function isParameterProperty(parameter: TreeNode): boolean {
  return parameter.children.some(
    (child) =>
      child?.type === 'accessibility_modifier' || child?.type === 'readonly' || child?.type === 'override_modifier'
  );
}

/** Whether a class member's name makes it the constructor: `constructor` as a name or a string, but not computed. */
export function isConstructorName(name: TreeNode | null | undefined): boolean {
  if (name?.type === 'property_identifier') return name.text === 'constructor';
  return name?.type === 'string' && stringValue(name) === 'constructor';
}

/** Whether a property name is numeric, which a number index signature covers: `1`, `1.5`, and `-1` but not `01`. */
export function isNumericName(name: string): boolean {
  return String(Number(name)) === name;
}

/** The value of a string literal node. */
export function stringValue(node: TreeNode): string {
  let value = '';
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'string_fragment') value += child.text;
    else if (child.type === 'escape_sequence') value += decodeEscape(child);
  }
  return value;
}

export function templateFragmentText(node: TreeNode): string {
  if (node.type === 'escape_sequence') return decodeEscape(node);
  return node.text.replaceAll(/\r\n?/g, '\n');
}

export function isConstAssertion(node: TreeNode): boolean {
  if (node.type !== 'as_expression' && node.type !== 'type_assertion') return false;
  const type = node.type === 'type_assertion' ? named(named(node)[0])[0] : named(node)[1];
  return !type || hasToken(node, 'const') || type.text === 'const';
}

export function isRawTypeTemplateFragment(node: TreeNode): boolean {
  const parent = node.parent;
  return parent?.type === 'template_literal_type' && !named(parent).some((child) => child.type === 'template_type');
}

/** Whether `node` is the template of `` tag`...` ``, which stands for the `TemplateStringsArray` argument. */
export function isTaggedTemplateArgument(node: TreeNode): boolean {
  return (
    node.type === 'template_string' &&
    node.parent?.type === 'call_expression' &&
    node.parent.childForFieldName('arguments')?.id === node.id
  );
}

export function hasInvalidCharacterEscape(node: TreeNode): boolean {
  if (node.type !== 'escape_sequence') return false;
  const body = node.text.slice(1);
  if (body.startsWith('u{'))
    return !/^u\{[\da-f]+\}$/i.test(body) || Number.parseInt(body.slice(2, -1), 16) > 0x10_ff_ff;
  if (body.startsWith('u')) return !/^u[\da-f]{4}$/i.test(body);
  if (body.startsWith('x')) return !/^x[\da-f]{2}$/i.test(body);
  return false;
}

const simpleEscapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function decodeEscape(node: TreeNode): string {
  const { text } = node;
  const body = text.slice(1);
  if (
    isRawTypeTemplateFragment(node) &&
    (hasInvalidCharacterEscape(node) ||
      /^[1-9]/.test(body) ||
      (body.startsWith('0') && (body.length > 1 || /[0-9]/.test(node.nextSibling?.text[0] ?? ''))))
  )
    return text;
  if (hasInvalidCharacterEscape(node))
    throw new CompileError([
      { row: node.startPosition.row, message: 'エスケープシーケンスの書き方に誤りがあります。' },
    ]);
  if (body in simpleEscapes) return simpleEscapes[body];
  if (body.startsWith('x')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('u{')) return String.fromCodePoint(Number.parseInt(body.slice(2, -1), 16));
  if (body.startsWith('u')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('\r') || body.startsWith('\n')) return '';
  return body;
}

/** The value of a numeric literal, or a bigint for one ending with `n`. */
export function numberValue(text: string): number | bigint {
  const clean = text.replaceAll('_', '');
  if (clean.endsWith('n')) return BigInt(clean.slice(0, -1));
  if (/^0[0-7]+$/.test(clean)) return Number.parseInt(clean, 8);
  return Number(clean);
}

/** Whether a node is a function whose `this` is its own, rather than an arrow function's enclosing one. */
export function isFunctionWithOwnThis(node: TreeNode): boolean {
  return [
    'function_declaration',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
    'method_definition',
    'class_static_block',
  ].includes(node.type);
}

/** Whether a node is a link of an optional chain: `a?.b`, or a link continuing one without parentheses, as `a?.b.c`. */
export function isOptionalChain(node: TreeNode): boolean {
  const object = chainObject(node);
  return object !== undefined && (node.childForFieldName('optional_chain') !== null || isOptionalChain(object));
}

/** The expression a link of a chain continues, as `a?.b` for `a?.b.c`, `a?.b()`, and `a?.b!`. */
export function chainObject(node: TreeNode): TreeNode | undefined {
  switch (node.type) {
    case 'member_expression':
    case 'subscript_expression': {
      return node.childForFieldName('object') ?? undefined;
    }
    case 'call_expression': {
      return node.childForFieldName('function') ?? undefined;
    }
    case 'non_null_expression': {
      return named(node)[0];
    }
    default: {
      return undefined;
    }
  }
}

/** Whether TypeScript inlines the flow of a synchronous, non-generator immediate call. */
export function isInlinedInvocation(node: TreeNode): boolean {
  return (
    (node.type === 'arrow_function' || node.type === 'function_expression') &&
    !hasToken(node, 'async') &&
    isImmediatelyInvoked(node)
  );
}

export function isImmediatelyInvoked(node: TreeNode): boolean {
  let expression = node;
  while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
  const parent = expression.parent;
  return parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === expression.id;
}

/** The labels a chain of labeled statements gives, and the statement they label. */
export function labeledBody(node: TreeNode): { labels: string[]; body: TreeNode | undefined } {
  const labels: string[] = [];
  let body: TreeNode | null = node;
  while (body?.type === 'labeled_statement') {
    labels.push(body.childForFieldName('label')?.text ?? '');
    body = body.childForFieldName('body');
  }
  return { labels, body: body ?? undefined };
}

/** The label a `break` or `continue` jumps to, if it names one. */
export function jumpLabel(jump: TreeNode): string | undefined {
  return named(jump).find((child) => child.type === 'statement_identifier')?.text;
}

export const loopStatementTypes = new Set(['while_statement', 'do_statement', 'for_statement', 'for_in_statement']);

export function isGlobalAugmentationNamespace(node: TreeNode): boolean {
  const name = node.childForFieldName('name');
  return (
    node.type === 'internal_module' &&
    !hasToken(node, 'namespace') &&
    name?.type === 'identifier' &&
    name.text === 'global'
  );
}

export function isTopLevelAmbientModule(node: TreeNode | null | undefined): boolean {
  if (
    (node?.type !== 'module' && node?.type !== 'internal_module') ||
    node.childForFieldName('name')?.type !== 'string'
  )
    return false;
  let container = node.parent;
  while (container && (container.type === 'ambient_declaration' || container.type === 'export_statement')) {
    container = container.parent;
  }
  return container?.type === 'program';
}

export function isAmbientModuleBody(node: TreeNode | null | undefined): boolean {
  return node?.type === 'statement_block' && isTopLevelAmbientModule(node.parent);
}

export function isNamespaceBody(node: TreeNode | null | undefined): boolean {
  const owner = node?.type === 'statement_block' ? node.parent : undefined;
  return (
    (owner?.type === 'internal_module' || owner?.type === 'module') &&
    owner.childForFieldName('name')?.type !== 'string' &&
    !isGlobalAugmentationNamespace(owner)
  );
}

export function isDirectGlobalAugmentationContainer(node: TreeNode, isExternalModule: boolean): boolean {
  return isExternalModule ? node.parent?.type === 'program' : isAmbientModuleBody(node.parent);
}

/** Whether a program has an `import` or an `export`, which makes it a module. */
export function isModule(root: TreeNode): boolean {
  return root.namedChildren.some((child) => child?.type === 'import_statement' || child?.type === 'export_statement');
}
