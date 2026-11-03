import type { Argument, ClassNode, Expression, MemberExpression, ObjectMember } from './ast';
import { EvaluatorBase, nameFunction, type Reference, referenceBase, SHORT_CIRCUIT } from './evaluatorBase';
import {
  type AccessorProperty,
  appendAll,
  type Element,
  HOLE,
  isAccessor,
  isCallable,
  isObject,
  type JsArray,
  JsFunction,
  type JsObject,
  toBoolean,
  type Value,
} from './values';

type ChainValue = Value | typeof SHORT_CIRCUIT;

export abstract class ExpressionEvaluator extends EvaluatorBase {
  abstract evaluateClass(cls: ClassNode): JsFunction;

  abstract superCall(args: Value[], callRow: number): JsObject;

  evaluate(expression: Expression): Value {
    const value = this.evaluateChain(expression);
    return value === SHORT_CIRCUIT ? undefined : value;
  }

  private evaluateChain(expression: Expression): ChainValue {
    const { runtime } = this;
    const outerRow = runtime.currentRow;
    runtime.currentRow = expression.row;
    try {
      return this.evaluateKind(expression);
    } finally {
      runtime.currentRow = outerRow;
    }
  }

  // code-gauge-allow functionNcss 60 -- One case per expression kind, each delegating where it grows.
  private evaluateKind(expression: Expression): ChainValue {
    const { runtime } = this;
    switch (expression.kind) {
      case 'literal': {
        return expression.value;
      }
      case 'template': {
        return this.template(expression.strings, expression.expressions);
      }
      case 'identifier': {
        return this.readVariable(expression.name);
      }
      case 'this': {
        return this.thisValue();
      }
      case 'array': {
        return this.arrayLiteral(expression.elements);
      }
      case 'object': {
        return this.objectLiteral(expression.members);
      }
      case 'functionExpression': {
        return this.createFunction(expression.fn, runtime.frame.scope);
      }
      case 'classExpression': {
        return this.evaluateClass(expression.cls);
      }
      case 'member': {
        return this.member(expression);
      }
      case 'call': {
        return this.call(expression);
      }
      case 'new': {
        return this.newExpression(expression);
      }
      case 'assign': {
        return this.assign(expression);
      }
      case 'update': {
        const reference = this.reference(expression.target);
        const oldValue = runtime.toNumber(this.getReference(reference));
        const newValue = expression.operator === '++' ? oldValue + 1 : oldValue - 1;
        this.putReference(reference, newValue);
        return expression.prefix ? newValue : oldValue;
      }
      case 'unary': {
        return this.unary(expression.operator, expression.argument);
      }
      case 'binary': {
        const left = this.evaluate(expression.left);
        const right = runtime.hold(left, () => this.evaluate(expression.right));
        return this.binary(expression.operator, left, right);
      }
      case 'logical': {
        const left = this.evaluate(expression.left);
        return shortCircuits(expression.operator, left) ? left : this.evaluate(expression.right);
      }
      case 'conditional': {
        return toBoolean(this.evaluate(expression.test))
          ? this.evaluate(expression.consequent)
          : this.evaluate(expression.alternate);
      }
      case 'sequence': {
        let value: Value;
        for (const item of expression.expressions) value = this.evaluate(item);
        return value;
      }
      case 'parenthesized': {
        return this.evaluate(expression.expression);
      }
    }
  }

  private template(strings: string[], expressions: Expression[]): string {
    const { runtime } = this;
    let text = strings[0];
    for (const [index, expression] of expressions.entries()) {
      const part = runtime.toString(this.evaluate(expression)) + strings[index + 1];
      runtime.extendString(text.length + part.length, part.length);
      text += part;
    }
    return text;
  }

  evaluateArguments(args: Argument[]): Value[] {
    // Arguments have no elisions, which are the only source of holes.
    return this.evaluateElements(args) as Value[];
  }

