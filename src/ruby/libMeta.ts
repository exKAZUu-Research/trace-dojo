import type { Params } from './ast';
import { className, inspect, toStr } from './conversions';
import { def } from './define';
import { argumentError, nameError, typeError } from './errors';
import { hashGet } from './hashes';
import {
  addMethod,
  callMethod,
  callProc,
  constInModule,
  type Gen,
  invoke,
  ivarGet,
  ivarSet,
  methodMissing,
  nativeProc,
  requireBlock,
} from './interp';
import { procArity } from './libObject';
import {
  invalidateMethodCaches,
  NIL,
  RBasic,
  RClass,
  type RMethod,
  RObject,
  RProc,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, classOf, realClassOf, singletonClassOf, str, sym, truthy } from './values';

/** The name a method takes as a Symbol or a String, raising as Ruby does for anything else. */
export function* nameOf(value: Value): Gen<string> {
  if (value instanceof RSymbol) return value.name;
  if (value instanceof RString) return value.s;
  throw typeError(`${yield* inspect(value)} is not a symbol nor a string`);
}

function* ivarName(value: Value): Gen<string> {
  const name = yield* nameOf(value);
  if (!/^@[A-Za-z_\u0080-￿][\w\u0080-￿]*$/u.test(name)) {
    throw nameError(`'${name}' is not allowed as an instance variable name`, NIL, name);
  }
  return name;
}

// Calling by name ------------------------------------------------------------------------------------------------------

def(
  'Kernel',
  ['send', '__send__'],
  [1, -1],
  function* (self, args, block, keywords) {
    const name = yield* nameOf(args[0]);
    return yield* callMethod(self, name, args.slice(1), keywords, block, { fcall: true });
  },
  { keywords: true }
);
def(
  'Kernel',
  'public_send',
  [1, -1],
  function* (self, args, block, keywords) {
    const name = yield* nameOf(args[0]);
    return yield* callMethod(self, name, args.slice(1), keywords, block, { fcall: false });
  },
  { keywords: true }
);

/** `respond_to?`: whether a public (or, with `include_all`, any) method answers, or `respond_to_missing?` says so. */
export function* respondsToName(self: Value, name: string, includeAll: boolean): Gen<boolean> {
  const method = classOf(self).findMethod(name);
  if (method) return includeAll || method.visibility === 'public';
  const missing = classOf(self).findMethod('respond_to_missing?');
  if (missing && missing.body.kind !== 'native') {
    return truthy(yield* invoke(missing, self, [sym(name), includeAll], undefined, undefined, true));
  }
  return false;
}

def('Kernel', 'respond_to?', [1, 2], function* (self, args) {
  return yield* respondsToName(self, yield* nameOf(args[0]), args.length > 1 && truthy(args[1]));
});
def('Kernel', 'respond_to_missing?', 2, () => false, { visibility: 'private' });

// Method objects -------------------------------------------------------------------------------------------------------

interface MethodData {
  recv: Value;
  method: RMethod;
  held(): Value[];
}

function methodObject(recv: Value, method: RMethod): RObject {
  const object = new RObject(rt().c.Method);
  const data: MethodData = {
    recv,
    method,
    held() {
      return [this.recv];
    },
  };
  object.data = data;
  return object;
}

function* findForMethodObject(self: Value, name: string): Gen<RMethod> {
  const method = classOf(self).findMethod(name);
  if (method) return method;
  if (yield* respondsToName(self, name, true)) {
    const missing = classOf(self).findMethod('method_missing') as RMethod;
    return {
      name,
      owner: missing.owner,
      visibility: 'public',
      body: {
        kind: 'proc',
        proc: nativeProc(-1, (args, block) => invoke(missing, self, [sym(name), ...args], undefined, block, true)),
      },
    };
  }
  const description =
    self === rt().mainObject
      ? 'an instance of Object'
      : `${realClassOf(self).name === undefined ? '' : 'an instance of '}${realClassOf(self).name ?? ''}`;
  throw nameError(`undefined method '${name}' for ${description}`, self, name);
}

