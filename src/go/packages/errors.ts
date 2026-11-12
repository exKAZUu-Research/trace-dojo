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
  underlying,
} from '../types';
import { Cell, copyValue, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { sliceValues } from './support';

const ERROR_SLICE = sliceOf(ERROR_TYPE);

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
    sliceValues(((receiver as Pointer).load() as GoStruct).fields[0])
      .map((error) => errorMessage(error))
      .join('\n'),
  true
);
addMethod(
  JOIN_ERROR,
  'Unwrap',
  fn([], [ERROR_SLICE]),
  (receiver) => ((receiver as Pointer).load() as GoStruct).fields[0],
  true
);

function errorMessage(error: Value): string {
  const iface = error as Iface;
  return dynamicMethod(iface.type, 'Error')?.(iface.value, []) as string;
}

/** The errors an error wraps, through `Unwrap() error` or `Unwrap() []error`. */
function unwrapAll(error: Iface): Value[] {
  const call = dynamicMethod(error.type, 'Unwrap');
  if (!call) return [];
  const result = call(error.value, []);
  if (result instanceof Slice || result === undefined) {
    const type = (error.type.kind === 'pointer' ? error.type.element : error.type) as never;
    void type;
    if (result instanceof Slice) return result.values();
  }
  return result === undefined ? [] : [result as Value];
}

function unwrapType(error: Iface): 'single' | 'multiple' | undefined {
  const call = dynamicMethod(error.type, 'Unwrap');
  if (!call) return undefined;
  const result = call(error.value, []);
  return result instanceof Slice ? 'multiple' : 'single';
}

function is(error: Value, target: Value): boolean {
  if (error === undefined || target === undefined) return error === target;
  const targetComparable = isComparable((target as Iface).type);
  const visit = (current: Value): boolean => {
    if (current === undefined) return false;
    const iface = current as Iface;
    if (targetComparable && identical(iface.type, (target as Iface).type) && equalityOf(ANY)(current, target))
      return true;
    const isMethod = dynamicMethod(iface.type, 'Is');
    if (isMethod && isMethod(iface.value, [target]) === true) return true;
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
    const asMethod = dynamicMethod(iface.type, 'As');
    if (asMethod && asMethod(iface.value, [target]) === true) return true;
    return unwrapAll(iface).some(visit);
  };
  return visit(error);
}

const members: Record<string, Entity> = {
  New: nativeFunction('New', fn([BASIC.string], [ERROR_TYPE]), ([text]) => newError(text as string)),
  Is: nativeFunction('Is', fn([ERROR_TYPE, ERROR_TYPE], [BASIC.bool]), ([error, target]) => is(error, target)),
  As: nativeFunction('As', fn([ERROR_TYPE, ANY], [BASIC.bool]), ([error, target]) => as(error, target)),
  Unwrap: nativeFunction('Unwrap', fn([ERROR_TYPE], [ERROR_TYPE]), ([error]) => {
    if (error === undefined || unwrapType(error as Iface) !== 'single') return;
    return dynamicMethod((error as Iface).type, 'Unwrap')?.((error as Iface).value, []) as Value;
  }),
  Join: nativeFunction('Join', fn([ERROR_SLICE], [ERROR_TYPE], true), ([errors]) => {
    const present = sliceValues(errors).filter((error) => error !== undefined);
    if (present.length === 0) return;
    const list = new Slice(present, 0, present.length, present.length);
    return new Iface(pointerTo(JOIN_ERROR), new Pointer(new Cell(new GoStruct([list])), 'v'));
  }),
};

export const ERRORS_PACKAGE = definePackage('errors', members, ['ErrUnsupported']);
