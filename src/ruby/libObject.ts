// code-gauge-allow-file fileNcss 583 -- The libObject module keeps one concern's cases together.
import {
  anonymousClassName,
  anyToS,
  className,
  compareValues,
  comparisonSign,
  inspect,
  inspectException,
  inspectObject,
  inspectProc,
  rEql,
  rEquals,
  toRubyInt,
  toStr,
  toStrValue,
} from './conversions';
import { def, sdef } from './define';
import { argumentCountError, argumentError, frozenError, nameError, rubyError, typeError } from './errors';
import { hashSet } from './hashes';
import {
  addMethod,
  callMethod,
  callProc,
  type Gen,
  invoke,
  ivarGet,
  ivarSet,
  makeBlock,
  requireBlock,
  respondsTo,
} from './interp';
import { curry, makeEnumerator, sizedEnumerator } from './libEnumerator';
import { kernelFloat, kernelInteger } from './libNumeric';
import {
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
  RFloat,
  RHash,
  RObject,
  RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
  type Visibility,
} from './objects';
import { rt, RubyError, ThrowSignal, UnsupportedFeatureError } from './runtime';
import { arr, classOf, isA, newHash, realClassOf, sameIdentity, singletonClassOf, str, sym, truthy } from './values';

// Object --------------------------------------------------------------------------------------------------------------

def('BasicObject', 'initialize', 0, () => NIL, { visibility: 'private' });
def('BasicObject', 'initialize_copy', 1, () => NIL, { visibility: 'private' });
def(
  'BasicObject',
  'initialize_dup',
  1,
  function* (self, [source]) {
    yield* callMethod(self, 'initialize_copy', [source], undefined, undefined, { fcall: true });
    return NIL;
  },
  { visibility: 'private' }
);
def(
  'BasicObject',
  'initialize_clone',
  1,
  function* (self, [source]) {
    yield* callMethod(self, 'initialize_copy', [source], undefined, undefined, { fcall: true });
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
def('BasicObject', '==', 1, (self, [other]) => self === other || (typeof self === 'number' && self === other));
def('BasicObject', 'equal?', 1, (self, [other]) => sameIdentity(self, other));
def('BasicObject', '!', 0, (self) => !truthy(self));
def('BasicObject', '!=', 1, function* (self, [other]) {
  return !truthy(yield* callMethod(self, '==', [other]));
});
def('BasicObject', '__id__', 0, (self) => objectId(self));
def('Kernel', 'object_id', 0, (self) => objectId(self));

const floatBits = new DataView(new ArrayBuffer(8));

function objectId(value: Value): bigint {
  if (typeof value === 'bigint') return 2n * value + 1n;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return (0x7f_f8_00_00_00_00_00_00n << 3n) | 6n;
    floatBits.setFloat64(0, value);
    return (floatBits.getBigUint64(0) << 3n) | 6n;
  }
  if (value === NIL) return 8n;
  if (value === true) return 20n;
  if (value === false) return 0n;
  if (value instanceof RBasic) return BigInt(value.id);
  if (value instanceof RSymbol) return BigInt(value.id);
  return 16n;
}

function hashString(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) as number)) % 1_000_003;
  return hash;
}

def('Kernel', 'class', 0, (self) => realClassOf(self));
def('Kernel', 'singleton_class', 0, (self) => {
  if (!(self instanceof RBasic) || self instanceof RFloat) throw typeError("can't define singleton");
  return singletonClassOf(self);
});
def('Kernel', 'frozen?', 0, (self) => (self instanceof RBasic ? self.frozen : true));
def('Kernel', 'freeze', 0, (self) => {
  if (self instanceof RBasic) self.frozen = true;
  return self;
});
def('Kernel', 'nil?', 0, (self) => self === NIL);
def('Kernel', ['is_a?', 'kind_of?'], 1, (self, [cls]) => {
  if (!(cls instanceof RClass)) throw typeError('class or module required');
  return isA(self, cls);
});
def('Kernel', 'instance_of?', 1, (self, [cls]) => {
  if (!(cls instanceof RClass)) throw typeError('class or module required');
  return realClassOf(self) === cls;
});
def('Kernel', '===', 1, function* (self, [other]) {
  return self === other || (yield* rEquals(self, other));
});
def('Kernel', 'eql?', 1, function* (self, [other]) {
  return yield* rEql(self, other);
});
def('Kernel', 'hash', 0, (self) => BigInt(hashString(String(objectId(self)))));
def('Kernel', '<=>', 1, function* (self, [other]) {
  if (classOf(self).findMethod('==')?.owner === rt().c.Comparable) return self === other ? 0n : NIL;
  return self === other || (yield* rEquals(self, other)) ? 0n : NIL;
});
def('Kernel', 'to_s', 0, (self) => str(anyToS(self)));
def('Kernel', 'inspect', 0, function* (self) {
  if (self instanceof RObject && self.exception) return str(yield* inspectException(self));
  if (self instanceof RBasic && !(self instanceof RClass)) {
    if (classOf(self).findMethod('to_s')?.body.kind === 'user' && !self.ivars?.size) {
      return str(anyToS(self));
    }
    return str(yield* inspectObject(self));
  }
  return str(anyToS(self));
});
def('Kernel', 'itself', 0, (self) => self);
def('Kernel', ['then', 'yield_self'], 0, function* (self, _args, block) {
  if (!block) return sizedEnumerator(self, 'then', [], () => 1n);
  return yield* callProc(requireBlock(block), [self]);
});
def('Kernel', 'tap', 0, function* (self, _args, block) {
  yield* callProc(requireBlock(block), [self], { used: false });
  return self;
});
def('Kernel', 'dup', 0, function* (self) {
  return yield* copyObject(self, false);
});
def(
  'Kernel',
  'clone',
  0,
  function* (self, _args, _block, keywords) {
    let freezeOption: Value | undefined;
    if (keywords) {
      for (const entry of keywords.map.values()) {
        if (entry.key instanceof RSymbol && entry.key.name === 'freeze') {
          freezeOption = entry.value;
          if (freezeOption !== true && freezeOption !== false && freezeOption !== NIL)
            throw argumentError(`unexpected value for freeze: ${realClassOf(freezeOption).name}`);
        } else throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
      }
    }
    return yield* copyObject(self, true, freezeOption);
  },
  { keywords: true }
);

