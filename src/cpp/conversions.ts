import { convertScalar } from '../c/arith';
import { convertNumeric, type NumericValue } from './arithmetic';
import { type Expr, mapMemberConstants } from './expr';
import { erasePointee } from './pointerCasts';
import type { Syntax } from './syntax';
import {
  type ClassInfo,
  type FunctionInfo,
  intRank,
  isArithmetic,
  isConstType,
  isInteger,
  sameType,
  type Type,
  unqualified,
} from './types';
import type { MemberPointer, Ptr } from './values';
import { FunctionRef, NULL_MEMBER, NULL_PTR } from './values';

/** The ranks of implicit conversion sequences, better first. */
export const enum Rank {
  Exact,
  Promotion,
  Conversion,
  UserDefined,
}

/** An implicit conversion sequence, with what the rules for choosing among overloads compare. */
export interface ConversionSequence {
  rank: Rank;
  /** The qualified pointee type when a standard conversion adds `const`. */
  qualificationTarget?: Type;
  /** Whether the sequence converts a pointer to `bool`, which is worse than other conversions of the same rank. */
  isBoolean: boolean;
  /** How many classes up the hierarchy a derived-to-base conversion goes, or 0. */
  baseDistance: number;
  convertsToVoidPointer?: boolean;
  isInitializerList?: boolean;
  /**
   * How the sequence binds a reference, when the target is one: to const or not, as an rvalue reference or not, and
   * whether the source is an rvalue, which overload resolution compares (C++20 [over.ics.rank]p3.2.3).
   */
  reference?: { toConst: boolean; isRvalue?: boolean; fromRvalue?: boolean };
  /** The converting constructor of a user-defined conversion. */
  user?: FunctionInfo;
  scalarSource?: ClassInfo;
  trailingStandard?: ConversionSequence;
  apply: (expr: Expr) => Expr;
}

/** What converting needs from the compiler: making objects and temporaries. */
export interface ConversionHost {
  /** The prvalue of an expression: its value, an array's first element's address, or a copy of nothing. */
  rvalue(expr: Expr): Expr;
  /** A prvalue copy of an object of class type, which copying from a derived class slices. */
  copyObject(expr: Expr, cls: ClassInfo): Expr;
  /** A prvalue object made by a constructor that takes one argument (and defaults for the rest). */
  constructFrom(cls: ClassInfo, constructor: FunctionInfo, argument: Expr, row: number): Expr;
  /** An lvalue designating a temporary that holds a prvalue, for binding a const reference to it. */
  materialize(expr: Expr): Expr;
  /** Stops when a derived-to-base conversion names a base class that is inaccessible here. */
  checkBaseConversion(from: ClassInfo, to: ClassInfo, row: number): void;
  /** Whether a constructor may convert implicitly: it is not `explicit`. */
  isViableConstructor(constructor: FunctionInfo): boolean;
  /** The conversion of a braced list argument (`f({1, 2})`) to a type, by list-initialization. */
  bracedConversion(list: Syntax, to: Type): ConversionSequence | undefined;
  /** A call of a conversion function (`operator int() const`) on an object. */
  callConversion(expr: Expr, fn: FunctionInfo): Expr;
  /** Notes that the program uses a function, which it must then define. */
  useFunction(fn: FunctionInfo, row: number): void;
}

const identity = (expr: Expr): Expr => expr;

export function sequence(
  rank: Rank,
  apply: (expr: Expr) => Expr,
  extra: Partial<ConversionSequence> = {}
): ConversionSequence {
  return { rank, isBoolean: false, baseDistance: 0, apply, ...extra };
}

/**
 * The implicit conversion sequence from an expression to a type (which may be a reference), or undefined when none
 * exists. User-defined conversions are considered only when `allowUser`.
 */
export function implicitConversion(
  host: ConversionHost,
  expr: Expr,
  to: Type,
  allowUser = true,
  allowExplicit = false
): ConversionSequence | undefined {
  const standard = convertWithoutFunctions(host, expr, to, allowUser);
  if (standard || !allowUser || to.kind === 'reference' || expr.type.kind !== 'class' || expr.type.cls.library)
    return standard;
  return conversionFunction(host, expr, to, allowExplicit);
}

/**
 * The user-defined conversion by a conversion function of the expression's class (C++20 [over.match.conv]), the
 * explicit ones too when `allowExplicit` (a direct-initialization or a contextual conversion to `bool`).
 */
