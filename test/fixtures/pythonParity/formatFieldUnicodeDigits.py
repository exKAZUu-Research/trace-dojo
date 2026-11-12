import string
got = ['{０}'.format('hello'), '{0[１]}'.format(['a', 'b']), '{٢}{0}'.format('x', 'y', 'z'), '{a}'.format(a=1), '{0[x]}'.format({'x': 3}), list(string.Formatter().parse('{０[１]}'))[0][1], '{0[１０]}'.format(list(range(11)))]
try:
    '{}{０}'.format(1, 2)
except ValueError as e:
    got.append(str(e))
if got != ['hello', 'b', 'zx', '1', '3', '０[１]', '10', 'cannot switch from automatic field numbering to manual field specification']:
    raise AssertionError(got)
