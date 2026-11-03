import type { Node } from '@willbooster/web-tree-sitter';

import type { Modifiers, Span, TypeSyntax } from './ast';
import { CompileError } from './diagnostics';

export function span(node: Node): Span {
  return {
    row: node.startPosition.row,
    endRow: node.endPosition.row,
    start: node.startIndex,
    end: node.endIndex,
  };
}

export function unsupported(node: Node, feature: string): never {
  throw new CompileError([{ row: node.startPosition.row, message: `${feature}は、この採点環境では使えません。` }]);
}

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => !!child && !isComment(child));
}

export function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

export function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) throw new Error(`Missing field ${name} of ${node.type}`);
  return child;
}

export function modifiersOf(node: Node): Node | undefined {
  return node.children.find((child) => child?.type === 'modifiers') ?? undefined;
}

export function convertModifiers(node: Node | null | undefined): Modifiers {
  const modifiers: Modifiers = {
    isStatic: false,
    isFinal: false,
    isAbstract: false,
    access: 'package',
  };
  for (const child of node?.children ?? []) {
    if (child) applyModifier(modifiers, child);
  }
  return modifiers;
}

function applyModifier(modifiers: Modifiers, child: Node): void {
  switch (child.type) {
    case 'visibility': {
      modifiers.access = child.text as Modifiers['access'];
      break;
    }
    case 'modifier': {
      applyKeywordModifier(modifiers, child);
      break;
    }
    case 'marker_annotation': {
      if (child.text !== '@Override') unsupported(child, `アノテーション「${child.text}」`);
      break;
    }
    case 'annotation': {
      unsupported(child, `アノテーション「${child.text}」`);
      break;
    }
    // The fork exposes visibility keywords and modifiers as named nodes; other tokens are punctuation.
    default: {
      if (child.isNamed && !isComment(child)) unsupported(child, `修飾子「${child.text}」`);
    }
  }
}

const keywordModifiers = { static: 'isStatic', final: 'isFinal', abstract: 'isAbstract' } as const;

function applyKeywordModifier(modifiers: Modifiers, child: Node): void {
  const key = keywordModifiers[child.text as keyof typeof keywordModifiers] as
    | (typeof keywordModifiers)[keyof typeof keywordModifiers]
    | undefined;
  if (!key) unsupported(child, `修飾子「${child.text}」`);
  modifiers[key] = true;
}

export function countDimensions(node: Node): number {
  if (node.namedChildren.some((child) => child && !isComment(child))) unsupported(node, '配列の次元へのアノテーション');
  return node.children.filter((child) => child?.type === '[').length;
}

export function wrapArray(type: TypeSyntax, dimensions: number, node: Node): TypeSyntax {
  let result = type;
  for (let index = 0; index < dimensions; index++) result = { kind: 'array', element: result, ...span(node) };
  return result;
}

export function convertType(node: Node): TypeSyntax {
  switch (node.type) {
    case 'integral_type': {
      if (node.text !== 'int' && node.text !== 'char') unsupported(node, `型「${node.text}」`);
      return { kind: 'primitive', name: node.text as 'int' | 'char', ...span(node) };
    }
    case 'floating_point_type': {
      if (node.text !== 'double') unsupported(node, `型「${node.text}」`);
      return { kind: 'primitive', name: 'double', ...span(node) };
    }
    case 'boolean_type': {
      return { kind: 'primitive', name: 'boolean', ...span(node) };
    }
    case 'type_identifier': {
      return node.text === 'var' ? { kind: 'var', ...span(node) } : { kind: 'named', name: node.text, ...span(node) };
    }
    case 'array_type': {
      return wrapArray(convertType(field(node, 'element')), countDimensions(field(node, 'dimensions')), node);
    }
    case 'scoped_type_identifier': {
      // `java.lang.String` and the like name the same classes as their simple names.
      const parts = node.text.split('.').map((part) => part.trim());
      const qualifier = parts.slice(0, -1).join('.');
      if (qualifier !== 'java.lang') unsupported(node, `型「${node.text}」`);
      return { kind: 'named', name: parts.at(-1) ?? '', ...span(node) };
    }
    case 'generic_type': {
      return unsupported(node, 'ジェネリクス');
    }
    default: {
      return unsupported(node, `型「${node.text}」`);
    }
  }
}

/** Converts a variable's declared type, including `[]` written after its name. */
export function convertVariableType(node: Node): TypeSyntax {
  const type = convertType(field(node, 'type'));
  const dimensions = node.childForFieldName('dimensions');
  return dimensions ? wrapArray(type, countDimensions(dimensions), dimensions) : type;
}

export function identifierOf(node: Node, what: string): Node {
  const name = field(node, 'name');
  if (name.type !== 'identifier') unsupported(name, what);
  return name;
}
