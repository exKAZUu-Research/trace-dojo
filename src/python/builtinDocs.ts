import type { PyAttribute } from './attributeDescriptors';
import { BUILTIN_DOCS } from './data/builtinDocs';
import { builtinFunctionModule } from './modules';
import { currentRuntime } from './runtimeContext';
import { classOf, descriptorOwners } from './types';
import { PyBuiltinFunction, PyClass, PyDescriptor, PyModule, type PyValue } from './values';

/** The docstring and the text signature of a builtin, by `module.qualname[.attribute]`, read on first use. */
let table: Map<string, [string | undefined, string | undefined]> | undefined;
/** The entries of the attributes of types by `qualname.attribute`, the types of the builtins module first. */
const bySuffix = new Map<string, [string | undefined, string | undefined]>();

/** CPython's docstring of a builtin function, method, type, or module, if CPython has one. */
export function builtinDoc(value: PyValue): string | undefined {
  return entry(value)?.[0];
}

/** CPython's `__text_signature__` of a builtin function, method, or type, if CPython has one. */
export function builtinTextSignature(value: PyValue): string | undefined {
  return entry(value)?.[1];
}

/**
 * The data of a builtin, or of the method a type's method overrides when CPython's type inherits it instead, as for
 * the `__repr__` of an iterator, which is `object`'s in CPython.
 */
function entry(value: PyValue): [string | undefined, string | undefined] | undefined {
  const key = docKey(value);
  if (key === undefined) return undefined;
  const found = entries().get(key) ?? (key.startsWith('?') ? bySuffix.get(key.slice(1)) : undefined);
  if (found || !(value instanceof PyBuiltinFunction)) return found;
  const owner = ownerOf(value);
  for (const base of owner?.mro.slice(1) ?? []) {
    const inherited = entries().get(`${classKey(base)}.${value.name}`);
    if (inherited) return inherited;
  }
  return undefined;
}

/** The C accelerator module CPython's function of this name in a module comes from, such as `_operator`, if any. */
export function acceleratorModule(module: string, name: string): string | undefined {
  return entries().get(`@${module}.${name}`)?.[0];
}

/** The docstrings of `object.__class__` and of the `__dict__` and `__weakref__` of the classes without `__slots__`. */
export const INSTANCE_ATTRIBUTE_DOCS: Record<string, string> = {
  __class__: "the object's class",
  __dict__: 'dictionary for instance variables',
  __weakref__: 'list of weak references to the object',
};

/** The docstring CPython's module of this name has, if it has one. */
export function moduleDoc(name: string): string | undefined {
  return entries().get(name)?.[0];
}

/** The attributes of CPython's builtin class, as sorted `name:kind` words, which pydoc's help shows. */
export function builtinClassLayout(cls: PyClass): string | undefined {
  return entries().get(`!${classKey(cls)}`)?.[0];
}

export function builtinTypeImmutable(cls: PyClass): boolean | undefined {
  const flag = entries().get(`^${classKey(cls)}`)?.[0];
  return flag === undefined ? undefined : flag === '1';
}

function entries(): Map<string, [string | undefined, string | undefined]> {
  if (!table) {
    const [keys, strings, pairs] = JSON.parse(BUILTIN_DOCS) as [string[], string[], [number, number][]];
    table = new Map(
      keys.map((key, index) => {
        const [doc, signature] = pairs[index] as [number, number];
        return [key, [strings[doc - 1], strings[signature - 1]]];
      })
    );
    for (const [key, value] of table) {
      if (key.startsWith('^')) continue;
      const suffix = key.split('.').slice(-2).join('.');
      if (key.startsWith('builtins.') || !bySuffix.has(suffix)) bySuffix.set(suffix, value);
    }
  }
  return table;
}

/**
 * The key of a builtin in the data: `module.qualname` of a type, that with `.name` of a type's method (bound or not),
 * and `module.name` of a module's function; `?qualname.name` asks for a method of a type of unknown module.
 */
export function docKey(value: PyValue): string | undefined {
  if (value instanceof PyClass) return classKey(value);
  if (value instanceof PyModule) return value.name;
  // A getset or member descriptor, which this module, imported before them, knows by its owner.
  const attributeOwner = (value as Partial<PyAttribute>).owner;
  if (attributeOwner instanceof PyClass) return `${classKey(attributeOwner)}.${(value as PyAttribute).name}`;
  if (value instanceof PyDescriptor && value.fn instanceof PyBuiltinFunction) return docKey(value.fn);
  if (!(value instanceof PyBuiltinFunction)) return undefined;
  const owner = ownerOf(value);
  if (owner) return `${classKey(owner)}.${value.name}`;
  if (value.self instanceof PyModule) return `${value.self.name}.${value.name}`;
  // A type's method whose type the function does not record, which only its type's name tells.
  if (value.ownerName !== undefined && value.self === undefined) return `?${value.ownerName}.${value.name}`;
  const module = builtinFunctionModule(currentRuntime(), value);
  return module === undefined ? undefined : `${module}.${value.name}`;
}

/** The type a builtin method belongs to: the one defining it, or the one of the object it is bound to. */
function ownerOf(fn: PyBuiltinFunction): PyClass | undefined {
  const owner = descriptorOwners.get(fn);
  if (owner) return owner;
  const { self } = fn;
  if (self === undefined || self instanceof PyModule) return undefined;
  // A class method bound to a subclass, as `bool.from_bytes`, is its base's.
  const inClass =
    self instanceof PyClass && self.mro.some((each) => each.name === fn.ownerName && each.dict.has(fn.name));
  const cls = self instanceof PyClass && inClass ? self : classOf(self);
  return cls.mro.find((each) => each.dict.has(fn.name));
}

function classKey(cls: PyClass): string {
  return `${cls.module}.${cls.qualifiedName}`;
}
