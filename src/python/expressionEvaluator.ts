import { pushAll } from './arrays';
// code-gauge-allow-file fileNcss 490 -- The expression evaluator keeps one method per kind of expression together.
import type { Argument, Comprehension, Element, Expression, FormattedValue, FunctionDef, NameRef, Target } from './ast';
import { functionStr, KeywordArguments, mappingEntries } from './callArguments';
import { moduleNameOf } from './classes';
import { constantValue, foldConstants } from './constantFolding';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { Frame } from './frame';
import {
  callValue,
  deleteAttribute,
  deleteItem,
  getAttribute,
  getItem,
  isTruthy,
  iterate,
  iterateHeld,
  lengthOf,
  lookupSpecial,
  setAttribute,
  setItem,
  toArray,
} from './objects';
import { binaryOp, compareOp, unaryOp } from './operators';
import type { Runtime } from './runtime';
import { withoutCharge } from './runtimeContext';
import { addToTable, updateTable } from './setOperations';
import {
  dictClass,
  functionClass,
  generatorClass,
  listClass,
  newDict,
  newList,
  newSet,
  newTuple,
  None,
  pyError,
  sliceClass,
  tupleClass,
  typeError,
  typeName,
} from './types';
import {
  DONE,
  type Kwargs,
  PyCell,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyList,
  type PySet,
  PySlice,
  PyTuple,
  type PyValue,
} from './values';

