// code-gauge-allow-file fileNcss 583 -- The libObject module keeps one concern's cases together.
import {
  anonymousClassName,
  anyToS,
  className,
  compareValues,
  inspect,
  inspectException,
  inspectObject,
  inspectProc,
  rEql,
  rEquals,
  toInt,
  toS,
  toStr,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, implicitConversionError, nameError, rubyError, typeError } from './errors';
import { hashKeyOf } from './hashes';
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
import { curry, makeEnumerator } from './libEnumerator';
import { kernelFloat, kernelInteger } from './libNumeric';
import {
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
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
import { arr, classOf, isA, newHash, realClassOf, singletonClassOf, str, sym, truthy } from './values';

// Object --------------------------------------------------------------------------------------------------------------

def('BasicObject', 'initialize', [0, -1], () => NIL, { visibility: 'private' });
def('BasicObject', '==', 1, (self, [other]) => self === other || (typeof self === 'number' && self === other));
def('BasicObject', 'equal?', 1, (self, [other]) => self === other);
def('BasicObject', '!', 0, (self) => !truthy(self));
def('BasicObject', '!=', 1, function* (self, [other]) {
  return !truthy(yield* callMethod(self, '==', [other]));
});
def('BasicObject', '__id__', 0, (self) => objectId(self));
def('Kernel', 'object_id', 0, (self) => objectId(self));

function objectId(value: Value): bigint {
  if (typeof value === 'bigint') return 2n * value + 1n;
  if (value === NIL) return 8n;
  if (value === true) return 20n;
  if (value === false) return 0n;
  if (value instanceof RBasic) return BigInt(value.id);
  if (value instanceof RSymbol) return BigInt(hashString(value.name) * 8 + 12);
  return 16n;
}

function hashString(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) as number)) % 1_000_003;
  return hash;
}

def('Kernel', 'class', 0, (self) => realClassOf(self));
def('Kernel', 'singleton_class', 0, (self) => {
  if (!(self instanceof RBasic)) throw typeError("can't define singleton");
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
def('Kernel', 'hash', 0, function* (self) {
  return BigInt(hashString(yield* hashKeyOf(self)));
});
def('Kernel', '<=>', 1, function* (self, [other]) {
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
  [0, 1],
  function* (self, _args, _block, keywords) {
    let keepFrozen = true;
    if (keywords) {
      for (const entry of keywords.map.values()) {
        if (entry.key instanceof RSymbol && entry.key.name === 'freeze') keepFrozen = entry.value !== false;
      }
    }
    return yield* copyObject(self, keepFrozen);
  },
  { keywords: true }
);

// code-gauge-allow functionCognitiveComplexity 18 -- Ruby's method takes these argument forms, which the branches mirror.
// code-gauge-allow functionNcss 39 -- Ruby's method takes these argument forms, which the branches mirror.
function* copyObject(self: Value, keepFrozen: boolean): Gen {
  if (!(self instanceof RBasic) || self instanceof RClass) return self;
  let copy: RBasic;
  if (self instanceof RString) copy = new RString(self.cls, self.s);
  else if (self instanceof RArray) copy = new RArray(self.cls, [...self.items]);
  else if (self instanceof RHash) {
    const hash = new RHash(self.cls);
    for (const [key, entry] of self.map) hash.map.set(key, { ...entry });
    hash.defaultValue = self.defaultValue;
    hash.defaultProc = self.defaultProc;
    hash.byIdentity = self.byIdentity;
    copy = hash;
  } else if (self instanceof RObject) {
    const object = new RObject(self.cls);
    if (self.exception) object.exception = { ...self.exception };
    if (self.turtle) throw typeError(`can't copy Turtle`);
    object.data = copyData(self.data);
    copy = object;
  } else if (self instanceof RProc) {
    return self;
  } else {
    return self;
  }
  if (self.ivars) copy.ivars = new Map(self.ivars);
  if (keepFrozen) copy.frozen = self.frozen;
  const initializeCopy = classOf(copy).findMethod('initialize_copy');
  if (initializeCopy && initializeCopy.body.kind === 'user') {
    yield* invoke(initializeCopy, copy, [self], undefined, undefined, false);
  }
  return copy;
}

function copyData(data: unknown): unknown {
  if (data && typeof data === 'object' && 'copy' in data && typeof data.copy === 'function') return data.copy();
  return data;
}

def('Kernel', 'extend', [1, -1], (self, modules) => {
  if (!(self instanceof RBasic)) throw typeError("can't define singleton");
  const singleton = singletonClassOf(self);
  for (const module of modules.toReversed()) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
    if (!singleton.includes.includes(module)) singleton.includes.unshift(module);
  }
  invalidateMethodCaches();
  return self;
});
def('Kernel', 'display', 0, function* (self) {
  rt().io.stdout.write(yield* toS(self));
  return NIL;
});
def('Kernel', ['to_enum', 'enum_for'], [0, -1], function* (self, args) {
  const [method = sym('each'), ...rest] = args;
  if (!(method instanceof RSymbol)) throw typeError(`${yield* inspect(method)} is not a symbol nor a string`);
  return makeEnumerator(self, method.name, rest);
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
    const proc = requireBlock(block);
    if (proc.body.kind === 'block' && proc.callSiteActive !== undefined) proc.isLambda = true;
    return proc;
  },
  PRIVATE
);
def('Kernel', 'proc', 0, (_self, _args, block) => requireBlock(block), PRIVATE);
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
// code-gauge-allow functionNcss 34 -- Ruby's method takes these argument forms, which the branches mirror.
// code-gauge-allow functionCognitiveComplexity 25 -- Ruby's method takes these argument forms, which the branches mirror.
export function* makeRaise(args: Value[], keywords?: RHash): Gen<RubyError> {
  const runtime = rt();
  let cause: Value | undefined;
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (entry.key instanceof RSymbol && entry.key.name === 'cause') cause = entry.value;
      else args = [...args, keywords];
    }
  }
  let exception: Value;
  if (args.length === 0) {
    const current = runtime.globals.get('$!');
    if (current instanceof RObject && current.exception) return new RubyError(current);
    exception = (yield* callMethod(runtime.c.RuntimeError, 'new', [str('unhandled exception')])) as Value;
  } else if (args[0] instanceof RString && args.length === 1) {
    exception = yield* callMethod(runtime.c.RuntimeError, 'new', [args[0]]);
  } else {
    const [target, message] = args;
    if (!respondsTo(target, 'exception')) throw typeError('exception class/object expected');
    exception = yield* callMethod(target, 'exception', message === undefined ? [] : [message]);
    if (!(exception instanceof RObject) || !exception.exception) throw typeError('exception object expected');
  }
  const object = exception as RObject;
  const state = object.exception as NonNullable<RObject['exception']>;
  const current = runtime.globals.get('$!') ?? NIL;
  if (cause !== undefined) state.cause = cause;
  else if (state.cause === NIL && current !== object) state.cause = current;
  return new RubyError(object);
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
      if (error instanceof ThrowSignal && error.tag === tag) return error.value;
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
      if (active === tag || (yield* rEquals(active, tag))) throw new ThrowSignal(active, value);
    }
    throw rubyError(runtime.c.UncaughtThrowError, `uncaught throw ${yield* inspect(tag)}`);
  },
  PRIVATE
);

