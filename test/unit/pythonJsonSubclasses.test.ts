import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('JSON encoders and decoders accept string subclasses without invoking conversion hooks', () => {
  const program = `import json
class Text(str):
    def __str__(self): raise AssertionError('str hook')
for ascii in [True, False]:
    assert json.loads(Text(json.dumps([Text('é'), {Text('k'): 1}], ensure_ascii=ascii))) == ['é', {'k': 1}]
assert json.loads(Text(' 3 ')) == 3
assert json.loads(json.dumps({Text('k'): Text('v')}, indent=Text(' '))) == {'k': 'v'}
for encode in [json.encoder.encode_basestring, json.encoder.encode_basestring_ascii]:
    assert json.loads(encode(Text('é'))) == 'é'
    try: encode(4)
    except TypeError as error: assert str(error) == 'first argument must be a string, not int'
    else: raise AssertionError('accepted')
print('json')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'json\n',
    uncaughtException: undefined,
  });
});

test('json public functions use the live module globals for replacement encoders and decoders', () => {
  const program = `import json, io
class Encoder(json.JSONEncoder):
    def encode(self, value): return 'patched'
    def iterencode(self, value, _one_shot=False): yield 'streamed'
class Decoder(json.JSONDecoder):
    def decode(self, value): return 'decoded'
json.JSONEncoder = Encoder
json.JSONDecoder = Decoder
assert json.dumps(1, indent=2) == 'patched'
output = io.StringIO()
json.dump(1, output, indent=2)
assert output.getvalue() == 'streamed'
assert json.loads('1', parse_int=int) == 'decoded'
assert json.load(io.StringIO('1'), parse_int=int) == 'decoded'
original = json.loads.__globals__['JSONDecoder']
del json.JSONDecoder
try: json.loads('1', parse_int=int)
except NameError: pass
else: raise AssertionError('deleted class remained visible')
json.JSONDecoder = original
assert json.loads('1', parse_int=int) == 'decoded'
print('live')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'live\n',
    uncaughtException: undefined,
  });
});
