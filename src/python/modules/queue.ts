// `queue`, transcribed from CPython's Lib/queue.py onto `threading`, so that blocked producers and consumers wake in
// CPython's order. SimpleQueue is the pure Python one, which behaves as `_queue.SimpleQueue` does for one interpreter.
import { registerSourceModule } from '../sourceModules';

const SOURCE = String.raw`
import threading
from collections import deque
from heapq import heappush, heappop
from _thread import _monotonic as time
class Empty(Exception):
    __module__ = '_queue'
class Full(Exception):
    pass
class ShutDown(Exception):
    pass
class Queue:
    def __init__(self, maxsize=0):
        self.maxsize = maxsize
        self._init(maxsize)
        self.mutex = threading.Lock()
        self.not_empty = threading.Condition(self.mutex)
        self.not_full = threading.Condition(self.mutex)
        self.all_tasks_done = threading.Condition(self.mutex)
        self.unfinished_tasks = 0
        self.is_shutdown = False
    def task_done(self):
        with self.all_tasks_done:
            unfinished = self.unfinished_tasks - 1
            if unfinished <= 0:
                if unfinished < 0:
                    raise ValueError('task_done() called too many times')
                self.all_tasks_done.notify_all()
            self.unfinished_tasks = unfinished
    def join(self):
        with self.all_tasks_done:
            while self.unfinished_tasks:
                self.all_tasks_done.wait()
    def qsize(self):
        with self.mutex:
            return self._qsize()
    def empty(self):
        with self.mutex:
            return not self._qsize()
    def full(self):
        with self.mutex:
            return 0 < self.maxsize <= self._qsize()
    def put(self, item, block=True, timeout=None):
        with self.not_full:
            if self.is_shutdown:
                raise ShutDown
            if self.maxsize > 0:
                if not block:
                    if self._qsize() >= self.maxsize:
                        raise Full
                elif timeout is None:
                    while self._qsize() >= self.maxsize:
                        self.not_full.wait()
                        if self.is_shutdown:
                            raise ShutDown
                elif timeout < 0:
                    raise ValueError("'timeout' must be a non-negative number")
                else:
                    endtime = time() + timeout
                    while self._qsize() >= self.maxsize:
                        remaining = endtime - time()
                        if remaining <= 0.0:
                            raise Full
                        self.not_full.wait(remaining)
                        if self.is_shutdown:
                            raise ShutDown
            self._put(item)
            self.unfinished_tasks += 1
            self.not_empty.notify()
    def get(self, block=True, timeout=None):
        with self.not_empty:
            if self.is_shutdown and not self._qsize():
                raise ShutDown
            if not block:
                if not self._qsize():
                    raise Empty
            elif timeout is None:
                while not self._qsize():
                    self.not_empty.wait()
                    if self.is_shutdown and not self._qsize():
                        raise ShutDown
            elif timeout < 0:
                raise ValueError("'timeout' must be a non-negative number")
            else:
                endtime = time() + timeout
                while not self._qsize():
                    remaining = endtime - time()
                    if remaining <= 0.0:
                        raise Empty
                    self.not_empty.wait(remaining)
                    if self.is_shutdown and not self._qsize():
                        raise ShutDown
            item = self._get()
            self.not_full.notify()
            return item
    def put_nowait(self, item):
        return self.put(item, block=False)
    def get_nowait(self):
        return self.get(block=False)
    def shutdown(self, immediate=False):
        with self.mutex:
            self.is_shutdown = True
            if immediate:
                while self._qsize():
                    self._get()
                    if self.unfinished_tasks > 0:
                        self.unfinished_tasks -= 1
                self.all_tasks_done.notify_all()
            self.not_empty.notify_all()
            self.not_full.notify_all()
    def _init(self, maxsize):
        self.queue = deque()
    def _qsize(self):
        return len(self.queue)
    def _put(self, item):
        self.queue.append(item)
    def _get(self):
        return self.queue.popleft()
class PriorityQueue(Queue):
    def _init(self, maxsize):
        self.queue = []
    def _qsize(self):
        return len(self.queue)
    def _put(self, item):
        heappush(self.queue, item)
    def _get(self):
        return heappop(self.queue)
class LifoQueue(Queue):
    def _init(self, maxsize):
        self.queue = []
    def _qsize(self):
        return len(self.queue)
    def _put(self, item):
        self.queue.append(item)
    def _get(self):
        return self.queue.pop()
class _PySimpleQueue:
    __module__ = '_queue'
    def __init__(self):
        self._queue = deque()
        self._count = threading.Semaphore(0)
    def put(self, item, block=True, timeout=None):
        self._queue.append(item)
        self._count.release()
    def get(self, block=True, timeout=None):
        if not block:
            timeout = None
        elif timeout is not None and timeout < 0:
            raise ValueError("'timeout' must be a non-negative number")
        if not self._count.acquire(block, timeout):
            raise Empty
        return self._queue.popleft()
    def put_nowait(self, item):
        return self.put(item, block=False)
    def get_nowait(self):
        return self.get(block=False)
    def empty(self):
        return len(self._queue) == 0
    def qsize(self):
        return len(self._queue)
class SimpleQueue(_PySimpleQueue):
    __module__ = '_queue'
`;

registerSourceModule('queue', SOURCE, undefined, { blocks: true });
