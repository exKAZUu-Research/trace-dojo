// code-gauge-allow-file fileNcss 444 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { LIMITS } from '../interpreter/limits';
import type { FunctionDecl } from './ast';
import { lower } from './bytes';
import { valueName } from './conversions';
import { throwError } from './errors';
import { collectGarbage } from './garbage';
import { share } from './places';
import { FatalError, Frame, memoryExhaustedMessage, rt, type Runtime, SCRIPT_PATH, setCallCapture } from './runtime';
import { coerce, describeType, NO_MATCH, typeToString } from './types';
import {
  type Callable,
  type ClosureData,
  type Method,
  type NativeContext,
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
  inline?: boolean;
}

/** One call on the stack, as stack traces report it. */
export interface CallRecord {
  name: string;
  className?: string;
  type?: '->' | '::';
  args: Value[];
  /** The arguments a variadic parameter collected by name, which traces show as `name: value`. */
  named?: [string, Value][];
  /** The row of the call in its caller, or undefined when native code made the call. */
  row: number | undefined;
}

/** Runs a user function's body, which the interpreter provides. */
let runBody: (decl: FunctionDecl, frame: Frame) => Value = () => null;

export function setBodyRunner(run: (decl: FunctionDecl, frame: Frame) => Value): void {
  runBody = run;
}

/** The fatal error PHP reports when endless recursion uses up its memory, growing its stack by a 2 MiB page. */
const MEMORY_EXHAUSTED = memoryExhaustedMessage(2_097_152);

/** Ends a run whose recursion used up the host's stack, which PHP reports as running out of memory. */
export class HostStackExhaustion {
  readonly message = MEMORY_EXHAUSTED;
  record: CallRecord | undefined;
  row: number | undefined;
}

let hostStackExhaustion = new HostStackExhaustion();

/** The calls running, innermost last, for stack traces. */
export const callStack: CallRecord[] = [];
setCallCapture(() => callStack.toReversed());

/** Whether native code is running a callback, which stack traces show as `[internal function]`. */
let nativeDepth = 0;

/** Runs `work` as the engine's own code, whose calls traces show as `[internal function]`. */
export function asInternal<T>(work: () => T): T {
  nativeDepth++;
  try {
    return work();
  } finally {
    nativeDepth--;
  }
}

export function resetCallStack(): void {
  hostStackExhaustion = new HostStackExhaustion();
  callStack.length = 0;
  nativeDepth = 0;
}

/** The display name of a function in messages: `f`, `A::m`, or `{closure:A::m():3}`. */
export function functionDisplayName(target: CallTarget): string {
  const { fn, method } = target;
  if (method) return `${method.scope.name}::${method.name}`;
  if (fn.kind === 'user' && fn.decl.isClosure) return fn.decl.name;
  return fn.name;
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
      name: fn.decl.name,
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
  if (target.fn.kind === 'native') return invokeNative(target, target.fn, args, callRow);
  return invokeUser(target, target.fn, args, callRow);
}

function invokeNative(target: CallTarget, fn: NativeFunction, args: ArgValue[], row: number | undefined): Value {
  const runtime = rt();
  runtime.spend();
  const name = functionDisplayName(target);
  if (target.inline && row !== undefined) {
    const { values, refs, named } = bindNative(fn, args, name, callerIsStrict());
    return runNative(runtime, fn, {
      args: values,
      refs,
      thisObj: target.thisObj,
      calledClass: target.staticClass,
      named,
      row,
    });
  }
  const strict = callerIsStrict();
  // The frame exists while PHP checks the arguments, so a TypeError about them shows the call in its trace.
  const passed = args.filter((arg) => arg.name === undefined).map((arg) => arg.ref?.v ?? arg.v);
  for (const arg of args) {
    if (arg.name === undefined) continue;
    const index = fn.params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (index !== -1) passed[index] = arg.ref?.v ?? arg.v;
  }
  callStack.push(recordFor(target, passed, nativeDepth > 0 && row === undefined ? undefined : row));
  nativeDepth++;
  runtime.nativeCalls++;
  runtime.mayHoldGarbage = true;
  const held: unknown[] = [];
  runtime.nativeHeld.push(held);
  const savedRow = runtime.row;
  let result: Value;
  try {
    const { values, refs, named } = bindNative(fn, args, name, strict);
    result = runNative(runtime, fn, {
      args: values,
      refs,
      thisObj: target.thisObj,
      calledClass: target.staticClass,
      named,
    });
  } finally {
    nativeDepth--;
    runtime.nativeCalls--;
    runtime.nativeHeld.pop();
    callStack.pop();
    runtime.row = savedRow;
  }
  // The values the function's callbacks returned are released once it is done with them; its result stays held.
  if (result instanceof PhpObject || result instanceof PhpArray) runtime.frame.temporaries.push(result);
  runtime.release(held);
  return result;
}

