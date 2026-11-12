# Only %% escapes a percent sign; after a key, flag, width, precision, or length, % is a conversion that takes an
# argument and is then refused.
got = []
for tpl, arg in [('%5%', ()), ('%05%', ()), ('%-%', ()), ('%+%', ()), ('%5%', 3), ('%*%', (3,)), ('%*%', (3, 4)), ('%%', ()), ('%d%%', 5), ('%5.1f%%', 12.345), ('%(a)%', {'a': 1}), ('%(a)%', {}), ('%.%', 1), ('%l%', ()), ('a%%b%sc', 'x'), ('%h%', 1)]:
    try:
        got.append(tpl % arg)
    except (TypeError, ValueError, KeyError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
if got != ['TypeError: not enough arguments for format string', 'TypeError: not enough arguments for format string', 'TypeError: not enough arguments for format string', 'TypeError: not enough arguments for format string', "ValueError: unsupported format character '%' (0x25) at index 2", 'TypeError: not enough arguments for format string', "ValueError: unsupported format character '%' (0x25) at index 2", '%', '5%', ' 12.3%', "ValueError: unsupported format character '%' (0x25) at index 4", "KeyError: 'a'", "ValueError: unsupported format character '%' (0x25) at index 2", 'TypeError: not enough arguments for format string', 'a%bxc', "ValueError: unsupported format character '%' (0x25) at index 2"]:
    raise AssertionError(got)

# A conversion takes at most one length modifier; a second is read as the conversion character.
got = []
for tpl in ['%lld', '%lldd', '%hhd', '%LLd', '%ll%', '%lh%d', '%lll%', '%ld', '%hd', '%Ld', '%5.2lf']:
    try:
        got.append(tpl % 3)
    except ValueError as error:
        got.append(str(error))
expected = ["unsupported format character 'l' (0x6c) at index 2", "unsupported format character 'l' (0x6c) at index 2", "unsupported format character 'h' (0x68) at index 2", "unsupported format character 'L' (0x4c) at index 2", "unsupported format character 'l' (0x6c) at index 2", "unsupported format character 'h' (0x68) at index 2", "unsupported format character 'l' (0x6c) at index 2", '3', '3', '3', ' 3.00']
if got != expected:
    raise AssertionError(got)
