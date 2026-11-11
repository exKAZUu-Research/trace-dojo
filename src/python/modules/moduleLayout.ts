import { BUILTIN_DOC } from '../attributes';
import { isSupportedModule, MISSING_PLATFORM_MODULES } from '../moduleNames';
import { isRegisteredModule } from '../modules';
import { None } from '../types';
import { PyModule } from '../values';
import { MODULE_LAYOUTS } from './moduleLayouts';

/** How CPython provides a module: where its code comes from, its doc and package, and the modules its code imported. */
export interface ModuleLayout {
  /** A builtin module has no file; a frozen one has a file but no cache; a package also has a path. */
  kind: 'builtin' | 'frozen' | 'source' | 'package';
  /** False when CPython's module has no docstring. */
  doc?: false;
  /** The `__package__` when it is not the package the module's name implies. */
  package?: string;
  /** The modules the module's code imported, by the names it holds them under. */
  imports?: Readonly<Record<string, string>>;
}

const LOADER: Record<string, string> = {
  __loader__: 'モジュールの __loader__（import の仕組み）',
  __spec__: 'モジュールの __spec__（import の仕組み）',
};
const FROZEN: Record<string, string> = {
  ...LOADER,
  __builtins__: 'モジュールの __builtins__（組み込みの名前空間そのもの）',
  __file__: 'モジュールの __file__（ファイルのパス）',
};
const SOURCE: Record<string, string> = { ...FROZEN, __cached__: 'モジュールの __cached__（ファイルのパス）' };
const PACKAGE: Record<string, string> = { ...SOURCE, __path__: 'パッケージの __path__（ファイルのパス）' };
/** The attributes of each kind of module that tell how it was found and loaded, which this grader does not provide. */
const LOADING_ATTRIBUTES: Record<ModuleLayout['kind'], Record<string, string>> = {
  builtin: LOADER,
  frozen: FROZEN,
  source: SOURCE,
  package: PACKAGE,
};

/**
 * Gives a new module the attributes CPython's has that its code did not define: `__doc__`, `__package__`, the
 * modules CPython's code imported (imported when first read), and the loading attributes, which raise the unsupported
 * error.
 */
export function addLayoutAttributes(module: PyModule, importName: string): void {
  const layout = MODULE_LAYOUTS[importName] ?? MODULE_LAYOUTS[module.name];
  if (!layout) return;
  const { dict } = module;
  for (const [key, feature] of Object.entries(LOADING_ATTRIBUTES[layout.kind])) {
    if (!dict.has(key)) module.unsupported.set(key, feature);
  }
  if (!dict.has('__doc__') && !module.unsupported.has('__doc__')) {
    if (layout.doc === false) dict.set('__doc__', None);
    else module.unsupported.set('__doc__', BUILTIN_DOC);
  }
  if (!dict.has('__package__')) dict.set('__package__', layout.package ?? impliedPackage(importName, layout));
  for (const [key, target] of Object.entries(layout.imports ?? {})) {
    const supported =
      isSupportedModule(target) || (isRegisteredModule(target) && !MISSING_PLATFORM_MODULES.has(target));
    if (dict.has(key)) {
      // The module's code may keep a stand-in for a module this grader lacks, as CPython's code does when an import
      // fails; reading it from outside still names the missing module.
      if (!supported && !(dict.get(key) instanceof PyModule)) module.unsupported.set(key, `モジュール ${target}`);
      continue;
    }
    if (supported) {
      module.unsupported.delete(key);
      module.imports.set(key, target);
    } else if (!module.unsupported.has(key)) {
      module.unsupported.set(key, `モジュール ${target}`);
    }
  }
}

function impliedPackage(name: string, layout: ModuleLayout): string {
  return layout.kind === 'package' ? name : name.slice(0, Math.max(0, name.lastIndexOf('.')));
}
