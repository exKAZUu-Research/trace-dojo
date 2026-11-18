import type { Arg } from './ast';

export function simpleSprintfFormat(args: Arg[]): string | undefined {
  if (args.some((arg) => arg.spread || arg.name !== undefined)) return;
  const format = args[0]?.e;
  if (format?.k !== 'lit' || typeof format.v !== 'string' || format.v.length >= 256) return;
  let operands = 0;
  for (const part of format.v.matchAll(/%[sd%]|%/g)) {
    if (part[0] === '%') return;
    if (part[0] !== '%%') operands++;
  }
  return operands + 1 === args.length ? format.v : undefined;
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