  /** Evaluates elements in order, holding the values so far for garbage collection; an elision leaves a hole. */
  private evaluateElements(args: (Argument | undefined)[]): Element[] {
    const { runtime } = this;
    const values: Element[] = [];
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    try {
      for (const argument of args) {
        if (argument === undefined) {
          values.push(HOLE);
        } else if (argument.kind === 'spread') {
          const spread = runtime.iterate(this.evaluate(argument.argument));
          runtime.allocate(spread.length);
          appendAll(values, spread);
          appendAll(temporaries, spread);
        } else {
          const value = this.evaluate(argument);
          values.push(value);
          temporaries.push(value);
        }
      }
      return values;
    } finally {
      temporaries.length = held;
    }
  }

  private arrayLiteral(elements: (Argument | undefined)[]): JsArray {
    return this.runtime.newArray(this.evaluateElements(elements));
  }

  private objectLiteral(members: ObjectMember[]): JsObject {
    const { runtime } = this;
    const object = runtime.newObject();
    runtime.hold(object, () => {
      for (const member of members) this.defineObjectMember(object, member);
    });
    return object;
  }

  private defineObjectMember(object: JsObject, member: ObjectMember): void {
    const { runtime } = this;
    if (member.kind === 'spread') {
      this.copyDataProperties(object, this.evaluate(member.argument));
      return;
    }
    const key = this.propertyKey(member.key);
    if (member.kind !== 'property') {
      defineAccessor(
        runtime,
        object,
        key,
        member.kind,
        this.createFunction(member.fn, runtime.frame.scope, object),
        true
      );
      return;
    }
    const { value: valueExpression } = member;
    const value =
      valueExpression.kind === 'functionExpression' && valueExpression.fn.kind === 'method'
        ? this.createFunction(valueExpression.fn, runtime.frame.scope, object)
        : this.evaluate(valueExpression);
    if (member.key.kind === 'computed' && value instanceof JsFunction) nameFunction(runtime, value, key);
    runtime.createDataProperty(object, key, value);
  }

  private copyDataProperties(target: JsObject, source: Value): void {
    const { runtime } = this;
    if (source === undefined || source === null) return;
    if (typeof source === 'string') {
      // A string's properties are its UTF-16 code units.
      for (const [index, character] of source.split('').entries()) {
        runtime.createDataProperty(target, String(index), character);
      }
      return;
    }
    if (!isObject(source)) return;
    for (const key of runtime.ownEnumerableKeys(source))
      runtime.createDataProperty(target, key, runtime.get(source, key));
  }

  private member(expression: Extract<Expression, { kind: 'member' }>): ChainValue {
    const { runtime } = this;
    if (expression.object.kind === 'super') return this.getReference(this.memberReference(expression));
    const base = this.evaluateChain(expression.object);
    if (base === SHORT_CIRCUIT) return SHORT_CIRCUIT;
    if (expression.optional && (base === undefined || base === null)) return SHORT_CIRCUIT;
    return runtime.hold(base, () => {
      if (expression.property.kind === 'private')
        return runtime.getPrivate(base, this.privateKey(expression.property.name));
      return runtime.get(base, this.propertyKey(expression.property));
    });
  }

