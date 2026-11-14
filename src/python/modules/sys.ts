import { moduleBuiltin } from '../define';
import { displayValue } from '../display';
import { registerModule } from '../modules';
import { argument } from '../nativeArgs';
import { toIndex } from '../numbers';
import { UNSUPPORTED_SYS_ATTRIBUTES } from '../sysAttributes';
import { exceptionClassNamed, newException, None, typeError, valueError } from '../types';
import { LazyModuleAttribute, PyError, type PyValue } from '../values';
import { sysHooks } from './sysHooks';
import { sysInformation, sysModules } from './sysInfo';

const builtin = moduleBuiltin('sys');

registerModule(
  'sys',
  (runtime, namespace) => {
    const displayhook = builtin('displayhook', 'one', 1, 1, ([value]) => displayValue(runtime, value));
    const entries = new Map<string, PyValue>([
      [
        'exit',
        builtin('exit', 'expected', 0, 1, (args) => {
          throw runtime.systemExit(args[0]);
        }),
      ],
      ['maxsize', 2n ** 63n - 1n],
      [
        'get_int_max_str_digits',
        builtin('get_int_max_str_digits', 'none', 0, 0, () => BigInt(runtime.intMaxStrDigits)),
      ],
      [
        'set_int_max_str_digits',
        builtin(
          'set_int_max_str_digits',
          'takes',
          0,
          1,
          (args, kwargs) => {
            const value = argument(args, kwargs, 0, 'maxdigits');
            if (value === undefined) {
              throw typeError("set_int_max_str_digits() missing required argument 'maxdigits' (pos 1)");
            }
            const limit = toIndex(value);
            if (limit !== 0n && limit < 640n) throw valueError('maxdigits must be >= 640 or 0 for unlimited');
            runtime.intMaxStrDigits = Number(limit);
            return None;
          },
          { keywords: ['maxdigits'] }
        ),
      ],
      ['stdout', runtime.standardStream('stdout')],
      ['stderr', runtime.standardStream('stderr')],
      ['displayhook', displayhook],
      ['__displayhook__', displayhook],
      ...sysInformation(runtime),
      ...sysHooks(runtime),
    ]);
    for (const [key, value] of entries) namespace.set(key, value);
    namespace.set('modules', sysModules(runtime));
    const module = runtime.importModule('sys');
    const stdin = new LazyModuleAttribute(() => runtime.standardStream('stdin'));
    for (const name of ['stdin', '__stdin__']) module.imports.set(name, stdin);
    return new Map();
  },
  UNSUPPORTED_SYS_ATTRIBUTES
);

export function systemExitError(code: PyValue | undefined): PyError {
  return new PyError(newException(exceptionClassNamed('SystemExit'), code === undefined ? [] : [code]));
}
