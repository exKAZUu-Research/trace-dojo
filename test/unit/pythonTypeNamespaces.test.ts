import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// CPython 3.14.10 computes `expected`.
test("C types written in Python and module namespaces match CPython's", () => {
  const program = String.raw`import types, json, io, sys
actual = []
actual.append(sorted(vars(types.SimpleNamespace)))
actual.append(sorted(vars(types.MappingProxyType)))
actual.append([k for k in vars(json) if not k.startswith('__')])
p = types.MappingProxyType({'a': 1})
try:
    p.x = 1
except AttributeError as e:
    actual.append(str(e))
n = types.SimpleNamespace(a=1)
n.b = 2
actual += [repr(n), type(sys.implementation) is types.SimpleNamespace, p | {'b': 2}]
actual.append(sorted(vars(io.TextIOWrapper))[:8])
actual.append(type(io.TextIOWrapper.write).__name__)
actual.append(sys.float_info.__reduce__()[1][0][1])
actual.append(reversed({1: 2, 3: 4}).__reduce__()[1])
expected = [['__dict__', '__doc__', '__eq__', '__ge__', '__gt__', '__hash__', '__init__', '__le__', '__lt__', '__ne__', '__new__', '__reduce__', '__replace__', '__repr__'], ['__class_getitem__', '__contains__', '__doc__', '__eq__', '__ge__', '__getitem__', '__gt__', '__hash__', '__ior__', '__iter__', '__le__', '__len__', '__lt__', '__ne__', '__new__', '__or__', '__repr__', '__reversed__', '__ror__', '__str__', 'copy', 'get', 'items', 'keys', 'values'], ['scanner', 'decoder', 'JSONDecoder', 'JSONDecodeError', 'encoder', 'JSONEncoder', 'codecs', '_default_encoder', 'dump', 'dumps', '_default_decoder', 'detect_encoding', 'load', 'loads'], "'mappingproxy' object has no attribute 'x' and no __dict__ for setting new attributes", 'namespace(a=1, b=2)', True, {'a': 1, 'b': 2}, ['_CHUNK_SIZE', '__doc__', '__getstate__', '__init__', '__module__', '__next__', '__repr__', '_finalizing'], 'method_descriptor', 1024, ([3, 1],)]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});
