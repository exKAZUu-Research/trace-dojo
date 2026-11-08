import type { Node } from '@willbooster/web-tree-sitter';

import { GenerationLimitError, MAX_REPLACEMENTS } from '../../limits';

const operatorChanges: Record<string, string[]> = {
  '+': ['-', '*'],
  '-': ['+', '*'],
  '*': ['+', '/'],
  '/': ['*', '+'],
  '%': ['/', '*'],
  '<': ['<=', '>', '+'],
  '<=': ['<', '>='],
  '>': ['>=', '<'],
  '>=': ['>', '<='],
  '==': ['!=', '='],
  '!=': ['=='],
  '&&': ['||'],
  '||': ['&&'],
  '!': [''],
  '=': ['+=', '-='],
  '+=': ['-=', '='],
  '-=': ['+=', '='],
  '*=': ['+=', '='],
  '++': ['--', ' += 0'],
  '--': ['++', ' -= 0'],
};
const turtleMethods = [
  ['forward', 'backward', 'turnLeft', 'turnRight'],
  ['前に進む', '後に戻る', '左を向く', '右を向く'],
];
export type Role = 'expression' | 'operator' | 'keyword' | 'type' | 'name' | 'arguments' | 'modifier' | 'statement';

export function replacementsFor(node: Node, role: Role, text: string): string[] {
  if (role === 'operator') return operatorChanges[text] ?? [];
  if (role === 'modifier') return ['', '__invalid__'];
  if (role === 'keyword')
    return text === 'continue'
      ? ['break', '__invalid__']
      : text === 'break'
        ? ['continue', '__invalid__']
        : ['__invalid__'];
  if (role === 'type')
    return [...declaredTypes(node), 'int', 'boolean', '__invalid__'].filter((value) => value !== text);
  if (role === 'name')
    return [...(turtleMethods.find((group) => group.includes(text)) ?? []), '__invalid__'].filter(
      (value) => value !== text
    );
  if (role === 'arguments') return argumentChanges(node, text);
  if (role === 'statement') return text.startsWith('throw ') ? ['return', '__invalid__'] : ['__invalid__'];
  const result = expressionChanges(node, text);
  return [...new Set(result)].filter((value) => value !== text);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Each independent syntax case contributes alternatives to the same expression.
// code-gauge-allow functionNcss 31 -- Keep the small expression alternatives together for comparison.
function expressionChanges(node: Node, text: string): string[] {
  const results = ['0', '1', 'true', 'false', '__invalid__', ...visibleNames(node)];
  if (/^\d+$/.test(text)) results.push(String(Number(text) + 1), String(Number(text) - 1), '2');
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (node.type === 'binary_expression' && left && right) results.push(left.text, right.text);
  if (node.type === 'unary_expression') {
    const operand = node.childForFieldName('operand') ?? node.namedChildren.at(-1);
    if (operand) results.push(operand.text);
  }
  if (['identifier', 'field_access', 'method_invocation', 'binary_expression'].includes(node.type))
    results.push(`!(${text})`, `${text} + 1`);
  if (node.type === 'field_access') {
    const field = node.childForFieldName('field');
    if (field) results.push(field.text);
  }
  if (node.type === 'method_invocation' || node.type === 'object_creation_expression')
    results.push(...invocationChanges(node));
  if (node.type === 'array_access') {
    const array = node.childForFieldName('array');
    const index = node.childForFieldName('index');
    const nestedIndex = array?.childForFieldName('index');
    const nestedArray = array?.childForFieldName('array');
    if (index && nestedIndex && nestedArray) results.push(`${nestedArray.text}[${index.text}][${nestedIndex.text}]`);
  }
  if (node.type === 'assignment_expression' && left && right) {
    for (const name of visibleNames(right)) results.push(`${left.text} = ${name}`);
  }
  return results;
}

function invocationChanges(node: Node): string[] {
  const results: string[] = [];
  const args = node.childForFieldName('arguments');
  if (args)
    for (const value of argumentChanges(args, args.text.slice(1, -1)))
      results.push(patch(node, args.startIndex + 1, args.endIndex - 1, value));
  const type = node.childForFieldName('type');
  if (type) for (const name of declaredTypes(node)) results.push(patch(node, type.startIndex, type.endIndex, name));
  return results;
}

function argumentChanges(node: Node, text: string): string[] {
  const arguments_ = node.namedChildren.filter((child): child is Node => !!child && !child.type.endsWith('comment'));
  const count = arguments_.length;
  if (2 + count + (count * (count - 1)) / 2 > MAX_REPLACEMENTS)
    throw new GenerationLimitError('Too many argument permutations');
  const values = arguments_.map((child) => child.text);
  const results = ['', '__invalid__'];
  for (let i = 0; i < values.length; i++) {
    results.push(values.filter((_, index) => index !== i).join(', '));
    for (let j = i + 1; j < values.length; j++) {
      const swapped = [...values];
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
      results.push(swapped.join(', '));
    }
  }
  return [...new Set(results)].filter((value) => value !== text);
}

/** Collect only lexically visible earlier locals, enclosing parameters and fields; execution validates type compatibility. */
// code-gauge-allow functionCognitiveComplexity 24 -- Lexical scope traversal must stop at the class boundary while collecting locals, parameters, and fields.
function visibleNames(node: Node): string[] {
  const names = new Set<string>();
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'block' || scope.type === 'for_statement') {
      for (const declaration of scope.namedChildren) {
        if (declaration?.type !== 'local_variable_declaration' || declaration.endIndex > node.startIndex) continue;
        addDeclarators(declaration, names);
      }
    }
    if (scope.type === 'method_declaration' || scope.type === 'constructor_declaration') addParameters(scope, names);
    if (scope.type === 'class_body') {
      for (const declaration of scope.namedChildren)
        if (declaration?.type === 'field_declaration') addDeclarators(declaration, names);
      break;
    }
  }
  return [...names];
}

function addParameters(scope: Node, names: Set<string>): void {
  for (const parameter of scope.childForFieldName('parameters')?.namedChildren ?? []) {
    const name = parameter?.childForFieldName('name');
    if (name) names.add(name.text);
  }
}

function addDeclarators(declaration: Node, names: Set<string>): void {
  for (const child of declaration.namedChildren) {
    const name = child?.type === 'variable_declarator' ? child.childForFieldName('name') : undefined;
    if (name) names.add(name.text);
  }
}

function declaredTypes(node: Node): string[] {
  let root = node;
  while (root.parent) root = root.parent;
  return root.namedChildren
    .filter((child) => child?.type === 'class_declaration')
    .map((child) => child?.childForFieldName('name')?.text ?? '')
    .filter(Boolean);
}

function patch(node: Node, start: number, end: number, replacement: string): string {
  return node.text.slice(0, start - node.startIndex) + replacement + node.text.slice(end - node.startIndex);
}
