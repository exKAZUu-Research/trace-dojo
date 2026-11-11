import type { Argument, Element, Expression, FormattedValue, Target } from './ast';
import { asyncYield, awaitValue } from './coroutines';
import {
  addArgument,
  addElement,
  type CallArguments,
  ExpressionEvaluator,
  formatPart,
  mergeMapping,
  storeKey,
} from './expressionEvaluator';
import type { Frame } from './frame';
import { delegateTo } from './generators';
import { getAttribute, getItem, isTruthy, setAttribute, setItem } from './objects';
import { binaryOp, compareOp, unaryOp } from './operators';
import { targetSuspends } from './suspension';
import { suspendingCall } from './threads';
import { newDict, None, sliceClass } from './types';
import { type Kwargs, PySlice, type PyValue } from './values';

/**
 * A evaluation that may suspend the running generator: it yields what the generator gives the code resuming it and
 * receives what that code sends back.
 */
export type Suspension<T = PyValue> = Generator<PyValue, T, PyValue>;

/**
 * Evaluates the expressions that may suspend a generator in the middle (those the converter marks with `suspends`)
 * step by step, as generators. Their unmarked parts and all other expressions take the synchronous path, and both
 * paths combine values with the same functions.
 */
export abstract class SuspendingEvaluator extends ExpressionEvaluator {
  /** Runs a list, set, or dict comprehension that awaits, in the coroutine running it. */
  protected abstract asyncComprehension(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    first: PyValue
  ): Suspension;

  // code-gauge-allow functionNcss 60 -- One case per kind of expression that may contain a suspending part.
  *evaluateSuspending(expression: Expression, frame: Frame): Suspension {
    if (!expression.suspends) return this.evaluate(expression, frame);
    switch (expression.kind) {
      case 'yield':
      case 'yieldFrom':
      case 'await': {
        return yield* this.suspensionPoint(expression, frame);
      }
      case 'fstring': {
        return yield* this.formattedStringSuspending(expression.parts, frame);
      }
      case 'list':
      case 'tuple':
      case 'set': {
        return yield* this.displaySuspending(expression.kind, expression.elements, frame);
      }
      case 'dict': {
        return yield* this.dictSuspending(expression, frame);
      }
      case 'attribute': {
        return getAttribute(yield* this.evaluateSuspending(expression.object, frame), expression.name);
      }
      case 'subscript': {
        const object = yield* this.evaluateSuspending(expression.object, frame);
        return getItem(object, yield* this.holding(frame, object, this.evaluateSuspending(expression.index, frame)));
      }
      case 'slice': {
        const { lower, upper, step } = expression;
        const lowerValue = lower ? yield* this.evaluateSuspending(lower, frame) : None;
        const upperValue = upper ? yield* this.evaluateSuspending(upper, frame) : None;
        return new PySlice(
          sliceClass,
          lowerValue,
          upperValue,
          step ? yield* this.evaluateSuspending(step, frame) : None
        );
      }
      case 'call': {
        return yield* this.callSuspending(expression.callee, expression.args, expression.row, frame);
      }
      case 'binary': {
        const left = yield* this.evaluateSuspending(expression.left, frame);
        const right = yield* this.holding(frame, left, this.evaluateSuspending(expression.right, frame));
        return binaryOp(expression.operator, left, right);
      }
      case 'unary': {
        return unaryOp(expression.operator, yield* this.evaluateSuspending(expression.operand, frame));
      }
      case 'not': {
        return !isTruthy(yield* this.evaluateSuspending(expression.operand, frame));
      }
      case 'boolean': {
        const left = yield* this.evaluateSuspending(expression.left, frame);
        const truthy = isTruthy(left);
        if (expression.operator === 'and' ? !truthy : truthy) return left;
        return yield* this.evaluateSuspending(expression.right, frame);
      }
      case 'compare': {
        return yield* this.compareSuspending(expression, frame);
      }
      case 'conditional': {
        const test = isTruthy(yield* this.evaluateSuspending(expression.test, frame));
        return yield* this.evaluateSuspending(test ? expression.body : expression.orelse, frame);
      }
      case 'lambda': {
        const defaults = yield* this.defaultsSuspending(expression.fn.params, frame);
        return this.createFunction(expression.fn, frame, [], defaults);
      }
      case 'namedExpression': {
        const value = yield* this.evaluateSuspending(expression.value, frame);
        this.storeName(expression.target, value, frame);
        return value;
      }
      case 'comprehension': {
        return yield* this.comprehensionSuspending(expression, frame);
      }
      default: {
        throw new Error(`A ${expression.kind} expression does not suspend`);
      }
    }
  }

