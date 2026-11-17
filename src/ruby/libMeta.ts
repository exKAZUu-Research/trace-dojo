// code-gauge-allow-file fileNcss 611 -- Reflection and encoded constant lookup share representation and state; splitting registration by size would scatter that concern.
import type { Params } from './ast';
import { prependHierarchy } from './classHierarchy';
import { getClassVariable, hasClassVariable, setClassVariable } from './classVariables';
import { addressOf, className, inspect, inspectValue, toSValue, tryImplicitConversion } from './conversions';
import { def, findCoreMethod, isCoreMethod, sdef, sundef } from './define';
import { EncodedStringBuilder } from './encodedStringJoin';
import { argumentError, frozenError, nameError, rubyError, typeError, undefinedMethodError } from './errors';
import { validateKeywords } from './exceptionOption';
import { digest, hashGet } from './hashes';
import { internId } from './internedIds';
import {
  addMethod,
  assertMutableClass,
  assertNoDefinitionHook,
  callMethod,
  callProc,
  constInModule,
  constSet,
  type Gen,
  invoke,
  ivarGet,
  ivarSet,
  missingConstant,
  nativeProc,
  PRIVATE_METHOD_NAMES,
  raiseMethodMissing,
  requireBlock,
} from './interp';
import { procArity } from './libObject';
import { inspectStringEncoding, symbolFromString, symbolNameString, symbolString } from './libString';
import { nativeOwners } from './nativeOwners';
import { type NativeSignature, nativeSignatures } from './nativeSignatures';
import {
  invalidateMethodCaches,
  type NativeFn,
  NIL,
  RBasic,
  RClass,
  type RMethod,
  RObject,
  RProc,
  RString,
  RSymbol,
  type Value,
  type Visibility,
} from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { isEncodingPrintable } from './unicodeText';
import {
  arr,
  classOf,
  isA,
  realClassOf,
  requireObjectIdentity,
  sameIdentity,
  singletonClassOf,
  singletonDefinitionClass,
  str,
  stringBytes,
  sym,
  truthy,
} from './values';

for (const owner of ['Method', 'UnboundMethod']) {
  sundef(owner, 'new');
  sdef(owner, 'allocate', 0, () => {
    throw typeError(`allocator undefined for ${owner}`);
  });
}

export function* methodKeyOf(value: Value, intern = false): Gen<string> {
  const name = (yield* symbolNameOf(value, true)).key;
  if (intern) internId(name);
  return name;
}

export function* symbolNameOf(value: Value, identifier = false): Gen<RSymbol> {
  const input = yield* symbolNameInput(value);
  return input instanceof RSymbol ? input : identifier ? identifierSymbol(input) : symbolFromString(input);
}

function* symbolNameInput(value: Value): Gen<RSymbol | RString> {
  if (value instanceof RSymbol || value instanceof RString) return value;
  const converted = yield* tryImplicitConversion(value, 'to_str');
  if (converted instanceof RString) return converted;
  if (converted !== undefined && converted !== NIL) {
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
  }
  throw typeError(`${yield* inspect(value)} is not a symbol nor a string`);
}

export function identifierSymbol(value: RString): RSymbol {
  if (value.usAscii && stringBytes(value).some((byte) => byte >= 128))
    throw rubyError(rt().c.EncodingError, `invalid symbol in encoding US-ASCII :${inspectStringEncoding(value)}`);
  return symbolFromString(value);
}

function* ivarName(value: Value): Gen<string> {
  const symbol = yield* symbolNameOf(value, true);
  const name = symbol.name;
  if (!/^@[A-Za-z_\u0080-\u{10FFFF}][\w\u0080-\u{10FFFF}]*$/u.test(name)) {
    throw nameError(`'${name}' is not allowed as an instance variable name`, NIL, name);
  }
  return symbol.key;
}

function* classVariableName(value: Value): Gen<string> {
  const symbol = yield* symbolNameOf(value, true);
  const name = symbol.name;
  if (!/^@@[A-Za-z_\u0080-\u{10FFFF}][\w\u0080-\u{10FFFF}]*$/u.test(name))
    throw nameError(`'${name}' is not allowed as a class variable name`, NIL, name);
  return symbol.key;
}

// Calling by name ------------------------------------------------------------------------------------------------------

const sendByName: NativeFn = function* (self, args, block, keywords, used) {
  const name = yield* methodKeyOf(args[0]);
  return yield* callMethod(self, name, args.slice(1), keywords, block, { fcall: true, used });
};
def('Kernel', 'send', [1, -1], sendByName, { keywords: true });
def('BasicObject', '__send__', [1, -1], sendByName, { keywords: true });
def(
  'Kernel',
  'public_send',
  [1, -1],
  function* (self, args, block, keywords, used) {
    const name = yield* methodKeyOf(args[0]);
    return yield* callMethod(self, name, args.slice(1), keywords, block, { publicOnly: true, used });
  },
  { keywords: true }
);

