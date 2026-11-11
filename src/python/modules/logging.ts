import { builtin } from '../define';
import { registerUnsupportedAttributes } from '../modules';
import { toIndex } from '../numbers';
import { registerSourceModule } from '../sourceModules';
import { newTuple, None } from '../types';
import type { PyValue } from '../values';

// The core of CPython's `logging` package: loggers, handlers writing to streams, formatters, filters, and the
// module-level functions, without threads, files, or configuration files. A record's file name, module, path, process,
// and thread belong to the machine running the program, so formatting one of them stops the program, as does writing
// a traceback anywhere but to stderr, since tracebacks name the program's file.
const SOURCE = String.raw`
import sys
import threading
import time
import weakref

__all__ = ['BASIC_FORMAT', 'CRITICAL', 'DEBUG', 'ERROR',
           'FATAL', 'Filter', 'Formatter', 'Handler', 'INFO',
           'LogRecord', 'Logger', 'LoggerAdapter', 'NOTSET', 'NullHandler',
           'StreamHandler', 'WARN', 'WARNING', 'addLevelName', 'basicConfig',
           'critical', 'debug', 'disable', 'error',
           'exception', 'fatal', 'getLevelName', 'getLogger', 'getLoggerClass',
           'info', 'log', 'makeLogRecord', 'setLoggerClass', 'shutdown',
           'warn', 'warning', 'getLogRecordFactory', 'setLogRecordFactory',
           'lastResort', 'raiseExceptions', 'getLevelNamesMapping',
           'getHandlerByName', 'getHandlerNames']

raiseExceptions = True
logThreads = True
logMultiprocessing = True
logProcesses = True
logAsyncioTasks = True

_startTime = time.time_ns()

CRITICAL = 50
FATAL = CRITICAL
ERROR = 40
WARNING = 30
WARN = WARNING
INFO = 20
DEBUG = 10
NOTSET = 0

_levelToName = {
    CRITICAL: 'CRITICAL',
    ERROR: 'ERROR',
    WARNING: 'WARNING',
    INFO: 'INFO',
    DEBUG: 'DEBUG',
    NOTSET: 'NOTSET',
}
_nameToLevel = {
    'CRITICAL': CRITICAL,
    'FATAL': FATAL,
    'ERROR': ERROR,
    'WARN': WARNING,
    'WARNING': WARNING,
    'INFO': INFO,
    'DEBUG': DEBUG,
    'NOTSET': NOTSET,
}


def getLevelNamesMapping():
    return _nameToLevel.copy()


def getLevelName(level):
    result = _levelToName.get(level)
    if result is not None:
        return result
    result = _nameToLevel.get(level)
    if result is not None:
        return result
    return "Level %s" % level


def addLevelName(level, levelName):
    _levelToName[level] = levelName
    _nameToLevel[levelName] = level


def _checkLevel(level):
    if isinstance(level, int):
        rv = level
    elif str(level) == level:
        if level not in _nameToLevel:
            raise ValueError("Unknown level: %r" % level)
        rv = _nameToLevel[level]
    else:
        raise TypeError("Level not an integer or a valid string: %r"
                        % (level,))
    return rv


class _MachineValue:
    """A record attribute that belongs to the machine running the program."""

    def __init__(self, name):
        self.name = name

    def __str__(self):
        _unsupported('ログの ' + self.name + '（実行する環境ごとに異なる値）')

    def __repr__(self):
        return str(self)

    def __format__(self, spec):
        return str(self)

    def __int__(self):
        return str(self)

    def __index__(self):
        return str(self)


class LogRecord(object):
    def __init__(self, name, level, pathname, lineno,
                 msg, args, exc_info, func=None, sinfo=None, **kwargs):
        ct = time.time_ns()
        self.name = name
        self.msg = msg
        if (args and len(args) == 1 and isinstance(args[0], dict)
            and args[0]):
            args = args[0]
        self.args = args
        self.levelname = getLevelName(level)
        self.levelno = level
        self.pathname = pathname
        self.filename = _MachineValue('filename')
        self.module = _MachineValue('module')
        self.exc_info = exc_info
        self.exc_text = None
        self.stack_info = sinfo
        self.lineno = lineno
        self.funcName = func
        self.created = ct / 1000000000
        self.msecs = (ct % 1_000_000_000) // 1_000_000 + 0.0
        self.relativeCreated = (ct - _startTime) / 1000000
        self.thread = _MachineValue('thread')
        self.threadName = 'MainThread'
        self.processName = 'MainProcess'
        self.process = _MachineValue('process')
        self.taskName = None

    def __repr__(self):
        return '<LogRecord: %s, %s, %s, %s, "%s">'%(self.name, self.levelno,
            self.pathname, self.lineno, self.msg)

    def getMessage(self):
        msg = str(self.msg)
        if self.args:
            msg = msg % self.args
        return msg


_logRecordFactory = LogRecord


def setLogRecordFactory(factory):
    global _logRecordFactory
    _logRecordFactory = factory


def getLogRecordFactory():
    return _logRecordFactory


def makeLogRecord(dict):
    rv = _logRecordFactory(None, None, "", 0, "", (), None, None)
    for key, value in dict.items():
        setattr(rv, key, value)
    return rv


class PercentStyle(object):

    default_format = '%(message)s'
    asctime_format = '%(asctime)s'
    asctime_search = '%(asctime)'

    def __init__(self, fmt, *, defaults=None):
        self._fmt = fmt or self.default_format
        self._defaults = defaults

    def usesTime(self):
        return self._fmt.find(self.asctime_search) >= 0

    def validate(self):
        if not _percent_fields(self._fmt):
            raise ValueError("Invalid format '%s' for '%s' style" % (self._fmt, self.default_format[0]))

    def _format(self, record):
        defaults = self._defaults
        if defaults:
            values = defaults | vars(record)
        else:
            values = vars(record)
        return self._fmt % values

    def format(self, record):
        try:
            return self._format(record)
        except KeyError as e:
            raise ValueError('Formatting field not found in record: %s' % e)


class StrFormatStyle(PercentStyle):
    default_format = '{message}'
    asctime_format = '{asctime}'
    asctime_search = '{asctime'

    def _format(self, record):
        defaults = self._defaults
        if defaults:
            values = defaults | vars(record)
        else:
            values = vars(record)
        return self._fmt.format(**values)

    def validate(self):
        if '{' not in self._fmt:
            raise ValueError('invalid format: no fields')


class StringTemplateStyle(PercentStyle):
    default_format = '$' '{message}'
    asctime_format = '$' '{asctime}'
    asctime_search = '$' '{asctime}'

    def __init__(self, *args, **kwargs):
        from string import Template
        super().__init__(*args, **kwargs)
        self._tpl = Template(self._fmt)

    def usesTime(self):
        fmt = self._fmt
        return fmt.find('$asctime') >= 0 or fmt.find(self.asctime_search) >= 0

    def validate(self):
        if '$' not in self._fmt:
            raise ValueError('invalid format: no fields')

    def _format(self, record):
        defaults = self._defaults
        if defaults:
            values = defaults | vars(record)
        else:
            values = vars(record)
        return self._tpl.substitute(**values)


BASIC_FORMAT = "%(levelname)s:%(name)s:%(message)s"

_STYLES = {
    '%': (PercentStyle, BASIC_FORMAT),
    '{': (StrFormatStyle, '{levelname}:{name}:{message}'),
    '$': (StringTemplateStyle, '$' '{levelname}:$' '{name}:$' '{message}'),
}


class Formatter(object):
    converter = time.localtime

    def __init__(self, fmt=None, datefmt=None, style='%', validate=True, *,
                 defaults=None):
        if style not in _STYLES:
            raise ValueError('Style must be one of: %s' % ','.join(
                             _STYLES.keys()))
        self._style = _STYLES[style][0](fmt, defaults=defaults)
        if validate:
            self._style.validate()

        self._fmt = self._style._fmt
        self.datefmt = datefmt

    default_time_format = '%Y-%m-%d %H:%M:%S'
    default_msec_format = '%s,%03d'

    def formatTime(self, record, datefmt=None):
        ct = self.converter(record.created)
        if datefmt:
            s = time.strftime(datefmt, ct)
        else:
            s = time.strftime(self.default_time_format, ct)
            if self.default_msec_format:
                s = self.default_msec_format % (s, record.msecs)
        return s

    def formatException(self, ei):
        lines = ['Traceback (most recent call last):\n']
        value = ei[1]
        if value is not None:
            import traceback
            lines.extend(traceback.format_exception_only(value))
        s = ''.join(lines)
        if s[-1:] == "\n":
            s = s[:-1]
        return s

    def usesTime(self):
        return self._style.usesTime()

    def formatMessage(self, record):
        return self._style.format(record)

    def formatStack(self, stack_info):
        return stack_info

    def format(self, record):
        record.message = record.getMessage()
        if self.usesTime():
            record.asctime = self.formatTime(record, self.datefmt)
        s = self.formatMessage(record)
        if record.exc_info:
            if not record.exc_text:
                record.exc_text = self.formatException(record.exc_info)
        if record.exc_text:
            if s[-1:] != "\n":
                s = s + "\n"
            s = s + record.exc_text
        if record.stack_info:
            if s[-1:] != "\n":
                s = s + "\n"
            s = s + self.formatStack(record.stack_info)
        return s


_defaultFormatter = Formatter()


class BufferingFormatter(object):
    """
    A formatter suitable for formatting a number of records.
    """
    def __init__(self, linefmt=None):
        """
        Optionally specify a formatter which will be used to format each
        individual record.
        """
        if linefmt:
            self.linefmt = linefmt
        else:
            self.linefmt = _defaultFormatter

    def formatHeader(self, records):
        """
        Return the header string for the specified records.
        """
        return ""

    def formatFooter(self, records):
        """
        Return the footer string for the specified records.
        """
        return ""

    def format(self, records):
        """
        Format the specified records and return the result as a string.
        """
        rv = ""
        if len(records) > 0:
            rv = rv + self.formatHeader(records)
            for record in records:
                rv = rv + self.linefmt.format(record)
            rv = rv + self.formatFooter(records)
        return rv


class Filter(object):
    def __init__(self, name=''):
        self.name = name
        self.nlen = len(name)

    def filter(self, record):
        if self.nlen == 0:
            return True
        elif self.name == record.name:
            return True
        elif record.name.find(self.name, 0, self.nlen) != 0:
            return False
        return (record.name[self.nlen] == ".")


class Filterer(object):
    def __init__(self):
        self.filters = []

    def addFilter(self, filter):
        if not (filter in self.filters):
            self.filters.append(filter)

    def removeFilter(self, filter):
        if filter in self.filters:
            self.filters.remove(filter)

    def filter(self, record):
        for f in self.filters:
            if hasattr(f, 'filter'):
                result = f.filter(record)
            else:
                result = f(record)
            if not result:
                return False
            if isinstance(result, LogRecord):
                record = result
        return record


_lock = threading.RLock()


def _prepareFork():
    _lock.acquire()


def _afterFork():
    _lock.release()


_handlers = {}
_handlerList = []


def _addHandlerRef(handler):
    _handlerList.append(weakref.ref(handler))


def getHandlerByName(name):
    return _handlers.get(name)


def getHandlerNames():
    return frozenset(_handlers)


class Handler(Filterer):
    def __init__(self, level=NOTSET):
        Filterer.__init__(self)
        self._name = None
        self.level = _checkLevel(level)
        self.formatter = None
        self._closed = False
        _addHandlerRef(self)
        self.createLock()

    def get_name(self):
        return self._name

    def set_name(self, name):
        if self._name in _handlers:
            del _handlers[self._name]
        self._name = name
        if name:
            _handlers[name] = self

    name = property(get_name, set_name)

    def createLock(self):
        self.lock = threading.RLock()

    def acquire(self):
        if self.lock:
            self.lock.acquire()

    def release(self):
        if self.lock:
            self.lock.release()

    def setLevel(self, level):
        self.level = _checkLevel(level)

    def format(self, record):
        if self.formatter:
            fmt = self.formatter
        else:
            fmt = _defaultFormatter
        return fmt.format(record)

    def emit(self, record):
        raise NotImplementedError('emit must be implemented '
                                  'by Handler subclasses')

    def handle(self, record):
        rv = self.filter(record)
        if isinstance(rv, LogRecord):
            record = rv
        if rv:
            self.emit(record)
        return rv

    def setFormatter(self, fmt):
        self.formatter = fmt

    def flush(self):
        pass

    def close(self):
        self._closed = True
        if self._name and self._name in _handlers:
            del _handlers[self._name]

    def handleError(self, record):
        if raiseExceptions and sys.stderr:
            sys.stderr.write('--- Logging error ---\n')

    def __repr__(self):
        level = getLevelName(self.level)
        return '<%s (%s)>' % (self.__class__.__name__, level)


class StreamHandler(Handler):
    terminator = '\n'

    def __init__(self, stream=None):
        Handler.__init__(self)
        if stream is None:
            stream = sys.stderr
        self.stream = stream

    def flush(self):
        if self.stream and hasattr(self.stream, "flush"):
            self.stream.flush()

    def emit(self, record):
        if record.exc_info and self.stream is not _standard_stderr():
            _unsupported('プログラムのファイル名を含むトレースバックのログを標準エラー出力以外に書くこと')
        try:
            msg = self.format(record)
            stream = self.stream
            stream.write(msg + self.terminator)
            self.flush()
        except RecursionError:
            raise
        except Exception:
            self.handleError(record)

    def setStream(self, stream):
        if stream is self.stream:
            result = None
        else:
            result = self.stream
            self.acquire()
            try:
                self.flush()
                self.stream = stream
            finally:
                self.release()
        return result

    def __repr__(self):
        level = getLevelName(self.level)
        name = getattr(self.stream, 'name', '')
        name = str(name)
        if name:
            name += ' '
        return '<%s %s(%s)>' % (self.__class__.__name__, name, level)


class _StderrHandler(StreamHandler):
    def __init__(self, level=NOTSET):
        Handler.__init__(self, level)

    @property
    def stream(self):
        return sys.stderr


_defaultLastResort = _StderrHandler(WARNING)
lastResort = _defaultLastResort


class NullHandler(Handler):
    def handle(self, record):
        """Stub."""

    def emit(self, record):
        """Stub."""

    def createLock(self):
        self.lock = None


class PlaceHolder(object):
    """
    PlaceHolder instances are used in the Manager logger hierarchy to take
    the place of nodes for which no loggers have been defined. This class is
    intended for internal use only and not as part of the public API.
    """
    def __init__(self, alogger):
        """
        Initialize with the specified logger being a child of this placeholder.
        """
        self.loggerMap = { alogger : None }

    def append(self, alogger):
        """
        Add the specified logger as a child of this placeholder.
        """
        if alogger not in self.loggerMap:
            self.loggerMap[alogger] = None


class Manager(object):
    def __init__(self, rootnode):
        self.root = rootnode
        self.disable = 0
        self.emittedNoHandlerWarning = False
        self.loggerDict = {}
        self.loggerClass = None
        self.logRecordFactory = None

    def getLogger(self, name):
        rv = None
        if not isinstance(name, str):
            raise TypeError('A logger name must be a string')
        with _lock:
            if name in self.loggerDict:
                rv = self.loggerDict[name]
                if isinstance(rv, PlaceHolder):
                    ph = rv
                    rv = (self.loggerClass or _loggerClass)(name)
                    rv.manager = self
                    self.loggerDict[name] = rv
                    self._fixupChildren(ph, rv)
                    self._fixupParents(rv)
            else:
                rv = (self.loggerClass or _loggerClass)(name)
                rv.manager = self
                self.loggerDict[name] = rv
                self._fixupParents(rv)
        return rv

    def _fixupParents(self, alogger):
        name = alogger.name
        i = name.rfind(".")
        rv = None
        while (i > 0) and not rv:
            substr = name[:i]
            if substr not in self.loggerDict:
                self.loggerDict[substr] = PlaceHolder(alogger)
            else:
                obj = self.loggerDict[substr]
                if isinstance(obj, Logger):
                    rv = obj
                else:
                    assert isinstance(obj, PlaceHolder)
                    obj.append(alogger)
            i = name.rfind(".", 0, i - 1)
        if not rv:
            rv = self.root
        alogger.parent = rv

    def _fixupChildren(self, ph, alogger):
        name = alogger.name
        namelen = len(name)
        for c in ph.loggerMap.keys():
            if c.parent.name[:namelen] != name:
                alogger.parent = c.parent
                c.parent = alogger


class Logger(Filterer):
    def __init__(self, name, level=NOTSET):
        Filterer.__init__(self)
        self.name = name
        self.level = _checkLevel(level)
        self.parent = None
        self.propagate = True
        self.handlers = []
        self.disabled = False

    def setLevel(self, level):
        self.level = _checkLevel(level)

    def debug(self, msg, *args, **kwargs):
        if self.isEnabledFor(DEBUG):
            self._log(DEBUG, msg, args, **kwargs)

    def info(self, msg, *args, **kwargs):
        if self.isEnabledFor(INFO):
            self._log(INFO, msg, args, **kwargs)

    def warning(self, msg, *args, **kwargs):
        if self.isEnabledFor(WARNING):
            self._log(WARNING, msg, args, **kwargs)

    def warn(self, msg, *args, **kwargs):
        import warnings
        warnings.warn("The 'warn' method is deprecated, "
            "use 'warning' instead", DeprecationWarning, 2)
        self.warning(msg, *args, **kwargs)

    def error(self, msg, *args, **kwargs):
        if self.isEnabledFor(ERROR):
            self._log(ERROR, msg, args, **kwargs)

    def exception(self, msg, *args, exc_info=True, **kwargs):
        self.error(msg, *args, exc_info=exc_info, **kwargs)

    def critical(self, msg, *args, **kwargs):
        if self.isEnabledFor(CRITICAL):
            self._log(CRITICAL, msg, args, **kwargs)

    def fatal(self, msg, *args, **kwargs):
        self.critical(msg, *args, **kwargs)

    def log(self, level, msg, *args, **kwargs):
        if not isinstance(level, int):
            if raiseExceptions:
                raise TypeError("level must be an integer")
            else:
                return
        if self.isEnabledFor(level):
            self._log(level, msg, args, **kwargs)

    def findCaller(self, stack_info=False, stacklevel=1):
        found = _caller(stacklevel)
        if found is None:
            return "(unknown file)", 0, "(unknown function)", None
        func, lineno = found
        return _MachineValue('pathname'), lineno, func, None

    def makeRecord(self, name, level, fn, lno, msg, args, exc_info,
                   func=None, extra=None, sinfo=None):
        rv = _logRecordFactory(name, level, fn, lno, msg, args, exc_info, func,
                             sinfo)
        if extra is not None:
            for key in extra:
                if (key in ["message", "asctime"]) or (key in rv.__dict__):
                    raise KeyError("Attempt to overwrite %r in LogRecord" % key)
                setattr(rv, key, extra[key])
        return rv

    def _log(self, level, msg, args, exc_info=None, extra=None, stack_info=False,
             stacklevel=1):
        fn, lno, func, sinfo = self.findCaller(stack_info, stacklevel)
        if exc_info:
            if isinstance(exc_info, BaseException):
                exc_info = (type(exc_info), exc_info, exc_info.__traceback__)
            elif not isinstance(exc_info, tuple):
                handled = _handled_exception()
                if handled is None:
                    exc_info = (None, None, None)
                else:
                    exc_info = (type(handled), handled, None)
        record = self.makeRecord(self.name, level, fn, lno, msg, args,
                                 exc_info, func, extra, sinfo)
        self.handle(record)

    def handle(self, record):
        if self.disabled:
            return
        maybe_record = self.filter(record)
        if not maybe_record:
            return
        if isinstance(maybe_record, LogRecord):
            record = maybe_record
        self.callHandlers(record)

    def addHandler(self, hdlr):
        if not (hdlr in self.handlers):
            self.handlers.append(hdlr)

    def removeHandler(self, hdlr):
        if hdlr in self.handlers:
            self.handlers.remove(hdlr)

    def hasHandlers(self):
        c = self
        rv = False
        while c:
            if c.handlers:
                rv = True
                break
            if not c.propagate:
                break
            else:
                c = c.parent
        return rv

    def callHandlers(self, record):
        c = self
        found = 0
        while c:
            for hdlr in c.handlers:
                found = found + 1
                if record.levelno >= hdlr.level:
                    hdlr.handle(record)
            if not c.propagate:
                c = None
            else:
                c = c.parent
        if (found == 0):
            if lastResort:
                if record.levelno >= lastResort.level:
                    lastResort.handle(record)
            elif raiseExceptions and not self.manager.emittedNoHandlerWarning:
                sys.stderr.write("No handlers could be found for logger"
                                 " \"%s\"\n" % self.name)
                self.manager.emittedNoHandlerWarning = True

    def getEffectiveLevel(self):
        logger = self
        while logger:
            if logger.level:
                return logger.level
            logger = logger.parent
        return NOTSET

    def isEnabledFor(self, level):
        if self.disabled:
            return False
        if self.manager.disable >= level:
            return False
        return level >= self.getEffectiveLevel()

    def getChild(self, suffix):
        if self.root is not self:
            suffix = '.'.join((self.name, suffix))
        return self.manager.getLogger(suffix)

    def getChildren(self):

        def _hierlevel(logger):
            if logger is logger.manager.root:
                return 0
            return 1 + logger.name.count('.')

        d = self.manager.loggerDict
        with _lock:
            return set(item for item in d.values()
                       if isinstance(item, Logger) and item.parent is self and
                       _hierlevel(item) == 1 + _hierlevel(item.parent))

    def __repr__(self):
        level = getLevelName(self.getEffectiveLevel())
        return '<%s %s (%s)>' % (self.__class__.__name__, self.name, level)


class RootLogger(Logger):
    def __init__(self, level):
        Logger.__init__(self, "root", level)


_loggerClass = Logger


class LoggerAdapter(object):
    def __init__(self, logger, extra=None, merge_extra=False):
        self.logger = logger
        self.extra = extra
        self.merge_extra = merge_extra

    def process(self, msg, kwargs):
        if self.merge_extra and "extra" in kwargs:
            kwargs["extra"] = {**self.extra, **kwargs["extra"]}
        else:
            kwargs["extra"] = self.extra
        return msg, kwargs

    def debug(self, msg, *args, **kwargs):
        self.log(DEBUG, msg, *args, **kwargs)

    def info(self, msg, *args, **kwargs):
        self.log(INFO, msg, *args, **kwargs)

    def warning(self, msg, *args, **kwargs):
        self.log(WARNING, msg, *args, **kwargs)

    def error(self, msg, *args, **kwargs):
        self.log(ERROR, msg, *args, **kwargs)

    def exception(self, msg, *args, exc_info=True, **kwargs):
        self.log(ERROR, msg, *args, exc_info=exc_info, **kwargs)

    def critical(self, msg, *args, **kwargs):
        self.log(CRITICAL, msg, *args, **kwargs)

    def log(self, level, msg, *args, **kwargs):
        if self.isEnabledFor(level):
            msg, kwargs = self.process(msg, kwargs)
            self.logger.log(level, msg, *args, stacklevel=kwargs.pop('stacklevel', 1) + 1, **kwargs)

    def isEnabledFor(self, level):
        return self.logger.isEnabledFor(level)

    def setLevel(self, level):
        self.logger.setLevel(level)

    def getEffectiveLevel(self):
        return self.logger.getEffectiveLevel()

    def hasHandlers(self):
        return self.logger.hasHandlers()

    @property
    def manager(self):
        return self.logger.manager

    @property
    def name(self):
        return self.logger.name

    def __repr__(self):
        logger = self.logger
        level = getLevelName(logger.getEffectiveLevel())
        return '<%s %s (%s)>' % (self.__class__.__name__, logger.name, level)


root = RootLogger(WARNING)
Logger.root = root
Logger.manager = Manager(Logger.root)


def setLoggerClass(klass):
    global _loggerClass
    if klass != Logger:
        if not issubclass(klass, Logger):
            raise TypeError("logger not derived from logging.Logger: "
                            + klass.__name__)
    _loggerClass = klass


def getLoggerClass():
    return _loggerClass


def basicConfig(**kwargs):
    force = kwargs.pop('force', False)
    encoding = kwargs.pop('encoding', None)
    errors = kwargs.pop('errors', 'backslashreplace')
    if force:
        for h in root.handlers[:]:
            root.removeHandler(h)
            h.close()
    if len(root.handlers) == 0:
        handlers = kwargs.pop("handlers", None)
        if handlers is None:
            if "stream" in kwargs and "filename" in kwargs:
                raise ValueError("'stream' and 'filename' should not be "
                                 "specified together")
        else:
            if "stream" in kwargs or "filename" in kwargs:
                raise ValueError("'stream' or 'filename' should not be "
                                 "specified together with 'handlers'")
        if handlers is None:
            filename = kwargs.pop("filename", None)
            mode = kwargs.pop("filemode", 'a')
            if filename:
                _unsupported('ファイルに書くログ（logging.basicConfig の filename）')
            else:
                stream = kwargs.pop("stream", None)
                h = StreamHandler(stream)
            handlers = [h]
        dfs = kwargs.pop("datefmt", None)
        style = kwargs.pop("style", '%')
        if style not in _STYLES:
            raise ValueError('Style must be one of: %s' % ','.join(
                             _STYLES.keys()))
        fs = kwargs.pop("format", _STYLES[style][1])
        fmt = Formatter(fs, dfs, style)
        for h in handlers:
            if h.formatter is None:
                h.setFormatter(fmt)
            root.addHandler(h)
        level = kwargs.pop("level", None)
        if level is not None:
            root.setLevel(level)
        if kwargs:
            keys = ', '.join(kwargs.keys())
            raise ValueError('Unrecognised argument(s): %s' % keys)


def getLogger(name=None):
    if not name or isinstance(name, str) and name == root.name:
        return root
    return Logger.manager.getLogger(name)


def critical(msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.critical(msg, *args, **kwargs)


def fatal(msg, *args, **kwargs):
    critical(msg, *args, **kwargs)


def error(msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.error(msg, *args, **kwargs)


def exception(msg, *args, exc_info=True, **kwargs):
    error(msg, *args, exc_info=exc_info, **kwargs)


def warning(msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.warning(msg, *args, **kwargs)


def warn(msg, *args, **kwargs):
    import warnings
    warnings.warn("The 'warn' function is deprecated, "
        "use 'warning' instead", DeprecationWarning, 2)
    warning(msg, *args, **kwargs)


def info(msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.info(msg, *args, **kwargs)


def debug(msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.debug(msg, *args, **kwargs)


def log(level, msg, *args, **kwargs):
    if len(root.handlers) == 0:
        basicConfig()
    root.log(level, msg, *args, **kwargs)


def disable(level=CRITICAL):
    root.manager.disable = level


_warnings_showwarning = None


def _showwarning(message, category, filename, lineno, file=None, line=None):
    if file is not None:
        if _warnings_showwarning is not None:
            _warnings_showwarning(message, category, filename, lineno, file, line)
    else:
        logger = getLogger("py.warnings")
        if not logger.handlers:
            logger.addHandler(NullHandler())
        # The message, warnings.formatwarning() of the warning, starts with the path of the program's file.
        logger.warning(_MachineValue('py.warnings のメッセージ（プログラムのファイルのパスを含む）'))


def captureWarnings(capture):
    global _warnings_showwarning
    import warnings
    if capture:
        if _warnings_showwarning is None:
            _warnings_showwarning = warnings.showwarning
            warnings.showwarning = _showwarning
    else:
        if _warnings_showwarning is not None:
            warnings.showwarning = _warnings_showwarning
            _warnings_showwarning = None


def shutdown(handlerList=_handlerList):
    for wr in reversed(handlerList[:]):
        try:
            h = wr()
            if h:
                try:
                    h.acquire()
                    if getattr(h, 'flushOnClose', True):
                        h.flush()
                    h.close()
                except (OSError, ValueError):
                    pass
                finally:
                    h.release()
        except:
            if raiseExceptions:
                raise


import atexit
atexit.register(shutdown)
`;

registerSourceModule(
  'logging',
  SOURCE,
  (runtime) =>
    new Map<string, PyValue>([
      [
        '_caller',
        builtin('_caller', 'one', 1, 1, ([level]) => {
          const frames = runtime.programFrames();
          const found = frames[Math.max(Number(toIndex(level)), 1) - 1];
          if (!found) return None;
          const name = found.frame.kind === 'function' ? (found.frame.fn?.name ?? '<module>') : '<module>';
          return newTuple([name, BigInt((found.row ?? -1) + 1)]);
        }),
      ],
      [
        '_percent_fields',
        builtin('_percent_fields', 'one', 1, 1, ([format]) =>
          /%\(\w+\)[#0+ -]*(?:\*|\d+)?(?:\.(?:\*|\d+))?[diouxXeEfFgGcrsa%]/.test(format as string)
        ),
      ],
    ])
);

registerUnsupportedAttributes('logging', {
  FileHandler: 'ファイルに書くログ（logging.FileHandler）',
});