  private *comprehensionSuspending(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame
  ): Suspension {
    const first = yield* this.evaluateSuspending(expression.generators[0].iterable, frame);
    if (expression.scope.isAsync && expression.type !== 'generator') {
      return yield* this.asyncComprehension(expression, frame, first);
    }
    return this.comprehension(expression, frame, first);
  }

  /** Evaluates `yield`, `yield from`, or `await`, which suspend the running generator or coroutine. */
  private *suspensionPoint(
    expression: Extract<Expression, { kind: 'yield' | 'yieldFrom' | 'await' }>,
    frame: Frame
  ): Suspension {
    const value = expression.value ? yield* this.evaluateSuspending(expression.value, frame) : None;
    if (expression.kind === 'yieldFrom') return yield* delegateTo(value, frame);
    if (expression.kind === 'await') return yield* awaitValue(value, frame, expression.row);
    return yield frame.scope.isAsync ? asyncYield(value) : value;
  }

  /** Evaluates the defaults of parameters in order, as defining a function does. */
  *defaultsSuspending(params: { default?: Expression }[], frame: Frame): Suspension<PyValue[]> {
    const values: PyValue[] = [];
    const length = frame.temporaries.length;
    try {
      for (const param of params) {
        if (!param.default) continue;
        const value = yield* this.evaluateSuspending(param.default, frame);
        values.push(value);
        frame.temporaries.push(value);
      }
    } finally {
      frame.temporaries.length = length;
    }
    return values;
  }

  /** Stores a value into a target whose parts may suspend, evaluating them as `assign` does. */
  *assignSuspending(target: Target, value: PyValue, frame: Frame): Suspension<void> {
    if (!targetSuspends(target)) {
      this.assign(target, value, frame);
      return;
    }
    const length = frame.temporaries.length;
    frame.temporaries.push(value);
    try {
      switch (target.kind) {
        case 'attribute': {
          setAttribute(yield* this.evaluateSuspending(target.object, frame), target.name, value);
          return;
        }
        case 'subscript': {
          const object = yield* this.evaluateSuspending(target.object, frame);
          setItem(object, yield* this.holding(frame, object, this.evaluateSuspending(target.index, frame)), value);
          return;
        }
        default: {
          const items = this.unpackTarget(target as Extract<Target, { kind: 'unpack' }>, value);
          for (const [index, element] of (target as Extract<Target, { kind: 'unpack' }>).elements.entries()) {
            yield* this.assignSuspending(element, items[index], frame);
          }
        }
      }
    } finally {
      frame.temporaries.length = length;
    }
  }

  /**
   * Calls a value from the call expression at `row` so that the blocking operations it makes suspend the running
   * thread, as `invoke` calls it otherwise.
   */
  protected *invokeSuspending(callee: PyValue, args: PyValue[], kwargs: Kwargs, row: number): Suspension {
    const call = suspendingCall(callee, args, kwargs);
    if (!call) return this.invoke(callee, args, kwargs, row);
    const { runtime } = this;
    const outerRow = runtime.currentRow;
    runtime.currentRow = row;
    try {
      return yield* call;
    } finally {
      runtime.currentRow = outerRow;
    }
  }

