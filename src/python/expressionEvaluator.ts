import { functionAnnotationReferences } from './annotations';
// code-gauge-allow-file fileNcss 794 -- The expression evaluator keeps one method per kind of expression together.
import { pushAll } from './arrays';
import type {
  Argument,
  Comprehension,
  Element,
  Expression,
  FormattedValue,
  FunctionDef,
  NameRef,
  ScopeInfo,
  Target,
} from './ast';
import { functionStr, KeywordArguments, mappingEntries } from './callArguments';
import { constantValue, foldConstants } from './constantFolding';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { Frame } from './frame';
import { referencesOf } from './garbageCollection';
import { programAttribute } from './namespaceDifferences';
import {
  callValue,
  deleteAttribute,
  deleteItem,
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
import { markGeneratorExpression } from './reflection';
import type { Runtime } from './runtime';
import { currentRuntime, withoutCharge } from './runtimeContext';
import { addToTable, updateTable } from './setOperations';
import { templateLiteral } from './templateStrings';
import { noteUnwinding, setFrameGenerator } from './tracebacks';
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
  PyBoundMethod,
  PyBuiltinFunction,
  PyCell,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyList,
  PyModule,
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
        return this.createFunction(expression.fn, frame);
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
    return this.readAttribute(this.evaluateValue(expression.object, frame), expression.name);
  }

  /** `object.name` in a program's code. */
  protected readAttribute(object: PyValue, name: string): PyValue {
    // An object's `__dict__` holds its attributes outside it.
    const { locals } = this.runtime.finalizer;
    if (locals.marking && name === '__dict__') locals.escape(object);
    return programAttribute(object, name);
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

  /** Evaluates the iterable of a `for` clause, which CPython compiles differently when it is a set display. */
  protected evaluateIterable(expression: Expression, frame: Frame): PyValue {
    return expression.kind === 'set'
      ? this.setDisplay(expression.elements, frame, true)
      : this.evaluate(expression, frame);
  }

  private display(expression: Extract<Expression, { kind: 'list' | 'tuple' | 'set' }>, frame: Frame): PyValue {
    if (expression.kind === 'set') return this.setDisplay(expression.elements, frame, false);
    const items = this.elements(expression.elements, frame);
    const display = this.newDisplay(expression.kind, items);
    const { locals } = this.runtime.finalizer;
    if (locals.marking) locals.bornContainer(display, items);
    return display;
  }

  protected newDisplay(kind: 'list' | 'tuple' | 'set', items: PyValue[]): PyValue {
    if (kind === 'set') return newSet(items);
    return kind === 'list' ? newList(items) : newTuple(items);
  }

  /**
   * Builds a set in the steps CPython's bytecode takes, which decide the order of its elements: the elements before
   * the first starred one are added together, as a folded frozenset merged into the set when they are three or more
   * constants, and each later element is added as it is evaluated. A display of more than 30 elements adds one by
   * one, and so does a display of constants that a `for` clause iterates, where the frozenset itself is iterated.
   */
  // code-gauge-allow functionCognitiveComplexity 24 -- Follows the steps in which CPython's compiler builds a set display.
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
      const { locals } = this.runtime.finalizer;
      if (locals.marking) locals.bornContainer(set, referencesOf(set) as PyValue[]);
      return set;
    });
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
        const value = frame.locals.get(name) ?? frame.globals.get(name) ?? this.lookupBuiltin(name, frame);
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
        const value = frame.globals.get(name) ?? this.lookupBuiltin(name, frame) ?? classCellOf(name, frame);
        if (value === undefined) throw this.nameError(`name '${name}' is not defined`, name, frame);
        return value;
      }
    }
  }

  /** Looks up `name` in the `__builtins__` object captured by `frame`, subscripting non-dict values as CPython does. */
  private lookupBuiltin(name: string, frame: Frame): PyValue | undefined {
    const { builtins } = frame;
    if (builtins === undefined) return this.runtime.builtins.get(name);
    if (builtins instanceof PyModule) return builtins.dict.get(name);
    if (builtins instanceof PyDict && builtins.cls === dictClass) return builtins.store.get(name);
    try {
      return getItem(builtins, name);
    } catch (error) {
      if (this.runtime.isLookupError(error)) return undefined;
      throw error;
    }
  }

  private builtinNames(frame: Frame): Iterable<string> {
    const { builtins } = frame;
    if (builtins === undefined) return this.runtime.builtins.keys();
    if (builtins instanceof PyModule) return builtins.dict.keys();
    if (builtins instanceof PyDict && builtins.cls === dictClass) {
      return builtins.store
        .ordered()
        .map((entry) => entry.key)
        .filter((key): key is string => typeof key === 'string');
    }
    return [];
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
        ...this.builtinNames(frame),
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
          this.storeInto(this.evaluateValue(target.object, frame), target.name, true, value);
        });
        return;
      }
      case 'subscript': {
        this.hold(frame, value, () => {
          const object = this.evaluateValue(target.object, frame);
          this.hold(frame, object, () => this.storeInto(object, this.evaluateValue(target.index, frame), false, value));
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

  /** Stores `value` as an attribute or an item of `object`, freeing what only the value it replaced kept. */
  protected storeInto(object: PyValue, key: PyValue, isAttribute: boolean, value: PyValue): void {
    this.runtime.finalizer.replacing(object, key, isAttribute, () => {
      if (isAttribute) setAttribute(object, key as string, value);
      else setItem(object, key, value);
    });
    this.stored(object, key, value, isAttribute);
  }

  /**
   * Records that `object` now holds `value` under `key`: a local instance's attribute or a local container's item
   * stays local in it, and anything else keeps the value, and the key, outside the frames.
   */
  private stored(object: PyValue, key: PyValue, value: PyValue, isAttribute: boolean): void {
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
    const starred = newList([]);
    for (let item = next(); item !== DONE; item = next()) {
      starred.append(item);
    }
    if (starred.items.length < after) throw notEnough(before + starred.items.length);
    const tail: PyValue[] = [];
    for (let index = 0; index < after; index++) tail.unshift(starred.editableItems.pop() as PyValue);
    return [...items, starred, ...tail];
  }

  deleteTarget(target: Target, frame: Frame): void {
    switch (target.kind) {
      case 'name': {
        this.deleteName(target, frame);
        return;
      }
      case 'attribute': {
        const object = this.evaluateValue(target.object, frame);
        this.runtime.finalizer.replacing(object, target.name, true, () => deleteAttribute(object, target.name));
        return;
      }
      case 'subscript': {
        const object = this.evaluateValue(target.object, frame);
        const index = this.evaluate(target.index, frame);
        this.runtime.finalizer.replacing(object, index, false, () => deleteItem(object, index));
        return;
      }
      case 'unpack': {
        for (const element of target.elements) this.deleteTarget(element, frame);
      }
    }
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
      result = this.invokeFrom(this.beforeCall(callee, frame, length), callee, args, kwargs, expression.row);
    } finally {
      temporaries.length = length;
    }
    this.afterCall(callee, args, kwargs, result);
    return result;
  }

  /**
   * Prepares the call of `callee` with its arguments evaluated, which `frame.temporaries` hold after the callee from
   * `length` on, returning the list, dict, set, or deque whose method `callee` is when its removals need freeing.
   */
  protected beforeCall(callee: PyValue, frame: Frame, length: number): PyValue | undefined {
    const { finalizer } = this.runtime;
    if (finalizer.locals.marking) finalizer.locals.beforeCall(callee);
    if (finalizer.pending.size === 0) return undefined;
    const owner = builtinMethodOwner(callee);
    // CPython's caller hands its references to the arguments to a Python function's frame.
    if (owner === undefined && passesArguments(callee)) frame.temporaries.length = length + 1;
    return owner;
  }

  /** Calls `callee`, freeing what it removes from `owner`, the list, dict, set, or deque whose method it is, if any. */
  protected invokeFrom(
    owner: PyValue | undefined,
    callee: PyValue,
    args: PyValue[],
    kwargs: Kwargs,
    row: number
  ): PyValue {
    if (owner === undefined) return this.invoke(callee, args, kwargs, row);
    const method = { name: callee instanceof PyBuiltinFunction ? callee.name : '', key: args[0] };
    return this.runtime.finalizer.mutating(owner, () => this.invoke(callee, args, kwargs, row), args, method);
  }

  /** Records what a returned call stored, and frees what only its arguments held, as CPython's caller does. */
  protected afterCall(callee: PyValue, args: PyValue[], kwargs: Kwargs, result: PyValue): void {
    const { finalizer } = this.runtime;
    if (finalizer.locals.marking) finalizer.locals.afterCall(callee, args, kwargs, result);
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
   * positional arguments the call passes before these, as a class statement passes its body and name. As CPython
   * compiles a call whose only positional argument is starred to CALL_FUNCTION_EX, which converts that iterable after
   * evaluating the keywords and names the callee if it fails, such an argument is read last; any other starred
   * argument is read in order, as a list display reads it.
   */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows CPython's argument evaluation and CALL_FUNCTION_EX unpacking order.
  // code-gauge-allow functionNcss 31 -- Follows CPython's argument evaluation and CALL_FUNCTION_EX unpacking order.
  arguments(argumentList: Argument[], frame: Frame, callee: PyValue, leading = 0): CallArguments {
    const positionals = argumentList.filter((argument) => argument.kind === 'positional' || argument.kind === 'star');
    const soleStar = leading + positionals.length === 1 && positionals[0].kind === 'star' ? positionals[0] : undefined;
    const args: PyValue[] = [];
    const keywords = new KeywordArguments(callee);
    const { locals } = this.runtime.finalizer;
    // Arguments that only a Python function's frame or a local container keeps stay local; spread ones are copied.
    const keeps = locals.marking && locals.keepsArgumentsLocal(callee);
    let deferred: PyValue | undefined;
    for (const argument of argumentList) {
      if (argument === soleStar) {
        deferred = this.evaluate(argument.value, frame);
        frame.temporaries.push(deferred);
        continue;
      }
      const local = keeps && (argument.kind === 'positional' || argument.kind === 'keyword');
      const value = local ? this.evaluateValue(argument.value, frame) : this.evaluate(argument.value, frame);
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
   * the parameters' defaults in order, and holding evaluated defaults as temporaries until the function exists.
   */
  createFunction(
    def: FunctionDef,
    frame: Frame,
    decorators: PyValue[] = [],
    defaultValues?: PyValue[],
    typeParams?: PyValue[]
  ): PyValue {
    return this.withTemporaries(frame, () => {
      const resolvedDefaults =
        defaultValues ??
        def.params.flatMap((param) => {
          if (!param.default) return [];
          const value = this.evaluate(param.default, frame);
          frame.temporaries.push(value);
          return [value];
        });
      const [defaults, keywordDefaults] = splitDefaults(def, resolvedDefaults);
      const fn = new PyFunction(
        functionClass,
        def,
        frame.globals,
        closureOf(def, frame),
        defaults,
        keywordDefaults,
        def.usesClassCell ? frame.classCell : undefined
      );
      fn.module = frame.globals.get('__name__') ?? None;
      if (typeParams) fn.typeParams = typeParams;
      if (def.returns || def.params.some((param) => param.annotation)) this.keepAnnotationFrame(fn, frame);
      return this.decorate(fn, decorators);
    });
  }

  /** Makes a function's annotations evaluate in its defining frame, whose values they refer to then escape. */
  private keepAnnotationFrame(fn: PyFunction, frame: Frame): void {
    fn.annotationFrame = frame;
    const { locals } = this.runtime.finalizer;
    if (!locals.marking) return;
    for (const ref of functionAnnotationReferences(fn)) locals.escape(ref instanceof PyCell ? ref.value : ref);
  }

  private decorate(fn: PyFunction, decorators: PyValue[]): PyValue {
    let result: PyValue = fn;
    for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
    return result;
  }

  // Comprehensions --------------------------------------------------------------------------------------------------

  /** Runs a comprehension, whose first iterable `firstIterable` the enclosing frame evaluated when passed. */
  // code-gauge-allow functionNcss 48 -- Follows how CPython runs each kind of comprehension in its own scope.
  // code-gauge-allow functionCognitiveComplexity 26 -- Follows how CPython runs each kind of comprehension in its own scope.
  protected comprehension(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    firstIterable?: PyValue
  ): PyValue {
    const { runtime } = this;
    const iterable = firstIterable ?? this.evaluateIterable(expression.generators[0].iterable, frame);
    const { next, held: first } = iterateHeld(iterable);
    const inner = this.comprehensionFrame(expression, frame, first);
    if (expression.type === 'generator') {
      markGeneratorExpression(inner, first, first !== iterable ? first : undefined);
      const body = this.generatorItems(expression, inner, first, next);
      const generator = new PyGenerator(
        generatorClass,
        '<genexpr>',
        expression.qualifiedName ?? '<genexpr>',
        (input) => {
          inner.resumeRow = runtime.currentRow;
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
        () => [iterable, first, ...inner.locals.values(), ...inner.cells.values(), ...inner.temporaries]
      );
      generator.frame = inner;
      setFrameGenerator(inner, generator);
      return generator;
    }
    runtime.pushFrame(inner);
    try {
      inner.temporaries.push(iterable, first);
      const { locals } = runtime.finalizer;
      if (expression.type === 'dict') {
        const dict = newDict();
        inner.temporaries.push(dict);
        const items = this.comprehensionItems(expression, inner, next, (key, value) => dict.store.set(key, value));
        while (!items.next().done);
        if (locals.marking) locals.bornContainer(dict, referencesOf(dict) as PyValue[]);
        return dict;
      }
      const container = expression.type === 'list' ? newList([]) : newSet();
      inner.temporaries.push(container);
      for (const item of this.comprehensionItems(expression, inner, next)) {
        if (container instanceof PyList) container.append(item);
        else container.table.add(item);
      }
      if (locals.marking) locals.bornContainer(container, referencesOf(container) as PyValue[]);
      return container;
    } finally {
      runtime.popFrame();
    }
  }

  /** The body of a generator expression's generator, which runs its clauses and yields its elements. */
  protected generatorItems(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    inner: Frame,
    _first: PyValue,
    firstNext: () => PyValue | typeof DONE
  ): Generator<PyValue, PyValue> {
    return this.comprehensionItems(expression, inner, firstNext);
  }

  protected comprehensionFrame(
    expression: Extract<Expression, { kind: 'comprehension' }>,
    frame: Frame,
    firstIterator?: PyValue
  ): Frame {
    const inner = this.nestedFrame('comprehension', expression.scope, frame);
    if (expression.type === 'generator') inner.firstArgument = firstIterator;
    else inner.inlinedIn = frame;
    return inner;
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
    const inner = new Frame(kind, new Map(), cells, frame.globals, callRow, false, scope, frame.fn, frame.classCell);
    inner.builtins = frame.builtins;
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
        throw typeError(`${functionStr(callee)} got multiple values for keyword argument '${argument.name}'`);
      }
      kwargs.set(argument.name, value);
      frame.temporaries.push(value);
      return;
    }
    case 'doubleStar': {
      if (lookupSpecial(value, 'keys') === undefined) {
        throw typeError(`${functionStr(callee)} argument after ** must be a mapping, not ${typeName(value)}`);
      }
      const kwargs = (collected.kwargs ??= new Map());
      for (const [key, item] of mappingEntries(value)) {
        if (typeof key !== 'string') throw typeError('keywords must be strings');
        if (kwargs.has(key))
          throw typeError(`${functionStr(callee)} got multiple values for keyword argument '${key}'`);
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
  const subject = leading + positional === 1 ? `${functionStr(callee)} argument` : 'Value';
  return typeError(`${subject} after * must be an iterable, not ${typeName(iterable)}`);
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
export function unpack(value: PyValue, count: number): PyValue[] {
  if ((value instanceof PyList && value.cls === listClass) || (value instanceof PyTuple && value.cls === tupleClass)) {
    const { items } = value;
    if (items.length > count) throw tooManyValues(count, items.length);
    if (items.length < count) throw notEnoughValues(count, items.length);
    return [...items];
  }
  if (!isIterable(value)) throw typeError(`cannot unpack non-iterable ${typeName(value)} object`);
  // The items taken so far are only here while the iterator runs Python code.
  return currentRuntime().runNative(() => unpackIterated(value, count));
}

function unpackIterated(value: PyValue, count: number): PyValue[] {
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

/** A function's positional defaults and its keyword-only defaults, from the values of its parameters' defaults. */
function splitDefaults(def: FunctionDef, values: PyValue[]): [PyValue[], Map<string, PyValue>] {
  const defaults: PyValue[] = [];
  const keywordDefaults = new Map<string, PyValue>();
  let index = 0;
  for (const param of def.params) {
    if (!param.default) continue;
    const value = values[index++] as PyValue;
    if (param.kind === 'keywordOnly') keywordDefaults.set(param.name, value);
    else defaults.push(value);
  }
  return [defaults, keywordDefaults];
}

/** The cells of the defining frame a new function closes over, which the frame creates for the names it lacks. */
function closureOf(def: FunctionDef, frame: Frame): Map<string, PyCell> {
  const closure = new Map<string, PyCell>();
  for (const name of def.scope.frees) {
    let cell = frame.cells.get(name);
    if (!cell) {
      cell = new PyCell();
      frame.cells.set(name, cell);
    }
    closure.set(name, cell);
  }
  return closure;
}
