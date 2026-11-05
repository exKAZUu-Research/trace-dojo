import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Modifiers, Pattern, PrimitiveTypeName, Span, TypeParameter, TypeSyntax } from './ast';

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
    isDefault: false,
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
    case 'marker_annotation':
    case 'annotation': {
      const name = (child.childForFieldName('name')?.text ?? '').replace(/^java\.lang\./, '');
      if (!KNOWN_ANNOTATIONS.has(name)) unsupported(child, `アノテーション「${child.text}」`);
      if (name === 'Override') modifiers.hasOverride = true;
      break;
    }
    // The fork exposes visibility keywords and modifiers as named nodes; other tokens are punctuation.
    default: {
      if (child.isNamed && !isComment(child)) unsupported(child, `修飾子「${child.text}」`);
    }
  }
}

/** The annotations of java.lang, which change nothing these programs do except what `@Override` checks. */
const KNOWN_ANNOTATIONS = new Set(['Override', 'SuppressWarnings', 'Deprecated', 'FunctionalInterface', 'SafeVarargs']);

/** Modifiers that concern only threads and serialization, which these single-threaded programs never see. */
const IGNORED_MODIFIERS = new Set(['transient', 'volatile', 'synchronized', 'strictfp']);

const keywordModifiers = {
  static: 'isStatic',
  final: 'isFinal',
  abstract: 'isAbstract',
  default: 'isDefault',
} as const;

function applyKeywordModifier(modifiers: Modifiers, child: Node): void {
  if (child.text === 'sealed' || child.text === 'non-sealed') {
    modifiers.sealing = child.text;
    return;
  }
  if (IGNORED_MODIFIERS.has(child.text)) return;
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
    case 'integral_type':
    case 'floating_point_type': {
      return { kind: 'primitive', name: node.text as PrimitiveTypeName, ...span(node) };
    }
    case 'boolean_type': {
      return { kind: 'primitive', name: 'boolean', ...span(node) };
    }
    case 'type_identifier': {
      return node.text === 'var'
        ? { kind: 'var', ...span(node) }
        : { kind: 'named', name: node.text, qualifier: [], ...span(node) };
    }
    case 'array_type': {
      return wrapArray(convertType(field(node, 'element')), countDimensions(field(node, 'dimensions')), node);
    }
    case 'scoped_type_identifier': {
      return convertScopedType(node);
    }
    case 'generic_type': {
      const [base, argumentsNode] = namedChildren(node);
      const type = convertType(base);
      if (type.kind !== 'named') return unsupported(node, `型「${node.text}」`);
      return { ...type, args: namedChildren(argumentsNode).map((arg) => convertTypeArgument(arg)), ...span(node) };
    }
    default: {
      return unsupported(node, `型「${node.text}」`);
    }
  }
}

function convertTypeArgument(node: Node): TypeSyntax {
  if (node.type !== 'wildcard') return convertType(node);
  const bound = namedChildren(node).find((child) => child.type !== 'super' && child.type !== 'extends');
  return {
    kind: 'wildcard',
    bound: bound ? convertType(bound) : undefined,
    isSuper: node.children.some((child) => child?.type === 'super'),
    ...span(node),
  };
}

export function convertTypeParameters(node: Node | null): TypeParameter[] {
  if (!node) return [];
  return namedChildren(node).map((parameter) => {
    const [name, bound] = namedChildren(parameter);
    if (name.type !== 'type_identifier') unsupported(parameter, '型パラメータへのアノテーション');
    return {
      name: name.text,
      bounds: bound ? namedChildren(bound).map((type) => convertType(type)) : [],
      ...span(parameter),
    };
  });
}

/** Converts a variable's declared type, including `[]` written after its name. */
export function convertVariableType(node: Node): TypeSyntax {
  const type = convertType(field(node, 'type'));
  const dimensions = node.childForFieldName('dimensions');
  return dimensions ? wrapArray(type, countDimensions(dimensions), dimensions) : type;
}

/** Converts a type pattern or a record pattern. */
export function convertPattern(node: Node): Pattern {
  if (node.type === 'pattern') return convertPattern(namedChildren(node)[0]);
  if (node.type === 'record_pattern') {
    const [typeNode, body] = namedChildren(node);
    // The grammar writes a record pattern's type as an identifier rather than a type.
    const names = typeNode.text.split('.').map((part) => part.trim());
    const type: TypeSyntax =
      typeNode.type === 'identifier' || typeNode.type === 'scoped_identifier'
        ? { kind: 'named', name: names.at(-1) as string, qualifier: names.slice(0, -1), ...span(typeNode) }
        : convertType(typeNode);
    return {
      kind: 'recordPattern',
      type,
      components: namedChildren(body).map((component) => convertPattern(component)),
      ...span(node),
    };
  }
  if (node.type === 'record_pattern_component' && namedChildren(node)[0]?.type === 'record_pattern') {
    return convertPattern(namedChildren(node)[0]);
  }
  const parts = namedChildren(node).filter((child) => child.type !== 'modifiers');
  const name = parts.at(-1) as Node;
  const typeNode = parts.length > 1 ? parts[0] : undefined;
  return {
    kind: 'typePattern',
    type: typeNode && typeNode.text !== 'var' ? convertType(typeNode) : undefined,
    binding: { name: name.text, isFinal: convertModifiers(modifiersOf(node)).isFinal, ...span(name) },
    ...span(node),
  };
}

/** The name a declaration gives, which is `_` for an unnamed variable. */
export function identifierOf(node: Node, what: string): Node {
  const name = field(node, 'name');
  if (name.type !== 'identifier' && name.type !== 'underscore_pattern') unsupported(name, what);
  return name;
}

function convertScopedType(node: Node): TypeSyntax {
  if (namedChildren(node).some((child) => child.type.endsWith('annotation'))) {
    unsupported(node, `型「${node.text}」`);
  }
  const [qualifierNode, nameNode] = namedChildren(node);
  if (qualifierNode && nameNode && hasTypeArguments(qualifierNode)) {
    const outer = convertType(qualifierNode);
    if (outer.kind !== 'named') return unsupported(node, `型「${node.text}」`);
    return {
      kind: 'named',
      name: nameNode.text,
      qualifier: [...outer.qualifier, outer.name],
      outer,
      ...span(node),
    };
  }
  const parts = node.text.split('.').map((part) => part.trim());
  // `java.lang.String`, `java.util.List`, and the like name the same classes as their simple names.
  const qualifier = parts.slice(0, -1);
  const isPackage = /^java\.[a-z.]+$/.test(qualifier.join('.'));
  return { kind: 'named', name: parts.at(-1) ?? '', qualifier: isPackage ? [] : qualifier, ...span(node) };
}

function hasTypeArguments(node: Node): boolean {
  return node.type === 'generic_type' || namedChildren(node).some((child) => hasTypeArguments(child));
}
