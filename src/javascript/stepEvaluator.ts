import type { Argument, Expression, MemberExpression, ObjectMember } from './ast';
import { nameFunction, type Reference, referenceBase, SHORT_CIRCUIT } from './evaluatorBase';
import { defineAccessor, ExpressionEvaluator, isLogicalOperator, shortCircuits } from './expressionEvaluator';
import { Awaiting, GeneratorReturn, resumedValue, type Steps } from './generators';
import { delegateYield } from './iteratorProtocol';
import {
  appendAll,
  type Element,
  HOLE,
  isCallable,
  isObject,
  JsFunction,
  type JsObject,
  toBoolean,
  type Value,
} from './values';

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
        return yield* this.yieldSteps(expression);
      }
      case 'await': {
        return resumedValue(yield new Awaiting(yield* this.evaluateSteps(expression.argument)));
      }
      case 'privateIn': {
        return this.hasPrivate(expression.name, yield* this.evaluateSteps(expression.right));
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
        return yield* this.unarySteps(expression);
      }
      case 'template': {
        return yield* this.templateSteps(expression);
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
        const value = yield* this.callSteps(expression);
        return value === SHORT_CIRCUIT ? undefined : value;
      }
      case 'new': {
        return yield* this.newSteps(expression);
      }
      default: {
        throw new Error(`A yield in an unsupported expression: ${expression.kind}`);
      }
    }
  }
  private *yieldSteps(expression: Extract<Expression, { kind: 'yield' }>): Steps<Value> {
    const value = expression.argument ? yield* this.evaluateSteps(expression.argument) : undefined;
    if (expression.delegate) return yield* delegateYield(this.runtime, value, expression.isAsync);
    if (!expression.isAsync) return resumedValue(yield value);
    // An async generator awaits the value it yields, and the value `return()` resumes it with.
    const resume = yield resumedValue(yield new Awaiting(value));
    if (resume.kind === 'return') throw new GeneratorReturn(resumedValue(yield new Awaiting(resume.value)));
    return resumedValue(resume);
  }

  private *unarySteps(expression: Extract<Expression, { kind: 'unary' }>): Steps<Value> {
    let target = expression.argument;
    while (target.kind === 'parenthesized') target = target.expression;
    if (expression.operator === 'delete' && target.kind === 'member') {
      return this.deleteReference(yield* this.referenceSteps(target));
    }
    return this.unaryValue(expression.operator, yield* this.evaluateSteps(expression.argument));
  }

  /** Converts each substitution to a string before the next one is evaluated, as JavaScript does. */
  private *templateSteps(expression: Extract<Expression, { kind: 'template' }>): Steps<Value> {
    const { runtime } = this;
    let text = expression.strings[0];
    for (const [index, substitution] of expression.expressions.entries()) {
      const part = runtime.toString(yield* this.evaluateSteps(substitution)) + expression.strings[index + 1];
      runtime.extendString(text.length + part.length, part.length);
      text += part;
    }
    return text;
  }

  private *newSteps(expression: Extract<Expression, { kind: 'new' }>): Steps<Value> {
    const { runtime } = this;
    const constructor = yield* this.evaluateSteps(expression.callee);
    const args = yield* this.holdingSteps([constructor], () => this.argumentSteps(expression.args));
    if (!(constructor instanceof JsFunction) || !constructor.isConstructor) {
      return runtime.throwError('TypeError', `${expression.calleeText} is not a constructor`);
    }
    return this.holdWhile([constructor, ...args], () =>
      runtime.construct(constructor, args, constructor, expression.row)
    );
  }

  private *argumentSteps(args: Argument[]): Steps<Value[]> {
    // Arguments have no elisions, which are the only source of holes.
    return (yield* this.elementSteps(args)) as Value[];
  }

  /** Evaluates elements or arguments in order, holding the values so far; an elision leaves a hole. */
  private *elementSteps(elements: (Argument | undefined)[]): Steps<Element[]> {
    const { runtime } = this;
    const values: Element[] = [];
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    try {
      for (const element of elements) {
        if (element === undefined) {
          values.push(HOLE);
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

  protected *holdingSteps<T>(values: Value[], run: () => Steps<T>): Steps<T> {
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

  /** Evaluates the object of a member or call in an optional chain, keeping the chain's short-circuit. */
  private *chainSteps(expression: Expression): Steps<Value | typeof SHORT_CIRCUIT> {
    if (expression.kind === 'member' && expression.suspends) return yield* this.memberSteps(expression);
    if (expression.kind === 'call' && expression.suspends) return yield* this.callSteps(expression);
    // A link that does not suspend still carries the chain's short-circuit, as the synchronous chain does.
    return expression.suspends ? yield* this.evaluateSteps(expression) : this.evaluateChain(expression);
  }

  /** Reads a member whose object or key suspends, which short-circuits the rest of its optional chain on nullish. */
  private *memberSteps(expression: MemberExpression): Steps<Value | typeof SHORT_CIRCUIT> {
    const reference = yield* this.referenceSteps(expression);
    return reference === SHORT_CIRCUIT ? SHORT_CIRCUIT : this.getReference(reference);
  }

  /**
   * Resolves a member whose object or key suspends, evaluating them step by step in the order `memberReference`
   * does; a `super` member keeps its lookup in the parent with `this` as the receiver.
   */
  private *referenceSteps(target: MemberExpression): Steps<Reference | typeof SHORT_CIRCUIT> {
    const { runtime } = this;
    const { object, property } = target;
    const computedKey = (base: Value, key: Expression): Steps<Value> =>
      this.holdingSteps([base], () => this.evaluateSteps(key));
    if (object.kind === 'super') {
      const thisValue = this.thisValue();
      const key =
        property.kind === 'computed'
          ? runtime.toPropertyKey(yield* computedKey(thisValue, property.expression))
          : this.propertyKey(property);
      return { kind: 'super', key, thisValue };
    }
    const base = yield* this.chainSteps(object);
    if (base === SHORT_CIRCUIT || (target.optional && (base === undefined || base === null))) return SHORT_CIRCUIT;
    if (property.kind === 'private') return { kind: 'private', base, name: this.privateKey(property.name) };
    const key =
      property.kind === 'computed'
        ? runtime.toPropertyKey(yield* computedKey(base, property.expression))
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
          // A method keeps the object as its home, and a function takes a computed key as its name, as when defined at once.
          const { value: valueExpression } = member;
          const value =
            valueExpression.kind === 'functionExpression' && valueExpression.fn.kind === 'method'
              ? this.createFunction(valueExpression.fn, runtime.frame.scope, object)
              : yield* this.evaluateSteps(valueExpression);
          if (member.key.kind === 'computed' && value instanceof JsFunction) nameFunction(runtime, value, key);
          runtime.createDataProperty(object, key, value);
        } else {
          const accessor = this.createFunction(member.fn, runtime.frame.scope, object);
          defineAccessor(runtime, object, key, member.kind, accessor, true);
        }
      }
    }
  }

  /** The reference an assignment writes to, whose member target cannot be an optional chain. */
  private *assignmentReferenceSteps(target: MemberExpression): Steps<Reference> {
    if (!memberPartsSuspend(target)) return this.reference(target);
    return (yield* this.referenceSteps(target)) as Reference;
  }

  private *assignSteps(expression: Extract<Expression, { kind: 'assign' }>): Steps<Value> {
    const { runtime } = this;
    const { operator, target } = expression;
    if (operator === '=' && target.kind !== 'identifier' && target.kind !== 'member') {
      const value = yield* this.evaluateSteps(expression.value);
      this.bindPattern(target, value, 'assign');
      return value;
    }
    const reference = target.kind === 'member' ? yield* this.assignmentReferenceSteps(target) : this.reference(target);
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

  /** Evaluates a callee that suspends with the `this` its call passes, as {@link ExpressionEvaluator.callee} does. */
  private *calleeSteps(callee: Expression): Steps<{ fn: Value; thisValue: Value } | typeof SHORT_CIRCUIT> {
    let target = callee;
    while (target.kind === 'parenthesized') target = target.expression;
    if (target.kind !== 'member') {
      const fn = yield* this.chainSteps(callee);
      return fn === SHORT_CIRCUIT ? SHORT_CIRCUIT : { fn, thisValue: undefined };
    }
    const reference = yield* this.referenceSteps(target);
    if (reference === SHORT_CIRCUIT) return target === callee ? SHORT_CIRCUIT : { fn: undefined, thisValue: undefined };
    const thisValue = referenceBase(reference);
    return { fn: this.runtime.hold(thisValue, () => this.getReference(reference)), thisValue };
  }

  /** Calls a function whose callee or arguments suspend, which short-circuits the rest of its optional chain on nullish. */
  private *callSteps(expression: Extract<Expression, { kind: 'call' }>): Steps<Value | typeof SHORT_CIRCUIT> {
    const { runtime } = this;
    const callee = expression.callee as Expression;
    const resolved = callee.suspends ? yield* this.calleeSteps(callee) : this.callee(callee);
    if (resolved === SHORT_CIRCUIT) return SHORT_CIRCUIT;
    const { fn, thisValue } = resolved;
    if (expression.optional && (fn === undefined || fn === null)) return SHORT_CIRCUIT;
    const args = yield* this.holdingSteps([fn, thisValue], () => this.argumentSteps(expression.args));
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${expression.calleeText} is not a function`);
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

function memberPartsSuspend(target: MemberExpression): boolean {
  return (
    (target.object.kind !== 'super' && target.object.suspends === true) ||
    (target.property.kind === 'computed' && target.property.expression.suspends === true)
  );
}
