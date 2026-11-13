import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('C constructors bind keywords and report count, required and duplicate arguments in parser order', () => {
  const program = `import contextvars, decimal
assert bytes(memoryview(object=b'abc')) == b'abc'
context = decimal.Context(prec=3)
assert decimal.Decimal(value='1.2345', context=context) == decimal.Decimal('1.2345')
assert contextvars.ContextVar('value', default=7).get() == 7
for call in (
    lambda: contextvars.ContextVar('a', 'b'),
    lambda: contextvars.ContextVar('a', 'b', 'c'),
    lambda: contextvars.ContextVar(name='a'),
    lambda: contextvars.ContextVar('a', defualt=1),
    lambda: memoryview(),
    lambda: memoryview(b'a', b'b'),
    lambda: memoryview(b'a', object=b'b'),
    lambda: memoryview(objec=b'a'),
    lambda: decimal.Decimal(x=1),
    lambda: decimal.Decimal(contex=context),
    lambda: decimal.Decimal(1, value=2),
    lambda: decimal.Decimal(1, None, x=2),
):
    try: call()
    except TypeError as error: print(str(error))
    else: raise AssertionError('invalid arguments accepted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: `ContextVar() takes at most 1 positional argument (2 given)
ContextVar() takes at most 2 arguments (3 given)
ContextVar() takes exactly 1 positional argument (0 given)
ContextVar() got an unexpected keyword argument 'defualt'. Did you mean 'default'?
memoryview() missing required argument 'object' (pos 1)
memoryview() takes at most 1 argument (2 given)
memoryview() takes at most 1 argument (2 given)
memoryview() missing required argument 'object' (pos 1)
this function got an unexpected keyword argument 'x'
this function got an unexpected keyword argument 'contex'. Did you mean 'context'?
argument for function given by name ('value') and position (1)
function takes at most 2 arguments (3 given)
`,
    uncaughtException: undefined,
  });
});

test('lock class statements and dynamic types reject inheritance while reentrant locks remain usable bases', () => {
  const program = `import _thread, threading
try:
    class Lock(threading.Lock): pass
except TypeError as error: print(str(error))
else: raise AssertionError('lock subclass accepted')
try: type('Lock', (_thread.LockType,), {})
except TypeError as error: print(str(error))
else: raise AssertionError('dynamic lock subclass accepted')
class Reentrant(_thread.RLock): pass
lock = Reentrant()
assert lock.acquire(False)
assert lock.acquire(False)
lock.release()
lock.release()
print('reentrant')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type '_thread.lock' is not an acceptable base type\ntype '_thread.lock' is not an acceptable base type\nreentrant\n",
    uncaughtException: undefined,
  });
});

test('C keyword diagnostics preserve raw keys while legacy parsers compare Unicode spellings', () => {
  const program = `import contextvars, decimal
class Name(str):
    def __str__(self): return 'shown'
class DifferentHash(Name):
    def __hash__(self): return 123
    def __eq__(self, other): return False
for call in (
    lambda: decimal.Decimal(**{Name('x'): 1}),
    lambda: decimal.Decimal(**{DifferentHash('value'): 1}),
    lambda: contextvars.ContextVar('name', **{Name('x'): 1}),
    lambda: contextvars.ContextVar('name', **{DifferentHash('default'): 1}),
    lambda: memoryview(**{DifferentHash('object'): b'x'}),
):
    try: call()
    except TypeError as error: print(str(error))
    else: raise AssertionError('invalid keyword accepted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: `this function got an unexpected keyword argument 'shown'
invalid keyword argument for this function
ContextVar() got an unexpected keyword argument 'shown'
invalid keyword argument for ContextVar()
memoryview() missing required argument 'object' (pos 1)
`,
    uncaughtException: undefined,
  });
});

test('native function keywords compare Unicode payloads without calling string subclass hash and equality hooks', () => {
  const program = `import zlib
class Name(str):
    def __hash__(self): return 123
    def __eq__(self, other): return False
compressed = zlib.compress(b'payload', **{Name('level'): 1})
assert zlib.decompress(compressed) == b'payload'
print('compressed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'compressed\n',
    uncaughtException: undefined,
  });
});
