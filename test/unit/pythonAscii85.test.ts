import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('Ascii85 decodes partial groups, shortcuts, Adobe framing and ignored whitespace', () => {
  const program = `import base64
cases = [(b'', False), (b'!', False), (b'!!', False), (b'!!!', False), (b'!!!!', False), (b'!!!!!', False),
         (b'z', False), (b'y', False), (b'<~z !!!! \\n~>', True), (b'87cURD]i,"Ebo7', False),
         (b'!z', False), (b'!y', False), (b'v', False), (b'uuuuu', False)]
for encoded, adobe in cases:
    try:
        print(base64.a85decode(encoded, foldspaces=True, adobe=adobe).hex())
    except ValueError as error:
        print(error)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '\n\n00\n0000\n000000\n00000000\n00000000\n20202020\n00000000000000\n48656c6c6f20576f726c64\n' +
      'z inside Ascii85 5-tuple\ny inside Ascii85 5-tuple\nNon-Ascii85 digit found: v\nAscii85 overflow\n',
    uncaughtException: undefined,
  });
});

test.each(["b'z' * 100000", "b'y' * 100000", "b'!!!!!' * 100000"])(
  'Ascii85 output fits alongside retained values without a temporary number array: %s',
  (encoded) => {
    const program = `import base64
retained = [None] * 600000
print(len(base64.a85decode(${encoded}, foldspaces=True)))`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: '400000\n',
      uncaughtException: undefined,
    });
  }
);

test.each(["b'z' * 100000", "b'y' * 100000", "b'!!!!!' * 100000"])(
  'Ascii85 packed output still obeys remaining storage: %s',
  (encoded) => {
    const program = `import base64
retained = [None] * 950000
base64.a85decode(${encoded}, foldspaces=True)`;
    expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: 'MemoryError' });
  }
);

test('Ascii85 expansion accepts the output-length boundary and rejects larger output', () => {
  const program = `import base64
print(len(base64.a85decode(b'z' * 250000)))
base64.a85decode(b'z' * 250001)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '1000000\n',
    uncaughtException: 'MemoryError',
  });
});
