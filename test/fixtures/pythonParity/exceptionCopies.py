# copy and deepcopy rebuild an exception from its class and arguments, then copy its attributes and notes.
import copy


class MyError(ValueError):
    pass


class Two(Exception):
    def __init__(self, a, b):
        super().__init__(a, b)
        self.b = b


error = MyError('bad input')
error.extra = [1]
error.add_note('n')
deep = copy.deepcopy(error)
shallow = copy.copy(error)
two = Two(1, [2])
deep_two = copy.deepcopy(two)
plain = ValueError('x')
got = [str(deep), deep.args, deep.extra, deep.extra is error.extra, deep.__notes__, deep is error, shallow.extra is error.extra, type(deep).__name__, deep_two.args, deep_two.b, deep_two.b is two.b, copy.deepcopy(plain) is plain, copy.copy(plain) is plain, copy.deepcopy(plain).args, str(copy.deepcopy({'error': MyError('bad input')})['error'])]
try:
    raise deep
except MyError as caught:
    got.append(str(caught))
expected = ['bad input', ('bad input',), [1], False, ['n'], False, True, 'MyError', (1, [2]), [2], False, False, False, ('x',), 'bad input', 'bad input']
if got != expected:
    raise AssertionError(got)
