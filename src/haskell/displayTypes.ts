import { CHAR_TYPE, DOUBLE_TYPE, FLOAT_TYPE, FUNCTION_TYPE, INT_TYPE, INTEGER_TYPE, WORD_TYPE } from './builtinTypes';
import type { Core } from './core';
import { type TypeHint, type TypeHintRef, UNKNOWN_TYPE } from './displayTypeHints';
import type { ConInfo } from './entities';
import type { Runtime } from './runtime';
import { mapGraph, mapGraphPairs } from './typeGraph';
import { instantiateType, matchType, prune, splitApp, type Type, typeChildren } from './types';
import { type Dict, Env, type Slot, Thunk, TypedSlot, untypedSlot } from './values';

export { UNKNOWN_TYPE } from './displayTypeHints';

const concreteTypes = new WeakSet<Type>();
const dictionaryTypes = new WeakMap<Dict, TypeHint>();

export function applicationDisplayHint(code: Core, env: Env | undefined, runtime: Runtime): TypeHint | undefined {
  if (!runtime.steps.recorder) return code.displayType;
  if (code.k === 'frame' && code.size === 0) return { tag: 'frameType', code, env, runtime };
  let fn = code;
  let argumentsCount = 0;
  while (fn.k === 'app') {
    argumentsCount += fn.args.length;
    fn = fn.fn;
  }
  const parent: TypeHint | undefined =
    fn.k === 'method'
      ? { tag: 'deferredMethodType', dict: runtime.machine.makeSlot(fn.dict, env), index: fn.index, runtime }
      : fn.k === 'local'
        ? slotTypeHint(env!.at(fn.depth).slots[fn.index] as Slot, fn.displayType)
        : fn.k === 'global'
          ? slotTypeHint(runtime.global(fn.global), fn.displayType)
          : fn.displayType;
  if (!parent || argumentsCount === 0) return code.displayType;
  const actual: TypeHint = { tag: 'applicationType', parent, arguments: argumentsCount };
  return code.displayType ? { tag: 'refinement', template: code.displayType, actual } : actual;
}

export function methodTypeHint(dict: Dict, index: number, runtime: Runtime): TypeHint {
  const scheme = dict.instance.cls.methods[index].scheme!;
  return {
    tag: 'methodType',
    parent: dictionaryTypeHint(dict, runtime),
    template: scheme.type,
    parameters: scheme.kinds.length,
  };
}

function dictionaryTypeHint(dict: Dict, runtime: Runtime): TypeHint {
  let hint = dictionaryTypes.get(dict);
  if (!hint) {
    hint = { tag: 'dictionaryType', dict, runtime };
    dictionaryTypes.set(dict, hint);
  }
  return hint;
}

export function typedSlot(slot: Slot, type: TypeHint | undefined): Slot {
  return type ? new TypedSlot(untypedSlot(slot), slotTypeHint(slot, type)) : slot;
}

export function slotDisplayType(slot: Slot, fallback: Type = UNKNOWN_TYPE): Type {
  if (isConcreteType(fallback)) return fallback;
  return resolveHint(slotTypeHint(slot, fallback));
}

export function slotTypeHint(slot: Slot, fallback: TypeHint = UNKNOWN_TYPE): TypeHint {
  const actual = slot instanceof TypedSlot ? slot.type : slot instanceof Thunk ? thunkTypeHint(slot) : undefined;
  if (!actual || actual === fallback) return fallback;
  return { tag: 'refinement', template: fallback, actual };
}

export function thunkTypeHint(thunk: Thunk): TypeHintRef {
  return (thunk.displayType ??= { tag: 'hint', value: UNKNOWN_TYPE });
}

export function constructorFieldHint(con: ConInfo, parent: TypeHint, position: number): TypeHint {
  return { tag: 'fieldType', con, parent, position };
}

function resolveHint(hint: TypeHint): Type {
  return mapGraph<TypeHint, Type>(
    hint,
    (node) => node,
    hintChildren,
    (node, mapped) => {
      switch (node.tag) {
        case 'hint': {
          return mapped[0];
        }
        case 'refinement': {
          return mapped.length === 1 ? mapped[0] : refineType(mapped[0], mapped[1]);
        }
        case 'frameType':
        case 'deferredMethodType': {
          return mapped[0];
        }
        case 'dictionaryType': {
          return dictionaryDisplayType(node.dict, mapped);
        }
        case 'methodType': {
          return instantiateType(
            node.template,
            Array.from({ length: node.parameters }, (_, index) => (index === 0 ? mapped[0] : UNKNOWN_TYPE))
          );
        }
        case 'applicationType': {
          return applicationResultType(mapped[0], node.arguments);
        }
        case 'fieldType': {
          return constructorFieldType(node.con, mapped[0], node.position);
        }
        default: {
          return prune(node);
        }
      }
    }
  );
}