// code-gauge-allow functionCognitiveComplexity 18 -- Object copying preserves each value kind, singleton methods, copy hooks, and clone freeze options.
// code-gauge-allow functionNcss 39 -- Object copying preserves each value kind, singleton methods, copy hooks, and clone freeze options.
function* copyObject(self: Value, clone: boolean, freezeOption?: Value): Gen {
  if (!(self instanceof RBasic) || self instanceof RFloat) {
    if (clone && freezeOption === false) throw argumentError(`can't unfreeze ${realClassOf(self).name}`);
    return self;
  }
  let copy: RBasic;
  if (self instanceof RClass) copy = copyClass(self);
  else if (self instanceof RString) {
    const string = new RString(self.cls, self.s);
    string.binary = self.binary;
    string.usAscii = self.usAscii;
    string.rawBytes = self.rawBytes ? Uint8Array.from(self.rawBytes) : undefined;
    copy = string;
  } else if (self instanceof RArray) copy = new RArray(self.cls, [...self.items]);
  else if (self instanceof RHash) {
    const hash = new RHash(self.cls);
    for (const [key, entry] of self.map) hash.map.set(key, { ...entry });
    hash.defaultValue = self.defaultValue;
    hash.defaultProc = self.defaultProc;
    copy = hash;
  } else if (self instanceof RObject) {
    const object = new RObject(self.cls);
    if (self.exception) object.exception = { ...self.exception };
    if (self.turtle) throw typeError(`can't copy Turtle`);
    object.data = copyData(self.data);
    copy = object;
  } else if (self instanceof RProc) {
    const proc = new RProc(self.cls, self.body, self.self, self.outer);
    proc.isLambda = self.isLambda;
    proc.captured = self.captured ? [...self.captured] : undefined;
    proc.breakTag = self.breakTag;
    proc.callSiteState = self.callSiteState;
    copy = proc;
  } else if (self instanceof RRange) {
    copy = new RRange(self.cls, self.begin, self.end, self.exclusive);
    copy.frozen = false;
  } else {
    return self;
  }
  if (self.ivars) copy.ivars = new Map(self.ivars);
  if ((clone || self instanceof RClass) && self.singleton) copySingleton(self.singleton, copy);
  yield* initializeCopy(copy, self, clone, freezeOption);
  if (clone) copy.frozen = freezeOption === true || (freezeOption !== false && self.frozen);
  return copy;
}

function copyClass(source: RClass): RClass {
  const copy = new RClass(source.cls, undefined, source.superclass, source.isModule, source.isSingleton);
  copy.instanceKind = source.instanceKind;
  copy.isUserDefined = source.isUserDefined;
  for (const included of source.includes) copy.includes.push(included);
  for (const prepended of source.prepends) copy.prepends.push(prepended);
  for (const [name, value] of source.constants) copy.constants.set(name, value);
  for (const [name, value] of source.classVariables) copy.classVariables.set(name, value);
  for (const [name, method] of source.methods)
    copy.methods.set(name, {
      ...method,
      owner: method.owner === source ? copy : method.owner,
      body:
        method.body.kind === 'user'
          ? { ...method.body, cref: method.body.cref.map((scope) => (scope === source ? copy : scope)) }
          : method.body,
    });
  invalidateMethodCaches();
  return copy;
}

function copySingleton(original: RClass, copy: RBasic): void {
  const singleton = new RClass(rt().c.Class, undefined, original.superclass, false, true);
  singleton.attached = copy;
  for (const included of original.includes) singleton.includes.push(included);
  for (const prepended of original.prepends) singleton.prepends.push(prepended);
  for (const [name, method] of original.methods)
    singleton.methods.set(name, { ...method, owner: method.owner === original ? singleton : method.owner });
  copy.singleton = singleton;
  invalidateMethodCaches();
}

function* initializeCopy(copy: RBasic, source: RBasic, clone: boolean, freezeOption: Value | undefined): Gen<void> {
  let keywords: RHash | undefined;
  if (clone && freezeOption !== undefined) {
    keywords = newHash();
    yield* hashSet(keywords, sym('freeze'), freezeOption);
  }
  yield* callMethod(copy, clone ? 'initialize_clone' : 'initialize_dup', [source], keywords, undefined, {
    fcall: true,
  });
}

function copyData(data: unknown): unknown {
  if (data && typeof data === 'object' && 'copy' in data && typeof data.copy === 'function') return data.copy();
  return data;
}

def('Kernel', 'extend', [1, -1], function* (self, modules) {
  for (const module of modules) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
  }
  for (const module of modules.toReversed() as RClass[]) {
    yield* callMethod(module, 'extend_object', [self], undefined, undefined, { fcall: true });
    yield* callMethod(module, 'extended', [self], undefined, undefined, { fcall: true });
  }
  return self;
});
def('Kernel', 'display', [0, 1], function* (self, args) {
  const stream = args.length > 0 ? args[0] : (rt().globals.get('$stdout') as Value);
  yield* callMethod(stream, 'write', [self]);
  return NIL;
});
def('Kernel', ['to_enum', 'enum_for'], [0, -1], function* (self, args, block) {
  const [method = sym('each'), ...rest] = args;
  if (method instanceof RSymbol) return makeEnumerator(self, method.name, rest, undefined, { sizeBlock: block });
  if (method instanceof RString || respondsTo(method, 'to_str', true))
    return makeEnumerator(self, (yield* toStrValue(method)).s, rest, undefined, { sizeBlock: block });
  throw typeError(`${yield* inspect(method)} is not a symbol nor a string`);
});

