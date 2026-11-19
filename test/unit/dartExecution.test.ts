import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// Dart SDK 3.13.7 (`dart run`) prints the expected output: the VM's hash codes and the bucket order of HashMap and
// HashSet, the default map's insertion order, Random's sequence for a seed, shuffle, and the order sort leaves equal
// elements in.
test('a program prints the hash order, random numbers, and sort order the Dart VM gives', () => {
  const program = String.raw`import 'dart:collection';
import 'dart:math';

void main() {
  var m = <Object?, int>{};
  for (var k in [100, 'apple', 3.5, -7, 'b', 2.0, true, null, 1 << 40]) {
    m[k] = m.length;
  }
  print(m);
  print(HashMap.of({'x': 1, 'yy': 2, 'zzz': 3, 'banana': 4, 'cherry': 5, 'date': 6, 'elder': 7, 'fig': 8, 'grape': 9}));
  print(HashSet.of([10, 3, 77, 1024, 5, 64, 9, 31, 2, 100]));
  print(HashSet.of([1.5, 2.25, 0.1, 3.7, -4.5, 9.75, 100.5, 0.3, 7.125, 1e10 + 0.5]));
  print(['abc'.hashCode, 42.hashCode, (-1).hashCode, 1.5.hashCode, 2.0.hashCode, true.hashCode, null.hashCode]);
  var r = Random(42);
  print([for (var i = 0; i < 5; i++) r.nextInt(100)]);
  print([r.nextDouble(), r.nextBool()]);
  var deck = List.generate(10, (i) => i)..shuffle(Random(7));
  print(deck);
  var words = List.generate(40, (i) => 'w' + ((i * 7) % 13).toString());
  words.sort((a, b) => a.length.compareTo(b.length));
  print(words);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '{100: 0, apple: 1, 3.5: 2, -7: 3, b: 4, 2.0: 5, true: 6, null: 7, 1099511627776: 8}',
      '{cherry: 5, date: 6, x: 1, yy: 2, banana: 4, elder: 7, fig: 8, zzz: 3, grape: 9}',
      '{1024, 64, 2, 3, 100, 5, 9, 10, 77, 31}',
      '{7.125, 0.3, 1.5, 2.25, -4.5, 9.75, 100.5, 0.1, 3.7, 10000000000.5}',
      '[756227931, 487242, 0, 4609434219686920192, 23202, 1231, 2011]',
      '[87, 58, 4, 85, 77]',
      '[0.5996719615235281, false]',
      '[5, 1, 4, 7, 3, 9, 2, 6, 8, 0]',
      '[w0, w7, w1, w8, w2, w9, w3, w6, w4, w5, w5, w4, w6, w0, w7, w1, w8, w2, w9, w3, w3, w4, w9, w5, w2, w0, w0, w7, w1, w8, w6, w11, w10, w10, w12, w11, w11, w12, w10, w12]',
      '',
    ].join('\n'),
  });
});

// The SDK prints doubles without JavaScript's formatting (`100.0`, `1e+21`), wraps ints at 64 bits, and rounds and
// divides as Dart defines.
test('a program formats numbers, strings, records, and collections as Dart does', () => {
  const program = `void main() {
  print([0.1 + 0.2, 1e21, 1e-7, 100.0, -0.0, 1 / 0, 0 / 0, 123456789.123]);
  print([3.14159.toStringAsFixed(2), 1.5.toStringAsExponential(3), 0.000123.toStringAsPrecision(2), 255.toRadixString(16)]);
  print([9223372036854775807 + 1, -7 ~/ 2, -7 % 3, 7.remainder(-3), 5 / 2, 2.5.round(), (-2.5).round(), 1 << 63]);
  print([int.parse('-0x1F'), double.parse('1e3'), num.parse('7'), int.tryParse('x')]);
  print('\${'abc'.padLeft(6, '*')}|\${'Dart'.substring(1, 3)}|\${'a,b,,c'.split(',')}|\${'hello'.replaceAll('l', 'L')}');
  var sb = StringBuffer()..write('x')..writeAll([1, 2], '-')..writeln('!');
  print(sb);
  print((1, name: 'a', 2.0));
  print([1, [2, {3: 'c'}], {4, 5}]);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '[0.30000000000000004, 1e+21, 1e-7, 100.0, -0.0, Infinity, NaN, 123456789.123]',
      '[3.14, 1.500e+0, 0.00012, ff]',
      '[-9223372036854775808, -3, 2, 1, 2.5, 3, -3, -9223372036854775808]',
      '[-31, 1000.0, 7, null]',
      '***abc|ar|[a, b, , c]|heLLo',
      'x1-2!',
      '',
      '(1, 2.0, name: a)',
      '[1, [2, {3: c}], {4, 5}]',
      '',
    ].join('\n'),
  });
});

test('patterns, generics, and an uncaught error behave as the SDK does', () => {
  const program = `sealed class Shape {}

class Circle extends Shape {
  final double r;
  Circle(this.r);
}

class Square extends Shape {
  final double side;
  Square(this.side);
}

double area(Shape s) => switch (s) {
  Circle(r: var r) => 3 * r * r,
  Square(:var side) => side * side,
};

T firstOf<T>(List<T> items) => items.first;

void main() {
  print([area(Circle(1)), area(Square(2))]);
  var (a, b) = (1, 'x');
  print('$a $b');
  var json = {'name': 'Ana', 'tags': ['a', 'b']};
  if (json case {'name': String n, 'tags': [_, var last]}) print('$n $last');
  print(firstOf([3, 4]).isEven);
  int? maybe;
  print(maybe ?? -1);
  var list = [1, 2, 3];
  list[5] = 0;
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[3.0, 4.0]\n1 x\nAna b\nfalse\n-1\n',
    uncaughtException: 'Unhandled exception:\nRangeError (index): Invalid value: Not in inclusive range 0..2: 5',
  });
});

test('stdout is shown, stderr is accepted without being shown, and exit stops the program', () => {
  const program = `import 'dart:io';

void main() {
  stderr.writeln('hidden');
  stdout.write('a');
  stdout.writeln(1);
  exit(3);
  print('not reached');
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'a1\n' });
});

// Each program is an error before it runs in the SDK, at the line given.
test.each([
  { name: 'a type mismatch', body: '  int x = "a";', row: 1 },
  { name: 'a member of a nullable value', body: '  String? s;\n  print(s.length);', row: 2 },
  { name: 'an assignment to a final variable', body: '  final n = 1;\n  n = 2;', row: 2 },
  { name: 'a read before assignment', body: '  int y;\n  print(y);', row: 2 },
  { name: "a missing ';' at the end of the line", body: '  var x = 1\n  print(x);', row: 1 },
  { name: "a missing '}' of an inner block", body: '  if (true) {\n    print(1);\n', row: 1 },
  { name: 'a non-exhaustive switch', body: '  var b = true;\n  print(switch (b) { true => 1 });', row: 2 },
])('$name is a compile error', ({ body, row }) => {
  const result = executeProgram('dart', `void main() {\n${body}\n}\n`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.row).toBe(row);
});

test.each([
  { name: 'standard input', program: "import 'dart:io';\n\nvoid main() {\n  print(stdin.readLineSync());\n}\n" },
  { name: 'async functions', program: 'Future<void> main() async {\n  await Future.delayed(Duration.zero);\n}\n' },
  { name: 'files', program: "import 'dart:io';\n\nvoid main() {\n  print(File('a.txt').readAsStringSync());\n}\n" },
])('$name are rejected as unavailable before running', ({ program }) => {
  const result = executeProgram('dart', program);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toMatch(/この採点環境では使えません。$/);
});
