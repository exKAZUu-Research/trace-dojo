import { builtin } from '../define';
import { registerModule } from '../modules';
import { exceptionClassNamed, newException } from '../types';
import { PyError, type PyValue } from '../values';

registerModule(
  'sys',
  (runtime) =>
    new Map<string, PyValue>([
      [
        'exit',
        builtin('exit', 'expected', 0, 1, (args) => {
          throw runtime.systemExit(args[0]);
        }),
      ],
      ['maxsize', 2n ** 63n - 1n],
      ['stdout', runtime.standardStream('stdout')],
      ['stderr', runtime.standardStream('stderr')],
    ])
);

export function systemExitError(code: PyValue | undefined): PyError {
  return new PyError(newException(exceptionClassNamed('SystemExit'), code === undefined ? [] : [code]));
}
