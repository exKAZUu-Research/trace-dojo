from collections import deque
d = deque([1, 2, 1, 3, 1])
got = [d.index(1), d.index(1, 1), d.index(1, 3), d.index(1, -2), d.index(3, 0, 4), d.index(1, -100, 100)]
messages = []
for args in [(1, 0, 0), (2, 2), (9,), (3, 0, 3), (1, 5)]:
    try:
        d.index(*args)
    except ValueError as e:
        messages.append(str(e))
try:
    d.remove(9)
except ValueError as e:
    messages.append(str(e))
if got != [0, 2, 4, 4, 3, 0] or messages != ['deque.index(x): x not in deque'] * 5 + ['deque.remove(x): x not in deque']:
    raise AssertionError([got, messages])
