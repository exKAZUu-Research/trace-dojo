import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([false, true])('context and match temporaries release at their scope boundary (async=%s)', (async) => {
  const program = `import asyncio
class R:
    def __init__(self, n): self.n = n
    def __enter__(self): return self
    def __exit__(self, *args): print('exit', self.n)
    async def __aenter__(self):
        await asyncio.sleep(0)
        return self
    async def __aexit__(self, *args):
        await asyncio.sleep(0)
        print('exit', self.n)
    def __del__(self): print('del', self.n)
${async ? 'async ' : ''}def run():
    ${async ? 'async ' : ''}with R(1), R(2): pass
    print('with end')
    ${async ? 'async ' : ''}with R(3) as r:
        r = None
    print('rebound end')
    match R(4):
        case None: pass
    print('match end')
${async ? 'asyncio.run(run())' : 'run()'}
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'exit 2\ndel 2\nexit 1\ndel 1\nwith end\nexit 3\ndel 3\nrebound end\ndel 4\nmatch end\nend\n',
    uncaughtException: undefined,
  });
});

test('temporary cleanup preserves returned objects and escaping traceback locals', () => {
  const program = `class R:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __del__(self): print('del')
def returned():
    with R() as value: return value
value = returned()
print(type(value).__name__)
del value
print('returned end')
def failed():
    with R() as value: raise ValueError()
try: failed()
except ValueError as error: saved = error.__traceback__
print('saved')
del saved
print('error end')
def final():
    try: return R()
    finally: pass
value = final()
print(type(value).__name__)
del value
print('final end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'R\ndel\nreturned end\nsaved\ndel\nerror end\nR\ndel\nfinal end\n',
    uncaughtException: undefined,
  });
});

test('releasing traceback frames uses local slot order rather than assignment order', () => {
  const program = `class R:
    def __init__(self, n): self.n = n
    def __del__(self): print('del', self.n)
def fail():
    first = None
    second = R(2)
    first = R(1)
    alias = first
    raise ValueError()
try: fail()
except ValueError as error: saved = error.__traceback__
del saved
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'del 2\ndel 1\nend\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])(
  'frame.clear releases a generator expression iterator unless independently held (%s)',
  (retain) => {
    const program = `import weakref
class It:
    def __iter__(self): return self
    def __next__(self): return 1
    def __del__(self): print('del')
iterator = It()
ref = weakref.ref(iterator)
g = (x for x in iterator)
frame = g.gi_frame
${retain ? '' : 'del iterator'}
g.close()
frame.clear()
print(ref() is None)
${retain ? 'del iterator\nprint(ref() is None)' : ''}
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: retain ? 'False\ndel\nTrue\nend\n' : 'del\nTrue\nend\n',
      uncaughtException: undefined,
    });
  }
);

test.each([false, true])('shutdown keeps container ownership depth across namespace order (%s)', (listFirst) => {
  const list = "items = [R('list')]";
  const others = `def f(x=R('default')): return x
class Holder: attr = R('classattr')
def make(x=R('closure_default')):
    def inner(): return x
    return inner
closure = make()`;
  const program = `class R:
    def __init__(self, n): self.n = n
    def __del__(self): print('del', self.n)
${listFirst ? list + '\n' + others : others + '\n' + list}
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'end\ndel list\ndel default\ndel classattr\ndel closure_default\n',
    uncaughtException: undefined,
  });
});

test('a grader stop bypasses context exit and temporary finalization', () => {
  const program = `class R:
    def __enter__(self): return self
    def __exit__(self, *args): print('exit')
    def __del__(self): print('del')
with R():
    print('before')
    input()
print('after')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'before\n',
    uncaughtException: '標準入力（input()）は、この採点環境では使えません。',
  });
});
