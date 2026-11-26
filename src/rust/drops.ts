import { normalize } from './infer';
import type { Program } from './items';
import { type Frame, MOVED, UNASSIGNED } from './runtime';
import { concreteType, typeKey } from './runtimeTypes';
import { type FnDef, type ImplDef, shallow, substitute, type Type, type TypeParam } from './types';
import {
  type BorrowGuard,
  type BufferedWriter,
  type CellBox,
  CellPlace,
  type ChannelEnd,
  DynValue,
  EnumValue,
  FnValue,
  isPlace,
  type IterValue,
  type MapValue,
  type SetValue,
  type SharedBox,
  StructValue,
  type Value,
  type WeakRef,
} from './values';

type Call = (fn: FnDef, typeArgs: Type[], args: Value[]) => Value;

/**
 * Drops values as Rust does when their owner goes away: runs the program's `Drop` impls, then drops the parts of the
 * value in order. Only types that hold a value with a `Drop` impl need it, so programs without one pay nothing.
 */
export class Dropper {
  private readonly impls: ImplDef[];
  private readonly needs = new Map<string, boolean>();
  private readonly dropFn: FnDef | undefined;

  constructor(
    private readonly program: Program,
    private readonly call: Call
  ) {
    this.impls = program.impls.filter((impl) => impl.trait?.trait.builtin === 'Drop' && !isStdImpl(impl));
    this.dropFn = program.builtinTraits.get('Drop')?.methods.get('drop');
  }

  private counted = false;

  /** Whether any value of the program can need dropping. */
  get active(): boolean {
    return this.counted || this.impls.length > 0;
  }

  /** Starts dropping values, once the program makes a value whose drop counts (an `Rc`, a `RefCell`'s guard). */
  activate(): void {
    this.counted = true;
  }

  /**
   * Whether a value of a concrete type holds something whose drop does something: whether a type that drops by
   * itself is reachable through its parts. A search that reaches none tells the same of every type it went through,
   * so each type of a recursive group is searched once.
   */
  needsDrop(type: Type): boolean {
    if (!this.active) return false;
    const root = normalize(shallow(type));
    const rootKey = typeKey(root);
    const known = this.needs.get(rootKey);
    if (known !== undefined) return known;
    const visited = new Set([rootKey]);
    const pending = [root];
    for (let t = pending.pop(); t; t = pending.pop()) {
      const answer = this.needs.get(typeKey(t));
      if (answer === false) continue;
      if (answer === true || this.dropsItself(t)) {
        this.needs.set(rootKey, true);
        return true;
      }
      for (const part of partsOf(t)) {
        const next = normalize(shallow(part));
        const key = typeKey(next);
        if (visited.has(key)) continue;
        visited.add(key);
        pending.push(next);
      }
    }
    for (const key of visited) this.needs.set(key, false);
    return false;
  }

  /** Whether dropping a value of a type does something itself, whatever its parts hold. */
  private dropsItself(t: Type): boolean {
    if (t.kind === 'dyn' || t.kind === 'closure') return true;
    return t.kind === 'adt' && (COUNTED.has(t.def.builtin ?? '') || this.implFor(t) !== undefined);
  }

  /** Drops a value of a concrete type: its `Drop` impl first, then its fields, elements, or contents in order. */
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of owning type.
  drop(value: Value, type: Type): void {
    if (value === MOVED || (value as unknown) === UNASSIGNED || !this.needsDrop(type)) return;
    const t = normalize(shallow(type));
    if (t.kind === 'adt') {
      const impl = this.implFor(t);
      if (impl && this.dropFn) this.call(this.dropFn, [t], [new CellPlace(value)]);
      this.dropAdt(value, t);
      return;
    }
    if (t.kind === 'closure') {
      const target = isPlace(value) ? value.get() : value;
      if (target instanceof FnValue) target.dropCaptures?.();
      return;
    }
    if (t.kind === 'dyn') {
      const target = isPlace(value) ? value.get() : value;
      if (target instanceof DynValue) this.drop(target.value, target.type);
      return;
    }
    if (t.kind === 'tuple' || t.kind === 'array') {
      const items = value as Value[];
      const types = t.kind === 'tuple' ? t.elems : items.map(() => t.elem);
      for (const [index, item] of items.entries()) this.drop(item, types[index]);
    }
  }

  /** An `Rc`, an `Arc`, or a `Weak` going: one count less, and the value goes with its last strong count. */
  private dropCounted(target: Value, t: Type & { kind: 'adt' }): void {
    if (t.def.builtin === 'Weak') {
      const { box } = target as WeakRef;
      if (box && box.weak > 0) box.weak--;
      return;
    }
    const box = target as SharedBox;
    if (box.strong === 0) return;
    box.strong--;
    if (box.strong === 0) this.drop(box.value, t.args[0]);
  }

