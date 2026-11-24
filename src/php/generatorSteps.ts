// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { placeOf } from './assignment';
import type { Arg, ArrayItem, ClassRef, Expr, ListItem } from './ast';
import { toBool } from './conversions';
import { notice, throwError } from './errors';
import { GeneratorState } from './generators';
import { ev, evQuiet } from './interp';
import { acquireIterator, InnerIterator } from './iteratorAcquisition';
import { strictEquals } from './operators';
import { share } from './places';
import { PhpThrow, rt } from './runtime';
import { suspends } from './suspension';
import { deref, PhpArray, type PhpClass, PhpObject, type Ref, type Value } from './values';

/** What a `yield` yields: its key, which is undefined when the generator numbers it, and its value. */
export interface YieldRequest {
  key: Value | undefined;
  value: Value | Ref;
  /** Whether the value comes from `yield from`, whose keys leave the generator's own numbering alone. */
  delegated?: boolean;
}

/** The evaluation of a generator's statement part that may suspend at a `yield` and resume with the sent value. */
export type Steps<T> = Generator<YieldRequest, T, Value>;

// Suspending expressions -------------------------------------------------------------------------------------------

/** Evaluates an expression of a generator, suspending at each `yield` it contains with what the `yield` yields. */
export function* evSteps(e: Expr): Steps<Value> {
  if (!suspends(e)) return ev(e);
  switch (e.k) {
    case 'yield': {
      return yield* yieldSteps(e);
    }
    case 'yieldFrom': {
      return yield* yieldFromSteps(e);
    }
    case 'bin': {
      return yield* binarySteps(e);
    }
    case 'cond': {
      const test = yield* evSteps(e.test);
      if (e.consequent === undefined) return toBool(test) ? test : yield* evSteps(e.alternate);
      return toBool(test) ? yield* evSteps(e.consequent) : yield* evSteps(e.alternate);
    }
    case 'match': {
      return yield* matchSteps(e);
    }
    default: {
      return ev(yield* hoist(e, false));
    }
  }
}

const SHORT_CIRCUITS = new Set(['&&', 'and', '||', 'or', '??']);

function* binarySteps(e: Extract<Expr, { k: 'bin' }>): Steps<Value> {
  switch (e.op) {
    case '&&':
    case 'and': {
      return toBool(yield* evSteps(e.l)) && toBool(yield* evSteps(e.r));
    }
    case '||':
    case 'or': {
      return toBool(yield* evSteps(e.l)) || toBool(yield* evSteps(e.r));
    }
    case '??': {
      return evQuiet(yield* hoist(e.l, true), 'coalesce') ?? (yield* evSteps(e.r));
    }
    default: {
      return ev(yield* hoist(e, false));
    }
  }
}

function* matchSteps(e: Extract<Expr, { k: 'match' }>): Steps<Value> {
  const subject = yield* evSteps(e.subject);
  const armsSuspend = e.arms.some((arm) => suspends(arm.body) || arm.conditions?.some(suspends));
  if (!armsSuspend) return ev({ ...e, subject: held(subject, e.subject.row) });
  for (const arm of e.arms) {
    for (const condition of arm.conditions ?? []) {
      if (strictEquals(subject, yield* evSteps(condition))) return yield* evSteps(arm.body);
    }
  }
  const fallback = e.arms.find((arm) => arm.conditions === undefined);
  if (fallback) return yield* evSteps(fallback.body);
  return ev({ ...e, subject: held(subject, e.subject.row), arms: [], jumpTable: false });
}

/**
 * Evaluates the parts of an expression up to its last `yield`, returning the expression with those parts replaced by
 * their values, which no longer suspends. A variable stays to be read when the rest runs, as PHP reads compiled
 * variables when the instruction that uses them runs; a part that `place` marks as a target stays a target.
 */
