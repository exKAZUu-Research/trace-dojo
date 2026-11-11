// code-gauge-allow-file fileNcss 718 -- The expression evaluator keeps one method per kind of expression together.
import type {
  Argument,
  Comprehension,
  Constant,
  Element,
  Expression,
  FormattedValue,
  FunctionDef,
  NameRef,
  ScopeInfo,
  Target,
} from './ast';
import { newBytes } from './bytesValues';
import { newComplex } from './complexNumbers';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { Frame } from './frame';
import { referencesOf } from './garbageCollection';
import { programAttribute } from './namespaceDifferences';
import { namespaceOf } from './namespaces';
import {
  bindValue,
  callValue,
  deleteAttribute,
  deleteItem,
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
import { markGeneratorExpression } from './reflection';
import type { Runtime } from './runtime';
import { templateLiteral } from './templateStrings';
import { noteUnwinding, setFrameGenerator } from './tracebacks';
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
  PyBoundMethod,
  PyBuiltinFunction,
  PyCell,
  PyClass,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyList,
  PyModule,
  PyObject,
  PySlice,
  PyTuple,
  type PyValue,
} from './values';

/** Evaluates expressions in a frame, synchronously: only statements may suspend a generator. */
export class ExpressionEvaluator {
  constructor(protected readonly runtime: Runtime) {}

  /** Evaluates an expression whose value the caller hands on, which is then no longer local to the frames. */
  evaluate(expression: Expression, frame: Frame): PyValue {
    const value = this.evaluateValue(expression, frame);
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.escape(value);
    return value;
  }

  /**
   * Evaluates an expression whose value the caller keeps in the frame, or reads without keeping, such as an operand,
   * so that a local object stays local.
   */
  // code-gauge-allow functionNcss 49 -- One case per kind of expression.
  evaluateValue(expression: Expression, frame: Frame): PyValue {
    switch (expression.kind) {
      case 'name': {
        return this.loadName(expression, frame);
      }
      case 'constant': {
        return constantValue(expression.value);
      }
      case 'fstring': {
        return expression.template
          ? this.templateString(expression.parts, frame)
          : this.formattedString(expression.parts, frame);
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
        return this.attribute(expression, frame);
      }
      case 'subscript': {
        return this.subscript(expression, frame);
      }
      case 'slice': {
        return this.slice(expression, frame);
      }
      case 'call': {
        return this.call(expression, frame);
      }
      case 'binary': {
        return this.binary(expression, frame);
      }
      case 'unary': {
        return unaryOp(expression.operator, this.evaluateValue(expression.operand, frame));
      }
      case 'not': {
        return !isTruthy(this.evaluateValue(expression.operand, frame));
      }
      case 'boolean': {
        const left = this.evaluateValue(expression.left, frame);
        const truthy = isTruthy(left);
        return (expression.operator === 'and' ? !truthy : truthy) ? left : this.evaluateValue(expression.right, frame);
      }
      case 'compare': {
        return this.compare(expression, frame);
      }
      case 'conditional': {
        return this.evaluateValue(
          isTruthy(this.evaluateValue(expression.test, frame)) ? expression.body : expression.orelse,
          frame
        );
      }
      case 'lambda': {
        return this.createFunction(expression.fn, frame, []);
      }
      case 'namedExpression': {
        const value = this.evaluateValue(expression.value, frame);
        this.storeName(expression.target, value, frame);
        return value;
      }
      case 'comprehension': {
        return this.comprehension(expression, frame);
      }
    }
    throw new Error('Unknown expression');
  }

  private attribute(expression: Extract<Expression, { kind: 'attribute' }>, frame: Frame): PyValue {
    const object = this.evaluateValue(expression.object, frame);
    // An object's `__dict__` holds its attributes outside it.
    const { locals } = this.runtime.finalizer;
    if (locals.marking && expression.name === '__dict__') locals.escape(object);
    return programAttribute(object, expression.name);
  }

  private subscript(expression: Extract<Expression, { kind: 'subscript' }>, frame: Frame): PyValue {
    const object = this.evaluateValue(expression.object, frame);
    const item = this.hold(frame, object, () => getItem(object, this.evaluateValue(expression.index, frame)));
    // A slice copies items into a new container, which is not local.
    const { locals } = this.runtime.finalizer;
    if (locals.marking && expression.index.kind === 'slice') locals.escapeItems(item);
    return item;
  }