def('Kernel', ['method', 'public_method'], 1, function* (self, [name]) {
  return methodObject(self, yield* findForMethodObject(self, yield* nameOf(name)));
});
def(
  'Method',
  ['call', '()', '[]', '==='],
  [0, -1],
  function* (self: RObject, args, block, keywords) {
    const { recv, method } = self.data as MethodData;
    return yield* invoke(method, recv, args, keywords, block, true);
  },
  { keywords: true }
);
def('Method', 'to_proc', 0, (self: RObject) => {
  const { recv, method } = self.data as MethodData;
  return nativeProc(methodArity(method), (args, block) => invoke(method, recv, args, undefined, block, true), true);
});
def('Method', 'arity', 0, (self: RObject) => BigInt(methodArity((self.data as MethodData).method)));
def('Method', 'name', 0, (self: RObject) => sym((self.data as MethodData).method.name));
def('Method', 'owner', 0, (self: RObject) => (self.data as MethodData).method.owner);
def('Method', 'receiver', 0, (self: RObject) => (self.data as MethodData).recv);
def('Method', ['inspect', 'to_s'], 0, (self: RObject) => {
  const { recv, method } = self.data as MethodData;
  const owner = method.owner.isSingleton ? `${className(realClassOf(recv))}.` : `${className(method.owner)}#`;
  return str(`#<Method: ${owner}${method.name}(*)>`);
});
def('Method', 'unbind', 0, () => {
  throw typeError('UnboundMethod is not supported');
});

/** What `parameters` lists for parameters a program wrote: each one's kind and, when it has one, its name. */
// code-gauge-allow functionCognitiveComplexity 17 -- Ruby's method takes these argument forms, which the branches mirror.
function parameterList(params: Params, isLambda: boolean): Value {
  const entries: Value[] = [];
  const add = (kind: string, name?: string): void => {
    entries.push(arr(name === undefined ? [sym(kind)] : [sym(kind), sym(name)]));
  };
  const positional = isLambda ? 'req' : 'opt';
  const nameOf = (target: Params['required'][number]): string | undefined =>
    typeof target === 'string' && !(params.implicit && target === 'it') ? target : undefined;
  for (const target of params.required) add(positional, nameOf(target));
  for (const optional of params.optional) add('opt', optional.name);
  if (params.rest !== undefined) add('rest', params.rest);
  for (const target of params.post) add(positional, nameOf(target));
  for (const keyword of params.keywords) add(keyword.value ? 'key' : 'keyreq', keyword.name);
  if (params.noKeywords) add('nokey');
  if (params.keywordRest !== undefined) add('keyrest', params.keywordRest);
  if (params.block !== undefined) add('block', params.block);
  return arr(entries);
}

/** What `parameters` lists for a method or proc implemented natively, which Ruby knows only by its arity. */
function nativeParameterList(arity: number): Value {
  if (arity < 0) return arr([arr([sym('rest')])]);
  return arr(Array.from({ length: arity }, () => arr([sym('req')])));
}

def(
  'Proc',
  'parameters',
  0,
  function* (self: RProc, _args, _block, keywords) {
    const asLambda = keywords ? (yield* hashGet(keywords, sym('lambda')))?.value : undefined;
    const isLambda = asLambda === undefined || asLambda === NIL ? self.isLambda : truthy(asLambda);
    if (self.body.kind === 'native') return nativeParameterList(self.body.arity);
    return self.body.def.params ? parameterList(self.body.def.params, isLambda) : arr([]);
  },
  { keywords: true }
);
def('Method', 'parameters', 0, (self: RObject) => {
  const { method } = self.data as MethodData;
  if (method.body.kind === 'user') return parameterList(method.body.def.params, true);
  if (method.body.kind === 'proc') return callParameters(method.body.proc);
  return nativeParameterList(methodArity(method));
});

function callParameters(proc: RProc): Value {
  if (proc.body.kind === 'native') return nativeParameterList(proc.body.arity);
  return proc.body.def.params ? parameterList(proc.body.def.params, true) : arr([]);
}

function methodArity(method: RMethod): number {
  const { body } = method;
  switch (body.kind) {
    case 'user': {
      const { params } = body.def;
      const required = params.required.length + params.post.length;
      const requiredKeywords = params.keywords.some((keyword) => !keyword.value);
      if (params.rest !== undefined || params.optional.length > 0) return -required - 1 - (requiredKeywords ? 1 : 0);
      return required + (requiredKeywords ? 1 : 0);
    }
    case 'native': {
      return body.min === body.max ? body.min : -body.min - 1;
    }
    case 'reader': {
      return 0;
    }
    case 'writer': {
      return 1;
    }
    case 'proc': {
      return procArity(body.proc);
    }
    default: {
      return 0;
    }
  }
}

// Instance variables ---------------------------------------------------------------------------------------------------

