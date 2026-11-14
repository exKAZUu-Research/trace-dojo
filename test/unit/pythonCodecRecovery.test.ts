import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('escape decoding applies recovery policies to malformed hex escapes', () => {
  const program = String.raw`import codecs
class Text(str): pass
for make in [bytes, bytearray, memoryview]:
    data = make(br'a\xzzb\x1z\x')
    replaced, consumed = codecs.escape_decode(data, Text('replace'))
    ignored, count = codecs.escape_decode(data, 'ignore')
    assert replaced == b'a?zzb?z?' and ignored == b'azzbz'
    assert consumed == count == len(data)
    try: codecs.escape_decode(data, None)
    except ValueError as error: assert str(error) == r'invalid \x escape at position 1'
    else: raise AssertionError('strict')
assert codecs.escape_decode(Text(chr(233) + r'\n')) == ((chr(233) + '\n').encode(), 4)
assert codecs.escape_decode(b'plain', 'unused') == (b'plain', 5)
try: codecs.escape_decode(br'\x', 'unused')
except ValueError as error: assert str(error) == 'decoding error; unknown error handling code: unused'
else: raise AssertionError('unknown policy')
print('decoded')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'decoded\n',
    uncaughtException: undefined,
  });
});

test('dictionary deepcopy copies values first and retains them during key hooks', () => {
  const program = `import copy, gc
class Resource:
    def __del__(self): print('released')
class Key:
    def __deepcopy__(self, memo):
        gc.collect()
        print('key')
        return self
class Value:
    def __deepcopy__(self, memo):
        print('value')
        return Resource()
result = copy.deepcopy({Key(): Value()})
print('copied')
del result
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'value\nkey\ncopied\nreleased\nend\n',
    uncaughtException: undefined,
  });
});
