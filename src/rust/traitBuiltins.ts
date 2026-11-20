// code-gauge-allow-file fileNcss 437 -- One rule per trait of the standard library.
import { normalize } from './infer';
import { supportsDebug } from './iterDebug';
import { intoIterItem } from './iterTypes';
import { conversionExists, infallibleConversion } from './traitConversions';
import { doubleEndedSearcher, iteratorCapability } from './traitIterators';
import type { Answer, TraitSolver } from './traits';
import { freshVar, isBuiltin, isIteratorShape, isSigned, shallow, type TraitRef, type Type, USIZE } from './types';

/** A question of whether a type implements one of the standard library's traits. */
interface Goal {
  solver: TraitSolver;
  t: Type;
  ref: TraitRef;
  name: string;
  /** Whether every type implements the trait asked about, with its arguments. */
  all: (types: Type[]) => Answer;
}

type AdtType = Type & { kind: 'adt' };

type Rule = (goal: Goal) => Answer;

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
  'Entry',
]);

const DEFAULT_TYPES = new Set([
  'String',
  'Vec',
  'HashMap',
  'HashSet',
  'BTreeMap',
  'BTreeSet',
  'VecDeque',
  'BinaryHeap',
  'Option',
]);

export const ERROR_TYPES = new Set([
  'ParseIntError',
  'ParseFloatError',
  'ParseBoolError',
  'ParseCharError',
  'TryFromIntError',
  'CharTryFromError',
  'TryFromCharError',
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

const RULES: Record<string, Rule> = {
  Sized: sized,
  Send: () => 'yes',
  Sync: () => 'yes',
  Copy: copy,
  Clone: clone,
  Debug: debug,
  Display: display,
  ToString: ({ solver, t }) => solver.implements(t, { trait: solver.program.traitDef('Display'), args: [] }),
  PartialEq: comparison,
  Eq: comparison,
  PartialOrd: comparison,
  Ord: comparison,
  Hash: comparison,
  Default: defaultValue,
  Error: stdError,
  Integer: ({ t }) => (t.kind === 'int' ? 'yes' : 'no'),
  AsRef: asRef,
  SliceIndex: sliceIndex,
  SignedInteger: signedness,
  UnsignedInteger: signedness,
  Float: ({ t }) => (t.kind === 'float' ? 'yes' : 'no'),
  FromStr: fromStr,
  FromStrTarget: fromStr,
  DoubleEndedPattern: doubleEndedPattern,
  Pattern: pattern,
  StringPart: ({ t }) => (isStringPart(t) ? 'yes' : 'no'),
  SliceOf: sliceOf,
  JoinSeparator: joinSeparator,
  ToOwned: ({ solver, t }) => solver.implements(t, { trait: solver.program.traitDef('Clone'), args: [] }),
  RangeBounds: rangeBounds,
  Borrow: borrow,
  FromIterator: ({ solver, t, ref }) => fromIterator(solver, t, ref.args[0]),
  DoubleEndedIterator: ({ t }) => iteratorCapability(t, 'back'),
  ExactSizeIterator: ({ t }) => iteratorCapability(t, 'exact'),
  DoubleEndedSearcher: ({ t }) => doubleEndedSearcher(t),
  Iterator: iterator,
  IntoIterator: iterator,
  ExtendInto: extendInto,
  Extend: extend,
  Sum: sum,
  Product: sum,
  From: fromInto,
  Into: fromInto,
  TryFrom: tryFrom,
  TryInto: tryFrom,
};

/** Whether a type of the standard library (or a derive) implements one of its traits, as std's impls decide. */
export function builtinImplements(solver: TraitSolver, t: Type, ref: TraitRef): Answer {
  const name = ref.trait.builtin as string;
  // std implements these for tuples of up to 12 elements.
  if (t.kind === 'tuple' && t.elems.length > 12 && TUPLE_TRAITS.has(name)) return 'no';
  const rule = RULES[name] as Rule | undefined;
  if (!rule) return 'no';
  const all = (types: Type[]): Answer => {
    let result: Answer = 'yes';
    for (const type of types) {
      const answer = solver.implements(type, { trait: ref.trait, args: ref.args });
      if (answer === 'no') return 'no';
      if (answer === 'unknown') result = 'unknown';
    }
    return result;
  };
  return rule({ solver, t, ref, name, all });
}

function sized({ t }: Goal): Answer {
  return t.kind === 'str' || t.kind === 'slice' || t.kind === 'dyn' ? 'no' : 'yes';
}

function copy(goal: Goal): Answer {
  const { t } = goal;
  const plain = plainCopy(goal);
  if (plain) return plain;
  if (t.kind !== 'adt') return 'no';
  if (t.def.builtin === 'RangeFull') return 'yes';
  return derived(goal) ?? 'no';
}

/** What `Copy` and `Clone` share: primitives, shared references, and what is made of copies. */
function plainCopy({ t, all }: Goal): Answer | undefined {
  if (isPrimitive(t) || t.kind === 'fn' || t.kind === 'never') return 'yes';
  if (t.kind === 'ref') return t.mutable ? 'no' : 'yes';
  if (t.kind === 'tuple') return all(t.elems);
  if (t.kind === 'array') return all([t.elem]);
  if (t.kind === 'closure') return closureCaptures(t, all);
  return undefined;
}

function clone(goal: Goal): Answer {
  const plain = plainCopy(goal);
  if (plain) return plain;
  return goal.t.kind === 'adt' ? cloneAdt(goal, goal.t) : 'no';
}

function cloneAdt(goal: Goal, t: AdtType): Answer {
  const { all } = goal;
  const d = derived(goal);
  if (d) return d;
  // An iterator clones as what it holds does: the closures of its adapters.
  if (t.def.builtin === 'Iter') return all([t.args[1]]);
  if (isIteratorShape(t.def))
    return all(t.args.filter((arg) => normalize(shallow(arg)).kind === 'closure' || isShapeType(arg)));
  if (CLONE_CONTAINERS.has(t.def.builtin as string)) return all(t.args);
  if (t.def.builtin === 'String' || ERROR_TYPES.has(t.def.builtin as string)) return 'yes';
  if (t.def.builtin === 'Box') {
    const inner = shallow(t.args[0]);
    if (inner.kind === 'dyn') return 'no';
    if (inner.kind === 'str') return 'yes';
    return all([inner.kind === 'slice' ? inner.elem : inner]);
  }
  return 'no';
}

function debug(goal: Goal): Answer {
  const { t, all } = goal;
  if (isPrimitive(t) || t.kind === 'str' || t.kind === 'never') return 'yes';
  if (t.kind === 'ref') return all([t.target]);
  if (t.kind === 'tuple') return all(t.elems);
  if (t.kind === 'array' || t.kind === 'slice') return all([t.elem]);
  if (t.kind === 'dyn') return dynImplies(goal.solver, t, 'Debug');
  if (t.kind !== 'adt') return 'no';
  const d = derived(goal);
  if (d) return d;
  if (t.def.builtin === 'Iter') return supportsDebug(t.args[1]) ? all([t.args[0]]) : 'no';
  if (DEBUG_TYPES.has(t.def.builtin as string)) return all(t.args);
  return 'no';
}

function display({ solver, t, all }: Goal): Answer {
  if (isPrimitive(t) || t.kind === 'str' || t.kind === 'never') return 'yes';
  if (t.kind === 'ref') return all([t.target]);
  if (t.kind === 'dyn') return dynImplies(solver, t, 'Display');
  if (t.kind !== 'adt') return 'no';
  if (t.def.builtin === 'String' || ERROR_TYPES.has(t.def.builtin as string) || t.def.builtin === 'CaseIter')
    return 'yes';
  if (t.def.builtin === 'Box') return all(t.args);
  return 'no';
}

function dynImplies(solver: TraitSolver, t: Type & { kind: 'dyn' }, trait: string): Answer {
  return solver.boundsImply([t.trait], { trait: solver.program.traitDef(trait), args: [] }) ? 'yes' : 'no';
}

function comparison(goal: Goal): Answer {
  const { solver, t, ref, name, all } = goal;
  // The standard library's types compare with their own type, as the default `Rhs` makes them.
  const partial = name === 'PartialEq' || name === 'PartialOrd';
  if (partial && ref.args[0]) {
    return solver.unifier.tryUnify(t, ref.args[0])
      ? builtinImplements(solver, t, { trait: ref.trait, args: [] })
      : 'no';
  }
  if (t.kind === 'float') return partial ? 'yes' : 'no';
  if (isPrimitive(t) || t.kind === 'str' || t.kind === 'never') return 'yes';
  if (t.kind === 'ref') return all([t.target]);
  if (t.kind === 'tuple') return all(t.elems);
  if (t.kind === 'array' || t.kind === 'slice') return all([t.elem]);
  if (t.kind === 'adt') return comparisonAdt(goal, t);
  return 'no';
}

function comparisonAdt(goal: Goal, t: AdtType): Answer {
  const { name, all } = goal;
  const d = derived(goal);
  if (d) return d;
  const builtin = t.def.builtin as string;
  const equality = name === 'PartialEq' || name === 'Eq';
  if (builtin === 'String' || builtin === 'Ordering') return 'yes';
  if (ERROR_TYPES.has(builtin)) return equality ? 'yes' : 'no';
  if (['Vec', 'VecDeque', 'Box', 'Option', 'Result', 'BTreeSet', 'BTreeMap', 'Reverse'].includes(builtin)) {
    return all(t.args);
  }
  if (['HashMap', 'HashSet'].includes(builtin)) return equality ? all(t.args) : 'no';
  if (RANGE_TYPES.has(builtin)) return equality || name === 'Hash' ? all(t.args) : 'no';
  return 'no';
}

function defaultValue(goal: Goal): Answer {
  const { t, all } = goal;
  if (isPrimitive(t)) return 'yes';
  if (t.kind === 'tuple') return all(t.elems);
  // std implements `Default` for arrays of up to 32 elements, and for empty `&str` and slices.
  if (t.kind === 'array') return t.len <= 32 ? all([t.elem]) : 'no';
  if (t.kind === 'ref') return ['str', 'slice'].includes(shallow(t.target).kind) ? 'yes' : 'no';
  if (t.kind !== 'adt') return 'no';
  const d = derived(goal);
  if (d) return d;
  const builtin = t.def.builtin as string;
  if (DEFAULT_TYPES.has(builtin)) return 'yes';
  if (builtin === 'Box') return all(t.args);
  return 'no';
}

function stdError({ t, all }: Goal): Answer {
  if (t.kind === 'adt') return ERROR_TYPES.has(t.def.builtin as string) ? 'yes' : 'no';
  if (t.kind === 'ref') return all([t.target]);
  return 'no';
}

/** `String` and `str` as `str`, and `Vec`s, arrays, and slices as slices; through references too. */
function asRef({ solver, t, ref }: Goal): Answer {
  const target = normalize(shallow(ref.args[0]));
  if (t.kind === 'ref') return solver.implements(t.target, ref);
  const isString = t.kind === 'str' || (t.kind === 'adt' && t.def.builtin === 'String');
  // Strings are also their UTF-8 bytes.
  const bytes: Type = { kind: 'slice', elem: { kind: 'int', name: 'u8' } };
  if (isString) {
    return solver.unifier.tryUnify(target, { kind: 'str' }) || solver.unifier.tryUnify(target, bytes) ? 'yes' : 'no';
  }
  const elem =
    t.kind === 'array' || t.kind === 'slice'
      ? t.elem
      : t.kind === 'adt' && t.def.builtin === 'Vec'
        ? t.args[0]
        : undefined;
  if (!elem) return 'no';
  return solver.unifier.tryUnify(target, { kind: 'slice', elem }) ? 'yes' : 'no';
}

/** A `usize`, or a range of them. */
function sliceIndex({ solver, t }: Goal): Answer {
  if (t.kind === 'int') return t.name === 'usize' ? 'yes' : 'no';
  if (t.kind !== 'adt' || !RANGE_TYPES.has(t.def.builtin as string)) return t.kind === 'var' ? 'unknown' : 'no';
  return t.args.every((arg) => solver.unifier.tryUnify(arg, USIZE)) ? 'yes' : 'no';
}

function signedness({ t, name }: Goal): Answer {
  return t.kind === 'int' && isSigned(t.name) === (name === 'SignedInteger') ? 'yes' : 'no';
}

function fromStr({ t }: Goal): Answer {
  if (t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char') return 'yes';
  return t.kind === 'adt' && t.def.builtin === 'String' ? 'yes' : 'no';
}

/** A pattern whose searcher finds the same matches from either end: not a string (`DoubleEndedSearcher`). */
function doubleEndedPattern({ solver, t }: Goal): Answer {
  const target = t.kind === 'ref' ? normalize(shallow(t.target)) : undefined;
  if (target && (target.kind === 'str' || target.kind === 'ref' || isBuiltin(target, 'String'))) return 'no';
  return builtinImplements(solver, t, { trait: solver.program.traitDef('Pattern'), args: [] });
}

function pattern(goal: Goal): Answer {
  const { solver, t } = goal;
  if (t.kind === 'char') return 'yes';
  if (t.kind === 'fn') {
    return t.params.length === 1 &&
      solver.unifier.tryUnify(t.params[0], { kind: 'char' }) &&
      solver.unifier.tryUnify(t.ret, { kind: 'bool' })
      ? 'yes'
      : 'no';
  }
  if (t.kind === 'closure') {
    return solver.implements(t, {
      trait: solver.program.traitDef('FnMut'),
      args: [],
      fnSig: { params: [{ kind: 'char' }], ret: { kind: 'bool' } },
    });
  }
  if (t.kind === 'ref') return referencePattern(goal, shallow(t.target));
  if (t.kind === 'array' && shallow(t.elem).kind === 'char') return 'yes';
  return 'no';
}

function referencePattern({ solver, ref }: Goal, target: Type): Answer {
  if (target.kind === 'str') return 'yes';
  if (target.kind === 'var') return 'unknown';
  if (target.kind === 'adt' && target.def.builtin === 'String') return 'yes';
  if (target.kind === 'ref') return builtinImplements(solver, target, ref);
  if ((target.kind === 'array' || target.kind === 'slice') && shallow(target.elem).kind === 'char') return 'yes';
  return 'no';
}

/** What implements `Borrow<[T]>`, as `Concat` and `Join` take it: arrays, vectors, and slices by reference. */
function sliceOf({ solver, t, ref }: Goal): Answer {
  const elem = borrowedSliceElem(t);
  if (elem === 'unknown') return 'unknown';
  return elem && solver.unifier.tryUnify(elem, ref.args[0]) ? 'yes' : 'no';
}

/** `Join` separates by an element or by a slice of elements. */
function joinSeparator({ solver, t, ref }: Goal): Answer {
  if (t.kind !== 'ref') return t.kind === 'var' ? 'unknown' : 'no';
  const target = normalize(shallow(t.target));
  return solver.unifier.tryUnify(target.kind === 'slice' ? target.elem : target, ref.args[0]) ? 'yes' : 'no';
}

function rangeBounds({ solver, t, ref }: Goal): Answer {
  if (t.kind !== 'adt') return 'no';
  if (!RANGE_TYPES.has(t.def.builtin as string)) return 'no';
  if (t.def.builtin === 'RangeFull') return 'yes';
  return solver.unifier.tryUnify(t.args[0], ref.args[0]) ? 'yes' : 'no';
}

function borrow({ solver, t, ref }: Goal): Answer {
  const [q] = ref.args;
  // The type a key is looked up by comes from the argument (`set.contains(&[1][..])` by `[i32]`).
  const target = shallow(q);
  if (target.kind === 'var' && !target.v.literal) return 'unknown';
  if (solver.unifier.tryUnify(t, q)) return 'yes';
  if (t.kind === 'adt' && t.def.builtin === 'String' && target.kind === 'str') return 'yes';
  if (t.kind === 'adt' && t.def.builtin === 'Vec' && target.kind === 'slice') {
    return solver.unifier.tryUnify(t.args[0], target.elem) ? 'yes' : 'no';
  }
  if (t.kind === 'ref' && solver.unifier.tryUnify(t.target, q)) return 'yes';
  if (t.kind === 'adt' && t.def.builtin === 'Box' && solver.unifier.tryUnify(t.args[0], q)) return 'yes';
  return 'no';
}

function iterator({ solver, t, ref, name }: Goal): Answer {
  if (t.kind === 'var') return 'unknown';
  if (name === 'Iterator' && !isIterator(t)) return 'no';
  const item = intoIterItem(t);
  if (!item) return 'no';
  return !ref.item || solver.unifier.tryUnify(item, ref.item) ? 'yes' : 'no';
}

/** A collection of `T` extends from `T`s, and from `&T`s when `T` is `Copy`. */
function extendInto({ solver, t, ref }: Goal): Answer {
  const [target] = ref.args;
  if (solver.unifier.tryUnify(t, target)) return 'yes';
  if (t.kind === 'ref' && !t.mutable) {
    const snapshot = solver.unifier.snapshot();
    if (solver.unifier.unify(t.target, target) && solver.isCopy(t.target)) return 'yes';
    solver.unifier.rollback(snapshot);
  }
  return 'no';
}

/** Collections of `Copy` elements also extend from references to them. */
function extend({ solver, t, ref }: Goal): Answer {
  const item = shallow(ref.args[0]);
  if (item.kind === 'ref' && t.kind === 'adt' && t.args.length === 1) {
    const snapshot = solver.unifier.snapshot();
    if (solver.unifier.unify(item.target, t.args[0]) && solver.isCopy(item.target)) return 'yes';
    solver.unifier.rollback(snapshot);
  }
  return fromIterator(solver, t, ref.args[0]);
}

function sum(goal: Goal): Answer {
  const { solver, t, ref } = goal;
  const [item] = ref.args;
  if (t.kind === 'adt' && (t.def.builtin === 'Result' || t.def.builtin === 'Option')) return fallibleSum(goal, t);
  if (t.kind !== 'int' && t.kind !== 'float') return 'no';
  const element = shallow(item);
  const inner = element.kind === 'ref' ? shallow(element.target) : element;
  if (inner.kind === 'var') return solver.unifier.tryUnify(inner, t) ? 'yes' : 'unknown';
  return solver.unifier.tryUnify(inner, t) ? 'yes' : 'no';
}

/** `Result<T, E>` sums `Result<U, E>`s and `Option<T>` sums `Option<U>`s when `T` sums `U`s, stopping at an error. */
function fallibleSum({ solver, ref }: Goal, t: AdtType): Answer {
  const element = normalize(shallow(ref.args[0]));
  if (element.kind === 'var') return 'unknown';
  if (element.kind !== 'adt' || element.def !== t.def) return 'no';
  if (t.def.builtin === 'Result' && !solver.unifier.tryUnify(t.args[1], element.args[1])) return 'no';
  return solver.implements(t.args[0], { trait: ref.trait, args: [element.args[0]] });
}

/** `From<source>` for `t` (or `Into<target>` for `t`), from the standard library's conversions and user impls. */
function fromInto({ solver, t, ref }: Goal): Answer {
  if (ref.trait.builtin === 'Into') {
    const target = ref.args[0];
    return solver.implements(target, { trait: solver.program.traitDef('From'), args: [t] });
  }
  const source = normalize(shallow(ref.args[0]));
  if (source.kind === 'var') return 'unknown';
  if (source.kind === 'adt' && ['ParseError', 'Unsigned', 'Signed', 'Indexed'].includes(source.def.builtin as string))
    return 'unknown';
  if (solver.unifier.tryUnify(t, source)) return 'yes';
  return conversionExists(solver, source, t) ? 'yes' : 'no';
}

/** Integers convert to each other, failing out of range; `char`s from `u32`s, and `u8`s from `char`s. */
function tryFrom({ t, ref, name }: Goal): Answer {
  const other = normalize(shallow(ref.args[0]));
  const [source, target] = name === 'TryFrom' ? [other, t] : [t, other];
  if (source.kind === 'var' || target.kind === 'var') return unresolvedTryFrom(source, target);
  if (source.kind === 'int' && target.kind === 'int') return 'yes';
  if (target.kind === 'char' && source.kind === 'int' && source.name === 'u32') return 'yes';
  if (source.kind === 'char' && target.kind === 'int' && target.name === 'u8') return 'yes';
  return infallibleConversion(source, target) ? 'yes' : 'no';
}

/** A conversion from or to a type not known yet, which no float literal has. */
function unresolvedTryFrom(source: Type, target: Type): Answer {
  const literal = source.kind === 'var' ? source.v.literal : target.kind === 'var' ? target.v.literal : undefined;
  return literal === 'float' ? 'no' : 'unknown';
}

function fromIterator(solver: TraitSolver, t: Type, item: Type): Answer {
  if (t.kind !== 'adt') return 'no';
  const element = shallow(item);
  switch (t.def.builtin) {
    case 'Vec':
    case 'VecDeque':
    case 'HashSet':
    case 'BTreeSet':
    case 'BinaryHeap': {
      return solver.unifier.tryUnify(t.args[0], item) ? 'yes' : 'no';
    }
    case 'Box': {
      return boxFromIterator(solver, shallow(t.args[0]), item, element);
    }
    case 'String': {
      return stringFromIterator(element);
    }
    case 'HashMap':
    case 'BTreeMap': {
      return solver.unifier.tryUnify({ kind: 'tuple', elems: t.args }, item) ? 'yes' : 'no';
    }
    case 'Result':
    case 'Option': {
      const inner = freshVar();
      const args = t.def.builtin === 'Result' ? [inner, t.args[1]] : [inner];
      if (!solver.unifier.tryUnify(item, solver.program.builtinType(t.def.builtin, args))) return 'no';
      return solver.implements(t.args[0], { trait: solver.program.traitDef('FromIterator'), args: [inner] });
    }
    default: {
      return 'no';
    }
  }
}

function stringFromIterator(element: Type): Answer {
  if (element.kind === 'var') return 'unknown';
  if (element.kind === 'char') return 'yes';
  return isStringPart(element) ? 'yes' : 'no';
}

function boxFromIterator(solver: TraitSolver, inner: Type, item: Type, element: Type): Answer {
  if (inner.kind === 'slice') return solver.unifier.tryUnify(inner.elem, item) ? 'yes' : 'no';
  if (inner.kind === 'str') return element.kind === 'var' ? 'unknown' : isStringPart(element) ? 'yes' : 'no';
  return 'no';
}

/** A derive bounds every type parameter by the trait, as `#[derive]` does. */
function derived({ t, name, all }: Goal): Answer | undefined {
  if (t.kind !== 'adt') return undefined;
  return t.def.derives.has(name) ? all(t.args) : undefined;
}

function isPrimitive(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char';
}

/**
 * Whether a closure is `Copy` (or `Clone`), which it is when what it captures is: a shared reference always, a
 * `&mut` never, a value when its type is.
 */
function closureCaptures(t: Type & { kind: 'closure' }, all: (types: Type[]) => Answer): Answer {
  const captures = t.closure.captures ?? [];
  if (captures.some((capture) => capture.mode === 'mut')) return 'no';
  return all(captures.filter((capture) => capture.mode === 'value').map((capture) => capture.type));
}

function isShapeType(type: Type): boolean {
  const t = normalize(shallow(type));
  return t.kind === 'adt' && isIteratorShape(t.def);
}

/**
 * What `String` (and `Box<str>`) collect from and extend with: `char`s, `&char`s, `&str`s, `String`s, and `Box<str>`s,
 * but not `&String`s.
 */
function isStringPart(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'char') return true;
  if (t.kind === 'adt')
    return t.def.builtin === 'String' || (t.def.builtin === 'Box' && shallow(t.args[0]).kind === 'str');
  if (t.kind !== 'ref') return false;
  const target = normalize(shallow(t.target));
  return target.kind === 'str' || target.kind === 'char';
}

function borrowedSliceElem(type: Type): Type | 'unknown' | undefined {
  if (type.kind === 'var') return 'unknown';
  if (type.kind === 'array') return type.elem;
  if (type.kind === 'adt' && type.def.builtin === 'Vec') return type.args[0];
  if (type.kind === 'adt' && type.def.builtin === 'Box') {
    const inner = normalize(shallow(type.args[0]));
    return inner.kind === 'slice' ? inner.elem : undefined;
  }
  if (type.kind !== 'ref') return undefined;
  const target = normalize(shallow(type.target));
  if (target.kind === 'var') return 'unknown';
  return target.kind === 'slice' ? target.elem : undefined;
}

/** Whether a type is an iterator itself, not only a collection that makes one: `IterImpl`, a range, or `&mut` of one. */
function isIterator(type: Type): boolean {
  const t = type.kind === 'ref' && type.mutable ? normalize(shallow(type.target)) : type;
  if (t.kind === 'param' || t.kind === 'opaque') return true;
  return (
    t.kind === 'adt' && ['Iter', 'Range', 'RangeInclusive', 'RangeFrom', 'CaseIter'].includes(t.def.builtin as string)
  );
}
