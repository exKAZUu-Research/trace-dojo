import type { Condition, Expr, Pattern } from './ast';
import type { Compiler, Eval } from './compiler';
import { isPlaceExpr } from './compilerCommon';
import { takesWhole } from './compilerPatterns';
import { normalize } from './infer';
import { ControlSignal, type Frame, UNASSIGNED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow, type Type } from './types';
import { DONE, type IterValue, UNIT_VALUE, type Value } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

export function compileIf(c: Compiler, expr: ExprOf<'if'>): Eval {
  const cond = compileCondition(c, expr.cond);
  const condLocals = expr.cond.kind === 'let' ? c.patternSlots(expr.cond.pattern) : [];
  const then = c.compileBlock(expr.consequent);
  const otherwise = expr.else ? c.value(expr.else) : undefined;
  return (frame) => {
    frame.runtime.spend();
    if (cond(frame)) {
      try {
        return then(frame);
      } finally {
        for (const slot of condLocals) frame.locals[slot] = UNASSIGNED;
      }
    }
    return otherwise ? otherwise(frame) : UNIT_VALUE;
  };
}

export function compileMatch(c: Compiler, expr: ExprOf<'match'>): Eval {
  const scrutinee = c.read(expr.scrutinee);
  const placeEval = isPlaceExpr(expr.scrutinee, c.annotations) ? c.place(expr.scrutinee) : undefined;
  const arms = expr.arms.map((arm) => {
    const matcher = c.compileMatcher(arm.pattern);
    const body = c.value(arm.body);
    const slots = c.patternSlots(arm.pattern);
    const takeAll = takesWhole(c, expr.scrutinee, arm.pattern);
    return { matcher, body, slots, takeAll };
  });
  return (frame) => {
    frame.runtime.spend();
    const value = scrutinee(frame);
    frame.temporaries.push(value);
    try {
      for (const { matcher, body, slots, takeAll } of arms) {
        if (matcher(frame, value, placeEval ? () => placeEval(frame) : undefined)) {
          takeAll?.(frame);
          frame.temporaries.pop();
          try {
            return body(frame);
          } finally {
            for (const slot of slots) frame.locals[slot] = UNASSIGNED;
            frame.temporaries.push(undefined);
          }
        }
      }
    } finally {
      frame.temporaries.pop();
    }
    throw new Error('No arm matched');
  };
}

export function compileLoop(c: Compiler, expr: ExprOf<'loop'>): Eval {
  const body = c.compileBlock(expr.body);
  const label = expr.label;
  return (frame) => {
    for (;;) {
      frame.runtime.spend();
      const signal = runBody(body, frame, label);
      if (signal) return signal.value ?? UNIT_VALUE;
    }
  };
}

export function compileWhile(c: Compiler, expr: ExprOf<'while'>): Eval {
  const cond = compileCondition(c, expr.cond);
  const letPattern = expr.cond.kind === 'let' ? expr.cond.pattern : undefined;
  const condLocals = letPattern ? c.patternSlots(letPattern) : [];
  const body = c.compileBlock(expr.body);
  const label = expr.label;
  const row = letPattern ? c.stepRow(expr.span) : undefined;
  const answered = bindsAnswer(letPattern);
  return (frame) => {
    try {
      for (;;) {
        frame.runtime.spend();
        if (!cond(frame)) return UNIT_VALUE;
        stepBinding(frame, row, answered);
        if (runBody(body, frame, label)) return UNIT_VALUE;
      }
    } finally {
      for (const slot of condLocals) frame.locals[slot] = UNASSIGNED;
    }
  };
}

export function compileFor(c: Compiler, expr: ExprOf<'for'>): Eval {
  const loopInfo = c.annotations.loops.get(expr);
  if (!loopInfo) throw new Error('Unchecked for');
  const iterable = c.value(expr.iterable);
  const fromType = runtimeType(loopInfo.from);
  const bind = c.compileBinder(expr.pattern);
  const patternSlots = c.patternSlots(expr.pattern);
  const body = c.compileBlock(expr.body);
  const label = expr.label;
  const row = c.stepRow(expr.span);
  const answered = bindsAnswer(expr.pattern);
  return (frame) => {
    const source = iterable(frame);
    // The iterator keeps what the loop still uses: all of a borrowed collection, or what an owned one has left.
    const iterator = c.support.toIter(source, fromType(frame)) as IterValue;
    frame.temporaries.push(iterator);
    try {
      for (;;) {
        frame.runtime.spend();
        const next = iterator.next();
        if (next === DONE) return UNIT_VALUE;
        bind(frame, next as Value);
        stepBinding(frame, row, answered);
        if (runBody(body, frame, label)) return UNIT_VALUE;
      }
    } finally {
      frame.temporaries.pop();
      for (const slot of patternSlots) frame.locals[slot] = UNASSIGNED;
    }
  };
}

function compileCondition(c: Compiler, cond: Condition): Eval {
  if (cond.kind === 'expr') return c.value(cond.expr);
  const value = c.read(cond.value);
  const matcher = c.compileMatcher(cond.pattern);
  const placeEval = isPlaceExpr(cond.value, c.annotations) ? c.place(cond.value) : undefined;
  const takeAll = takesWhole(c, cond.value, cond.pattern);
  return (frame) => {
    const v = value(frame);
    const matched = matcher(frame, v, placeEval ? () => placeEval(frame) : undefined);
    if (matched) takeAll?.(frame);
    return matched;
  };
}

function stepBinding(frame: Frame, row: number | undefined, answered: boolean): void {
  if (row !== undefined) frame.runtime.steps.stepBinding(row, answered);
}

/** Runs a loop's body once, returning the `break` that ends the loop, if any; a `continue` goes on. */
function runBody(body: Eval, frame: Frame, label: string | undefined): ControlSignal | undefined {
  try {
    body(frame);
  } catch (error) {
    if (!(error instanceof ControlSignal) || error.kind === 'return') throw error;
    if (error.label !== undefined && error.label !== label) throw error;
    if (error.kind === 'break') return error;
  }
  return undefined;
}

/** Whether a loop's pattern binds a value learners write down: a number, a `bool`, a `char`, or a string. */
function bindsAnswer(pattern: Pattern | undefined): boolean {
  if (!pattern) return false;
  if (pattern.kind === 'tuple' || pattern.kind === 'tupleStruct' || pattern.kind === 'struct') return true;
  const type = normalize(shallow(resolve(pattern.ty ?? { kind: 'tuple', elems: [] }, true)));
  return isAnswerType(type);
}

function isAnswerType(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char' || t.kind === 'str') return true;
  if (t.kind === 'ref') return isAnswerType(t.target);
  return t.kind === 'adt' && t.def.builtin === 'String';
}
