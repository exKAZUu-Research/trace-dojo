import type { Arg, Expr, ResolvedName } from './ast';
import { lower } from './bytes';

const FRAMELESS_ARITIES = new Map<string, readonly number[]>(
  Object.entries({
    class_exists: [1, 2],
    dechex: [1],
    dirname: [1, 2],
    implode: [1, 2],
    in_array: [2, 3],
    is_numeric: [1],
    max: [2],
    min: [2],
    preg_match: [2],
    preg_replace: [3],
    property_exists: [2],
    str_contains: [2],
    str_replace: [3],
    str_starts_with: [2],
    strpos: [2, 3],
    strstr: [2, 3],
    strtr: [2, 3],
    substr: [2, 3],
    trim: [1, 2],
  })
);

const OPCODE_ARITIES = new Map<string, readonly number[]>(
  Object.entries({
    array_key_exists: [2],
    get_called_class: [0],
    get_class: [0, 1],
  })
);

const oneArgumentOpcodes = new Set([
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

export function compiledBuiltinName(callee: Expr | ResolvedName): string | undefined {
  if (!('k' in callee)) return callee.fallback ? undefined : lower(callee.name);
  if (callee.k !== 'lit' || typeof callee.v !== 'string' || callee.v.includes('::')) return undefined;
  return lower(callee.v.startsWith('\\') ? callee.v.slice(1) : callee.v);
}

export function compiledBuiltinResult(
  builtin: string,
  args: Arg[],
  inFunction: boolean
): 'constant' | 'temporary' | undefined {
  const specialized = specializedBuiltinCall(builtin, args, inFunction);
  if (specialized === 'forwarding') return undefined;
  if (specialized) return 'temporary';
  if (builtin === 'sprintf' && simpleSprintfFormat(args) !== undefined) {
    return args.length === 1 ? 'constant' : 'temporary';
  }
  if (args.length !== 1 || args[0].spread || args[0].name !== undefined) return undefined;
  const value = builtinLiteralArgument(args[0].e);
  if (builtin === 'chr' && typeof value === 'bigint' && value >= 0n && value <= 255n) return 'constant';
  if (builtin === 'ord' && typeof value === 'string' && value.length === 1) return 'constant';
  if (builtin === 'defined' && value !== undefined && (typeof value !== 'string' || !/[\\:]/.test(value)))
    return 'temporary';
  return undefined;
}

export function builtinLiteralArgument(argument: Expr): Extract<Expr, { k: 'lit' }>['v'] | undefined {
  return argument.k === 'lit' ? argument.v : argument.k === 'bin' ? argument.foldedString : undefined;
}

export function specializedBuiltinCall(
  builtin: string,
  args: Arg[],
  inFunction: boolean
): 'opcode' | 'frameless' | 'forwarding' | undefined {
  if (args.some((arg) => arg.spread || arg.name !== undefined)) return undefined;
  const arity = args.length;
  if (FRAMELESS_ARITIES.get(builtin)?.includes(arity)) return 'frameless';
  if (builtin === 'call_user_func' && arity > 0) return 'forwarding';
  if (builtin === 'call_user_func_array' && arity === 2) return 'forwarding';
  if (builtin === 'func_get_args' || builtin === 'func_num_args')
    return inFunction && arity === 0 ? 'opcode' : undefined;
  if (OPCODE_ARITIES.get(builtin)?.includes(arity) || (arity === 1 && oneArgumentOpcodes.has(builtin))) return 'opcode';
  return undefined;
}

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
