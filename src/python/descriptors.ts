import { method } from './define';
import { builtinClass, pyError } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type PyClass, PyOpaque, type PyValue } from './values';

/**
 * The data descriptors builtin types keep in their dictionaries, such as `int.real` or `function.__code__`, which
 * `dir()` lists and attribute access reads through.
 */

export const getsetDescriptorClass = builtinClass('getset_descriptor');
export const memberDescriptorClass = builtinClass('member_descriptor');

interface DescriptorData {
  owner: PyClass;
  name: string;
  get?: (self: PyValue) => PyValue;
  set?: (self: PyValue, value: PyValue) => void;
  /** The feature an unsupported attribute's error names. */
  unsupported?: string;
  /** Whether an instance's own attribute of the name takes precedence, as for `__doc__`. */
  nonData?: boolean;
}

for (const [cls, kind] of [
  [getsetDescriptorClass, 'attribute'],
  [memberDescriptorClass, 'member'],
] as const) {
  method(cls, '__repr__', 'none', 0, 0, (self) => {
    const data = dataOf(self);
    return `<${kind} '${data.name}' of '${data.owner.name}' objects>`;
  });
  method(cls, '__get__', 'expected', 1, 2, (self, [instance]) => readDescriptor(self as PyOpaque, instance));
  cls.opaqueAttribute = (self, name) => {
    const data = dataOf(self);
    if (name === '__name__' || name === '__qualname__')
      return name === '__name__' ? data.name : `${data.owner.name}.${data.name}`;
    if (name === '__objclass__') return data.owner;
    return;
  };
}

const dataOf = (self: PyValue): DescriptorData => (self as PyOpaque).data as DescriptorData;

/** Adds a data descriptor to a builtin class, which reads the attribute with `get` and writes it with `set`. */
export function defineGetSet(
  cls: PyClass,
  name: string,
  get: DescriptorData['get'],
  options: { set?: DescriptorData['set']; member?: boolean; nonData?: boolean } = {}
): void {
  const descriptorClass = options.member ? memberDescriptorClass : getsetDescriptorClass;
  const data: DescriptorData = { owner: cls, name, get, set: options.set, nonData: options.nonData };
  cls.dict.set(name, new PyOpaque(descriptorClass, name, data));
}

/** Adds attributes this grader does not support, which `dir()` lists but reading raises the unsupported error. */
export function defineUnsupportedAttributes(cls: PyClass, features: Record<string, string>): void {
  for (const [name, unsupported] of Object.entries(features)) {
    cls.dict.set(
      name,
      new PyOpaque(getsetDescriptorClass, name, { owner: cls, name, unsupported } satisfies DescriptorData)
    );
  }
}

export function isDataDescriptor(value: PyValue | undefined): value is PyOpaque {
  return isBuiltinDescriptor(value) && !dataOf(value).nonData;
}

/** Whether a value is a builtin descriptor that an instance's own attribute of the name hides, such as `__doc__`. */
export function isNonDataDescriptor(value: PyValue | undefined): value is PyOpaque {
  return isBuiltinDescriptor(value) && dataOf(value).nonData === true;
}

function isBuiltinDescriptor(value: PyValue | undefined): value is PyOpaque {
  return value instanceof PyOpaque && (value.cls === getsetDescriptorClass || value.cls === memberDescriptorClass);
}

/** Reads an attribute through a builtin data descriptor. */
export function readDescriptor(descriptor: PyOpaque, instance: PyValue): PyValue {
  const data = dataOf(descriptor);
  if (data.unsupported !== undefined) throw new UnsupportedFeatureError(data.unsupported);
  if (!data.get)
    throw pyError('AttributeError', `attribute '${data.name}' of '${data.owner.name}' objects is not readable`);
  return data.get(instance);
}

/** Writes an attribute through a builtin data descriptor, which may be read-only. */
export function writeDescriptor(descriptor: PyOpaque, instance: PyValue, value: PyValue): void {
  const data = dataOf(descriptor);
  if (data.unsupported !== undefined) throw new UnsupportedFeatureError(data.unsupported);
  if (!data.set) throw unwritableError(descriptor);
  data.set(instance, value);
}

/** The error of assigning to or deleting an attribute whose builtin data descriptor has no setter. */
export function unwritableError(descriptor: PyOpaque): Error {
  const data = dataOf(descriptor);
  return pyError(
    'AttributeError',
    descriptor.cls === memberDescriptorClass
      ? 'readonly attribute'
      : `attribute '${data.name}' of '${data.owner.name}' objects is not writable`
  );
}
