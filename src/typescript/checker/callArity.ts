import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { State } from './flow';
import { named } from './syntax';
import { isAnyLike, isIntrinsic, type Signature, type TupleElement, type Type, undefinedType, unionOf } from './types';

interface ArgumentPosition {
  before: State;
  spread?: Type;
}

/** Flow at each expression's source position in an argument list or array literal. */
export class ExpressionListFlow {
  private positions?: Map<number, ArgumentPosition>;

  constructor(
    private readonly c: Checker,
    readonly nodes: TreeNode[]
  ) {}

  before(node: TreeNode): State {
    return this.position(node)?.before;
  }

  spreadType(node: TreeNode): Type | undefined {
    return node.type === 'spread_element' ? this.position(node)?.spread : undefined;
  }

  length(node: TreeNode): number | undefined {
    return node.type === 'spread_element' ? fixedSpreadLength(this.spreadType(node)) : 1;
  }

  private position(node: TreeNode): ArgumentPosition | undefined {
    this.positions ??= this.c.flow.probe(() => this.c.silently(() => this.collectPositions()));
    return this.positions.get(node.id);
  }

  private collectPositions(): Map<number, ArgumentPosition> {
    const positions = new Map<number, ArgumentPosition>();
    for (const [index, node] of this.nodes.entries()) {
      const before = this.c.flow.current?.clone();
      const operand = node.type === 'spread_element' ? named(node)[0] : undefined;
      const spread = operand ? this.c.expressions.check(operand) : undefined;
      positions.set(node.id, { before, spread });
      if (!operand && index + 1 < this.nodes.length) this.c.expressions.check(node);
    }
    return positions;
  }
}

/** Counts the arguments of a call against the parameters of a signature, and reports when they do not fit. */
export class CallArity {
  constructor(private readonly c: Checker) {}

  /**
   * Whether the instance of a signature whose declaration takes the arguments takes them too. TypeScript counts the
   * instance again only for a rest parameter that is no array, as `...args: A`; otherwise the declared parameters
   * decide, where `x: T | void` stays omittable even when `T` is inferred as `unknown`.
   */
  instanceArityMatches(instance: Signature, declaration: Signature, args: ExpressionListFlow): boolean {
    const hasNonArrayRest = declaration.parameters.some(
      ({ rest, type }) => rest && !isAnyLike(type) && !this.c.isArrayType(type) && !this.c.isReadonlyArrayType(type)
    );
    return !hasNonArrayRest || this.arityMatches(instance, args);
  }

  maximumArguments(signature: Signature): number {
    return signature.parameters.some((parameter) => parameter.rest)
      ? Number.POSITIVE_INFINITY
      : signature.parameters.length;
  }

  /** How many elements a spread tuple with a rest element passes before its rest, as `[number, ...string[]]`. */
  private leadingLength(type: Type | undefined): number {
    const elements = type?.kind === 'object' && type.objectKind === 'tuple' ? (type.tuple?.elements ?? []) : [];
    const restIndex = elements.findIndex((element) => element.rest);
    return restIndex === -1 ? 0 : restIndex;
  }

  arityMatches(signature: Signature, args: ExpressionListFlow): boolean {
    let count = 0;
    for (const arg of args.nodes) {
      const length = args.length(arg);
      if (length === undefined) {
        // A tuple with a rest element passes its leading elements, then as many more as the rest holds. As TypeScript
        // decides, a spread of unknown length fits where it starts past the required parameters and either a rest
        // parameter or an optional one takes it, whatever follows it.
        count += this.leadingLength(args.spreadType(arg));
        const hasRest = signature.parameters.some((parameter) => parameter.rest);
        return count >= minimumArguments(signature) && (hasRest || count < signature.parameters.length);
      }
      count += length;
    }
    return count >= minimumArguments(signature) && count <= this.maximumArguments(signature);
  }

  reportArity(node: TreeNode, callee: TreeNode, signature: Signature, args: ExpressionListFlow): void {
    const minimum = minimumArguments(signature);
    const maximum = this.maximumArguments(signature);
    const spread = args.nodes.find((arg) => args.length(arg) === undefined);
    if (spread && !this.arityMatches(signature, args)) {
      this.c.error(spread, 'スプレッド構文の引数は、タプル型であるか、残余引数に渡されなければいけません。');
      return;
    }
    let count = 0;
    let excess: TreeNode | undefined;
    for (const arg of args.nodes) {
      count += args.length(arg) ?? 1;
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

/** How many arguments a call must pass, as TypeScript's `getMinArgumentCount` counts them. */
export function minimumArguments(signature: Signature): number {
  if (signature.minimumArguments !== undefined) return signature.minimumArguments;
  let minimum = 0;
  for (const [index, parameter] of signature.parameters.entries()) {
    if (!parameter.optional && !parameter.rest && !acceptsVoid(parameter.type)) minimum = index + 1;
  }
  return minimum;
}

/** Whether a parameter's type has `void` as itself or a union member, which lets callers omit it when it trails. */
function acceptsVoid(type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).some((member) => isIntrinsic(member, 'void'));
}

export function tupleArgumentContexts(
  c: Checker,
  restType: Type,
  lengths: (number | undefined)[]
): (Type | undefined)[] {
  const elements = restType.kind === 'object' ? (restType.tuple?.elements ?? []) : [];
  const restIndex = elements.findIndex((element) => element.rest);
  const trailing = restIndex === -1 ? 0 : elements.length - 1 - restIndex;
  const fromStart = offsets(lengths);
  const fromEnd = offsets(lengths.toReversed()).toReversed();
  return lengths.map((_, index) => {
    const start = fromStart[index];
    if (start !== undefined && (restIndex === -1 || start < restIndex)) return elements[start]?.type;
    const end = fromEnd[index];
    if (end !== undefined && end < trailing) return elements[elements.length - 1 - end].type;
    if (restIndex === -1) return;
    return c.restElementType(elements[restIndex].type);
  });
}

/** How many values precede each argument, until a spread of unknown length. */
function offsets(lengths: (number | undefined)[]): (number | undefined)[] {
  let offset: number | undefined = 0;
  return lengths.map((length) => {
    const current = offset;
    offset = offset === undefined || length === undefined ? undefined : offset + length;
    return current;
  });
}

export function spreadLength(c: Checker, arg: TreeNode): number | undefined {
  if (arg.type !== 'spread_element') return 1;
  return fixedSpreadLength(c.flow.probe(() => c.silently(() => c.expressions.check(named(arg)[0]))));
}

function fixedSpreadLength(type: Type | undefined): number | undefined {
  if (
    type?.kind === 'object' &&
    type.objectKind === 'tuple' &&
    !(type.tuple?.elements ?? []).some((element) => element.rest)
  )
    return type.tuple?.elements.length;
  return undefined;
}
