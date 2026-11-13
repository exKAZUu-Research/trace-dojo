import functools


def check(actual, expected):
    if actual != expected:
        raise AssertionError(str(actual) + ' != ' + str(expected))


nan = float('nan')
check(str(sorted([3, nan, 1, 2])), '[3, nan, 1, 2]')
check(str(sorted([3, nan, 1, 2], reverse=True)), '[2, 3, nan, 1]')
check(str(sorted([2.0, 1.0, nan, 0.0, 5.0, nan, 4.0, 3.0])), '[1.0, nan, 0.0, 2.0, 5.0, nan, 3.0, 4.0]')


def error_of(items, reverse=False):
    try:
        sorted(items, reverse=reverse)
    except TypeError as e:
        return str(e)


check(error_of([3, None, 1]), "'<' not supported between instances of 'NoneType' and 'int'")
check(error_of([3, None, 1], True), "'<' not supported between instances of 'NoneType' and 'int'")
check(error_of([1, 2, 'a', 3]), "'<' not supported between instances of 'str' and 'int'")
check(error_of([(1,), 2.5, 1]), "'<' not supported between instances of 'float' and 'tuple'")
check(error_of([1, 2, 3, 2.5, None, 'a']), "'<' not supported between instances of 'NoneType' and 'float'")

log = []


class V:
    def __init__(self, v):
        self.v = v

    def __lt__(self, other):
        log.append((self.v, other.v))
        return self.v < other.v


def pairs(values, **options):
    log.clear()
    items = [V(v) for v in values]
    items.sort(**options)
    return [x.v for x in items], list(log)


check(pairs([3, 1, 2]), ([1, 2, 3], [(1, 3), (2, 1), (1, 2), (2, 3), (2, 3), (2, 1)]))
check(pairs([3, 1, 2], reverse=True), ([3, 2, 1], [(1, 2), (3, 1), (1, 3), (3, 2)]))
check(
    pairs([5, 4, 4, 3, 6, 1]),
    (
        [1, 3, 4, 4, 5, 6],
        [(4, 5), (4, 4), (4, 4), (3, 4), (6, 3), (3, 6), (6, 5), (1, 6), (1, 4), (1, 4), (1, 3)],
    ),
)
check(
    pairs([1, 2, 2, 1, 0, 3, 2], key=lambda x: V(-x.v)),
    (
        [3, 2, 2, 2, 1, 1, 0],
        [
            (-2, -1), (-2, -2), (-2, -2), (-1, -2), (-2, -1), (-1, -1), (0, -1),
            (-3, 0), (-3, -1), (-3, -2), (-3, -2), (-2, -1), (-2, -2), (-2, -2),
        ],
    ),
)


def digest(values, **options):
    result, logged = pairs(values, **options)
    h = 0
    for a, b in logged:
        h = (h * 1000003 + a * 131 + b + 1) % 1000000007
    return result == sorted(values, reverse=options.get('reverse', False)), len(logged), h


# Long enough to be split into runs that are merged.
shuffled = [(i * 7919) % 101 for i in range(200)]
check(digest(shuffled), (True, 1265, 293612049))
check(digest(shuffled, reverse=True), (True, 1274, 129280056))
# Ascending and descending runs of 37 items, which the merges gallop through.
runs = [(i % 37) * (1 - 2 * ((i // 37) % 2)) + i // 50 for i in range(1000)]
check(digest(runs), (True, 4982, 74664822))
check(digest(runs, reverse=True), (True, 7858, 15055876))

calls = []


def compare(a, b):
    calls.append((a, b))
    return a % 10 - b % 10


check(sorted([31, 12, 22, 41, 3], key=functools.cmp_to_key(compare)), [31, 41, 12, 22, 3])
check(calls, [(12, 31), (22, 12), (41, 22), (31, 22), (41, 12), (41, 31), (3, 12), (3, 22)])


class Failing(V):
    def __lt__(self, other):
        if len(log) == 150:
            raise RuntimeError('stop')
        return V.__lt__(self, other)


def after_failure(**options):
    log.clear()
    items = [Failing(v) for v in shuffled]
    try:
        items.sort(**options)
    except RuntimeError:
        h = 0
        for x in items:
            h = (h * 1000003 + x.v) % 1000000007
        return len(items), h, [x.v for x in items[:8]]


check(after_failure(), (200, 970708425, [0, 2, 3, 6, 9, 12, 15, 18]))
check(after_failure(reverse=True), (200, 340902311, [0, 41, 82, 22, 63, 3, 44, 85]))


class Mutating(V):
    def __lt__(self, other):
        target.append(V(0))
        target.pop()
        return self.v < other.v


target = [Mutating(2), Mutating(1)]
try:
    target.sort()
    raise AssertionError('the sort did not notice the mutation')
except ValueError as e:
    check(str(e), 'list modified during sort')
check([x.v for x in target], [1, 2])
