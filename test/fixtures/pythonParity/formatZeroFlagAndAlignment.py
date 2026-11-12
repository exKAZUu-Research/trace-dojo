def outcome(value, spec):
    try:
        direct = format(value, spec)
    except Exception as error:
        return type(error).__name__ + ": " + str(error)
    if f"{value:{spec}}" != direct or ("{:" + spec + "}").format(value) != direct:
        raise AssertionError((value, spec))
    return direct


values = ['ab', 42, -42, True, 1234.5, -0.0]
cases = [
    ('08', ['ab000000', '00000042', '-0000042', '00000001', '001234.5', '-00000.0']),
    ('<08', ['ab000000', '42000000', '-4200000', '10000000', '1234.500', '-0.00000']),
    ('>08', ['000000ab', '00000042', '00000-42', '00000001', '001234.5', '0000-0.0']),
    ('^08', ['000ab000', '00042000', '00-42000', '00010000', '01234.50', '00-0.000']),
    ('=08', ["ValueError: '=' alignment not allowed in string format specifier", '00000042', '-0000042', '00000001', '001234.5', '-00000.0']),
    ('x<08', ['abxxxxxx', '42xxxxxx', '-42xxxxx', '1xxxxxxx', '1234.5xx', '-0.0xxxx']),
    ('x=08', ["ValueError: '=' alignment not allowed in string format specifier", 'xxxxxx42', '-xxxxx42', 'xxxxxxx1', 'xx1234.5', '-xxxx0.0']),
    ('+08', ['ValueError: Sign not allowed in string format specifier', '+0000042', '-0000042', '+0000001', '+01234.5', '-00000.0']),
    ('<+08', ['ValueError: Sign not allowed in string format specifier', '+4200000', '-4200000', '+1000000', '+1234.50', '-0.00000']),
    ('^ 08', ['ValueError: Space not allowed in string format specifier', '00 42000', '00-42000', '000 1000', ' 1234.50', '00-0.000']),
    ('08,', ["ValueError: Cannot specify ',' with 's'.", '0,000,042', '-000,042', '0,000,001', '01,234.5', '-0,000.0']),
    ('<08,', ["ValueError: Cannot specify ',' with 's'.", '42000000', '-4200000', '10000000', '1,234.50', '-0.00000']),
    ('=010,', ["ValueError: Cannot specify ',' with 's'.", '00,000,042', '-0,000,042', '00,000,001', '0,001,234.5', '-000,000.0']),
    ('08.1f', ["ValueError: Unknown format code 'f' for object of type 'str'", '000042.0', '-00042.0', '000001.0', '001234.5', '-00000.0']),
    ('<08.1f', ["ValueError: Unknown format code 'f' for object of type 'str'", '42.00000', '-42.0000', '1.000000', '1234.500', '-0.00000']),
    ('^+010.2e', ["ValueError: Unknown format code 'e' for object of type 'str'", '+4.20e+010', '-4.20e+010', '+1.00e+000', '+1.23e+030', '-0.00e+000']),
    ('#010x', ["ValueError: Unknown format code 'x' for object of type 'str'", '0x0000002a', '-0x000002a', '0x00000001', "ValueError: Unknown format code 'x' for object of type 'float'", "ValueError: Unknown format code 'x' for object of type 'float'"]),
    ('<#010x', ["ValueError: Unknown format code 'x' for object of type 'str'", '0x2a000000', '-0x2a00000', '0x10000000', "ValueError: Unknown format code 'x' for object of type 'float'", "ValueError: Unknown format code 'x' for object of type 'float'"]),
    ('=#010b', ["ValueError: Unknown format code 'b' for object of type 'str'", '0b00101010', '-0b0101010', '0b00000001', "ValueError: Unknown format code 'b' for object of type 'float'", "ValueError: Unknown format code 'b' for object of type 'float'"]),
    ('^010_X', ["ValueError: Unknown format code 'X' for object of type 'str'", '00002A0000', '000-2A0000', '0000100000', "ValueError: Unknown format code 'X' for object of type 'float'", "ValueError: Unknown format code 'X' for object of type 'float'"]),
    ('08s', ['ab000000', "ValueError: Unknown format code 's' for object of type 'int'", "ValueError: Unknown format code 's' for object of type 'int'", "ValueError: Unknown format code 's' for object of type 'bool'", "ValueError: Unknown format code 's' for object of type 'float'", "ValueError: Unknown format code 's' for object of type 'float'"]),
    ('08c', ["ValueError: Unknown format code 'c' for object of type 'str'", '0000000*', 'OverflowError: %c arg not in range(0x110000)', '0000000\x01', "ValueError: Unknown format code 'c' for object of type 'float'", "ValueError: Unknown format code 'c' for object of type 'float'"]),
    ('<08c', ["ValueError: Unknown format code 'c' for object of type 'str'", '*0000000', 'OverflowError: %c arg not in range(0x110000)', '\x010000000', "ValueError: Unknown format code 'c' for object of type 'float'", "ValueError: Unknown format code 'c' for object of type 'float'"]),
    ('08.1', ['a0000000', 'ValueError: Precision not allowed in integer format specifier', 'ValueError: Precision not allowed in integer format specifier', 'ValueError: Precision not allowed in integer format specifier', '0001e+03', '-000e+00']),
    ('0', ['ab', '42', '-42', '1', '1234.5', '-0.0']),
    ('<0', ['ab', '42', '-42', '1', '1234.5', '-0.0']),
    (' 08', ['ValueError: Space not allowed in string format specifier', ' 0000042', '-0000042', ' 0000001', ' 01234.5', '-00000.0']),
    ('#08', ['ValueError: Alternate form (#) not allowed in string format specifier', '00000042', '-0000042', '00000001', '001234.5', '-00000.0']),
    ('z08.0f', ["ValueError: Unknown format code 'f' for object of type 'str'", '00000042', '-0000042', '00000001', '00001234', '00000000']),
    ('08n', ["ValueError: Unknown format code 'n' for object of type 'str'", '00000042', '-0000042', '00000001', '001234.5', '-0000000']),
    ('012_._f', ["ValueError: Unknown format code 'f' for object of type 'str'", '0_042.000_000', '-042.000_000', '0_001.000_000', '1_234.500_000', '-000.000_000']),
    ('09,.1%', ["ValueError: Unknown format code '%' for object of type 'str'", '04,200.0%', '-4,200.0%', '00,100.0%', '123,450.0%', '-0,000.0%']),
    ('８', ['ab      ', '      42', '     -42', '       1', '  1234.5', '    -0.0']),
]
for spec, expected in cases:
    actual = [outcome(value, spec) for value in values]
    if actual != expected:
        raise AssertionError((spec, actual))
