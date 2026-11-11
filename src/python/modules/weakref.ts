import { builtin } from '../define';
import { registerModule } from '../modules';
import { callValue } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { None } from '../types';
import type { PyValue } from '../values';
import { weakrefClass, weakReferenceOf } from '../weakReferences';

/** Whether a weak reference and the object it refers to are both still alive. */
function isAlive(reference: PyValue): boolean {
  return (
    currentRuntime()
      .reachableObjects()
      .has(reference as object) && callValue(reference, []) !== None
  );
}

registerModule(
  'weakref',
  () =>
    new Map<string, PyValue>([
      ['ref', weakrefClass],
      ['ReferenceType', weakrefClass],
      [
        'getweakrefcount',
        builtin('getweakrefcount', 'one', 1, 1, ([value]) => {
          const reference = weakReferenceOf(value);
          return reference !== undefined && isAlive(reference) ? 1n : 0n;
        }),
      ],
      [
        'getweakrefs',
        builtin('getweakrefs', 'one', 1, 1, ([value]) => {
          const reference = weakReferenceOf(value);
          return currentRuntime().listOf(reference !== undefined && isAlive(reference) ? [reference] : []);
        }),
      ],
    ]),
  Object.fromEntries([
    ['proxy', '弱参照のプロキシ（weakref.proxy()）'],
    ['ProxyType', '弱参照のプロキシ（weakref.ProxyType）'],
    ['CallableProxyType', '弱参照のプロキシ（weakref.CallableProxyType）'],
    ['WeakMethod', 'weakref.WeakMethod'],
    ['WeakValueDictionary', 'weakref.WeakValueDictionary'],
    ['WeakKeyDictionary', 'weakref.WeakKeyDictionary'],
    ['WeakSet', 'weakref.WeakSet'],
    ['finalize', 'オブジェクトが解放されたときの処理（weakref.finalize）'],
  ])
);
