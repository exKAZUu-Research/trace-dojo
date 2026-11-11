import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { callValue, getAttribute } from '../objects';
import type { Runtime } from '../runtime';
import { exceptionClassNamed, newException, None } from '../types';
import { PyError, type PyValue } from '../values';
import { sysInformation } from './sysInfo';

registerModule('sys', (runtime) => {
  const displayhook = builtin('displayhook', 'one', 1, 1, ([value]) => display(runtime, value));
  return new Map<string, PyValue>([
    [
      'exit',
      builtin('exit', 'expected', 0, 1, (args) => {
        throw runtime.systemExit(args[0]);
      }),
    ],
    ['maxsize', 2n ** 63n - 1n],
    ['stdout', runtime.standardStream('stdout')],
    ['stderr', runtime.standardStream('stderr')],
    ['displayhook', displayhook],
    ['__displayhook__', displayhook],
    ...sysInformation(runtime),
  ]);
});

/** `sys.displayhook(value)`: writes the repr of a value other than None to `sys.stdout` and keeps it as `_`. */
function display(runtime: Runtime, value: PyValue): PyValue {
  if (value === None) return None;
  runtime.builtins.set('_', None);
  const write = getAttribute(getAttribute(runtime.importModule('sys'), 'stdout'), 'write');
  callValue(write, [pyRepr(value)]);
  callValue(write, ['\n']);
  runtime.builtins.set('_', value);
  return None;
}

export function systemExitError(code: PyValue | undefined): PyError {
  return new PyError(newException(exceptionClassNamed('SystemExit'), code === undefined ? [] : [code]));
}
