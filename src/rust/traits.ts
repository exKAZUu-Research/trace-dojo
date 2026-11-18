// code-gauge-allow-file fileNcss 561 -- One rule per trait or conversion of the standard library.
import { normalize, type Unifier } from './infer';
import type { Module, Program } from './items';
import {
  freshVar,
  type ImplDef,
  isSigned,
  shallow,
  type Subst,
  substitute,
  substituteTraitRef,
  type TraitDef,
  type TraitRef,
  type Type,
  USIZE,
} from './types';

export type Answer = 'yes' | 'no' | 'unknown';

/** Decides which types implement which traits: from impls, derives, bounds, and the standard library's rules. */
export class TraitSolver {
  constructor(
    readonly program: Program,
    readonly unifier: Unifier
  ) {}

  /** Whether `type` implements the trait, binding variables of closure signatures as a side effect. */
  // code-gauge-allow functionCognitiveComplexity 20 -- One rule per trait or conversion of the standard library.
  implements(type: Type, ref: TraitRef): Answer {
    const t = normalize(shallow(type));
    const { trait } = ref;
    if (t.kind === 'never') return 'yes';
    if (t.kind === 'var') return this.varImplements(t, ref);
    // Type parameters are `Sized` unless they opt out with `?Sized`.
    if (t.kind === 'param') return trait.builtin === 'Sized' || this.boundsImply(t.param.bounds, ref) ? 'yes' : 'no';
    if (t.kind === 'adt' && ['ParseError', 'Unsigned', 'Signed', 'Indexed'].includes(t.def.builtin as string))
      return 'unknown';
    if (t.kind === 'opaque') return this.boundsImply(t.opaque.bounds, ref) ? 'yes' : this.builtinOnly(t, ref);
    if (t.kind === 'dyn') {
      if (this.boundsImply([t.trait], ref)) return 'yes';
      return this.builtinOnly(t, ref);
    }
    if (ref.fnSig) return this.closureImplements(t, ref);
    const user = this.userImpl(trait, t, ref.args);
    if (user) return 'yes';
    if (trait.builtin) return this.builtinImplements(t, ref);
    return 'no';
  }

  private builtinOnly(t: Type, ref: TraitRef): Answer {
    return ref.trait.builtin ? this.builtinImplements(t, ref) : 'no';
  }

  private varImplements(t: Type & { kind: 'var' }, ref: TraitRef): Answer {
    // An untyped number indexing a slice is a `usize`, the only integer type slices take.
    if (t.v.literal === 'int' && ref.trait.builtin === 'SliceIndex')
      return this.unifier.tryUnify(t, USIZE) ? 'yes' : 'no';
    if (t.v.literal && ref.trait.builtin) return this.literalImplements(t.v.literal, ref);
    return 'unknown';
  }

  private literalImplements(literal: 'int' | 'float', ref: TraitRef): Answer {
    const name = ref.trait.builtin as string;
    if (literal === 'float' && ['Eq', 'Ord', 'Hash', 'Integer'].includes(name)) return 'no';
    if (literal === 'int' && name === 'Float') return 'no';
    if (
      [
        'Copy',
        'Clone',
        'Debug',
        'Display',
        'PartialEq',
        'PartialOrd',
        'Default',
        'ToString',
        'Send',
        'Sync',
        'Sized',
      ].includes(name)
    ) {
      return 'yes';
    }
    if (literal === 'int' && ['Eq', 'Ord', 'Hash', 'Integer'].includes(name)) return 'yes';
    if (literal === 'float' && name === 'Float') return 'yes';
    return 'unknown';
  }

