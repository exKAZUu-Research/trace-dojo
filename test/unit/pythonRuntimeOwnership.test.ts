import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['close', 'g.close()'],
  ['throw', 'g.throw(ValueError())'],
  ['body exception', 'next(g)'],
])('completed generators release locals after %s', (_name, finish) => {
  const program = `class A:
    def __del__(self): print('del')
def gen():
    a = A()
    yield 1
    raise ValueError()
g = gen()
next(g)
try:
    ${finish}
except ValueError:
    pass
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'del\nend\n',
    uncaughtException: undefined,
  });
});

test('an exposed generator frame keeps locals until the frame is released', () => {
  const program = `import sys, weakref
class A:
    def __del__(self): print('del')
def gen():
    a = A()
    yield sys._getframe(), weakref.ref(a)
g = gen()
frame, ref = next(g)
g.close()
print(ref() is not None, frame.f_generator is None)
print(type(frame.f_locals['a']).__name__)
del frame
print(ref() is None)
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'True True\nA\ndel\nTrue\nend\n',
    uncaughtException: undefined,
  });
});

test('an escaped generator traceback retains locals after an exceptional exit', () => {
  const program = `import weakref
class A:
    def __del__(self): print('del')
refs = []
def gen():
    a = A()
    refs.append(weakref.ref(a))
    yield 1
    raise ValueError()
g = gen()
next(g)
try:
    next(g)
except ValueError as error:
    saved = error.__traceback__
print(refs[0]() is not None)
del saved
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'True\ndel\nend\n',
    uncaughtException: undefined,
  });
});

test('BLAKE2 state snapshots mutable constructor parameters and survives copying', () => {
  const program = `import hashlib
for name in ('blake2b', 'blake2s'):
    for parameter in ('key', 'salt', 'person'):
        data = bytearray(b'key')
        h = getattr(hashlib, name)(b'message', **{parameter: data})
        expected = h.hexdigest()
        copy = h.copy()
        data[0] = 88
        print(expected == h.hexdigest(), expected == copy.hexdigest())
        h.update(b'x')
        print(h.hexdigest() != copy.hexdigest())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'True True\nTrue\n'.repeat(6),
    uncaughtException: undefined,
  });
});

test.each([
  ['hash copies', 'import hashlib\nh=hashlib.sha256(bytes(500000))\na=[h.copy() for _ in range(30)]'],
  ['struct layouts', 'import struct\nstruct.calcsize("x" * 400000)'],
])('%s obey the storage budget', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: 'MemoryError' });
});

test('Fraction normalization charges large-integer gcd work', () => {
  expect(executeProgram('python', 'from fractions import Fraction\nFraction(2**1000000, 3**600000)')).toMatchObject({
    kind: 'limitExceeded',
  });
});

test.each([false, true])('XML expansion cannot be diluted by future input (split=%s)', (split) => {
  const program = `import xml.parsers.expat
entities = ['<!ENTITY e0 "' + 'x' * 1000 + '">']
for i in range(1, 5):
    entities.append(f'<!ENTITY e{i} "' + f'&e{i-1};' * 10 + '">')
doc = '<!DOCTYPE r [' + ''.join(entities) + ']><r>&e4;</r>'
tail = '<!--' + ' ' * 200000 + '-->'
p = xml.parsers.expat.ParserCreate()
p.Parse(doc${split ? ', False)\np.Parse(tail, True)' : ' + tail, True)'}`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    uncaughtException:
      'xml.parsers.expat.ExpatError: limit on input amplification factor (from DTD and entities) breached: line 1, column 1253',
  });
});

test('parameter entity expansion in XML declarations obeys the operation budget', () => {
  const program = `import xml.parsers.expat
entities = ['<!ENTITY % e0 " ">']
for i in range(1, 9):
    entities.append(f'<!ENTITY % e{i} "' + f'&#37;e{i-1};' * 10 + '">')
p = xml.parsers.expat.ParserCreate()
p.SetParamEntityParsing(xml.parsers.expat.XML_PARAM_ENTITY_PARSING_ALWAYS)
p.Parse('<!DOCTYPE r [' + ''.join(entities) + '%e8;]><r/>', True)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  ['unsupported input', 'input()', '標準入力（input()）は、この採点環境では使えません。'],
  [
    'deadlock',
    'lock=threading.Lock(); lock.acquire(); lock.acquire()',
    'デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。',
  ],
])('a grader stop for %s does not run shutdown code', (_name, stop, uncaughtException) => {
  const program = `import atexit, threading
atexit.register(lambda: print('atexit'))
def generator():
    try:
        yield 1
    except BaseException:
        print('caught')
    finally:
        print('cleanup')
g = generator()
next(g)
print('before')
${stop}
print('after')`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', stdout: 'before\n', uncaughtException });
});

test('a deadlocked coroutine does not resume during shutdown', () => {
  const program = `import asyncio
async def main():
    try:
        await asyncio.Event().wait()
    except BaseException as error:
        print('caught', type(error).__name__)
    finally:
        print('cleanup')
asyncio.run(main())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。',
  });
});

test.each(['raise ValueError("failure")', 'raise SystemExit()'])(
  'Python exceptions still run shutdown code: %s',
  (stop) => {
    const program = `import atexit
atexit.register(lambda: print('atexit'))
def generator():
    try:
        yield 1
    finally:
        print('cleanup')
g = generator()
next(g)
print('before')
${stop}`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'before\natexit\ncleanup\n',
      uncaughtException: stop.includes('ValueError') ? 'ValueError: failure' : undefined,
    });
  }
);
