import { CompileError } from '../interpreter/diagnostics';
import type { Expression, IterationSource, PropertyName } from './ast';
import { printedOperation, stringLiteralValue } from './operatorPrinter';

/**
 * The parts of a tree-sitter node that converting reads, which a view of another grammar's tree can also provide.
 */
export interface Node {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly children: Node[];
  readonly namedChildren: Node[];
  childForFieldName(fieldName: string): Node | null;
  childrenForFieldName(fieldName: string): Node[];
}

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type !== 'comment');
}

/** Whether a function body or a program starts with a `"use strict"` directive. */
export function hasUseStrictDirective(statements: Node[]): boolean {
  for (const statement of statements) {
    const expression = statement.type === 'expression_statement' ? namedChildren(statement)[0] : undefined;
    if (expression?.type !== 'string') return false;
    if (expression.text.slice(1, -1) === 'use strict') return true;
  }
  return false;
}

/** The first named child in a field, skipping the `;` and empty statements that the `for` header puts there. */
export function namedField(node: Node, name: string): Node | undefined {
  return node.childrenForFieldName(name).find((child) => child.isNamed && child.type !== 'empty_statement');
}

export function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) return fail(node, '書き方に誤りがあります。');
  return child;
}

export function hasChild(node: Node, type: string): boolean {
  return node.children.some((child) => child.type === type);
}

export function rowOf(node: Node): number {
  return node.startPosition.row;
}

export function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression') current = namedChildren(current)[0];
  return current;
}

/**
 * How V8's CallPrinter names a callee in an error message: names, `this`, and property accesses as written without
 * spaces or type syntax, a string key as `.key`, and anything else as `(intermediate value)`.
 */
export function calleeText(node: Node): string {
  return printedCallee(node) ?? '(intermediate value)';
}

export function iterationSource(node: Node): IterationSource {
  const operand = unwrapParentheses(node);
  const callee =
    operand.type === 'call_expression'
      ? calleeText(field(operand, 'function'))
      : operand.type === 'new_expression'
        ? calleeText(field(operand, 'constructor'))
        : undefined;
  if (isOptionalChain(operand)) return { text: '(intermediate value)', callee, isOptionalChain: true };
  return { text: calleeText(operand), callee };
}

/** Whether a `?.` short-circuits the expression, which V8 then evaluates as one optional chain. */
export function isOptionalChain(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.childForFieldName('optional_chain')) return true;
    if (current.type === 'call_expression') current = current.childForFieldName('function');
    else if (current.type === 'member_expression' || current.type === 'subscript_expression')
      current = current.childForFieldName('object');
    else return false;
  }
  return false;
}

// code-gauge-allow functionNcss 40 -- One case per kind of expression V8's CallPrinter names.
// code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of expression V8's CallPrinter names.
function printedCallee(node: Node): string | undefined {
  switch (node.type) {
    case 'identifier': {
      return nameOf(node);
    }
    case 'this':
    case 'super': {
      return node.text;
    }
    case 'parenthesized_expression': {
      return printedCallee(namedChildren(node)[0]);
    }
    case 'object': {
      // V8 prints a part for each member.
      const members = namedChildren(node).filter((child) => child.type !== 'comment');
      return `{${'(intermediate value)'.repeat(members.length)}}`;
    }
    case 'array': {
      return `[${namedChildren(node)
        .map((element) => printedCallee(element) ?? '(intermediate value)')
        .join(',')}]`;
    }
    case 'null':
    case 'true':
    case 'false': {
      return node.type;
    }
    case 'undefined': {
      // As written, or as a compiler emitted it.
      return node.text;
    }
    case 'call_expression': {
      return `${calleeText(field(node, 'function'))}(...)`;
    }
    case 'member_expression': {
      const object = printedCallee(field(node, 'object'));
      const dot = node.childForFieldName('optional_chain') ? '?.' : '.';
      return object === undefined ? undefined : `${object}${dot}${nameOf(field(node, 'property'))}`;
    }
    case 'subscript_expression': {
      const object = printedCallee(field(node, 'object'));
      const index = unwrapParentheses(field(node, 'index'));
      if (object === undefined) return undefined;
      const dot = node.childForFieldName('optional_chain') ? '?.' : '';
      const key = stringLiteralValue(index);
      if (key !== undefined) return `${object}${dot || '.'}${key}`;
      return `${object}${dot}[${printedCallee(index) ?? '(intermediate value)'}]`;
    }
    default: {
      return printedOperation(node, printedCallee);
    }
  }
}

/** Gives an anonymous function or class the name it is assigned to, as `name` shows. */
export function nameAnonymous(value: Expression, name: string): void {
  if (value.kind === 'functionExpression' && value.fn.name === '') value.fn.name = name;
  if (value.kind === 'classExpression' && value.cls.name === '') value.cls.name = name;
}

export function keyName(key: PropertyName): string {
  if (key.kind === 'key') return key.key;
  if (key.kind === 'private') return key.name;
  return '';
}

/** The accessor keyword of a method definition, if any. */
export function accessorOf(node: Node): 'getter' | 'setter' | undefined {
  if (hasChild(node, 'get')) return 'getter';
  if (hasChild(node, 'set')) return 'setter';
  return undefined;
}

const reservedBindingNames = new Set(['eval', 'arguments']);

export function checkBindingName(node: Node): void {
  if (reservedBindingNames.has(nameOf(node))) fail(node, `${node.text} は変数名に使えません。`);
}

/** The words JavaScript reserves, which an identifier spelling one with an escape may not stand for. */
const reservedWords = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with'.split(
    ' '
  )
);

/** The name an identifier, a property name, or a `#name` spells, with its `\\u` escapes decoded. */
export function nameOf(node: Node): string {
  const { text } = node;
  if (!text.includes('\\')) return text;
  const start = text.startsWith('#') ? 1 : 0;
  const name = text.replaceAll(
    /\\u(?:\{([\dA-Fa-f]+)\}|([\dA-Fa-f]{4}))/g,
    (escape: string, braced: string | undefined, fixed: string | undefined, offset: number) => {
      const codePoint = Number.parseInt(braced ?? fixed ?? '', 16);
      const character = codePoint <= 0x10_ff_ff ? String.fromCodePoint(codePoint) : '';
      // An escape must spell a character the name may hold where it stands, as one written plainly would be.
      const allowed = offset === start ? /^[\p{ID_Start}$_]$/u : /^[\p{ID_Continue}$‌‍]$/u;
      if (!allowed.test(character)) fail(node, `${escape} は、この位置の名前に使える文字を表していません。`);
      return character;
    }
  );
  // Property names and #names may be reserved words; variables and labels may not.
  const mayBeReserved = node.type.startsWith('property_identifier') || node.type === 'private_property_identifier';
  if (!mayBeReserved && reservedWords.has(name)) fail(node, `予約語 ${name} は、エスケープを含めて書けません。`);
  return name;
}

/** The name a node spells, or an empty one when there is no node, as for an anonymous function. */
export function optionalNameOf(node: Node | null | undefined): string {
  return node ? nameOf(node) : '';
}

export function fail(node: Node, message: string): never {
  throw new CompileError([{ row: rowOf(node), message }]);
}

export function unsupported(node: Node, feature: string): never {
  return fail(node, `${feature}は、この採点環境では使えません。`);
}

/** Features learners may write that the interpreter rejects, by node type. */
export const unsupportedFeatures: Record<string, string> = {
  import_statement: 'import や export ',
  export_statement: 'import や export ',
  with_statement: 'with 文',
  jsx_element: 'JSX ',
  jsx_self_closing_element: 'JSX ',
};
