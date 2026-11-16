import { type StructType, TYPE } from '../types';
import { arrayListFactory } from './arrayList';
import { asciiNamespace } from './ascii';
import { fmtNamespace } from './fmtlib';
import { HASH_MAP_MEMBERS } from './hashMap';
import { mathNamespace } from './math';
import { memNamespace } from './mem';
import { enumsNamespace, metaNamespace, PRIORITY_QUEUE, unicodeNamespace } from './misc';
import { addMembers, unavailableMember } from './native';
import { PUBLIC_STD_MEMBERS } from './publicMembers';
import { randomNamespace } from './random';
import { sortNamespace } from './sort';
import { registerLazy } from './std';

registerLazy('mem', () => ({ type: TYPE, value: completeNamespace('mem', memNamespace()) }));
registerLazy('fmt', () => ({ type: TYPE, value: completeNamespace('fmt', fmtNamespace()) }));
registerLazy('ascii', () => ({ type: TYPE, value: completeNamespace('ascii', asciiNamespace()) }));
registerLazy('math', () => ({ type: TYPE, value: completeNamespace('math', mathNamespace()) }));
registerLazy('sort', () => ({ type: TYPE, value: completeNamespace('sort', sortNamespace()) }));
registerLazy('unicode', () => ({ type: TYPE, value: completeNamespace('unicode', unicodeNamespace()) }));
registerLazy('meta', () => ({ type: TYPE, value: completeNamespace('meta', metaNamespace()) }));
registerLazy('enums', () => ({ type: TYPE, value: completeNamespace('enums', enumsNamespace()) }));
registerLazy('Random', () => ({ type: TYPE, value: completeNamespace('Random', randomNamespace()) }));
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

function completeNamespace(name: string, type: StructType): StructType {
  for (const member of PUBLIC_STD_MEMBERS[name]) {
    if (!type.namespace.decls.has(member)) addMembers(type, { [member]: unavailableMember(`std.${name}.${member}`) });
  }
  return type;
}
