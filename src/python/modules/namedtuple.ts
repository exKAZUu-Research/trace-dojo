import { bindArguments, type Signature } from '../calls';
import { pyRepr, pyStr } from '../conversions';
import { method, pythonFunction, pythonMethod } from '../define';
import { definePythonLevelNew } from '../instances';
import { libraryReceiver, unsupportedReceiver } from '../libraryReceivers';
import { argument } from '../nativeArgs';
import { callValue, exactLength, getAttribute, isTruthy, iterate, toArray } from '../objects';
import { runningRuntime } from '../runtimeContext';
import { PYTHON_WHITESPACE } from '../strings';
import { containerRepr } from '../typeContainers';
import {
  builtinClass,
  newDict,
  newList,
  newTuple,
  None,
  pyError,
  tupleClass,
  tupleGetterClass,
  typeClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { isIdentifierText } from '../unicodeClasses';
import { DONE, type Kwargs, PyBuiltinFunction, PyClass, PyDescriptor, PyTuple, type PyValue } from '../values';
import { PYTHON_KEYWORDS } from './keywords';

const NAMED_TUPLE_ORDER = [
  '__doc__',
  '__slots__',
  '_fields',
  '_field_defaults',
  '__new__',
  '_make',
  '__replace__',
  '_replace',
  '__repr__',
  '_asdict',
  '__getnewargs__',
  '__match_args__',
];

/** The index of the field each `_tuplegetter` reads. */
const tupleGetterIndexes = new WeakMap<PyDescriptor, number>();

/** The namedtuple class that a `typing.NamedTuple` class statement creates. */
export function namedTupleClass(name: string, fields: string[], defaults: PyValue[]): PyClass {
  return namedtupleWithMethods([name, newList(fields)], new Map([['defaults', newTuple(defaults)]])) as PyClass;
}

/** A namedtuple class that a library module defines, such as `functools.CacheInfo`. */
export function makeNamedTupleClass(name: string, fields: string[], module: string): PyClass {
  return namedtupleWithMethods([name, newList(fields)], new Map([['module', module]])) as PyClass;
}

function namedtupleWithMethods(args: PyValue[], kwargs: Kwargs): PyValue {
  const cls = namedtuple(args, kwargs);
  defineNamedTupleMethods(cls);
  // The order of the namespace collections.namedtuple's code gives its class.
  const fields = (cls.dict.get('_fields') as PyTuple).items as string[];
  const entries = new Map(cls.dict);
  cls.dict.clear();
  for (const name of [...NAMED_TUPLE_ORDER, ...fields, '__module__', ...entries.keys()]) {
    const value = entries.get(name);
    if (value === undefined || cls.dict.has(name)) continue;
    cls.dict.set(name, value);
  }
  return cls;
}

/** `collections.namedtuple`. */
export const namedtupleFunction = pythonFunction(
  'namedtuple',
  'typename, field_names, *, rename=False, defaults=None, module=None',
  namedtupleWithMethods
);

function namedtuple(args: PyValue[], kwargs: Kwargs): PyClass {
  const typename = pyStr(argument(args, kwargs, 0, 'typename') as PyValue);
  const rename = isTruthy(kwargs?.get('rename') ?? false);
  const fields = namedTupleFields(argument(args, kwargs, 1, 'field_names') as PyValue, rename);
  checkNamedTupleNames(typename, fields, rename);
  const defaultsValue = kwargs?.get('defaults') ?? None;
  const defaults = defaultsValue === None ? [] : toArray(defaultsValue);
  if (defaults.length > fields.length) throw typeError('Got more default values than field names');
  const cls = new PyClass(typename, [tupleClass], typeClass);
  cls.mro = [cls, ...tupleClass.mro];
  cls.isBuiltin = false;
  cls.layout = { base: 'native' };
  cls.slotNames = new Set();
  cls.construct = (tupleType, values, keywords) =>
    newNamedTuple(typename, tupleType, fields, defaults, values, keywords);
  definePythonLevelNew(cls, cls.construct);
  const moduleArg = kwargs?.get('module');
  const resolvedModule =
    moduleArg === undefined || moduleArg === None ? runningRuntime()?.frame?.globals.get('__name__') : moduleArg;
  cls.module = typeof resolvedModule === 'string' ? resolvedModule : '__main__';
  cls.dict.set('__doc__', `${typename}(${fields.join(', ')}${fields.length === 1 ? ',' : ''})`);
  cls.dict.set('__slots__', newTuple([]));
  cls.dict.set('_fields', newTuple(fields));
  cls.dict.set(
    '_field_defaults',
    newDict(defaults.map((value, index) => [fields[fields.length - defaults.length + index], value]))
  );
  cls.dict.set('__match_args__', newTuple(fields));
  cls.dict.set('__module__', resolvedModule ?? '__main__');
  defineFieldGetters(cls, fields);
  return cls;
}

/** Gives a namedtuple's class a `_tuplegetter` for each field. */
function defineFieldGetters(cls: PyClass, fields: string[]): void {
  for (const [index, name] of fields.entries()) {
    const getter = new PyDescriptor(
      tupleGetterClass,
      new PyBuiltinFunction(builtinClass('getter'), name, ([self]) => fieldAt(self as PyTuple, index)),
      undefined,
      undefined,
      `Alias for field number ${index}`
    );
    tupleGetterIndexes.set(getter, index);
    cls.dict.set(name, getter);
  }
}

function fieldAt(tuple: PyTuple, index: number): PyValue {
  if (index >= tuple.items.length) throw pyError('IndexError', 'tuple index out of range');
  return tuple.items[index];
}

method(tupleGetterClass, '__repr__', 'none', 0, 0, (self) => {
  const getter = self as PyDescriptor;
  return `_tuplegetter(${tupleGetterIndexes.get(getter) ?? 0}, ${pyRepr(getter.doc ?? None)})`;
});
method(tupleGetterClass, '__get__', 'expected', 1, 2, (self, [instance]) => {
  const getter = self as PyDescriptor;
  if (instance === None) return getter;
  const index = tupleGetterIndexes.get(getter) ?? 0;
  if (!(instance instanceof PyTuple)) {
    throw typeError(
      `descriptor for index '${index}' for tuple subclasses doesn't apply to '${typeName(instance)}' object`
    );
  }
  return fieldAt(instance, index);
});
method(tupleGetterClass, '__set__', 'expected', 2, 2, () => {
  throw pyError('AttributeError', "can't set attribute");
});
method(tupleGetterClass, '__delete__', 'one', 1, 1, () => {
  throw pyError('AttributeError', "can't delete attribute");
});

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
    const isUnusable = !isIdentifierText(name) || PYTHON_KEYWORDS.has(name) || name.startsWith('_') || seen.has(name);
    seen.add(name);
    return isUnusable ? `_${index}` : name;
  });
}