  /** Whether bounds imply a trait, through supertraits. */
  // code-gauge-allow functionCognitiveComplexity 18 -- One rule per trait or conversion of the standard library.
  boundsImply(bounds: TraitRef[], ref: TraitRef): boolean {
    const seen = new Set<TraitDef>();
    const stack = [...bounds];
    while (stack.length > 0) {
      const bound = stack.pop() as TraitRef;
      if (bound.trait === ref.trait) {
        if (ref.fnSig && bound.fnSig) {
          return (
            bound.fnSig.params.length === ref.fnSig.params.length &&
            this.unifier.tryUnify(
              { kind: 'tuple', elems: bound.fnSig.params },
              { kind: 'tuple', elems: ref.fnSig.params }
            ) &&
            this.unifier.tryUnify(bound.fnSig.ret, ref.fnSig.ret)
          );
        }
        if (bound.args.every((arg, i) => ref.args[i] === undefined || this.unifier.tryUnify(arg, ref.args[i])))
          return true;
      }
      if (ref.fnSig && bound.fnSig && closureKindAtLeast(bound.trait.name, ref.trait.name)) {
        return (
          bound.fnSig.params.length === ref.fnSig.params.length &&
          this.unifier.tryUnify(
            { kind: 'tuple', elems: bound.fnSig.params },
            { kind: 'tuple', elems: ref.fnSig.params }
          ) &&
          this.unifier.tryUnify(bound.fnSig.ret, ref.fnSig.ret)
        );
      }
      if (seen.has(bound.trait)) continue;
      seen.add(bound.trait);
      stack.push(...bound.trait.supertraits);
    }
    return false;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One rule per trait or conversion of the standard library.
  private closureImplements(t: Type, ref: TraitRef): Answer {
    const sig = ref.fnSig!;
    if (t.kind === 'closure') {
      const { closure } = t;
      if (!closureKindAtLeast(closure.kind, ref.trait.name)) return 'no';
      if (closure.params.length !== sig.params.length) return 'no';
      const ok =
        this.unifier.tryUnify({ kind: 'tuple', elems: closure.params }, { kind: 'tuple', elems: sig.params }) &&
        this.unifier.tryUnify(closure.ret, sig.ret);
      return ok ? 'yes' : 'no';
    }
    if (t.kind === 'fn') {
      if (t.params.length !== sig.params.length) return 'no';
      const ok =
        this.unifier.tryUnify({ kind: 'tuple', elems: t.params }, { kind: 'tuple', elems: sig.params }) &&
        this.unifier.tryUnify(t.ret, sig.ret);
      return ok ? 'yes' : 'no';
    }
    if (t.kind === 'ref') return this.closureImplements(normalize(shallow(t.target)), ref);
    if (t.kind === 'adt' && t.def.builtin === 'Box') return this.closureImplements(normalize(shallow(t.args[0])), ref);
    return 'no';
  }

  /** The user's impl of a trait for a type, with the impl's type parameters bound. */
  userImpl(trait: TraitDef, type: Type, args: Type[] = []): { impl: ImplDef; subst: Subst } | undefined {
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const subst = this.matchImpl(impl, type, args);
      if (subst) return { impl, subst };
    }
    return undefined;
  }

  /**
   * Matches an impl's self type (and trait arguments) against a type, binding the impl's parameters to fresh
   * variables; the bindings stay when it matches, so that the caller learns the arguments.
   */
  matchImpl(impl: ImplDef, type: Type, traitArgs: Type[] = []): Subst | undefined {
    const subst: Subst = new Map(impl.params.map((param) => [param, freshVar()]));
    const snapshot = this.unifier.snapshot();
    const selfType = substitute(impl.selfType, subst);
    if (!this.unifier.unify(selfType, type)) {
      this.unifier.rollback(snapshot);
      return undefined;
    }
    if (impl.trait) {
      const implArgs = substituteTraitRef(impl.trait, subst).args;
      for (const [index, arg] of traitArgs.entries()) {
        if (implArgs[index] && !this.unifier.unify(implArgs[index], arg)) {
          this.unifier.rollback(snapshot);
          return undefined;
        }
      }
    }
    for (const param of impl.params) {
      const bound = subst.get(param) as Type;
      for (const ref of param.bounds) {
        const answer = this.implements(bound, substituteTraitRef(ref, subst));
        if (answer === 'no') {
          this.unifier.rollback(snapshot);
          return undefined;
        }
      }
    }
    return subst;
  }

  isCopy(type: Type): boolean {
    return this.implements(type, { trait: this.program.traitDef('Copy'), args: [] }) === 'yes';
  }

