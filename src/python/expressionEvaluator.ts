// code-gauge-allow-file fileNcss 482 -- The expression evaluator keeps one method per kind of expression together.
import type {
  Argument,
  Comprehension,
  Constant,
  Element,
  Expression,
  FormattedValue,
  FunctionDef,
  NameRef,
  Target,
} from './ast';
import { moduleNameOf } from './classes';
import { newComplex } from './complexNumbers';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { Frame } from './frame';
import {
  bindValue,
  callValue,
  deleteAttribute,
  deleteItem,
  getAttribute,
  getItem,
  isTruthy,
  iterate,
  lengthOf,
  lookupSpecial,
  setAttribute,
  setItem,
  toArray,
} from './objects';
import { binaryOp, compareOp, unaryOp } from './operators';
import type { Runtime } from './runtime';
import {
  Ellipsis,
  functionClass,
  generatorClass,
  newDict,
  newList,
  newSet,
  newTuple,
  None,
  pyError,
  sliceClass,
  typeError,
  typeName,
} from './types';
import {
  DONE,
  type Kwargs,
  PyCell,
  PyClass,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyList,
  PySlice,
  PyTuple,
  type PyValue,
} from './values';

/** Evaluates expressions in a frame, synchronously: only statements may suspend a generator. */
export class ExpressionEvaluator {
  constructor(protected readonly runtime: Runtime) {}

  // code-gauge-allow functionNcss 45 -- One case per kind of expression.
  evaluate(expression: Expression, frame: Frame): PyValue {
    switch (expression.kind) {
      case 'name': {
        return this.loadName(expression, frame);
      }
      case 'constant': {
        return constantValue(expression.value);
      }
      case 'fstring': {
        return this.formattedString(expression.parts, frame);
      }
      case 'list':
      case 'tuple':
      case 'set': {
        return this.display(expression, frame);
      }
      case 'dict': {
        return this.dictDisplay(expression, frame);
      }
      case 'attribute': {
        return getAttribute(this.evaluate(expression.object, frame), expression.name);
      }
      case 'subscript': {
        const object = this.evaluate(expression.object, frame);
        return this.hold(frame, object, () => getItem(object, this.evaluate(expression.index, frame)));
      }
      case 'slice': {
        return this.slice(expression, frame);
      }
      case 'call': {
        return this.call(expression, frame);
      }
      case 'binary': {
        const left = this.evaluate(expression.left, frame);
        return this.hold(frame, left, () =>
          binaryOp(expression.operator, left, this.evaluate(expression.right, frame))
        );
      }
      case 'unary': {
        return unaryOp(expression.operator, this.evaluate(expression.operand, frame));
      }
      case 'not': {
        return !isTruthy(this.evaluate(expression.operand, frame));
      }
      case 'boolean': {
        const left = this.evaluate(expression.left, frame);
        const truthy = isTruthy(left);
        return (expression.operator === 'and' ? !truthy : truthy) ? left : this.evaluate(expression.right, frame);
      }
      case 'compare': {
        return this.compare(expression, frame);
      }
      case 'lambda': {
        return this.createFunction(expression.fn, frame, []);
      }
      case 'namedExpression': {
        const value = this.evaluate(expression.value, frame);
        this.storeName(expression.target, value, frame);
        return value;
      }
      case 'comprehension': {
        return this.comprehension(expression, frame);
      }
    }
    throw new Error('Unknown expression');
  }

  private display(expression: Extract<Expression, { kind: 'list' | 'tuple' | 'set' }>, frame: Frame): PyValue {
    if (expression.kind === 'set') {
      return this.withTemporaries(frame, () => {
        const items = this.elements(expression.elements, frame);
        this.runtime.allocate(items.length + 1);
        return newSet(items);
      });
    }
    const items = this.elements(expression.elements, frame);
    this.runtime.allocate(items.length + 1);
    return expression.kind === 'list' ? newList(items) : newTuple(items);
  }