// CPython's compiler pushes at most this many elements of a display before building the collection.
const MAX_STACKED_ELEMENTS = 30;
const MIN_FOLDED_ELEMENTS = 3;

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

  /** Evaluates the iterable of a `for` clause, which CPython compiles differently when it is a set display. */
  protected evaluateIterable(expression: Expression, frame: Frame): PyValue {
    return expression.kind === 'set'
      ? this.setDisplay(expression.elements, frame, true)
      : this.evaluate(expression, frame);
  }

  private display(expression: Extract<Expression, { kind: 'list' | 'tuple' | 'set' }>, frame: Frame): PyValue {
    if (expression.kind === 'set') return this.setDisplay(expression.elements, frame, false);
    const items = this.elements(expression.elements, frame);
    return expression.kind === 'list' ? newList(items) : newTuple(items);
  }

  /**
   * Builds a set in the steps CPython's bytecode takes, which decide the order of its elements: the elements before
   * the first starred one are added together, as a folded frozenset merged into the set when they are three or more
   * constants, and each later element is added as it is evaluated. A display of more than 30 elements adds one by
   * one, and so does a display of constants that a `for` clause iterates, where the frozenset itself is iterated.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- Follows the steps in which CPython's compiler builds a set display.
  private setDisplay(elements: Element[], frame: Frame, iterated: boolean): PySet {
    return this.withTemporaries(frame, () => {
      const starIndex = elements.findIndex((element) => element.kind === 'starred');
      const leadingCount = elements.length > MAX_STACKED_ELEMENTS ? 0 : starIndex === -1 ? elements.length : starIndex;
      const leading = elements.slice(0, leadingCount) as Expression[];
      const isFolded = leadingCount >= MIN_FOLDED_ELEMENTS && !(iterated && starIndex === -1);
      const constants = isFolded ? foldConstants(leading) : undefined;
      const set = newSet();
      if (constants) {
        updateTable(
          set.table,
          withoutCharge(() => newSet(constants, true))
        );
      } else {
        const items = this.elements(leading, frame);
        pushAll(frame.temporaries, items);
        for (const item of items) addToTable(set.table, item);
      }
      frame.temporaries.push(set);
      for (const element of elements.slice(leadingCount)) {
        if (element.kind === 'starred') updateTable(set.table, this.evaluate(element.value, frame));
        else addToTable(set.table, this.evaluate(element, frame));
      }
      return set;
    });
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
        ...inlinedNames(frame),
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

  /**
   * Evaluates call arguments, holding each for garbage collection until the call returns. As CPython compiles a call
   * whose only positional argument is starred to CALL_FUNCTION_EX, which converts that iterable after evaluating the
   * keywords and names the callee if it fails, such an argument is read last; any other starred argument is read in
   * order, as a list display reads it.
   */
  protected arguments(argumentList: Argument[], frame: Frame, callee: PyValue): { args: PyValue[]; kwargs: Kwargs } {
    const positionals = argumentList.filter((argument) => argument.kind === 'positional' || argument.kind === 'star');
    const soleStar = positionals.length === 1 && positionals[0].kind === 'star' ? positionals[0] : undefined;
    const args: PyValue[] = [];
    const keywords = new KeywordArguments(callee);
    let deferred: PyValue | undefined;
    for (const argument of argumentList) {
      if (argument === soleStar) {
        deferred = this.evaluate(argument.value, frame);
        frame.temporaries.push(deferred);
        continue;
      }
      const value = this.evaluate(argument.value, frame);
      frame.temporaries.push(value);
      if (argument.kind === 'positional') args.push(value);
      else if (argument.kind === 'star') this.pushAll(frame, args, starredItems(value));
      else if (argument.kind === 'keyword') keywords.add(argument.name, value);
      else keywords.merge(value, frame);
    }
    if (deferred !== undefined) {
      if (!isIterable(deferred)) {
        throw typeError(`${functionStr(callee)} argument after * must be an iterable, not ${typeName(deferred)}`);
      }
      this.pushAll(frame, args, toArray(deferred));
    }
    return { args, kwargs: keywords.finish() };
  }

  private pushAll(frame: Frame, args: PyValue[], items: PyValue[]): void {
    for (const item of items) {
      args.push(item);
      frame.temporaries.push(item);
    }
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
    if (def.returns || def.params.some((param) => param.annotation)) fn.definingFrame = frame;
    fn.module = moduleNameOf(frame);
    this.runtime.allocate(2);
    let result: PyValue = fn;
    for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
    return result;
  }

  /** The annotations of a function, evaluated when the program reads `__annotations__`. */
  annotationsOf(fn: PyFunction): PyDict {
    const dict = newDict();
    const frame = fn.definingFrame ?? this.runtime.frame;
    for (const param of fn.def.params) {
      if (param.annotation) dict.store.set(param.name, this.evaluate(param.annotation, frame));
    }
    if (fn.def.returns) dict.store.set('return', this.evaluate(fn.def.returns, frame));
    return dict;
  }

  // Comprehensions --------------------------------------------------------------------------------------------------

  private comprehension(expression: Extract<Expression, { kind: 'comprehension' }>, frame: Frame): PyValue {
    const { runtime } = this;
    const iterable = this.evaluateIterable(expression.generators[0].iterable, frame);
    const { next, held: first } = iterateHeld(iterable);
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
        () => [iterable, first, ...inner.locals.values(), ...inner.cells.values(), ...inner.temporaries]
      );
    }
    runtime.pushFrame(inner);
    try {
      inner.temporaries.push(iterable, first);
      if (expression.type === 'dict') {
        const dict = newDict();
        inner.temporaries.push(dict);
        const items = this.comprehensionItems(expression, inner, next, (key, value) => dict.store.set(key, value));
        while (!items.next().done);
        return dict;
      }
      const container = expression.type === 'list' ? newList([]) : newSet();
      inner.temporaries.push(container);
      for (const item of this.comprehensionItems(expression, inner, next)) {
        if (container instanceof PyList) container.append(item);
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
    const inner = new Frame(
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
    if (expression.type !== 'generator') inner.inlinedIn = frame;
    return inner;
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
          const iterable = this.evaluateIterable(generators[index + 1].iterable, frame);
          const length = frame.temporaries.length;
          const { next: innerNext, held } = iterateHeld(iterable);
          frame.temporaries.push(iterable, held);
          try {
            yield* level.call(this, index + 1, innerNext);
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

function unboundLocal(name: string): PyError {
  const error = pyError(
    'UnboundLocalError',
    `cannot access local variable '${name}' where it is not associated with a value`
  );
  const state = error.exception.exception;
  if (state) state.name = name;
  return error;
}

function isIterable(value: PyValue): boolean {
  if (typeof value === 'string' || value instanceof PyList || value instanceof PyTuple || value instanceof PyDict)
    return true;
  return lookupSpecial(value, '__iter__') !== undefined || lookupSpecial(value, '__getitem__') !== undefined;
}

/** The items of a starred value that is read as a list display reads it. */
function starredItems(value: PyValue): PyValue[] {
  if (!isIterable(value)) throw typeError(`Value after * must be an iterable, not ${typeName(value)}`);
  return toArray(value);
}

/** The names of the frames an inlined comprehension runs within, which CPython's frame for it holds as its own. */
function inlinedNames(frame: Frame): string[] {
  const names: string[] = [];
  for (let outer = frame.inlinedIn; outer; outer = outer.inlinedIn) names.unshift(...outer.locals.keys());
  return names;
}

/**
 * The items a target list unpacks a value into, raising the errors CPython raises for a count mismatch: it reports how
 * many values there were only for an exact list, tuple, or dict, and asks no other iterable for its length.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows CPython's unpacking, whose errors differ for exact lists, tuples, and dicts.
export function unpack(value: PyValue, count: number): PyValue[] {
  if ((value instanceof PyList && value.cls === listClass) || (value instanceof PyTuple && value.cls === tupleClass)) {
    const { items } = value;
    if (items.length > count) throw tooManyValues(count, items.length);
    if (items.length < count) throw notEnoughValues(count, items.length);
    return [...items];
  }
  if (!isIterable(value)) throw typeError(`cannot unpack non-iterable ${typeName(value)} object`);
  const next = iterate(value);
  const items: PyValue[] = [];
  for (let index = 0; index < count; index++) {
    const item = next();
    if (item === DONE) throw notEnoughValues(count, items.length);
    items.push(item);
  }
  if (next() !== DONE) {
    throw tooManyValues(count, value instanceof PyDict && value.cls === dictClass ? lengthOf(value) : undefined);
  }
  return items;
}

function tooManyValues(expected: number, actual: number | undefined): PyError {
  return pyError(
    'ValueError',
    `too many values to unpack (expected ${expected}${actual === undefined ? '' : `, got ${actual}`})`
  );
}

function notEnoughValues(expected: number, actual: number): PyError {
  return pyError('ValueError', `not enough values to unpack (expected ${expected}, got ${actual})`);
}

export { PyError };
