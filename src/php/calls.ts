// code-gauge-allow-file fileNcss -- Keeps call binding, completion and frame cleanup together.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { LIMITS } from '../interpreter/limits';
import type { FunctionDecl, Stmt } from './ast';
import { lower, untilNul } from './bytes';
import { valueName } from './conversions';
import {
  type CleanupException,
  deprecated,
  isCleanupException,
  notice,
  throwError,
  withCleanupExceptions,
  withPendingException,
} from './errors';
import { hasStoredObject, recordPossibleRoot, releaseDropped } from './garbage';
import { decodeLiteral } from './literals';
import { share } from './places';
import {
  ExitSignal,
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
  deref,
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
  heldReference?: boolean;
  validatedCallback?: Value;
  nativeTransfer?: { values: unknown[]; count: number; container?: PhpArray };
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
  dynamic?: boolean;
  compiledCallback?: boolean;
  directOverload?: boolean;
  inline?: boolean;
  frameless?: boolean;
  /** Observes a validated return before its frame cleanup can throw. */
  captureReturn?: (value: Value) => void;
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

export type StatementCompletion =
  | undefined
  | { t: 'break' | 'continue'; depth: number }
  | { t: 'return'; slot: Value | Ref; row: number }
  | { t: 'goto'; label: string };

/** Runs a user function's body, which the interpreter provides. */
let runBody: (decl: FunctionDecl, frame: Frame) => Value = () => null;
let runStatementList: (statements: Stmt[]) => StatementCompletion = () => {};

export function setBodyRunner(
  run: (decl: FunctionDecl, frame: Frame) => Value,
  runList: (statements: Stmt[]) => StatementCompletion
): void {
  runBody = run;
  runStatementList = runList;
}

/** Makes the Generator object a call to a generator function returns, which the generators module provides. */
let createGenerator: (frame: Frame, record: CallRecord) => PhpObject = () => {
  throw new Error('Generators are not loaded');
};

export function setGeneratorFactory(create: (frame: Frame, record: CallRecord) => PhpObject): void {
  createGenerator = create;
}

/** Runs `run` in a generator's frame, which the call stack holds as a call made at `record.row`. */
export function runInFrame<T>(frame: Frame, record: CallRecord, run: () => T): T {
  const runtime = rt();
  if (runtime.depth >= LIMITS.maxCallDepth) throw new FatalError(MEMORY_EXHAUSTED, runtime.row, true);
  const outerNative = nativeDepth;
  const outerNativeCalls = runtime.nativeCalls;
  const outerReleaseMode = runtime.nativeReleaseMode;
  const savedRow = runtime.row;
  runtime.frames.push(frame);
  callStack.push(record);
  runtime.depth++;
  nativeDepth = 0;
  runtime.nativeCalls = 0;
  runtime.nativeReleaseMode = 'ordinary';
  try {
    return run();
  } finally {
    nativeDepth = outerNative;
    runtime.nativeCalls = outerNativeCalls;
    runtime.nativeReleaseMode = outerReleaseMode;
    runtime.depth--;
    callStack.pop();
    runtime.frames.pop();
    runtime.row = savedRow;
  }
}

/** Releases the locals of a generator's frame once the generator finishes or is destroyed. */
export function releaseGeneratorFrame(frame: Frame, failure?: unknown): void {
  const runtime = rt();
  for (const value of frame.argumentHolders) if (value instanceof Ref) value.rc--;
  for (const value of frame.temporaries) if (value instanceof Ref) value.rc--;
  releaseFrame(runtime, runtime.frame, frame, null, false, failure instanceof PhpThrow ? failure : undefined);
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
// code-gauge-allow functionCognitiveComplexity -- PHP combines separate class and function names differently for each diagnostic format.
export function functionDisplayName(target: CallTarget, parameter = false): string {
  const { fn, method, scope } = target;
  if (method) return parameter ? classMethodLabel(method.scope, method.name) : `${method.scope.name}::${method.name}`;
  if (fn.kind === 'user' && fn.decl.isPropertyHook)
    return scope && parameter ? classMethodLabel(scope, fn.name) : `${scope?.name ?? fn.decl.className}::${fn.name}`;
  if (fn.kind === 'user' && fn.decl.isClosure) {
    const name = fn.decl.name;
    return scope && parameter ? classMethodLabel(scope, name) : `${scope ? `${scope.name}::` : ''}${untilNul(name)}`;
  }
  return fn.name;
}

export function classMethodLabel(scope: PhpClass, method: string): string {
  return untilNul(`${scope.fullName}::${method}`);
}

function recordFor(target: CallTarget, args: Value[], row: number | undefined): CallRecord {
  const { fn, method, thisObj } = target;
  if (method) {
    return {
      name: method.name,
      className: method.scope.fullName,
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
      className: scope?.fullName,
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
  if (target.fn.kind === 'native') {
    if (target.fn.acceptsNamed === 'positional-only') checkNamedArgs([], args);
    return invokeNative(target, target.fn, args, callRow, discardResult);
  }
  return invokeUser(target, target.fn, args, callRow, discardResult);
}

interface NativeHolders {
  values: unknown[];
  references: Ref[];
  argumentCount: number;
}

interface NativeCallState {
  runtime: Runtime;
  caller: Frame;
  name: string;
  inline: boolean;
  forwardsReference: boolean;
  strict: boolean;
  record: CallRecord | undefined;
  held: NativeHolders;
  savedRow: number;
}

function isHostMemoryError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('invalid string length') ||
    lowerMessage.includes('invalid array length') ||
    lowerMessage.includes('out of memory') ||
    lowerMessage.includes('maximum call stack size exceeded')
  );
}

const nativeDeprecations = new WeakMap<NativeFunction, string>();

/** Records the deprecation PHP reports on calling a builtin, before it binds the arguments. */
export function deprecateNative(fn: NativeFunction, deprecation: string): void {
  nativeDeprecations.set(fn, deprecation);
}

export function invokeNative(
  target: CallTarget,
  fn: NativeFunction,
  args: ArgValue[],
  row: number | undefined,
  discardResult: boolean
): Value {
  const deprecation = nativeDeprecations.get(fn);
  if (deprecation) deprecated(deprecation);
  const saved = enterNativeCall(target, fn, args, row);
  let result: Value = null;
  let returnedReference: Ref | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = fn.impl(prepareNativeCall(saved, target, fn, args, row, discardResult));
    if (typeof result === 'string') saved.runtime.ensureStringFits(result.length);
    if (saved.forwardsReference && !discardResult) {
      returnedReference = saved.runtime.lastReturnRef;
      if (returnedReference) saved.runtime.holdTemporaryReference(returnedReference);
    }
    target.captureReturn?.(result);
  } catch (error) {
    failed = true;
    failure =
      error instanceof RangeError && isHostMemoryError(error.message) ? saved.runtime.memoryExhausted(2 ** 31) : error;
    throw failure;
  } finally {
    if (target.thisObj) nativeOwnershipChanged(target.thisObj);
    exitNativeCall(saved, target, result, failure, failed);
  }
  saved.runtime.lastReturnRef = returnedReference;
  return result;
}

// code-gauge-allow functionCognitiveComplexity -- Builds the native call record and argument holders in one pass.
function enterNativeCall(
  target: CallTarget,
  fn: NativeFunction,
  args: ArgValue[],
  row: number | undefined
): NativeCallState {
  const runtime = rt();
  runtime.spend();
  const caller = runtime.frame;
  const name = functionDisplayName(target);
  const inline = Boolean(target.inline && row !== undefined);
  const forwardsReference = fn.forwardsReference === true || (inline && fn.forwardsReference === 'inlined');
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
    record = recordFor(target, dense, row ?? implicitCallRow());
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
  return { runtime, caller, name, inline, forwardsReference, strict, record, held, savedRow: runtime.row };
}

// code-gauge-allow functionCognitiveComplexity -- Binds native arguments, by-ref defaults, and reference holders before dispatch.
function prepareNativeCall(
  saved: NativeCallState,
  target: CallTarget,
  fn: NativeFunction,
  args: ArgValue[],
  row: number | undefined,
  discardResult: boolean
): NativeContext {
  const { values, refs, named } = bindNative(
    fn,
    args,
    saved.name,
    saved.strict,
    Boolean(saved.inline || target.directOverload),
    saved.record
  );
  if (target.dynamic && fn.directOnly) throwError('Error', `Cannot call ${fn.name}() dynamically`);
  for (let index = 0; index < values.length; index++) {
    if (values[index] === undefined && fn.params[index]?.byRef)
      refs[index] = Ref.temporary(nativeDefault(fn.params[index].nativeDefault));
  }
  if (saved.record) saved.record.argumentRefs = refs;
  for (const ref of refs) {
    if (!ref || saved.held.references.includes(ref)) continue;
    ref.rc++;
    saved.held.references.push(ref);
    saved.held.values.splice(saved.held.argumentCount++, 0, ref);
  }
  if (saved.forwardsReference) saved.runtime.lastReturnRef = undefined;
  return {
    name: fn.name,
    args: values,
    refs,
    thisObj: target.thisObj,
    calledClass: target.staticClass,
    named,
    directOverload: target.directOverload,
    compiledCallback: target.compiledCallback,
    dynamic: target.dynamic,
    row: saved.inline || target.frameless ? row : undefined,
    discardResult: Boolean(saved.inline && discardResult),
  };
}

function exitNativeCall(
  saved: NativeCallState,
  target: CallTarget,
  result: Value,
  failure: unknown,
  failed: boolean
): void {
  const { runtime, caller, inline, held, savedRow } = saved;
  if (!inline) {
    nativeDepth--;
    callStack.pop();
  }
  runtime.nativeCalls--;
  runtime.nativeHeld.pop();
  const released = calleeRoot(runtime, target.closure, target.thisObj);
  if (released) runtime.pendingGcRoots.add(released);
  runtime.row = savedRow;
  if (!failed || failure instanceof PhpThrow || failure instanceof ExitSignal) {
    if (result instanceof PhpObject || result instanceof PhpArray) caller.temporaries.push(result);
    releaseNativeValues(runtime, held, failure instanceof PhpThrow ? failure : undefined);
  } else {
    for (const ref of held.references) ref.releaseWithoutGc();
  }
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
    if (!failed || failure instanceof PhpThrow || failure instanceof ExitSignal)
      releaseCallValues(runtime, args, failure instanceof PhpThrow ? failure : undefined);
  }
}

