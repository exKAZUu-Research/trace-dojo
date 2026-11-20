import { TYPE } from '../types';
import { arrayListFactory } from './arrayList';
import { asciiNamespace } from './ascii';
import { fmtNamespace } from './fmtlib';
import { HASH_MAP_MEMBERS } from './hashMap';
import { mathNamespace } from './math';
import { memNamespace } from './mem';
import { enumsNamespace, metaNamespace, PRIORITY_QUEUE, unicodeNamespace } from './misc';
import { unavailableMember } from './native';
import { randomNamespace } from './random';
import { sortNamespace } from './sort';
import { registerLazy } from './std';

registerLazy('mem', () => ({ type: TYPE, value: memNamespace() }));
registerLazy('fmt', () => ({ type: TYPE, value: fmtNamespace() }));
registerLazy('ascii', () => ({ type: TYPE, value: asciiNamespace() }));
registerLazy('math', () => ({ type: TYPE, value: mathNamespace() }));
registerLazy('sort', () => ({ type: TYPE, value: sortNamespace() }));
registerLazy('unicode', () => ({ type: TYPE, value: unicodeNamespace() }));
registerLazy('meta', () => ({ type: TYPE, value: metaNamespace() }));
registerLazy('enums', () => ({ type: TYPE, value: enumsNamespace() }));
registerLazy('Random', () => ({ type: TYPE, value: randomNamespace() }));
registerLazy('ArrayList', arrayListFactory());
registerLazy('PriorityQueue', PRIORITY_QUEUE);
for (const [name, member] of Object.entries(HASH_MAP_MEMBERS)) registerLazy(name, member);

/** Library members that this grader does not run, with what learners call them. */
const UNAVAILABLE: Record<string, string> = {
  array_hash_map: '挿入の順を保つハッシュマップ（std.array_hash_map）',
  AutoArrayHashMapUnmanaged: '挿入の順を保つハッシュマップ（std.AutoArrayHashMapUnmanaged）',
  StringArrayHashMapUnmanaged: '挿入の順を保つハッシュマップ（std.StringArrayHashMapUnmanaged）',
  DoublyLinkedList: '侵入型の連結リスト（std.DoublyLinkedList。@fieldParentPtr が要る）',
  SinglyLinkedList: '侵入型の連結リスト（std.SinglyLinkedList。@fieldParentPtr が要る）',
};
for (const [name, what] of Object.entries(UNAVAILABLE)) registerLazy(name, unavailableMember(what));
