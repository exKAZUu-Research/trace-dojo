from collections import Counter, OrderedDict, defaultdict
def check(*values):
    if not all(values):
        raise ValueError(str(values))
a = Counter(a=3, b=1)
b = Counter('aab')
check((a | b) == Counter(a=3, b=1), (Counter(x=5) | Counter(x=1))['x'] == 5)
a |= b
check(a['a'] == 3, a['b'] == 1)
check(type(Counter(a=1) | {'b': 2}) is dict, type(OrderedDict(a=1) | {'b': 2}) is OrderedDict)
d = defaultdict(int, a=1) | {'b': 2}
check(type(d) is defaultdict, d['missing'] == 0, Counter('a') == {'a': 1})
