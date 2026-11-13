from collections import Counter
class Two:
    def __index__(self):
        return 2
c = Counter()
c['a'] = True
c['b'] = 2
c['z'] = 0
c['n'] = -1
c['i'] = Two()
got = list(c.elements())
c['f'] = 1.5
items = c.elements()
first = next(items)
try:
    list(items)
    raise AssertionError('no TypeError')
except TypeError as e:
    message = str(e)
if [got, first, message] != [['a', 'b', 'b', 'i', 'i'], 'a', "'float' object cannot be interpreted as an integer"]:
    raise AssertionError([got, first, message])
