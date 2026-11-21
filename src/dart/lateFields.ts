import type { FieldMember } from './classes';
import type { Runtime } from './runtime';
import { type Callable, type DartObject, UNINITIALIZED, type Value } from './values';

type LateInitializer = (runtime: Runtime, receiver: DartObject) => Value;

export function lateFieldGetter(field: FieldMember, initializer: () => LateInitializer | undefined): Callable {
  const { slot, name } = field;
  return (runtime, receiver) => {
    const object = receiver as DartObject;
    const value = object.fields[slot];
    if (value !== UNINITIALIZED) return value;
    const initialize = initializer();
    if (!initialize) return runtime.throwError('LateError', '', [`Field '${name}' has not been initialized.`]);
    return initializeField(
      runtime,
      name,
      field.isFinal,
      () => initialize(runtime, object),
      () => object.fields[slot],
      (computed) => {
        object.fields[slot] = computed;
      }
    );
  };
}

export function initializeField(
  runtime: Runtime,
  name: string,
  isFinal: boolean,
  initialize: () => Value,
  read: () => Value,
  write: (value: Value) => void
): Value {
  const computed = initialize();
  if (isFinal && read() !== UNINITIALIZED)
    runtime.throwError('LateError', '', [`Field '${name}' has been assigned during initialization.`]);
  write(computed);
  return computed;
}

export function lateFieldSetter(field: FieldMember): Callable {
  const { slot, name } = field;
  return (runtime, receiver, args) => {
    const object = receiver as DartObject;
    const value = args.positional[0];
    runtime.checkFieldWrite(object, field, value, args.isDynamic);
    if (field.isFinal && object.fields[slot] !== UNINITIALIZED)
      runtime.throwError('LateError', '', [`Field '${name}' has already been initialized.`]);
    object.fields[slot] = value;
    return;
  };
}
