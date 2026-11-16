// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { placeOf } from './assignment';
import type { Arg, Expr } from './ast';
import { lower } from './bytes';
import { type ArgValue, type CallTarget, closureFunction, invoke, paramIsByRef } from './calls';
import { canCall, lookupMethod, requireClass } from './classes';
import { debugType } from './conversions';
import { notice, throwError, warn } from './errors';
import { type Chain, ev, evChain, iterate, resolveClassRef, SHORT } from './interp';
import { toStr } from './operators';
import { ElementPlace, share, VarPlace } from './places';
import { type Frame, rt } from './runtime';
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
// code-gauge-allow functionNcss 54 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function evalArgs(args: Arg[], fn: Callable | undefined, name: string | undefined): ArgValue[] {
  const runtime = rt();
  const values: ArgValue[] = [];
  const frame = runtime.frame;
  for (const [index, arg] of args.entries()) {
    if (arg.spread) {
      const value = ev(arg.e);
      if (value instanceof PhpArray) {
        for (const [key, item] of value.entries()) {
          if (typeof key === 'string') values.push({ v: share(item), name: key });
          else {
            if (values.some((other) => other.name !== undefined)) {
              throwError('Error', 'Cannot use positional argument after named argument during unpacking');
            }
            const position = values.length;
            if (fn && paramIsByRef(fn, position)) values.push({ v: item, ref: new ElementPlace(value, key).ref() });
            else values.push({ v: share(item) });
          }
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
      const value = ev(e);
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
    if (!fn) throwError('Error', `Call to undefined function ${name.name}()`);
    if (e.fcc) return closureFromCallable({ fn });
    const args = evalArgs(e.args, fn, fn.name);
    runtime.row = e.row;
    const result = invoke({ fn }, args, e.row);
    runtime.frame.temporaries.push(result);
    return result;
  }
  const callee = ev(e.fn);
  runtime.row = e.row;
  const target = callTargetOf(callee, true);
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
  if (!(object instanceof PhpObject)) {
    throwError('Error', `Call to a member function ${methodName}() on ${debugType(object)}`);
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
  throwError(
    'Error',
    `Call to undefined method ${object.cls.isAnonymous ? 'class@anonymous' : object.cls.name}::${methodName}()`
  );
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
    params: [{ name: 'args', byRef: false, variadic: true, optional: true }],
    impl: ({ args }) =>
      invoke(
        { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: cls, method: magic },
        [{ v: name }, { v: PhpArray.list(args) }],
        undefined
      ),
  };
}

// code-gauge-allow functionCognitiveComplexity 25 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
// code-gauge-allow functionNcss 42 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
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

/**
 * The function a callable value names: a closure, an invokable object, a function name, `"Class::method"`, or
 * `[$objectOrClass, "method"]`.
 */
// code-gauge-allow functionNcss 38 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
export function callTargetOf(value: Value, forCall: boolean): CallTarget {
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
    if (forCall) throwError('Error', 'Object of type ' + value.cls.name + ' is not callable');
    throwError('Error', 'Object of type ' + value.cls.name + ' is not callable');
  }
  if (typeof value === 'string') {
    const separator = value.indexOf('::');
    if (separator !== -1) return staticCallable(value.slice(0, separator), value.slice(separator + 2), scope);
    const fn = runtime.functions.get(lower(value.startsWith('\\') ? value.slice(1) : value));
    if (!fn) throwError('Error', `Call to undefined function ${value}()`);
    return { fn };
  }
  if (value instanceof PhpArray && value.size === 2) {
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
        throwError(
          'Error',
          `Call to ${found.visibility} method ${target.cls.name}::${found.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
        );
      throwError('Error', `Call to undefined method ${target.cls.name}::${method}()`);
    }
    if (typeof method === 'string' && typeof target === 'string') return staticCallable(target, method, scope);
  }
  if (value instanceof PhpArray) throwError('Error', 'Array callback must have exactly two elements');
  throwError('Error', 'Value not callable');
}

function magicTarget(object: PhpObject, magic: Method, name: string): CallTarget {
  return { fn: magicForwarder(magic, name, object, object.cls), thisObj: object };
}

// code-gauge-allow functionCognitiveComplexity 22 -- Resolves each form of call and callable by PHP's lookup rules, in PHP's order of checks.
function staticCallable(className: string, methodName: string, scope: PhpClass | undefined): CallTarget {
  const frame = rt().frame;
  let cls: PhpClass;
  const word = lower(className);
  if (word === 'self' || word === 'static' || word === 'parent') {
    if (!frame.scope) throwError('Error', `Cannot use "${word}" when no class scope is active`);
    cls =
      word === 'self'
        ? frame.scope
        : word === 'parent'
          ? (frame.scope.parent as PhpClass)
          : (frame.staticClass as PhpClass);
  } else cls = requireClass(className);
  const method = lookupMethod(cls, lower(methodName), scope);
  if (!method) {
    const magic = cls.findMethod('__callstatic');
    if (magic) return { fn: magicForwarder(magic, methodName, undefined, cls), staticClass: cls };
    throwError('Error', `Call to undefined method ${cls.name}::${methodName}()`);
  }
  if (!canCall(method, scope))
    throwError(
      'Error',
      `Call to ${method.visibility} method ${cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  if (!method.isStatic) {
    const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
    if (!thisObj)
      throwError('Error', `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`);
    return { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
  }
  return { fn: method.fn, scope: method.scope, staticClass: cls, method };
}

/** Calls a callable value with arguments already evaluated, as `call_user_func` and `$f(...)` do. */
export function callValue(callable: Value, args: ArgValue[], row: number | undefined): Value {
  const target = callTargetOf(callable, true);
  const bound = args.map((arg, index) => {
    if (arg.ref) return arg;
    if (paramIsByRef(target.fn, index, arg.name) && target.fn.kind === 'user') {
      return { ...arg, ref: new Ref(arg.v) };
    }
    return arg;
  });
  return invoke(target, bound, row);
}

/** Calls a callback from native code, such as `array_map`'s, whose frames show as `[internal function]`. */
export function callCallback(callable: Value, args: Value[]): Value {
  const target = callTargetOf(callable, true);
  return invoke(
    target,
    args.map((v) => ({ v })),
    undefined
  );
}

/** Calls a callback with references for its by-reference parameters, as `array_walk` does. */
export function callCallbackRefs(callable: Value, args: ArgValue[]): Value {
  const target = callTargetOf(callable, true);
  return invoke(target, args, undefined);
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
