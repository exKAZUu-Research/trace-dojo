import { STDLIB_MODULE_NAMES } from './stdlibModuleNames';

/** The standard library modules this grader implements, which programs may import. */
export const SUPPORTED_MODULES: ReadonlySet<string> = new Set([
  'bisect',
  'collections',
  'copy',
  'dataclasses',
  'enum',
  'functools',
  'heapq',
  'itertools',
  'json',
  'math',
  'random',
  'statistics',
  'string',
  'sys',
  'typing',
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