/** Checks the names of a namedtuple as collections.namedtuple does, in its order. */
function checkNamedTupleNames(typename: string, fields: string[], rename: boolean): void {
  for (const name of [typename, ...fields]) {
    if (!isIdentifierText(name))
      throw valueError(`Type names and field names must be valid identifiers: ${pyRepr(name)}`);
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
  return new PyTuple(
    cls,
    fields.map((field) => bound.get(field) as PyValue)
  );
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
    const fields = fieldsOf(tuple);
    return newDict(leadingItems(tuple, fields.length).map((value, index) => [fields[index], value]));
  });
  pythonMethod(cls, '_replace', '**kwds', (self, _args, kwargs) => replaceFields(self, kwargs));
  pythonMethod(cls, '_make', 'iterable', (owner, [iterable]) => makeNamedTuple(owner as PyClass, iterable), 'class');
  cls.dict.set('__replace__', cls.dict.get('_replace') as PyValue);
  pythonMethod(cls, '__getnewargs__', '', (self) => newTuple(toArray(self)));
}

const isNamedTuple = (value: PyValue): value is PyTuple =>
  value instanceof PyTuple && value.cls.lookup('_fields') !== undefined;

function fieldsOf(tuple: PyTuple): readonly PyValue[] {
  return (tuple.cls.lookup('_fields') as PyTuple | undefined)?.items ?? [];
}

/** Transcribes `self._make(map(kwds.pop, field_names, self))` of `_replace` and its check of the keywords left over. */
function replaceFields(self: PyValue, kwargs: Kwargs): PyValue {
  const tuple = libraryReceiver(self, isNamedTuple, '_make', 'NamedTuple._replace');
  const remaining = new Map(kwargs);
  // map() stops at the shorter of the fields and the tuple's iteration, which a subclass may override.
  const fields = fieldsOf(tuple);
  const items = leadingItems(tuple, fields.length).map((current, index) => {
    const value = remaining.get(fields[index] as string) ?? current;
    remaining.delete(fields[index] as string);
    return value;
  });
  const result = callValue(getAttribute(tuple, '_make'), [newList(items)]);
  if (remaining.size > 0) throw typeError(`Got unexpected field names: ${pyRepr(newList([...remaining.keys()]))}`);
  return result;
}

/** At most `count` items of a tuple's iteration, read no further, as zip() and map() read them beside the fields. */
function leadingItems(tuple: PyTuple, count: number): PyValue[] {
  const next = iterate(tuple);
  const items: PyValue[] = [];
  while (items.length < count) {
    const item = next();
    if (item === DONE) break;
    items.push(item);
  }
  return items;
}

/** Transcribes `_make` of collections.namedtuple, which builds the tuple without calling the class. */
function makeNamedTuple(cls: PyClass, iterable: PyValue): PyTuple {
  const result = new PyTuple(cls, toArray(iterable));
  const count = BigInt((cls.lookup('_fields') as PyTuple).items.length);
  // `len()` of the result, which a subclass's __len__ answers.
  const length = exactLength(result);
  if (length !== count) throw typeError(`Expected ${count} arguments, got ${exactLength(result)}`);
  return result;
}
