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

test.each([false, true])('CDATA entity expansion obeys amplification limits for text and bytes (bytes=%s)', (bytes) => {
  const program = `import xml.parsers.expat as expat
p = expat.ParserCreate()
p.CharacterDataHandler = lambda text: None
doc = '<!DOCTYPE r [<!ENTITY a "<![CDATA[' + 'x'*50000 + ']]>">]><r>' + '&a;'*200 + '</r>'
try: p.Parse(${bytes ? "doc.encode('utf-8')" : 'doc'}, True)
except expat.ExpatError as error: print(error)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'limit on input amplification factor (from DTD and entities) breached: line 1, column 50542\n',
    uncaughtException: undefined,
  });
});

test('CDATA accounting is stable when its delimiters cross parse chunks', () => {
  const program = `import xml.parsers.expat as expat
for split in range(1, 20):
    parser = expat.ParserCreate()
    seen = []
    parser.CharacterDataHandler = seen.append
    source = '<r><![CDATA[hello\\nworld]]></r>'
    for index in range(0, len(source), split): parser.Parse(source[index:index+split], False)
    parser.Parse('', True)
    assert ''.join(seen) == 'hello\\nworld'
print('chunks')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'chunks\n',
    uncaughtException: undefined,
  });
});