  /** Keeps a value reachable for garbage collection while `run` evaluates more of the expression holding it. */
  protected *holding<T>(frame: Frame, value: PyValue, run: Suspension<T>): Suspension<T> {
    const length = frame.temporaries.length;
    frame.temporaries.push(value);
    try {
      return yield* run;
    } finally {
      frame.temporaries.length = length;
    }
  }

  private *formattedStringSuspending(parts: (string | FormattedValue)[], frame: Frame): Suspension {
    let result = '';
    for (const part of parts) {
      if (typeof part === 'string') {
        result += part;
        continue;
      }
      const value = yield* this.evaluateSuspending(part.expression, frame);
      const spec = part.spec ? ((yield* this.evaluateSuspending(part.spec, frame)) as string) : '';
      result += formatPart(part, value, spec);
      this.runtime.buildString(result.length);
    }
    return result;
  }

  private *displaySuspending(kind: 'list' | 'tuple' | 'set', elements: Element[], frame: Frame): Suspension {
    const items: PyValue[] = [];
    const length = frame.temporaries.length;
    try {
      for (const element of elements) {
        const isStarred = element.kind === 'starred';
        addElement(items, frame, isStarred, yield* this.evaluateSuspending(isStarred ? element.value : element, frame));
      }
      return this.newDisplay(kind, items);
    } finally {
      frame.temporaries.length = length;
    }
  }

  // code-gauge-allow duplicateLines 15 -- Mirrors the synchronous dict display step by step, sharing how it combines the values.
  private *dictSuspending(expression: Extract<Expression, { kind: 'dict' }>, frame: Frame): Suspension {
    const length = frame.temporaries.length;
    try {
      const dict = newDict();
      frame.temporaries.push(dict);
      for (const item of expression.items) {
        if (item.kind === 'doubleStar') {
          mergeMapping(dict, yield* this.evaluateSuspending(item.value, frame));
          continue;
        }
        const key = yield* this.evaluateSuspending(item.key, frame);
        frame.temporaries.push(key);
        storeKey(dict, key, yield* this.evaluateSuspending(item.value, frame));
      }
      this.runtime.allocate(dict.store.size + 1);
      return dict;
    } finally {
      frame.temporaries.length = length;
    }
  }

  private *callSuspending(callee: Expression, args: Argument[], row: number, frame: Frame): Suspension {
    return yield* this.callValueSuspending(yield* this.evaluateSuspending(callee, frame), args, row, frame);
  }

  /** Evaluates the arguments of a call whose callee has been evaluated, then calls it. */
  protected *callValueSuspending(calleeValue: PyValue, args: Argument[], row: number, frame: Frame): Suspension {
    let passed: PyValue[] = [];
    let result: PyValue = None;
    const length = frame.temporaries.length;
    frame.temporaries.push(calleeValue);
    try {
      const collected: CallArguments = { args: [], kwargs: undefined };
      for (const argument of args) {
        addArgument(
          collected,
          argument,
          yield* this.evaluateSuspending(argument.value, frame),
          { callee: calleeValue, argumentList: args, leading: 0 },
          frame
        );
      }
      passed = collected.args;
      result = yield* this.invokeSuspending(calleeValue, collected.args, collected.kwargs, row);
    } finally {
      frame.temporaries.length = length;
    }
    this.afterCall(passed, result);
    return result;
  }

  private *compareSuspending(expression: Extract<Expression, { kind: 'compare' }>, frame: Frame): Suspension {
    let left = yield* this.evaluateSuspending(expression.operands[0], frame);
    let result: PyValue = true;
    for (const [index, operator] of expression.operators.entries()) {
      const right = yield* this.holding(frame, left, this.evaluateSuspending(expression.operands[index + 1], frame));
      result = this.hold(frame, right, () => compareOp(operator, left, right));
      if (index < expression.operators.length - 1 && !isTruthy(result)) return result;
      left = right;
    }
    return result;
  }
}
