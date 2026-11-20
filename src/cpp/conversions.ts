import { convertScalar } from '../c/arith';
import { type Expr, mapMemberConstants } from './expr';
import { NEGATIVE_NAN } from './floatSign';
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
import type { Ptr } from './values';
import { NULL_PTR } from './values';

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
  /** How the sequence binds a reference, when the target is one. */
  reference?: { toConst: boolean };
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
  allowUser = true
): ConversionSequence | undefined {
  // The library's pseudo-parameter of a callable or a braced list takes the argument as it is.
  if (expr.braced && to.kind === 'function')
    return sequence(Rank.Exact, (e) => ({ ...e, constantInitialization: true }), { isInitializerList: true });
  if (expr.braced) return host.bracedConversion(expr.braced, to);
  // A function's name converts only to a parameter that takes a callable, as the library's algorithms have.
  if (to.kind === 'function' || expr.functions) {
    return to.kind === 'function' && expr.functions ? sequence(Rank.Exact, (e) => e) : undefined;
  }
  if (to.kind === 'reference') return referenceBinding(host, expr, to.to, allowUser);
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
  if (!toConst && expr.isXvalue) return undefined;
  const from = expr.type;
  if (expr.isLvalue && (toConst || !isConstType(from))) {
    if (
      sameType(unqualified(from), unqualified(target), false) &&
      (from.kind !== 'array' || sameType(from, target, false))
    ) {
      return sequence(Rank.Exact, identity, { reference: { toConst } });
    }
    const distance = baseDistance(from, target);
    if (distance > 0) {
      return sequence(Rank.Conversion, (e) => toBase(host, e, target), {
        reference: { toConst },
        baseDistance: distance,
      });
    }
  }
  if (!toConst) return undefined;
  if (!expr.isLvalue && from.kind === 'class' && target.kind === 'class') {
    const distance = from.cls === target.cls ? 0 : baseDistance(from, target);
    if (from.cls === target.cls || distance > 0) {
      return sequence(distance > 0 ? Rank.Conversion : Rank.Exact, (e) => toBase(host, host.materialize(e), target), {
        reference: { toConst },
        baseDistance: distance,
      });
    }
  }
  const converted = implicitConversion(host, expr, unqualified(target), allowUser);
  if (!converted) return undefined;
  return { ...converted, reference: { toConst }, apply: (e) => host.materialize(converted.apply(e)) };
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
    if (to.name === 'bool' && (from.kind === 'pointer' || from.kind === 'array')) {
      return sequence(Rank.Conversion, (e) => ({ ...host.rvalue(e), type: to, run: notNull(host.rvalue(e).run) }), {
        isBoolean: true,
      });
    }
    return undefined;
  }
  if (to.kind === 'nullptr') return from.kind === 'nullptr' ? sequence(Rank.Exact, (e) => host.rvalue(e)) : undefined;
  if (to.kind === 'pointer') return pointerConversion(host, expr, to);
  return undefined;
}

function arithmeticConversion(
  host: ConversionHost,
  from: Extract<Type, { kind: 'int' | 'float' }>,
  to: Extract<Type, { kind: 'int' | 'float' }>
): ConversionSequence {
  const target = unqualified(to);
  const apply = (e: Expr): Expr => convertArithmetic(host.rvalue(e), target);
  if (from.kind === to.kind && from.name === to.name) return sequence(Rank.Exact, apply);
  if (isPromotion(from, to)) return sequence(Rank.Promotion, apply);
  return sequence(Rank.Conversion, apply);
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
    run: (frame) => {
      const value = run(frame);
      if (value === NEGATIVE_NAN) return to.kind === 'float' ? value : convertScalar(Number.NaN, from, to);
      return convertScalar(value as number | bigint, from, to);
    },
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
  return (frame) => ((run(frame) as Ptr).isNull ? 0 : 1);
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
