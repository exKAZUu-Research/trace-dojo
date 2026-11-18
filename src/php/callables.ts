// code-gauge-allow-file fileNcss 661 -- Keeps one PHP runtime concern and its shared helpers in one module.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { placeOf } from './assignment';
import type { Arg, Expr, ResolvedName } from './ast';
import { hasNullsafeReceiver } from './astAnalysis';
import { oneArgumentBuiltinOpcodes, simpleSprintfFormat } from './builtinCompiler';
import builtinNames from './builtinNames.json';
import { lower } from './bytes';
import {
  type ArgValue,
  type CallTarget,
  checkNamedArgs,
  classMethodLabel,
  closureFunction,
  functionDisplayName,
  handOverArgs,
  invoke,
  type MagicCall,
  NamedArgumentBindings,
  paramIsByRef,
} from './calls';
import { canCall, classScopeMessage, lookupMethod, requireClass } from './classes';
import { debugType, valueName } from './conversions';
import { deprecated, notice, probe, ProbeFailure, throwError, warn, withPendingException } from './errors';
import {
  type Chain,
  ev,
  evChain,
  isCompiledVariable,
  iterate,
  prepareOperand,
  resolveStaticClass,
  SHORT,
} from './interp';
import { ElementPlace, share, VarPlace, writableContainer } from './places';
import { type Frame, PhpThrow, rt } from './runtime';
import { renderSimpleSprintf } from './sprintf';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Callable,
  type ClosureData,
  isClosure,
  type Method,
  type NativeFunction,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  type UserFunction,
  type Value,
} from './values';

// Calls --------------------------------------------------------------------------------------------------------------

/** Evaluates call arguments, binding by-reference parameters to locations. */
export function evalArgs(
  args: Arg[],
  fn: Callable | undefined,
  name: string | undefined,
  allowUnresolvedNames = true
): ArgValue[] {
  const runtime = rt();
  const values: ArgValue[] = [];
  const named = args.some((arg) => arg.name !== undefined || arg.spread)
    ? new NamedArgumentBindings(fn?.params ?? [], fn === undefined && allowUnresolvedNames)
    : undefined;
  let positional = 0;
  const add = (value: ArgValue): void => {
    if (value.name === undefined) value.position = positional++;
    const index = named?.add(value);
    if (index !== undefined) positional = Math.max(positional, index + 1);
    if (value.ref) {
      value.ref.isRef = true;
      runtime.holdTemporaryReference(value.ref);
      value.heldReference = true;
    }
    values.push(value);
  };
  const frame = runtime.frame;
  for (const arg of args) {
    const mark = frame.temporaries.length;
    const first = values.length;
    try {
      if (arg.spread) {
        const source =
          fn?.params.some((param) => param.byRef) && arg.e.k === 'var' && arg.e.name !== 'GLOBALS'
            ? placeOf(arg.e)
            : undefined;
        let value = source ? source.get() : ev(arg.e);
        if (value instanceof PhpArray) frame.temporaries.push(value);
        if (value instanceof PhpArray && source) value = writableContainer(source);
        else if (value instanceof PhpArray && fn?.params.some((param) => param.byRef)) {
          value = value.copy();
          frame.temporaries.push(value);
        }
        let named = false;
        const unpackName = (key: Value): string | undefined => {
          if (typeof key === 'string') {
            named = true;
            return key;
          }
          if (typeof key !== 'bigint') throwError('Error', 'Keys must be of type int|string during argument unpacking');
          if (named) throwError('Error', 'Cannot use positional argument after named argument during unpacking');
          return undefined;
        };
        if (value instanceof PhpArray) {
          for (const [key, item] of value.entries()) {
            const argumentName = unpackName(key);
            const position = argumentName === undefined ? positional : -1;
            if (fn && paramIsByRef(fn, position, argumentName)) {
              const ref = new ElementPlace(value, key).ref();
              add({ v: ref.v, ref, name: argumentName });
            } else add({ v: share(item), name: argumentName });
          }
        } else if (
          value instanceof PhpObject &&
          value.cls.isSubclassOf(runtime.classes.get('traversable') as PhpClass)
        ) {
          for (const [key, item] of iterate(value)) {
            const argumentName = unpackName(key);
            const position = argumentName === undefined ? positional : -1;
            if (fn && paramIsByRef(fn, position, argumentName)) {
              const namedIndex = fn.params.findIndex((param) => param.name === argumentName);
              const parameter = position === -1 ? namedIndex : position;
              const number = parameter >= 0 ? parameter + 1 : fn.params.length;
              warn(
                `Cannot pass by-reference argument ${number} of ${name ?? fn.name}() by unpacking a Traversable, passing by-value instead`
              );
            }
            add({ v: share(item), name: argumentName });
          }
        } else
          throwError('TypeError', `Only arrays and Traversables can be unpacked, ${valueName(value ?? null)} given`);
        keepUnpackedArguments(frame, values.slice(first), mark);
        continue;
      }
      const position = arg.name === undefined ? positional : -1;
      const byRef = fn ? paramIsByRef(fn, position, arg.name) : false;
      if (byRef) {
        const e = arg.e;
        if (
          (['varvar', 'idx', 'prop', 'sprop'].includes(e.k) || (e.k === 'var' && e.name !== 'GLOBALS')) &&
          !hasNullsafeReceiver(e)
        ) {
          const ref = placeOf(e, 'write', true).ref();
          add({ v: ref.v, ref, name: arg.name });
          continue;
        }
        runtime.lastReturnRef = undefined;
        const value = ev(e);
        const returned = runtime.lastReturnRef as Ref | undefined;
        runtime.lastReturnRef = undefined;
        if (returned && (e.k === 'call' || e.k === 'mcall' || e.k === 'scall')) {
          add({ v: returned.v, ref: returned, name: arg.name });
          continue;
        }
        const paramIndex = referenceParameterIndex(fn?.params, position, arg.name);
        const param = fn?.params[Math.min(paramIndex, fn.params.length - 1)];
        if (param?.preferRef) {
          add({ v: value, name: arg.name });
          continue;
        }
        if (permitsTemporaryReference(e)) {
          notice('Only variables should be passed by reference');
          add({ v: value, ref: Ref.temporary(value), name: arg.name });
          continue;
        }
        const label = name ?? fn?.name ?? '';
        const paramLabel = param?.variadic ? '' : ` ($${param?.name ?? ''})`;
        throwError('Error', `${label}(): Argument #${paramIndex + 1}${paramLabel} could not be passed by reference`);
      }
      const value = share(ev(arg.e));
      frame.temporaries.push(value);
      add({ v: value, name: arg.name });
    } finally {
      claimArgumentTemporaries(frame, values, first, mark);
    }
  }
  return values;
}

