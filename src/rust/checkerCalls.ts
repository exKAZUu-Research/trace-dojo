import type { PathRes, ReceiverAdjust } from './annotations';
import type { Expr } from './ast';
import type { Checker } from './checker';
import { closureSignature } from './checkerClosures';
import { rejectStaticMutBorrow } from './checkerOperators';
import {
  applyWrittenFnArgs,
  checkMethodVisible,
  checkTraitInScope,
  isStandardType,
  rejectDropCall,
  resolveValuePath,
  traitInScope,
  typeOfRes,
} from './checkerPaths';
import { requireMutablePlace } from './checkerPlaces';
import { normalize } from './infer';
import type { Module, Program } from './items';
import { compileError } from './items';
import { failedInherentBound } from './methodBounds';
import { autoderefSteps, boundsOf, derefOnce, lookupMethod } from './methods';
import { reborrowsIterator } from './receiverReborrow';
import { typeAfter } from './regions';
import {
  adt,
  type ClosureType,
  type DerefKind,
  type FnDef,
  hasVars,
  intType,
  isBuiltin,
  ref,
  REF_STR,
  resolve,
  type SelfWrapper,
  shallow,
  type Subst,
  substitute,
  type TraitDef,
  type Type,
  typeToString,
  UNIT,
} from './types';

export function checkCall(c: Checker, expr: Extract<Expr, { kind: 'call' }>, expected: Type | undefined): Type {
  const { callee } = expr;
  if (callee.kind === 'path') {
    const res = resolveValuePath(c, callee.path, callee.span);
    c.annotations.paths.set(callee, res);
    if (res.kind === 'fn' && res.fn.ast?.isUnsafe) c.requireUnsafe(callee.span, 'unsafe fn を呼ぶこと');
    if (res.kind === 'fn') {
      rejectDropCall(res.fn, callee.span);
      return callFn(c, expr, res.fn, res.typeArgs, expected);
    }
    if (res.kind === 'ctor') return callCtor(c, expr, res, expected);
    const type = typeOfRes(c, res, callee.span, undefined);
    callee.ty = type;
    return callValue(c, expr, type, expected);
  }
  const type = c.expr(callee, undefined);
  return callValue(c, expr, type, expected);
}

/** rustc rejects calling `Drop::drop` in any form, which would drop the value a second time. */
function callFn(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  fn: FnDef,
  typeArgs: Type[],
  expected: Type | undefined
): Type {
  if (fn.nativeKey === 'Turtle::new') return turtleNew(c, expr);
  const sig = c.instantiate(fn, typeArgs, expr.span);
  const params = fn.selfMode ? [selfParamType(fn, sig.subst), ...sig.params] : sig.params;
  if (expr.args.length !== params.length) {
    compileError(
      expr.span,
      `関数 ${fn.name} の引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`
    );
  }
  const iterable = fn.selfMode ? [false, ...iterableParams(fn)] : iterableParams(fn);
  checkArgs(c, expr.args, params, expectations(c, sig.ret, params, expected), iterable);
  if (fn.selfMode === 'value' && !fn.selfWrapper) c.requireTrait(params[0], 'Sized', expr.args[0].span);
  expr.callee.ty = { kind: 'fn', params, ret: sig.ret };
  return sig.ret;
}

export function selfParamType(fn: FnDef, subst: Subst): Type {
  const self = fn.trait ? ({ kind: 'param', param: fn.trait.self } as Type) : (fn.impl?.selfType ?? UNIT);
  const selfType = substitute(self, subst);
  if (fn.selfMode === 'value') {
    return wrapSelf((fn.module as Module).program, fn.selfWrapper, selfType);
  }
  return ref(selfType, fn.selfMode === 'mutRef');
}

/** The type of a `self` whose declared type is `wrapper` around `Self`. */
export function wrapSelf(program: Program, wrapper: SelfWrapper | undefined, selfType: Type): Type {
  if (!wrapper) return selfType;
  return program.builtinType(wrapper, [wrapper === 'Pin' ? ref(selfType, true) : selfType]);
}

