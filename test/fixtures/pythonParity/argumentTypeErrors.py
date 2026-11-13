# Argument Clinic spells a None argument as None, while hand-written checks name its type; every attribute function
# checks that the name is a str.
import sys


class A:
    pass


calls = [lambda: 'ab'.count(None), lambda: 'ab'.find(None), lambda: 'ab'.rindex(None), lambda: format(1, None), lambda: float.__format__(1.0, None), lambda: object().__format__(None), lambda: int.__format__(1, None), lambda: sys.stdout.write(None), lambda: float.__getformat__(None), lambda: float.fromhex(None), lambda: Exception().add_note(None), lambda: Exception().add_note(1), lambda: 'ab'.replace(None, 'a'), lambda: 'ab'.removeprefix(None), lambda: str.maketrans('a', None), lambda: 'ab'.partition(None), lambda: 'ab'.startswith(None), lambda: 'ab'.count(1), lambda: delattr(A(), None), lambda: delattr(A(), 1), lambda: A().__getattribute__(None), lambda: getattr(A(), None), lambda: setattr(A(), [], 1), lambda: hasattr(A(), 2.5), lambda: A().__setattr__(None, 1), lambda: A().__delattr__(None)]
messages = []
for call in calls:
    try:
        call()
    except TypeError as error:
        messages.append(str(error))
expected = ['count() argument 1 must be str, not None', 'find() argument 1 must be str, not None', 'rindex() argument 1 must be str, not None', 'format() argument 2 must be str, not None', '__format__() argument must be str, not None', '__format__() argument must be str, not None', '__format__() argument must be str, not None', 'write() argument must be str, not None', '__getformat__() argument must be str, not None', 'bad argument type for built-in operation', 'add_note() argument must be str, not None', 'add_note() argument must be str, not int', 'replace() argument 1 must be str, not None', 'removeprefix() argument must be str, not None', 'maketrans() argument 2 must be str, not None', 'must be str, not NoneType', 'startswith first arg must be str or a tuple of str, not NoneType', 'count() argument 1 must be str, not int', "attribute name must be string, not 'NoneType'", "attribute name must be string, not 'int'", "attribute name must be string, not 'NoneType'", "attribute name must be string, not 'NoneType'", "attribute name must be string, not 'list'", "attribute name must be string, not 'float'", "attribute name must be string, not 'NoneType'", "attribute name must be string, not 'NoneType'"]
if messages != expected:
    raise AssertionError(messages)
