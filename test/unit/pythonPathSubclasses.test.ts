import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('filesystem encoding returns bytes for string subclasses and preserves byte paths', () => {
  const program = String.raw`import os
class Path(str): pass
class BinaryPath(bytes): pass
for text in ['file.txt', '教材.txt', '\udcff']:
    path = Path(text)
    encoded = os.fsencode(path)
    assert type(encoded) is bytes
    assert encoded == str(path).encode('utf8', 'surrogateescape')
    assert os.fsdecode(encoded) == text
binary = BinaryPath(b'file.txt')
assert os.fsencode(binary) is binary
print('encoded')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'encoded\n',
    uncaughtException: undefined,
  });
});
