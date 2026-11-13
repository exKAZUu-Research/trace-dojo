import itertools

results = [
    next(itertools.product(repeat=10**12)),
    list(itertools.product(repeat=3)),
    list(itertools.product()),
    list(itertools.product([1, 2], repeat=2)),
    list(itertools.product([1, 2], 'a', repeat=0)),
    list(itertools.product([], repeat=3)),
    [next(t) for t in itertools.tee([5, 6], 3)],
    itertools.tee([5], 0),
    list(itertools.combinations_with_replacement([1, 2], 2)),
]
expected = [(), [()], [()], [(1, 1), (1, 2), (2, 1), (2, 2)], [()], [], [5, 5, 5], (), [(1, 1), (1, 2), (2, 2)]]
if results != expected:
    raise AssertionError(repr(results))

from collections import Counter

elements = Counter(a=10**12, b=2).elements()
if [next(elements), next(elements)] != ['a', 'a']:
    raise AssertionError('Counter.elements')
if list(Counter(a=2, b=0, c=-1, d=1).elements()) != ['a', 'a', 'd']:
    raise AssertionError('Counter.elements with non-positive counts')

wide = format(1, '0999999,d')
if [len(wide), wide[:6], wide[-9:]] != [999999, '000,00', '0,000,001']:
    raise AssertionError('zero-padded grouping')
if [format(1234567, '012,d'), format(-1234.5, '012_.2f'), format(255, '#012_x')] != ['0,001,234,567', '-0_001_234.50', '0x0_0000_00ff']:
    raise AssertionError('grouping')

texts = ['-j', '+j', 'inf+nanj', '-Infinity', '1e5j', ' (1.5-2.5e3j) ', '1' * 400, '1' * 99999 + 'x', '1+2']
results = []
for text in texts:
    try:
        results.append(repr(complex(text)))
    except ValueError as error:
        results.append(str(error))
malformed = 'complex() arg is a malformed string'
if results != ['-1j', '1j', '(inf+nanj)', '(-inf+0j)', '100000j', '(1.5-2500j)', '(inf+0j)', malformed, malformed]:
    raise AssertionError(repr(results))
