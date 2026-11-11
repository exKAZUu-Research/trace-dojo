import { BUILTIN_DOC } from '../attributes';
import { moduleDoc } from '../builtinDocs';
import { pyRepr } from '../conversions';
import { isSupportedModule, MISSING_PLATFORM_MODULES } from '../moduleNames';
import { isRegisteredModule, setBuiltinFunctionModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { callValue, importedModule } from '../objects';
import { nativeFunction, newList, None, typeError, typeName } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, PyBuiltinFunction, type PyClass, PyFunction, PyModule, type PyValue } from '../values';
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
  /** The names of the module's namespace in CPython's order, which follows its creation and its code, by spaces. */
  names: string;
  /** The modules CPython's functions in the namespace come from, when another than this one, as `_json`'s. */
  owners?: Readonly<Record<string, string>>;
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

/** Orders a new module's namespace as CPython's, whose names follow the module's creation and its code. */
export function orderNamespace(module: PyModule, importName = module.name): void {
  const layout = MODULE_LAYOUTS[importName] ?? MODULE_LAYOUTS[module.name];
  if (!layout) return;
  const { dict } = module;
  const entries = new Map(dict);
  dict.clear();
  for (const key of layout.names.split(' ')) {
    const value = entries.get(key);
    if (value === undefined) continue;
    dict.set(key, value);
    entries.delete(key);
  }
  for (const [key, value] of entries) dict.set(key, value);
}

/** Gives the functions of a new module the `__module__` CPython's have, which may name the module they come from. */
export function recordFunctionOwners(module: PyModule, importName = module.name): void {
  const layout = MODULE_LAYOUTS[importName] ?? MODULE_LAYOUTS[module.name];
  const owners = layout?.owners ?? {};
  for (const [key, owner] of Object.entries(owners)) {
    const value = module.dict.get(key);
    if (value instanceof PyFunction && sharedUnder(module, value, key, owners)) {
      // CPython's C function, such as json's scanstring, beside the Python function it falls back to.
      const native = nativeFunction(key, (args, kwargs) => callValue(value, args, kwargs));
      setBuiltinFunctionModule(native, owner);
      module.dict.set(key, native);
    } else if (value instanceof PyFunction) value.module = owner;
    else if (value instanceof PyBuiltinFunction) setBuiltinFunctionModule(value, owner);
  }
}

/** Whether the module holds a function under another name too, which CPython's function of that name is not. */
function sharedUnder(module: PyModule, fn: PyFunction, key: string, owners: Readonly<Record<string, string>>): boolean {
  for (const [other, value] of module.dict)
    if (value === fn && other !== key && owners[other] === undefined) return true;
  return false;
}

/**
 * Imports the modules a module holds because CPython's code imported them, which this grader imports when first read,
 * so that its namespace lists them where CPython's does.
 */
export function completeNamespace(module: PyModule): void {
  if (module.imports.size === 0) return;
  for (const key of module.imports.keys()) {
    try {
      importedModule(module, key);
    } catch (error) {
      // A shared object this grader does not support stays one that raises when read.
      if (!(error instanceof UnsupportedFeatureError)) throw error;
    }
  }
  orderNamespace(module);
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
  const module = new PyModule(cls, '', new Map<string, PyValue>());
  initializeModule(module, args, kwargs);
  createdModules.add(module);
  return module;
}

/** `module.__init__(name, doc=None)`, which sets the names CPython's new modules start with. */
export function initializeModule(module: PyModule, args: PyValue[], kwargs: Kwargs): void {
  checkArgs(
    { qualified: 'module', short: 'module', min: 0, max: 2, style: 'takes', keywords: ['name', 'doc'] },
    args,
    kwargs
  );
  const name = argument(args, kwargs, 0, 'name');
  if (name === undefined) throw typeError("module() missing required argument 'name' (pos 1)");
  if (typeof name !== 'string') throw typeError(`module() argument 'name' must be str, not ${typeName(name)}`);
  for (const [key, value] of [
    ['__name__', name],
    ['__doc__', argument(args, kwargs, 1, 'doc') ?? None],
    ['__package__', None],
    ['__loader__', None],
    ['__spec__', None],
  ] as const) {
    module.unsupported.delete(key);
    module.dict.set(key, value);
  }
}

/** `module.__dir__()`: the module's own `__dir__()` when its namespace has one, or else the names it has. */
export function moduleDir(module: PyModule): PyValue {
  const own = module.dict.get('__dir__');
  if (own !== undefined) return callValue(own, []);
  return newList([...new Set([...module.dict.keys(), ...module.unsupported.keys(), ...module.imports.keys()])]);
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
