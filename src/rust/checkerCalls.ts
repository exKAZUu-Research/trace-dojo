import type { PathRes, ReceiverAdjust } from './annotations';
import type { Expr } from './ast';
import type { Checker } from './checker';
import {
  checkMethodVisible,
  checkTraitInScope,
  resolveValuePath,
  traitInScope,
  typeArgsFor,
  typeOfRes,
} from './checkerPaths';
import { requireMutablePlace } from './checkerPlaces';
import { normalize } from './infer';
import type { Module } from './items';
import { compileError } from './items';
import { autoderefSteps, boundsOf, lookupMethod } from './methods';
import {
  adt,
  type FnDef,
  hasVars,
  intType,
  ref,
  REF_STR,
  resolve,
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
    if (res.kind === 'fn') return callFn(c, expr, res.fn, res.typeArgs, expected);
    if (res.kind === 'ctor') return callCtor(c, expr, res, expected);
    const type = typeOfRes(c, res, callee.span, undefined);
    callee.ty = type;
    return callValue(c, expr, type, expected);
  }
  const type = c.expr(callee, undefined);
  return callValue(c, expr, type, expected);
}

function callFn(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  fn: FnDef,
  typeArgs: Type[],
  expected: Type | undefined
): Type {
  if ((fn as { nativeKey?: string }).nativeKey === 'Turtle::new') return turtleNew(c, expr);
  const sig = c.instantiate(fn, typeArgs, expr.span);
  const params = fn.selfMode ? [selfParamType(fn, sig.subst), ...sig.params] : sig.params;
  if (expr.args.length !== params.length) {
    compileError(
      expr.span,
      `関数 ${fn.name} の引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`
    );
  }
  checkArgs(c, expr.args, params, expectations(c, sig.ret, params, expected));
  expr.callee.ty = { kind: 'fn', params, ret: sig.ret };
  return sig.ret;
}

export function selfParamType(fn: FnDef, subst: Subst): Type {
  const self = fn.trait ? ({ kind: 'param', param: fn.trait.self } as Type) : (fn.impl?.selfType ?? UNIT);
  const selfType = substitute(self, subst);
  if (fn.selfMode === 'value') return selfType;
  return ref(selfType, fn.selfMode === 'mutRef');
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

function checkArgs(c: Checker, args: Expr[], params: Type[], expectations: (Type | undefined)[] = []): void {
  // Closures are checked last, when the other arguments have told their parameters' types.
  const order = [...args.keys()].toSorted(
    (a, b) => Number(args[a].kind === 'closure') - Number(args[b].kind === 'closure')
  );
  for (const index of order) checkArgument(c, args[index], params[index], expectations[index]);
}

function checkArgument(c: Checker, arg: Expr, param: Type, expectation: Type | undefined): void {
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
      !hasVars(target) &&
      c.tryCoerce(arg, type, target)
    ) {
      c.unifyOrError(arg.span, param, target);
      return;
    }
    c.coerce(arg, type, param);
    return;
  }
  c.coerceExpr(arg, param);
}

function coerceClosure(c: Checker, arg: Expr, type: Type, param: Type): void {
  const p = shallow(param);
  if (p.kind === 'var' || p.kind === 'param') {
    if (p.kind === 'var') c.unifier.tryUnify(p, type);
    return;
  }
  c.coerce(arg, type, param);
}

/** The signature a closure passed for a parameter takes: from the parameter's `Fn` bound. */
function closureSignature(c: Checker, param: Type): { params: Type[]; ret: Type } | undefined {
  const p = shallow(param);
  if (p.kind === 'var') {
    const bounds = c.varBounds.get(p.v) ?? [];
    const fnBound = bounds.find((bound) => bound.fnSig);
    return fnBound?.fnSig;
  }
  if (p.kind === 'param') return p.param.bounds.find((bound) => bound.fnSig)?.fnSig;
  if (p.kind === 'fn') return { params: p.params, ret: p.ret };
  if (p.kind === 'adt' && p.def.builtin === 'Box') {
    const inner = shallow(p.args[0]);
    if (inner.kind === 'dyn' && inner.trait.fnSig) return inner.trait.fnSig;
  }
  return undefined;
}

/** Calls a value: a closure, a function, or a value whose type is bounded by a closure trait. */
function callValue(
  c: Checker,
  expr: Extract<Expr, { kind: 'call' }>,
  calleeType: Type,
  expected: Type | undefined
): Type {
  let t = normalize(shallow(calleeType));
  while (t.kind === 'ref' || (t.kind === 'adt' && t.def.builtin === 'Box')) {
    t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
  }
  let params: Type[];
  let ret: Type;
  if (t.kind === 'closure') {
    params = t.closure.params;
    ret = t.closure.ret;
    requireCallableMut(c, expr, t.closure.kind);
  } else if (t.kind === 'fn') {
    params = t.params;
    ret = t.ret;
  } else {
    const bounds = boundsOf(t) ?? [];
    const sig = bounds.find((bound) => bound.fnSig);
    if (!sig?.fnSig) {
      compileError(expr.callee.span, `${typeToString(resolve(calleeType))} は関数ではないので、呼び出せません。`);
    }
    params = sig.fnSig.params;
    ret = sig.fnSig.ret;
    if (sig.trait.name === 'FnMut') requireCallableMut(c, expr, 'FnMut');
  }
  if (expr.args.length !== params.length) {
    compileError(expr.span, `引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`);
  }
  if (expected) c.unifier.tryUnify(ret, expected);
  checkArgs(c, expr.args, params);
  c.annotations.calls.set(expr, 'closure');
  return ret;
}

