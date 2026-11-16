import { LIMITS } from '../interpreter/limits';
import type { FunctionDecl } from './ast';
import { lower } from './bytes';
import { FatalError, Frame, rt, SCRIPT_PATH, setCallCapture } from './runtime';
import { coerce, describeType, givenType, NO_MATCH, typeToString } from './types';
import {
  type Callable,
  type ClosureData,
  type Method,
  type NativeFunction,
  type Param,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  type TypeDecl,
  type UserFunction,
  type Value,
} from './values';
import { throwError } from './errors';
import { share } from './places';

/** An argument as a call passes it: its value, and the reference a by-reference parameter receives. */
export interface ArgValue {
  v: Value;
  ref?: Ref;
  name?: string;
}

/** What a call runs and on behalf of whom. */
export interface CallTarget {
  fn: Callable;
  thisObj?: PhpObject;
  scope?: PhpClass;
  staticClass?: PhpClass;
  method?: Method;
  closure?: PhpObject;
}

/** One call on the stack, as stack traces report it. */
export interface CallRecord {
  name: string;
  className?: string;
  type?: '->' | '::';
  args: Value[];
  /** The row of the call in its caller, or undefined when native code made the call. */
  row: number | undefined;
}

/** Runs a user function's body, which the interpreter provides. */
let runBody: (decl: FunctionDecl, frame: Frame) => Value = () => null;

export function setBodyRunner(run: (decl: FunctionDecl, frame: Frame) => Value): void {
  runBody = run;
}

/** The calls running, innermost last, for stack traces. */
export const callStack: CallRecord[] = [];
setCallCapture(() => callStack.toReversed());

/** Whether native code is running a callback, which stack traces show as `[internal function]`. */
let nativeDepth = 0;
const nativeMarks: number[] = [];

export function resetCallStack(): void {
  callStack.length = 0;
  nativeDepth = 0;
  nativeMarks.length = 0;
}

/** The display name of a function in messages: `f`, `A::m`, or `{closure:/main.php:3}`. */
export function functionDisplayName(target: CallTarget): string {
  const { fn, method } = target;
  if (method) return `${method.scope.name}::${method.name}`;
  if (fn.kind === 'user' && fn.decl.isClosure) return closureName(fn.decl);
  return fn.name;
}

export function closureName(decl: FunctionDecl): string {
  return `{closure:${SCRIPT_PATH}:${decl.row + 1}}`;
}

function recordFor(target: CallTarget, args: Value[], row: number | undefined): CallRecord {
  const { fn, method, thisObj } = target;
  if (method) {
    return {
      name: method.name,
      className: method.scope.name,
      type: thisObj && !method.isStatic ? '->' : '::',
      args,
      row,
    };
  }
  if (fn.kind === 'user' && fn.decl.isClosure) {
    const closureData = target.closure?.internal as ClosureData | undefined;
    const scope = closureData?.scope;
    return {
      name: closureName(fn.decl),
      className: scope?.name,
      type: scope ? (closureData?.thisObj ? '->' : '::') : undefined,
      args,
      row,
    };
  }
  return { name: fn.name, args, row };
}

/**
 * Calls a function with arguments already bound to its parameters' kinds (references for by-reference parameters).
 *
 * @param callRow The row of the call, or undefined for a call native code makes.
 */
export function invoke(target: CallTarget, args: ArgValue[], callRow: number | undefined): Value {
  const runtime = rt();
  const row = callRow === undefined ? undefined : callRow;
  if (target.fn.kind === 'native') return invokeNative(target, target.fn, args, row);
  return invokeUser(target, target.fn, args, row);
}

function invokeNative(target: CallTarget, fn: NativeFunction, args: ArgValue[], row: number | undefined): Value {
  const runtime = rt();
  const name = functionDisplayName(target);
  const { values, refs, named } = bindNative(fn, args, name);
  callStack.push(recordFor(target, values, nativeDepth > 0 && row === undefined ? undefined : row));
  nativeDepth++;
  const savedRow = runtime.row;
  try {
    return fn.impl({ args: values, refs, thisObj: target.thisObj, calledClass: target.staticClass, named });
  } finally {
    nativeDepth--;
    callStack.pop();
    runtime.row = savedRow;
  }
}

