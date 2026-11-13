import heapq, json, math, operator, sys
def outcome(f):
    try: return repr(f())
    except Exception as e: return type(e).__name__ + ': ' + str(e)
class LH:
    def __len__(self): return 1
    def __length_hint__(self): return None
class F:
    def __format__(self, spec): return None
def f(*a, **k): pass
cases = [
 ('heapify', lambda: heapq.heapify(None)), ('heappush', lambda: heapq.heappush(None, 1)), ('heappop', lambda: heapq.heappop(None)),
 ('heappushpop', lambda: heapq.heappushpop(None, 1)), ('heapreplace', lambda: heapq.heapreplace(None, 1)),
 ('heapify_max', lambda: heapq.heapify_max(None)), ('heappush_max', lambda: heapq.heappush_max(None, 1)), ('heappop_max', lambda: heapq.heappop_max(None)),
 ('heappushpop_max', lambda: heapq.heappushpop_max(None, 1)), ('heapreplace_max', lambda: heapq.heapreplace_max(None, 1)),
 ('super', lambda: super(None, 1)),
 ('star', lambda: f(*None)), ('dstar', lambda: f(**None)), ('complex', lambda: complex(None)), ('complex imag', lambda: complex(1, None)),
 ('ExceptionGroup', lambda: ExceptionGroup(None, [ValueError()])), ('json.loads', lambda: json.loads(None)),
 ('%c', lambda: '%c' % None), ('%d', lambda: '%d' % None), ('%x', lambda: '%x' % None), ('%f', lambda: '%f' % None),
 ('list index', lambda: [1][None]), ('range index', lambda: range(3)[None]), ('str index', lambda: 'a'[None]), ('tuple index', lambda: (1,)[None]),
 ('in str', lambda: None in 'a'), ('star display', lambda: [*None]),
 ('print sep', lambda: print(1, sep=1)), ('print end', lambda: print(1, end=1)),
 ('startswith', lambda: 'a'.startswith(None)), ('startswith tuple', lambda: 'a'.startswith((None,))),
 ('json key', lambda: json.dumps({(1,): 1})), ('format result', lambda: format(F())),
 ('reconfigure', lambda: sys.stdout.reconfigure(encoding=None) or sys.stdout.reconfigure(errors=1)),
 ('math.sqrt', lambda: math.sqrt(None)), ('round', lambda: round(None)), ('float.__round__', lambda: (1.5).__round__(None)),
 ('length_hint', lambda: operator.length_hint(LH())),
]
out = [name + ' | ' + outcome(c) for name, c in cases]
expected = ['heapify | TypeError: heapify() argument must be list, not None', 'heappush | TypeError: heappush() argument 1 must be list, not None', 'heappop | TypeError: heappop() argument must be list, not None', 'heappushpop | TypeError: heappushpop() argument 1 must be list, not None', 'heapreplace | TypeError: heapreplace() argument 1 must be list, not None', 'heapify_max | TypeError: heapify_max() argument must be list, not None', 'heappush_max | TypeError: heappush_max() argument 1 must be list, not None', 'heappop_max | TypeError: heappop_max() argument must be list, not None', 'heappushpop_max | TypeError: heappushpop_max() argument 1 must be list, not None', 'heapreplace_max | TypeError: heapreplace_max() argument 1 must be list, not None', 'super | TypeError: super() argument 1 must be a type, not NoneType', 'star | TypeError: __main__.f() argument after * must be an iterable, not NoneType', 'dstar | TypeError: __main__.f() argument after ** must be a mapping, not NoneType', 'complex | TypeError: complex() argument must be a string or a number, not NoneType', "complex imag | TypeError: complex() argument 'imag' must be a real number, not NoneType", 'ExceptionGroup | TypeError: BaseExceptionGroup.__new__() argument 1 must be str, not None', 'json.loads | TypeError: the JSON object must be str, bytes or bytearray, not NoneType', '%c | TypeError: %c requires an int or a unicode character, not NoneType', '%d | TypeError: %d format: a real number is required, not NoneType', '%x | TypeError: %x format: an integer is required, not NoneType', '%f | TypeError: must be real number, not NoneType', 'list index | TypeError: list indices must be integers or slices, not NoneType', 'range index | TypeError: range indices must be integers or slices, not NoneType', "str index | TypeError: string indices must be integers, not 'NoneType'", 'tuple index | TypeError: tuple indices must be integers or slices, not NoneType', "in str | TypeError: 'in <string>' requires string as left operand, not NoneType", 'star display | TypeError: Value after * must be an iterable, not NoneType', 'print sep | TypeError: sep must be None or a string, not int', 'print end | TypeError: end must be None or a string, not int', 'startswith | TypeError: startswith first arg must be str or a tuple of str, not NoneType', 'startswith tuple | TypeError: tuple for startswith must only contain str, not NoneType', 'json key | TypeError: keys must be str, int, float, bool or None, not tuple', 'format result | TypeError: __format__ must return a str, not NoneType', "reconfigure | TypeError: reconfigure() argument 'errors' must be str or None, not int", 'math.sqrt | TypeError: must be real number, not NoneType', "round | TypeError: type NoneType doesn't define __round__ method", 'float.__round__ | 2', 'length_hint | 1']
if out != expected:
    raise AssertionError([(a, b) for a, b in zip(out, expected) if a != b])
