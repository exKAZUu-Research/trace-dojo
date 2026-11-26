import { defineNatives, type NativeCall } from '../natives';
import { type CsArray, CsObject, type Value } from '../values';
import { compositeFormat } from './nativesCore';
import { invariantObject } from './nativesGlobalization';
import { fail, failNull, libraryType } from './support';

const CONCRETE = 'System.Runtime.CompilerServices.FormattableStringFactory+ConcreteFormattableString';

/** The composite format and the arguments of a FormattableString that an interpolated string converted to. */
interface FormattableState {
  format: string;
  /** The array that `GetArguments` returns itself, as .NET's does. */
  arguments: CsArray;
}

function stateOf(receiver: Value): FormattableState {
  return (receiver as CsObject).native as FormattableState;
}

/** Formats a FormattableString as `string.Format` with a provider, the current culture for an undefined one. */
function formatted(call: NativeCall, receiver: Value, provider: Value): string {
  const { format, arguments: args } = stateOf(receiver);
  const object = libraryType(call, 'System.Object');
  const text = compositeFormat(
    call,
    format,
    args.values.map((value) => ({ value, type: object })),
    provider
  );
  call.frame.runtime.allocateString(text.length);
  return text;
}

function formattableArgument(value: Value): Value {
  if (value === undefined) failNull('formattable');
  return value;
}

defineNatives({
  'System.Runtime.CompilerServices.FormattableStringFactory.Create': (call, _receiver, [format, args]) => {
    if (format === undefined) failNull('format');
    if (args === undefined) failNull('arguments');
    const object = new CsObject(libraryType(call, CONCRETE), []);
    object.native = { format: format as string, arguments: args as CsArray } satisfies FormattableState;
    return object;
  },
  [`${CONCRETE}.get_Format`]: (_call, receiver) => stateOf(receiver).format,
  [`${CONCRETE}.get_ArgumentCount`]: (_call, receiver) => stateOf(receiver).arguments.values.length,
  [`${CONCRETE}.GetArguments`]: (_call, receiver) => stateOf(receiver).arguments,
  [`${CONCRETE}.GetArgument`]: (_call, receiver, [index]) => {
    const { values } = stateOf(receiver).arguments;
    if ((index as number) < 0 || (index as number) >= values.length)
      fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return values[index as number];
  },
  [`${CONCRETE}.ToString`]: (call, receiver, [provider]) => formatted(call, receiver, provider as Value),
  'System.FormattableString.ToString()': (call, receiver) => formatted(call, receiver, undefined),
  'System.FormattableString.ToString(string?, IFormatProvider?)': (call, receiver, [_ignored, provider]) =>
    formatted(call, receiver, provider as Value),
  'System.FormattableString.Invariant': (call, _receiver, [formattable]) =>
    formatted(call, formattableArgument(formattable as Value), invariantObject(call)),
  'System.FormattableString.CurrentCulture': (call, _receiver, [formattable]) =>
    formatted(call, formattableArgument(formattable as Value), undefined),
});
