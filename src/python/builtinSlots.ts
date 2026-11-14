import { method } from './define';
import { attributeName, genericGetAttribute } from './objects';
import { binaryOp, unaryOp } from './operators';
import { boolClass, classOf, intClass, methodClass, moduleClass, None, NotImplemented, superClass } from './types';

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

// super's, method's, and module's own lookup, which a subclass's __getattribute__ reaches without its hook.
for (const cls of [superClass, methodClass, moduleClass]) {
  method(cls, '__getattribute__', 'one', 1, 1, (self, [name]) => {
    name = attributeName(name);
    return genericGetAttribute(self, name);
  });
}
method(superClass, '__init__', 'expected', 0, 2, () => None);
