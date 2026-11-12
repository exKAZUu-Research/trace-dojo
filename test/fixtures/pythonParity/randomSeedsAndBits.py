import random
random.seed(42)
if random.getrandbits(0) != 0 or random.random() != 0.6394267984578837:
    raise AssertionError("getrandbits(0) must return 0 without advancing the generator")
got = []
for seed in (-1.5, -2.5, -3.0, float("-inf")):
    random.seed(seed)
    got.append(random.random())
if got != [0.7101153317194698, 0.4779490710306722, 0.4710496035798619, 0.820833204760975]:
    raise AssertionError(got)
