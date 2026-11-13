// The reductions of the standard library types this interpreter writes natively, as CPython's reduce them for pickle.
import { setInstanceAttribute } from '../attributes';
import { pyStr } from '../conversions';
import { method } from '../define';
import { ownDict } from '../descriptors';
import { enumClass } from '../enums';
import { namespaceDict } from '../namespaces';
import { callValue, getAttribute, getIterator, isCallable } from '../objects';
import { objectState } from '../reduction';
import { currentRuntime } from '../runtimeContext';
import {
  classOf,
  dictClass,
  ellipsisClass,
  newDict,
  newTuple,
  None,
  notImplementedClass,
  tupleClass,
  typeError,
} from '../types';
import { type PyDeque, PyDict, type PyOpaque, PyTuple, type PyValue } from '../values';
import { defaultdictClass, dequeClass, orderedDictClass } from './collections';
import { decimalClass } from './decimal';
import { fractionClass, type PyFraction } from './fractions';
import { type Partial, partialClass } from './functools';

const itemsIterator = (self: PyValue): PyValue => getIterator(callValue(getAttribute(self, 'items'), []));

method(orderedDictClass, '__reduce__', 'none', 0, 0, (self) =>
  newTuple([classOf(self), newTuple([]), objectState(self, false), None, itemsIterator(self)])
);
method(defaultdictClass, '__reduce__', 'none', 0, 0, (self) => {
  const factory = (self as PyDict).defaultFactory;
  const args = factory === undefined || factory === None ? [] : [factory];
  return newTuple([classOf(self), newTuple(args), None, None, itemsIterator(self)]);
});
method(dequeClass, '__reduce__', 'none', 0, 0, (self) => {
  const { maxlen } = self as PyDeque;
  const args = maxlen === undefined ? [] : [newTuple([]), BigInt(maxlen)];
  return newTuple([classOf(self), newTuple(args), objectState(self, false), getIterator(self)]);
});

method(decimalClass, '__reduce__', 'none', 0, 0, (self) => newTuple([classOf(self), newTuple([pyStr(self)])]));
method(fractionClass, '__reduce__', 'none', 0, 0, (self) => {
  const fraction = self as PyFraction;
  return newTuple([classOf(self), newTuple([fraction.numerator, fraction.denominator])]);
});

method(enumClass, '__reduce_ex__', 'one', 1, 1, (self) =>
  newTuple([classOf(self), newTuple([getAttribute(self, '_value_')])])
);
method(notImplementedClass, '__reduce__', 'none', 0, 0, () => 'NotImplemented');
method(ellipsisClass, '__reduce__', 'none', 0, 0, () => 'Ellipsis');

const partialOf = (self: PyValue): Partial => (self as PyOpaque).data as Partial;

method(partialClass, '__reduce__', 'none', 0, 0, (self) => {
  const partial = partialOf(self);
  const keywords = newDict(partial.keywords.store.ordered().map((entry) => [entry.key, entry.value]));
  const state = newTuple([partial.fn, newTuple(partial.args.items), keywords, objectState(self, false)]);
  return newTuple([classOf(self), newTuple([partial.fn]), state]);
});
method(partialClass, '__setstate__', 'one', 1, 1, (self, [state]) => {
  if (!(state instanceof PyTuple) || state.items.length !== 4) throw typeError('invalid partial state');
  const [fn, args, kwargs, attributes] = state.items;
  if (
    !isCallable(fn) ||
    !(args instanceof PyTuple) ||
    !(kwargs instanceof PyDict || kwargs === None) ||
    !(attributes instanceof PyDict || attributes === None)
  ) {
    throw typeError('invalid partial state');
  }
  const restoredArgs = args.cls === tupleClass ? args : newTuple(args.items);
  const restoredKeywords =
    kwargs instanceof PyDict
      ? kwargs.cls === dictClass
        ? kwargs
        : newDict(kwargs.store.ordered().map((entry) => [entry.key, entry.value]))
      : newDict();
  const restoredAttributes = attributes === None ? newDict() : attributes;
  const { finalizer } = currentRuntime();
  replacePartialField(self, 'fn', fn);
  replacePartialField(self, 'args', restoredArgs);
  replacePartialField(self, 'keywords', restoredKeywords);
  const previousAttributes = ownDict(self);
  finalizer.replacingReference(
    previousAttributes ? namespaceDict(previousAttributes) : undefined,
    () => setInstanceAttribute(self as PyOpaque, '__dict__', restoredAttributes),
    [self]
  );
  return None;
});

function replacePartialField<Key extends keyof Partial>(self: PyValue, key: Key, value: Partial[Key]): void {
  const partial = partialOf(self);
  currentRuntime().finalizer.replacingReference(
    partial[key],
    () => {
      partial[key] = value;
    },
    [self]
  );
}
