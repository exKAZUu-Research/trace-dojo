import type { RealmBuilder } from './realm';
import { CollectionState } from './realmCollections';
import { dateValueOf, newDate } from './realmDate';
import { withStackLimit } from './realmJson';
import { newRegExp } from './realmRegExp';
import type { Runtime } from './runtime';
import { HOLE, isAccessor, isObject, JsArray, JsFunction, type JsObject, JsThrow, type Value } from './values';

export function defineStructuredClone(builder: RealmBuilder): void {
  builder.global(
    'structuredClone',
    builder.function('structuredClone', 1, ({ runtime, args }) =>
      withStackLimit(runtime, () => structuredClone(runtime, args[0], new Map()))
    )
  );
}

/** The structured clone of plain data: primitives, arrays, plain objects, Maps, Sets, and errors. */
// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 39 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function structuredClone(runtime: Runtime, value: Value, memory: Map<JsObject, JsObject>): Value {
  runtime.spend();
  if (typeof value === 'symbol') return cloneError(runtime, value.toString());
  if (!isObject(value)) return value;
  const cloned = memory.get(value);
  if (cloned) return cloned;
  if (
    value instanceof JsFunction ||
    value.turtle ||
    value.promise ||
    value.generator ||
    value.asyncGenerator ||
    value.hostIterator
  ) {
    return cloneError(
      runtime,
      value instanceof JsFunction && value.behavior.kind !== 'native' ? value.behavior.node.source : '#<Object>'
    );
  }
  if (value.collection?.isWeak) return cloneError(runtime, `#<${value.collection.kind}>`);
  if (value instanceof JsArray) return cloneArray(runtime, value, memory);
  if (value.primitive !== undefined) return cloneBoxed(runtime, value, value.primitive, memory);
  const { realm } = runtime;
  const time = dateValueOf(value);
  if (time !== undefined) {
    const date = newDate(runtime, time, realm.datePrototype);
    memory.set(value, date);
    return date;
  }
  if (value.regexp) {
    const regexp = newRegExp(runtime, value.regexp.source, value.regexp.flags);
    memory.set(value, regexp);
    return regexp;
  }
  const { collection } = value;
  let prototype = realm.objectPrototype;
  if (collection) prototype = collection.kind === 'Map' ? realm.mapPrototype : realm.setPrototype;
  else if (value.isError) prototype = clonedErrorPrototype(runtime, value);
  const copy = runtime.newObject(prototype);
  memory.set(value, copy);
  return runtime.hold(copy, () => {
    copyContents(runtime, value, copy, memory);
    return copy;
  });
}

function cloneBoxed(
  runtime: Runtime,
  value: JsObject,
  primitive: NonNullable<JsObject['primitive']>,
  memory: Map<JsObject, JsObject>
): JsObject {
  if (typeof primitive === 'symbol') return cloneError(runtime, '[object Symbol]');
  const copy = runtime.toObject(primitive);
  memory.set(value, copy);
  return copy;
}

/** Clones into `copy` what `value` holds: a collection's entries, an error's message and cause, or its properties. */
function copyContents(runtime: Runtime, value: JsObject, copy: JsObject, memory: Map<JsObject, JsObject>): void {
  const { collection } = value;
  if (collection) {
    const state = new CollectionState(collection.kind);
    copy.collection = state;
    for (const entry of collection.liveEntries(runtime)) {
      const key = structuredClone(runtime, entry.key, memory);
      state.set(
        runtime,
        key,
        runtime.hold(key, () => structuredClone(runtime, entry.value, memory))
      );
    }
  } else if (value.isError) {
    copy.isError = true;
    for (const key of ['message', 'cause']) {
      const property = value.properties.get(key);
      if (property && !isAccessor(property)) {
        copy.properties.set(key, { ...property, value: structuredClone(runtime, property.value, memory) });
      }
    }
  } else {
    copyOwnProperties(runtime, value, copy, memory);
  }
}

/** The prototype of an error's clone, which is that of the standard error its name names, or Error's. */
function clonedErrorPrototype(runtime: Runtime, error: JsObject): JsObject {
  const name = runtime.get(error, 'name');
  const { errorPrototypes } = runtime.realm;
  return typeof name === 'string' && (CLONED_ERROR_NAMES as readonly string[]).includes(name)
    ? errorPrototypes[name as (typeof CLONED_ERROR_NAMES)[number]]
    : errorPrototypes.Error;
}

const CLONED_ERROR_NAMES = ['Error', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError'] as const;

function cloneArray(runtime: Runtime, source: JsArray, memory: Map<JsObject, JsObject>): JsArray {
  const array = runtime.newArray([]);
  memory.set(source, array);
  return runtime.hold(array, () => {
    for (const element of source.elements) {
      runtime.allocate(1);
      array.elements.push(element === HOLE ? HOLE : structuredClone(runtime, element, memory));
    }
    copyOwnProperties(runtime, source, array, memory);
    return array;
  });
}

/** Copies the own enumerable string-keyed properties, which for an array are those besides its elements. */
function copyOwnProperties(
  runtime: Runtime,
  source: JsObject,
  target: JsObject,
  memory: Map<JsObject, JsObject>
): void {
  const keys =
    source instanceof JsArray
      ? [...source.properties.keys()].filter((key) => typeof key === 'string')
      : runtime.ownKeys(source);
  for (const key of keys) {
    if (!runtime.getOwnProperty(source, key)?.enumerable) continue;
    runtime.createDataProperty(target, key, structuredClone(runtime, runtime.get(source, key), memory));
  }
}

function cloneError(runtime: Runtime, description: string): never {
  const error = runtime.newError('Error', `${description} could not be cloned.`);
  error.properties.set('name', { value: 'DataCloneError', writable: true, enumerable: false, configurable: true });
  throw new JsThrow(error);
}
