import { pyRepr } from './conversions';
import { callValue } from './objects';
import type { Runtime } from './runtime';
import { None } from './types';
import type { PyValue } from './values';

/** `sys.displayhook`, which shows the value of an expression statement compiled in 'single' mode on sys.stdout. */
export function displayValue(runtime: Runtime, value: PyValue): void {
  if (value === None) return;
  runtime.builtins.set('_', None);
  callValue(runtime.builtins.get('print') as PyValue, [pyRepr(value)]);
  runtime.builtins.set('_', value);
}
