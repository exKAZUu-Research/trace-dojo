calls = []
class Items:
    def __iter__(self):
        return iter([1, 2, 3])
    def __len__(self):
        calls.append('len')
        return 3
messages = []
for v in [Items(), 'abc', {1, 2, 3}, range(3), {1: 1, 2: 2, 3: 3}, [1, 2, 3]]:
    try:
        a, b = v
    except ValueError as e:
        messages.append(str(e))
expected = ['too many values to unpack (expected 2)'] * 4 + ['too many values to unpack (expected 2, got 3)'] * 2
if messages != expected or calls != []:
    raise AssertionError([messages, calls])
