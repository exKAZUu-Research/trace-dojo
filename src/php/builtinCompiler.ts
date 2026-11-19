import type { Arg } from './ast';

export function simpleSprintfFormat(args: Arg[], folded?: string): string | undefined {
  if (args.some((arg) => arg.spread || arg.name !== undefined)) return;
  const expression = args[0]?.e;
  const format = folded ?? (expression?.k === 'lit' ? expression.v : undefined);
  if (typeof format !== 'string' || format.length >= 256) return;
  let operands = 0;
  for (const [, specifier] of simpleSprintfParts(format)) {
    if (specifier === undefined) return;
    if (specifier !== '%') operands++;
  }
  return operands + 1 === args.length ? format : undefined;
}

export function simpleSprintfParts(format: string): IterableIterator<RegExpExecArray> {
  return format.matchAll(/%([sd%])|%/g);
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
