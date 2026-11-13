from collections import deque
def check(*values):
    if not all(values):
        raise ValueError(str(values))
def g(target):
    yield 1
    yield len(target)
    raise ValueError()
results = []
for target in [[], deque()]:
    try:
        target.extend(g(target))
    except ValueError:
        pass
    results.append(list(target))
b = [0]
try:
    b += g(b)
except ValueError:
    pass
check(results == [[1, 1], [1, 1]], b == [0, 1, 2])