/** Runs a native function's body, refusing a string it builds past the limit as PHP's memory limit would. */
function runNative(runtime: Runtime, fn: NativeFunction, context: NativeContext): Value {
  try {
    const result = fn.impl(context);
    if (typeof result === 'string') runtime.ensureStringFits(result.length);
    return result;
  } catch (error) {
    // The host refuses a string or an array past its own limit, which only a structure far past ours reaches.
    if (
      error instanceof RangeError &&
      /Invalid (string|array) length|Out of memory|Maximum call stack size exceeded|out of memory/i.test(error.message)
    ) {
      throw runtime.memoryExhausted(2 ** 31);
    }
    throw error;
  }
}

/** Matches arguments to a native function's parameters, coercing them to the declared types. */
function bindNative(
  fn: NativeFunction,
  args: ArgValue[],
  name: string,
  strict: boolean
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
  // Only call_user_func passes on named arguments its variadic parameter collects; PHP's other functions refuse them,
  // after checking the arguments they did match.
  const refusesNamed = named !== undefined && fn.name !== 'call_user_func' && !fn.acceptsNamed;
  if (refusesNamed && given < required) {
    throwError(
      'ArgumentCountError',
      `${name}() expects ${variadic ? 'at least' : 'exactly'} ${required} argument${required === 1 ? '' : 's'}, ${given} given`
    );
  }
  if (!variadic && positional.length > fixed) {
    throwError('ArgumentCountError', argumentCountMessage(name, required, fixed, positional.length));
  }
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param.variadic) {
      for (let rest = index; rest < positional.length; rest++) {
        const arg = positional[rest];
        values.push(param.byRef ? (arg.ref?.v ?? arg.v) : coerceArg(param, rest, arg.v, strict, name));
        refs.push(arg.ref);
      }
      break;
    }
    const arg = positional.at(index) ?? args.find((candidate) => candidate.name === param.name);
    if (arg === undefined) {
      if (!param.optional) {
        throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
      }
      values.push(undefined as unknown as Value);
      refs.push(undefined);
      continue;
    }
    if (param.byRef) {
      const value = arg.ref ? arg.ref.v : arg.v;
      // PHP checks the type of a by-reference argument without converting the variable.
      coerceArg(param, index, value, true, name);
      values.push(value);
      refs.push(arg.ref);
    } else {
      values.push(coerceArg(param, index, arg.v, strict, name));
      refs.push(undefined);
    }
  }
  // Trailing parameters left out stay undefined, so natives can tell them from an explicit null.
  while (values.length > 0 && values.at(-1) === undefined && refs.at(-1) === undefined) {
    values.pop();
    refs.pop();
  }
  if (refusesNamed) throwError('ArgumentCountError', `${name}() does not accept unknown named parameters`);
  return { values, refs, named };
}

function coerceArg(param: Param, index: number, value: Value, strict: boolean, name: string): Value {
  if (!param.type) return value;
  const coerced = coerce(value, param.type, {
    strict,
    internal: true,
    nullDeprecation: () =>
      `${name}(): Passing null to parameter #${index + 1} ($${param.name}) of type ${typeToString(param.type as TypeDecl)} is deprecated`,
  });
  if (coerced === NO_MATCH) {
    // PHP names no parameter for an argument a variadic parameter collects.
    const label = param.variadic ? '' : ` ($${param.name})`;
    const parts = param.type.k === 'union' ? param.type.types : [param.type];
    if (parts.some((part) => part.k === 'named' && part.name === 'callable')) {
      const orNull = typeAllowsNull(param.type) ? ' or null' : '';
      throwError(
        'TypeError',
        `${name}(): Argument #${index + 1}${label} must be a valid callback${orNull}, ${callableProblem(value)}`
      );
    }
    throwError(
      'TypeError',
      `${name}(): Argument #${index + 1}${label} must be of type ${nativeTypeText(param.type)}, ${valueName(value)} given`
    );
  }
  return coerced;
}

function typeAllowsNull(type: TypeDecl): boolean {
  if (type.k === 'named') return type.nullable === true || type.name === 'null' || type.name === 'mixed';
  return type.k === 'union' && type.types.some((part) => typeAllowsNull(part));
}

