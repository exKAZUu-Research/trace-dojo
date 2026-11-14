import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('exception group partitions follow derive and preserve exception metadata', () => {
  const program = `class Group(ExceptionGroup):
    def __new__(cls, message, errors, tag):
        result = super().__new__(cls, message, errors)
        result.tag = tag
        return result
    def derive(self, errors): return Group(self.message, errors, self.tag)
group = Group('errors', [ValueError('a'), TypeError('b')], 'kept')
group.add_note('note')
try: raise group from RuntimeError('cause')
except Group as caught:
    matched, rest = caught.split(ValueError)
    for part in [matched, rest]:
        assert type(part) is Group and part.tag == 'kept'
        assert part.__traceback__ is caught.__traceback__
        assert part.__cause__ is caught.__cause__
        assert part.__context__ is caught.__context__
        assert part.__notes__ == caught.__notes__ and part.__notes__ is not caught.__notes__
    all_matched, empty = caught.split(Exception)
    assert all_matched is caught and empty is None
    derived, empty = caught.split(lambda e: isinstance(e, (ValueError, TypeError)))
    assert derived is not caught and len(derived.exceptions) == 2
try: raise group
except* ValueError as error: print(error.tag, type(error).__name__)
except* TypeError as error: print(error.tag, type(error).__name__)
class Invalid(ExceptionGroup):
    def derive(self, errors): return 1
try: Invalid('bad', [ValueError()]).split(ValueError)
except TypeError as error: assert str(error) == 'derive must return an instance of BaseExceptionGroup'
else: raise AssertionError('invalid derive')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'kept Group\nkept Group\n',
    uncaughtException: undefined,
  });
});

test('derived partitions of deeply shared groups obey the storage budget', () => {
  const program = `group = ExceptionGroup('leaf', [ValueError()])
for i in range(27): group = ExceptionGroup('nested', [group, group])
try: raise group
except* TypeError: pass`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: 'MemoryError' });
});
