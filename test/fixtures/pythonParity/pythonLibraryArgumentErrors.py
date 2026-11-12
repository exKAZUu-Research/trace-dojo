import copy
import random
import statistics
from collections import Counter
messages = []
for call in [lambda: random.randint(1), lambda: random.randint(1, 2, 3), lambda: random.choice(), lambda: statistics.mean(), lambda: copy.deepcopy(), lambda: Counter().most_common(1, 2), lambda: random.choices([1], kk=1)]:
    try:
        call()
    except TypeError as e:
        messages.append(str(e))
expected = ["Random.randint() missing 1 required positional argument: 'b'", 'Random.randint() takes 3 positional arguments but 4 were given', "Random.choice() missing 1 required positional argument: 'seq'", "mean() missing 1 required positional argument: 'data'", "deepcopy() missing 1 required positional argument: 'x'", 'Counter.most_common() takes from 1 to 2 positional arguments but 3 were given', "Random.choices() got an unexpected keyword argument 'kk'. Did you mean 'k'?"]
if messages != expected or random.randint(a=1, b=1) != 1 or statistics.mean(data=[1, 2]) != 1.5:
    raise AssertionError(messages)
