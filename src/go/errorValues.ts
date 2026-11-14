import { addMethod, fn, namedType } from './native';
import { nilPointerPanic } from './runtimeErrors';
import { BASIC, type NamedType, pointerTo } from './types';
import { Cell, GoStruct, Iface, Pointer, type Value } from './values';

/** The type of the errors `errors.New` makes, which `%T` prints as `*errors.errorString`. */
export const ERROR_STRING_TYPE: NamedType = namedType('errors', 'errorString', {
  kind: 'struct',
  fields: [{ name: 's', type: BASIC.string, embedded: false }],
});
addMethod(
  ERROR_STRING_TYPE,
  'Error',
  fn([], [BASIC.string]),
  (receiver) => {
    if (!(receiver instanceof Pointer)) nilPointerPanic();
    return (receiver.load() as GoStruct).fields[0];
  },
  true
);

/** A new error value, as `errors.New(text)` returns, where `text` holds UTF-8 bytes. */
export function newError(text: string): Value {
  return new Iface(pointerTo(ERROR_STRING_TYPE), new Pointer(new Cell(new GoStruct([text])), 'v'));
}