/** `respond_to?`: whether a public (or, with `include_all`, any) method answers, or `respond_to_missing?` says so. */
export function* respondsToName(self: Value, name: string, includeAll: boolean): Gen<boolean> {
  const method = classOf(self).findMethod(name);
  if (method && (includeAll || method.visibility === 'public')) return true;
  const missing = classOf(self).findMethod('respond_to_missing?');
  if (missing && !isCoreMethod(missing, rt().c.Kernel, 'respond_to_missing?')) {
    return truthy(yield* invoke(missing, self, [sym(name), includeAll], undefined, undefined, true));
  }
  return false;
}

export function* advertisesPublicMethod(self: Value, name: string): Gen<boolean> {
  const responder = classOf(self).findMethod('respond_to?');
  if (responder && (responder.body.kind !== 'native' || !('builtinResponder' in responder.body.fn))) {
    return truthy(yield* invoke(responder, self, [sym(name)], undefined, undefined, true));
  }
  return yield* respondsToName(self, name, false);
}

const builtinRespondTo = Object.assign(
  function* (self: Value, args: Value[]): Gen<boolean> {
    return yield* respondsToName(self, yield* methodKeyOf(args[0]), args.length > 1 && truthy(args[1]));
  },
  { builtinResponder: true }
);
def('Kernel', 'respond_to?', [1, 2], builtinRespondTo);
def('Kernel', 'respond_to_missing?', 2, () => false, { visibility: 'private' });

// Method objects -------------------------------------------------------------------------------------------------------

interface MethodData {
  recv: Value;
  method: RMethod;
  owner: RClass;
  moduleBound: boolean;
  name: string;
  held(): Value[];
}

function methodObject(
  recv: Value,
  method: RMethod,
  name = method.name,
  owner = methodReflectionOwner(method, classOf(recv)),
  moduleBound = false
): RObject {
  if (method.body.kind === 'native') method = { ...method, nativeIdentityOwner: method.nativeIdentityOwner ?? owner };
  const object = new RObject(rt().c.Method);
  const data: MethodData = {
    recv,
    method,
    owner,
    moduleBound,
    name,
    held() {
      return [
        this.recv,
        this.owner,
        this.method.owner,
        ...(this.method.body.kind === 'proc' ? [this.method.body.proc] : []),
      ];
    },
  };
  object.data = data;
  return object;
}

function methodReflectionOwner(method: RMethod, receiverClass: RClass): RClass {
  if (method.reflectionOwner) return method.reflectionOwner;
  if (method.body.kind !== 'native' || method.missing || method.owner.isSingleton) return method.owner;
  for (const ancestor of receiverClass.ancestors()) {
    const owner = nativeOwners[`${ancestor.name}#${method.name}`];
    if (owner) return rt().c[owner];
  }
  return method.owner;
}

export function aliasedMethod(method: RMethod, owner: RClass): RMethod {
  return {
    ...method,
    reflectionOwner: owner,
    nativeIdentityOwner:
      method.body.kind === 'native' ? (method.nativeIdentityOwner ?? methodReflectionOwner(method, owner)) : undefined,
  };
}

function methodIdentity(value: object): number {
  const runtime = rt();
  let id = runtime.methodHashIds.get(value);
  if (id === undefined) {
    id = runtime.nextMethodHashId++;
    runtime.methodHashIds.set(value, id);
  }
  return id;
}

function methodBodyIdentity(method: RMethod, owner: RClass): object {
  if (method.missing) return sym(method.name);
  const { body } = method;
  if (body.kind !== 'native') return body;
  const canonical = findCoreMethod(method.nativeIdentityOwner ?? owner, method.name);
  const fn = canonical?.body.kind === 'native' ? canonical.body.fn : body.fn;
  return fn.nativeIdentity ?? fn;
}

function reflectedCallable(method: RMethod, owner: RClass, recv: Value): RMethod {
  if (method.body.kind !== 'native' || method.missing || isA(recv, method.owner)) return method;
  const canonical = findCoreMethod(method.nativeIdentityOwner ?? owner, method.name);
  return canonical?.body.kind === 'native' && !('unavailable' in canonical.body.fn)
    ? { ...method, body: canonical.body }
    : method;
}

