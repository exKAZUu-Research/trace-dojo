import { combineDelegates, removeDelegate } from './delegates';
import type { NativeMethod } from './natives';
import type { FieldSymbol } from './types';
import { CsBox, CsObject, CsStruct, type Value } from './values';

/**
 * The `add` or `remove` accessor that C# gives a field-like event, which subscribes a handler to the event's delegate
 * field. Calls through an interface's event reach a class's field-like event by this accessor.
 */
export function fieldEventAccessor(field: FieldSymbol, isAdd: boolean): NativeMethod {
  return (call, receiver, args) => {
    const fields = fieldsOf(receiver);
    const handler = args[0] as Value;
    fields[field.slot] = isAdd
      ? combineDelegates(call.frame.runtime, fields[field.slot], handler)
      : removeDelegate(call.frame.runtime, fields[field.slot], handler);
    return;
  };
}

function fieldsOf(receiver: Value): Value[] {
  if (receiver instanceof CsObject || receiver instanceof CsStruct) return receiver.fields;
  if (receiver instanceof CsBox && receiver.value instanceof CsStruct) return receiver.value.fields;
  throw new Error('A field-like event accessor needs an object receiver');
}