function turtleNew(c: Checker, expr: Extract<Expr, { kind: 'call' }>): Type {
  const { args } = expr;
  if (args.length > 0 && args.length !== 2 && args.length !== 3) {
    compileError(
      expr.span,
      'Turtle::new には、引数を書かないか、x と y、または x と y と色（"R" など）を書いてください。'
    );
  }
  if (args.length >= 2) {
    c.coerceExpr(args[0], intType('i32'));
    c.coerceExpr(args[1], intType('i32'));
  }
  if (args.length === 3) c.coerceExpr(args[2], REF_STR);
  const turtle = c.program.builtinType('Turtle');
  expr.callee.ty = { kind: 'fn', params: args.map((arg) => arg.ty ?? UNIT), ret: turtle };
  return turtle;
}

function callCtor(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  res: Extract<PathRes, { kind: 'ctor' }>,
  expected: Type | undefined
): Type {
  const variant = res.def.variants[res.variant];
  if (variant.shape !== 'tuple') {
    if (variant.shape === 'unit')
      compileError(expr.span, `${variant.name} は引数を取りません（() を消してください）。`);
    compileError(expr.span, `${variant.name} は、${variant.name} { ... } の形で作ってください。`);
  }
  const self = adt(res.def, res.typeArgs);
  const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
  const params = variant.fields.map((field) => substitute(field.type, subst));
  if (expr.args.length !== params.length) {
    compileError(
      expr.span,
      `${variant.name} の引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`
    );
  }
  c.requireAdtArguments(res.def, res.typeArgs, expr.span);
  checkArgs(c, expr.args, params, expectations(c, self, params, expected));
  expr.callee.ty = { kind: 'fn', params, ret: self };
  return self;
}

/**
 * The types the arguments of a call are expected to have when its result is expected to have a type: a hint for
 * checking them, as rustc derives it by unifying tentatively, which the arguments' own types may still override
 * through coercions (`let b: Box<dyn T> = Box::new(s)`).
 */
function expectations(c: Checker, ret: Type, params: Type[], expected: Type | undefined): (Type | undefined)[] {
  if (!expected) return [];
  const snapshot = c.unifier.snapshot();
  const unified = c.unifier.unify(ret, expected);
  const result = unified ? params.map((param) => resolve(param)) : [];
  c.unifier.rollback(snapshot);
  return result;
}

/**
 * The parameters of a function of the standard library that are declared as iterators, which stand for
 * `IntoIterator` parameters and so take whatever iterates; one that only becomes an iterator type by its type
 * arguments (`Vec<IntoIter<i32>>::push`) takes that type alone.
 */
function iterableParams(fn: FnDef): boolean[] {
  if (!(fn.module as Module).isStd) return [];
  return fn.paramTypes.map((type) => {
    const t = shallow(type);
    return t.kind === 'adt' && t.def.builtin === 'Iter';
  });
}

function checkArgs(
  c: Checker,
  args: Expr[],
  params: Type[],
  expectations: (Type | undefined)[] = [],
  iterable: boolean[] = []
): void {
  // Closures are checked last, when the other arguments have told their parameters' types.
  const order = [...args.keys()].toSorted(
    (a, b) => Number(args[a].kind === 'closure') - Number(args[b].kind === 'closure')
  );
  const inputTypes = params.map((param) => shallow(param));
  const enclosing = c.iterableArgument;
  for (const index of order) {
    c.iterableArgument = iterable[index] ? args[index] : undefined;
    // A parameter whose type is an associated type (`o: T::O`) learns it from the bounds that the arguments before
    // it settled, so the argument coerces to it (`&String` to `&str`) as rustc normalizes it first.
    if (inputTypes[index].kind === 'var') inputTypes[index] = shallow(c.settledAssoc(params[index]));
    checkArgument(c, args[index], params[index], inputTypes[index], expectations[index]);
  }
  c.iterableArgument = enclosing;
}

