import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

const lines = (source: string): number[] => traceProgram('python', source, source).traceItems.map(({ line }) => line);

const DEADLOCK = 'デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。';

test('coroutines and async generators follow the protocols of await, async for, and async with', () => {
  expectSameAsCPython(`log = []
class Step:
    def __init__(self, v):
        self.v = v
    def __await__(self):
        return (yield self.v)
def run(coro):
    sent = None
    while True:
        try:
            y = coro.send(sent)
            log.append(("yielded", y))
            sent = y * 10
        except StopIteration as e:
            return e.value
async def agen(n):
    try:
        for i in range(n):
            got = await Step(i)
            x = yield got
            log.append(("sent in", x))
    finally:
        log.append("agen finally")
class Ctx:
    async def __aenter__(self):
        await Step(7)
        return "ctx"
    async def __aexit__(self, t, v, tb):
        log.append(("exit", t.__name__, str(v)))
        return True
async def main():
    async for v in agen(2):
        log.append(("loop", v))
    log.append([x async for x in agen(1)])
    log.append({x: await Step(x) for x in range(2)})
    g = (x + 1 async for x in agen(2))
    log.append((type(g).__name__, [y async for y in g]))
    async with Ctx() as c:
        log.append(c)
        raise ValueError("boom")
    a = agen(3)
    log.append(await a.__anext__())
    log.append(await a.asend("hi"))
    log.append(await a.aclose())
    log.append(await anext(a, "default"))
    return "done"
log.append(run(main()))
async def f():
    return 1
c = f()
c.close()
try:
    c.send(None)
except RuntimeError as e:
    log.append(str(e))
async def g():
    try:
        await 1
    except TypeError as e:
        log.append(str(e))
    try:
        async for _ in [1]:
            pass
    except TypeError as e:
        log.append(str(e))
    try:
        async with 1:
            pass
    except TypeError as e:
        log.append(str(e))
run(g())
expected = [('yielded', 0), ('loop', 0), ('sent in', None), ('yielded', 1), ('loop', 10), ('sent in', None), 'agen finally', ('yielded', 0), ('sent in', None), 'agen finally', [0], ('yielded', 0), ('yielded', 1), {0: 0, 1: 10}, ('yielded', 0), ('sent in', None), ('yielded', 1), ('sent in', None), 'agen finally', ('async_generator', [1, 11]), ('yielded', 7), 'ctx', ('exit', 'ValueError', 'boom'), ('yielded', 0), 0, ('sent in', 'hi'), ('yielded', 1), 10, 'agen finally', None, 'default', 'done', 'cannot reuse already awaited coroutine', "'int' object can't be awaited", "'async for' requires an object with __aiter__ method, got list", "'int' object does not support the asynchronous context manager protocol (missed __aexit__ method)"]
if log != expected:
    raise ValueError(log)`);
});

test('asyncio runs tasks, timers, and callbacks in the order of CPython event loop', () => {
  expectSameAsCPython(`import asyncio
log = []
async def say(msg, delay):
    await asyncio.sleep(delay)
    log.append(msg)
    return msg
async def worker(name, q):
    while True:
        item = await q.get()
        await asyncio.sleep(0.01 * item)
        log.append((name, item))
        q.task_done()
async def boom(n):
    await asyncio.sleep(n)
    raise ValueError(f"boom{n}")
async def slow():
    try:
        await asyncio.sleep(10)
    except asyncio.CancelledError:
        log.append("slow cancelled")
        raise
async def agen():
    try:
        for i in range(5):
            yield i
            await asyncio.sleep(0.01)
    finally:
        log.append("agen cleanup")
async def main():
    log.append(await asyncio.gather(say("a", 0.2), say("b", 0.1), say("c", 0.1), say("d", 0)))
    q = asyncio.Queue()
    for i in [3, 1, 2, 5, 4]:
        q.put_nowait(i)
    tasks = [asyncio.create_task(worker(f"w{i}", q)) for i in range(2)]
    await q.join()
    for t in tasks:
        t.cancel()
    log.append([type(r).__name__ for r in await asyncio.gather(*tasks, return_exceptions=True)])
    try:
        await asyncio.wait_for(slow(), timeout=0.5)
    except TimeoutError:
        log.append("timed out")
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(boom(0.1))
            tg.create_task(slow())
            tg.create_task(boom(0.2))
    except* ValueError as eg:
        log.append([str(e) for e in eg.exceptions])
    for c in asyncio.as_completed([say("x", 0.3), say("y", 0.1)]):
        log.append(await c)
    loop = asyncio.get_running_loop()
    loop.call_later(0.2, log.append, "later 0.2")
    loop.call_soon(log.append, "soon")
    loop.call_later(0.1, log.append, "later 0.1")
    await asyncio.sleep(0.3)
    async for v in agen():
        if v == 1:
            break
    log.append("after break")
    await asyncio.sleep(0.1)
    sem = asyncio.Semaphore(2)
    async def limited(i):
        async with sem:
            log.append(("in", i))
            await asyncio.sleep(0.1)
    await asyncio.gather(*(limited(i) for i in range(3)))
    return "main done"
log.append(asyncio.run(main()))
try:
    asyncio.run(boom(0))
except ValueError as e:
    log.append(repr(e))
expected = ['d', 'b', 'c', 'a', ['a', 'b', 'c', 'd'], ('w1', 1), ('w0', 3), ('w1', 2), ('w1', 4), ('w0', 5), ['CancelledError', 'CancelledError'], 'slow cancelled', 'timed out', 'slow cancelled', ['boom0.1'], 'y', 'y', 'x', 'x', 'soon', 'later 0.1', 'later 0.2', 'after break', 'agen cleanup', ('in', 0), ('in', 1), ('in', 2), 'main done', "ValueError('boom0')"]
if log != expected:
    raise ValueError(log)`);
});

