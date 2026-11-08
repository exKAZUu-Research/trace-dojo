import type { Node } from '@willbooster/web-tree-sitter';

interface Binding {
  name: string;
  type: string;
  kind: 'local' | 'parameter' | 'field';
}
const numericTypes = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'char']);

/** Deliberately partial source facts: unresolved types never justify a pedagogical mutation. */
// code-gauge-allow functionCognitiveComplexity 26 -- Keep the deliberately supported expression forms together; unresolved forms return no fact.
// code-gauge-allow functionNcss 32 -- Each syntax case provides one conservative type fact.
export function expressionType(node: Node): string | undefined {
  if (node.type === 'identifier') return visibleBindings(node).find((b) => b.name === node.text)?.type;
  if (node.type === 'decimal_integer_literal' && /^\d+$/.test(node.text)) return 'int';
  if (node.type === 'decimal_floating_point_literal') return /[fF]$/.test(node.text) ? 'float' : 'double';
  if (node.type === 'true' || node.type === 'false') return 'boolean';
  if (node.type === 'string_literal') return 'String';
  if (node.type === 'character_literal') return 'char';
  if (node.type === 'object_creation_expression') return node.childForFieldName('type')?.text;
  if (node.type === 'array_access') {
    const array = node.childForFieldName('array');
    const type = array && expressionType(array);
    return type?.endsWith('[]') ? type.slice(0, -2) : undefined;
  }
  if (node.type === 'parenthesized_expression')
    return node.namedChildren[0] ? expressionType(node.namedChildren[0]) : undefined;
  if (node.type === 'unary_expression') {
    const operand = node.childForFieldName('operand') ?? node.namedChildren.at(-1);
    return operand ? expressionType(operand) : undefined;
  }
  if (node.type === 'binary_expression') return binaryType(node);
  if (node.type === 'field_access' && node.childForFieldName('object')?.text === 'this') {
    if (isStaticContext(node)) return;
    const name = node.childForFieldName('field')?.text;
    return classFields(node).find((b) => b.name === name)?.type;
  }
  return;
}

export function isNumeric(type: string | undefined): boolean {
  return type !== undefined && numericTypes.has(type);
}

/** Nearest declarations win, including incompatible bindings hiding otherwise compatible fields. */
export function visibleBindings(node: Node): Binding[] {
  const bindings = new Map<string, Binding>();
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'lambda_expression') break;
    for (const binding of unsupportedBindings(scope)) addBinding(bindings, binding);
    for (const binding of scopeBindings(scope, node.startIndex)) addBinding(bindings, binding);
    if (scope.type === 'class_body') {
      for (const binding of classFields(node)) addBinding(bindings, binding);
      break;
    }
  }
  return [...bindings.values()].filter((b) => knownType(node, b.type));
}

export function nearestCallable(node: Node): Node | undefined {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'method_declaration' || scope.type === 'constructor_declaration') return scope;
    if (['lambda_expression', 'class_body'].includes(scope.type)) return;
  }
  return;
}

export function isVoidMethod(node: Node): boolean {
  const callable = nearestCallable(node);
  return callable?.type === 'method_declaration' && callable.childForFieldName('type')?.text === 'void';
}

export function relatedClasses(node: Node, name: string): string[] {
  let root = node;
  while (root.parent) root = root.parent;
  const parents = new Map<string, string | undefined>();
  for (const declaration of root.namedChildren) {
    if (declaration?.type !== 'class_declaration') continue;
    const id = declaration.childForFieldName('name')?.text;
    if (id) parents.set(id, declaration.childForFieldName('superclass')?.namedChildren[0]?.text);
  }
  if (!parents.has(name)) return [];
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    let parent = parents.get(id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      parent = parents.get(parent);
    }
    return seen;
  };
  return [...parents.keys()].filter((id) => id !== name && (ancestors(name).has(id) || ancestors(id).has(name)));
}

/** Unknown binding types must still shadow outer declarations; skipping the binding would invent a false type. */
function unsupportedBindings(scope: Node): Binding[] {
  if (scope.type === 'enhanced_for_statement') {
    const name = scope.childForFieldName('name')?.text;
    return name ? [{ name, type: '', kind: 'local' }] : [];
  }
  const children =
    scope.type === 'catch_clause'
      ? scope.namedChildren
      : scope.type === 'try_with_resources_statement'
        ? (scope.childForFieldName('resources')?.namedChildren ?? [])
        : [];
  return children.flatMap((child) => {
    if (!child || !['catch_formal_parameter', 'resource'].includes(child.type)) return [];
    const name = child.childForFieldName('name')?.text;
    return name ? [{ name, type: '', kind: 'local' as const }] : [];
  });
}

