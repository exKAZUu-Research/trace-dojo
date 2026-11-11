import { builtin } from '../define';
import { toIndex } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { newTuple, None, typeError, typeName } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';

// CPython's `_py_warnings.py` without threads and contexts. A warning's line number is the row the program runs; its
// file name is the path of the program's file, which differs on every machine, so reading it stops the program.
const SOURCE = String.raw`
import sys

__all__ = ["warn", "warn_explicit", "showwarning",
           "formatwarning", "filterwarnings", "simplefilter",
           "resetwarnings", "catch_warnings", "deprecated"]

_FILENAME = '<program>'


def showwarning(message, category, filename, lineno, file=None, line=None):
    """Hook to write a warning to a file; replace if you like."""
    msg = WarningMessage(message, category, filename, lineno, file, line)
    _showwarnmsg_impl(msg)


def formatwarning(message, category, filename, lineno, line=None):
    """Function to format a warning the standard way."""
    msg = WarningMessage(message, category, filename, lineno, None, line)
    return _formatwarnmsg_impl(msg)


def _showwarnmsg_impl(msg):
    file = msg.file
    if file is None:
        file = sys.stderr
        if file is None:
            return
    text = _formatwarnmsg(msg)
    try:
        file.write(text)
    except OSError:
        pass


def _formatwarnmsg_impl(msg):
    category = msg.category.__name__
    s = f"{msg._filename}:{msg.lineno}: {category}: {msg.message}\n"
    if msg.line is not None:
        line = msg.line.strip()
        if line:
            s += "  %s\n" % line
    return s


_showwarning_orig = showwarning


def _showwarnmsg(msg):
    """Hook to write a warning to a file; replace if you like."""
    sw = showwarning
    if sw is not _showwarning_orig:
        if not callable(sw):
            raise TypeError("warnings.showwarning() must be set to a "
                            "function or method")
        sw(msg.message, msg.category, msg._filename, msg.lineno, msg.file, msg.line)
        return
    _showwarnmsg_impl(msg)


_formatwarning_orig = formatwarning


def _formatwarnmsg(msg):
    """Function to format a warning the standard way."""
    fw = formatwarning
    if fw is not _formatwarning_orig:
        return fw(msg.message, msg.category, msg._filename, msg.lineno, msg.line)
    return _formatwarnmsg_impl(msg)


class _Pattern:
    def __init__(self, pattern, ignorecase):
        self.pattern = pattern
        self.ignorecase = ignorecase

    def match(self, text):
        return _regex_match(self.pattern, text, self.ignorecase)

    def __eq__(self, other):
        return isinstance(other, _Pattern) and (self.pattern, self.ignorecase) == (other.pattern, other.ignorecase)


def filterwarnings(action, message="", category=Warning, module="", lineno=0,
                   append=False):
    """Insert an entry into the list of warnings filters (at the front)."""
    if action not in {"error", "ignore", "always", "all", "default", "module", "once"}:
        raise ValueError(f"invalid action: {action!r}")
    if not isinstance(message, str):
        raise TypeError("message must be a string")
    if not isinstance(category, type) or not issubclass(category, Warning):
        raise TypeError("category must be a Warning subclass")
    if not isinstance(module, str):
        raise TypeError("module must be a string")
    if not isinstance(lineno, int):
        raise TypeError("lineno must be an int")
    if lineno < 0:
        raise ValueError("lineno must be an int >= 0")

    if message:
        message = _Pattern(message, True)
    else:
        message = None
    if module:
        module = _Pattern(module, False)
    else:
        module = None

    _add_filter(action, message, category, module, lineno, append=append)


def simplefilter(action, category=Warning, lineno=0, append=False):
    """Insert a simple entry into the list of warnings filters (at the front)."""
    if action not in {"error", "ignore", "always", "all", "default", "module", "once"}:
        raise ValueError(f"invalid action: {action!r}")
    if not isinstance(lineno, int):
        raise TypeError("lineno must be an int")
    if lineno < 0:
        raise ValueError("lineno must be an int >= 0")
    _add_filter(action, None, category, None, lineno, append=append)


def _filters_mutated():
    global _filters_version
    _filters_version += 1


def _add_filter(*item, append):
    if not append:
        try:
            filters.remove(item)
        except ValueError:
            pass
        filters.insert(0, item)
    else:
        if item not in filters:
            filters.append(item)
    _filters_mutated()


def resetwarnings():
    """Clear the list of warning filters, so that no filters are active."""
    del filters[:]
    _filters_mutated()


class _OptionError(Exception):
    """Exception used by option processing helpers."""
    pass


def warn(message, category=None, stacklevel=1, source=None,
         *, skip_file_prefixes=()):
    """Issue a warning, or maybe ignore it or raise an exception."""
    if isinstance(message, Warning):
        category = message.__class__
    if category is None:
        category = UserWarning
    if not (isinstance(category, type) and issubclass(category, Warning)):
        raise TypeError("category must be a Warning subclass, "
                        "not '{:s}'".format(type(category).__name__))
    if not isinstance(skip_file_prefixes, tuple):
        raise TypeError('skip_file_prefixes must be a tuple of strs.')
    if skip_file_prefixes:
        stacklevel = max(2, stacklevel)
    caller = _caller(stacklevel)
    if caller is None:
        filename = "<sys>"
        lineno = 0
        module = "sys"
    else:
        filename = _FILENAME
        module, lineno = caller
    registry = _registries.setdefault(module, {})
    warn_explicit(message, category, filename, lineno, module, registry, None, source=source)


_registries = {}


def warn_explicit(message, category, filename, lineno,
                  module=None, registry=None, module_globals=None,
                  source=None):
    lineno = int(lineno)
    if module is None:
        module = filename or "<unknown>"
        if module[-3:].lower() == ".py":
            module = module[:-3]
    if isinstance(message, Warning):
        text = str(message)
        category = message.__class__
    else:
        text = message
        message = category(message)
    key = (text, category, lineno)
    if registry is None:
        registry = {}
    if registry.get('version', 0) != _filters_version:
        registry.clear()
        registry['version'] = _filters_version
    if registry.get(key):
        return
    for item in filters:
        action, msg, cat, mod, ln = item
        if ((msg is None or msg.match(text)) and
            issubclass(category, cat) and
            (mod is None or mod.match(module)) and
            (ln == 0 or lineno == ln)):
            break
    else:
        action = defaultaction
    if action == "ignore":
        return
    if action == "error":
        raise message
    if action == "once":
        registry[key] = 1
        oncekey = (text, category)
        if onceregistry.get(oncekey):
            return
        onceregistry[oncekey] = 1
    elif action in {"always", "all"}:
        pass
    elif action == "module":
        registry[key] = 1
        altkey = (text, category, 0)
        if registry.get(altkey):
            return
        registry[altkey] = 1
    elif action == "default":
        registry[key] = 1
    else:
        raise RuntimeError(
              "Unrecognized action (%r) in warnings.filters:\n %s" %
              (action, item))
    msg = WarningMessage(message, category, filename, lineno, source=source)
    _showwarnmsg(msg)


class WarningMessage(object):

    _WARNING_DETAILS = ("message", "category", "filename", "lineno", "file",
                        "line", "source")

    def __init__(self, message, category, filename, lineno, file=None,
                 line=None, source=None):
        self.message = message
        self.category = category
        self._filename = filename
        self.lineno = lineno
        self.file = file
        self.line = line
        self.source = source
        if category:
            self._category_name = category.__name__
        else:
            self._category_name = None

    @property
    def filename(self):
        if self._filename == _FILENAME:
            _unsupported('警告を出したプログラムのファイル名（WarningMessage.filename）')
        return self._filename

    def __str__(self):
        return ("{message : %r, category : %r, filename : %r, lineno : %s, "
                    "line : %r}" % (self.message, self._category_name,
                                    self.filename, self.lineno, self.line))

    def __repr__(self):
        return f'<{type(self).__qualname__} {self}>'


class catch_warnings(object):

    def __init__(self, *, record=False, module=None,
                 action=None, category=Warning, lineno=0, append=False):
        import warnings
        self._record = record
        if module is None:
            self._module = warnings
        else:
            self._module = module
        self._entered = False
        if action is None:
            self._filter = None
        else:
            self._filter = (action, category, lineno, append)

    def __repr__(self):
        args = []
        if self._record:
            args.append("record=True")
        name = type(self).__name__
        return "%s(%s)" % (name, ", ".join(args))

    def __enter__(self):
        if self._entered:
            raise RuntimeError("Cannot enter %r twice" % self)
        self._entered = True
        self._filters = self._module.filters
        self._module.filters = self._filters[:]
        self._showwarnmsg_impl = self._module._showwarnmsg_impl
        self._showwarning = self._module.showwarning
        self._module._filters_mutated()
        if self._record:
            log = []
            self._module._showwarnmsg_impl = log.append
            self._module.showwarning = self._module._showwarning_orig
        else:
            log = None
        if self._filter is not None:
            self._module.simplefilter(*self._filter)
        return log

    def __exit__(self, *exc_info):
        if not self._entered:
            raise RuntimeError("Cannot exit %r without entering first" % self)
        self._module.filters = self._filters
        self._module._showwarnmsg_impl = self._showwarnmsg_impl
        self._module.showwarning = self._showwarning
        self._module._filters_mutated()


class deprecated:
    """Indicate that a class, function or overload is deprecated."""

    def __init__(self, message, /, *, category=DeprecationWarning, stacklevel=1):
        if not isinstance(message, str):
            raise TypeError(
                f"Expected an object of type str for 'message', not {type(message).__name__!r}"
            )
        self.message = message
        self.category = category
        self.stacklevel = stacklevel

    def __call__(self, arg, /):
        msg = self.message
        category = self.category
        stacklevel = self.stacklevel
        if category is None:
            arg.__deprecated__ = msg
            return arg
        elif isinstance(arg, type):
            _unsupported('クラスに付ける warnings.deprecated')
        elif callable(arg):
            import functools

            @functools.wraps(arg)
            def wrapper(*args, **kwargs):
                warn(msg, category=category, stacklevel=stacklevel + 1)
                return arg(*args, **kwargs)
            arg.__deprecated__ = wrapper.__deprecated__ = msg
            return wrapper
        else:
            raise TypeError(
                "@deprecated decorator with non-None category must be applied to "
                f"a class or callable, not {arg!r}"
            )


_filters_version = 1
filters = []
defaultaction = "default"
onceregistry = {}
filterwarnings("default", category=DeprecationWarning, module="__main__", append=True)
simplefilter("ignore", category=DeprecationWarning, append=True)
simplefilter("ignore", category=PendingDeprecationWarning, append=True)
simplefilter("ignore", category=ImportWarning, append=True)
simplefilter("ignore", category=ResourceWarning, append=True)


_DEPRECATED_MSG = "{name!r} is deprecated and slated for removal in Python {remove}"


def _deprecated(name, message=_DEPRECATED_MSG, *, remove, _version=sys.version_info):
    """Warn that *name* is deprecated or should be removed.

    RuntimeError is raised if *remove* specifies a major/minor tuple older than
    the current Python version or the same version but past the alpha.

    The *message* argument is formatted with *name* and *remove* as a Python
    version tuple (e.g. (3, 11)).

    """
    remove_formatted = f"{remove[0]}.{remove[1]}"
    if (_version[:2] > remove) or (_version[:2] == remove and _version[3] != "alpha"):
        msg = f"{name!r} was slated for removal after Python {remove_formatted} alpha"
        raise RuntimeError(msg)
    else:
        msg = message.format(name=name, remove=remove_formatted)
        warn(msg, DeprecationWarning, stacklevel=3)
`;

registerSourceModule(
  'warnings',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_caller',
        builtin('_caller', 'one', 1, 1, ([level]) => {
          const frames = currentRuntime().programFrames();
          const found = frames[Number(toIndex(level)) - 1] ?? (Number(toIndex(level)) <= 1 ? frames[0] : undefined);
          if (!found) return None;
          return newTuple([found.frame.moduleName, BigInt((found.row ?? -1) + 1)]);
        }),
      ],
      [
        '_regex_match',
        builtin('_regex_match', 'expected', 3, 3, ([pattern, text, ignorecase]) => {
          if (typeof text !== 'string')
            throw typeError(`expected string or bytes-like object, got '${typeName(text)}'`);
          try {
            return new RegExp(`^(?:${pattern as string})`, ignorecase === true ? 'iu' : 'u').test(text);
          } catch {
            throw new UnsupportedFeatureError('この warnings の正規表現');
          }
        }),
      ],
    ])
);
