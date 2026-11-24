import type { Node } from '@willbooster/web-tree-sitter';

import type { Annotation, Argument } from './ast';
import {
  children,
  firstOfType,
  hasToken,
  identifierName,
  named,
  namedOfType,
  required,
  rowOf,
  syntaxError,
} from './convertSupport';

/**
 * Reads an annotation such as `@get:JvmName("x")`, `@Deprecated("old")`, or `@OptIn(Marker::class)`.
 *
 * @param convertArgument Converts an argument of the annotation as an argument of a call.
 */
export function convertAnnotation(node: Node, convertArgument: (node: Node) => Argument): Annotation {
  const parts = named(node);
  const targetNode = parts.find((part) => part.type === 'use_site_target');
  const target = required(parts.find((part) => part.type !== 'use_site_target'));
  const typeNode = target.type === 'constructor_invocation' ? named(target)[0] : target;
  const path = namedOfType(typeNode, 'identifier').map(identifierName);
  const name = path.at(-1) as string;
  const qualifiedName = path.length > 1 ? path.join('.') : undefined;
  const argumentsNode = firstOfType(target, 'value_arguments');
  const argumentNodes = argumentsNode ? namedOfType(argumentsNode, 'value_argument') : undefined;
  const useSiteTarget = targetNode ? (children(targetNode)[0]?.type ?? targetNode.text.replace(/:$/, '')) : undefined;
  return {
    row: rowOf(node),
    name,
    qualifiedName,
    path,
    useSiteTarget,
    args: argumentNodes?.map(convertArgument),
    markers: name === 'OptIn' && argumentNodes ? optInMarkerArguments(argumentNodes) : undefined,
  };
}

function optInMarkerArguments(args: Node[]): NonNullable<Annotation['markers']> {
  const namedArgument = args.find((argument) => hasToken(argument, '='));
  if (namedArgument) {
    const [name, value] = named(namedArgument);
    if (!name || identifierName(name) !== 'markerClass')
      throw syntaxError(namedArgument, '@OptIn の引数名は markerClass です。');
    if (args.length !== 1) throw syntaxError(namedArgument, 'markerClass と位置で指定する引数は一緒に書けません。');
    return annotationArrayValues(required(value)).map(optInMarker);
  }
  return args.flatMap((argument) => {
    const value = required(named(argument)[0]);
    return value.type === 'spread_expression'
      ? annotationArrayValues(required(named(value)[0])).map(optInMarker)
      : [optInMarker(value)];
  });
}

function annotationArrayValues(node: Node): Node[] {
  if (node.type === 'parenthesized_expression' || node.type === 'spread_expression')
    return annotationArrayValues(required(named(node)[0]));
  if (node.type === 'collection_literal') return named(node);
  if (node.type === 'call_expression') {
    const callee = named(node)[0];
    const parts = firstOfType(node, 'value_arguments');
    if (parts && (callee.text === 'arrayOf' || callee.text === 'kotlin.arrayOf') && named(node).length === 2)
      return namedOfType(parts, 'value_argument').map((argument) => required(named(argument)[0]));
  }
  throw syntaxError(node, 'markerClass にはアノテーションクラスを並べた配列を書いてください。');
}

function optInMarker(node: Node): NonNullable<Annotation['markers']>[number] {
  if (node.type === 'parenthesized_expression') return optInMarker(required(named(node)[0]));
  const owner = named(node)[0];
  const path =
    node.type === 'navigation_expression' && hasToken(node, '::') && hasToken(node, 'class') && owner
      ? annotationClassPath(owner)
      : undefined;
  if (!path) throw syntaxError(node, '@OptIn にはアノテーションクラス名::class を書いてください。');
  return { row: rowOf(node), path };
}

function annotationClassPath(node: Node): string[] | undefined {
  if (node.type === 'identifier') return [identifierName(node)];
  if (node.type !== 'navigation_expression' || !hasToken(node, '.')) return undefined;
  const [receiver, member] = named(node);
  if (!receiver || member?.type !== 'identifier') return undefined;
  const path = annotationClassPath(receiver);
  return path && [...path, identifierName(member)];
}
