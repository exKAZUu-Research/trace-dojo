import { STDLIB_MODULE_NAMES } from './stdlibModuleNames';

/** The standard library modules this grader implements, which programs may import. */
export const SUPPORTED_MODULES: ReadonlySet<string> = new Set([
  '__future__',
  '_thread',
  'abc',
  'annotationlib',
  'array',
  'asyncio',
  'atexit',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'calendar',
  'cmath',
  'collections',
  'collections.abc',
  'concurrent',
  'concurrent.futures',
  'contextlib',
  'copy',
  'dataclasses',
  'datetime',
  'decimal',
  'enum',
  'fractions',
  'functools',
  'gc',
  'hashlib',
  'heapq',
  'importlib',
  'inspect',
  'io',
  'itertools',
  'json',
  'keyword',
  'logging',
  'math',
  'numbers',
  'operator',
  'os',
  'os.path',
  'posixpath',
  'pprint',
  'queue',
  'random',
  're',
  'statistics',
  'string',
  'string.templatelib',
  'struct',
  'sys',
  'textwrap',
  'threading',
  'time',
  'traceback',
  'types',
  'typing',
  'unicodedata',
  'weakref',
  'warnings',
  'zlib',
]);

export function isSupportedModule(module: string): boolean {
  return SUPPORTED_MODULES.has(module);
}

/** Names an import that this grader rejects, for its error message. */
export function unsupportedModuleFeature(module: string): string {
  const top = module.split('.')[0];
  return STDLIB_MODULE_NAMES.has(top)
    ? `モジュール ${module}`
    : `標準ライブラリ以外のモジュールや別のファイルの import（${module}）`;
}
