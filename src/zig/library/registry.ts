import { TYPE } from '../types';
import { arrayListFactory } from './arrayList';
import { asciiNamespace } from './ascii';
import { fmtNamespace } from './fmtlib';
import { HASH_MAP_MEMBERS } from './hashMap';
import { mathNamespace } from './math';
import { memNamespace } from './mem';
import { fnMember, nativeStruct } from './native';
import { sortNamespace } from './sort';
import { registerLazy } from './std';

registerLazy('mem', () => ({ type: TYPE, value: memNamespace() }));
registerLazy('fmt', () => ({ type: TYPE, value: fmtNamespace() }));
registerLazy('ascii', () => ({ type: TYPE, value: asciiNamespace() }));
registerLazy('math', () => ({ type: TYPE, value: mathNamespace() }));
registerLazy('sort', () => ({ type: TYPE, value: sortNamespace() }));
registerLazy('ArrayList', arrayListFactory());
for (const [name, member] of Object.entries(HASH_MAP_MEMBERS)) registerLazy(name, member);

/** Library modules not yet implemented, which report that they are unavailable. */
for (const name of ['unicode', 'meta', 'enums', 'Random', 'array_hash_map']) {
  registerLazy(name, () => ({ type: TYPE, value: nativeStruct(`std.${name}`, {}) }));
}
for (const name of [
  'AutoArrayHashMapUnmanaged',
  'StringArrayHashMapUnmanaged',
  'PriorityQueue',
  'DoublyLinkedList',
  'SinglyLinkedList',
]) {
  registerLazy(
    name,
    fnMember(`std.${name}`, (sema, call) => sema.error(call.span, `std.${name} はまだ使えません。`))
  );
}