def('Kernel', 'instance_variables', 0, () => {
  throw new UnsupportedFeatureError('instance_variables');
});

// Kernel functions ----------------------------------------------------------------------------------------------------

const PRIVATE = { visibility: 'private' as Visibility };

def('Kernel', 'block_given?', 0, () => rt().frame.home.extra.block !== undefined, PRIVATE);
def(
  'Kernel',
  'loop',
  0,
  function* (_self, _args, block) {
    if (!block) {
      return makeEnumerator(rt().mainObject, 'loop', []);
    }
    for (;;) {
      rt().spend();
      try {
        yield* callProc(block, [], { used: false });
      } catch (error) {
        if (error instanceof RubyError && isA(error.exception, rt().c.StopIteration)) {
          return ivarGet(error.exception, '@result');
        }
        throw error;
      }
    }
  },
  PRIVATE
);
def(
  'Kernel',
  'lambda',
  0,
  (_self, _args, block) => {
    const proc = requireProcBlock(block);
    if (!proc.literalAtCall) throw argumentError('lambda requires a literal block');
    if (proc.body.kind === 'block' && proc.callSiteState !== undefined) proc.isLambda = true;
    return proc;
  },
  PRIVATE
);
def('Kernel', 'proc', 0, (_self, _args, block) => requireProcBlock(block), PRIVATE);

function requireProcBlock(block: RProc | undefined): RProc {
  if (!block) throw argumentError('tried to create Proc object without a block');
  return block;
}
def(
  'Kernel',
  ['raise', 'fail'],
  [0, 3],
  function* (_self, args, _block, keywords) {
    throw yield* makeRaise(args, keywords);
  },
  { ...PRIVATE, keywords: true }
);

/** Builds the exception `raise` throws from its arguments. */
// code-gauge-allow functionNcss 36 -- raise accepts exception classes or instances, messages, and cause keywords in Ruby order.
// code-gauge-allow functionCognitiveComplexity 25 -- raise accepts exception classes or instances, messages, and cause keywords in Ruby order.
export function* makeRaise(args: Value[], keywords?: RHash): Gen<RubyError> {
  const runtime = rt();
  const parsed = raiseArguments(args, keywords);
  args = parsed.args;
  const { cause } = parsed;
  if (args.length === 0 && cause !== undefined) throw argumentError('only cause is given with no arguments');
  if (args.length >= 3) throw new UnsupportedFeatureError('raise backtrace');
  let exception: Value;
  if (args.length === 0) {
    const current = runtime.globals.get('$!');
    if (current instanceof RObject && current.exception) return new RubyError(current);
    exception = (yield* callMethod(runtime.c.RuntimeError, 'new', [str('unhandled exception')])) as Value;
  } else if (args[0] instanceof RString && args.length === 1) {
    exception = yield* callMethod(runtime.c.RuntimeError, 'new', [args[0]]);
  } else {
    const [target, message] = args;
    if (!respondsTo(target, 'exception', true)) throw typeError('exception class/object expected');
    exception = yield* callMethod(target, 'exception', message === undefined ? [] : [message], undefined, undefined, {
      fcall: true,
    });
    if (!(exception instanceof RObject) || !exception.exception) throw typeError('exception object expected');
  }
  const object = exception as RObject;
  const state = object.exception as NonNullable<RObject['exception']>;
  const current = runtime.globals.get('$!') ?? NIL;
  if (cause !== undefined) {
    if (cause !== NIL && (!(cause instanceof RObject) || !cause.exception))
      throw typeError('exception object expected');
    state.cause = cause;
  } else if (state.cause === NIL && current !== object) state.cause = current;
  return new RubyError(object);
}

function raiseArguments(args: Value[], keywords: RHash | undefined): { args: Value[]; cause?: Value } {
  let cause: Value | undefined;
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (entry.key instanceof RSymbol && entry.key.name === 'cause') cause = entry.value;
      else args = [...args, keywords];
    }
  }
  return { args, cause };
}

def(
  'Kernel',
  'catch',
  [0, 1],
  function* (_self, args, block) {
    const runtime = rt();
    const tag = args.length > 0 ? args[0] : new RObject(runtime.c.Object);
    runtime.catchTags.push(tag);
    try {
      return yield* callProc(requireBlock(block), [tag]);
    } catch (error) {
      if (error instanceof ThrowSignal && sameIdentity(error.tag, tag)) return error.value;
      throw error;
    } finally {
      runtime.catchTags.pop();
    }
  },
  PRIVATE
);
def(
  'Kernel',
  'throw',
  [1, 2],
  function* (_self, [tag, value = NIL]) {
    const runtime = rt();
    for (const active of runtime.catchTags.toReversed()) {
      if (sameIdentity(active, tag)) throw new ThrowSignal(active, value);
    }
    throw rubyError(runtime.c.UncaughtThrowError, `uncaught throw ${yield* inspect(tag)}`);
  },
  PRIVATE
);

