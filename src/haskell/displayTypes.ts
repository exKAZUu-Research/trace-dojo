import { IO_TYPE } from './builtinTypes';
import type { ConInfo } from './entities';
import { mapGraph, mapGraphPairs } from './typeGraph';
import { instantiateType, prune, splitApp, type Type, typeChildren } from './types';
import { chargeTypeWork } from './typeWorkBudget';
import { type Slot, Thunk, TypedSlot, untypedSlot } from './values';

export const UNKNOWN_TYPE: Type = { tag: 'tgen', index: -1 };
const concreteTypes = new WeakSet<Type>();

export function typedSlot(slot: Slot, type: Type | undefined): Slot {
  if (!type) return slot;
  const actual = prune(type);
  if (actual.tag === 'tvar' || actual.tag === 'tgen') return slot;
  const { head } = splitApp(actual);
  if (head.tag === 'tcon' && (head.entity.special === 'function' || head.entity === IO_TYPE)) return slot;
  return new TypedSlot(untypedSlot(slot), slotDisplayType(slot, type));
}

export function slotDisplayType(slot: Slot, fallback: Type = UNKNOWN_TYPE): Type {
  let result = fallback;
  let seen: Set<Thunk> | undefined;
  while (!isConcreteType(result) && (slot instanceof TypedSlot || slot instanceof Thunk)) {
    chargeTypeWork();
    if (slot instanceof TypedSlot) {
      result = refineType(result, slot.type);
      slot = slot.slot;
      continue;
    }
    if (slot.displayType) result = refineType(result, slot.displayType);
    if (!slot.target || seen?.has(slot)) break;
    seen ??= new Set<Thunk>();
    seen.add(slot);
    slot = slot.target;
  }
  return result;
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
