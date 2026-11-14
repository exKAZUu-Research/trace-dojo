import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// CPython 3.14.10 computes the expected values from the same programs.
test('instances of subclasses of builtin types behave as the builtin types where CPython does', () => {
  const program = `import json
class Stack(list):
    def __init__(self, name, items=()):
        super().__init__(items)
        self.name = name
    def append(self, x):
        super().append(x * 10)
class Default(dict):
    def __missing__(self, key):
        return len(key)
    def __setitem__(self, key, value):
        super().__setitem__(key, value + 1)
class Money(int):
    def __str__(self):
        return f"\${int(self)}"
class Shout(str):
    def __repr__(self):
        return "Shout()"
class Point(tuple):
    def __new__(cls, x, y):
        return super().__new__(cls, (x, y))
s = Stack("s", [1, 2])
s.append(3)
s.extend([4])
d = Default(a=1)
d["b"] = 1
d.update(c=1)
m = Money(5)
p = Point(1, 2)
actual = [str(s), s.name, str(type(s + [5])), str(d), str(d["zzz"]), json.dumps(d), str(m), repr(m), str(m + 1), f"{m:03d}", str({m: 1}[5]), str([Shout("a")]), "-".join([Shout("b"), "c"]), str(p), str(p == (1, 2)), str(hash(p) == hash((1, 2))), str(type(p[:1]))]
expected = ['[1, 2, 30, 4]', 's', "<class 'list'>", "{'a': 1, 'b': 2, 'c': 1}", '3', '{"a": 1, "b": 2, "c": 1}', '$5', '5', '6', '005', '1', '[Shout()]', 'b-c', '(1, 2)', 'True', 'True', "<class 'tuple'>"]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(a + ' != ' + e)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('metaclasses and class hooks run when and as CPython runs them', () => {
  const program = `log = []
class Singleton(type):
    instances = {}
    def __call__(cls, *args):
        if cls not in Singleton.instances:
            Singleton.instances[cls] = super().__call__(*args)
        return Singleton.instances[cls]
class Config(metaclass=Singleton):
    def __init__(self, value):
        log.append(f"init {value}")
class Ordered(type):
    @classmethod
    def __prepare__(mcs, name, bases, **kwargs):
        log.append(f"prepare {name} {kwargs}")
        return {}
    def __new__(mcs, name, bases, namespace, **kwargs):
        namespace["fields"] = [key for key in namespace if not key.startswith("_")]
        return super().__new__(mcs, name, bases, namespace)
class Plugin:
    def __init_subclass__(cls, /, tag="none", **kwargs):
        super().__init_subclass__(**kwargs)
        log.append(f"subclass {cls.__name__} {tag}")
class Positive:
    def __set_name__(self, owner, name):
        self.name = "_" + name
    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return getattr(obj, self.name)
    def __set__(self, obj, value):
        if value < 0:
            raise ValueError("negative")
        setattr(obj, self.name, value)
class Record(Plugin, metaclass=Ordered, tag="rec"):
    b = 1
    a = 2
    size = Positive()
class Slotted:
    __slots__ = ("x",)
r = Record()
r.size = 3
try:
    r.size = -1
except ValueError as e:
    log.append(str(e))
try:
    Slotted().y = 1
except AttributeError as e:
    log.append(str(e))
actual = [str(Config(1) is Config(2)), str(Record.fields), str(r.size), str(type(Record).__name__), str(type("T", (Plugin,), {}, tag="t").__mro__)] + log
expected = ['True', "['b', 'a', 'size']", '3', 'Ordered', "(<class '__main__.T'>, <class '__main__.Plugin'>, <class 'object'>)", "prepare Record {'tag': 'rec'}", 'subclass Record none', 'negative', "'Slotted' object has no attribute 'y' and no __dict__ for setting new attributes", 'init 1', 'subclass T t']
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(a + ' != ' + e)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  [
    'bases with conflicting layouts',
    'class A(int, str):\n    pass',
    'TypeError: multiple bases have instance lay-out conflict',
  ],
  [
    'bases with conflicting metaclasses',
    'class M(type):\n    pass\nclass N(type):\n    pass\nclass A(metaclass=M):\n    pass\nclass B(metaclass=N):\n    pass\nclass C(A, B):\n    pass',
    'TypeError: metaclass conflict: the metaclass of a derived class must be a (non-strict) subclass of the metaclasses of all its bases',
  ],
  [
    'object.__new__ for a subclass of a builtin type',
    'class L(list):\n    def __new__(cls):\n        return object.__new__(cls)\nL()',
    'TypeError: object.__new__(L) is not safe, use list.__new__()',
  ],
  [
    'an argument to object.__new__ from a __new__ of its own',
    'class A:\n    def __new__(cls, x):\n        return object.__new__(cls, x)\nA(1)',
    'TypeError: object.__new__() takes exactly one argument (the type to instantiate)',
  ],
  ['a subclass of bool', 'class B(bool):\n    pass', "TypeError: type 'bool' is not an acceptable base type"],
])('%s ends the program as CPython describes it', (_, source, description) => {
  expect(executeProgram('python', source)).toMatchObject({ kind: 'executed', uncaughtException: description });
});

test('the trace shows an instance of a subclass of a builtin type as the builtin value, with the fields of self', () => {
  const program = `class Stack(list):
    def __init__(self, name):
        super().__init__()
        self.name = name
class Money(int):
    pass
s = Stack('a')
s.append(Money(5))`;
  const { traceItems } = traceProgram('python', program, program);
  expect(traceItems.find((item) => item.line === 4)?.vars).toEqual({ self: [], name: 'a', 'self.name': 'a' });
  expect(traceItems.at(-1)?.vars).toEqual({ s: [5] });
});
