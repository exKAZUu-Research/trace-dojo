from collections import Counter, deque
def check(*values):
    if not all(values):
        raise ValueError(str(values))
a = Counter(x=1)
b = a
a += Counter(x=1)
check(b is a, b == Counter(x=2))
q = deque([1])
p = q
q += [2]
q += (i for i in range(3, 5))
check(p is q, list(p) == [1, 2, 3, 4])
n = 1
try:
    n += 'a'
except TypeError as e:
    check(str(e) == "unsupported operand type(s) for +=: 'int' and 'str'")