function knownType(node: Node, type: string): boolean {
  const scalar = type.replaceAll('[]', '');
  if (numericTypes.has(scalar) || ['boolean', 'String', 'Turtle'].includes(scalar)) return true;
  let root = node;
  while (root.parent) root = root.parent;
  const matching: Node[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'class_declaration' && current.childForFieldName('name')?.text === scalar)
      matching.push(current);
    for (const child of current.namedChildren) if (child) stack.push(child);
  }
  return matching.length === 1 && matching[0].parent?.id === root.id;
}

function scopeBindings(scope: Node, before: number): Binding[] {
  if (['block', 'for_statement', 'switch_block_statement_group'].includes(scope.type))
    return scope.namedChildren
      .toReversed()
      .flatMap((declaration) =>
        declaration?.type === 'local_variable_declaration' ? declarators(declaration, before).toReversed() : []
      );
  if (scope.type !== 'method_declaration' && scope.type !== 'constructor_declaration') return [];
  return (scope.childForFieldName('parameters')?.namedChildren ?? []).flatMap((parameter) => {
    if (parameter?.type === 'spread_parameter') {
      const declaration = parameter.namedChildren.find((child) => child?.type === 'variable_declarator');
      const name = declaration?.childForFieldName('name')?.text;
      return name ? [{ name, type: '', kind: 'parameter' as const }] : [];
    }
    if (parameter?.type !== 'formal_parameter') return [];
    const name = parameter.childForFieldName('name')?.text;
    return name ? [{ name, type: declaredType(parameter, parameter) ?? '', kind: 'parameter' as const }] : [];
  });
}

function binaryType(node: Node): string | undefined {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  const a = expressionType(left),
    b = expressionType(right);
  const operator = node.childForFieldName('operator')?.text;
  if (['&&', '||'].includes(operator ?? '') && a === 'boolean' && b === 'boolean') return 'boolean';
  if (['<', '<=', '>', '>=', '==', '!='].includes(operator ?? '') && a && b) return 'boolean';
  if (operator === '+' && (a === 'String' || b === 'String')) return 'String';
  if (isNumeric(a) && isNumeric(b))
    return ['double', 'float', 'long'].find((type) => a === type || b === type) ?? 'int';
  return;
}

function classFields(node: Node): Binding[] {
  let scope = node.parent;
  while (scope && scope.type !== 'class_body') scope = scope.parent;
  const staticOnly = isStaticContext(node);
  return (scope?.namedChildren ?? []).flatMap((declaration) =>
    declaration?.type === 'field_declaration' && (!staticOnly || hasModifier(declaration, 'static'))
      ? declarators(declaration, Number.POSITIVE_INFINITY).map((b) => ({ ...b, kind: 'field' as const }))
      : []
  );
}

function isStaticContext(node: Node): boolean {
  const callable = nearestCallable(node);
  if (callable) return hasModifier(callable, 'static');
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'static_initializer') return true;
    if (scope.type === 'field_declaration') return hasModifier(scope, 'static');
    if (scope.type === 'class_body') break;
  }
  return false;
}

function hasModifier(node: Node, name: string): boolean {
  return node.namedChildren.some(
    (child) => child?.type === 'modifiers' && child.children.some((token) => token?.text === name)
  );
}

function declarators(declaration: Node, before: number): Binding[] {
  return declaration.namedChildren.flatMap((child) => {
    if (child?.type !== 'variable_declarator' || child.endIndex > before) return [];
    const name = child.childForFieldName('name')?.text;
    return name ? [{ name, type: declaredType(declaration, child) ?? '', kind: 'local' as const }] : [];
  });
}

function declaredType(declaration: Node, declarator: Node): string | undefined {
  const type = declaration.childForFieldName('type')?.text;
  return type ? (type + (declarator.childForFieldName('dimensions')?.text ?? '')).replaceAll(/\s/g, '') : undefined;
}
function addBinding(bindings: Map<string, Binding>, binding: Binding): void {
  if (!bindings.has(binding.name)) bindings.set(binding.name, binding);
}

export function isVariableUse(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    [
      'variable_declarator',
      'formal_parameter',
      'spread_parameter',
      'catch_formal_parameter',
      'enhanced_for_statement',
    ].includes(parent.type) &&
    parent.childForFieldName('name')?.id === node.id
  )
    return false;
  if (['method_invocation', 'field_access'].includes(parent.type))
    return parent.childForFieldName('object')?.id === node.id;
  return [
    'enhanced_for_statement',
    'switch_label',
    'ternary_expression',
    'cast_expression',
    'instanceof_expression',
    'dimensions_expr',
    'binary_expression',
    'unary_expression',
    'update_expression',
    'assignment_expression',
    'argument_list',
    'array_access',
    'array_initializer',
    'return_statement',
    'throw_statement',
    'parenthesized_expression',
    'variable_declarator',
    'for_statement',
  ].includes(parent.type);
}
