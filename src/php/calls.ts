// code-gauge-allow-file fileNcss 684 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { LIMITS } from '../interpreter/limits';
import type { FunctionDecl } from './ast';
import { lower } from './bytes';
import { valueName } from './conversions';
import { notice, throwError, withPendingException } from './errors';
import { decodeLiteral } from './literals';
import { share } from './places';
import {
  FatalError,
  Frame,
  memoryExhaustedMessage,
  PhpThrow,
  rt,
  type Runtime,
  SCRIPT_PATH,
  setCallCapture,
} from './runtime';
import { coerce, describeType, matches, NO_MATCH, parameterType, typeToString } from './types';
import {
  type Callable,
  type ClosureData,
  type Method,
  type NativeContext,
  type NativeFunction,
  nativeOwnershipChanged,
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
  temporaryCount?: number;
  nativeTransfer?: { values: unknown[]; count: number; value?: Value };
  v: Value;
  ref?: Ref;
  name?: string;
  position?: number;
  omitted?: boolean;
}

/** What a call runs and on behalf of whom. */
export interface CallTarget {
  fn: Callable;
  thisObj?: PhpObject;
  scope?: PhpClass;
  staticClass?: PhpClass;
  method?: Method;
  closure?: PhpObject;
  magic?: MagicCall;
  directOverload?: boolean;
  inline?: boolean;
  frameless?: boolean;
}

export interface MagicCall {
  method: Method;
  name: string;
  receiver?: PhpObject;
  calledClass: PhpClass;
}

/** One call on the stack, as stack traces report it. */
export interface CallRecord {
  name: string;
  className?: string;
  type?: '->' | '::';
  args: Value[];
  argumentRefs?: (Ref | undefined)[];
  boundFrame?: Frame;
  thisObj?: PhpObject;
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
setCallCapture(() =>
  callStack.toReversed().map((record) => ({
    ...record,
    args: callArguments(record),
    named: callNamedArguments(record),
    argumentRefs: undefined,
    boundFrame: undefined,
    thisObj: undefined,
  }))
);

export function callArguments(record: CallRecord): Value[] {
  if (record.boundFrame) return frameArguments(record.boundFrame);
  return record.args.map((value, index) => {
    const ref = record.argumentRefs?.[index];
    return ref ? ref.v : value;
  });
}

export function frameArguments(frame: Frame): Value[] {
  const values = frame.args.map((value, index) => (frame.argumentRefs[index] ? frame.argumentRefs[index].v : value));
  for (const [index, param] of frame.fn?.params.entries() ?? []) {
    if (index >= values.length || param.variadic) break;
    values[index] = frame.vars.get(param.name)?.v ?? null;
  }
  return values;
}

export function callNamedArguments(record: CallRecord): [string, Value][] {
  return (record.named ?? []).map(([name, value]) => {
    const ref = record.boundFrame?.namedArgumentRefs.get(name);
    return [name, ref ? ref.v : value];
  });
}

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
  if (fn.kind === 'user' && fn.decl.isPropertyHook) return `${target.scope?.name ?? fn.decl.className}::${fn.name}`;
  if (fn.kind === 'user' && fn.decl.isClosure) return `${target.scope ? `${target.scope.name}::` : ''}${fn.decl.name}`;
  return fn.name;
}

