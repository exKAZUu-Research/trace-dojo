// `threading`, transcribed from CPython's Lib/threading.py onto the locks and threads of `_thread`, so that conditions,
// semaphores, events, and barriers wake threads in CPython's order.
import { registerSourceModule } from '../sourceModules';

const SOURCE = String.raw`
import _thread
import sys as _sys
from collections import deque as _deque
from itertools import count as _count

_start_thread = _thread._start_thread
_allocate_lock = _thread.allocate_lock
_time = _thread._monotonic
get_ident = _thread.get_ident
stack_size = _thread.stack_size
get_native_id = _thread.get_native_id
ThreadError = _thread.error
TIMEOUT_MAX = _thread.TIMEOUT_MAX
Lock = _thread.lock
_CRLock = _thread.RLock
_LockType = _thread.LockType
_daemon_threads_allowed = _thread.daemon_threads_allowed
_is_main_interpreter = _thread._is_main_interpreter
_HAVE_THREAD_NATIVE_ID = True
_SHUTTING_DOWN = False
from weakref import WeakSet

__all__ = ['get_ident', 'active_count', 'Condition', 'current_thread',
           'enumerate', 'main_thread', 'TIMEOUT_MAX',
           'Event', 'Lock', 'RLock', 'Semaphore', 'BoundedSemaphore', 'Thread',
           'Barrier', 'BrokenBarrierError', 'Timer', 'ThreadError',
           'setprofile', 'settrace', 'local', 'stack_size',
           'excepthook', 'ExceptHookArgs', 'gettrace', 'getprofile',
           'setprofile_all_threads','settrace_all_threads']
__all__ += ['get_native_id']

# A program here can install no trace or profile function, so none is ever set.
_profile_hook = None
_trace_hook = None


def getprofile():
    return _profile_hook


def gettrace():
    return _trace_hook


def RLock(*args, **kwargs):
    return _CRLock(*args, **kwargs)


class Condition:
    def __init__(self, lock=None):
        if lock is None:
            lock = RLock()
        self._lock = lock
        self.acquire = lock.acquire
        self.release = lock.release
        try:
            self._release_save = lock._release_save
        except AttributeError:
            pass
        try:
            self._acquire_restore = lock._acquire_restore
        except AttributeError:
            pass
        try:
            self._is_owned = lock._is_owned
        except AttributeError:
            pass
        self._waiters = _deque()

    def __enter__(self):
        return self._lock.__enter__()

    def __exit__(self, *args):
        return self._lock.__exit__(*args)

    def __repr__(self):
        return "<Condition(%s, %d)>" % (self._lock, len(self._waiters))

    def _release_save(self):
        self._lock.release()

    def _acquire_restore(self, x):
        self._lock.acquire()

    def _is_owned(self):
        if self._lock.acquire(False):
            self._lock.release()
            return False
        else:
            return True

    def wait(self, timeout=None):
        if not self._is_owned():
            raise RuntimeError("cannot wait on un-acquired lock")
        waiter = _allocate_lock()
        waiter.acquire()
        self._waiters.append(waiter)
        saved_state = self._release_save()
        gotit = False
        try:
            if timeout is None:
                waiter.acquire()
                gotit = True
            else:
                if timeout > 0:
                    gotit = waiter.acquire(True, timeout)
                else:
                    gotit = waiter.acquire(False)
            return gotit
        finally:
            self._acquire_restore(saved_state)
            if not gotit:
                try:
                    self._waiters.remove(waiter)
                except ValueError:
                    pass

    def wait_for(self, predicate, timeout=None):
        endtime = None
        waittime = timeout
        result = predicate()
        while not result:
            if waittime is not None:
                if endtime is None:
                    endtime = _time() + waittime
                else:
                    waittime = endtime - _time()
                    if waittime <= 0:
                        break
            self.wait(waittime)
            result = predicate()
        return result

    def notify(self, n=1):
        if not self._is_owned():
            raise RuntimeError("cannot notify on un-acquired lock")
        waiters = self._waiters
        while waiters and n > 0:
            waiter = waiters[0]
            try:
                waiter.release()
            except RuntimeError:
                pass
            else:
                n -= 1
            try:
                waiters.remove(waiter)
            except ValueError:
                pass

    def notify_all(self):
        self.notify(len(self._waiters))

    def notifyAll(self):
        self.notify_all()


class Semaphore:
    def __init__(self, value=1):
        if value < 0:
            raise ValueError("semaphore initial value must be >= 0")
        self._cond = Condition(Lock())
        self._value = value

    def __repr__(self):
        cls = self.__class__
        return (f"<{cls.__module__}.{cls.__qualname__} at {id(self):#x}:"
                f" value={self._value}>")

    def acquire(self, blocking=True, timeout=None):
        if not blocking and timeout is not None:
            raise ValueError("can't specify timeout for non-blocking acquire")
        rc = False
        endtime = None
        with self._cond:
            while self._value == 0:
                if not blocking:
                    break
                if timeout is not None:
                    if endtime is None:
                        endtime = _time() + timeout
                    else:
                        timeout = endtime - _time()
                        if timeout <= 0:
                            break
                self._cond.wait(timeout)
            else:
                self._value -= 1
                rc = True
        return rc

    __enter__ = acquire

    def release(self, n=1):
        if n < 1:
            raise ValueError('n must be one or more')
        with self._cond:
            self._value += n
            self._cond.notify(n)

    def __exit__(self, t, v, tb):
        self.release()


class BoundedSemaphore(Semaphore):
    def __init__(self, value=1):
        super().__init__(value)
        self._initial_value = value

    def __repr__(self):
        cls = self.__class__
        return (f"<{cls.__module__}.{cls.__qualname__} at {id(self):#x}:"
                f" value={self._value}/{self._initial_value}>")

    def release(self, n=1):
        if n < 1:
            raise ValueError('n must be one or more')
        with self._cond:
            if self._value + n > self._initial_value:
                raise ValueError("Semaphore released too many times")
            self._value += n
            self._cond.notify(n)


class Event:
    def __init__(self):
        self._cond = Condition(Lock())
        self._flag = False

    def __repr__(self):
        cls = self.__class__
        status = 'set' if self._flag else 'unset'
        return f"<{cls.__module__}.{cls.__qualname__} at {id(self):#x}: {status}>"

    def is_set(self):
        return self._flag

    def isSet(self):
        return self.is_set()

    def set(self):
        with self._cond:
            self._flag = True
            self._cond.notify_all()

    def clear(self):
        with self._cond:
            self._flag = False

    def wait(self, timeout=None):
        with self._cond:
            signaled = self._flag
            if not signaled:
                signaled = self._cond.wait(timeout)
            return signaled


class Barrier:
    def __init__(self, parties, action=None, timeout=None):
        if parties < 1:
            raise ValueError("parties must be >= 1")
        self._cond = Condition(Lock())
        self._action = action
        self._timeout = timeout
        self._parties = parties
        self._state = 0
        self._count = 0

    def __repr__(self):
        cls = self.__class__
        if self.broken:
            return f"<{cls.__module__}.{cls.__qualname__} at {id(self):#x}: broken>"
        return (f"<{cls.__module__}.{cls.__qualname__} at {id(self):#x}:"
                f" waiters={self.n_waiting}/{self.parties}>")

    def wait(self, timeout=None):
        if timeout is None:
            timeout = self._timeout
        with self._cond:
            self._enter()
            index = self._count
            self._count += 1
            try:
                if index + 1 == self._parties:
                    self._release()
                else:
                    self._wait(timeout)
                return index
            finally:
                self._count -= 1
                self._exit()

    def _enter(self):
        while self._state in (-1, 1):
            self._cond.wait()
        if self._state < 0:
            raise BrokenBarrierError

    def _release(self):
        try:
            if self._action:
                self._action()
            self._state = 1
            self._cond.notify_all()
        except:
            self._break()
            raise

    def _wait(self, timeout):
        if not self._cond.wait_for(lambda : self._state != 0, timeout):
            self._break()
            raise BrokenBarrierError
        if self._state < 0:
            raise BrokenBarrierError

    def _exit(self):
        if self._count == 0:
            if self._state in (-1, 1):
                self._state = 0
                self._cond.notify_all()

    def reset(self):
        with self._cond:
            if self._count > 0:
                if self._state == 0:
                    self._state = -1
                elif self._state == -2:
                    self._state = -1
            else:
                self._state = 0
            self._cond.notify_all()

    def abort(self):
        with self._cond:
            self._break()

    def _break(self):
        self._state = -2
        self._cond.notify_all()

    @property
    def parties(self):
        return self._parties

    @property
    def n_waiting(self):
        if self._state == 0:
            return self._count
        return 0

    @property
    def broken(self):
        return self._state == -2


class BrokenBarrierError(RuntimeError):
    pass


_counter = _count(1).__next__
def _newname(name_template):
    return name_template % _counter()

_active = {}
_limbo = {}


class Thread:
    _initialized = False

    def __init__(self, group=None, target=None, name=None,
                 args=(), kwargs=None, *, daemon=None, context=None):
        assert group is None, "group argument must be None for now"
        if kwargs is None:
            kwargs = {}
        if name:
            name = str(name)
        else:
            name = _newname("Thread-%d")
            if target is not None:
                try:
                    target_name = target.__name__
                    name += f" ({target_name})"
                except AttributeError:
                    pass
        self._target = target
        self._name = name
        self._args = args
        self._kwargs = kwargs
        if daemon is not None:
            self._daemonic = daemon
        else:
            self._daemonic = current_thread().daemon
        self._ident = None
        self._native_id = None
        self._handle = None
        self._started = Event()
        self._initialized = True

    def __repr__(self):
        assert self._initialized, "Thread.__init__() was not called"
        status = "initial"
        if self._started.is_set():
            status = "started"
        if self._handle is not None and self._handle.is_done():
            status = "stopped"
        if self._daemonic:
            status += " daemon"
        if self._ident is not None:
            status += " %s" % self._ident
        return "<%s(%s, %s)>" % (self.__class__.__name__, self._name, status)

    def start(self):
        if not self._initialized:
            raise RuntimeError("thread.__init__() not called")
        if self._started.is_set():
            raise RuntimeError("threads can only be started once")
        _limbo[self] = self
        self._handle = _start_thread(self._bootstrap, self._daemonic)
        self._started.wait()

    def run(self):
        try:
            if self._target is not None:
                self._target(*self._args, **self._kwargs)
        finally:
            del self._target, self._args, self._kwargs

    def _bootstrap(self):
        try:
            self._ident = get_ident()
            self._native_id = get_native_id()
            self._started.set()
            _active[self._ident] = self
            del _limbo[self]
            try:
                self.run()
            except BaseException as exc:
                _invoke_excepthook(self, exc)
        finally:
            del _active[get_ident()]

    def join(self, timeout=None):
        if not self._initialized:
            raise RuntimeError("Thread.__init__() not called")
        if not self._started.is_set():
            raise RuntimeError("cannot join thread before it is started")
        if self is current_thread():
            raise RuntimeError("cannot join current thread")
        if timeout is not None:
            timeout = max(timeout, 0)
        if self._handle is not None:
            self._handle.join(timeout)

    @property
    def name(self):
        assert self._initialized, "Thread.__init__() not called"
        return self._name

    @name.setter
    def name(self, name):
        assert self._initialized, "Thread.__init__() not called"
        self._name = str(name)

    @property
    def ident(self):
        assert self._initialized, "Thread.__init__() not called"
        return self._ident

    @property
    def native_id(self):
        assert self._initialized, "Thread.__init__() not called"
        return self._native_id

    def is_alive(self):
        assert self._initialized, "Thread.__init__() not called"
        return self._started.is_set() and not (self._handle is not None and self._handle.is_done())

    @property
    def daemon(self):
        assert self._initialized, "Thread.__init__() not called"
        return self._daemonic

    @daemon.setter
    def daemon(self, daemonic):
        if not self._initialized:
            raise RuntimeError("Thread.__init__() not called")
        if self._started.is_set():
            raise RuntimeError("cannot set daemon status of active thread")
        self._daemonic = daemonic

    def isDaemon(self):
        return self.daemon

    def setDaemon(self, daemonic):
        self.daemon = daemonic

    def getName(self):
        return self.name

    def setName(self, name):
        self.name = name


class _ExceptHookArgs(tuple):
    n_fields = 4
    n_sequence_fields = 4
    n_unnamed_fields = 0

    def __new__(cls, args):
        return tuple.__new__(cls, args)

    @property
    def exc_type(self):
        return self[0]

    @property
    def exc_value(self):
        return self[1]

    @property
    def exc_traceback(self):
        return self[2]

    @property
    def thread(self):
        return self[3]

    def __repr__(self):
        return (f"_thread._ExceptHookArgs(exc_type={self[0]!r}, exc_value={self[1]!r}, "
                f"exc_traceback={self[2]!r}, thread={self[3]!r})")

ExceptHookArgs = _ExceptHookArgs


def excepthook(args, /):
    if args.exc_type == SystemExit:
        return
    name = args.thread.name if args.thread is not None else get_ident()
    print(f"Exception in thread {name}:", file=_sys.stderr)
    print(f"{args.exc_type.__name__}: {args.exc_value}", file=_sys.stderr)

__excepthook__ = excepthook


def _invoke_excepthook(thread, exc):
    args = ExceptHookArgs([type(exc), exc, exc.__traceback__, thread])
    hook = excepthook
    try:
        hook(args)
    except Exception as hook_exc:
        print("Exception in threading.excepthook:", file=_sys.stderr)


class Timer(Thread):
    def __init__(self, interval, function, args=None, kwargs=None):
        Thread.__init__(self)
        self.interval = interval
        self.function = function
        self.args = args if args is not None else []
        self.kwargs = kwargs if kwargs is not None else {}
        self.finished = Event()

    def cancel(self):
        self.finished.set()

    def run(self):
        self.finished.wait(self.interval)
        if not self.finished.is_set():
            self.function(*self.args, **self.kwargs)
        self.finished.set()


class _MainThread(Thread):
    def __init__(self):
        Thread.__init__(self, name="MainThread", daemon=False)
        self._started.set()
        self._ident = get_ident()
        self._native_id = get_native_id()
        _active[self._ident] = self

    def is_alive(self):
        return True

    def __repr__(self):
        return "<_MainThread(MainThread, started %s)>" % self._ident


class _DummyThread(Thread):
    def __init__(self):
        Thread.__init__(self, name=_newname("Dummy-%d"), daemon=True)
        self._started.set()
        self._ident = get_ident()
        self._native_id = get_native_id()
        _active[self._ident] = self

    def is_alive(self):
        return True

    def join(self, timeout=None):
        raise RuntimeError("cannot join a dummy thread")

    def __repr__(self):
        return "<_DummyThread(%s, started daemon %s)>" % (self._name, self._ident)


def current_thread():
    try:
        return _active[get_ident()]
    except KeyError:
        return _DummyThread()

def currentThread():
    return current_thread()


def active_count():
    return len(_active) + len(_limbo)

def activeCount():
    return active_count()


def enumerate():
    return list(_active.values()) + list(_limbo.values())


def main_thread():
    return _main_thread


class local:
    __module__ = '_thread'

    def __new__(cls, /, *args, **kw):
        if (args or kw) and (cls.__init__ is object.__init__):
            raise TypeError("Initialization arguments are not supported")
        self = object.__new__(cls)
        _local_arguments[id(self)] = (args, kw)
        return self

    def __getattribute__(self, name):
        # The running thread's values stand in for the instance dict, between the class's data descriptors and the
        # rest of its attributes.
        values = _local_values(self)
        if name == '__dict__':
            return values
        if name in values and not _is_data_descriptor(type(self), name):
            return values[name]
        return object.__getattribute__(self, name)

    def __setattr__(self, name, value):
        _local_values(self)[name] = value

    def __delattr__(self, name):
        values = _local_values(self)
        if name not in values:
            raise AttributeError(f"'{_local_name(self)}' object has no attribute '{name}'")
        del values[name]

local.__name__ = '_local'
local.__qualname__ = '_local'

_local_arguments = {}
_local_dicts = {}

def _is_data_descriptor(cls, name):
    for klass in cls.__mro__:
        if name in klass.__dict__:
            kind = type(klass.__dict__[name])
            return hasattr(kind, '__set__') or hasattr(kind, '__delete__')
    return False

def _local_name(self):
    cls = type(self)
    return '_thread._local' if cls is local else cls.__qualname__

def _local_values(self):
    key = (id(self), get_ident())
    values = _local_dicts.get(key)
    if values is None:
        values = _local_dicts[key] = {}
        if any(owner == id(self) for owner, _ in _local_dicts if (owner, _) != key):
            args, kw = _local_arguments[id(self)]
            init = type(self).__init__
            if init is not object.__init__:
                init(self, *args, **kw)
    return values


_main_thread = _MainThread()

_threading_atexits = []

def _register_atexit(func, *arg, **kwargs):
    _threading_atexits.append(lambda: func(*arg, **kwargs))

def _shutdown():
    for atexit_call in reversed(_threading_atexits):
        atexit_call()

`;

registerSourceModule('threading', SOURCE, undefined, {
  blocks: true,
  unsupported: {
    setprofile: 'threading.setprofile()',
    setprofile_all_threads: 'threading.setprofile_all_threads()',
    settrace: 'threading.settrace()',
    settrace_all_threads: 'threading.settrace_all_threads()',
  },
});
