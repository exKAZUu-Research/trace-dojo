import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('type hints honor suppression, generic scopes and wrapped callable namespaces', () => {
  const program = `import typing, functools, types
@typing.no_type_check
def ignored(value: 'Missing'): pass
@typing.no_type_check
class Ignored:
    value: 'Missing'
assert typing.get_type_hints(ignored) == typing.get_type_hints(Ignored) == {}
def generic[T](value: 'T') -> 'T': pass
assert typing.get_type_hints(generic) == {'value': generic.__type_params__[0], 'return': generic.__type_params__[0]}
class Generic[T]:
    value: 'T'
assert typing.get_type_hints(Generic)['value'] is Generic.__type_params__[0]
X = int
class Shadow:
    X = str
    value: 'X'
assert typing.get_type_hints(Shadow)['value'] is int
assert typing.get_type_hints(Shadow, {}, dict(vars(Shadow)))['value'] is str
namespace = {'X': int}
exec('def original(value: "X"): pass', namespace)
wrapped = functools.wraps(namespace['original'])(lambda *args, **kwargs: None)
assert typing.get_type_hints(wrapped)['value'] is int
assert typing.get_type_hints(wrapped, {'X': str})['value'] is str
class Item: pass
class Owner:
    def method(self, value: 'Item'): pass
assert typing.get_type_hints(Owner().method)['value'] is Item
print('hints')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'hints\n',
    uncaughtException: undefined,
  });
});

test('type hints resolve nested postponed strings and respect annotation formats', () => {
  const program = `from __future__ import annotations
import typing, annotationlib
class Item: pass
def postponed(value: 'Item') -> "list['Item']": pass
assert typing.get_type_hints(postponed) == {'value': Item, 'return': list[Item]}
class Owner:
    item: 'Item'
assert typing.get_type_hints(Owner)['item'] is Item
def unresolved(value: Missing): pass
assert typing.get_type_hints(unresolved, format=annotationlib.Format.STRING) == {'value': 'Missing'}
reference = typing.get_type_hints(unresolved, format=annotationlib.Format.FORWARDREF)['value']
assert isinstance(reference, annotationlib.ForwardRef) and reference.__forward_arg__ == 'Missing'
class Unknown:
    value: Missing
assert typing.get_type_hints(Unknown, format=annotationlib.Format.STRING) == {'value': 'Missing'}
assert isinstance(typing.get_type_hints(Unknown, format=annotationlib.Format.FORWARDREF)['value'], annotationlib.ForwardRef)
print('formats')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'formats\n',
    uncaughtException: undefined,
  });
});

test('inspect signature forwards wrapper and annotation evaluation options', () => {
  const program = `import inspect, functools
class Item: pass
def original(value: 'Item') -> 'Item': pass
wrapper = functools.wraps(original)(lambda *args, **kwargs: None)
wrapper.__annotations__ = {}
assert str(inspect.signature(wrapper, follow_wrapped=False)) == '(*args, **kwargs)'
sig = inspect.signature(wrapper, eval_str=True)
assert sig.parameters['value'].annotation is Item and sig.return_annotation is Item
sig = inspect.signature(original, eval_str=True, globals={'Item': int}, locals={'Item': str})
assert sig.parameters['value'].annotation is str and sig.return_annotation is str
assert str(inspect.signature(original)) == "(value: 'Item') -> 'Item'"
print('signature')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'signature\n',
    uncaughtException: undefined,
  });
});

test('signature formatting applies string annotation quoting to parameters and returns', () => {
  const program = `import inspect
def original(value: 'int', *, option: 'str' = 'x') -> 'str': pass
sig = inspect.signature(original)
assert sig.format(quote_annotation_strings=False) == "(value: int, *, option: str = 'x') -> str"
assert sig.format(max_width=1, quote_annotation_strings=False) == "(\\n    value: int,\\n    *,\\n    option: str = 'x'\\n) -> str"
print('quoted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'quoted\n',
    uncaughtException: undefined,
  });
});
