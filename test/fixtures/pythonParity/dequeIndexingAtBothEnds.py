from collections import deque
q = deque(range(5))
q.appendleft(-1)
q.appendleft(-2)
a = q.pop()
b = q.popleft()
got = [a, b, q[0], q[-1], q[2], list(q), list(reversed(q)), len(q), 3 in q, q.index(2)]
q.appendleft(9)
q[1] = 8
del q[2]
got.append(list(q))
m = deque(maxlen=2)
for i in range(5):
    m.appendleft(i)
got.append(list(m))
try:
    for x in q:
        q.appendleft(0)
except RuntimeError as e:
    got.append(str(e))
if got != [4, -2, -1, 3, 1, [-1, 0, 1, 2, 3], [3, 2, 1, 0, -1], 5, True, 3, [9, 8, 1, 2, 3], [4, 3], 'deque mutated during iteration']:
    raise AssertionError(got)