def('Kernel', 'instance_variable_get', 1, function* (self, [name]) {
  return ivarGet(self, yield* ivarName(name));
});
def('Kernel', 'instance_variable_set', 2, function* (self, [name, value]) {
  ivarSet(self, yield* ivarName(name), value);
  return value;
});
def('Kernel', 'instance_variable_defined?', 1, function* (self, [name]) {
  const ivar = yield* ivarName(name);
  return self instanceof RBasic && (self.ivars?.has(ivar) ?? false);
});
def('Kernel', 'instance_variables', 0, (self) => {
  if (!(self instanceof RBasic) || !self.ivars) return arr([]);
  return arr([...self.ivars.keys()].filter((name) => !name.startsWith('@__')).map((name) => sym(name)));
});
def('Kernel', 'remove_instance_variable', 1, function* (self, [name]) {
  const ivar = yield* ivarName(name);
  if (!(self instanceof RBasic) || !self.ivars?.has(ivar)) {
    throw nameError(`instance variable ${ivar} not defined`, self, ivar);
  }
  const value = self.ivars.get(ivar) as Value;
  self.ivars.delete(ivar);
  return value;
});

// Evaluating blocks in another context ---------------------------------------------------------------------------------

/** `instance_eval` and `class_eval` with a string of code, which this grader does not evaluate. */
function refuseStringEval(name: string, args: Value[], block: RProc | undefined): RProc {
  if (!block && args.length > 0) throw new UnsupportedFeatureError(`文字列の評価（${name}）`);
  if (!block) throw argumentError('wrong number of arguments (given 0, expected 1..3)');
  if (args.length > 0) throw argumentError(`wrong number of arguments (given ${args.length}, expected 0)`);
  return block;
}

def('Kernel', 'instance_eval', [0, -1], function* (self, args, block) {
  const body = refuseStringEval('instance_eval', args, block);
  const definee = self instanceof RBasic ? singletonClassOf(self) : undefined;
  return yield* callProc(body, [self], { self, definee });
});
def('Kernel', 'instance_exec', [0, -1], function* (self, args, block) {
  const definee = self instanceof RBasic ? singletonClassOf(self) : undefined;
  return yield* callProc(requireBlock(block), args, { self, definee });
});
def('Module', ['class_eval', 'module_eval'], [0, -1], function* (self: RClass, args, block) {
  return yield* callProc(refuseStringEval('class_eval', args, block), [self], { self, definee: self });
});
def('Module', ['class_exec', 'module_exec'], [0, -1], function* (self: RClass, args, block) {
  return yield* callProc(requireBlock(block), args, { self, definee: self });
});
def('Kernel', 'define_singleton_method', [1, 2], function* (self, args, block) {
  if (!(self instanceof RBasic)) throw typeError("can't define singleton");
  return yield* defineMethodFrom(singletonClassOf(self), args, block, 'public');
});

// Defining methods -----------------------------------------------------------------------------------------------------

function* defineMethodFrom(
  owner: RClass,
  args: Value[],
  block: RProc | undefined,
  visibility: 'public' | 'private'
): Gen {
  const name = yield* nameOf(args[0]);
  const body = args.length > 1 ? args[1] : requireBlock(block);
  let method: RMethod;
  if (body instanceof RProc) {
    method = { name, owner, visibility, body: { kind: 'proc', proc: body } };
  } else if (body instanceof RObject && body.cls === rt().c.Method) {
    method = { ...(body.data as MethodData).method, name, owner, visibility };
  } else {
    throw typeError(`wrong argument type ${realClassOf(body).name} (expected Proc/Method/UnboundMethod)`);
  }
  addMethod(owner, method);
  return sym(name);
}

