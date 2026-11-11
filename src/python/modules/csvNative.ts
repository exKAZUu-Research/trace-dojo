import { callValue } from '../objects';
import { registerSourceModule } from '../sourceModules';
import { nativeFunction, wrapperDescriptorClass } from '../types';
import { PyBuiltinFunction, type PyFunction, type PyValue } from '../values';
import { readerNext } from './csvParser';

// CPython's `_csv` module, which CPython writes in C (`Modules/_csv.c`), in Python, with the reader's parser native
// (see csvParser.ts): the same parser states, the same quoting rules of the writer, and the same messages.
const SOURCE = String.raw`
QUOTE_MINIMAL, QUOTE_ALL, QUOTE_NONNUMERIC, QUOTE_NONE, QUOTE_STRINGS, QUOTE_NOTNULL = range(6)

_dialects = {}
_field_limit = 128 * 1024

_NAMES = ('dialect', 'delimiter', 'doublequote', 'escapechar', 'lineterminator',
          'quotechar', 'quoting', 'skipinitialspace', 'strict')


class Error(Exception):
    pass


def _no_new_attribute(obj, name):
    raise AttributeError(
        f"'{type(obj).__module__}.{type(obj).__name__}' object has no attribute '{name}' "
        "and no __dict__ for setting new attributes")


def _set_char(name, src, default):
    if src is _MISSING:
        return default
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a unicode character, not {type(src).__name__}')
    if len(src) != 1:
        raise TypeError(f'"{name}" must be a unicode character, not a string of length {len(src)}')
    return src


def _set_char_or_none(name, src, default):
    if src is _MISSING:
        return default
    if src is None:
        return None
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a unicode character or None, not {type(src).__name__}')
    if len(src) != 1:
        raise TypeError(f'"{name}" must be a unicode character or None, not a string of length {len(src)}')
    return src


def _set_bool(src, default):
    return default if src is _MISSING else bool(src)


def _set_int(name, src, default):
    if src is _MISSING:
        return default
    if type(src) is not int:
        raise TypeError(f'"{name}" must be an integer, not {type(src).__name__}')
    if not -2**31 <= src < 2**31:
        raise OverflowError('Python int too large to convert to C int')
    return src


def _set_str(name, src, default):
    if src is _MISSING:
        return default
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a string, not {type(src).__name__}')
    return src


def _check_char(name, c, lineterminator, allowspace):
    if c is None:
        return
    if c == '\r' or c == '\n' or (c == ' ' and not allowspace):
        raise ValueError(f'bad {name} value')
    if c in lineterminator:
        raise ValueError(f'bad {name} or lineterminator value')


def _check_chars(name1, name2, c1, c2):
    if c1 is not None and c1 == c2:
        raise ValueError(f'bad {name1} or {name2} value')


_MISSING = object()


class Dialect:
    """CSV dialect

The Dialect type records CSV parsing and generation options.
"""

    __slots__ = ('_delimiter', '_doublequote', '_escapechar', '_lineterminator',
                 '_quotechar', '_quoting', '_skipinitialspace', '_strict')

    def __new__(cls, *args, **kwargs):
        if len(args) > len(_NAMES):
            raise TypeError(f'function takes at most {len(_NAMES)} arguments ({len(args)} given)')
        values = dict(zip(_NAMES, args))
        for key, value in kwargs.items():
            if key not in _NAMES:
                raise TypeError(f"this function got an unexpected keyword argument '{key}'")
            if key in values:
                raise TypeError(f"argument for function given by name ('{key}') and position ({_NAMES.index(key) + 1})")
            values[key] = value
        dialect = values.pop('dialect', None)
        if dialect is not None:
            if isinstance(dialect, str):
                dialect = get_dialect(dialect)
            if isinstance(dialect, Dialect) and not values:
                return dialect
            for name in _NAMES[1:]:
                if name not in values:
                    try:
                        values[name] = getattr(dialect, name)
                    except AttributeError:
                        pass
        self = object.__new__(cls)
        get = values.get
        delimiter = _set_char('delimiter', get('delimiter', _MISSING), ',')
        doublequote = _set_bool(get('doublequote', _MISSING), True)
        escapechar = _set_char_or_none('escapechar', get('escapechar', _MISSING), None)
        lineterminator = _set_str('lineterminator', get('lineterminator', _MISSING), '\r\n')
        quotechar = _set_char_or_none('quotechar', get('quotechar', _MISSING), '"')
        quoting = _set_int('quoting', get('quoting', _MISSING), QUOTE_MINIMAL)
        skipinitialspace = _set_bool(get('skipinitialspace', _MISSING), False)
        strict = _set_bool(get('strict', _MISSING), False)
        if quoting not in range(6):
            raise TypeError('bad "quoting" value')
        if get('quotechar', _MISSING) is None and get('quoting', _MISSING) is _MISSING:
            quoting = QUOTE_NONE
        if quoting != QUOTE_NONE and quotechar is None:
            raise TypeError('quotechar must be set if quoting enabled')
        _check_char('delimiter', delimiter, lineterminator, True)
        _check_char('escapechar', escapechar, lineterminator, not skipinitialspace)
        _check_char('quotechar', quotechar, lineterminator, not skipinitialspace)
        _check_chars('delimiter', 'escapechar', delimiter, escapechar)
        _check_chars('delimiter', 'quotechar', delimiter, quotechar)
        _check_chars('escapechar', 'quotechar', escapechar, quotechar)
        init = object.__setattr__
        init(self, '_delimiter', delimiter)
        init(self, '_doublequote', doublequote)
        init(self, '_escapechar', escapechar)
        init(self, '_lineterminator', lineterminator)
        init(self, '_quotechar', quotechar)
        init(self, '_quoting', quoting)
        init(self, '_skipinitialspace', skipinitialspace)
        init(self, '_strict', strict)
        return self

    delimiter = property(lambda self: self._delimiter)
    doublequote = property(lambda self: self._doublequote)
    escapechar = property(lambda self: self._escapechar)
    lineterminator = property(lambda self: self._lineterminator)
    quotechar = property(lambda self: self._quotechar)
    quoting = property(lambda self: self._quoting)
    skipinitialspace = property(lambda self: self._skipinitialspace)
    strict = property(lambda self: self._strict)

    def __setattr__(self, name, value):
        if name in _NAMES:
            raise AttributeError(f"attribute '{name}' of '_csv.Dialect' objects is not writable")
        _no_new_attribute(self, name)


_c_type_name(Dialect, '_csv.Dialect')


def _call_dialect(dialect, kwargs):
    if dialect is None:
        return Dialect(**kwargs)
    return Dialect(dialect, **kwargs)


def _unpack(name, args, maximum):
    if not args:
        raise TypeError(f'{name} expected at least 1 argument, got 0')
    if len(args) > maximum:
        raise TypeError(f'{name} expected at most {maximum} arguments, got {len(args)}')
    return args[0], (args[1] if len(args) > 1 else None)




class reader:
    """CSV reader

Reader objects are responsible for reading and parsing tabular data
in CSV format.
"""

    __slots__ = ('_input', '_dialect', '_line_num')

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_csv.reader' instances")

    dialect = property(lambda self: self._dialect)
    line_num = property(lambda self: self._line_num)

    def __setattr__(self, name, value):
        if name in ('dialect', 'line_num'):
            raise AttributeError('readonly attribute')
        _no_new_attribute(self, name)

    def __iter__(self):
        return self

    __next__ = _reader_next


_c_type_name(reader, '_csv.reader')
_reader_type = reader


class writer:
    """CSV writer

Writer objects are responsible for generating tabular data
in CSV format from sequence input.
"""

    __slots__ = ('_write', '_dialect')

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_csv.writer' instances")

    dialect = property(lambda self: self._dialect)

    def __setattr__(self, name, value):
        if name == 'dialect':
            raise AttributeError('readonly attribute')
        _no_new_attribute(self, name)

    def writerow(self, row, /):
        """writerow(iterable)

Construct and write a CSV record from an iterable of fields.  Non-string
elements will be converted to string."""
        dialect = self._dialect
        quoting = dialect.quoting
        try:
            fields = iter(row)
        except TypeError:
            raise Error(f'iterable expected, not {type(row).__name__}') from None
        parts = []
        null_field = False
        for field in fields:
            if quoting == QUOTE_NONNUMERIC:
                quoted = not _is_number(field)
            elif quoting == QUOTE_ALL:
                quoted = True
            elif quoting == QUOTE_STRINGS:
                quoted = isinstance(field, str)
            elif quoting == QUOTE_NOTNULL:
                quoted = field is not None
            else:
                quoted = False
            null_field = field is None
            if null_field:
                text = ''
            elif isinstance(field, str):
                text = field
            else:
                text = str(field)
            if not text and dialect.delimiter == ' ' and dialect.skipinitialspace:
                if quoting == QUOTE_NONE or (null_field and (quoting == QUOTE_STRINGS or quoting == QUOTE_NOTNULL)):
                    raise Error('empty field must be quoted if delimiter is a space '
                                'and skipinitialspace is true')
                quoted = True
            parts.append(_join_field(dialect, text, quoted))
        if len(parts) == 1 and not parts[0]:
            if quoting == QUOTE_NONE or (null_field and (quoting == QUOTE_STRINGS or quoting == QUOTE_NOTNULL)):
                raise Error('single empty field record must be quoted')
            parts[0] = dialect.quotechar * 2
        return self._write(dialect.delimiter.join(parts) + dialect.lineterminator)

    def writerows(self, rows, /):
        """writerows(iterable of iterables)

Construct and write a series of iterables to a csv file.  Non-string
elements will be converted to string."""
        for row in rows:
            self.writerow(row)


_c_type_name(writer, '_csv.writer')
_writer_type = writer


def _is_number(value):
    cls = type(value)
    return (isinstance(value, (int, float, complex))
            or hasattr(cls, '__index__') or hasattr(cls, '__int__') or hasattr(cls, '__float__'))


def _join_field(dialect, text, quoted):
    delimiter = dialect.delimiter
    escapechar = dialect.escapechar
    quotechar = dialect.quotechar
    lineterminator = dialect.lineterminator
    quoting = dialect.quoting
    out = []
    for c in text:
        if (c == delimiter or c == escapechar or c == quotechar or c == '\n' or c == '\r'
                or c in lineterminator):
            want_escape = False
            if quoting == QUOTE_NONE:
                want_escape = True
            else:
                if c == quotechar:
                    if dialect.doublequote:
                        out.append(quotechar)
                    else:
                        want_escape = True
                elif c == escapechar:
                    want_escape = True
                if not want_escape:
                    quoted = True
            if want_escape:
                if escapechar is None:
                    raise Error('need to escape, but no escapechar set')
                out.append(escapechar)
        out.append(c)
    field = ''.join(out)
    return quotechar + field + quotechar if quoted else field


def reader(*args, **kwargs):
    """    csv_reader = reader(iterable [, dialect='excel']
                        [optional keyword args])
    for row in csv_reader:
        process(row)

The "iterable" argument can be any object that returns a line
of input for each iteration, such as a file object or a list.  The
optional "dialect" parameter is discussed below.  The function
also accepts optional keyword arguments which override settings
provided by the dialect.

The returned object is an iterator.  Each iteration returns a row
of the CSV file (which can span multiple input lines).
"""
    iterable, dialect = _unpack('reader', args, 2)
    self = object.__new__(_reader_type)
    init = object.__setattr__
    init(self, '_input', iter(iterable))
    init(self, '_dialect', _call_dialect(dialect, kwargs))
    init(self, '_line_num', 0)
    return self


def writer(*args, **kwargs):
    """    csv_writer = csv.writer(fileobj [, dialect='excel']
                            [optional keyword args])
    for row in sequence:
        csv_writer.writerow(row)

    [or]

    csv_writer = csv.writer(fileobj [, dialect='excel']
                            [optional keyword args])
    csv_writer.writerows(rows)

The "fileobj" argument can be any object that supports the file API.
"""
    output, dialect = _unpack('writer', args, 2)
    try:
        write = output.write
    except AttributeError:
        raise TypeError('argument 1 must have a "write" method') from None
    self = object.__new__(_writer_type)
    init = object.__setattr__
    init(self, '_write', write)
    init(self, '_dialect', _call_dialect(dialect, kwargs))
    return self


def register_dialect(*args, **kwargs):
    """Create a mapping from a string name to a dialect class.
    dialect = csv.register_dialect(name[, dialect[, **fmtparams]])"""
    name, dialect = _unpack('register_dialect', args, 2)
    if not isinstance(name, str):
        raise TypeError('dialect name must be a string')
    _dialects[name] = _call_dialect(dialect, kwargs)


def unregister_dialect(name):
    """Delete the name/dialect mapping associated with a string name.

    csv.unregister_dialect(name)"""
    try:
        del _dialects[name]
    except KeyError:
        raise Error('unknown dialect') from None


def get_dialect(name):
    """Return the dialect instance associated with name.

    dialect = csv.get_dialect(name)"""
    try:
        return _dialects[name]
    except KeyError:
        raise Error('unknown dialect') from None


def list_dialects():
    """Return a list of all know dialect names.

    names = csv.list_dialects()"""
    return list(_dialects)


def field_size_limit(*args, **kwargs):
    """Sets an upper limit on parsed fields.

    csv.field_size_limit([limit])

Returns old limit. If limit is not given, no new limit is set and
the old limit is returned"""
    global _field_limit
    if len(args) + len(kwargs) > 1:
        raise TypeError(f'field_size_limit() takes at most 1 argument ({len(args) + len(kwargs)} given)')
    for key in kwargs:
        if key != 'new_limit':
            raise TypeError(f"field_size_limit() got an unexpected keyword argument '{key}'")
    old = _field_limit
    if args or kwargs:
        limit = args[0] if args else kwargs['new_limit']
        if type(limit) is not int:
            raise TypeError('limit must be an integer')
        if not -2**63 <= limit < 2**63:
            raise OverflowError('Python int too large to convert to C ssize_t')
        _field_limit = limit
    return old


reader = _builtin_function(reader)
writer = _builtin_function(writer)
register_dialect = _builtin_function(register_dialect)
unregister_dialect = _builtin_function(unregister_dialect)
get_dialect = _builtin_function(get_dialect)
list_dialects = _builtin_function(list_dialects)
field_size_limit = _builtin_function(field_size_limit)
del _c_type_name, _builtin_function, _reader_next
`;

registerSourceModule(
  '_csv',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_reader_next',
        new PyBuiltinFunction(
          wrapperDescriptorClass,
          '__next__',
          ([self]) => readerNext(self),
          undefined,
          'method',
          '_csv.reader'
        ),
      ],
      [
        '_builtin_function',
        // Makes the module's functions builtin functions, as CPython's C functions are, which their reprs show.
        nativeFunction('_builtin_function', ([fn]) =>
          nativeFunction((fn as PyFunction).name, (args, kwargs) => callValue(fn, args, kwargs))
        ),
      ],
    ])
);
