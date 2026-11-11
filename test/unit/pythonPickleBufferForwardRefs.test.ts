import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program whose list `actual` must equal `expected`, the list CPython 3.14.10 computes. */
function expectSameAsCPython(program: string): void {
  const checked = `${program}
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))
if len(actual) != len(expected):
    raise ValueError('lengths differ')`;
  expect(executeProgram('python', checked)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('pickle.PickleBuffer pickles in-band and out-of-band as CPython does', () => {
  expectSameAsCPython(`import pickle
from pickle import PickleBuffer
actual = []
bufs = []
data = pickle.dumps([PickleBuffer(b'ro'), PickleBuffer(bytearray(b'rw')), 7], protocol=5, buffer_callback=bufs.append)
actual.append(data)
out = pickle.loads(data, buffers=bufs)
actual += [[memoryview(x).readonly for x in out[:2]], bytes(out[1])]
actual.append(pickle.dumps(PickleBuffer(bytearray(b'xyz')), protocol=5))
for protocol, kwargs in [(4, {}), (5, {})]:
    try:
        pickle.loads(data, **kwargs) if protocol == 5 else pickle.dumps(PickleBuffer(b'a'), protocol)
    except Exception as e:
        actual.append(str(e))
b = bytearray(b'ab')
pb = PickleBuffer(b)
try:
    b.append(1)
except BufferError as e:
    actual.append(str(e))
pb.release()
try:
    pb.raw()
except ValueError as e:
    actual.append(str(e))
expected = [
    b'\\x80\\x05\\x95\\n\\x00\\x00\\x00\\x00\\x00\\x00\\x00]\\x94(\\x97\\x98\\x97K\\x07e.',
    [True, False],
    b'rw',
    b'\\x80\\x05\\x95\\x0e\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x96\\x03\\x00\\x00\\x00\\x00\\x00\\x00\\x00xyz\\x94.',
    'PickleBuffer can only be pickled with protocol >= 5',
    'pickle stream refers to out-of-band data but no *buffers* argument was given',
    'Existing exports of data: object cannot be re-sized',
    'operation forbidden on released PickleBuffer object',
]`);
});

test('typing evaluates nested forward references as CPython does', () => {
  expectSameAsCPython(`import typing
from typing import Annotated, Callable, ForwardRef, List, Optional, evaluate_forward_ref, get_type_hints
class Node:
    children: List['Node']
    parent: Optional['Node']
    tagged: Annotated[dict[str, 'Node'], 'meta']
ns = {'Node': Node, 'Callable': Callable, 'List': List}
actual = [repr(evaluate_forward_ref(ForwardRef(src), globals=ns)) for src in
          ['list["Node"]', 'List["Node"]', 'Callable[["Node"], "int"]', 'dict[str, list["Node"]]']]
actual += [repr(get_type_hints(Node)), repr(get_type_hints(Node, include_extras=True)), repr(List['Node'])]
try:
    evaluate_forward_ref(ForwardRef('list["Missing"]'))
except NameError as e:
    actual.append((str(e), e.name))
expected = [
    'list[__main__.Node]',
    'typing.List[__main__.Node]',
    'typing.Callable[[__main__.Node], int]',
    'dict[str, list[__main__.Node]]',
    "{'children': typing.List[__main__.Node], 'parent': __main__.Node | None, 'tagged': dict[str, __main__.Node]}",
    "{'children': typing.List[__main__.Node], 'parent': __main__.Node | None, "
    "'tagged': typing.Annotated[dict[str, __main__.Node], 'meta']}",
    "typing.List[ForwardRef('Node')]",
    ("name 'Missing' is not defined", 'Missing'),
]`);
});