def(
  'Kernel',
  'exit',
  [0, 1],
  function* (_self, [status = true]) {
    const code = status === true ? 0n : status === false ? 1n : BigInt(yield* toRubyInt(status));
    const error = rubyError(rt().c.SystemExit, 'exit');
    error.exception.ivars = new Map([['@__status', code]]);
    throw error;
  },
  PRIVATE
);
def(
  'Kernel',
  'exit!',
  [0, 1],
  () => {
    throw new UnsupportedFeatureError('Kernel#exit!');
  },
  PRIVATE
);
def(
  'Kernel',
  'abort',
  [0, 1],
  function* (_self, [message]) {
    if (message !== undefined) rt().io.stderr.write(`${yield* toStr(message)}\n`);
    throw rubyError(rt().c.SystemExit, message ?? str('exit'));
  },
  PRIVATE
);
def(
  'Kernel',
  '__method__',
  0,
  () => {
    const method = rt().frame.home.extra.method;
    return method ? sym(method.name) : NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'Integer',
  [1, 2],
  function* (_self, args, _block, keywords) {
    return yield* kernelInteger(args, keywords);
  },
  { ...PRIVATE, keywords: true }
);
def(
  'Kernel',
  'Float',
  1,
  function* (_self, args, _block, keywords) {
    return yield* kernelFloat(args[0], keywords);
  },
  { ...PRIVATE, keywords: true }
);
for (const [name, feature] of [
  ['Rational', '有理数（Rational）'],
  ['Complex', '複素数（Complex）'],
] as const) {
  const reject = (): never => {
    throw new UnsupportedFeatureError(feature);
  };
  def('Kernel', name, [0, -1], reject, PRIVATE);
  sdef('Kernel', name, [0, -1], reject);
}

def(
  'Kernel',
  'String',
  1,
  function* (_self, [value]) {
    if (value instanceof RString) return value;
    if (respondsTo(value, 'to_str', true)) {
      const converted = yield* callMethod(value, 'to_str', [], undefined, undefined, { fcall: true });
      if (converted instanceof RString) return converted;
      if (converted !== NIL)
        throw typeError(
          `can't convert ${realClassOf(value).name} to String (${realClassOf(value).name}#to_str gives ${realClassOf(converted).name})`
        );
    }
    const converted = yield* callMethod(value, 'to_s', [], undefined, undefined, { fcall: true });
    if (converted instanceof RString) return converted;
    throw typeError(
      `can't convert ${realClassOf(value).name} to String (${realClassOf(value).name}#to_s gives ${realClassOf(converted).name})`
    );
  },
  PRIVATE
);
def(
  'Kernel',
  'Array',
  1,
  function* (_self, [value]) {
    if (value instanceof RArray) return value;
    if (respondsTo(value, 'to_ary', true)) {
      const converted = yield* callMethod(value, 'to_ary', [], undefined, undefined, { fcall: true });
      if (converted instanceof RArray) return converted;
      if (converted !== NIL) throw collectionConversionError(value, converted, 'Array', 'to_ary');
    }
    if (respondsTo(value, 'to_a', true)) {
      const converted = yield* callMethod(value, 'to_a', [], undefined, undefined, { fcall: true });
      if (converted instanceof RArray) return converted;
      if (converted !== NIL) throw collectionConversionError(value, converted, 'Array', 'to_a');
    }
    return arr([value]);
  },
  PRIVATE
);
def(
  'Kernel',
  'Hash',
  1,
  function* (_self, [value]) {
    if (value instanceof RHash) return value;
    if (value === NIL) return newHash();
    if (respondsTo(value, 'to_hash', true)) {
      const converted = yield* callMethod(value, 'to_hash', [], undefined, undefined, { fcall: true });
      if (converted instanceof RHash) return converted;
      if (converted !== NIL) throw collectionConversionError(value, converted, 'Hash', 'to_hash');
    }
    if (value instanceof RArray && value.items.length === 0) return newHash();
    throw typeError(`can't convert ${realClassOf(value).name} into Hash`);
  },
  PRIVATE
);

function collectionConversionError(value: Value, converted: Value, target: string, method: string): RubyError {
  const name = realClassOf(value).name;
  return typeError(`can't convert ${name} to ${target} (${name}#${method} gives ${realClassOf(converted).name})`);
}

for (const [name, feature] of [
  ['require', 'require（ライブラリ・別のファイルの読み込み）'],
  ['require_relative', 'require_relative（別のファイルの読み込み）'],
  ['load', 'load（別のファイルの読み込み）'],
  ['autoload', 'autoload'],
  ['gets', '標準入力（gets）'],
  ['readline', '標準入力（readline）'],
  ['readlines', '標準入力（readlines）'],
  ['open', 'ファイルの読み書き（open）'],
  ['system', '外部コマンドの実行（system）'],
  ['exec', '外部コマンドの実行（exec）'],
  ['spawn', '外部コマンドの実行（spawn）'],
  ['`', '外部コマンドの実行（`...`）'],
  ['fork', 'プロセスの生成（fork）'],
  ['trap', 'シグナル（trap）'],
  ['sleep', 'sleep'],
  ['eval', '文字列の評価（eval）'],
  ['binding', 'binding'],
  ['caller', '呼び出し履歴（caller）'],
  ['caller_locations', '呼び出し履歴（caller_locations）'],
  ['at_exit', 'at_exit'],
  ['set_trace_func', 'set_trace_func'],
  ['select', 'select'],
  ['syscall', 'syscall'],
  ['test', 'test'],
] as const) {
  def(
    'Kernel',
    name,
    [0, -1],
    () => {
      throw new UnsupportedFeatureError(feature);
    },
    PRIVATE
  );
}
for (const [name, feature] of [
  ['send', 'send（名前によるメソッドの呼び出し）'],
  ['__send__', '__send__（名前によるメソッドの呼び出し）'],
  ['public_send', 'public_send（名前によるメソッドの呼び出し）'],
  ['respond_to?', 'respond_to?'],
  ['method', 'method（Method オブジェクト）'],
  ['public_method', 'public_method'],
  ['singleton_method', 'singleton_method'],
  ['methods', 'methods'],
  ['public_methods', 'public_methods'],
  ['private_methods', 'private_methods'],
  ['protected_methods', 'protected_methods'],
  ['singleton_methods', 'singleton_methods'],
  ['instance_variable_get', 'instance_variable_get'],
  ['instance_variable_set', 'instance_variable_set'],
  ['instance_variable_defined?', 'instance_variable_defined?'],
  ['remove_instance_variable', 'remove_instance_variable'],
  ['instance_eval', 'instance_eval'],
  ['instance_exec', 'instance_exec'],
  ['define_singleton_method', 'define_singleton_method'],
] as const) {
  def('Kernel', name, [0, -1], () => {
    throw new UnsupportedFeatureError(feature);
  });
}

// Module and Class ----------------------------------------------------------------------------------------------------

def('Module', ['name'], 0, (self: RClass) => (self.name === undefined ? NIL : str(self.name)));
def('Module', ['to_s', 'inspect'], 0, (self: RClass) => str(className(self)));
def('Module', '===', 1, (self: RClass, [value]) => isA(value, self));
def('Module', '==', 1, (self, [other]) => self === other);
def('Module', 'hash', 0, (self: RClass) => BigInt(self.id));
def('Module', '<', 1, (self: RClass, [other]) => moduleCompare(self, other, true));
def('Module', '<=', 1, (self: RClass, [other]) => moduleCompare(self, other, false));
def('Module', '>', 1, (self: RClass, [other]) => moduleCompare(other as RClass, self, true, other));
def('Module', '>=', 1, (self: RClass, [other]) => moduleCompare(other as RClass, self, false, other));
def('Module', '<=>', 1, (self: RClass, [other]) => {
  if (self === other) return 0n;
  if (!(other instanceof RClass)) return NIL;
  if (self.isSubclassOf(other)) return -1n;
  if (other.isSubclassOf(self)) return 1n;
  return NIL;
});

function moduleCompare(self: RClass, other: Value, strict: boolean, checked: Value = other): Value {
  if (!(checked instanceof RClass)) throw typeError('compared with non class/module');
  if (self === other) return !strict;
  if (self.isSubclassOf(other as RClass)) return true;
  if ((other as RClass).isSubclassOf(self)) return false;
  return NIL;
}

def('Module', 'ancestors', 0, (self: RClass) => arr(self.ancestors().filter((module) => !module.isSingleton)));
def('Module', 'include?', 1, (self: RClass, [module]) => {
  if (!(module instanceof RClass) || !module.isModule) {
    throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
  }
  return self !== module && self.ancestors().includes(module);
});
def('Module', 'included_modules', 0, (self: RClass) => arr(self.ancestors().filter((module) => module.isModule)));
def(
  'Module',
  'append_features',
  1,
  (self: RClass, [target]) => {
    if (!(target instanceof RClass)) throw typeError('wrong argument type');
    if (target.frozen) throw frozenError(target, target.name ?? '');
    if (self.ancestors().includes(target)) throw argumentError('cyclic include detected');
    if (!target.ancestors().includes(self)) {
      target.includes.unshift(self);
      invalidateMethodCaches();
    }
    return self;
  },
  { visibility: 'private' }
);
def('Module', 'included', 1, () => NIL, { visibility: 'private' });
def(
  'Module',
  'extend_object',
  1,
  (self: RClass, [target]) => {
    if (!(target instanceof RBasic) || target instanceof RFloat) throw typeError("can't define singleton");
    if (target.frozen)
      throw frozenError(target, target instanceof RClass ? (target.name ?? '') : (realClassOf(target).name ?? ''));
    const singleton = singletonClassOf(target);
    if (!singleton.includes.includes(self)) singleton.includes.unshift(self);
    invalidateMethodCaches();
    return target;
  },
  { visibility: 'private' }
);
def('Module', 'extended', 1, () => NIL, { visibility: 'private' });
def('Module', 'include', [1, -1], function* (self: RClass, modules) {
  for (const module of modules) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
  }
  for (const module of modules.toReversed() as RClass[]) {
    yield* callMethod(module, 'append_features', [self], undefined, undefined, { fcall: true });
    yield* callMethod(module, 'included', [self], undefined, undefined, { fcall: true });
  }
  return self;
});
def('Module', 'prepend', [1, -1], () => {
  throw new UnsupportedFeatureError('prepend');
});
for (const name of [
  'define_method',
  'alias_method',
  'remove_method',
  'undef_method',
  'instance_method',
  'public_instance_method',
  'method_defined?',
  'public_method_defined?',
  'private_method_defined?',
  'protected_method_defined?',
  'instance_methods',
  'public_instance_methods',
  'private_instance_methods',
  'class_eval',
  'module_eval',
  'class_exec',
  'module_exec',
  'const_get',
  'const_set',
  'const_defined?',
  'constants',
  'class_variable_get',
  'class_variable_set',
  'class_variables',
  'class_variable_defined?',
  'remove_const',
  'refine',
  'using',
]) {
  def('Module', name, [0, -1], () => {
    throw new UnsupportedFeatureError(name);
  });
}

