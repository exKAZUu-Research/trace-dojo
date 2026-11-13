import random
random.seed(1)
got = []
for name, args in [('paretovariate', (0,)), ('paretovariate', (-0.0,)), ('weibullvariate', (1, 0)), ('weibullvariate', (1, -0.0)), ('expovariate', (0,)), ('triangular', (1, 1, 1)), ('vonmisesvariate', (0, 0))]:
    try:
        got.append(getattr(random, name)(*args))
    except ZeroDivisionError as e:
        got.append(str(e))
if got != ['division by zero'] * 5 + [1, 4.094079392473133]:
    raise AssertionError(got)