  private builtinImplements(t: Type, ref: TraitRef): Answer {
    const name = ref.trait.builtin as string;
    const all = (types: Type[], trait = ref): Answer => {
      let result: Answer = 'yes';
      for (const type of types) {
        const answer = this.implements(type, { trait: trait.trait, args: trait.args });
        if (answer === 'no') return 'no';
        if (answer === 'unknown') result = 'unknown';
      }
      return result;
    };
    const isPrimitive = t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char';
    const derived = (): Answer | undefined => {
      if (t.kind !== 'adt') return undefined;
      if (t.def.derives.has(name)) {
        // A derive bounds every type parameter by the trait, as `#[derive]` does.
        return all(t.args);
      }
      return undefined;
    };
    // std implements these for tuples of up to 12 elements.
    if (t.kind === 'tuple' && t.elems.length > 12 && TUPLE_TRAITS.has(name)) return 'no';
    switch (name) {
      case 'Sized': {
        return t.kind === 'str' || t.kind === 'slice' || t.kind === 'dyn' ? 'no' : 'yes';
      }
      case 'Send':
      case 'Sync': {
        return 'yes';
      }
      case 'Copy': {
        if (isPrimitive || t.kind === 'fn' || t.kind === 'never') return 'yes';
        if (t.kind === 'ref') return t.mutable ? 'no' : 'yes';
        if (t.kind === 'tuple') return all(t.elems);
        if (t.kind === 'array') return all([t.elem]);
        if (t.kind === 'adt') {
          if (t.def.builtin === 'RangeFull') return 'yes';
          return derived() ?? 'no';
        }
        return 'no';
      }
      case 'Clone': {
        if (isPrimitive || t.kind === 'fn' || t.kind === 'never') return 'yes';
        if (t.kind === 'ref') return t.mutable ? 'no' : 'yes';
        if (t.kind === 'tuple') return all(t.elems);
        if (t.kind === 'array') return all([t.elem]);
        if (t.kind === 'closure') return 'no';
        if (t.kind === 'adt') {
          const d = derived();
          if (d) return d;
          if (CLONE_CONTAINERS.has(t.def.builtin as string)) return all(t.args);
          if (t.def.builtin === 'String' || ERROR_TYPES.has(t.def.builtin as string)) return 'yes';
          if (t.def.builtin === 'Box') {
            const inner = shallow(t.args[0]);
            if (inner.kind === 'dyn') return 'no';
            return all(t.args);
          }
          return 'no';
        }
        return 'no';
      }
      case 'Debug': {
        if (isPrimitive || t.kind === 'str' || t.kind === 'never') return 'yes';
        if (t.kind === 'ref') return all([t.target]);
        if (t.kind === 'tuple') return all(t.elems);
        if (t.kind === 'array' || t.kind === 'slice') return all([t.elem]);
        if (t.kind === 'dyn')
          return this.boundsImply([t.trait], { trait: this.program.traitDef('Debug'), args: [] }) ? 'yes' : 'no';
        if (t.kind === 'adt') {
          const d = derived();
          if (d) return d;
          if (DEBUG_TYPES.has(t.def.builtin as string))
            return all(t.args.filter((_, i) => t.def.builtin !== 'Iter' || i < 0));
          return 'no';
        }
        return 'no';
      }
      case 'Display':
      case 'ToString': {
        if (name === 'ToString') {
          return this.implements(t, { trait: this.program.traitDef('Display'), args: [] });
        }
        if (isPrimitive || t.kind === 'str' || t.kind === 'never') return 'yes';
        if (t.kind === 'ref') return all([t.target]);
        if (t.kind === 'dyn') {
          return this.boundsImply([t.trait], { trait: this.program.traitDef('Display'), args: [] }) ? 'yes' : 'no';
        }
        if (t.kind === 'adt') {
          if (t.def.builtin === 'String' || ERROR_TYPES.has(t.def.builtin as string) || t.def.builtin === 'CaseIter')
            return 'yes';
          if (t.def.builtin === 'Box') return all(t.args);
          return 'no';
        }
        return 'no';
      }
      case 'PartialEq':
      case 'Eq':
      case 'PartialOrd':
      case 'Ord':
      case 'Hash': {
        const exact = name !== 'PartialEq' && name !== 'PartialOrd';
        if (t.kind === 'float') return exact ? 'no' : 'yes';
        if (isPrimitive || t.kind === 'str' || t.kind === 'never') return 'yes';
        if (t.kind === 'ref') return all([t.target]);
        if (t.kind === 'tuple') return all(t.elems);
        if (t.kind === 'array' || t.kind === 'slice') return all([t.elem]);
        if (t.kind === 'adt') {
          const d = derived();
          if (d) return d;
          const builtin = t.def.builtin as string;
          if (builtin === 'String' || builtin === 'Ordering') return 'yes';
          if (ERROR_TYPES.has(builtin)) return name === 'PartialEq' || name === 'Eq' ? 'yes' : 'no';
          if (['Vec', 'VecDeque', 'Box', 'Option', 'Result', 'BTreeSet', 'BTreeMap', 'Reverse'].includes(builtin)) {
            return all(t.args);
          }
          if (['HashMap', 'HashSet'].includes(builtin))
            return name === 'PartialEq' || name === 'Eq' ? all(t.args) : 'no';
          if (['Range', 'RangeInclusive'].includes(builtin))
            return name === 'PartialEq' || name === 'Eq' || name === 'Hash' ? all(t.args) : 'no';
          return 'no';
        }
        return 'no';
      }
      case 'Default': {
        if (isPrimitive) return 'yes';
        if (t.kind === 'tuple') return all(t.elems);
        if (t.kind === 'array') return all([t.elem]);
        if (t.kind === 'ref') return shallow(t.target).kind === 'str' ? 'yes' : 'no';
        if (t.kind === 'adt') {
          const d = derived();
          if (d) return d;
          const builtin = t.def.builtin as string;
          if (
            [
              'String',
              'Vec',
              'HashMap',
              'HashSet',
              'BTreeMap',
              'BTreeSet',
              'VecDeque',
              'BinaryHeap',
              'Option',
            ].includes(builtin)
          ) {
            return 'yes';
          }
          if (builtin === 'Box') return all(t.args);
          return 'no';
        }
        return 'no';
      }
      case 'Error': {
        if (t.kind === 'adt') return ERROR_TYPES.has(t.def.builtin as string) ? 'yes' : 'no';
        if (t.kind === 'ref') return all([t.target]);
        return 'no';
      }
      case 'Integer': {
        return t.kind === 'int' ? 'yes' : 'no';
      }
      case 'AsRef': {
        // `String` and `str` as `str`, and `Vec`s, arrays, and slices as slices; through references too.
        const target = normalize(shallow(ref.args[0]));
        if (t.kind === 'ref') return this.implements(t.target, ref);
        const isString = t.kind === 'str' || (t.kind === 'adt' && t.def.builtin === 'String');
        if (isString) return this.unifier.tryUnify(target, { kind: 'str' }) ? 'yes' : 'no';
        const elem =
          t.kind === 'array' || t.kind === 'slice'
            ? t.elem
            : t.kind === 'adt' && t.def.builtin === 'Vec'
              ? t.args[0]
              : undefined;
        if (!elem) return 'no';
        return this.unifier.tryUnify(target, { kind: 'slice', elem }) ? 'yes' : 'no';
      }
      case 'SliceIndex': {
        // A `usize`, or a range of them.
        if (t.kind === 'int') return t.name === 'usize' ? 'yes' : 'no';
        if (t.kind !== 'adt' || !RANGE_TYPES.has(t.def.builtin as string)) return t.kind === 'var' ? 'unknown' : 'no';
        return t.args.every((arg) => this.unifier.tryUnify(arg, USIZE)) ? 'yes' : 'no';
      }
      case 'SignedInteger':
      case 'UnsignedInteger': {
        return t.kind === 'int' && isSigned(t.name) === (name === 'SignedInteger') ? 'yes' : 'no';
      }
      case 'Float': {
        return t.kind === 'float' ? 'yes' : 'no';
      }
      case 'FromStrTarget': {
        if (t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char') return 'yes';
        return t.kind === 'adt' && t.def.builtin === 'String' ? 'yes' : 'no';
      }
      case 'Pattern': {
        if (t.kind === 'char') return 'yes';
        if (t.kind === 'fn') {
          return t.params.length === 1 &&
            this.unifier.tryUnify(t.params[0], { kind: 'char' }) &&
            this.unifier.tryUnify(t.ret, { kind: 'bool' })
            ? 'yes'
            : 'no';
        }
        if (t.kind === 'closure') {
          return this.implements(t, {
            trait: this.program.traitDef('FnMut'),
            args: [],
            fnSig: { params: [{ kind: 'char' }], ret: { kind: 'bool' } },
          });
        }
        if (t.kind === 'ref') {
          const target = shallow(t.target);
          if (target.kind === 'str') return 'yes';
          if (target.kind === 'var') return 'unknown';
          if (target.kind === 'adt' && target.def.builtin === 'String') return 'yes';
          if (target.kind === 'ref') return this.builtinImplements(target, ref);
          if ((target.kind === 'array' || target.kind === 'slice') && shallow(target.elem).kind === 'char')
            return 'yes';
          return 'no';
        }
        if (t.kind === 'array' && shallow(t.elem).kind === 'char') return 'yes';
        return 'no';
      }
      case 'StringPart': {
        if (t.kind === 'char') return 'yes';
        if (t.kind === 'adt' && t.def.builtin === 'String') return 'yes';
        if (t.kind === 'ref') {
          const target = shallow(t.target);
          return target.kind === 'str' ||
            target.kind === 'char' ||
            (target.kind === 'adt' && target.def.builtin === 'String')
            ? 'yes'
            : 'no';
        }
        return 'no';
      }
      case 'RangeBounds': {
        if (t.kind !== 'adt') return 'no';
        if (!RANGE_TYPES.has(t.def.builtin as string)) return 'no';
        if (t.def.builtin === 'RangeFull') return 'yes';
        return this.unifier.tryUnify(t.args[0], ref.args[0]) ? 'yes' : 'no';
      }
      case 'Borrow': {
        const [q] = ref.args;
        if (this.unifier.tryUnify(t, q)) return 'yes';
        const target = shallow(q);
        if (target.kind === 'var') return 'unknown';
        if (t.kind === 'adt' && t.def.builtin === 'String' && target.kind === 'str') return 'yes';
        if (t.kind === 'adt' && t.def.builtin === 'Vec' && target.kind === 'slice') {
          return this.unifier.tryUnify(t.args[0], target.elem) ? 'yes' : 'no';
        }
        if (t.kind === 'ref' && this.unifier.tryUnify(t.target, q)) return 'yes';
        if (t.kind === 'adt' && t.def.builtin === 'Box' && this.unifier.tryUnify(t.args[0], q)) return 'yes';
        return 'no';
      }
      case 'FromIterator': {
        return this.fromIterator(t, ref.args[0]);
      }
      case 'ExtendInto': {
        // A collection of `T` extends from `T`s, and from `&T`s when `T` is `Copy`.
        const [target] = ref.args;
        if (this.unifier.tryUnify(t, target)) return 'yes';
        if (t.kind === 'ref' && !t.mutable) {
          const snapshot = this.unifier.snapshot();
          if (this.unifier.unify(t.target, target) && this.isCopy(t.target)) return 'yes';
          this.unifier.rollback(snapshot);
        }
        return 'no';
      }
      case 'Extend': {
        // Collections of `Copy` elements also extend from references to them.
        const item = shallow(ref.args[0]);
        if (item.kind === 'ref' && t.kind === 'adt' && t.args.length === 1) {
          const snapshot = this.unifier.snapshot();
          if (this.unifier.unify(item.target, t.args[0]) && this.isCopy(item.target)) return 'yes';
          this.unifier.rollback(snapshot);
        }
        return this.fromIterator(t, ref.args[0]);
      }
      case 'Sum':
      case 'Product': {
        const [item] = ref.args;
        if (t.kind !== 'int' && t.kind !== 'float') return 'no';
        const element = shallow(item);
        const inner = element.kind === 'ref' ? shallow(element.target) : element;
        if (inner.kind === 'var') return this.unifier.tryUnify(inner, t) ? 'yes' : 'unknown';
        return this.unifier.tryUnify(inner, t) ? 'yes' : 'no';
      }
      case 'From':
      case 'Into': {
        return this.fromInto(t, ref);
      }
      case 'TryFrom':
      case 'TryInto': {
        // Integers convert to each other, failing out of range.
        const other = normalize(shallow(ref.args[0]));
        if (t.kind !== 'int') return 'no';
        if (other.kind === 'var') return other.v.literal === 'float' ? 'no' : 'unknown';
        return other.kind === 'int' ? 'yes' : 'no';
      }
      default: {
        return 'no';
      }
    }
  }

  private fromIterator(t: Type, item: Type): Answer {
    if (t.kind !== 'adt') return 'no';
    const element = shallow(item);
    switch (t.def.builtin) {
      case 'Vec':
      case 'VecDeque':
      case 'HashSet':
      case 'BTreeSet':
      case 'BinaryHeap': {
        return this.unifier.tryUnify(t.args[0], item) ? 'yes' : 'no';
      }
      case 'Box': {
        const inner = shallow(t.args[0]);
        if (inner.kind === 'slice') return this.unifier.tryUnify(inner.elem, item) ? 'yes' : 'no';
        return 'no';
      }
      case 'String': {
        if (element.kind === 'var') return 'unknown';
        if (element.kind === 'char') return 'yes';
        if (element.kind === 'adt' && element.def.builtin === 'String') return 'yes';
        if (element.kind === 'ref') {
          const target = shallow(element.target);
          if (target.kind === 'str' || target.kind === 'char') return 'yes';
          if (target.kind === 'adt' && target.def.builtin === 'String') return 'yes';
        }
        return 'no';
      }
      case 'HashMap':
      case 'BTreeMap': {
        return this.unifier.tryUnify({ kind: 'tuple', elems: t.args }, item) ? 'yes' : 'no';
      }
      case 'Result': {
        const inner = freshVar();
        if (!this.unifier.tryUnify(item, this.program.builtinType('Result', [inner, t.args[1]]))) return 'no';
        return this.implements(t.args[0], { trait: this.program.traitDef('FromIterator'), args: [inner] });
      }
      case 'Option': {
        const inner = freshVar();
        if (!this.unifier.tryUnify(item, this.program.builtinType('Option', [inner]))) return 'no';
        return this.implements(t.args[0], { trait: this.program.traitDef('FromIterator'), args: [inner] });
      }
      default: {
        return 'no';
      }
    }
  }

  /** `From<source>` for `t` (or `Into<target>` for `t`), from the standard library's conversions and user impls. */
  private fromInto(t: Type, ref: TraitRef): Answer {
    if (ref.trait.builtin === 'Into') {
      const target = ref.args[0];
      return this.implements(target, { trait: this.program.traitDef('From'), args: [t] });
    }
    const source = normalize(shallow(ref.args[0]));
    if (source.kind === 'var') return 'unknown';
    if (source.kind === 'adt' && ['ParseError', 'Unsigned', 'Signed', 'Indexed'].includes(source.def.builtin as string))
      return 'unknown';
    if (this.unifier.tryUnify(t, source)) return 'yes';
    return conversionExists(this.program, source, t, this) ? 'yes' : 'no';
  }
}

const CLONE_CONTAINERS = new Set([
  'Vec',
  'HashMap',
  'HashSet',
  'BTreeMap',
  'BTreeSet',
  'VecDeque',
  'BinaryHeap',
  'Option',
  'Result',
  'Iter',
  'Range',
  'RangeInclusive',
  'RangeFrom',
  'RangeTo',
  'RangeToInclusive',
  'Reverse',
]);

const DEBUG_TYPES = new Set([
  'String',
  'Vec',
  'HashMap',
  'HashSet',
  'BTreeMap',
  'BTreeSet',
  'VecDeque',
  'BinaryHeap',
  'Box',
  'Option',
  'Result',
  'Ordering',
  'Reverse',
  'Range',
  'RangeInclusive',
  'RangeFrom',
  'RangeTo',
  'RangeToInclusive',
  'RangeFull',
  'ParseIntError',
  'ParseFloatError',
  'TryFromIntError',
  'Utf8Error',
  'FmtError',
  'CaseIter',
]);

export const ERROR_TYPES = new Set([
  'ParseIntError',
  'ParseFloatError',
  'ParseBoolError',
  'ParseCharError',
  'TryFromIntError',
  'Utf8Error',
  'FmtError',
  'Infallible',
]);

const TUPLE_TRAITS = new Set(['Debug', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Default']);

export const RANGE_TYPES = new Set([
  'Range',
  'RangeInclusive',
  'RangeFrom',
  'RangeTo',
  'RangeToInclusive',
  'RangeFull',
]);

export function closureKindAtLeast(have: string, need: string): boolean {
  const order = ['Fn', 'FnMut', 'FnOnce'];
  return order.includes(have) && order.indexOf(have) <= order.indexOf(need);
}

/** The conversions `From` provides in the standard library that learning programs use. */
function conversionExists(program: Program, source: Type, target: Type, solver: TraitSolver): boolean {
  const t = normalize(shallow(target));
  if (t.kind === 'adt') {
    switch (t.def.builtin) {
      case 'String': {
        if (source.kind === 'char') return true;
        if (source.kind === 'ref') {
          const inner = shallow(source.target);
          return inner.kind === 'str' || (inner.kind === 'adt' && inner.def.builtin === 'String');
        }
        return source.kind === 'adt' && source.def.builtin === 'Box' && shallow(source.args[0]).kind === 'str';
      }
      case 'Vec': {
        if (source.kind === 'array') return solver.unifier.tryUnify(source.elem, t.args[0]);
        if (source.kind === 'ref') {
          const inner = shallow(source.target);
          if (inner.kind === 'slice' || inner.kind === 'array') return solver.unifier.tryUnify(inner.elem, t.args[0]);
          if (inner.kind === 'str') return solver.unifier.tryUnify(t.args[0], { kind: 'int', name: 'u8' });
        }
        if (source.kind === 'adt' && source.def.builtin === 'String') {
          return solver.unifier.tryUnify(t.args[0], { kind: 'int', name: 'u8' });
        }
        if (source.kind === 'adt' && ['VecDeque', 'BinaryHeap'].includes(source.def.builtin as string)) {
          return solver.unifier.tryUnify(source.args[0], t.args[0]);
        }
        return false;
      }
      case 'HashMap':
      case 'BTreeMap':
      case 'HashSet':
      case 'BTreeSet':
      case 'VecDeque':
      case 'BinaryHeap': {
        if (source.kind !== 'array' && !(source.kind === 'adt' && source.def.builtin === 'Vec')) return false;
        const elem = source.kind === 'array' ? source.elem : source.args[0];
        const want: Type = t.def.builtin.endsWith('Map') ? { kind: 'tuple', elems: t.args } : t.args[0];
        return solver.unifier.tryUnify(elem, want);
      }
      case 'Option': {
        return solver.unifier.tryUnify(t.args[0], source);
      }
      case 'Box': {
        const inner = shallow(t.args[0]);
        if (inner.kind === 'dyn' && inner.trait.trait.builtin === 'Error') {
          if (source.kind === 'adt' && source.def.builtin === 'String') return true;
          if (source.kind === 'ref' && shallow(source.target).kind === 'str') return true;
          return solver.implements(source, { trait: program.traitDef('Error'), args: [] }) === 'yes';
        }
        return solver.unifier.tryUnify(inner, source);
      }
      default: {
        return false;
      }
    }
  }
  if (t.kind === 'int' && source.kind === 'int') return losslessInt(source.name, t.name);
  if (t.kind === 'int' && source.kind === 'bool') return true;
  if (t.kind === 'int' && source.kind === 'char') return t.name === 'u32' || t.name === 'u64' || t.name === 'u128';
  if (t.kind === 'float' && source.kind === 'float') return t.name === 'f64' || source.name === 'f32';
  if (t.kind === 'float' && source.kind === 'int') {
    const bits = Number(source.name.slice(1));
    return t.name === 'f64' ? bits <= 32 : bits <= 16;
  }
  if (t.kind === 'char' && source.kind === 'int') return source.name === 'u8';
  return false;
}

function intBitsByName(name: string): number {
  return name.endsWith('size') ? 64 : Number(name.slice(1));
}

// code-gauge-allow functionCognitiveComplexity 20 -- One rule per trait or conversion of the standard library.
function losslessInt(from: string, to: string): boolean {
  if (from === to) return true;
  const fromSigned = from.startsWith('i');
  const toSigned = to.startsWith('i');
  const bits = intBitsByName;
  if (from.endsWith('size') || to.endsWith('size')) {
    if (from === 'u8' && (to === 'usize' || to === 'isize')) return true;
    if (from === 'u16' && to === 'usize') return true;
    if (from === 'i8' && to === 'isize') return true;
    if (from === 'i16' && to === 'isize') return true;
    return false;
  }
  if (fromSigned && !toSigned) return false;
  if (!fromSigned && toSigned) return bits(to) > bits(from);
  return bits(to) >= bits(from);
}

export function moduleOf(def: { module?: unknown }): Module | undefined {
  return def.module as Module | undefined;
}
