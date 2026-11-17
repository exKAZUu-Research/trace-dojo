// code-gauge-allow-file fileNcss 415 -- Keeps one PHP runtime concern and its shared helpers in one module.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { placeOf } from './assignment';
import type { Arg, Expr } from './ast';
import builtinNames from './builtinNames.json';
import { lower } from './bytes';
import { type ArgValue, type CallTarget, closureFunction, functionDisplayName, invoke, paramIsByRef } from './calls';
import { canCall, classScopeMessage, lookupMethod, requireClass } from './classes';
import { debugType, valueName } from './conversions';
import { deprecated, notice, probe, ProbeFailure, throwError, warn } from './errors';
import { type Chain, ev, evChain, iterate, resolveClassRef, SHORT } from './interp';
import { toStr } from './operators';
import { ElementPlace, share, VarPlace, writableContainer } from './places';
import { type Frame, rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Callable,
  type ClosureData,
  isClosure,
  type Method,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  type UserFunction,
  type Value,
} from './values';

// Calls --------------------------------------------------------------------------------------------------------------

/** Evaluates call arguments, binding by-reference parameters to locations. */
export function evalArgs(args: Arg[], fn: Callable | undefined, name: string | undefined): ArgValue[] {
  const runtime = rt();
  const values: ArgValue[] = [];
  const frame = runtime.frame;
  for (const [index, arg] of args.entries()) {
    if (arg.spread) {
      const source = fn?.params.some((param) => param.byRef) && arg.e.k === 'var' ? placeOf(arg.e) : undefined;
      let value = source ? source.get() : ev(arg.e);
      if (value instanceof PhpArray && source) value = writableContainer(source);
      else if (value instanceof PhpArray && fn?.params.some((param) => param.byRef)) value = value.copy();
      if (value instanceof PhpArray) {
        for (const [key, item] of value.entries()) {
          const argumentName = typeof key === 'string' ? key : undefined;
          if (argumentName === undefined && values.some((other) => other.name !== undefined)) {
            throwError('Error', 'Cannot use positional argument after named argument during unpacking');
          }
          const position = argumentName === undefined ? values.length : -1;
          if (fn && paramIsByRef(fn, position, argumentName)) {
            const ref = new ElementPlace(value, key).ref();
            values.push({ v: ref.v, ref, name: argumentName });
          } else values.push({ v: share(item), name: argumentName });
        }
      } else if (value instanceof PhpObject) {
        for (const [key, item] of iterate(value)) {
          if (typeof key === 'string') values.push({ v: share(item), name: key });
          else values.push({ v: share(item) });
        }
      } else throwError('TypeError', 'Only arrays and Traversables can be unpacked');
      continue;
    }
    const position = arg.name === undefined ? values.length : -1;
    const byRef = fn ? paramIsByRef(fn, position, arg.name) : false;
    if (byRef) {
      const e = arg.e;
      if (['var', 'varvar', 'idx', 'prop', 'sprop'].includes(e.k)) {
        const ref = placeOf(e).ref();
        values.push({ v: ref.v, ref, name: arg.name });
        continue;
      }
      runtime.lastReturnRef = undefined;
      const value = ev(e);
      const returned = runtime.lastReturnRef as Ref | undefined;
      runtime.lastReturnRef = undefined;
      if (returned && (e.k === 'call' || e.k === 'mcall' || e.k === 'scall')) {
        values.push({ v: returned.v, ref: returned, name: arg.name });
        continue;
      }
      const param = fn?.params[Math.min(position === -1 ? 0 : position, (fn?.params.length ?? 1) - 1)];
      if (param?.preferRef) {
        values.push({ v: value, name: arg.name });
        continue;
      }
      if (e.k === 'call' || e.k === 'mcall' || e.k === 'scall') {
        notice('Only variables should be passed by reference');
        values.push({ v: value, ref: new Ref(value), name: arg.name });
        continue;
      }
      const label = name ?? fn?.name ?? '';
      const paramIndex =
        arg.name === undefined ? index : (fn?.params.findIndex((param) => param.name === arg.name) ?? 0);
      const paramName = fn?.params[Math.min(paramIndex, (fn?.params.length ?? 1) - 1)]?.name ?? '';
      throwError('Error', `${label}(): Argument #${paramIndex + 1} ($${paramName}) could not be passed by reference`);
    }
    const value = ev(arg.e);
    frame.temporaries.push(value);
    values.push({ v: value, name: arg.name });
  }
  return values;
}

