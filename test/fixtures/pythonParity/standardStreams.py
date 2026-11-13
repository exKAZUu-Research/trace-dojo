import sys


def attributes(stream):
    # isatty() and line_buffering depend on whether the stream is a terminal, so they are left out.
    names = ['encoding', 'errors', 'closed', 'name', 'mode', 'write_through', 'newlines']
    return [getattr(stream, name) for name in names]


def predicates(stream):
    return [stream.writable(), stream.readable(), stream.flush()]


def assign(name):
    setattr(sys.stdout, name, 1)


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: attributes(sys.stdout), "['utf-8', 'strict', False, '<stdout>', 'w', False, None]")
check(lambda: predicates(sys.stdout), '[True, False, None]')
check(lambda: repr(sys.stdout), '"<_io.TextIOWrapper name=\'<stdout>\' mode=\'w\' encoding=\'utf-8\'>"')
check(lambda: attributes(sys.stderr), "['utf-8', 'backslashreplace', False, '<stderr>', 'w', False, None]")
check(lambda: predicates(sys.stderr), '[True, False, None]')
check(lambda: repr(sys.stderr), '"<_io.TextIOWrapper name=\'<stderr>\' mode=\'w\' encoding=\'utf-8\'>"')
check(lambda: sys.stdout.writelines(['', '']), 'None')
check(lambda: sys.stdout.writelines(part for part in ['']), 'None')
check(lambda: sys.stdout.write(''), '0')
check(lambda: sys.stderr.write('abc'), '3')
check(lambda: sys.stderr.writelines(['x', 'y']), 'None')
check(lambda: sys.stdout.writelines([1]), 'TypeError: write() argument must be str, not int')
check(lambda: sys.stdout.writelines(3), "TypeError: 'int' object is not iterable")
check(lambda: sys.stdout.writelines(), 'TypeError: _IOBase.writelines() takes exactly one argument (0 given)')
check(lambda: sys.stdout.write(), 'TypeError: TextIOWrapper.write() takes exactly one argument (0 given)')
check(lambda: sys.stdout.write(1), 'TypeError: write() argument must be str, not int')
check(lambda: sys.stdout.isatty(1), 'TypeError: TextIOWrapper.isatty() takes no arguments (1 given)')
check(lambda: sys.stdout.flush(1), 'TypeError: TextIOWrapper.flush() takes no arguments (1 given)')
check(lambda: sys.stdout.reconfigure(encoding='utf-8'), 'None')
check(lambda: (sys.stdout.encoding, sys.stdout.errors), "('utf-8', 'strict')")
check(lambda: sys.stdout.reconfigure(encoding='UTF8', errors='replace', newline='\n', line_buffering=True, write_through=True), 'None')
check(lambda: (sys.stdout.encoding, sys.stdout.errors, sys.stdout.line_buffering, sys.stdout.write_through), "('UTF8', 'replace', True, True)")
check(lambda: sys.stdout.reconfigure(encoding='utf-8'), 'None')
check(lambda: (sys.stdout.encoding, sys.stdout.errors), "('utf-8', 'strict')")
check(lambda: sys.stdout.reconfigure(errors='backslashreplace', line_buffering=None, write_through=0), 'None')
check(lambda: (sys.stdout.errors, sys.stdout.line_buffering, sys.stdout.write_through), "('backslashreplace', True, False)")
check(lambda: sys.stdout.reconfigure(errors='strict', line_buffering=False, newline=''), 'None')
check(lambda: sys.stdout.reconfigure('utf-8'), 'TypeError: reconfigure() takes no positional arguments')
check(lambda: sys.stdout.reconfigure(foo=1), "TypeError: reconfigure() got an unexpected keyword argument 'foo'")
check(lambda: sys.stdout.reconfigure(encoding=3), "TypeError: reconfigure() argument 'encoding' must be str or None, not int")
check(lambda: sys.stdout.reconfigure(errors=3), "TypeError: reconfigure() argument 'errors' must be str or None, not int")
check(lambda: sys.stdout.reconfigure(newline='x'), 'ValueError: illegal newline value: x')
check(lambda: sys.stdout.reconfigure(newline=3), "TypeError: reconfigure() argument 'newline' must be str or None, not int")
check(lambda: sys.stdout.reconfigure(line_buffering='x'), "TypeError: 'str' object cannot be interpreted as an integer")
check(lambda: assign('encoding'), 'AttributeError: readonly attribute')
check(lambda: assign('errors'), "AttributeError: attribute 'errors' of '_io.TextIOWrapper' objects is not writable")
check(lambda: assign('closed'), "AttributeError: attribute 'closed' of '_io.TextIOWrapper' objects is not writable")
check(lambda: assign('name'), "AttributeError: attribute 'name' of '_io.TextIOWrapper' objects is not writable")
check(lambda: assign('line_buffering'), 'AttributeError: readonly attribute')
check(lambda: assign('newlines'), "AttributeError: attribute 'newlines' of '_io.TextIOWrapper' objects is not writable")
check(lambda: assign('note'), 'None')
check(lambda: sys.stdout.note, '1')
check(lambda: sys.stdout.missing, "AttributeError: '_io.TextIOWrapper' object has no attribute 'missing'")
check(lambda: type(sys.stdout), "<class '_io.TextIOWrapper'>")