/** Matches arguments to a native function's parameters, coercing them to the declared types. */
// code-gauge-allow functionCognitiveComplexity 35 -- Argument binding follows PHP's rules for internal functions.
function bindNative(
  fn: NativeFunction,
  args: ArgValue[],
  name: string
): { values: Value[]; refs: (Ref | undefined)[]; named?: Map<string, Value> } {
  const params = fn.params;
  const values: Value[] = [];
  const refs: (Ref | undefined)[] = [];
  let named: Map<string, Value> | undefined;
  const variadic = params.at(-1)?.variadic ? params.at(-1) : undefined;
  const fixed = variadic ? params.length - 1 : params.length;
  const positional = args.filter((arg) => arg.name === undefined);
  const required = params.filter((param) => !param.optional && !param.variadic).length;
  for (const arg of args) {
    if (arg.name === undefined) continue;
    const index = params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (index === -1) {
      if (variadic) {
        named ??= new Map();
        named.set(arg.name, arg.v);
        continue;
      }
      throwError('Error', `Unknown named parameter $${arg.name}`);
    }
    if (index < positional.length) throwError('Error', `Named parameter $${arg.name} overwrites previous argument`);
  }
  const given = positional.length + args.filter((arg) => arg.name !== undefined && !named?.has(arg.name)).length;
  if (positional.length < required && args.every((arg) => arg.name === undefined)) {
    throwError('ArgumentCountError', argumentCountMessage(name, required, variadic ? -1 : fixed, given));
  }
  if (!variadic && positional.length > fixed) {
    throwError('ArgumentCountError', argumentCountMessage(name, required, fixed, positional.length));
  }
  const strict = callerIsStrict();
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param.variadic) {
      for (let rest = index; rest < positional.length; rest++) {
        const arg = positional[rest];
        values.push(param.byRef ? (arg.ref?.v ?? arg.v) : coerceArg(fn, param, rest, arg.v, strict, name));
        refs.push(arg.ref);
      }
      break;
    }
    let arg: ArgValue | undefined = positional[index];
    if (arg === undefined) arg = args.find((candidate) => candidate.name === param.name);
    if (arg === undefined) {
      if (!param.optional) {
        throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
      }
      values.push(undefined as unknown as Value);
      refs.push(undefined);
      continue;
    }
    if (param.byRef) {
      values.push(arg.ref ? arg.ref.v : arg.v);
      refs.push(arg.ref);
    } else {
      values.push(coerceArg(fn, param, index, arg.v, strict, name));
      refs.push(undefined);
    }
  }
  // Trailing parameters left out stay undefined, so natives can tell them from an explicit null.
  while (values.length > 0 && values.at(-1) === undefined && refs.at(-1) === undefined) {
    values.pop();
    refs.pop();
  }
  return { values, refs, named };
}

function coerceArg(fn: NativeFunction, param: Param, index: number, value: Value, strict: boolean, name: string): Value {
  if (!param.type) return value;
  const coerced = coerce(value, param.type, {
    strict,
    internal: true,
    nullDeprecation: () =>
      `${name}(): Passing null to parameter #${index + 1} ($${param.name}) of type ${typeToString(param.type as TypeDecl)} is deprecated`,
  });
  if (coerced === NO_MATCH) {
    if (param.type.k === 'named' && param.type.name === 'callable') {
      throwError('TypeError', `${name}(): Argument #${index + 1} ($${param.name}) must be a valid callback, ${callableProblem(value)}`);
    }
    throwError(
      'TypeError',
      `${name}(): Argument #${index + 1} ($${param.name}) must be of type ${typeToString(param.type)}, ${givenType(value)} given`
    );
  }
  void fn;
  return coerced;
}

/** Explains why a value is not a valid callback, which the library provides. */
let explainCallable: (value: Value) => string = () => 'no array or string given';

export function setCallableExplainer(explain: (value: Value) => string): void {
  explainCallable = explain;
}

export function callableProblem(value: Value): string {
  return explainCallable(value);
}

export function argumentCountMessage(name: string, min: number, max: number, given: number): string {
  if (min === max) return `${name}() expects exactly ${min} argument${min === 1 ? '' : 's'}, ${given} given`;
  if (given < min) return `${name}() expects at least ${min} argument${min === 1 ? '' : 's'}, ${given} given`;
  return `${name}() expects at most ${max} argument${max === 1 ? '' : 's'}, ${given} given`;
}

/** Whether the code making the current call declared strict_types. */
function callerIsStrict(): boolean {
  return rt().strictTypes && nativeDepth === 0;
}