/** Calling an `FnMut` closure borrows it mutably, so its variable must be `mut`. */
function requireCallableMut(c: Checker, expr: Extract<Expr, { kind: 'call' }>, kind: string): void {
  c.deferredChecks.push(() => {
    const callee = expr.callee;
    const closureType = shallow(callee.ty ?? UNIT);
    const actual = closureType.kind === 'closure' ? closureType.closure.kind : kind;
    if (actual !== 'FnMut') return;
    if (callee.kind !== 'path') return;
    const res = c.annotations.paths.get(callee);
    if (res?.kind === 'local' && !res.local.mutable && shallow(res.local.type).kind === 'closure') {
      compileError(
        callee.span,
        `変数 ${res.local.name} のクロージャは捕まえた変数を書き換えるので、let mut ${res.local.name} と宣言してください。`
      );
    }
  });
}

// code-gauge-allow functionNcss 37 -- Follows rustc's method probe and its checks step by step.
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
  if (expr.turbofish) {
    const own = fn.params.slice(fn.parentParamCount);
    const written = typeArgsFor(c, own, expr.turbofish, expr.methodSpan, expr.method);
    found.typeArgs.splice(fn.parentParamCount, own.length, ...written);
  }
  checkReceiverAdjust(c, expr, found.adjust);
  const sig = c.instantiate(fn, found.typeArgs, expr.methodSpan);
  if (expr.args.length !== sig.params.length) {
    compileError(
      expr.methodSpan,
      `メソッド ${expr.method} の引数の数が合いません（${sig.params.length} 個ですが、${expr.args.length} 個あります）。`
    );
  }
  checkArgs(c, expr.args, sig.params, expectations(c, sig.ret, sig.params, expected));
  c.annotations.methods.set(expr, { fn, typeArgs: found.typeArgs, receiver: found.adjust });
  if (fn.selfMode === 'value') checkMoveOutOfRef(c, expr, found.adjust, found.selfType);
  if (expr.method === 'map') return arrayMapResult(stripped, found.selfType, sig.ret);
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
  const t = typeToString(resolve(receiverType));
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
    push_back: '（Vec では push です）',
    add: '（Vec では push です）',
    append: '',
  };
  const hint = hints[expr.method];
  if (hint === undefined && autoderefSteps(c.program, receiverType).some((step) => isStandardType(step.type))) {
    compileError(expr.methodSpan, `${t} のメソッド ${expr.method} は、この採点環境では使えません。`);
  }
  compileError(expr.methodSpan, `${t} にメソッド ${expr.method} がありません${hint ?? ''}。`);
}

function isStandardType(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'adt') return (t.def.module as Module | undefined)?.isStd ?? false;
  if (t.kind === 'dyn') return (t.trait.trait.module as Module | undefined)?.isStd ?? false;
  return ['array', 'slice', 'str', 'char', 'int', 'float', 'bool'].includes(t.kind);
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
function checkMoveOutOfRef(
  c: Checker,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  adjust: ReceiverAdjust,
  selfType: Type
): void {
  if (adjust.autoref !== 'none' || adjust.asIter) return;
  const throughRef = adjust.derefs.some((step) => step === 'ref' || step === 'mutRef');
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
function checkReceiverAdjust(c: Checker, expr: Extract<Expr, { kind: 'methodCall' }>, adjust: ReceiverAdjust): void {
  const needsMut =
    adjust.autoref === 'mut' || (adjust.autoref === 'none' && adjust.derefs.at(-1) === 'mutRef' && false);
  if (!needsMut) return;
  const lastRef = adjust.derefs.lastIndexOf('mutRef');
  const sharedAfter = adjust.derefs.slice(lastRef + 1).includes('ref');
  if (adjust.derefs.includes('ref') && (lastRef === -1 || sharedAfter)) {
    compileError(
      expr.receiver.span,
      `& の参照を通しては、メソッド ${expr.method}（&mut self を受け取る）を呼べません（&mut の参照にしてください）。`
    );
  }
  if (lastRef !== -1) return;
  requireMutablePlace(c, expr.receiver, `メソッド ${expr.method} で書き換える`);
}

/** An array's `map` gives an array of its length, which the declaration on `[T]` cannot say. */
function arrayMapResult(receiver: Type, selfType: Type, ret: Type): Type {
  const self = normalize(shallow(selfType));
  const r = normalize(shallow(ret));
  if (receiver.kind === 'array' && self.kind === 'slice' && r.kind === 'slice') {
    return { kind: 'array', elem: r.elem, len: receiver.len };
  }
  return ret;
}
