import type { Expression } from './ast';

/**
 * Whether a call or creation passes an argument whose type its target may decide: an implicitly typed lambda, or a
 * generic call such as `Comparator.reverseOrder()` in `comparingByValue(Comparator.reverseOrder())`, directly or
 * through such a call, so that the call waits for its own target when it cannot be typed alone.
 */
export function passesPolyArgument(expression: Expression): boolean {
  if (expression.kind !== 'call' && expression.kind !== 'new') return false;
  return expression.args.some(
    (arg) =>
      (arg.kind === 'lambda' && arg.parameters.some((parameter) => !parameter.type)) ||
      arg.kind === 'call' ||
      arg.kind === 'new' ||
      passesPolyArgument(arg)
  );
}

/**
 * Whether a conditional or switch expression may result in a lambda or method reference, which only a target type
 * types, found among its results outside the calls and creations in it.
 */
export function resultsInFunction(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => resultsInFunction(child));
  if (typeof node !== 'object' || node === null) return false;
  const { kind } = node as { kind?: string };
  if (kind === 'lambda' || kind === 'methodRef') return true;
  if (kind === 'call' || kind === 'new') return false;
  const children = Object.entries(node).filter(([key]) => !(kind === 'conditional' && key === 'condition'));
  return children.some(([, value]) => resultsInFunction(value));
}