function* findForMethodObject(self: Value, name: string, publicOnly = false): Gen<RMethod> {
  const method = classOf(self).findMethod(name);
  if (method) {
    if (!publicOnly || method.visibility === 'public') return method;
    throw nameError(`method '${name}' for class '${realClassOf(self).name}' is ${method.visibility}`, self, name);
  }
  if (yield* respondsToName(self, name, !publicOnly)) {
    return {
      name,
      owner: classOf(self),
      missing: true,
      visibility: 'public',
      body: {
        kind: 'native',
        fn: (recv, args, block, keywords, used) =>
          callMethod(recv, 'method_missing', [sym(name), ...args], keywords, block, { fcall: true, used }),
        min: 0,
        max: -1,
        takesKeywords: true,
      },
    };
  }
  const receiverClass = self === rt().mainObject ? `#<Class:#<Object:${addressOf(self)}>>` : className(classOf(self));
  const description = `class '${receiverClass}'`;
  throw nameError(`undefined method '${name}' for ${description}`, self, name);
}

def('Kernel', 'method', 1, function* (self, [name]) {
  const requested = yield* methodKeyOf(name);
  return methodObject(self, yield* findForMethodObject(self, requested), requested);
});
def('Kernel', 'public_method', 1, function* (self, [name]) {
  const requested = yield* methodKeyOf(name);
  return methodObject(self, yield* findForMethodObject(self, requested, true), requested);
});
def(
  'Method',
  ['call', '()', '[]', '==='],
  [0, -1],
  function* (self: RObject, args, block, keywords, used) {
    const { recv, method, owner } = self.data as MethodData;
    return yield* invoke(reflectedCallable(method, owner, recv), recv, args, keywords, block, used);
  },
  { keywords: true }
);
def('Method', 'to_proc', 0, (self: RObject) => {
  const { recv, method, owner } = self.data as MethodData;
  const proc = nativeProc(
    methodArity(method),
    (args, block, used, keywords) => invoke(reflectedCallable(method, owner, recv), recv, args, keywords, block, used),
    true,
    true
  );
  proc.captured = [recv, method.owner, ...(method.body.kind === 'proc' ? [method.body.proc] : [])];
  proc.reflectedMethod = method;
  return proc;
});
def('Method', 'receiver', 0, (self: RObject) => (self.data as MethodData).recv);
def('Method', 'unbind', 0, (self: RObject) => {
  const { method, name, owner } = self.data as MethodData;
  return unboundMethod(method, name, owner);
});

function unboundMethod(method: RMethod, name: string, owner: RClass): RObject {
  const unbound = methodObject(NIL, method, name, owner);
  unbound.cls = rt().c.UnboundMethod;
  return unbound;
}

function* methodDescription(self: RObject): Gen<RString> {
  const { recv, method, name, owner: definingOwner, moduleBound } = self.data as MethodData;
  const unbound = self.cls === rt().c.UnboundMethod;
  const inspectedOwner = method.reflectionOwner ? (method.nativeIdentityOwner ?? method.owner) : definingOwner;
  const builder = new EncodedStringBuilder();
  const kind = unbound ? 'UnboundMethod' : 'Method';
  builder.append(methodDescriptionText(`#<${kind}: `));
  yield* appendMethodOwner(builder, inspectedOwner, recv, unbound || moduleBound);
  const definition =
    method.body.kind === 'user'
      ? method.body.def
      : method.body.kind === 'proc' && method.body.proc.body.kind === 'block'
        ? method.body.proc.body.def
        : undefined;
  const params = definition?.params;
  const signature = params
    ? methodParameterSignature(params)
    : methodArity(method) < 0
      ? '*'
      : Array.from({ length: methodArity(method) }, () => '_').join(', ');
  const row = definition?.row ?? method.row;
  builder.append(symbolString(sym(name)));
  if (name !== method.name) {
    builder.append(methodDescriptionText('('));
    builder.append(symbolString(sym(method.name)));
    builder.append(methodDescriptionText(')'));
  }
  builder.append(str(`(${signature})${row === undefined ? '' : ` main.rb:${row + 1}`}>`));
  return builder.finish();
}

// code-gauge-allow functionCognitiveComplexity 20 -- Ruby renders named, anonymous, forwarding, destructured and no-keyword parameter kinds differently.
function methodParameterSignature(params: Params): string {
  if (
    params.rest === '*' &&
    params.keywordRest === '**' &&
    params.block === '&' &&
    params.required.length + params.optional.length + params.post.length + params.keywords.length === 0
  )
    return '...';
  const signature = [
    ...params.required.map((param) => (typeof param === 'string' ? param : '_')),
    ...params.optional.map((param) => `${param.name}=...`),
    ...(params.rest === undefined ? [] : [params.rest === '*' ? '*' : `*${params.rest}`]),
    ...params.post.map((param) => (typeof param === 'string' ? param : '_')),
    ...params.keywords.map((param) => `${param.name}:${param.value ? ' ...' : ''}`),
  ];
  if (params.keywordRest !== undefined && (params.keywordRest !== '**' || signature.length === 0))
    signature.push(params.keywordRest === '**' ? '**' : `**${params.keywordRest}`);
  if (params.noKeywords) signature.push('**nil');
  if (params.block !== undefined) signature.push(params.block === '&' ? '...' : `&${params.block}`);
  return signature.join(', ');
}

