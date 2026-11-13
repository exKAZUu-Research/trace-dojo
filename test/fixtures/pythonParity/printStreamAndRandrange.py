# print writes to the current sys.stdout, and randrange refuses a step without a stop unless it is the int 1.
import random
import sys

stdout = sys.stdout
sys.stdout = sys.stderr
for i in range(101):
    print('x' * 1000)
sys.stdout = None
print('gone')
del sys.stdout
try:
    print('lost')
except RuntimeError as error:
    message = str(error)
sys.stdout = stdout
random.seed(3)
got = [message]
for call in [lambda: random.randrange(10, step=2), lambda: random.randrange(10, None, 0), lambda: random.randrange(10, None, 1), lambda: random.randrange(10, None), lambda: random.randrange(10, step=1.0)]:
    try:
        got.append(call())
    except TypeError as error:
        got.append(str(error))
if got != ['lost sys.stdout', 'Missing a non-None stop argument', 'Missing a non-None stop argument', 3, 9, 'Missing a non-None stop argument']:
    raise AssertionError(got)
