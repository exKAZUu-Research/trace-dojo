import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('tokenizing continued strings preserves their physical lines and round trips CRLF and LF source', () => {
  const program = String.raw`import io, tokenize, token
for newline in ['\n', '\r\n']:
    for quote in ["'", '"']:
        for prefix in ['', 'r']:
            text = 'value = ' + prefix + quote + 'first\\' + newline + 'second' + quote + newline + '# comment' + newline
            tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
            strings = [t.string for t in tokens if t.type == token.STRING]
            assert strings == [prefix + quote + 'first\\' + newline + 'second' + quote]
            assert tokenize.untokenize(tokens) == text
            for t in tokens:
                if t.type in (token.NEWLINE, token.NL):
                    assert t.string == newline
                    assert t.end == (t.start[0], t.start[1] + len(newline))
for text in ['value = 1', '# comment', '# comment\r\n', 'value = 1\n']:
    tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    assert tokenize.untokenize(tokens) == text
print('tokenized')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'tokenized\n',
    uncaughtException: undefined,
  });
});