function* appendMethodOwner(
  builder: EncodedStringBuilder,
  definingOwner: RClass,
  recv: Value,
  unbound: boolean
): Gen<void> {
  if (unbound) {
    builder.append(yield* methodObjectLabel(definingOwner));
    builder.append(methodDescriptionText('#'));
    return;
  }
  if (!definingOwner.isSingleton) {
    const receiverClass =
      recv instanceof RClass && (!recv.isModule || recv.singletonExposed) ? classOf(recv) : realClassOf(recv);
    builder.append(yield* methodObjectLabel(receiverClass));
    if (receiverClass !== definingOwner) {
      builder.append(methodDescriptionText('('));
      builder.append(methodInspectionLabel(yield* toSValue(definingOwner), 'quoted'));
      builder.append(methodDescriptionText(')'));
    }
    builder.append(methodDescriptionText('#'));
    return;
  }
  const attached = definingOwner.attached as Value;
  builder.append(yield* methodObjectLabel(recv));
  if (recv !== attached) {
    builder.append(methodDescriptionText('('));
    builder.append(yield* methodObjectLabel(attached));
    builder.append(methodDescriptionText(')'));
  }
  builder.append(methodDescriptionText('.'));
}

function* methodObjectLabel(value: Value): Gen<RString> {
  return methodInspectionLabel(yield* inspectValue(value));
}

function methodInspectionLabel(value: RString, mode: 'inspect' | 'quoted' = 'inspect'): RString {
  const byteEncoding = value.binary || value.usAscii;
  const codes = byteEncoding ? [...stringBytes(value)] : Array.from(value.s, (char) => char.codePointAt(0)!);
  if (
    !(byteEncoding && codes.some((code) => code >= 128)) &&
    !(mode === 'quoted' && codes.some((code) => !isEncodingPrintable(code)))
  )
    return value;
  const controls: Record<number, string> = {
    0: String.raw`\0`,
    7: String.raw`\a`,
    8: String.raw`\b`,
    9: String.raw`\t`,
    10: String.raw`\n`,
    11: String.raw`\v`,
    12: String.raw`\f`,
    13: String.raw`\r`,
    27: String.raw`\e`,
    127: String.raw`\c?`,
  };
  const parts: string[] = [];
  let length = 0;
  for (const code of codes) {
    const part = controls[code] ?? methodEscapedCharacter(code, byteEncoding);
    length += part.length;
    rt().checkStringLength(length);
    if (parts.length % 256 === 0) rt().spend();
    parts.push(part);
  }
  return methodDescriptionText(parts.join(''));
}

function methodEscapedCharacter(code: number, byteEncoding: boolean): string {
  if (code >= 32 && code < 127) return String.fromCodePoint(code);
  if (byteEncoding || (code >= 0xdc_80 && code <= 0xdc_ff))
    return `\\x${(code & 255).toString(16).toUpperCase().padStart(2, '0')}`;
  const hex = code.toString(16).toUpperCase();
  return code < 0x1_00_00 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
}

function methodDescriptionText(text: string): RString {
  const value = str(text);
  value.binary = true;
  return value;
}

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
function nativeParameterList(arity: number, required = 0): Value {
  if (arity < 0) return arr([...Array.from({ length: required }, () => arr([sym('req')])), arr([sym('rest')])]);
  return arr(Array.from({ length: arity }, () => arr([sym('req')])));
}

def(
  'Proc',
  'parameters',
  0,
  function* (self: RProc, _args, _block, keywords) {
    yield* validateKeywords(keywords, ['lambda']);
    const asLambda = keywords ? (yield* hashGet(keywords, sym('lambda')))?.value : undefined;
    const isLambda = asLambda === undefined || asLambda === NIL ? self.isLambda : truthy(asLambda);
    if (self.reflectedMethod) return methodParameterList(self.reflectedMethod, isLambda);
    if (self.body.kind === 'native') return nativeParameterList(self.body.arity, self.nativeRequired);
    return self.body.def.params ? parameterList(self.body.def.params, isLambda) : arr([]);
  },
  { keywords: true }
);
function callParameters(proc: RProc, isLambda = true): Value {
  if (proc.body.kind === 'native') return nativeParameterList(proc.body.arity, proc.nativeRequired);
  return proc.body.def.params ? parameterList(proc.body.def.params, isLambda) : arr([]);
}

function methodParameterList(method: RMethod, isLambda = true): Value {
  if (method.body.kind === 'user') return parameterList(method.body.def.params, isLambda);
  if (method.body.kind === 'proc') return callParameters(method.body.proc, isLambda);
  const parameters = nativeSignature(method)?.parameters;
  return parameters
    ? arr(parameters.map(([kind, name]) => arr(name === undefined ? [sym(kind)] : [sym(kind), sym(name)])))
    : nativeParameterList(methodArity(method));
}

