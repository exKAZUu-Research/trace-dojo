import type { Argument, Expression, MemberExpression, ObjectMember } from './ast';
import { delegateAsync } from './asyncGenerators';
import { type Reference, referenceBase, SHORT_CIRCUIT } from './evaluatorBase';
import { defineAccessor, ExpressionEvaluator, isLogicalOperator, shortCircuits } from './expressionEvaluator';
import { Awaiting, GeneratorReturn, type Resume, resumedValue, resumeGenerator, type Steps } from './generators';
import { DONE } from './iteration';
import { appendAll, isCallable, isObject, JsFunction, JsObject, toBoolean, type Value } from './values';

/**
 * Evaluates the expressions of a generator body that contain a `yield`, suspending at each `yield` with the value it
 * yields. The parts without a `yield` run as {@link ExpressionEvaluator.evaluate} runs them; the converter rejects a
 * `yield` anywhere else.
 */
export abstract class StepEvaluator extends ExpressionEvaluator {
  // code-gauge-allow functionNcss 50 -- One case per kind of expression that a `yield` may sit in.
  *evaluateSteps(expression: Expression): Steps<Value> {
    if (!expression.suspends) return this.evaluate(expression);
    const { runtime } = this;
    switch (expression.kind) {
      case 'yield': {
        const value = expression.argument ? yield* this.evaluateSteps(expression.argument) : undefined;
        if (expression.delegate) {
          return expression.isAsync ? yield* delegateAsync(this.runtime, value) : yield* this.delegate(value);
        }
        if (!expression.isAsync) return resumedValue(yield value);
        // An async generator awaits the value it yields, and the value `return()` resumes it with.
        const resume = yield resumedValue(yield new Awaiting(value));
        if (resume.kind === 'return') throw new GeneratorReturn(resumedValue(yield new Awaiting(resume.value)));
        return resumedValue(resume);
      }
      case 'await': {
        return resumedValue(yield new Awaiting(yield* this.evaluateSteps(expression.argument)));
      }
      case 'parenthesized': {
        return yield* this.evaluateSteps(expression.expression);
      }
      case 'sequence': {
        let value: Value;
        for (const item of expression.expressions) value = yield* this.evaluateSteps(item);
        return value;
      }
      case 'binary': {
        const left = yield* this.evaluateSteps(expression.left);
        const right = yield* this.holdingSteps([left], () => this.evaluateSteps(expression.right));
        return runtime.hold(left, () => runtime.hold(right, () => this.binary(expression.operator, left, right)));
      }
      case 'logical': {
        const left = yield* this.evaluateSteps(expression.left);
        return shortCircuits(expression.operator, left) ? left : yield* this.evaluateSteps(expression.right);
      }
      case 'conditional': {
        return toBoolean(yield* this.evaluateSteps(expression.test))
          ? yield* this.evaluateSteps(expression.consequent)
          : yield* this.evaluateSteps(expression.alternate);
      }
      case 'unary': {
        return this.unaryValue(expression.operator, yield* this.evaluateSteps(expression.argument));
      }
      case 'template': {
        const values = yield* this.elementSteps(expression.expressions);
        let text = expression.strings[0];
        for (const [index, value] of values.entries()) {
          const part = runtime.toString(value) + expression.strings[index + 1];
          runtime.extendString(text.length + part.length, part.length);
          text += part;
        }
        return text;
      }
      case 'array': {
        return runtime.newArray(yield* this.elementSteps(expression.elements));
      }
      case 'object': {
        return yield* this.objectSteps(expression.members);
      }
      case 'member': {
        const value = yield* this.memberSteps(expression);
        return value === SHORT_CIRCUIT ? undefined : value;
      }
      case 'assign': {
        return yield* this.assignSteps(expression);
      }
      case 'call': {
        return yield* this.callSteps(expression);
      }
      case 'new': {
        const constructor = this.evaluate(expression.callee);
        if (!(constructor instanceof JsFunction) || !constructor.isConstructor) {
          return runtime.throwError('TypeError', `${expression.calleeText} is not a constructor`);
        }
        const args = yield* this.holdingSteps([constructor], () => this.elementSteps(expression.args));
        return this.holdWhile([constructor, ...args], () =>
          runtime.construct(constructor, args, constructor, expression.row)
        );
      }
      default: {
        throw new Error(`A yield in an unsupported expression: ${expression.kind}`);
      }
    }
  }

