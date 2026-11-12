# The methods a namedtuple subclass overrides decide truth, length, hashing, and _asdict, as in CPython.
from collections import namedtuple

Base = namedtuple('Base', 'ok value')


class Result(Base):
    def __bool__(self):
        return bool(self.ok)


class Short(Base):
    def __len__(self):
        return 1

    def __hash__(self):
        return 7

    def __iter__(self):
        return iter(['it'])


failed = Result(False, 42)
flag = 'no'
if failed:
    flag = 'yes'
short = Short(1, 2)
got = [flag, bool(failed), bool(Result(True, 0)), not failed, len(short), bool(Short(0, 0)), hash(short), short._asdict(), Base(1, 2)._asdict(), len(Base(1, 2)), bool(Base(0, 0))]
expected = ['no', False, True, True, 1, True, 7, {'ok': 'it'}, {'ok': 1, 'value': 2}, 2, True]
if got != expected:
    raise AssertionError(got)