function dictionaryDisplayType(dict: Dict, argumentsTypes: Type[]): Type {
  const { instance } = dict;
  const bindings: (Type | undefined)[] = Array.from({ length: instance.kinds.length });
  for (const [index, type] of argumentsTypes.entries()) matchType(instance.context[index].type, type, bindings);
  return instantiateType(
    instance.head,
    bindings.map((type) => type ?? UNKNOWN_TYPE)
  );
}

function applicationResultType(type: Type, argumentsCount: number): Type {
  for (let index = 0; index < argumentsCount; index++) {
    const { head, args } = splitApp(type);
    if (head.tag !== 'tcon' || head.entity !== FUNCTION_TYPE) return UNKNOWN_TYPE;
    type = args[1];
  }
  return type;
}

function hintChildren(hint: TypeHint): TypeHint[] {
  if (hint.tag === 'frameType') {
    return [
      (hint.resolved ??= applicationDisplayHint(hint.code.body, new Env(0, hint.env), hint.runtime) ?? UNKNOWN_TYPE),
    ];
  }
  if (hint.tag === 'hint') return [hint.value];
  if (hint.tag === 'fieldType' || hint.tag === 'methodType' || hint.tag === 'applicationType') return [hint.parent];
  if (hint.tag === 'deferredMethodType')
    return [
      (hint.resolved ??= methodTypeHint(hint.runtime.machine.force(hint.dict) as Dict, hint.index, hint.runtime)),
    ];
  if (hint.tag === 'dictionaryType') {
    return (hint.arguments ??= hint.dict.args.map((slot) =>
      dictionaryTypeHint(hint.runtime.machine.force(slot) as Dict, hint.runtime)
    ));
  }
  if (hint.tag !== 'refinement') return [];
  const template = hint.template;
  const known = template.tag === 'tgen' || template.tag === 'tvar' || template.tag === 'tcon' || template.tag === 'tap';
  return known && isConcreteType(template) ? [template] : [template, hint.actual];
}

function isConcreteType(type: Type): boolean {
  return mapGraph<Type, boolean>(
    type,
    prune,
    (node) => (concreteTypes.has(node) ? [] : typeChildren(node)),
    (node, children) => {
      const concrete =
        concreteTypes.has(node) || node.tag === 'tcon' || (node.tag === 'tap' && children.every(Boolean));
      if (concrete) concreteTypes.add(node);
      return concrete;
    }
  );
}

function refineType(template: Type, actual: Type): Type {
  return mapGraphPairs(
    template,
    actual,
    prune,
    (left, right) =>
      left !== right && left.tag === 'tap' && right.tag === 'tap'
        ? [
            [left.fn, right.fn],
            [left.arg, right.arg],
          ]
        : [],
    (left, right, mapped) => {
      if (left.tag === 'tgen' || left.tag === 'tvar') return right;
      if (mapped.length === 0) return left;
      const [fn, arg] = mapped;
      if (left.tag === 'tap' && fn === left.fn && arg === left.arg) return left;
      if (right.tag === 'tap' && fn === right.fn && arg === right.arg) return right;
      return { tag: 'tap', fn, arg };
    }
  );
}

export function constructorFieldType(con: ConInfo, type: Type, position: number): Type {
  const { args } = splitApp(prune(type));
  const parameters = Array.from({ length: con.type.arity }, (_, index) => args[index] ?? UNKNOWN_TYPE);
  return instantiateType(con.fieldTypes[position], parameters);
}

export function isScalarType(type: Type): boolean {
  const { head, args } = splitApp(type);
  if (head.tag !== 'tcon') return false;
  const entity = head.entity;
  if ([INT_TYPE, INTEGER_TYPE, WORD_TYPE, DOUBLE_TYPE, FLOAT_TYPE, CHAR_TYPE].includes(entity)) return true;
  if (entity.name === 'Bool' && entity.module === 'Base') return true;
  if (entity.special === 'list' && args.length === 1) {
    const elem = splitApp(args[0]).head;
    return elem.tag === 'tcon' && elem.entity === CHAR_TYPE;
  }
  return false;
}
