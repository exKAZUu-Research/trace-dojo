import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

test('dynamic compilation charges syntax before retaining a generated expression', () => {
  const program = `source = '[' + '1,' * 180000 + '0]'
compile(source, 'generated', 'eval')
print('retained')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'MemoryError',
  });
});

test.each(['compile', 'eval', 'exec'])('distinct %s sources share the run syntax storage budget', (operation) => {
  const program = `for index in range(100):
    source = '[' + str(index) + ',' + '1,' * 2000 + '0]'
    ${operation === 'compile' ? "compile(source, 'generated', 'eval')" : `${operation}(source)`}
print('retained')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'MemoryError',
  });
});

test('cached compilation avoids repeatedly allocating syntax and preserves code objects across cache eviction', () => {
  const program = `source = '[' + '1,' * 2000 + '0]'
first = compile('7', 'first', 'eval')
for index in range(100): compile(source, 'same', 'eval')
for index in range(150): compile(str(index), 'evicted', 'eval')
assert eval(first) == 7
assert first.co_filename == 'first'
print('compiled')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'compiled\n',
    uncaughtException: undefined,
  });
});
