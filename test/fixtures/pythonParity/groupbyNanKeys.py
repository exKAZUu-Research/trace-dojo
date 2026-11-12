from itertools import groupby
a = float('nan')
got = [[len(list(g)) for k, g in groupby([a, a, 1])], [(k, list(g)) for k, g in groupby('aabbbc')]]
groups = groupby([1, 1, 2, 2])
k1, g1 = next(groups)
k2, g2 = next(groups)
got.append([list(g1), list(g2)])
if got != [[2, 1], [('a', ['a', 'a']), ('b', ['b', 'b', 'b']), ('c', ['c'])], [[], [2, 2]]]:
    raise AssertionError(got)
