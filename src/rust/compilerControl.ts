import type { Condition, Expr, Pattern } from './ast';
import type { Compiler, Eval } from './compiler';
import { compileGuardedMatcher, compilePatternInput, takesWhole } from './compilerPatterns';
import { normalize } from './infer';
import { ControlSignal, type Frame, RustPanic } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow, type Type } from './types';
import { DONE, type IterValue, UNIT_VALUE, type Value } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type ConditionalEval = (frame: Frame, onMatch: () => void) => boolean;

export function compileIf(c: Compiler, expr: ExprOf<'if'>, asStatement: boolean): Eval {
  const cond = compileCondition(c, expr.cond);
  const condLocals = expr.cond.kind === 'let' ? c.patternSlots(expr.cond.pattern) : [];
  const then = c.compileBlock(expr.consequent, asStatement);
  const otherwise = expr.else && (asStatement ? c.statement(expr.else) : c.value(expr.else));
  return (frame) => {
    frame.runtime.spend();
    let result: Value = UNIT_VALUE;
    const matched = cond(frame, () => {
      try {
        result = then(frame);
      } finally {
        frame.endScope(condLocals);
      }
    });
    if (matched) return result;
    return otherwise ? otherwise(frame) : UNIT_VALUE;
  };
}

export function compileMatch(c: Compiler, expr: ExprOf<'match'>, asStatement: boolean): Eval {
  const scrutinee = compilePatternInput(
    c,
    expr.scrutinee,
    expr.arms.map((arm) => arm.pattern)
  );
  const arms = expr.arms.map((arm) => {
    const matcher = compileGuardedMatcher(c, arm.pattern);
    const guard = arm.guard && c.value(arm.guard);
    const body = asStatement ? c.statement(arm.body) : c.value(arm.body);
    const slots = c.patternSlots(arm.pattern);
    const takeAll = takesWhole(c, expr.scrutinee, arm.pattern);
    return { matcher, guard, body, slots, takeAll };
  });
  return (frame) => {
    frame.runtime.spend();
    const { value, place } = scrutinee(frame);
    return frame.runtime.withRoots([place], () => {
      for (const { matcher, guard, body, slots, takeAll } of arms) {
        const moveOut = matcher(frame, value, () => place);
        if (!moveOut) continue;
        if (guard) {
          const mark = frame.runtime.liveGuards.length;
          const passed = guard(frame) === true;
          // A guard's temporaries go before its arm runs.
          frame.runtime.releaseGuards(frame, mark);
          if (!passed) {
            frame.endScope(slots, false);
            continue;
          }
        }
        moveOut();
        takeAll?.(frame);
        try {
          return body(frame);
        } finally {
          frame.endScope(slots);
        }
      }
      throw new Error('No arm matched');
    });
  };
}

export function compileLoop(c: Compiler, expr: ExprOf<'loop'>): Eval {
  const body = c.compileBlock(expr.body, true);
  const label = expr.label;
  const isBlock = expr.isBlock === true;
  return (frame) => {
    for (;;) {
      frame.runtime.spend();
      const signal = runBody(body, frame, label, isBlock);
      if (signal) return signal.value ?? UNIT_VALUE;
    }
  };
}

export function compileWhile(c: Compiler, expr: ExprOf<'while'>): Eval {
  const cond = compileCondition(c, expr.cond);
  const letPattern = expr.cond.kind === 'let' ? expr.cond.pattern : undefined;
  const condLocals = letPattern ? c.patternSlots(letPattern) : [];
  const body = c.compileBlock(expr.body, true);
  const label = expr.label;
  const row = letPattern ? c.stepRow(expr.span) : undefined;
  const answered = bindsAnswer(letPattern);
  return (frame) => {
    for (;;) {
      frame.runtime.spend();
      let breaks = false;
      const matched = cond(frame, () => {
        try {
          stepBinding(frame, row, answered);
          breaks = !!runBody(body, frame, label);
        } finally {
          frame.endScope(condLocals);
        }
      });
      if (!matched || breaks) return UNIT_VALUE;
    }
  };
}

// code-gauge-allow functionCognitiveComplexity -- Runs the loop and drops its iterator when it is left early, as Rust does.
// code-gauge-allow functionNcss -- Runs the loop and drops its iterator when it is left early, as Rust does.
export function compileFor(c: Compiler, expr: ExprOf<'for'>): Eval {
  const loopInfo = c.annotations.loops.get(expr);
  if (!loopInfo) throw new Error('Unchecked for');
  const iterable = c.value(expr.iterable);
  const fromType = runtimeType(loopInfo.from);
  const bind = c.compileOwnedBinder(expr.pattern);
  const patternSlots = c.patternSlots(expr.pattern);
  const body = c.compileBlock(expr.body, true);
  const label = expr.label;
  const row = c.stepRow(expr.span);
  const answered = bindsAnswer(expr.pattern);
  return (frame) => {
    const source = iterable(frame);
    const iterator = c.support.toIter(source, fromType(frame)) as IterValue;
    return frame.runtime.withRoots([iterator], () =>
      frame.runtime.withActiveBorrows([iterator], () => {
        try {
          for (;;) {
            frame.runtime.spend();
            const next = iterator.next();
            if (next === DONE) return UNIT_VALUE;
            frame.temporaries.push(bind(frame, next));
            let broke = false;
            try {
              stepBinding(frame, row, answered);
              broke = !!runBody(body, frame, label);
            } finally {
              frame.temporaries.pop();
              frame.endScope(patternSlots);
            }
            if (broke) {
              frame.runtime.dropper?.dropRest(iterator);
              return UNIT_VALUE;
            }
          }
        } catch (error) {
          // A `return`, a `break` of an outer loop or a panic leaves the loop, which drops its iterator.
          if (error instanceof ControlSignal || error instanceof RustPanic) frame.runtime.dropper?.dropRest(iterator);
          throw error;
        }
      })
    );
  };
}

function compileCondition(c: Compiler, cond: Condition): ConditionalEval {
  if (cond.kind === 'expr') {
    const value = c.value(cond.expr);
    return (frame, onMatch) => {
      const mark = frame.runtime.liveGuards.length;
      const result = value(frame);
      // A condition's temporaries (a `RefCell`'s guard) go before its branch runs.
      frame.runtime.releaseGuards(frame, mark);
      if (!result) return false;
      onMatch();
      return true;
    };
  }
  const input = compilePatternInput(c, cond.value, [cond.pattern]);
  const matcher = c.compileMatcher(cond.pattern);
  const takeAll = takesWhole(c, cond.value, cond.pattern);
  return (frame, onMatch) => {
    const mark = frame.runtime.liveGuards.length;
    const { value, place } = input(frame);
    // Edition 2024 drops the scrutinee's temporaries when the matched branch ends, or before `else` runs.
    try {
      return frame.runtime.withRoots([place], () => {
        if (!matcher(frame, value, () => place)) return false;
        takeAll?.(frame);
        onMatch();
        return true;
      });
    } finally {
      frame.runtime.releaseGuards(frame, mark);
    }
  };
}

function stepBinding(frame: Frame, row: number | undefined, answered: boolean): void {
  if (row !== undefined) frame.runtime.steps.stepBinding(row, answered);
}

/** Runs a loop's body once, returning the `break` that ends the loop, if any; a `continue` goes on. */
function runBody(body: Eval, frame: Frame, label: string | undefined, isBlock = false): ControlSignal | undefined {
  try {
    body(frame);
  } catch (error) {
    if (!(error instanceof ControlSignal) || error.kind === 'return') throw error;
    if (error.label === undefined ? isBlock : error.label !== label) throw error;
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
