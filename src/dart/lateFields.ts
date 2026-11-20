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
    const computed = initialize(runtime, object);
    if (field.isFinal && object.fields[slot] !== UNINITIALIZED)
      runtime.throwError('LateError', '', [`Field '${name}' has been assigned during initialization.`]);
    object.fields[slot] = computed;
    return computed;
  };
}

export function lateFieldSetter(field: FieldMember): Callable {
  const { slot, name } = field;
  return (runtime, receiver, args) => {
    const object = receiver as DartObject;
    if (field.isFinal && object.fields[slot] !== UNINITIALIZED)
      runtime.throwError('LateError', '', [`Field '${name}' has already been initialized.`]);
    object.fields[slot] = args.positional[0];
    return;
  };
}
