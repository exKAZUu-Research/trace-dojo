import { copyKeywords } from '../callArguments';
import { pyRepr } from '../conversions';
import { method } from '../define';
import { attributeName, callValue, getAttribute, getItem } from '../objects';
import { builtinClass, defineMethod, newTuple, stringValue, typeError } from '../types';
import { type Kwargs, type PyClass, PyOpaque, type PyValue } from '../values';

export const itemgetterClass = callableClass(
  'itemgetter',
  (self, target) => {
    const items = (self.data as PyValue[]).map((key) => getItem(target, key));
    return items.length === 1 ? items[0] : newTuple(items);
  },
  (self) => argumentsText(self.data as PyValue[])
);
itemgetterClass.construct = (cls, args, kwargs) => {
  checkGetterArgs('itemgetter', args, kwargs);
  return new PyOpaque(cls, '', args);
};

interface AttributePaths {
  paths: string[];
  args: PyValue[];
}

export const attrgetterClass = callableClass(
  'attrgetter',
  (self, target) => {
    const values = (self.data as AttributePaths).paths.map((path) => {
      let value = target;
      for (const name of path.split('.')) value = getAttribute(value, name);
      return value;
    });
    return values.length === 1 ? values[0] : newTuple(values);
  },
  (self) => argumentsText((self.data as AttributePaths).args)
);
attrgetterClass.construct = (cls, args, kwargs) => {
  checkGetterArgs('attrgetter', args, kwargs);
  const paths = args.map((name) => {
    const text = stringValue(name);
    if (text === undefined) throw typeError('attribute name must be a string');
    return text;
  });
  return new PyOpaque(cls, '', { paths, args } satisfies AttributePaths);
};

interface MethodCall {
  name: PyValue;
  args: PyValue[];
  kwargs: Kwargs;
}

export const methodcallerClass = callableClass(
  'methodcaller',
  (self, target) => {
    const { name, args, kwargs } = self.data as MethodCall;
    return callValue(getAttribute(target, attributeName(name)), args, kwargs);
  },
  (self) => {
    const { name, args, kwargs } = self.data as MethodCall;
    const keywords = [...(kwargs ?? [])].map(([key, value]) => `${key}=${pyRepr(value)}`);
    return [argumentsText([name, ...args]), ...keywords].join(', ');
  }
);
methodcallerClass.construct = (cls, [name, ...args], kwargs) => {
  if (name === undefined) throw typeError('methodcaller needs at least one argument, the method name');
  if (stringValue(name) === undefined) throw typeError('method name must be a string');
  return new PyOpaque(cls, '', { name, args, kwargs: kwargs && copyKeywords(kwargs) } satisfies MethodCall);
};

function callableClass(
  name: string,
  apply: (self: PyOpaque, target: PyValue) => PyValue,
  describe: (self: PyOpaque) => string
): PyClass {
  const cls = builtinClass(name);
  cls.module = 'operator';
  cls.typeName = `operator.${name}`;
  method(cls, '__repr__', 'none', 0, 0, (self) => `operator.${name}(${describe(self as PyOpaque)})`);
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
