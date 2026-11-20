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
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\n[1, 1, 0]\n1\n2\n[1, 1, 0]\n',
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
  List<num> values = <int>[1, 2];
  try { values.first = 1.5; } catch (e) { print(e.runtimeType); }
  try { values.addAll(values.where((x) => x > 0)); } catch (e) { print(e.runtimeType); }
  print(values);
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
    stdout: '_TypeError\n_TypeError\nConcurrentModificationError\n[1, 2, 1]\n{1: 2}\n_TypeError\n{1: 2, 2: 4}\n',
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