function* symbolNames(args: Value[], expandArrays = false): Gen<string[]> {
  const names: string[] = [];
  for (const arg of args) {
    if (arg instanceof RArray && expandArrays) {
      for (const item of arg.items) names.push(yield* symbolName(item));
    } else names.push(yield* symbolName(arg));
  }
  return names;
}

function* symbolName(value: Value): Gen<string> {
  if (value instanceof RSymbol) return value.name;
  if (value instanceof RString) return value.s;
  if (respondsTo(value, 'to_str', true)) return (yield* toStrValue(value)).s;
  throw typeError(`${yield* inspect(value)} is not a symbol nor a string`);
}

function* defineAttributes(self: RClass, names: Value[], reader: boolean, writer: boolean): Gen<RArray> {
  const frame = rt().frame;
  const visibility =
    (frame.kind === 'class' && frame.self === self) || frame.extra.definitionTarget === self
      ? frame.defaultVisibility
      : 'public';
  const defined: Value[] = [];
  for (const value of names) {
    const name = yield* symbolName(value);
    if (!/^[A-Za-z_\u0080-￿][\w\u0080-￿]*$/u.test(name)) {
      throw nameError(`invalid attribute name '${name}'`, self, name);
    }
    if (reader) {
      addMethod(self, { name, owner: self, visibility, body: { kind: 'reader', ivar: `@${name}` } });
      defined.push(sym(name));
    }
    if (writer) {
      addMethod(self, { name: `${name}=`, owner: self, visibility, body: { kind: 'writer', ivar: `@${name}` } });
      defined.push(sym(`${name}=`));
    }
  }
  return arr(defined);
}

