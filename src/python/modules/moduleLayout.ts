import { BUILTIN_DOC } from '../attributes';
import { moduleDoc } from '../builtinDocs';
import { pyRepr } from '../conversions';
import { isSupportedModule, MISSING_PLATFORM_MODULES } from '../moduleNames';
import { isRegisteredModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { None, typeError, typeName } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, type PyClass, PyModule, type PyValue } from '../values';
import { MODULE_LAYOUTS } from './moduleLayouts';

/** How CPython provides a module: where its code comes from, its doc and package, and the modules its code imported. */
export interface ModuleLayout {
  /** A builtin module has no file; a frozen one has a file but no cache; a package also has a path. */
  kind: 'builtin' | 'frozen' | 'source' | 'package';
  /** False when CPython's module has no docstring. */
  doc?: false;
  /** The `__package__` when it is not the package the module's name implies; null for CPython's None. */
  package?: string | null;
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
// code-gauge-allow functionCognitiveComplexity 16 -- One case per attribute CPython's module creation adds.
export function addLayoutAttributes(module: PyModule, importName: string): void {
  const layout = MODULE_LAYOUTS[importName] ?? MODULE_LAYOUTS[module.name];
  if (!layout) return;
  const { dict } = module;
  for (const [key, feature] of Object.entries(LOADING_ATTRIBUTES[layout.kind])) {
    if (!dict.has(key)) module.unsupported.set(key, feature);
  }
  if (!dict.has('__doc__') && !module.unsupported.has('__doc__')) {
    const doc = layout.doc === false ? undefined : moduleDoc(module.name);
    if (layout.doc === false) dict.set('__doc__', None);
    else if (doc === undefined) module.unsupported.set('__doc__', BUILTIN_DOC);
    else dict.set('__doc__', doc);
  }
  if (!dict.has('__package__')) {
    const { package: name } = layout;
    dict.set('__package__', name === null ? None : (name ?? impliedPackage(importName, layout)));
  }
  for (const [key, target] of Object.entries(layout.imports ?? {})) addImportedModule(module, key, target);
}

/** Makes `module.key` the module `target`, imported when first read, or the unsupported error when this grader lacks it. */
function addImportedModule(module: PyModule, key: string, target: string): void {
  const supported = isSupportedModule(target) || (isRegisteredModule(target) && !MISSING_PLATFORM_MODULES.has(target));
  if (module.dict.has(key)) {
    // The module's code may keep a stand-in for a module this grader lacks, as CPython's code does when an import
    // fails; reading it from outside still names the missing module.
    if (!supported && !(module.dict.get(key) instanceof PyModule)) module.unsupported.set(key, `モジュール ${target}`);
  } else if (supported) {
    module.unsupported.delete(key);
    module.imports.set(key, target);
  } else if (!module.unsupported.has(key)) {
    module.unsupported.set(key, `モジュール ${target}`);
  }
}

/** The modules a program creates with `types.ModuleType(name)`, whose repr reads their namespace. */
const createdModules = new WeakSet<PyModule>();

/** `types.ModuleType(name, doc=None)`, a module with CPython's initial namespace. */
export function createModule(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyModule {
  checkArgs(
    { qualified: 'module', short: 'module', min: 0, max: 2, style: 'takes', keywords: ['name', 'doc'] },
    args,
    kwargs
  );
  const name = argument(args, kwargs, 0, 'name');
  if (name === undefined) throw typeError("module() missing required argument 'name' (pos 1)");
  if (typeof name !== 'string') throw typeError(`module() argument 'name' must be str, not ${typeName(name)}`);
  const module = new PyModule(
    cls,
    name,
    new Map<string, PyValue>([
      ['__name__', name],
      ['__doc__', argument(args, kwargs, 1, 'doc') ?? None],
      ['__package__', None],
      ['__loader__', None],
      ['__spec__', None],
    ])
  );
  createdModules.add(module);
  return module;
}

/**
 * The repr of a module: a builtin or frozen module of CPython says so, while CPython's repr of a module loaded from a
 * file shows its path, which this grader does not have.
 */
export function moduleRepr(module: PyModule): string {
  if (createdModules.has(module)) {
    const name = module.dict.get('__name__');
    const file = module.dict.get('__file__');
    const shown = typeof name === 'string' ? pyRepr(name) : "'?'";
    return typeof file === 'string' ? `<module ${shown} from ${pyRepr(file)}>` : `<module ${shown}>`;
  }
  const kind = MODULE_LAYOUTS[module.name]?.kind ?? 'builtin';
  if (kind === 'builtin' || kind === 'frozen')
    return `<module '${module.name}' (${kind === 'builtin' ? 'built-in' : 'frozen'})>`;
  throw new UnsupportedFeatureError(`モジュール ${module.name} の repr（ファイルのパスを含む）`);
}

function impliedPackage(name: string, layout: ModuleLayout): string {
  return layout.kind === 'package' ? name : name.slice(0, Math.max(0, name.lastIndexOf('.')));
}
