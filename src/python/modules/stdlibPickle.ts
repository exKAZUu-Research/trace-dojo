// The reductions of the standard library types this interpreter writes natively, as CPython's reduce them for pickle.
import { pyStr } from '../conversions';
import { method } from '../define';
import { enumClass } from '../enums';
import { callValue, getAttribute, getIterator, isCallable, setAttribute } from '../objects';
import { objectState } from '../reduction';
import { classOf, dictClass, ellipsisClass, newDict, newTuple, None, notImplementedClass, typeError } from '../types';
import { type PyDeque, PyDict, type PyOpaque, PyTuple, type PyValue } from '../values';
import { counterClass, defaultdictClass, dequeClass, orderedDictClass } from './collections';
import { decimalClass } from './decimal';
import { fractionClass, type PyFraction } from './fractions';
import { type Partial, partialClass } from './functools';

const itemsIterator = (self: PyValue): PyValue => getIterator(callValue(getAttribute(self, 'items'), []));

method(orderedDictClass, '__reduce__', 'none', 0, 0, (self) =>
  newTuple([classOf(self), newTuple([]), objectState(self, false), None, itemsIterator(self)])
);
method(counterClass, '__reduce__', 'none', 0, 0, (self) =>
  newTuple([classOf(self), newTuple([callValue(dictClass, [self])])])
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
  setAttribute(self, '__dict__', attributes === None ? newDict() : attributes);
  const partial = partialOf(self);
  partial.fn = fn;
  partial.args = newTuple(args.items);
  partial.keywords =
    kwargs instanceof PyDict ? newDict(kwargs.store.ordered().map((entry) => [entry.key, entry.value])) : newDict();
  return None;
});