def('Module', 'attr_reader', [0, -1], function* (self: RClass, args) {
  return yield* defineAttributes(self, args, true, false);
});
def('Module', 'attr', [0, -1], function* (self: RClass, args) {
  const writer = args.length === 2 && (args[1] === true || args[1] === false) ? args[1] : false;
  const names = args.length === 2 && (args[1] === true || args[1] === false) ? args.slice(0, 1) : args;
  return yield* defineAttributes(self, names, true, writer);
});
def('Module', 'attr_writer', [0, -1], function* (self: RClass, args) {
  return yield* defineAttributes(self, args, false, true);
});
def('Module', 'attr_accessor', [0, -1], function* (self: RClass, args) {
  return yield* defineAttributes(self, args, true, true);
});

function* setVisibility(self: RClass, args: Value[], visibility: Visibility): Gen {
  const frame = rt().frame;
  if (args.length === 0) {
    if ((frame.kind === 'class' && frame.self === self) || frame.extra.definitionTarget === self) {
      frame.defaultVisibility = visibility;
      frame.moduleFunction = false;
    } else if (frame.kind === 'main' && self === rt().c.Object) {
      frame.defaultVisibility = visibility;
    }
    return NIL;
  }
  if (self.frozen) throw frozenError(self, self.name ?? '');
  for (const arg of args)
    for (const value of arg instanceof RArray ? arg.items : [arg]) {
      const name = yield* symbolName(value);
      const method = self.findMethod(name);
      if (!method) {
        throw nameError(
          `undefined method '${name}' for ${self.isModule ? 'module' : 'class'} '${self.name}'`,
          self,
          name
        );
      }
      if (method.owner === self) method.visibility = visibility;
      else addMethod(self, { name, owner: self, visibility, body: { kind: 'visibility' } });
    }
  invalidateMethodCaches();
  return args.length === 1 ? args[0] : arr(args);
}

def('Module', 'public', [0, -1], (self, args) => setVisibility(self, args, 'public'), PRIVATE);
def('Module', 'private', [0, -1], (self, args) => setVisibility(self, args, 'private'), PRIVATE);
def('Module', 'protected', [0, -1], (self, args) => setVisibility(self, args, 'protected'), PRIVATE);
def(
  'Module',
  'module_function',
  [0, -1],
  function* (self: RClass, args) {
    const frame = rt().frame;
    if (args.length === 0) {
      if (frame.kind === 'class' && frame.self === self) {
        frame.moduleFunction = true;
        frame.defaultVisibility = 'private';
      }
      return NIL;
    }
    for (const name of yield* symbolNames(args)) {
      const method = self.findMethod(name);
      if (!method) throw nameError(`undefined method '${name}' for module '${self.name}'`, self, name);
      addMethod(singletonClassOf(self), { ...method, owner: singletonClassOf(self), visibility: 'public' });
      addMethod(self, { ...method, visibility: 'private' });
    }
    return args.length === 1 ? args[0] : arr(args);
  },
  PRIVATE
);
def('Module', 'private_class_method', [0, -1], function* (self: RClass, args) {
  yield* setVisibility(singletonClassOf(self), args, 'private');
  return NIL;
});
def('Module', 'public_class_method', [0, -1], function* (self: RClass, args) {
  yield* setVisibility(singletonClassOf(self), args, 'public');
  return NIL;
});
def('Module', 'private_constant', [0, -1], () => {
  throw new UnsupportedFeatureError('Module#private_constant');
});
def('Module', 'freeze', 0, (self: RClass) => {
  self.frozen = true;
  return self;
});
def('Module', 'module_function?', 0, () => false, PRIVATE);

def('Class', 'superclass', 0, (self: RClass) => {
  let parent = self.superclass;
  while (parent?.isSingleton) parent = parent.superclass;
  return parent ?? NIL;
});
def('Class', 'allocate', 0, (self: RClass) => allocate(self));
def(
  'Class',
  'new',
  [0, -1],
  function* (self: RClass, args, block, keywords) {
    const object = allocate(self);
    const initialize = classOf(object).findMethod('initialize');
    if (initialize) yield* invoke(initialize, object, args, keywords, block, false);
    return object;
  },
  { keywords: true }
);
def('Class', 'class', 0, (self: RClass) => (self.isModule ? rt().c.Module : rt().c.Class));
sdef('Class', 'new', [0, 1], function* (_self, [superclass], block) {
  const runtime = rt();
  const parent = superclass ?? runtime.c.Object;
  if (!(parent instanceof RClass) || parent.isModule) {
    throw typeError(`superclass must be an instance of Class (given an instance of ${realClassOf(parent).name})`);
  }
  if (parent === runtime.c.Class) throw typeError("can't make subclass of Class");
  if (parent.isSingleton) throw typeError("can't make subclass of singleton class");
  const cls = new RClass(runtime.c.Class, undefined, parent, false);
  cls.isUserDefined = true;
  const inherited = classOf(parent).findMethod('inherited');
  if (inherited?.body.kind === 'user') yield* invoke(inherited, parent, [cls], undefined, undefined, false);
  if (block) yield* callProc(block, [cls], { self: cls, definitionTarget: cls });
  return cls;
});