/** A native parameter's type as PHP's argument parsing names it, in the order the signature declares. */
function nativeTypeText(type: TypeDecl): string {
  if (type.k !== 'union') return typeToString(type);
  const text = type.types.map((part) => typeToString(part)).join('|');
  // Argument parsing that accepts an array or an object (Z_PARAM_ARRAY_OR_OBJECT) asks for an array in its message.
  return text === 'array|object' ? 'array' : text;
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

// code-gauge-allow functionNcss 58 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function invokeUser(target: CallTarget, fn: UserFunction, args: ArgValue[], row: number | undefined): Value {
  const runtime = rt();
  const { decl } = fn;
  if (runtime.depth >= LIMITS.maxCallDepth) {
    throw new FatalError(MEMORY_EXHAUSTED, runtime.row, true);
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
  if (closure) bindClosureVars(frame, closure);
  const strict = runtime.strictTypes && nativeDepth === 0;
  const positional = args.filter((arg) => arg.name === undefined);
  const params = fn.params;
  checkNamedArgs(params, args, positional.length);
  frame.args = positional.map((arg) => arg.ref?.v ?? arg.v);
  const record = recordFor(target, [...frame.args], row ?? implicitCallRow());
  const savedRow = runtime.row;
  runtime.frames.push(frame);
  callStack.push(record);
  runtime.depth++;
  const outerNative = nativeDepth;
  const outerNativeCalls = runtime.nativeCalls;
  nativeDepth = 0;
  runtime.nativeCalls = 0;
  let returned: Value;
  try {
    runtime.row = decl.row;
    bindParams(frame, fn, args, positional, name, strict, row);
    handOverArgs(caller, args);
    recordBoundArgs(record, params, frame, args, positional.length);
    let result: Value;
    try {
      result = runBody(decl, frame);
    } catch (error) {
      // The host's stack may run out before the call depth limit under a smaller stack. Too little stack remains here
      // to build an error, so a prepared one carries the innermost call out to where reporting it is safe.
      if (error instanceof RangeError) {
        hostStackExhaustion.record ??= callStack.at(-1);
        hostStackExhaustion.row ??= runtime.row;
        throw hostStackExhaustion;
      }
      throw error;
    }
    if (decl.returnType) result = checkReturn(result, decl.returnType, name, frame);
    else if (decl.byRefReturn === false) result = share(result);
    runtime.lastReturnRef = decl.byRefReturn ? frame.returnRef : undefined;
    returned = result;
  } finally {
    nativeDepth = outerNative;
    runtime.nativeCalls = outerNativeCalls;
    runtime.depth--;
    callStack.pop();
    runtime.frames.pop();
    for (const ref of frame.vars.values()) ref.rc--;
    runtime.row = savedRow;
    if (decl.isAtomic) runtime.steps.completeAtomicCall();
  }
  releaseFrame(runtime, caller, frame, returned, outerNative > 0);
  return returned;
}

/**
 * Destroys a returned function's locals as PHP does, in the order the function declares them, so that their
 * destructors run before the caller goes on, while the returned value stays held by the caller, or by the native
 * function that called this one until that is done with it.
 */
function releaseFrame(runtime: Runtime, caller: Frame, frame: Frame, returned: Value, fromNative: boolean): void {
  const holder = fromNative ? runtime.nativeHeld.at(-1) : undefined;
  if (returned instanceof PhpObject || returned instanceof PhpArray) (holder ?? caller.temporaries).push(returned);
  runtime.release([...[...frame.vars.values()].map((ref) => ref.v), frame.thisObj, frame.closure]);
  if (runtime.destructibles > 0) collectGarbage(runtime);
}

/**
 * Records a call's arguments as PHP's traces show them once bound: converted to the parameters' types, and with the
 * parameters that named arguments reach.
 */
function recordBoundArgs(
  record: CallRecord,
  params: Param[],
  frame: Frame,
  args: ArgValue[],
  positional: number
): void {
  if (args.length > positional) tracedNamedArgs(record, params, frame, args, positional);
  for (const [index, param] of params.entries()) {
    if (param.variadic || index >= record.args.length) break;
    record.args[index] = frame.vars.get(param.name)?.v ?? null;
  }
}

/**
 * Records the arguments of a call with named arguments as PHP's traces show them: the parameters up to the last one
 * passed, defaults included, then what a variadic parameter collected by name.
 */
function tracedNamedArgs(
  record: CallRecord,
  params: Param[],
  frame: Frame,
  args: ArgValue[],
  positional: number
): void {
  let count = positional;
  const named: [string, Value][] = [];
  for (const arg of args) {
    if (arg.name === undefined) continue;
    const index = params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (index === -1) named.push([arg.name, arg.v]);
    else count = Math.max(count, index + 1);
  }
  record.args = [
    ...record.args,
    ...params.slice(positional, count).map((param) => frame.vars.get(param.name)?.v ?? null),
  ];
  record.named = named;
}

/**
 * Takes the arguments of a user function call off the caller's temporaries once the callee's parameters hold them, as
 * PHP moves a temporary argument into the callee's frame, which frees it with the callee's other variables.
 */
function handOverArgs(caller: Frame, args: ArgValue[]): void {
  for (const arg of args) {
    if (!(arg.v instanceof PhpObject || arg.v instanceof PhpArray)) continue;
    // The value may be held twice: as the object `new` made and as the evaluated argument.
    for (
      let index = caller.temporaries.lastIndexOf(arg.v);
      index !== -1;
      index = caller.temporaries.lastIndexOf(arg.v)
    ) {
      caller.temporaries.splice(index, 1);
    }
  }
}

/** Gives a closure's frame the variables the closure captured: shared references, or copies of values. */
function bindClosureVars(frame: Frame, closure: ClosureData): void {
  for (const [varName, ref] of closure.bound) {
    if (ref.isRef) {
      ref.rc++;
      frame.vars.set(varName, ref);
    } else frame.vars.set(varName, new Ref(share(ref.v)));
  }
}

/** The row a call the engine makes for the program's code (a magic method, a conversion) shows: that code's. */
function implicitCallRow(): number | undefined {
  const runtime = rt();
  return nativeDepth === 0 && !runtime.shuttingDown ? runtime.row : undefined;
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

// code-gauge-allow functionNcss 38 -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
// code-gauge-allow functionParameterCount 7 -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
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
        if (param.byRef) {
          const ref = bindRef(arg);
          ref.v = checkParam(ref.v, param, at, name, strict, frame, callRow);
          rest.append(ref);
        } else rest.append(checkParam(arg.v, param, at, name, strict, frame, callRow));
      }
      for (const arg of args) {
        if (arg.name !== undefined && !params.some((other) => other.name === arg.name && !other.variadic)) {
          if (param.byRef) {
            const ref = bindRef(arg);
            ref.v = checkParam(ref.v, param, index, name, strict, frame, callRow);
            rest.setSlot(arg.name, ref);
          } else rest.set(arg.name, checkParam(arg.v, param, index, name, strict, frame, callRow));
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

// code-gauge-allow functionParameterCount 7 -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
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
  const label = param.variadic ? '' : ` ($${param.name})`;
  throwError(
    'TypeError',
    `${name}(): Argument #${index + 1}${label} must be of type ${typeText}, ${valueName(value)} given${where}`
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
  const display = describeType(type, frame.scope, frame.staticClass);
  // A body that ends without `return` returns nothing, which PHP names apart from null.
  const returned = frame.returning === undefined && !frame.decl?.arrowBody ? 'none' : valueName(value);
  throwError('TypeError', `${name}(): Return value must be of type ${display}, ${returned} returned`);
}

/** Whether a user function's parameter `index` takes a reference. */
export function paramIsByRef(fn: Callable, index: number, name?: string): boolean {
  const params = fn.params;
  if (name !== undefined) {
    return (
      params.find((param) => param.name === name)?.byRef ??
      (params.at(-1)?.byRef === true && params.at(-1)?.variadic === true)
    );
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
  const returnText = signature
    .slice(close + 1)
    .replace(/^\s*:\s*/, '')
    .trim();
  const params: Param[] = [];
  if (inside) {
    for (const part of splitParams(inside)) {
      const match = /^(?:([^$&.]+?)\s+)?(&~?)?(\.\.\.)?\$(\w+)(\s*=\s*(.+))?$/.exec(part.trim());
      if (!match) throw new Error(`Bad signature part: ${part} in ${signature}`);
      const [, typeText, ref, dots, paramName, defaultPart] = match;
      params.push({
        name: paramName,
        type: typeText ? parseTypeText(typeText.trim()) : undefined,
        byRef: ref !== undefined,
        preferRef: ref === '&~',
        variadic: dots === '...',
        optional: defaultPart !== undefined || dots === '...',
      });
    }
  }
  return { name, params, returnType: returnText ? parseTypeText(returnText) : undefined };
}

// code-gauge-allow functionCognitiveComplexity 19 -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
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
  const builtin = [
    'int',
    'float',
    'string',
    'bool',
    'array',
    'callable',
    'iterable',
    'object',
    'mixed',
    'void',
    'null',
    'never',
    'false',
    'true',
    'static',
    'self',
  ];
  return { k: 'named', name: builtin.includes(lower(text)) ? lower(text) : text };
}

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