function checkArgument(c: Checker, arg: Expr, param: Type, inputType: Type, expectation: Type | undefined): void {
  if (arg.kind === 'closure') {
    const sig = closureSignature(c, param);
    if (sig) {
      const type = c.expr(arg, { kind: 'fn', params: sig.params, ret: sig.ret });
      coerceClosure(c, arg, type, param);
      return;
    }
  }
  if (expectation && hasVars(param)) {
    const type = c.expr(arg, expectation);
    // An argument coerces to the type its expected input has (`Some(&s)` as an `Option<&str>`), unless that type is
    // unsized and only a hint (`Box::new(s)` as a `Box<dyn T>`), as rustc's `rvalue_hint` makes it.
    const target = resolve(expectation);
    const t = normalize(shallow(target));
    if (
      t.kind !== 'dyn' &&
      t.kind !== 'str' &&
      t.kind !== 'slice' &&
      (t.kind === 'ref' || !hasVars(target)) &&
      c.tryCoerce(arg, type, target)
    ) {
      c.unifyOrError(arg.span, param, target);
      c.markReborrows(arg, target);
      return;
    }
    c.coerce(arg, type, param);
  } else c.coerceExpr(arg, param);
  if (inputType.kind !== 'var') c.markReborrows(arg, inputType);
}

function coerceClosure(c: Checker, arg: Expr, type: Type, param: Type): void {
  const p = shallow(param);
  if (p.kind === 'var' || p.kind === 'param') {
    if (p.kind === 'var') c.unifier.tryUnify(p, type);
    return;
  }
  c.coerce(arg, type, param);
}

/** Calls a value: a closure, a function, or a value whose type is bounded by a closure trait. */
// code-gauge-allow functionNcss -- Call rules differ for concrete functions, closures and callable bounds.
// code-gauge-allow functionCognitiveComplexity -- Call rules differ for concrete functions, closures and callable bounds.
function callValue(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  calleeType: Type,
  expected: Type | undefined
): Type {
  let t = normalize(shallow(calleeType));
  // A closure behind a reference or a pointer that owns or shares it (`Box`, `Rc`, `Arc`) is called through it.
  while (t.kind === 'ref' || (t.kind === 'adt' && ['Box', 'Rc', 'Arc'].includes(t.def.builtin ?? ''))) {
    t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
  }
  let params: Type[];
  let ret: Type;
  let kind: ClosureType['kind'];
  if (t.kind === 'closure') {
    params = t.closure.params;
    ret = t.closure.ret;
    kind = t.closure.kind;
  } else if (t.kind === 'fn') {
    if (t.isUnsafe || (t.item && 'ast' in t.item && t.item.ast?.isUnsafe)) {
      c.requireUnsafe(expr.span, 'unsafe fn を呼ぶこと');
    }
    params = t.params;
    ret = t.ret;
    kind = 'Fn';
  } else {
    const bounds = boundsOf(t) ?? [];
    const sig =
      bounds.find((bound) => bound.fnSig && bound.trait.builtin === 'Fn') ??
      bounds.find((bound) => bound.fnSig && bound.trait.builtin === 'FnMut') ??
      bounds.find((bound) => bound.fnSig);
    if (!sig?.fnSig) {
      compileError(expr.callee.span, `${typeToString(resolve(calleeType))} は関数ではないので、呼び出せません。`);
    }
    params = sig.fnSig.params;
    ret = sig.fnSig.ret;
    kind = sig.trait.builtin === 'Fn' || sig.trait.builtin === 'FnMut' ? sig.trait.builtin : 'FnOnce';
  }
  if (kind === 'FnMut') requireCallableMut(c, expr, kind);
  const recordKind = (): void => recordCallKind(c, expr, calleeType, t, kind);
  recordKind();
  if (t.kind === 'closure') t.closure.unsettled?.push(recordKind);
  if (expr.args.length !== params.length) {
    compileError(expr.span, `引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`);
  }
  if (expected) c.unifier.tryUnify(ret, expected);
  checkArgs(c, expr.args, params);
  return ret;
}

