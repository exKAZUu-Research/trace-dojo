import { addMethod, fn, namedType } from './native';
import { GoPanic } from './runtime';
import { BASIC, type NamedType, pointerTo } from './types';
import { Cell, GoStruct, Iface, Pointer, type Value } from './values';

function errorType(name: string, prefix: string, pointer = false, pkg = 'runtime'): NamedType {
  const type = namedType(pkg, name, { kind: 'struct', fields: [] });
  const message = (receiver: Value): string => {
    if (pointer && !(receiver instanceof Pointer)) nilPointerPanic();
    const struct = (receiver instanceof Pointer ? receiver.load() : receiver) as GoStruct | undefined;
    if (!struct) nilPointerPanic();
    return prefix + String(struct.native?.message);
  };
  addMethod(type, 'Error', fn([], [BASIC.string]), (receiver) => message(receiver), pointer);
  addMethod(type, 'RuntimeError', fn([], []), () => {}, pointer);
  return type;
}

/** The types of Go's runtime errors, as `%T` names them. */
const BOUNDS_ERROR = errorType('boundsError', 'runtime error: ');
const ERROR_STRING = errorType('errorString', 'runtime error: ');
const PLAIN_ERROR = errorType('plainError', '');
export const TYPE_ASSERTION_ERROR = errorType('TypeAssertionError', '', true);
export const PANIC_NIL_ERROR = errorType('PanicNilError', 'runtime error: ', true);
const UNHASHABLE_TYPE_ERROR = errorType('unhashableTypeError', 'hash of unhashable type: ', false, 'maps');

function errorValue(type: NamedType, message: string, pointer = false): Iface {
  const struct = new GoStruct([], { message });
  if (!pointer) return new Iface(type, struct);
  return new Iface(pointerTo(type), new Pointer(new Cell(struct), 'v'));
}

export function boundsPanic(message: string): never {
  throw new GoPanic(errorValue(BOUNDS_ERROR, message));
}

export function indexPanic(index: bigint | number, length: number): never {
  if (index < 0) boundsPanic(`index out of range [${index}]`);
  boundsPanic(`index out of range [${index}] with length ${length}`);
}

export function divideByZeroPanic(): never {
  throw new GoPanic(errorValue(ERROR_STRING, 'integer divide by zero'));
}

export function nilPointerPanic(): never {
  throw new GoPanic(errorValue(ERROR_STRING, 'invalid memory address or nil pointer dereference'));
}

export function runtimeErrorPanic(message: string): never {
  throw new GoPanic(errorValue(ERROR_STRING, message));
}

export function plainPanic(message: string): never {
  throw new GoPanic(errorValue(PLAIN_ERROR, message));
}

export function typeAssertionPanic(message: string): never {
  throw new GoPanic(errorValue(TYPE_ASSERTION_ERROR, `interface conversion: ${message}`, true));
}

/** The panic of a lookup or delete in a nil or empty map whose key holds a value of an unhashable type. */
export function unhashableKeyPanic(typeName: string): never {
  throw new GoPanic(errorValue(UNHASHABLE_TYPE_ERROR, typeName));
}

/** The value `panic(nil)` panics with since Go 1.21. */
export function panicNilValue(): Value {
  return errorValue(PANIC_NIL_ERROR, 'panic called with nil argument', true);
}
