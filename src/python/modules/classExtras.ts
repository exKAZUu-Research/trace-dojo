import { method } from '../define';
import { registerExtraAttributes } from '../modules';
import { callValue } from '../objects';
import { genericAliasClass } from '../typeHints';
import { classmethodClass, isInstanceOf, NotImplemented } from '../types';
import { PyClass, PyDescriptor, PyError, type PyInstance, type PyValue } from '../values';

// The class attributes CPython's library classes have that their implementations here do not define: the
// `__module__` entry of the classes CPython creates at run time, which their instances read, and the
// `__class_getitem__` of the generic ones.

/** The classes of each module whose `__dict__` has `__module__` in CPython, with its value. */
const MODULE_ENTRIES: [string, string, string][] = [
  ['builtins', 'ExceptionGroup', 'builtins'],
  ['io', 'StringIO', '_io'],
  ['io', 'BytesIO', '_io'],
  ['fractions', 'Fraction', 'fractions'],
  ['statistics', 'NormalDist', 'statistics'],
  ['operator', 'itemgetter', 'operator'],
  ['operator', 'attrgetter', 'operator'],
  ['operator', 'methodcaller', 'operator'],
  ['time', 'struct_time', 'time'],
  ['collections', 'Counter', 'collections'],
  ['collections', 'deque', 'collections'],
  ['collections', 'defaultdict', 'collections'],
  ['_thread', 'LockType', '_thread'],
  ['_thread', 'RLock', '_thread'],
  ['decimal', 'Decimal', 'decimal'],
  ['decimal', 'Context', 'decimal'],
  ['functools', 'partial', 'functools'],
  ['re', 'Pattern', 're'],
  ['re', 'Match', 're'],
];

/** The generic classes of each module, whose `__class_getitem__` makes a `types.GenericAlias`. */
const GENERIC_CLASSES: [string, string][] = [
  ['builtins', 'BaseExceptionGroup'],
  ['builtins', 'memoryview'],
  ['collections', 'deque'],
  ['collections', 'defaultdict'],
  ['array', 'array'],
  ['re', 'Pattern'],
  ['re', 'Match'],
  ['contextvars', 'ContextVar'],
  ['contextvars', 'Token'],
  ['weakref', 'ref'],
  ['queue', 'Queue'],
  ['queue', 'SimpleQueue'],
];

/** Methods of classes that CPython also has under another name, with the name of the method that does the same. */
const ALIASES: [string, string, string, string][] = [
  ['collections', 'deque', '__copy__', 'copy'],
  ['collections', 'defaultdict', '__copy__', 'copy'],
  ['_thread', 'LockType', 'locked_lock', 'locked'],
  ['io', 'BytesIO', 'readinto1', 'readinto'],
];

/** The C types whose `detach()` raises io.UnsupportedOperation, as in-memory streams have no buffer. */
const UNDETACHABLE: [string, string][] = [
  ['io', 'StringIO'],
  ['io', 'BytesIO'],
];

/**
 * The reflected operators of C types that CPython's slot wrappers give: `__rsub__(self, other)` runs the type's
 * `__sub__` with the operands swapped when `other` is of the type, as the slot function checks, else NotImplemented.
 */
const REFLECTED: [string, string, string][] = [
  ['datetime', 'date', '__sub__'],
  ['datetime', 'datetime', '__sub__'],
  ['datetime', 'timedelta', '__truediv__'],
  ['datetime', 'timedelta', '__floordiv__'],
  ['datetime', 'timedelta', '__mod__'],
  ['datetime', 'timedelta', '__divmod__'],
];

const modules = new Set(
  [...MODULE_ENTRIES, ...GENERIC_CLASSES, ...ALIASES, ...REFLECTED, ...UNDETACHABLE].map(([module]) => module)
);
for (const module of modules) {
  registerExtraAttributes(module, (_runtime, namespace) => {
    for (const [owner, name, value] of MODULE_ENTRIES) {
      const cls = namespace.get(name);
      if (owner === module && cls instanceof PyClass && !cls.dict.has('__module__')) cls.dict.set('__module__', value);
    }
    for (const [owner, name] of GENERIC_CLASSES) {
      const cls = namespace.get(name);
      if (owner === module && cls instanceof PyClass && cls.lookup('__class_getitem__') === undefined) {
        cls.dict.set('__class_getitem__', new PyDescriptor(classmethodClass, genericAliasClass));
      }
    }
    for (const [owner, name, alias, original] of ALIASES) {
      const cls = namespace.get(name);
      const method = cls instanceof PyClass ? cls.lookup(original) : undefined;
      if (owner === module && cls instanceof PyClass && method !== undefined && !cls.dict.has(alias)) {
        cls.dict.set(alias, method);
      }
    }
    for (const [owner, name, operator] of REFLECTED) {
      const cls = namespace.get(name);
      const reflected = `__r${operator.slice(2)}`;
      if (owner !== module || !(cls instanceof PyClass) || cls.dict.has(reflected)) continue;
      const forward = cls.lookup(operator) as PyValue;
      method(cls, reflected, 'one', 1, 1, (self, [other]) =>
        isInstanceOf(other, cls) ? callValue(forward, [other, self]) : NotImplemented
      );
    }
    for (const [owner, name] of UNDETACHABLE) {
      const cls = namespace.get(name);
      if (owner !== module || !(cls instanceof PyClass) || cls.dict.has('detach')) continue;
      method(cls, 'detach', 'none', 0, 0, () => {
        throw new PyError(callValue(namespace.get('UnsupportedOperation') as PyValue, ['detach']) as PyInstance);
      });
    }
    return [];
  });
}