function referenceParameterIndex(params: Callable['params'] | undefined, position: number, name?: string): number {
  if (name === undefined || !params) return position;
  const index = params.findIndex((param) => !param.variadic && param.name === name);
  return index === -1 ? params.length - 1 : index;
}

function permitsTemporaryReference(e: Expr): boolean {
  if (e.k === 'mcall' || e.k === 'scall') return !e.fcc;
  if (e.k !== 'call') return e.k === 'new' || e.k === 'newAnon';
  if (e.fcc) return false;
  if ('k' in e.fn || e.fn.fallback) return true;
  const fn = rt().functions.get(lower(e.fn.name));
  return fn?.kind !== 'native' || !compiledTemporaryResult(fn, e.args);
}

function compiledTemporaryResult(fn: NativeFunction, args: Arg[]): boolean {
  const name = lower(fn.name);
  if (name === 'call_user_func' || name === 'call_user_func_array') return false;
  if (specializedCall(fn, args)) return true;
  if (name === 'sprintf') return simpleSprintfFormat(args) !== undefined;
  if (args.length !== 1 || args[0].spread || args[0].name !== undefined) return false;
  if (oneArgumentBuiltinOpcodes.has(name)) return true;
  const literal = args[0].e;
  if (literal.k !== 'lit') return false;
  const value = literal.v;
  if (name === 'chr') return typeof value === 'bigint' && value >= 0n && value <= 255n;
  if (name === 'ord') return typeof value === 'string' && value.length === 1;
  return name === 'defined' && (typeof value !== 'string' || !/[\\:]/.test(value));
}

function keepUnpackedArguments(frame: Frame, args: ArgValue[], mark: number): void {
  const end = frame.temporaries.length;
  for (const { v, ref } of args) {
    if (ref) rt().holdTemporaryReference(ref);
    else if (v instanceof PhpObject || v instanceof PhpArray) frame.temporaries.push(v);
  }
  const source = frame.temporaries.splice(mark, end - mark);
  for (const value of source) if (value instanceof Ref) value.rc--;
  rt().release(source);
}

function claimArgumentTemporaries(frame: Frame, args: ArgValue[], first: number, mark: number): void {
  const available = new Map<Value, number>();
  for (const value of frame.temporaries.slice(mark)) {
    if (value instanceof PhpObject || value instanceof PhpArray) available.set(value, (available.get(value) ?? 0) + 1);
  }
  for (const arg of args.slice(first)) {
    arg.temporaryCount = available.get(arg.v) ?? 0;
    available.delete(arg.v);
  }
}

