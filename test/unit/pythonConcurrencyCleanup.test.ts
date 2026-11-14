import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('concurrent futures and event loops deliver failures to configured loggers', () => {
  const program = `import logging, concurrent.futures, asyncio
class Handler(logging.Handler):
    def emit(self, record):
        print(record.name, record.levelname, type(record.exc_info[1]).__name__)
for name in ['concurrent.futures', 'asyncio']:
    logger = logging.getLogger(name)
    logger.addHandler(Handler())
    logger.propagate = False
def fail(future): raise ValueError('callback')
future = concurrent.futures.Future()
future.add_done_callback(fail)
future.set_result(1)
def initialize(): raise ValueError('initializer')
with concurrent.futures.ThreadPoolExecutor(1, initializer=initialize) as pool:
    try: pool.submit(int).result()
    except concurrent.futures.thread.BrokenThreadPool: print('broken')
async def main():
    loop = asyncio.get_running_loop()
    loop.call_soon(fail, None)
    await asyncio.sleep(0)
    loop.call_exception_handler({'message': 'explicit', 'exception': ValueError('explicit'), 'extra': 'detail'})
asyncio.run(main())
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'concurrent.futures ERROR ValueError\nconcurrent.futures CRITICAL ValueError\nbroken\nasyncio ERROR ValueError\nasyncio ERROR ValueError\nend\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])('dropping an executor wakes its idle worker (map=%s)', (map) => {
  const program = `import concurrent.futures, threading
pool = concurrent.futures.ThreadPoolExecutor(1)
${map ? 'results = pool.map(int, [1, 2])\nprint(next(results))' : 'print(pool.submit(int, 1).result())'}
workers = [t for t in threading.enumerate() if t is not threading.current_thread()]
del pool
for worker in workers:
    worker.join(timeout=1)
    assert not worker.is_alive()
print('joined')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\njoined\n',
    uncaughtException: undefined,
  });
});

test.each(['append', 'extend'])(
  'a suspending sort restores original items when its key raises after a concurrent %s',
  (operation) => {
    const program = `import threading
items = [3, 1, 2]
entered = threading.Event()
resume = threading.Event()
def key(value):
    entered.set()
    resume.wait()
    raise ValueError('key failed')
def sort():
    try: items.sort(key=key)
    except ValueError as error: print(error)
worker = threading.Thread(target=sort)
worker.start()
entered.wait()
${operation === 'append' ? 'items.append(9)' : 'items.extend([9, 10])'}
resume.set()
worker.join()
print(items)`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'key failed\n[3, 1, 2]\n',
      uncaughtException: undefined,
    });
  }
);

test.each(['', 'import threading\n'])('sort detects historical mutations in either execution mode (%s)', (imports) => {
  const program = `${imports}for operation in ['pop', 'clear']:
    items = [3, 1, 2]
    def key(value):
        if operation == 'pop':
            items.append(9)
            items.pop()
        else:
            items.extend([9, 10])
            items.clear()
        return value
    try: items.sort(key=key)
    except ValueError as error: print(error)
    else: raise AssertionError('missed mutation')
    print(items)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'list modified during sort\n[1, 2, 3]\nlist modified during sort\n[1, 2, 3]\n',
    uncaughtException: undefined,
  });
});
