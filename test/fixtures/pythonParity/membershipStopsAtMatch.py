ran = []
def items():
    yield 1
    ran.append('after 1')
    yield 2
    ran.append('after 2')
source = items()
found = 1 in source
ran_by_match = list(ran)
missing = 5 in items()
if [found, ran_by_match, missing, next(source)] != [True, [], False, 2]:
    raise AssertionError([found, ran_by_match, missing])