export function callExpression(e: Extract<Expr, { k: 'call' }>, discardResult = false): Value {
  const runtime = rt();
  runtime.row = e.row;
  if (!('k' in e.fn)) return callNamedExpression(e, e.fn, discardResult);
  const callee = ev(e.fn);
  if (callee instanceof PhpObject || callee instanceof PhpArray) runtime.frame.temporaries.push(callee);
  runtime.row = e.initRow ?? e.row;
  const target = callTargetOf(callee, 'direct');
  if (e.fcc) return closureFromCallable(target);
  if (e.fn.k === 'lit' && typeof callee === 'string') target.dynamic = false;
  const args = evalArgs(e.args, target.magic ? undefined : target.fn, functionDisplayName(target, true));
  runtime.row = e.row;
  const result = target.magic
    ? invokeMagic(target.magic, args, e.row, discardResult)
    : invoke(target, args, e.row, discardResult);
  runtime.frame.temporaries.push(result);
  return result;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Resolves the named call before selecting how PHP evaluates its arguments.
function callNamedExpression(e: Extract<Expr, { k: 'call' }>, name: ResolvedName, discardResult: boolean): Value {
  const runtime = rt();
  const fn =
    runtime.functions.get(lower(name.name)) ??
    (name.fallback ? runtime.functions.get(lower(name.fallback)) : undefined);
  if (!fn) {
    if (builtinNames.functions.includes(lower(name.fallback ?? name.name)))
      throw new UnsupportedFeatureError(`PHP の組み込み関数（${name.fallback ?? name.name}）`);
    throwError('Error', `Call to undefined function ${name.name}()`);
  }
  if (e.fcc) return closureFromCallable({ fn });
  const format =
    fn.kind === 'native' && !name.fallback && lower(fn.name) === 'sprintf' ? simpleSprintfFormat(e.args) : undefined;
  if (format !== undefined) {
    const reads = e.args.slice(1).map((arg) => prepareOperand(arg.e));
    return renderSimpleSprintf(format, reads, e.row);
  }
  const specialized = name.fallback ? undefined : specializedCall(fn, e.args);
  const frameless = specialized === 'frameless';
  const directOverload = frameless && fn.kind === 'native' && fn.shortParamsDirectOnly;
  const inline = specialized === 'opcode' || (frameless && fn.name === 'strtr');
  const row = inline && fn.name === 'strlen' ? e.args[0].e.row : e.row;
  const args =
    specialized && fn.name !== 'call_user_func' && fn.name !== 'call_user_func_array'
      ? evalDeferredValueArgs(e.args, row)
      : evalArgs(e.args, fn, fn.name);
  runtime.row = row;
  const compiledCallback = inline && compiledLiteralCallback(fn, e.args[0]?.e);
  const result = invoke({ fn, inline, frameless, directOverload, compiledCallback }, args, row, discardResult);
  runtime.frame.temporaries.push(result);
  return result;
}

function compiledLiteralCallback(fn: Callable, callback: Expr | undefined): boolean {
  if (fn.name !== 'call_user_func' && fn.name !== 'call_user_func_array') return false;
  return callback?.k === 'lit' && typeof callback.v === 'string' && !callback.v.startsWith('\\');
}

function evalDeferredValueArgs(args: Arg[], row: number): ArgValue[] {
  const frame = rt().frame;
  const mark = frame.temporaries.length;
  const reads = args.map((arg) => prepareOperand(arg.e));
  const values = reads.map((read, position): ArgValue => ({ v: share(read(row)), position }));
  claimArgumentTemporaries(frame, values, 0, mark);
  return values;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Resolves each form of call and callable in PHP's order of checks.
// code-gauge-allow functionNcss 48 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function methodCallExpression(e: Extract<Expr, { k: 'mcall' }>, discardResult = false): Chain {
  const runtime = rt();
  const member = e.name;
  const deferred = isCompiledVariable(e.obj);
  const earlyObject = !deferred || e.nullsafe ? evChain(e.obj) : undefined;
  if (earlyObject === SHORT || (e.nullsafe && earlyObject === null)) return SHORT;
  if (!deferred && earlyObject instanceof PhpObject) runtime.frame.temporaries.push(earlyObject);
  const readName = typeof member === 'string' ? undefined : prepareOperand(member);
  const methodName = readName ? dynamicMethodName(readName()) : (member as string);
  const object = deferred ? prepareOperand(e.obj)(e.row) : (earlyObject ?? null);
  runtime.row = e.row;
  if (!(object instanceof PhpObject) || object.isResource) {
    throwError('Error', `Call to a member function ${methodName}() on ${valueName(object)}`);
  }
  runtime.frame.temporaries.push(object);
  const scope = runtime.frame.scope;
  if (isClosure(object) && lower(methodName) === '__invoke') {
    const target = closureTarget(object);
    if (e.fcc) return object;
    const args = evalArgs(e.args, target.fn, functionDisplayName(target, true));
    return invoke(target, args, e.row, discardResult);
  }
  const method = lookupMethod(object.cls, lower(methodName), scope);
  if (method && !method.isAbstract && canCall(method, scope)) {
    const target: CallTarget = method.isStatic
      ? { fn: method.fn, scope: method.scope, staticClass: object.cls, method }
      : { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method };
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, classMethodLabel(method.scope, method.name));
    runtime.row = e.row;
    const result = invoke(target, args, e.row, discardResult);
    runtime.frame.temporaries.push(result);
    return result;
  }
  const magic = object.cls.findMethod('__call');
  if (magic) {
    const args = evalArgs(e.args, undefined, undefined);
    if (e.fcc) return magicClosure(object, object.cls, magic, methodName);
    return invoke(
      { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic },
      [{ v: methodName }, packMagicArguments(args)],
      e.row,
      discardResult
    );
  }
  if (method) {
    if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
    throwError(
      'Error',
      `Call to ${method.visibility} method ${method.scope.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  throwError('Error', `Call to undefined method ${object.cls.name}::${methodName}()`);
}

function dynamicMethodName(value: Value): string {
  if (typeof value !== 'string') throwError('Error', 'Method name must be a string');
  return value;
}

function packMagicArguments(args: ArgValue[]): ArgValue {
  const array = new PhpArray();
  for (const arg of args) {
    if (arg.name !== undefined) array.set(arg.name, arg.v);
    else array.append(arg.v);
  }
  const frame = rt().frame;
  frame.temporaries.push(array);
  handOverArgs(
    frame,
    args.filter((arg) => arg.name === undefined)
  );
  return { v: array, temporaryCount: 1 };
}

function magicClosure(receiver: PhpObject | undefined, calledClass: PhpClass, method: Method, name: string): PhpObject {
  return makeCallableClosure(magicClosureTarget({ method, name, receiver, calledClass }));
}

function magicClosureTarget({ method: magic, name, receiver, calledClass }: MagicCall): CallTarget {
  const fn = magicForwarder({ method: magic, name, receiver, calledClass });
  const method: Method = { ...magic, fn, name, lname: lower(name), isStatic: !receiver };
  return { fn, method, thisObj: receiver, scope: method.scope, staticClass: calledClass };
}

function magicForwarder(magic: MagicCall): Callable {
  return {
    kind: 'native',
    name: magic.name,
    acceptsNamed: true,
    params: [{ name: 'arguments', byRef: false, variadic: true, optional: true }],
    impl: ({ args, named }) => {
      const argumentsToPack: ArgValue[] = args.map((v) => ({ v }));
      for (const [key, v] of named ?? []) argumentsToPack.push({ v, name: key });
      return invokeMagic(magic, argumentsToPack, undefined);
    },
  };
}

function invokeMagic(
  { method, name, receiver, calledClass }: MagicCall,
  args: ArgValue[],
  row: number | undefined,
  discardResult = false
): Value {
  return invoke(
    { fn: method.fn, thisObj: receiver, scope: method.scope, staticClass: calledClass, method },
    [{ v: name }, packMagicArguments(args)],
    row,
    discardResult
  );
}

// code-gauge-allow functionCognitiveComplexity 30 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
// code-gauge-allow functionNcss 48 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function staticCallExpression(e: Extract<Expr, { k: 'scall' }>, discardResult = false): Chain {
  const runtime = rt();
  const frame = runtime.frame;
  runtime.row = e.row;
  const cls = resolveStaticClass(e.cls);
  if (cls === SHORT) return SHORT;
  const methodName = typeof e.name === 'string' ? e.name : dynamicMethodName(ev(e.name));
  runtime.row = e.row;
  const scope = frame.scope;
  const constructor = typeof e.name === 'string' && lower(methodName) === '__construct';
  const method = constructor ? staticConstructor(cls, frame) : lookupMethod(cls, lower(methodName), scope);
  const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
  if (method && (constructor || canCall(method, scope))) {
    const target = constructor
      ? nonStaticMethodTarget(method, thisObj)
      : staticInvocationTarget(e.cls.k, cls, method, thisObj, frame.staticClass);
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, classMethodLabel(method.scope, method.name));
    runtime.row = e.row;
    const result = invoke(target, args, e.row, discardResult);
    frame.temporaries.push(result);
    return result;
  }
  if (thisObj) {
    const magic = thisObj.cls.findMethod('__call');
    if (magic) {
      if (e.fcc) return magicClosure(thisObj, thisObj.cls, magic, methodName);
      const args = evalArgs(e.args, undefined, undefined);
      return invoke(
        { fn: magic.fn, thisObj, scope: magic.scope, staticClass: thisObj.cls, method: magic },
        [{ v: methodName }, packMagicArguments(args)],
        e.row,
        discardResult
      );
    }
  }
  const magicStatic = cls.findMethod('__callstatic');
  if (magicStatic) {
    reportStaticTraitCall(cls, methodName);
    if (e.fcc) return magicClosure(undefined, cls, magicStatic, methodName);
    const args = evalArgs(e.args, undefined, undefined);
    return invoke(
      { fn: magicStatic.fn, scope: magicStatic.scope, staticClass: cls, method: magicStatic },
      [{ v: methodName }, packMagicArguments(args)],
      e.row,
      discardResult
    );
  }
  if (method) {
    throwError(
      'Error',
      `Call to ${method.visibility} method ${method.scope.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  throwError('Error', `Call to undefined method ${cls.name}::${methodName}()`);
}

function staticConstructor(cls: PhpClass, frame: Frame): Method {
  const constructor = cls.findMethod('__construct');
  if (!constructor) throwError('Error', 'Cannot call constructor');
  if (constructor.visibility === 'private' && frame.thisObj && frame.thisObj.cls !== constructor.scope)
    throwError('Error', `Cannot call private ${constructor.scope.name}::__construct()`);
  return constructor;
}

function staticInvocationTarget(
  kind: Extract<Expr, { k: 'scall' }>['cls']['k'],
  cls: PhpClass,
  method: Method,
  thisObj: PhpObject | undefined,
  calledClass: PhpClass | undefined
): CallTarget {
  if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
  if (method.isStatic) {
    reportStaticTraitCall(cls, method.name);
    const forwarding = kind === 'parent' || kind === 'self' || kind === 'static';
    return { fn: method.fn, scope: method.scope, staticClass: forwarding && calledClass ? calledClass : cls, method };
  }
  return nonStaticMethodTarget(method, thisObj);
}

function nonStaticMethodTarget(method: Method, thisObj: PhpObject | undefined): CallTarget {
  if (thisObj) return { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
  throwError('Error', `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`);
}

function reportStaticTraitCall(cls: PhpClass, name: string): void {
  if (cls.kind === 'trait')
    deprecated(
      `Calling static trait method ${cls.name}::${name} is deprecated, it should only be called on a class using the trait`
    );
}

export function readOffset(object: PhpObject, key: Value | undefined): Value {
  const getter = object.cls.findMethod('offsetget');
  const owner = getter?.scope.lname;
  if (key === undefined && getter?.fn.kind === 'native' && owner === 'splfixedarray')
    throwError('Error', '[] operator not supported for SplFixedArray');
  const inline = object.cls.lname === 'splobjectstorage' && key instanceof PhpObject && !key.isResource;
  const classArrayObject = rt().classes.get('arrayobject');
  const classArrayIterator = rt().classes.get('arrayiterator');
  const omitted =
    key === undefined &&
    getter?.fn.kind === 'user' &&
    ((classArrayObject && object.cls.isSubclassOf(classArrayObject)) ||
      (classArrayIterator && object.cls.isSubclassOf(classArrayIterator)));
  return callMethod(object, 'offsetGet', [key ?? null], rt().row, { inline, omittedOffset: omitted });
}

/** Calls a method of an object by name, as native code calls `offsetGet` or `__toString`. */
export function callMethod(
  object: PhpObject,
  name: string,
  args: Value[],
  row?: number,
  options?: {
    inline?: boolean;
    omittedOffset?: boolean;
    lookupClass?: PhpClass;
    captureReturn?: (value: Value) => void;
  }
): Value {
  const method = (options?.lookupClass ?? object.cls).findMethod(lower(name));
  if (!method) {
    const magic = object.cls.findMethod('__call');
    if (magic) {
      return invoke(
        {
          fn: magic.fn,
          thisObj: object,
          scope: magic.scope,
          staticClass: object.cls,
          method: magic,
          captureReturn: options?.captureReturn,
        },
        [{ v: name }, { v: PhpArray.list(args) }],
        row
      );
    }
    throwError('Error', `Call to undefined method ${object.cls.name}::${name}()`);
  }
  return invoke(
    {
      fn: method.fn,
      thisObj: method.isStatic ? undefined : object,
      scope: method.scope,
      staticClass: object.cls,
      method,
      captureReturn: options?.captureReturn,
      inline:
        row !== undefined &&
        method.fn.kind === 'native' &&
        (options?.inline || ['splfixedarray', 'arrayobject', 'arrayiterator'].includes(method.scope.lname)),
    },
    args.map((v) => ({ v, omitted: options?.omittedOffset })),
    row
  );
}

// Callables ----------------------------------------------------------------------------------------------------------

export function closureTarget(closure: PhpObject): CallTarget {
  const data = closure.internal as ClosureData;
  return {
    fn: data.fn,
    dynamic: true,
    thisObj: data.thisObj,
    scope: data.scope,
    staticClass: data.calledClass ?? data.thisObj?.cls ?? data.scope,
    method: data.method,
    closure: data.fn.kind === 'user' && data.fn.decl.isClosure ? closure : undefined,
  };
}

export function callableClosureName(closure: PhpObject): string {
  const { fn, method } = closureTarget(closure);
  if (method) return `${method.scope.fullName}::${method.name}`;
  if (fn.kind === 'user' && fn.decl.isClosure) return fn.decl.name;
  return fn.name;
}

class CallableFailure {
  constructor(
    readonly message: string,
    readonly problem: string
  ) {}
}

/**
 * The function a callable value names: a closure, an invokable object, a function name, `"Class::method"`, or
 * `[$objectOrClass, "method"]`.
 */
export function callTargetOf(value: Value, mode: 'direct' | 'callback'): CallTarget {
  try {
    return { ...resolveCallable(value, mode), dynamic: true };
  } catch (error) {
    if (error instanceof CallableFailure) throwError('Error', error.message);
    throw error;
  }
}

export function checkCallable(value: Value): boolean {
  try {
    resolveCallable(value, 'callback', true);
    return true;
  } catch (error) {
    if (error instanceof CallableFailure) return false;
    throw error;
  }
}

export function explainCallable(value: Value): string {
  try {
    resolveCallable(value, 'callback');
    return '';
  } catch (error) {
    if (error instanceof CallableFailure) return error.problem;
    throw error;
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function resolveCallable(value: Value, mode: 'direct' | 'callback', emitScopeWarning = false): CallTarget {
  const runtime = rt();
  const scope = runtime.frame.scope;
  if (value instanceof PhpObject) {
    if (isClosure(value)) return closureTarget(value);
    const invokeMethod = value.cls.findMethod('__invoke');
    if (invokeMethod)
      return {
        fn: invokeMethod.fn,
        thisObj: value,
        scope: invokeMethod.scope,
        staticClass: value.cls,
        method: invokeMethod,
      };
    throw new CallableFailure('Object of type ' + value.cls.name + ' is not callable', 'no array or string given');
  }
  if (typeof value === 'string') {
    const separator = value.indexOf('::');
    if (separator !== -1)
      return staticCallable(value.slice(0, separator), value.slice(separator + 2), scope, mode, emitScopeWarning);
    const fn = runtime.functions.get(lower(value.startsWith('\\') ? value.slice(1) : value));
    if (!fn) {
      if (builtinNames.functions.includes(lower(value.replace(/^\\/, ''))))
        throw new UnsupportedFeatureError(`PHP の組み込み関数（${value}）`);
      throw new CallableFailure(
        `Call to undefined function ${value}()`,
        `function "${value}" not found or invalid function name`
      );
    }
    return { fn };
  }
  if (value instanceof PhpArray) return arrayCallable(value, scope, mode, emitScopeWarning);
  throw new CallableFailure(`Value of type ${debugType(value)} is not callable`, 'no array or string given');
}

function arrayCallable(
  value: PhpArray,
  scope: PhpClass | undefined,
  mode: 'direct' | 'callback',
  emitScopeWarning: boolean
): CallTarget {
  if (value.size !== 2)
    throw new CallableFailure(
      'Array callback must have exactly two elements',
      'array callback must have exactly two members'
    );
  if (!value.has(0n) || !value.has(1n))
    throw new CallableFailure(
      'Array callback has to contain indices 0 and 1',
      'array callback has to contain indices 0 and 1'
    );
  const target = value.get(0n);
  if (typeof target !== 'string' && (!(target instanceof PhpObject) || target.isResource))
    throw new CallableFailure(
      'First array member is not a valid class name or object',
      'first array member is not a valid class name or object'
    );
  const method = value.get(1n);
  if (typeof method !== 'string')
    throw new CallableFailure('Second array member is not a valid method', 'second array member is not a valid method');
  return typeof target === 'string'
    ? staticCallable(target, method, scope, mode, emitScopeWarning)
    : arrayObjectCallable(target, method, scope, mode, emitScopeWarning);
}

function arrayObjectCallable(
  target: PhpObject,
  method: string,
  scope: PhpClass | undefined,
  mode: 'direct' | 'callback',
  emitScopeWarning: boolean
): CallTarget {
  if (isClosure(target) && lower(method) === '__invoke') return closureTarget(target);
  const qualified = mode === 'callback' ? qualifiedObjectMethod(target.cls, method, scope) : undefined;
  const name = qualified?.name ?? method;
  const found =
    qualified && qualified.cls !== target.cls
      ? qualified.cls.findMethod(lower(name))
      : lookupMethod(target.cls, lower(name), scope);
  if (qualified && emitScopeWarning)
    deprecated(`Callables of the form ["${target.cls.name}", "${method}"] are deprecated`);
  if (found && canCall(found, scope)) {
    return found.isStatic
      ? { fn: found.fn, scope: found.scope, staticClass: target.cls, method: found }
      : { fn: found.fn, thisObj: target, scope: found.scope, staticClass: target.cls, method: found };
  }
  const magic = arrayMagicTarget(target, qualified?.cls ?? target.cls, name, found);
  if (magic) return magic;
  if (found)
    throw new CallableFailure(
      `Call to ${found.visibility} method ${found.scope.name}::${found.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`,
      `cannot access ${found.visibility} method ${target.cls.name}::${found.name}()`
    );
  throw new CallableFailure(
    `Call to undefined method ${qualified?.cls.name ?? target.cls.name}::${qualified?.name ?? method}()`,
    `class ${qualified?.cls.name ?? target.cls.name} does not have a method "${qualified?.name ?? method}"`
  );
}

function arrayMagicTarget(
  receiver: PhpObject,
  lookupClass: PhpClass,
  name: string,
  inaccessible: Method | undefined
): CallTarget | undefined {
  const magic = lookupClass.findMethod('__call');
  if (lookupClass === receiver.cls) return magic && magicTarget(receiver, receiver.cls, magic, name);
  if (inaccessible && !magic) return;
  const caller = rt().frame.thisObj;
  if (magic && caller?.cls.isSubclassOf(lookupClass)) {
    const callerMagic = caller.cls.findMethod('__call') ?? magic;
    return magicTarget(receiver, receiver.cls, callerMagic, name);
  }
  const staticMagic = lookupClass.findMethod('__callstatic');
  if (staticMagic) {
    return magicTarget(undefined, receiver.cls, staticMagic, name);
  }
}

function qualifiedObjectMethod(
  target: PhpClass,
  method: string,
  scope: PhpClass | undefined
): { cls: PhpClass; name: string } | undefined {
  const separator = method.indexOf('::');
  if (separator === -1) return undefined;
  const qualifier = method.slice(0, separator);
  const word = lower(qualifier);
  let cls: PhpClass;
  if (word === 'self') cls = target;
  else if (word === 'parent') {
    if (!target.parent)
      throw new CallableFailure(
        'Cannot access "parent" when current class scope has no parent',
        'cannot access "parent" when current class scope has no parent'
      );
    cls = target.parent;
  } else if (word === 'static') {
    if (!scope)
      throw new CallableFailure(classScopeMessage(word), 'cannot access "static" when no class scope is active');
    cls = rt().frame.staticClass ?? scope;
  } else cls = callableClass(qualifier);
  if (!target.isSubclassOf(cls))
    throw new CallableFailure(
      `Class ${target.name} is not a subclass of ${cls.name}`,
      `class ${target.name} is not a subclass of ${cls.name}`
    );
  return { cls, name: method.slice(separator + 2) };
}

function magicTarget(receiver: PhpObject | undefined, calledClass: PhpClass, method: Method, name: string): CallTarget {
  return {
    fn: method.fn,
    thisObj: receiver,
    staticClass: calledClass,
    magic: { method, name, receiver, calledClass },
  };
}

// code-gauge-allow functionCognitiveComplexity 27 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function staticCallable(
  className: string,
  methodName: string,
  scope: PhpClass | undefined,
  mode: 'direct' | 'callback',
  emitScopeWarning: boolean
): CallTarget {
  const frame = rt().frame;
  const word = lower(className);
  let cls: PhpClass;
  let calledClass: PhpClass | undefined;
  if (mode === 'callback' && (word === 'self' || word === 'static' || word === 'parent')) {
    if (!frame.scope) {
      const message = classScopeMessage(word);
      throw new CallableFailure(message, message[0].toLowerCase() + message.slice(1));
    }
    if (emitScopeWarning) deprecated(`Use of "${word}" in callables is deprecated`);
    if (word === 'parent' && !frame.scope.parent)
      throw new CallableFailure(
        'Cannot access "parent" when current class scope has no parent',
        'cannot access "parent" when current class scope has no parent'
      );
    calledClass = frame.staticClass ?? frame.scope;
    cls = (word === 'self' ? frame.scope : word === 'parent' ? frame.scope.parent : calledClass) as PhpClass;
  } else cls = callableClass(className);
  calledClass ??= cls;
  const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
  const method = lookupMethod(cls, lower(methodName), scope);
  if (!method || !canCall(method, scope)) {
    const magic = cls.findMethod('__callstatic');
    if (magic) return magicTarget(undefined, calledClass, magic, methodName);
    throw inaccessibleStaticMethod(cls, methodName, method, scope, mode === 'callback' && !thisObj);
  }
  if (method.isAbstract) {
    throw new CallableFailure(
      `Cannot call abstract method ${method.scope.name}::${method.name}()`,
      `cannot call abstract method ${cls.name}::${method.name}()`
    );
  }
  if (!method.isStatic) {
    if (!thisObj) throw nonStaticCallable(method);
    return { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
  }
  return { fn: method.fn, scope: method.scope, staticClass: calledClass, method };
}

function inaccessibleStaticMethod(
  cls: PhpClass,
  methodName: string,
  method: Method | undefined,
  scope: PhpClass | undefined,
  checkStatic: boolean
): CallableFailure {
  if (!method)
    return new CallableFailure(
      `Call to undefined method ${cls.name}::${methodName}()`,
      `class ${cls.name} does not have a method "${methodName}"`
    );
  if (checkStatic && !method.isStatic) return nonStaticCallable(method);
  return new CallableFailure(
    `Call to ${method.visibility} method ${method.scope.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`,
    `cannot access ${method.visibility} method ${cls.name}::${method.name}()`
  );
}

function nonStaticCallable(method: Method): CallableFailure {
  const suffix = `method ${method.scope.name}::${method.name}() cannot be called statically`;
  return new CallableFailure(`Non-static ${suffix}`, `non-static ${suffix}`);
}

function callableClass(name: string): PhpClass {
  try {
    return probe(() => requireClass(name));
  } catch (error) {
    if (error instanceof ProbeFailure)
      throw new CallableFailure(`Class "${name}" not found`, `class "${name}" not found`);
    throw error;
  }
}

/** Calls a callable value with arguments already evaluated, as `call_user_func` and `$f(...)` do. */
export function callValue(
  callable: Value,
  args: ArgValue[],
  row: number | undefined,
  mode: 'direct' | 'callback' = 'callback',
  discardResult = false,
  compiledTarget = false
): Value {
  const target = callTargetOf(callable, mode);
  if (compiledTarget) target.dynamic = false;
  return invokeCallbackTarget(target, args, row, discardResult);
}

export function invokeCallbackTarget(
  target: CallTarget,
  args: ArgValue[],
  row: number | undefined,
  discardResult = false
): Value {
  if (target.magic) return invokeMagic(target.magic, args, row, discardResult);
  checkNamedArgs(target.fn.params, args);
  warnCallbackReferenceArguments(target, args);
  return invoke(target, args, row, discardResult);
}

export function callCallback(callable: Value, args: Value[]): Value {
  return callValue(
    callable,
    args.map((v) => ({ v })),
    undefined
  );
}

export function callCallbackRefs(callable: Value, args: ArgValue[], discardResult = false): Value {
  const call = (): Value => callValue(callable, args, undefined, 'callback', discardResult);
  return discardResult ? consumeInvokedResult(call, () => null) : call();
}

export function consumeCallbackResult<T>(callable: Value, args: Value[], consume: (value: Value) => T): T {
  return consumeInvokedResult(() => callCallback(callable, args), consume);
}

export function consumeInvokedResult<T>(call: () => Value, consume: (value: Value) => T): T {
  const runtime = rt();
  const nativeMark = runtime.nativeHeld.at(-1)?.length ?? 0;
  const temporaryMark = runtime.frame.temporaries.length;
  const value = call();
  runtime.lastReturnRef = undefined;
  if (!(value instanceof PhpObject || value instanceof PhpArray)) return consume(value);
  let pending: PhpThrow | undefined;
  let canRelease = true;
  try {
    return consume(value);
  } catch (error) {
    if (error instanceof PhpThrow) pending = error;
    else canRelease = false;
    throw error;
  } finally {
    if (canRelease)
      withPendingException(runtime, pending, () => runtime.discardNativeResult(value, nativeMark, temporaryMark));
  }
}

function warnCallbackReferenceArguments(target: CallTarget, args: ArgValue[]): void {
  for (const [index, arg] of args.entries()) {
    if (arg.ref || !paramIsByRef(target.fn, index, arg.name)) continue;
    const namedIndex = arg.name === undefined ? -1 : target.fn.params.findIndex((param) => param.name === arg.name);
    const position = namedIndex >= 0 ? namedIndex : index;
    const param = target.fn.params[Math.min(position, target.fn.params.length - 1)];
    if (param?.preferRef) continue;
    const label = param?.variadic ? '' : ` ($${param?.name ?? arg.name ?? ''})`;
    warn(
      `${functionDisplayName(target)}(): Argument #${position + 1}${label} must be passed by reference, value given`
    );
  }
}

export function closureFromCallable(target: CallTarget): PhpObject {
  return target.magic ? makeCallableClosure(magicClosureTarget(target.magic), true) : makeCallableClosure(target);
}

export function closureFromValue(value: Value): PhpObject {
  if (value instanceof PhpObject && isClosure(value)) return value;
  try {
    return closureFromCallable(resolveCallable(value, 'callback', true));
  } catch (error) {
    if (error instanceof CallableFailure)
      throwError('TypeError', `Failed to create closure from callable: ${error.problem}`);
    throw error;
  }
}

function makeCallableClosure(target: CallTarget, omitParameters = false): PhpObject {
  const runtime = rt();
  const closureClass = runtime.classes.get('closure') as PhpClass;
  const object = runtime.newObject(closureClass);
  const data: ClosureData = {
    fn: target.fn,
    isCallable: true,
    bound: new Map(),
    thisObj: target.thisObj,
    scope: target.scope,
    calledClass: target.staticClass,
    isStatic: target.method?.isStatic ?? target.fn.kind === 'native',
    method: target.method,
    omitParameters,
  };
  object.internal = data;
  runtime.frame.temporaries.push(object);
  return object;
}

export function createClosure(e: Extract<Expr, { k: 'closure' }>): PhpObject {
  const runtime = rt();
  const frame = runtime.frame;
  const fn = closureFunction(e.fn);
  const bound = new Map<string, Ref>();
  for (const use of e.uses) {
    if (use.byRef) {
      const ref = new VarPlace(frame, use.name).ref();
      ref.isRef = true;
      ref.rc++;
      bound.set(use.name, ref);
    } else {
      const ref = frame.vars.get(use.name);
      if (!ref) {
        runtime.row = use.row;
        warn(`Undefined variable $${use.name}`);
      }
      bound.set(use.name, new Ref(share(ref?.v ?? null)));
    }
  }
  return newClosure(fn, bound, e.isStatic, frame);
}

export function createArrow(e: Extract<Expr, { k: 'arrow' }>): PhpObject {
  const frame = rt().frame;
  const fn = closureFunction(e.fn);
  const bound = new Map<string, Ref>();
  for (const name of e.fn.captures ?? []) {
    const ref = frame.vars.get(name);
    if (ref) bound.set(name, new Ref(share(ref.v)));
  }
  return newClosure(fn, bound, e.isStatic, frame);
}

function newClosure(fn: UserFunction, bound: Map<string, Ref>, isStatic: boolean, frame: Frame): PhpObject {
  const runtime = rt();
  const object = runtime.newObject(runtime.classes.get('closure') as PhpClass);
  object.internal = {
    fn,
    bound,
    thisObj: isStatic ? undefined : frame.thisObj,
    scope: frame.scope,
    lexicalScope:
      frame.decl?.isClosure && frame.closure ? (frame.closure.internal as ClosureData).lexicalScope : frame.scope,
    calledClass: frame.staticClass,
    isStatic,
  } satisfies ClosureData;
  frame.temporaries.push(object);
  return object;
}

// Function bodies ----------------------------------------------------------------------------------------------------

const FRAMELESS_ARITIES: Readonly<Partial<Record<string, readonly number[]>>> = {
  class_exists: [1, 2],
  dechex: [1],
  dirname: [1, 2],
  implode: [1, 2],
  in_array: [2, 3],
  is_numeric: [1],
  max: [2],
  min: [2],
  preg_match: [2],
  preg_replace: [3],
  property_exists: [2],
  str_contains: [2],
  str_replace: [3],
  str_starts_with: [2],
  strpos: [2, 3],
  strstr: [2, 3],
  strtr: [2, 3],
  substr: [2, 3],
  trim: [1, 2],
};

const OPCODE_ARITIES: Readonly<Partial<Record<string, readonly number[]>>> = {
  array_key_exists: [2],
  boolval: [1],
  call_user_func_array: [2],
  doubleval: [1],
  floatval: [1],
  func_get_args: [0],
  func_num_args: [0],
  get_called_class: [0],
  get_class: [0, 1],
  intval: [1],
  strval: [1],
};

function specializedCall(fn: Callable, args: Arg[]): 'opcode' | 'frameless' | undefined {
  if (fn.kind !== 'native' || args.some((arg) => arg.spread || arg.name !== undefined)) return undefined;
  const name = lower(fn.name);
  if ((name === 'func_get_args' || name === 'func_num_args') && !rt().frame.decl) return undefined;
  if (FRAMELESS_ARITIES[name]?.includes(args.length)) return 'frameless';
  const arities = OPCODE_ARITIES[name];
  if (
    arities
      ? arities.includes(args.length)
      : fn.inlined && (name === 'call_user_func' ? args.length > 0 : args.length === 1)
  )
    return 'opcode';
  return undefined;
}