export function callExpression(e: Extract<Expr, { k: 'call' }>): Value {
  const runtime = rt();
  runtime.row = e.row;
  if (!('k' in e.fn)) {
    const name = e.fn;
    const fn =
      runtime.functions.get(lower(name.name)) ??
      (name.fallback ? runtime.functions.get(lower(name.fallback)) : undefined);
    if (!fn) {
      if (builtinNames.functions.includes(lower(name.fallback ?? name.name)))
        throw new UnsupportedFeatureError(`PHP の組み込み関数（${name.fallback ?? name.name}）`);
      throwError('Error', `Call to undefined function ${name.name}()`);
    }
    if (e.fcc) return closureFromCallable({ fn });
    const args = evalArgs(e.args, fn, fn.name);
    runtime.row = e.row;
    const result = invoke({ fn, inline: inlineCall(fn, e.args) }, args, e.row);
    runtime.frame.temporaries.push(result);
    return result;
  }
  const callee = ev(e.fn);
  runtime.row = e.row;
  const target = callTargetOf(callee, 'direct');
  if (e.fcc) return closureFromCallable(target);
  const args = evalArgs(e.args, target.fn, functionNameFor(target));
  runtime.row = e.row;
  const result = invoke(target, args, e.row);
  runtime.frame.temporaries.push(result);
  return result;
}

function functionNameFor(target: CallTarget): string {
  return target.method ? `${target.method.scope.name}::${target.method.name}` : target.fn.name;
}

