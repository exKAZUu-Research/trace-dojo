from collections import deque
def check(*values):
    if not all(values):
        raise ValueError(str(values))
q = deque([1, 2])
check(q == deque([1, 2]), deque() == deque(), not (deque([1]) != deque([1])), [deque([1])] == [deque([1])])
check(deque([1, 2]) < deque([1, 3]), deque([1]) < deque([1, 2]), deque([2]) >= deque([1, 9]), deque([1]) != [1])
q += [4]
check(list(q) == [1, 2, 4])
try:
    q * 1.5
except TypeError as e:
    check(str(e) == "can't multiply sequence by non-int of type 'float'")
