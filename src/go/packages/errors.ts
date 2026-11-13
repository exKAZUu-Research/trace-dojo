import type { Entity } from '../entities';
import { equalityOf } from '../equality';
import { newError } from '../errorValues';
import { dynamicMethod } from '../methods';
import { addMethod, definePackage, fn, namedType, nativeFunction } from '../native';
import { runtimeErrorPanic } from '../runtimeErrors';
import {
  ANY,
  BASIC,
  ERROR_TYPE,
  identical,
  isComparable,
  missingMethod,
  pointerTo,
  sliceOf,
  type Type,
  underlying,
} from '../types';
import { Cell, copyValue, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { libraryVariable } from './io';
import { receiverStruct, sliceValues } from './support';

const ERROR_SLICE = sliceOf(ERROR_TYPE);
const UNWRAP_SINGLE_IFACE = { kind: 'interface' as const, methods: [{ name: 'Unwrap', type: fn([], [ERROR_TYPE]) }] };
const UNWRAP_MULTI_IFACE = { kind: 'interface' as const, methods: [{ name: 'Unwrap', type: fn([], [ERROR_SLICE]) }] };
const IS_IFACE = { kind: 'interface' as const, methods: [{ name: 'Is', type: fn([ERROR_TYPE], [BASIC.bool]) }] };
const AS_IFACE = { kind: 'interface' as const, methods: [{ name: 'As', type: fn([ANY], [BASIC.bool]) }] };

/** `*errors.joinError`, which `errors.Join` returns. */
const JOIN_ERROR = namedType('errors', 'joinError', {
  kind: 'struct',
  fields: [{ name: 'errs', type: ERROR_SLICE, embedded: false }],
});
addMethod(
  JOIN_ERROR,
  'Error',
  fn([], [BASIC.string]),
  (receiver) =>
    sliceValues(receiverStruct(receiver).fields[0])
      .map((error) => errorMessage(error))
      .join('\n'),
  true
);
addMethod(JOIN_ERROR, 'Unwrap', fn([], [ERROR_SLICE]), (receiver) => receiverStruct(receiver).fields[0], true);

const members: Record<string, Entity> = {
  New: nativeFunction('New', fn([BASIC.string], [ERROR_TYPE]), ([text]) => newError(text as string)),
  Is: nativeFunction('Is', fn([ERROR_TYPE, ERROR_TYPE], [BASIC.bool]), ([error, target]) => is(error, target)),
  As: nativeFunction('As', fn([ERROR_TYPE, ANY], [BASIC.bool]), ([error, target]) => as(error, target)),
  Unwrap: nativeFunction('Unwrap', fn([ERROR_TYPE], [ERROR_TYPE]), ([error]) => {
    if (error === undefined || unwrapKind((error as Iface).type) !== 'single') return;
    return dynamicMethod((error as Iface).type, 'Unwrap')?.((error as Iface).value, []) as Value;
  }),
  ErrUnsupported: libraryVariable('ErrUnsupported', ERROR_TYPE, newError('unsupported operation')),
  Join: nativeFunction('Join', fn([ERROR_SLICE], [ERROR_TYPE], true), ([errors]) => {
    const present = sliceValues(errors).filter((error) => error !== undefined);
    if (present.length === 0) return;
    const list = new Slice(present, 0, present.length, present.length);
    return new Iface(pointerTo(JOIN_ERROR), new Pointer(new Cell(new GoStruct([list])), 'v'));
  }),
};

/** The errors package, without AsType, which a program can only call with explicit type arguments. */
export const ERRORS_PACKAGE = definePackage('errors', members, ['AsType']);

function errorMessage(error: Value): string {
  const iface = error as Iface;
  return dynamicMethod(iface.type, 'Error')?.(iface.value, []) as string;
}

function is(error: Value, target: Value): boolean {
  if (error === undefined || target === undefined) return error === target;
  const targetComparable = isComparable((target as Iface).type);
  const visit = (current: Value): boolean => {
    if (current === undefined) return false;
    const iface = current as Iface;
    if (targetComparable && identical(iface.type, (target as Iface).type) && equalityOf(ANY)(current, target))
      return true;
    if (!missingMethod(iface.type, IS_IFACE) && dynamicMethod(iface.type, 'Is')?.(iface.value, [target]) === true)
      return true;
    return unwrapAll(iface).some(visit);
  };
  return visit(error);
}

function as(error: Value, target: Value): boolean {
  if (!(target instanceof Iface) || target.value === undefined || underlying(target.type).kind !== 'pointer') {
    runtimeErrorPanic('errors: target must be a non-nil pointer');
  }
  const elementType = (underlying(target.type) as { element: Parameters<typeof underlying>[0] }).element;
  const elementUnder = underlying(elementType);
  if (elementUnder.kind !== 'interface' && missingMethod(elementType, ERROR_TYPE.underlying as never)) {
    runtimeErrorPanic('errors: *target must be interface or implement error');
  }
  const pointer = target.value as Pointer;
  const visit = (current: Value): boolean => {
    if (current === undefined) return false;
    const iface = current as Iface;
    if (
      elementUnder.kind === 'interface' ? !missingMethod(iface.type, elementUnder) : identical(iface.type, elementType)
    ) {
      pointer.store(elementUnder.kind === 'interface' ? iface : copyValue(iface.value));
      return true;
    }
    if (!missingMethod(iface.type, AS_IFACE) && dynamicMethod(iface.type, 'As')?.(iface.value, [target]) === true)
      return true;
    return unwrapAll(iface).some(visit);
  };
  return visit(error);
}

/** The errors an error wraps, through `Unwrap() error` or `Unwrap() []error`. */
function unwrapAll(error: Iface): Value[] {
  const kind = unwrapKind(error.type);
  if (!kind) return [];
  const result = dynamicMethod(error.type, 'Unwrap')?.(error.value, []);
  if (kind === 'multiple') return sliceValues(result as Value);
  return result === undefined ? [] : [result as Value];
}

function unwrapKind(type: Type): 'single' | 'multiple' | undefined {
  if (!missingMethod(type, UNWRAP_SINGLE_IFACE)) return 'single';
  if (!missingMethod(type, UNWRAP_MULTI_IFACE)) return 'multiple';
  return undefined;
}
