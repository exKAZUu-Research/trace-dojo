import json


def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


loop = []
loop.append(loop)
shared = [[]]
check(lambda: json.dumps([[], {}, [[]], {"a": []}, (), "é\n\"", 1.5, None, True, 10**30, float("inf")]), '\'[[], {}, [[]], {"a": []}, [], "\\\\u00e9\\\\n\\\\"", 1.5, null, true, 1000000000000000000000000000000, Infinity]\'')
check(lambda: json.dumps({"b": [1, {"c": "d"}], "a": 2, 3: 4, None: 5, True: [[]]}, indent=2), '\'{\\n  "b": [\\n    1,\\n    {\\n      "c": "d"\\n    }\\n  ],\\n  "a": 2,\\n  "3": 4,\\n  "null": 5,\\n  "true": [\\n    []\\n  ]\\n}\'')
check(lambda: json.dumps({"b": 1, "a": [1, 2, {}]}, indent="\t", sort_keys=True, ensure_ascii=False, separators=(",", ":")), '\'{\\n\\t"a":[\\n\\t\\t1,\\n\\t\\t2,\\n\\t\\t{}\\n\\t],\\n\\t"b":1\\n}\'')
check(lambda: json.dumps(list(range(3)), indent=0), "'[\\n0,\\n1,\\n2\\n]'")
check(lambda: json.dumps({1: {2: {3: []}}}, indent=1), '\'{\\n "1": {\\n  "2": {\\n   "3": []\\n  }\\n }\\n}\'')
check(lambda: len(json.dumps(["x" * 999990])), '999994')
check(lambda: len(json.dumps([[]] * 249999)), '999996')
check(lambda: json.dumps({(1, 2): 3, "a": [[], []]}, skipkeys=True), '\'{"a": [[], []]}\'')
check(lambda: json.dumps([1, [2, [3, set()]]], default=list), "'[1, [2, [3, []]]]'")
check(lambda: json.dumps("\u2028\x7f\x00é", ensure_ascii=True), '\'"\\\\u2028\\\\u007f\\\\u0000\\\\u00e9"\'')
check(lambda: json.dumps([shared, shared, shared[0], shared[0]]), "'[[[]], [[]], [], []]'")
check(lambda: json.dumps(loop), 'ValueError: Circular reference detected')
check(lambda: json.dumps({(1, 2): 3}), 'TypeError: keys must be str, int, float, bool or None, not tuple')
check(lambda: json.dumps([float("nan")], allow_nan=False), 'ValueError: Out of range float values are not JSON compliant: nan')
check(lambda: json.dumps(set()), 'TypeError: Object of type set is not JSON serializable')

# Members of enums whose members are ints or strs encode as those values, as values and as keys.
from enum import Enum, IntEnum, IntFlag, StrEnum


class Color(StrEnum):
    RED = 'red'


class Perm(IntFlag):
    R = 1
    W = 2


class Level(IntEnum):
    HIGH = 3


class Plain(Enum):
    ONE = 1


check(lambda: json.dumps({'color': Color.RED, 'perm': Perm.R | Perm.W, 'level': Level.HIGH, Color.RED: 1, Perm.W: 2, Level.HIGH: 3}), repr('{"color": "red", "perm": 3, "level": 3, "red": 1, "2": 2, "3": 3}'))
check(lambda: json.dumps(Plain.ONE), 'TypeError: Object of type Plain is not JSON serializable')
