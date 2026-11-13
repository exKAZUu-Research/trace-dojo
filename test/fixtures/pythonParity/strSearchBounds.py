def check(*values):
    if not all(values):
        raise ValueError(str(values))
check('abc'.find('', 4) == -1, 'abc'.count('', 2, 1) == 0, 'abc'.startswith('', 4) is False)
check('abc'.find('', 3) == 3, 'abc'.rfind('', 2, 1) == -1, 'abc'.endswith('', 2, 1) is False, 'abc'.count('', 4) == 0, 'abc'.count('', 3) == 1)