  private call(expression: Extract<Expression, { kind: 'call' }>): ChainValue {
    const { runtime } = this;
    const { callee } = expression;
    if (callee.kind === 'super') {
      return this.superCall(this.evaluateArguments(expression.args), expression.row);
    }
    const resolved = this.callee(callee);
    if (resolved === SHORT_CIRCUIT) return SHORT_CIRCUIT;
    const { fn, thisValue } = resolved;
    if (expression.optional && (fn === undefined || fn === null)) return SHORT_CIRCUIT;
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${expression.calleeText} is not a function`);
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    temporaries.push(fn, thisValue);
    try {
      const args = this.evaluateArguments(expression.args);
      appendAll(temporaries, args);
      return runtime.call(fn, thisValue, args, expression.row);
    } finally {
      temporaries.length = held;
    }
  }

  /** Evaluates a callee with the `this` a call passes, which is the object of a (parenthesized) member. */
  private callee(callee: Expression): { fn: Value; thisValue: Value } | typeof SHORT_CIRCUIT {
    const target = callee.kind === 'parenthesized' && callee.expression.kind === 'member' ? callee.expression : callee;
    if (target.kind !== 'member') {
      const fn = this.evaluateChain(callee);
      return fn === SHORT_CIRCUIT ? SHORT_CIRCUIT : { fn, thisValue: undefined };
    }
    const reference = this.calleeReference(target, target === callee);
    if (reference === SHORT_CIRCUIT) return SHORT_CIRCUIT;
    const thisValue = referenceBase(reference);
    return { fn: this.runtime.hold(thisValue, () => this.getReference(reference)), thisValue };
  }

  private calleeReference(target: MemberExpression, continuesChain: boolean): Reference | typeof SHORT_CIRCUIT {
    if (target.object.kind === 'super') return this.memberReference(target);
    const base = continuesChain ? this.evaluateChain(target.object) : this.evaluate(target.object);
    if (base === SHORT_CIRCUIT || (target.optional && (base === undefined || base === null))) return SHORT_CIRCUIT;
    return this.runtime.hold(base, (): Reference =>
      target.property.kind === 'private'
        ? { kind: 'private', base, name: this.privateKey(target.property.name) }
        : { kind: 'property', base, key: this.propertyKey(target.property) }
    );
  }

  private newExpression(expression: Extract<Expression, { kind: 'new' }>): Value {
    const { runtime } = this;
    const constructor = this.evaluate(expression.callee);
    if (!(constructor instanceof JsFunction) || !constructor.isConstructor) {
      return runtime.throwError('TypeError', `${expression.calleeText} is not a constructor`);
    }
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    temporaries.push(constructor);
    try {
      const args = this.evaluateArguments(expression.args);
      appendAll(temporaries, args);
      return runtime.construct(constructor, args, constructor, expression.row);
    } finally {
      temporaries.length = held;
    }
  }

  private assign(expression: Extract<Expression, { kind: 'assign' }>): Value {
    const { runtime } = this;
    const { operator, target } = expression;
    if (operator === '=' && target.kind !== 'identifier' && target.kind !== 'member') {
      const value = this.evaluate(expression.value);
      this.bindPattern(target, value, 'assign');
      return value;
    }
    const reference = this.reference(target);
    return runtime.hold(referenceBase(reference), () => {
      if (operator === '=') {
        const value = this.evaluate(expression.value);
        this.putReference(reference, value);
        return value;
      }
      const current = this.getReference(reference);
      const baseOperator = operator.slice(0, -1);
      if (isLogicalOperator(baseOperator)) {
        if (shortCircuits(baseOperator, current)) return current;
        const value = this.evaluate(expression.value);
        this.putReference(reference, value);
        return value;
      }
      const right = runtime.hold(current, () => this.evaluate(expression.value));
      const value = this.binary(baseOperator, current, right);
      this.putReference(reference, value);
      return value;
    });
  }

  private deleteExpression(argument: Expression): boolean {
    const { runtime } = this;
    const target = argument.kind === 'parenthesized' ? argument.expression : argument;
    if (target.kind !== 'member') {
      this.evaluate(argument);
      return true;
    }
    // An optional chain that meets null or undefined deletes nothing, which succeeds.
    const reference = this.calleeReference(target, target === argument);
    if (reference === SHORT_CIRCUIT) return true;
    if (reference.kind === 'super') return runtime.throwError('ReferenceError', "Unsupported reference to 'super'");
    if (reference.kind !== 'property') return runtime.throwError('TypeError', 'Private fields can not be deleted');
    return runtime.deleteProperty(reference.base, reference.key);
  }

  private unary(operator: string, argument: Expression): Value {
    const { runtime } = this;
    switch (operator) {
      case 'typeof': {
        if (argument.kind === 'identifier' && !runtime.frame.scope.lookup(argument.name)) return 'undefined';
        return runtime.typeOf(this.evaluate(argument));
      }
      case 'delete': {
        return this.deleteExpression(argument);
      }
      case 'void': {
        this.evaluate(argument);
        return undefined;
      }
      case '!': {
        return !toBoolean(this.evaluate(argument));
      }
      case '-': {
        return -runtime.toNumber(this.evaluate(argument));
      }
      case '+': {
        return runtime.toNumber(this.evaluate(argument));
      }
      case '~': {
        return ~runtime.toNumber(this.evaluate(argument));
      }
      default: {
        throw new Error(`Unknown unary operator: ${operator}`);
      }
    }
  }

  // code-gauge-allow functionNcss 40 -- One case per operator.
  binary(operator: string, left: Value, right: Value): Value {
    const { runtime } = this;
    switch (operator) {
      case '+': {
        const leftPrimitive = runtime.toPrimitive(left, 'default');
        const rightPrimitive = runtime.toPrimitive(right, 'default');
        if (typeof leftPrimitive === 'string' || typeof rightPrimitive === 'string') {
          const text = String(leftPrimitive) + String(rightPrimitive);
          runtime.buildString(text.length);
          return text;
        }
        return Number(leftPrimitive) + Number(rightPrimitive);
      }
      case '===': {
        return left === right;
      }
      case '!==': {
        return left !== right;
      }
      case '==': {
        return runtime.looseEquals(left, right);
      }
      case '!=': {
        return !runtime.looseEquals(left, right);
      }
      case '<':
      case '>':
      case '<=':
      case '>=': {
        return compare(operator, runtime.toPrimitive(left, 'number'), runtime.toPrimitive(right, 'number'));
      }
      case 'instanceof': {
        return runtime.instanceOf(left, right);
      }
      case 'in': {
        if (!isObject(right)) {
          return runtime.throwError(
            'TypeError',
            `Cannot use 'in' operator to search for '${runtime.toPropertyKey(left)}' in ${runtime.describe(right)}`
          );
        }
        return runtime.hasProperty(right, runtime.toPropertyKey(left));
      }
      default: {
        return arithmetic(operator, runtime.toNumber(left), runtime.toNumber(right));
      }
    }
  }
}

type LogicalOperator = '&&' | '||' | '??';

function isLogicalOperator(operator: string): operator is LogicalOperator {
  return operator === '&&' || operator === '||' || operator === '??';
}

/** Whether a logical operator yields its left operand without evaluating its right one. */
function shortCircuits(operator: LogicalOperator, left: Value): boolean {
  if (operator === '&&') return !toBoolean(left);
  if (operator === '||') return toBoolean(left);
  return left !== undefined && left !== null;
}

type Primitive = undefined | null | boolean | number | string;

/** Compares primitives with the host's operators, which follow JavaScript's rules for them. */
function compare(operator: '<' | '>' | '<=' | '>=', left: Primitive, right: Primitive): boolean {
  const a = left as number;
  const b = right as number;
  switch (operator) {
    case '<': {
      return a < b;
    }
    case '>': {
      return a > b;
    }
    case '<=': {
      return a <= b;
    }
    case '>=': {
      return a >= b;
    }
  }
}

function arithmetic(operator: string, left: number, right: number): number {
  switch (operator) {
    case '-': {
      return left - right;
    }
    case '*': {
      return left * right;
    }
    case '/': {
      return left / right;
    }
    case '%': {
      return left % right;
    }
    case '**': {
      return left ** right;
    }
    case '&': {
      return left & right;
    }
    case '|': {
      return left | right;
    }
    case '^': {
      return left ^ right;
    }
    case '<<': {
      return left << right;
    }
    case '>>': {
      return left >> right;
    }
    case '>>>': {
      return left >>> right;
    }
    default: {
      throw new Error(`Unknown binary operator: ${operator}`);
    }
  }
}

/** Adds a getter or setter, keeping the other half of an accessor already defined under the same key. */
export function defineAccessor(
  runtime: EvaluatorBase['runtime'],
  object: JsObject,
  key: string,
  kind: 'getter' | 'setter',
  fn: JsFunction,
  enumerable: boolean
): void {
  const existing = object.properties.get(key);
  const accessor: AccessorProperty =
    existing && isAccessor(existing) ? existing : { get: undefined, set: undefined, enumerable, configurable: true };
  if (kind === 'getter') accessor.get = fn;
  else accessor.set = fn;
  runtime.defineProperty(object, key, accessor);
}
