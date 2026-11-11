import { builtin } from '../define';
import { registerModule } from '../modules';
import { exceptionClassNamed, newException } from '../types';
import { PyError, type PyValue } from '../values';
import { sysInformation, sysModules } from './sysInfo';

registerModule('sys', (runtime, namespace) => {
  const entries = new Map<string, PyValue>([
    [
      'exit',
      builtin('exit', 'expected', 0, 1, (args) => {
        throw runtime.systemExit(args[0]);
      }),
    ],
    ['maxsize', 2n ** 63n - 1n],
    ['stdout', runtime.standardStream('stdout')],
    ['stderr', runtime.standardStream('stderr')],
    ...sysInformation(runtime),
  ]);
  for (const [key, value] of entries) namespace.set(key, value);
  namespace.set('modules', sysModules(runtime));
  return new Map();
});

export function systemExitError(code: PyValue | undefined): PyError {
  return new PyError(newException(exceptionClassNamed('SystemExit'), code === undefined ? [] : [code]));
}
