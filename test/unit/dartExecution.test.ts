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
  const program = `void main() {
  var codes = [65, 66];
  print(String.fromCharCodes(codes, 0, 5));
  print(String.fromCharCodes(codes, 5));
  print(String.fromCharCodes(codes.map((code) { print(code); return code; }), 0, 1));
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'AB\n\n65\nA\n' });
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
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'null\n-1\n237745\n' });
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
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1\n1\n-1\n1\n' });
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

test('dart:math Point allows subclasses and implementations', () => {
  const program = `import 'dart:math';
class Location extends Point<int> { Location() : super(1, 2); }
abstract class Coordinates implements Point<int> {}
void main() { print(Location()); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Point(1, 2)\n' });
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
  print(base64.encode(view));
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
      'QUJD',
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
}
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Out of Memory\n3323908\n' });
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
extension ListType<T> on List<T> {
  Type get item => T;
  Type read() => T;
}
extension Indices on int {
  int operator [](int index) => this + index;
  void operator []=(int index, int value) { print([index, value]); }
}`;
  expect(executeProgram('dart', `${declarations} void main() { print(1.label); }`)).toMatchObject({
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
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[a, b, specific]\nB:direct\nA:a!\n[2, 9]\n[1, 6]\n(int, int)\n',
  });
});

test('labeled exits join the flow of their own target', () => {
  const missing = `int value() {
  outer: while (true) { while (true) { break outer; } }
}
void main() { print(value()); }`;
  expect(executeProgram('dart', missing)).toMatchObject({ kind: 'compileError' });
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
void main() { print(value()); print(items().first); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '7\n8\n' });
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
void main() { inspect(2); name(null); name('dart'); print([length([]), length([42]), length(null)]); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '3\n[3]\nmissing\nDART\n[0, 1, -1]\n',
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
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type '(int, String)' is not a subtype of type '(int, int)'\ntype 'List<Object>' is not a subtype of type 'List<int>'\n[0, 0]\n[2, 3]\n",
  });
});

test('Object.hash accepts twenty arguments and hashes the supplied values in order', () => {
  const program = `void main() {
  print(Object.hash(1, 2) == Object.hashAll([1, 2]));
  print(Object.hash(1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20) ==
        Object.hashAll([1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\n' });
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
  print([identical(local, sdk), local is List<String>, sdk is List<core.String>]);
  const a = String;
  const b = core.String;
  print([a == b, <Type>{a, b}.length, identical(b, 'sdk'.runtimeType)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[false, true, true]\n[false, 2, true]\n',
  });
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
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'first caught\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\nOut of Memory\n',
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
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[3, 1, 2]\n[1, 3, 2]\n[1, 3, 3]\n[1, 2, 3]\n1\nConcurrentModificationError\n{1: 11, 2: 20, 3: 30}\nUnsupported operation: Cannot modify unmodifiable map\nUnsupported operation: Cannot modify an unmodifiable list\n{1, 2, 3}\n{2, 3}\n{2, 3}\ntrue\n',
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
  var matches = 'a'.allMatches('a' * 1000000);
  print([matches.first.start, matches.first.end]);
  print(''.allMatches('xy').map((match) => match.start).toList());
  print('aa'.replaceFirst(_RegExp(), 'b'));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'a\n[bc, , x]\n[0, 1]\n[0, 1, 2]\nba\n',
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
  print([double.tryParse('9' * 120000 + 'x'), num.tryParse('x' + ' ' * 120000 + 'x')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1.5\n2.5\n42\n[null, null]\n' });
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
