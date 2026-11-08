import type { Node } from '@willbooster/web-tree-sitter';

import type { Selector } from '../../types';
import type { Role } from './mutations';
import { operatorFamilies, operatorFamily, type OperatorSelector } from './operators';
import { isVariableUse } from './sourceFacts';

export type Emit = (node: Node | null | undefined, role?: Role, start?: number, end?: number) => void;
interface Rule {
  selector: Selector;
  nodeTypes: string[];
  collect: (node: Node, emit: Emit) => void;
}

/**
 * Selector contract: headers expose their individual parts and keywords; they never expose a control body.
 * Declarations expose the declaration/type/initializer. Assignment-update exposes the expression and operands.
 * Calls and construction expose the expression, receiver/name or new/type, individual arguments and unparenthesized argument list.
 * Members expose access/receiver/name; arrays expose initializer/elements/access/array/index.
 * Return/throw expose the statement without its semicolon and operand. Jumps and modifiers expose their keyword.
 * Operators and literals expose themselves. Variable references exclude declaration and member/method names.
 */
export const rules: Rule[] = [
  {
    selector: 'for',
    nodeTypes: ['for_statement'],
    collect: (node, emit) => {
      keywords(node, emit, ['for']);
      fields(node, emit, ['init', 'condition', 'update']);
    },
  },
  {
    selector: 'for',
    nodeTypes: ['enhanced_for_statement'],
    collect: (node, emit) => {
      keywords(node, emit, ['for']);
      emit(node.childForFieldName('type'), 'type');
      fields(node, emit, ['name', 'value']);
    },
  },
  {
    selector: 'while',
    nodeTypes: ['while_statement', 'do_statement'],
    collect: (node, emit) => {
      keywords(node, emit, ['while', 'do']);
      fields(node, emit, ['condition']);
    },
  },
  {
    selector: 'if',
    nodeTypes: ['if_statement'],
    collect: (node, emit) => {
      keywords(node, emit, ['if', 'else']);
      fields(node, emit, ['condition']);
    },
  },
  {
    selector: 'switch',
    nodeTypes: ['switch_expression'],
    collect: (node, emit) => {
      keywords(node, emit, ['switch']);
      fields(node, emit, ['condition']);
    },
  },
  {
    selector: 'switch',
    nodeTypes: ['switch_label'],
    collect: (node, emit) => {
      keywords(node, emit, ['case', 'default']);
      for (const child of meaningfulChildren(node)) emit(child);
    },
  },
  ...(Object.keys(operatorFamilies) as OperatorSelector[]).map((selector) => ({
    selector,
    nodeTypes: ['binary_expression', 'unary_expression', 'assignment_expression', 'update_expression'],
    collect: (node: Node, emit: Emit) =>
      operators(node, (token, role) => {
        if (token && operatorFamily(token.text) === selector) emit(token, role);
      }),
  })),
  {
    selector: 'literal',
    nodeTypes: [
      'decimal_integer_literal',
      'hex_integer_literal',
      'octal_integer_literal',
      'binary_integer_literal',
      'decimal_floating_point_literal',
      'hex_floating_point_literal',
      'string_literal',
      'character_literal',
      'true',
      'false',
      'null_literal',
    ],
    collect: (node, emit) => emit(node),
  },
  {
    selector: 'variableReference',
    nodeTypes: ['identifier'],
    collect: (node, emit) => {
      if (isVariableUse(node)) emit(node);
    },
  },
  {
    selector: 'variableDeclaration',
    nodeTypes: ['local_variable_declaration', 'field_declaration'],
    collect: declarations,
  },
  {
    selector: 'assignment',
    nodeTypes: ['assignment_expression'],
    collect: (node, emit) => {
      emit(node);
      fields(node, emit, ['left', 'right']);
    },
  },
  {
    selector: 'assignment',
    nodeTypes: ['update_expression'],
    collect: (node, emit) => {
      emit(node);
      for (const child of meaningfulChildren(node)) emit(child);
    },
  },
  {
    selector: 'call',
    nodeTypes: ['method_invocation', 'explicit_constructor_invocation'],
    collect: (node, emit) => {
      emit(node);
      fields(node, emit, ['object']);
      emit(node.childForFieldName('name'), 'name');
      emitArguments(node, emit);
    },
  },
  {
    selector: 'construction',
    nodeTypes: ['object_creation_expression'],
    collect: (node, emit) => {
      emit(node);
      keywords(node, emit, ['new']);
      emit(node.childForFieldName('type'), 'type');
      emitArguments(node, emit);
    },
  },
  {
    selector: 'member',
    nodeTypes: ['field_access'],
    collect: (node, emit) => {
      emit(node);
      fields(node, emit, ['object', 'field']);
    },
  },
  {
    selector: 'array',
    nodeTypes: ['array_initializer'],
    collect: (node, emit) => {
      emit(node);
      for (const child of meaningfulChildren(node)) emit(child);
    },
  },
  {
    selector: 'array',
    nodeTypes: ['array_access'],
    collect: (node, emit) => {
      emit(node);
      fields(node, emit, ['array', 'index']);
    },
  },
  { selector: 'return', nodeTypes: ['return_statement'], collect: operandStatement },
  { selector: 'throw', nodeTypes: ['throw_statement'], collect: operandStatement },
  { selector: 'break', nodeTypes: ['break_statement'], collect: (node, emit) => keywords(node, emit, ['break']) },
  {
    selector: 'continue',
    nodeTypes: ['continue_statement'],
    collect: (node, emit) => keywords(node, emit, ['continue']),
  },
  { selector: 'modifier', nodeTypes: ['modifiers'], collect: modifiers },
];

export function meaningfulChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => !!child && !child.type.endsWith('comment'));
}

function keywords(node: Node, emit: Emit, words: string[]): void {
  for (const child of node.children) if (child && words.includes(child.text)) emit(child, 'keyword');
}
function fields(node: Node, emit: Emit, names: string[]): void {
  for (const name of names) {
    const parts = node.childrenForFieldName(name);
    if (parts.length > 1) emit(node, 'expression', parts[0].startIndex, parts.at(-1)!.endIndex);
    else emit(parts[0]);
  }
}
function operators(node: Node, emit: Emit): void {
  const operator = node.childForFieldName('operator');
  if (operator) emit(operator, 'operator');
  else
    for (const child of node.children)
      if (child && ['++', '--', '!', '~', '+', '-'].includes(child.text)) emit(child, 'operator');
}
function declarations(node: Node, emit: Emit): void {
  emit(node);
  emit(node.childForFieldName('type'), 'type');
  for (const declaration of meaningfulChildren(node))
    if (declaration.type === 'variable_declarator') emit(declaration.childForFieldName('value'));
}
function operandStatement(node: Node, emit: Emit): void {
  emit(node, 'statement');
  for (const child of meaningfulChildren(node)) emit(child);
}
function modifiers(node: Node, emit: Emit): void {
  for (const child of node.children)
    if (
      child &&
      /^(public|private|protected|static|final|abstract|synchronized|volatile|transient|native|strictfp|default)$/.test(
        child.text
      )
    )
      emit(child, 'modifier');
}
function emitArguments(node: Node, emit: Emit): void {
  const args = node.childForFieldName('arguments');
  if (!args) return;
  const children = meaningfulChildren(args);
  for (const child of children) emit(child);
  if (children.length > 0) emit(args, 'arguments', children[0].startIndex, children.at(-1)!.endIndex);
}
