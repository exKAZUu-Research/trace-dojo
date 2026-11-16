import { type TypeHint, type TypeHintRef, UNKNOWN_TYPE } from './displayTypeHints';
import type { ConInfo } from './entities';
import { mapGraph, mapGraphPairs } from './typeGraph';
import { instantiateType, prune, splitApp, type Type, typeChildren } from './types';
import { type Slot, Thunk, TypedSlot, untypedSlot } from './values';

export { UNKNOWN_TYPE } from './displayTypeHints';

const concreteTypes = new WeakSet<Type>();

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

function hintChildren(hint: TypeHint): TypeHint[] {
  if (hint.tag === 'hint') return [hint.value];
  if (hint.tag === 'fieldType') return [hint.parent];
  if (hint.tag !== 'refinement') return [];
  const template = hint.template;
  const known = template.tag !== 'hint' && template.tag !== 'fieldType' && template.tag !== 'refinement';
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