function conversionFunction(
  host: ConversionHost,
  expr: Expr,
  to: Type,
  allowExplicit: boolean
): ConversionSequence | undefined {
  const source = expr.type as Extract<Type, { kind: 'class' }>;
  const viable: { fn: FunctionInfo; second: ConversionSequence }[] = [];
  for (const fn of conversionFunctions(source.cls)) {
    if (fn.isExplicit && !allowExplicit) continue;
    if (isConstType(source) && !fn.isConst) continue;
    const result: Expr = {
      type: unqualified(fn.ret.kind === 'reference' ? fn.ret.to : fn.ret),
      isLvalue: fn.ret.kind === 'reference',
      row: expr.row,
      run: () => {},
    };
    const second = convertWithoutFunctions(host, result, to, false);
    if (second) viable.push({ fn, second });
  }
  const best = bestOf(viable, (a, b) => compareSequences(a.second, b.second));
  if (!best) return undefined;
  return sequence(Rank.UserDefined, (e) => best.second.apply(host.callConversion(e, best.fn)), {
    user: best.fn,
  });
}

/** The conversion functions a class declares or inherits, the derived class's hiding the base's of the same name. */
export function conversionFunctions(cls: ClassInfo): FunctionInfo[] {
  const found = new Map<string, FunctionInfo[]>();
  for (let current: ClassInfo | undefined = cls; current; current = current.base) {
    for (const [name, methods] of current.methods) {
      if (!found.has(name) && methods.some((fn) => fn.isConversion)) found.set(name, methods);
    }
  }
  return [...found.values()].flat().filter((fn) => fn.isConversion);
}

function convertWithoutFunctions(
  host: ConversionHost,
  expr: Expr,
  to: Type,
  allowUser: boolean
): ConversionSequence | undefined {
  // The library's pseudo-parameter of a callable or a braced list takes the argument as it is.
  if (expr.braced && to.kind === 'function')
    return sequence(Rank.Exact, (e) => ({ ...e, constantInitialization: true }), { isInitializerList: true });
  if (expr.braced) return host.bracedConversion(expr.braced, to);
  const pointee = to.kind === 'pointer' && to.to.kind === 'function' ? to.to : undefined;
  if (pointee && expr.functions) return functionPointer(host, expr, to as Extract<Type, { kind: 'pointer' }>, pointee);
  // A function's name binds a reference to a pointer to it (a forwarding reference's deduction) as a temporary.
  const pointerTarget = to.kind === 'reference' && (to.isRvalue || isConstType(to.to)) ? unqualified(to.to) : undefined;
  if (expr.functions && pointerTarget?.kind === 'pointer' && pointerTarget.to.kind === 'function') {
    const pointer = functionPointer(host, expr, pointerTarget, pointerTarget.to);
    if (pointer) return { ...pointer, apply: (e) => host.materialize(pointer.apply(e)) };
  }
  if (pointee && allowUser && expr.type.kind === 'class' && expr.type.cls.isLambda)
    return lambdaPointer(host, expr, to as Extract<Type, { kind: 'pointer' }>, pointee);
  // A function's name converts only to a parameter that takes a callable, as the library's algorithms have, or to
  // a class whose constructor takes the function (`std::function`).
  if (expr.functions && to.kind === 'class' && !to.cls.library && allowUser)
    return classConversion(host, expr, to.cls, allowUser);
  if (to.kind === 'function' || expr.functions) {
    return to.kind === 'function' && expr.functions ? sequence(Rank.Exact, (e) => e) : undefined;
  }
  if (to.kind === 'reference')
    return to.isRvalue
      ? rvalueReferenceBinding(host, expr, to.to, allowUser)
      : referenceBinding(host, expr, to.to, allowUser);
  if (to.kind === 'class') return classConversion(host, expr, to.cls, allowUser);
  if (allowUser && expr.type.kind === 'class' && expr.type.cls.library?.scalarValue) {
    const scalar = scalarValue(host, expr);
    const conversion = standardConversion(host, scalar, to);
    if (conversion)
      return sequence(Rank.UserDefined, (e) => conversion.apply(scalarValue(host, e)), {
        scalarSource: expr.type.cls,
        trailingStandard: conversion,
      });
  }
  return standardConversion(host, expr, to);
}

/** The type of a function, which a pointer to it points to. */
export function functionTypeOf(fn: FunctionInfo): Type {
  return { kind: 'function', ret: fn.ret, params: fn.params.map((param) => unqualified(param.type)) };
}

