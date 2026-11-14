import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['iter([Resource()])', false],
  ['iter((Resource(),))', false],
  ['iter({1: Resource()}.values())', false],
  ['iter({Resource(): 1})', false],
  ['iter({Resource()})', false],
  ['reversed({1: Resource()}.values())', false],
  ['iter({1: Resource()}.items())', true],
  ['reversed({1: Resource()}.items())', true],
  ['iter(collections.deque([Resource()]))', true],
  ['reversed(collections.deque([Resource()]))', true],
  ['reversed([Resource()])', true],
  ['iter(collections.OrderedDict([(1, Resource())]).items())', true],
  ['reversed(collections.OrderedDict([(1, Resource())]).items())', true],
] as const)('native iterator ownership after exhaustion: %s', (creation, retains) => {
  const program = `import collections, gc
class Resource:
    def __del__(self): print('released')
it = ${creation}
next(it)
print('yielded')
next(it, None)
gc.collect()
print('exhausted')
del it
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: retains ? 'yielded\nexhausted\nreleased\nend\n' : 'yielded\nreleased\nexhausted\nend\n',
    uncaughtException: undefined,
  });
});

test.each(['bytes', 'bytearray'])('exhausted %s iterators release subclass sources', (base) => {
  const program = `class Buffer(${base}):
    def __del__(self): print('released')
it = iter(Buffer(b'x'))
print(next(it))
assert next(it, None) is None
print('exhausted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '120\nreleased\nexhausted\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])(
  'dict item iterators retain their cached tuple without overwriting externally held results (%s)',
  (keepFirst) => {
    const program = `class Resource:
    def __init__(self, name): self.name = name
    def __del__(self): print('released', self.name)
it = iter({1: Resource('one'), 2: Resource('two')}.items())
${keepFirst ? 'first = next(it)' : 'next(it)'}
next(it)
next(it, None)
print('exhausted')
${keepFirst ? "assert first[0] == 1 and first[1].name == 'one'\ndel first" : 'pass'}
del it
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: keepFirst
        ? 'released two\nexhausted\nreleased one\nend\n'
        : 'released one\nexhausted\nreleased two\nend\n',
      uncaughtException: undefined,
    });
  }
);

test('exhaustion releases iterator ownership while independent source owners remain live', () => {
  const program = `class Resource:
    def __del__(self): print('released')
source = [Resource()]
it = iter(source)
next(it)
next(it, None)
print('retained')
del it
source.clear()
print('cleared')
source.append(9)
assert list(iter(source)) == [9]
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'retained\nreleased\ncleared\nend\n',
    uncaughtException: undefined,
  });
});

test('memory iterators release their view and exported source at exhaustion', () => {
  const program = `class Buffer(bytearray):
    def __del__(self): print('released')
it = iter(memoryview(Buffer(b'x')))
print(next(it))
next(it, None)
print('exhausted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '120\nreleased\nexhausted\n',
    uncaughtException: undefined,
  });
});

test('native collection builders retain yielded resources while iterator sources are released', () => {
  const program = `closed = 0
class Resource:
    def __init__(self): self.closed = False
    def __del__(self):
        global closed
        self.closed = True
        closed += 1
for builder in [list, tuple, set]:
    closed = 0
    it = iter({1: Resource(), 2: Resource()}.items())
    built = builder(it)
    assert closed == 0 and all(not pair[1].closed for pair in built)
    del built
    assert closed == 1
    del it
    assert closed == 2
print('built')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'built\n',
    uncaughtException: undefined,
  });
});

test('dictionary item traversal remains bounded while retained tuples stay unchanged', () => {
  const program = `d = {i: [i] for i in range(6000)}
total = 0
for key, value in d.items():
    total += value[0]
assert total == 17997000
kept = []
it = iter(d.items())
first = next(it)
kept.append(first)
del first
for pair in it:
    assert kept[0][0] == 0
assert kept == [(0, [0])]
d = {i: i for i in range(16000)}
assert sum(value for key, value in d.items()) == 127992000
print('traversed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'traversed\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])('item tuples stay efficient through generators after frame exposure (%s)', (expose) => {
  const program = `${expose ? 'locals()' : 'pass'}
d = {i: [i] for i in range(6000)}
def pairs():
    for pair in d.items(): yield pair
total = 0
for key, value in pairs(): total += value[0]
assert total == 17997000
it = iter({1: 'one', 2: 'two', 3: 'three'}.items())
def forward():
    pair = next(it)
    yield pair
g = forward()
first = next(g)
assert next(it) == (2, 'two')
assert first == (1, 'one')
assert next(g, None) is None
del first
assert next(it) == (3, 'three')
source = iter({1: 'one', 2: 'two', 3: 'three'}.items())
assert list(source) == [(1, 'one'), (2, 'two'), (3, 'three')]
print('forwarded')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'forwarded\n',
    uncaughtException: undefined,
  });
});

test.each(['locals()', 'vars()', 'sys._getframe()'])(
  'reflection during item iteration preserves bounded ownership: %s',
  (reflect) => {
    const program = `import sys
d = {i: [i] for i in range(9000)}
total = 0
for pair in d.items():
    if pair[0] == 0: ${reflect}
    total += pair[1][0]
assert total == 40495500
it = iter({1: 'one', 2: 'two', 3: 'three'}.items())
def capture():
    pair = next(it)
    return locals()
snapshot = capture()
assert next(it) == (2, 'two')
assert snapshot['pair'] == (1, 'one')
snapshot.clear()
assert next(it) == (3, 'three')
print('reflected')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'reflected\n',
      uncaughtException: undefined,
    });
  }
);
