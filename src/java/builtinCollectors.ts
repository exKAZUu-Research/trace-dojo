import { findEntry, javaEquals, javaHash, putEntry } from './builtinCollections';
import { defineDownstreamCollectors } from './builtinDownstreamCollectors';
import { callFunction } from './builtinFunctions';
import { createStore } from './builtinMaps';
import { stringify } from './builtins';
import { classType, type Context, extendsOf, superOf, typeVariable, variableType } from './builtinStreamSupport';
import { addMethod, defineInterface, newString } from './builtinSupport';
import { box } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  type ClassInfo,
  type ClassType,
  createClass,
  type JavaType,
  type NativeMethod,
  type WildcardType,
} from './types';
import { HashStore, type JavaObject, type JavaString, type Value } from './values';

function textOf(value: Value): string {
  return (value as JavaString | undefined)?.value ?? '';
}

/** What a collector does: create a container, add each element to it, and turn it into the result. */
export interface CollectorFunctions {
  supply: (frame: Frame) => unknown;
  accumulate: (frame: Frame, container: unknown, value: Value) => void;
  finish: (frame: Frame, container: unknown) => Value;
}

export const collectors = new WeakMap<JavaObject, CollectorFunctions>();

// code-gauge-allow functionNcss 35 -- One registration per builtin method, each a small native.
export function defineCollectors(context: Context): ClassInfo {
  const { registry, objectType, collections } = context;
  const collector = defineInterface(registry, 'Collector', 'java.util.stream');
  const [ct, ca, cr] = ['T', 'A', 'R'].map((name) => typeVariable(name, objectType));
  collector.typeParameters = [ct, ca, cr];
  const impl = createClass('CollectorImpl', context.objectClass, true);
  impl.interfaces = [collector];
  impl.supertypes.push(collector.type as ClassType);
  const collectorsClass = registry.define('Collectors', context.objectClass, 'java.util.stream');
  const create = (frame: Frame, functions: CollectorFunctions): JavaObject => {
    const object = frame.runtime.allocateObject(frame, impl);
    collectors.set(object, functions);
    return object;
  };
  const listOf = (element: JavaType): ClassType => classType(collections.listClass, element);
  const generic = (
    name: string,
    parameters: (t: JavaType) => JavaType[],
    result: (t: JavaType) => JavaType,
    native: NativeMethod
  ): void => {
    const t = typeVariable('T', objectType);
    const method = addMethod(collectorsClass, name, parameters(variableType(t)), result(variableType(t)), true, native);
    method.typeParameters = [t];
  };
  const wildcard: WildcardType = { kind: 'wildcard', bound: undefined, isSuper: false };
  generic(
    'toList',
    () => [],
    (t) => classType(collector, t, wildcard, listOf(t)),
    (frame) =>
      create(frame, {
        supply: () => [] as Value[],
        accumulate: (_, container, value) => void (container as Value[]).push(value),
        finish: (finishFrame, container) => newList(finishFrame, container as Value[]),
      })
  );
  generic(
    'toSet',
    () => [],
    (t) => classType(collector, t, wildcard, classType(registry.classes.get('Set') as ClassInfo, t)),
    (frame) =>
      create(frame, {
        supply: () => [] as Value[],
        accumulate: (_, container, value) => void (container as Value[]).push(value),
        finish: (finishFrame, container) => newHashSet(finishFrame, container as Value[]),
      })
  );
  const charSequence = context.stringType;
  for (const parameters of [[], [charSequence], [charSequence, charSequence, charSequence]]) {
    addMethod(
      collectorsClass,
      'joining',
      parameters,
      classType(collector, charSequence, wildcard, context.stringType),
      true,
      (frame, _, [separator, prefix, suffix]) =>
        create(frame, {
          supply: () => [] as string[],
          accumulate: (accumulateFrame, container, value) =>
            void (container as string[]).push(stringify(accumulateFrame, value, context.objectType)),
          finish: (finishFrame, container) => {
            const joined = (container as string[]).join(textOf(separator));
            return newString(finishFrame, `${textOf(prefix)}${joined}${textOf(suffix)}`);
          },
        })
    );
  }
  generic(
    'counting',
    () => [],
    (t) => classType(collector, t, wildcard, context.wrappers.byKind.get('long')?.type as JavaType),
    (frame) =>
      create(frame, {
        supply: () => ({ count: 0n }),
        accumulate: (_, container) => {
          (container as { count: bigint }).count++;
        },
        finish: (finishFrame, container) =>
          box(finishFrame, context.wrappers.byKind.get('long') as ClassInfo, (container as { count: bigint }).count),
      })
  );
  defineDownstreamCollectors(context, collectorsClass, collector, create);
  defineToMap(context, collectorsClass, collector, create);
  return collector;
}