/** Makes an uninitialized instance of a class, of the kind its library ancestor makes. */
export function allocate(cls: RClass): Value {
  const runtime = rt();
  if (cls.isSingleton) throw typeError("can't create instance of singleton class");
  switch (cls.instanceKind) {
    case 'string': {
      return new RString(cls, '');
    }
    case 'array': {
      return new RArray(cls, []);
    }
    case 'hash': {
      return new RHash(cls);
    }
    case 'exception': {
      const object = new RObject(cls);
      object.exception = { message: NIL, cause: NIL };
      return object;
    }
    case 'none': {
      throw rubyError(runtime.c.NoMethodError, `undefined method 'new' for class ${cls.name}`);
    }
    default: {
      if (cls === runtime.c.Module || cls === runtime.c.Class) {
        throw new UnsupportedFeatureError(`${cls.name}.new`);
      }
      return new RObject(cls);
    }
  }
}

sdef('Module', 'new', 0, () => {
  throw new UnsupportedFeatureError('Module.new');
});

// nil, true, false ----------------------------------------------------------------------------------------------------

def('NilClass', 'to_s', 0, () => str(''));
def('NilClass', 'to_a', 0, () => arr([]));
def('NilClass', 'to_h', 0, () => newHash());
def('NilClass', 'to_i', 0, () => 0n);
def('NilClass', 'to_f', 0, () => 0);
def('NilClass', 'inspect', 0, () => str('nil'));
def('NilClass', '&', 1, () => false);
def('NilClass', '|', 1, (_self, [other]) => truthy(other));
def('NilClass', 'nil?', 0, () => true);
def('TrueClass', ['to_s', 'inspect'], 0, () => str('true'));
def('TrueClass', '&', 1, (_self, [other]) => truthy(other));
def('TrueClass', '|', 1, () => true);
def('TrueClass', '^', 1, (_self, [other]) => !truthy(other));
def('TrueClass', '!', 0, () => false);
def('FalseClass', ['to_s', 'inspect'], 0, () => str('false'));
def('FalseClass', '&', 1, () => false);
def('FalseClass', '|', 1, (_self, [other]) => truthy(other));
def('FalseClass', '^', 1, (_self, [other]) => truthy(other));
def('FalseClass', '!', 0, () => true);

// Exceptions ----------------------------------------------------------------------------------------------------------

def(
  'Exception',
  'initialize',
  [0, 1],
  function* (self: RObject, [message = NIL]) {
    if (self.frozen) throw frozenError(self, yield* inspectException(self));
    (self.exception as NonNullable<RObject['exception']>).message = message;
    return NIL;
  },
  PRIVATE
);
sdef('Exception', 'exception', [0, -1], function* (self: RClass, args, block, keywords) {
  return yield* callMethod(self, 'new', args, keywords, block);
});
def('Exception', 'exception', [0, 1], function* (self: RObject, args) {
  if (args.length === 0 || args[0] === self) return self;
  const copy = (yield* callMethod(self, 'clone', [])) as RObject;
  if (copy.frozen) throw frozenError(copy, yield* inspectException(copy));
  (copy.exception as NonNullable<RObject['exception']>).message = args[0];
  return copy;
});
def('Exception', 'to_s', 0, function* (self: RObject) {
  const message = self.exception?.message ?? NIL;
  if (message === NIL) return str(className(realClassOf(self)));
  if (message instanceof RString) return message;
  const converted = yield* callMethod(message, 'to_s', [], undefined, undefined, { fcall: true });
  if (!(converted instanceof RString)) {
    const name = realClassOf(message).name;
    throw typeError(`can't convert ${name} to String (${name}#to_s gives ${realClassOf(converted).name})`);
  }
  return converted;
});
def('Exception', 'message', 0, function* (self: RObject) {
  return yield* callMethod(self, 'to_s', []);
});
def('Exception', 'detailed_message', [0, -1], () => {
  throw new UnsupportedFeatureError('Exception#detailed_message');
});
def('Exception', 'inspect', 0, function* (self: RObject) {
  return str(yield* inspectException(self));
});
def('Exception', 'full_message', [0, -1], () => {
  throw new UnsupportedFeatureError('full_message');
});
def('Exception', ['backtrace', 'backtrace_locations', 'set_backtrace'], [0, -1], () => {
  throw new UnsupportedFeatureError('backtrace');
});
def('Exception', 'cause', 0, (self: RObject) => self.exception?.cause ?? NIL);
def('Exception', '==', 1, function* (self: RObject, [other]) {
  if (self === other) return true;
  if (!(other instanceof RObject) || !other.exception || realClassOf(self) !== realClassOf(other)) return false;
  return yield* rEquals(yield* callMethod(self, 'message', []), yield* callMethod(other, 'message', []));
});
def('NameError', 'name', 0, (self: RObject) => self.ivars?.get('@__name') ?? NIL);
def('NameError', 'receiver', 0, (self: RObject) => self.ivars?.get('@__receiver') ?? NIL);
def('FrozenError', 'receiver', 0, (self: RObject) => self.ivars?.get('@__receiver') ?? NIL);
def('KeyError', 'key', 0, (self: RObject) => self.ivars?.get('@__key') ?? NIL);
def('KeyError', 'receiver', 0, (self: RObject) => self.ivars?.get('@__receiver') ?? NIL);
def('StopIteration', 'result', 0, (self: RObject) => self.ivars?.get('@result') ?? NIL);
def('SystemExit', 'status', 0, (self: RObject) => self.ivars?.get('@__status') ?? 0n);
def('SystemExit', 'success?', 0, (self: RObject) => (self.ivars?.get('@__status') ?? 0n) === 0n);

// Comparable ----------------------------------------------------------------------------------------------------------

class ComparableCycle {
  constructor(
    readonly receiver: Value,
    readonly other: Value
  ) {}
}

function* compareOrFail(self: Value, other: Value): Gen<number> {
  return yield* compareValues(self, other);
}

