import { objectClass } from './types';

/** The docstrings of builtin functions that this grader gives as CPython does. */
export const builtinDocs = new WeakMap<object, string>();

/**
 * The docstrings of `object`'s methods, which pydoc shows for the methods a class inherits, or overrides without a
 * docstring of its own.
 */
const OBJECT_METHOD_DOCS: [string, string][] = [
  ['__new__', 'Create and return a new object.  See help(type) for accurate signature.'],
  ['__repr__', 'Return repr(self).'],
  ['__hash__', 'Return hash(self).'],
  ['__str__', 'Return str(self).'],
  ['__getattribute__', 'Return getattr(self, name).'],
  ['__setattr__', 'Implement setattr(self, name, value).'],
  ['__delattr__', 'Implement delattr(self, name).'],
  ['__lt__', 'Return self<value.'],
  ['__le__', 'Return self<=value.'],
  ['__eq__', 'Return self==value.'],
  ['__ne__', 'Return self!=value.'],
  ['__gt__', 'Return self>value.'],
  ['__ge__', 'Return self>=value.'],
  ['__init__', 'Initialize self.  See help(type(self)) for accurate signature.'],
  ['__reduce_ex__', 'Helper for pickle.'],
  ['__reduce__', 'Helper for pickle.'],
  ['__getstate__', 'Helper for pickle.'],
  [
    '__subclasshook__',
    'Abstract classes can override this to customize issubclass().\n\nThis is invoked early on by abc.ABCMeta.__subclasscheck__().\nIt should return True, False or NotImplemented.  If it returns\nNotImplemented, the normal algorithm is used.  Otherwise, it\noverrides the normal algorithm (and the outcome is cached).\n',
  ],
  [
    '__init_subclass__',
    'This method is called when a class is subclassed.\n\nThe default implementation does nothing. It may be\noverridden to extend subclasses.\n',
  ],
  ['__format__', 'Default object formatter.\n\nReturn str(self) if format_spec is empty. Raise TypeError otherwise.'],
  ['__sizeof__', 'Size of object in memory, in bytes.'],
  ['__dir__', 'Default dir() implementation.'],
];

/** The docstrings of `object.__class__` and of the `__dict__` and `__weakref__` of the classes without `__slots__`. */
export const INSTANCE_ATTRIBUTE_DOCS: Record<string, string> = {
  __class__: "the object's class",
  __dict__: 'dictionary for instance variables',
  __weakref__: 'list of weak references to the object',
};

/** Records the docstrings of `object`'s methods, once they are defined. */
export function recordObjectDocs(): void {
  for (const [name, doc] of OBJECT_METHOD_DOCS) {
    const method = objectClass.dict.get(name);
    if (typeof method === 'object') builtinDocs.set(method, doc);
  }
}
