import { CHAR_TYPE, DOUBLE_TYPE, FLOAT_TYPE, FUNCTION_TYPE, INT_TYPE, INTEGER_TYPE, WORD_TYPE } from './builtinTypes';
import { type DisplayTypeScope, type TypeHint, type TypeHintRef, UNKNOWN_TYPE } from './displayTypeHints';
import type { ConInfo } from './entities';
import type { Runtime } from './runtime';
import { mapGraph, mapGraphPairs, walkGraph, walkGraphPairs } from './typeGraph';
import { instantiateType, prune, splitApp, tap, tcon, type Type, typeChildren } from './types';
import { chargeTypeWork } from './typeWorkBudget';
import { type Dict, type Env, type Slot, Thunk, TypedSlot, untypedSlot } from './values';

export { UNKNOWN_TYPE } from './displayTypeHints';

const concreteTypes = new WeakSet<Type>();
const dictionaryTypes = new WeakMap<Dict, TypeHint>();

const scopedTypes = new WeakMap<DisplayTypeScope, WeakMap<Type, TypeHint>>();

export function contextualDisplayHint(type: Type | undefined, env: Env | undefined): TypeHint | undefined {
  return type ? scopedTypeHint(type, env?.displayScope) : undefined;
}

function scopedTypeHint(type: Type, scope: DisplayTypeScope | undefined): TypeHint {
  const template = prune(type);
  if (!scope || template.tag === 'tcon' || concreteTypes.has(template)) return template;
  let cache = scopedTypes.get(scope);
  if (!cache) {
    cache = new WeakMap();
    scopedTypes.set(scope, cache);
  }
  let hint = cache.get(template);
  if (!hint) {
    hint = { tag: 'scopedType', template, scope };
    cache.set(template, hint);
  }
  return hint;
}

export function bindDisplayTypes(
  env: Env,
  patterns: readonly Type[],
  parameters: readonly Type[],
  args: readonly Slot[],
  runtime: Runtime
): void {
  if (!runtime.steps.recorder) return;
  if (patterns.length + parameters.length === 0) return;
  env.displayScope = {
    parent: env.displayScope,
    constraints: [
      ...patterns.map((pattern, index) => ({
        pattern,
        actual: { tag: 'dictionaryArgumentType' as const, slot: args[index], runtime },
      })),
      ...parameters.map((pattern, index) => ({ pattern, actual: slotTypeHint(args[patterns.length + index]) })),
    ],
  };
}

