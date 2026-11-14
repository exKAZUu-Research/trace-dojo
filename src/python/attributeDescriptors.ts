import { method } from './define';
import { builtinDataDescriptorClasses, builtinDescriptorClasses } from './descriptors';
import { builtinClass, classOf, None, pyError, typeError, typeName } from './types';
import { type PyClass, PyObject, type PyValue } from './values';

/** CPython's `getset_descriptor`: an attribute a builtin type computes, such as `int.real`. */
export const getsetDescriptorClass = builtinClass('getset_descriptor');
/** CPython's `member_descriptor`: a field of a builtin type's struct, such as `range.start`, or a `__slots__` entry. */
export const memberDescriptorClass = builtinClass('member_descriptor');

type Getter = (instance: PyValue) => PyValue;
/** Sets an attribute, or deletes it when `value` is undefined. */
type Setter = (instance: PyValue, value: PyValue | undefined) => void;

/** A data attribute of a builtin type, which reads and writes the field or value its owner keeps. */
export class PyAttribute extends PyObject {
  // code-gauge-allow functionParameterCount 7 -- The parts of a C type's PyGetSetDef or PyMemberDef entry.
  constructor(
    kind: 'getset' | 'member',
    readonly name: string,
    readonly owner: PyClass,
    readonly get: Getter,
    readonly set?: Setter,
    readonly doc?: string,
    /** Whether it stands for an attribute the objects keep natively, which lookup finds before it. */
    readonly stands = false
  ) {
    super(kind === 'member' ? memberDescriptorClass : getsetDescriptorClass);
  }

  /** The value a stand-in gives an object that keeps none, as the class attribute it replaced did. */
  fallback?: PyValue;

  get isMember(): boolean {
    return this.cls === memberDescriptorClass;
  }

  /** Assigns the attribute of an instance, or deletes it when `value` is undefined, as `__set__` does. */
  assign(instance: PyValue, value: PyValue | undefined): void {
    this.check(instance);
    if (this.set) {
      this.set(instance, value);
      return;
    }
    if (this.isMember) throw pyError('AttributeError', 'readonly attribute');
    throw pyError('AttributeError', `attribute '${this.name}' of '${this.owner.name}' objects is not writable`);
  }

  /** Raises CPython's TypeError for an instance of another type than the descriptor's. */
  check(instance: PyValue): void {
    if (classOf(instance).isSubclassOf(this.owner)) return;
    throw typeError(
      `descriptor '${this.name}' for '${this.owner.typeName ?? this.owner.name}' objects doesn't apply to a '${typeName(instance)}' object`
    );
  }
}

/** Defines a data attribute of a builtin type: computed (`getset`) or a struct field (`member`). */
export function defineAttribute(
  cls: PyClass,
  name: string,
  get: Getter,
  options: { kind?: 'getset' | 'member'; set?: Setter; doc?: string } = {}
): PyAttribute {
  const attribute = new PyAttribute(options.kind ?? 'getset', name, cls, get, options.set, options.doc);
  cls.dict.set(name, attribute);
  return attribute;
}

for (const cls of [getsetDescriptorClass, memberDescriptorClass]) {
  builtinDescriptorClasses.add(cls);
  builtinDataDescriptorClasses.add(cls);
  const self = (value: PyValue): PyAttribute => value as PyAttribute;
  method(cls, '__get__', 'expected', 1, 2, (descriptor, [instance, owner]) => {
    const attribute = self(descriptor);
    if (instance === None) {
      if (owner === undefined || owner === None) throw typeError('__get__(None, None) is invalid');
      return attribute;
    }
    attribute.check(instance);
    return attribute.get(instance);
  });
  method(cls, '__set__', 'expected', 2, 2, (descriptor, [instance, value]) => {
    self(descriptor).assign(instance, value);
    return None;
  });
  method(cls, '__delete__', 'one', 1, 1, (descriptor, [instance]) => {
    self(descriptor).assign(instance, undefined);
    return None;
  });
  method(cls, '__repr__', 'none', 0, 0, (descriptor) => {
    const { name, owner, isMember } = self(descriptor);
    return `<${isMember ? 'member' : 'attribute'} '${name}' of '${owner.typeName ?? owner.name}' objects>`;
  });
}

/** The attributes descriptors have outside their class's dictionary. */
export function attributeDescriptorField(attribute: PyAttribute, name: string): PyValue | undefined {
  if (name === '__name__') return attribute.name;
  if (name === '__qualname__') return `${attribute.owner.qualifiedName}.${attribute.name}`;
  if (name === '__objclass__') return attribute.owner;
  return undefined;
}
