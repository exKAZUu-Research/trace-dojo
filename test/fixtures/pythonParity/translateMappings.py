# str.translate checks an integer mapping's range, and takes a bool as the integer it is.
got = []
for table in [{97: -1}, {97: 1114112}, {97: 2 ** 70}, {97: 1114111}, {97: True}, {97: 1.5}, {97: 'xy'}, {97: None}]:
    try:
        got.append(ascii('abc'.translate(table)))
    except (ValueError, TypeError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
expected = ['ValueError: character mapping must be in range(0x110000)', 'ValueError: character mapping must be in range(0x110000)', 'ValueError: character mapping must be in range(0x110000)', "'\\U0010ffffbc'", "'\\x01bc'", 'TypeError: character mapping must return integer, None or str', "'xybc'", "'bc'"]
if got != expected:
    raise AssertionError(got)
# str.maketrans checks a dict's keys before converting them.
got = []
for table in [{'': 'x'}, {'ab': 'x'}, {1.5: 'x'}]:
    try:
        str.maketrans(table)
    except (ValueError, TypeError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
got += [str.maketrans({'a': 1, 'b': None}), str.maketrans({-1: 'x'}), str.maketrans({True: 'x'})]
if got != ['ValueError: string keys in translatetable must be of length 1', 'ValueError: string keys in translatetable must be of length 1', 'TypeError: keys in translate table mustbe strings or integers', {97: 1, 98: None}, {-1: 'x'}, {True: 'x'}]:
    raise AssertionError(got)
