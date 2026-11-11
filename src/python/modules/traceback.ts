import { registerUnsupportedAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';

// The parts of CPython's `traceback` module that do not show the program's file, with its `TracebackException` for
// exceptions without frames: a traceback names the path of the program's file, which differs on every machine, so
// printing one goes only to stderr, which learners do not see, and formatting one as a string stops the program.
const SOURCE =
  String.raw`
import collections.abc
import sys
import textwrap

__all__ = ['print_exc', 'format_exception', 'format_exception_only', 'print_exception', 'print_stack',
           'clear_frames', 'TracebackException']

_sentinel = object()

_cause_message = (
    "\nThe above exception was the direct cause "
    "of the following exception:\n\n")

_context_message = (
    "\nDuring handling of the above exception, "
    "another exception occurred:\n\n")


def _parse_value_tb(exc, value, tb):
    if (value is _sentinel) != (tb is _sentinel):
        raise ValueError("Both or neither of value and tb must be given")
    if value is tb is _sentinel:
        if exc is not None:
            if isinstance(exc, BaseException):
                return exc, exc.__traceback__

            raise TypeError(f'Exception expected for value, '
                            f'{type(exc).__name__} found')
        else:
            return None, None
    return value, tb


def print_exception(exc, /, value=_sentinel, tb=_sentinel, limit=None, file=None, chain=True, **kwargs):
    """Print exception up to 'limit' stack trace entries from 'tb' to 'file'.

    This differs from print_tb() in the following ways: (1) if
    traceback is not None, it prints a header "Traceback (most recent
    call last):"; (2) it prints the exception type and value after the
    stack trace; (3) if type is SyntaxError and value has the
    appropriate format, it prints the line where the syntax error
    occurred with a caret on the next line indicating the approximate
    position of the error.
    """
    value, tb = _parse_value_tb(exc, value, tb)
    te = TracebackException(type(value), value, tb, limit=limit, compact=True)
    if te._has_frames(chain):
        lines = []
        if value is not None:
            lines.append('Traceback (most recent call last):\n')
        lines.extend(format_exception_only(value))
        _print_lines(lines, file)
    else:
        te.print(file=file, chain=chain)


def format_exception(exc, /, value=_sentinel, tb=_sentinel, limit=None, chain=True, **kwargs):
    """Format a stack trace and the exception information.

    The arguments have the same meaning as the corresponding arguments
    to print_exception().  The return value is a list of strings, each
    ending in a newline and some containing internal newlines.  When
    these lines are concatenated and printed, exactly the same text is
    printed as does print_exception().
    """
    value, tb = _parse_value_tb(exc, value, tb)
    te = TracebackException(type(value), value, tb, limit=limit, compact=True)
    return list(te.format(chain=chain))


def format_exception_only(exc, /, value=_sentinel, *, show_group=False, **kwargs):
    """Format the exception part of a traceback.

    The return value is a list of strings, each ending in a newline.

    The list contains the exception's message, which is
    normally a single string; however, for :exc:` +
  '`' +
  String.raw`SyntaxError` +
  '`' +
  String.raw` exceptions, it
    contains several lines that (when printed) display detailed information
    about where the syntax error occurred. Following the message, the list
    contains the exception's ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`__notes__` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`.

    When *show_group* is ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`True` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`, and the exception is an instance of
    :exc:` +
  '`' +
  String.raw`BaseExceptionGroup` +
  '`' +
  String.raw`, the nested exceptions are included as
    well, recursively, with indentation relative to their nesting depth.
    """
    if value is _sentinel:
        value = exc
    te = TracebackException(type(value), value, None, compact=True)
    return list(te.format_exception_only(show_group=show_group))


def _format_final_exc_line(etype, value, *, insert_final_newline=True):
    valuestr = _safe_string(value, 'exception')
    end_char = "\n" if insert_final_newline else ""
    if value is None or not valuestr:
        line = f"{etype}{end_char}"
    else:
        line = f"{etype}: {valuestr}{end_char}"
    return line


def _safe_string(value, what, func=str):
    try:
        return func(value)
    except:
        return f'<{what} {func.__name__}() failed>'


def _print_lines(lines, file):
    if file is None:
        file = sys.stderr
    if file is not _standard_stderr():
        _unsupported('プログラムのファイル名を含むトレースバックを標準エラー出力以外に書くこと')
    for line in lines:
        print(line, file=file, end='')


def print_exc(limit=None, file=None, chain=True):
    """Shorthand for 'print_exception(sys.exception(), limit=limit, file=file, chain=chain)'."""
    print_exception(_handled_exception(), limit=limit, file=file, chain=chain)


def clear_frames(tb):
    "Clear all references to local variables in the frames of a traceback."
    while tb is not None:
        try:
            tb.tb_frame.clear()
        except RuntimeError:
            pass
        tb = tb.tb_next


def print_stack(f=None, limit=None, file=None):
    """Print a stack trace from its invocation point.

    The optional 'f' argument can be used to specify an alternate
    stack frame at which to start. The optional 'limit' and 'file'
    arguments have the same meaning as for print_exception().
    """
    _print_lines(['Traceback (most recent call last):\n'], file)


class StackSummary(list):
    """A list of FrameSummary objects, representing a stack of frames."""


StackSummary.__module__ = 'traceback'


class _ExceptionPrintContext:
    def __init__(self):
        self.seen = set()
        self.exception_group_depth = 0
        self.need_close = False

    def indent(self):
        return ' ' * (2 * self.exception_group_depth)

    def emit(self, text_gen, margin_char=None):
        if margin_char is None:
            margin_char = '|'
        indent_str = self.indent()
        if self.exception_group_depth:
            indent_str += margin_char + ' '

        if isinstance(text_gen, str):
            yield textwrap.indent(text_gen, indent_str, lambda line: True)
        else:
            for text in text_gen:
                yield textwrap.indent(text, indent_str, lambda line: True)


class TracebackException:
    """An exception ready for rendering.

    The traceback module captures enough attributes from the original exception
    to this intermediary form to ensure that no references are held, while
    still being able to fully print or format it.

    max_group_width and max_group_depth control the formatting of exception
    groups. The depth refers to the nesting level of the group, and the width
    refers to the size of a single exception group's exceptions array. The
    formatted output is truncated when either limit is exceeded.

    Use ` +
  '`' +
  String.raw`from_exception` +
  '`' +
  String.raw` to create TracebackException instances from exception
    objects, or the constructor to create TracebackException instances from
    individual components.

    - :attr:` +
  '`' +
  String.raw`__cause__` +
  '`' +
  String.raw` A TracebackException of the original *__cause__*.
    - :attr:` +
  '`' +
  String.raw`__context__` +
  '`' +
  String.raw` A TracebackException of the original *__context__*.
    - :attr:` +
  '`' +
  String.raw`exceptions` +
  '`' +
  String.raw` For exception groups - a list of TracebackException
      instances for the nested *exceptions*.  ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`None` +
  '`' +
  String.raw`` +
  '`' +
  String.raw` for other exceptions.
    - :attr:` +
  '`' +
  String.raw`__suppress_context__` +
  '`' +
  String.raw` The *__suppress_context__* value from the
      original exception.
    - :attr:` +
  '`' +
  String.raw`stack` +
  '`' +
  String.raw` A ` +
  '`' +
  String.raw`StackSummary` +
  '`' +
  String.raw` representing the traceback.
    - :attr:` +
  '`' +
  String.raw`exc_type` +
  '`' +
  String.raw` (deprecated) The class of the original traceback.
    - :attr:` +
  '`' +
  String.raw`exc_type_str` +
  '`' +
  String.raw` String display of exc_type
    - :attr:` +
  '`' +
  String.raw`filename` +
  '`' +
  String.raw` For syntax errors - the filename where the error
      occurred.
    - :attr:` +
  '`' +
  String.raw`lineno` +
  '`' +
  String.raw` For syntax errors - the linenumber where the error
      occurred.
    - :attr:` +
  '`' +
  String.raw`end_lineno` +
  '`' +
  String.raw` For syntax errors - the end linenumber where the error
      occurred. Can be ` +
  '`' +
  String.raw`None` +
  '`' +
  String.raw` if not present.
    - :attr:` +
  '`' +
  String.raw`text` +
  '`' +
  String.raw` For syntax errors - the text where the error
      occurred.
    - :attr:` +
  '`' +
  String.raw`offset` +
  '`' +
  String.raw` For syntax errors - the offset into the text where the
      error occurred.
    - :attr:` +
  '`' +
  String.raw`end_offset` +
  '`' +
  String.raw` For syntax errors - the end offset into the text where
      the error occurred. Can be ` +
  '`' +
  String.raw`None` +
  '`' +
  String.raw` if not present.
    - :attr:` +
  '`' +
  String.raw`msg` +
  '`' +
  String.raw` For syntax errors - the compiler error message.
    """

    def __init__(self, exc_type, exc_value, exc_traceback, *, limit=None,
            lookup_lines=True, capture_locals=False, compact=False,
            max_group_width=15, max_group_depth=10, save_exc_type=True, _seen=None):
        is_recursive_call = _seen is not None
        if _seen is None:
            _seen = set()
        _seen.add(id(exc_value))

        self.max_group_width = max_group_width
        self.max_group_depth = max_group_depth

        # The frames of a traceback name the program's file, so only frameless exceptions format here.
        self._traceback = exc_traceback
        self._exc_type = exc_type if save_exc_type else None

        self._str = _safe_string(exc_value, 'exception')
        try:
            self.__notes__ = getattr(exc_value, '__notes__', None)
        except Exception as e:
            self.__notes__ = [
                f'Ignored error getting __notes__: {_safe_string(e, '__notes__', repr)}']

        self._is_syntax_error = False
        self._have_exc_type = exc_type is not None
        if exc_type is not None:
            self.exc_type_qualname = exc_type.__qualname__
            self.exc_type_module = exc_type.__module__
        else:
            self.exc_type_qualname = None
            self.exc_type_module = None

        if exc_type and issubclass(exc_type, SyntaxError):
            self.filename = exc_value.filename
            lno = exc_value.lineno
            self.lineno = str(lno) if lno is not None else None
            end_lno = exc_value.end_lineno
            self.end_lineno = str(end_lno) if end_lno is not None else None
            self.text = exc_value.text
            self.offset = exc_value.offset
            self.end_offset = exc_value.end_offset
            self.msg = exc_value.msg
            self._is_syntax_error = True
        self.__suppress_context__ = \
            exc_value.__suppress_context__ if exc_value is not None else False

        if not is_recursive_call:
            queue = [(self, exc_value)]
            while queue:
                te, e = queue.pop()
                if (e is not None and e.__cause__ is not None
                    and id(e.__cause__) not in _seen):
                    cause = TracebackException(
                        type(e.__cause__),
                        e.__cause__,
                        e.__cause__.__traceback__,
                        limit=limit,
                        lookup_lines=lookup_lines,
                        capture_locals=capture_locals,
                        max_group_width=max_group_width,
                        max_group_depth=max_group_depth,
                        _seen=_seen)
                else:
                    cause = None

                if compact:
                    need_context = (cause is None and
                                    e is not None and
                                    not e.__suppress_context__)
                else:
                    need_context = True
                if (e is not None and e.__context__ is not None
                    and need_context and id(e.__context__) not in _seen):
                    context = TracebackException(
                        type(e.__context__),
                        e.__context__,
                        e.__context__.__traceback__,
                        limit=limit,
                        lookup_lines=lookup_lines,
                        capture_locals=capture_locals,
                        max_group_width=max_group_width,
                        max_group_depth=max_group_depth,
                        _seen=_seen)
                else:
                    context = None

                if e is not None and isinstance(e, BaseExceptionGroup):
                    exceptions = []
                    for exc in e.exceptions:
                        texc = TracebackException(
                            type(exc),
                            exc,
                            exc.__traceback__,
                            limit=limit,
                            lookup_lines=lookup_lines,
                            capture_locals=capture_locals,
                            max_group_width=max_group_width,
                            max_group_depth=max_group_depth,
                            _seen=_seen)
                        exceptions.append(texc)
                else:
                    exceptions = None

                te.__cause__ = cause
                te.__context__ = context
                te.exceptions = exceptions
                if cause:
                    queue.append((te.__cause__, e.__cause__))
                if context:
                    queue.append((te.__context__, e.__context__))
                if exceptions:
                    queue.extend(zip(te.exceptions, e.exceptions))

    @classmethod
    def from_exception(cls, exc, *args, **kwargs):
        """Create a TracebackException from an exception."""
        return cls(type(exc), exc, exc.__traceback__, *args, **kwargs)

    @property
    def stack(self):
        if self._traceback is not None:
            _unsupported('トレースバックの情報（TracebackException.stack）')
        return _StackSummary()

    @property
    def exc_type(self):
        import warnings
        warnings.warn('Deprecated in 3.13. Use exc_type_str instead.',
                      DeprecationWarning, stacklevel=2)
        return self._exc_type

    @property
    def exc_type_str(self):
        if not self._have_exc_type:
            return None
        stype = self.exc_type_qualname
        smod = self.exc_type_module
        if smod not in ("__main__", "builtins"):
            if not isinstance(smod, str):
                smod = "<unknown>"
            stype = smod + '.' + stype
        return stype

    def __eq__(self, other):
        if isinstance(other, TracebackException):
            return self.__dict__ == other.__dict__
        return NotImplemented

    def __str__(self):
        return self._str

    def _has_frames(self, chain):
        if self._traceback is not None:
            return True
        parts = list(self.exceptions or ())
        if chain:
            parts.extend(each for each in (self.__cause__, self.__context__) if each is not None)
        return any(part._has_frames(chain) for part in parts)

    def format_exception_only(self, *, show_group=False, _depth=0, **kwargs):
        """Format the exception part of the traceback.

        The return value is a generator of strings, each ending in a newline.

        Generator yields the exception message.
        For :exc:` +
  '`' +
  String.raw`SyntaxError` +
  '`' +
  String.raw` exceptions, it
        also yields (before the exception message)
        several lines that (when printed)
        display detailed information about where the syntax error occurred.
        Following the message, generator also yields
        all the exception's ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`__notes__` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`.

        When *show_group* is ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`True` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`, and the exception is an instance of
        :exc:` +
  '`' +
  String.raw`BaseExceptionGroup` +
  '`' +
  String.raw`, the nested exceptions are included as
        well, recursively, with indentation relative to their nesting depth.
        """
        indent = 3 * _depth * ' '
        if not self._have_exc_type:
            yield indent + _format_final_exc_line(None, self._str)
            return

        stype = self.exc_type_str
        if not self._is_syntax_error:
            if _depth > 0:
                formatted = _format_final_exc_line(
                    stype, self._str, insert_final_newline=False
                ).split('\n')
                yield from [
                    indent + l + '\n'
                    for l in formatted
                ]
            else:
                yield _format_final_exc_line(stype, self._str)
        else:
            yield from [indent + l for l in self._format_syntax_error(stype)]

        if (
            isinstance(self.__notes__, collections.abc.Sequence)
            and not isinstance(self.__notes__, (str, bytes))
        ):
            for note in self.__notes__:
                note = _safe_string(note, 'note')
                yield from [indent + l + '\n' for l in note.split('\n')]
        elif self.__notes__ is not None:
            yield indent + "{}\n".format(_safe_string(self.__notes__, '__notes__', func=repr))

        if self.exceptions and show_group:
            for ex in self.exceptions:
                yield from ex.format_exception_only(show_group=show_group, _depth=_depth+1)

    def _format_syntax_error(self, stype, **kwargs):
        """Format SyntaxError exceptions (internal helper)."""
        filename_suffix = ''
        if self.lineno is not None:
            yield '  File "{}", line {}\n'.format(
                self.filename or "<string>",
                self.lineno,
                )
        elif self.filename is not None:
            filename_suffix = ' ({})'.format(self.filename)

        text = self.text
        if isinstance(text, str):
            rtext = text.rstrip('\n')
            ltext = rtext.lstrip(' \n\f')
            spaces = len(rtext) - len(ltext)
            if self.offset is None:
                yield '    {}\n'.format(ltext)
            elif isinstance(self.offset, int):
                offset = self.offset
                if self.lineno == self.end_lineno:
                    end_offset = (
                        self.end_offset
                        if (
                            isinstance(self.end_offset, int)
                            and self.end_offset != 0
                        )
                        else offset
                    )
                else:
                    end_offset = len(rtext) + 1

                if self.text and offset > len(self.text):
                    offset = len(rtext) + 1
                if self.text and end_offset > len(self.text):
                    end_offset = len(rtext) + 1
                if offset >= end_offset or end_offset < 0:
                    end_offset = offset + 1

                colno = offset - 1 - spaces
                end_colno = end_offset - 1 - spaces
                caretspace = ' '
                if colno >= 0:
                    caretspace = ((c if c.isspace() else ' ') for c in ltext[:colno])
                    yield '    {}\n'.format(ltext)
                    yield '    {}{}\n'.format(
                        "".join(caretspace),
                        ('^' * (end_colno - colno)),
                    )
                else:
                    yield '    {}\n'.format(ltext)
        try:
            if not (msg := self.msg):
                msg = "<no detail available>"
        except TypeError:
            pass
        yield "{}: {}{}\n".format(stype, msg, filename_suffix)

    def format(self, *, chain=True, _ctx=None, **kwargs):
        """Format the exception.

        If chain is not *True*, *__cause__* and *__context__* will not be formatted.

        The return value is a generator of strings, each ending in a newline and
        some containing internal newlines. ` +
  '`' +
  String.raw`print_exception` +
  '`' +
  String.raw` is a wrapper around
        this method which just prints the lines to a file.

        The message indicating which exception occurred is always the last
        string in the output.
        """
        if _ctx is None:
            if self._has_frames(chain):
                _unsupported('プログラムのファイル名を含むトレースバックの文字列（traceback.TracebackException.format）')
            _ctx = _ExceptionPrintContext()

        output = []
        exc = self
        if chain:
            while exc:
                if exc.__cause__ is not None:
                    chained_msg = _cause_message
                    chained_exc = exc.__cause__
                elif (exc.__context__  is not None and
                      not exc.__suppress_context__):
                    chained_msg = _context_message
                    chained_exc = exc.__context__
                else:
                    chained_msg = None
                    chained_exc = None

                output.append((chained_msg, exc))
                exc = chained_exc
        else:
            output.append((None, exc))

        for msg, exc in reversed(output):
            if msg is not None:
                yield from _ctx.emit(msg)
            if exc.exceptions is None:
                yield from _ctx.emit(exc.format_exception_only())
            elif _ctx.exception_group_depth > self.max_group_depth:
                yield from _ctx.emit(
                    f"... (max_group_depth is {self.max_group_depth})\n")
            else:
                is_toplevel = (_ctx.exception_group_depth == 0)
                if is_toplevel:
                    _ctx.exception_group_depth += 1

                yield from _ctx.emit(exc.format_exception_only())
                num_excs = len(exc.exceptions)
                if num_excs <= self.max_group_width:
                    n = num_excs
                else:
                    n = self.max_group_width + 1
                _ctx.need_close = False
                for i in range(n):
                    last_exc = (i == n-1)
                    if last_exc:
                        _ctx.need_close = True

                    if self.max_group_width is not None:
                        truncated = (i >= self.max_group_width)
                    else:
                        truncated = False
                    title = f'{i+1}' if not truncated else '...'
                    yield (_ctx.indent() +
                           ('+-' if i==0 else '  ') +
                           f'+---------------- {title} ----------------\n')
                    _ctx.exception_group_depth += 1
                    if not truncated:
                        yield from exc.exceptions[i].format(chain=chain, _ctx=_ctx)
                    else:
                        remaining = num_excs - self.max_group_width
                        plural = 's' if remaining > 1 else ''
                        yield from _ctx.emit(
                            f"and {remaining} more exception{plural}\n")

                    if last_exc and _ctx.need_close:
                        yield (_ctx.indent() +
                               "+------------------------------------\n")
                        _ctx.need_close = False
                    _ctx.exception_group_depth -= 1

                if is_toplevel:
                    assert _ctx.exception_group_depth == 1
                    _ctx.exception_group_depth = 0

    def print(self, *, file=None, chain=True, **kwargs):
        """Print the result of self.format(chain=chain) to 'file'."""
        if file is None:
            file = sys.stderr
        for line in self.format(chain=chain):
            print(line, file=file, end="")


_StackSummary = StackSummary
del StackSummary
`;

registerSourceModule('traceback', SOURCE);

const FORMATTED = 'プログラムのファイル名を含むトレースバックの文字列';
registerUnsupportedAttributes('traceback', {
  format_exc: `${FORMATTED}（traceback.format_exc）`,
  format_tb: `${FORMATTED}（traceback.format_tb）`,
  format_stack: `${FORMATTED}（traceback.format_stack）`,
  format_list: `${FORMATTED}（traceback.format_list）`,
  extract_tb: 'トレースバックの情報（traceback.extract_tb）',
  extract_stack: 'トレースバックの情報（traceback.extract_stack）',
  walk_tb: 'トレースバックの情報（traceback.walk_tb）',
  walk_stack: 'トレースバックの情報（traceback.walk_stack）',
  print_tb: 'トレースバックの情報（traceback.print_tb）',
  print_list: 'トレースバックの情報（traceback.print_list）',
  print_last: 'traceback.print_last',
  StackSummary: 'traceback.StackSummary',
  FrameSummary: 'traceback.FrameSummary',
});
