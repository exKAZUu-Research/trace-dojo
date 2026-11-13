import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('text streams require a BOM only for unspecified UTF byte order', () => {
  const program = `import io
class Chunked(io.BytesIO):
    def read1(self, size=-1): return super().read1(1)
for encoding, data in [('utf-16', b'A\\x00'), ('utf-32', b'A\\x00\\x00\\x00')]:
    try:
        io.TextIOWrapper(io.BytesIO(data), encoding=encoding, errors='replace').read()
    except UnicodeDecodeError as error:
        print(error)
for encoding, data in [('utf-16', b'\\xff\\xfeA\\x00'), ('utf-32', b'\\x00\\x00\\xfe\\xff\\x00\\x00\\x00A'),
                       ('utf-16-le', b'A\\x00'), ('utf-32-be', b'\\x00\\x00\\x00A')]:
    stream = io.TextIOWrapper(Chunked(data), encoding=encoding)
    print(stream.read(1), repr(stream.read()))
for encoding in ('utf-16', 'utf-32'):
    print(repr(io.TextIOWrapper(io.BytesIO(), encoding=encoding).read()))`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "'utf-16' codec can't decode bytes in position 0-1: Stream does not start with BOM\n" +
      "'utf-32' codec can't decode bytes in position 0-3: Stream does not start with BOM\n" +
      "A ''\n".repeat(4) +
      "''\n''\n",
    uncaughtException: undefined,
  });
});

test('bytes and text float formatting use their own errors and preserve user conversion errors', () => {
  const program = `class Number:
    def __float__(self): return 1.25
class BadNumber:
    def __float__(self): raise TypeError('custom')
for format in (b'%.2f', bytearray(b'%e'), '%g'):
    print(format % Number())
    for value in ('x', None, [1], 1+2j, BadNumber()):
        try:
            format % value
        except TypeError as error:
            print(error)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "b'1.25'\n" +
      formatErrors('float argument required') +
      "bytearray(b'1.250000e+00')\n" +
      formatErrors('float argument required') +
      '1.25\n' +
      formatErrors('must be real number'),
    uncaughtException: undefined,
  });
});

test('native type names do not leak into subclass error messages', () => {
  const program = `import ast, csv, hashlib, unicodedata
class Node(ast.AST): pass
class CsvError(csv.Error): pass
for value in (ast.AST(), Node(), hashlib.blake2b(), csv.Error(), CsvError(), unicodedata.ucd_3_2_0):
    try:
        value.absent
    except AttributeError as error:
        print(error)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "'ast.AST' object has no attribute 'absent'\n" +
      "'Node' object has no attribute 'absent'\n" +
      "'_blake2.blake2b' object has no attribute 'absent'\n" +
      "'_csv.Error' object has no attribute 'absent'\n" +
      "'CsvError' object has no attribute 'absent'\n" +
      "'unicodedata.UCD' object has no attribute 'absent'\n",
    uncaughtException: undefined,
  });
});

function formatErrors(message: string): string {
  return ['str', 'NoneType', 'list', 'complex'].map((name) => `${message}, not ${name}\n`).join('') + 'custom\n';
}
