def outcome(value, spec):
    try:
        direct = format(value, spec)
    except Exception as error:
        return type(error).__name__ + ": " + str(error)
    if f"{value:{spec}}" != direct or ("{:" + spec + "}").format(value) != direct:
        raise AssertionError((value, spec))
    return direct


values = [float("inf"), float("-inf"), float("nan"), float("1e308"), float("-1e307"), 10 ** 400, 0.5, 12]
cases = [
    ('%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.000000%', '1200.000000%']),
    ('.2%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.00%', '1200.00%']),
    ('.0%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50%', '1200%']),
    ('10.1%', ['      inf%', '     -inf%', '      nan%', '      inf%', '     -inf%', 'OverflowError: int too large to convert to float', '     50.0%', '   1200.0%']),
    ('<10%', ['inf%      ', '-inf%     ', 'nan%      ', 'inf%      ', '-inf%     ', 'OverflowError: int too large to convert to float', '50.000000%', '1200.000000%']),
    ('^+10.0%', ['  +inf%   ', '  -inf%   ', '  +nan%   ', '  +inf%   ', '  -inf%   ', 'OverflowError: int too large to convert to float', '   +50%   ', '  +1200%  ']),
    ('010%', ['000000inf%', '-00000inf%', '000000nan%', '000000inf%', '-00000inf%', 'OverflowError: int too large to convert to float', '50.000000%', '1200.000000%']),
    ('=+010%', ['+00000inf%', '-00000inf%', '+00000nan%', '+00000inf%', '-00000inf%', 'OverflowError: int too large to convert to float', '+50.000000%', '+1200.000000%']),
    ('<010%', ['inf%000000', '-inf%00000', 'nan%000000', 'inf%000000', '-inf%00000', 'OverflowError: int too large to convert to float', '50.000000%', '1200.000000%']),
    (' %', [' inf%', '-inf%', ' nan%', ' inf%', '-inf%', 'OverflowError: int too large to convert to float', ' 50.000000%', ' 1200.000000%']),
    (',%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.000000%', '1,200.000000%']),
    ('010,%', ['000000inf%', '-00000inf%', '000000nan%', '000000inf%', '-00000inf%', 'OverflowError: int too large to convert to float', '50.000000%', '1,200.000000%']),
    ('#.0%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.%', '1200.%']),
    ('.1F', ['INF', '-INF', 'NAN', '100000000000000001097906362944045541740492309677311846336810682903157585404911491537163328978494688899061249669721172515611590283743140088328307009198146046031271664502933027185697489699588559043338384466165001178426897626212945177628091195786707458122783970171784415105291802893207873272974885715430223118336.0', '-9999999999999999860310597602564577717002641838126363875249660735883565852672743849064846414228960666786379280392654615393353172850252103336275952370615397010730691664689375178569039851073146339641623266071126720011020169553304018596457812688561947201171488461172921822139066929851282122002676667750021070848.0', 'OverflowError: int too large to convert to float', '0.5', '12.0']),
    ('=+012.3e', ['+00000000inf', '-00000000inf', '+00000000nan', '+01.000e+308', '-01.000e+307', 'OverflowError: int too large to convert to float', '+005.000e-01', '+001.200e+01']),
    ('10.2E', ['       INF', '      -INF', '       NAN', ' 1.00E+308', '-1.00E+307', 'OverflowError: int too large to convert to float', '  5.00E-01', '  1.20E+01']),
    ('010G', ['0000000INF', '-000000INF', '0000000NAN', '00001E+308', '-0001E+307', 'OverflowError: int too large to convert to float', '00000000.5', '0000000012']),
    ('z%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.000000%', '1200.000000%']),
    ('_.1,%', ['inf%', '-inf%', 'nan%', 'inf%', '-inf%', 'OverflowError: int too large to convert to float', '50.0%', '1_200.0%']),
]
for spec, expected in cases:
    actual = [outcome(value, spec) for value in values]
    if actual != expected:
        raise AssertionError((spec, actual))
