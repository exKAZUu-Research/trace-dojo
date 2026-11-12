got = []
for n in [10 ** 4299, -(10 ** 4299), 2 ** 14284, 2 ** 14285, 10 ** 4299 - 1, -(10 ** 4300 - 1), 10 ** 4300]:
    try:
        got.append(len(str(n)))
    except ValueError as e:
        got.append(str(e))
message = 'Exceeds the limit (4300 digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit'
if got != [4300, 4301, 4300, message, 4299, 4301, message]:
    raise AssertionError(got)
