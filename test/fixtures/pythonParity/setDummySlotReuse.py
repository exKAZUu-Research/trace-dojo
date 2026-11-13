def check(*values):
    if not all(values):
        raise ValueError(str(values))
s = set()
s.add(1)
s.add(29)
s.add(22)
s.discard(1)
s.discard(22)
s.add(25)
s.add(40)
s.add(22)
check(list(s) == [40, 22, 25, 29])