  private slice(expression: Extract<Expression, { kind: 'slice' }>, frame: Frame): PyValue {
    const lower = expression.lower ? this.evaluate(expression.lower, frame) : None;
    const upper = expression.upper ? this.evaluate(expression.upper, frame) : None;
    const step = expression.step ? this.evaluate(expression.step, frame) : None;
    return new PySlice(sliceClass, lower, upper, step);
  }

  /** Keeps a value reachable for garbage collection while `run` evaluates more of the expression holding it. */
  protected hold<T>(frame: Frame, value: PyValue, run: () => T): T {
    const { temporaries } = frame;
    const length = temporaries.length;
    temporaries.push(value);
    try {
      return run();
    } finally {
      temporaries.length = length;
    }
  }

  private withTemporaries<T>(frame: Frame, run: () => T): T {
    const length = frame.temporaries.length;
    try {
      return run();
    } finally {
      frame.temporaries.length = length;
    }
  }

  // Names -----------------------------------------------------------------------------------------------------------

  loadName(ref: NameRef, frame: Frame): PyValue {
    const { name } = ref;
    switch (ref.access) {
      case 'local': {
        const value = frame.locals.get(name);
        if (value === undefined) throw unboundLocal(name);
        return value;
      }
      case 'cell': {
        const value = frame.cells.get(name)?.value;
        if (value === undefined) {
          if (frame.scope.cells.includes(name)) throw unboundLocal(name);
          throw this.nameError(
            `cannot access free variable '${name}' where it is not associated with a value in enclosing scope`,
            name,
            frame
          );
        }
        return value;
      }
      case 'name': {
        const value = frame.locals.get(name) ?? frame.globals.get(name) ?? this.runtime.builtins.get(name);
        if (value === undefined) throw this.nameError(`name '${name}' is not defined`, name, frame);
        return value;
      }
      case 'classCell': {
        const value = frame.locals.get(name) ?? frame.cells.get(name)?.value;
        if (value === undefined) {
          throw this.nameError(
            `cannot access free variable '${name}' where it is not associated with a value in enclosing scope`,
            name,
            frame
          );
        }
        return value;
      }
      default: {
        const value = frame.globals.get(name) ?? this.runtime.builtins.get(name);
        if (value === undefined) throw this.nameError(`name '${name}' is not defined`, name, frame);
        return value;
      }
    }
  }

  private nameError(message: string, name: string, frame: Frame): PyError {
    const error = pyError('NameError', message);
    const state = error.exception.exception;
    if (state) {
      state.name = name;
      state.candidates = [
        ...frame.locals.keys(),
        ...[...frame.cells.entries()].filter(([, cell]) => cell.value !== undefined).map(([key]) => key),
        ...(frame.globals === frame.locals ? [] : frame.globals.keys()),
        ...this.runtime.builtins.keys(),
      ];
      state.selfValue = frame.kind === 'function' ? frame.locals.get('self') : undefined;
    }
    return error;
  }

  storeName(ref: NameRef, value: PyValue, frame: Frame): void {
    const { name } = ref;
    switch (ref.access) {
      case 'local':
      case 'name': {
        frame.locals.set(name, value);
        return;
      }
      case 'cell':
      case 'classCell': {
        const cell = frame.cells.get(name);
        if (cell) cell.value = value;
        else frame.cells.set(name, new PyCell(value));
        return;
      }
      default: {
        frame.globals.set(name, value);
      }
    }
  }

  deleteName(ref: NameRef, frame: Frame): void {
    const { name } = ref;
    switch (ref.access) {
      case 'local': {
        if (!frame.locals.delete(name)) throw unboundLocal(name);
        return;
      }
      case 'cell':
      case 'classCell': {
        const cell = frame.cells.get(name);
        if (cell?.value === undefined) throw unboundLocal(name);
        cell.value = undefined;
        return;
      }
      case 'name': {
        if (!frame.locals.delete(name)) throw this.nameError(`name '${name}' is not defined`, name, frame);
        return;
      }
      default: {
        if (!frame.globals.delete(name)) throw this.nameError(`name '${name}' is not defined`, name, frame);
      }
    }
  }