// User functions -----------------------------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 30 -- Binds parameters as PHP's RECV opcodes do.
function invokeUser(target: CallTarget, fn: UserFunction, args: ArgValue[], row: number | undefined): Value {
  const runtime = rt();
  const { decl } = fn;
  if (runtime.depth >= LIMITS.maxCallDepth) {
    throw new FatalError('Allowed memory size of 134217728 bytes exhausted (tried to allocate 2097152 bytes)', runtime.row, true);
  }
  const name = functionDisplayName(target);
  const caller = runtime.frame;
  const frame = new Frame(
    fn,
    row,
    decl.isAtomic,
    target.thisObj,
    target.scope,
    target.staticClass,
    target.method,
    target.closure
  );
  const closure = target.closure?.internal as ClosureData | undefined;
  if (closure) {
    for (const [varName, ref] of closure.bound) {
      if (ref.isRef) {
        ref.rc++;
        frame.vars.set(varName, ref);
      } else frame.vars.set(varName, new Ref(share(ref.v)));
    }
  }
  const strict = runtime.strictTypes && nativeDepth === 0;
  const positional = args.filter((arg) => arg.name === undefined);
  const params = fn.params;
  checkNamedArgs(params, args, positional.length);
  const record = recordFor(target, positional.map((arg) => arg.ref?.v ?? arg.v), row);
  frame.args = positional.map((arg) => arg.ref?.v ?? arg.v);
  const savedRow = runtime.row;
  runtime.frames.push(frame);
  callStack.push(record);
  runtime.depth++;
  const outerNative = nativeDepth;
  nativeMarks.push(nativeDepth);
  nativeDepth = 0;
  try {
    runtime.row = decl.row;
    bindParams(frame, fn, args, positional, name, strict, row);
    let result = runBody(decl, frame);
    if (decl.returnType) result = checkReturn(result, decl.returnType, name, frame);
    else if (decl.byRefReturn === false) result = share(result);
    runtime.lastReturnRef = decl.byRefReturn ? frame.returnRef : undefined;
    return result;
  } finally {
    nativeDepth = outerNative;
    nativeMarks.pop();
    runtime.depth--;
    callStack.pop();
    runtime.frames.pop();
    for (const ref of frame.vars.values()) ref.rc--;
    runtime.row = savedRow;
    if (decl.isAtomic) runtime.steps.completeAtomicCall();
    void caller;
  }
}

function checkNamedArgs(params: Param[], args: ArgValue[], positionalCount: number): void {
  const variadic = params.at(-1)?.variadic;
  for (const arg of args) {
    if (arg.name === undefined) continue;
    const index = params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (index === -1) {
      if (variadic) continue;
      throwError('Error', `Unknown named parameter $${arg.name}`);
    }
    if (index < positionalCount) throwError('Error', `Named parameter $${arg.name} overwrites previous argument`);
  }
}

/** Evaluates a parameter's default value, which the interpreter provides. */
let evaluateDefault: (decl: FunctionDecl, index: number, frame: Frame) => Value = () => null;

export function setDefaultEvaluator(run: (decl: FunctionDecl, index: number, frame: Frame) => Value): void {
  evaluateDefault = run;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Binds parameters as PHP's RECV opcodes do.
function bindParams(
  frame: Frame,
  fn: UserFunction,
  args: ArgValue[],
  positional: ArgValue[],
  name: string,
  strict: boolean,
  callRow: number | undefined
): void {
  const params = fn.params;
  const required = params.filter((param) => !param.optional && !param.variadic).length;
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param.variadic) {
      const rest = new PhpArray();
      for (let at = index; at < positional.length; at++) {
        const arg = positional[at];
        if (param.byRef) rest.append(bindRef(arg));
        else rest.append(checkParam(arg.v, param, at, name, strict, frame, callRow));
      }
      for (const arg of args) {
        if (arg.name !== undefined && !params.some((other) => other.name === arg.name && !other.variadic)) {
          rest.set(arg.name, checkParam(arg.v, param, index, name, strict, frame, callRow));
        }
      }
      frame.vars.set(param.name, new Ref(rest));
      break;
    }
    const arg = index < positional.length ? positional[index] : args.find((candidate) => candidate.name === param.name);
    if (arg === undefined) {
      if (!param.optional) {
        const anyNamed = args.some((candidate) => candidate.name !== undefined);
        if (anyNamed) throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
        const hasOptional = params.some((other) => other.optional && !other.variadic) || params.at(-1)?.variadic;
        const where = callRow === undefined ? '' : ` in ${SCRIPT_PATH} on line ${callRow + 1}`;
        const expectation = hasOptional ? 'at least' : 'exactly';
        throwError(
          'ArgumentCountError',
          `Too few arguments to function ${name}(), ${positional.length} passed${where} and ${expectation} ${required} expected`
        );
      }
      const value = evaluateDefault(fn.decl, index, frame);
      frame.vars.set(param.name, new Ref(value));
      continue;
    }
    if (param.byRef) {
      const ref = bindRef(arg);
      frame.vars.set(param.name, ref);
      if (param.type && !(ref.v === null && param.implicitNullable)) {
        ref.v = checkParam(ref.v, param, index, name, strict, frame, callRow);
      }
    } else {
      frame.vars.set(param.name, new Ref(checkParam(share(arg.v), param, index, name, strict, frame, callRow)));
    }
  }
}

