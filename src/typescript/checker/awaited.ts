import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  mapType,
  neverType,
  propertyAccessType,
  regularOf,
  type Signature,
  type Type,
  typeMembers,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

export interface AwaitedErrorSite {
  node: TreeNode;
  kind: 'await' | 'yield' | 'return';
  reported?: boolean;
}

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
  'enum_body',
]);

/**
 * The type `await` gives a value of `type`, as TypeScript's `Awaited<T>`: the value a promise or another object with a
 * `then` method fulfills with, unwrapped through promises of promises, while keeping a generic type whose constraint
 * has no thenable value as itself and wrapping one that may in `Awaited<T>`.
 */
export function awaitedType(
  c: Checker,
  type: Type,
  site?: AwaitedErrorSite,
  depth = 0,
  seen: ReadonlySet<Type> = new Set()
): Type {
  if (isAnyLike(type) || depth > MAX_AWAITED_DEPTH) return type;
  if (type.kind === 'union') return mapType(type, (member) => awaitedType(c, member, site, depth + 1, seen));
  if (isGenericAwaitedOperand(type)) {
    return mayBeThenableGeneric(c, type, depth) ? c.globalTypeAlias('Awaited', [type]) : type;
  }
  if (type.kind !== 'object' && type.kind !== 'intersection') return type;
  const canonical = regularOf(type);
  if (seen.has(canonical)) return reportCircularThenable(c, site);
  const nextSeen = new Set([...seen, canonical]);
  if (isLibraryPromiseType(c, type))
    return awaitedType(c, type.typeArguments?.[0] ?? unknownType, site, depth + 1, nextSeen);
  const step = inspectThenable(c, type);
  if (step.kind === 'nonThenable') return type;
  if (step.kind === 'valid') return awaitedType(c, step.value, site, depth + 1, nextSeen);
  return reportInvalidThenable(c, site);
}

function reportCircularThenable(c: Checker, site: AwaitedErrorSite | undefined): Type {
  if (!site) return anyType;
  if (!site.reported) {
    site.reported = true;
    c.error(
      site.node,
      "型は、それ自身の 'then' メソッドのフルフィルメント コールバック内で直接または間接的に参照されます。"
    );
  }
  return errorType;
}

function isLibraryPromiseType(c: Checker, type: Type): type is Extract<Type, { kind: 'object' }> {
  return type.kind === 'object' && (c.isLibraryType(type, 'Promise') || c.isLibraryType(type, 'PromiseLike'));
}

function reportInvalidThenable(c: Checker, site: AwaitedErrorSite | undefined): Type {
  if (!site) return neverType;
  if (!site.reported) {
    site.reported = true;
    c.error(site.node, invalidThenableMessage(site.kind));
  }
  return errorType;
}

/** Unwraps `Awaited<T>` back to `T` when wrapping an async function's inferred return type in `Promise<...>`. */
export function unwrapAwaitedType(c: Checker, type: Type): Type {
  if (type.kind === 'union') return mapType(type, (member) => unwrapAwaitedType(c, member));
  const root = type.kind === 'conditional' ? (type.root ?? type) : undefined;
  return type.kind === 'conditional' &&
    type.aliasName === 'Awaited' &&
    type.aliasArguments?.length === 1 &&
    root?.declaration !== undefined &&
    c.isLibrary(root.declaration)
    ? type.aliasArguments[0]
    : type;
}

/** The contextual type `T | PromiseLike<T>` TypeScript gives an `await`, async `return`, or async `yield` operand. */
export function awaitableContextualType(c: Checker, expected: Type | undefined): Type | undefined {
  if (!expected || isAnyLike(expected)) return expected;
  return unionOf([expected, c.globalType('PromiseLike', [expected])]);
}

function isGenericAwaitedOperand(type: Type): boolean {
  return (
    type.kind === 'typeParameter' ||
    type.kind === 'indexedAccess' ||
    type.kind === 'conditional' ||
    type.kind === 'keyof'
  );
}

function mayBeThenableGeneric(c: Checker, type: Type, depth: number): boolean {
  if (depth > MAX_AWAITED_DEPTH) return false;
  const constraint = type.kind === 'typeParameter' ? c.constraintOf(type) : c.baseConstraint(type);
  if (!constraint || constraint === type) return true;
  return typeMembers(constraint).some((member) => mayBeThenableConstraint(c, member, depth + 1));
}