/** Records the closure trait a call goes through, which is the callee's own once a closure's captures are settled. */
function recordCallKind(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  calleeType: Type,
  callee: Type,
  declared: ClosureType['kind']
): void {
  const kind = callee.kind === 'closure' ? callee.closure.kind : declared;
  if (
    kind === 'FnOnce' &&
    autoderefSteps(c.program, calleeType)
      .at(-1)
      ?.derefs.some((step) => step !== 'own') &&
    !c.solver.isCopy(callee)
  ) {
    compileError(expr.callee.span, '参照の先の FnOnce クロージャは、値をムーブできないので呼び出せません。');
  }
  c.annotations.callKinds.set(expr, kind);
}

/** Calling an `FnMut` closure borrows it mutably, so its variable must be `mut`. */
function requireCallableMut(c: Checker, expr: Extract<Expr, { kind: 'call' }>, kind: string): void {
  c.deferredChecks.push(() => {
    const callee = expr.callee;
    const adjustment = autoderefSteps(c.program, callee.ty ?? UNIT).at(-1)!;
    const actual = adjustment.type.kind === 'closure' ? adjustment.type.closure.kind : kind;
    if (actual !== 'FnMut') return;
    if (adjustment.derefs.includes('ref')) {
      compileError(callee.span, '& の参照を通して FnMut のクロージャは呼び出せません。');
    }
    requireMutablePlace(c, callee, 'FnMut のクロージャを呼び出す', adjustment.derefs);
  });
}

// code-gauge-allow functionNcss -- Follows rustc's method probe and its checks step by step.
export function checkMethodCall(
  c: Checker,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  expected: Type | undefined
): Type {
  const receiverType = c.settled(c.expr(expr.receiver, undefined));
  const resolvedReceiver = normalize(shallow(receiverType));
  let stripped = resolvedReceiver;
  while (stripped.kind === 'ref') stripped = normalize(shallow(stripped.target));
  if (stripped.kind === 'var' && !stripped.v.literal) {
    c.unknownLocal(expr.receiver);
    compileError(
      expr.methodSpan,
      `型が決まらないので、メソッド ${expr.method} を呼べません（変数の型を書いてください）。`
    );
  }
  const found = lookupMethod(c.program, c.solver, receiverType, expr.method, (trait) => traitInScope(c, trait));
  if (stripped.kind === 'var' && found && found !== 'ambiguous') numberReceiver(c, expr, stripped, found.fn);
  if (found === 'ambiguous') {
    compileError(
      expr.methodSpan,
      `型が決まらないので、メソッド ${expr.method} を呼べません（変数の型を書いてください）。`
    );
  }
  if (!found) return noMethod(c, expr, receiverType);
  if (found.ambiguousWith) {
    const first = (found.fn.trait ?? found.fn.impl?.trait?.trait) as TraitDef;
    compileError(
      expr.methodSpan,
      `メソッド ${expr.method} は、トレイト ${first.name} と ${found.ambiguousWith.name} の両方にあります（${first.name}::${expr.method}(...) の形で、どちらかを選んでください）。`
    );
  }
  checkMethodVisible(c, found.fn, expr.methodSpan);
  checkTraitInScope(c, found.fn, stripped, expr.methodSpan, `メソッド ${expr.method}`);
  const { fn } = found;
  applyWrittenFnArgs(c, fn, found.typeArgs, expr.turbofish, expr.methodSpan);
  checkReceiverAdjust(c, expr, found.adjust, fn.selfMode);
  const throughReference = found.adjust.derefs.some((step) => step === 'ref' || step === 'mutRef');
  if (found.adjust.autoref !== 'none' && !throughReference) rejectStaticMutBorrow(c, expr.receiver, expr.receiver.span);
  const sig = c.instantiate(fn, found.typeArgs, expr.methodSpan);
  if (expr.args.length !== sig.params.length) {
    compileError(
      expr.methodSpan,
      `メソッド ${expr.method} の引数の数が合いません（${sig.params.length} 個ですが、${expr.args.length} 個あります）。`
    );
  }
  checkArgs(c, expr.args, sig.params, expectations(c, sig.ret, sig.params, expected), iterableParams(fn));
  if (fn.ast?.isUnsafe) c.requireUnsafe(expr.span, 'unsafe fn を呼ぶこと');
  rejectDropCall(fn, expr.methodSpan);
  c.annotations.methods.set(expr, { fn, typeArgs: found.typeArgs, receiver: found.adjust });
  const adjusted = typeAfter(receiverType, found.adjust.derefs) ?? found.selfType;
  if (fn.selfMode === 'value') checkSelfMove(c, expr, fn, found, receiverType);
  if (expr.method === 'map') return arrayMapResult(adjusted, found.selfType, sig.ret);
  return sig.ret;
}

