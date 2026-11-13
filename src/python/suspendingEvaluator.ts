import type { Argument, Element, Expression, FormattedValue, Target } from './ast';
import { asyncYield, awaitValue } from './coroutines';
import {
  addArgument,
  addElement,
  type CallArguments,
  ExpressionEvaluator,
  formatPart,
  mergeMapping,
} from './expressionEvaluator';
import type { Frame } from './frame';
import { delegateTo } from './generators';
import { getItem, isTruthy } from './objects';
import { binaryOp, compareOp, unaryOp } from './operators';
import { targetSuspends } from './suspension';
import { templateLiteral } from './templateStrings';
import { TemporaryScope } from './temporaryScope';
import { iterateSuspending, type SuspendingNext } from './threadIteration';
import { isWaitRequest, suspendingCall } from './threads';
import { newDict, newList, newSet, None, sliceClass } from './types';
import { DONE, type Kwargs, type PyDict, PyList, PySet, PySlice, type PyTuple, type PyValue } from './values';

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

  /** Evaluates an expression that may suspend, whose value the caller hands on, as `evaluate` does. */
  *evaluateSuspending(expression: Expression, frame: Frame): Suspension {
    if (!expression.suspends) return this.evaluate(expression, frame);
    const value = yield* this.suspendingValue(expression, frame);
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.escape(value);
    return value;
  }

  // code-gauge-allow functionNcss 60 -- One case per kind of expression that may contain a suspending part.
  private *suspendingValue(expression: Expression, frame: Frame): Suspension {
    switch (expression.kind) {
      case 'yield':
      case 'yieldFrom':
      case 'await': {
        return yield* this.suspensionPoint(expression, frame);
      }
      case 'fstring': {
        return yield* this.formattedStringSuspending(expression.parts, frame, expression.template);
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
        return this.readAttribute(yield* this.evaluateSuspending(expression.object, frame), expression.name);
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
    if (expression.scope.isAsync || expression.type === 'generator')
      return this.comprehension(expression, frame, first);
    return yield* this.threadComprehension(expression, frame, first, iterateSuspending(first));
  }

  /**
   * A generator expression of a program that runs threads (the only one that suspends without awaiting) passes the
   * waits in its clauses on to the code resuming it.
   */
  protected override generatorItems(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    inner: Frame,
    first: PyValue,
    firstNext: () => PyValue | typeof DONE
  ): Generator<PyValue, PyValue> {
    if (!expression.suspends || expression.scope.isAsync) {
      return super.generatorItems(expression, inner, first, firstNext);
    }
    return this.itemsSuspending(expression, inner, iterateSuspending(first));
  }

  /** Runs a list, set, or dict comprehension of a program that runs threads, passing the waits in it on. */
  private *threadComprehension(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    first: PyValue,
    next: SuspendingNext
  ): Suspension {
    const { runtime } = this;
    const inner = this.comprehensionFrame(expression, frame);
    runtime.pushFrame(inner);
    try {
      inner.temporaries.push(first);
      const result = expression.type === 'list' ? newList([]) : expression.type === 'set' ? newSet() : newDict();
      inner.temporaries.push(result);
      const items = this.itemsSuspending(expression, inner, next);
      for (let step = items.next(); !step.done; step = items.next()) {
        if (isWaitRequest(step.value)) {
          yield step.value;
          continue;
        }
        if (result instanceof PyList) result.append(step.value);
        else if (result instanceof PySet) result.table.add(step.value);
        else {
          const [key, value] = (step.value as PyTuple).items;
          (result as PyDict).store.set(key, value);
        }
      }
      return result;
    } finally {
      runtime.popFrame();
    }
  }

  /**
   * Runs the clauses of a comprehension, yielding each element (a key and value pair for a dict comprehension) and
   * passing on the waits of the thread reading its iterables or evaluating its parts.
   */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows the clauses of a comprehension, as the synchronous one does.
  // code-gauge-allow functionNcss 35 -- Follows the clauses of a comprehension, as the synchronous one does.
  private *itemsSuspending(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    firstNext: SuspendingNext
  ): Suspension {
    const { generators } = expression;
    const { runtime } = this;
    const level = function* (this: SuspendingEvaluator, index: number, next: SuspendingNext): Suspension<void> {
      const generator = generators[index];
      for (let item = yield* next(); item !== DONE; item = yield* next()) {
        runtime.spend();
        yield* this.assignSuspending(generator.target, item, frame);
        let passes = true;
        for (const condition of generator.conditions) {
          if (!isTruthy(yield* this.evaluateSuspending(condition, frame))) {
            passes = false;
            break;
          }
        }
        if (!passes) continue;
        if (index + 1 < generators.length) {
          const iterable = yield* this.evaluateSuspending(generators[index + 1].iterable, frame);
          const temporaryScope = new TemporaryScope(frame.temporaries);
          frame.temporaries.push(iterable);
          try {
            yield* level.call(this, index + 1, iterateSuspending(iterable));
          } catch (error) {
            throw temporaryScope.capture(error);
          } finally {
            temporaryScope.release();
          }
          continue;
        }
        const element = yield* this.evaluateSuspending(expression.element, frame);
        if (expression.value === undefined) {
          yield element;
          continue;
        }
        frame.temporaries.push(element);
        const value = yield* this.evaluateSuspending(expression.value, frame);
        frame.temporaries.pop();
        yield runtime.tuple([element, value]);
      }
    };
    yield* level.call(this, 0, firstNext);
    return None;
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
    const temporaryScope2 = new TemporaryScope(frame.temporaries, () => [values]);
    try {
      for (const param of params) {
        if (!param.default) continue;
        const value = yield* this.evaluateSuspending(param.default, frame);
        values.push(value);
        frame.temporaries.push(value);
      }
    } catch (error) {
      throw temporaryScope2.capture(error);
    } finally {
      temporaryScope2.release();
    }
    return values;
  }

  /** Stores a value into a target whose parts may suspend, evaluating them as `assign` does. */
  *assignSuspending(target: Target, value: PyValue, frame: Frame): Suspension<void> {
    if (!targetSuspends(target)) {
      this.assign(target, value, frame);
      return;
    }
    // An attribute or an item keeps the value outside the frames.
    if (target.kind !== 'unpack') this.runtime.finalizer.locals.escape(value);
    const temporaryScope3 = new TemporaryScope(frame.temporaries);
    frame.temporaries.push(value);
    try {
      switch (target.kind) {
        case 'attribute': {
          this.storeInto(yield* this.evaluateSuspending(target.object, frame), target.name, true, value);
          return temporaryScope3.keep(undefined);
        }
        case 'subscript': {
          const object = yield* this.evaluateSuspending(target.object, frame);
          const index = yield* this.holding(frame, object, this.evaluateSuspending(target.index, frame));
          this.hold(frame, object, () => this.storeInto(object, index, false, value));
          return temporaryScope3.keep(undefined);
        }
        default: {
          const items = this.unpackTarget(target as Extract<Target, { kind: 'unpack' }>, value);
          for (const [index, element] of (target as Extract<Target, { kind: 'unpack' }>).elements.entries()) {
            yield* this.assignSuspending(element, items[index], frame);
          }
        }
      }
    } catch (error) {
      throw temporaryScope3.capture(error);
    } finally {
      temporaryScope3.release();
    }
  }

  /** Keeps a value reachable for garbage collection while `run` evaluates more of the expression holding it. */
  protected *holding<T>(frame: Frame, value: PyValue, run: Suspension<T>): Suspension<T> {
    const temporaryScope4 = new TemporaryScope(frame.temporaries);
    frame.temporaries.push(value);
    try {
      return temporaryScope4.keep(yield* run);
    } catch (error) {
      throw temporaryScope4.capture(error);
    } finally {
      temporaryScope4.release();
    }
  }

  private *formattedStringSuspending(parts: (string | FormattedValue)[], frame: Frame, template = false): Suspension {
    let result = '';
    const fields: [PyValue, string][] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        result += part;
        continue;
      }
      const value = yield* this.evaluateSuspending(part.expression, frame);
      const spec = part.spec ? ((yield* this.evaluateSuspending(part.spec, frame)) as string) : '';
      if (template) {
        fields.push([value, spec]);
        continue;
      }
      result += formatPart(part, value, spec);
      this.runtime.buildString(result.length);
    }
    return template ? templateLiteral(parts, fields) : result;
  }

  private *displaySuspending(kind: 'list' | 'tuple' | 'set', elements: Element[], frame: Frame): Suspension {
    const items: PyValue[] = [];
    const temporaryScope5 = new TemporaryScope(frame.temporaries);
    try {
      for (const element of elements) {
        const isStarred = element.kind === 'starred';
        addElement(items, frame, isStarred, yield* this.evaluateSuspending(isStarred ? element.value : element, frame));
      }
      return temporaryScope5.keep(this.newDisplay(kind, items));
    } catch (error) {
      throw temporaryScope5.capture(error);
    } finally {
      temporaryScope5.release();
    }
  }

  private *dictSuspending(expression: Extract<Expression, { kind: 'dict' }>, frame: Frame): Suspension {
    const temporaryScope6 = new TemporaryScope(frame.temporaries);
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
        dict.store.set(key, yield* this.evaluateSuspending(item.value, frame));
      }
      return temporaryScope6.keep(dict);
    } catch (error) {
      throw temporaryScope6.capture(error);
    } finally {
      temporaryScope6.release();
    }
  }

  private *callSuspending(callee: Expression, args: Argument[], row: number, frame: Frame): Suspension {
    return yield* this.callValueSuspending(yield* this.evaluateSuspending(callee, frame), args, row, frame);
  }

  /** Evaluates the arguments of a call whose callee has been evaluated, then calls it. */
  protected *callValueSuspending(calleeValue: PyValue, args: Argument[], row: number, frame: Frame): Suspension {
    let passed: PyValue[] = [];
    let kwargs: Kwargs;
    let result: PyValue = None;
    const temporaryScope7 = new TemporaryScope(frame.temporaries, () => [result]);
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
      kwargs = collected.kwargs;
      const owner = this.beforeCall(calleeValue, frame, temporaryScope7.length);
      result = yield* this.invokeSuspending(owner, calleeValue, passed, kwargs, row);
    } catch (error) {
      throw temporaryScope7.capture(error);
    } finally {
      temporaryScope7.release();
    }
    this.afterCall(calleeValue, passed, kwargs, result);
    return result;
  }

  /**
   * Calls a value from the call expression at `row` so that the blocking operations it makes suspend the running
   * thread, as `invoke` calls it otherwise.
   */
  protected *invokeSuspending(
    owner: PyValue | undefined,
    callee: PyValue,
    args: PyValue[],
    kwargs: Kwargs,
    row: number
  ): Suspension {
    const call = suspendingCall(callee, args, kwargs);
    if (!call) return this.invokeFrom(owner, callee, args, kwargs, row);
    const { runtime } = this;
    const outerRow = runtime.currentRow;
    runtime.currentRow = row;
    const { locals } = runtime.finalizer;
    if (locals.marking) locals.noteCall(callee);
    try {
      return yield* call;
    } finally {
      runtime.currentRow = outerRow;
    }
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
