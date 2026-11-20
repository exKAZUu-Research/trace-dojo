import { BINARY, UNARY } from '../../c/library/mathFunctions';
import { MATH_CONSTANTS } from './constants';
import { isLibcGlobalDeclared, isLibcHeaderMacro, isSdkGlobalType, isSdkStdDeclared } from './libcGlobals';

/** The headers suggested when a library name is missing. */
const DECLARING_HEADERS: Record<string, string[]> = {};
for (const [group, names] of Object.entries({
  iostream: ['cout', 'cerr', 'clog', 'endl', 'flush', 'ends'],
  iomanip: ['setw', 'setprecision', 'setfill', 'setbase', 'setiosflags', 'resetiosflags'],
  string: ['string', 'to_string', 'stoi', 'stol', 'stoll', 'stoul', 'stoull', 'stof', 'stod', 'stold', 'getline'],
  vector: ['vector'],
  map: ['map', 'multimap'],
  set: ['set', 'multiset'],
  unordered_map: ['unordered_map'],
  unordered_set: ['unordered_set'],
  deque: ['deque'],
  list: ['list'],
  stack: ['stack'],
  queue: ['queue', 'priority_queue'],
  array: ['array'],
  utility: ['pair', 'make_pair', 'swap'],
  algorithm: [
    'sort',
    'stable_sort',
    'reverse',
    'min',
    'max',
    'minmax',
    'min_element',
    'max_element',
    'find',
    'find_if',
    'find_if_not',
    'count',
    'count_if',
    'fill',
    'binary_search',
    'lower_bound',
    'upper_bound',
    'unique',
    'next_permutation',
    'prev_permutation',
    'all_of',
    'any_of',
    'none_of',
    'for_each',
    'transform',
    'copy',
    'copy_if',
    'replace',
    'replace_if',
    'remove',
    'remove_if',
    'equal',
    'rotate',
    'clamp',
    'shuffle',
    'iter_swap',
  ],
  numeric: ['accumulate', 'iota', 'gcd', 'lcm', 'partial_sum', 'inner_product'],
  functional: [
    'less',
    'greater',
    'less_equal',
    'greater_equal',
    'equal_to',
    'not_equal_to',
    'plus',
    'minus',
    'multiplies',
    'divides',
    'modulus',
  ],
  iterator: ['back_inserter', 'next', 'prev', 'advance', 'distance'],
  sstream: ['ostringstream', 'istringstream', 'stringstream'],
  stdexcept: [
    'runtime_error',
    'logic_error',
    'invalid_argument',
    'out_of_range',
    'length_error',
    'domain_error',
    'range_error',
    'overflow_error',
    'underflow_error',
  ],
  exception: [
    'exception',
    'bad_exception',
    'exception_ptr',
    'current_exception',
    'make_exception_ptr',
    'rethrow_exception',
  ],
  new: [
    'bad_alloc',
    'bad_array_new_length',
    'nothrow',
    'nothrow_t',
    'new_handler',
    'set_new_handler',
    'get_new_handler',
  ],
  limits: ['numeric_limits'],
  random: ['mt19937', 'mt19937_64', 'random_device', 'uniform_int_distribution', 'uniform_real_distribution'],
  cstdlib: [
    'rand',
    'srand',
    'exit',
    'abs',
    'labs',
    'llabs',
    'atoi',
    'atol',
    'RAND_MAX',
    'EXIT_SUCCESS',
    'EXIT_FAILURE',
  ],
  cmath: [
    ...Object.keys(UNARY).flatMap((name) => [name, `${name}f`, `${name}l`]),
    ...Object.keys(BINARY).flatMap((name) => [name, `${name}f`, `${name}l`]),
    'fma',
    'abs',
    'isnan',
    'isinf',
    'isfinite',
    'signbit',
    ...Object.keys(MATH_CONSTANTS),
    'INFINITY',
    'NAN',
    'HUGE_VAL',
  ],
  cctype: [
    'isalnum',
    'isalpha',
    'isblank',
    'iscntrl',
    'isdigit',
    'isgraph',
    'islower',
    'isprint',
    'ispunct',
    'isspace',
    'isupper',
    'isxdigit',
    'tolower',
    'toupper',
  ],
  cstring: ['strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strchr', 'strstr'],
  cstdio: [
    'FILE',
    'printf',
    'fprintf',
    'sprintf',
    'snprintf',
    'puts',
    'putchar',
    'fputs',
    'fputc',
    'putc',
    'fflush',
    'stdout',
    'stderr',
    'EOF',
  ],
  climits: [
    'CHAR_BIT',
    'CHAR_MAX',
    'CHAR_MIN',
    'SCHAR_MAX',
    'SCHAR_MIN',
    'UCHAR_MAX',
    'SHRT_MAX',
    'SHRT_MIN',
    'USHRT_MAX',
    'INT_MAX',
    'INT_MIN',
    'UINT_MAX',
    'LONG_MAX',
    'LONG_MIN',
    'ULONG_MAX',
    'LLONG_MAX',
    'LLONG_MIN',
    'ULLONG_MAX',
  ],
})) {
  for (const name of names) (DECLARING_HEADERS[name] ??= []).push(group);
}

function typedefHeader(name: string): string | undefined {
  if (name === 'ssize_t') return 'cstdio';
  if (name === 'size_t' || name === 'ptrdiff_t' || name === 'nullptr_t') return 'cstddef';
  if (/^u?int(?:8|16|32|64|ptr|max)_t$/.test(name)) return 'cstdint';
}

export function isVisible(name: string, headers: ReadonlySet<string>, scope: 'std' | 'global'): boolean {
  if (scope === 'std') return isSdkStdDeclared(name, headers);
  return isLibcGlobalDeclared(name, headers) || isSdkGlobalType(name, headers) || isLibcHeaderMacro(name, headers);
}

/** The header that declares a library name, for the message that asks to include it. */
export function headerOf(name: string): string | undefined {
  if (['begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend', 'size'].includes(name)) return 'iterator';
  if (['istream', 'ostream', 'ios'].includes(name)) return name;
  return typedefHeader(name) ?? DECLARING_HEADERS[name]?.[0];
}

export function hasLocaleCtypeOverload(name: string, headers: ReadonlySet<string>): boolean {
  if (!DECLARING_HEADERS[name]?.includes('cctype') || name === 'isblank') return false;
  return ['locale', 'ios', 'istream', 'ostream', 'iostream', 'sstream', 'iomanip'].some((header) =>
    headers.has(header)
  );
}