  private binary(expression: Extract<Expression, { kind: 'binary' }>, frame: Frame): PyValue {
    const left = this.evaluateValue(expression.left, frame);
    // Garbage collection only looks for objects among the values held.
    if (typeof left !== 'object')
      return binaryOp(expression.operator, left, this.evaluateValue(expression.right, frame));
    const result = this.hold(frame, left, () =>
      binaryOp(expression.operator, left, this.evaluateValue(expression.right, frame))
    );
    // Concatenating or repeating containers copies their items into a new one, which is not local.
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.escapeItems(result);
    return result;
  }

  private display(expression: Extract<Expression, { kind: 'list' | 'tuple' | 'set' }>, frame: Frame): PyValue {
    const build = (): PyValue => {
      const items = this.elements(expression.elements, frame);
      const display = this.newDisplay(expression.kind, items);
      const { locals } = this.runtime.finalizer;
      if (locals.marking) locals.bornContainer(display, items);
      return display;
    };
    return expression.kind === 'set' ? this.withTemporaries(frame, build) : build();
  }

  protected newDisplay(kind: 'list' | 'tuple' | 'set', items: PyValue[]): PyValue {
    this.runtime.allocate(items.length + 1);
    if (kind === 'set') return newSet(items);
    return kind === 'list' ? newList(items) : newTuple(items);
  }

  protected slice(expression: Extract<Expression, { kind: 'slice' }>, frame: Frame): PyValue {
    const lower = expression.lower ? this.evaluate(expression.lower, frame) : None;
    const upper = expression.upper ? this.evaluate(expression.upper, frame) : None;
    const step = expression.step ? this.evaluate(expression.step, frame) : None;
    return new PySlice(sliceClass, lower, upper, step);
  }