/** A function's name converted to a pointer to the overload whose type is the pointee's (C++20 [over.over]). */
function functionPointer(
  host: ConversionHost,
  expr: Expr,
  to: Extract<Type, { kind: 'pointer' }>,
  pointee: Type
): ConversionSequence | undefined {
  const candidates = expr.functions?.candidates ?? [];
  const fn = candidates.find(
    (candidate) => (!candidate.owner || candidate.isStatic) && sameType(functionTypeOf(candidate), pointee, false)
  );
  if (!fn) return undefined;
  return sequence(Rank.Exact, (e) => {
    host.useFunction(fn, e.row);
    const value = new FunctionRef([fn]);
    return { type: to, isLvalue: false, row: e.row, run: () => value, staticAddress: true };
  });
}

/** A lambda without captures converted to a pointer to its function call operator (C++20 [expr.prim.lambda.closure]). */
function lambdaPointer(
  host: ConversionHost,
  expr: Expr,
  to: Extract<Type, { kind: 'pointer' }>,
  pointee: Type
): ConversionSequence | undefined {
  const { cls } = expr.type as Extract<Type, { kind: 'class' }>;
  const [call] = cls.methods.get('operator()') ?? [];
  if (!call || cls.fields.length > 0 || !sameType(functionTypeOf(call), pointee, false)) return undefined;
  const value = new FunctionRef([call]);
  return sequence(Rank.UserDefined, (e) => {
    const { run } = e;
    return {
      type: to,
      isLvalue: false,
      row: e.row,
      run: (frame) => {
        run(frame);
        return value;
      },
    };
  });
}

export function scalarValue(host: ConversionHost, expr: Expr): Expr {
  const value = host.rvalue(expr);
  const scalar = value.type.kind === 'class' ? value.type.cls.library?.scalarValue : undefined;
  if (!scalar) return value;
  const { run, row } = value;
  return { type: scalar.type, isLvalue: false, row, run: (frame) => scalar.read(run(frame)) };
}

function referenceBinding(
  host: ConversionHost,
  expr: Expr,
  target: Type,
  allowUser: boolean
): ConversionSequence | undefined {
  const toConst = isConstType(target);
  if (!toConst && (expr.isXvalue || expr.isBitField)) return undefined;
  const from = expr.type;
  // A const reference to a bit-field binds to a temporary holding its value.
  if (expr.isLvalue && !expr.isBitField && (toConst || !isConstType(from))) {
    const fromRvalue = expr.isXvalue === true;
    if (
      sameType(unqualified(from), unqualified(target), false) &&
      (from.kind !== 'array' || sameType(from, target, false))
    ) {
      return sequence(Rank.Exact, identity, { reference: { toConst, fromRvalue } });
    }
    const distance = baseDistance(from, target);
    if (distance > 0) {
      return sequence(Rank.Conversion, (e) => toBase(host, e, target), {
        reference: { toConst, fromRvalue },
        baseDistance: distance,
      });
    }
  }
  if (!toConst) return undefined;
  const fromRvalue = !expr.isLvalue || expr.isXvalue === true;
  if (!expr.isLvalue && from.kind === 'class' && target.kind === 'class') {
    const distance = from.cls === target.cls ? 0 : baseDistance(from, target);
    if (from.cls === target.cls || distance > 0) {
      return sequence(distance > 0 ? Rank.Conversion : Rank.Exact, (e) => toBase(host, host.materialize(e), target), {
        reference: { toConst, fromRvalue },
        baseDistance: distance,
      });
    }
  }
  const converted = implicitConversion(host, expr, unqualified(target), allowUser);
  if (!converted) return undefined;
  return { ...converted, reference: { toConst, fromRvalue }, apply: (e) => host.materialize(converted.apply(e)) };
}

/** Binds an rvalue reference (`T&&`), which only an rvalue may bind: an xvalue directly, a prvalue as a temporary. */
function rvalueReferenceBinding(
  host: ConversionHost,
  expr: Expr,
  target: Type,
  allowUser: boolean
): ConversionSequence | undefined {
  if (expr.isLvalue && !expr.isXvalue) return undefined;
  const from = expr.type;
  const reference = { toConst: isConstType(target), isRvalue: true, fromRvalue: true };
  if (isConstType(from) && !isConstType(target)) return undefined;
  const related = sameType(unqualified(from), unqualified(target), false) || baseDistance(from, target) > 0;
  if (related) {
    const distance = baseDistance(from, target);
    return sequence(
      distance > 0 ? Rank.Conversion : Rank.Exact,
      (e) => toBase(host, e.isLvalue ? e : host.materialize(e), target),
      { reference, baseDistance: distance }
    );
  }
  const converted = implicitConversion(host, { ...expr, isXvalue: false }, unqualified(target), allowUser);
  if (!converted) return undefined;
  return { ...converted, reference, apply: (e) => markXvalue(host.materialize(converted.apply(e))) };
}