export function* hoist(e: Expr, place: boolean): Steps<Expr> {
  if (!suspends(e)) return e;
  const hoister = HOISTERS[e.k] as Hoister<Expr> | undefined;
  return hoister ? yield* hoister(e, place) : held(yield* evSteps(e), e.row);
}

type Hoister<E extends Expr> = (e: E, place: boolean) => Steps<Expr>;

/** How each kind of expression that a `yield` may sit in evaluates its parts before the `yield`. */
const HOISTERS: { [K in Expr['k']]?: Hoister<Extract<Expr, { k: K }>> } = {
  *bin(e) {
    if (SHORT_CIRCUITS.has(e.op)) return held(yield* evSteps(e), e.row);
    const [l, r] = yield* hoistAll([
      [e.l, false],
      [e.r, false],
    ]);
    return { ...e, l, r };
  },
  *interp(e) {
    const expressions = e.parts.filter((part): part is Expr => typeof part !== 'string');
    const hoisted = yield* hoistAll(expressions.map((part) => [part, false]));
    let index = 0;
    return { ...e, parts: e.parts.map((part) => (typeof part === 'string' ? part : hoisted[index++])) };
  },
  *varvar(e) {
    return { ...e, name: yield* hoist(e.name, false) };
  },
  *array(e) {
    const hoisted = yield* hoistAll(e.items.flatMap((item) => itemSlots(item.key, item.value, item.byRef)));
    let index = 0;
    const items = e.items.map((item): ArrayItem => {
      const key = item.key ? hoisted[index++] : undefined;
      return { ...item, key, value: hoisted[index++] };
    });
    return { ...e, items };
  },
  *list(e) {
    const hoisted = yield* hoistAll(e.items.flatMap((item) => (item ? itemSlots(item.key, item.target, true) : [])));
    let index = 0;
    const items = e.items.map((item): ListItem | undefined => {
      if (!item) return undefined;
      const key = item.key ? hoisted[index++] : undefined;
      return { ...item, key, target: hoisted[index++] };
    });
    return { ...e, items };
  },
  *idx(e, place) {
    const [base, index] = yield* hoistAll([[e.base, place], ...optionalSlot(e.index)]);
    return { ...e, base, index };
  },
  *prop(e, place) {
    const [obj, name] = yield* hoistAll([[e.obj, place], ...nameSlot(e.name)]);
    return { ...e, obj, name: typeof e.name === 'string' ? e.name : name };
  },
  *sprop(e) {
    const [cls, name] = yield* hoistClassAndName(e.cls, e.name);
    return { ...e, cls, name };
  },
  *cconst(e) {
    const [cls, name] = yield* hoistClassAndName(e.cls, e.name);
    return { ...e, cls, name };
  },
  *call(e) {
    const fnSlots: [Expr, boolean][] = typeof e.fn === 'object' && 'k' in e.fn ? [[e.fn, false]] : [];
    const hoisted = yield* hoistAll([...fnSlots, ...argSlots(e.args)]);
    const fn = fnSlots.length > 0 ? hoisted[0] : e.fn;
    return { ...e, fn, args: withArgs(e.args, hoisted.slice(fnSlots.length)) };
  },
  *mcall(e) {
    const nameSlots = nameSlot(e.name);
    const hoisted = yield* hoistAll([[e.obj, false], ...nameSlots, ...argSlots(e.args)]);
    const name = typeof e.name === 'string' ? e.name : hoisted[1];
    return { ...e, obj: hoisted[0], name, args: withArgs(e.args, hoisted.slice(1 + nameSlots.length)) };
  },
  *scall(e) {
    const [cls, name] = yield* hoistClassAndName(e.cls, e.name);
    return { ...e, cls, name, args: withArgs(e.args, yield* hoistAll(argSlots(e.args))) };
  },
  *new(e) {
    const [cls] = yield* hoistClassAndName(e.cls, '');
    return { ...e, cls, args: withArgs(e.args, yield* hoistAll(argSlots(e.args))) };
  },
  *newAnon(e) {
    return { ...e, args: withArgs(e.args, yield* hoistAll(argSlots(e.args))) };
  },
  *assign(e) {
    const [target, value] = yield* hoistAll([
      [e.target, true],
      [e.value, false],
    ]);
    return { ...e, target, value };
  },
  *assignOp(e) {
    const [target, value] = yield* hoistAll([
      [e.target, true],
      [e.value, false],
    ]);
    return { ...e, target, value };
  },
  *assignRef(e) {
    const [target, source] = yield* hoistAll([
      [e.target, true],
      [e.source, true],
    ]);
    return { ...e, target, source };
  },
  *incdec(e) {
    return { ...e, target: yield* hoist(e.target, true) };
  },
  unary: hoistOperand,
  cast: hoistOperand,
  silence: hoistOperand,
  clone: hoistOperand,
  throw: hoistOperand,
  print: hoistOperand,
  *empty(e) {
    return { ...e, e: yield* hoist(e.e, true) };
  },
  *isset(e) {
    return { ...e, items: yield* hoistAll(e.items.map((item) => [item, true])) };
  },
  *instanceof(e) {
    const [subject, classExpression] = yield* hoistAll([[e.e, false], ...classSlot(e.cls)]);
    const cls: ClassRef = e.cls.k === 'expr' ? { ...e.cls, e: classExpression } : e.cls;
    return { ...e, e: subject, cls };
  },
  *pipe(e) {
    const [l, r] = yield* hoistAll([
      [e.l, false],
      [e.r, false],
    ]);
    return { ...e, l, r };
  },
};

