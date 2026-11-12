def check(*values):
    if not all(values):
        raise ValueError(str(values))
check(list({10, 20, 30, 40, 50}) == [50, 20, 40, 10, 30])
check(list({-1, -2, -3, 8, 16}) == [16, -1, 8, -3, -2])
check([x for x in {10, 20, 30, 40, 50}] == [40, 10, 50, 20, 30])
a = 10
check(list({a, 20, 30, 40, 50}) == [40, 10, 50, 20, 30])