function markXvalue(expr: Expr): Expr {
  return { ...expr, isXvalue: true };
}

function classConversion(
  host: ConversionHost,
  expr: Expr,
  cls: ClassInfo,
  allowUser: boolean
): ConversionSequence | undefined {
  const from = expr.type;
  if (from.kind === 'class' && from.cls === cls) {
    return sequence(Rank.Exact, (e) => (e.isLvalue ? host.copyObject(e, cls) : e));
  }
  if (from.kind === 'class') {
    const distance = baseDistance(from, { kind: 'class', cls });
    if (distance > 0) return sequence(Rank.Conversion, (e) => host.copyObject(e, cls), { baseDistance: distance });
  }
  if (!allowUser) return undefined;
  const viable: { constructor: FunctionInfo; first: ConversionSequence }[] = [];
  for (const candidate of cls.constructors) {
    const constructor = candidate.instantiate ? candidate.instantiate([expr], undefined) : candidate;
    if (!constructor || !host.isViableConstructor(constructor)) continue;
    const [param, ...rest] = constructor.params;
    if (!param || rest.some((other) => other.defaultValue === undefined && !other.isOptional)) continue;
    const first = implicitConversion(host, expr, param.type, false);
    if (first) viable.push({ constructor, first });
  }
  const best = bestOf(viable, (a, b) => compareSequences(a.first, b.first));
  if (!best) return undefined;
  return sequence(Rank.UserDefined, (e) => host.constructFrom(cls, best.constructor, e, e.row), {
    user: best.constructor,
  });
}

function standardConversion(host: ConversionHost, expr: Expr, to: Type): ConversionSequence | undefined {
  const from = expr.type;
  if (from.kind === 'class' || to.kind === 'void' || from.kind === 'void') return undefined;
  if (isArithmetic(to)) {
    if (isArithmetic(from)) return arithmeticConversion(host, from, to);
    if (to.name === 'bool' && (from.kind === 'pointer' || from.kind === 'array' || from.kind === 'memberPointer')) {
      return sequence(Rank.Conversion, (e) => ({ ...host.rvalue(e), type: to, run: notNull(host.rvalue(e).run) }), {
        isBoolean: true,
      });
    }
    return undefined;
  }
  if (to.kind === 'nullptr') return from.kind === 'nullptr' ? sequence(Rank.Exact, (e) => host.rvalue(e)) : undefined;
  if (to.kind === 'pointer') return pointerConversion(host, expr, to);
  if (to.kind === 'memberPointer') return memberPointerConversion(host, expr, to);
  return undefined;
}

/**
 * The conversions to a pointer to a member: the same type, the null pointer constant, and a pointer to a member of a
 * base to one of the derived class (C++20 [conv.mem]).
 */
function memberPointerConversion(
  host: ConversionHost,
  expr: Expr,
  to: Extract<Type, { kind: 'memberPointer' }>
): ConversionSequence | undefined {
  const from = expr.type;
  if (expr.isNullConstant || from.kind === 'nullptr')
    return sequence(Rank.Conversion, (e) => ({ ...host.rvalue(e), type: to, run: () => NULL_MEMBER }));
  if (from.kind !== 'memberPointer' || !sameType(from.to, to.to)) return undefined;
  if (from.cls === to.cls) return sequence(Rank.Exact, (e) => ({ ...host.rvalue(e), type: to }));
  if (to.cls.isDerivedFrom(from.cls)) return sequence(Rank.Conversion, (e) => ({ ...host.rvalue(e), type: to }));
  return undefined;
}

