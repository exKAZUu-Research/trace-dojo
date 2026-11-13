import { pyRepr } from '../conversions';
import { method } from '../define';
import { callValue, getAttribute, getItem } from '../objects';
import { builtinClass, defineMethod, newTuple, typeError } from '../types';
import { type Kwargs, type PyClass, PyOpaque, type PyValue } from '../values';

/** `operator.itemgetter`, `attrgetter` and `methodcaller`: callables that apply what they were created with. */

export const itemgetterClass = callableClass('itemgetter', (self, target) => {
  const items = (self.data as PyValue[]).map((key) => getItem(target, key));
  return items.length === 1 ? items[0] : newTuple(items);
});
itemgetterClass.construct = (cls, args, kwargs) => {
  checkGetterArgs('itemgetter', args, kwargs);
  return new PyOpaque(cls, argumentsText(args), args);
};

export const attrgetterClass = callableClass('attrgetter', (self, target) => {
  const values = (self.data as string[]).map((path) => {
    let value = target;
    for (const name of path.split('.')) value = getAttribute(value, name);
    return value;
  });
  return values.length === 1 ? values[0] : newTuple(values);
});
attrgetterClass.construct = (cls, args, kwargs) => {
  checkGetterArgs('attrgetter', args, kwargs);
  if (args.some((name) => typeof name !== 'string')) throw typeError('attribute name must be a string');
  return new PyOpaque(cls, argumentsText(args), args);
};

interface MethodCall {
  name: string;
  args: PyValue[];
  kwargs: Kwargs;
}

export const methodcallerClass = callableClass('methodcaller', (self, target) => {
  const { name, args, kwargs } = self.data as MethodCall;
  return callValue(getAttribute(target, name), args, kwargs);
});
methodcallerClass.construct = (cls, [name, ...args], kwargs) => {
  if (name === undefined) throw typeError('methodcaller needs at least one argument, the method name');
  if (typeof name !== 'string') throw typeError('method name must be a string');
  return new PyOpaque(cls, '', { name, args, kwargs: kwargs && new Map(kwargs) } satisfies MethodCall);
};
method(methodcallerClass, '__repr__', 'none', 0, 0, (self) => {
  const { name, args, kwargs } = (self as PyOpaque).data as MethodCall;
  const keywords = [...(kwargs ?? [])].map(([key, value]) => `${key}=${pyRepr(value)}`);
  return `operator.methodcaller(${[argumentsText([name, ...args]), ...keywords].join(', ')})`;
});

function callableClass(name: string, apply: (self: PyOpaque, target: PyValue) => PyValue): PyClass {
  const cls = builtinClass(name);
  cls.module = 'operator';
  cls.typeName = `operator.${name}`;
  method(cls, '__repr__', 'none', 0, 0, (self) => `operator.${name}(${(self as PyOpaque).text})`);
  defineMethod(
    cls,
    '__call__',
    (self, args, kwargs) => {
      if (kwargs && kwargs.size > 0) throw typeError(`${name}() takes no keyword arguments`);
      if (args.length !== 1) throw typeError(`${name} expected 1 argument, got ${args.length}`);
      return apply(self as PyOpaque, args[0]);
    },
    { receiver: 'wrapper' }
  );
  return cls;
}

function checkGetterArgs(name: string, args: PyValue[], kwargs: Kwargs): void {
  if (kwargs && kwargs.size > 0) throw typeError(`${name}() takes no keyword arguments`);
  if (args.length === 0) throw typeError(`${name} expected 1 argument, got 0`);
}

function argumentsText(args: readonly PyValue[]): string {
  return args.map((arg) => pyRepr(arg)).join(', ');
}