// code-gauge-allow functionCognitiveComplexity 29 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
// code-gauge-allow functionNcss 48 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function methodCallExpression(e: Extract<Expr, { k: 'mcall' }>): Chain {
  const runtime = rt();
  const object = evChain(e.obj);
  if (object === SHORT) return SHORT;
  if (e.nullsafe && object === null) return SHORT;
  const name = typeof e.name === 'string' ? e.name : undefined;
  let methodName: string;
  if (name !== undefined) methodName = name;
  else {
    const value = ev(e.name as Expr);
    if (value instanceof PhpObject && isClosure(value)) {
      throwError('Error', 'Method name must be a string');
    }
    methodName = toStr(value);
  }
  runtime.row = e.row;
  if (!(object instanceof PhpObject) || object.isResource) {
    throwError('Error', `Call to a member function ${methodName}() on ${valueName(object)}`);
  }
  runtime.frame.temporaries.push(object);
  const scope = runtime.frame.scope;
  const method = lookupMethod(object.cls, lower(methodName), scope);
  if (method && !method.isAbstract && canCall(method, scope)) {
    const target: CallTarget = method.isStatic
      ? { fn: method.fn, scope: method.scope, staticClass: object.cls, method }
      : { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method };
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, `${method.scope.name}::${method.name}`);
    runtime.row = e.row;
    const result = invoke(target, args, e.row);
    runtime.frame.temporaries.push(result);
    return result;
  }
  if (isClosure(object) && lower(methodName) === '__invoke') {
    const target = closureTarget(object);
    if (e.fcc) return object;
    const args = evalArgs(e.args, target.fn, functionNameFor(target));
    return invoke(target, args, e.row);
  }
  const magic = object.cls.findMethod('__call');
  if (magic) {
    const args = evalArgs(e.args, undefined, undefined);
    if (e.fcc) return magicClosure(object, magic, methodName);
    return invoke(
      { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic },
      [{ v: methodName }, { v: argsArray(args) }],
      e.row
    );
  }
  if (method) {
    if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
    throwError(
      'Error',
      `Call to ${method.visibility} method ${object.cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  throwError('Error', `Call to undefined method ${object.cls.name}::${methodName}()`);
}

function argsArray(args: ArgValue[]): PhpArray {
  const array = new PhpArray();
  for (const arg of args) {
    if (arg.name !== undefined) array.set(arg.name, arg.v);
    else array.append(arg.v);
  }
  return array;
}

function magicClosure(object: PhpObject, magic: Method, methodName: string): PhpObject {
  return closureFromCallable({
    fn: magicForwarder(magic, methodName, object, object.cls),
    thisObj: object,
    scope: object.cls,
  });
}

/** A function that passes its arguments to `__call` or `__callStatic` with the name of the method a program called. */
function magicForwarder(magic: Method, name: string, object: PhpObject | undefined, cls: PhpClass): Callable {
  return {
    kind: 'native',
    name,
    acceptsNamed: true,
    params: [{ name: 'args', byRef: false, variadic: true, optional: true }],
    impl: ({ args, named }) => {
      const forwarded = PhpArray.list(args);
      for (const [key, value] of named ?? []) forwarded.set(key, value);
      return invoke(
        { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: cls, method: magic },
        [{ v: name }, { v: forwarded }],
        undefined
      );
    },
  };
}

// code-gauge-allow functionCognitiveComplexity 30 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
// code-gauge-allow functionNcss 46 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function staticCallExpression(e: Extract<Expr, { k: 'scall' }>): Value {
  const runtime = rt();
  const frame = runtime.frame;
  runtime.row = e.row;
  const cls = resolveClassRef(e.cls);
  const methodName = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
  runtime.row = e.row;
  const scope = frame.scope;
  const method = lookupMethod(cls, lower(methodName), scope);
  const forwarding = e.cls.k === 'parent' || e.cls.k === 'self' || e.cls.k === 'static';
  const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
  if (method && canCall(method, scope)) {
    if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
    let target: CallTarget;
    if (method.isStatic) {
      const staticClass = forwarding && frame.staticClass ? frame.staticClass : cls;
      target = { fn: method.fn, scope: method.scope, staticClass, method };
    } else if (thisObj) {
      target = { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
    } else {
      throwError('Error', `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`);
    }
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, `${method.scope.name}::${method.name}`);
    runtime.row = e.row;
    const result = invoke(target, args, e.row);
    frame.temporaries.push(result);
    return result;
  }
  if (thisObj) {
    const magic = thisObj.cls.findMethod('__call');
    if (magic) {
      if (e.fcc) return magicClosure(thisObj, magic, methodName);
      const args = evalArgs(e.args, undefined, undefined);
      return invoke(
        { fn: magic.fn, thisObj, scope: magic.scope, staticClass: thisObj.cls, method: magic },
        [{ v: methodName }, { v: argsArray(args) }],
        e.row
      );
    }
  }
  const magicStatic = cls.findMethod('__callstatic');
  if (magicStatic) {
    if (e.fcc)
      return closureFromCallable({ fn: magicForwarder(magicStatic, methodName, undefined, cls), staticClass: cls });
    const args = evalArgs(e.args, undefined, undefined);
    return invoke(
      { fn: magicStatic.fn, scope: magicStatic.scope, staticClass: cls, method: magicStatic },
      [{ v: methodName }, { v: argsArray(args) }],
      e.row
    );
  }
  if (method) {
    throwError(
      'Error',
      `Call to ${method.visibility} method ${cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  throwError('Error', `Call to undefined method ${cls.name}::${methodName}()`);
}

/** Calls a method of an object by name, as native code calls `offsetGet` or `__toString`. */
export function callMethod(object: PhpObject, name: string, args: Value[]): Value {
  const method = object.cls.findMethod(lower(name));
  if (!method) {
    const magic = object.cls.findMethod('__call');
    if (magic) {
      return invoke(
        { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic },
        [{ v: name }, { v: PhpArray.list(args) }],
        undefined
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
    },
    args.map((v) => ({ v })),
    undefined
  );
}

// Callables ----------------------------------------------------------------------------------------------------------

export function closureTarget(closure: PhpObject): CallTarget {
  const data = closure.internal as ClosureData;
  return {
    fn: data.fn,
    thisObj: data.thisObj,
    scope: data.scope,
    staticClass: data.calledClass ?? data.thisObj?.cls ?? data.scope,
    method: data.method,
    closure: data.fn.kind === 'user' && data.fn.decl.isClosure ? closure : undefined,
  };
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
    return resolveCallable(value, mode);
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

// code-gauge-allow functionCognitiveComplexity 27 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function arrayCallable(
  value: PhpArray,
  scope: PhpClass | undefined,
  mode: 'direct' | 'callback',
  emitScopeWarning: boolean
): CallTarget {
  if (value.size === 2) {
    const target = value.get(0n);
    const method = value.get(1n);
    if (typeof method === 'string' && target instanceof PhpObject) {
      const found = lookupMethod(target.cls, lower(method.replace(/^parent::/i, '')), scope);
      if (found && canCall(found, scope)) {
        return found.isStatic
          ? { fn: found.fn, scope: found.scope, staticClass: target.cls, method: found }
          : { fn: found.fn, thisObj: target, scope: found.scope, staticClass: target.cls, method: found };
      }
      const magic = target.cls.findMethod('__call');
      if (magic) return magicTarget(target, magic, method);
      if (found)
        throw new CallableFailure(
          `Call to ${found.visibility} method ${target.cls.name}::${found.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`,
          `cannot access ${found.visibility} method ${target.cls.name}::${found.name}()`
        );
      throw new CallableFailure(
        `Call to undefined method ${target.cls.name}::${method}()`,
        `class ${target.cls.name} does not have a method "${method}"`
      );
    }
    if (typeof method === 'string' && typeof target === 'string')
      return staticCallable(target, method, scope, mode, emitScopeWarning);
  }
  if (value.size !== 2)
    throw new CallableFailure(
      'Array callback must have exactly two elements',
      'array callback must have exactly two members'
    );
  throw new CallableFailure(
    'First array member is not a valid class name or object',
    typeof value.get(1n) === 'string'
      ? 'first array member is not a valid class name or object'
      : 'second array member is not a valid method'
  );
}

function magicTarget(object: PhpObject, magic: Method, name: string): CallTarget {
  return { fn: magicForwarder(magic, name, object, object.cls), thisObj: object };
}

// code-gauge-allow functionCognitiveComplexity 28 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
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
    cls = (
      word === 'self' ? frame.scope : word === 'parent' ? frame.scope.parent : (frame.staticClass ?? frame.scope)
    ) as PhpClass;
  } else cls = callableClass(className);
  const method = lookupMethod(cls, lower(methodName), scope);
  if (!method) {
    const magic = cls.findMethod('__callstatic');
    if (magic) return { fn: magicForwarder(magic, methodName, undefined, cls), staticClass: cls };
    throw new CallableFailure(
      `Call to undefined method ${cls.name}::${methodName}()`,
      `class ${cls.name} does not have a method "${methodName}"`
    );
  }
  if (!canCall(method, scope))
    throw new CallableFailure(
      `Call to ${method.visibility} method ${cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`,
      `cannot access ${method.visibility} method ${cls.name}::${method.name}()`
    );
  if (!method.isStatic) {
    const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
    if (!thisObj)
      throw new CallableFailure(
        `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`,
        `non-static method ${method.scope.name}::${method.name}() cannot be called statically`
      );
    return { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
  }
  return { fn: method.fn, scope: method.scope, staticClass: cls, method };
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
  mode: 'direct' | 'callback' = 'callback'
): Value {
  const target = callTargetOf(callable, mode);
  return invoke(target, bindCallbackArguments(target, args), row);
}

export function callCallback(callable: Value, args: Value[]): Value {
  return callValue(
    callable,
    args.map((v) => ({ v })),
    undefined
  );
}

export function callCallbackRefs(callable: Value, args: ArgValue[]): Value {
  return callValue(callable, args, undefined);
}

function bindCallbackArguments(target: CallTarget, args: ArgValue[]): ArgValue[] {
  return args.map((arg, index) => {
    if (arg.ref || !paramIsByRef(target.fn, index, arg.name)) return arg;
    const namedIndex = arg.name === undefined ? -1 : target.fn.params.findIndex((param) => param.name === arg.name);
    const position = namedIndex >= 0 ? namedIndex : index;
    const param = target.fn.params[Math.min(position, target.fn.params.length - 1)];
    if (param?.preferRef) return arg;
    const label = param?.variadic ? '' : ` ($${param?.name ?? arg.name ?? ''})`;
    warn(
      `${functionDisplayName(target)}(): Argument #${position + 1}${label} must be passed by reference, value given`
    );
    return { ...arg, ref: Ref.temporary(arg.v) };
  });
}

export function closureFromCallable(target: CallTarget): PhpObject {
  const runtime = rt();
  const closureClass = runtime.classes.get('closure') as PhpClass;
  const object = runtime.newObject(closureClass);
  const data: ClosureData = {
    fn: target.fn,
    bound: new Map(),
    thisObj: target.thisObj,
    scope: target.scope,
    calledClass: target.staticClass,
    isStatic: !target.thisObj,
    method: target.method,
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
        runtime.row = e.row;
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
    calledClass: frame.staticClass,
    isStatic,
  } satisfies ClosureData;
  frame.temporaries.push(object);
  return object;
}

// Function bodies ----------------------------------------------------------------------------------------------------

function inlineCall(fn: Callable, args: Arg[]): boolean {
  if (fn.kind !== 'native' || args.some((arg) => arg.spread || arg.name !== undefined)) return false;
  const name = lower(fn.name);
  if (['strval', 'floatval', 'doubleval', 'boolval'].includes(name)) return args.length === 1;
  if (name === 'intval') return args.length === 1;
  if (name === 'sprintf') {
    const format = args[0]?.e;
    if (format?.k !== 'lit' || typeof format.v !== 'string') return false;
    const conversions = format.v.match(/%[sd]/g) ?? [];
    return !format.v.replaceAll(/%[sd]/g, '').includes('%') && args.length === conversions.length + 1;
  }
  if (!fn.inlined) return false;
  if (name === 'array_key_exists') return args.length === 2;
  if (name === 'get_class') return args.length <= 1;
  if (name === 'call_user_func') return args.length > 0;
  if (name === 'call_user_func_array') return args.length === 2;
  return args.length === 1;
}