function arithmeticConversion(
  host: ConversionHost,
  from: Extract<Type, { kind: 'int' | 'float' }>,
  to: Extract<Type, { kind: 'int' | 'float' }>
): ConversionSequence | undefined {
  const target = unqualified(to);
  const apply = (e: Expr): Expr => convertArithmetic(host.rvalue(e), target);
  const fromEnum = from.kind === 'int' ? from.enumeration : undefined;
  const toEnum = to.kind === 'int' ? to.enumeration : undefined;
  // No integer converts to an enumeration implicitly, and a scoped enumeration converts to nothing (C++20 [conv.integral]).
  if (toEnum || fromEnum?.isScoped) return toEnum === fromEnum ? sequence(Rank.Exact, apply) : undefined;
  if (fromEnum) {
    // An unscoped enumeration promotes to its underlying type and to that type's promotion (C++20 [conv.prom]).
    const promoted = enumPromotion(from as Extract<Type, { kind: 'int' }>);
    if (to.kind === 'int' && (to.name === promoted || (fromEnum.hasFixedType && to.name === fromEnum.underlying)))
      return sequence(Rank.Promotion, apply);
    return sequence(Rank.Conversion, apply);
  }
  if (from.kind === to.kind && from.name === to.name) return sequence(Rank.Exact, apply);
  if (isPromotion(from, to)) return sequence(Rank.Promotion, apply);
  return sequence(Rank.Conversion, apply);
}

function enumPromotion(type: Extract<Type, { kind: 'int' }>): string {
  return intRank(type.name) < intRank('int') ? 'int' : type.name;
}

/** Converts an arithmetic prvalue to another arithmetic type, folding constants. */
export function convertArithmetic(expr: Expr, to: Extract<Type, { kind: 'int' | 'float' }>): Expr {
  const from = expr.type as Extract<Type, { kind: 'int' | 'float' }>;
  if (from.kind === to.kind && from.name === to.name) return { ...expr, type: to };
  const run = expr.run;
  const converted: Expr = {
    type: to,
    isLvalue: false,
    row: expr.row,
    run: (frame) => convertNumeric(run(frame) as NumericValue, from, to),
    memberConstant: mapMemberConstants([expr], ([value]) => convertScalar(value, from, to)),
  };
  const known = expr.constant ?? expr.foldedValue;
  if (known !== undefined) {
    try {
      const constant = convertScalar(known, from, to);
      if (expr.constant !== undefined) converted.constant = constant;
      else converted.foldedValue = constant;
      if (!Number.isNaN(known)) converted.run = () => constant;
    } catch {
      // A conversion that overflows is no constant; it stops the program when it runs.
    }
  }
  return converted;
}

function isPromotion(from: Type, to: Type): boolean {
  if (from.kind === 'float' && to.kind === 'float') return from.name === 'float' && to.name === 'double';
  if (from.kind !== 'int' || to.kind !== 'int') return false;
  return to.name === 'int' && intRank(from.name) < intRank('int');
}

function pointerConversion(
  host: ConversionHost,
  expr: Expr,
  to: Extract<Type, { kind: 'pointer' }>
): ConversionSequence | undefined {
  const from = expr.type;
  if (from.kind === 'nullptr' || (expr.isNullConstant && isInteger(from))) {
    return sequence(Rank.Conversion, (e) => {
      const value = host.rvalue(e);
      return {
        type: to,
        isLvalue: false,
        row: e.row,
        staticAddress: value.isNullConstant || value.staticAddress || value.constantInitialization,
        run: (frame) => {
          value.run(frame);
          return NULL_PTR;
        },
      };
    });
  }
  const fromTarget = from.kind === 'pointer' ? from.to : from.kind === 'array' ? from.of : undefined;
  if (!fromTarget) return undefined;
  const apply = (e: Expr): Expr => ({ ...host.rvalue(e), type: to });
  // clang++ converts a string literal to `char *` with only a warning, ranking it below every other conversion, even
  // a user-defined one or an ellipsis; writing through the pointer stops the program.
  if (expr.literalBytes !== undefined && sameType(to.to, { kind: 'int', name: 'char' })) {
    return sequence(Rank.UserDefined + 2, apply);
  }
  if (isConstType(fromTarget) && !isConstType(to.to)) return undefined;
  const qualificationTarget = !isConstType(fromTarget) && isConstType(to.to) ? to.to : undefined;
  if (permitsQualificationConversion(fromTarget, to.to)) {
    return sequence(Rank.Exact, apply, { qualificationTarget: sameType(fromTarget, to.to) ? undefined : to.to });
  }
  if (to.to.kind === 'void') {
    return sequence(
      Rank.Conversion,
      (e) => {
        const value = apply(e);
        const run = value.run;
        return { ...value, run: (frame) => erasePointee(run(frame) as Ptr, fromTarget) };
      },
      { qualificationTarget, convertsToVoidPointer: true }
    );
  }
  const distance = baseDistance(fromTarget, to.to);
  if (distance > 0) {
    return sequence(Rank.Conversion, (e) => apply(toBase(host, e, to.to)), {
      baseDistance: distance,
      qualificationTarget,
    });
  }
  return undefined;
}