/**
 * On a number whose type is not yet known, rustc finds trait methods (`1.cmp(&2)`) but no inherent ones; the
 * program's own trait impl for a number type gives the number that type.
 */
function numberReceiver(c: Checker, expr: Extract<Expr, { kind: 'methodCall' }>, number: Type, fn: FnDef): void {
  const ownImpl = fn.impl?.trait && !(fn.module as Module).isStd ? fn.impl : undefined;
  if (ownImpl) {
    const implSelf = normalize(shallow(ownImpl.selfType));
    if (implSelf.kind === 'int' || implSelf.kind === 'float') c.unifier.tryUnify(number, implSelf);
  } else if (!fn.trait || fn.impl) {
    compileError(
      expr.methodSpan,
      `数の型が決まらないので、メソッド ${expr.method} を呼べません（5_i32 や 2.0_f64 のように、型を書いてください）。`
    );
  }
}

function noMethod(c: Checker, expr: Extract<Expr, { kind: 'methodCall' }>, receiverType: Type): never {
  const snapshot = c.unifier.snapshot();
  const candidate = lookupMethod(c.program, c.solver, receiverType, expr.method);
  c.unifier.rollback(snapshot);
  const trait = candidate && candidate !== 'ambiguous' && (candidate.fn.trait ?? candidate.fn.impl?.trait?.trait);
  if (trait && !traitInScope(c, trait)) {
    compileError(
      expr.methodSpan,
      `メソッド ${expr.method} はトレイト ${trait.name} のものなので、use でトレイトを取り込んでください。`
    );
  }
  const missing = failedInherentBound(c.program, c.solver, receiverType, expr.method);
  const t = typeToString(resolve(receiverType));
  if (missing === 'otherNumber') compileError(expr.methodSpan, `${t} にメソッド ${expr.method} がありません。`);
  if (missing) c.require(missing.type, missing.ref, expr.methodSpan);
  const fieldType = fieldTypeOf(c, receiverType, expr.method);
  if (fieldType) {
    compileError(
      expr.methodSpan,
      `${expr.method} はフィールドです。フィールドの関数を呼ぶには (x.${expr.method})(...) と書きます。`
    );
  }
  const hints: Record<string, string> = {
    length: '（長さは len() です）',
    size: '（長さは len() です）',
    charAt: '（文字は chars().nth(i) で取り出します）',
    equals: '（比べるには == を使います）',
    toString: '（to_string() です）',
    toUpperCase: '（to_uppercase() です）',
  };
  const receiverTypes = autoderefSteps(c.program, receiverType).map((step) => step.type);
  const vecHint = ['push_back', 'add'].includes(expr.method) && receiverTypes.some((type) => isBuiltin(type, 'Vec'));
  const hint = vecHint ? '（Vec では push です）' : hints[expr.method];
  if (hint === undefined && receiverTypes.some(isStandardType)) {
    compileError(expr.methodSpan, `${t} のメソッド ${expr.method} は、この採点環境では使えません。`);
  }
  compileError(expr.methodSpan, `${t} にメソッド ${expr.method} がありません${hint ?? ''}。`);
}

function fieldTypeOf(c: Checker, type: Type, name: string): Type | undefined {
  for (const step of autoderefSteps(c.program, type)) {
    const t = shallow(step.type);
    if (t.kind === 'adt' && t.def.kind === 'struct') {
      const field = t.def.variants[0]?.fields.find((f) => f.name === name);
      if (field) return field.type;
    }
  }
  return undefined;
}

