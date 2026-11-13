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