function recordFor(target: CallTarget, args: Value[], row: number | undefined): CallRecord {
  const { fn, method, thisObj } = target;
  if (method) {
    return {
      name: method.name,
      className: method.scope.name,
      type: thisObj && !method.isStatic ? '->' : '::',
      thisObj,
      args,
      row,
    };
  }
  if (fn.kind === 'user' && fn.decl.isPropertyHook)
    return {
      name: fn.name,
      className: target.scope?.name ?? fn.decl.className,
      type: thisObj ? '->' : '::',
      thisObj,
      args,
      row,
    };
  if (fn.kind === 'user' && fn.decl.isClosure) {
    const scope = target.scope;
    return {
      name: fn.decl.name,
      className: scope?.name,
      type: scope ? (thisObj ? '->' : '::') : undefined,
      thisObj,
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
export function invoke(
  target: CallTarget,
  args: ArgValue[],
  callRow: number | undefined,
  discardResult = false
): Value {
  if (target.fn.kind === 'native') return invokeNative(target, target.fn, args, callRow, discardResult);
  return invokeUser(target, target.fn, args, callRow, discardResult);
}

interface NativeHolders {
  values: unknown[];
  references: Ref[];
  argumentCount: number;
}

function invokeNative(
  target: CallTarget,
  fn: NativeFunction,
  args: ArgValue[],
  row: number | undefined,
  discardResult: boolean
): Value {
  const runtime = rt();
  runtime.spend();
  const caller = runtime.frame;
  const name = functionDisplayName(target);
  const inline = target.inline && row !== undefined;
  const strict = callerIsStrict();
  let record: CallRecord | undefined;
  if (!inline) {
    const passed = positionalArguments(args).map((arg) => arg.ref?.v ?? arg.v);
    for (const arg of args) {
      if (arg.name === undefined) continue;
      const index = fn.params.findIndex((param) => param.name === arg.name && !param.variadic);
      if (index !== -1) passed[index] = arg.ref?.v ?? arg.v;
    }
    const dense = Array.from({ length: passed.length }, (_, index) =>
      index in passed ? passed[index] : nativeDefault(fn.params[index]?.nativeDefault)
    );
    record = recordFor(target, dense, nativeDepth > 0 && row === undefined ? undefined : row);
    callStack.push(record);
    nativeDepth++;
  }
  runtime.nativeCalls++;
  const held: NativeHolders = {
    values: args.map((arg) => arg.ref ?? arg.v),
    references: args.flatMap((arg) => (arg.ref ? [arg.ref] : [])),
    argumentCount: args.length,
  };
  for (const ref of held.references) ref.rc++;
  runtime.nativeHeld.push(held.values);
  handOverArgs(caller, args);
  const savedRow = runtime.row;
  let result: Value = null;
  let failed = false;
  let failure: unknown;
  try {
    const { values, refs, named } = bindNative(
      fn,
      args,
      name,
      strict,
      Boolean(inline || target.directOverload),
      record
    );
    for (let index = 0; index < values.length; index++) {
      if (values[index] === undefined && fn.params[index]?.byRef)
        refs[index] = Ref.temporary(nativeDefault(fn.params[index].nativeDefault));
    }
    if (record) record.argumentRefs = refs;
    for (const ref of refs) {
      if (!ref || held.references.includes(ref)) continue;
      ref.rc++;
      held.references.push(ref);
      held.values.splice(held.argumentCount++, 0, ref);
    }
    result = runNative(runtime, fn, {
      args: values,
      refs,
      thisObj: target.thisObj,
      calledClass: target.staticClass,
      named,
      directOverload: target.directOverload,
      row: inline || target.frameless ? row : undefined,
      discardResult: Boolean(inline && discardResult),
    });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (!inline) {
      nativeDepth--;
      callStack.pop();
    }
    runtime.nativeCalls--;
    runtime.nativeHeld.pop();
    if (target.thisObj) runtime.pendingGcRoots.add(target.thisObj);
    runtime.row = savedRow;
    if (!failed || failure instanceof PhpThrow) {
      if (result instanceof PhpObject || result instanceof PhpArray) caller.temporaries.push(result);
      releaseNativeValues(runtime, held, failure instanceof PhpThrow ? failure : undefined);
    } else {
      for (const ref of held.references) ref.releaseWithoutGc();
    }
  }
  runtime.lastReturnRef = undefined;
  return result;
}

function nativeDefault(defaultText: string | undefined): Value {
  const text = defaultText?.trim();
  if (!text || text === 'UNKNOWN' || text === 'null') return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === '[]') return new PhpArray();
  if (/^-?\d+$/.test(text)) return BigInt(text);
  if (/^-?\d+\.\d+(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
  if (text.startsWith('"') || text.startsWith("'")) return decodeLiteral(text.slice(1, -1), text[0] === '"');
  if (text.includes('|')) {
    let bits = 0n;
    for (const part of text.split('|')) bits |= nativeDefault(part.trim()) as bigint;
    return bits;
  }
  const separator = text.indexOf('::');
  if (separator !== -1) {
    const cls = rt().classes.get(lower(text.slice(0, separator)));
    return cls?.findConst(text.slice(separator + 2))?.value ?? null;
  }
  return rt().constants.get(text) ?? null;
}

function releaseNativeValues(runtime: Runtime, held: NativeHolders, pending?: PhpThrow): void {
  const args = held.values.slice(0, held.argumentCount);
  const transients = held.values.slice(held.argumentCount);
  let failure: unknown = pending;
  let failed = false;
  runtime.nativeHeld.push(args);
  try {
    releaseCallValues(runtime, transients, pending);
  } catch (error) {
    failure = error;
    failed = true;
    throw error;
  } finally {
    runtime.nativeHeld.pop();
    for (const ref of held.references) ref.releaseWithoutGc();
    if (!failed || failure instanceof PhpThrow)
      releaseCallValues(runtime, args, failure instanceof PhpThrow ? failure : undefined);
  }
}

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
  } finally {
    if (context.thisObj) nativeOwnershipChanged(context.thisObj);
  }
}

/** Matches arguments to a native function's parameters, coercing them to the declared types. */
// code-gauge-allow functionNcss 58 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function bindNative(
  fn: NativeFunction,
  args: ArgValue[],
  name: string,
  strict: boolean,
  directOverload: boolean,
  record?: CallRecord
): { values: Value[]; refs: (Ref | undefined)[]; named?: Map<string, Value> } {
  const positional = positionalArguments(args);
  const params = nativeOverloadParams(fn, args, positional.length, directOverload);
  const values: Value[] = [];
  const refs: (Ref | undefined)[] = [];
  if (record) record.argumentRefs = refs;
  const append = (value: Value | undefined, ref?: Ref): void => {
    const index = values.length;
    values.push(value as Value);
    refs.push(ref);
    if (record && index < record.args.length && typeof value === 'string') record.args[index] = value;
  };
  const named = checkNamedArgs(params, args);
  if (record && named) record.named = [...named];
  const variadic = params.at(-1)?.variadic ? params.at(-1) : undefined;
  const fixed = variadic ? params.length - 1 : params.length;
  let lastGiven = positional.length - 1;
  for (const arg of args)
    lastGiven = Math.max(
      lastGiven,
      params.findIndex((param) => param.name === arg.name)
    );
  const required = params.filter((param) => !param.optional && !param.variadic).length;
  const given = args.filter((arg) => arg.name === undefined || !named?.has(arg.name)).length;
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
        append(
          param.byRef ? (arg.ref?.v ?? arg.v) : coerceArg(param, rest, arg.v, strict, name),
          param.byRef ? (arg.ref ?? Ref.temporary(arg.v)) : undefined
        );
      }
      break;
    }
    const arg = positional.at(index) ?? args.find((candidate) => candidate.name === param.name);
    if (arg === undefined) {
      if (!param.optional) {
        throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
      }
      if (param.nativeDefault === 'UNKNOWN' && index < lastGiven)
        throwError(
          'ArgumentCountError',
          `${name}(): Argument #${index + 1} ($${param.name}) must be passed explicitly, because the default value is not known`
        );
      append(undefined);
      continue;
    }
    if (param.byRef) {
      const value = arg.ref ? arg.ref.v : arg.v;
      // PHP checks the type of a by-reference argument without converting the variable.
      coerceArg(param, index, value, true, name);
      append(value, arg.ref ?? Ref.temporary(value));
    } else {
      append(coerceArg(param, index, arg.v, strict, name));
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

function nativeOverloadParams(fn: NativeFunction, args: ArgValue[], positional: number, direct: boolean): Param[] {
  const short = fn.shortParams;
  if (!short || positional > short.length || (fn.shortParamsDirectOnly && !direct)) return fn.params;
  const extraNames = new Set(fn.params.slice(short.length).map((param) => param.name));
  return args.some((arg) => arg.name !== undefined && extraNames.has(arg.name)) ? fn.params : short;
}

function coerceArg(param: Param, index: number, value: Value, strict: boolean, name: string): Value {
  if (!param.type) return value;
  const coerced = coerce(value, param.type, {
    strict,
    internal: true,
    nullDeprecation: () =>
      `${name}(): Passing null to parameter #${index + 1} ($${param.name}) of type ${param.nativeNullType ?? typeToString(param.type as TypeDecl)} is deprecated`,
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

export function backtraceLimit(value: bigint | undefined): number {
  return value === undefined || value === 0n ? Infinity : Math.max(0, Number(value));
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

// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function invokeUser(
  target: CallTarget,
  fn: UserFunction,
  args: ArgValue[],
  row: number | undefined,
  discardResult: boolean
): Value {
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
  const strict = runtime.strictTypes && nativeDepth === 0;
  const positional = positionalArguments(args);
  const params = fn.params;
  checkNamedArgs(params, args);
  frame.args = positional.map((arg) => arg.ref?.v ?? arg.v);
  for (const arg of args) {
    const index = arg.name === undefined ? -1 : params.findIndex((param) => !param.variadic && param.name === arg.name);
    if (index >= 0) frame.args[index] = arg.ref?.v ?? arg.v;
  }
  frame.args = Array.from({ length: frame.args.length }, (_, index) => frame.args[index] ?? null);
  const record = recordFor(target, [...frame.args], row ?? implicitCallRow());
  frame.args = args.map((arg) => arg.ref?.v ?? arg.v);
  frame.argumentHolders = [...frame.args];
  const savedRow = runtime.row;
  runtime.frames.push(frame);
  callStack.push(record);
  runtime.depth++;
  const outerNative = nativeDepth;
  const outerNativeCalls = runtime.nativeCalls;
  nativeDepth = 0;
  runtime.nativeCalls = 0;
  let returned: Value = null;
  let failure: unknown;
  let failed = false;
  try {
    runtime.row = decl.row;
    handOverArgs(caller, args);
    if (closure) bindClosureVars(frame, closure);
    bindParams(frame, fn, args, positional, name, strict, row);
    recordBoundArgs(record, params, frame, args, positional.length);
    bindArgumentHolders(frame, params, record, args);
    runtime.dropTemporaries(frame, 0);
    record.boundFrame = frame;
    let result: Value;
    try {
      result = runBody(decl, frame);
    } catch (error) {
      // The host's stack may run out before the call depth limit under a smaller stack. Too little stack remains here
      // to build an error, so a prepared one carries the innermost call out to where reporting it is safe.
      if (error instanceof RangeError) {
        runtime.exhausted = true;
        hostStackExhaustion.record ??= callStack.at(-1);
        hostStackExhaustion.row ??= runtime.row;
        throw hostStackExhaustion;
      }
      throw error;
    }
    result = completeUserReturn(decl, frame, result, name);
    if (discardResult) {
      const returning = frame.returning;
      frame.returning = undefined;
      runtime.row = frame.returnRow ?? runtime.row;
      runtime.release([returning, result]);
    } else returned = result;
  } catch (error) {
    failure = error;
    failed = true;
    throw error;
  } finally {
    nativeDepth = outerNative;
    runtime.nativeCalls = outerNativeCalls;
    runtime.depth--;
    callStack.pop();
    runtime.frames.pop();
    for (const ref of frame.vars.values()) ref.rc--;
    for (const value of frame.argumentHolders) if (value instanceof Ref) value.rc--;
    for (const value of frame.temporaries) if (value instanceof Ref) value.rc--;
    runtime.row = savedRow;
    if (decl.isAtomic) runtime.steps.completeAtomicCall();
    if (!failed || failure instanceof PhpThrow)
      releaseFrame(
        runtime,
        caller,
        frame,
        returned,
        outerNative > 0,
        failure instanceof PhpThrow ? failure : undefined
      );
  }
  runtime.lastReturnRef = !discardResult && frame.returning instanceof Ref ? frame.returning : undefined;
  return returned;
}

function completeUserReturn(decl: FunctionDecl, frame: Frame, value: Value, name: string): Value {
  const runtime = rt();
  runtime.row = frame.returnRow ?? decl.endRow;
  const result = decl.returnType ? checkReturn(value, decl.returnType, name, frame) : value;
  if (!decl.byRefReturn) return decl.returnType ? result : share(result);
  if (frame.returning instanceof Ref) {
    if (decl.returnType) frame.returning.assign(result);
    return frame.returning.v;
  }
  notice('Only variable references should be returned by reference');
  const ref = Ref.temporary(result);
  ref.isRef = true;
  frame.returning = ref;
  return result;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function bindArgumentHolders(frame: Frame, params: Param[], record: CallRecord, args: ArgValue[]): void {
  frame.args = [...record.args];
  frame.argumentHolders = [];
  const variadic = params.at(-1)?.variadic ? params.at(-1) : undefined;
  const fixed = variadic ? params.length - 1 : params.length;
  const rest = variadic ? frame.vars.get(variadic.name)?.v : undefined;
  const positional = positionalArguments(args);
  const namedRefs = new Set(args.filter((arg) => arg.ref && arg.name !== undefined).map((arg) => arg.name));
  const hold = (slot: Value | Ref): void => {
    if (slot instanceof Ref) slot.rc++;
    frame.argumentHolders.push(slot);
  };
  for (let index = fixed; index < frame.args.length; index++) {
    const stored = rest instanceof PhpArray ? (rest.map.get(BigInt(index - fixed)) ?? null) : frame.args[index];
    const slot = stored instanceof Ref && !positional[index]?.ref ? stored.v : stored;
    frame.args[index] = slot instanceof Ref ? slot.v : slot;
    if (slot instanceof Ref) frame.argumentRefs[index] = slot;
    hold(slot);
  }
  for (const entry of record.named ?? []) {
    const stored = rest instanceof PhpArray ? (rest.map.get(entry[0]) ?? null) : entry[1];
    const slot = stored instanceof Ref && !namedRefs.has(entry[0]) ? stored.v : stored;
    entry[1] = slot instanceof Ref ? slot.v : slot;
    if (slot instanceof Ref) frame.namedArgumentRefs.set(entry[0], slot);
    hold(slot);
  }
}

/**
 * Releases a finished function's locals in declaration order, so that their
 * destructors run before the caller goes on, while the returned value stays held by the caller, or by the native
 * function that called this one until that is done with it.
 */
function releaseFrame(
  runtime: Runtime,
  caller: Frame,
  frame: Frame,
  returned: Value,
  fromNative: boolean,
  pending?: PhpThrow
): void {
  if (frame.thisObj) runtime.pendingGcRoots.add(frame.thisObj);
  const holder = fromNative ? runtime.nativeHeld.at(-1) : undefined;
  if (returned instanceof PhpObject || returned instanceof PhpArray) (holder ?? caller.temporaries).push(returned);
  releaseCallValues(
    runtime,
    [
      ...[...frame.vars.values()].map((ref) => ref.v),
      ...frame.argumentHolders,
      ...frame.temporaries,
      frame.returning,
      frame.thisObj,
      frame.closure,
    ],
    pending
  );
}

function releaseCallValues(runtime: Runtime, values: unknown[], pending?: PhpThrow): void {
  withPendingException(runtime, pending, () => runtime.release(values));
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
  if (args.some((arg) => arg.name !== undefined)) tracedNamedArgs(record, params, frame, args, positional);
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
    ...record.args.slice(0, positional),
    ...params.slice(positional, count).map((param) => frame.vars.get(param.name)?.v ?? null),
  ];
  record.named = named;
}

/**
 * Takes the arguments of a user function call off the caller's temporaries once the callee's parameters hold them, as
 * PHP moves a temporary argument into the callee's frame, which frees it with the callee's other variables.
 */
export function handOverArgs(caller: Frame, args: ArgValue[]): void {
  for (const arg of args) {
    if (arg.nativeTransfer) {
      const { values, count, value = arg.v } = arg.nativeTransfer;
      for (let index = count - 1; index >= 0; index--) {
        if (values[index] === value) {
          values[index] = undefined;
          break;
        }
      }
    }

    for (let count = arg.temporaryCount ?? 0; count > 0; count--) {
      const index = caller.temporaries.lastIndexOf(arg.v);
      if (index === -1) break;
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

function positionalArguments(args: ArgValue[]): ArgValue[] {
  const result: ArgValue[] = [];
  for (const arg of args) if (arg.name === undefined) result[arg.position ?? result.length] = arg;
  return result;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function checkNamedArgs(params: Param[], args: ArgValue[]): Map<string, Value> | undefined {
  const variadic = params.at(-1)?.variadic;
  const names = new Set<string>();
  const positions = new Set<number>();
  let nextPosition = 0;
  let named: Map<string, Value> | undefined;
  for (const arg of args) {
    if (arg.name === undefined) {
      if (arg.position === undefined && names.size > 0)
        throwError('Error', 'Cannot use positional argument after named argument');
      const position = arg.position ?? nextPosition;
      positions.add(position);
      nextPosition = position + 1;
      continue;
    }
    const index = params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (names.has(arg.name) || (index !== -1 && positions.has(index)))
      throwError('Error', `Named parameter $${arg.name} overwrites previous argument`);
    names.add(arg.name);
    if (index === -1) {
      if (!variadic) throwError('Error', `Unknown named parameter $${arg.name}`);
      named ??= new Map();
      named.set(arg.name, arg.v);
    }
  }
  return named;
}

/** Evaluates a parameter's default value, which the interpreter provides. */
let evaluateDefault: (decl: FunctionDecl, index: number, frame: Frame) => Value = () => null;

export function setDefaultEvaluator(run: (decl: FunctionDecl, index: number, frame: Frame) => Value): void {
  evaluateDefault = run;
}

// code-gauge-allow functionNcss 52 -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
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
  let holderIndices: Map<ArgValue, number> | undefined;
  const bindSupplied = (arg: ArgValue, param: Param, index: number, assign: (slot: Value | Ref) => void): void => {
    const ref = param.byRef ? bindRef(arg) : undefined;
    if (ref) assign(ref);
    const original = ref ? ref.v : share(arg.v);
    const value = checkParam(original, param, index, name, strict, frame, callRow);
    if (ref) {
      if (value !== original) ref.v = value;
    } else assign(value);
    if (!(original instanceof PhpObject) || value === original) return;
    holderIndices ??= new Map(args.map((argument, position) => [argument, position]));
    const holder = holderIndices.get(arg)!;
    const held = frame.argumentHolders[holder];
    frame.argumentHolders[holder] = value;
    rt().release([original, held]);
  };
  const required = params.filter((param) => !param.optional && !param.variadic).length;
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param.variadic) {
      const rest = new PhpArray();
      frame.vars.set(param.name, new Ref(rest));
      for (let at = index; at < positional.length; at++) {
        const arg = positional[at];
        if (arg.omitted) throwError('ArgumentCountError', `${name}(): Argument #${at + 1} not passed`);
        bindSupplied(arg, param, at, (slot) => rest.append(slot));
      }
      for (const arg of args) {
        const argName = arg.name;
        if (argName !== undefined && !params.some((other) => other.name === argName && !other.variadic))
          bindSupplied(arg, param, index, (slot) => rest.setSlot(argName, slot));
      }
      break;
    }
    const arg = positional[index] ?? args.find((candidate) => candidate.name === param.name);
    if (arg === undefined || arg.omitted) {
      if (!param.optional) {
        const anyNamed = args.some((candidate) => candidate.name !== undefined);
        const passed = callStack.at(-1)?.args.length ?? positional.length;
        if (arg?.omitted || (anyNamed && passed >= required)) {
          throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
        }
        const hasOptional = params.some((other) => other.optional && !other.variadic);
        const where = callRow === undefined ? '' : ` in ${SCRIPT_PATH} on line ${callRow + 1}`;
        const expectation = hasOptional ? 'at least' : 'exactly';
        throwError(
          'ArgumentCountError',
          `Too few arguments to function ${name}(), ${passed} passed${where} and ${expectation} ${required} expected`
        );
      }
      const value = evaluateDefault(fn.decl, index, frame);
      frame.vars.set(param.name, new Ref(value));
      continue;
    }
    bindSupplied(arg, param, index, (slot) => frame.vars.set(param.name, slot instanceof Ref ? slot : new Ref(slot)));
  }
}

function bindRef(arg: ArgValue): Ref {
  const ref = arg.ref ?? Ref.temporary(arg.v);
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
  const type = parameterType(param);
  if (!type) return value;
  const coerced = coerce(value, type, { strict, internal: false, scope: frame.scope, staticClass: frame.staticClass });
  if (coerced !== NO_MATCH) return coerced;
  const where = callRow === undefined ? '' : `, called in ${SCRIPT_PATH} on line ${callRow + 1}`;
  const typeText = describeType(type, frame.scope);
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
  if (
    frame.returning instanceof Ref &&
    frame.returning.typeOwners().length > 0 &&
    !matches(value, type, { scope: frame.scope, staticClass: frame.staticClass })
  )
    return throwReturnTypeError(value, type, name, frame);
  const coerced = coerce(value, type, {
    strict: rt().strictTypes,
    internal: false,
    scope: frame.scope,
    staticClass: frame.staticClass,
  });
  if (coerced !== NO_MATCH) return share(coerced);
  return throwReturnTypeError(value, type, name, frame);
}

function throwReturnTypeError(value: Value, type: TypeDecl, name: string, frame: Frame): never {
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
      const [, typeText, ref, dots, paramName, defaultPart, defaultText] = match;
      params.push({
        name: paramName,
        type: typeText ? parseTypeText(typeText.trim()) : undefined,
        byRef: ref !== undefined,
        preferRef: ref === '&~',
        variadic: dots === '...',
        optional: defaultPart !== undefined || dots === '...',
        nativeDefault: defaultText,
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
  return { kind: 'user', name: '{closure}', decl, params: decl.params, statics: new Map() };
}

export function copyClosureData(data: ClosureData): ClosureData {
  return {
    ...data,
    bound: copyClosureRefs(data.bound),
    fn:
      data.fn.kind === 'user' && data.fn.decl.isClosure
        ? { ...data.fn, statics: copyClosureRefs(data.fn.statics) }
        : data.fn,
  };
}

const copyClosureRefs = (refs: Map<string, Ref>): Map<string, Ref> =>
  new Map(
    [...refs].map(([name, ref]) => {
      if (ref.isRef && ref.rc > 1) {
        ref.rc++;
        return [name, ref];
      }
      return [name, new Ref(share(ref.v))];
    })
  );

export function isObject(value: Value): value is PhpObject {
  return value instanceof PhpObject;
}
