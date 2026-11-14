import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const iteratorSource = `class Iterator:
    def __init__(self): self.n = 0
    def __iter__(self): return self
    def __next__(self):
        self.n += 1
        if self.n > 2: raise StopIteration
        return self.n
    def __del__(self): print('released')
class Items:
    def __iter__(self): return Iterator()
`;

test.each([false, true])(
  'loops retain their iterator through collection, waits and early exits (threads=%s)',
  (threads) => {
    const program = `import gc, time
${threads ? 'time.sleep(0)' : ''}
${iteratorSource}
def run():
    for value in Items():
        gc.collect()
        ${threads ? 'time.sleep(0)' : 'pass'}
        print(value)
    print('loop end')
    for value in Items():
        print(value)
        break
    print('break end')
run()
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: '1\n2\nreleased\nloop end\n1\nreleased\nbreak end\nend\n',
      uncaughtException: undefined,
    });
  }
);

test.each([false, true])('native iterable consumers own custom iterators until returning (threads=%s)', (threads) => {
  const program = `import time
${threads ? 'time.sleep(0)' : ''}
${iteratorSource}
for consume in (list, tuple, any, all, min, max, sum, sorted):
    print(consume(Items()))
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'released\n[1, 2]\nreleased\n(1, 2)\nreleased\nTrue\nreleased\nTrue\nreleased\n1\nreleased\n2\nreleased\n3\nreleased\n[1, 2]\nend\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])('nested comprehension iterators release at their own boundaries (threads=%s)', (threads) => {
  const program = `import time
${threads ? 'time.sleep(0)' : ''}
${iteratorSource}
print([x + y for x in Items() for y in Items()])
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'released\nreleased\nreleased\n[2, 3, 3, 4]\nend\n',
    uncaughtException: undefined,
  });
});

test('async comprehensions retain distinct iterators while another task collects garbage', () => {
  const program = `import asyncio, gc
class Iterator:
    def __init__(self): self.n = 0
    def __aiter__(self): return self
    async def __anext__(self):
        await asyncio.sleep(0)
        self.n += 1
        if self.n > 2: raise StopAsyncIteration
        return self.n
    def __del__(self): print('released')
class Items:
    def __aiter__(self): return Iterator()
async def read(): return [x async for x in Items()]
async def collect():
    await asyncio.sleep(0)
    gc.collect()
async def main():
    result, _ = await asyncio.gather(read(), collect())
    print(result)
asyncio.run(main())
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'released\n[1, 2]\nend\n',
    uncaughtException: undefined,
  });
});
