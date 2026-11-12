def check(*values):
    if not all(values):
        raise ValueError(str(values))
nums = [3, 1]
for arg in [True, len]:
    try:
        nums.sort(arg)
    except TypeError as e:
        check(str(e) == 'sort() takes no positional arguments')
