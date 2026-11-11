// `asyncio`, transcribed from CPython's Lib/asyncio onto an event loop without I/O whose clock is the run's virtual one,
// so that tasks run in the order CPython's loop runs them: ready callbacks first in, first out, then timers by time.
import { registerSourceModule } from '../sourceModules';
import { asyncioNatives } from './asyncioNatives';

const SOURCE = String.raw`
import collections
import enum
import functools
import heapq
import itertools
import math

_PENDING = 'PENDING'
_CANCELLED = 'CANCELLED'
_FINISHED = 'FINISHED'
FIRST_COMPLETED = 'FIRST_COMPLETED'
FIRST_EXCEPTION = 'FIRST_EXCEPTION'
ALL_COMPLETED = 'ALL_COMPLETED'
iscoroutine = _core.iscoroutine


def iscoroutinefunction(func):
    return _core.iscoroutinefunction(func)


class CancelledError(BaseException):
    __module__ = 'asyncio.exceptions'


TimeoutError = TimeoutError


class InvalidStateError(Exception):
    __module__ = 'asyncio.exceptions'


class SendfileNotAvailableError(RuntimeError):
    __module__ = 'asyncio.exceptions'


class IncompleteReadError(EOFError):
    __module__ = 'asyncio.exceptions'

    def __init__(self, partial, expected):
        r_expected = 'undefined' if expected is None else repr(expected)
        super().__init__(f'{len(partial)} bytes read on a total of '
                         f'{r_expected} expected bytes')
        self.partial = partial
        self.expected = expected


class LimitOverrunError(Exception):
    __module__ = 'asyncio.exceptions'

    def __init__(self, message, consumed):
        super().__init__(message)
        self.consumed = consumed


class BrokenBarrierError(RuntimeError):
    __module__ = 'asyncio.exceptions'


# Events --------------------------------------------------------------------------------------------------------------

def _format_callback(func):
    if isinstance(func, functools.partial):
        return _format_callback(func.func)
    name = getattr(func, '__qualname__', None) or getattr(func, '__name__', None) or repr(func)
    if name.startswith('Task.'):
        name = 'Task.task_wakeup'
    return f'{name}()'


class Handle:
    __module__ = 'asyncio.events'

    def __init__(self, callback, args, loop, context=None):
        self._context = context
        self._loop = loop
        self._callback = callback
        self._args = args
        self._cancelled = False
        self._repr = None

    def _repr_info(self):
        info = [self.__class__.__name__]
        if self._cancelled:
            info.append('cancelled')
        if self._callback is not None:
            info.append(_format_callback(self._callback))
        return info

    def __repr__(self):
        if self._repr is not None:
            return self._repr
        info = self._repr_info()
        return '<{}>'.format(' '.join(info))

    def get_context(self):
        return self._context

    def cancel(self):
        if not self._cancelled:
            self._cancelled = True
            self._callback = None
            self._args = None

    def cancelled(self):
        return self._cancelled

    def _run(self):
        try:
            self._callback(*self._args)
        except (SystemExit, KeyboardInterrupt):
            raise
        except BaseException as exc:
            cb = _format_callback(self._callback)
            msg = f'Exception in callback {cb}'
            context = {
                'message': msg,
                'exception': exc,
                'handle': self,
            }
            self._loop.call_exception_handler(context)
        self = None


class TimerHandle(Handle):
    __module__ = 'asyncio.events'

    def __init__(self, when, callback, args, loop, context=None):
        super().__init__(callback, args, loop, context)
        self._when = when
        self._scheduled = False

    def _repr_info(self):
        info = super()._repr_info()
        pos = 2 if self._cancelled else 1
        info.insert(pos, f'when={self._when}')
        return info

    def __hash__(self):
        return hash(self._when)

    def __lt__(self, other):
        if isinstance(other, TimerHandle):
            return self._when < other._when
        return NotImplemented

    def __le__(self, other):
        if isinstance(other, TimerHandle):
            return self._when < other._when or self.__eq__(other)
        return NotImplemented

    def __gt__(self, other):
        if isinstance(other, TimerHandle):
            return self._when > other._when
        return NotImplemented

    def __ge__(self, other):
        if isinstance(other, TimerHandle):
            return self._when > other._when or self.__eq__(other)
        return NotImplemented

    def __eq__(self, other):
        if isinstance(other, TimerHandle):
            return (self._when == other._when and
                    self._callback == other._callback and
                    self._args == other._args and
                    self._cancelled == other._cancelled)
        return NotImplemented

    def cancel(self):
        if not self._cancelled:
            self._loop._timer_handle_cancelled(self)
        super().cancel()

    def when(self):
        return self._when


_running_loop = None
_event_loop = None


def get_running_loop():
    loop = _get_running_loop()
    if loop is None:
        raise RuntimeError('no running event loop')
    return loop


def _get_running_loop():
    if _running_loop is not None and _running_loop[1] == _core.get_ident():
        return _running_loop[0]
    return None


def _set_running_loop(loop):
    global _running_loop
    _running_loop = None if loop is None else (loop, _core.get_ident())


def get_event_loop():
    current_loop = _get_running_loop()
    if current_loop is not None:
        return current_loop
    if _event_loop is None or _event_loop[1] != _core.get_ident():
        raise RuntimeError("There is no current event loop in thread %r." % _core.thread_name())
    return _event_loop[0]


def set_event_loop(loop):
    global _event_loop
    _event_loop = None if loop is None else (loop, _core.get_ident())


def new_event_loop():
    return _UnixSelectorEventLoop()


def _run_until_complete_cb(fut):
    if not fut.cancelled():
        exc = fut.exception()
        if isinstance(exc, (SystemExit, KeyboardInterrupt)):
            return
    _get_loop(fut).stop()


class BaseEventLoop:
    __module__ = 'asyncio.base_events'

    def __init__(self):
        self._timer_cancelled_count = 0
        self._closed = False
        self._stopping = False
        self._ready = collections.deque()
        self._scheduled = []
        self._default_executor = None
        self._internal_fds = 0
        self._thread_id = None
        self._clock_resolution = 1e-09
        self._exception_handler = None
        self._debug = False
        self.slow_callback_duration = 0.1
        self._current_handle = None
        self._task_factory = None
        self._coroutine_origin_tracking_enabled = False
        self._coroutine_origin_tracking_saved_depth = None
        self._asyncgens_shutdown_called = False
        self._executor_shutdown_called = False

    def __repr__(self):
        return (
            f'<{self.__class__.__name__} running={self.is_running()} '
            f'closed={self.is_closed()} debug={self.get_debug()}>'
        )

    def create_future(self):
        return Future(loop=self)

    def create_task(self, coro, **kwargs):
        self._check_closed()
        if self._task_factory is not None:
            return self._task_factory(self, coro, **kwargs)
        task = Task(coro, loop=self, **kwargs)
        try:
            return task
        finally:
            del task

    def set_task_factory(self, factory):
        if factory is not None and not callable(factory):
            raise TypeError('task factory must be a callable or None')
        self._task_factory = factory

    def get_task_factory(self):
        return self._task_factory

    def _check_closed(self):
        if self._closed:
            raise RuntimeError('Event loop is closed')

    def _asyncgen_finalizer_hook(self, agen):
        if not self.is_closed():
            self.call_soon_threadsafe(self.create_task, agen.aclose())

    async def shutdown_asyncgens(self):
        self._asyncgens_shutdown_called = True
        closing_agens = _core.take_asyncgens()
        if not closing_agens:
            return
        results = await gather(
            *[ag.aclose() for ag in closing_agens],
            return_exceptions=True)
        for result, agen in zip(results, closing_agens):
            if isinstance(result, Exception):
                self.call_exception_handler({
                    'message': f'an error occurred during closing of '
                               f'asynchronous generator {agen!r}',
                    'exception': result,
                    'asyncgen': agen
                })

    async def shutdown_default_executor(self, timeout=None):
        self._executor_shutdown_called = True
        if self._default_executor is None:
            return
        self._default_executor.shutdown(wait=True)

    def _check_running(self):
        if self.is_running():
            raise RuntimeError('This event loop is already running')
        if _get_running_loop() is not None:
            raise RuntimeError(
                'Cannot run the event loop while another loop is running')

    def _run_forever_setup(self):
        self._check_closed()
        self._check_running()
        self._thread_id = _core.get_ident()
        _core.set_asyncgen_finalizer(self._asyncgen_finalizer_hook)
        _set_running_loop(self)

    def _run_forever_cleanup(self):
        self._stopping = False
        self._thread_id = None
        _set_running_loop(None)
        _core.set_asyncgen_finalizer(None)

    def run_forever(self):
        self._run_forever_setup()
        try:
            while True:
                self._run_once()
                if self._stopping:
                    break
        finally:
            self._run_forever_cleanup()

    def run_until_complete(self, future):
        self._check_closed()
        self._check_running()
        new_task = not isfuture(future)
        future = ensure_future(future, loop=self)
        future.add_done_callback(_run_until_complete_cb)
        try:
            self.run_forever()
        except:
            if new_task and future.done() and not future.cancelled():
                future.exception()
            raise
        finally:
            future.remove_done_callback(_run_until_complete_cb)
        if not future.done():
            raise RuntimeError('Event loop stopped before Future completed.')
        return future.result()

    def stop(self):
        self._stopping = True

    def close(self):
        if self.is_running():
            raise RuntimeError("Cannot close a running event loop")
        if self._closed:
            return
        self._closed = True
        self._ready.clear()
        self._scheduled.clear()
        self._executor_shutdown_called = True
        executor = self._default_executor
        if executor is not None:
            self._default_executor = None
            executor.shutdown(wait=False)

    def is_closed(self):
        return self._closed

    def is_running(self):
        return (self._thread_id is not None)

    def time(self):
        return _core.loop_time()

    def call_later(self, delay, callback, *args, context=None):
        if delay is None:
            raise TypeError('delay must not be None')
        timer = self.call_at(self.time() + delay, callback, *args,
                             context=context)
        return timer

    def call_at(self, when, callback, *args, context=None):
        if when is None:
            raise TypeError("when cannot be None")
        self._check_closed()
        timer = TimerHandle(when, callback, args, self, context)
        heapq.heappush(self._scheduled, timer)
        timer._scheduled = True
        return timer

    def call_soon(self, callback, *args, context=None):
        self._check_closed()
        handle = self._call_soon(callback, args, context)
        return handle

    def _call_soon(self, callback, args, context):
        handle = Handle(callback, args, self, context)
        self._ready.append(handle)
        return handle

    def call_soon_threadsafe(self, callback, *args, context=None):
        self._check_closed()
        handle = self._call_soon(callback, args, context)
        _core.wakeup(self)
        return handle

    def run_in_executor(self, executor, func, *args):
        self._check_closed()
        if executor is None:
            executor = self._default_executor
            if self._executor_shutdown_called:
                raise RuntimeError('Executor shutdown has been called')
            if executor is None:
                import concurrent.futures
                executor = concurrent.futures.ThreadPoolExecutor(
                    thread_name_prefix='asyncio'
                )
                self._default_executor = executor
        return wrap_future(executor.submit(func, *args), loop=self)

    def set_default_executor(self, executor):
        import concurrent.futures
        if not isinstance(executor, concurrent.futures.ThreadPoolExecutor):
            raise TypeError('executor must be ThreadPoolExecutor instance')
        self._default_executor = executor

    def get_exception_handler(self):
        return self._exception_handler

    def set_exception_handler(self, handler):
        if handler is not None and not callable(handler):
            raise TypeError(f'A callable object or None is expected, '
                            f'got {handler!r}')
        self._exception_handler = handler

    def default_exception_handler(self, context):
        message = context.get('message')
        if not message:
            message = 'Unhandled exception in event loop'
        _core.report(message)

    def call_exception_handler(self, context):
        if self._exception_handler is None:
            try:
                self.default_exception_handler(context)
            except (SystemExit, KeyboardInterrupt):
                raise
            except BaseException:
                pass
        else:
            try:
                ctx = None
                thing = context.get("task")
                if thing is None:
                    thing = context.get("future")
                if thing is None:
                    thing = context.get("handle")
                self._exception_handler(self, context)
            except (SystemExit, KeyboardInterrupt):
                raise
            except BaseException as exc:
                try:
                    self.default_exception_handler({
                        'message': 'Unhandled error in exception handler',
                        'exception': exc,
                        'context': context,
                    })
                except (SystemExit, KeyboardInterrupt):
                    raise
                except BaseException:
                    pass

    def _timer_handle_cancelled(self, handle):
        if handle._scheduled:
            self._timer_cancelled_count += 1

    def _run_once(self):
        sched_count = len(self._scheduled)
        if (sched_count > 100 and
            self._timer_cancelled_count / sched_count > 0.5):
            new_scheduled = []
            for handle in self._scheduled:
                if handle._cancelled:
                    handle._scheduled = False
                else:
                    new_scheduled.append(handle)
            heapq.heapify(new_scheduled)
            self._scheduled = new_scheduled
            self._timer_cancelled_count = 0
        else:
            while self._scheduled and self._scheduled[0]._cancelled:
                self._timer_cancelled_count -= 1
                handle = heapq.heappop(self._scheduled)
                handle._scheduled = False
        timeout = None
        if self._ready or self._stopping:
            timeout = 0
        elif self._scheduled:
            timeout = self._scheduled[0]._when - self.time()
            if timeout > 86400:
                timeout = 86400
            elif timeout < 0:
                timeout = 0
        _core.select(self, timeout)
        end_time = self.time() + self._clock_resolution
        while self._scheduled:
            handle = self._scheduled[0]
            if handle._when >= end_time:
                break
            handle = heapq.heappop(self._scheduled)
            handle._scheduled = False
            self._ready.append(handle)
        ntodo = len(self._ready)
        for i in range(ntodo):
            handle = self._ready.popleft()
            if handle._cancelled:
                continue
            handle._run()
        handle = None

    def get_debug(self):
        return self._debug

    def set_debug(self, enabled):
        self._debug = enabled


class _UnixSelectorEventLoop(BaseEventLoop):
    __module__ = 'asyncio.unix_events'


SelectorEventLoop = _UnixSelectorEventLoop
EventLoop = _UnixSelectorEventLoop
AbstractEventLoop = BaseEventLoop


# Futures -------------------------------------------------------------------------------------------------------------

def isfuture(obj):
    return (hasattr(obj.__class__, '_asyncio_future_blocking') and
            obj._asyncio_future_blocking is not None)


def _future_repr_info(future):
    info = [future._state.lower()]
    if future._state == _FINISHED:
        if future._exception is not None:
            info.append(f'exception={future._exception!r}')
        else:
            info.append(f'result={future._result!r}')
    if future._callbacks:
        info.append('cb=[' + ', '.join(_format_callback(cb) for cb, _ in future._callbacks) + ']')
    return info


class Future:
    __module__ = '_asyncio'
    _state = _PENDING
    _result = None
    _exception = None
    _loop = None
    _source_traceback = None
    _cancel_message = None
    _cancelled_exc = None
    _asyncio_future_blocking = False
    __asyncio_awaited_by = None
    __log_traceback = False

    def __init__(self, *, loop=None):
        if loop is None:
            self._loop = get_event_loop()
        else:
            self._loop = loop
        self._callbacks = []

    def __repr__(self):
        info = _future_repr_info(self)
        return '<{} {}>'.format(self.__class__.__name__, ' '.join(info))

    @property
    def _log_traceback(self):
        return self.__log_traceback

    @_log_traceback.setter
    def _log_traceback(self, val):
        if val:
            raise ValueError('_log_traceback can only be set to False')
        self.__log_traceback = False

    def get_loop(self):
        loop = self._loop
        if loop is None:
            raise RuntimeError("Future object is not initialized.")
        return loop

    def _make_cancelled_error(self):
        if self._cancelled_exc is not None:
            exc = self._cancelled_exc
            self._cancelled_exc = None
            return exc
        if self._cancel_message is None:
            exc = CancelledError()
        else:
            exc = CancelledError(self._cancel_message)
        return exc

    def cancel(self, msg=None):
        self.__log_traceback = False
        if self._state != _PENDING:
            return False
        self._state = _CANCELLED
        self._cancel_message = msg
        self.__schedule_callbacks()
        return True

    def __schedule_callbacks(self):
        callbacks = self._callbacks[:]
        if not callbacks:
            return
        self._callbacks[:] = []
        for callback, ctx in callbacks:
            self._loop.call_soon(callback, self, context=ctx)

    def cancelled(self):
        return self._state == _CANCELLED

    def done(self):
        return self._state != _PENDING

    def result(self):
        if self._state == _CANCELLED:
            raise self._make_cancelled_error()
        if self._state != _FINISHED:
            raise InvalidStateError('Result is not set.')
        self.__log_traceback = False
        if self._exception is not None:
            raise self._exception
        return self._result

    def exception(self):
        if self._state == _CANCELLED:
            raise self._make_cancelled_error()
        if self._state != _FINISHED:
            raise InvalidStateError('Exception is not set.')
        self.__log_traceback = False
        return self._exception

    def add_done_callback(self, fn, *, context=None):
        if self._state != _PENDING:
            self._loop.call_soon(fn, self, context=context)
        else:
            self._callbacks.append((fn, context))

    def remove_done_callback(self, fn):
        filtered_callbacks = [(f, ctx)
                              for (f, ctx) in self._callbacks
                              if f != fn]
        removed_count = len(self._callbacks) - len(filtered_callbacks)
        if removed_count:
            self._callbacks[:] = filtered_callbacks
        return removed_count

    def set_result(self, result):
        if self._state != _PENDING:
            raise InvalidStateError('invalid state')
        self._result = result
        self._state = _FINISHED
        self.__schedule_callbacks()

    def set_exception(self, exception):
        if self._state != _PENDING:
            raise InvalidStateError('invalid state')
        if isinstance(exception, type):
            exception = exception()
        if isinstance(exception, StopIteration):
            new_exc = RuntimeError("StopIteration interacts badly with "
                                   "generators and cannot be raised into a "
                                   "Future")
            new_exc.__cause__ = exception
            new_exc.__context__ = exception
            exception = new_exc
        self._exception = exception
        self._state = _FINISHED
        self.__schedule_callbacks()
        self.__log_traceback = True

    def __await__(self):
        if not self.done():
            self._asyncio_future_blocking = True
            yield self
        if not self.done():
            raise RuntimeError("await wasn't used with future")
        return self.result()

    __iter__ = __await__


_PyFuture = Future


def _get_loop(fut):
    try:
        get_loop = fut.get_loop
    except AttributeError:
        pass
    else:
        return get_loop()
    return fut._loop


def _set_result_unless_cancelled(fut, result):
    if fut.cancelled():
        return
    fut.set_result(result)


def future_add_to_awaited_by(fut, waiter, /):
    pass


def future_discard_from_awaited_by(fut, waiter, /):
    pass


def _copy_future_state(source, dest):
    if dest.cancelled():
        return
    if source.cancelled():
        dest.cancel()
    else:
        exception = source.exception()
        if exception is not None:
            dest.set_exception(_convert_future_exc(exception))
        else:
            result = source.result()
            dest.set_result(result)


def _convert_future_exc(exc):
    import concurrent.futures
    exc_class = type(exc)
    if exc_class is concurrent.futures.CancelledError:
        return CancelledError(*exc.args)
    elif exc_class is concurrent.futures.InvalidStateError:
        return InvalidStateError(*exc.args)
    else:
        return exc


def _set_concurrent_future_state(concurrent, source):
    if source.cancelled():
        concurrent.cancel()
    if not concurrent.set_running_or_notify_cancel():
        return
    exception = source.exception()
    if exception is not None:
        concurrent.set_exception(_convert_future_exc(exception))
    else:
        result = source.result()
        concurrent.set_result(result)


def _chain_future(source, destination):
    source_loop = _get_loop(source) if isfuture(source) else None
    dest_loop = _get_loop(destination) if isfuture(destination) else None

    def _set_state(future, other):
        if isfuture(future):
            _copy_future_state(other, future)
        else:
            _set_concurrent_future_state(future, other)

    def _call_check_cancel(destination):
        if destination.cancelled():
            if source_loop is None or source_loop is _get_running_loop():
                source.cancel()
            else:
                source_loop.call_soon_threadsafe(source.cancel)

    def _call_set_state(source):
        if (destination.cancelled() and
                dest_loop is not None and dest_loop.is_closed()):
            return
        if dest_loop is None or dest_loop is _get_running_loop():
            _set_state(destination, source)
        else:
            if dest_loop.is_closed():
                return
            dest_loop.call_soon_threadsafe(_set_state, destination, source)

    destination.add_done_callback(_call_check_cancel)
    source.add_done_callback(_call_set_state)


def wrap_future(future, *, loop=None):
    if isfuture(future):
        return future
    if loop is None:
        loop = get_event_loop()
    new_future = loop.create_future()
    _chain_future(future, new_future)
    return new_future


# Tasks ---------------------------------------------------------------------------------------------------------------

def _task_repr_info(task):
    info = _future_repr_info(task)
    if task.cancelling() and not task.done():
        info[0] = 'cancelling'
    info.insert(1, 'name=%r' % task.get_name())
    if task._fut_waiter is not None:
        info.insert(2, f'wait_for={task._fut_waiter!r}')
    if task._coro:
        info.insert(2, f'coro=<{_core.coroutine_repr(task._coro)}>')
    return info


class _Sleep0:
    def __await__(self):
        yield


_task_name_counter = itertools.count(1).__next__
def current_task(loop=None):
    if loop is None:
        loop = get_running_loop()
    return _current_tasks.get(loop)
def all_tasks(loop=None):
    if loop is None:
        loop = get_running_loop()
    eager_tasks = list(_eager_tasks)
    return {t for t in itertools.chain(_scheduled_tasks, eager_tasks)
            if _get_loop(t) is loop and not t.done()}
class Task(_PyFuture):
    __module__ = '_asyncio'
    _log_destroy_pending = True
    def __init__(self, coro, *, loop=None, name=None, context=None,
                 eager_start=False):
        super().__init__(loop=loop)
        if not iscoroutine(coro):
            self._log_destroy_pending = False
            raise TypeError(f"a coroutine was expected, got {coro!r}")
        if name is None:
            self._name = f'Task-{_task_name_counter()}'
        else:
            self._name = str(name)
        self._num_cancels_requested = 0
        self._must_cancel = False
        self._fut_waiter = None
        self._coro = coro
        self._context = context
        if eager_start and self._loop.is_running():
            self.__eager_start()
        else:
            self._loop.call_soon(self.__step, context=self._context)
            _py_register_task(self)
    def __repr__(self):
        info = _task_repr_info(self)
        return '<{} {}>'.format(self.__class__.__name__, ' '.join(info))
    def get_coro(self):
        return self._coro
    def get_context(self):
        return self._context
    def get_name(self):
        return self._name
    def set_name(self, value):
        self._name = str(value)
    def set_result(self, result):
        raise RuntimeError('Task does not support set_result operation')
    def set_exception(self, exception):
        raise RuntimeError('Task does not support set_exception operation')
    def cancel(self, msg=None):
        self._log_traceback = False
        if self.done():
            return False
        self._num_cancels_requested += 1
        if self._fut_waiter is not None:
            if self._fut_waiter.cancel(msg=msg):
                return True
        self._must_cancel = True
        self._cancel_message = msg
        return True
    def cancelling(self):
        return self._num_cancels_requested
    def uncancel(self):
        if self._num_cancels_requested > 0:
            self._num_cancels_requested -= 1
            if self._num_cancels_requested == 0:
                self._must_cancel = False
        return self._num_cancels_requested
    def __eager_start(self):
        prev_task = _py_swap_current_task(self._loop, self)
        try:
            _py_register_eager_task(self)
            try:
                self.__step_run_and_handle_result(None)
            finally:
                _py_unregister_eager_task(self)
        finally:
            try:
                curtask = _py_swap_current_task(self._loop, prev_task)
                assert curtask is self
            finally:
                if self.done():
                    self._coro = None
                    self = None  # Needed to break cycles when an exception occurs.
                else:
                    _py_register_task(self)
    def __step(self, exc=None):
        if self.done():
            raise InvalidStateError(
                f'__step(): already done: {self!r}, {exc!r}')
        if self._must_cancel:
            if not isinstance(exc, CancelledError):
                exc = self._make_cancelled_error()
            self._must_cancel = False
        self._fut_waiter = None
        _py_enter_task(self._loop, self)
        try:
            self.__step_run_and_handle_result(exc)
        finally:
            _py_leave_task(self._loop, self)
            self = None  # Needed to break cycles when an exception occurs.
    def __step_run_and_handle_result(self, exc):
        coro = self._coro
        try:
            if exc is None:
                result = coro.send(None)
            else:
                result = coro.throw(exc)
        except StopIteration as exc:
            if self._must_cancel:
                self._must_cancel = False
                super().cancel(msg=self._cancel_message)
            else:
                super().set_result(exc.value)
        except CancelledError as exc:
            self._cancelled_exc = exc
            super().cancel()  # I.e., Future.cancel(self).
        except (KeyboardInterrupt, SystemExit) as exc:
            super().set_exception(exc)
            raise
        except BaseException as exc:
            super().set_exception(exc)
        else:
            blocking = getattr(result, '_asyncio_future_blocking', None)
            if blocking is not None:
                if _get_loop(result) is not self._loop:
                    new_exc = RuntimeError(
                        f'Task {self!r} got Future '
                        f'{result!r} attached to a different loop')
                    self._loop.call_soon(
                        self.__step, new_exc, context=self._context)
                elif blocking:
                    if result is self:
                        new_exc = RuntimeError(
                            f'Task cannot await on itself: {self!r}')
                        self._loop.call_soon(
                            self.__step, new_exc, context=self._context)
                    else:
                        future_add_to_awaited_by(result, self)
                        result._asyncio_future_blocking = False
                        result.add_done_callback(
                            self.__wakeup, context=self._context)
                        self._fut_waiter = result
                        if self._must_cancel:
                            if self._fut_waiter.cancel(
                                    msg=self._cancel_message):
                                self._must_cancel = False
                else:
                    new_exc = RuntimeError(
                        f'yield was used instead of yield from '
                        f'in task {self!r} with {result!r}')
                    self._loop.call_soon(
                        self.__step, new_exc, context=self._context)
            elif result is None:
                self._loop.call_soon(self.__step, context=self._context)
            elif _core.isgenerator(result):
                new_exc = RuntimeError(
                    f'yield was used instead of yield from for '
                    f'generator in task {self!r} with {result!r}')
                self._loop.call_soon(
                    self.__step, new_exc, context=self._context)
            else:
                new_exc = RuntimeError(f'Task got bad yield: {result!r}')
                self._loop.call_soon(
                    self.__step, new_exc, context=self._context)
        finally:
            self = None  # Needed to break cycles when an exception occurs.
    def __wakeup(self, future):
        future_discard_from_awaited_by(future, self)
        try:
            future.result()
        except BaseException as exc:
            self.__step(exc)
        else:
            self.__step()
        self = None  # Needed to break cycles when an exception occurs.
_PyTask = Task
def create_task(coro, **kwargs):
    loop = get_running_loop()
    return loop.create_task(coro, **kwargs)
async def wait(fs, *, timeout=None, return_when=ALL_COMPLETED):
    if isfuture(fs) or iscoroutine(fs):
        raise TypeError(f"expect a list of futures, not {type(fs).__name__}")
    if not fs:
        raise ValueError('Set of Tasks/Futures is empty.')
    if return_when not in (FIRST_COMPLETED, FIRST_EXCEPTION, ALL_COMPLETED):
        raise ValueError(f'Invalid return_when value: {return_when}')
    fs = set(fs)
    if any(iscoroutine(f) for f in fs):
        raise TypeError("Passing coroutines is forbidden, use tasks explicitly.")
    loop = get_running_loop()
    return await _wait(fs, timeout, return_when, loop)
def _release_waiter(waiter, *args):
    if not waiter.done():
        waiter.set_result(None)
async def wait_for(fut, timeout):
    if timeout is not None and timeout <= 0:
        fut = ensure_future(fut)
        if fut.done():
            return fut.result()
        await _cancel_and_wait(fut)
        try:
            return fut.result()
        except CancelledError as exc:
            raise TimeoutError from exc
    async with _timeout(timeout):
        return await fut
async def _wait(fs, timeout, return_when, loop):
    assert fs, 'Set of Futures is empty.'
    waiter = loop.create_future()
    timeout_handle = None
    if timeout is not None:
        timeout_handle = loop.call_later(timeout, _release_waiter, waiter)
    counter = len(fs)
    cur_task = current_task()
    def _on_completion(f):
        nonlocal counter
        counter -= 1
        if (counter <= 0 or
            return_when == FIRST_COMPLETED or
            return_when == FIRST_EXCEPTION and (not f.cancelled() and
                                                f.exception() is not None)):
            if timeout_handle is not None:
                timeout_handle.cancel()
            if not waiter.done():
                waiter.set_result(None)
        future_discard_from_awaited_by(f, cur_task)
    for f in fs:
        f.add_done_callback(_on_completion)
        future_add_to_awaited_by(f, cur_task)
    try:
        await waiter
    finally:
        if timeout_handle is not None:
            timeout_handle.cancel()
        for f in fs:
            f.remove_done_callback(_on_completion)
            future_discard_from_awaited_by(f, cur_task)
    done, pending = set(), set()
    for f in fs:
        if f.done():
            done.add(f)
        else:
            pending.add(f)
    return done, pending
async def _cancel_and_wait(fut):
    loop = get_running_loop()
    waiter = loop.create_future()
    cb = functools.partial(_release_waiter, waiter)
    fut.add_done_callback(cb)
    cur_task = current_task()
    future_add_to_awaited_by(fut, cur_task)
    try:
        fut.cancel()
        await waiter
    finally:
        fut.remove_done_callback(cb)
        future_discard_from_awaited_by(fut, cur_task)
class _AsCompletedIterator:
    def __init__(self, aws, timeout):
        self._done = Queue()
        self._timeout_handle = None
        loop = get_event_loop()
        self._cur_task = current_task()
        todo = {ensure_future(aw, loop=loop) for aw in set(aws)}
        for f in todo:
            f.add_done_callback(self._handle_completion)
            future_add_to_awaited_by(f, self._cur_task)
        if todo and timeout is not None:
            self._timeout_handle = (
                loop.call_later(timeout, self._handle_timeout)
            )
        self._todo = todo
        self._todo_left = len(todo)
    def __aiter__(self):
        return self
    def __iter__(self):
        return self
    async def __anext__(self):
        if not self._todo_left:
            raise StopAsyncIteration
        assert self._todo_left > 0
        self._todo_left -= 1
        return await self._wait_for_one()
    def __next__(self):
        if not self._todo_left:
            raise StopIteration
        assert self._todo_left > 0
        self._todo_left -= 1
        return self._wait_for_one(resolve=True)
    def _handle_timeout(self):
        for f in self._todo:
            f.remove_done_callback(self._handle_completion)
            future_discard_from_awaited_by(f, self._cur_task)
            self._done.put_nowait(None)  # Sentinel for _wait_for_one().
        self._todo.clear()  # Can't do todo.remove(f) in the loop.
    def _handle_completion(self, f):
        if not self._todo:
            return  # _handle_timeout() was here first.
        self._todo.remove(f)
        future_discard_from_awaited_by(f, self._cur_task)
        self._done.put_nowait(f)
        if not self._todo and self._timeout_handle is not None:
            self._timeout_handle.cancel()
    async def _wait_for_one(self, resolve=False):
        try:
            f = await self._done.get()
        except:
            self._todo_left += 1
            raise
        if f is None:
            raise TimeoutError
        return f.result() if resolve else f
def as_completed(fs, *, timeout=None):
    if _core.isawaitable(fs):
        raise TypeError(
            f"expects an iterable of awaitables, not {type(fs).__name__}"
        )
    return _AsCompletedIterator(fs, timeout)
async def sleep(delay, result=None):
    if delay <= 0:
        await _Sleep0()
        return result
    if math.isnan(delay):
        raise ValueError("Invalid delay: NaN (not a number)")
    loop = get_running_loop()
    future = loop.create_future()
    h = loop.call_later(delay,
                        _set_result_unless_cancelled,
                        future, result)
    try:
        return await future
    finally:
        h.cancel()
def ensure_future(coro_or_future, *, loop=None):
    if isfuture(coro_or_future):
        if loop is not None and loop is not _get_loop(coro_or_future):
            raise ValueError('The future belongs to a different loop than '
                            'the one specified as the loop argument')
        return coro_or_future
    should_close = True
    if not iscoroutine(coro_or_future):
        if _core.isawaitable(coro_or_future):
            async def _wrap_awaitable(awaitable):
                return await awaitable
            coro_or_future = _wrap_awaitable(coro_or_future)
            should_close = False
        else:
            raise TypeError('An asyncio.Future, a coroutine or an awaitable '
                            'is required')
    if loop is None:
        loop = get_event_loop()
    try:
        return loop.create_task(coro_or_future)
    except RuntimeError:
        if should_close:
            coro_or_future.close()
        raise
class _GatheringFuture(Future):
    def __init__(self, children, *, loop):
        assert loop is not None
        super().__init__(loop=loop)
        self._children = children
        self._cancel_requested = False
    def cancel(self, msg=None):
        if self.done():
            return False
        ret = False
        for child in self._children:
            if child.cancel(msg=msg):
                ret = True
        if ret:
            self._cancel_requested = True
        return ret
def _discard_awaited_by(children, waiter):
    for fut in children:
        future_discard_from_awaited_by(fut, waiter)
def gather(*coros_or_futures, return_exceptions=False):
    if not coros_or_futures:
        loop = get_event_loop()
        outer = loop.create_future()
        outer.set_result([])
        return outer
    loop = _get_running_loop()
    if loop is not None:
        cur_task = current_task(loop)
    else:
        cur_task = None
    def _done_callback(fut, cur_task=cur_task):
        nonlocal nfinished
        nfinished += 1
        if cur_task is not None:
            future_discard_from_awaited_by(fut, cur_task)
        if outer is None or outer.done():
            if not fut.cancelled():
                fut.exception()
            return
        if not return_exceptions:
            if fut.cancelled():
                exc = fut._make_cancelled_error()
                _discard_awaited_by(children, cur_task)
                outer.set_exception(exc)
                return
            else:
                exc = fut.exception()
                if exc is not None:
                    _discard_awaited_by(children, cur_task)
                    outer.set_exception(exc)
                    return
        if nfinished == nfuts:
            results = []
            for fut in children:
                if fut.cancelled():
                    res = CancelledError(
                        '' if fut._cancel_message is None else
                        fut._cancel_message)
                else:
                    res = fut.exception()
                    if res is None:
                        res = fut.result()
                results.append(res)
            if outer._cancel_requested:
                exc = fut._make_cancelled_error()
                outer.set_exception(exc)
            else:
                outer.set_result(results)
    arg_to_fut = {}
    children = []
    nfuts = 0
    nfinished = 0
    done_futs = []
    outer = None  # bpo-46672
    for arg in coros_or_futures:
        if arg not in arg_to_fut:
            fut = ensure_future(arg, loop=loop)
            if loop is None:
                loop = _get_loop(fut)
            if fut is not arg:
                fut._log_destroy_pending = False
            nfuts += 1
            arg_to_fut[arg] = fut
            if fut.done():
                done_futs.append(fut)
            else:
                if cur_task is not None:
                    future_add_to_awaited_by(fut, cur_task)
                fut.add_done_callback(_done_callback)
        else:
            fut = arg_to_fut[arg]
        children.append(fut)
    outer = _GatheringFuture(children, loop=loop)
    for fut in done_futs:
        _done_callback(fut)
    return outer
def shield(arg):
    inner = ensure_future(arg)
    if inner.done():
        return inner
    loop = _get_loop(inner)
    outer = loop.create_future()
    if loop is not None and (cur_task := current_task(loop)) is not None:
        future_add_to_awaited_by(inner, cur_task)
    else:
        cur_task = None
    def _clear_awaited_by_callback(inner):
        future_discard_from_awaited_by(inner, cur_task)
    def _inner_done_callback(inner):
        if outer.cancelled():
            return
        if inner.cancelled():
            outer.cancel()
        else:
            exc = inner.exception()
            if exc is not None:
                outer.set_exception(exc)
            else:
                outer.set_result(inner.result())
    def _outer_done_callback(outer):
        if not inner.done():
            inner.remove_done_callback(_inner_done_callback)
            if cur_task is not None:
                inner.remove_done_callback(_clear_awaited_by_callback)
                future_discard_from_awaited_by(inner, cur_task)
    if cur_task is not None:
        inner.add_done_callback(_clear_awaited_by_callback)
    inner.add_done_callback(_inner_done_callback)
    outer.add_done_callback(_outer_done_callback)
    return outer
def run_coroutine_threadsafe(coro, loop):
    import concurrent.futures
    if not iscoroutine(coro):
        raise TypeError('A coroutine object is required')
    future = concurrent.futures.Future()
    def callback():
        try:
            _chain_future(ensure_future(coro, loop=loop), future)
        except (SystemExit, KeyboardInterrupt):
            raise
        except BaseException as exc:
            if future.set_running_or_notify_cancel():
                future.set_exception(exc)
            raise
    loop.call_soon_threadsafe(callback)
    return future
def create_eager_task_factory(custom_task_constructor):
    def factory(loop, coro, *, eager_start=True, **kwargs):
        return custom_task_constructor(
            coro, loop=loop, eager_start=eager_start, **kwargs)
    return factory
eager_task_factory = create_eager_task_factory(Task)
_scheduled_tasks = set()
_eager_tasks = set()
_current_tasks = {}
def _register_task(task):
    _scheduled_tasks.add(task)
def _register_eager_task(task):
    _eager_tasks.add(task)
def _enter_task(loop, task):
    current_task = _current_tasks.get(loop)
    if current_task is not None:
        raise RuntimeError(f"Cannot enter into task {task!r} while another "
                           f"task {current_task!r} is being executed.")
    _current_tasks[loop] = task
def _leave_task(loop, task):
    current_task = _current_tasks.get(loop)
    if current_task is not task:
        raise RuntimeError(f"Leaving task {task!r} does not match "
                           f"the current task {current_task!r}.")
    del _current_tasks[loop]
def _swap_current_task(loop, task):
    prev_task = _current_tasks.get(loop)
    if task is None:
        del _current_tasks[loop]
    else:
        _current_tasks[loop] = task
    return prev_task
def _unregister_task(task):
    _scheduled_tasks.discard(task)
def _unregister_eager_task(task):
    _eager_tasks.discard(task)
_py_current_task = current_task
_py_register_task = _register_task
_py_register_eager_task = _register_eager_task
_py_unregister_task = _unregister_task
_py_unregister_eager_task = _unregister_eager_task
_py_enter_task = _enter_task
_py_leave_task = _leave_task
_py_swap_current_task = _swap_current_task
_py_all_tasks = all_tasks


class _LoopBoundMixin:
    __module__ = 'asyncio.mixins'
    _loop = None
    def _get_loop(self):
        loop = _get_running_loop()
        if self._loop is None:
            self._loop = loop
        if loop is not self._loop:
            raise RuntimeError(f'{self!r} is bound to a different event loop')
        return loop

class _ContextManagerMixin:
    async def __aenter__(self):
        await self.acquire()
        return None
    async def __aexit__(self, exc_type, exc, tb):
        self.release()
class Lock(_ContextManagerMixin, _LoopBoundMixin):
    __module__ = 'asyncio.locks'
    def __init__(self):
        self._waiters = None
        self._locked = False
    def __repr__(self):
        res = super().__repr__()
        extra = 'locked' if self._locked else 'unlocked'
        if self._waiters:
            extra = f'{extra}, waiters:{len(self._waiters)}'
        return f'<{res[1:-1]} [{extra}]>'
    def locked(self):
        return self._locked
    async def acquire(self):
        if (not self._locked and (self._waiters is None or
                all(w.cancelled() for w in self._waiters))):
            self._locked = True
            return True
        if self._waiters is None:
            self._waiters = collections.deque()
        fut = self._get_loop().create_future()
        self._waiters.append(fut)
        try:
            try:
                await fut
            finally:
                self._waiters.remove(fut)
        except CancelledError:
            if not self._locked:
                self._wake_up_first()
            raise
        self._locked = True
        return True
    def release(self):
        if self._locked:
            self._locked = False
            self._wake_up_first()
        else:
            raise RuntimeError('Lock is not acquired.')
    def _wake_up_first(self):
        if not self._waiters:
            return
        try:
            fut = next(iter(self._waiters))
        except StopIteration:
            return
        if not fut.done():
            fut.set_result(True)
class Event(_LoopBoundMixin):
    __module__ = 'asyncio.locks'
    def __init__(self):
        self._waiters = collections.deque()
        self._value = False
    def __repr__(self):
        res = super().__repr__()
        extra = 'set' if self._value else 'unset'
        if self._waiters:
            extra = f'{extra}, waiters:{len(self._waiters)}'
        return f'<{res[1:-1]} [{extra}]>'
    def is_set(self):
        return self._value
    def set(self):
        if not self._value:
            self._value = True
            for fut in self._waiters:
                if not fut.done():
                    fut.set_result(True)
    def clear(self):
        self._value = False
    async def wait(self):
        if self._value:
            return True
        fut = self._get_loop().create_future()
        self._waiters.append(fut)
        try:
            await fut
            return True
        finally:
            self._waiters.remove(fut)
class Condition(_ContextManagerMixin, _LoopBoundMixin):
    __module__ = 'asyncio.locks'
    def __init__(self, lock=None):
        if lock is None:
            lock = Lock()
        self._lock = lock
        self.locked = lock.locked
        self.acquire = lock.acquire
        self.release = lock.release
        self._waiters = collections.deque()
    def __repr__(self):
        res = super().__repr__()
        extra = 'locked' if self.locked() else 'unlocked'
        if self._waiters:
            extra = f'{extra}, waiters:{len(self._waiters)}'
        return f'<{res[1:-1]} [{extra}]>'
    async def wait(self):
        if not self.locked():
            raise RuntimeError('cannot wait on un-acquired lock')
        fut = self._get_loop().create_future()
        self.release()
        try:
            try:
                self._waiters.append(fut)
                try:
                    await fut
                    return True
                finally:
                    self._waiters.remove(fut)
            finally:
                err = None
                while True:
                    try:
                        await self.acquire()
                        break
                    except CancelledError as e:
                        err = e
                if err is not None:
                    try:
                        raise err  # Re-raise most recent exception instance.
                    finally:
                        err = None  # Break reference cycles.
        except BaseException:
            self._notify(1)
            raise
    async def wait_for(self, predicate):
        result = predicate()
        while not result:
            await self.wait()
            result = predicate()
        return result
    def notify(self, n=1):
        if not self.locked():
            raise RuntimeError('cannot notify on un-acquired lock')
        self._notify(n)
    def _notify(self, n):
        idx = 0
        for fut in self._waiters:
            if idx >= n:
                break
            if not fut.done():
                idx += 1
                fut.set_result(False)
    def notify_all(self):
        self.notify(len(self._waiters))
class Semaphore(_ContextManagerMixin, _LoopBoundMixin):
    __module__ = 'asyncio.locks'
    def __init__(self, value=1):
        if value < 0:
            raise ValueError("Semaphore initial value must be >= 0")
        self._waiters = None
        self._value = value
    def __repr__(self):
        res = super().__repr__()
        extra = 'locked' if self.locked() else f'unlocked, value:{self._value}'
        if self._waiters:
            extra = f'{extra}, waiters:{len(self._waiters)}'
        return f'<{res[1:-1]} [{extra}]>'
    def locked(self):
        return self._value == 0 or (
            any(not w.cancelled() for w in (self._waiters or ())))
    async def acquire(self):
        if not self.locked():
            self._value -= 1
            return True
        if self._waiters is None:
            self._waiters = collections.deque()
        fut = self._get_loop().create_future()
        self._waiters.append(fut)
        try:
            try:
                await fut
            finally:
                self._waiters.remove(fut)
        except CancelledError:
            if fut.done() and not fut.cancelled():
                self._value += 1
            raise
        finally:
            while self._value > 0:
                if not self._wake_up_next():
                    break  # There was no-one to wake up.
        return True
    def release(self):
        self._value += 1
        self._wake_up_next()
    def _wake_up_next(self):
        if not self._waiters:
            return False
        for fut in self._waiters:
            if not fut.done():
                self._value -= 1
                fut.set_result(True)
                return True
        return False
class BoundedSemaphore(Semaphore):
    __module__ = 'asyncio.locks'
    def __init__(self, value=1):
        self._bound_value = value
        super().__init__(value)
    def release(self):
        if self._value >= self._bound_value:
            raise ValueError('BoundedSemaphore released too many times')
        super().release()
class _BarrierState(enum.Enum):
    FILLING = 'filling'
    DRAINING = 'draining'
    RESETTING = 'resetting'
    BROKEN = 'broken'
class Barrier(_LoopBoundMixin):
    __module__ = 'asyncio.locks'
    def __init__(self, parties):
        if parties < 1:
            raise ValueError('parties must be >= 1')
        self._cond = Condition() # notify all tasks when state changes
        self._parties = parties
        self._state = _BarrierState.FILLING
        self._count = 0       # count tasks in Barrier
    def __repr__(self):
        res = super().__repr__()
        extra = f'{self._state.value}'
        if not self.broken:
            extra += f', waiters:{self.n_waiting}/{self.parties}'
        return f'<{res[1:-1]} [{extra}]>'
    async def __aenter__(self):
        return await self.wait()
    async def __aexit__(self, *args):
        pass
    async def wait(self):
        async with self._cond:
            await self._block() # Block while the barrier drains or resets.
            try:
                index = self._count
                self._count += 1
                if index + 1 == self._parties:
                    await self._release()
                else:
                    await self._wait()
                return index
            finally:
                self._count -= 1
                self._exit()
    async def _block(self):
        await self._cond.wait_for(
            lambda: self._state not in (
                _BarrierState.DRAINING, _BarrierState.RESETTING
            )
        )
        if self._state is _BarrierState.BROKEN:
            raise BrokenBarrierError("Barrier aborted")
    async def _release(self):
        self._state = _BarrierState.DRAINING
        self._cond.notify_all()
    async def _wait(self):
        await self._cond.wait_for(lambda: self._state is not _BarrierState.FILLING)
        if self._state in (_BarrierState.BROKEN, _BarrierState.RESETTING):
            raise BrokenBarrierError("Abort or reset of barrier")
    def _exit(self):
        if self._count == 0:
            if self._state in (_BarrierState.RESETTING, _BarrierState.DRAINING):
                self._state = _BarrierState.FILLING
            self._cond.notify_all()
    async def reset(self):
        async with self._cond:
            if self._count > 0:
                if self._state is not _BarrierState.RESETTING:
                    self._state = _BarrierState.RESETTING
            else:
                self._state = _BarrierState.FILLING
            self._cond.notify_all()
    async def abort(self):
        async with self._cond:
            self._state = _BarrierState.BROKEN
            self._cond.notify_all()
    @property
    def parties(self):
        return self._parties
    @property
    def n_waiting(self):
        if self._state is _BarrierState.FILLING:
            return self._count
        return 0
    @property
    def broken(self):
        return self._state is _BarrierState.BROKEN


class QueueEmpty(Exception):
    __module__ = 'asyncio.queues'
    pass
class QueueFull(Exception):
    __module__ = 'asyncio.queues'
    pass
class QueueShutDown(Exception):
    __module__ = 'asyncio.queues'
    pass
class Queue(_LoopBoundMixin):
    __module__ = 'asyncio.queues'
    def __init__(self, maxsize=0):
        self._maxsize = maxsize
        self._getters = collections.deque()
        self._putters = collections.deque()
        self._unfinished_tasks = 0
        self._finished = Event()
        self._finished.set()
        self._init(maxsize)
        self._is_shutdown = False
    def _init(self, maxsize):
        self._queue = collections.deque()
    def _get(self):
        return self._queue.popleft()
    def _put(self, item):
        self._queue.append(item)
    def _wakeup_next(self, waiters):
        while waiters:
            waiter = waiters.popleft()
            if not waiter.done():
                waiter.set_result(None)
                break
    def __repr__(self):
        return f'<{type(self).__name__} at {id(self):#x} {self._format()}>'
    def __str__(self):
        return f'<{type(self).__name__} {self._format()}>'
    def _format(self):
        result = f'maxsize={self._maxsize!r}'
        if getattr(self, '_queue', None):
            result += f' _queue={list(self._queue)!r}'
        if self._getters:
            result += f' _getters[{len(self._getters)}]'
        if self._putters:
            result += f' _putters[{len(self._putters)}]'
        if self._unfinished_tasks:
            result += f' tasks={self._unfinished_tasks}'
        if self._is_shutdown:
            result += ' shutdown'
        return result
    def qsize(self):
        return len(self._queue)
    @property
    def maxsize(self):
        return self._maxsize
    def empty(self):
        return not self._queue
    def full(self):
        if self._maxsize <= 0:
            return False
        else:
            return self.qsize() >= self._maxsize
    async def put(self, item):
        while self.full():
            if self._is_shutdown:
                raise QueueShutDown
            putter = self._get_loop().create_future()
            self._putters.append(putter)
            try:
                await putter
            except:
                putter.cancel()  # Just in case putter is not done yet.
                try:
                    self._putters.remove(putter)
                except ValueError:
                    pass
                if not self.full() and not putter.cancelled():
                    self._wakeup_next(self._putters)
                raise
        return self.put_nowait(item)
    def put_nowait(self, item):
        if self._is_shutdown:
            raise QueueShutDown
        if self.full():
            raise QueueFull
        self._put(item)
        self._unfinished_tasks += 1
        self._finished.clear()
        self._wakeup_next(self._getters)
    async def get(self):
        while self.empty():
            if self._is_shutdown and self.empty():
                raise QueueShutDown
            getter = self._get_loop().create_future()
            self._getters.append(getter)
            try:
                await getter
            except:
                getter.cancel()  # Just in case getter is not done yet.
                try:
                    self._getters.remove(getter)
                except ValueError:
                    pass
                if not self.empty() and not getter.cancelled():
                    self._wakeup_next(self._getters)
                raise
        return self.get_nowait()
    def get_nowait(self):
        if self.empty():
            if self._is_shutdown:
                raise QueueShutDown
            raise QueueEmpty
        item = self._get()
        self._wakeup_next(self._putters)
        return item
    def task_done(self):
        if self._unfinished_tasks <= 0:
            raise ValueError('task_done() called too many times')
        self._unfinished_tasks -= 1
        if self._unfinished_tasks == 0:
            self._finished.set()
    async def join(self):
        if self._unfinished_tasks > 0:
            await self._finished.wait()
    def shutdown(self, immediate=False):
        self._is_shutdown = True
        if immediate:
            while not self.empty():
                self._get()
                if self._unfinished_tasks > 0:
                    self._unfinished_tasks -= 1
            if self._unfinished_tasks == 0:
                self._finished.set()
        while self._getters:
            getter = self._getters.popleft()
            if not getter.done():
                getter.set_result(None)
        while self._putters:
            putter = self._putters.popleft()
            if not putter.done():
                putter.set_result(None)
class PriorityQueue(Queue):
    __module__ = 'asyncio.queues'
    def _init(self, maxsize):
        self._queue = []
    def _put(self, item, heappush=heapq.heappush):
        heappush(self._queue, item)
    def _get(self, heappop=heapq.heappop):
        return heappop(self._queue)
class LifoQueue(Queue):
    __module__ = 'asyncio.queues'
    def _init(self, maxsize):
        self._queue = []
    def _put(self, item):
        self._queue.append(item)
    def _get(self):
        return self._queue.pop()


class _TimeoutState(enum.Enum):
    CREATED = "created"
    ENTERED = "active"
    EXPIRING = "expiring"
    EXPIRED = "expired"
    EXITED = "finished"
class Timeout:
    __module__ = 'asyncio.timeouts'
    def __init__(self, when):
        self._state = _TimeoutState.CREATED
        self._timeout_handler=None
        self._task=None
        self._when = when
    def when(self):
        return self._when
    def reschedule(self, when):
        if self._state is not _TimeoutState.ENTERED:
            if self._state is _TimeoutState.CREATED:
                raise RuntimeError("Timeout has not been entered")
            raise RuntimeError(
                f"Cannot change state of {self._state.value} Timeout",
            )
        self._when = when
        if self._timeout_handler is not None:
            self._timeout_handler.cancel()
        if when is None:
            self._timeout_handler = None
        else:
            loop = get_running_loop()
            if when <= loop.time():
                self._timeout_handler = loop.call_soon(self._on_timeout)
            else:
                self._timeout_handler = loop.call_at(when, self._on_timeout)
    def expired(self):
        return self._state in (_TimeoutState.EXPIRING, _TimeoutState.EXPIRED)
    def __repr__(self):
        info = ['']
        if self._state is _TimeoutState.ENTERED:
            when = round(self._when, 3) if self._when is not None else None
            info.append(f"when={when}")
        info_str = ' '.join(info)
        return f"<Timeout [{self._state.value}]{info_str}>"
    async def __aenter__(self):
        if self._state is not _TimeoutState.CREATED:
            raise RuntimeError("Timeout has already been entered")
        task = current_task()
        if task is None:
            raise RuntimeError("Timeout should be used inside a task")
        self._state = _TimeoutState.ENTERED
        self._task = task
        self._cancelling = self._task.cancelling()
        self.reschedule(self._when)
        return self
    async def __aexit__(
        self,
        exc_type,
        exc_val,
        exc_tb,
    ):
        assert self._state in (_TimeoutState.ENTERED, _TimeoutState.EXPIRING)
        if self._timeout_handler is not None:
            self._timeout_handler.cancel()
            self._timeout_handler = None
        if self._state is _TimeoutState.EXPIRING:
            self._state = _TimeoutState.EXPIRED
            if self._task.uncancel() <= self._cancelling and exc_type is not None:
                if issubclass(exc_type, CancelledError):
                    raise TimeoutError from exc_val
                elif exc_val is not None:
                    self._insert_timeout_error(exc_val)
                    if isinstance(exc_val, ExceptionGroup):
                        for exc in exc_val.exceptions:
                            self._insert_timeout_error(exc)
        elif self._state is _TimeoutState.ENTERED:
            self._state = _TimeoutState.EXITED
        return None
    def _on_timeout(self):
        assert self._state is _TimeoutState.ENTERED
        self._task.cancel()
        self._state = _TimeoutState.EXPIRING
        self._timeout_handler = None
    @staticmethod
    def _insert_timeout_error(exc_val: BaseException):
        while exc_val.__context__ is not None:
            if isinstance(exc_val.__context__, CancelledError):
                te = TimeoutError()
                te.__context__ = te.__cause__ = exc_val.__context__
                exc_val.__context__ = te
                break
            exc_val = exc_val.__context__
def timeout(delay):
    loop = get_running_loop()
    return Timeout(loop.time() + delay if delay is not None else None)
def timeout_at(when):
    return Timeout(when)


class TaskGroup:
    __module__ = 'asyncio.taskgroups'
    def __init__(self):
        self._entered = False
        self._exiting = False
        self._aborting = False
        self._loop = None
        self._parent_task = None
        self._parent_cancel_requested = False
        self._tasks = set()
        self._errors = []
        self._base_error = None
        self._on_completed_fut = None
    def __repr__(self):
        info = ['']
        if self._tasks:
            info.append(f'tasks={len(self._tasks)}')
        if self._errors:
            info.append(f'errors={len(self._errors)}')
        if self._aborting:
            info.append('cancelling')
        elif self._entered:
            info.append('entered')
        info_str = ' '.join(info)
        return f'<TaskGroup{info_str}>'
    async def __aenter__(self):
        if self._entered:
            raise RuntimeError(
                f"TaskGroup {self!r} has already been entered")
        if self._loop is None:
            self._loop = get_running_loop()
        self._parent_task = current_task(self._loop)
        if self._parent_task is None:
            raise RuntimeError(
                f'TaskGroup {self!r} cannot determine the parent task')
        self._entered = True
        return self
    async def __aexit__(self, et, exc, tb):
        tb = None
        try:
            return await self._aexit(et, exc)
        finally:
            self._parent_task = None
            self._errors = None
            self._base_error = None
            exc = None
    async def _aexit(self, et, exc):
        self._exiting = True
        if (exc is not None and
                self._is_base_error(exc) and
                self._base_error is None):
            self._base_error = exc
        if et is not None and issubclass(et, CancelledError):
            propagate_cancellation_error = exc
        else:
            propagate_cancellation_error = None
        if et is not None:
            if not self._aborting:
                self._abort()
        while self._tasks:
            if self._on_completed_fut is None:
                self._on_completed_fut = self._loop.create_future()
            try:
                await self._on_completed_fut
            except CancelledError as ex:
                if not self._aborting:
                    propagate_cancellation_error = ex
                    self._abort()
            self._on_completed_fut = None
        assert not self._tasks
        if self._base_error is not None:
            try:
                raise self._base_error
            finally:
                exc = None
        if self._parent_cancel_requested:
            if self._parent_task.uncancel() == 0:
                propagate_cancellation_error = None
        try:
            if propagate_cancellation_error is not None and not self._errors:
                try:
                    raise propagate_cancellation_error
                finally:
                    exc = None
        finally:
            propagate_cancellation_error = None
        if et is not None and not issubclass(et, CancelledError):
            self._errors.append(exc)
        if self._errors:
            if self._parent_task.cancelling():
                self._parent_task.uncancel()
                self._parent_task.cancel()
            try:
                raise BaseExceptionGroup(
                    'unhandled errors in a TaskGroup',
                    self._errors,
                ) from None
            finally:
                exc = None
    def create_task(self, coro, **kwargs):
        if not self._entered:
            coro.close()
            raise RuntimeError(f"TaskGroup {self!r} has not been entered")
        if self._exiting and not self._tasks:
            coro.close()
            raise RuntimeError(f"TaskGroup {self!r} is finished")
        if self._aborting:
            coro.close()
            raise RuntimeError(f"TaskGroup {self!r} is shutting down")
        task = self._loop.create_task(coro, **kwargs)
        future_add_to_awaited_by(task, self._parent_task)
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)
        try:
            return task
        finally:
            del task
    def _is_base_error(self, exc: BaseException) -> bool:
        assert isinstance(exc, BaseException)
        return isinstance(exc, (SystemExit, KeyboardInterrupt))
    def _abort(self):
        self._aborting = True
        for t in self._tasks:
            if not t.done():
                t.cancel()
    def _on_task_done(self, task):
        self._tasks.discard(task)
        future_discard_from_awaited_by(task, self._parent_task)
        if self._on_completed_fut is not None and not self._tasks:
            if not self._on_completed_fut.done():
                self._on_completed_fut.set_result(True)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is None:
            return
        self._errors.append(exc)
        if self._is_base_error(exc) and self._base_error is None:
            self._base_error = exc
        if self._parent_task.done():
            self._loop.call_exception_handler({
                'message': f'Task {task!r} has errored out but its parent '
                           f'task {self._parent_task} is already completed',
                'exception': exc,
                'task': task,
            })
            return
        if not self._aborting and not self._parent_cancel_requested:
            self._abort()
            self._parent_cancel_requested = True
            self._parent_task.cancel()


class _RunnerState(enum.Enum):
    CREATED = "created"
    INITIALIZED = "initialized"
    CLOSED = "closed"
class Runner:
    __module__ = 'asyncio.runners'
    def __init__(self, *, debug=None, loop_factory=None):
        self._state = _RunnerState.CREATED
        self._debug = debug
        self._loop_factory = loop_factory
        self._loop = None
        self._context = None
        self._interrupt_count = 0
        self._set_event_loop = False
    def __enter__(self):
        self._lazy_init()
        return self
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
    def close(self):
        if self._state is not _RunnerState.INITIALIZED:
            return
        try:
            loop = self._loop
            _cancel_all_tasks(loop)
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.run_until_complete(
                loop.shutdown_default_executor(300))
        finally:
            if self._set_event_loop:
                set_event_loop(None)
            loop.close()
            self._loop = None
            self._state = _RunnerState.CLOSED
    def get_loop(self):
        self._lazy_init()
        return self._loop
    def run(self, coro, *, context=None):
        if _get_running_loop() is not None:
            raise RuntimeError(
                "Runner.run() cannot be called from a running event loop")
        self._lazy_init()
        if not iscoroutine(coro):
            if _core.isawaitable(coro):
                async def _wrap_awaitable(awaitable):
                    return await awaitable
                coro = _wrap_awaitable(coro)
            else:
                raise TypeError('An asyncio.Future, a coroutine or an '
                                'awaitable is required')
        if context is None:
            context = self._context
        task = self._loop.create_task(coro, context=context)
        self._interrupt_count = 0
        try:
            return self._loop.run_until_complete(task)
        except CancelledError:
            if self._interrupt_count > 0:
                uncancel = getattr(task, "uncancel", None)
                if uncancel is not None and uncancel() == 0:
                    raise KeyboardInterrupt()
            raise  # CancelledError
    def _lazy_init(self):
        if self._state is _RunnerState.CLOSED:
            raise RuntimeError("Runner is closed")
        if self._state is _RunnerState.INITIALIZED:
            return
        if self._loop_factory is None:
            self._loop = new_event_loop()
            if not self._set_event_loop:
                set_event_loop(self._loop)
                self._set_event_loop = True
        else:
            self._loop = self._loop_factory()
        if self._debug is not None:
            self._loop.set_debug(self._debug)
        self._context = None
        self._state = _RunnerState.INITIALIZED
def run(main, *, debug=None, loop_factory=None):
    if _get_running_loop() is not None:
        raise RuntimeError(
            "asyncio.run() cannot be called from a running event loop")
    with Runner(debug=debug, loop_factory=loop_factory) as runner:
        return runner.run(main)
def _cancel_all_tasks(loop):
    to_cancel = all_tasks(loop)
    if not to_cancel:
        return
    for task in to_cancel:
        task.cancel()
    loop.run_until_complete(gather(*to_cancel, return_exceptions=True))
    for task in to_cancel:
        if task.cancelled():
            continue
        if task.exception() is not None:
            loop.call_exception_handler({
                'message': 'unhandled exception during asyncio.run() shutdown',
                'exception': task.exception(),
                'task': task,
            })



async def to_thread(func, /, *args, **kwargs):
    loop = get_running_loop()
    func_call = functools.partial(func, *args, **kwargs)
    return await loop.run_in_executor(None, func_call)

_timeout = timeout

`;

registerSourceModule('asyncio', SOURCE, asyncioNatives);
