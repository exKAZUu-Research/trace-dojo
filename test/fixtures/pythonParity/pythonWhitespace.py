from collections import namedtuple
s = '﻿alpha﻿beta'
spaces = ''.join(chr(c) for c in range(70000) if chr(c).isspace())
got = [s.strip(), s.split(), '﻿'.isspace(), '\x1c'.isspace(), '\x85'.isspace(), '　a　'.strip(), 'a\x1fb'.split(), [ord(c) for c in spaces]]
for text in [' ﻿1', '\x1c1', '\x851', '　1　', ' 1 ']:
    row = []
    for f in (int, float, complex):
        try:
            row.append(f(text))
        except ValueError:
            row.append('VE')
    got.append(row)
got.append(namedtuple('P', 'a\x1cb　c')._fields)
expected = [s, [s], False, True, True, 'a', ['a', 'b'], [9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288], ['VE', 'VE', 'VE'], ['VE', 'VE', 'VE'], [1, 1.0, 1 + 0j], [1, 1.0, 1 + 0j], [1, 1.0, 1 + 0j], ('a', 'b', 'c')]
if got != expected:
    raise AssertionError(got)
