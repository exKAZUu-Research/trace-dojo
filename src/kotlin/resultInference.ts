import { branchHint, commonSupertype } from './typeRelations';
import { hasOpenVariables, type KType, resolved } from './types';

export function siblingResultType(types: KType[], expected: KType | undefined): KType | undefined {
  const informative = types.filter((type) => resolved(type).kind !== 'nothing' && !hasOpenVariables(type));
  if (informative.length === 0) return undefined;
  const outer = expected && !hasOpenVariables(expected) ? expected : undefined;
  return branchHint(commonSupertype(informative), outer, true);
}

export function needsSiblingHint(expected: KType | undefined): boolean {
  if (!expected || hasOpenVariables(expected)) return true;
  const type = resolved(expected);
  return type.kind !== 'class' || type.args.length === 0 || type.args.some(({ variance }) => variance === 'star');
}