function mayBeThenableConstraint(c: Checker, member: Type, depth: number): boolean {
  if (
    isAnyLike(member) ||
    isIntrinsic(member, 'unknown') ||
    isIntrinsic(member, 'object') ||
    c.relations.isEmptyObjectType(member)
  )
    return true;
  if (isGenericAwaitedOperand(member)) return mayBeThenableGeneric(c, member, depth);
  if (member.kind !== 'object' && member.kind !== 'intersection') return false;
  return (
    c.isLibraryType(member, 'Promise') ||
    c.isLibraryType(member, 'PromiseLike') ||
    inspectThenable(c, member).kind !== 'nonThenable'
  );
}

type ThenableStep = { kind: 'nonThenable' } | { kind: 'invalid' } | { kind: 'valid'; value: Type };

function inspectThenable(c: Checker, type: Type): ThenableStep {
  const thenProperty = c.propertyOf(type, 'then');
  const thenType = thenProperty && propertyAccessType(thenProperty);
  if (!thenType || isAnyLike(thenType)) return { kind: 'nonThenable' };
  if (c.signaturesOf(c.relations.removeNullish(thenType), 'call').length === 0) return { kind: 'nonThenable' };
  const signatures = c.relations.isNullable(thenType) ? [] : c.signaturesOf(thenType, 'call');
  const values = signatures.length > 0 ? fulfilledValuesOfSignatures(c, signatures) : undefined;
  return values ? { kind: 'valid', value: unionOf(values) } : { kind: 'invalid' };
}

function fulfilledValuesOfSignatures(c: Checker, signatures: readonly Signature[]): Type[] | undefined {
  const values: Type[] = [];
  for (const signature of signatures) {
    const fulfilled = signatureFulfilledValue(c, signature);
    if (!fulfilled) return undefined;
    values.push(fulfilled);
  }
  return values;
}

function signatureFulfilledValue(c: Checker, signature: Signature): Type | undefined {
  const onfulfilled = signature.parameters[0];
  if (!onfulfilled || onfulfilled.rest) return undefined;
  const callbackType = c.relations.removeNullish(onfulfilled.type);
  if (isAnyLike(callbackType) || isIntrinsic(callbackType, 'unknown')) return undefined;
  const callbacks = c.signaturesOf(callbackType, 'call');
  if (callbacks.length === 0) return undefined;
  return unionOf(callbacks.map((callback) => callback.parameters[0]?.type ?? undefinedType));
}

function invalidThenableMessage(kind: AwaitedErrorSite['kind']): string {
  const subject =
    kind === 'return'
      ? '非同期関数の戻り値'
      : kind === 'yield'
        ? "非同期ジェネレーター内の 'yield' オペランド"
        : "'await' オペランド";
  return `${subject}の型は、有効な Promise であるか、呼び出し可能な 'then' メンバーを含んでいないかのどちらかであることが必要です。`;
}

/** Whether every value of `type` is a non-nullish Promise or thenable, which TS2801 flags when tested as a condition. */
export function isAlwaysAwaitableType(c: Checker, type: Type, depth = 0): boolean {
  if (isAnyLike(type) || depth > MAX_AWAITED_DEPTH || c.relations.isNullable(type)) return false;
  const members = typeMembers(type);
  return members.length > 0 && members.every((member) => isAwaitableMember(c, member, depth));
}

function isAwaitableMember(c: Checker, member: Type, depth: number): boolean {
  if (isGenericAwaitedOperand(member)) {
    const constraint = member.kind === 'typeParameter' ? c.constraintOf(member) : c.baseConstraint(member);
    return constraint !== undefined && constraint !== member && isAlwaysAwaitableType(c, constraint, depth + 1);
  }
  if (member.kind !== 'object' && member.kind !== 'intersection') return false;
  return (
    c.isLibraryType(member, 'Promise') ||
    c.isLibraryType(member, 'PromiseLike') ||
    inspectThenable(c, member).kind === 'valid'
  );
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
      `ファイルの一番外側の${what}は、ファイルがモジュールのときしか使えず、この採点環境ではモジュールの一番外側の${what}も使えません。async 関数の中で使ってください。`
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
