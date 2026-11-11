// `asyncio`, transcribed from CPython's Lib/asyncio onto an event loop without I/O whose clock is the run's virtual one,
// so that tasks run in the order CPython's loop runs them: ready callbacks first in, first out, then timers by time.
import { registerSharedAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';
import { asyncioNatives } from './asyncioNatives';

const SOURCE = String.raw`
import collections
import contextvars
import enum
import functools
import heapq
import itertools
import math
import types
import warnings

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
        if context is None:
            context = contextvars.copy_context()
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
            self._context.run(self._callback, *self._args)
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


class _AbstractEventLoopPolicy:
    """Abstract policy for accessing the event loop."""

    def get_event_loop(self):
        """Get the event loop for the current context.

        Returns an event loop object implementing the AbstractEventLoop interface,
        or raises an exception in case no event loop has been set for the
        current context and the current policy does not specify to create one.

        It should never return None."""
        raise NotImplementedError

    def set_event_loop(self, loop):
        """Set the event loop for the current context to loop."""
        raise NotImplementedError

    def new_event_loop(self):
        """Create and return a new event loop object according to this
        policy's rules. If there's need to set this loop as the event loop for
        the current context, set_event_loop must be called explicitly."""
        raise NotImplementedError

class _BaseDefaultEventLoopPolicy(_AbstractEventLoopPolicy):
    """Default policy implementation for accessing the event loop.

    In this policy, each thread has its own event loop.  However, we
    only automatically create an event loop by default for the main
    thread; other threads by default have no event loop.

    Other policies may have different rules (e.g. a single global
    event loop, or automatically creating an event loop per thread, or
    using some other notion of context to which an event loop is
    associated).
    """

    _loop_factory = None

    # Each thread's loop, kept by thread ident: importing threading for its local would start the thread
    # scheduler, which slows every loop of a program.
    class _Local:
        def __init__(self):
            self._loops = {}

        @property
        def _loop(self):
            return self._loops.get(_core.get_ident())

        @_loop.setter
        def _loop(self, loop):
            self._loops[_core.get_ident()] = loop

    def __init__(self):
        self._local = self._Local()

    def get_event_loop(self):
        """Get the event loop for the current context.

        Returns an instance of EventLoop or raises an exception.
        """
        if self._local._loop is None:
            raise RuntimeError('There is no current event loop in thread %r.'
                               % _core.thread_name())

        return self._local._loop

    def set_event_loop(self, loop):
        """Set the event loop."""
        if loop is not None and not isinstance(loop, AbstractEventLoop):
            raise TypeError(f"loop must be an instance of AbstractEventLoop or None, not '{type(loop).__name__}'")
        self._local._loop = loop

    def new_event_loop(self):
        """Create a new event loop.

        You must call set_event_loop() to make this the current event
        loop.
        """
        return self._loop_factory()

_BaseDefaultEventLoopPolicy._Local.__qualname__ = '_BaseDefaultEventLoopPolicy._Local'
for _cls in (_AbstractEventLoopPolicy, _BaseDefaultEventLoopPolicy, _BaseDefaultEventLoopPolicy._Local):
    _cls.__module__ = 'asyncio.events'


class _UnixDefaultEventLoopPolicy(_BaseDefaultEventLoopPolicy):
    """UNIX event loop policy"""
    __module__ = 'asyncio.unix_events'


_DefaultEventLoopPolicy = _UnixDefaultEventLoopPolicy
_event_loop_policy = None


def _init_event_loop_policy():
    global _event_loop_policy
    if _event_loop_policy is None:
        _event_loop_policy = _DefaultEventLoopPolicy()


def _get_event_loop_policy():
    """Get the current event loop policy."""
    if _event_loop_policy is None:
        _init_event_loop_policy()
    return _event_loop_policy

def get_event_loop_policy():
    warnings._deprecated('asyncio.get_event_loop_policy', remove=(3, 16))
    return _get_event_loop_policy()

def _set_event_loop_policy(policy):
    """Set the current event loop policy.

    If policy is None, the default policy is restored."""
    global _event_loop_policy
    if policy is not None and not isinstance(policy, _AbstractEventLoopPolicy):
        raise TypeError(f"policy must be an instance of AbstractEventLoopPolicy or None, not '{type(policy).__name__}'")
    _event_loop_policy = policy

def set_event_loop_policy(policy):
    warnings._deprecated('asyncio.set_event_loop_policy', remove=(3,16))
    _set_event_loop_policy(policy)

def get_event_loop():
    current_loop = _get_running_loop()
    if current_loop is not None:
        return current_loop
    return _get_event_loop_policy().get_event_loop()


def set_event_loop(loop):
    _get_event_loop_policy().set_event_loop(loop)


def new_event_loop():
    return _get_event_loop_policy().new_event_loop()


def __getattr__(name: str):
    match name:
        case "AbstractEventLoopPolicy":
            warnings._deprecated(f"asyncio.{name}", remove=(3, 16))
            return _AbstractEventLoopPolicy
        case "DefaultEventLoopPolicy":
            warnings._deprecated(f"asyncio.{name}", remove=(3, 16))
            return _DefaultEventLoopPolicy

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _run_until_complete_cb(fut):
    if not fut.cancelled():
        exc = fut.exception()
        if isinstance(exc, (SystemExit, KeyboardInterrupt)):
            return
    _get_loop(fut).stop()


# CPython's asyncio.events.AbstractEventLoop, with its defaults' socket and subprocess constants as numbers.
class AbstractEventLoop:
    """Abstract event loop."""

    __module__ = 'asyncio.events'

    # Running and stopping the event loop.

    def run_forever(self):
        """Run the event loop until stop() is called."""
        raise NotImplementedError

    def run_until_complete(self, future):
        """Run the event loop until a Future is done.

        Return the Future's result, or raise its exception.
        """
        raise NotImplementedError

    def stop(self):
        """Stop the event loop as soon as reasonable.

        Exactly how soon that is may depend on the implementation, but
        no more I/O callbacks should be scheduled.
        """
        raise NotImplementedError

    def is_running(self):
        """Return whether the event loop is currently running."""
        raise NotImplementedError

    def is_closed(self):
        """Returns True if the event loop was closed."""
        raise NotImplementedError

    def close(self):
        """Close the loop.

        The loop should not be running.

        This is idempotent and irreversible.

        No other methods should be called after this one.
        """
        raise NotImplementedError

    async def shutdown_asyncgens(self):
        """Shutdown all active asynchronous generators."""
        raise NotImplementedError

    async def shutdown_default_executor(self):
        """Schedule the shutdown of the default executor."""
        raise NotImplementedError

    # Methods scheduling callbacks.  All these return Handles.

    def _timer_handle_cancelled(self, handle):
        """Notification that a TimerHandle has been cancelled."""
        raise NotImplementedError

    def call_soon(self, callback, *args, context=None):
        return self.call_later(0, callback, *args, context=context)

    def call_later(self, delay, callback, *args, context=None):
        raise NotImplementedError

    def call_at(self, when, callback, *args, context=None):
        raise NotImplementedError

    def time(self):
        raise NotImplementedError

    def create_future(self):
        raise NotImplementedError

    # Method scheduling a coroutine object: create a task.

    def create_task(self, coro, **kwargs):
        raise NotImplementedError

    # Methods for interacting with threads.

    def call_soon_threadsafe(self, callback, *args, context=None):
        raise NotImplementedError

    def run_in_executor(self, executor, func, *args):
        raise NotImplementedError

    def set_default_executor(self, executor):
        raise NotImplementedError

    # Network I/O methods returning Futures.

    async def getaddrinfo(self, host, port, *,
                          family=0, type=0, proto=0, flags=0):
        raise NotImplementedError

    async def getnameinfo(self, sockaddr, flags=0):
        raise NotImplementedError

    async def create_connection(
            self, protocol_factory, host=None, port=None,
            *, ssl=None, family=0, proto=0,
            flags=0, sock=None, local_addr=None,
            server_hostname=None,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None,
            happy_eyeballs_delay=None, interleave=None):
        raise NotImplementedError

    async def create_server(
            self, protocol_factory, host=None, port=None,
            *, family=0,
            flags=1, sock=None, backlog=100,
            ssl=None, reuse_address=None, reuse_port=None,
            keep_alive=None,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None,
            start_serving=True):
        """A coroutine which creates a TCP server bound to host and port.

        The return value is a Server object which can be used to stop
        the service.

        If host is an empty string or None all interfaces are assumed
        and a list of multiple sockets will be returned (most likely
        one for IPv4 and another one for IPv6). The host parameter can also
        be a sequence (e.g. list) of hosts to bind to.

        family can be set to either AF_INET or AF_INET6 to force the
        socket to use IPv4 or IPv6. If not set it will be determined
        from host (defaults to AF_UNSPEC).

        flags is a bitmask for getaddrinfo().

        sock can optionally be specified in order to use a preexisting
        socket object.

        backlog is the maximum number of queued connections passed to
        listen() (defaults to 100).

        ssl can be set to an SSLContext to enable SSL over the
        accepted connections.

        reuse_address tells the kernel to reuse a local socket in
        TIME_WAIT state, without waiting for its natural timeout to
        expire. If not specified will automatically be set to True on
        UNIX.

        reuse_port tells the kernel to allow this endpoint to be bound to
        the same port as other existing endpoints are bound to, so long as
        they all set this flag when being created. This option is not
        supported on Windows.

        keep_alive set to True keeps connections active by enabling the
        periodic transmission of messages.

        ssl_handshake_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL handshake before aborting the
        connection. Default is 60s.

        ssl_shutdown_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL shutdown procedure
        before aborting the connection. Default is 30s.

        start_serving set to True (default) causes the created server
        to start accepting connections immediately.  When set to False,
        the user should await Server.start_serving() or
        Server.serve_forever() to make the server to start accepting
        connections.
        """
        raise NotImplementedError

    async def sendfile(self, transport, file, offset=0, count=None,
                       *, fallback=True):
        """Send a file through a transport.

        Return an amount of sent bytes.
        """
        raise NotImplementedError

    async def start_tls(self, transport, protocol, sslcontext, *,
                        server_side=False,
                        server_hostname=None,
                        ssl_handshake_timeout=None,
                        ssl_shutdown_timeout=None):
        """Upgrade a transport to TLS.

        Return a new transport that *protocol* should start using
        immediately.
        """
        raise NotImplementedError

    async def create_unix_connection(
            self, protocol_factory, path=None, *,
            ssl=None, sock=None,
            server_hostname=None,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None):
        raise NotImplementedError

    async def create_unix_server(
            self, protocol_factory, path=None, *,
            sock=None, backlog=100, ssl=None,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None,
            start_serving=True):
        """A coroutine which creates a UNIX Domain Socket server.

        The return value is a Server object, which can be used to stop
        the service.

        path is a str, representing a file system path to bind the
        server socket to.

        sock can optionally be specified in order to use a preexisting
        socket object.

        backlog is the maximum number of queued connections passed to
        listen() (defaults to 100).

        ssl can be set to an SSLContext to enable SSL over the
        accepted connections.

        ssl_handshake_timeout is the time in seconds that an SSL server
        will wait for the SSL handshake to complete (defaults to 60s).

        ssl_shutdown_timeout is the time in seconds that an SSL server
        will wait for the SSL shutdown to finish (defaults to 30s).

        start_serving set to True (default) causes the created server
        to start accepting connections immediately.  When set to False,
        the user should await Server.start_serving() or
        Server.serve_forever() to make the server to start accepting
        connections.
        """
        raise NotImplementedError

    async def connect_accepted_socket(
            self, protocol_factory, sock,
            *, ssl=None,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None):
        """Handle an accepted connection.

        This is used by servers that accept connections outside of
        asyncio, but use asyncio to handle connections.

        This method is a coroutine.  When completed, the coroutine
        returns a (transport, protocol) pair.
        """
        raise NotImplementedError

    async def create_datagram_endpoint(self, protocol_factory,
                                       local_addr=None, remote_addr=None, *,
                                       family=0, proto=0, flags=0,
                                       reuse_address=None, reuse_port=None,
                                       allow_broadcast=None, sock=None):
        """A coroutine which creates a datagram endpoint.

        This method will try to establish the endpoint in the background.
        When successful, the coroutine returns a (transport, protocol) pair.

        protocol_factory must be a callable returning a protocol instance.

        socket family AF_INET, socket.AF_INET6 or socket.AF_UNIX depending
        on host (or family if specified), socket type SOCK_DGRAM.

        reuse_address tells the kernel to reuse a local socket in
        TIME_WAIT state, without waiting for its natural timeout to
        expire. If not specified it will automatically be set to True on
        UNIX.

        reuse_port tells the kernel to allow this endpoint to be bound to
        the same port as other existing endpoints are bound to, so long as
        they all set this flag when being created. This option is not
        supported on Windows and some UNIX's. If the
        :py:data:${'`'}~socket.SO_REUSEPORT${'`'} constant is not defined then this
        capability is unsupported.

        allow_broadcast tells the kernel to allow this endpoint to send
        messages to the broadcast address.

        sock can optionally be specified in order to use a preexisting
        socket object.
        """
        raise NotImplementedError

    # Pipes and subprocesses.

    async def connect_read_pipe(self, protocol_factory, pipe):
        """Register read pipe in event loop. Set the pipe to non-blocking mode.

        protocol_factory should instantiate object with Protocol interface.
        pipe is a file-like object.
        Return pair (transport, protocol), where transport supports the
        ReadTransport interface."""
        # The reason to accept file-like object instead of just file descriptor
        # is: we need to own pipe and close it at transport finishing
        # Can got complicated errors if pass f.fileno(),
        # close fd in pipe transport then close f and vice versa.
        raise NotImplementedError

    async def connect_write_pipe(self, protocol_factory, pipe):
        """Register write pipe in event loop.

        protocol_factory should instantiate object with BaseProtocol
        interface.
        Pipe is file-like object already switched to nonblocking.
        Return pair (transport, protocol), where transport support
        WriteTransport interface."""
        # The reason to accept file-like object instead of just file descriptor
        # is: we need to own pipe and close it at transport finishing
        # Can got complicated errors if pass f.fileno(),
        # close fd in pipe transport then close f and vice versa.
        raise NotImplementedError

    async def subprocess_shell(self, protocol_factory, cmd, *,
                               stdin=-1,
                               stdout=-1,
                               stderr=-1,
                               **kwargs):
        raise NotImplementedError

    async def subprocess_exec(self, protocol_factory, *args,
                              stdin=-1,
                              stdout=-1,
                              stderr=-1,
                              **kwargs):
        raise NotImplementedError

    # Ready-based callback registration methods.
    # The add_*() methods return None.
    # The remove_*() methods return True if something was removed,
    # False if there was nothing to delete.

    def add_reader(self, fd, callback, *args):
        raise NotImplementedError

    def remove_reader(self, fd):
        raise NotImplementedError

    def add_writer(self, fd, callback, *args):
        raise NotImplementedError

    def remove_writer(self, fd):
        raise NotImplementedError

    # Completion based I/O methods returning Futures.

    async def sock_recv(self, sock, nbytes):
        raise NotImplementedError

    async def sock_recv_into(self, sock, buf):
        raise NotImplementedError

    async def sock_recvfrom(self, sock, bufsize):
        raise NotImplementedError

    async def sock_recvfrom_into(self, sock, buf, nbytes=0):
        raise NotImplementedError

    async def sock_sendall(self, sock, data):
        raise NotImplementedError

    async def sock_sendto(self, sock, data, address):
        raise NotImplementedError

    async def sock_connect(self, sock, address):
        raise NotImplementedError

    async def sock_accept(self, sock):
        raise NotImplementedError

    async def sock_sendfile(self, sock, file, offset=0, count=None,
                            *, fallback=None):
        raise NotImplementedError

    # Signal handling.

    def add_signal_handler(self, sig, callback, *args):
        raise NotImplementedError

    def remove_signal_handler(self, sig):
        raise NotImplementedError

    # Task factory.

    def set_task_factory(self, factory):
        raise NotImplementedError

    def get_task_factory(self):
        raise NotImplementedError

    # Error handlers.

    def get_exception_handler(self):
        raise NotImplementedError

    def set_exception_handler(self, handler):
        raise NotImplementedError

    def default_exception_handler(self, context):
        raise NotImplementedError

    def call_exception_handler(self, context):
        raise NotImplementedError

    # Debug flag management.

    def get_debug(self):
        raise NotImplementedError

    def set_debug(self, enabled):
        raise NotImplementedError


class BaseEventLoop(AbstractEventLoop):
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
            if context is None:
                context = contextvars.copy_context()
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
        if context is None:
            self._context = contextvars.copy_context()
        else:
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
                self._context.run(self.__step_run_and_handle_result, None)
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



class BaseProtocol:
    """Common base class for protocol interfaces.

    Usually user implements protocols that derived from BaseProtocol
    like Protocol or ProcessProtocol.

    The only case when BaseProtocol should be implemented directly is
    write-only transport like write pipe
    """

    __slots__ = ()

    def connection_made(self, transport):
        """Called when a connection is made.

        The argument is the transport representing the pipe connection.
        To receive data, wait for data_received() calls.
        When the connection is closed, connection_lost() is called.
        """

    def connection_lost(self, exc):
        """Called when the connection is lost or closed.

        The argument is an exception object or None (the latter
        meaning a regular EOF is received or the connection was
        aborted or closed).
        """

    def pause_writing(self):
        """Called when the transport's buffer goes over the high-water mark.

        Pause and resume calls are paired -- pause_writing() is called
        once when the buffer goes strictly over the high-water mark
        (even if subsequent writes increases the buffer size even
        more), and eventually resume_writing() is called once when the
        buffer size reaches the low-water mark.

        Note that if the buffer size equals the high-water mark,
        pause_writing() is not called -- it must go strictly over.
        Conversely, resume_writing() is called when the buffer size is
        equal or lower than the low-water mark.  These end conditions
        are important to ensure that things go as expected when either
        mark is zero.

        NOTE: This is the only Protocol callback that is not called
        through EventLoop.call_soon() -- if it were, it would have no
        effect when it's most needed (when the app keeps writing
        without yielding until pause_writing() is called).
        """

    def resume_writing(self):
        """Called when the transport's buffer drains below the low-water mark.

        See pause_writing() for details.
        """


class Protocol(BaseProtocol):
    """Interface for stream protocol.

    The user should implement this interface.  They can inherit from
    this class but don't need to.  The implementations here do
    nothing (they don't raise exceptions).

    When the user wants to requests a transport, they pass a protocol
    factory to a utility function (e.g., EventLoop.create_connection()).

    When the connection is made successfully, connection_made() is
    called with a suitable transport object.  Then data_received()
    will be called 0 or more times with data (bytes) received from the
    transport; finally, connection_lost() will be called exactly once
    with either an exception object or None as an argument.

    State machine of calls:

      start -> CM [-> DR*] [-> ER?] -> CL -> end

    * CM: connection_made()
    * DR: data_received()
    * ER: eof_received()
    * CL: connection_lost()
    """

    __slots__ = ()

    def data_received(self, data):
        """Called when some data is received.

        The argument is a bytes object.
        """

    def eof_received(self):
        """Called when the other end calls write_eof() or equivalent.

        If this returns a false value (including None), the transport
        will close itself.  If it returns a true value, closing the
        transport is up to the protocol.
        """


class BufferedProtocol(BaseProtocol):
    """Interface for stream protocol with manual buffer control.

    Event methods, such as ${'`'}create_server${'`'} and ${'`'}create_connection${'`'},
    accept factories that return protocols that implement this interface.

    The idea of BufferedProtocol is that it allows to manually allocate
    and control the receive buffer.  Event loops can then use the buffer
    provided by the protocol to avoid unnecessary data copies.  This
    can result in noticeable performance improvement for protocols that
    receive big amounts of data.  Sophisticated protocols can allocate
    the buffer only once at creation time.

    State machine of calls:

      start -> CM [-> GB [-> BU?]]* [-> ER?] -> CL -> end

    * CM: connection_made()
    * GB: get_buffer()
    * BU: buffer_updated()
    * ER: eof_received()
    * CL: connection_lost()
    """

    __slots__ = ()

    def get_buffer(self, sizehint):
        """Called to allocate a new receive buffer.

        *sizehint* is a recommended minimal size for the returned
        buffer.  When set to -1, the buffer size can be arbitrary.

        Must return an object that implements the
        :ref:${'`'}buffer protocol <bufferobjects>${'`'}.
        It is an error to return a zero-sized buffer.
        """

    def buffer_updated(self, nbytes):
        """Called when the buffer was updated with the received data.

        *nbytes* is the total number of bytes that were written to
        the buffer.
        """

    def eof_received(self):
        """Called when the other end calls write_eof() or equivalent.

        If this returns a false value (including None), the transport
        will close itself.  If it returns a true value, closing the
        transport is up to the protocol.
        """


class DatagramProtocol(BaseProtocol):
    """Interface for datagram protocol."""

    __slots__ = ()

    def datagram_received(self, data, addr):
        """Called when some datagram is received."""

    def error_received(self, exc):
        """Called when a send or receive operation raises an OSError.

        (Other than BlockingIOError or InterruptedError.)
        """


class SubprocessProtocol(BaseProtocol):
    """Interface for protocol for subprocess calls."""

    __slots__ = ()

    def pipe_data_received(self, fd, data):
        """Called when the subprocess writes data into stdout/stderr pipe.

        fd is int file descriptor.
        data is bytes object.
        """

    def pipe_connection_lost(self, fd, exc):
        """Called when a file descriptor associated with the child process is
        closed.

        fd is the int file descriptor that was closed.
        """

    def process_exited(self):
        """Called when subprocess has exited."""


for _cls in (BaseProtocol, Protocol, BufferedProtocol, DatagramProtocol, SubprocessProtocol):
    _cls.__module__ = 'asyncio.protocols'


class BaseTransport:
    """Base class for transports."""

    __slots__ = ('_extra',)

    def __init__(self, extra=None):
        if extra is None:
            extra = {}
        self._extra = extra

    def get_extra_info(self, name, default=None):
        """Get optional transport information."""
        return self._extra.get(name, default)

    def is_closing(self):
        """Return True if the transport is closing or closed."""
        raise NotImplementedError

    def close(self):
        """Close the transport.

        Buffered data will be flushed asynchronously.  No more data
        will be received.  After all buffered data is flushed, the
        protocol's connection_lost() method will (eventually) be
        called with None as its argument.
        """
        raise NotImplementedError

    def set_protocol(self, protocol):
        """Set a new protocol."""
        raise NotImplementedError

    def get_protocol(self):
        """Return the current protocol."""
        raise NotImplementedError


class ReadTransport(BaseTransport):
    """Interface for read-only transports."""

    __slots__ = ()

    def is_reading(self):
        """Return True if the transport is receiving."""
        raise NotImplementedError

    def pause_reading(self):
        """Pause the receiving end.

        No data will be passed to the protocol's data_received()
        method until resume_reading() is called.
        """
        raise NotImplementedError

    def resume_reading(self):
        """Resume the receiving end.

        Data received will once again be passed to the protocol's
        data_received() method.
        """
        raise NotImplementedError


class WriteTransport(BaseTransport):
    """Interface for write-only transports."""

    __slots__ = ()

    def set_write_buffer_limits(self, high=None, low=None):
        """Set the high- and low-water limits for write flow control.

        These two values control when to call the protocol's
        pause_writing() and resume_writing() methods.  If specified,
        the low-water limit must be less than or equal to the
        high-water limit.  Neither value can be negative.

        The defaults are implementation-specific.  If only the
        high-water limit is given, the low-water limit defaults to an
        implementation-specific value less than or equal to the
        high-water limit.  Setting high to zero forces low to zero as
        well, and causes pause_writing() to be called whenever the
        buffer becomes non-empty.  Setting low to zero causes
        resume_writing() to be called only once the buffer is empty.
        Use of zero for either limit is generally sub-optimal as it
        reduces opportunities for doing I/O and computation
        concurrently.
        """
        raise NotImplementedError

    def get_write_buffer_size(self):
        """Return the current size of the write buffer."""
        raise NotImplementedError

    def get_write_buffer_limits(self):
        """Get the high and low watermarks for write flow control.
        Return a tuple (low, high) where low and high are
        positive number of bytes."""
        raise NotImplementedError

    def write(self, data):
        """Write some data bytes to the transport.

        This does not block; it buffers the data and arranges for it
        to be sent out asynchronously.
        """
        raise NotImplementedError

    def writelines(self, list_of_data):
        """Write a list (or any iterable) of data bytes to the transport.

        The default implementation concatenates the arguments and
        calls write() on the result.
        """
        data = b''.join(list_of_data)
        self.write(data)

    def write_eof(self):
        """Close the write end after flushing buffered data.

        (This is like typing ^D into a UNIX program reading from stdin.)

        Data may still be received.
        """
        raise NotImplementedError

    def can_write_eof(self):
        """Return True if this transport supports write_eof(), False if not."""
        raise NotImplementedError

    def abort(self):
        """Close the transport immediately.

        Buffered data will be lost.  No more data will be received.
        The protocol's connection_lost() method will (eventually) be
        called with None as its argument.
        """
        raise NotImplementedError


class Transport(ReadTransport, WriteTransport):
    """Interface representing a bidirectional transport.

    There may be several implementations, but typically, the user does
    not implement new transports; rather, the platform provides some
    useful transports that are implemented using the platform's best
    practices.

    The user never instantiates a transport directly; they call a
    utility function, passing it a protocol factory and other
    information necessary to create the transport and protocol.  (E.g.
    EventLoop.create_connection() or EventLoop.create_server().)

    The utility function will asynchronously create a transport and a
    protocol and hook them up by calling the protocol's
    connection_made() method, passing it the transport.

    The implementation here raises NotImplemented for every method
    except writelines(), which calls write() in a loop.
    """

    __slots__ = ()


class DatagramTransport(BaseTransport):
    """Interface for datagram (UDP) transports."""

    __slots__ = ()

    def sendto(self, data, addr=None):
        """Send data to the transport.

        This does not block; it buffers the data and arranges for it
        to be sent out asynchronously.
        addr is target socket address.
        If addr is None use target address pointed on transport creation.
        If data is an empty bytes object a zero-length datagram will be
        sent.
        """
        raise NotImplementedError

    def abort(self):
        """Close the transport immediately.

        Buffered data will be lost.  No more data will be received.
        The protocol's connection_lost() method will (eventually) be
        called with None as its argument.
        """
        raise NotImplementedError


class SubprocessTransport(BaseTransport):

    __slots__ = ()

    def get_pid(self):
        """Get subprocess id."""
        raise NotImplementedError

    def get_returncode(self):
        """Get subprocess returncode.

        See also
        http://docs.python.org/3/library/subprocess#subprocess.Popen.returncode
        """
        raise NotImplementedError

    def get_pipe_transport(self, fd):
        """Get transport for pipe with number fd."""
        raise NotImplementedError

    def send_signal(self, signal):
        """Send signal to subprocess.

        See also:
        docs.python.org/3/library/subprocess#subprocess.Popen.send_signal
        """
        raise NotImplementedError

    def terminate(self):
        """Stop the subprocess.

        Alias for close() method.

        On Posix OSs the method sends SIGTERM to the subprocess.
        On Windows the Win32 API function TerminateProcess()
         is called to stop the subprocess.

        See also:
        http://docs.python.org/3/library/subprocess#subprocess.Popen.terminate
        """
        raise NotImplementedError

    def kill(self):
        """Kill the subprocess.

        On Posix OSs the function sends SIGKILL to the subprocess.
        On Windows kill() is an alias for terminate().

        See also:
        http://docs.python.org/3/library/subprocess#subprocess.Popen.kill
        """
        raise NotImplementedError


for _cls in (BaseTransport, ReadTransport, WriteTransport, Transport, DatagramTransport, SubprocessTransport):
    _cls.__module__ = 'asyncio.transports'


class AbstractServer:
    """Abstract server returned by create_server()."""

    def close(self):
        """Stop serving.  This leaves existing connections open."""
        raise NotImplementedError

    def close_clients(self):
        """Close all active connections."""
        raise NotImplementedError

    def abort_clients(self):
        """Close all active connections immediately."""
        raise NotImplementedError

    def get_loop(self):
        """Get the event loop the Server object is attached to."""
        raise NotImplementedError

    def is_serving(self):
        """Return True if the server is accepting connections."""
        raise NotImplementedError

    async def start_serving(self):
        """Start accepting connections.

        This method is idempotent, so it can be called when
        the server is already being serving.
        """
        raise NotImplementedError

    async def serve_forever(self):
        """Start accepting connections until the coroutine is cancelled.

        The server is closed when the coroutine is cancelled.
        """
        raise NotImplementedError

    async def wait_closed(self):
        """Coroutine to wait until service is closed."""
        raise NotImplementedError

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.close()
        await self.wait_closed()

AbstractServer.__module__ = 'asyncio.events'


del _cls

_UnixDefaultEventLoopPolicy._loop_factory = _UnixSelectorEventLoop

__all__ = ('BaseEventLoop', 'Server', 'iscoroutinefunction', 'iscoroutine', 'AbstractEventLoop', 'AbstractServer', 'Handle', 'TimerHandle', 'get_event_loop_policy', 'set_event_loop_policy', 'get_event_loop', 'set_event_loop', 'new_event_loop', '_set_running_loop', 'get_running_loop', '_get_running_loop', 'BrokenBarrierError', 'CancelledError', 'InvalidStateError', 'TimeoutError', 'IncompleteReadError', 'LimitOverrunError', 'SendfileNotAvailableError', 'Future', 'wrap_future', 'isfuture', 'future_add_to_awaited_by', 'future_discard_from_awaited_by', 'capture_call_graph', 'format_call_graph', 'print_call_graph', 'FrameCallGraphEntry', 'FutureCallGraph', 'Lock', 'Event', 'Condition', 'Semaphore', 'BoundedSemaphore', 'Barrier', 'BaseProtocol', 'Protocol', 'DatagramProtocol', 'SubprocessProtocol', 'BufferedProtocol', 'Runner', 'run', 'Queue', 'PriorityQueue', 'LifoQueue', 'QueueFull', 'QueueEmpty', 'QueueShutDown', 'StreamReader', 'StreamWriter', 'StreamReaderProtocol', 'open_connection', 'start_server', 'open_unix_connection', 'start_unix_server', 'create_subprocess_exec', 'create_subprocess_shell', 'Task', 'create_task', 'FIRST_COMPLETED', 'FIRST_EXCEPTION', 'ALL_COMPLETED', 'wait', 'wait_for', 'as_completed', 'sleep', 'gather', 'shield', 'ensure_future', 'run_coroutine_threadsafe', 'current_task', 'all_tasks', 'create_eager_task_factory', 'eager_task_factory', '_register_task', '_unregister_task', '_enter_task', '_leave_task', 'TaskGroup', 'to_thread', 'Timeout', 'timeout', 'timeout_at', 'BaseTransport', 'ReadTransport', 'WriteTransport', 'Transport', 'DatagramTransport', 'SubprocessTransport', 'SelectorEventLoop', 'EventLoop')

_timeout = timeout

`;

const NETWORK = 'ネットワーク';
const PROCESS = '外部プロセス';
const GRAPH = '非同期の呼び出しのグラフ（コルーチンが待っているものとフレームから作る）';

// CPython's `asyncio.graph`, whose data classes asyncio shares; building them when asyncio loads would slow every
// program that uses asyncio.
const GRAPH_SOURCE = String.raw`
"""Introspection utils for tasks call graphs."""

import dataclasses
import io
import sys
import types

__all__ = (
    'capture_call_graph',
    'format_call_graph',
    'print_call_graph',
    'FrameCallGraphEntry',
    'FutureCallGraph',
)


@dataclasses.dataclass(frozen=True, slots=True)
class FrameCallGraphEntry:
    frame: types.FrameType


@dataclasses.dataclass(frozen=True, slots=True)
class FutureCallGraph:
    future: futures.Future
    call_stack: tuple["FrameCallGraphEntry", ...]
    awaited_by: tuple["FutureCallGraph", ...]
`;

const GRAPH_FUNCTIONS = {
  capture_call_graph: `${GRAPH}（asyncio.capture_call_graph()）`,
  format_call_graph: `${GRAPH}（asyncio.format_call_graph()）`,
  print_call_graph: `${GRAPH}（asyncio.print_call_graph()）`,
};

registerSourceModule('asyncio.graph', GRAPH_SOURCE, undefined, { unsupported: GRAPH_FUNCTIONS });
registerSharedAttributes('asyncio', {
  FrameCallGraphEntry: 'asyncio.graph:FrameCallGraphEntry',
  FutureCallGraph: 'asyncio.graph:FutureCallGraph',
});

registerSourceModule('asyncio', SOURCE, asyncioNatives, {
  unsupported: {
    Server: `${NETWORK}（asyncio.Server）`,
    StreamReader: `${NETWORK}のストリーム（asyncio.StreamReader）`,
    StreamReaderProtocol: `${NETWORK}のストリーム（asyncio.StreamReaderProtocol）`,
    StreamWriter: `${NETWORK}のストリーム（asyncio.StreamWriter）`,
    open_connection: `${NETWORK}（asyncio.open_connection()）`,
    open_unix_connection: `${NETWORK}（asyncio.open_unix_connection()）`,
    start_server: `${NETWORK}（asyncio.start_server()）`,
    start_unix_server: `${NETWORK}（asyncio.start_unix_server()）`,
    create_subprocess_exec: `${PROCESS}（asyncio.create_subprocess_exec()）`,
    create_subprocess_shell: `${PROCESS}（asyncio.create_subprocess_shell()）`,
    ...GRAPH_FUNCTIONS,
  },
});
