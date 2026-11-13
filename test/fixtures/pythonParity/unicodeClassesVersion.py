from collections import namedtuple

def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

# These code points are assigned after Unicode 16.0.0, CPython 3.14's version, so they are unassigned there.
late = [chr(2191), chr(3164), chr(6863), chr(8385)]
check([repr(c) for c in late], ["'\\u088f'", "'\\u0c5c'", "'\\u1acf'", "'\\u20c1'"])
check([[c.isalpha(), c.isalnum(), c.isprintable(), c.isidentifier()] for c in late], [[False] * 4] * 4)
check(['京'.isnumeric(), '_x'.isidentifier(), '1a'.isidentifier(), 'é'.isalpha(), ' '.isprintable(), '​'.isprintable()], [True, True, False, True, False, False])
check([repr('a​b c\x7f'), '{:٣}|'.format('x'), format(5, '٠٣d')], ["'a\\u200bb\\xa0c\\x7f'", 'x  |', '  5'])
try:
    namedtuple('P', ['a', chr(2191)])
except ValueError as e:
    check(str(e), "Type names and field names must be valid identifiers: '\\u088f'")
check(repr(namedtuple('Q', ['é', 'x'])(1, 2)), 'Q(é=1, x=2)')
