// `concurrent.futures` with its thread pool, transcribed from CPython's Lib/concurrent/futures/_base.py and thread.py
// onto `threading` and `queue`. A pool's default size counts 8 CPUs, as `os.process_cpu_count()` differs per machine.
import { registerModule } from '../modules';
import { registerSourceModule } from '../sourceModules';

const SOURCE = String.raw`
_CPU_COUNT = 8
import collections
import threading
from _thread import _monotonic
from itertools import islice
FIRST_COMPLETED = 'FIRST_COMPLETED'
FIRST_EXCEPTION = 'FIRST_EXCEPTION'
ALL_COMPLETED = 'ALL_COMPLETED'
_AS_COMPLETED = '_AS_COMPLETED'
PENDING = 'PENDING'
RUNNING = 'RUNNING'
CANCELLED = 'CANCELLED'
CANCELLED_AND_NOTIFIED = 'CANCELLED_AND_NOTIFIED'
FINISHED = 'FINISHED'
_STATE_TO_DESCRIPTION_MAP = {
    PENDING: "pending",
    RUNNING: "running",
    CANCELLED: "cancelled",
    CANCELLED_AND_NOTIFIED: "cancelled",
    FINISHED: "finished"
}
class _Logger:
    def critical(self, *args, **kwargs):
        pass
    def exception(self, *args, **kwargs):
        pass
LOGGER = _Logger()
class Error(Exception):
    __module__ = 'concurrent.futures._base'
class CancelledError(Error):
    __module__ = 'concurrent.futures._base'
class InvalidStateError(Error):
    __module__ = 'concurrent.futures._base'
class _Waiter(object):
    def __init__(self):
        self.event = threading.Event()
        self.finished_futures = []
    def add_result(self, future):
        self.finished_futures.append(future)
    def add_exception(self, future):
        self.finished_futures.append(future)
    def add_cancelled(self, future):
        self.finished_futures.append(future)
class _AsCompletedWaiter(_Waiter):
    def __init__(self):
        super(_AsCompletedWaiter, self).__init__()
        self.lock = threading.Lock()
    def add_result(self, future):
        with self.lock:
            super(_AsCompletedWaiter, self).add_result(future)
            self.event.set()
    def add_exception(self, future):
        with self.lock:
            super(_AsCompletedWaiter, self).add_exception(future)
            self.event.set()
    def add_cancelled(self, future):
        with self.lock:
            super(_AsCompletedWaiter, self).add_cancelled(future)
            self.event.set()
class _FirstCompletedWaiter(_Waiter):
    def add_result(self, future):
        super().add_result(future)
        self.event.set()
    def add_exception(self, future):
        super().add_exception(future)
        self.event.set()
    def add_cancelled(self, future):
        super().add_cancelled(future)
        self.event.set()
class _AllCompletedWaiter(_Waiter):
    def __init__(self, num_pending_calls, stop_on_exception):
        self.num_pending_calls = num_pending_calls
        self.stop_on_exception = stop_on_exception
        self.lock = threading.Lock()
        super().__init__()
    def _decrement_pending_calls(self):
        with self.lock:
            self.num_pending_calls -= 1
            if not self.num_pending_calls:
                self.event.set()
    def add_result(self, future):
        super().add_result(future)
        self._decrement_pending_calls()
    def add_exception(self, future):
        super().add_exception(future)
        if self.stop_on_exception:
            self.event.set()
        else:
            self._decrement_pending_calls()
    def add_cancelled(self, future):
        super().add_cancelled(future)
        self._decrement_pending_calls()
class _AcquireFutures(object):
    def __init__(self, futures):
        self.futures = sorted(futures, key=id)
    def __enter__(self):
        for future in self.futures:
            future._condition.acquire()
    def __exit__(self, *args):
        for future in self.futures:
            future._condition.release()
def _create_and_install_waiters(fs, return_when):
    if return_when == _AS_COMPLETED:
        waiter = _AsCompletedWaiter()
    elif return_when == FIRST_COMPLETED:
        waiter = _FirstCompletedWaiter()
    else:
        pending_count = sum(
                f._state not in [CANCELLED_AND_NOTIFIED, FINISHED] for f in fs)
        if return_when == FIRST_EXCEPTION:
            waiter = _AllCompletedWaiter(pending_count, stop_on_exception=True)
        elif return_when == ALL_COMPLETED:
            waiter = _AllCompletedWaiter(pending_count, stop_on_exception=False)
        else:
            raise ValueError("Invalid return condition: %r" % return_when)
    for f in fs:
        f._waiters.append(waiter)
    return waiter
def _yield_finished_futures(fs, waiter, ref_collect):
    while fs:
        f = fs[-1]
        for futures_set in ref_collect:
            futures_set.remove(f)
        with f._condition:
            f._waiters.remove(waiter)
        del f
        yield fs.pop()
def as_completed(fs, timeout=None):
    if timeout is not None:
        end_time = timeout + _monotonic()
    fs = set(fs)
    total_futures = len(fs)
    with _AcquireFutures(fs):
        finished = set(
                f for f in fs
                if f._state in [CANCELLED_AND_NOTIFIED, FINISHED])
        pending = fs - finished
        waiter = _create_and_install_waiters(fs, _AS_COMPLETED)
    finished = list(finished)
    try:
        yield from _yield_finished_futures(finished, waiter,
                                           ref_collect=(fs,))
        while pending:
            if timeout is None:
                wait_timeout = None
            else:
                wait_timeout = end_time - _monotonic()
                if wait_timeout < 0:
                    raise TimeoutError(
                            '%d (of %d) futures unfinished' % (
                            len(pending), total_futures))
            waiter.event.wait(wait_timeout)
            with waiter.lock:
                finished = waiter.finished_futures
                waiter.finished_futures = []
                waiter.event.clear()
            finished.reverse()
            yield from _yield_finished_futures(finished, waiter,
                                               ref_collect=(fs, pending))
    finally:
        for f in fs:
            with f._condition:
                f._waiters.remove(waiter)
DoneAndNotDoneFutures = collections.namedtuple(
        'DoneAndNotDoneFutures', 'done not_done')
def wait(fs, timeout=None, return_when=ALL_COMPLETED):
    fs = set(fs)
    with _AcquireFutures(fs):
        done = {f for f in fs
                   if f._state in [CANCELLED_AND_NOTIFIED, FINISHED]}
        not_done = fs - done
        if (return_when == FIRST_COMPLETED) and done:
            return DoneAndNotDoneFutures(done, not_done)
        elif (return_when == FIRST_EXCEPTION) and done:
            if any(f for f in done
                   if not f.cancelled() and f.exception() is not None):
                return DoneAndNotDoneFutures(done, not_done)
        if len(done) == len(fs):
            return DoneAndNotDoneFutures(done, not_done)
        waiter = _create_and_install_waiters(fs, return_when)
    waiter.event.wait(timeout)
    for f in fs:
        with f._condition:
            f._waiters.remove(waiter)
    done.update(waiter.finished_futures)
    return DoneAndNotDoneFutures(done, fs - done)
def _result_or_cancel(fut, timeout=None):
    try:
        try:
            return fut.result(timeout)
        finally:
            fut.cancel()
    finally:
        del fut
class Future(object):
    __module__ = 'concurrent.futures._base'
    def __init__(self):
        self._condition = threading.Condition()
        self._state = PENDING
        self._result = None
        self._exception = None
        self._waiters = []
        self._done_callbacks = []
    def _invoke_callbacks(self):
        for callback in self._done_callbacks:
            try:
                callback(self)
            except Exception:
                LOGGER.exception('exception calling callback for %r', self)
    def __repr__(self):
        with self._condition:
            if self._state == FINISHED:
                if self._exception:
                    return '<%s at %#x state=%s raised %s>' % (
                        self.__class__.__name__,
                        id(self),
                        _STATE_TO_DESCRIPTION_MAP[self._state],
                        self._exception.__class__.__name__)
                else:
                    return '<%s at %#x state=%s returned %s>' % (
                        self.__class__.__name__,
                        id(self),
                        _STATE_TO_DESCRIPTION_MAP[self._state],
                        self._result.__class__.__name__)
            return '<%s at %#x state=%s>' % (
                    self.__class__.__name__,
                    id(self),
                   _STATE_TO_DESCRIPTION_MAP[self._state])
    def cancel(self):
        with self._condition:
            if self._state in [RUNNING, FINISHED]:
                return False
            if self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]:
                return True
            self._state = CANCELLED
            self._condition.notify_all()
        self._invoke_callbacks()
        return True
    def cancelled(self):
        with self._condition:
            return self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]
    def running(self):
        with self._condition:
            return self._state == RUNNING
    def done(self):
        with self._condition:
            return self._state in [CANCELLED, CANCELLED_AND_NOTIFIED, FINISHED]
    def __get_result(self):
        if self._exception is not None:
            try:
                raise self._exception
            finally:
                self = None
        else:
            return self._result
    def add_done_callback(self, fn):
        with self._condition:
            if self._state not in [CANCELLED, CANCELLED_AND_NOTIFIED, FINISHED]:
                self._done_callbacks.append(fn)
                return
        try:
            fn(self)
        except Exception:
            LOGGER.exception('exception calling callback for %r', self)
    def result(self, timeout=None):
        try:
            with self._condition:
                if self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]:
                    raise CancelledError()
                elif self._state == FINISHED:
                    return self.__get_result()
                self._condition.wait(timeout)
                if self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]:
                    raise CancelledError()
                elif self._state == FINISHED:
                    return self.__get_result()
                else:
                    raise TimeoutError()
        finally:
            self = None
    def exception(self, timeout=None):
        with self._condition:
            if self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]:
                raise CancelledError()
            elif self._state == FINISHED:
                return self._exception
            self._condition.wait(timeout)
            if self._state in [CANCELLED, CANCELLED_AND_NOTIFIED]:
                raise CancelledError()
            elif self._state == FINISHED:
                return self._exception
            else:
                raise TimeoutError()
    def set_running_or_notify_cancel(self):
        with self._condition:
            if self._state == CANCELLED:
                self._state = CANCELLED_AND_NOTIFIED
                for waiter in self._waiters:
                    waiter.add_cancelled(self)
                return False
            elif self._state == PENDING:
                self._state = RUNNING
                return True
            else:
                LOGGER.critical('Future %s in unexpected state: %s',
                                id(self),
                                self._state)
                raise RuntimeError('Future in unexpected state')
    def set_result(self, result):
        with self._condition:
            if self._state in {CANCELLED, CANCELLED_AND_NOTIFIED, FINISHED}:
                raise InvalidStateError('{}: {!r}'.format(self._state, self))
            self._result = result
            self._state = FINISHED
            for waiter in self._waiters:
                waiter.add_result(self)
            self._condition.notify_all()
        self._invoke_callbacks()
    def set_exception(self, exception):
        with self._condition:
            if self._state in {CANCELLED, CANCELLED_AND_NOTIFIED, FINISHED}:
                raise InvalidStateError('{}: {!r}'.format(self._state, self))
            self._exception = exception
            self._state = FINISHED
            for waiter in self._waiters:
                waiter.add_exception(self)
            self._condition.notify_all()
        self._invoke_callbacks()
class Executor(object):
    __module__ = 'concurrent.futures._base'
    def submit(self, fn, /, *args, **kwargs):
        raise NotImplementedError()
    def map(self, fn, *iterables, timeout=None, chunksize=1, buffersize=None):
        if buffersize is not None and not isinstance(buffersize, int):
            raise TypeError("buffersize must be an integer or None")
        if buffersize is not None and buffersize < 1:
            raise ValueError("buffersize must be None or > 0")
        if timeout is not None:
            end_time = timeout + _monotonic()
        zipped_iterables = zip(*iterables)
        if buffersize:
            fs = collections.deque(
                self.submit(fn, *args) for args in islice(zipped_iterables, buffersize)
            )
        else:
            fs = [self.submit(fn, *args) for args in zipped_iterables]
        executor_weakref = lambda: self
        def result_iterator():
            try:
                fs.reverse()
                while fs:
                    if (
                        buffersize
                        and (executor := executor_weakref())
                        and (args := next(zipped_iterables, None))
                    ):
                        fs.appendleft(executor.submit(fn, *args))
                    if timeout is None:
                        yield _result_or_cancel(fs.pop())
                    else:
                        yield _result_or_cancel(fs.pop(), end_time - _monotonic())
            finally:
                for future in fs:
                    future.cancel()
        return result_iterator()
    def shutdown(self, wait=True, *, cancel_futures=False):
        pass
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.shutdown(wait=True)
        return False
class BrokenExecutor(RuntimeError):
    __module__ = 'concurrent.futures._base'
import itertools
import queue
_threads_queues = {}
_shutdown = False
_global_shutdown_lock = threading.Lock()
def _python_exit():
    global _shutdown
    with _global_shutdown_lock:
        _shutdown = True
    items = list(_threads_queues.items())
    for t, q in items:
        q.put(None)
    for t, q in items:
        t.join()
threading._register_atexit(_python_exit)
class WorkerContext:
    __module__ = 'concurrent.futures.thread'
    @classmethod
    def prepare(cls, initializer, initargs):
        if initializer is not None:
            if not callable(initializer):
                raise TypeError("initializer must be a callable")
        def create_context():
            return cls(initializer, initargs)
        def resolve_task(fn, args, kwargs):
            return (fn, args, kwargs)
        return create_context, resolve_task
    def __init__(self, initializer, initargs):
        self.initializer = initializer
        self.initargs = initargs
    def initialize(self):
        if self.initializer is not None:
            self.initializer(*self.initargs)
    def finalize(self):
        pass
    def run(self, task):
        fn, args, kwargs = task
        return fn(*args, **kwargs)
class _WorkItem:
    __module__ = 'concurrent.futures.thread'
    def __init__(self, future, task):
        self.future = future
        self.task = task
    def run(self, ctx):
        if not self.future.set_running_or_notify_cancel():
            return
        try:
            result = ctx.run(self.task)
        except BaseException as exc:
            self.future.set_exception(exc)
            self = None
        else:
            self.future.set_result(result)
def _worker(executor_reference, ctx, work_queue):
    try:
        ctx.initialize()
    except BaseException:
        executor = executor_reference()
        if executor is not None:
            executor._initializer_failed()
        return
    try:
        while True:
            try:
                work_item = work_queue.get_nowait()
            except queue.Empty:
                executor = executor_reference()
                if executor is not None:
                    executor._idle_semaphore.release()
                del executor
                work_item = work_queue.get(block=True)
            if work_item is not None:
                work_item.run(ctx)
                del work_item
                continue
            executor = executor_reference()
            if _shutdown or executor is None or executor._shutdown:
                if executor is not None:
                    executor._shutdown = True
                work_queue.put(None)
                return
            del executor
    finally:
        ctx.finalize()
class BrokenThreadPool(BrokenExecutor):
    __module__ = 'concurrent.futures.thread'
class ThreadPoolExecutor(Executor):
    __module__ = 'concurrent.futures.thread'
    BROKEN = BrokenThreadPool
    _counter = itertools.count().__next__
    @classmethod
    def prepare_context(cls, initializer, initargs):
        return WorkerContext.prepare(initializer, initargs)
    def __init__(self, max_workers=None, thread_name_prefix='',
                 initializer=None, initargs=(), **ctxkwargs):
        if max_workers is None:
            max_workers = min(32, _CPU_COUNT + 4)
        if max_workers <= 0:
            raise ValueError("max_workers must be greater than 0")
        (self._create_worker_context,
         self._resolve_work_item_task,
         ) = type(self).prepare_context(initializer, initargs, **ctxkwargs)
        self._max_workers = max_workers
        self._work_queue = queue.SimpleQueue()
        self._idle_semaphore = threading.Semaphore(0)
        self._threads = set()
        self._broken = False
        self._shutdown = False
        self._shutdown_lock = threading.Lock()
        self._thread_name_prefix = (thread_name_prefix or
                                    ("ThreadPoolExecutor-%d" % self._counter()))
    def submit(self, fn, /, *args, **kwargs):
        with self._shutdown_lock, _global_shutdown_lock:
            if self._broken:
                raise self.BROKEN(self._broken)
            if self._shutdown:
                raise RuntimeError('cannot schedule new futures after shutdown')
            if _shutdown:
                raise RuntimeError('cannot schedule new futures after '
                                   'interpreter shutdown')
            f = Future()
            task = self._resolve_work_item_task(fn, args, kwargs)
            w = _WorkItem(f, task)
            self._work_queue.put(w)
            self._adjust_thread_count()
            return f
    def _adjust_thread_count(self):
        if self._idle_semaphore.acquire(timeout=0):
            return
        num_threads = len(self._threads)
        if num_threads < self._max_workers:
            thread_name = '%s_%d' % (self._thread_name_prefix or self,
                                     num_threads)
            t = threading.Thread(name=thread_name, target=_worker,
                                 args=(lambda: self,
                                       self._create_worker_context(),
                                       self._work_queue))
            t.start()
            self._threads.add(t)
            _threads_queues[t] = self._work_queue
    def _initializer_failed(self):
        with self._shutdown_lock:
            self._broken = ('A thread initializer failed, the thread pool '
                            'is not usable anymore')
            while True:
                try:
                    work_item = self._work_queue.get_nowait()
                except queue.Empty:
                    break
                if work_item is not None:
                    work_item.future.set_exception(self.BROKEN(self._broken))
    def shutdown(self, wait=True, *, cancel_futures=False):
        with self._shutdown_lock:
            self._shutdown = True
            if cancel_futures:
                while True:
                    try:
                        work_item = self._work_queue.get_nowait()
                    except queue.Empty:
                        break
                    if work_item is not None:
                        work_item.future.cancel()
            self._work_queue.put(None)
        if wait:
            for t in self._threads:
                t.join()
`;

registerModule('concurrent', () => new Map());
registerSourceModule('concurrent.futures', SOURCE, undefined, {
  blocks: true,
  unsupported: {
    ProcessPoolExecutor: 'concurrent.futures.ProcessPoolExecutor（別のプロセスでの実行）',
    InterpreterPoolExecutor: 'concurrent.futures.InterpreterPoolExecutor（別のインタプリタでの実行）',
  },
});
