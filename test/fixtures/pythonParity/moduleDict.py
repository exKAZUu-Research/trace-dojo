import math
import collections
import json
d = vars(math)
got = [type(d).__name__, d['pi'], math.__dict__ is vars(math), getattr(math, '__dict__', 'missing') is d, 'deque' in vars(collections), 'UserDict' in vars(collections), 'dumps' in json.__dict__, math.__class__.__name__]
if got != ['dict', 3.141592653589793, True, True, True, True, True, 'module']:
    raise AssertionError(got)