  // Targets ---------------------------------------------------------------------------------------------------------

  assign(target: Target, value: PyValue, frame: Frame): void {
    switch (target.kind) {
      case 'name': {
        this.storeName(target, value, frame);
        return;
      }
      case 'attribute': {
        this.hold(frame, value, () => setAttribute(this.evaluate(target.object, frame), target.name, value));
        return;
      }
      case 'subscript': {
        this.hold(frame, value, () => {
          const object = this.evaluate(target.object, frame);
          this.hold(frame, object, () => setItem(object, this.evaluate(target.index, frame), value));
        });
        return;
      }
      case 'unpack': {
        const items = unpack(value, target.elements.length);
        this.hold(frame, value, () => {
          for (const [index, element] of target.elements.entries()) this.assign(element, items[index], frame);
        });
      }
    }
  }

  deleteTarget(target: Target, frame: Frame): void {
    switch (target.kind) {
      case 'name': {
        this.deleteName(target, frame);
        return;
      }
      case 'attribute': {
        deleteAttribute(this.evaluate(target.object, frame), target.name);
        return;
      }
      case 'subscript': {
        const object = this.evaluate(target.object, frame);
        deleteItem(object, this.evaluate(target.index, frame));
        return;
      }
      case 'unpack': {
        for (const element of target.elements) this.deleteTarget(element, frame);
      }
    }
  }

  // Displays --------------------------------------------------------------------------------------------------------

  private elements(elements: Element[], frame: Frame): PyValue[] {
    const items: PyValue[] = [];
    const { temporaries } = frame;
    const length = temporaries.length;
    try {
      for (const element of elements) {
        if (element.kind === 'starred') {
          const iterable = this.evaluate(element.value, frame);
          for (const item of starredItems(iterable)) {
            items.push(item);
            temporaries.push(item);
          }
        } else {
          const item = this.evaluate(element, frame);
          items.push(item);
          temporaries.push(item);
        }
      }
    } finally {
      temporaries.length = length;
    }
    return items;
  }

  private dictDisplay(expression: Extract<Expression, { kind: 'dict' }>, frame: Frame): PyValue {
    return this.withTemporaries(frame, () => {
      const dict = newDict();
      frame.temporaries.push(dict);
      for (const item of expression.items) {
        if (item.kind === 'doubleStar') {
          const mapping = this.evaluate(item.value, frame);
          for (const [key, value] of mappingEntries(mapping)) dict.store.set(key, value);
          continue;
        }
        const key = this.evaluate(item.key, frame);
        frame.temporaries.push(key);
        const value = this.evaluate(item.value, frame);
        dict.store.set(key, value);
      }
      this.runtime.allocate(dict.store.size + 1);
      return dict;
    });
  }

  private formattedString(parts: (string | FormattedValue)[], frame: Frame): string {
    let result = '';
    for (const part of parts) {
      if (typeof part === 'string') {
        result += part;
        continue;
      }
      let value = this.evaluate(part.expression, frame);
      if (part.conversion === 'r') value = pyRepr(value);
      else if (part.conversion === 's') value = pyStr(value);
      else if (part.conversion === 'a') value = pyAscii(value);
      const spec = part.spec ? (this.evaluate(part.spec, frame) as string) : '';
      result += (part.debugText ?? '') + pyFormat(value, spec);
      this.runtime.buildString(result.length);
    }
    return result;
  }

  // Calls -----------------------------------------------------------------------------------------------------------

  private call(expression: Extract<Expression, { kind: 'call' }>, frame: Frame): PyValue {
    const { runtime } = this;
    const callee = this.evaluate(expression.callee, frame);
    return this.withTemporaries(frame, () => {
      frame.temporaries.push(callee);
      const { args, kwargs } = this.arguments(expression.args, frame, callee);
      const outerRow = runtime.currentRow;
      runtime.currentRow = expression.row;
      try {
        return callValue(callee, args, kwargs);
      } finally {
        runtime.currentRow = outerRow;
      }
    });
  }