/** `Collectors.toMap`, which collects into a `HashMap` and merges the values of a duplicate key, if it may. */
function defineToMap(
  context: Context,
  collectorsClass: ClassInfo,
  collector: ClassInfo,
  create: (frame: Frame, functions: CollectorFunctions) => JavaObject
): void {
  const { objectType, collections } = context;
  const fn = context.fn('Function');
  const binary = context.fn('BinaryOperator');
  for (const isMerging of [false, true]) {
    const [t, k, u] = ['T', 'K', 'U'].map((name) => typeVariable(name, objectType));
    const [tType, kType, uType] = [t, k, u].map((variable) => variableType(variable));
    const parameters = [
      classType(fn, superOf(tType), extendsOf(kType)),
      classType(fn, superOf(tType), extendsOf(uType)),
      ...(isMerging ? [classType(binary, uType)] : []),
    ];
    const resultType = classType(
      collector,
      tType,
      { kind: 'wildcard', bound: undefined, isSuper: false },
      classType(collections.mapClass, kType, uType)
    );
    const method = addMethod(
      collectorsClass,
      'toMap',
      parameters,
      resultType,
      true,
      (frame, _, [keyMapper, valueMapper, merger]) =>
        create(frame, {
          supply: (supplyFrame) => {
            const map = supplyFrame.runtime.allocateObject(
              supplyFrame,
              supplyFrame.runtime.builtins.classes.get('HashMap') as ClassInfo
            );
            createStore(map);
            return map;
          },
          accumulate: (accumulateFrame, container, value) => {
            const key = callFunction(accumulateFrame, fn, keyMapper, [value]);
            const mapped = callFunction(accumulateFrame, fn, valueMapper, [value]);
            if (mapped === undefined) throwBuiltin(accumulateFrame, 'NullPointerException');
            const existing = findEntry(accumulateFrame, container as Value, key);
            if (!existing) {
              // A merging toMap adds a key as HashMap.merge does, at the start of its bucket.
              putEntry(accumulateFrame, container as Value, key, false, mapped, isMerging);
              return;
            }
            if (!isMerging) {
              const describe = (item: Value): string => stringify(accumulateFrame, item, objectType);
              throwBuiltin(
                accumulateFrame,
                'IllegalStateException',
                `Duplicate key ${describe(key)} (attempted merging values ${describe(existing.value)} and ${describe(mapped)})`
              );
            }
            existing.value = callFunction(accumulateFrame, binary, merger, [existing.value, mapped]);
          },
          finish: (_, container) => container as Value,
        })
    );
    method.typeParameters = [t, k, u];
  }
}

export function newList(frame: Frame, items: Value[]): JavaObject {
  frame.runtime.allocateArray(frame, items.length);
  const list = frame.runtime.allocateObject(frame, frame.runtime.builtins.classes.get('ArrayList') as ClassInfo);
  list.elements = items;
  list.modCount = 0;
  return list;
}

/** A `HashSet` of the values, keeping the first of equal ones, as `toSet` gives. */
function newHashSet(frame: Frame, values: Value[]): JavaObject {
  const set = frame.runtime.allocateObject(frame, frame.runtime.builtins.classes.get('HashSet') as ClassInfo);
  set.store = new HashStore();
  set.modCount = 0;
  for (const value of values) {
    const hash = javaHash(frame, value);
    const isNew = !set.store.entries.some((entry) => entry.hash === hash && javaEquals(frame, value, entry.key));
    if (isNew) set.store.add({ key: value, value: undefined, hash });
  }
  return set;
}
