import { IO_TYPE } from './builtinTypes';
import type { ConInfo } from './entities';
import { instantiateType, prune, splitApp, type Type } from './types';
import { type Slot, Thunk, TypedSlot, untypedSlot } from './values';

export const UNKNOWN_TYPE: Type = { tag: 'tgen', index: -1 };

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
  while (slot instanceof TypedSlot || slot instanceof Thunk) {
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

function refineType(template: Type, actual: Type): Type {
  const left = prune(template);
  const right = prune(actual);
  if (left === right) return left;
  if (left.tag === 'tgen' || left.tag === 'tvar') return right;
  if (left.tag === 'tap' && right.tag === 'tap')
    return { tag: 'tap', fn: refineType(left.fn, right.fn), arg: refineType(left.arg, right.arg) };
  return left;
}

export function constructorFieldType(con: ConInfo, type: Type, position: number): Type {
  const { args } = splitApp(prune(type));
  const parameters = Array.from({ length: con.type.arity }, (_, index) => args[index] ?? UNKNOWN_TYPE);
  return instantiateType(con.fieldTypes[position], parameters);
}
