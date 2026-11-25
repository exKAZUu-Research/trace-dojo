import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';

/** The message of a construct that this environment does not run. */
export function unavailableMessage(what: string): string {
  return `${what}は、この採点環境では使えません。`;
}

export function unavailableJavaFeature(path: string): string | undefined {
  const within = (prefix: string): boolean => path === prefix || path.startsWith(prefix + '.');
  if (path === 'java.lang.System.in') return 'Java の System.in（readln() を使ってください）';
  if (within('java.util.Scanner')) return 'Java の Scanner（readln() を使ってください）';
  if (within('java.nio')) return 'java.nio のファイルの読み書き（java.io.File を使ってください）';
  if (within('java.net')) return 'ネットワーク';
  if (within('java.util.concurrent')) return 'コルーチン・スレッド';
  if (within('java.lang.reflect')) return 'リフレクション';
  return undefined;
}

/** What an import of a package this environment does not run names, for its message. */
export function describeUnavailableImport(path: string): string {
  if (path.startsWith('kotlin.io.path')) return 'kotlin.io.path のファイルの読み書き（java.io.File を使ってください）';
  if (path.startsWith('io.ktor')) return 'ネットワーク';
  if (path.startsWith('kotlinx.coroutines') || path.startsWith('kotlin.concurrent')) return 'コルーチン・スレッド';
  if (path.startsWith('kotlin.reflect')) return 'リフレクション';
  if (path.startsWith('kotlin.')) return `標準ライブラリの ${path} `;
  return `標準ライブラリ以外のライブラリ（${path}）`;
}

/**
 * The packages of the functions that start coroutines and threads, which learners write without their imports from
 * examples: an unresolved call of one is reported as unavailable, as its import is, instead of as a missing name.
 */
const UNAVAILABLE_FUNCTION_PACKAGES: Readonly<Record<string, string>> = {
  runBlocking: 'kotlinx.coroutines',
  launch: 'kotlinx.coroutines',
  async: 'kotlinx.coroutines',
  delay: 'kotlinx.coroutines',
  thread: 'kotlin.concurrent',
};

/** What an unresolved simple name is when it names a function of a package this environment does not run. */
export function unavailableFunction(name: string): string | undefined {
  const owner = Object.hasOwn(UNAVAILABLE_FUNCTION_PACKAGES, name) ? UNAVAILABLE_FUNCTION_PACKAGES[name] : undefined;
  return owner && `${describeUnavailableImport(`${owner}.${name}`)}（${name}）`;
}

export function syntaxError(node: Node, message: string): CompileError {
  return new CompileError([{ row: node.startPosition.row, message }]);
}

export function unavailable(node: Node, what: string): CompileError {
  return syntaxError(node, unavailableMessage(what));
}

export function named(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && !isComment(child));
}

export function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null && !isComment(child));
}

export function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

export function namedOfType(node: Node, type: string): Node[] {
  return named(node).filter((child) => child.type === type);
}

export function firstOfType(node: Node, type: string): Node | undefined {
  return named(node).find((child) => child.type === type);
}

/** Whether `node` has an anonymous child token with the given text. */
export function hasToken(node: Node, text: string): boolean {
  return children(node).some((child) => !child.isNamed && child.type === text);
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('A node the grammar requires is missing');
  return value;
}

export function rowOf(node: Node): number {
  return node.startPosition.row;
}

/** An identifier's name, without the backticks of a quoted one. */
export function identifierName(node: Node): string {
  const { text } = node;
  return text.startsWith('`') ? text.slice(1, -1) : text;
}
