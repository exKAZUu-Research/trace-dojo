import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('star imports resolve package submodules and ignore private implementation differences', () => {
  const program = `from array import *
print(array('i', [1, 2]))
from ipaddress import *
print(ip_address('127.0.0.1'))
from email import *
print(message_from_string('Subject: hi\\n\\nbody')['Subject'], charset.Charset('utf-8'))
from xml import *
print(dom.__name__, parsers.__name__, sax.__name__, etree.__name__)
from re import *
print(findall('a', 'aba'))
from logging import *
print(BufferingFormatter.__name__)
captureWarnings(True)
captureWarnings(False)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "array('i', [1, 2])\n127.0.0.1\nhi utf-8\nxml.dom xml.parsers xml.sax xml.etree\n['a', 'a']\nBufferingFormatter\n",
    uncaughtException: undefined,
  });
});

test.each([
  ['traceback', 'format_exc()'],
  ['logging', 'FileHandler'],
])('unavailable %s exports fail when used after star import', (module, usage) => {
  const program = `from ${module} import *
try:
    print(${usage})
except Exception:
    print('caught')`;
  const result = executeProgram('python', program);
  expect(result).toMatchObject({ kind: 'executed', stdout: '' });
  expect(result).toMatchObject({ uncaughtException: expect.stringContaining('この採点環境では使えません。') });
});