  /** Drops the elements an iterator that owns them has not yielded. */
  dropRest(iter: IterValue): void {
    if (iter.rest && iter.ownedItemType) for (const item of iter.rest()) this.drop(item, iter.ownedItemType);
  }

  // code-gauge-allow functionNcss -- One case per kind of owning type.
  private dropAdt(value: Value, t: Type & { kind: 'adt' }): void {
    const target = isPlace(value) ? value.get() : value;
    switch (t.def.builtin) {
      case 'Rc':
      case 'Arc':
      case 'Weak': {
        this.dropCounted(target, t);
        return;
      }
      case 'Ref':
      case 'RefMut':
      case 'MutexGuard':
      case 'RwLockReadGuard':
      case 'RwLockWriteGuard': {
        (target as BorrowGuard).release();
        return;
      }
      case 'Receiver': {
        (target as ChannelEnd).receiverDropped = true;
        return;
      }
      case 'BufWriter': {
        // Dropping a `BufWriter` passes on what it holds, and ignores a failure as std does.
        (target as BufferedWriter).flush();
        return;
      }
      case 'RefCell':
      case 'Cell':
      case 'Mutex':
      case 'RwLock': {
        this.drop((target as CellBox).value, t.args[0]);
        return;
      }
      case 'Box': {
        this.drop(value, t.args[0]);
        return;
      }
      case 'Iter': {
        this.dropRest(target as IterValue);
        return;
      }
      case 'Vec':
      case 'VecDeque':
      case 'BinaryHeap': {
        for (const item of value as Value[]) this.drop(item, t.args[0]);
        return;
      }
      case 'HashMap':
      case 'BTreeMap': {
        for (const [key, item] of (value as MapValue).entries.snapshot()) {
          this.drop(key, t.args[0]);
          this.drop(item, t.args[1]);
        }
        return;
      }
      case 'HashSet':
      case 'BTreeSet': {
        for (const item of (value as SetValue).entries.snapshot()) this.drop(item, t.args[0]);
        return;
      }
      default: {
        break;
      }
    }
    if (!(target instanceof StructValue) && !(target instanceof EnumValue)) return;
    const variant = t.def.variants[target instanceof EnumValue ? target.variant : 0];
    const subst = argsOf(t);
    for (const [index, field] of (variant?.fields ?? []).entries()) {
      this.drop(target.fields[index], substitute(field.type, subst));
    }
  }

  /** Drops the variables of a frame's slots, the last declared first. */
  dropSlots(frame: Frame, slots: readonly number[]): void {
    if (!this.active) return;
    for (let index = slots.length - 1; index >= 0; index--) {
      const slot = slots[index];
      this.dropSlot(frame, slot);
      // The temporaries a `let` extended go after its variable, the last made first.
      const held = frame.extendedTemporaries.get(slot);
      frame.extendedTemporaries.delete(slot);
      for (const release of held?.toReversed() ?? []) release();
    }
  }

  private dropSlot(frame: Frame, slot: number): void {
    const local = frame.info.locals.find((info) => info.slot === slot);
    const value = frame.locals[slot];
    if (!local || value === UNASSIGNED || value === MOVED) return;
    const type = concreteType(local.type, frame.typeArgs);
    if (!this.needsDrop(type)) return;
    frame.locals[slot] = MOVED;
    this.drop(value, type);
  }

  private implFor(t: Type & { kind: 'adt' }): ImplDef | undefined {
    return this.impls.find((impl) => {
      const self = normalize(shallow(impl.selfType));
      return self.kind === 'adt' && self.def === t.def;
    });
  }
}

/** The types whose drop counts (an `Rc`'s strong count) or ends a borrow (a `RefCell`'s guard). */
const COUNTED = new Set([
  'Rc',
  'Weak',
  'Ref',
  'RefMut',
  'Arc',
  'MutexGuard',
  'RwLockReadGuard',
  'RwLockWriteGuard',
  'Receiver',
  'BufWriter',
]);

/** The types of the values a value of a type holds: its fields and type arguments, elements, or contents. */
function partsOf(t: Type): Type[] {
  switch (t.kind) {
    case 'adt': {
      const fields = t.def.variants.flatMap((variant) =>
        variant.fields.map((field) => substitute(field.type, argsOf(t)))
      );
      return [...t.args, ...fields];
    }
    case 'tuple': {
      return t.elems;
    }
    case 'array':
    case 'slice': {
      return [t.elem];
    }
    default: {
      return [];
    }
  }
}

function argsOf(t: Type & { kind: 'adt' }): Map<TypeParam, Type> {
  return new Map(t.def.params.map((param, index) => [param, t.args[index]]));
}

function isStdImpl(impl: ImplDef): boolean {
  return (impl.module as { isStd?: boolean }).isStd === true;
}
