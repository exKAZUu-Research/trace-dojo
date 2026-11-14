import { installNatives, setSingletonFactory } from './define';
import { rubyError } from './errors';
import { installMathConstants } from './libNumeric';
import { defineMainObject } from './libObject';
import { NIL, RClass, RObject, type Value } from './objects';
import { type Runtime, stackTooDeepFactory } from './runtime';
import { singletonClassOf, str } from './values';

const EXCEPTION_TREE: [string, string][] = [
  ['NoMemoryError', 'Exception'],
  ['ScriptError', 'Exception'],
  ['LoadError', 'ScriptError'],
  ['NotImplementedError', 'ScriptError'],
  ['SyntaxError', 'ScriptError'],
  ['SecurityError', 'Exception'],
  ['SignalException', 'Exception'],
  ['Interrupt', 'SignalException'],
  ['StandardError', 'Exception'],
  ['ArgumentError', 'StandardError'],
  ['UncaughtThrowError', 'ArgumentError'],
  ['EncodingError', 'StandardError'],
  ['FiberError', 'StandardError'],
  ['IOError', 'StandardError'],
  ['EOFError', 'IOError'],
  ['IndexError', 'StandardError'],
  ['KeyError', 'IndexError'],
  ['StopIteration', 'IndexError'],
  ['ClosedQueueError', 'StopIteration'],
  ['LocalJumpError', 'StandardError'],
  ['NameError', 'StandardError'],
  ['NoMethodError', 'NameError'],
  ['RangeError', 'StandardError'],
  ['FloatDomainError', 'RangeError'],
  ['RegexpError', 'StandardError'],
  ['RuntimeError', 'StandardError'],
  ['FrozenError', 'RuntimeError'],
  ['SystemCallError', 'StandardError'],
  ['ThreadError', 'StandardError'],
  ['TypeError', 'StandardError'],
  ['ZeroDivisionError', 'StandardError'],
  ['SystemExit', 'Exception'],
  ['SystemStackError', 'Exception'],
];

export interface CoreClasses {
  BasicObject: RClass;
  Object: RClass;
  Module: RClass;
  Class: RClass;
  Kernel: RClass;
  Comparable: RClass;
  Enumerable: RClass;
  NilClass: RClass;
  TrueClass: RClass;
  FalseClass: RClass;
  Numeric: RClass;
  Integer: RClass;
  Float: RClass;
  String: RClass;
  Symbol: RClass;
  Array: RClass;
  Hash: RClass;
  Range: RClass;
  Proc: RClass;
  Exception: RClass;
  Math: RClass;
  Random: RClass;
  Turtle: RClass;
  Enumerator: RClass;
  IO: RClass;
  Set: RClass;
  [name: string]: RClass;
}

/** Creates the library's classes for one run, since a program may reopen and change them. */
export function bootstrap(runtime: Runtime): void {
  // Class's class is itself, which the constructor cannot express.
  const placeholder = undefined as unknown as RClass;
  const basicObject = new RClass(placeholder, 'BasicObject', undefined, false);
  const object = new RClass(placeholder, 'Object', basicObject, false);
  const module = new RClass(placeholder, 'Module', object, false);
  const klass = new RClass(placeholder, 'Class', module, false);
  for (const each of [basicObject, object, module, klass]) each.cls = klass;
  const c = { BasicObject: basicObject, Object: object, Module: module, Class: klass } as CoreClasses;
  runtime.c = c;
  for (const each of [basicObject, object, module, klass]) object.constants.set(each.baseName as string, each);

  const defineModule = (name: string, under: RClass = object): RClass => {
    const created = new RClass(module, name, undefined, true);
    created.lexicalParent = under;
    under.constants.set(name, created);
    c[under === object ? name : `${under.baseName}::${name}`] = created;
    return created;
  };
  const defineClass = (name: string, superclass: RClass, under: RClass = object): RClass => {
    const created = new RClass(klass, name, superclass, false);
    created.lexicalParent = under;
    under.constants.set(name, created);
    c[under === object ? name : `${under.baseName}::${name}`] = created;
    return created;
  };

  const kernel = defineModule('Kernel');
  object.includes.push(kernel);
  defineModule('Comparable');
  defineModule('Enumerable');
  defineClass('NilClass', object).instanceKind = 'none';
  defineClass('TrueClass', object).instanceKind = 'none';
  defineClass('FalseClass', object).instanceKind = 'none';
  const numeric = defineClass('Numeric', object);
  numeric.includes.push(c.Comparable);
  defineClass('Integer', numeric).instanceKind = 'none';
  defineClass('Float', numeric).instanceKind = 'none';
  const string = defineClass('String', object);
  string.instanceKind = 'string';
  string.includes.push(c.Comparable);
  const symbol = defineClass('Symbol', object);
  symbol.instanceKind = 'none';
  symbol.includes.push(c.Comparable);
  const array = defineClass('Array', object);
  array.instanceKind = 'array';
  array.includes.push(c.Enumerable);
  const hash = defineClass('Hash', object);
  hash.instanceKind = 'hash';
  hash.includes.push(c.Enumerable);
  defineClass('Range', object).includes.push(c.Enumerable);
  defineClass('Proc', object);
  const exception = defineClass('Exception', object);
  exception.instanceKind = 'exception';
  for (const [name, parent] of EXCEPTION_TREE) defineClass(name, c[parent]);
  const encoding = defineModule('Encoding');
  defineClass('CompatibilityError', c.EncodingError, encoding);
  const math = defineModule('Math');
  defineClass('DomainError', c.ArgumentError, math);
  const errno = defineModule('Errno');
  defineClass('EDOM', c.SystemCallError, errno);
  defineClass('Random', object);
  defineClass('Turtle', object);
  const enumerator = defineClass('Enumerator', object);
  enumerator.includes.push(c.Enumerable);
  defineClass('ArithmeticSequence', enumerator, enumerator);
  defineClass('Chain', enumerator, enumerator);
  defineClass('Yielder', object, enumerator);
  defineClass('IO', object);
  const set = defineClass('Set', object);
  set.includes.push(c.Enumerable);

  setSingletonFactory(singletonClassOf);
  installNatives(runtime);
  installMathConstants();
  object.constants.delete('IO');

  const main = new RObject(object);
  runtime.mainObject = main;
  defineMainObject(main);
  runtime.globals.set('$stdout', ioObject(runtime, 'stdout'));
  runtime.globals.set('$stderr', ioObject(runtime, 'stderr'));
  object.constants.set('STDOUT', runtime.globals.get('$stdout') as Value);
  object.constants.set('STDERR', runtime.globals.get('$stderr') as Value);
  runtime.globals.set('$!', NIL);
  runtime.globals.set('$,', NIL);
  const inputSeparator = str('\n');
  inputSeparator.frozen = true;
  runtime.globals.set('$/', inputSeparator);
  stackTooDeepFactory.create = () => rubyError(runtime.c.SystemStackError, 'stack level too deep');
}

function ioObject(runtime: Runtime, stream: 'stdout' | 'stderr'): RObject {
  const io = new RObject(runtime.c.IO);
  io.data = stream;
  return io;
}