  /** Keeps a value reachable for garbage collection while `run` evaluates more of the expression holding it. */
  hold<T>(frame: Frame, value: PyValue, run: () => T): T {
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
        const value = frame.locals.get(name) ?? frame.globals.get(name) ?? this.builtinsOf(frame).get(name);
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
        const value = frame.globals.get(name) ?? this.builtinsOf(frame).get(name) ?? classCellOf(name, frame);
        if (value === undefined) throw this.nameError(`name '${name}' is not defined`, name, frame);
        return value;
      }
    }
  }

  /** The builtins a frame's names fall back to: those its globals' `__builtins__` holds, as in CPython. */
  private builtinsOf(frame: Frame): Map<string, PyValue> {
    const builtins = frame.globals.get('__builtins__');
    if (builtins instanceof PyModule) return builtins.dict;
    if (builtins instanceof PyDict) return namespaceOf(builtins);
    return this.runtime.builtins;
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
    const { finalizer } = this.runtime;
    const { locals } = finalizer;
    if (locals.marking && !locals.bindsLocally(frame, ref.access)) locals.escape(value);
    if (finalizer.pending.size === 0) {
      bindName(ref, value, frame);
      return;
    }
    const replaced = this.boundValue(ref, frame);
    bindName(ref, value, frame);
    finalizer.release([replaced]);
  }

  deleteName(ref: NameRef, frame: Frame): void {
    const { finalizer } = this.runtime;
    const deleted = finalizer.pending.size > 0 ? this.boundValue(ref, frame) : undefined;
    this.unbindName(ref, frame);
    finalizer.release([deleted]);
  }

  /** The value a name is bound to, without the errors of reading an unbound one. */
  private boundValue(ref: NameRef, frame: Frame): PyValue | undefined {
    switch (ref.access) {
      case 'local':
      case 'name': {
        return frame.locals.get(ref.name);
      }
      case 'cell':
      case 'classCell': {
        return frame.cells.get(ref.name)?.value;
      }
      default: {
        return frame.globals.get(ref.name);
      }
    }
  }

  private unbindName(ref: NameRef, frame: Frame): void {
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
        this.hold(frame, value, () => {
          const object = this.evaluateValue(target.object, frame);
          if (this.runtime.finalizer.pending.size === 0) setAttribute(object, target.name, value);
          else this.replacing(object, target.name, true, () => setAttribute(object, target.name, value));
          this.stored(object, target.name, value, true);
        });
        return;
      }
      case 'subscript': {
        this.hold(frame, value, () => {
          const object = this.evaluateValue(target.object, frame);
          this.hold(frame, object, () => {
            const index = this.evaluateValue(target.index, frame);
            if (this.runtime.finalizer.pending.size === 0) setItem(object, index, value);
            else this.replacing(object, index, false, () => setItem(object, index, value));
            this.stored(object, index, value, false);
          });
        });
        return;
      }
      case 'unpack': {
        const items = this.unpackTarget(target, value);
        this.hold(frame, value, () => {
          for (const [index, element] of target.elements.entries()) this.assign(element, items[index], frame);
        });
      }
    }
  }

  /**
   * Records that `object` now holds `value` under `key`: a local instance's attribute or a local container's item
   * stays local in it, and anything else keeps the value, and the key, outside the frames.
   */
  protected stored(object: PyValue, key: PyValue, value: PyValue, isAttribute: boolean): void {
    const { locals } = this.runtime.finalizer;
    if (!locals.marking) return;
    if (isAttribute) {
      const kept = object instanceof PyInstance && locals.isLocal(object) && object.dict.get(key as string) === value;
      if (kept) locals.own(value, object);
      else locals.escape(value);
      return;
    }
    if ((object instanceof PyList || object instanceof PyDict) && object.cls.isBuiltin && locals.isLocal(object)) {
      locals.own(value, object);
      locals.own(key, object);
    } else {
      locals.escape(value);
      locals.escape(key);
    }
  }

  /** The items a target list unpacks a value into. */
  protected unpackTarget(target: Extract<Target, { kind: 'unpack' }>, value: PyValue): PyValue[] {
    const { starIndex } = target;
    if (starIndex === undefined) return unpack(value, target.elements.length);
    const items = this.unpackStarred(value, starIndex, target.elements.length - starIndex - 1);
    // A starred target gets a new list of the items it collects.
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.escapeItems(items[starIndex] as PyValue);
    return items;
  }

  /** The items a target list with a starred element unpacks a value into, the starred one taking a list of the rest. */
  private unpackStarred(value: PyValue, before: number, after: number): PyValue[] {
    const minimum = before + after;
    const notEnough = (got: number): PyError =>
      pyError('ValueError', `not enough values to unpack (expected at least ${minimum}, got ${got})`);
    if (!isIterable(value)) throw typeError(`cannot unpack non-iterable ${typeName(value)} object`);
    const next = iterate(value);
    const items: PyValue[] = [];
    for (let index = 0; index < before; index++) {
      const item = next();
      if (item === DONE) throw notEnough(index);
      items.push(item);
    }
    const rest: PyValue[] = [];
    for (let item = next(); item !== DONE; item = next()) {
      this.runtime.allocate(1);
      rest.push(item);
    }
    if (rest.length < after) throw notEnough(before + rest.length);
    this.runtime.allocate(1);
    return [...items, newList(rest.slice(0, rest.length - after)), ...rest.slice(rest.length - after)];
  }

  deleteTarget(target: Target, frame: Frame): void {
    switch (target.kind) {
      case 'name': {
        this.deleteName(target, frame);
        return;
      }
      case 'attribute': {
        const object = this.evaluateValue(target.object, frame);
        this.replacing(object, target.name, true, () => deleteAttribute(object, target.name));
        return;
      }
      case 'subscript': {
        const object = this.evaluateValue(target.object, frame);
        const index = this.evaluate(target.index, frame);
        this.replacing(object, index, false, () => deleteItem(object, index));
        return;
      }
      case 'unpack': {
        for (const element of target.elements) this.deleteTarget(element, frame);
      }
    }
  }

  /** Stores over or deletes an attribute or an item, closing a generator that only the value it held reached. */
  private replacing(object: PyValue, key: PyValue, isAttribute: boolean, store: () => void): void {
    // A slice may remove several items of a container, which its change frees.
    if (!isAttribute && key instanceof PyObject) {
      this.runtime.finalizer.mutating(object, store);
      return;
    }
    const replaced = this.heldValue(object, key, isAttribute);
    store();
    this.release(replaced);
  }

  /**
   * The value an attribute or an item of a builtin container holds, read without running the program's code, while a
   * suspended generator waits to be closed: storing over it or deleting it may leave the generator unreachable.
   */
  private heldValue(object: PyValue, key: PyValue, isAttribute: boolean): PyValue | undefined {
    if (this.runtime.finalizer.pending.size === 0) return undefined;
    if (isAttribute) {
      return object instanceof PyInstance || object instanceof PyClass ? object.dict.get(key as string) : undefined;
    }
    if (object instanceof PyList && typeof key === 'bigint') {
      const { items } = object;
      return items[Number(key < 0n ? key + BigInt(items.length) : key)];
    }
    if (object instanceof PyDict && typeof key !== 'object') return object.store.get(key);
    return undefined;
  }

  /** Closes the generators that dropping a reference to `value` left unreachable, as reference counting does. */
  protected release(value: PyValue | undefined): void {
    const { finalizer } = this.runtime;
    if (finalizer.pending.size > 0) finalizer.release([value]);
  }

  // Displays --------------------------------------------------------------------------------------------------------

  private elements(elements: Element[], frame: Frame): PyValue[] {
    const items: PyValue[] = [];
    const { temporaries } = frame;
    const length = temporaries.length;
    try {
      for (const element of elements) {
        // The display keeps its elements, which stay local in it; a starred one is a container it copies.
        const value =
          element.kind === 'starred' ? this.evaluate(element.value, frame) : this.evaluateValue(element, frame);
        addElement(items, frame, element.kind === 'starred', value);
      }
    } finally {
      temporaries.length = length;
    }
    return items;
  }

  // code-gauge-allow duplicateLines 15 -- The suspending evaluator mirrors this step by step, sharing how it combines the values.
  private dictDisplay(expression: Extract<Expression, { kind: 'dict' }>, frame: Frame): PyValue {
    return this.withTemporaries(frame, () => {
      const dict = newDict();
      frame.temporaries.push(dict);
      for (const item of expression.items) {
        if (item.kind === 'doubleStar') {
          mergeMapping(dict, this.evaluate(item.value, frame));
          continue;
        }
        const key = this.evaluateValue(item.key, frame);
        frame.temporaries.push(key);
        const value = this.evaluateValue(item.value, frame);
        dict.store.set(key, value);
      }
      this.runtime.allocate(dict.store.size + 1);
      const { locals } = this.runtime.finalizer;
      if (locals.marking) locals.bornContainer(dict, referencesOf(dict) as PyValue[]);
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
      const value = this.evaluate(part.expression, frame);
      result += formatPart(part, value, part.spec ? (this.evaluate(part.spec, frame) as string) : '');
      this.runtime.buildString(result.length);
    }
    return result;
  }

  /** A t-string, whose replacement fields evaluate to the values of its Interpolations, unformatted. */
  private templateString(parts: (string | FormattedValue)[], frame: Frame): PyValue {
    const fields: [PyValue, string][] = [];
    for (const part of parts) {
      if (typeof part === 'string') continue;
      const value = this.evaluate(part.expression, frame);
      fields.push([value, part.spec ? (this.evaluate(part.spec, frame) as string) : '']);
    }
    return templateLiteral(parts, fields);
  }

  // Calls -----------------------------------------------------------------------------------------------------------

  /** Evaluates a call, whose callee the caller may have evaluated already. */
  protected call(
    expression: Extract<Expression, { kind: 'call' }>,
    frame: Frame,
    callee = this.evaluateValue(expression.callee, frame)
  ): PyValue {
    const { temporaries } = frame;
    const length = temporaries.length;
    temporaries.push(callee);
    let args: PyValue[];
    let kwargs: Kwargs;
    let result: PyValue;
    try {
      const collected = this.arguments(expression.args, frame, callee);
      args = collected.args;
      kwargs = collected.kwargs;
      const { finalizer } = this.runtime;
      if (finalizer.locals.marking) finalizer.locals.beforeCall(callee);
      const owner = finalizer.pending.size > 0 ? builtinMethodOwner(callee) : undefined;
      if (owner !== undefined) {
        // A method of a list, dict, set, or deque frees the items it removes, such as `clear` does.
        const method = { name: callee instanceof PyBuiltinFunction ? callee.name : '', key: args[0] };
        result = finalizer.mutating(
          owner,
          () => this.invoke(callee, args, collected.kwargs, expression.row),
          args,
          method
        );
      } else {
        // CPython's caller hands its references to the arguments to a Python function's frame.
        if (finalizer.pending.size > 0 && passesArguments(callee)) temporaries.length = length + 1;
        result = this.invoke(callee, args, collected.kwargs, expression.row);
      }
    } finally {
      temporaries.length = length;
    }
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.afterCall(callee, args, kwargs, result);
    this.afterCall(args, result);
    return result;
  }

  /** Closes a generator that only the arguments of a returned call held, as freeing them does in CPython. */
  protected afterCall(args: PyValue[], result: PyValue): void {
    const { finalizer } = this.runtime;
    if (finalizer.pending.size > 0) finalizer.release(args, [result]);
  }

  /** Calls a value from the call expression at `row`, which the call's frame and tracebacks report. */
  protected invoke(callee: PyValue, args: PyValue[], kwargs: Kwargs, row: number): PyValue {
    const { runtime } = this;
    const outerRow = runtime.currentRow;
    runtime.currentRow = row;
    const { locals } = runtime.finalizer;
    if (locals.marking) locals.noteCall(callee);
    try {
      return callValue(callee, args, kwargs);
    } finally {
      runtime.currentRow = outerRow;
    }
  }

  /**
   * Evaluates call arguments, holding each for garbage collection until the call returns. `leading` counts the
   * positional arguments the call passes before these, as a class statement passes its body and name.
   */
  arguments(argumentList: Argument[], frame: Frame, callee: PyValue, leading = 0): CallArguments {
    const collected: CallArguments = { args: [], kwargs: undefined };
    const { locals } = this.runtime.finalizer;
    // Arguments that only a Python function's frame or a local container keeps stay local; spread ones are copied.
    const keeps = locals.marking && locals.keepsArgumentsLocal(callee);
    for (const argument of argumentList) {
      const local = keeps && (argument.kind === 'positional' || argument.kind === 'keyword');
      const value = local ? this.evaluateValue(argument.value, frame) : this.evaluate(argument.value, frame);
      if (argument.kind === 'positional') {
        collected.args.push(value);
        frame.temporaries.push(value);
      } else {
        addArgument(collected, argument, value, { callee, argumentList, leading }, frame);
      }
    }
    return collected;
  }

  private compare(expression: Extract<Expression, { kind: 'compare' }>, frame: Frame): PyValue {
    let left = this.evaluateValue(expression.operands[0], frame);
    let result: PyValue = true;
    for (const [index, operator] of expression.operators.entries()) {
      const right = this.hold(frame, left, () => this.evaluateValue(expression.operands[index + 1], frame));
      result = this.hold(frame, right, () => compareOp(operator, left, right));
      if (index < expression.operators.length - 1 && !isTruthy(result)) return result;
      left = right;
    }
    return result;
  }

  // Functions -------------------------------------------------------------------------------------------------------

  /**
   * Creates a function object, evaluating its defaults in the defining frame unless `defaultValues` gives the values of
   * the parameters' defaults in order.
   */
  // code-gauge-allow functionCognitiveComplexity 16 -- Sets each attribute a new function object carries.
  createFunction(
    def: FunctionDef,
    frame: Frame,
    decorators: PyValue[],
    defaultValues: PyValue[] = def.params.flatMap((param) =>
      param.default ? [this.evaluate(param.default, frame)] : []
    ),
    typeParams?: PyValue[]
  ): PyValue {
    const defaults: PyValue[] = [];
    const keywordDefaults = new Map<string, PyValue>();
    let index = 0;
    for (const param of def.params) {
      if (!param.default) continue;
      const value = defaultValues[index++];
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
    fn.module = frame.globals.get('__name__') ?? None;
    if (typeParams) fn.typeParams = typeParams;
    if (def.returns || def.params.some((param) => param.annotation)) fn.annotationFrame = frame;
    this.runtime.allocate(2);
    let result: PyValue = fn;
    for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
    return result;
  }

  // Comprehensions --------------------------------------------------------------------------------------------------

  /** Runs a comprehension, whose first iterable `first` the enclosing frame evaluated. */
  // code-gauge-allow functionNcss 45 -- Follows how CPython runs each kind of comprehension in its own scope.
  // code-gauge-allow functionCognitiveComplexity 24 -- Follows how CPython runs each kind of comprehension in its own scope.
  protected comprehension(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    // A generator expression keeps its first iterable; the other comprehensions only read it.
    first = expression.type === 'generator'
      ? this.evaluate(expression.generators[0].iterable, frame)
      : this.evaluateValue(expression.generators[0].iterable, frame)
  ): PyValue {
    const { runtime } = this;
    const inner = this.comprehensionFrame(expression, frame);
    if (expression.type === 'generator') {
      markGeneratorExpression(inner, first);
      const body = this.generatorItems(expression, inner, first);
      const generator = new PyGenerator(
        generatorClass,
        '<genexpr>',
        '<genexpr>',
        (input) => {
          runtime.pushFrame(inner);
          try {
            return input.error ? body.throw(input.error) : body.next();
          } catch (error) {
            noteUnwinding(error);
            throw error;
          } finally {
            runtime.popFrame();
            // The generator keeps its frame off the stack.
            if (runtime.finalizer.locals.marking) runtime.finalizer.locals.escapeFrame(inner);
          }
        },
        () => [first, ...inner.locals.values(), ...inner.temporaries]
      );
      generator.frame = inner;
      setFrameGenerator(inner, generator);
      return generator;
    }
    const next = iterate(first);
    runtime.pushFrame(inner);
    try {
      inner.temporaries.push(first);
      const { locals } = runtime.finalizer;
      if (expression.type === 'dict') {
        const dict = newDict();
        inner.temporaries.push(dict);
        const items = this.comprehensionItems(expression, inner, next, (key, value) => dict.store.set(key, value));
        while (!items.next().done);
        if (locals.marking) locals.bornContainer(dict, referencesOf(dict) as PyValue[]);
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
      if (locals.marking)
        locals.bornContainer(container, items.length > 0 ? items : (referencesOf(container) as PyValue[]));
      return container;
    } finally {
      runtime.popFrame();
    }
  }

  /** The body of a generator expression's generator, which runs its clauses and yields its elements. */
  protected generatorItems(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    inner: Frame,
    first: PyValue
  ): Generator<PyValue, PyValue> {
    return this.comprehensionItems(expression, inner, iterate(first));
  }

  protected comprehensionFrame(expression: Extract<Expression, { kind: 'comprehension' }>, frame: Frame): Frame {
    return this.nestedFrame('comprehension', expression.scope, frame);
  }

  /** The frame of a scope nested in `frame`'s, which captures the variables of `frame` it reads. */
  protected nestedFrame(kind: 'comprehension' | 'function', scope: ScopeInfo, frame: Frame): Frame {
    const cells = new Map<string, PyCell>();
    for (const name of scope.frees) {
      let cell = frame.cells.get(name);
      if (!cell) {
        cell = new PyCell();
        frame.cells.set(name, cell);
      }
      cells.set(name, cell);
    }
    for (const name of scope.cells) cells.set(name, new PyCell());
    const callRow = kind === 'function' ? frame.callRow : undefined;
    return new Frame(kind, new Map(), cells, frame.globals, callRow, false, scope, frame.fn, frame.classCell);
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
        // A list, set, or dict comprehension keeps its elements in the container it builds, where they stay local.
        if (store) {
          const key = this.evaluateValue(expression.element, frame);
          store(
            key,
            this.hold(frame, key, () => this.evaluateValue(expression.value as Expression, frame))
          );
          continue;
        }
        yield expression.type === 'generator'
          ? this.evaluate(expression.element, frame)
          : this.evaluateValue(expression.element, frame);
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
    case 'bytes': {
      return newBytes(constant.value);
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

function bindName(ref: NameRef, value: PyValue, frame: Frame): void {
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

/** The positional and keyword arguments of a call, collected in order. */
export interface CallArguments {
  args: PyValue[];
  kwargs: Map<string, PyValue> | undefined;
}

/**
 * The call whose arguments are being collected: the callee, all its argument expressions, and how many positional
 * arguments it passes before them, which CPython's errors for unpacking depend on.
 */
export interface CallSite {
  callee: PyValue;
  argumentList: Argument[];
  leading: number;
}

/** Adds an argument's value to a call's arguments, raising CPython's errors for unpacking it. */
// code-gauge-allow functionNcss 32 -- Adds each kind of argument, raising CPython's errors for unpacking.
// code-gauge-allow functionCognitiveComplexity 22 -- Adds each kind of argument, raising CPython's errors for unpacking.
export function addArgument(
  collected: CallArguments,
  argument: Argument,
  value: PyValue,
  call: CallSite,
  frame: Frame
): void {
  const { callee } = call;
  switch (argument.kind) {
    case 'positional': {
      collected.args.push(value);
      frame.temporaries.push(value);
      return;
    }
    case 'star': {
      if (!isIterable(value)) throw notIterableError(call.argumentList, callee, call.leading, value);
      for (const item of toArray(value)) {
        collected.args.push(item);
        frame.temporaries.push(item);
      }
      return;
    }
    case 'keyword': {
      const kwargs = (collected.kwargs ??= new Map());
      if (kwargs.has(argument.name)) {
        throw typeError(`${calleeName(callee)} got multiple values for keyword argument '${argument.name}'`);
      }
      kwargs.set(argument.name, value);
      frame.temporaries.push(value);
      return;
    }
    case 'doubleStar': {
      if (lookupSpecial(value, 'keys') === undefined) {
        throw typeError(`${calleeName(callee)} argument after ** must be a mapping, not ${typeName(value)}`);
      }
      const kwargs = (collected.kwargs ??= new Map());
      for (const [key, item] of mappingEntries(value)) {
        if (typeof key !== 'string') throw typeError('keywords must be strings');
        if (kwargs.has(key)) throw typeError(`${calleeName(callee)} got multiple values for keyword argument '${key}'`);
        kwargs.set(key, item);
        frame.temporaries.push(item);
      }
    }
  }
}

/** Adds an element's value to the items of a display, spreading it when the element is starred. */
export function addElement(items: PyValue[], frame: Frame, isStarred: boolean, value: PyValue): void {
  if (!isStarred) {
    items.push(value);
    frame.temporaries.push(value);
    return;
  }
  for (const item of starredItems(value)) {
    items.push(item);
    frame.temporaries.push(item);
  }
}

/** Adds the items of a mapping that a dict display spreads with `**`. */
export function mergeMapping(dict: PyDict, mapping: PyValue): void {
  for (const [key, value] of mappingEntries(mapping)) dict.store.set(key, value);
}

/** The text of an f-string's replacement field, given its value and the text of its format spec. */
export function formatPart(part: FormattedValue, value: PyValue, spec: string): string {
  let converted = value;
  if (part.conversion === 'r') converted = pyRepr(value);
  else if (part.conversion === 's') converted = pyStr(value);
  else if (part.conversion === 'a') converted = pyAscii(value);
  return (part.debugText ?? '') + pyFormat(converted, spec);
}

/** The class a method that names `__class__` is defined in, which it reads as `super()` does. */
function classCellOf(name: string, frame: Frame): PyValue | undefined {
  return name === '__class__' && frame.kind === 'function' ? frame.classCell?.value : undefined;
}

/**
 * The error for `*` before a value that is not iterable, which names the callee only when the value is all the
 * positional arguments, as CPython then passes it to the call without building a tuple first.
 */
function notIterableError(argumentList: Argument[], callee: PyValue, leading: number, iterable: PyValue): Error {
  const positional = argumentList.filter((each) => each.kind === 'positional' || each.kind === 'star').length;
  const subject = leading + positional === 1 ? `${calleeName(callee)} argument` : 'Value';
  return typeError(`${subject} after * must be an iterable, not ${typeName(iterable)}`);
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

/** Whether calling a value runs a Python function, whose frame takes over the references to the arguments. */
function passesArguments(callee: PyValue): boolean {
  return callee instanceof PyFunction || (callee instanceof PyBoundMethod && callee.fn instanceof PyFunction);
}

/** The object a builtin method is bound to, whose items calling it may remove. */
function builtinMethodOwner(callee: PyValue): PyValue | undefined {
  if (callee instanceof PyBuiltinFunction) return callee.self;
  if (callee instanceof PyBoundMethod && !(callee.fn instanceof PyFunction)) return callee.self;
  return undefined;
}