def(
  'Kernel',
  'exit',
  [0, 1],
  (_self, [status = true]) => {
    const error = rubyError(rt().c.SystemExit, 'exit');
    error.exception.ivars = new Map([['@__status', status === true ? 0n : status === false ? 1n : status]]);
    throw error;
  },
  PRIVATE
);
def(
  'Kernel',
  'exit!',
  [0, 1],
  () => {
    throw rubyError(rt().c.SystemExit, 'exit');
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

def(
  'Kernel',
  'String',
  1,
  function* (_self, [value]) {
    if (value instanceof RString) return value;
    return str(yield* toS(value));
  },
  PRIVATE
);
def(
  'Kernel',
  'Array',
  1,
  function* (_self, [value]) {
    if (value instanceof RArray) return value;
    if (value === NIL) return arr([]);
    if (respondsTo(value, 'to_ary')) return yield* callMethod(value, 'to_ary', []);
    if (respondsTo(value, 'to_a')) return yield* callMethod(value, 'to_a', []);
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
    if (value === NIL || (value instanceof RArray && value.items.length === 0)) return newHash();
    if (respondsTo(value, 'to_hash')) return yield* callMethod(value, 'to_hash', []);
    throw implicitConversionError(value, 'Hash');
  },
  PRIVATE
);

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
  ['eval', '文字列の評価（eval）'],
  ['binding', 'binding'],
  ['caller', '呼び出し履歴（caller）'],
  ['caller_locations', '呼び出し履歴（caller_locations）'],
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
  ['singleton_method', 'singleton_method'],
  ['methods', 'methods'],
  ['public_methods', 'public_methods'],
  ['private_methods', 'private_methods'],
  ['protected_methods', 'protected_methods'],
  ['singleton_methods', 'singleton_methods'],
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
def('Module', 'include', [1, -1], function* (self: RClass, modules) {
  for (const module of modules) {
    if (!(module instanceof RClass) || !module.isModule) {
      throw typeError(`wrong argument type ${realClassOf(module).name} (expected Module)`);
    }
  }
  for (const module of modules.toReversed() as RClass[]) {
    if (self.ancestors().includes(module)) continue;
    self.includes.unshift(module);
    invalidateMethodCaches();
    const hook = classOf(module).findMethod('included');
    if (hook && hook.body.kind === 'user') yield* invoke(hook, module, [self], undefined, undefined, false);
  }
  return self;
});

for (const name of ['instance_methods', 'public_instance_methods', 'private_instance_methods', 'refine', 'using']) {
  def('Module', name, [0, -1], () => {
    throw new UnsupportedFeatureError(name);
  });
}

function* symbolNames(args: Value[]): Gen<string[]> {
  const names: string[] = [];
  for (const arg of args) {
    if (arg instanceof RSymbol) names.push(arg.name);
    else if (arg instanceof RString) names.push(arg.s);
    else if (arg instanceof RArray) names.push(...(yield* symbolNames(arg.items)));
    else throw typeError(`${yield* inspect(arg)} is not a symbol nor a string`);
  }
  return names;
}

function defineAttributes(self: RClass, names: string[], reader: boolean, writer: boolean): RArray {
  const frame = rt().frame;
  const visibility = frame.kind === 'class' && frame.self === self ? frame.defaultVisibility : 'public';
  const defined: Value[] = [];
  for (const name of names) {
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

def('Module', ['attr_reader', 'attr'], [0, -1], function* (self: RClass, args) {
  return defineAttributes(self, yield* symbolNames(args), true, false);
});
def('Module', 'attr_writer', [0, -1], function* (self: RClass, args) {
  return defineAttributes(self, yield* symbolNames(args), false, true);
});
def('Module', 'attr_accessor', [0, -1], function* (self: RClass, args) {
  return defineAttributes(self, yield* symbolNames(args), true, true);
});

function* setVisibility(self: RClass, args: Value[], visibility: Visibility): Gen {
  const frame = rt().frame;
  if (args.length === 0) {
    if (frame.kind === 'class' && frame.self === self) {
      frame.defaultVisibility = visibility;
      frame.moduleFunction = false;
    }
    return NIL;
  }
  for (const name of yield* symbolNames(args)) {
    const method = self.findMethod(name);
    if (!method) {
      throw nameError(
        `undefined method '${name}' for ${self.isModule ? 'module' : 'class'} '${self.name}'`,
        self,
        name
      );
    }
    if (method.owner === self) method.visibility = visibility;
    else addMethod(self, { ...method, owner: self, visibility });
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
def('Module', 'private_constant', [0, -1], () => NIL);
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
  const cls = new RClass(runtime.c.Class, undefined, parent, false);
  cls.isUserDefined = true;
  if (block) yield* callProc(block, [cls], { self: cls });
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
  (self: RObject, [message = NIL]) => {
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
  (copy.exception as NonNullable<RObject['exception']>).message = args[0];
  return copy;
});
def('Exception', 'to_s', 0, function* (self: RObject) {
  const message = self.exception?.message ?? NIL;
  if (message === NIL) return str(className(realClassOf(self)));
  if (message instanceof RString) return message;
  return str(yield* toS(message));
});
def('Exception', 'message', 0, function* (self: RObject) {
  return str(yield* toS(yield* callMethod(self, 'to_s', [])));
});
def('Exception', 'detailed_message', [0, -1], function* (self: RObject) {
  return str(yield* toS(yield* callMethod(self, 'message', [])));
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

function* compareOrFail(self: Value, other: Value): Gen<number> {
  return yield* compareValues(self, other);
}

def('Comparable', '==', 1, function* (self, [other]) {
  if (self === other) return true;
  const result = yield* callMethod(self, '<=>', [other]);
  if (result === NIL) return false;
  return result === 0n || result === 0;
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
def('Proc', ['inspect', 'to_s'], 0, (self: RProc) => str(inspectProc(self)));
def('Proc', 'curry', [0, 1], function* (self: RProc, args) {
  const arity = args.length > 0 ? Number(yield* toInt(args[0])) : procArity(self);
  return curry(self, arity < 0 ? -arity - 1 : arity, []);
});
sdef('Proc', 'new', 0, (_self, _args, block) => requireBlock(block));

export function procArity(proc: RProc): number {
  if (proc.body.kind === 'native') return proc.body.arity;
  const { params } = proc.body.def;
  if (!params) return proc.isLambda ? 0 : -1;
  const required = params.required.length + params.post.length;
  const requiredKeywords = params.keywords.some((keyword) => !keyword.value);
  if (params.rest !== undefined || (params.optional.length > 0 && proc.isLambda)) return -required - 1;
  if (!proc.isLambda && params.optional.length > 0) return -required - 1;
  if (requiredKeywords && required === 0) return 1;
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
