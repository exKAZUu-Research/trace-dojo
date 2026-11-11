import { method } from './define';
import { getAttribute } from './objects';
import { binaryOp, unaryOp } from './operators';
import { boolClass, classOf, intClass, None, NotImplemented, superClass, typeError, typeName } from './types';

// The slot methods CPython's bool and super define themselves, which this grader's operators and lookup implement.

for (const [name, operator] of [
  ['and', '&'],
  ['or', '|'],
  ['xor', '^'],
] as const) {
  method(boolClass, `__${name}__`, 'one', 1, 1, (self, [other]) =>
    classOf(other).isSubclassOf(intClass) ? binaryOp(operator, self, other) : NotImplemented
  );
  method(boolClass, `__r${name}__`, 'one', 1, 1, (self, [other]) =>
    classOf(other).isSubclassOf(intClass) ? binaryOp(operator, other, self) : NotImplemented
  );
}
method(boolClass, '__invert__', 'none', 0, 0, (self) => unaryOp('~', self));

method(superClass, '__getattribute__', 'one', 1, 1, (self, [name]) => {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  return getAttribute(self, name);
});
method(superClass, '__init__', 'expected', 0, 2, () => None);