for (const owner of ['Method', 'UnboundMethod']) {
  def(owner, ['==', 'eql?'], 1, (self: RObject, [other]) => {
    if (!(other instanceof RObject) || other.cls !== self.cls) return false;
    const left = self.data as MethodData;
    const right = other.data as MethodData;
    if (left === right) return true;
    const equal =
      sameIdentity(left.recv, right.recv) &&
      left.moduleBound === right.moduleBound &&
      (left.method.body.kind === 'native'
        ? (left.method.nativeIdentityOwner ?? left.owner) === (right.method.nativeIdentityOwner ?? right.owner)
        : left.method.owner === right.method.owner) &&
      methodBodyIdentity(left.method, left.owner) === methodBodyIdentity(right.method, right.owner);
    if (!equal) return false;
    requireObjectIdentity(left.recv);
    return true;
  });
  def(owner, 'hash', 0, (self: RObject) => {
    const { recv, method, owner: definingOwner } = self.data as MethodData;
    requireObjectIdentity(recv);
    const receiver =
      recv instanceof RBasic
        ? `o${methodIdentity(recv)}`
        : recv instanceof RSymbol
          ? `s${recv.id}`
          : typeof recv === 'bigint' || typeof recv === 'number' || typeof recv === 'boolean'
            ? `${typeof recv}:${recv}`
            : 'nil';
    return BigInt(
      `0x${digest(`${receiver}:${methodIdentity(method.body.kind === 'native' ? (method.nativeIdentityOwner ?? definingOwner) : method.owner)}:${methodIdentity(methodBodyIdentity(method, definingOwner))}`)}`
    );
  });
  def(owner, 'arity', 0, (self: RObject) => BigInt(methodArity((self.data as MethodData).method)));
  def(owner, 'parameters', 0, (self: RObject) => {
    return methodParameterList((self.data as MethodData).method);
  });
  def(owner, 'name', 0, (self: RObject) => sym((self.data as MethodData).name));
  def(owner, 'owner', 0, (self: RObject) => (self.data as MethodData).owner);
  def(owner, ['inspect', 'to_s'], 0, function* (self: RObject) {
    return yield* methodDescription(self);
  });
  def(owner, 'source_location', 0, () => {
    throw new UnsupportedFeatureError(`${owner}#source_location`);
  });
}

export function methodArity(method: RMethod): number {
  const { body } = method;
  switch (body.kind) {
    case 'user': {
      return methodParamsArity(body.def.params);
    }
    case 'native': {
      return nativeSignature(method)?.arity ?? (body.min === body.max ? body.min : -1);
    }
    case 'reader': {
      return 0;
    }
    case 'writer': {
      return 1;
    }
    case 'proc': {
      return body.proc.body.kind === 'native' ? procArity(body.proc) : methodParamsArity(body.proc.body.def.params);
    }
    default: {
      return 0;
    }
  }
}

function nativeSignature(method: RMethod): NativeSignature | undefined {
  const owner = method.nativeIdentityOwner ?? method.owner;
  const name = owner.isSingleton && owner.attached instanceof RClass ? `${owner.attached.name}.` : `${owner.name}#`;
  return method.nativeSignature ?? nativeSignatures[name + method.name];
}