/** Matches arguments to a native function's parameters, coercing them to the declared types. */
// code-gauge-allow functionNcss -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
    if (
      record &&
      index < record.args.length &&
      (typeof value === 'string' ||
        (record.args[index] === null && value !== undefined && params[index]?.type?.k === 'union'))
    )
      record.args[index] = value;
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
  const refusesNamed = named !== undefined && fn.name !== 'call_user_func' && fn.acceptsNamed !== true;
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
      append(arg.validatedCallback ?? coerceArg(param, index, arg.v, strict, name));
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

export function validateNativeCallback(fn: NativeFunction, arg: ArgValue): void {
  arg.validatedCallback = coerceArg(fn.params[0], 0, arg.v, callerIsStrict(), fn.name);
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

function nativeTypeText(type: TypeDecl): string {
  if (type.k !== 'union') return typeToString(type);
  const text = type.types.map((part) => typeToString(part)).join('|');
  // Z_PARAM_ARRAY_HT_OR_STR and Z_PARAM_ARRAY_OR_OBJECT use parser labels that can differ from the stubs.
  if (text === 'string|array') return 'array|string';
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

interface UserCallState {
  runtime: Runtime;
  caller: Frame;
  frame: Frame;
  decl: UserFunction['decl'];
  target: CallTarget;
  received: UserArgumentSlots;
  record: CallRecord;
  strict: boolean;
  savedRow: number;
  outerNative: number;
  outerNativeCalls: number;
  outerReleaseMode: Runtime['nativeReleaseMode'];
  bound: boolean;
  /** The Generator a call to a generator function returns, which keeps the frame instead of releasing it. */
  generator?: PhpObject;
}

// code-gauge-allow functionCognitiveComplexity -- Dispatches ordinary user function bodies directly to execList to avoid an extra host frame.
// code-gauge-allow functionNcss -- Handles direct body execution and RangeError host-stack translation in one frame.
export function invokeUser(
  target: CallTarget,
  fn: UserFunction,
  args: ArgValue[],
  row: number | undefined,
  discardResult: boolean
): Value {
  const saved = enterUserCall(target, fn, args, row);
  let returned: Value = null;
  let failure: unknown;
  let failed = false;
  try {
    bindUserCall(saved, fn, args, row);
    saved.bound = true;
    if (saved.decl.isGenerator) {
      saved.generator = createGenerator(saved.frame, saved.record);
      saved.runtime.lastReturnRef = undefined;
      returned = discardResult ? null : saved.generator;
      return returned;
    }
    let bodyResult: Value;
    if (!saved.decl.arrowBody && !saved.frame.thisObj) {
      const completion = runStatementList(saved.decl.body);
      if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
      saved.frame.returning = completion?.t === 'return' ? completion.slot : undefined;
      saved.frame.returnRow = completion?.t === 'return' ? completion.row : undefined;
      bodyResult = saved.frame.returning instanceof Ref ? saved.frame.returning.v : (saved.frame.returning ?? null);
    } else {
      bodyResult = runBody(saved.decl, saved.frame);
    }
    returned = finishUserReturn(saved, bodyResult, discardResult);
  } catch (error) {
    if (error instanceof RangeError && saved.bound) {
      saved.runtime.exhausted = true;
      hostStackExhaustion.record ??= callStack.at(-1);
      hostStackExhaustion.row ??= saved.runtime.row;
      failure = hostStackExhaustion;
      failed = true;
      throw hostStackExhaustion;
    }
    failure = error;
    failed = true;
    throw error;
  } finally {
    exitUserCall(saved, returned, failure, failed);
  }
  saved.runtime.lastReturnRef =
    !discardResult && saved.frame.returning instanceof Ref ? saved.frame.returning : undefined;
  return returned;
}

function enterUserCall(target: CallTarget, fn: UserFunction, args: ArgValue[], row: number | undefined): UserCallState {
  const runtime = rt();
  const { decl } = fn;
  if (runtime.depth >= LIMITS.maxCallDepth) {
    throw new FatalError(MEMORY_EXHAUSTED, runtime.row, true);
  }
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
  const strict = runtime.strictTypes && nativeDepth === 0;
  checkNamedArgs(fn.params, args);
  const received = userArgumentSlots(fn.params, args);
  const record = recordForUserCall(target, received, row);
  frame.args = args.map((arg) => arg.ref?.v ?? arg.v);
  frame.argumentHolders = [...frame.args];
  const saved = {
    runtime,
    caller: runtime.frame,
    frame,
    decl,
    target,
    received,
    record,
    strict,
    savedRow: runtime.row,
    outerNative: nativeDepth,
    outerNativeCalls: runtime.nativeCalls,
    outerReleaseMode: runtime.nativeReleaseMode,
    bound: false,
  };
  runtime.frames.push(frame);
  callStack.push(record);
  runtime.depth++;
  nativeDepth = 0;
  runtime.nativeCalls = 0;
  runtime.nativeReleaseMode = 'ordinary';
  return saved;
}

function bindUserCall(saved: UserCallState, fn: UserFunction, args: ArgValue[], row: number | undefined): void {
  const { runtime, caller, frame, decl, target, received, record, strict } = saved;
  runtime.row = decl.row;
  handOverArgs(caller, args, frame);
  const closure = target.closure?.internal as ClosureData | undefined;
  if (closure) bindClosureVars(frame, closure);
  bindParams(
    frame,
    fn,
    args,
    received,
    { name: functionDisplayName(target), parameter: functionDisplayName(target, true) },
    strict,
    row
  );
  bindArgumentHolders(frame, fn.params, record, args);
  runtime.dropTemporaries(frame, 0);
  record.boundFrame = frame;
}

function finishUserReturn(saved: UserCallState, bodyResult: Value, discardResult: boolean): Value {
  const { runtime, decl, frame, target } = saved;
  const result = completeUserReturn(decl, frame, bodyResult, target);
  if (discardResult) {
    const returning = frame.returning;
    frame.returning = undefined;
    runtime.row = frame.returnRow ?? runtime.row;
    runtime.release([returning, result]);
    return null;
  }
  target.captureReturn?.(result);
  return result;
}

function exitUserCall(saved: UserCallState, returned: Value, failure: unknown, failed: boolean): void {
  const { runtime, caller, frame, decl, savedRow, outerNative, outerNativeCalls, outerReleaseMode } = saved;
  nativeDepth = outerNative;
  runtime.nativeCalls = outerNativeCalls;
  runtime.nativeReleaseMode = outerReleaseMode;
  runtime.depth--;
  callStack.pop();
  runtime.frames.pop();
  if (saved.generator) {
    exitGeneratorCall(saved, saved.generator, returned);
    return;
  }
  for (const value of frame.argumentHolders) if (value instanceof Ref) value.rc--;
  for (const value of frame.temporaries) if (value instanceof Ref) value.rc--;
  runtime.row = savedRow;
  if (decl.isAtomic) runtime.steps.completeAtomicCall();
  if (!failed || failure instanceof PhpThrow || failure instanceof ExitSignal)
    releaseFrame(runtime, caller, frame, returned, outerNative > 0, failure instanceof PhpThrow ? failure : undefined);
  else for (const ref of frame.vars.values()) ref.rc--;
}

/** Hands the Generator a generator function's call returns to its caller, keeping the call's frame for it. */
function exitGeneratorCall(saved: UserCallState, generator: PhpObject, returned: Value): void {
  const { runtime, caller, decl, savedRow, outerNative } = saved;
  runtime.row = savedRow;
  if (decl.isAtomic) runtime.steps.completeAtomicCall();
  if (returned === null) runtime.release([generator]);
  else ((outerNative > 0 ? runtime.nativeHeld.at(-1) : undefined) ?? caller.temporaries).push(generator);
}

interface UserArgumentSlots {
  fixed: (ArgValue | undefined)[];
  extraNamed: { name: string; argument: ArgValue }[];
}

function userArgumentSlots(params: Param[], args: ArgValue[]): UserArgumentSlots {
  const fixed = positionalArguments(args);
  const extraNamed: UserArgumentSlots['extraNamed'] = [];
  for (const arg of args) {
    if (arg.name === undefined) continue;
    const index = params.findIndex((param) => !param.variadic && param.name === arg.name);
    if (index !== -1) fixed[index] = arg;
    else extraNamed.push({ name: arg.name, argument: arg });
  }
  return { fixed, extraNamed };
}

function recordForUserCall(target: CallTarget, received: UserArgumentSlots, row: number | undefined): CallRecord {
  const record = recordFor(
    target,
    Array.from(received.fixed, (arg) => arg?.ref?.v ?? arg?.v ?? null),
    row ?? implicitCallRow()
  );
  if (received.extraNamed.length > 0)
    record.named = received.extraNamed.map(({ name, argument }) => [name, argument.ref?.v ?? argument.v]);
  return record;
}

function completeUserReturn(decl: FunctionDecl, frame: Frame, value: Value, target: CallTarget): Value {
  const runtime = rt();
  runtime.row = frame.returnRow ?? decl.endRow;
  if (decl.returnType?.k === 'named' && decl.returnType.name === 'never') {
    const subject = frame.scope ? 'method' : 'function';
    throwError(
      'TypeError',
      `${functionDisplayName(target, true)}(): never-returning ${subject} must not implicitly return`
    );
  }
  const result = decl.returnType ? checkReturn(decl.returnType, functionDisplayName(target), frame) : value;
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

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
  const holders = (fromNative ? runtime.nativeHeld.at(-1) : undefined) ?? caller.temporaries;
  try {
    if (!isComposite(returned)) {
      releaseFrameValues(runtime, frame, fromNative, pending);
      return;
    }
    holders.push(returned);
    // PHP's return of a variable moves its value out and buffers it as a possible root before freeing the other locals.
    if (frame.returnedLocal?.v === returned) recordPossibleRoot(runtime, returned);
    try {
      releaseFrameValues(runtime, frame, fromNative, pending);
    } catch (error) {
      throw releaseFailedCallResult(runtime, holders, returned, error);
    }
  } finally {
    releaseCallee(runtime, frame);
  }
}

/**
 * Buffers `$this` or the called closure as a possible root after the locals, as PHP's leave helper releases the call's
 * reference to them after freeing the locals.
 */
function releaseCallee(runtime: Runtime, frame: Frame): void {
  const released = calleeRoot(runtime, frame.closure, frame.thisObj);
  if (!released) return;
  runtime.pendingGcRoots.add(released);
  releaseDropped(runtime, [], true);
}

/**
 * The object whose release a call's exit buffers as a possible root: a closure call, bound or a first-class callable,
 * holds its own reference to the closure, which is buffered while a variable still holds it and it is not buffered
 * yet; only other calls hold `$this`.
 */
function calleeRoot(
  runtime: Runtime,
  closure: PhpObject | undefined,
  thisObj: PhpObject | undefined
): PhpObject | undefined {
  if (!closure) return thisObj;
  return runtime.gcRoots.has(closure) || !hasStoredObject(runtime, closure) ? undefined : closure;
}

/** Frees a call's result when its frame cleanup throws, as PHP frees the call's result before choosing a handler. */
function releaseFailedCallResult(
  runtime: Runtime,
  holders: unknown[],
  returned: PhpObject | PhpArray,
  error: unknown
): unknown {
  if (!isCleanupException(error) || holders.at(-1) !== returned) return error;
  holders.pop();
  try {
    if (error instanceof PhpThrow) withPendingException(runtime, error, () => runtime.release([returned]));
    else runtime.release([returned]);
  } catch (releaseError) {
    return releaseError;
  }
  return error;
}

function releaseFrameValues(runtime: Runtime, frame: Frame, fromNative: boolean, pending?: PhpThrow): void {
  for (const ref of frame.vars.values()) if (!ref.isDefinedBinding) ref.rc--;
  const locals = Array.from(runtime.variableBindings(frame), ([, ref]) => ref);
  const tail = [...frame.argumentHolders, ...frame.temporaries, frame.returning, frame.thisObj, frame.closure];
  if (locals.length === 0) {
    releaseCallValues(runtime, tail, pending, fromNative);
    return;
  }
  const heldTail = tail.map((value) => (value instanceof Ref ? value.v : value)).filter(isComposite);
  withPendingException(runtime, pending, () => releaseFrameLocals(runtime, locals, heldTail, tail, fromNative));
}

function releaseFrameLocals(
  runtime: Runtime,
  locals: readonly Ref[],
  heldTail: readonly (PhpObject | PhpArray)[],
  tail: unknown[],
  fromNative: boolean
): void {
  const base = runtime.held.length;
  runtime.held.push(...heldTail, ...locals);
  let released = 0;
  try {
    withCleanupExceptions(runtime, (capture) => {
      for (const [index, ref] of locals.entries()) {
        runtime.held[base + heldTail.length + index] = null;
        ref.rc--;
        released = index + 1;
        if (isComposite(ref.v)) releaseFrameStep(runtime, [ref.v], fromNative, capture);
      }
      for (let index = 0; index < heldTail.length; index++) runtime.held[base + index] = null;
      releaseFrameStep(runtime, tail, fromNative, capture);
    });
  } finally {
    for (let index = released; index < locals.length; index++) locals[index].rc--;
    runtime.held.length = base;
  }
}

function isComposite(value: unknown): value is PhpObject | PhpArray {
  return value instanceof PhpObject || value instanceof PhpArray;
}

function releaseFrameStep(
  runtime: Runtime,
  values: unknown[],
  fromNative: boolean,
  capture: (error: CleanupException) => void
): void {
  try {
    runtime.release(values, false, fromNative);
  } catch (error) {
    if (!isCleanupException(error)) throw error;
    capture(error);
  }
}

function releaseCallValues(runtime: Runtime, values: unknown[], pending?: PhpThrow, fromNative = false): void {
  withPendingException(runtime, pending, () => runtime.release(values, false, fromNative));
}

/**
 * Takes the arguments of a user function call off the caller's temporaries once the callee's parameters hold them, as
 * PHP moves a temporary argument into the callee's frame, which frees it with the callee's other variables.
 */
export function handOverArgs(caller: Frame, args: ArgValue[], callee?: Frame): void {
  for (const arg of args) {
    if (arg.heldReference && arg.ref) transferArgumentReference(caller, arg.ref, callee);
    if (arg.nativeTransfer) transferNativeArgument(arg.nativeTransfer, arg.v);

    for (let count = arg.temporaryCount ?? 0; count > 0; count--) {
      const index = caller.temporaries.lastIndexOf(arg.v);
      if (index === -1) break;
      caller.temporaries.splice(index, 1);
    }
  }
}

function transferNativeArgument(transfer: NonNullable<ArgValue['nativeTransfer']>, fallback: Value): void {
  const { values, count, container } = transfer;
  for (let index = count - 1; index >= 0; index--) {
    if (values[index] !== (container ?? fallback)) continue;
    values[index] = undefined;
    if (container) rt().release([container]);
    return;
  }
}

function transferArgumentReference(caller: Frame, reference: Ref, callee: Frame | undefined): void {
  const index = caller.temporaries.lastIndexOf(reference);
  if (index === -1) return;
  caller.temporaries.splice(index, 1);
  if (callee) callee.temporaries.push(reference);
  // PHP frees an internal function's arguments with zval_ptr_dtor_nogc, which buffers no possible root.
  else reference.releaseWithoutGc();
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
export function implicitCallRow(): number | undefined {
  const runtime = rt();
  return nativeDepth === 0 && !runtime.shuttingDown ? runtime.instructionRow : undefined;
}

function positionalArguments(args: ArgValue[]): ArgValue[] {
  const result: ArgValue[] = [];
  for (const arg of args) if (arg.name === undefined) result[arg.position ?? result.length] = arg;
  return result;
}

export function checkNamedArgs(params: Param[], args: ArgValue[]): Map<string, Value> | undefined {
  if (!args.some((arg) => arg.name !== undefined)) return undefined;
  const binding = new NamedArgumentBindings(params);
  for (const arg of args) binding.add(arg);
  return binding.extra;
}

export class NamedArgumentBindings {
  private readonly names = new Set<string>();
  private readonly positions = new Set<number>();
  private nextPosition = 0;
  extra?: Map<string, Value>;

  constructor(
    private readonly params: Param[],
    private readonly allowUnknown = false
  ) {}

  add(arg: ArgValue): number | undefined {
    if (arg.name === undefined) {
      if (arg.position === undefined && this.names.size > 0)
        throwError('Error', 'Cannot use positional argument after named argument');
      const position = arg.position ?? this.nextPosition;
      this.positions.add(position);
      this.nextPosition = position + 1;
      return undefined;
    }
    const index = this.params.findIndex((param) => param.name === arg.name && !param.variadic);
    if (this.names.has(arg.name) || (index !== -1 && this.positions.has(index)))
      throwError('Error', `Named parameter $${arg.name} overwrites previous argument`);
    this.names.add(arg.name);
    if (index !== -1) return index;
    if (!this.allowUnknown && !this.params.at(-1)?.variadic)
      throwError('Error', `Unknown named parameter $${arg.name}`);
    (this.extra ??= new Map()).set(arg.name, arg.v);
  }
}

/** Evaluates a parameter's default value, which the interpreter provides. */
let evaluateDefault: (decl: FunctionDecl, index: number, frame: Frame) => Value = () => null;

export function setDefaultEvaluator(run: (decl: FunctionDecl, index: number, frame: Frame) => Value): void {
  evaluateDefault = run;
}

// code-gauge-allow functionNcss -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
// code-gauge-allow functionParameterCount -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
function bindParams(
  frame: Frame,
  fn: UserFunction,
  args: ArgValue[],
  received: UserArgumentSlots,
  labels: { name: string; parameter: string },
  strict: boolean,
  callRow: number | undefined
): void {
  const params = fn.params;
  const record = callStack.at(-1)!;
  const gaps = fillUserArgumentGaps(frame, fn, received.fixed, record, labels.name);
  let holderIndices: Map<ArgValue, number> | undefined;
  const bindSupplied = (
    arg: ArgValue,
    param: Param,
    index: number,
    assign: (slot: Value | Ref) => void,
    namedSlot?: [string, Value]
  ): void => {
    const ref = param.byRef ? bindRef(arg) : undefined;
    if (ref) assign(ref);
    const original = ref ? ref.v : share(arg.v);
    const value = checkParam(original, param, index, labels.parameter, strict, frame, callRow, ref);
    if (namedSlot) namedSlot[1] = value;
    else record.args[index] = value;
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
    rt().row = fn.decl.params[index].row;
    if (param.variadic) {
      const rest = new PhpArray();
      frame.vars.set(param.name, new Ref(rest));
      for (let at = index; at < received.fixed.length; at++) {
        const arg = received.fixed[at];
        if (!arg || arg.omitted) throwError('ArgumentCountError', `${labels.name}(): Argument #${at + 1} not passed`);
        bindSupplied(arg, param, at, (slot) => rest.append(slot));
      }
      for (const [at, { name, argument }] of received.extraNamed.entries()) {
        bindSupplied(argument, param, index, (slot) => rest.setSlot(name, slot), record.named![at]);
      }
      break;
    }
    const arg = received.fixed[index];
    if (arg === undefined || arg.omitted) {
      if (!param.optional) {
        const passed = record.args.length;
        const hasOptional = params.some((other) => other.optional && !other.variadic);
        const where = callRow === undefined ? '' : ` in ${SCRIPT_PATH} on line ${callRow + 1}`;
        const expectation = hasOptional ? 'at least' : 'exactly';
        throwError(
          'ArgumentCountError',
          `Too few arguments to function ${labels.name}(), ${passed} passed${where} and ${expectation} ${required} expected`
        );
      }
      const declared = fn.decl.params[index];
      const gap = gaps?.get(index);
      const value = gap === undefined ? evaluateDefault(fn.decl, index, frame) : gap;
      rt().row = declared.defaultReportRow ?? declared.row;
      const checked = checkParam(value, param, index, labels.parameter, rt().strictTypes, frame, callRow);
      if (gap !== undefined) record.args[index] = checked;
      frame.vars.set(param.name, new Ref(checked));
      continue;
    }
    bindSupplied(arg, param, index, (slot) => frame.vars.set(param.name, slot instanceof Ref ? slot : new Ref(slot)));
  }
}

function fillUserArgumentGaps(
  frame: Frame,
  fn: UserFunction,
  fixed: UserArgumentSlots['fixed'],
  record: CallRecord,
  name: string
): Map<number, Value> | undefined {
  let defaults: Map<number, Value> | undefined;
  for (let index = 0; index < Math.min(fixed.length, fn.params.length); index++) {
    const param = fn.params[index];
    if (param.variadic) break;
    const arg = fixed[index];
    if (arg && !arg.omitted) continue;
    const declared = fn.decl.params[index];
    rt().row = declared.defaultReportRow ?? declared.row;
    if (!param.optional)
      throwError('ArgumentCountError', `${name}(): Argument #${index + 1} ($${param.name}) not passed`);
    const value = evaluateDefault(fn.decl, index, frame);
    (defaults ??= new Map<number, Value>()).set(index, value);
    record.args[index] = value;
  }
  return defaults;
}

function bindRef(arg: ArgValue): Ref {
  const ref = arg.ref ?? Ref.temporary(arg.v);
  ref.isRef = true;
  ref.rc++;
  return ref;
}

// code-gauge-allow functionParameterCount -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
function checkParam(
  value: Value,
  param: Param,
  index: number,
  name: string,
  strict: boolean,
  frame: Frame,
  callRow: number | undefined,
  reference?: Ref
): Value {
  const type = parameterType(param);
  if (!type) return value;
  const context = { scope: frame.scope, staticClass: frame.staticClass };
  const coerced = reference?.typeOwners().length
    ? matches(value, type, context)
      ? value
      : NO_MATCH
    : coerce(value, type, { ...context, strict, internal: false });
  if (coerced !== NO_MATCH) return coerced;
  const where = callRow === undefined ? '' : `, called in ${SCRIPT_PATH} on line ${callRow + 1}`;
  const typeText = describeType(type, frame.scope);
  const label = param.variadic ? '' : ` ($${param.name})`;
  throwError(
    'TypeError',
    `${name}(): Argument #${index + 1}${label} must be of type ${typeText}, ${valueName(value)} given${where}`
  );
}

function checkReturn(type: TypeDecl, name: string, frame: Frame): Value {
  if (type.k === 'named' && type.name === 'void') return null;
  const slot = frame.returning;
  if (slot === undefined) return throwReturnTypeError(undefined, type, name, frame);
  const value = deref(slot);
  if (
    slot instanceof Ref &&
    slot.typeOwners().length > 0 &&
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

function throwReturnTypeError(value: Value | undefined, type: TypeDecl, name: string, frame: Frame): never {
  const display = describeType(type, frame.scope, frame.staticClass);
  const returned = value === undefined ? 'none' : valueName(value);
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

// code-gauge-allow functionCognitiveComplexity -- Binds arguments to parameters as PHP's call protocol does, in its order of checks.
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
  const nullable = text.startsWith('?');
  const name = nullable ? text.slice(1) : text;
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
  const normalized = lower(name);
  return { k: 'named', name: builtin.includes(normalized) ? normalized : name, nullable: nullable || undefined };
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
      const copy = new Ref(share(ref.v));
      copy.isRef = ref.isRef;
      return [name, copy];
    })
  );

export function isObject(value: Value): value is PhpObject {
  return value instanceof PhpObject;
}