  /** Runs `yield*`, which passes each value of the iterable out and each resumption in until the iterable is done. */
  private *delegate(iterable: Value): Steps<Value> {
    const { runtime } = this;
    if (iterable instanceof JsObject && iterable.generator) {
      let resume: Resume = { kind: 'next', value: undefined };
      for (;;) {
        const result = resumeGenerator(runtime, iterable, resume);
        if (result.done) {
          if (resume.kind === 'return') throw new GeneratorReturn(result.value);
          return result.value;
        }
        resume = yield result.value;
      }
    }
    const iterator = runtime.iterator(iterable);
    for (let value = iterator.next(); value !== DONE; value = iterator.next()) {
      const resume = yield value;
      if (resume.kind !== 'next') {
        iterator.close();
        if (resume.kind === 'throw') {
          return runtime.throwError('TypeError', "The iterator does not provide a 'throw' method");
        }
        throw new GeneratorReturn(resume.value);
      }
    }
    return undefined;
  }

  /** Evaluates elements or arguments in order, holding the values so far for garbage collection. */
  private *elementSteps(elements: (Argument | undefined)[]): Steps<Value[]> {
    const { runtime } = this;
    const values: Value[] = [];
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    try {
      for (const element of elements) {
        if (element === undefined) {
          values.push(undefined);
        } else if (element.kind === 'spread') {
          const spread = runtime.iterate(yield* this.evaluateSteps(element.argument));
          runtime.allocate(spread.length);
          appendAll(values, spread);
          appendAll(temporaries, spread);
        } else {
          const value = yield* this.evaluateSteps(element);
          values.push(value);
          temporaries.push(value);
        }
      }
      return values;
    } finally {
      temporaries.length = held;
    }
  }

  private *holdingSteps<T>(values: Value[], run: () => Steps<T>): Steps<T> {
    const { temporaries } = this.runtime.frame;
    const held = temporaries.length;
    appendAll(temporaries, values);
    try {
      return yield* run();
    } finally {
      temporaries.length = held;
    }
  }

  private holdWhile<T>(values: Value[], run: () => T): T {
    const { temporaries } = this.runtime.frame;
    const held = temporaries.length;
    appendAll(temporaries, values);
    try {
      return run();
    } finally {
      temporaries.length = held;
    }
  }

  /** Reads a member whose object or key suspends, which short-circuits the rest of its optional chain on nullish. */
  private *memberSteps(expression: Extract<Expression, { kind: 'member' }>): Steps<Value | typeof SHORT_CIRCUIT> {
    const { runtime } = this;
    const { object } = expression;
    const base =
      object.kind === 'super'
        ? this.thisValue()
        : object.kind === 'member' && object.suspends
          ? yield* this.memberSteps(object)
          : yield* this.evaluateSteps(object);
    if (base === SHORT_CIRCUIT || (expression.optional && (base === undefined || base === null))) return SHORT_CIRCUIT;
    const { property } = expression;
    if (property.kind === 'private') return runtime.getPrivate(base, this.privateKey(property.name));
    const key =
      property.kind === 'computed'
        ? runtime.toPropertyKey(yield* this.holdingSteps([base], () => this.evaluateSteps(property.expression)))
        : property.key;
    return runtime.get(base, key);
  }