function* hoistOperand<E extends Extract<Expr, { e: Expr }>>(e: E): Steps<Expr> {
  return { ...e, e: yield* hoist(e.e, false) };
}

function itemSlots(key: Expr | undefined, value: Expr, place: boolean): [Expr, boolean][] {
  return [...optionalSlot(key), [value, place]];
}

function optionalSlot(e: Expr | undefined): [Expr, boolean][] {
  return e ? [[e, false]] : [];
}

function nameSlot(name: string | Expr): [Expr, boolean][] {
  return typeof name === 'string' ? [] : [[name, false]];
}

function classSlot(cls: ClassRef): [Expr, boolean][] {
  return cls.k === 'expr' ? [[cls.e, false]] : [];
}

function* hoistClassAndName<N extends string | Expr>(cls: ClassRef, name: N): Steps<[ClassRef, N]> {
  const classSlots = classSlot(cls);
  const hoisted = yield* hoistAll([...classSlots, ...nameSlot(name)]);
  const hoistedClass: ClassRef = cls.k === 'expr' ? { ...cls, e: hoisted[0] } : cls;
  const hoistedName = (typeof name === 'string' ? name : hoisted[classSlots.length]) as N;
  return [hoistedClass, hoistedName];
}

const VARIABLE_KINDS = new Set(['var', 'varvar', 'idx', 'prop', 'sprop', 'list']);

function argSlots(args: Arg[]): [Expr, boolean][] {
  return args.map((arg) => [arg.e, VARIABLE_KINDS.has(arg.e.k)]);
}

function withArgs(args: Arg[], hoisted: Expr[]): Arg[] {
  return args.map((arg, index) => ({ ...arg, e: hoisted[index] }));
}

/** Hoists parts evaluated in order: those before the last that suspends are evaluated now, those after it stay. */
function* hoistAll(slots: [Expr, boolean][]): Steps<Expr[]> {
  let last = -1;
  for (const [index, [e]] of slots.entries()) if (suspends(e)) last = index;
  const result: Expr[] = [];
  for (const [index, [e, place]] of slots.entries()) {
    if (index > last) result.push(e);
    else if (suspends(e)) result.push(yield* hoist(e, place));
    else result.push(freeze(e, place));
  }
  return result;
}

