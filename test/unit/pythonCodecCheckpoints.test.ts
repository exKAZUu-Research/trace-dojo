import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('incremental codec checkpoints preserve shift designations and pending character pairs', () => {
  const program = `import codecs
for encoding, text in [('iso2022_jp', 'あい'), ('iso2022_jp_2', 'あい'), ('hz', '中文'), ('iso2022_jp_2004', 'か゚あ'), ('shift_jis_2004', 'か゚あ'), ('euc_jis_2004', 'か゚あ')]:
    encoder_type = codecs.getincrementalencoder(encoding)
    for cut in range(len(text) + 1):
        encoder = encoder_type()
        first = encoder.encode(text[:cut])
        state = encoder.getstate()
        assert isinstance(state, int)
        encoder.reset()
        encoder.setstate(state)
        assert encoder.getstate() == state
        assert first + encoder.encode(text[cut:], True) == text.encode(encoding)
        restored = encoder_type()
        restored.setstate(state)
        assert first + restored.encode(text[cut:], True) == text.encode(encoding)
    decoder_type = codecs.getincrementaldecoder(encoding)
    data = text.encode(encoding)
    for cut in range(len(data) + 1):
        decoder = decoder_type()
        first = decoder.decode(data[:cut])
        state = decoder.getstate()
        decoder.reset()
        decoder.setstate(state)
        assert decoder.getstate() == state
        assert first + decoder.decode(data[cut:], True) == text
        restored = decoder_type()
        restored.setstate(state)
        assert first + restored.decode(data[cut:], True) == text
print('restored')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'restored\n',
    uncaughtException: undefined,
  });
});

test('buffered writes count contiguous typed buffers in bytes and reject strided views before writing', () => {
  const program = `import io, array
for code, values in [('I', [0x12345678, 0x11223344]), ('d', [1.5, 2.5]), ('b', [1, 2, 3])]:
    data = array.array(code, values)
    for size in [2, 4, 16, 32]:
        target = io.BytesIO()
        writer = io.BufferedWriter(target, size)
        assert writer.write(data) == len(data.tobytes())
        writer.flush()
        assert target.getvalue() == data.tobytes()
        assert writer.write(memoryview(data)) == len(data.tobytes())
        writer.flush()
        assert target.getvalue() == data.tobytes() * 2
        try: writer.write(memoryview(b'abcd')[::2])
        except BufferError as error: assert str(error) == 'memoryview: underlying buffer is not C-contiguous'
        else: raise AssertionError('accepted strided buffer')
        assert target.getvalue() == data.tobytes() * 2
print('written')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'written\n',
    uncaughtException: undefined,
  });
});

test('text position cookies retain CPython field widths across pending CRLF and stateful decoding', () => {
  const program = String.raw`import io
for encoding in ['latin-1', 'iso2022_jp']:
    stream = io.TextIOWrapper(io.BytesIO(b'a\r\nb'), encoding=encoding, newline='')
    assert stream.read(2) == 'a\r'
    position = stream.tell()
    print(position)
    expected = stream.read()
    stream.seek(position)
    assert stream.read() == expected == '\nb'
print('sought')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '340282367000166625996085689099021713410\n340282367000326829991620776672911949826\nsought\n',
    uncaughtException: undefined,
  });
});