export function methodTypeHint(dict: Dict, index: number, runtime: Runtime): TypeHint {
  const scheme = dict.instance.cls.methods[index].scheme!;
  return {
    tag: 'methodType',
    parent: dictionaryTypeHint(dict, runtime),
    template: scheme.type,
    parameters: scheme.kinds.length,
    dictionaries: scheme.preds.length - 1,
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
  return refineHint(fallback, actual);
}

export function thunkTypeHint(thunk: Thunk): TypeHintRef {
  return (thunk.displayType ??= { tag: 'hint', value: UNKNOWN_TYPE });
}

export function constructorFieldHint(con: ConInfo, parent: TypeHint, position: number): TypeHint {
  return { tag: 'fieldType', con, parent, position };
}

function resolveHint(hint: TypeHint): Type {
  const resolved = new Map<TypeHint, Type>();
  return mapGraph<TypeHint, Type>(
    hint,
    (node) => node,
    (node) => hintChildren(node, resolved),
    (node, mapped) => {
      const type = rebuildHint(node, mapped);
      resolved.set(node, type);
      return type;
    }
  );
}

function rebuildHint(node: TypeHint, mapped: Type[]): Type {
  switch (node.tag) {
    case 'hint': {
      return mapped[0];
    }
    case 'refinement': {
      return mapped.length === 1 ? mapped[0] : refineType(mapped[0], mapped[1]);
    }
    case 'dictionaryArgumentType': {
      return mapped[0];
    }
    case 'scopedType': {
      if (node.concrete) return node.concrete;
      const type = mappedScopedType(node.template, mapped);
      if (isConcreteType(type)) node.concrete = type;
      return type;
    }
    case 'matchedType': {
      return matchedParameterType(node.pattern, mapped[0], node.variable);
    }
    case 'dictionaryType': {
      return dictionaryDisplayType(node.dict, mapped);
    }
    case 'methodType': {
      return instantiatedMethodType(node, mapped[0]);
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

function mappedScopedType(template: Type, mapped: Type[]): Type {
  const type = prune(template);
  return type.tag === 'tap' ? { tag: 'tap', fn: mapped[0], arg: mapped[1] } : (mapped[0] ?? type);
}

function matchedParameterType(pattern: Type, actual: Type, variable: Type): Type {
  let result: Type | undefined;
  for (const [left, right] of walkGraphPairs(pattern, actual, prune, typeChildren)) {
    if (left === variable) result = result ? refineType(result, right) : right;
  }
  return result ?? UNKNOWN_TYPE;
}

function instantiatedMethodType(node: Extract<TypeHint, { tag: 'methodType' }>, instance: Type): Type {
  let type = instantiateType(
    node.template,
    Array.from({ length: node.parameters }, (_, index) => (index === 0 ? instance : UNKNOWN_TYPE))
  );
  for (let index = 0; index < node.dictionaries; index++) type = tap(tcon(FUNCTION_TYPE), UNKNOWN_TYPE, type);
  return type;
}

function dictionaryDisplayType(dict: Dict, argumentsTypes: Type[]): Type {
  const { instance } = dict;
  const bindings: (Type | undefined)[] = Array.from({ length: instance.kinds.length });
  for (const [index, type] of argumentsTypes.entries()) {
    for (const [pattern, actual] of walkGraphPairs(instance.context[index].type, type, prune, typeChildren)) {
      if (pattern.tag !== 'tgen') continue;
      const previous = bindings[pattern.index];
      bindings[pattern.index] = previous ? refineType(previous, actual) : actual;
    }
  }
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

function hintChildren(hint: TypeHint, resolved: ReadonlyMap<TypeHint, Type>): TypeHint[] {
  if (hint.tag === 'scopedType')
    return hint.concrete ? [hint.concrete] : (hint.children ??= scopedTypeChildren(hint.template, hint.scope));
  if (hint.tag === 'matchedType') return [hint.parent];
  if (hint.tag === 'dictionaryArgumentType')
    return [(hint.resolved ??= dictionaryTypeHint(hint.runtime.machine.force(hint.slot) as Dict, hint.runtime))];
  if (hint.tag === 'hint') return [hint.value];
  if (hint.tag === 'fieldType' || hint.tag === 'methodType' || hint.tag === 'applicationType') return [hint.parent];
  if (hint.tag === 'dictionaryType') {
    return (hint.arguments ??= hint.dict.args.map((slot) =>
      dictionaryTypeHint(hint.runtime.machine.force(slot) as Dict, hint.runtime)
    ));
  }
  if (hint.tag !== 'refinement') return [];
  const template = hint.template;
  const alreadyResolved = resolved.get(template);
  if (alreadyResolved && isConcreteType(alreadyResolved)) return [template];
  const known = template.tag === 'tgen' || template.tag === 'tvar' || template.tag === 'tcon' || template.tag === 'tap';
  return known && isConcreteType(template) ? [template] : [template, hint.actual];
}

function scopedTypeChildren(template: Type, scope: DisplayTypeScope): TypeHint[] {
  const type = prune(template);
  if (type.tag === 'tap') return [scopedTypeHint(type.fn, scope), scopedTypeHint(type.arg, scope)];
  if (type.tag !== 'tvar' && type.tag !== 'tgen') return [];
  let result: TypeHint | undefined;
  for (let current: DisplayTypeScope | undefined = scope; current; current = current.parent) {
    chargeTypeWork();
    const actual = displayTypeBindings(current).get(type);
    if (actual) result = refineHint(result, actual);
  }
  return result ? [result] : [];
}

function displayTypeBindings(scope: DisplayTypeScope): ReadonlyMap<Type, TypeHint> {
  if (scope.bindings) return scope.bindings;
  const bindings = new Map<Type, TypeHint>();
  for (const { pattern, actual } of scope.constraints) {
    for (const variable of walkGraph(pattern, prune, typeChildren)) {
      if (variable.tag === 'tvar' || variable.tag === 'tgen')
        bindings.set(
          variable,
          refineHint(bindings.get(variable), { tag: 'matchedType', pattern, variable, parent: actual })
        );
    }
  }
  scope.bindings = bindings;
  return bindings;
}

function refineHint(template: TypeHint | undefined, actual: TypeHint): TypeHint {
  return template ? { tag: 'refinement', template, actual } : actual;
}

export function isConcreteType(type: Type): boolean {
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
  if (entity.traceKind === 'bool') return true;
  if (entity.special === 'list' && args.length === 1) {
    const elem = splitApp(args[0]).head;
    return elem.tag === 'tcon' && elem.entity === CHAR_TYPE;
  }
  return false;
}
