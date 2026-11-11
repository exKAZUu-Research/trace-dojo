import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// CPython 3.14.10 gives these values for the same expressions.
test('re matches, groups, substitutes, and splits as CPython does', () => {
  const program = String.raw`import re
actual = [
    repr(re.search(r'(\d+)-(\d+)', 'tel: 03-1234')),
    repr(re.match(r'(a|ab)(c|bcd)(d*)', 'abcd').groups()),
    repr(re.findall(r'(\w)(\d)?', 'a1b')),
    repr(re.sub('x*', '-', 'abxd')),
    repr(re.split(r'(\W+)', '...words, words...')),
    repr(re.sub(r'(?P<y>\d{4})-(?P<m>\d\d)', r'\g<m>/\g<y>', '2024-03')),
    repr([m.span() for m in re.finditer(r'\w*', 'ab cd')]),
    repr(re.match(r'(?:(a)|(b))+', 'ab').lastindex),
    repr(re.findall(r'(?i)[a-z]+', 'Kelvin\u212a ſ')),
    repr(re.findall(r'\d+', '今日は２０２４年3月')),
    repr(re.match(r'(?:x?|y)*+z', 'xyxz')),
    repr(re.fullmatch(r'a*?', 'aaa')),
    repr(re.I | re.M),
    repr(re.compile(r'\bword\b', re.I | re.X)),
    repr(re.subn(r'(?m)^', '> ', 'a\nb')),
    repr(re.match(r"\\", "\\")),
]
expected = ["<re.Match object; span=(5, 12), match='03-1234'>", "('a', 'bcd', '')", "[('a', '1'), ('b', '')]", "'-a-b--d-'", "['', '...', 'words', ', ', 'words', '...', '']", "'03/2024'", '[(0, 2), (2, 2), (3, 5), (5, 5)]', '2', "['Kelvin\u212a', 'ſ']", "['２０２４', '3']", 'None', "<re.Match object; span=(0, 3), match='aaa'>", 're.IGNORECASE|re.MULTILINE', "re.compile('\\\\bword\\\\b', re.IGNORECASE|re.VERBOSE)", "('> a\\n> b', 2)", "<re.Match object; span=(0, 1), match='\\\\'>"]
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(a + ' != ' + e)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  [
    'an unclosed group',
    "import re\nre.compile('(a')",
    're.PatternError: missing ), unterminated subpattern at position 0',
  ],
  [
    'a bad escape on a later line',
    "import re\nre.compile('a\\n\\\\q')",
    String.raw`re.PatternError: bad escape \q at position 2 (line 2, column 1)`,
  ],
  ['an unknown group in a template', "import re\nre.sub('(a)', r'\\g<x>', 'a')", "IndexError: unknown group name 'x'"],
])('%s raises the error CPython raises', (_, source, description) => {
  expect(executeProgram('python', source)).toMatchObject({ kind: 'executed', uncaughtException: description });
});

test('catastrophic backtracking ends with the operations limit', () => {
  const startedAt = performance.now();
  expect(executeProgram('python', "import re\nre.match(r'(a+)+b', 'a' * 40)")).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
  expect(performance.now() - startedAt).toBeLessThan(5000);
});

// CPython 3.14.10 gives these values for the same expressions.
test('RegexFlag is an IntFlag, and re.DEBUG prints the parsed pattern and its code as CPython does', () => {
  const program = String.raw`import re, io, contextlib, collections
out = io.StringIO()
with contextlib.redirect_stdout(out):
    re.compile('ab*', re.DEBUG)
actual = [
    repr(isinstance(re.I, int)), format(re.I | re.M, 'd'), '%d %x %s' % (re.I, re.M, re.I), repr(~re.I),
    repr(re.RegexFlag(1024)), type(re.match('a', 'a')).__name__, out.getvalue(),
]
try:
    collections.deque() + []
except TypeError as e:
    actual.append(str(e))
try:
    re.match('a', 'a').x
except AttributeError as e:
    actual.append(str(e))
expected = ['True', '10', '2 8 re.IGNORECASE', 're.ASCII|re.LOCALE|re.UNICODE|re.MULTILINE|re.DOTALL|re.VERBOSE|re.DEBUG|0x1', 're.RegexFlag(1024)', 'Match', "LITERAL 97\nMAX_REPEAT 0 MAXREPEAT\n  LITERAL 98\n\n 0. INFO 8 0b1 1 MAXREPEAT (to 9)\n      prefix_skip 1\n      prefix [0x61] ('a')\n      overlap [0]\n 9: LITERAL 0x61 ('a')\n11. REPEAT_ONE 6 0 MAXREPEAT (to 18)\n15.   LITERAL 0x62 ('b')\n17.   SUCCESS\n18: SUCCESS\n", 'can only concatenate deque (not "list") to deque', "'re.Match' object has no attribute 'x'"]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});