  /** Evaluates the object and the key of an assignment's member target step by step, as `memberReference` does. */
  private *memberReferenceSteps(target: MemberExpression): Steps<Reference> {
    if (
      target.object.kind === 'super' ||
      !(target.object.suspends || (target.property.kind === 'computed' && target.property.expression.suspends))
    ) {
      return this.memberReference(target);
    }
    const base = yield* this.evaluateSteps(target.object);
    const { property } = target;
    if (property.kind === 'private') return { kind: 'private', base, name: this.privateKey(property.name) };
    const key =
      property.kind === 'computed'
        ? this.runtime.toPropertyKey(yield* this.holdingSteps([base], () => this.evaluateSteps(property.expression)))
        : property.key;
    return { kind: 'property', base, key };
  }

  private *objectSteps(members: ObjectMember[]): Steps<JsObject> {
    const object = this.runtime.newObject();
    yield* this.holdingSteps([object], () => this.objectMemberSteps(object, members));
    return object;
  }

  private *objectMemberSteps(object: JsObject, members: ObjectMember[]): Steps<void> {
    const { runtime } = this;
    for (const member of members) {
      if (!memberSuspends(member)) {
        this.defineObjectMember(object, member);
      } else if (member.kind === 'spread') {
        this.copyDataProperties(object, yield* this.evaluateSteps(member.argument));
      } else if (member.kind === 'prototype') {
        const prototype = yield* this.evaluateSteps(member.value);
        if (prototype === null || isObject(prototype)) object.proto = prototype;
      } else {
        const key =
          member.key.kind === 'computed'
            ? runtime.toPropertyKey(yield* this.evaluateSteps(member.key.expression))
            : this.propertyKey(member.key);
        if (member.kind === 'property') {
          runtime.createDataProperty(object, key, yield* this.evaluateSteps(member.value));
        } else {
          const accessor = this.createFunction(member.fn, runtime.frame.scope, object);
          defineAccessor(runtime, object, key, member.kind, accessor, true);
        }
      }
    }
  }

  private *assignSteps(expression: Extract<Expression, { kind: 'assign' }>): Steps<Value> {
    const { runtime } = this;
    const { operator, target } = expression;
    if (operator === '=' && target.kind !== 'identifier' && target.kind !== 'member') {
      const value = yield* this.evaluateSteps(expression.value);
      this.bindPattern(target, value, 'assign');
      return value;
    }
    const reference = target.kind === 'member' ? yield* this.memberReferenceSteps(target) : this.reference(target);
    return yield* this.holdingSteps(
      [referenceBase(reference)],
      function* (this: StepEvaluator): Steps<Value> {
        if (operator === '=') {
          const value = yield* this.evaluateSteps(expression.value);
          this.putReference(reference, value);
          return value;
        }
        const current = this.getReference(reference);
        const baseOperator = operator.slice(0, -1);
        if (isLogicalOperator(baseOperator)) {
          if (shortCircuits(baseOperator, current)) return current;
          const value = yield* this.evaluateSteps(expression.value);
          this.putReference(reference, value);
          return value;
        }
        const right = yield* this.holdingSteps([current], () => this.evaluateSteps(expression.value));
        const value = runtime.hold(right, () => this.binary(baseOperator, current, right));
        this.putReference(reference, value);
        return value;
      }.bind(this)
    );
  }

  private *callSteps(expression: Extract<Expression, { kind: 'call' }>): Steps<Value> {
    const { runtime } = this;
    const resolved = this.callee(expression.callee as Expression);
    if (resolved === SHORT_CIRCUIT) return undefined;
    const { fn, thisValue } = resolved;
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${expression.calleeText} is not a function`);
    const args = yield* this.holdingSteps([fn, thisValue], () => this.elementSteps(expression.args));
    return this.holdWhile([fn, thisValue, ...args], () => runtime.call(fn, thisValue, args, expression.row));
  }
}

/** Whether defining an object literal member suspends, which its value, its computed key, or its spread may. */
function memberSuspends(member: ObjectMember): boolean {
  if (member.kind === 'spread') return member.argument.suspends === true;
  if (member.kind === 'prototype') return member.value.suspends === true;
  if (member.key.kind === 'computed' && member.key.expression.suspends) return true;
  return member.kind === 'property' && member.value.suspends === true;
}
