import { normalize } from './infer';
import type { Program } from './items';
import { type Frame, MOVED, UNASSIGNED } from './runtime';
import { concreteType, typeKey } from './runtimeTypes';
import { type FnDef, type ImplDef, sameType, shallow, substitute, type Type, type TypeParam } from './types';
import type { MapValue, SetValue} from './values';
import { CellPlace, DynValue, EnumValue, isPlace, StructValue, type Value } from './values';

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

  /** Whether any value of the program can need dropping. */
  get active(): boolean {
    return this.impls.length > 0;
  }

  /** Whether a value of a concrete type holds something whose drop does something. */
  needsDrop(type: Type, seen: Type[] = []): boolean {
    if (!this.active) return false;
    const t = normalize(shallow(type));
    if (seen.some((other) => sameType(other, t))) return false;
    const key = typeKey(t);
    const known = this.needs.get(key);
    if (known !== undefined) return known;
    const inner = [...seen, t];
    let result: boolean;
    switch (t.kind) {
      case 'adt': {
        result =
          this.implFor(t) !== undefined ||
          t.args.some((arg) => this.needsDrop(arg, inner)) ||
          t.def.variants.some((variant) =>
            variant.fields.some((field) => this.needsDrop(substitute(field.type, argsOf(t)), inner))
          );
        break;
      }
      case 'tuple': {
        result = t.elems.some((elem) => this.needsDrop(elem, inner));
        break;
      }
      case 'array':
      case 'slice': {
        result = this.needsDrop(t.elem, inner);
        break;
      }
      case 'dyn':
      case 'closure': {
        result = true;
        break;
      }
      default: {
        result = false;
      }
    }
    this.needs.set(key, result);
    return result;
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

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of owning type.
  private dropAdt(value: Value, t: Type & { kind: 'adt' }): void {
    switch (t.def.builtin) {
      case 'Box': {
        this.drop(value, t.args[0]);
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
    const target = isPlace(value) ? value.get() : value;
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
      const local = frame.info.locals.find((info) => info.slot === slot);
      const value = frame.locals[slot];
      if (!local || value === UNASSIGNED || value === MOVED) continue;
      const type = concreteType(local.type, frame.typeArgs);
      if (!this.needsDrop(type)) continue;
      frame.locals[slot] = MOVED;
      this.drop(value, type);
    }
  }

  private implFor(t: Type & { kind: 'adt' }): ImplDef | undefined {
    return this.impls.find((impl) => {
      const self = normalize(shallow(impl.selfType));
      return self.kind === 'adt' && self.def === t.def;
    });
  }
}

function argsOf(t: Type & { kind: 'adt' }): Map<TypeParam, Type> {
  return new Map(t.def.params.map((param, index) => [param, t.args[index]]));
}

function isStdImpl(impl: ImplDef): boolean {
  return (impl.module as { isStd?: boolean }).isStd === true;
}