def('Comparable', '==', 1, function* (self, [other]) {
  if (self === other) return true;
  const pairs = rt().comparablePairs;
  const active = pairs.get(self) ?? new Set<Value>();
  if (active.has(other)) throw new ComparableCycle(self, other);
  active.add(other);
  pairs.set(self, active);
  try {
    const result = yield* callMethod(self, '<=>', [other]);
    if (result === NIL) return false;
    return (yield* comparisonSign(result)) === 0;
  } catch (error) {
    if (error instanceof ComparableCycle && error.receiver === self && error.other === other) return false;
    throw error;
  } finally {
    active.delete(other);
    if (active.size === 0) pairs.delete(self);
  }
});
def('Comparable', '>', 1, function* (self, [other]) {
  return (yield* compareOrFail(self, other)) > 0;
});
def('Comparable', '>=', 1, function* (self, [other]) {
  return (yield* compareOrFail(self, other)) >= 0;
});
def('Comparable', '<', 1, function* (self, [other]) {
  return (yield* compareOrFail(self, other)) < 0;
});
def('Comparable', '<=', 1, function* (self, [other]) {
  return (yield* compareOrFail(self, other)) <= 0;
});
def('Comparable', 'between?', 2, function* (self, [min, max]) {
  return (yield* compareOrFail(self, min)) >= 0 && (yield* compareOrFail(self, max)) <= 0;
});
def('Comparable', 'clamp', [1, 2], function* (self, args) {
  let [min, max] = args;
  if (args.length === 1) {
    if (!(min instanceof RRange)) throw typeError(`wrong argument type ${realClassOf(min).name} (expected Range)`);
    if (min.exclusive && min.end !== NIL) throw argumentError('cannot clamp with an exclusive range');
    [min, max] = [min.begin, min.end];
  }
  if (min !== NIL && max !== NIL && (yield* compareOrFail(min, max)) > 0) {
    throw argumentError('min argument must be less than or equal to max argument');
  }
  if (min !== NIL && (yield* compareOrFail(self, min)) < 0) return min;
  if (max !== NIL && (yield* compareOrFail(self, max)) > 0) return max;
  return self;
});

// Proc ----------------------------------------------------------------------------------------------------------------

def(
  'Proc',
  ['call', '()', 'yield', '===', '[]'],
  [0, -1],
  function* (self: RProc, args, block, keywords) {
    return yield* callProc(self, args, { keywords, block, callRow: rt().currentRow });
  },
  { keywords: true }
);
def('Proc', 'to_proc', 0, (self) => self);
def('Proc', 'lambda?', 0, (self: RProc) => self.isLambda);
def('Proc', 'arity', 0, (self: RProc) => BigInt(procArity(self)));
def('Proc', 'parameters', 0, () => {
  throw new UnsupportedFeatureError('Proc#parameters');
});
def('Proc', ['inspect', 'to_s'], 0, (self: RProc) => str(inspectProc(self)));
def('Proc', 'curry', [0, 1], function* (self: RProc, args) {
  const arity = args.length > 0 ? yield* toRubyInt(args[0]) : procArity(self);
  if (args.length > 0 && self.isLambda) {
    const [minimum, maximum] = lambdaCurryBounds(self);
    if (arity < minimum || (maximum >= 0 && arity > maximum)) throw argumentCountError(arity, minimum, maximum);
  }
  return curry(self, arity < 0 ? -arity - 1 : arity, []);
});

function lambdaCurryBounds(proc: RProc): [number, number] {
  if (proc.body.kind === 'native') {
    const arity = proc.body.arity;
    return arity < 0 ? [-arity - 1, -1] : [arity, arity];
  }
  const params = proc.body.def.params;
  if (!params) return [0, 0];
  const positional = params.required.length + params.post.length;
  const hasKeywords = params.keywords.length > 0 || params.keywordRest !== undefined;
  const required = positional + Number(params.keywords.some((keyword) => !keyword.value));
  return [required, params.rest === undefined ? positional + params.optional.length + Number(hasKeywords) : -1];
}
sdef('Proc', 'new', 0, (_self, _args, block) => requireProcBlock(block));

export function procArity(proc: RProc): number {
  if (proc.body.kind === 'native') return proc.body.arity;
  const { params } = proc.body.def;
  if (!params) return proc.isLambda ? 0 : -1;
  const positional = params.required.length + params.post.length;
  const requiredKeywords = params.keywords.some((keyword) => !keyword.value);
  const required = positional + Number(requiredKeywords);
  if (params.rest !== undefined || params.optional.length > 0) return -required - 1;
  if (proc.isLambda && !requiredKeywords && (params.keywords.length > 0 || params.keywordRest !== undefined))
    return -positional - 1;
  return required;
}

// The main object -----------------------------------------------------------------------------------------------------

/** Defines `to_s` and `inspect` on the main object, which Ruby shows as `main`. */
export function defineMainObject(main: RObject): void {
  const singleton = singletonClassOf(main);
  const object = rt().c.Object;
  const delegate = (name: string, visibility: Visibility): void => {
    singleton.methods.set(name, {
      name,
      owner: singleton,
      visibility: 'private',
      body: {
        kind: 'native',
        fn: (_self, args) => {
          if (name === 'include') return callMethod(object, 'include', args);
          return setVisibility(object, args, visibility);
        },
        min: 0,
        max: -1,
        takesKeywords: false,
      },
    });
  };
  delegate('include', 'public');
  delegate('public', 'public');
  delegate('private', 'private');
  delegate('protected', 'protected');
  for (const name of ['to_s', 'inspect']) {
    singleton.methods.set(name, {
      name,
      owner: singleton,
      visibility: 'public',
      body: { kind: 'native', fn: () => str('main'), min: 0, max: 0, takesKeywords: false },
    });
  }
}

export { anonymousClassName, frozenError, makeBlock, ivarSet };
