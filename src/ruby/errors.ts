import { NIL, type RClass, RObject, RString, RSymbol, type Value } from './objects';
import { rt, RubyError } from './runtime';
import { realClassOf, str } from './values';

/** Creates a Ruby exception of `cls` with `message`, to throw. */
export function rubyError(cls: RClass, message: string | Value): RubyError {
  const exception = new RObject(cls);
  exception.exception = { message: typeof message === 'string' ? str(message) : message, cause: NIL };
  return new RubyError(exception);
}

export function argumentError(message: string): RubyError {
  return rubyError(rt().c.ArgumentError, message);
}

export function typeError(message: string): RubyError {
  return rubyError(rt().c.TypeError, message);
}

export function runtimeError(message: string): RubyError {
  return rubyError(rt().c.RuntimeError, message);
}

export function indexError(message: string): RubyError {
  return rubyError(rt().c.IndexError, message);
}

export function rangeError(message: string): RubyError {
  return rubyError(rt().c.RangeError, message);
}

export function zeroDivisionError(): RubyError {
  return rubyError(rt().c.ZeroDivisionError, 'divided by 0');
}

export function floatDomainError(message: string): RubyError {
  return rubyError(rt().c.FloatDomainError, message);
}

export function nameError(message: string, receiver: Value = NIL, name?: string): RubyError {
  const error = rubyError(rt().c.NameError, message);
  setNameErrorFields(error.exception, receiver, name);
  return error;
}

export function noMethodError(message: string, receiver: Value, name: string): RubyError {
  const error = rubyError(rt().c.NoMethodError, message);
  setNameErrorFields(error.exception, receiver, name);
  return error;
}

function setNameErrorFields(exception: RObject, receiver: Value, name: string | undefined): void {
  exception.ivars ??= new Map();
  exception.ivars.set('@__receiver', receiver);
  exception.ivars.set('@__name', name === undefined ? NIL : RSymbol.of(name));
}

export function frozenError(value: Value, shown: string): RubyError {
  const error = rubyError(rt().c.FrozenError, `can't modify frozen ${realClassOf(value).name}: ${shown}`);
  error.exception.ivars = new Map([['@__receiver', value]]);
  return error;
}

export function argumentCountError(given: number, min: number, max: number): RubyError {
  return argumentError(`wrong number of arguments (given ${given}, expected ${expectedArity(min, max)})`);
}

export function expectedArity(min: number, max: number): string {
  if (max < 0) return `${min}+`;
  if (min === max) return String(min);
  return `${min}..${max}`;
}

/** How a NoMethodError names its receiver: `nil`, `true`, `main`, `class Foo`, or `an instance of Foo`. */
export function receiverDescription(value: Value): string {
  const runtime = rt();
  if (value === NIL) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === runtime.mainObject) return 'main';
  if (value instanceof RObject || value instanceof RString || !(typeof value === 'object')) {
    return `an instance of ${realClassOf(value).name}`;
  }
  const cls = value as RClass;
  if ('isModule' in cls && cls.constants !== undefined) {
    return `${cls.isModule ? 'module' : 'class'} ${cls.name ?? inspectAnonymous(cls)}`;
  }
  return `an instance of ${realClassOf(value).name}`;
}

function inspectAnonymous(cls: RClass): string {
  return `#<${cls.isModule ? 'Module' : 'Class'}:0x${'0'.repeat(16)}>`;
}

/** How "no implicit conversion of X into Y" names a value: `nil`, `true`, `false`, or its class. */
export function conversionName(value: Value): string {
  if (value === NIL) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return realClassOf(value).name ?? '';
}

export function implicitConversionError(value: Value, into: string): RubyError {
  return typeError(`no implicit conversion of ${conversionName(value)} into ${into}`);
}

export function frozenCheck(value: { frozen: boolean } & Value, shown: () => string): void {
  if (value.frozen) throw frozenError(value, shown());
}