/** Taking `self` by value through a reference moves out of it, which only `Copy` types allow. */
/**
 * A method taking `self` by value moves the receiver; `self: Box<Self>` takes the `Box`, which method lookup derefs
 * through to `Self`, while lookup stops at an `Rc`, `Arc` or `Pin` itself.
 */
function checkSelfMove(
  c: Checker,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  fn: FnDef,
  found: { adjust: ReceiverAdjust; selfType: Type },
  receiverType: Type
): void {
  const derefs = fn.selfWrapper === 'Box' ? found.adjust.derefs.slice(0, -1) : found.adjust.derefs;
  const adjust = { ...found.adjust, derefs };
  checkMoveOutOfRef(c, expr, adjust, typeThrough(c, receiverType, derefs) ?? found.selfType);
}

/** The type a receiver derefs to through its steps, a `Deref` impl's (`W` to its `Target`) included. */
function typeThrough(c: Checker, receiverType: Type, derefs: DerefKind[]): Type | undefined {
  if (!derefs.includes('user')) return typeAfter(receiverType, derefs);
  let type = receiverType;
  for (let index = 0; index < derefs.length; index++) type = derefOnce(c.program, type)?.type ?? type;
  return type;
}

function checkMoveOutOfRef(
  c: Checker,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  adjust: ReceiverAdjust,
  selfType: Type
): void {
  if (adjust.autoref !== 'none') return;
  if (adjust.asIter && !isBuiltin(shallow(selfType), 'Box')) return;
  if (reborrowsIterator(adjust.derefs, selfType)) return;
  c.requireTrait(selfType, 'Sized', expr.receiver.span);
  // A `Deref` impl (`Rc`, a guard, the program's) lends its target as a reference does; a `Box` owns it.
  const throughRef = adjust.derefs.some((step) => step === 'ref' || step === 'mutRef' || step === 'user');
  if (!throughRef) return;
  c.deferredChecks.push(() => {
    if (!c.solver.isCopy(resolve(selfType, true))) {
      compileError(
        expr.methodSpan,
        `参照の先の値は動かせないので、メソッド ${expr.method}（self を受け取る）を呼べません（.clone() で複製するか、参照のまま使えるメソッドを使ってください）。`
      );
    }
  });
}

/** `&mut self` methods need a mutable place: a `mut` variable, or a place reached through `&mut`. */
function checkReceiverAdjust(
  c: Checker,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  adjust: ReceiverAdjust,
  mode: FnDef['selfMode']
): void {
  if (mode !== 'mutRef') return;
  // An iterator a `&mut` holds (`r.nth(2)` of `r: &mut C`) is reborrowed through it, which needs no `mut` binding.
  const receiver = normalize(shallow(expr.receiver.ty ?? UNIT));
  const throughMut = adjust.asIter && adjust.derefs.length === 0 && receiver.kind === 'ref' && receiver.mutable;
  const derefs = adjust.autoref === 'none' || throughMut ? [...adjust.derefs, 'mutRef' as const] : adjust.derefs;
  if (derefs.includes('ref')) {
    compileError(
      expr.receiver.span,
      `& の参照を通しては、メソッド ${expr.method}（&mut self を受け取る）を呼べません（&mut の参照にしてください）。`
    );
  }
  requireMutablePlace(c, expr.receiver, `メソッド ${expr.method} で書き換える`, derefs);
}

/** An array's `map` gives an array of its length, which the declaration on `[T]` cannot say. */
function arrayMapResult(receiver: Type, selfType: Type, ret: Type): Type {
  const array = normalize(shallow(receiver));
  const self = normalize(shallow(selfType));
  const r = normalize(shallow(ret));
  if (array.kind === 'array' && self.kind === 'slice' && r.kind === 'slice') {
    return { kind: 'array', elem: r.elem, len: array.len };
  }
  return ret;
}
