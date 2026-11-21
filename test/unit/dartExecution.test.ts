import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

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
  print(['𐐨'.toUpperCase(), '𐐀'.toLowerCase(), 'ß'.toUpperCase(), 'İ'.toLowerCase(), 'ᾀ'.toUpperCase(), 'Ა'.toLowerCase()]);
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
      '[𐐀, 𐐨, ß, i, ᾈ, Ა]',
      '',
    ].join('\n'),
  });
});

test('hash sets compare all candidate keys in the same bucket', () => {
  const program = `import 'dart:collection';
class Key {
  final int value;
  Key(this.value);
  int get hashCode => value;
  bool operator ==(Object other) {
    if (other is! Key) return false;
    print([value, other.value]);
    return value == other.value;
  }
}
void main() {
  final set = HashSet<Key>();
  print(set.add(Key(1)));
  print(set.add(Key(9)));
  print(set.remove(Key(17)));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n[1, 9]\ntrue\n[9, 17]\n[1, 17]\nfalse\n',
  });
});

test('integer bit-width conversions honor Dart integer limits', () => {
  const program = `void main() {
  var value = -129;
  for (var width in [-9223372036854775808, -1, 0, 8, 63, 64, 65, 9223372036854775807]) {
    try {
      print(value.toUnsigned(width));
    } on ArgumentError catch (error) {
      print(error);
    }
    try {
      print(value.toSigned(width));
    } on ArgumentError catch (error) {
      print(error);
    }
  }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'Invalid argument(s): -9223372036854775808',
      '-129',
      'Invalid argument(s): -1',
      'Invalid argument(s): -2',
      '0',
      'Invalid argument(s): -1',
      '127',
      '127',
      '9223372036854775679',
      '-129',
      '-129',
      '-129',
      '-129',
      '-129',
      '-129',
      '-129',
      '',
    ].join('\n'),
    uncaughtException: undefined,
  });
});

test('BigInt conversions and shifts report invalid shift counts as Dart errors', () => {
  const program = `void main() {
  var value = BigInt.from(-129);
  for (var width in [-1, 0, 8]) {
    try {
      print(value.toUnsigned(width));
    } on ArgumentError catch (error) {
      print(error);
    }
    try {
      print(value.toSigned(width));
    } on ArgumentError catch (error) {
      print(error);
    }
  }
  try {
    print(value << -1);
  } on ArgumentError catch (error) {
    print(error);
  }
  try {
    print(value >> -1);
  } on ArgumentError catch (error) {
    print(error);
  }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'Invalid argument(s): shift-amount must be positive -1',
      'Invalid argument(s): shift-amount must be positive -2',
      '0',
      'Invalid argument(s): shift-amount must be positive -1',
      '127',
      '127',
      'Invalid argument(s): shift-amount must be positive -1',
      'Invalid argument(s): shift-amount must be positive -1',
      '',
    ].join('\n'),
    uncaughtException: undefined,
  });
});

test('text sinks distinguish omitted values from null and report invalid code points', () => {
  const program = `import 'dart:io';
void main() {
  var buffer = StringBuffer();
  buffer.writeln(null);
  buffer.writeln();
  stdout.writeln(null);
  stdout.writeln();
  try { buffer.writeCharCode(-1); } catch (error) { print(error); }
  try { stdout.writeCharCode(9223372036854775807); } catch (error) { print(error); }
  buffer.writeCharCode(0x1f600);
  print(buffer);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'null',
      '',
      'RangeError: Invalid value: Not in inclusive range 0..1114111: -1',
      'RangeError: Invalid value: Not in inclusive range 0..1114111: 9223372036854775807',
      'null',
      '',
      '😀',
      '',
    ].join('\n'),
  });
});

test('records evaluate in source order and expose their fields through dynamic', () => {
  const program = `int side(int value) { print(value); return value; }
void main() {
  const a = ['a|string:b'];
  const b = ['a', 'b'];
  print([a, b, identical(a, b), identical(b, const ['a', 'b'])]);
  print((side(1), z: side(2), side(3), a: side(4)));
  dynamic record = (7, f: () => 8, name: null);
  print([record.$1, record.f(), record.name]);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[a|string:b], [a, b], false, true]\n1\n2\n3\n4\n(1, 3, a: 4, z: 2)\n[7, 8, null]\n',
  });
});

test('String.fromCharCodes stops at the end of the requested slice', () => {
  const program = `import 'dart:collection';
Iterable<int> streamed() sync* { print('start'); yield 65; }
int visit(int code) { print(code); return code; }
class LoggedList extends ListBase<int> {
  int get length => 1;
  set length(int size) {}
  int operator [](int index) { print('read'); return 65; }
  void operator []=(int index, int value) {}
}
void main() {
  var codes = [65, 66];
  print(String.fromCharCodes(codes, 0, 5));
  print(String.fromCharCodes(codes, 5));
  print(String.fromCharCodes(codes.map(visit), 0, 1));
  for (final source in <Iterable<int>>[codes, {65, 66}, {1: 65, 2: 66}.values, Queue<int>.of(codes)]) {
    final mapped = source.map(visit);
    print('equal=' + String.fromCharCodes(mapped, 2));
    print('past=' + String.fromCharCodes(mapped, 5, 10));
  }
  print('stream=' + String.fromCharCodes(streamed().map(visit), 5));
  print('custom=' + String.fromCharCodes(LoggedList(), 1));
  print('view=' + String.fromCharCodes(UnmodifiableListView<int>(LoggedList()), 5));
  print('inside=' + String.fromCharCodes(LoggedList(), 0, 1));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'AB\n\n65\nA\nequal=\npast=\nequal=\npast=\nequal=\npast=\nequal=\npast=\nstart\n65\nstream=\ncustom=\nview=\nread\ninside=A\n',
  });
});

test('record destructuring requires a compatible static shape', () => {
  const valid = `void main() {
    (int, int)? promoted = (1, 2);
    var (a, b) = promoted;
    (a, b) = (b, a);
    final (parenthesized) = (a, b);
    print(parenthesized);
    Object unmatched = 5;
    if (unmatched case (var x, var y)) { print([x, y]); } else { print('else'); }
    dynamic wrong = 5;
    try { var (x, y) = wrong; print([x, y]); } catch (error) { print(error); }
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    stdout: "(2, 1)\nelse\ntype 'int' is not a subtype of type '(dynamic, dynamic)'\n",
  });
  for (const body of [
    'var (a, b) = source; print(a);',
    'Object value = (1, 2); var (a, b) = value; print(a);',
    'var (a, b) = 5; print(a);',
    'var (a, b) = (1, 2, 3); print(a);',
    'var (a, :named) = (1, other: 2); print(a);',
    'Object value = (1, 2); int a = 0, b = 0; (a, b) = value;',
  ]) {
    const program = `(int, int)? get source => (1, 2); void main() { ${body} }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
});

test('conditions cast dynamic operands to bool and preserve short-circuiting', () => {
  const program = `void main() {
  dynamic value = 1;
  try { if (value) print('bad'); } catch (error) { print(error); }
  try { print(true && value); } catch (error) { print(error); }
  try { print(!value); } catch (error) { print(error); }
  print(false && value);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: `type 'int' is not a subtype of type 'bool'\n`.repeat(3) + 'false\n',
  });
});

test('finally propagates assignments in functions and synchronous generators', () => {
  const program = `Iterable<int> generate() sync* {
  int x;
  try { yield 4; } finally { x = 5; }
  yield x;
}
void main() {
  int local;
  try { print('try'); } finally { local = 3; }
  print(local);
  print(generate().toList());
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'try\n3\n[4, 5]\n' });
});

test('large integer inputs distinguish int overflow from exact BigInt values', () => {
  const program = `void main() {
  print(int.tryParse('9' * 600000));
  print(int.tryParse('0xffffffffffffffff'));
  print(BigInt.parse('2' * 150000, radix: 3).bitLength);
  final padding = '0' * 800000;
  print(BigInt.parse(padding, radix: 36));
  print(BigInt.parse('-' + padding + 'z', radix: 36));
  print(BigInt.parse('  -0x' + padding + 'f  '));
  print(BigInt.tryParse(padding + 'z', radix: 16));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'null\n-1\n237745\n0\n-35\n-15\nnull\n',
  });
});

test('large BigInt inputs are checked by their exact size at the boundary', () => {
  for (const [radix, zeros] of [
    [36, 773_705],
    [20, 925_512],
  ]) {
    const program = `void main() { print(BigInt.parse('0001' + '0' * ${zeros}, radix: ${radix}).bitLength); }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3999997\n' });
  }
  const oversized = `void main() {
    try { print(BigInt.parse('000z' + 'z' * 773705, radix: 36).bitLength); }
    catch (error) { print(error.runtimeType); }
  }`;
  expect(executeProgram('dart', oversized)).toMatchObject({ kind: 'executed', stdout: 'OutOfMemoryError\n' });
});

test('setRange follows each list kind and copies overlapping ranges', () => {
  const program = `void main() {
  var fixed = List<int>.filled(3, 0);
  var growable = [0, 0, 0];
  for (var list in [fixed, growable]) {
    list.setRange(0, 1, [1, 2].map((value) { print(value); return value; }));
    list.setRange(1, 3, list);
    print(list);
  }
  growable.setRange(0, 1, [1, 2, 3].map((value) {
    if (value == 1) throw 'skipped';
    print(value);
    return value;
  }), 1);
  print(growable);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\n[1, 1, 0]\n1\n2\n[1, 1, 0]\n2\n3\n[2, 1, 0]\n',
  });
});

test('dotted Dart constants resolve as prefixes or named constructors', () => {
  const program = `import 'dart:math' as m;
enum Option { one, two }
class Example { const Example.named(); }
void main() {
  print(const m.Point(1, 2));
  print(new m.Point(3, 4));
  print(const Example.named());
  if ((Option.one, m.pi) case (Option.one, m.pi)) print('matched');
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: "Point(1, 2)\nPoint(3, 4)\nInstance of 'Example'\nmatched\n",
  });
});

