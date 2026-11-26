import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken } from './syntax';
import { isAnyLike, mapType, type Type, unknownType } from './types';

/** How deeply a promise may hold promises before its awaited type stops unwrapping. */
const MAX_AWAITED_DEPTH = 50;

/** The nodes that decide whether `await` is allowed: functions, and the bodies that run apart from them. */
const awaitBoundaries = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_static_block',
]);

/**
 * The type `await` gives a value of `type`, as TypeScript's `Awaited<T>`: the value a promise or another object with a
 * `then` method fulfills with, unwrapped through promises of promises.
 */
export function awaitedType(c: Checker, type: Type, depth = 0): Type {
  if (isAnyLike(type) || depth > MAX_AWAITED_DEPTH) return type;
  if (type.kind === 'union') return mapType(type, (member) => awaitedType(c, member, depth + 1));
  // A type parameter waits for what its constraint does, and an intersection for what its `then` gives.
  if (type.kind === 'typeParameter') {
    const constraint = c.constraintOf(type);
    return constraint ? awaitedType(c, constraint, depth + 1) : type;
  }
  if (type.kind !== 'object' && type.kind !== 'intersection') return type;
  if (type.kind === 'object' && (c.isLibraryType(type, 'Promise') || c.isLibraryType(type, 'PromiseLike')))
    return awaitedType(c, type.typeArguments?.[0] ?? unknownType, depth + 1);
  const then = c.propertyOf(type, 'then');
  const onfulfilled = then && c.signaturesOf(then.type(), 'call')[0]?.parameters[0]?.type;
  if (!onfulfilled) return type;
  const callback = c.signaturesOf(c.relations.removeNullish(onfulfilled), 'call')[0];
  const value = callback?.parameters[0]?.type;
  return value ? awaitedType(c, value, depth + 1) : type;
}

/**
 * Reports an `await` or a `for await` outside an async function: at the top level, where only a module may wait and
 * tsx runs none that does, or in a function that is not async.
 */
export function checkAwaitPlace(c: Checker, node: TreeNode, isLoop: boolean): void {
  const container = awaitContainer(node);
  const what = awaitWhat(isLoop);
  // tsx compiles a module to CommonJS, where esbuild refuses a top-level await.
  if (!container && c.isModule) c.error(node, `モジュールの一番外側の${what}は、この採点環境では使えません。`);
  else if (!container)
    c.error(
      node,
      `ファイルの一番外側の${what}は、ファイルがモジュールのときしか使えませんが、このファイルには import も export もありません。モジュールにするには、空の 'export {}' を書いてください。`
    );
  else if (!hasToken(container, 'async')) c.error(node, nonAsyncAwaitMessage(isLoop));
}

/**
 * The error of an `await` the parser left out of the tree, which it does inside a function that is not async, or
 * `undefined` when the `await` is elsewhere.
 */
export function unparsedAwaitMessage(awaitToken: TreeNode): string | undefined {
  const container = awaitContainer(awaitToken);
  if (!container || hasToken(container, 'async')) return undefined;
  return nonAsyncAwaitMessage(awaitToken.parent?.type === 'for_in_statement');
}

function awaitContainer(node: TreeNode): TreeNode | null {
  let container: TreeNode | null = node.parent;
  while (container && !awaitBoundaries.has(container.type)) container = container.parent;
  return container;
}

function nonAsyncAwaitMessage(isLoop: boolean): string {
  return `${awaitWhat(isLoop)}は、async 関数の中とモジュールの一番外側でしか使えません。`;
}

function awaitWhat(isLoop: boolean): string {
  return isLoop ? "'for await' ループ" : "'await' 式";
}
