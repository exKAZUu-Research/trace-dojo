import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([false, true])('incremental XML input charges retained arrays before growing them (bytes=%s)', (bytes) => {
  const program = `import xml.parsers.expat as expat
p = expat.ParserCreate()
p.Parse(${bytes ? "b'<root>'" : "'<root>'"}, False)
chunk = ${bytes ? "b'x'" : "'x'"} * 100000
for _ in range(12): p.Parse(chunk, False)
p.Parse(${bytes ? "b'</root>'" : "'</root>'"}, True)
print('ok')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'MemoryError',
  });
});

test.each([false, true])(
  'XML chunk boundaries preserve decoded characters and offsets within the budget (bytes=%s)',
  (bytes) => {
    const program = `import xml.parsers.expat as expat
p = expat.ParserCreate()
seen = []
p.CharacterDataHandler = seen.append
text = '<root>あéx</root>'
data = ${bytes ? "text.encode('utf-8')" : 'text'}
for index in range(len(data)): p.Parse(data[index:index+1], False)
p.Parse(${bytes ? "b''" : "''"}, True)
print(''.join(seen), p.CurrentByteIndex)`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'あéx 19\n',
      uncaughtException: undefined,
    });
  }
);
