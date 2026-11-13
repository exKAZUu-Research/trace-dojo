high = chr(55357)
low = chr(56832)
e = chr(128512)
s = 'a' + e + 'b' + e + 'ab' + low + 'a' + e
long_needle = (e + 'ab') * 4
text = 'x' + long_needle + e + 'ab' + long_needle + 'y'

got = [
    s.find(e), s.rfind(e), s.find(e, 2), s.rfind(e, 0, 4), s.count(e), s.count(e, 2, 4),
    s.find(low), s.find(high), s.count(low), low in s, high in s, (low + 'a') in s,
    s.find(''), s.rfind(''), s.find('', 4, 2), s.find('', 99), s.count('', 3), s.count('', 99),
    s.index('ab'), s.rindex('a', 0, 8), s.startswith(e, 1), s.endswith(e), s.endswith('a', 0, 9),
    s.startswith(high, 1), s.endswith(low), s.startswith(('z', 'b'), 2),
    s.split(e), s.rsplit(e, 1), s.split(low), s.split(e, 1),
    s.partition(e), s.rpartition(e), s.partition(high),
    s.replace(e, '-'), s.replace(e, '-', 2), s.replace(low, '+'), s.replace(high, '+'),
    s.removeprefix('a' + e), s.removesuffix(e), s.removesuffix(low),
    s.strip('a' + e), s.rstrip(e),
    text.find(long_needle), text.rfind(long_needle), text.count(long_needle),
    text.find(long_needle, 2), text.rfind(long_needle, 0, 20), len(text.split(long_needle)),
    text.rsplit(long_needle, 1)[1], text.replace(long_needle, '#'),
    ('ab' * 20).count('ab' * 5), ('ab' * 20).rfind('ab' * 5 + 'a'), ('a' * 30).rsplit('a' * 9, 2),
]
expected = [
    1, 8, 3, 3, 3, 1,
    6, -1, 1, True, False, True,
    0, 9, -1, -1, 7, 0,
    4, 7, True, True, False,
    False, False, True,
    ['a', 'b', 'ab' + low + 'a', ''], ['a' + e + 'b' + e + 'ab' + low + 'a', ''], ['a' + e + 'b' + e + 'ab', 'a' + e],
    ['a', 'b' + e + 'ab' + low + 'a' + e],
    ('a', e, 'b' + e + 'ab' + low + 'a' + e), ('a' + e + 'b' + e + 'ab' + low + 'a', e, ''), (s, '', ''),
    'a-b-ab' + low + 'a-', 'a-b-ab' + low + 'a' + e, 'a' + e + 'b' + e + 'ab+a' + e, s,
    'b' + e + 'ab' + low + 'a' + e, 'a' + e + 'b' + e + 'ab' + low + 'a', s,
    'b' + e + 'ab' + low, 'a' + e + 'b' + e + 'ab' + low + 'a',
    1, 16, 2,
    4, 7, 3,
    'y', 'x##' + e + 'aby',
    4, 28, ['a' * 12, '', ''],
]
if got != expected:
    raise AssertionError([(index, g, x) for index, (g, x) in enumerate(zip(got, expected)) if g != x])
