import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { CsBox, CsStruct, type Value } from '../values';
import { fail, failOutOfRange, libraryType } from './support';

/**
 * The console's terminal operations as .NET runs them on Unix with standard input and output redirected, as a grader
 * runs a program: colors and the cursor change no output, keys cannot be read, and the cursor stays at its origin.
 * What depends on the terminal type (such as the window's size) is left undeclared, so it is rejected as unusable.
 */

/** The color .NET reports before a program sets one, which is no `ConsoleColor` member. */
const UNKNOWN_COLOR = -1;

interface ConsoleState {
  foreground: number;
  background: number;
}

const consoleStates = new WeakMap<object, ConsoleState>();

function consoleStateOf(call: NativeCall): ConsoleState {
  const runtime = call.frame.runtime;
  let state = consoleStates.get(runtime);
  if (!state) {
    state = { foreground: UNKNOWN_COLOR, background: UNKNOWN_COLOR };
    consoleStates.set(runtime, state);
  }
  return state;
}

const colorSetter =
  (which: keyof ConsoleState): NativeMethod =>
  (call, _receiver, [color]) => {
    const value = color as number;
    if (value !== UNKNOWN_COLOR && (value < 0 || value > 15))
      fail(
        'System.ArgumentException',
        'The ConsoleColor enum value was not defined on that enum. Please use a defined color from the enum.'
      );
    consoleStateOf(call)[which] = value;
  };

const notSupported = (): never =>
  fail('System.PlatformNotSupportedException', 'Operation is not supported on this platform.');

/** .NET's check of a cursor coordinate, whose limit on Unix is `short.MaxValue`. */
function checkCursor(call: NativeCall, value: number, paramName: string): void {
  if (value < 0 || value >= 32_767)
    failOutOfRange(
      call,
      paramName,
      "The value must be greater than or equal to zero and less than the console's buffer size in that dimension.",
      String(value)
    );
}

const KEY_FIELDS = { keyChar: 0, key: 1, modifiers: 2 } as const;
const MODIFIER = { alt: 1, shift: 2, control: 4 } as const;

function unboxed(value: Value): Value {
  return value instanceof CsBox ? value.value : value;
}

function keyFields(value: Value): Value[] {
  return (unboxed(value) as CsStruct).fields;
}

function sameKey(a: Value, b: Value): boolean {
  const left = keyFields(a);
  const right = keyFields(b);
  return left.every((field, index) => field === right[index]);
}

defineNatives({
  'System.Console.ReadKey': () =>
    fail(
      'System.InvalidOperationException',
      'Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.'
    ),
  'System.Console.get_KeyAvailable': () =>
    fail(
      'System.InvalidOperationException',
      'Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.'
    ),
  'System.Console.get_IsInputRedirected': () => true,
  'System.Console.get_IsOutputRedirected': () => true,
  'System.Console.get_IsErrorRedirected': () => true,
  'System.Console.Clear': () => {},
  'System.Console.Beep()': () => {},
  'System.Console.Beep(int, int)': notSupported,
  'System.Console.ResetColor': (call) => {
    const state = consoleStateOf(call);
    state.foreground = UNKNOWN_COLOR;
    state.background = UNKNOWN_COLOR;
  },
  'System.Console.get_ForegroundColor': (call) => consoleStateOf(call).foreground,
  'System.Console.set_ForegroundColor': colorSetter('foreground'),
  'System.Console.get_BackgroundColor': (call) => consoleStateOf(call).background,
  'System.Console.set_BackgroundColor': colorSetter('background'),
  'System.Console.get_Title': notSupported,
  'System.Console.set_Title': (_call, _receiver, [title]) => {
    if (title === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'value');
  },
  'System.Console.get_CursorVisible': notSupported,
  'System.Console.set_CursorVisible': () => {},
  'System.Console.get_CursorLeft': () => 0,
  'System.Console.get_CursorTop': () => 0,
  'System.Console.set_CursorLeft': (call, _receiver, [left]) => {
    checkCursor(call, left as number, 'left');
  },
  'System.Console.set_CursorTop': (call, _receiver, [top]) => {
    checkCursor(call, top as number, 'top');
  },
  'System.Console.GetCursorPosition': (call) => {
    const int = libraryType(call, 'System.Int32');
    return new CsStruct(libraryType(call, 'System.ValueTuple', [int, int]), [0, 0]);
  },
  'System.Console.SetCursorPosition': (call, _receiver, [left, top]) => {
    checkCursor(call, left as number, 'left');
    checkCursor(call, top as number, 'top');
  },

  'System.ConsoleKeyInfo..ctor': (call, receiver, [keyChar, key, shift, alt, control]) => {
    const keyValue = key as number;
    if (keyValue < 0 || keyValue > 255)
      failOutOfRange(call, 'key', 'Console key values must be between 0 and 255 inclusive.');
    const fields = (receiver as CsStruct).fields;
    fields[KEY_FIELDS.keyChar] = keyChar as Value;
    fields[KEY_FIELDS.key] = keyValue;
    fields[KEY_FIELDS.modifiers] =
      (shift ? MODIFIER.shift : 0) | (alt ? MODIFIER.alt : 0) | (control ? MODIFIER.control : 0);
  },
  'System.ConsoleKeyInfo.get_KeyChar': (_call, receiver) => keyFields(receiver)[KEY_FIELDS.keyChar],
  'System.ConsoleKeyInfo.get_Key': (_call, receiver) => keyFields(receiver)[KEY_FIELDS.key],
  'System.ConsoleKeyInfo.get_Modifiers': (_call, receiver) => keyFields(receiver)[KEY_FIELDS.modifiers],
  'System.ConsoleKeyInfo.Equals(object?)': (_call, receiver, [other]) => {
    const value = unboxed(other as Value);
    return (
      value instanceof CsStruct &&
      value.type.symbol === (unboxed(receiver) as CsStruct).type.symbol &&
      sameKey(receiver, value)
    );
  },
  'System.ConsoleKeyInfo.Equals(ConsoleKeyInfo)': (_call, receiver, [other]) => sameKey(receiver, other as Value),
  'System.ConsoleKeyInfo.GetHashCode': (_call, receiver) => {
    const [keyChar, key, modifiers] = keyFields(receiver) as number[];
    return keyChar | (key << 16) | (modifiers << 24);
  },
  'System.ConsoleKeyInfo.op_Equality': (_call, _receiver, [a, b]) => sameKey(a as Value, b as Value),
  'System.ConsoleKeyInfo.op_Inequality': (_call, _receiver, [a, b]) => !sameKey(a as Value, b as Value),
});
