import type { Arg } from './ast';

export function usesSimpleSprintf(args: Arg[]): boolean {
  const format = args[0]?.e;
  if (format?.k !== 'lit' || typeof format.v !== 'string') return false;
  const conversions = format.v.match(/%[sd]/g) ?? [];
  return !format.v.replaceAll(/%[sd]/g, '').includes('%') && args.length === conversions.length + 1;
}

export const oneArgumentBuiltinOpcodes = new Set([
  'strlen',
  'is_null',
  'is_bool',
  'is_long',
  'is_int',
  'is_integer',
  'is_float',
  'is_double',
  'is_string',
  'is_array',
  'is_object',
  'is_resource',
  'is_scalar',
  'boolval',
  'intval',
  'floatval',
  'doubleval',
  'strval',
  'count',
  'sizeof',
  'gettype',
  'clone',
]);