  /** Evaluates call arguments, holding each for garbage collection until the call returns. */
  // code-gauge-allow functionNcss 40 -- Evaluates each kind of argument in order, raising CPython's errors for unpacking.
  // code-gauge-allow functionCognitiveComplexity 26 -- Evaluates each kind of argument in order, raising CPython's errors for unpacking.
  protected arguments(argumentList: Argument[], frame: Frame, callee: PyValue): { args: PyValue[]; kwargs: Kwargs } {
    const args: PyValue[] = [];
    let kwargs: Map<string, PyValue> | undefined;
    for (const argument of argumentList) {
      switch (argument.kind) {
        case 'positional': {
          const value = this.evaluate(argument.value, frame);
          args.push(value);
          frame.temporaries.push(value);
          break;
        }
        case 'star': {
          const iterable = this.evaluate(argument.value, frame);
          if (!isIterable(iterable)) {
            throw typeError(`${calleeName(callee)} argument after * must be an iterable, not ${typeName(iterable)}`);
          }
          for (const item of toArray(iterable)) {
            args.push(item);
            frame.temporaries.push(item);
          }
          break;
        }
        case 'keyword': {
          const value = this.evaluate(argument.value, frame);
          kwargs ??= new Map();
          if (kwargs.has(argument.name)) {
            throw typeError(`${calleeName(callee)} got multiple values for keyword argument '${argument.name}'`);
          }
          kwargs.set(argument.name, value);
          frame.temporaries.push(value);
          break;
        }
        case 'doubleStar': {
          const mapping = this.evaluate(argument.value, frame);
          if (lookupSpecial(mapping, 'keys') === undefined) {
            throw typeError(`${calleeName(callee)} argument after ** must be a mapping, not ${typeName(mapping)}`);
          }
          kwargs ??= new Map();
          for (const [key, value] of mappingEntries(mapping)) {
            if (typeof key !== 'string') throw typeError('keywords must be strings');
            if (kwargs.has(key))
              throw typeError(`${calleeName(callee)} got multiple values for keyword argument '${key}'`);
            kwargs.set(key, value);
            frame.temporaries.push(value);
          }
          break;
        }
      }
    }
    return { args, kwargs };
  }

  private compare(expression: Extract<Expression, { kind: 'compare' }>, frame: Frame): PyValue {
    let left = this.evaluate(expression.operands[0], frame);
    let result: PyValue = true;
    for (const [index, operator] of expression.operators.entries()) {
      const right = this.hold(frame, left, () => this.evaluate(expression.operands[index + 1], frame));
      result = this.hold(frame, right, () => compareOp(operator, left, right));
      if (index < expression.operators.length - 1 && !isTruthy(result)) return result;
      left = right;
    }
    return result;
  }

  // Functions -------------------------------------------------------------------------------------------------------

  /** Creates a function object, evaluating its defaults in the defining frame. */
  createFunction(def: FunctionDef, frame: Frame, decorators: PyValue[]): PyValue {
    const defaults: PyValue[] = [];
    const keywordDefaults = new Map<string, PyValue>();
    for (const param of def.params) {
      if (!param.default) continue;
      const value = this.evaluate(param.default, frame);
      if (param.kind === 'keywordOnly') keywordDefaults.set(param.name, value);
      else defaults.push(value);
    }
    const closure = new Map<string, PyCell>();
    for (const name of def.scope.frees) {
      let cell = frame.cells.get(name);
      if (!cell) {
        cell = new PyCell();
        frame.cells.set(name, cell);
      }
      closure.set(name, cell);
    }
    const fn = new PyFunction(
      functionClass,
      def,
      frame.globals,
      closure,
      defaults,
      keywordDefaults,
      def.usesClassCell ? frame.classCell : undefined
    );
    fn.module = moduleNameOf(frame);
    this.runtime.allocate(2);
    let result: PyValue = fn;
    for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
    return result;
  }

