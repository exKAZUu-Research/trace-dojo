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

test("an array's buffer has its type code and shares its memory, as CPython's does", () => {
  expectSameAsCPython(`import array, pickle, struct
a = array.array('i', [1, 2, 3])
m = memoryview(a)
actual = [(m.format, m.itemsize, m.shape, m.obj is a, m[1:].tolist(), m == a)]
m[0] = 9
a[1] = 7
actual += [a.tolist(), m.tolist(), m.cast('B').tolist()[:4], struct.unpack_from('i', a, 4)]
try:
    a.append(4)
except BufferError as e:
    actual.append(str(e))
m.release()
a.append(4)
struct.pack_into('i', a, 0, 5)
r = pickle.PickleBuffer(array.array('h', [1, -1])).raw()
actual += [a.tolist(), bytes(a), (r.format, r.shape, bytes(r)), memoryview(array.array('w', 'x')).format]
expected = [
    ('i', 4, (3,), True, [2, 3], True),
    [9, 7, 3],
    [9, 7, 3],
    [9, 0, 0, 0],
    (7,),
    'cannot resize an array that is exporting buffers',
    [5, 7, 3, 4],
    b'\\x05\\x00\\x00\\x00\\x07\\x00\\x00\\x00\\x03\\x00\\x00\\x00\\x04\\x00\\x00\\x00',
    ('B', (4,), b'\\x01\\x00\\xff\\xff'),
    'w',
]`);
});

test('type and builtin types raise AttributeError for the type attributes CPython has none of', () => {
  expectSameAsCPython(`actual = []
for t in [type, int]:
    for name in ['__abstractmethods__', '__annotate__', '__annotations__']:
        try:
            getattr(t, name)
        except AttributeError as e:
            actual.append(str(e))
expected = [
    '__abstractmethods__',
    "type object 'type' has no attribute '__annotate__'",
    "type object 'type' has no attribute '__annotations__'",
    '__abstractmethods__',
    "type object 'int' has no attribute '__annotate__'",
    "type object 'int' has no attribute '__annotations__'",
]`);
});