export function permitsQualificationConversion(from: Type, to: Type, canAdd = true): boolean {
  const fromConst = isConstType(from);
  const toConst = isConstType(to);
  if (fromConst !== toConst && (fromConst || !canAdd)) return false;
  if (from.kind === 'pointer' && to.kind === 'pointer') {
    return permitsQualificationConversion(from.to, to.to, canAdd && toConst);
  }
  if (from.kind === 'array' && to.kind === 'array') {
    return from.length === to.length && permitsQualificationConversion(from.of, to.of, canAdd);
  }
  return sameType(from, to, false);
}

function toBase(host: ConversionHost, expr: Expr, base: Type): Expr {
  const { type } = expr;
  const from = type.kind === 'pointer' ? type.to : type.kind === 'array' ? type.of : type;
  if (from.kind !== 'class' || base.kind !== 'class' || from.cls === base.cls) return expr;
  host.checkBaseConversion(from.cls, base.cls, expr.row);
  return classLocation(type.kind === 'array' || type.kind === 'pointer' ? host.rvalue(expr) : expr, base.cls);
}

export function classLocation(expr: Expr, cls: ClassInfo): Expr {
  const { run, temporaryBinding } = expr;
  return {
    ...expr,
    run: (frame) => (run(frame) as Ptr).forClass(cls),
    temporaryBinding: temporaryBinding && ((frame, retain) => temporaryBinding(frame, retain).forClass(cls)),
  };
}

function notNull(run: Expr['run']): Expr['run'] {
  return (frame) => ((run(frame) as Ptr | MemberPointer).isNull ? 0 : 1);
}

/** How many classes up from `from` the class `to` is, or 0 when `to` is no proper base of `from`. */
function baseDistance(from: Type, to: Type): number {
  return from.kind === 'class' && to.kind === 'class' ? (from.cls.distanceToBase(to.cls) ?? 0) : 0;
}

/**
 * Compares two conversion sequences of the same argument: positive when `a` is better, negative when `b` is, and 0
 * when neither is (C++20 [over.ics.rank]).
 */
export function compareSequences(a: ConversionSequence, b: ConversionSequence): number {
  if (a.isInitializerList !== b.isInitializerList) return a.isInitializerList ? 1 : -1;
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.rank === Rank.UserDefined)
    return a.scalarSource === b.scalarSource && a.trailingStandard && b.trailingStandard
      ? compareSequences(a.trailingStandard, b.trailingStandard)
      : 0;
  if (a.isBoolean !== b.isBoolean) return a.isBoolean ? -1 : 1;
  if (a.baseDistance > 0 && b.convertsToVoidPointer) return 1;
  if (b.baseDistance > 0 && a.convertsToVoidPointer) return -1;
  if (a.baseDistance !== b.baseDistance && a.baseDistance > 0 && b.baseDistance > 0) {
    return b.baseDistance - a.baseDistance;
  }
  const qualification = compareQualificationTargets(a.qualificationTarget, b.qualificationTarget);
  if (qualification) return qualification;
  // An rvalue binds an rvalue reference better than an lvalue reference.
  if (
    a.reference?.fromRvalue &&
    b.reference?.fromRvalue &&
    Boolean(a.reference.isRvalue) !== Boolean(b.reference.isRvalue)
  )
    return a.reference.isRvalue ? 1 : -1;
  if (a.reference && b.reference && a.reference.toConst !== b.reference.toConst) return a.reference.toConst ? -1 : 1;
  return 0;
}

function compareQualificationTargets(first: Type | undefined, second: Type | undefined): number {
  if (!first) return second ? 1 : 0;
  if (!second) return -1;
  const firstToSecond = permitsQualificationConversion(first, second);
  const secondToFirst = permitsQualificationConversion(second, first);
  if (firstToSecond === secondToFirst) return 0;
  return firstToSecond ? 1 : -1;
}

/** The candidate better than every other, or undefined when none or several are best. */
export function bestOf<T>(candidates: T[], compare: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const candidate of candidates) if (!best || compare(candidate, best) > 0) best = candidate;
  if (!best) return undefined;
  const found = best;
  return candidates.every((other) => other === found || compare(found, other) > 0) ? found : undefined;
}