test('threads run in a fixed order whose order-independent results match CPython', () => {
  expectSameAsCPython(`import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
log = []
def quick(n):
    log.append(("quick", n))
for i in range(3):
    threading.Thread(target=quick, args=(i,)).start()
log.append("main")
counter = 0
lock = threading.Lock()
def inc(n):
    global counter
    for _ in range(n):
        with lock:
            counter += 1
ts = [threading.Thread(target=inc, args=(500,)) for _ in range(4)]
for t in ts:
    t.start()
for t in ts:
    t.join()
log.append(counter)
q = queue.Queue(maxsize=2)
def producer():
    for i in range(4):
        q.put(i)
        log.append(("put", i))
    q.put(None)
def consumer():
    while (item := q.get()) is not None:
        log.append(("got", item))
p = threading.Thread(target=producer)
c = threading.Thread(target=consumer)
p.start()
c.start()
p.join()
c.join()
sem = threading.Semaphore(2)
inside = []
peak = []
def limited(i):
    with sem:
        inside.append(i)
        peak.append(len(inside))
        time.sleep(0.1)
        inside.remove(i)
ls = [threading.Thread(target=limited, args=(i,)) for i in range(3)]
for t in ls:
    t.start()
for t in ls:
    t.join()
log.append(max(peak))
barrier = threading.Barrier(2)
def wait_barrier(i):
    log.append(("before", i))
    barrier.wait()
    log.append(("after", i))
bs = [threading.Thread(target=wait_barrier, args=(i,)) for i in range(2)]
for t in bs:
    t.start()
for t in bs:
    t.join()
def square(x):
    time.sleep(0.01 * (5 - x))
    return x * x
with ThreadPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(square, i) for i in range(5)]
    log.append([f.result() for f in futures])
    log.append(sorted(f.result() for f in as_completed(futures)))
    log.append(list(executor.map(square, range(4))))
def fail():
    raise KeyError("k")
t = threading.Thread(target=fail)
t.start()
t.join()
log.append(t.is_alive())
expected = [('quick', 0), ('quick', 1), ('quick', 2), 'main', 2000, ('put', 0), ('put', 1), ('got', 0), ('got', 1), ('put', 2), ('put', 3), ('got', 2), ('got', 3), 2, ('before', 0), ('before', 1), ('after', 1), ('after', 0), [0, 1, 4, 9, 16], [0, 1, 4, 9, 16], [0, 1, 4, 9], False]
if log != expected:
    raise ValueError(log)`);
});

test('types.coroutine makes generators awaitable, and inspect tells coroutines and async generators apart', () => {
  expectSameAsCPython(`import asyncio, inspect, types
@types.coroutine
def sleep0():
    yield
    return 5
async def f():
    return await sleep0()
async def ag():
    yield 1
def g():
    yield
flags = [inspect.iscoroutinefunction(f), inspect.iscoroutine(f()), inspect.isasyncgenfunction(ag),
         inspect.isasyncgen(ag()), inspect.isgenerator(f()), inspect.isgeneratorfunction(ag),
         inspect.isawaitable(sleep0()), inspect.isawaitable(g()), isinstance(f(), types.CoroutineType)]
if (asyncio.run(f()), flags) != (5, [True, True, True, True, False, False, True, False, True]):
    raise ValueError(flags)`);
});

test('a deadlock of threads or tasks stops the program, and no except clause catches it', () => {
  const threads = `import threading
lock = threading.Lock()
lock.acquire()
try:
    lock.acquire()
except BaseException:
    print('caught')`;
  const tasks = `import asyncio
async def main():
    await asyncio.get_running_loop().create_future()
asyncio.run(main())`;
  const unjoined = `import threading
threading.Thread(target=threading.Event().wait).start()`;
  for (const program of [threads, tasks, unjoined]) {
    expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: DEADLOCK });
  }
});

test('steps of threads are recorded as they run, and the objects of the library stay hidden', () => {
  const program = `import threading
count = 0
lock = threading.Lock()
def work(n):
    global count
    with lock:
        count += n
t = threading.Thread(target=work, args=(2,))
t.start()
t.join()
print(count)`;
  const items = traceProgram('python', program, program).traceItems.map(({ line, callLines, vars, referenceVars }) => ({
    line,
    callLines,
    vars,
    referenceVars,
  }));
  expect(items).toEqual([
    { line: 0, callLines: [], vars: {}, referenceVars: {} },
    { line: 2, callLines: [], vars: { count: 0 }, referenceVars: {} },
    { line: 3, callLines: [], vars: { count: 0 }, referenceVars: {} },
    { line: 8, callLines: [], vars: { count: 0 }, referenceVars: {} },
    { line: 6, callLines: [], vars: { n: 2 }, referenceVars: {} },
    { line: 7, callLines: [], vars: { n: 2 }, referenceVars: {} },
    { line: 9, callLines: [], vars: { count: 2 }, referenceVars: {} },
    { line: 10, callLines: [], vars: { count: 2 }, referenceVars: {} },
    { line: 11, callLines: [], vars: { count: 2 }, referenceVars: {} },
  ]);
});

test('importing threading leaves the steps of a program that runs no thread as they are', () => {
  const program = `def add(a, b):
    s = a + b
    return s
def work(n):
    x = add(n, 1)
    print(x)
work(1)
y = work(2)`;
  expect(lines(`import threading\n${program}`)).toEqual(lines(`\n${program}`));
});
