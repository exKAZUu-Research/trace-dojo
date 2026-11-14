import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('generated dataclass annotations honor string, value and forward-reference formats', () => {
  const program = `from dataclasses import dataclass
from annotationlib import get_annotations, Format, ForwardRef
from inspect import signature
from functools import partial
@dataclass
class Record:
    value: int
    other: Unknown
annotations = get_annotations(Record.__init__, format=Format.STRING)
assert annotations == {'value': 'int', 'other': 'Unknown', 'return': 'None'}
annotations = get_annotations(Record.__init__, format=Format.FORWARDREF)
assert annotations['value'] is int and isinstance(annotations['other'], ForwardRef)
assert annotations['return'] is None
try: get_annotations(Record.__init__, format=Format.VALUE)
except NameError: pass
else: raise AssertionError('resolved unknown type')
assert signature(Record, annotation_format=Format.STRING).parameters['other'].annotation == 'Unknown'
assert signature(partial(Record, 1), annotation_format=Format.FORWARDREF).parameters['other'].annotation.__forward_arg__ == 'Unknown'
Unknown = str
assert get_annotations(Record.__init__) == {'value': int, 'other': str, 'return': None}
print('annotated')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'annotated\n',
    uncaughtException: undefined,
  });
});

test('make_dataclass resolves generic bases through metaclass preparation', () => {
  const program = `from dataclasses import make_dataclass
class Box[T]: pass
for base in [list[int], Box[int]]:
    Child = make_dataclass('Child', [('value', int)], bases=(base,))
    assert Child(5).value == 5
    assert Child.__orig_bases__ == (base,)
    assert Child.__bases__[0] is base.__origin__
class Meta(type):
    @classmethod
    def __prepare__(cls, name, bases, **kwargs):
        return {'prepared': True}
class Parent(metaclass=Meta): pass
Child = make_dataclass('Child', ['value'], bases=(Parent,), namespace={'extra': 7})
assert Child.prepared and Child.extra == 7 and Child(3).value == 3
print('constructed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'constructed\n',
    uncaughtException: undefined,
  });
});