test('initializing formals only occur in constructors that can bind them', () => {
  const valid = `class Parent {
    final int value;
    const Parent({required this.value});
  }
  class Child extends Parent {
    const Child({required super.value});
  }
  void main() { print(const Child(value: 3).value); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '3\n' });
  for (const invalid of [
    'void f(this.value) {}',
    'class A { int value = 1; void f(super.value) {} }',
    'class A { int value = 1; f(this.value) {} }',
    'void f() { final g = (this.value) {}; g(1); }',
    'void f() { void local({required super.value}) {} local(value: 1); }',
    'class A { final int value = 1; A.named(); factory A(this.value) => A.named(); }',
    'class A { final int value = 1; A.named(); factory A(this.value) = A.named; }',
    'class A { final int value; A.named(this.value); A(this.value) : this.named(value); }',
  ]) {
    expect(executeProgram('dart', `${invalid} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('try blocks require a handler or finally', () => {
  const valid = `void main() {
    try { throw StateError('raised'); } on StateError { print('caught'); }
    try { print('body'); } finally { print('finished'); }
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: 'caught\nbody\nfinished\n' });
  expect(executeProgram('dart', `void main() { try { print('body'); } print('finished'); }`)).toMatchObject({
    kind: 'compileError',
  });
});

test('required named parameters cannot have defaults', () => {
  for (const declarations of [
    'void f({required int n = 1}) {}',
    'class A { A({required int n = 1}); }',
    'class A { A.named({int n = 1}); factory A({required int n = 1}) = A.named; }',
    'void f() { void local({required int n = 1}) {} }',
    'void f() { var closure = ({required int n = 1}) {}; }',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('setters use one required positional argument and return void', () => {
  const valid = `typedef Nothing = void;
int value = 0;
Nothing set top(int n) { value = n; }
class A { void set property(int n) { value += n; } }
void main() { top = 1; A().property = 2; print(value); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '3\n' });
  for (const declarations of [
    'int set x(int n) => n;',
    'set x([int n = 1]) {}',
    'set x({required int n}) {}',
    'class A { int set x(int n) => n; }',
    'class A { static set x([int n = 1]) {} }',
    'extension A on int { dynamic set x(int n) {} }',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('covariant parameters follow the rules of their declaration context', () => {
  const valid = `class A(covariant var int value) { void set property(covariant int n) { value = n; } }
void main() { final object = A(1); object.property = 2; print(object.value); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '2\n' });
  for (const declarations of [
    'void f(covariant int n) {}',
    'class A { static void f(covariant int n) {} }',
    'extension A on int { void f(covariant int n) {} }',
    'extension type A(int value) { void f(covariant int n) {} }',
    'class A(covariant int value) {}',
    'class A(covariant final int value) {}',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('main receives a checked second argument explicitly set to null', () => {
  const optional = 'void main(List<String> args, [dynamic value = 10]) { print([args, value]); }';
  expect(executeProgram('dart', optional)).toMatchObject({ kind: 'executed', stdout: '[[], null]\n' });
  const required = 'void main(List<String> args, int value) { print(value); }';
  expect(executeProgram('dart', required)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: "Unhandled exception:\ntype 'Null' is not a subtype of type 'int' of 'value'",
  });
});

test('dynamic writes and for-in assignments enforce the target type', () => {
  const program = `class Box {
  int field = 1;
  set value(int value) { print(value); }
}
int global = 0;
void main() {
  dynamic box = Box();
  try { box.field = 'a'; } catch (e) { print(e); }
  try { box.value = 'a'; } catch (e) { print(e); }
  print(box.field);
  for (global in [7, 8]) print(global);
  int local = 0;
  Iterable<dynamic> items = ['x'];
  try { for (local in items) print(local); } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      `type 'String' is not a subtype of type 'int' of 'value'\n`.repeat(2) +
      "1\n7\n8\ntype 'String' is not a subtype of type 'int'\n",
  });
});

test('synchronous generators preserve iteration captures, patterns, and yield-star types', () => {
  const program = `Iterable<int Function()> callbacks() sync* {
  for (var index = 0; index < 3; index++) { yield () => index; }
}
Iterable<int> patterned(Object? x) sync* {
  if (x case (int value, _) when value > 0) { yield value; } else { yield 0; }
}
Iterable<int> invalidYield() sync* { dynamic values = ['x']; yield* values; }
void main() {
  print([for (var callback in callbacks()) callback()]);
  print(patterned((4, 0)).toList());
  print(patterned((0, 0)).toList());
  try { print(invalidYield().first); } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: "[0, 1, 2]\n[4]\n[0]\ntype 'List<String>' is not a subtype of type 'Iterable<int>'\n",
  });
});

test('a compound assignment retries a late initializer that throws', () => {
  const program = `void main() {
  var attempts = 0;
  int init() {
    attempts++;
    if (attempts == 1) throw 'retry';
    return 4;
  }
  late int x = init();
  try { x += 1; } catch (e) { print(e); }
  x += 2;
  print(x);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'retry\n6\n' });
});

test('num.compareTo orders precise integers, signed zeros, and NaN', () => {
  const program = `void main() {
  print(9007199254740993.compareTo(9007199254740992.0));
  print(9223372036854775808.0.compareTo(9223372036854775807));
  print((-0.0).compareTo(0));
  print(double.nan.compareTo(double.infinity));
  print([double.nan.clamp(0, 1), double.nan.clamp(-5.0, double.infinity)]);
  int a = -9223372036854775808;
  double b = -9223372036854775808.0;
  print([a == b, a.hashCode == b.hashCode, {a, b}.length, {a: 'yes'}[b]]);
  print([7.oneBitCount, (-1).oneBitCount, 8.trailingZeroBitCount, 0.trailingZeroBitCount]);
  print([2.modPow(0, 1), 2.modPow(1, 1), a.gcd(0), 0.gcd(a), a.gcd(14)]);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '1\n1\n-1\n1\n[1, Infinity]\n[true, true, 1, yes]\n[3, 64, 3, 64]\n[1, 0, -9223372036854775808, -9223372036854775808, 2]\n',
  });
});

test('min and max use Dart mixed comparisons and preserve signed-zero results', () => {
  const program = `import 'dart:math';
void main() {
  int a = 9007199254740993;
  double b = 9007199254740992.0;
  print([min(a, b), min(b, a), max(a, b), max(b, a)]);
  print([min(0, -0.0), max(-0.0, 0), min(0.0, -0.0), max(-0.0, 0.0)]);
  print([min(1, double.nan), max(double.nan, 1)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[9007199254740993, 9007199254740992.0, 9007199254740993, 9007199254740992.0]\n[-0.0, 0, -0.0, 0.0]\n[NaN, NaN]\n',
  });
});

test('geometry uses SDK dimension normalization and deterministic hashes', () => {
  const program = `import 'dart:math';
void main() {
  print([Point(1, 2).hashCode, Point(1.0, 2.0).hashCode]);
  print([Rectangle(1, 2, 3, 4).hashCode, MutableRectangle(1, 2, 3, 4).hashCode]);
  print([Point(-1, 2.5).hashCode, Rectangle(1.5, 2.5, 3.5, 4.5).hashCode]);
  print(Object.hashAllUnordered([1, 2, 3]));
  const fixed = Rectangle<double>(0, 0, double.negativeInfinity, -0.0);
  var mutable = MutableRectangle<double>(0, 0, -0.0, double.nan);
  print([fixed.width, fixed.height, mutable.width, mutable.height]);
  mutable.width = -0.0;
  mutable.height = double.negativeInfinity;
  print([mutable.width, mutable.height, Rectangle(0, 0, -7, 1).width]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[472247166, 472247166]\n[64923539, 64923539]\n[11525266, 158132701]\n12378480\n[0.0, 0.0, 0.0, NaN]\n[-0.0, 0.0, 0]\n',
  });
});

test('extensible SDK classes allow subclasses and implementations', () => {
  const program = `import 'dart:collection';
import 'dart:math';
class Location extends Point<int> { Location() : super(1, 2); }
abstract class Coordinates implements Point<int> {}
abstract class Call implements Invocation {}
class LocalCall extends Invocation {
  Symbol get memberName => #hello;
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class Handler {
  dynamic noSuchMethod(Invocation invocation) {
    print(invocation.namedArguments.runtimeType);
    print(invocation.namedArguments);
    try { invocation.namedArguments[#added] = 2; } catch (error) { print(error); }
  }
}
class Wait extends Duration { const Wait() : super(seconds: 5); }
class Message extends StringBuffer { Message() : super('hello'); }
abstract class MixedList with ListBase<int> {}
abstract class MixedMap with MapMixin<String, int> {}
abstract class MixedSet with SetBase<int> {}
void main() {
  print(Location());
  print(const Wait().inSeconds);
  StringSink sink = Message();
  sink.write(' world');
  print(sink);
  print(LocalCall().memberName);
  dynamic handler = Handler();
  handler.missing(a: 1);
  handler.missingGetter;
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'Point(1, 2)\n5\nhello world\nSymbol("hello")\nUnmodifiableMapView<Symbol, Object?>\n{Symbol("a"): 1}\nUnsupported operation: Cannot modify unmodifiable map\n_ConstMap<Symbol, Object?>\n{}\nUnsupported operation: Cannot modify unmodifiable map\n',
  });
  for (const name of ['Comparable<int>', 'Type', 'Pattern', 'ListQueue<int>', 'SplayTreeSet<int>']) {
    const invalid = `import 'dart:collection'; abstract class Invalid extends ${name} {} void main() {}`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('Iterable.generate requires a compatible generator only for positive counts', () => {
  const program = `void main() {
  print(Iterable<String>.generate(-1).toList());
  print(Iterable<String>.generate(0).toList());
  print(Iterable<num>.generate(2).toList());
  print(Iterable<String>.generate(2, (i) => i.toString()).toList());
  try { print(Iterable<String>.generate(2)); } catch (error) { print(error); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[]\n[]\n[0, 1]\n[0, 1]\nInvalid argument(s) (generator): Generator must be supplied or element type must allow integers\n',
  });
});

test('a parameter can only narrow an override when explicitly covariant', () => {
  const invalid = 'class A<T> { void f(T value) {} } class B extends A<num> { void f(int value) {} } void main() {}';
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  const valid = `class A { void f({covariant num value = 0}) {} }
class B extends A { void f({int value = 0}) { print(value); } }
void main() {
  A object = B();
  object.f(value: 7);
  try { object.f(value: 1.5); } catch (e) { print(e.runtimeType); }
}
`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '7\n_TypeError\n' });
});

test('inherited implementations must match new interfaces and mixin constraints', () => {
  const incompatible = `abstract class Reader { int read(); }
class Parent { String read() => 'text'; }
abstract class Child extends Parent implements Reader {}
void main() {}`;
  expect(executeProgram('dart', incompatible)).toMatchObject({ kind: 'compileError' });
  const declarations = `abstract class Reader { int read(); }
class Parent<T> { final T value; Parent(this.value); T read() => value; }
mixin Shared<T> on Parent<T> { T readShared() => value; }`;
  const valid = `${declarations}
class Child extends Parent<int> with Shared<int> implements Reader { Child() : super(3); }
void main() { final child = Child(); print([child.read(), child.readShared()]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[3, 3]\n' });
  const wrongMixin = `${declarations}
class Child extends Parent<String> with Shared<int> { Child() : super('text'); }
void main() {}`;
  expect(executeProgram('dart', wrongMixin)).toMatchObject({ kind: 'compileError' });
});

test('redirecting factories check argument types and shapes against their targets', () => {
  for (const parameters of ['', 'int number', '{required String name}']) {
    const invalid = `abstract class A { factory A(String text) = B; }
class B implements A { B(${parameters}); }
void main() {}`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `abstract class A<T> { T get value; factory A(T value, {bool? flag}) = B<T>; }
class B<T> implements A<T> {
  final T value;
  B(this.value, {bool? flag});
}
void main() { print(A<int>(3, flag: true).value); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '3\n' });
});

test('strings and null-aware indexing preserve Dart syntax', () => {
  const program = String.raw`class A {
  String toString() => 'A1';
  void show() { print('$this'); }
}
class N { List<int>? xs; }
void main() {
  A().show();
  print('''\nabc''');
  print('''
literal''');
  var n = N();
  n.xs?[1] = 7;
  n.xs = [5, 6];
  n.xs?[1] = 7;
  n.xs?[0]++;
  print(n.xs);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'A1\n\nabc\nliteral\n[6, 7]\n' });
});

test('type aliases, super defaults, and field initializers resolve in their declaration context', () => {
  const program = String.raw`typedef IntBox = Box<int>;
typedef Forward = Later;
typedef Later = int;
class Box<T extends num> { T value; Box(this.value); }
class A { static const original = 10; int x; A([this.x = original]); }
class B extends A { B(int marker, [super.x]); }
class Named { final int x; const Named.named({this.x = 2}); }
class Derived extends Named { const Derived({super.x}) : super.named(); }
class Twice extends Derived { const Twice({super.x = 3}); }
int write(String label, int value) { print(label); return value; }
class Fields {
  int x = write('declaration', 1);
  Fields() : x = write('list', 2);
}
void main() {
  Forward a = IntBox(8).value;
  print(a);
  print(B(1).x);
  print([const Derived().x, const Derived(x: 4).x, const Twice().x]);
  print(Fields().x);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: ['8', '10', '[2, 4, 3]', 'declaration', 'list', '2', ''].join('\n'),
  });
});

test('enhanced enums, self-bounded generics, and covariant setters compile', () => {
  const program = String.raw`mixin Greet { String hi() => 'hi'; }
enum Lang with Greet { en, ja }
class A<T extends A<T>> { T self() => this as T; }
class B extends A<B> {}
class Parent { set x(covariant num value) {} }
class Child extends Parent { set x(int value) { print(value); } }
void main() {
  print(Lang.en.hi());
  print(B().self());
  Parent p = Child();
  p.x = 1;
  try { p.x = 1.5; } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: ['hi', "Instance of 'B'", '1', "type 'double' is not a subtype of type 'int' of 'value'", ''].join('\n'),
  });
});

test('mixin fields use application slots and concrete generic arguments', () => {
  const program = `class Base { int base = 10; }
mixin Data<T> {
  late int value = 20;
  late final int setOnce;
  List<T> values = <T>[];
  late List<T> lazy = <T>[];
}
class C<T> extends Base with Data<T> {}
void main() {
  final c = C<int>();
  print([c.base, c.value]);
  c.value = 30;
  c.setOnce = 40;
  c.values.add(1);
  c.lazy.add(2);
  print([c.base, c.value, c.setOnce, c.values.runtimeType, c.values, c.lazy]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[10, 20]\n[10, 30, 40, List<int>, [1], [2]]\n',
  });
});

test('list views support patterns and codecs through their public members', () => {
  const program = String.raw`import 'dart:convert';
void main() {
  final view = [65, 66, 67].cast<int>();
  if (view case [var head, ..., var tail]) print(head + tail);
  if (view case [_, ...var middle, _]) print(middle);
  print(utf8.decode(view));
  print(utf8.encode('aé😀\uD800'));
  print(utf8.encoder.convert('a😀b', 1, 2));
  print(utf8.encoder.convert('a😀b', 1, 3));
  print(utf8.decoder.convert(view, 1, 3));
  print(Utf8Decoder(allowMalformed: true).convert([65, 255, 66], 1, 2));
  try { utf8.decoder.convert([65, 255, 66], 1, 2); } catch (error) { print(error); }
  try { utf8.encoder.convert('a', 0, 2); } catch (error) { print(error); }
  print(base64.encode(view));
  print(base64.encoder.convert([65]));
  print(base64Url.encoder.convert([255]));
  print(base64.decoder.convert('xxQQ==yy', 2, 6));
  for (var illegal in [[256], [65, -1]]) {
    try { print(base64.encode(illegal)); } catch (e) { print(e); }
  }
  print(base64.normalize('xxSGk=yy', 2, 6));
  print(base64.normalize('xxSGkyy', 2, 5));
  print(base64Url.normalize('xx%2D%5Fyy', 2, 8));
  print(base64.normalize('xxab==yy', 2, 6));
  try { print(base64.normalize('xxa=yy', 2, 4)); } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      '132',
      '[66]',
      'ABC',
      '[97, 195, 169, 240, 159, 152, 128, 239, 191, 189]',
      '[239, 191, 189]',
      '[240, 159, 152, 128]',
      'BC',
      '�',
      'FormatException: Invalid UTF-8 byte (at offset 1)',
      'RangeError (end): Invalid value: Not in inclusive range 0..1: 2',
      'QUJD',
      'QQ==',
      '_w==',
      '[65]',
      "Invalid argument (Not a byte value at index 0: 0x100): Instance(length:1) of '_GrowableList'",
      "Invalid argument (Not a byte value at index 1: 0x-1): Instance(length:2) of '_GrowableList'",
      'xxSGk=yy',
      'xxSGk=yy',
      'xx+/==yy',
      'xxab==yy',
      'FormatException: Invalid base64 padding, padded length must be multiple of four, is 2 (at character 5)',
      'xxa=yy',
      '    ^',
      '',
      '',
    ].join('\n'),
  });
  const oversized = "import 'dart:convert'; void main() { print(utf8.encode('é' * 500000).length); }";
  expect(executeProgram('dart', oversized)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test('Base64 encoding and normalization apply the full output limit', () => {
  const program = `import 'dart:convert';
void main() {
  var bytes = List<int>.filled(750001, 0);
  try { print(base64Url.encode(bytes).length); } catch (error) { print(error); }
  var text = 'AA' + 'x' * 999998;
  try { print(base64.normalize(text, 0, 2).length); } catch (error) { print(error); }
  print(base64.normalize(text.substring(0, text.length - 2), 0, 2).length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Out of Memory\nOut of Memory\n1000000\n',
  });
});

test('patterns stop after a requested match and preserve special capture names', () => {
  const program = String.raw`class P implements Pattern {
  Iterable<Match> allMatches(String text, [int start = 0]) sync* {
    yield RegExp('a').firstMatch(text)!;
    throw 'extra';
  }
  Match? matchAsPrefix(String text, [int start = 0]) => RegExp('a').matchAsPrefix(text, start);
}
void main() {
  print('aa'.replaceFirst(P(), 'b'));
  print('aa'.replaceFirstMapped(P(), (match) => match[0]!.toUpperCase()));
  final iterable = RegExp('a').allMatches('aba');
  print(iterable.map((match) => match.start).toList());
  print(iterable.first.end);
  print(RegExp('a').allMatches('a' * 1000000).first[0]);
  final names = RegExp(r'(?<word>a)(?<__proto__>b)').firstMatch('ab')!;
  print(names.namedGroup('__proto__'));
  try { print(names.namedGroup('constructor')); } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      'ba',
      'Aa',
      '[0, 2]',
      '1',
      'a',
      'b',
      'Invalid argument(s): Not a capture group name: constructor',
      '',
    ].join('\n'),
  });
});

test.each([
  'enum E { a; E(); } void main() {}',
  'enum E { a } void main() { E(); }',
  'enum E { a } class Child extends E {} void main() {}',
  'class A { set x(int value) {} } class B extends A { set x(String value) {} } void main() {}',
])('rejects invalid enum declarations and setter overrides: %s', (source) => {
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
});

test('turtles stay live through instance callbacks and generator collection', () => {
  const closures = `class Actor {
  final turtle = Turtle(0, 1);
  void Function() callback() => () => turtle.forward();
}
void main() {
  var move = Actor().callback();
  var other = Turtle(0, 0);
  print(other.canMoveForward());
  move();
}
`;
  const generator = `Iterable<Turtle> turtles() sync* {
  yield Turtle(1, 1);
  var second = Turtle(3, 3);
  second.canMoveForward();
  yield second;
}
void main() {
  var list = List<Turtle>.from(turtles());
  list[0].forward();
}
`;
  expect(executeProgram('dart', closures)).toMatchObject({
    kind: 'executed',
    stdout: 'false\n',
    finalTurtles: [
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ],
  });
  expect(executeProgram('dart', generator)).toMatchObject({
    kind: 'executed',
    finalTurtles: [
      { x: 1, y: 2 },
      { x: 3, y: 3 },
    ],
  });
  const iterables = `late Turtle saved;
class KeyIterator implements Iterator<Turtle> {
  bool _ready = true;
  bool moveNext() { final result = _ready; _ready = false; return result; }
  Turtle get current => Turtle(1, 1);
}
class ValueIterator implements Iterator<int> {
  bool _ready = true;
  bool moveNext() { final result = _ready; _ready = false; return result; }
  int get current { Turtle(3, 3).canMoveForward(); return 1; }
}
class Keys extends Iterable<Turtle> { Iterator<Turtle> get iterator => KeyIterator(); }
class Values extends Iterable<int> { Iterator<int> get iterator => ValueIterator(); }
void main() {
  final map = Map<Turtle, int>.fromIterables(Keys(), Values());
  saved = map.keys.first;
  saved.forward();
}`;
  expect(executeProgram('dart', iterables)).toMatchObject({ kind: 'executed', finalTurtles: [{ x: 1, y: 2 }] });
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

// The SDK solves a generic call's type arguments from its context first (Object? for print's argument), clamps them to
// their bounds, promotes through a bool local holding a condition, and lets a closure with a void body take any context.
test('inference and flow analysis follow the SDK', () => {
  const program = `T maxOf<T extends Comparable<T>>(List<T> xs) => xs.reduce((a, b) => a.compareTo(b) >= 0 ? a : b);
T id<T>(T x) {
  print(T);
  return x;
}

void main() {
  int? x = 3;
  final ok = x != null;
  if (ok) print(x + 1);
  Object? Function() f = () => [1].add(2);
  print(f());
  print(id(1));
  num n = id(2);
  print(n);
  print(maxOf(['b', 'a']));
  print([[1], [2.5]].runtimeType);
  print(maxOf([3, 9, 2]));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '4\nnull\nObject?\n1\nnum\n2\nb\nList<List<num>>\n',
    uncaughtException:
      "Unhandled exception:\ntype '(num, num) => num' is not a subtype of type '(int, int) => int' of 'combine'",
  });
});

// The interpreter matches regular expressions with its own engine, which must keep ECMAScript's backtracking order,
// the groups each iteration of a loop clears, lookbehind's backward matching, and Unicode and case-insensitive modes.
test("regular expressions match as the VM's Irregexp does", () => {
  const program = String.raw`void main() {
  String show(RegExpMatch m) => [for (var g = 0; g <= m.groupCount; g++) m[g]].toString();
  print(show(RegExp(r'(z)((a+)?(b+)?(c))*').firstMatch('zaacbbbcac')!));
  print(show(RegExp(r'(.*?)a(?!(a+)b\2c)\2(.*)').firstMatch('baaabaac')!));
  print(show(RegExp(r'(?<=(\d+)(\d+))$').firstMatch('1053')!));
  print(show(RegExp(r'(a*)*b').firstMatch('aaab')!));
  print(RegExp(r'(?<q>["\x27]).*?\k<q>').allMatches('"a" \'b\'').map((m) => m.namedGroup('q')).toList());
  print(RegExp(r'\bfoo\b').allMatches('foo foobar foo.').map((m) => m.start).toList());
  print(RegExp(r'^\w+$', multiLine: true).allMatches('one\ntwo').map((m) => m[0]).toList());
  print(RegExp(r'(?i:a)b').allMatches('aB Ab ab').map((m) => m.start).toList());
  print([RegExp(r'ſ', caseSensitive: false).hasMatch('S'), RegExp(r'ſ', caseSensitive: false, unicode: true).hasMatch('S')]);
  print('😀😀'.split(RegExp('', unicode: true)).length);
  print('a1b22c333'.replaceAllMapped(RegExp(r'(\d)(\d*)'), (m) => '<' + m[1]! + '|' + m[2]! + '>'));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '[zaacbbbcac, z, ac, a, null, c]',
      '[baaabaac, ba, null, abaac]',
      '[, 1, 053]',
      '[aaab, aaa]',
      '[", \']',
      '[0, 11]',
      '[one, two]',
      '[3, 6]',
      '[false, true]',
      '2',
      'a<1|>b<2|2>c<3|33>',
      '',
    ].join('\n'),
  });
});

// Neither a host RegExp nor a host BigInt operation can be interrupted, so they must stop at the limits before they
// hold the server's process.
test.each([
  {
    name: 'a regular expression that backtracks exponentially',
    body: "  print(RegExp(r'(x+x+)+y').hasMatch('x' * 40));",
  },
  {
    name: 'a gcd of BigInts with millions of bits',
    body: '  var a = (BigInt.one << 2000000) - BigInt.one;\n  print(a.gcd(a - BigInt.two));',
  },
])('$name stops at the operation limit', ({ body }) => {
  expect(executeProgram('dart', `void main() {\n${body}\n}\n`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test('a BigInt too large to compute runs out of memory before it is computed', () => {
  const program = `void main() {
  var x = BigInt.from(3);
  try {
    for (var i = 0; i < 40; i++) x = x * x;
  } catch (e) {
    print(e);
  }
  print(x.bitLength);
  try { print((BigInt.one << 3500000).toString().length); } catch (e) { print(e); }
  try { print((BigInt.one << 2000000).toRadixString(3).length); } catch (e) { print(e); }
  print((BigInt.one << 999999).toRadixString(2).length);
  try { print(((-BigInt.one) << 999999).toRadixString(2).length); } catch (e) { print(e); }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Out of Memory\n3323908\nOut of Memory\nOut of Memory\n1000000\nOut of Memory\n',
  });
});

test('stdout is shown, stderr is accepted without being shown, and exit stops the program', () => {
  const program = `import 'dart:io';

void main() {
  Stdout out = stdout;
  Stdout err = stderr;
  err.writeln('hidden');
  print(out.runtimeType);
  out.write('a');
  out.writeln(1);
  exit(3);
  print('not reached');
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Stdout\na1\n' });
  for (const statement of ['stdout.flush()', 'stdout.close()', 'print(stdout.done)', 'exitCode = 2']) {
    const result = executeProgram('dart', `import 'dart:io'; void main() { ${statement}; }`);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toMatch(/この採点環境では使えません。$/);
  }
});

test('nullable values can use Object members and still dispatch to overrides', () => {
  const program = `class Marker {
  String toString() => 'marker';
  int get hashCode => 42;
}
void inspect(int? i, String? s, List<int>? l, Marker? marker) {
  print([i.toString(), s.toString(), l.toString()]);
  print(l.hashCode == null.hashCode);
  final text = i.toString;
  print(text());
  print([marker.toString(), marker.hashCode]);
}
void main() { inspect(null, null, null, Marker()); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[null, null, null]\ntrue\nnull\n[marker, 42]\n',
  });
});

test('extension types can expose members of compatible representation interfaces', () => {
  const program = `extension type NumberE(int value) implements int { NumberE get same => this; }
extension type Measure(double value) implements num {}
extension type Wrapped(int data) implements NumberE {}
void main() {
  int i = NumberE(3);
  print([i, NumberE(3).same.isOdd, Measure(1.5).floor(), Wrapped(5).value]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[3, true, 1, 5]\n' });
  const invalid = 'extension type Invalid(String value) implements int {} void main() {}';
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
});

test('cyclic subtype edges produce a diagnostic before pattern analysis', () => {
  for (const declaration of [
    'class A implements A {}',
    'sealed class A implements B {} sealed class B implements A {}',
    'mixin A on B {} class B with A {}',
  ]) {
    expect(executeProgram('dart', `${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('only assigned non-late locals can be read by a new closure', () => {
  expect(executeProgram('dart', 'void main() { int x; var read = () => x; x = 1; print(read()); }')).toMatchObject({
    kind: 'compileError',
  });
  const valid = 'void main() { late int x; var read = () => x; x = 1; print(read()); }';
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '1\n' });
});

test('equal method tear-offs work as set and map keys', () => {
  const program = `class Target { void callback() {} }
void main() {
  final target = Target();
  final first = target.callback;
  final second = target.callback;
  print([first == second, first.hashCode == second.hashCode, {first, second}.length, {first: 1}[second]]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[true, true, 1, 1]\n' });
});

test('implicit extension calls require a unique most-specific declaration', () => {
  const declarations = `extension A on int { String get label => 'a'; set label(String s) { print('A:$s'); } }
extension B on int { String get label => 'b'; set label(String s) { print('B:$s'); } }
extension Generic<T> on T { String get kind => 'generic'; }
extension Specific on String { String get kind => 'specific'; }
extension All<T> on List<T> { String get tag => 'all'; }
extension Numbers<T extends num> on List<T> { String get tag => 'numbers'; int size() => length; }
extension Defaults<T, U extends T, V extends X, X extends List<T>, Y> on List<T> {
  (Type, Type, Type) get defaults => (U, V, Y);
}
extension ListType<T> on List<T> {
  Type get item => T;
  Type read() => T;
  T firstValue() => this[0];
  T echo(T value) => value;
}
extension Indices on int {
  int operator [](int index) => this + index;
  void operator []=(int index, int value) { print([index, value]); }
}`;
  expect(executeProgram('dart', `${declarations} void main() { print(1.label); }`)).toMatchObject({
    kind: 'compileError',
  });
  expect(executeProgram('dart', `${declarations} void main() { print(['x'].size()); }`)).toMatchObject({
    kind: 'compileError',
  });
  const program = `${declarations}
(Type, Type) readTypes<U>(List<U> values) {
  final read = values.read;
  return (ListType<U>(values).item, read());
}
void main() {
  print([A(1).label, B(1).label, 'x'.kind]);
  B(1).label = 'direct';
  A(1).label += '!';
  var x = 3;
  x[2] += 4;
  Indices(x)[1] = 6;
  print(readTypes<int>([1]));
  final values = [1];
  print([values.firstValue is int Function(), values.echo.runtimeType]);
  print([values.tag, ['x'].tag]);
  print(values.defaults);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[a, b, specific]\nB:direct\nA:a!\n[2, 9]\n[1, 6]\n(int, int)\n[true, (int) => int]\n[numbers, all]\n(int, List<int>, dynamic)\n',
  });
});

test('labeled exits join the flow of their own target', () => {
  const missing = `int value() {
  outer: while (true) { while (true) { break outer; } }
}
void main() { print(value()); }`;
  expect(executeProgram('dart', missing)).toMatchObject({ kind: 'compileError' });
  const unassigned = `int value() {
  int answer;
  outer: do { while (true) { answer = 7; continue outer; } } while (false);
  return answer;
}
void main() { print(value()); }`;
  expect(executeProgram('dart', unassigned)).toMatchObject({ kind: 'compileError' });
  const valid = `int value() {
  int answer;
  done: {
    while (true) { answer = 7; break done; }
  }
  return answer;
}
Iterable<int> items() sync* {
  int answer;
  outer: while (true) { while (true) { answer = 8; break outer; } }
  yield answer;
}
int labeledContinue() {
  int answer;
  outer: do { do { answer = 9; continue outer; } while (false); } while (false);
  return answer;
}
int unlabeledContinue() {
  int answer;
  do { answer = 10; continue; } while (false);
  return answer;
}
void main() { print(value()); print(items().first); print(labeledContinue()); print(unlabeledContinue()); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '7\n8\n9\n10\n' });
  for (const [condition, operator] of [
    ['answer + 1 < 0', '+'],
    ['answer < 0', '<'],
    ['-answer < 0', 'unary-'],
  ]) {
    const skipped = `void check(bool skip) {
  int answer;
  outer: do { if (skip) continue outer; answer = 7; continue outer; } while (${condition});
}
void main() {
  try { check(true); } catch (error) { print(error); }
}`;
    expect(executeProgram('dart', skipped)).toMatchObject({
      kind: 'executed',
      stdout: expect.stringContaining(`The method '${operator}' was called on null`),
    });
  }

  const rightOperand = `bool printOperand(Object? value) { print(value); return false; }
void integer(bool skip) {
  int x;
  outer: do { if (skip) continue outer; x = 7; continue outer; } while (printOperand(1 + x));
}
void doubleValue(bool skip) {
  double x;
  outer: do { if (skip) continue outer; x = 7.0; continue outer; } while (printOperand(1.0 + x));
}
void stringValue(bool skip) {
  String x;
  outer: do { if (skip) continue outer; x = 'a'; continue outer; } while (printOperand('b' + x));
}
void main() {
  for (final callback in [integer, doubleValue, stringValue]) {
    try { callback(true); } catch (error) { print(error); }
  }
  dynamic value;
  try { print(1 + value); } catch (error) { print(error); }
}`;
  expect(executeProgram('dart', rightOperand)).toMatchObject({
    kind: 'executed',
    stdout:
      "NoSuchMethodError: The method '_addFromInteger' was called on null.\nReceiver: null\nTried calling: _addFromInteger(1)\nNoSuchMethodError: The method 'toDouble' was called on null.\nReceiver: null\nTried calling: toDouble()\nInvalid argument(s)\ntype 'Null' is not a subtype of type 'num'\n",
  });
});

test('list patterns check the live bounds after matching a mutating getter', () => {
  const program = `late List<Object?> values;
class Clearer {
  int get flag { values.clear(); return 1; }
}
void main() {
  values = [Clearer(), 2];
  try { if (values case [Clearer(flag: 1), var x]) print(x); }
  catch (error) { print(error.runtimeType); }
  values = [Clearer(), 2, 3];
  try { if (values case [Clearer(flag: 1), ..., var x]) print(x); }
  catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'RangeError\nRangeError\n' });
});

test('patterns promote the subject in guarded cases and later alternatives', () => {
  const program = `void inspect(Object? x) {
  if (x case int() when x.isEven) print(x + 1);
  print([if (x case int()) x + 1]);
}
int length(List<Object?>? x) => switch (x) {
  null => -1,
  [] => x.length,
  _ => x.length,
};
void name(String? x) {
  switch (x) { case null: print('missing'); default: print(x.toUpperCase()); }
}
int afterSwitch(String? x) {
  switch (x) { case == null: return -1; }
  return x.length;
}
int relational(int? x) => switch (x) { != null => x + 1, null => 0 };
int combined(int? x) {
  if (x case != null && > 0) return x + 1;
  switch (x) { case 0 || null: return 0; }
  return x + 1;
}
int alternative(int? x) {
  if (x case null || >= 0) return 0;
  return x - 1;
}
void main() {
  inspect(2);
  name(null);
  name('dart');
  print([length([]), length([42]), length(null)]);
  print([afterSwitch('dart'), afterSwitch(null), relational(2), relational(null)]);
  print([combined(3), combined(null), combined(-3), alternative(null), alternative(-2)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '3\n[3]\nmissing\nDART\n[0, 1, -1]\n[4, -1, 3, 0]\n[4, 0, -2, 0, -3]\n',
  });
});

test('private field promotions follow an individual receiver and expire on reassignment', () => {
  const declarations = `class Node {
  final Node? _next;
  final int value;
  Node(this.value, [this._next]);
}
class Wrapper { final Node _head; Wrapper(this._head); }`;
  const valid = `${declarations} void main() {
  var current = Node(1, Node(2, Node(3)));
  var sum = 0;
  while (current._next != null) { current = current._next; sum += current.value; }
  final wrapper = Wrapper(Node(4, Node(5)));
  if ((wrapper)._head._next != null) sum += wrapper._head._next.value;
  print(sum);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '10\n' });
  const invalid = `${declarations} void main() {
  var current = Node(1, Node(2));
  if (current._next != null) { current = Node(3); print(current._next.value); }
}`;
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
});

test('dynamic complement preserves int semantics and rejects doubles', () => {
  const program = `void inspect(dynamic value) {
  try { print(~value); } catch (e) { print(e.runtimeType); }
  print(-value);
}
void main() { inspect(3); inspect(3.5); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '-4\n-3\nNoSuchMethodError\n-3.5\n',
  });
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
  { name: 'a closure typed by the context Object?', body: '  print([1, 2].fold(0, (a, b) => a + b));', row: 1 },
])('$name is a compile error', ({ body, row }) => {
  const result = executeProgram('dart', `void main() {\n${body}\n}\n`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.row).toBe(row);
});

test.each([
  { name: 'standard input', program: "import 'dart:io';\n\nvoid main() {\n  print(stdin.readLineSync());\n}\n" },
  { name: 'async functions', program: 'Future<void> main() async {\n  await Future.delayed(Duration.zero);\n}\n' },
  { name: 'files', program: "import 'dart:io';\n\nvoid main() {\n  print(File('a.txt').readAsStringSync());\n}\n" },
  {
    name: 'secure random constructors',
    program: "import 'dart:math'; void main() { print('before'); try { Random.secure(); } catch (_) {} }",
  },
  {
    name: 'secure random constructor tear-offs',
    program: "import 'dart:math' as m; typedef RandomAlias = m.Random; void main() { print(RandomAlias.secure); }",
  },
  { name: 'stack-trace inspection', program: 'void main() { print(StackTrace.current); }' },
])('$name are rejected as unavailable before running', ({ program }) => {
  const result = executeProgram('dart', program);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toMatch(/この採点環境では使えません。$/);
});

test('assignment retains a temporary indexed receiver through the right-hand side', () => {
  const program = `late Turtle saved;
class Holder {
  final Turtle turtle = Turtle(1, 1);
  void operator []=(int index, int value) { saved = turtle; }
}
int collect() {
  var other = Turtle(3, 3);
  other.canMoveForward();
  return 0;
}
void main() {
  Holder()[0] = collect();
  saved.forward();
}
`;
  const result = executeProgram('dart', program);
  expect(result).toMatchObject({ kind: 'executed', uncaughtException: undefined, finalTurtles: [{ x: 1, y: 2 }] });
});

test('compound assignment requires a readable property before main runs', () => {
  const program = 'class C { set x(int? value) {} } void main() { print("started"); C().x ??= 1; }';
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
});

test('typed collection operations check dynamic values as they enter the collection', () => {
  const program = `Iterable<dynamic> items() sync* {
  yield 1;
  yield 'bad';
  print('late element');
  yield 2;
}
void main() {
  try { List<int>.from(items()); } catch (e) { print(e.runtimeType); }
  try { List<int>.unmodifiable(items()); } catch (e) { print(e.runtimeType); }
  List<num> values = <int>[1, 2];
  try { values.first = 1.5; } catch (e) { print(e.runtimeType); }
  try { values.addAll(values.where((x) => x > 0)); } catch (e) { print(e.runtimeType); }
  print(values);
  Map<num, num> typedMap = <int, int>{};
  try { typedMap.addEntries(<MapEntry<num, num>>[MapEntry(1, 1.5)]); } catch (e) { print(e.runtimeType); }
  typedMap.addEntries(<MapEntry<int, int>>[MapEntry(2, 3)]);
  print(typedMap);
  dynamic source = <num, num>{1: 2};
  print(<int, int>{...source});
  dynamic invalid = 'wrong';
  try { print(<int>[?invalid]); } catch (e) { print(e.runtimeType); }
  print(Map<int, int>.fromIterable([1, 2], key: (x) => x, value: (x) { return x * 2; }));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '_TypeError\n_TypeError\n_TypeError\nConcurrentModificationError\n[1, 2, 1]\n_TypeError\n{2: 3}\n{1: 2}\n_TypeError\n{1: 2, 2: 4}\n',
  });
});

test('switches partition nullable record fields and lists by length', () => {
  const program = `int sum(List<int> xs) => switch (xs) {
  [] => 0, [var head, ...var tail] => head + sum(tail),
};
String shape((int?, dynamic) value) => switch (value) {
  (null, _) => 'left', (_, null) => 'right', (int(), Object()) => 'both',
};
void main() {
  print(sum([1, 2, 3]));
  print(shape((1, 'x')));
  print(shape((1, null)));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '6\nboth\nright\n' });
});

test('switch guards and shared case bodies each read the matched binding', () => {
  const program = `void main() {
  Object value = 3;
  int Function()? read;
  switch (value) {
    case int n when n < 0:
    case int n when ((read = () => n) != null):
      print(n);
      n++;
      print(read!());
  }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3\n3\n' });
  expect(executeProgram('dart', 'void main() { switch (1) { case 1: case int n: print(n); } }')).toMatchObject({
    kind: 'compileError',
  });
});

test('identity maps and custom hash sets keep their key rules through lookups and copies', () => {
  const program = `import 'dart:collection';
class Key {
  int get hashCode => 0;
  bool operator ==(Object other) => other is Key;
}
void main() {
  var key = Key();
  var map = Map<Key, int>.identity()..[key] = 1 ..[Key()] = 2;
  print([map.length, map[Key()], map.remove(key)]);
  bool same(String a, String b) => a.toLowerCase() == b.toLowerCase();
  int hash(String a) => 1;
  var sets = [HashSet<String>(equals: same, hashCode: hash), LinkedHashSet<String>(equals: same, hashCode: hash)];
  for (var set in sets) {
    set.addAll(['abc', 'ABC']);
    print([set.length, set.lookup('ABC'), set.contains(1), set.toSet().remove('ABC')]);
  }
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[2, null, 1]\n[1, abc, false, true]\n[1, abc, false, true]\n',
  });
});

test('a closure inherits promotions when assignments target shadowed locals', () => {
  const program = `void main() {
  int? total = 5;
  if (total != null) print([1, 2].map((value) => value + total));
  for (var i = 0; i < 2; i++) { var total = i; total++; }
  (() { var total = 0; total++; })();
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '(6, 7)\n' });
});

test('generic function arguments constrain parameters in both directions', () => {
  const program = `R Function(A) memo<A, R>(R Function(A) callback) => callback;
T identity<T>(T value) => value;
Type pair<T>(T value, void Function(T) callback) => T;
Type named<T>(void Function({required T value}) callback) => T;
void main() {
  print(memo((int n) => n * n)(4));
  print(pair(1, (num x) {}));
  print(named(({required int value}) {}));
  List<int> mapped = [1, 2].map(identity).toList();
  print(mapped);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '16\nint\nint\n[1, 2]\n' });
  expect(executeProgram('dart', 'int answer() => 42; void main() { print(answer<String>()); }')).toMatchObject({
    kind: 'compileError',
  });
});

test('dynamic generic calls instantiate and check bounds before invoking the body', () => {
  const program = `T echo<T extends num>(T value) => value;
class C { T method<T extends num>(T value) => value; }
void show<T extends U, U extends num>() { print([T, U]); }
void main() {
  dynamic f = echo;
  dynamic receiver = C();
  try { print(f<String>('hello')); } catch (e) { print(e); }
  try { print(f('hello')); } catch (e) { print(e); }
  try { print(receiver.method<String>('hello')); } catch (e) { print(e); }
  print([f(3), receiver.method(4)]);
  dynamic forward = show;
  forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type 'String' is not a subtype of type 'num' of 'T'\ntype 'String' is not a subtype of type 'num' of 'value'\ntype 'String' is not a subtype of type 'num' of 'T'\n[3, 4]\n[num, num]\n",
  });
});

test('nested function types, contextual tear-offs, and raw type literals retain their arguments', () => {
  const program = `class Box<T extends num> {}
typedef Alias<T extends num> = Box<T>;
class Forward<T extends U, U extends num> {}
class Recursive<T extends Comparable<T>> {}
T choose<T>(T a, T b) => a;
void main() {
  int Function() Function() factory = () => () => 1;
  num Function(int, double) numeric = choose;
  Object Function(int, String) mixed = choose;
  print([factory()(), numeric(2, 3.0), mixed(4, 'x')]);
  print([Box, Box == Box<num>, Alias, Alias == Box<num>, Alias<num>]);
  print([Forward, Recursive]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[1, 2, 4]\n[Box<num>, true, Box<num>, true, Box<num>]\n[Forward<num, num>, Recursive<Comparable<dynamic>>]\n',
  });
});

test('dynamic pattern assignments validate the input before applying writes', () => {
  const program = `void main() {
  int a = 0, b = 0;
  dynamic pair = (1, 'wrong');
  try { (a, b) = pair; } catch (e) { print(e); }
  dynamic list = <Object>[1, 'wrong'];
  try { [a, b] = list; } catch (e) { print(e); }
  print([a, b]);
  pair = (2, 3);
  (a, b) = pair;
  print([a, b]);
  List<int> tail = [];
  list = <int>[4, 5];
  <int>[a, ...tail] = list;
  print([a, tail]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type '(int, String)' is not a subtype of type '(int, int)'\ntype 'List<Object>' is not a subtype of type 'List<int>'\n[0, 0]\n[2, 3]\n[4, [5]]\n",
  });
  const invalid = 'void main() { int a = 0; List<int> tail = []; dynamic x = <int>[1, 2]; [a, ...tail] = x; }';
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  const duplicate = 'void main() { int a = 0; ([a], a) = ([4], 5); }';
  expect(executeProgram('dart', duplicate)).toMatchObject({ kind: 'compileError' });
});

test('Object.hash accepts twenty arguments and hashes the supplied values in order', () => {
  const program = `class Item {
  int get hashCode { print('hash'); return 1; }
}
Iterable<Item> items() sync* {
  print('yield');
  yield Item();
  throw 'stop';
}
void main() {
  print(Object.hash(1, 2) == Object.hashAll([1, 2]));
  print(Object.hash(1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20) ==
        Object.hashAll([1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
  try { Object.hashAll(items()); } catch (error) { print(error); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\nyield\nhash\nstop\n',
  });
});

test('construction checks constants before main and only evaluates selected branches', () => {
  const valid = `class Box<T> {
  final T value;
  const Box(this.value);
}
class C {
  final (int, int) value;
  const C(int n) : value = (n + 1, 0);
}
void main() {
  const n = true ? 3 : 1 ~/ 0;
  const a = <int>[n];
  const b = [...a, n + 1];
  print([const C(n).value, b]);
  print(const Box(1).value);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[(4, 0), [3, 4]]\n1\n' });
  for (const invalid of [
    'void main() { print("started"); const n = [1 ~/ 0]; }',
    'int f() => 5; class C { final int n; const C() : n = f(); } void main() {}',
    'class C { const C(int n) : assert(n > 0); } void main() { print(const C(0)); }',
    'void main() { print(const {1, 1}); }',
    'class C { final Map<int,int> value; const C(this.value); } void main() { print(const C({1: 2, 1: 3})); }',
  ]) {
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
  for (const initializer of ['const <T>[]', 'const <T>{}', 'const <int, T>{}', 'const Box<T>()']) {
    const invalid = `class Box<T> { const Box(); }
class C<T> { final Object value; const C() : value = ${initializer}; }
void main() { print('started'); }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('enum values and conditional collection elements are evaluated as constants', () => {
  const program = `enum E { a(3); const E(this.n); final int n; }
void main() {
  const a = [if (true) 1 else 1 ~/ 0];
  const b = {'key': 0, if (true) 'other': 1};
  print([a, b, E.a.n]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1], {key: 0, other: 1}, 3]\n',
  });
  for (const declaration of [
    'int argument() => 1; enum E { a(argument()); const E(this.n); final int n; }',
    'enum E { a(0); const E(int n) : assert(n > 0); }',
  ]) {
    expect(executeProgram('dart', `${declaration} void main() { print('started'); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('constructor tear-offs use their reified signature for calls and identity', () => {
  const program = `extension type Id(int value) {}
class Box<T> {}
Object make<T>() => Box<T>.new;
void main() {
  final f = make<int>();
  print(f.runtimeType);
  print(f is Box<int> Function());
  print(identical(f, Box<int>.new));
  print(Box<int>.new == Box<String>.new);
  print(<Function>{Box<int>.new, Box<String>.new}.length);
  Object a = List<Id>.empty();
  Object b = Box<Id>();
  print([a.runtimeType, b.runtimeType, a is List<int>, b is Box<int>]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '() => Box<int>\ntrue\ntrue\nfalse\n2\n[List<int>, Box<int>, true, true]\n',
  });
});

test('local functions expose inferred return types and all calls reject duplicate names', () => {
  expect(
    executeProgram(
      'dart',
      `void main() {
    f() => 1;
    g() { return 'text'; }
    print([f.runtimeType, g.runtimeType, f is int Function()]);
  }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[() => int, () => String, true]\n' });
  for (const source of [
    "void main() { f() => 1; print('started'); String wrong = f(); print(wrong); }",
    'class C { void f({int n = 0}) {} } void main() { dynamic c = C(); c.f(n: 1, n: 2); }',
    'void main() { dynamic f = ({int n = 0}) {}; f(n: 1, n: 2); }',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('constant inference closes generic contexts while preserving concrete types', () => {
  const program = `class Box<T> {
  final List<T> values;
  const Box({this.values = const []});
}
class Value<T> { const Value(); }
void inspect<T>() {
  List<T?> list = const [];
  Set<T> set = const {};
  List<T Function(T)> callbacks = const [];
  Value<T> value = const Value();
  print([list.runtimeType, set.runtimeType, callbacks.runtimeType, value.runtimeType]);
}
void main() { print(const Box<int>().values.runtimeType); inspect<int>(); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'List<Never>\n[List<Never>, _ConstSet<Never>, List<(Object?) => Never>, Value<Never>]\n',
  });
});

test('a later local declaration shadows an outer name throughout its block', () => {
  const declaration = 'int x = 10; void f() {}';
  for (const body of [
    'print(x); var x = 2;',
    'var x = 1; { print(x); var x = 2; }',
    'x = 3; var x = 2;',
    'f(); void f() {}',
    'var (x, y) = (x, 1);',
    'Iterable<int> values() sync* { yield x; var x = 2; }',
  ]) {
    const result = executeProgram('dart', `${declaration} void main() { ${body} }`);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain('宣言より前');
  }
  const valid = `${declaration} void main() { print(x); { var x = 2; print(x); } }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '10\n2\n' });
});

test('a single switch case shares its binding with closures from the guard', () => {
  const program = `late int Function() saved;
bool remember(int Function() callback) { saved = callback; return true; }
void main() {
  switch (1) {
    case int n when remember(() => n):
      n++;
      print(saved());
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '2\n' });
});

test('for-in writes the iterable element to an implicit instance field', () => {
  const program = `class C {
  int value = 0;
  void run() { for (value in [3, 4]) print(value); }
}
void main() { C().run(); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3\n4\n' });
});

test('a set being built retains values from earlier generator iterations', () => {
  const program = `Iterable<Turtle> generate() sync* {
  yield Turtle(1, 1);
  yield Turtle(3, 3);
  var third = Turtle(5, 5);
  third.canMoveForward();
  yield third;
}
void main() {
  var turtles = Set<Turtle>.from(generate());
  turtles.first.forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [
      { x: 1, y: 2 },
      { x: 3, y: 3 },
      { x: 5, y: 5 },
    ],
  });
});

test('constants with same-named types from different libraries stay distinct', () => {
  const program = `import 'dart:core' as core;
class String { const String(); }
void main() {
  const local = <String>[];
  const sdk = <core.String>[];
  core.print([core.identical(local, sdk), local is core.List<String>, sdk is core.List<core.String>]);
  const a = String;
  const b = core.String;
  core.print([a == b, <core.Type>{a, b}.length, core.identical(b, 'sdk'.runtimeType)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[false, true, true]\n[false, 2, true]\n',
  });
  for (const directive of ["import 'dart:core' as core;", "import 'dart:core' show String;"]) {
    expect(executeProgram('dart', `${directive} void main() { print('hidden'); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('import show filters intersect and preserve hide exclusions', () => {
  const directive = "import 'dart:math' show min, max, sqrt hide sqrt show max, sqrt;";
  expect(executeProgram('dart', `${directive} void main() { print(max(1, 2)); }`)).toMatchObject({
    kind: 'executed',
    stdout: '2\n',
  });
  for (const call of ['min(1, 2)', 'sqrt(4)']) {
    expect(executeProgram('dart', `${directive} void main() { print(${call}); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('comments preserve optional defaults and type operators', () => {
  const program = `void positional([int x /* default */ = 1]) => print(x);
void named({int? x /* default */ = 2}) => print(x);
void main() {
  positional();
  named();
  Object value = 3;
  print(value /* test */ is int);
  print(value /* cast */ as int);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1\n2\ntrue\n3\n' });
});

test('generic function Type equality includes bounds and ignores parameter names', () => {
  const program = `typedef A = T Function<T extends num>(T);
typedef B = T Function<T extends Object>(T);
typedef C = U Function<U extends num>(U);
typedef F = T Function<T extends Comparable<T>>(T);
typedef G = V Function<V extends Comparable<V>>(V);
void main() { print([A == B, A == C, F == G, <Type>{A, B, C}.length]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[false, true, true, 2]\n' });
});

test('joined branches retain only promotions shared by both paths', () => {
  const shared = `void show(Object x) {
  if (x is num) {
    if (x is int || x is double) print(x.abs());
  }
}
void main() { show(-2.5); }`;
  expect(executeProgram('dart', shared)).toMatchObject({ kind: 'executed', stdout: '2.5\n' });
  for (const secondType of ['double', 'num']) {
    const invalid = `void show(Object x) { if (x is int || x is ${secondType}) print(x.abs()); }
void main() { show(-2.5); }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('JSON encoding interleaves list reads and element callbacks', () => {
  const program = `import 'dart:collection';
import 'dart:convert';
late List<dynamic> source;
class Element {
  int toJson() { print('encode'); source.add(2); return 1; }
}
class View extends ListBase<dynamic> {
  int get length { print('length'); return source.length; }
  set length(int n) => source.length = n;
  dynamic operator [](int n) { print('read $n'); return source[n]; }
  void operator []=(int n, dynamic x) { source[n] = x; }
}
void main() {
  source = [Element()];
  print(jsonEncode(source));
  source = [Element()];
  print(jsonEncode(View()));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'encode\n[1,2]\nlength\nread 0\nencode\nlength\nread 1\nlength\n[1,2]\n',
  });
});

test('generic aliases substitute class arguments for constructor calls and tear-offs', () => {
  const declarations = `typedef Alias<T> = Box<int, T>;
typedef Nullable<T> = Box<int, T>?;
typedef FixedNullable = Box<int, String>?;
class Box<X, Y> {
  final X x;
  final Y y;
  const Box(this.x, this.y);
  const Box.named({required this.x, required this.y});
}`;
  const program = `${declarations}
void main() {
  print(new Alias<String>(1, 'new').y);
  print(Alias<int>(1, 2).y);
  print(Alias<String>.named(x: 3, y: 'named').y);
  print(Alias.named(x: 3, y: 'inferred').runtimeType);
  var make = Alias.new;
  print(make(4, 'tear-off').runtimeType);
  print(new Nullable<int>(2, 3).y);
  print(Nullable<String>.named(x: 4, y: 'nullable').y);
  print(Nullable<String>.new(4, 'tear-off').runtimeType);
  print((Nullable.new)(5, 'tear-off').y);
  print(FixedNullable(5, 'direct').y);
  print(new FixedNullable.new(5, 'explicit').y);
  print(FixedNullable.new(5, 'selector')?.y);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'new\n2\nnamed\nBox<int, String>\nBox<int, String>\n3\nnullable\nBox<int, String>\ntear-off\ndirect\nexplicit\nselector\n',
  });
  for (const invocation of [
    'Nullable(1, 2)',
    'Nullable.new(1, 2)',
    "FixedNullable.new(1, '')",
    "FixedNullable.named(x: 1, y: '')",
  ]) {
    expect(executeProgram('dart', `${declarations} void main() { print(${invocation}.y); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('list switch cases can partition finite element values and lengths', () => {
  const program = `String flag(List<bool> list) => switch (list) {
  [] => 'empty',
  [true, ...] => 'first',
  [..., false] => 'last',
  [false, ..., true] => 'both',
};
String nullable(List<int?> list) => switch (list) {
  [] => 'empty', [null, ...] => 'null', [int(), ...] => 'int',
};
String row(List<(List<int>, int)> rows) => switch (rows) {
  [] => 'no rows',
  [([], _), ...] => 'row empty',
  [([var head, ...], _), ...] => 'row starts $head',
};
void main() {
  print(flag([]));
  print(flag([true]));
  print(flag([false]));
  print(flag([false, false, true]));
  print(nullable([null]));
  print(nullable([3]));
  print(row([([1, 2], 3)]));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'empty\nfirst\nlast\nboth\nnull\nint\nrow starts 1\n',
  });
});

test('JSON output and standard sinks honor limits and incomplete iteration', () => {
  const program = String.raw`import 'dart:convert';
import 'dart:io';
Iterable<String> values() sync* {
  yield 'first';
  throw 'failure';
}
void main() {
  try { stdout.writeAll(values(), ','); } catch (e) { print(' caught'); }
  var text = 'x' * 600000;
  try { jsonEncode([text, text]); } catch (e) { print(e); }
  try { jsonEncode('\x00' * 200000); } catch (e) { print(e); }
  try { text.replaceFirst('x', text); } catch (e) { print(e); }
  try { text.replaceRange(0, 0, text); } catch (e) { print(e); }
  try { 'xx'.splitMapJoin('x', onMatch: (m) => text); } catch (e) { print(e); }
  try { [text, text].join(); } catch (e) { print(e); }
  try { [text, text].toString(); } catch (e) { print(e); }
  try { (text, name: text).toString(); } catch (e) { print(e); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'first caught\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\n',
  });
});

test('Function.apply and regexp match groups read any Dart List', () => {
  const program = `import 'dart:collection';
class View extends ListBase<int> {
  int get length => 2;
  set length(int n) {}
  int operator [](int n) { print('read $n'); return n; }
  void operator []=(int n, int value) {}
}
class GrowingIndices extends View {
  int size = 1;
  int get length => size;
  int operator [](int n) {
    print('group $n');
    size = 2;
    return 0;
  }
}
void main() {
  print(Function.apply((int a, int b) => [a, b], View()));
  print(RegExp('(a)').firstMatch('a')!.groups(UnmodifiableListView<int>([0, 1])));
  var mapped = HashSet<int>.of([1, 2, 3]).map((x) { print('map'); return x; });
  print([mapped.skip(1).length, mapped.take(1).length]);
  var cast = mapped.cast<int>();
  print([cast.skip(1).length, cast.take(1).length]);
  final map = HashMap<int, int>.of({1: 10, 2: 20});
  print(map.keys.map((x) { print('key'); return x; }).skip(1).length);
  print(map.values.map((x) { print('value'); return x; }).take(1).length);
  try { RegExp('a').firstMatch('a')!.groups(GrowingIndices()); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'read 1\nread 0\n[0, 1]\n[a, a]\n[2, 1]\n[2, 1]\n1\n1\ngroup 0\ngroup 1\nRangeError\n',
  });
});

test('indexed views, queues, and map views apply mutations in SDK order', () => {
  const program = `import 'dart:collection';
class View extends ListBase<int> {
  final List<int> data = [3, 1, 2];
  int get length => data.length;
  set length(int n) { data.length = n; }
  int operator [](int n) => data[n];
  void operator []=(int n, int value) { data[n] = value; }
}
class Table extends MapBase<int, int> {
  final Map<int, int> data = {1: 10, 2: 20};
  int? operator [](Object? key) => data[key];
  void operator []=(int key, int value) { data[key] = value; }
  int? remove(Object? key) => data.remove(key);
  void clear() { data.clear(); }
  Iterable<int> get keys => data.keys.where((key) => true);
}
void main() {
  final view = View();
  view.sort((a, b) { print(view); return a.compareTo(b); });
  print(view);
  final table = Table();
  print(table.values.map((value) { print('mapper ran'); return value; }).skip(1).length);
  try {
    table.updateAll((key, value) { table[3] = 30; return value + 1; });
  } catch (error) { print(error.runtimeType); }
  print(table);
  final readonly = UnmodifiableMapView<int, int>(table);
  try { readonly.update(1, (value) { print('update ran'); return value; }); } catch (error) { print(error); }
  try { UnmodifiableListView<int>(view).fillRange(0, 0); } catch (error) { print(error); }
  final queue = Queue<int>.of([1, 2, 3]);
  queue.removeWhere((value) { print(queue); return value.isOdd; });
  queue.add(4);
  final iterator = queue.iterator;
  iterator.moveNext();
  queue.retainWhere((_) => true);
  print(iterator.moveNext());
  final linked = DoubleLinkedQueue<int>.of([1, 2]);
  linked.removeWhere((value) {
    print(value);
    if (value == 1) linked.add(3);
    if (value == 2) return true;
    return false;
  });
  print(linked);
  try {
    linked.retainWhere((value) { linked.remove(value); return true; });
  } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[3, 1, 2]\n[1, 3, 2]\n[1, 3, 3]\n[1, 2, 3]\n1\nConcurrentModificationError\n{1: 11, 2: 20, 3: 30}\nUnsupported operation: Cannot modify unmodifiable map\nUnsupported operation: Cannot modify an unmodifiable list\n{1, 2, 3}\n{2, 3}\n{2, 3}\ntrue\n1\n2\n3\n{1, 3}\nConcurrentModificationError\n',
  });
});

test('line splitting and string matching consume input on demand', () => {
  const program = String.raw`import 'dart:convert';
class _RegExp implements Pattern {
  Iterable<Match> allMatches(String s, [int start = 0]) => 'a'.allMatches(s, start);
  Match? matchAsPrefix(String s, [int start = 0]) => 'a'.matchAsPrefix(s, start);
}
void main() {
  print(LineSplitter.split('a\r\n' + 'x' * 999997).first);
  print(LineSplitter.split('abc\r\n\rxy', 1, 7).toList());
  print(const LineSplitter().convert('a\r\nb'));
  var matches = 'a'.allMatches('a' * 1000000);
  print([matches.first.start, matches.first.end]);
  print(''.allMatches('xy').map((match) => match.start).toList());
  print('aa'.replaceFirst(_RegExp(), 'b'));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'a\n[bc, , x]\n[a, b]\n[0, 1]\n[0, 1, 2]\nba\n',
  });
  const declarations = "import 'dart:convert';";
  const subclass = `${declarations} class Splitter extends LineSplitter {} void main() {}`;
  const converter = `${declarations} void main() { Converter<String, List<String>> c = LineSplitter(); }`;
  expect(executeProgram('dart', subclass)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('dart', converter)).toMatchObject({ kind: 'compileError' });
});

test('string pattern operations read the original match in SDK order', () => {
  const program = `class Located implements Match {
  int get start { print('start'); return 1; }
  int get end { print('end'); return 2; }
  String? operator [](int i) { print('group'); return 'B'; }
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}
class Finder implements Pattern {
  Match? matchAsPrefix(String input, [int start = 0]) => start == 0 ? Located() : null;
  Iterable<Match> allMatches(String input, [int start = 0]) => [Located()];
}
void main() {
  final pattern = Finder();
  print(['abc'.startsWith(pattern), 'abc'.indexOf(pattern), 'abc'.lastIndexOf(pattern), 'abc'.contains(pattern)]);
  print('abc'.split(pattern));
  print('abc'.splitMapJoin(pattern));
  print('abc'.replaceFirstMapped(pattern, (match) { print('replace'); return 'x'; }));
  print('abc'.replaceAllMapped(pattern, (match) { print('replace'); return 'x'; }));
  print('a😀'.splitMapJoin('', onMatch: (match) => '|', onNonMatch: (text) => text.length.toString() + ','));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[true, 0, 0, true]\nstart\nend\nstart\n[a, c]\nstart\ngroup\nend\naBc\nreplace\nstart\nend\naxc\nstart\nreplace\nend\naxc\n0,|1,|2,|0,\n',
  });
});

test('native calls and getters keep evaluated arguments reachable through callbacks', () => {
  const program = `late Turtle key, second, throughGetter, namedFromGetter;
class Handler {
  Function get callback {
    Turtle(3, 3).canMoveForward();
    return (Turtle turtle) { throughGetter = turtle; };
  }
  Function get namedCallback {
    Turtle(3, 3).canMoveForward();
    return ({required Turtle turtle}) { namedFromGetter = turtle; };
  }
}
void main() {
  var map = <Turtle, int>{};
  map.putIfAbsent(Turtle(1, 1), () {
    Turtle(3, 3).canMoveForward();
    return 1;
  });
  key = map.keys.first;
  key.forward();
  var count = 0;
  [Turtle(1, 3), Turtle(2, 2)].forEach((turtle) {
    if (++count == 1) Turtle(3, 3).canMoveForward();
    else second = turtle;
  });
  second.forward();
  dynamic handler = Handler();
  handler.callback(Turtle(3, 1));
  throughGetter.forward();
  handler.namedCallback(turtle: Turtle(4, 1));
  namedFromGetter.forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [
      { x: 1, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ],
  });
});

test('list removal follows the live length and checks the matched index again', () => {
  const program = `late List<dynamic> values;
class Appending {
  bool operator ==(Object other) { values.add(9); return false; }
  int get hashCode => 0;
}
class Clearing {
  bool operator ==(Object other) { values.clear(); return true; }
  int get hashCode => 0;
}
void main() {
  values = [Appending()];
  print([values.remove(9), values.length]);
  values = [Appending()];
  print(values.indexOf(9));
  values = [Clearing()];
  try { values.remove(9); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[true, 1]\n1\nRangeError\n' });
});

test('list formatting and replacement observe learner callbacks in SDK order', () => {
  const program = `late List<Object> contents;
class Item {
  final bool clear;
  Item(this.clear);
  String toString() {
    if (clear) { contents.clear(); } else { contents.add(3); }
    return 'item';
  }
}
void main() {
  for (final clear in [false, true]) {
    contents = [Item(clear), 2];
    try { print(contents); } catch (error) { print([error.runtimeType, contents.length]); }
  }
  var target = [0, 0];
  try {
    target.replaceRange(1, 2, [1, 2].map((value) {
      print(target);
      if (value == 2) throw 'stop';
      return value;
    }));
  } catch (error) { print(target); }
  var middle = [0, 1, 2, 3];
  middle.replaceRange(1, 3, [5, 6, 7]);
  print(middle);
  middle.replaceRange(1, 4, [8]);
  print(middle);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[ConcurrentModificationError, 3]\n[ConcurrentModificationError, 0]\n[0, 0]\n[0, 1]\n[0, 1]\n[0, 5, 6, 7, 3]\n[0, 8, 3]\n',
  });
});

test('list sorting keeps displaced values reachable during comparisons', () => {
  const program = `class Item {
  final int number;
  final Turtle turtle = Turtle(1, 1);
  Item(this.number);
}
void main() {
  var items = List.generate(34, (index) => Item(index));
  var calls = 0;
  items.sort((left, right) {
    if (++calls == 11) Turtle(3, 3).canMoveForward();
    return left.number.compareTo(right.number);
  });
  items[21].turtle.forward();
}`;
  const result = executeProgram('dart', program);
  expect(result.kind).toBe('executed');
  if (result.kind === 'executed') {
    expect(result.finalTurtles).toHaveLength(34);
    expect(result.finalTurtles.filter(({ x, y }) => x === 1 && y === 2)).toHaveLength(1);
  }
});

test('custom map entries stay reachable during insertion callbacks', () => {
  const declarations = `import 'dart:collection';
class Key {
  int get hashCode {
    Turtle(3, 3).canMoveForward();
    return 1;
  }
}
class Source extends MapBase<Key, Turtle> {
  Turtle? operator [](Object? key) => null;
  void operator []=(Key key, Turtle value) {}
  void clear() {}
  Turtle? remove(Object? key) => null;
  Iterable<Key> get keys => [];
  void forEach(void Function(Key, Turtle) add) { add(Key(), Turtle(1, 1)); }
}`;
  for (const create of ['var m = <Key, Turtle>{}; m.addAll(Source());', 'var m = <Key, Turtle>{...Source()};']) {
    const program = `${declarations} void main() { ${create} m.values.first.forward(); }`;
    expect(executeProgram('dart', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: undefined,
      finalTurtles: [{ x: 1, y: 2 }],
    });
  }
});

test('map constructors retain their computed values while hashing a key', () => {
  const declarations = `class Key {
  int get hashCode { Turtle(3, 3).canMoveForward(); return 1; }
}
class Source extends Iterable<Turtle> {
  Iterator<Turtle> get iterator => Cursor();
}
class Cursor implements Iterator<Turtle> {
  bool started = false;
  bool moveNext() {
    if (started) return false;
    started = true;
    return true;
  }
  Turtle get current => Turtle(1, 1);
}`;
  for (const create of [
    'Map<Key, Turtle>.fromIterables([Key()], Source())',
    'Map<Key, Turtle>.fromIterable([1], key: (x) => Key(), value: (x) => Turtle(1, 1))',
  ]) {
    const program = `${declarations} void main() { final map = ${create}; map.values.first.forward(); }`;
    expect(executeProgram('dart', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: undefined,
      finalTurtles: [{ x: 1, y: 2 }],
    });
  }
});

test('list filtering retains earlier values across later predicate calls', () => {
  for (const [method, keep] of [
    ['retainWhere', 'position != 2'],
    ['removeWhere', 'position == 2'],
  ]) {
    const program = `void main() {
  var turtles = [Turtle(1, 1), Turtle(2, 2), Turtle(3, 3)];
  var position = 0;
  turtles.${method}((turtle) {
    if (++position == 3) {
      turtles[0] = Turtle(4, 4);
      Turtle(5, 5).canMoveForward();
    }
    return ${keep};
  });
  turtles[0].forward();
}`;
    const result = executeProgram('dart', program);
    expect(result).toMatchObject({ kind: 'executed', uncaughtException: undefined });
    if (result.kind === 'executed') {
      expect(result.finalTurtles).toEqual([
        expect.objectContaining({ x: 1, y: 2 }),
        expect.objectContaining({ x: 3, y: 3 }),
      ]);
    }
  }
});

test('set membership keeps its source iterator reachable during hashing', () => {
  const program = `import 'dart:collection';
late Turtle saved;
class Source extends Iterable<int> {
  Iterator<int> get iterator => Cursor();
}
class Cursor implements Iterator<int> {
  final Turtle turtle = Turtle(1, 1);
  bool started = false;
  int get current => 1;
  bool moveNext() {
    if (!started) { started = true; return true; }
    saved = turtle;
    return false;
  }
}
void main() {
  var collect = false;
  var set = LinkedHashSet<int>(hashCode: (key) {
    if (collect) Turtle(3, 3).canMoveForward();
    return key;
  });
  set.add(1);
  collect = true;
  print(set.containsAll(Source()));
  saved.forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
    finalTurtles: [{ x: 1, y: 2 }],
  });
});

test('set endpoints skip deleted entries and may return null', () => {
  const program = `void main() {
  final set = <int?>{1, 2, null, 3, 4};
  set.remove(1);
  set.remove(4);
  print([set.first, set.last]);
  set.remove(3);
  print(set.last);
  set.clear();
  try { print(set.last); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 3]\nnull\nStateError\n' });
});

test('set union keeps values accumulated before a source callback collects', () => {
  const program = `import 'dart:collection';
Iterable<Turtle> turtles() sync* {
  yield Turtle(1, 1);
  yield Turtle(3, 3);
  var last = Turtle(5, 5);
  last.canMoveForward();
  yield last;
}
class Source extends SetBase<Turtle> {
  Iterator<Turtle> get iterator => turtles().iterator;
  int get length => 3;
  Set<Turtle> toSet() => <Turtle>{};
  bool add(Turtle value) => false;
  bool contains(Object? value) => false;
  Turtle? lookup(Object? value) => null;
  bool remove(Object? value) => false;
}
void main() {
  final result = <Turtle>{}.union(Source());
  result.first.forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [
      { x: 1, y: 2 },
      { x: 3, y: 3 },
      { x: 5, y: 5 },
    ],
  });
});

test('map updates and value searches detect changes to the live key set', () => {
  const program = `late Map<int, Object> owner;
class Entry {
  final bool matches;
  Entry(this.matches);
  bool operator ==(Object other) { owner[2] = 9; return matches; }
  int get hashCode => 0;
}
void main() {
  for (var matches in [false, true]) {
    owner = {1: Entry(matches)};
    try { print(owner.containsValue(9)); } catch (error) { print(error.runtimeType); }
  }
  var map = {1: 1, 2: 2};
  try {
    map.updateAll((key, value) { map[9] = 9; return value + 1; });
  } catch (error) { print([error.runtimeType, map]); }
  map.updateAll((key, value) => value * 2);
  print(map);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'ConcurrentModificationError\ntrue\n[ConcurrentModificationError, {1: 2, 2: 2, 9: 9}]\n{1: 4, 2: 4, 9: 18}\n',
  });
});

test('JSON encoding errors include partial output and the conversion cause', () => {
  const program = `import 'dart:convert';
void main() {
  try { jsonEncode({'a': Object()}); }
  on JsonUnsupportedObjectError catch (error) {
    print(error.partialResult);
    print(error.cause is NoSuchMethodError);
  }
  try { jsonEncode([1, Object()], toEncodable: (value) => Object()); }
  on JsonUnsupportedObjectError catch (error) {
    print(error.partialResult);
    print((error.cause as JsonUnsupportedObjectError).partialResult);
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '{"a":\ntrue\n[1,\n[1,\n',
  });
});

test('JSON revivers keep prior results reachable during callbacks', () => {
  const program = `import 'dart:convert';
void main() {
  var result = jsonDecode('{"a":1,"b":2}', reviver: (key, value) {
    if (key == 'a') return Turtle(1, 1);
    if (key == 'b') Turtle(3, 3).canMoveForward();
    return value;
  });
  result['a'].forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [{ x: 1, y: 2 }],
  });
});

test('numeric parsing applies the SDK whitespace and argument rules', () => {
  const program = String.raw`void main() {
  print(double.tryParse('\u00851.5'));
  print(num.tryParse('2.5\u0085'));
  print(int.tryParse('\u008542'));
  print([int.tryParse('K', radix: 21), BigInt.tryParse('K', radix: 21)]);
  print([int.parse('K', radix: 21), BigInt.parse('K', radix: 21)]);
  print([double.tryParse('9' * 120000 + 'x'), num.tryParse('x' + ' ' * 120000 + 'x')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1.5\n2.5\n42\n[null, null]\n[20, 20]\n[null, null]\n',
  });
  expect(executeProgram('dart', 'void main() { print(int.parse("42", onError: (s) => 0)); }')).toMatchObject({
    kind: 'compileError',
  });
});

test('JSON map snapshots retain values across serialization callbacks', () => {
  const program = `import 'dart:convert';
late Turtle saved;
class Entry {
  Map<String, dynamic> toJson() => {'trigger': 1, 'turtle': Turtle(1, 1)};
}
class Trigger {
  int toJson() { Turtle(3, 3).canMoveForward(); return 0; }
}
void main() {
  final contents = Entry().toJson()..['trigger'] = Trigger();
  print(jsonEncode(contents, toEncodable: (value) {
    if (value is Turtle) {
      saved = value;
      value.forward();
      return 1;
    }
    contents.remove('turtle');
    return (value as dynamic).toJson();
  }));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [{ x: 1, y: 2 }],
    stdout: '{"trigger":0,"turtle":1}\n',
  });
});

test('list mutations preserve the prefix written before an error', () => {
  const program = `late List<dynamic> items;
class Marker {
  final bool equal;
  Marker(this.equal);
  bool operator ==(Object other) { items.add(2); return equal; }
  int get hashCode => 0;
}
class JoinMarker {
  String toString() { items.add(2); return 'x'; }
}
Iterable<int> source() sync* { yield 1; throw 'stop'; }
void main() {
  for (var value in [false, true]) {
    items = [Marker(value)];
    try { print(items.contains(9)); } catch (e) { print(e.runtimeType); }
  }
  items = [JoinMarker(), 1];
  print(items.join(','));
  items = [JoinMarker(), 1];
  print(items.join());
  var target = [0, 0];
  try { target.setAll(0, source()); } catch (e) { print(target); }
  items = [1, Marker(false)];
  try {
    items.lastIndexWhere((item) { items.clear(); return false; });
  } catch (e) { print(e.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ConcurrentModificationError\ntrue\nx,1,2\nx1\n[1, 0]\nRangeError\n',
  });
});

test('bulk list writes can copy large blocks without a host call argument limit', () => {
  const program = `void main() {
  final source = List<int>.filled(200000, 1);
  final values = [0, 2];
  values.insertAll(1, source);
  print([values.length, values.first, values.last]);
  values.replaceRange(0, 200001, [5, 6]);
  print(values);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[200002, 0, 2]\n[5, 6, 2]\n',
  });
  const oversized = 'void main() { <int>[].replaceRange(0, 0, List<int>.filled(510000, 1)); }';
  expect(executeProgram('dart', oversized)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test('sync generators invalidate current when they terminate', () => {
  const program = `Iterable<int> values(bool fail) sync* { yield 1; if (fail) throw 'stop'; }
Iterable<int?> empty() sync* {}
void inspect(Iterator<int> iterator) {
  try { print(iterator.current); } catch (e) { print(e.runtimeType); }
}
void main() {
  for (var fail in [false, true]) {
    var iterator = values(fail).iterator;
    inspect(iterator);
    iterator.moveNext();
    inspect(iterator);
    try { print(iterator.moveNext()); } catch (e) { print(e); }
    inspect(iterator);
  }
  print(empty().iterator.current);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\n1\nfalse\n_TypeError\n_TypeError\n1\nstop\n_TypeError\nnull\n',
  });
});

test('set results respect hash order and factories and shuffle checks callback indices', () => {
  const program = `import 'dart:collection';
import 'dart:math';

class Key {
  final int value;
  Key(this.value);
  int get hashCode => value;
  String toString() => 'K$value';
}

class InvalidRandom implements Random {
  bool nextBool() => false;
  double nextDouble() => 0;
  int nextInt(int max) => 99;
}

Set<R> make<R>() { print('factory'); return SplayTreeSet<R>(); }

void main() {
  final hash = HashSet.of(List.generate(100, Key.new));
  final selection = hash.where((key) => [1, 9, 17].contains(key.value)).toSet();
  print(hash.intersection(selection));
  print(hash.difference(hash.difference(selection)));
  var view = Set.castFrom<int, num>({3, 1, 2}, newSet: make);
  print(view.toSet());
  print(view.cast<num>().toSet());
  print(view.union({0}));
  print(view.intersection({3, 1}));
  print(view.difference({2}));
  var values = [1, 2];
  try { values.shuffle(InvalidRandom()); }
  catch (error) { print(error is RangeError); }
  print(values);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '{K17, K9, K1}\n{K17, K9, K1}\nfactory\n{1, 2, 3}\nfactory\n{1, 2, 3}\nfactory\n{0, 1, 2, 3}\nfactory\n{1, 3}\nfactory\n{1, 3}\ntrue\n[1, 2]\n',
  });
});

test('set string conversion detects changes made by element formatting', () => {
  const program = `late Set<Object> contents;
class Item {
  final bool removeAll;
  Item(this.removeAll);
  String toString() {
    if (removeAll) { contents.clear(); } else { contents.add(3); }
    return 'item';
  }
}
void main() {
  for (final removeAll in [false, true]) {
    contents = {Item(removeAll), 2};
    try { print(contents); }
    catch (error) { print([error.runtimeType, contents.length]); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[ConcurrentModificationError, 3]\n[ConcurrentModificationError, 0]\n',
  });
});

test('metadata resolves const constructors and references before executing the program', () => {
  const program = `class Mark<T> {
    final T value;
    const Mark.named(this.value);
  }
  @Deprecated.extend()
  class Subject<@Deprecated('parameter') T> {
    static const label = Mark<int>.named(1);
    @label void run(@label int value) {
      const local = Mark<String>.named('marker');
      @local int result = value + 1;
      print(result);
    }
  }
  @Mark<int>.named(2)
  void main() { Subject().run(2); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3\n' });
  for (const source of [
    "@NoSuchAnnotation() void main() { print('started'); }",
    "class Label { Label(int value); } @Label(1) void main() { print('started'); }",
    "class Label { const Label(int value) : assert(value > 0); } @Label(0) void main() { print('started'); }",
    "void marker() {} @marker void main() { print('started'); }",
    "class C<@Missing() T> {} void main() { print('started'); }",
    "void generic<@Missing() T>() {} void main() { print('started'); }",
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test.each([
  "class Base<T> { T? f() => null; } mixin M { String f() => 'text'; } class C extends Base<int> with M {}",
  'class A<T> {} class B implements A<int> {} class C extends B implements A<String> {}',
  'class C<T extends U, U extends T> {}',
  'late final int value = 1; void assign() { value = 2; }',
  'class C { static late final int value = 1; } void assign() { C.value = 2; }',
  "class C { int get x => 1; } void match() { if (C() case C(x: _, x: _)) print('matched'); }",
  'class Base { num f() => 1.5; } mixin M { int f(); } class C extends Base with M {}',
  'class Base { num get value => 1.5; } mixin M { int get value; } class C extends Base with M {}',
  'abstract class I { void f({required covariant num n}); } class Base { void f({required int n}) {} } class C extends Base implements I {}',
  'abstract class I { set value(covariant num n); } class Base { int value = 0; } class C extends Base implements I {}',
])('reports invalid Dart declarations before execution: %s', (declaration) => {
  expect(executeProgram('dart', `${declaration} void main() { print('started'); }`)).toMatchObject({
    kind: 'compileError',
  });
});

test('generic noSuchMethod forwarders check declared return types', () => {
  const program = `abstract class Contract<T> {
    T get value;
    R convert<R>();
  }
  class Handler<U> implements Contract<U> {
    dynamic noSuchMethod(Invocation invocation) => 'text';
  }
  void main() {
    Contract<int> value = Handler<int>();
    try { print(value.value); } catch (error) { print(error); }
    try { print(value.convert<int>()); } catch (error) { print(error); }
    print(value.convert<String>());
    dynamic target = value;
    print(target.unrelated());
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: "type 'String' is not a subtype of type 'int'\ntype 'String' is not a subtype of type 'int'\ntext\ntext\n",
  });
});

test('generic extensions infer both covariant and contravariant constraints', () => {
  const program = `extension RecordKind<T> on (T, T) { Type get kind => T; }
extension MapKind<T> on Map<T, T> { Type get kind => T; }
extension Positional<T extends num> on void Function(T) { Type get kind => T; }
extension Named<T> on void Function({required T value}) { Type get kind => T; }
void takeObject(Object value) {}
void takeString(String value) {}
void takeNamed({required String value}) {}
void main() {
  print((1, 'text').kind);
  print({1: 'text'}.kind);
  print(takeObject.kind);
  print(takeString.kind);
  print(takeNamed.kind);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Object\nObject\nnum\nNever\nString\n',
  });
});

test('private fields in different libraries keep distinct dispatch and types', () => {
  const program = `class D extends Duration {
    final String _duration = 'own';
    D() : super(seconds: 1);
  }
  void main() {
    D value = D();
    print(value.inSeconds);
    print(value._duration);
    dynamic dynamicValue = value;
    print(dynamicValue._duration);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\nown\nown\n',
  });
});

test('malformed regular expressions report the first SDK diagnostic', () => {
  const program = String.raw`void main() {
    for (final pattern in ['(?q:a)', r'[\d-a]', r'\u{110000}', r'[\p{not-a-property}]', '(?=a)*', '*a(?=b)*', r'\q\c!', r'\q\k<']) {
      try { RegExp(pattern, unicode: true); }
      on FormatException catch (error) { print(error.message); }
    }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'Invalid group\nInvalid character class\nInvalid Unicode escape\nInvalid property name in character class\nInvalid quantifier\nNothing to repeat\nInvalid escape\nInvalid escape\n',
  });
  const flagsAndAssertions = String.raw`void main() {
    for (final pattern in [r'[\', '(?ii:a)', '(?-:a)', '(?<=a)*']) {
      for (final unicode in [false, true]) {
        try { RegExp(pattern, unicode: unicode); }
        on FormatException catch (error) { print(error.message); }
      }
    }
  }`;
  expect(executeProgram('dart', flagsAndAssertions)).toMatchObject({
    kind: 'executed',
    stdout:
      '\\ at end of pattern\n\\ at end of pattern\nRepeated flag in flag group\nRepeated flag in flag group\nInvalid flag group\nInvalid flag group\nInvalid quantifier\nInvalid quantifier\n',
  });
});

test('escaped error text and regular expressions respect the string limit', () => {
  const program = String.raw`void main() {
    print(Error.safeToString('\u0001\n😀'));
    print(Error.safeToString('a' * 999998).length);
    for (final text in ['\u0001' * 200000, r'\' * 500000, 'a' * 999999]) {
      try { print(Error.safeToString(text).length); }
      catch (error) { print(error.runtimeType); }
    }
    print(RegExp.escape('a.*😀'));
    print(RegExp.escape('*' * 500000).length);
    for (final text in ['*' * 600000, '.' * 600000]) {
      try { print(RegExp.escape(text).length); }
      catch (error) { print(error.runtimeType); }
    }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '"\\u0001\\n😀"\n1000000\nOutOfMemoryError\nOutOfMemoryError\nOutOfMemoryError\na\\.\\*😀\n1000000\nOutOfMemoryError\nOutOfMemoryError\n',
  });
});

test('failed calls bound the complete description of their arguments', () => {
  const program = `external void missing(String left, String right);
void main() {
  final text = 'x' * 600000;
  dynamic object = Object();
  try { object.missing(1, z: 3, a: 2); } catch (error) { print(error); }
  try { object.missing(text, text); } catch (error) { print(error.runtimeType); }
  try { object.missing(z: text, a: text); } catch (error) { print(error.runtimeType); }
  dynamic f = () {};
  try { f(text, text); } catch (error) { print(error.runtimeType); }
  try { missing(text, text); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "NoSuchMethodError: Class 'Object' has no instance method 'missing'.\nReceiver: Instance of 'Object'\nTried calling: missing(1, a: 2, z: 3)\nOutOfMemoryError\nOutOfMemoryError\nOutOfMemoryError\nOutOfMemoryError\n",
  });
});

test('unsupported SDK exports respect import prefixes and visibility', () => {
  for (const [declaration, body] of [
    ["import 'dart:convert';", "print(ascii.encode('A'));"],
    ["import 'dart:convert' as codec show htmlEscape;", "print(codec.htmlEscape.convert('<'));"],
    ["import 'dart:collection' as collections;", 'collections.LinkedList<collections.LinkedListEntry>();'],
    ['', 'Sink? value; print(value);'],
    ["import 'dart:io' as io;", 'print(io.HttpDate);'],
  ]) {
    const result = executeProgram('dart', `${declaration} void main() { ${body} }`);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain('この採点環境では使えません');
  }
  const hidden = executeProgram('dart', "import 'dart:convert' hide ascii; void main() { print(ascii); }");
  expect(hidden.kind).toBe('compileError');
  if (hidden.kind === 'compileError') expect(hidden.diagnostics[0]?.message).toContain('定義されていません');
});

test('noSuchMethod forwarders bind defaults and check arguments before invoking the handler', () => {
  const program = `abstract class Contract {
    int f([int n = 3]);
    int g({int n = 4});
  }
  class Handler implements Contract {
    dynamic noSuchMethod(Invocation invocation) {
      print([invocation.isMethod, invocation.positionalArguments, invocation.namedArguments]);
      return 1;
    }
  }
  void main() {
    Contract typed = Handler();
    final f = typed.f;
    print(f is int Function([int]));
    print(f());
    print(typed.g());
    dynamic target = typed;
    try { target.f('bad'); } catch (error) { print(error.runtimeType); }
    try { target.g(n: 'bad'); } catch (error) { print(error.runtimeType); }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n[true, [3], {}]\n1\n[true, [], {Symbol("n"): 4}]\n1\n_TypeError\n_TypeError\n',
  });
});

test('super dispatch can call concrete noSuchMethod forwarders', () => {
  const program = `abstract class Contract {
    int run(int n);
    int get value;
    set value(int n);
  }
  class Parent implements Contract {
    dynamic noSuchMethod(Invocation invocation) => 0;
  }
  class Child extends Parent {
    dynamic noSuchMethod(Invocation invocation) {
      print([invocation.isMethod, invocation.isGetter, invocation.isSetter, invocation.positionalArguments]);
      return 2;
    }
    int call() => super.run(7);
    int Function(int) get callback => super.run;
    int get read => super.value;
    set write(int n) { super.value = n; }
  }
  void main() {
    final child = Child();
    print(child.call());
    print(child.callback(8));
    print(child.read);
    child.write = 9;
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[true, false, false, [7]]\n2\n[true, false, false, [8]]\n2\n[false, true, false, []]\n2\n[false, false, true, [9]]\n',
  });
  const abstractParent = program.replace('class Parent', 'abstract class Parent');
  expect(executeProgram('dart', abstractParent)).toMatchObject({ kind: 'compileError' });
});

test('indexed super assignments use the superclass and evaluate the index once', () => {
  const program = `class Parent {
    int? value;
    int? operator [](int index) { print('read $index'); return value; }
    void operator []=(int index, int? next) { print('write $index $next'); value = next; }
  }
  mixin Update on Parent {
    int index() { print('index'); return 7; }
    void update() {
      super[index()] ??= 2;
      super[index()] ??= 3;
      super[index()] = 4;
    }
  }
  class Counter {
    int value = 5;
    int operator [](int index) => value;
    void operator []=(int index, int next) { value = next; }
  }
  class Child extends Counter {
    int operator [](int index) => throw StateError('virtual read');
    void operator []=(int index, int next) => throw StateError('virtual write');
    void update() { print(super[0]++); print(++super[0]); super[0] += 8; print(super[0]); }
  }
  class Mixed extends Parent with Update {
    int? operator [](int index) => throw StateError('virtual read');
    void operator []=(int index, int? next) => throw StateError('virtual write');
  }
  void main() { Mixed().update(); Child().update(); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'index\nread 7\nwrite 7 2\nindex\nread 7\nindex\nwrite 7 4\n5\n7\n15\n',
  });
});

test('simple indexed super writes only require a concrete setter', () => {
  const program = `abstract class Parent {
    int operator [](int index);
    void operator []=(int index, int next) { print(next); }
  }
  class Child extends Parent {
    int operator [](int index) => 1;
    void update() { super[0] = 2; }
  }
  void main() { Child().update(); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '2\n' });
  expect(executeProgram('dart', program.replace('super[0] =', 'super[0] +='))).toMatchObject({ kind: 'compileError' });
});

test('indexed updates validate both operator arguments before reading or writing', () => {
  const program = `class Counter {
    int operator [](String key) { print('read $key'); return 1; }
    void operator []=(int key, int value) { print('write $key $value'); }
  }
  int rhs() { print('rhs'); return 2; }
  void main() {
    for (dynamic key in [0, 'x', true]) {
      try { Counter()[key] += rhs(); } catch (error) { print(error); }
    }
    Counter()[0] = rhs();
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type 'int' is not a subtype of type 'String'\ntype 'String' is not a subtype of type 'int'\ntype 'bool' is not a subtype of type 'int'\nrhs\nwrite 0 2\n",
  });
  for (const update of ['Counter()[0] += rhs()', 'Counter()[0]++', "Counter()['x']++"]) {
    expect(executeProgram('dart', program.replace('Counter()[0] = rhs()', update))).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('dynamic indexed updates type-check the reader before entering its body', () => {
  const program = `class Counter {
    int operator [](int key) { print('read $key'); return 1; }
    void operator []=(dynamic key, int value) { print('write $key $value'); }
  }
  void main() {
    dynamic counter = Counter();
    try { counter['x'] += 2; } catch (error) { print(error.runtimeType); }
    try { counter['x']++; } catch (error) { print(error.runtimeType); }
    counter[7] += 2;
    counter['x'] = 2;
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\n_TypeError\nread 7\nwrite 7 3\nwrite x 2\n',
  });
});

test('call flow follows written argument order and checks closure bodies after the other arguments', () => {
  const declarations = `void show(int value, {int other = 0}) { print([value, other]); }
  T echo<T>(T value, {required T other}) { print([value, other]); return value; }
  void withClosure<T>(T value, {required T Function(T) read}) { print(read(value)); }`;
  const program = `${declarations} void main() {
    final int a;
    show(other: a = 1, a);
    int b;
    echo(other: b = 2, b);
    int c;
    dynamic call = show;
    call(other: c = 3, c);
    int d;
    withClosure(read: ((n) => n + d), d = 4);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 1]\n[2, 2]\n[3, 3]\n8\n',
  });
  for (const call of ['show(other: a, a = 1)', 'echo(other: a, a = 1)', 'invoke(other: a, a = 1)']) {
    const invalid = `${declarations} void main() { dynamic invoke = show; int a; ${call}; }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('constructor delegation evaluates written arguments in source order', () => {
  const program = `int mark(String name) { print(name); return 1; }
  class Parent { Parent(int x, {int y = 0, int z = 0}); }
  class Child extends Parent {
    Child({super.z}) : super(y: mark('super named'), mark('super positional'));
    Child.redirect() : this.named(y: mark('this named'), mark('this positional'));
    Child.named(int x, {int y = 0}) : super(x, y: y);
  }
  void main() { Child(z: 30); Child.redirect(); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'super named\nsuper positional\nthis named\nthis positional\n',
  });
});

test('generic function type metadata resolves in checked declaration scopes', () => {
  const program = `typedef Callback = void Function<@Unknown() T>();
void Function<@Unknown() T>()? ignoredTopLevelReturn() => null;
void accept(void Function<@label T>()? f) { print(f); }
const label = 1;
void main() {
  const local = 1;
  List<void Function<@local T>()?> callbacks = [null];
  List<void Function<@local T>()?> readCallbacks() => callbacks;
  Callback? callback = readCallbacks().first;
  accept(callback);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'null\n' });
  for (const invalid of [
    program.replace('@label', '@Unknown()'),
    program.replace('@local', '@Unknown()'),
    program.replace('@local T>()?> readCallbacks', '@Unknown() T>()?> readCallbacks'),
    program.replace('const local =', 'final local =').replace('@local T>()?> callbacks', 'T>()?> callbacks'),
  ]) {
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('nested function bounds inherit the metadata checks of their declaration', () => {
  const ignored = `typedef F<T extends void Function<@Ignored() U>()> = T;
class Box<T extends void Function<@Ignored() U>()> {}
void top<T extends void Function<@Ignored() U>()>() {}`;
  const bound = 'void Function<@label U>()';
  const program = `${ignored}
void main() {
  const label = 1;
  void Function<T extends ${bound}>()? f() => null;
  void local<T extends ${bound}>() {}
  final closure = <T extends ${bound}>() {};
  local();
  closure();
  top();
  print(f());
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'null\n' });
  for (const declaration of [
    'void Function<T extends void Function<@Missing() U>()>()? f() => null;',
    'void local<T extends void Function<@Missing() U>()>() {}',
    'final closure = <T extends void Function<@Missing() U>()>() {};',
    `final label = 1; void Function<T extends ${bound}>()? f() => null;`,
  ]) {
    expect(executeProgram('dart', `${ignored} void main() { ${declaration} }`)).toMatchObject({ kind: 'compileError' });
  }
});

test('a subclass retains inherited noSuchMethod defaults through abstract redeclarations', () => {
  const program = `abstract class Contract {
  void method([int n = 1]);
  void named({int n = 1});
}
class Parent implements Contract {
  dynamic noSuchMethod(Invocation invocation) {
    print([invocation.positionalArguments, invocation.namedArguments]);
  }
}
abstract class Middle extends Parent {
  void method([int n = 2]);
  void named({int n = 2});
}
class Child extends Middle {
  void fromSuper() { super.method(); super.named(); }
}
void main() {
  final child = Child();
  child.method();
  child.named();
  final method = child.method;
  final named = child.named;
  method();
  named();
  child.fromSuper();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1], {}]\n[[], {Symbol("n"): 1}]\n[[1], {}]\n[[], {Symbol("n"): 1}]\n[[1], {}]\n[[], {Symbol("n"): 1}]\n',
  });
});

test('noSuchMethod forwarders use changed signatures at the concrete dispatch class', () => {
  const program = `abstract class Contract {
  num get value;
  num result([int n = 1]);
  void take(covariant num n);
  void named({covariant num n = 1});
  set value(covariant num n);
}
class Parent implements Contract {
  dynamic noSuchMethod(Invocation invocation) {
    print([invocation.positionalArguments, invocation.namedArguments]);
    return 1.5;
  }
}
abstract class Middle extends Parent {
  int get value;
  int result([int n = 2]);
  void take(covariant int n);
  void named({covariant int n = 2, int extra = 3});
  set value(covariant int n);
}
class Child extends Middle {
  num oldResult() => super.result();
}
void main() {
  final child = Child();
  print(child.oldResult());
  try { print(child.result()); } catch (error) { print(error.runtimeType); }
  try { print(child.value); } catch (error) { print(error.runtimeType); }
  Contract asContract = child;
  final take = asContract.take;
  print(take.runtimeType);
  try { take(1.5); } catch (error) { print(error.runtimeType); }
  dynamic named = child.named;
  print(named.runtimeType);
  try { named(n: 1.5); } catch (error) { print(error.runtimeType); }
  named();
  dynamic target = child;
  try { target.value = 1.5; } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[[1], {}]\n1.5\n[[2], {}]\n_TypeError\n[[], {}]\n_TypeError\n(Object?) => void\n_TypeError\n({Object? n, int extra}) => void\n_TypeError\n[[], {Symbol("n"): 2, Symbol("extra"): 3}]\n_TypeError\n',
  });
});

test('concrete classes may declare bodyless members when noSuchMethod implements them', () => {
  const program = `class Parent {
  int own();
  dynamic noSuchMethod(Invocation invocation) => 1;
}
class Child extends Parent {
  int added();
}
void main() { print([Parent().own(), Child().own(), Child().added()]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 1, 1]\n' });
  const missingHandler = program.replace('dynamic noSuchMethod(Invocation invocation) => 1;', '');
  expect(executeProgram('dart', missingHandler)).toMatchObject({ kind: 'compileError' });
  for (const source of [
    'class A { num f() => 1.5; } class B extends A { int f(); }',
    'class A { num get value => 1.5; } abstract class B extends A { int get value; } class C extends B {}',
  ]) {
    expect(executeProgram('dart', `${source} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('adding covariance changes the effective forwarder even when types match', () => {
  const program = `abstract class Contract {
    void f(num n);
    void named({num n = 1});
  }
  class Parent implements Contract {
    dynamic noSuchMethod(Invocation invocation) {
      print([invocation.positionalArguments, invocation.namedArguments]);
    }
  }
  abstract class Middle extends Parent {
    void f(covariant num n);
    void named({covariant num n = 2});
  }
  class Child extends Middle {}
  void main() {
    final child = Child();
    final f = child.f;
    final named = child.named;
    print(f.runtimeType);
    print(named.runtimeType);
    f(7);
    named();
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '(Object?) => void\n({Object? n}) => void\n[[7], {}]\n[[], {Symbol("n"): 2}]\n',
  });
});

test('replacement forwarders retain covariance from generic ancestors', () => {
  const program = `abstract class Contract<T> {
  T f([T? value]);
  T named({T? value});
}
class Parent<T> implements Contract<T> {
  dynamic noSuchMethod(Invocation invocation) => 1;
}
abstract class Middle extends Parent<num> {
  int f([num? value = 2]);
  int named({num? value = 2});
}
class Child extends Middle {}
void main() {
  final child = Child();
  final f = child.f;
  final named = child.named;
  print([f.runtimeType, f is int Function([Object?])]);
  print([named.runtimeType, named is int Function({Object? value})]);
  print([f(), named()]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[([Object?]) => int, true]\n[({Object? value}) => int, true]\n[1, 1]\n',
  });
});

test('concrete overrides check arguments passed through a generic supertype', () => {
  const program = `class Base<T> {
  void take(T n) {}
  void named({required T n}) {}
  set value(T n) {}
  T? field;
  late T lateField;
}
class Child extends Base<int> {
  void take(int n) { print(n); }
  void named({required int n}) { print(n); }
  set value(int n) { print(n); }
  int? field;
  late int lateField;
}
void main() {
  Base<num> target = Child();
  try { target.take(1.5); } catch (error) { print(error.runtimeType); }
  try { target.named(n: 1.5); } catch (error) { print(error.runtimeType); }
  try { target.value = 1.5; } catch (error) { print(error.runtimeType); }
  try { target.field = 1.5; } catch (error) { print(error.runtimeType); }
  try { target.lateField = 1.5; } catch (error) { print(error.runtimeType); }
  target.take(1);
  target.named(n: 2);
  target.value = 3;
  target.field = 4;
  target.lateField = 5;
  print([target.field, target.lateField]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\n_TypeError\n_TypeError\n_TypeError\n_TypeError\n1\n2\n3\n[4, 5]\n',
  });
});

test('combined interface signatures select inherited noSuchMethod binders and types', () => {
  const program = `abstract class General<T> {
  T f([T? value]);
  T get number;
}
class Parent<T> implements General<T> {
  dynamic noSuchMethod(Invocation invocation) {
    print(invocation.positionalArguments);
    return 1.5;
  }
}
abstract class Narrow {
  int f([num? value = 2]);
  int get number;
}
abstract class Middle extends Parent<num> implements Narrow {}
class Child extends Middle {
  num previous() => super.f();
}
void main() {
  final child = Child();
  print(child.previous());
  final f = child.f;
  print(f.runtimeType);
  try { int value = f(); print(value); } catch (error) { print(error.runtimeType); }
  try { int value = child.number; print(value); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[null]\n1.5\n([Object?]) => int\n[2]\n_TypeError\n[]\n_TypeError\n',
  });
  const badSuper = program.replace('num previous()', 'int previous()');
  expect(executeProgram('dart', badSuper)).toMatchObject({ kind: 'compileError' });
  const conflicting = program.replace('int get number;', 'String get number;');
  expect(executeProgram('dart', conflicting)).toMatchObject({ kind: 'compileError' });
});

test('a static member only sees its own type parameters and local variables', () => {
  const program = `class T {}
class C<T> {
  static T identity<T>(T value) => value;
  static int shadowed() { final T = 3; return T; }
}
void main() { print([C.identity(2), C.shadowed()]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 3]\n' });
  for (const declaration of [
    'class C<T> { static T? value; }',
    'mixin C<T> { static var value = T; }',
    'enum C<T> { value; static Type f() => T; }',
    'extension C<T> on List<T> { static T? value; }',
  ]) {
    expect(executeProgram('dart', `class T {} ${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('the effective inherited covariance check runs on direct calls and tear-offs', () => {
  const program = `abstract class Interface { void f([covariant num value = 3]); }
class Parent { void f([int value = 4]) { print(value); } }
class Child extends Parent implements Interface {}
class Further extends Child {}
void main() {
  Interface target = Further();
  try { target.f(1.5); } catch (error) { print(error.runtimeType); }
  final f = target.f;
  print(f.runtimeType);
  try { f(1.5); } catch (error) { print(error.runtimeType); }
  f(2);
  f();
  Further().f();
  Parent parent = Further();
  parent.f();
  Parent().f();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\n([Object?]) => void\n_TypeError\n2\n3\n3\n3\n4\n',
  });
});

test('extension inference validates dependent bounds after solving receiver constraints', () => {
  const declarations = `extension E<T extends U, U> on (U, void Function(T)) {
  String get types => '$T $U';
}
void acceptsInt(int value) {}
void acceptsNum(num value) {}
void acceptsString(String value) {}
extension ListBound<T extends List<U>, U> on (U, void Function(T)) {
  String get listTypes => '$T $U';
}
void acceptsIntList(List<int> value) {}
void acceptsStringList(List<String> value) {}`;
  const valid = `${declarations} void main() {
    print((1, acceptsInt).types);
    print((1, acceptsIntList).listTypes);
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: 'int int\nList<int> int\n' });
  for (const expression of ['(1, acceptsNum).types', '(1, acceptsString).types', '(1, acceptsStringList).listTypes']) {
    const source = `${declarations} void main() { print(${expression}); }`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('explicit extension applications check type arguments and the instantiated receiver type', () => {
  const declarations = `extension Sum<T extends num> on List<T> { Type get item => T; }
  extension Dependent<A, B extends List<A>> on B { Type get item => A; }
  extension Any on dynamic { int get tag => 1; }`;
  const program = `${declarations} void main() {
    dynamic numbers = [3];
    print(Sum<int>([]).item);
    print(Sum(numbers).item);
    print(Dependent<num, List<int>>(numbers).item);
    print(Any(null).tag);
    dynamic words = ['x'];
    try { print(Sum<int>(words).item); } catch (error) { print(error.runtimeType); }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'int\nnum\nnum\n1\n_TypeError\n',
  });
  for (const expression of [
    "Sum<int>(['x']).item",
    "Sum<String>(['x']).item",
    'Sum<int, int>([1]).item',
    'Dependent<int, List<num>>([1]).item',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() { print(${expression}); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('extension-type members use static owner arguments and separate method arguments', () => {
  const program = `extension type Box<T>(List<T> values) {
    Type get elementType => T;
    bool accepts(Object? value) => value is T;
    set first(T value) { values[0] = value; print(T); }
    (Type, Type) describe<U>() => (T, U);
  }
  void main() {
    final box = Box<int>([1]);
    print(box.elementType);
    print([box.accepts('x'), box.accepts(2)]);
    box.first = 3;
    print(box.values);
    print(box.describe<String>());
    final describe = box.describe;
    print(describe<bool>());
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'int\n[false, true]\nint\n[3]\n(int, String)\n(int, bool)\n',
  });
});

test('mixin applications substitute inferred types for writable and late fields', () => {
  const program = `mixin Items<T> {
    final fixed = <T>[];
    late var writable = <T>[];
    var ordinary = <T>[];
  }
  class Numbers with Items<int> {}
  class Words with Items<String> {}
  void main() {
    final numbers = Numbers();
    final words = Words();
    numbers.writable = [7];
    words.ordinary = ['x'];
    print([numbers.fixed.runtimeType, numbers.writable.runtimeType]);
    print([words.ordinary.runtimeType, words.writable.runtimeType]);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<int>, List<int>]\n[List<String>, List<String>]\n',
  });
  expect(executeProgram('dart', program.replace('numbers.writable = [7]', "numbers.writable = ['bad']"))).toMatchObject(
    {
      kind: 'compileError',
    }
  );
});

test('initializing and super formals are final during constructor initialization', () => {
  const program = `class A {
    int x;
    int y;
    A(this.x) : y = x { x = 3; }
  }
  class B extends A {
    int z;
    B(super.x) : z = x { x = 4; }
  }
  void main() { print([A(1).x, B(2).x, B(2).z]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[3, 4, 2]\n' });
  for (const source of [program.replace('y = x', 'y = (x = 2)'), program.replace('z = x', 'z = x++')]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('numeric operators on bounded type parameters return numeric types', () => {
  const declarations = [
    'int add<T extends int>(T a, T b) => a+b;',
    'double multiply<T extends double>(T a, T b) => a*b;',
    'int negate<T extends int>(T a) => -a;',
    'int complement<T extends int>(T a) => ~a;',
  ];
  const program = `${declarations.join('\n')}
  void main() { print([add(2, 3), multiply(2.0, 3.0), negate(2), complement(2)]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[5, 6.0, -2, -3]\n' });
  for (const declaration of declarations) {
    const invalid = program.replace(declaration, declaration.replace(/^\w+ /, 'T '));
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('environment constructors use declared defaults with no learner environment definitions', () => {
  const program = `void main() {
    print([
      const bool.fromEnvironment('enabled'),
      const bool.fromEnvironment('enabled', defaultValue: true),
      bool.fromEnvironment('enabled', defaultValue: true),
      const bool.hasEnvironment('enabled'),
      const int.fromEnvironment('count', defaultValue: 4),
      const String.fromEnvironment('name', defaultValue: 'unknown'),
    ]);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[false, true, true, false, 4, unknown]\n',
  });
});

test('generic enum constants resolve their own arguments and values uses the enum bound', () => {
  const program = `const selected = Constants.selected;
class Constants {
  static const selected = Op.add;
  static const seed = 1;
}
enum Op<T extends num> {
  add(Constants.seed), sub<int>(2);
  const Op(this.code);
  final T code;
}
enum Box<T> {
  number(1), text<String>('text');
  const Box(this.value);
  final T value;
}
void main() {
  int code = selected.code;
  print([code, Op.add.runtimeType, Op.values.runtimeType, Op.values.map((o) => o.code).toList()]);
  print([Box.number.value + 1, Box.values.runtimeType, Box.values.map((o) => o.value).toList()]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, Op<int>, List<Op<num>>, [1, 2]]\n[2, List<Box<dynamic>>, [1, text]]\n',
  });
  const bad = "enum E<T extends num> { x<String>('text'); const E(T value); } void main() {}";
  expect(executeProgram('dart', bad)).toMatchObject({ kind: 'compileError' });
});

test('Function values accept implicit callable tear-offs and expose call', () => {
  const program = `class Callable { T call<T>(T x) => x; }
extension type Offset(int offset) { int call(int x) => offset + x; }
Function returned<T extends Callable>(T object) => object;
void dispatch(Function f) {
  print(f.call<int>(2));
  Function extracted = f.call;
  print(extracted.call('text'));
}
void optional(Function? f) {
  print(f?.call(3));
  print(f?.call == null);
}
void main() {
  dispatch(Callable());
  final functions = <Function>[Callable(), Offset(1)];
  print(functions[0].call(4));
  print(functions[1].call(4));
  print(returned(Callable()).call(5));
  int Function(int) specialized = Callable();
  optional(specialized);
  optional(null);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '2\ntext\n4\n5\n5\n3\nfalse\nnull\ntrue\n',
  });
  const declarations = 'class C { int call(int value) => value; }';
  for (const body of [
    'Function? f(C? c) => c;',
    'void f(Function? g) { g.call(1); }',
    'void f(Function g) { String result = g.call; print(result); }',
    'void f(Object o) { o.call(); }',
  ]) {
    expect(executeProgram('dart', `${declarations} ${body} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('synchronous generators resume do loops and switch cases after yielding', () => {
  const program = `Iterable<int> values(List<Object> subjects) sync* {
  var i = -1;
  outer: do {
    i++;
    switch (subjects[i]) {
      case int value when value > 0:
        yield value;
        if (value == 2) continue outer;
        continue shared;
      shared:
      case 'x':
        yield* [10, 11];
        break;
      default:
        yield 20;
        if (i == 3) return;
    }
    yield -1;
  } while (i + 1 < subjects.length);
}
Iterable<int> counted() sync* {
  var i = 0;
  do {
    if (i++ == 0) { yield 0; continue; }
    yield i;
  } while (i < 3);
}
void main() {
  final sequence = values([1, 2, 'x', 0]);
  print(sequence.take(2).toList());
  print(sequence.toList());
  print(counted().toList());
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 10]\n[1, 10, 11, -1, 2, 10, 11, -1, 20]\n[0, 2, 3]\n',
  });
});

test('synchronous generators accept return types that can hold an Iterable', () => {
  const valid = `Object objectValues() sync* { yield 1; }
Object? optionalObject() sync* { yield 1; }
Iterable<int>? optionalIterable() sync* { yield 1; }
void main() {
  local() sync* { yield 1; }
  Object Function() closure = () sync* { yield 1; };
  Iterable<num> Function() contextual = () sync* { yield 1; };
  void Function() discarded = () sync* { yield 1; };
  discarded();
  print([objectValues().runtimeType, optionalObject().runtimeType, optionalIterable().runtimeType]);
  print([local().runtimeType, closure().runtimeType, contextual().runtimeType]);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    stdout:
      '[_SyncStarIterable<dynamic>, _SyncStarIterable<dynamic>, _SyncStarIterable<int>]\n[_SyncStarIterable<int>, _SyncStarIterable<int>, _SyncStarIterable<num>]\n',
  });
  for (const declaration of [
    'List<int> values() sync* { yield 1; }',
    'void values() sync* { yield 1; }',
    'T values<T extends Object>() sync* { yield 1; }',
    "Iterable<int>? values() sync* { yield 'text'; }",
  ]) {
    expect(executeProgram('dart', `${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('JSON revivers see each value accepted before a parse error', () => {
  const program = `import 'dart:convert';
void main() {
  dynamic revive(dynamic key, dynamic value) { print([key, value]); return value; }
  print(jsonDecode('{"x":1,"x":2}', reviver: revive));
  for (var input in ['[1,2,?]', '[1x]', '[[1],{"b":3}] trailing']) {
    try { jsonDecode(input, reviver: revive); }
    catch (error) { print(error.runtimeType); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[x, 1]\n[x, 2]\n[null, {x: 2}]\n{x: 2}\n[0, 1]\n[1, 2]\nFormatException\nFormatException\n[0, 1]\n[0, [1]]\n[b, 3]\n[1, {b: 3}]\nFormatException\n',
  });
});

test('native lists expose their identity hash as hashCode', () => {
  const program = `void main() {
  for (final list in [<int>[], List<int>.filled(2, 0), List<int>.unmodifiable([1])]) {
    print(list.hashCode == identityHashCode(list));
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\ntrue\n' });
});

test('collection control flow retains guaranteed assignments', () => {
  const program = `void main() {
  int n;
  bool b = true;
  var choose = [if (b case true) n = 1 else n = 2];
  int i;
  var counted = [for (i = 0; i < 1; i++) i];
  late List<int> source;
  var values = [for (final item in (source = [3])) item];
  print([choose, n, counted, i, values, source]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1], 1, [0], 1, [3], [3]]\n',
  });
  expect(
    executeProgram('dart', 'void main() { int n; var a = [for (var i = 0; i < 0; i++) n = 1]; print(n); }')
  ).toMatchObject({ kind: 'compileError' });
});

test('collection element contexts determine whether void values can be used', () => {
  const program = `void log() {}
void main() {
  final List<void> contextual = [log()];
  print([[log()], <void>[log()], contextual, {log()}, <void, int>{log(): 1}, <int, void>{1: log()}, [?log()]]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[null], [null], [null], {null}, {null: 1}, {1: null}, []]\n',
  });
  for (const expression of ['<dynamic>[log()]', "{'a':log()}", '{log():1}', '<int,void>{1:?log()}']) {
    expect(executeProgram('dart', `void log() {} void main() { var a = ${expression}; print(a); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('assignment indices must be usable values on dynamic and static receivers', () => {
  for (const program of [
    'void main() { dynamic a = {}; a[print(1)] = 2; }',
    'void main() { dynamic a = {}; a[print(1)]++; }',
    'class A { void operator []=(void k, int v) { print(v); } } void main() { A()[print(1)] = 2; }',
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
});

test('void return checks use both declared and contextual function types', () => {
  const program = `void arrow() => 2;
void accept(void Function() callback) { callback(); }
void main() {
  void Function() callback = () => 1;
  callback();
  arrow();
  accept(() { return print('ran'); });
  accept(() { return null; });
  dynamic value = 3;
  accept(() { return value; });
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'ran\n' });
  for (const source of [
    'void main() { void Function() callback = () { return 1; }; callback(); }',
    'void take(void Function() f) {} void main() { take(() { return 1; }); }',
    'void f(Object? x) { return x; } void main() {}',
    'void f() { return throw 1; } void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('dynamic operators reject void operands before execution', () => {
  for (const operator of ['+', '<', '&']) {
    const program = `void main() { dynamic value = 1; print(value ${operator} print('operand')); }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
});

test('function upper bounds preserve compatible named parameter signatures', () => {
  const program = `void main() {
  var optional = [({int n = 0}) => n, ({num n = 0}) => n.toInt()];
  var required = [({required int n, String x = ''}) => n, ({num n = 0, int y = 0}) => n.toInt()];
  var noNames = [({int x = 1}) => x, ({int y = 2}) => y];
  var incompatible = [({required int x}) => x, ({int y = 0}) => y];
  print([optional.runtimeType, required.runtimeType, noNames.runtimeType, incompatible.runtimeType]);
  print([optional.first(n: 3), required.last(n: 4), noNames.last()]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<({int n}) => int>, List<({required int n}) => int>, List<() => int>, List<Function>]\n[3, 4, 2]\n',
  });
  expect(executeProgram('dart', program.replace('optional.first(n: 3)', 'optional.first(n: "bad")'))).toMatchObject({
    kind: 'compileError',
  });
});

test('regular expressions preserve escaped text and UTF-16 search offsets', () => {
  const program = `void main() {
  var literal = RegExp.escape('a-b/c');
  print([literal, RegExp(literal, unicode: true).hasMatch('a-b/c')]);
  var regex = RegExp('.', unicode: true);
  print(regex.allMatches('😀x', 1).map((m) => [m.start, m.end, m[0]]).toList());
  print(RegExp('😀', unicode: true).allMatches('😀x', 1).map((m) => [m.start, m.end, m[0]]).toList());
  var prefix = regex.matchAsPrefix('😀x', 1)!;
  print([prefix.start, prefix.end, prefix[0], '😀x'.indexOf(regex, 1), '😀x'.startsWith(regex, 1)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[a-b/c, true]\n[[0, 2, 😀], [2, 3, x]]\n[[0, 2, 😀]]\n[0, 2, 😀, 1, true]\n',
  });
});

test('initializing and super formals leave scope when a constructor body begins', () => {
  const program = `class A {
  int x;
  int y;
  A(this.x) : y = x + 1 {
    void change() { x += 10; }
    change();
  }
}
class B extends A {
  B(super.x) { x *= 2; }
}
void main() {
  var a = A(2);
  var b = B(3);
  print([a.x, a.y, b.x, b.y]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[12, 3, 26, 4]\n' });
  expect(executeProgram('dart', 'class C { final int x; C(this.x) { x = 2; } } void main() { C(1); }')).toMatchObject({
    kind: 'compileError',
  });
});

test('switch coverage evaluates named and computed boolean and enum constants', () => {
  const program = `enum Choice { first, second }
const yes = true;
const first = Choice.first;
class State { static const other = Choice.second; }
int test(bool value) => switch (value) { yes => 1, false => 0 };
int choose(Choice value) => switch (value) { first => 1, State.other => 2 };
int local(bool? value) {
  const off = !yes;
  const empty = null;
  switch (value) {
    case yes: return 1;
    case off: return 0;
    case empty: return -1;
  }
}
void main() { print([test(true), choose(Choice.first), choose(Choice.second), local(false), local(null)]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 1, 2, 0, -1]\n' });
  expect(executeProgram('dart', program.replace('const off = !yes;', 'const off = yes;'))).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('false') })],
  });
});

test('exhaustiveness combines object property patterns across cases', () => {
  const program = `enum Mode { off, on }
const active = Mode.on;
sealed class State {}
class Value extends State {
  final Mode mode;
  Value(this.mode);
}
class Wrapped extends State {
  final Value value;
  Wrapped(this.value);
}
int score(State object) => switch (object) {
  Value(mode: active) => 1,
  Value(mode: Mode.off) => 2,
  Wrapped(value: Value(mode: active)) => 3,
  Wrapped(value: Value(mode: Mode.off)) => 4,
};
int boolean(Value a) => switch ((a, true)) {
  (Value(mode: active), _) => 1,
  (Value(mode: Mode.off), _) => 2,
};
void main() { print([score(Value(Mode.on)), score(Wrapped(Value(Mode.off))), boolean(Value(Mode.off))]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 4, 2]\n' });
  expect(executeProgram('dart', program.replace('  Wrapped(value: Value(mode: Mode.off)) => 4,', ''))).toMatchObject({
    kind: 'compileError',
  });
});

test('pattern decisions reuse each extracted path across alternatives and guards', () => {
  const program = `class C {
  int calls = 0;
  int get value { print('read'); return ++calls; }
}
void main() {
  var c = C();
  var answer = switch (c) {
    C(value: 1) when (c.calls = 10) > 20 => 0,
    C(value: 1) => 1,
    _ => -1,
  };
  print(answer);
  if (C() case C(value: 2) || C(value: 1)) print('or');
  c = C();
  if ((c, c) case (C(value: 1), C(value: 2))) print('separate');
  c = C();
  switch (c) {
    case C(value: 2): print(2);
    case C(value: 1): print(1);
  }
  if (c case C(value: 2)) print('new decision');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'read\n1\nread\nor\nread\nread\nseparate\nread\n1\nread\nnew decision\n',
  });
});

test('relational patterns validate operands and check dynamic results as bool', () => {
  const program = `class Score {
  dynamic operator <(int bound) => 0;
}
void main() {
  int value = 1;
  if (value case < 2) print('less');
  for (dynamic subject in [Score(), null]) {
    try { if (subject case < 2) print('matched'); }
    catch (error) { print(error.runtimeType); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'less\n_TypeError\nNoSuchMethodError\n',
  });
  for (const source of [
    "void main() { if (1 case < 'a') print('matched'); }",
    "class C { int operator <(int n) => 1; } void main() { if (C() case < 2) print('matched'); }",
    'bool check(int? n) => switch(n) { < 2 => true, _ => false }; void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('null-aware chains join flows only where their execution can be skipped', () => {
  const declarations = `class C {
  C get next => this;
  int get value => 3;
  void set value(int n) {}
  void take(int n) { print(n); }
}
C? nullable() => null;
`;
  const positive = `${declarations}
void main() {
  C? c = nullable();
  c?.take(c.value);
  int a;
  c?..take(a = 2)..take(a);
  var skipped = (c?.next.value = 2);
  print(skipped);
  C definite = C();
  int b;
  definite?.take(b = 4);
  print(b);
}`;
  expect(executeProgram('dart', positive)).toMatchObject({
    kind: 'executed',
    stdout: 'null\n4\n4\n',
  });
  for (const operation of ['c?.take(n = 1)', 'c?.next.value = (n = 1)', 'c?..take(n = 1)']) {
    expect(
      executeProgram('dart', `${declarations}void main() { C? c = nullable(); int n; ${operation}; print(n); }`)
    ).toMatchObject({ kind: 'compileError' });
  }
  expect(executeProgram('dart', 'void main() { List<int>? a; int n; a?[n = 1] = 2; print(n); }')).toMatchObject({
    kind: 'compileError',
  });
});

test('for-in declarations validate their annotations in statements and collections', () => {
  const program = `const note = 1;
void main() {
  for (@note var n in [3]) print(n);
  print([for (@note final (a,b) in [(1,2)]) a+b]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3\n[3]\n' });
  for (const source of [
    program.replace('@note var n', '@missing var n'),
    program.replace('@note final (a,b)', '@missing final (a,b)'),
    'void main() { int n = 0; for (@deprecated n in [1]) print(n); }',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('reentrant global initializers preserve assigned values even when the outer call fails', () => {
  const program = `int count = 0;
late final int x = initialize();
int initialize() {
  if (count++ == 0) print(x);
  return count;
}
class C {
  static int count = 0;
  static final int x = initialize();
  static int initialize() {
    if (count++ == 0) print(x);
    return count;
  }
}
int retries = 0;
int y = initializeOther();
int initializeOther() {
  if (retries++ == 0) { print(y); throw 'outer'; }
  return retries;
}
void main() {
  try { print(x); } catch (error) { print(error); }
  try { print(C.x); } catch (error) { print(error); }
  try { print(y); } catch (error) { print(error); }
  print([x, C.x, y]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "2\nLateInitializationError: Field 'x' has been assigned during initialization.\n2\nLateInitializationError: Field 'x' has been assigned during initialization.\n2\nouter\n[2, 2, 2]\n",
  });
});

test('enum values remain reserved when the generated getter is installed', () => {
  for (const member of ['static int values = 1;', 'static int get values => 1;', 'void set values(int n) {}']) {
    expect(executeProgram('dart', `enum E { a; ${member} } void main() { print(E.values); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
  expect(
    executeProgram('dart', 'enum E { a; static void set values(int n) {} } void main() { print(E.values); }')
  ).toMatchObject({ kind: 'executed', stdout: '[E.a]\n' });
});

test('unrepresentable integer literals in double contexts produce compile errors', () => {
  const digits = '1' + '0'.repeat(400);
  for (const literal of [digits, '-' + digits]) {
    expect(executeProgram('dart', `void main() { double value = ${literal}; print(value); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('native lists use the SDK callback and shuffle argument signatures', () => {
  const program = `import 'dart:math';
void main() {
  [1].forEach((value) => print(value));
  var list = [1, 2, 3, 4];
  list.shuffle(Random(1));
  print(list);
  dynamic dynamicList = list;
  try { dynamicList.shuffle(1); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\n[3, 2, 4, 1]\n_TypeError\n',
  });
  for (const source of [
    'void main() { [1].forEach((x) { return 2; }); }',
    'class Duck { int nextInt(int n) => 0; } void main() { [1,2].shuffle(Duck()); }',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('native set and map copies are charged against the allocation limit', () => {
  for (const [source, copy] of [
    ['Set<int>.of(List<int>.generate(10000, (i) => i))', '{...original}'],
    ['Set<int>.of(List<int>.generate(10000, (i) => i))', 'Set<int>.of(original)'],
    ['Map<int, int>.fromIterables(List<int>.generate(10000, (i) => i), List<int>.filled(10000, 1))', '{...original}'],
  ]) {
    const program = `void main() {
  var original = ${source};
  var copies = [];
  for (var i = 0; i < 120; i++) copies.add(${copy});
  print(copies.length);
}`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
  }
});

test('sealed switch coverage excludes concrete alternatives with incompatible type arguments', () => {
  const program = `sealed class Result<T> {}
class IntResult extends Result<int> {}
class StringResult extends Result<String> {}
class BottomResult extends Result<Never> {}
String label(Result<int>? value) => switch (value) {
  IntResult() => 'int',
  BottomResult() => 'bottom',
  null => 'null',
};
void main() { print([label(IntResult()), label(BottomResult()), label(null)]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[int, bottom, null]\n' });
  expect(executeProgram('dart', program.replace("  BottomResult() => 'bottom',", ''))).toMatchObject({
    kind: 'compileError',
  });
});

test('joining generic function types keeps their shared parameter scope', () => {
  const program = `int f<T>(T x) => 1;
double g<U>(U x) => 2.0;
T same<T>(T x) => x;
int bounded<T extends num>(T x) => 0;
void main() {
  var functions = [f, g];
  print([functions.runtimeType, [same, f].runtimeType, [f, bounded].runtimeType]);
  num result = functions.last<String>('text');
  print(result);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<<Y0>(Y0) => num>, List<<Y0>(Y0) => Object?>, List<Function>]\n2.0\n',
  });
  expect(executeProgram('dart', program.replace('num result', 'String result'))).toMatchObject({
    kind: 'compileError',
  });
});

test('generic closure instantiations preserve function equality, hashing, and canonical tear-offs', () => {
  const program = `T id<T>(T value) => value;
class C {
  T id<T>(T value) => value;
  static T identity<T>(T value) => value;
}
class Box<T> {
  final T value;
  Box(this.value);
}
void check(Function a, Function b) {
  print([a == b, identical(a, b), a.hashCode == b.hashCode, {a: 1}[b]]);
}
void main() {
  int Function(int) a = id, b = id;
  num Function(num) different = id;
  check(a, b);
  check(a, different);
  var c = C();
  int Function(int) method1 = c.id, method2 = c.id, other = C().id;
  check(method1, method2);
  check(method1, other);
  int Function(int) static1 = C.identity, static2 = C.identity;
  check(static1, static2);
  final generic = <T>(T n) => n;
  int Function(int) local1 = generic, local2 = generic;
  check(local1, local2);
  Box<int> Function(int) constructor = Box.new;
  check(constructor, Box<int>.new);
  T Function<T>(T)? absent;
  int Function(int)? nullable = absent;
  print([a(5), method1(6), constructor(7).value, nullable]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[true, true, true, 1]\n[false, false, false, null]\n[true, false, true, 1]\n[false, false, false, null]\n[true, true, true, 1]\n[true, false, true, 1]\n[true, true, true, 1]\n[5, 6, 7, null]\n',
  });
});

test('late local initializers use deferred flow and preserve reentrant results', () => {
  const program = `void main() {
  late int input;
  late int result = input;
  input = 3;
  print(result);
  var count = 0;
  int Function() read = () => 0;
  late int mutable = read();
  read = () { if (count++ == 0) return mutable + 1; return 7; };
  print([mutable, count]);
  count = 0;
  late final int once = read();
  read = () { if (count++ == 0) return once + 1; return 4; };
  try { print(once); } catch (error) { print(error); }
  print([once, count]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: "3\n[8, 2]\nLateInitializationError: Local 'once' has been assigned during initialization.\n[4, 2]\n",
  });
  for (const source of [
    'void main() { int input; late int result = input; input = 3; print(result); }',
    'void main() { late int input; late int result = input; print(result); }',
    'void main() { int? input = 1; late int result = input + 1; input = null; print(result); }',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('a late initializer keeps its captured turtle across an escaped scope', () => {
  const program = `Turtle Function() make() {
  {
    final turtle = Turtle(1, 1);
    late final Turtle deferred = turtle;
    return () => deferred;
  }
}
void main() {
  final read = make();
  Turtle(3, 3).canMoveForward();
  read().forward();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    finalTurtles: [{ x: 1, y: 2 }],
  });
  expect(traceProgram('dart', program, program).finalTurtles).toMatchObject([{ x: 1, y: 2 }]);
});

test('pattern extraction distinguishes list directions and reified extension getters', () => {
  const program = `import 'dart:collection';
class L extends ListBase<int> {
  int calls = 0;
  int get length => 1;
  set length(int value) {}
  int operator [](int index) { print('read'); return ++calls; }
  void operator []=(int index, int value) {}
}
extension Kind<T> on List<T> {
  Type get kind { print(T); return T; }
}
Type read<T>(List<T> list) {
  if (list case List<T>(kind: var kind)) return kind;
  return Object;
}
void main() {
  print(switch (L()) { [2, ...] => 0, [..., 1] => 1, _ => 2 });
  print(switch (L()) { [...var a, 2] => 0, [...var b, 1] => 1, _ => 2 });
  Object list = <int>[1];
  print(switch (list) { List<int>(kind: String) => 0, List<num>(kind: num) => 1, _ => 2 });
  print(read<int>([1]));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'read\nread\n2\nread\n1\nint\nnum\n1\nint\nint\n',
  });
});

test('formal defaults use equals, and var formals require a primary constructor field', () => {
  const sources = [
    'void f({int value: 1}) {} void main() { f(); }',
    'void f(var value) {} void main() { f(1); }',
    'void f(var int value) {} void main() { f(1); }',
    'void main() { var f = (var int value) => value; f(1); }',
    'class C { C(var int value); } void main() { C(1); }',
  ];
  for (const source of sources) expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  const program = `class C(var int value) {}
int f({int value = 1}) => value;
void main() { var c = C(f()); c.value += 2; print(c.value); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '3\n' });
});

test('Base64 encoders read custom list lengths in SDK order', () => {
  const program = `import 'dart:convert';
import 'dart:collection';
class Input extends ListBase<int> {
  int checks = 0;
  int get length { checks++; print(checks); return checks; }
  set length(int value) {}
  int operator [](int index) => 65 + index;
  void operator []=(int index, int value) {}
}
void main() {
  print(base64Encode(Input()));
  print(base64Url.encoder.convert(Input()));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\n2\nQUI=\n1\n2\nQUI=\n',
  });
});

test('Base64 validation preserves input offsets before checking output storage', () => {
  const program = `import 'dart:convert';
void main() {
  var slots = List<int>.filled(600000, 0);
  try { base64Decode('/' * 999996 + '?'); }
  on FormatException catch (error) { print(error.offset); }
  print(slots.length);
  print(base64.decoder.convert('xQQ%3d%3dy', 1, 9));
  print(base64Url.decode('-_8='));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '999996\n600000\n[65]\n[251, 255]\n',
  });
});

test('String.split keeps literal separators and custom match boundaries', () => {
  const program = `void main() {
  print('a--b----'.split('--'));
  print(''.split('-').length);
  print('😀'.split('').map((part) => part.codeUnitAt(0)).toList());
  print('a23b'.split(RegExp('[0-9]+')));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[a, b, , ]\n1\n[55357, 56832]\n[a, b]\n',
  });
});

test('int.parse reports the radix and the VM parsing block offset', () => {
  const program = `void parse(String source, [int? radix]) {
  try { print(int.parse(source, radix: radix)); }
  on FormatException catch (error) { print([error.message, error.offset]); }
}
void main() {
  parse('0xG');
  parse('-12x');
  parse(' + ');
  parse(' ');
  parse('000x', 10);
  parse('9999999999999999999999999x');
  parse('999999999999999999999999');
  parse('0xffffffffffffffff');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[Invalid radix-16 number, 2]\n[Invalid radix-10 number, 1]\n[Invalid number, 2]\n[Invalid number, 1]\n[Invalid radix-10 number, 3]\n[Invalid radix-10 number, 8]\n[Positive input exceeds the limit of integer, null]\n-1\n',
  });
});

test('BigInt size limits accept exact results at the boundary', () => {
  const program = `void main() {
  var n = BigInt.one << 3999999;
  print([(n + BigInt.zero).bitLength, (n - BigInt.one).bitLength, (n * BigInt.one).bitLength]);
  print([(n | BigInt.zero).bitLength, (n ^ n).bitLength, BigInt.two.pow(3999999).bitLength]);
  try { print(n + n); } on OutOfMemoryError { print('too large'); }
  try { print(n * n); } on OutOfMemoryError { print('too large'); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[4000000, 3999999, 4000000]\n[4000000, 0, 4000000]\ntoo large\ntoo large\n',
  });
});

test('Codec exposes typed converters and inherited encode and decode methods', () => {
  const program = `import 'dart:convert';
class Count extends Converter<String, int> {
  int convert(String input) => input.length;
}
class Stars extends Converter<int, String> {
  String convert(int count) => '*' * count;
}
class Example extends Codec<String, int> {
  Converter<String, int> get encoder => Count();
  Converter<int, String> get decoder => Stars();
}
void main() {
  Codec<Object?, String> jsonCodec = json;
  print([jsonCodec.encoder.convert(1), jsonCodec.decoder.convert('true')]);
  Codec<String, int> example = Example();
  print([example.encode('abc'), example.decode(2)]);
  print(base64.decode(base64.encode([65])));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, true]\n[3, **]\n[65]\n',
  });
  expect(
    executeProgram(
      'dart',
      "import 'dart:convert'; class Broken extends Codec<String,int> { int encode(String s) => 0; String decode(int n) => ''; } void main() {}"
    )
  ).toMatchObject({ kind: 'compileError' });
});

test('index assignment operators must declare a void result', () => {
  const program = `typedef Nothing = void;
class A {
  Nothing operator []=(int index, int value) { print(value); }
}
extension B on int {
  operator []=(int index, int value) { print(value); }
}
void main() { A()[0] = 1; 2[0] = 3; }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1\n3\n' });
  for (const source of [
    'class A { int operator []=(int i, int n) => n; } void main() {}',
    'extension E on int { dynamic operator []=(int i, int n) => n; } void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
});

test('insertAll grows and shifts the destination before reading efficient sources', () => {
  const program = `import 'dart:collection';
class Input extends ListBase<int?> {
  final List<int?> target;
  Input(this.target);
  int get length => 2;
  set length(int value) {}
  int operator [](int index) {
    print(target);
    if (index == 0) throw 'stop';
    return 9;
  }
  void operator []=(int index, int? value) {}
}
void main() {
  var start = <int?>[1, 2, 3], middle = <int?>[1, 2, 3], empty = <int>[];
  start.insertAll(0, start);
  empty.insertAll(0, empty);
  try { middle.insertAll(1, middle); } catch (error) { print(error.runtimeType); }
  print([start, middle, empty]);
  var target = <int?>[1, 2];
  try { target.insertAll(1, Input(target)); } catch (error) { print(error); }
  print(target);
  target.insertAll(1, {7, 8});
  print(target);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'RangeError\n[[1, 2, 3, 1, 2, 3], [1, 2, 3, null, 2, 3], []]\n[1, 2, null, 2]\n[1, 2, 9, 2]\nstop\n[1, 2, 9, 2]\n[1, 7, 8, 2, 9, 2]\n',
  });
});

test('symbols preserve SDK hashes, canonical identity, and private lookup scope', () => {
  const program = `import 'dart:collection';
class Handler {
  Object? noSuchMethod(Invocation call) {
    print([call.memberName, call.memberName == #_foo, call.memberName == const Symbol('_foo')]);
    return null;
  }
}
void main() {
  var public = #foo, private = #_foo;
  print([identical(public, #foo), identical(public, const Symbol('foo')),
      identical(private, #_foo), private == const Symbol('_foo'), #C._foo == const Symbol('C._foo')]);
  print([public.hashCode, (#bar).hashCode, Symbol('').hashCode]);
  print(HashSet.of([#a, #b, #c, #d, #e]));
  dynamic receiver = Handler();
  receiver._foo();
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[true, true, true, false, true]\n[195624481, 67840445, 664597]\n{Symbol("e"), Symbol("d"), Symbol("a"), Symbol("c"), Symbol("b")}\n[Symbol("_foo"), true, false]\n',
  });
});

test('object and list patterns share the same length getter projection', () => {
  const program = `import 'dart:collection';
class Input extends ListBase<int> {
  int calls = 0;
  int get length { print('length'); return ++calls; }
  set length(int value) {}
  int operator [](int index) { print('read'); return 1; }
  void operator []=(int index, int value) {}
}
void main() {
  print(switch (Input()) { List(length: 2) => 0, [1] => 1, _ => 2 });
  print(switch (Input()) { [2] => 0, List(length: 1) => 1, _ => 2 });
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'length\nread\n1\nlength\nread\n1\n',
  });
});

test('map patterns cache lookups and check presence only for nullable values', () => {
  const program = `import 'dart:collection';
  class Input<T> extends MapBase<String, T> {
    final T? value;
    final bool present;
    Input(this.value, this.present);
    T? operator [](Object? key) { print('get $key'); return value; }
    void operator []=(String key, T value) {}
    Iterable<String> get keys => ['a'];
    void clear() {}
    T? remove(Object? key) => null;
    bool containsKey(Object? key) { print('contains $key'); return present; }
  }
  void match<T>(Map<String, T> input) {
    print(switch (input) { {'a': 2} => 'two', {'a': var value} => value, _ => 'absent' });
  }
  void main() {
    match(Input<int>(1, true));
    match(Input<int>(null, false));
    match(Input<int?>(null, true));
    match(Input<int?>(null, false));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'get a\n1\nget a\nabsent\nget a\ncontains a\nnull\nget a\ncontains a\nabsent\n',
  });
});

test('map patterns reject repeated constant identities, including aliases and records', () => {
  for (const [first, second] of [
    ["'id'", "'id'"],
    ['id', "'i' + 'd'"],
    ['(id,)', "('id',)"],
  ]) {
    const invalid = `const id = 'id';
    void main() {
      final map = <Object, int>{};
      if (map case {${first}: var first, ${second}: var second}) print([first, second]);
    }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `import 'dart:collection';
  class Keys extends MapBase<num, int> {
    Iterable<num> get keys => [0];
    void clear() {}
    int? remove(Object? key) => null;
    void operator []=(num key, int value) {}
    int? operator [](Object? key) {
      print(key);
      return key is int ? 1 : (key as double).isNegative ? 3 : 2;
    }
  }
  void main() {
    if (Keys() case {0: var a, 0.0: var b, -0.0: var c}) print([a, b, c]);
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '0\n0.0\n-0.0\n[1, 2, 3]\n' });
});

test('destructuring assignments enforce late final initialization when committing writes', () => {
  for (const assignment of ['(value,) = (2,)', '[value] = [2]']) {
    const program = `void main() {
      late final int value;
      void initialize() { value = 1; }
      initialize();
      try { ${assignment}; } catch (error) { print(error); }
      print(value);
    }`;
    expect(executeProgram('dart', program)).toMatchObject({
      kind: 'executed',
      stdout: "LateInitializationError: Local 'value' has already been initialized.\n1\n",
    });
  }
});

test('list copies skip empty efficient iterators and verify reported nonempty lengths', () => {
  const program = `import 'dart:collection';
class Input extends ListBase<int> {
  final int count;
  final int items;
  Input(this.count, [this.items = 1]);
  int get length { print('length'); return count; }
  Iterator<int> get iterator { print('iterator'); return List<int>.filled(items, 1).iterator; }
  set length(int value) {}
  int operator [](int index) => 1;
  void operator []=(int index, int value) {}
}
class Slice extends ListBase<int> {
  int calls = 0;
  int get length {
    print(++calls);
    if (calls == 5) throw 'extra';
    return 1;
  }
  set length(int value) {}
  int operator [](int index) => 1;
  void operator []=(int index, int value) {}
}
void main() {
  print(List<int>.of(Input(0)));
  print(List<int>.from(Input(0), growable: false));
  print(List<int>.unmodifiable(Input(0)));
  try { print(List<int>.of(Input(2))); } catch (error) { print(error.runtimeType); }
  try { print(List<int>.of(Input(1, 2))); } catch (error) { print(error); }
  print(switch (Slice()) { [...var a, 2] => 0, [...var b, 1] => 1, _ => 2 });
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'length\n[]\nlength\n[]\nlength\n[]\nlength\niterator\nConcurrentModificationError\nlength\niterator\nRangeError (index): Invalid value: Only valid value is 0: 1\n1\n2\n3\n4\n1\n',
  });
});

test('list concatenation and slicing stay within the allocation budget', () => {
  for (const body of [
    'final a = List<int>.filled(400000, 1); final b = List<int>.filled(400000, 2); print((a + b).length);',
    'final a = List<int>.filled(600000, 1); print(a.sublist(0).length);',
  ]) {
    expect(executeProgram('dart', `void main() { ${body} }`)).toMatchObject({
      kind: 'limitExceeded',
      limit: 'storage',
    });
  }
  const program = `import 'dart:collection';
  class Input extends ListBase<int> {
    final int count;
    Input(this.count);
    int get length {
      print('length');
      if (count < 0) throw StateError('length read');
      return count;
    }
    set length(int value) {}
    int operator [](int index) => 4;
    void operator []=(int index, int value) {}
    Iterator<int> get iterator { print('iterator'); return [4].iterator; }
  }
  void main() {
    print([1, 2] + [3]);
    print([1, 2] + Input(1));
    print([1, 2] + Input(0));
    try { print([1, 2] + Input(-1)); } catch (error) { print(error); }
    print([1, 2, 3].sublist(1, 2));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2, 3]\nlength\niterator\n[1, 2, 4]\nlength\n[1, 2]\nlength\nBad state: length read\n[2]\n',
  });
});

test('lastOrNull consumes one lazy cursor and retains the efficient-list shortcut', () => {
  const program = `import 'dart:collection';
  Iterable<int?> lazy(bool empty) sync* {
    print('start');
    if (empty) return;
    yield 1;
    print('next');
    yield null;
  }
  class Input extends ListBase<int> {
    int get length { print('length'); return 1; }
    set length(int value) {}
    int operator [](int index) => 8;
    void operator []=(int index, int value) {}
    int get last { print('last'); return 8; }
    Iterator<int> get iterator => throw StateError('unused');
  }
  void main() {
    print(lazy(false).lastOrNull);
    print(lazy(true).lastOrNull);
    print(Input().lastOrNull);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'start\nnext\nnull\nstart\nnull\nlength\nlast\n8\n',
  });
});

test('elementAtOrNull uses indexed access when its iterable has efficient length', () => {
  const program = `Iterable<int> lazy() sync* {
    print('first'); yield 1;
    print('second'); yield 2;
    print('third'); yield 3;
  }
  void main() {
    final mapped = [1, 2].map((n) { print('map $n'); return n; });
    print(mapped.elementAtOrNull(1));
    print(mapped.elementAtOrNull(5));
    print(lazy().elementAtOrNull(1));
    try { print(mapped.elementAtOrNull(-1)); } catch (error) { print(error.runtimeType); }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'map 2\n2\nnull\nfirst\nsecond\n2\nRangeError\n',
  });
});

test('indexed views preserve source lookups, offsets, and cursor state', () => {
  const program = `Iterable<int> lazy() sync* {
    print('start'); yield 1;
    print('next'); yield 2;
  }
  void main() {
    final view = [1, 2, 3].map((n) { print('map $n'); return n; }).indexed;
    print(view.length);
    print(view.elementAt(1));
    print(view.skip(1).take(1).toList());
    print(view.contains((2, 3)));
    print(view.contains((7, 7)));
    print(view.last);
    print(lazy().indexed.skip(1).first);
    final iterator = [9].indexed.iterator;
    try { print(iterator.current); } catch (error) { print(error); }
    print(iterator.moveNext());
    print(iterator.current);
    print(iterator.moveNext());
    print(iterator.moveNext());
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '3\nmap 2\n(1, 2)\nmap 2\n[(1, 2)]\nmap 3\ntrue\nfalse\nmap 3\n(2, 3)\nstart\nnext\n(1, 2)\nBad state: No element\ntrue\n(0, 9)\nfalse\nfalse\n',
  });
});

test('cast iterables delegate queries and cast only the values they return', () => {
  const program = `void main() {
    final source = <Object>['x', 1].map((value) => value);
    final view = source.cast<int>();
    print(view.length);
    print(view.contains('x'));
    print(view.last);
    print(view.elementAt(1));
    print(view.skip(1).first);
    print(view.take(1).contains('x'));
    print(view.lastWhere((value) => value == 1));
    print(view);
    print(view.cast<Object>().first);
    try { print(view.first); } catch (error) { print(error.runtimeType); }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '2\ntrue\n1\n1\n1\ntrue\n1\n(x, 1)\nx\n_TypeError\n',
  });
});

test('followedBy forwards endpoint and indexed queries to the appropriate source', () => {
  const program = `Iterable<int> lazy(String name, int value) sync* { print(name); yield value; }
  void main() {
    print(lazy('left', 1).followedBy(lazy('right', 2)).last);
    print(lazy('left', 1).followedBy(lazy('right', 2)).first);
    final mapped = [1, 2].map((n) { print('map $n'); return n; });
    final both = mapped.followedBy([3]);
    print(both.length);
    print(both.elementAt(1));
    print(both.elementAt(2));
    print(both.last);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'right\n2\nleft\n1\n3\nmap 2\n2\n3\n3\n',
  });
});

test('ListBase insertAll shifts before evaluating efficient mapped sets and map values', () => {
  const program = `import 'dart:collection';
  class Target extends ListBase<int?> {
    final values = <int?>[1, 2, 3];
    int get length => values.length;
    set length(int count) => values.length = count;
    int? operator [](int position) => values[position];
    void operator []=(int position, int? value) { values[position] = value; }
  }
  void main() {
    final setTarget = Target();
    setTarget.insertAll(1, {4, 5}.map((n) { print(setTarget); return n; }));
    print(setTarget);
    final mapTarget = Target();
    try {
      mapTarget.insertAll(1, {1: 6, 2: 7}.values.map((n) {
        print(mapTarget);
        if (n == 7) throw 'stop';
        return n;
      }));
    } catch (error) { print(error); }
    print(mapTarget);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[1, 2, 3, 2, 3]\n[1, 4, 3, 2, 3]\n[1, 4, 5, 2, 3]\n[1, 2, 3, 2, 3]\n[1, 6, 3, 2, 3]\nstop\n[1, 6, 3, 2, 3]\n',
  });
});

test('IterableMixin and IterableBase share Iterable type identity and method behavior', () => {
  const program = `import 'dart:collection';
  class Cursor implements Iterator<int> {
    int index = -1;
    bool moveNext() => ++index < 2;
    int get current { print('current $index'); return index; }
  }
  class Mixed with IterableMixin<int> {
    Iterator<int> get iterator => Cursor();
  }
  class Extended extends IterableBase<int> {
    Iterator<int> get iterator => Cursor();
  }
  void main() {
    print([IterableMixin == Iterable, IterableBase == Iterable]);
    print(Mixed().elementAt(1));
    print(Extended().elementAt(1));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[true, true]\ncurrent 1\n1\ncurrent 1\n1\n',
  });
});

test('native concatenation keeps the copied prefix alive during the right length callback', () => {
  const program = `import 'dart:collection';
  late List<Turtle> original;
  class Source extends ListBase<Turtle> {
    final added = Turtle(2, 2);
    int get length {
      original.clear();
      Turtle(3, 3).canMoveForward();
      return 1;
    }
    set length(int count) {}
    Turtle operator [](int position) => added;
    void operator []=(int position, Turtle value) {}
    Iterator<Turtle> get iterator => [added].iterator;
  }
  void main() {
    original = [Turtle(1, 1)];
    final result = original + Source();
    result.first.forward();
  }`;
  const finalTurtles = [
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ];
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', finalTurtles });
  expect(traceProgram('dart', program, program)).toMatchObject({ finalTurtles });
});

test('BigInt modPow meters wide multiplies and preserves small powers', () => {
  const valid = `void main() {
    print(BigInt.from(-2).modPow(BigInt.from(7), BigInt.from(101)));
    print(BigInt.two.modPow(BigInt.from(10), BigInt.from(1000)));
    print(BigInt.zero.modPow(BigInt.zero, BigInt.two));
    print(BigInt.two.modPow(BigInt.zero, BigInt.one));
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '74\n24\n1\n0\n' });
  const wide = `void main() {
    final modulus = (BigInt.one << 1000000) - BigInt.from(3);
    final base = (BigInt.one << 999999) + BigInt.from(123);
    final exponent = (BigInt.one << 128) - BigInt.one;
    print(base.modPow(exponent, modulus));
  }`;
  expect(executeProgram('dart', wide)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('dynamic native calls and tear-offs validate named arguments before dispatch', () => {
  const program = `void main() {
    dynamic text = 'abc';
    dynamic call = text.splitMapJoin;
    try { print(text.splitMapJoin('z', onMatch: 1)); } catch (error) { print(error.runtimeType); }
    try { print(text.splitMapJoin('z', onNonMatch: 1)); } catch (error) { print(error.runtimeType); }
    try { print(call('z', onMatch: 1)); } catch (error) { print(error.runtimeType); }
    print(call('z', onNonMatch: null));
    print(text.splitMapJoin('b', onMatch: (Match m) => 'X'));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\n_TypeError\n_TypeError\nabc\naXc\n',
  });
});

test('errors retain their first throw trace and catches receive the trace of the current throw', () => {
  const program = `void main() {
    final error = StateError('ordinary');
    print(error.stackTrace == null);
    late StackTrace first;
    try {
      try { throw error; }
      catch (caught, trace) {
        first = trace;
        print(identical(error.stackTrace, trace));
        rethrow;
      }
    } catch (_, trace) { print(identical(first, trace)); }
    try { Error.throwWithStackTrace(error, StackTrace.empty); }
    catch (_, trace) {
      print([identical(error.stackTrace, first), identical(trace, StackTrace.empty)]);
    }
    final explicit = StateError('explicit');
    try { Error.throwWithStackTrace(explicit, StackTrace.empty); }
    catch (_, trace) { print([identical(explicit.stackTrace, trace), identical(trace, StackTrace.empty)]); }
    try { List<int>.empty()[0]; }
    catch (error, trace) { if (error is Error) print(identical(error.stackTrace, trace)); }
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\ntrue\n[true, true]\n[true, true]\ntrue\n',
  });
});

test('an exception in flight keeps a custom trace reachable through rethrow', () => {
  const program = `class CustomTrace implements StackTrace {
    final Turtle turtle;
    CustomTrace(this.turtle);
    String toString() => 'custom';
  }
  void fail() { Error.throwWithStackTrace(StateError('test'), CustomTrace(Turtle(1, 1))); }
  void main() {
    late Turtle restored;
    try {
      try { fail(); }
      catch (_) { Turtle(3, 3).canMoveForward(); rethrow; }
    } catch (_, trace) {
      restored = (trace as CustomTrace).turtle;
      restored.forward();
    }
  }`;
  const finalTurtles = [{ x: 1, y: 2 }];
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', finalTurtles });
  expect(traceProgram('dart', program, program)).toMatchObject({ finalTurtles });
});

test('constant string construction keeps folding and evaluation within string limits', () => {
  for (const join of [(name: string) => `${name} + ${name}`, (name: string) => `'$${name}$${name}'`]) {
    const larger = Array.from({ length: 24 }, (_, index) => `const s${index + 1} = ${join(`s${index}`)};`);
    const prefix = `const s0 = 'x';\n${larger.slice(0, 19).join('\n')}`;
    const valid = `${prefix} void main() { print(s19.length); }`;
    expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '524288\n' });
    expect(executeProgram('dart', `${prefix}\n${larger.slice(19).join('\n')} void main() {}`)).toMatchObject({
      kind: 'compileError',
    });
    const local = `${prefix} void main() { const result = ${join('s19')}; print(result.length); }`;
    expect(executeProgram('dart', local)).toMatchObject({ kind: 'compileError' });
    const runtime = `${prefix} void main() {
      try { print(${join('s19')}); } catch (error) { print(error.runtimeType); }
    }`;
    expect(executeProgram('dart', runtime)).toMatchObject({ kind: 'executed', stdout: 'OutOfMemoryError\n' });
  }
});

test('constant collections canonicalize repeated strings without conflating distinct values', () => {
  const repeated = 's8,'.repeat(1024);
  const declarations = Array.from({ length: 8 }, (_, index) => `const s${index + 1} = s${index} + s${index};`);
  const program = `const s0 = 'abc';
  ${declarations.join('\n')}
  const list = [${repeated}];
  const same = [${repeated}];
  const different = ['other', ${'s8,'.repeat(1023)}];
  const pair = (s8, label: s8);
  const map = {s8: pair};
  void main() { print([identical(list, same), identical(list, different), identical(map, const {s8: (s8, label: s8)})]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[true, false, true]\n' });
});

test('growable list bulk writes check the live source length before reading elements', () => {
  const program = `import 'dart:collection';
class Input extends ListBase<int> {
  int remainingReads;
  Input(this.remainingReads);
  int get length => remainingReads-- > 0 ? 2 : 1;
  set length(int value) {}
  int operator [](int index) { print('read'); return 9; }
  void operator []=(int index, int value) {}
}
void main() {
  var inserted = <int?>[1, 2, 3], overwritten = <int?>[1, 2, 3];
  try { inserted.insertAll(1, Input(2)); } catch (error) { print(error.runtimeType); }
  try { overwritten.setAll(1, Input(1)); } catch (error) { print(error.runtimeType); }
  print([inserted, overwritten]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'StateError\nStateError\n[[1, 2, 3, 2, 3], [1, 2, 3]]\n',
  });
});
