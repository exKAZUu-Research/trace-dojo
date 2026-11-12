class P:
    def __init__(self):
        self.a = 1
def h(v):
    match v:
        case P(a=_):
            return 'p-any'
        case _:
            return 'other'
def k(v):
    match v:
        case 1 | 2 | _:
            return 'm'
words = ['b😀x', 'a😀y', 'a\U0001F600', 'a￿', 'a', '', 'ab', '\U00010000', '￿', '\ud800', 'a\ud800']
got = [h(P()), h(1), k(5), k(1), sorted(words), 'a\ud800' < 'a', 'a\U00010000' > 'a￿']
if got != ['p-any', 'other', 'm', 'm', ['', 'a', 'ab', 'a\ud800', 'a￿', 'a😀', 'a😀y', 'b😀x', '\ud800', '￿', '\U00010000'], True, True]:
    raise AssertionError(got)