  /** The annotations of a function, evaluated when the program reads `__annotations__`. */
  annotationsOf(fn: PyFunction): PyDict {
    const dict = newDict();
    const frame = this.runtime.frame;
    for (const param of fn.def.params) {
      if (param.annotation) dict.store.set(param.name, this.evaluate(param.annotation, frame));
    }
    if (fn.def.returns) dict.store.set('return', this.evaluate(fn.def.returns, frame));
    return dict;
  }

  // Comprehensions --------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 32 -- Follows how CPython runs each kind of comprehension in its own scope.
  private comprehension(expression: Extract<Expression, { kind: 'comprehension' }>, frame: Frame): PyValue {
    const { runtime } = this;
    const first = this.evaluate(expression.generators[0].iterable, frame);
    const next = iterate(first);
    const inner = this.comprehensionFrame(expression, frame);
    if (expression.type === 'generator') {
      const body = this.comprehensionItems(expression, inner, next);
      return new PyGenerator(
        generatorClass,
        '<genexpr>',
        '<genexpr>',
        () => {
          runtime.pushFrame(inner);
          try {
            return body.next();
          } finally {
            runtime.popFrame();
          }
        },
        () => [first, ...inner.locals.values(), ...inner.temporaries]
      );
    }
    runtime.pushFrame(inner);
    try {
      inner.temporaries.push(first);
      if (expression.type === 'dict') {
        const dict = newDict();
        inner.temporaries.push(dict);
        const items = this.comprehensionItems(expression, inner, next, (key, value) => dict.store.set(key, value));
        while (!items.next().done);
        return dict;
      }
      const items: PyValue[] = [];
      const container = expression.type === 'list' ? newList(items) : newSet();
      inner.temporaries.push(container);
      for (const item of this.comprehensionItems(expression, inner, next)) {
        runtime.allocate(1);
        if (container instanceof PyList) items.push(item);
        else container.table.add(item);
      }
      return container;
    } finally {
      runtime.popFrame();
    }
  }

  private comprehensionFrame(expression: Extract<Expression, { kind: 'comprehension' }>, frame: Frame): Frame {
    const cells = new Map<string, PyCell>();
    for (const name of expression.scope.frees) {
      let cell = frame.cells.get(name);
      if (!cell) {
        cell = new PyCell();
        frame.cells.set(name, cell);
      }
      cells.set(name, cell);
    }
    for (const name of expression.scope.cells) cells.set(name, new PyCell());
    return new Frame(
      'comprehension',
      new Map(),
      cells,
      frame.globals,
      undefined,
      false,
      expression.scope,
      frame.fn,
      frame.classCell
    );
  }

  /** Runs the clauses of a comprehension, yielding each element, or storing each pair through `store`. */
  private *comprehensionItems(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    firstNext: () => PyValue | typeof DONE,
    store?: (key: PyValue, value: PyValue) => void
  ): Generator<PyValue, PyValue> {
    const { generators } = expression;
    const { runtime } = this;
    const level = function* (
      this: ExpressionEvaluator,
      index: number,
      next: () => PyValue | typeof DONE
    ): Generator<PyValue, undefined> {
      const generator: Comprehension = generators[index];
      for (let item = next(); item !== DONE; item = next()) {
        runtime.spend();
        this.assign(generator.target, item, frame);
        if (!generator.conditions.every((condition) => isTruthy(this.evaluate(condition, frame)))) continue;
        if (index + 1 < generators.length) {
          const iterable = this.evaluate(generators[index + 1].iterable, frame);
          const length = frame.temporaries.length;
          frame.temporaries.push(iterable);
          try {
            yield* level.call(this, index + 1, iterate(iterable));
          } finally {
            frame.temporaries.length = length;
          }
          continue;
        }
        if (store) {
          const key = this.evaluate(expression.element, frame);
          store(
            key,
            this.hold(frame, key, () => this.evaluate(expression.value as Expression, frame))
          );
          continue;
        }
        yield this.evaluate(expression.element, frame);
      }
      return undefined;
    };
    yield* level.call(this, 0, firstNext);
    return None;
  }
}

