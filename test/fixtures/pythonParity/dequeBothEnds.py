from collections import deque
q = deque(range(1000))
total = 0
while q:
    total += q.popleft()
r = deque()
for i in range(1000):
    r.appendleft(i)
b = deque(maxlen=3)
for i in range(10):
    b.append(i)
c = deque(maxlen=3)
for i in range(10):
    c.appendleft(i)
m = deque([1, 2, 3])
m.appendleft(0)
x = m.popleft()
m.append(4)
got = [total, r[0], r[-1], len(r), list(b), list(c), list(m), x, m[0], m[-1], len(m)]
m.rotate(1)
got.append(list(m))
if got != [499500, 999, 0, 1000, [7, 8, 9], [9, 8, 7], [1, 2, 3, 4], 0, 1, 4, 4, [4, 1, 2, 3]]:
    raise AssertionError(got)