def('Module', 'define_method', [1, 2], function* (self: RClass, args, block) {
  const frame = rt().frame;
  const visibility =
    frame.kind === 'class' && frame.self === self && frame.defaultVisibility === 'private' ? 'private' : 'public';
  return yield* defineMethodFrom(self, args, block, visibility);
});
def('Module', 'alias_method', 2, function* (self: RClass, [newName, oldName]) {
  const name = yield* nameOf(newName);
  const old = yield* nameOf(oldName);
  const method = self.findMethod(old);
  if (!method) throw nameError(`undefined method '${old}' for class '${className(self)}'`, self, old);
  // An alias keeps the original method, whose owner and name `super` in it continues from.
  self.methods.set(name, { ...method });
  invalidateMethodCaches();
  return sym(name);
});
def('Module', 'remove_method', [0, -1], function* (self: RClass, names) {
  for (const value of names) {
    const name = yield* nameOf(value);
    if (!self.methods.delete(name)) {
      throw nameError(`method '${name}' not defined in ${className(self)}`, self, name);
    }
  }
  invalidateMethodCaches();
  return self;
});
def('Module', 'undef_method', [0, -1], function* (self: RClass, names) {
  for (const value of names) {
    const name = yield* nameOf(value);
    if (!self.findMethod(name)) {
      throw nameError(`undefined method '${name}' for class '${className(self)}'`, self, name);
    }
    addMethod(self, { name, owner: self, visibility: 'public', body: { kind: 'undefined' } });
  }
  return self;
});
def('Module', ['method_defined?', 'public_method_defined?'], [1, 2], function* (self: RClass, [name]) {
  const method = self.findMethod(yield* nameOf(name));
  return method !== undefined && method.visibility !== 'private';
});
def('Module', 'private_method_defined?', [1, 2], function* (self: RClass, [name]) {
  return self.findMethod(yield* nameOf(name))?.visibility === 'private';
});
def('Module', 'protected_method_defined?', [1, 2], function* (self: RClass, [name]) {
  return self.findMethod(yield* nameOf(name))?.visibility === 'protected';
});
def('Module', 'instance_method', 1, function* (self: RClass, [name]) {
  const methodName = yield* nameOf(name);
  const method = self.findMethod(methodName);
  if (!method) throw nameError(`undefined method '${methodName}' for class '${className(self)}'`, self, methodName);
  const unbound = methodObject(NIL, method);
  unbound.cls = rt().c.UnboundMethod;
  return unbound;
});
def('UnboundMethod', 'bind', 1, function* (self: RObject, [recv]) {
  return methodObject(recv, (self.data as MethodData).method);
});
def('UnboundMethod', 'name', 0, (self: RObject) => sym((self.data as MethodData).method.name));
def('UnboundMethod', 'owner', 0, (self: RObject) => (self.data as MethodData).method.owner);
def(
  'BasicObject',
  'method_missing',
  [1, -1],
  (self, [name]) => {
    methodMissing(self, (name as RSymbol).name, {});
  },
  { visibility: 'private' }
);
def('Module', 'prepend', [1, -1], function* (self: RClass, modules) {
  for (const module of modules) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
  }
  for (const module of modules.toReversed() as RClass[]) {
    if (self.prepends.includes(module)) continue;
    self.prepends.unshift(module);
    invalidateMethodCaches();
    const hook = classOf(module).findMethod('prepended');
    if (hook && hook.body.kind === 'user') yield* invoke(hook, module, [self], undefined, undefined, false);
  }
  return self;
});

// Constants and class variables ----------------------------------------------------------------------------------------

function* constantName(value: Value): Gen<string> {
  const name = yield* nameOf(value);
  if (!/^[A-Z][\w\u0080-￿]*$/u.test(name)) throw nameError(`wrong constant name ${name}`, NIL, name);
  return name;
}

def('Module', 'const_get', [1, 2], function* (self: RClass, [name]) {
  let module: Value = self;
  for (const part of (yield* nameOf(name)).split('::')) {
    if (!(module instanceof RClass)) throw typeError(`${yield* inspect(module)} is not a class/module`);
    module = constInModule(module, yield* constantName(str(part)));
  }
  return module;
});
def('Module', 'const_set', 2, function* (self: RClass, [name, value]) {
  const constant = yield* constantName(name);
  self.constants.set(constant, value);
  if (value instanceof RClass && value.baseName === undefined) {
    value.baseName = constant;
    if (self !== rt().c.Object) value.lexicalParent = self;
  }
  return value;
});
def('Module', 'const_defined?', [1, 2], function* (self: RClass, [name]) {
  const constant = yield* nameOf(name);
  return self.ancestors().some((module) => module.constants.has(constant)) || rt().c.Object.constants.has(constant);
});
def('Module', 'constants', [0, 1], (self: RClass) => arr([...self.constants.keys()].map((name) => sym(name))));
def('Module', 'class_variable_get', 1, function* (self: RClass, [name]) {
  const variable = yield* toStr(str(yield* nameOf(name)));
  for (const module of self.ancestors()) {
    const value = module.classVariables.get(variable);
    if (value !== undefined) return value;
  }
  throw nameError(`uninitialized class variable ${variable} in ${className(self)}`, self, variable);
});
def('Module', 'class_variable_set', 2, function* (self: RClass, [name, value]) {
  self.classVariables.set(yield* nameOf(name), value);
  return value;
});
def('Module', 'class_variable_defined?', 1, function* (self: RClass, [name]) {
  const variable = yield* nameOf(name);
  return self.ancestors().some((module) => module.classVariables.has(variable));
});
def('Module', 'class_variables', [0, 1], (self: RClass) => {
  const names = new Set<string>();
  for (const module of self.ancestors()) for (const name of module.classVariables.keys()) names.add(name);
  return arr([...names].map((name) => sym(name)));
});