function constantValue(constant: Constant): PyValue {
  switch (constant.kind) {
    case 'int':
    case 'float':
    case 'str':
    case 'bool': {
      return constant.value;
    }
    case 'none': {
      return None;
    }
    case 'ellipsis': {
      return Ellipsis;
    }
    case 'imaginary': {
      return newComplex(0, constant.value);
    }
  }
}

function unboundLocal(name: string): PyError {
  const error = pyError(
    'UnboundLocalError',
    `cannot access local variable '${name}' where it is not associated with a value`
  );
  const state = error.exception.exception;
  if (state) state.name = name;
  return error;
}

function calleeName(callee: PyValue): string {
  if (callee instanceof PyFunction) return `${callee.qualifiedName}()`;
  if (callee instanceof PyClass) return `${callee.qualifiedName}()`;
  if (callee instanceof PyInstance || callee instanceof PyTuple) return `${typeName(callee)} object`;
  const name = (callee as { qualifiedName?: string }).qualifiedName;
  return name ? `${name}()` : `${typeName(callee)} object`;
}

function isIterable(value: PyValue): boolean {
  if (typeof value === 'string' || value instanceof PyList || value instanceof PyTuple || value instanceof PyDict)
    return true;
  return lookupSpecial(value, '__iter__') !== undefined || lookupSpecial(value, '__getitem__') !== undefined;
}

function starredItems(value: PyValue): PyValue[] {
  if (!isIterable(value)) throw typeError(`Value after * must be an iterable, not ${typeName(value)}`);
  return toArray(value);
}

/** The key-value pairs of a mapping, read through `keys()` and indexing for mappings that are not dicts. */
export function mappingEntries(mapping: PyValue): [PyValue, PyValue][] {
  if (mapping instanceof PyDict) return mapping.store.ordered().map((entry) => [entry.key, entry.value]);
  const keys = lookupSpecial(mapping, 'keys');
  if (keys === undefined) throw typeError(`'${typeName(mapping)}' object is not a mapping`);
  return toArray(callValue(bindValue(keys, mapping), [])).map((key) => [key, getItem(mapping, key)]);
}

/** The items a target list unpacks a value into, raising the errors CPython raises for a count mismatch. */
// code-gauge-allow functionCognitiveComplexity 18 -- Matches CPython's messages for each way unpacking fails.
export function unpack(value: PyValue, count: number): PyValue[] {
  if (value instanceof PyList || value instanceof PyTuple || typeof value === 'string') {
    const items = value instanceof PyList || value instanceof PyTuple ? value.items : toArray(value);
    if (items.length > count)
      throw pyError('ValueError', `too many values to unpack (expected ${count}, got ${items.length})`);
    if (items.length < count) {
      throw pyError('ValueError', `not enough values to unpack (expected ${count}, got ${items.length})`);
    }
    return [...items];
  }
  if (!isIterable(value)) throw typeError(`cannot unpack non-iterable ${typeName(value)} object`);
  const next = iterate(value);
  const items: PyValue[] = [];
  for (let index = 0; index < count; index++) {
    const item = next();
    if (item === DONE)
      throw pyError('ValueError', `not enough values to unpack (expected ${count}, got ${items.length})`);
    items.push(item);
  }
  if (next() !== DONE) {
    let length: number | undefined;
    try {
      length = lengthOf(value);
    } catch {
      length = undefined;
    }
    throw pyError(
      'ValueError',
      `too many values to unpack (expected ${count}${length === undefined ? '' : `, got ${length}`})`
    );
  }
  return items;
}

export { PyError };
