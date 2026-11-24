import type { Node } from '@willbooster/web-tree-sitter';

import type { Annotation } from './ast';
import {
  firstOfType,
  hasToken,
  identifierName,
  named,
  namedOfType,
  required,
  rowOf,
  syntaxError,
  unavailable,
} from './convertSupport';

export function convertAnnotation(node: Node, isLibrary: boolean): Annotation {
  const parts = named(node);
  if (parts.some((part) => part.type === 'use_site_target'))
    throw unavailable(node, '対象を指定したアノテーション（@get: など）');
  const target = parts[0];
  const typeNode = target.type === 'constructor_invocation' ? named(target)[0] : target;
  const spelling = typeNode.text;
  if (isLibrary) return { row: rowOf(node), name: spelling };
  if (!LEARNER_ANNOTATIONS.has(spelling)) throw unavailable(node, `アノテーション @${spelling}`);
  const name = spelling.endsWith('JvmInline') ? 'JvmInline' : 'OptIn';
  const qualifiedName = spelling.includes('.') ? spelling : undefined;
  const args = firstOfType(target, 'value_arguments');
  const arguments_ = args ? namedOfType(args, 'value_argument') : [];
  if (name === 'JvmInline') {
    if (arguments_.length > 0) throw syntaxError(node, '@JvmInline には引数を書けません。');
    return { row: rowOf(node), name, qualifiedName };
  }
  return { row: rowOf(node), name, qualifiedName, markers: optInMarkerArguments(arguments_) };
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

/** The annotations of the Kotlin tour, which change nothing a program prints. */
const LEARNER_ANNOTATIONS = new Set(['JvmInline', 'OptIn', 'kotlin.jvm.JvmInline', 'kotlin.OptIn']);
