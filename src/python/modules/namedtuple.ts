import { bindArguments, type Signature } from '../calls';
import { pyRepr, pyStr } from '../conversions';
import { pythonFunction, pythonMethod } from '../define';
import { libraryReceiver, unsupportedReceiver } from '../libraryReceivers';
import { argument } from '../nativeArgs';
import { callValue, getAttribute, isTruthy, toArray } from '../objects';
import { PYTHON_WHITESPACE } from '../strings';
import { containerRepr } from '../typeContainers';
import {
  builtinClass,
  newDict,
  newList,
  newTuple,
  None,
  propertyClass,
  tupleClass,
  typeClass,
  typeError,
  valueError,
} from '../types';
import { AttributeMap, type Kwargs, PyBuiltinFunction, PyClass, PyDescriptor, PyTuple, type PyValue } from '../values';
import { PYTHON_KEYWORDS } from './keywords';

/** `collections.namedtuple`. */
export const namedtupleFunction = pythonFunction(
  'namedtuple',
  'typename, field_names, *, rename=False, defaults=None, module=None',
  namedtupleWithMethods
);

function namedtuple(args: PyValue[], kwargs: Kwargs): PyValue {
  const typename = pyStr(argument(args, kwargs, 0, 'typename') as PyValue);
  const fields = namedTupleFields(
    argument(args, kwargs, 1, 'field_names') as PyValue,
    isTruthy(kwargs?.get('rename') ?? false)
  );
  checkNamedTupleNames(typename, fields, isTruthy(kwargs?.get('rename') ?? false));
  const defaultsValue = kwargs?.get('defaults') ?? None;
  const defaults = defaultsValue === None ? [] : toArray(defaultsValue);
  if (defaults.length > fields.length) throw typeError('Got more default values than field names');
  const cls = new PyClass(typename, [tupleClass], typeClass);
  cls.mro = [cls, ...tupleClass.mro];
  cls.isBuiltin = false;
  cls.layout = { base: 'native' };
  cls.construct = (tupleType, values, keywords) =>
    newNamedTuple(typename, tupleType, fields, defaults, values, keywords);
  const module = kwargs?.get('module');
  cls.module = typeof module === 'string' ? module : '__main__';
  cls.dict.set('__doc__', `${typename}(${fields.join(', ')}${fields.length === 1 ? ',' : ''})`);
  cls.dict.set('__slots__', newTuple([]));
  cls.dict.set('_fields', newTuple(fields));
  cls.dict.set(
    '_field_defaults',
    newDict(defaults.map((value, index) => [fields[fields.length - defaults.length + index], value]))
  );
  cls.dict.set('__match_args__', newTuple(fields));
  cls.dict.set('__module__', cls.module);
  for (const [index, name] of fields.entries()) {
    cls.dict.set(
      name,
      new PyDescriptor(
        propertyClass,
        new PyBuiltinFunction(builtinClass('getter'), name, ([self]) => (self as PyTuple).items[index])
      )
    );
  }
  return cls;
}

/** The field names of a namedtuple, with `rename` replacing each unusable or repeated name by `_<index>`. */
function namedTupleFields(fieldNames: PyValue, rename: boolean): string[] {
  const fields =
    typeof fieldNames === 'string'
      ? fieldNames
          .replaceAll(',', ' ')
          .split(new RegExp(`${PYTHON_WHITESPACE.source}+`, 'u'))
          .filter(Boolean)
      : toArray(fieldNames).map(pyStr);
  if (!rename) return fields;
  const seen = new Set<string>();
  return fields.map((name, index) => {
    const isUnusable = !isIdentifier(name) || PYTHON_KEYWORDS.has(name) || name.startsWith('_') || seen.has(name);
    seen.add(name);
    return isUnusable ? `_${index}` : name;
  });
}

/** Checks the names of a namedtuple as collections.namedtuple does, in its order. */
function checkNamedTupleNames(typename: string, fields: string[], rename: boolean): void {
  for (const name of [typename, ...fields]) {
    if (!isIdentifier(name)) throw valueError(`Type names and field names must be valid identifiers: ${pyRepr(name)}`);
    if (PYTHON_KEYWORDS.has(name)) throw valueError(`Type names and field names cannot be a keyword: ${pyRepr(name)}`);
  }
  const seen = new Set<string>();
  for (const name of fields) {
    if (name.startsWith('_') && !rename)
      throw valueError(`Field names cannot start with an underscore: ${pyRepr(name)}`);
    if (seen.has(name)) throw valueError(`Encountered duplicate field name: ${pyRepr(name)}`);
    seen.add(name);
  }
}

function isIdentifier(name: string): boolean {
  return /^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(name);
}