function bindRef(arg: ArgValue): Ref {
  const ref = arg.ref ?? new Ref(arg.v);
  ref.isRef = true;
  ref.rc++;
  return ref;
}

function checkParam(
  value: Value,
  param: Param,
  index: number,
  name: string,
  strict: boolean,
  frame: Frame,
  callRow: number | undefined
): Value {
  const type = param.type;
  if (!type) return value;
  if (value === null && param.implicitNullable) return value;
  const coerced = coerce(value, type, { strict, internal: false, scope: frame.scope, staticClass: frame.staticClass });
  if (coerced !== NO_MATCH) return coerced;
  const where = callRow === undefined ? '' : `, called in ${SCRIPT_PATH} on line ${callRow + 1}`;
  const typeText = param.implicitNullable && type.k === 'named' ? `?${type.name}` : describeType(type, frame.scope);
  throwError(
    'TypeError',
    `${name}(): Argument #${index + 1} ($${param.name}) must be of type ${typeText}, ${givenType(value)} given${where}`
  );
}

function checkReturn(value: Value, type: TypeDecl, name: string, frame: Frame): Value {
  if (type.k === 'named' && type.name === 'void') return null;
  if (type.k === 'named' && type.name === 'never') {
    throwError('TypeError', `${name}(): never-returning function must not implicitly return`);
  }
  const coerced = coerce(value, type, {
    strict: rt().strictTypes,
    internal: false,
    scope: frame.scope,
    staticClass: frame.staticClass,
  });
  if (coerced !== NO_MATCH) return share(coerced);
  const display = type.k === 'named' && type.name === 'static' && frame.staticClass ? 'static' : describeType(type, frame.scope);
  throwError('TypeError', `${name}(): Return value must be of type ${display}, ${givenType(value)} returned`);
}

/** Whether a user function's parameter `index` takes a reference. */
export function paramIsByRef(fn: Callable, index: number, name?: string): boolean {
  const params = fn.params;
  if (name !== undefined) {
    return params.find((param) => param.name === name)?.byRef ?? (params.at(-1)?.byRef === true && params.at(-1)?.variadic === true);
  }
  if (index < params.length) return params[index].byRef;
  const last = params.at(-1);
  return last?.variadic === true && last.byRef;
}

/** Parses a native function's signature, written as in PHP's stubs: `str_pad(string $string, int $length, ...)`. */
export function parseSignature(signature: string): { name: string; params: Param[]; returnType?: TypeDecl } {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  const name = signature.slice(0, open).trim();
  const inside = signature.slice(open + 1, close).trim();
  const returnText = signature.slice(close + 1).replace(/^\s*:\s*/, '').trim();
  const params: Param[] = [];
  if (inside) {
    for (const part of splitParams(inside)) {
      const match = /^(?:([^$&.]+?)\s+)?(&)?(\.\.\.)?\$(\w+)(\s*=\s*(.+))?$/.exec(part.trim());
      if (!match) throw new Error(`Bad signature part: ${part} in ${signature}`);
      const [, typeText, ref, dots, paramName, defaultPart] = match;
      params.push({
        name: paramName,
        type: typeText ? parseTypeText(typeText.trim()) : undefined,
        byRef: ref === '&',
        variadic: dots === '...',
        optional: defaultPart !== undefined || dots === '...',
      });
    }
  }
  return { name, params, returnType: returnText ? parseTypeText(returnText) : undefined };
}

function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
      current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === '[' || char === '(') depth++;
    if (char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

export function parseTypeText(text: string): TypeDecl {
  if (text.includes('|')) return { k: 'union', types: text.split('|').map((part) => parseTypeText(part)) };
  if (text.startsWith('?')) return { k: 'named', name: lower(text.slice(1)), nullable: true };
  const builtin = ['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'never', 'false', 'true', 'static', 'self'];
  return { k: 'named', name: builtin.includes(lower(text)) ? lower(text) : text };
}

export function isNativeCallRunning(): boolean {
  return nativeDepth > 0;
}

export { invokeUser as _invokeUser };

export function closureFunction(decl: FunctionDecl): UserFunction {
  const runtime = rt();
  let fn = runtime.closureFunctions.get(decl);
  if (!fn) {
    fn = { kind: 'user', name: '{closure}', decl, params: decl.params, statics: new Map() };
    runtime.closureFunctions.set(decl, fn);
  }
  return fn;
}

export function isObject(value: Value): value is PhpObject {
  return value instanceof PhpObject;
}
