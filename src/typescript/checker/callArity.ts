import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named } from './syntax';
import { isIntrinsic, type Signature, type TupleElement, type Type, undefinedType, unionOf } from './types';

/** Counts the arguments of a call against the parameters of a signature, and reports when they do not fit. */
export class CallArity {
  constructor(private readonly c: Checker) {}

  minimumArguments(signature: Signature): number {
    if (signature.minimumArguments !== undefined) return signature.minimumArguments;
    let minimum = 0;
    for (const [index, parameter] of signature.parameters.entries()) {
      if (!parameter.optional && !parameter.rest && !this.acceptsUndefinedOnly(parameter.type)) minimum = index + 1;
    }
    return minimum;
  }

  /** Whether a trailing parameter's type is `void`, which lets callers omit it. */
  private acceptsUndefinedOnly(type: Type): boolean {
    return isIntrinsic(type, 'void');
  }

  maximumArguments(signature: Signature): number {
    return signature.parameters.some((parameter) => parameter.rest)
      ? Number.POSITIVE_INFINITY
      : signature.parameters.length;
  }

  /**
   * How many arguments an argument passes: a spread one passes its tuple's length, optional elements included as
   * TypeScript counts them, or an unknown count.
   */
  spreadLength(arg: TreeNode): number | undefined {
    if (arg.type !== 'spread_element') return 1;
    const type = this.c.silently(() => this.c.expressions.check(named(arg)[0]));
    if (
      type.kind === 'object' &&
      type.objectKind === 'tuple' &&
      !(type.tuple?.elements ?? []).some((element) => element.rest)
    )
      return type.tuple?.elements.length;
    return undefined;
  }

  /** How many elements a spread tuple with a rest element passes before its rest, as `[number, ...string[]]`. */
  private leadingLength(arg: TreeNode): number {
    const type = this.c.silently(() => this.c.expressions.check(named(arg)[0]));
    const elements = type.kind === 'object' && type.objectKind === 'tuple' ? (type.tuple?.elements ?? []) : [];
    const restIndex = elements.findIndex((element) => element.rest);
    return restIndex === -1 ? 0 : restIndex;
  }

  arityMatches(signature: Signature, args: TreeNode[]): boolean {
    let count = 0;
    let open = false;
    for (const arg of args) {
      const length = this.spreadLength(arg);
      if (length === undefined) {
        // A tuple with a rest element passes its leading elements, then as many more as the rest holds.
        count += this.leadingLength(arg);
        const restIndex = signature.parameters.findIndex((parameter) => parameter.rest);
        if (restIndex === -1 || count < restIndex) return false;
        open = true;
      } else count += length;
    }
    if (open)
      return this.maximumArguments(signature) === Number.POSITIVE_INFINITY && count <= this.maximumArguments(signature);
    return count >= this.minimumArguments(signature) && count <= this.maximumArguments(signature);
  }

  reportArity(node: TreeNode, callee: TreeNode, signature: Signature, args: TreeNode[]): void {
    const minimum = this.minimumArguments(signature);
    const maximum = this.maximumArguments(signature);
    const spread = args.find((arg) => arg.type === 'spread_element' && this.spreadLength(arg) === undefined);
    if (spread && !this.arityMatches(signature, args)) {
      this.c.error(spread, 'スプレッド構文の引数は、タプル型であるか、残余引数に渡されなければいけません。');
      return;
    }
    let count = 0;
    let excess: TreeNode | undefined;
    for (const arg of args) {
      count += this.spreadLength(arg) ?? 1;
      if (count > maximum) excess ??= arg;
    }
    const message =
      maximum === Number.POSITIVE_INFINITY
        ? `引数は少なくとも ${minimum} 個必要ですが、${count} 個渡されています。`
        : minimum === maximum
          ? `引数は ${minimum} 個必要ですが、${count} 個渡されています。`
          : `引数は ${minimum} 個から ${maximum} 個必要ですが、${count} 個渡されています。`;
    const at = excess ?? (callee.type === 'member_expression' ? (callee.childForFieldName('property') ?? node) : node);
    this.c.error(at, message);
  }
}

/**
 * The type an argument passed at an offset into a rest parameter of a tuple type takes: the element at that position,
 * or the rest element's element type at or after a rest element.
 */
export function tupleTypeAt(c: Checker, elements: TupleElement[], offset: number): Type | undefined {
  const restIndex = elements.findIndex((element) => element.rest);
  if (restIndex === -1 || offset < restIndex) {
    const element = elements[offset];
    return element && (element.optional ? unionOf([element.type, undefinedType]) : element.type);
  }
  return c.restElementType(elements[restIndex].type);
}
