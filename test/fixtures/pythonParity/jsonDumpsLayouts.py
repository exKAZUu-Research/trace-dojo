import json
class Point:
    def __init__(self, x):
        self.x = x
def convert(value):
    return {'x': value.x}
data = {'b': [1, 2.5, None, True, 'é'], 'a': {}, 3: [], 'p': Point(1), (1, 2): 'skipped'}
got = [
    json.dumps(data, default=convert, skipkeys=True),
    json.dumps(data, default=convert, skipkeys=True, indent=2, sort_keys=False),
    json.dumps({'k': [Point(2), {}]}, default=convert, separators=(',', ':')),
    json.dumps({(1, 2): 1}, skipkeys=True),
    json.dumps({(1, 2): 1, 'a': [{}]}, skipkeys=True, indent='\t'),
    json.dumps([[], [[]], {}], indent=1),
    json.dumps({'b': 1, 'a': 2}, sort_keys=True, ensure_ascii=False),
]
expected = ['{"b": [1, 2.5, null, true, "\\u00e9"], "a": {}, "3": [], "p": {"x": 1}}', '{\n  "b": [\n    1,\n    2.5,\n    null,\n    true,\n    "\\u00e9"\n  ],\n  "a": {},\n  "3": [],\n  "p": {\n    "x": 1\n  }\n}', '{"k":[{"x":2},{}]}', '{}', '{\n\t"a": [\n\t\t{}\n\t]\n}', '[\n [],\n [\n  []\n ],\n {}\n]', '{"a": 2, "b": 1}']
if got != expected:
    raise AssertionError(got)
try:
    loop = []
    loop.append(loop)
    json.dumps(loop)
    raise AssertionError('no circular error')
except ValueError as error:
    if str(error) != 'Circular reference detected':
        raise
