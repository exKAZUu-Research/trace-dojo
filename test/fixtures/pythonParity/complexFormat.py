inf = float("inf")
nan = float("nan")
VALUES = [
    complex(3, 4),
    complex(0, 1),
    complex(-0.0, -2.5),
    complex(1234567.891, -7654321.125),
    complex(0.0000001, 123456789012345678.0),
    complex(inf, -inf),
    complex(nan, 0.0),
    complex(0.0, -0.0),
]
# Each format specification with what it gives for each of VALUES: the text, or the exception.
CASES = [
    ('.1f', ['3.0+4.0j', '0.0+1.0j', '-0.0-2.5j', '1234567.9-7654321.1j', '0.0+123456789012345680.0j', 'inf-infj', 'nan+0.0j', '0.0-0.0j']),
    ('>12', ['      (3+4j)', '          1j', '   (-0-2.5j)', '(1234567.891-7654321.125j)', '(1e-07+1.2345678901234568e+17j)', '  (inf-infj)', '    (nan+0j)', '         -0j']),
    ('*^14', ['****(3+4j)****', '******1j******', '**(-0-2.5j)***', '(1234567.891-7654321.125j)', '(1e-07+1.2345678901234568e+17j)', '**(inf-infj)**', '***(nan+0j)***', '*****-0j******']),
    ('<10.2e', ['3.00e+00+4.00e+00j', '0.00e+00+1.00e+00j', '-0.00e+00-2.50e+00j', '1.23e+06-7.65e+06j', '1.00e-07+1.23e+17j', 'inf-infj  ', 'nan+0.00e+00j', '0.00e+00-0.00e+00j']),
    ('+', ['(+3+4j)', '+1j', '(-0-2.5j)', '(+1234567.891-7654321.125j)', '(+1e-07+1.2345678901234568e+17j)', '(+inf-infj)', '(+nan+0j)', '-0j']),
    (' ', ['( 3+4j)', ' 1j', '(-0-2.5j)', '( 1234567.891-7654321.125j)', '( 1e-07+1.2345678901234568e+17j)', '( inf-infj)', '( nan+0j)', '-0j']),
    ('#', ['(3.+4.j)', '1.j', '(-0.-2.5j)', '(1234567.891-7654321.125j)', '(1.e-07+1.2345678901234568e+17j)', '(inf-infj)', '(nan+0.j)', '-0.j']),
    ('z', ['(3+4j)', '1j', '(0-2.5j)', '(1234567.891-7654321.125j)', '(1e-07+1.2345678901234568e+17j)', '(inf-infj)', '(nan+0j)', '0j']),
    ('z.0f', ['3+4j', '0+1j', '0-2j', '1234568-7654321j', '0+123456789012345680j', 'inf-infj', 'nan+0j', '0+0j']),
    ('#.0f', ['3.+4.j', '0.+1.j', '-0.-2.j', '1234568.-7654321.j', '0.+123456789012345680.j', 'inf-infj', 'nan+0.j', '0.-0.j']),
    ('#.3', ['(3.00+4.00j)', '1.00j', '(-0.00-2.50j)', '(1.23e+06-7.65e+06j)', '(1.00e-07+1.23e+17j)', '(inf-infj)', '(nan+0.00j)', '-0.00j']),
    ('.3', ['(3+4j)', '1j', '(-0-2.5j)', '(1.23e+06-7.65e+06j)', '(1e-07+1.23e+17j)', '(inf-infj)', '(nan+0j)', '-0j']),
    (',', ['(3+4j)', '1j', '(-0-2.5j)', '(1,234,567.891-7,654,321.125j)', '(1e-07+1.2345678901234568e+17j)', '(inf-infj)', '(nan+0j)', '-0j']),
    ('_.2f', ['3.00+4.00j', '0.00+1.00j', '-0.00-2.50j', '1_234_567.89-7_654_321.12j', '0.00+123_456_789_012_345_680.00j', 'inf-infj', 'nan+0.00j', '0.00-0.00j']),
    (',.3_f', ['3.000+4.000j', '0.000+1.000j', '-0.000-2.500j', '1,234,567.891-7,654,321.125j', '0.000+123,456,789,012,345,680.000j', 'inf-infj', 'nan+0.000j', '0.000-0.000j']),
    ('E', ['3.000000E+00+4.000000E+00j', '0.000000E+00+1.000000E+00j', '-0.000000E+00-2.500000E+00j', '1.234568E+06-7.654321E+06j', '1.000000E-07+1.234568E+17j', 'INF-INFj', 'NAN+0.000000E+00j', '0.000000E+00-0.000000E+00j']),
    ('G', ['3+4j', '0+1j', '-0-2.5j', '1.23457E+06-7.65432E+06j', '1E-07+1.23457E+17j', 'INF-INFj', 'NAN+0j', '0-0j']),
    ('.4g', ['3+4j', '0+1j', '-0-2.5j', '1.235e+06-7.654e+06j', '1e-07+1.235e+17j', 'inf-infj', 'nan+0j', '0-0j']),
    ('#g', ['3.00000+4.00000j', '0.00000+1.00000j', '-0.00000-2.50000j', '1.23457e+06-7.65432e+06j', '1.00000e-07+1.23457e+17j', 'inf-infj', 'nan+0.00000j', '0.00000-0.00000j']),
    ('n', ['3+4j', '0+1j', '-0-2.5j', '1.23457e+06-7.65432e+06j', '1e-07+1.23457e+17j', 'inf-infj', 'nan+0j', '0-0j']),
    ('+.2F', ['+3.00+4.00j', '+0.00+1.00j', '-0.00-2.50j', '+1234567.89-7654321.12j', '+0.00+123456789012345680.00j', '+INF-INFj', '+NAN+0.00j', '+0.00-0.00j']),
    (' .1e', [' 3.0e+00+4.0e+00j', ' 0.0e+00+1.0e+00j', '-0.0e+00-2.5e+00j', ' 1.2e+06-7.7e+06j', ' 1.0e-07+1.2e+17j', ' inf-infj', ' nan+0.0e+00j', ' 0.0e+00-0.0e+00j']),
    ('é^20.1f', ['éééééé3.0+4.0jéééééé', 'éééééé0.0+1.0jéééééé', 'ééééé-0.0-2.5jéééééé', '1234567.9-7654321.1j', '0.0+123456789012345680.0j', 'ééééééinf-infjéééééé', 'éééééénan+0.0jéééééé', 'éééééé0.0-0.0jéééééé']),
    ('20', ['              (3+4j)', '                  1j', '           (-0-2.5j)', '(1234567.891-7654321.125j)', '(1e-07+1.2345678901234568e+17j)', '          (inf-infj)', '            (nan+0j)', '                 -0j']),
    ('-15,.1f', ['       3.0+4.0j', '       0.0+1.0j', '      -0.0-2.5j', '1,234,567.9-7,654,321.1j', '0.0+123,456,789,012,345,680.0j', '       inf-infj', '       nan+0.0j', '       0.0-0.0j']),
    ('010', ['ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier']),
    ('0<10', ['ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier']),
    ('=10', ["ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier", "ValueError: '=' alignment flag is not allowed in complex format specifier"]),
    ('0=10f', ['ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier', 'ValueError: Zero padding is not allowed in complex format specifier']),
    ('d', ["ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'", "ValueError: Unknown format code 'd' for object of type 'complex'"]),
    ('x', ["ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'", "ValueError: Unknown format code 'x' for object of type 'complex'"]),
    ('%', ["ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'", "ValueError: Unknown format code '%' for object of type 'complex'"]),
    ('s', ["ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'", "ValueError: Unknown format code 's' for object of type 'complex'"]),
    ('r', ["ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'", "ValueError: Unknown format code 'r' for object of type 'complex'"]),
    ('10.2ff', ["ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'", "ValueError: Invalid format specifier '10.2ff' for object of type 'complex'"]),
    (',n', ["ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'.", "ValueError: Cannot specify ',' with 'n'."]),
    ('.', ['ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision', 'ValueError: Format specifier missing precision']),
    ('.99999999999f', ['ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big', 'ValueError: precision too big']),
    ('_,', ["ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'.", "ValueError: Cannot specify both ',' and '_'."]),
]


def formats(value, spec):
    return [
        format(value, spec),
        f"{value:{spec}}",
        ("{:" + spec + "}").format(value),
        value.__format__(spec),
    ]


def attempt(value, spec):
    try:
        results = formats(value, spec)
    except Exception as error:
        return type(error).__name__ + ": " + str(error)
    if results[:4] != [results[0]] * 4:
        raise AssertionError(f"{spec!r}: the ways to format disagree: {results!r}")
    return results[0]


for spec, expected in CASES:
    actual = [attempt(value, spec) for value in VALUES]
    if actual != expected:
        raise AssertionError(f"{spec!r}: {actual!r} != {expected!r}")

z = complex(3, 4)
if [format(z, ""), f"{z}", "{}".format(z), f"z = {z:.1f}", "{0:>10.1f}|{0.imag:.0f}".format(z)] != [
    "(3+4j)",
    "(3+4j)",
    "(3+4j)",
    "z = 3.0+4.0j",
    "  3.0+4.0j|4",
]:
    raise AssertionError("formatting 3+4j")
try:
    z.__format__(1)
    raise AssertionError("a format specification must be a str")
except TypeError as error:
    if str(error) != "__format__() argument must be str, not int":
        raise AssertionError(str(error))