/** Evaluates a part that comes before a `yield`, unless PHP reads it only when the instruction using it runs. */
function freeze(e: Expr, place: boolean): Expr {
  switch (e.k) {
    case 'lit':
    case 'var':
    case 'const':
    case 'magic':
    case 'held':
    case 'closure':
    case 'arrow': {
      return e;
    }
    case 'idx': {
      if (!place) break;
      return { ...e, base: freeze(e.base, true), index: e.index && freeze(e.index, false) };
    }
    case 'prop': {
      if (!place) break;
      return { ...e, obj: freeze(e.obj, true), name: typeof e.name === 'string' ? e.name : freeze(e.name, false) };
    }
    case 'sprop':
    case 'list':
    case 'varvar': {
      if (place) return e;
      break;
    }
  }
  return held(ev(e), e.row);
}

/** A value evaluated before a `yield`, which the generator's frame holds until its statement ends. */
function held(v: Value, row: number): Expr {
  if (v instanceof PhpArray || v instanceof PhpObject) {
    const temporaries = rt().frame.temporaries;
    if (!temporaries.includes(v)) temporaries.push(v);
  }
  return { k: 'held', v, row };
}

// Yield ------------------------------------------------------------------------------------------------------------

function* yieldSteps(e: Extract<Expr, { k: 'yield' }>): Steps<Value> {
  const runtime = rt();
  const key = e.key ? yield* evSteps(e.key) : undefined;
  let value: Value | Ref = null;
  if (e.value && e.byRef && VARIABLE_KINDS.has(e.value.k)) {
    const ref = placeOf(yield* hoist(e.value, true)).ref();
    ref.isRef = true;
    value = ref;
  } else if (e.value) {
    value = share(yield* evSteps(e.value));
    runtime.row = e.row;
    if (e.byRef) notice('Only variable references should be yielded by reference');
  }
  runtime.row = e.row;
  const sent = yield { key, value };
  runtime.row = e.row;
  return sent;
}

function* yieldFromSteps(e: Extract<Expr, { k: 'yieldFrom' }>): Steps<Value> {
  const runtime = rt();
  const subject = yield* evSteps(e.e);
  runtime.row = e.row;
  if (subject instanceof PhpArray) {
    runtime.frame.temporaries.push(share(subject));
    for (const [key, slot] of subject.foreachEntries()) yield { key, value: deref(slot), delegated: true };
    return null;
  }
  if (subject instanceof PhpObject && subject.internal instanceof GeneratorState)
    return yield* delegateSteps(subject.internal, e.row);
  if (subject instanceof PhpObject && !subject.isResource) {
    const traversable = runtime.classes.get('traversable') as PhpClass;
    if (subject.cls.isSubclassOf(traversable)) return yield* traverseSteps(subject);
  }
  throwError('Error', 'Can use "yield from" only with arrays and Traversables');
}

function* delegateSteps(inner: GeneratorState, row: number): Steps<Value> {
  if (inner.status === 'running') throwError('Error', 'Impossible to yield from the Generator being currently run');
  inner.ensureInitialized();
  while (!inner.isFinished()) {
    let sent: Value;
    try {
      sent = yield { key: inner.key, value: inner.value, delegated: true };
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      rt().row = row;
      inner.resume({ k: 'throw', error });
      continue;
    }
    rt().row = row;
    inner.resume({ k: 'send', v: sent });
  }
  if (!inner.returned)
    throwError('Error', 'Generator passed to yield from was aborted without proper return and is unable to continue');
  return inner.returned.v;
}

function* traverseSteps(subject: PhpObject): Steps<Value> {
  const runtime = rt();
  const acquired = acquireIterator(subject);
  if (!acquired) return null;
  const iterator = new InnerIterator(acquired.iterator, acquired.handle);
  runtime.frame.temporaries.push(acquired.handle);
  iterator.rewind();
  while (iterator.valid()) {
    const value = iterator.current();
    const key = iterator.key();
    yield { key, value, delegated: true };
    iterator.next();
  }
  return null;
}
