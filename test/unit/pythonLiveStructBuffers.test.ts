import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['bytearray', 'memoryview', 'array'])(
  'iter_unpack observes live %s buffers and releases exports at exhaustion',
  (kind) => {
    const program = `import struct, array
source = ${kind === 'array' ? "array.array('B', [1, 2, 3])" : 'bytearray([1, 2, 3])'}
buffer = ${kind === 'memoryview' ? 'memoryview(source)' : 'source'}
it = struct.iter_unpack('B', buffer)
assert next(it) == (1,)
source[1] = 9
assert next(it) == (9,)
${
  kind === 'memoryview'
    ? `try: buffer.release()
except BufferError: pass
else: raise AssertionError('released')`
    : 'pass'
}
try: source.append(4)
except BufferError: pass
else: raise AssertionError('resized')
assert next(it) == (3,)
assert next(it, None) is None
${kind === 'memoryview' ? 'buffer.release()' : 'pass'}
source.append(4)
assert list(source) == [1, 9, 3, 4]
print('live')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'live\n',
      uncaughtException: undefined,
    });
  }
);

test('iter_unpack validates contiguity and releases exports when an iterator is discarded', () => {
  const program = `import struct, gc
source = bytearray([1, 2, 3, 4])
view = memoryview(source)
it = struct.iter_unpack('B', view)
del it
gc.collect()
view.release()
source.append(5)
assert list(struct.iter_unpack('B', memoryview(source)[1:2:2])) == [(2,)]
for view in [memoryview(source)[::2], memoryview(source)[:0:2]]:
    try: struct.iter_unpack('B', view)
    except BufferError: pass
    else: raise AssertionError('strided')
print('exports')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'exports\n',
    uncaughtException: undefined,
  });
});
