import { pyRepr } from './conversions';
import { callValue, getAttribute } from './objects';
import type { Runtime } from './runtime';
import { None } from './types';
import type { PyValue } from './values';

/** `sys.displayhook(value)`: writes the repr of a value other than None to `sys.stdout` and keeps it as `_`. */
export function displayValue(runtime: Runtime, value: PyValue): PyValue {
  if (value === None) return None;
  runtime.builtins.set('_', None);
  const write = getAttribute(getAttribute(runtime.importModule('sys'), 'stdout'), 'write');
  callValue(write, [pyRepr(value)]);
  callValue(write, ['\n']);
  runtime.builtins.set('_', value);
  return None;
}