/** Binds the arguments as CPython's generated `__new__(_cls, field, ...)` does, with the shared binding's checks. */
function newNamedTuple(
  typename: string,
  cls: PyClass,
  fields: string[],
  defaults: PyValue[],
  values: PyValue[],
  kwargs: Kwargs
): PyTuple {
  const signature: Signature = {
    qualifiedName: `${typename}.__new__`,
    def: { params: ['_cls', ...fields].map((name) => ({ name, kind: 'positional' })) },
    defaults,
    keywordDefaults: new Map(),
  };
  const bound = bindArguments(signature, [cls, ...values], kwargs);
  return namedTupleInstance(
    cls,
    fields.map((field) => bound.get(field) as PyValue)
  );
}

const isNamedTuple = (value: PyValue): value is PyTuple =>
  value instanceof PyTuple && value.cls.lookup('_fields') !== undefined;

function fieldsOf(tuple: PyTuple): readonly PyValue[] {
  return (tuple.cls.lookup('_fields') as PyTuple | undefined)?.items ?? [];
}

/**
 * Defines the methods collections.namedtuple writes in the body of each class it generates, on that class itself, so
 * that their names and argument errors name the class as CPython's do.
 */
function defineNamedTupleMethods(cls: PyClass): void {
  pythonMethod(cls, '__repr__', '', (self) => {
    if (!(self instanceof PyTuple)) throw unsupportedReceiver(self, 'NamedTuple.__repr__');
    const tuple = self;
    const fields = fieldsOf(tuple);
    return containerRepr(
      tuple,
      '...',
      () =>
        `${tuple.cls.name}(${fields.map((field, index) => `${field as string}=${pyRepr(tuple.items[index])}`).join(', ')})`
    );
  });
  pythonMethod(cls, '_asdict', '', (self) => {
    const tuple = libraryReceiver(self, isNamedTuple, '_fields', 'NamedTuple._asdict');
    // CPython zips the fields with the tuple's iteration, which a subclass may override.
    const values = toArray(tuple);
    return newDict(
      fieldsOf(tuple)
        .slice(0, values.length)
        .map((field, index) => [field, values[index]])
    );
  });
  pythonMethod(cls, '_replace', '**kwds', (self, _args, kwargs) => replaceFields(self, kwargs));
  pythonMethod(cls, '_make', 'iterable', (owner, [iterable]) => makeNamedTuple(owner as PyClass, iterable), 'class');
  cls.dict.set('__replace__', cls.dict.get('_replace') as PyValue);
  pythonMethod(cls, '__getnewargs__', '', (self) => newTuple(toArray(self)));
}

/** Transcribes `self._make(map(kwds.pop, field_names, self))` of `_replace` and its check of the keywords left over. */
function replaceFields(self: PyValue, kwargs: Kwargs): PyValue {
  const tuple = libraryReceiver(self, isNamedTuple, '_make', 'NamedTuple._replace');
  const remaining = new Map(kwargs);
  const items = fieldsOf(tuple).map((field, index) => {
    const value = remaining.get(field as string) ?? tuple.items[index];
    remaining.delete(field as string);
    return value;
  });
  const result = callValue(getAttribute(tuple.cls, '_make'), [newList(items)]);
  if (remaining.size > 0) throw typeError(`Got unexpected field names: ${pyRepr(newList([...remaining.keys()]))}`);
  return result;
}

/** Transcribes `_make` of collections.namedtuple, which builds the tuple without calling the class. */
function makeNamedTuple(cls: PyClass, iterable: PyValue): PyTuple {
  const items = toArray(iterable);
  const count = (cls.lookup('_fields') as PyTuple).items.length;
  if (items.length !== count) throw typeError(`Expected ${count} arguments, got ${items.length}`);
  return namedTupleInstance(cls, items);
}

/**
 * An instance of a namedtuple class or its subclass, however it is made. A subclass that does not define `__slots__`,
 * as the class namedtuple creates does, gives its instances a `__dict__`.
 */
function namedTupleInstance(cls: PyClass, items: PyValue[]): PyTuple {
  const tuple = new PyTuple(cls, items);
  if (cls.mro.some((each) => !each.isBuiltin && !each.dict.has('__slots__'))) tuple.attributes = new AttributeMap();
  return tuple;
}

function namedtupleWithMethods(args: PyValue[], kwargs: Kwargs): PyValue {
  const cls = namedtuple(args, kwargs) as PyClass;
  defineNamedTupleMethods(cls);
  return cls;
}

/** A namedtuple class that a library module defines, such as `functools.CacheInfo`. */
export function makeNamedTupleClass(name: string, fields: string[], module: string): PyClass {
  return namedtupleWithMethods([name, newList(fields)], new Map([['module', module]])) as PyClass;
}