function methodParamsArity(params: Params | undefined): number {
  if (!params) return 0;
  const positional = params.required.length + params.post.length;
  const requiredKeywords = params.keywords.some((keyword) => !keyword.value);
  const required = positional + Number(requiredKeywords);
  if (params.rest !== undefined || params.optional.length > 0) return -required - 1;
  if (!requiredKeywords && (params.keywords.length > 0 || params.keywordRest !== undefined)) return -required - 1;
  return required;
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
  return arr([...self.ivars.keys()].map((name) => sym(name)));
});
def('Kernel', 'remove_instance_variable', 1, function* (self, [name]) {
  const ivar = yield* ivarName(name);
  if (self instanceof RBasic && self.frozen) throw frozenError(self, yield* inspect(self));
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

def('BasicObject', 'instance_eval', [0, -1], function* (self, args, block, _keywords, used) {
  const body = refuseStringEval('instance_eval', args, block);
  const definee = singletonDefinitionClass(self);
  return yield* callProc(body, [self], { self, definee, forbidSingletonDefinition: !definee, used });
});
def(
  'BasicObject',
  'instance_exec',
  [0, -1],
  function* (self, args, block, keywords, used) {
    const definee = singletonDefinitionClass(self);
    return yield* callProc(requireBlock(block, rt().c.LocalJumpError, 'no block given'), args, {
      self,
      definee,
      keywords,
      forbidSingletonDefinition: !definee,
      used,
    });
  },
  { keywords: true }
);
def('Module', ['class_eval', 'module_eval'], [0, -1], function* (self: RClass, args, block, _keywords, used) {
  return yield* callProc(refuseStringEval('class_eval', args, block), [self], { self, definee: self, used });
});
def(
  'Module',
  ['class_exec', 'module_exec'],
  [0, -1],
  function* (self: RClass, args, block, keywords, used) {
    return yield* callProc(requireBlock(block, rt().c.LocalJumpError, 'no block given'), args, {
      self,
      definee: self,
      keywords,
      used,
    });
  },
  { keywords: true }
);
def('Kernel', 'define_singleton_method', [1, 2], function* (self, args, block) {
  const owner = singletonDefinitionClass(self);
  if (!owner) throw typeError("can't define singleton");
  return yield* defineMethodFrom(owner, args, block, 'public');
});

// Defining methods -----------------------------------------------------------------------------------------------------

function* defineMethodFrom(owner: RClass, args: Value[], block: RProc | undefined, visibility: Visibility): Gen {
  const name = yield* methodKeyOf(args[0], true);
  if (!owner.isSingleton && PRIVATE_METHOD_NAMES.has(name)) visibility = 'private';
  const body =
    args.length > 1
      ? args[1]
      : requireBlock(block, rt().c.ArgumentError, 'tried to create Proc object without a block');
  let method: RMethod;
  if (body instanceof RProc) {
    method = { name, owner, visibility, body: { kind: 'proc', proc: body } };
  } else if (body instanceof RObject && (body.cls === rt().c.Method || body.cls === rt().c.UnboundMethod)) {
    const source = (body.data as MethodData).method;
    assertMethodOwner(source.owner, owner, true);
    method = {
      ...source,
      name,
      superName: source.superName ?? source.name,
      owner,
      visibility,
      nativeSignature: source.body.kind === 'native' ? nativeSignature(source) : undefined,
    };
  } else {
    throw typeError(`wrong argument type ${realClassOf(body).name} (expected Proc/Method/UnboundMethod)`);
  }
  addMethod(owner, method);
  return sym(name);
}

def('Module', 'define_method', [1, 2], function* (self: RClass, args, block) {
  const frame = rt().frame;
  const visibility = frame.definitionOwner === self ? frame.defaultVisibility : 'public';
  const result = yield* defineMethodFrom(self, args, block, visibility);
  if (frame.definitionOwner === self && frame.moduleFunction && result instanceof RSymbol) {
    const method = self.methods.get(result.key) as RMethod;

    const owner = singletonClassOf(self);
    addMethod(owner, { ...method, owner, visibility: 'public' });
    method.visibility = 'private';
  }
  return result;
});
def('Module', 'alias_method', 2, function* (self: RClass, [newName, oldName]) {
  const name = yield* methodKeyOf(newName, true);
  const old = yield* methodKeyOf(oldName);
  const method = self.findMethod(old);
  if (!method) throw undefinedMethodError(self, old);
  assertMutableClass(self);
  // An alias keeps the original method, whose owner and name `super` in it continues from.
  assertNoDefinitionHook(self, 'added');
  self.methods.set(name, aliasedMethod(method, self));
  invalidateMethodCaches();
  return sym(name);
});
def('Module', 'remove_method', [0, -1], function* (self: RClass, names) {
  for (const value of names) {
    const name = yield* methodRemovalKey(self, value, 'remove');
    const method = self.methods.get(name);
    if (!method || method.body.kind === 'undefined') {
      throw nameError(`method '${name}' not defined in ${className(self)}`, self, name);
    }
    assertNoDefinitionHook(self, 'removed');
    self.methods.delete(name);
    invalidateMethodCaches();
  }
  return self;
});
def('Module', 'undef_method', [0, -1], function* (self: RClass, names) {
  for (const value of names) {
    const name = yield* methodRemovalKey(self, value, 'undef');
    if (!self.findMethod(name)) {
      const error = undefinedMethodError(self, name);
      error.exception.internal!.set('name', symbolNameString(sym(name)));
      throw error;
    }
    addMethod(self, { name, owner: self, visibility: 'public', body: { kind: 'undefined' } });
  }
  return self;
});
function* methodRemovalKey(owner: RClass, value: Value, operation: 'remove' | 'undef'): Gen<string> {
  const input = yield* symbolNameInput(value);
  const symbol = input instanceof RSymbol ? input : identifierSymbol(input);
  const name = symbol.key;
  if (!rt().internedIds.has(name)) {
    const error =
      operation === 'remove'
        ? nameError(`method '${name}' not defined in ${className(owner)}`, owner, name)
        : undefinedMethodError(owner, name);
    error.exception.internal!.set('name', input instanceof RString ? input : symbolNameString(input));
    throw error;
  }
  assertMutableClass(owner);
  return name;
}

function reflectedMethod(self: RClass, name: string, inherit: boolean): RMethod | undefined {
  const method = inherit ? self.findMethod(name) : self.methods.get(name);
  return method?.body.kind === 'undefined' ? undefined : method;
}

def('Module', 'method_defined?', [1, 2], function* (self: RClass, args) {
  const method = reflectedMethod(self, yield* methodKeyOf(args[0]), args.length < 2 || truthy(args[1]));
  return method !== undefined && method.visibility !== 'private';
});
def('Module', 'public_method_defined?', [1, 2], function* (self: RClass, args) {
  return (
    reflectedMethod(self, yield* methodKeyOf(args[0]), args.length < 2 || truthy(args[1]))?.visibility === 'public'
  );
});
def('Module', 'private_method_defined?', [1, 2], function* (self: RClass, args) {
  return (
    reflectedMethod(self, yield* methodKeyOf(args[0]), args.length < 2 || truthy(args[1]))?.visibility === 'private'
  );
});
def('Module', 'protected_method_defined?', [1, 2], function* (self: RClass, args) {
  return (
    reflectedMethod(self, yield* methodKeyOf(args[0]), args.length < 2 || truthy(args[1]))?.visibility === 'protected'
  );
});
def('Module', 'instance_method', 1, function* (self: RClass, [name]) {
  const methodName = yield* methodKeyOf(name);
  const method = self.findMethod(methodName);
  if (!method) throw undefinedMethodError(self, methodName);
  return unboundMethod(method, methodName, methodReflectionOwner(method, self));
});
def('UnboundMethod', 'bind', 1, function (self: RObject, [recv]) {
  const { name, owner } = self.data as MethodData;
  return methodObject(recv, validBoundMethod(self, recv), name, owner, owner.isModule);
});
def(
  'UnboundMethod',
  'bind_call',
  [1, -1],
  function* (self: RObject, [recv, ...args], block, keywords, used) {
    const { owner } = self.data as MethodData;
    return yield* invoke(
      reflectedCallable(validBoundMethod(self, recv), owner, recv),
      recv,
      args,
      keywords,
      block,
      used
    );
  },
  { keywords: true }
);

function validBoundMethod(self: RObject, recv: Value): RMethod {
  const { method, owner } = self.data as MethodData;
  assertMethodOwner(owner, recv, false);
  const canonical = findCoreMethod(method.nativeIdentityOwner ?? owner, method.name);
  if (
    method.body.kind === 'native' &&
    !isA(recv, method.owner) &&
    (!canonical || (canonical.body.kind === 'native' && 'unavailable' in canonical.body.fn))
  )
    throw new UnsupportedFeatureError('継承元の実装を持たないネイティブメソッドの別クラスへの束縛');
  return method;
}

function assertMethodOwner(owner: RClass, target: Value, defining: boolean): void {
  if (owner.isModule) return;
  const compatible = defining ? target instanceof RClass && target.ancestors().includes(owner) : isA(target, owner);
  if (compatible) return;
  if (owner.isSingleton)
    throw typeError(
      defining ? "can't bind singleton method to a different class" : 'singleton method called for a different object'
    );
  throw typeError(`bind argument must be ${defining ? 'a subclass' : 'an instance'} of ${className(owner)}`);
}
def('BasicObject', 'method_missing', [0, -1], (self, args) => raiseMethodMissing(self, args, rt().missingReason), {
  visibility: 'private',
});
def(
  'Module',
  'prepend_features',
  1,
  (self: RClass, [target]) => {
    if (!(target instanceof RClass)) throw typeError('wrong argument type');
    assertMutableClass(target);
    if (moduleDependsOn(self, target)) throw argumentError('cyclic prepend detected');
    prependHierarchy(target, self);
    if (!target.prepends.includes(self)) target.prepends.unshift(self);
    invalidateMethodCaches();
    return self;
  },
  { visibility: 'private' }
);
def('Module', 'prepended', 1, () => NIL, { visibility: 'private' });
def('Class', 'inherited', 1, () => NIL, { visibility: 'private' });

function moduleDependsOn(module: RClass, target: RClass): boolean {
  const pending = [module];
  const seen = new Set<RClass>();
  while (pending.length > 0) {
    const current = pending.pop() as RClass;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    rt().spend();
    pending.push(...current.includes, ...current.prepends);
    if (current.superclass) pending.push(current.superclass);
  }
  return false;
}

def('Module', 'prepend', [1, -1], function* (self: RClass, modules) {
  for (const module of modules) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
  }
  assertMutableClass(self);
  for (const module of modules.toReversed() as RClass[]) {
    yield* callMethod(module, 'prepend_features', [self], undefined, undefined, { fcall: true });
    yield* callMethod(module, 'prepended', [self], undefined, undefined, { fcall: true });
  }
  return self;
});

// Constants and class variables ----------------------------------------------------------------------------------------

function* constantName(value: Value): Gen<string> {
  const symbol = yield* symbolNameOf(value, true);
  const name = symbol.name;
  const valid = symbol.binary ? /^[A-Z][\w\P{ASCII}]*$/u : /^[\p{Uppercase}\p{Lt}][\w\P{ASCII}]*$/u;
  if (!valid.test(name)) throw nameError(`wrong constant name ${symbol.key}`, NIL, symbol.key);
  return symbol.key;
}

function reflectedConstant(module: RClass, name: string, inherit: boolean, nested: boolean): Value | undefined {
  const ancestors = inherit ? module.ancestors() : [module];
  const objectIndex = nested && module !== rt().c.Object ? ancestors.indexOf(rt().c.Object) : -1;
  const holders = objectIndex < 0 ? ancestors : ancestors.slice(0, objectIndex);
  for (const holder of holders) {
    const value = holder.constants.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 18 -- The ordered cases for reflection and encoded constant lookup share state; splitting them solely for the metric would hide their sequencing.
// code-gauge-allow duplicateLines 22 -- Constant queries share path validation but differ in missing-constant hooks, fallback lookup and return behavior.
def('Module', 'const_get', [1, 2], function* (self: RClass, args) {
  const inherit = args.length < 2 || truthy(args[1]);
  const input = yield* symbolNameOf(args[0], true);
  const requested = input.name;
  const absolute = requested.startsWith('::');
  const parts = (absolute ? requested.slice(2) : requested).split('::');
  if (parts.some((part) => part.length === 0)) throw nameError(`wrong constant name ${requested}`, NIL, requested);
  let module: Value = absolute ? rt().c.Object : self;
  for (const [index, part] of parts.entries()) {
    if (!(module instanceof RClass)) throw typeError(`${requested} does not refer to class/module`);
    const constant = yield* constantName(
      RSymbol.of(
        part,
        input.binary,
        input.usAscii,
        input.binary || input.usAscii ? Uint8Array.from(part, (char) => char.codePointAt(0)!) : undefined
      )
    );
    const value: Value | undefined =
      reflectedConstant(module, constant, inherit, index > 0) ??
      (inherit && index === 0 && module.isModule ? rt().c.Object.constants.get(constant) : undefined);
    if (value === undefined && inherit) constInModule(module, constant);
    if (value === undefined) missingConstant(module, constant, true);
    module = value;
  }
  return module;
});
def('Module', 'const_set', 2, function* (self: RClass, [name, value]) {
  const row = rt().currentRow;
  const constant = yield* constantName(name);
  constSet(self, constant, value, row);
  return value;
});
// code-gauge-allow duplicateLines 23 -- Constant queries share path validation but differ in missing-constant hooks, fallback lookup and return behavior.
def('Module', 'const_defined?', [1, 2], function* (self: RClass, args) {
  const input = yield* symbolNameOf(args[0], true);
  const requested = input.name;
  const inherit = args.length < 2 || truthy(args[1]);
  const absolute = requested.startsWith('::');
  const parts = (absolute ? requested.slice(2) : requested).split('::');
  if (parts.some((part) => part.length === 0)) throw nameError(`wrong constant name ${requested}`, NIL, requested);
  let module: Value | undefined = absolute ? rt().c.Object : self;
  for (const [index, part] of parts.entries()) {
    if (!(module instanceof RClass)) throw typeError(`${requested} does not refer to class/module`);
    const constant = yield* constantName(
      RSymbol.of(
        part,
        input.binary,
        input.usAscii,
        input.binary || input.usAscii ? Uint8Array.from(part, (char) => char.codePointAt(0)!) : undefined
      )
    );
    const value = reflectedConstant(module, constant, inherit, index > 0);
    module = value ?? (inherit && index === 0 && module.isModule ? rt().c.Object.constants.get(constant) : undefined);
    if (module === undefined) return false;
  }
  return true;
});
def('Module', 'constants', [0, 1], () => {
  throw new UnsupportedFeatureError('Module#constants（定数の並び順）');
});
def('Module', 'class_variable_get', 1, function* (self: RClass, [name]) {
  const variable = yield* classVariableName(name);
  return getClassVariable(self, variable);
});
def('Module', 'class_variable_set', 2, function* (self: RClass, [name, value]) {
  setClassVariable(self, yield* classVariableName(name), value);
  return value;
});
def('Module', 'class_variable_defined?', 1, function* (self: RClass, [name]) {
  const variable = yield* classVariableName(name);
  return hasClassVariable(self, variable);
});
def('Module', 'class_variables', [0, 1], () => {
  throw new UnsupportedFeatureError('Module#class_variables（クラス変数の並び順）');
});
