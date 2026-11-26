import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// Dart SDK 3.13.7 (`dart run`) prints the expected output: the VM's hash codes and the bucket order of HashMap and
// HashSet, the default map's insertion order, Random's sequence for a seed, shuffle, and the order sort leaves equal
// elements in.
test('SDK runtime types use the implementation class IDs for hashing and equality', () => {
  const program = `import 'dart:collection';
import 'dart:convert';
void main() {
  final values = <Object>[
    <int>{}, <int, int>{}, const <int>{1}, const <int, int>{1: 2},
    HashMap<int, int>(), HashSet<int>(), HashMap<int, int>.identity(), HashSet<int>.identity(),
    utf8.encode('dart'), RegExp('a').allMatches('abc'), 'a'.allMatches('abc'),
    RegExp('a').allMatches('a').iterator, ListQueue<int>().iterator, const Symbol('foo'),
    {1: 2}.entries.iterator, [1], const [1],
  ];
  print(values.map((value) => value.runtimeType.hashCode).toList());
  final setIterator = {1}.iterator.runtimeType;
  final mapIterator = {1: 2}.keys.iterator.runtimeType;
  print([setIterator, mapIterator, setIterator.hashCode, setIterator == mapIterator,
    identical(setIterator, mapIterator), HashSet<Type>.of([setIterator, mapIterator]).length]);
  final entries = {1: 2}.entries.iterator;
  print([entries.runtimeType, entries.moveNext(), entries.current.value]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[424476787, 265172708, 148984701, 818322171, 459265929, 825108430, 893455867, 129618337, ' +
      '774657860, 318142069, 629774339, 54613558, 713928503, 591490724, 681192328, 77465998, 77465998]\n' +
      '[_CompactIterator<int>, _CompactIterator<int>, 254673379, true, true, 1]\n' +
      '[_CompactEntriesIterator<int, int>, true, 2]\n',
  });
});

test('public SDK types share Dart VM hashes across libraries', () => {
  const program = `import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
class Holder<T> {}
void main() {
  final types = <Type>[
    Point<int>, ListQueue<int>, HashMap<int, int>, SplayTreeSet<int>, List<Point<int>>,
    JsonCodec, Utf8Codec, Stdout, Holder<Point<int>>, LinkedHashMap<int, int>,
  ];
  print(types.map((type) => type.hashCode).toList());
  print(HashSet<Type>.of(types));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[195568320, 56450997, 259497269, 137660767, 385687430, 955317462, 153614933, 47563481, 228988073, 346085082]\n' +
      '{Point<int>, ListQueue<int>, HashMap<int, int>, Utf8Codec, List<Point<int>>, JsonCodec, Holder<Point<int>>, Stdout, LinkedHashMap<int, int>, SplayTreeSet<int>}\n',
  });
});

test('learner class IDs determine Dart type hashes and hash-set order', () => {
  const program = `import 'dart:collection';
class Cat {}
class Dog {}
class Box<T> {}
void main() {
  final types = <Type>[Cat, Dog, Box<int>, List<Cat>, List<Dog>, List<Box<int>>];
  print(types.map((type) => type.hashCode).toList());
  print(HashSet<Type>.of(types));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[112432739, 338475303, 316355173, 161123295, 226588083, 914555672]\n' +
      '{List<Box<int>>, List<Dog>, Cat, Box<int>, List<Cat>, Dog}\n',
  });
  const withEarlierClass = program.replace('class Cat', 'class Extra {}\nclass Cat');
  expect(executeProgram('dart', withEarlierClass)).toMatchObject({
    kind: 'executed',
    stdout:
      '[338475303, 1029180056, 832762096, 226588083, 188099438, 1070093471]\n' +
      '{Box<int>, Dog, List<Cat>, List<Dog>, List<Box<int>>, Cat}\n',
  });
  const classHeaders = `class WithBound<T extends List<B>> {}
class Combined extends Root with M, N {}
class Independent {}
class Root {}
class B {}
mixin M {}
mixin N {}
class Reused extends Root with M {}
class Named = Root with N;
void main() {
  final types = <Type>[WithBound, Combined, Independent, Root, B, M, N, Reused, Named];
  print(types.map((type) => type.hashCode).toList());
}`;
  expect(executeProgram('dart', classHeaders)).toMatchObject({
    kind: 'executed',
    stdout: '[391944146, 1029180056, 20088519, 481707390, 338475303, 40931333, 210019128, 823985842, 404436695]\n',
  });
});

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

test('record hashes combine the Dart VM shape and each field hash', () => {
  const program = `class Zero { int get hashCode => 0; }
(int, {int declared})? unusedType;
void unusedFunction() { print((cold: Zero())); }
void main() {
  final zero = Zero();
  print([(zero,).hashCode, (zero, zero).hashCode]);
  Object unmatched = 0;
  if (unmatched case (pattern: _)) print('matched');
  print([(a: zero).hashCode, (b: zero).hashCode, (zero, a: zero).hashCode]);
  print([(a: zero, b: zero).hashCode, (b: zero, a: zero).hashCode]);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[307143837, 30638438]\n[113439216, 242120719, 325956720]\n[369347531, 369347531]\n',
  });
});

test('repeatedly hashing a long string key completes within the execution budget', () => {
  const program = `void main() {
    final key = 'x' * 900000;
    final keys = {key};
    final hash = key.hashCode;
    for (var i = 0; i < 2000; i++) {
      if (key.hashCode != hash || !keys.contains(key)) throw StateError('key changed');
    }
    print('done');
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'done\n',
  });
});

test('core type hashes preserve the Dart VM hash-set order', () => {
  const program = `import 'dart:collection';
typedef MaybeInt = int?;
void main() {
  final values = <Type>[int, num, String, bool, double, List<int>, MaybeInt, List<MaybeInt>, Map<String, int>];
  print(values.map((type) => type.hashCode).toList());
  print(HashSet<Type>.of(values.take(6)));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[1054059335, 924199842, 1028333344, 424929926, 740950697, 77465998, 409100164, 818850322, 371945621]\n' +
      '{String, double, num, List<int>, bool, int}\n',
  });
});

test('record and function types retain their VM hashes inside generic types', () => {
  const program = `typedef F = void Function();
typedef G = T Function<T extends num>(T);
typedef Plain = T Function<T>(T);
typedef Recursive = T Function<T extends Comparable<T>>(T);
typedef Named = String Function({required int value, bool? other});
typedef R = (int, String);
typedef NamedRecord = (int, {bool ok, G callback});
typedef Nested = T Function<T>(T Function<U>(U));
void main() {
  final types = <Type>[F, List<F>, G, List<G>, Plain, Recursive, Named, R, List<R>,
    NamedRecord, List<NamedRecord>, Nested];
  print(types.map((t) => t.hashCode).toList());
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[826101587, 351417490, 803463964, 790716176, 825237186, 1041639999, 372663102, ' +
      '948253231, 843832041, 1037485068, 498479561, 832321584]\n',
  });
});

test('String.fromCharCodes batches large conversions and preserves supplementary code points', () => {
  expect(
    executeProgram(
      'dart',
      `void main() {
        final codes = List<int>.filled(900000, 65);
        print(String.fromCharCodes(codes).length);
        print(codes.length);
      }`
    )
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout: '900000\n900000\n' });
  expect(
    executeProgram(
      'dart',
      `Iterable<int> codes() sync* {
        for (var i = 0; i < 65536; i++) yield i == 127 || i == 128 ? 0x1f600 : 65;
      }
      void main() {
        final text = String.fromCharCodes(codes());
        print([text.length, text.substring(126, 132)]);
      }`
    )
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout: '[65538, A😀😀A]\n' });
});

test('generic throw operands must exclude null or be dynamic', () => {
  for (const source of [
    'Never fail<T>(T x) => throw x; void main() {}',
    'Never fail<T extends num?>(T x) => throw x; void main() {}',
    'void fail<T>(T x) { if (x is num?) throw x; } void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `void promoted<T>(T x) { if (x != null) throw x; }
Never bounded<T extends Object>(T x) => throw x;
Never lateBound(dynamic x) => throw x;
void main() {
  try { promoted(1); } catch (value) { print(value); }
  try { bounded(2); } catch (value) { print(value); }
  try { lateBound(3); } catch (value) { print(value); }
}`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '1\n2\n3\n' });
});

test('member use and operators check the nullability of generic receivers', () => {
  for (const source of [
    'void f<T extends int?>(T x) { print(x.isEven); }',
    'void f<T extends int?>(T x) { print(x.abs()); }',
    'void f<T extends List<int>?>(T x) { x[0] = 1; }',
    'class C { int a = 1; } void f<T extends C?>(T x) { x.a = 2; }',
    'void f<T extends int?>(T x) { print(x + 1); }',
    'void f<T extends int>(T? x) { print(x + 1); }',
    'void f<T extends int>(T? x) { print(-x); }',
  ]) {
    expect(executeProgram('dart', `${source} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `class Box {}
extension NullBox on Box? { int operator +(int x) => x + 2; }
extension NullInt on int? { bool get sign => this == null; }
extension Generic<T> on T { bool get missing => this == null; }
void read<T extends int?>(T x) {
  print([x?.isEven, x.sign, x.runtimeType]);
  if (x != null) print(x + 1);
}
void offset<T extends Box?>(T x) { print(x + 1); }
void missing<T>(T x) { print(x.missing); }
void main() { read<int?>(null); read(2); offset<Box?>(null); missing<int?>(null); }`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[null, true, Null]\n[true, false, int]\n3\n3\ntrue\n',
  });
});

test('equality flow promotes only the value the comparison tested', () => {
  for (const source of [
    'void main() { int? x = 1; if (x != (x = null)) print(x.isEven); }',
    "void main() { String? x = 'a'; if (x != (x = null)) print(x.length); }",
    `class Box { final int? _x; Box(this._x); }
     void main() {
       Box b = Box(2);
       if (b._x != ((b = Box(null))._x as Null)) print(b._x.isEven);
     }`,
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `void main() {
    int? x = 2;
    if (x != (false ? (x = null) : null)) print(x.isEven);
    int? y = 3;
    if ((x = null) != y) print(y.isOdd);
    if (y != null) print(y.isOdd);
  }`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'true\ntrue\ntrue\n',
  });
});

test('special type annotations reject written type arguments', () => {
  for (const source of [
    'void main() { dynamic<int> x = 1; print(x); }',
    'void main() { Null<int> x = null; print(x); }',
    'Never<int> fail() => throw 1; void main() { print(1); }',
  ]) {
    const result = executeProgram('dart', source);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain('型引数は 0 個');
  }
});

test('constant identical calls use the constness of the compiled arguments', () => {
  const program = `const a = 1;
const alias = identical(a, a);
const sum = identical(1 + 1, 2);
const interpolated = identical('$a', '1');
const list = identical([a], [1]);
const nested = identical(identical(a, 1), true);
void main() { print([alias, sum, interpolated, list, nested]); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[true, true, true, true, true]\n',
  });
  for (const source of [
    "var x = 1; const answer = identical('$x', '1'); void main() {}",
    'int value() => 1; const answer = identical(value(), 1); void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
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

test('generic main uses type bounds and zero-argument VM dispatch', () => {
  const bounded = 'void main<T extends num>() { print(T); }';
  expect(executeProgram('dart', bounded)).toMatchObject({ kind: 'executed', stdout: 'num\n' });
  const optional = "void main<T>([List<String> args = const ['default']]) { print([T, args]); }";
  expect(traceProgram('dart', optional, optional).stdout).toBe('[dynamic, [default]]\n');
  const required = 'void main<T>(List<String> args) { print(args); }';
  expect(executeProgram('dart', required)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('Tried calling: main()'),
  });
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

test('Dart constructor declarations treat new as the unnamed constructor', () => {
  const program = `class Base {
  final int value;
  const Base.new(this.value);
  const Base.other(int value) : this.new(value);
}
class Child extends Base {
  Child(int value) : super.new(value);
}
abstract class Value {
  factory Value.new(int value) = NumberValue.new;
  int get value;
}
class NumberValue implements Value {
  final int value;
  NumberValue.new(this.value);
}
extension type Gauge.new(int value) {}
enum Status {
  ready.new(1), idle(0);
  const Status.new(this.value);
  final int value;
}
void main() {
  final create = Base.new;
  print([const Base(1).value, const Base.new(2).value, Base.other(3).value,
    Child(4).value, create(5).value, Value(6).value, Gauge(7).value, Status.ready.value]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 3, 4, 5, 6, 7, 1]\n' });
  const duplicate = 'class C { C(); C.new(); } void main() {}';
  expect(executeProgram('dart', duplicate)).toMatchObject({ kind: 'compileError' });
});

test('named Dart constructors share the static member namespace', () => {
  const program = `class Person {
  final String name;
  final int age;
  Person.name(this.name) : age = 0;
}
class WithGetter {
  int get name => 1;
  WithGetter.name();
}
class WithMethod {
  int read() => 2;
  WithMethod.read();
}
class WithFactory {
  final int value = 3;
  WithFactory();
  factory WithFactory.value() => WithFactory();
}
void main() {
  print([Person.name('Dart').name, WithGetter.name().name, WithMethod.read().read(), WithFactory.value().value]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[Dart, 1, 2, 3]\n',
  });
  for (const member of ['static int name = 1;', 'static set name(int value) {}']) {
    const invalid = `class C { ${member} C.name(); } void main() {}`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart member names cannot reuse enclosing names or type parameters', () => {
  for (const declaration of [
    'class C { int C = 1; }',
    'class C<T> { static int T() => 1; }',
    'class C<T> { C.T(); }',
    'class C<T>(var int T) {}',
    'extension E on String { int get E => 1; }',
    'extension E<T> on List<T> { int get T => 1; }',
    'extension type E<T>(T T) {}',
    'enum E { E }',
  ]) {
    expect(executeProgram('dart', `${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = 'class C { C.C(); } void main() { print(C.C().runtimeType); }';
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: 'C\n' });
});

test('wildcard Dart type parameters keep arity without binding a name', () => {
  const program = `class Field<_, _> { int _ = 1; }
class Constructor<_> { Constructor._(); }
extension Getter<_> on String { int get _ => 2; }
class _ { String get label => 'binding'; }
class Typed<_> {
  _? value;
  String read() => value?.label ?? 'empty';
}
void main() {
  print(Field<int, int>()._);
  print(Constructor<int>._().runtimeType);
  print('x'._);
  print(Typed<String>().read());
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '1\nConstructor<int>\n2\nempty\n',
  });
});

test('own Dart members shadow type names only in their declaration scope', () => {
  for (const declarations of [
    'class C { String? value; int String = 1; }',
    'class C { void List() {} void f() { List<int> values = []; } }',
    'class C { void set String(int value) {} String? value; }',
    'class C { int String = 1; static String? value; }',
    'class C { int String = 1; C.named(String value); }',
    'extension E on String { String? read() => null; int get String => 1; }',
    'extension type E(String String) {}',
    "import 'dart:core'; import 'dart:core' as types; class C { int types = 1; types.String? value; }",
  ]) {
    expect(executeProgram('dart', `${declarations} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `class Parent { int String = 1; }
class Child extends Parent { String? value; }
class Header<T extends String> extends Parent { int Parent = 1; int String = 2; }
class Generic {
  int String = 1;
  void write<String>(String value) { print(value); }
}
class Named { Named.String(); String? value; }
void main() {
  print([Child().value, Header().Parent, Named.String().value]);
  Generic().write(8);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[null, 1, null]\n8\n' });
});

test('local bindings shadow type names and library prefixes', () => {
  for (const program of [
    'void main() { var List = 1; List<int> values = []; }',
    'void main() { List<int> values = []; var List = 1; }',
    'void main() { int int = 1; }',
    'void f(int List) { List<int> values = []; } void main() {}',
    'void f<T>() { var T = 1; T? value; } void main() {}',
    "import 'dart:core' as c; void main() { var c = 1; c.List<int> values = []; }",
    'class C { C(); } void main() { var C = 1; print(new C()); }',
    'class C { const C(); } void main() { var C = 1; print(const C()); }',
    'class C<T> { C(); } void main() { var C = 1; print(C<int>.new); }',
    'class C<T> { C(); } void f<C>() { print(new C()); } void main() {}',
    'class C { C(); } class D { int C = 1; void f() { new C(); } } void main() {}',
    "import 'dart:math' as m; void main() { var m = 1; print(new m.Random(1).nextInt(10)); }",
    "import 'dart:math' as m; void main() { var m = 1; print(m.Random.new); }",
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `class Box { Box(List<int> values); }
typedef Numbers = List<int>;
void main() {
  var T = 1;
  void nested<T>(T value) { print(value); }
  nested('nested');
  var List = 2;
  print(Box([T, List]).runtimeType);
  Numbers numbers = [T, List];
  print(numbers);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: 'nested\nBox\n[1, 2]\n' });
  const constructors = `import 'dart:math' as m;
class Box<T> { const Box(); const Box.named(); }
typedef Value = Box<int>;
void main() {
  print([new Value(), const Box<String>.named(), Box<bool>.new(), new m.Random(1).nextInt(10)].map((x) => x.runtimeType).toList());
}`;
  expect(executeProgram('dart', constructors)).toMatchObject({
    kind: 'executed',
    stdout: '[Box<int>, Box<String>, Box<bool>, int]\n',
  });
});

test('dynamic collection contexts constrain generic constructor inference', () => {
  const program = `void main() {
  List<dynamic> cells = List.filled(3, null);
  cells[0] = 1;
  List raw = List.filled(2, null);
  raw[0] = 'raw';
  List<dynamic> generated = List.generate(2, (_) => null);
  generated[0] = true;
  Map<String, dynamic> mapped = Map.from({'key': null});
  mapped['key'] = 1;
  List<List<dynamic>> nested = List.filled(1, List.filled(2, null));
  nested[0][0] = 2;
  print([cells, raw, generated, mapped, nested]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[1, null, null], [raw, null], [true, null], {key: 1}, [[2, null]]]\n',
  });
});

test('dynamic iterable sources are cast before iterator lookup', () => {
  const program = `Iterable<dynamic> copy(dynamic source) sync* {
  for (final value in source) yield value;
}
void show(Object? Function() read) {
  try { print(read()); } catch (e) { print(e); }
}
void main() {
  dynamic source = 42;
  show(() { for (final value in source) print(value); return null; });
  show(() => copy(source).toList());
  show(() => [for (final value in source) value]);
  show(() => <int>[...source]);
  show(() => <int>{...source});
  show(() => <int>[...?source]);
  source = null;
  show(() => <int>[...?source]);
  source = ['text'];
  show(() => <int>[...source]);
  source = [7];
  show(() => <int>[...source]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type 'int' is not a subtype of type 'Iterable<dynamic>'\n".repeat(5) +
      "type 'int' is not a subtype of type 'Iterable<dynamic>?'\n" +
      "[]\ntype 'String' is not a subtype of type 'int'\n[7]\n",
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
  var maxInt = 9223372036854775807;
  var roundedMax = 9223372036854775808.0;
  print([maxInt == roundedMax, maxInt.hashCode == roundedMax.hashCode,
    {maxInt, roundedMax}.length, {maxInt: 'yes'}[roundedMax]]);
  print([7.oneBitCount, (-1).oneBitCount, 8.trailingZeroBitCount, 0.trailingZeroBitCount]);
  print([2.modPow(0, 1), 2.modPow(1, 1), a.gcd(0), 0.gcd(a), a.gcd(14)]);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '1\n1\n-1\n1\n[1, Infinity]\n[true, true, 1, yes]\n[true, true, 1, yes]\n[3, 64, 3, 64]\n[1, 0, -9223372036854775808, -9223372036854775808, 2]\n',
  });
});

test('detached string copies share the execution budget', () => {
  const measure = `void measure(int count) {
  final text = 'x' * 500000 + ' ';
  var length = 0;
  for (var index = 0; index < count; index++) {
    length += text.substring(1).length + text.trimRight().length;
  }
  print(length);
}`;
  expect(executeProgram('dart', `${measure} void main() => measure(1);`)).toMatchObject({
    kind: 'executed',
    stdout: '1000000\n',
  });
  expect(executeProgram('dart', `${measure} void main() => measure(18);`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test('bare this is a list and set element', () => {
  const program = `class Node {
  final String name;
  Node(this.name);
  List<Node> nodes(Node other) => <Node>[this, ...[other]];
  Set<Node> unique() => {this};
}
extension Singleton on int { List<int> asList() => [this]; }
void main() {
  final root = Node('root');
  print(root.nodes(Node('child')).map((node) => node.name).toList());
  print(root.unique().single.name);
  print(5.asList());
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[root, child]\nroot\n[5]\n' });
});

test('const constructor interpolations use the evaluated parameter values', () => {
  const program = `class C {
  final String text;
  const C(Object? value) : text = 'value: $value';
  const C.checked(int value) : assert(value > 0, 'value: \${value + 1}'), text = 'ok';
}
void main() {
  print(const C(42).text);
  print(const C(null).text);
  print(const C.checked(1).text);
  print(C(Object()).text);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: "value: 42\nvalue: null\nok\nvalue: Instance of 'Object'\n",
  });
  expect(executeProgram('dart', program.replace('C(Object())', 'const C(Object())'))).toMatchObject({
    kind: 'compileError',
  });
});

test('multiline strings handle opening whitespace and escaped line endings like Dart', () => {
  const slash = '\\';
  const program = `void main() {
  print(('''  ${slash}\nhello''').codeUnits);
  print(('''  ${slash} \nhello''').codeUnits);
  print(('''A${slash}\nB''').codeUnits);
  print(('''A${slash}\r\nB''').codeUnits);
  print(('''A\r\nB''').codeUnits);
  print((r'''A${slash}\r\nB''').codeUnits);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      '[104, 101, 108, 108, 111]',
      '[104, 101, 108, 108, 111]',
      '[65, 10, 66]',
      '[65, 13, 10, 66]',
      '[65, 10, 66]',
      '[65, 92, 10, 66]',
      '',
    ].join('\n'),
  });
});

test.each([
  ['interpolation', "'$text$i'"],
  ['concatenation', "text + 'x'"],
  ['padding', 'text.padRight(text.length + 1)'],
  ['a buffer snapshot', "(StringBuffer(text)..write('x')).toString()"],
])('%s charges for the text it produces', (_operation, expression) => {
  expect(
    executeProgram(
      'dart',
      `void main() {
  final text = 'x' * 500000;
  var total = 0;
  for (var i = 0; i < 34; i++) total += (${expression}).length;
  print(total);
}`
    )
  ).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  [
    'an expression-bodied recursive function',
    'int fib(int n) => n < 2 ? n : fib(n - 1) + fib(n - 2);\nvoid main() => print(fib(32));',
  ],
  ['a list generator', 'void main() => print(List<int>.generate(1100000, (i) => i).length);'],
  [
    'repeated fillRange',
    'void main() {\n  final a = List<int>.filled(1100, 0);\n  for (var i = 0; i < 1100; i++) a.fillRange(0, a.length, 1);\n}',
  ],
])('%s stops at the operation or time limit', (_work, source) => {
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'limitExceeded',
    limit: expect.stringMatching(/^(operations|time)$/),
  });
});

test.each([
  ['records', `(${Array.from({ length: 60 }, () => 'i').join(', ')})`],
  ['closures', `() => ${Array.from({ length: 60 }, (_, index) => `v${index}`).join(' + ')}`],
])('retained %s count their fields against the storage limit', (_values, element) => {
  const program = `void main() {
  ${Array.from({ length: 60 }, (_, index) => `var v${index} = ${index};`).join('\n  ')}
  final values = List.generate(17000, (i) => ${element});
  print(values.length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test('Dart Unicode regular expressions step over surrogate pairs as the VM does', () => {
  const program = `void main() {
  final text = 'a😀b';
  for (final pattern in [r'(?:)', r'.', r'(?<=.)']) {
    final re = RegExp(pattern, unicode: true);
    print(re.allMatches(text).map((m) => '\${m.start}-\${m.end}').toList());
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[0-0, 1-1, 3-3, 4-4]\n[0-1, 1-3, 3-4]\n[1-1, 3-3, 4-4]\n',
  });
});

test.each([
  ["@missing external int x, y;\nvoid main() { print('hello'); }", 0],
  ["class A { const A(int v); }\n@A('s') external final int x;\nvoid main() { print('hello'); }", 1],
])('Dart checks the metadata of external top-level variables: %s', (program, row) => {
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row })],
  });
});

test.each(['-big', '~big'])('Dart charges the digits of each %s result to the operation budget', (expression) => {
  const program = `void main() {
  final big = BigInt.one << 1000000;
  final values = List.generate(1500, (_) => ${expression});
  print(values.length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('Dart enum methods may omit their return types', () => {
  const program = `enum Color { red, blue; show() => name; toString() => 'C'; }
void main() { print([Color.red.show(), Color.blue]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[red, C]\n' });
});

test('Dart keeps the sign of a negated zero integer literal in a double context', () => {
  const program = `void main() {
  double x = -0;
  const double z = -0x0;
  print([x, z, 1 / x, <double>[-0][0]]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[-0.0, -0.0, -Infinity, -0.0]\n',
  });
});

test.each([
  "final int? x;\nvoid main() { print('hi'); }",
  'final x;\nvoid main() { print(x); }',
  "class C { static final int? x; }\nvoid main() { print('hi'); }",
])('Dart requires an initializer on a final top-level or static variable: %s', (program) => {
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 0 })],
  });
});

test('Dart field initializers read primary constructor parameters', () => {
  const program = `class Box<T>(T value) { final List<T> values = [value]; final first = value; }
class P(final int x, var int y) { final sum = x + y; }
void main() {
  final box = Box(7);
  final p = P(1, 2);
  print([box.values, box.first.runtimeType, p.x, p.y, p.sum]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[[7], int, 1, 2, 3]\n' });
});

test('Dart promotes private late final fields but not private late fields', () => {
  const promoted = `class A {
  late final int? _x;
  late final String? _s = 'ab';
  A(this._x);
  void show() { if (_x != null && _s != null) print([_x.isEven, _s.length]); }
}
mixin M { late final int? _y = 2; }
class B with M {}
void main() {
  A(4).show();
  final b = B();
  if (b._y != null) print(b._y.isEven);
}`;
  expect(executeProgram('dart', promoted)).toMatchObject({ kind: 'executed', stdout: '[true, 2]\ntrue\n' });
  const mutable =
    'class A { late int? _x = 4; void show() { if (_x != null) print(_x.isEven); } }\nvoid main() { A().show(); }';
  expect(executeProgram('dart', mutable)).toMatchObject({ kind: 'compileError' });
});

test.each([
  ['int?', 'null => 0, != null => 1'],
  ['int?', '== null => 0, int() => 1'],
  ['int', '!= null => 1'],
  ['Object?', '!= null => 1, null => 0'],
  ['List<int>?', '== null => 0, [] => 1, [_, ...] => 2'],
])('Dart relational null patterns do not make a switch on %s exhaustive: %s', (type, cases) => {
  expect(
    executeProgram('dart', `int f(${type} v) => switch (v) { ${cases} };\nvoid main() { print(f(null as dynamic)); }`)
  ).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('すべての値') })],
  });
});

test.each(['int _', 'var _', 'final _'])(
  'Dart rejects the wildcard declaration %s in a pattern assignment',
  (wildcard) => {
    expect(executeProgram('dart', `void main() { int a = 0; (${wildcard}, a) = (1, 2); print(a); }`)).toMatchObject({
      kind: 'compileError',
    });
    expect(executeProgram('dart', 'void main() { int a = 0; (_, a) = (1, 2); print(a); }')).toMatchObject({
      kind: 'executed',
      stdout: '2\n',
    });
  }
);

test('Dart for-in loops in sync* generators charge each advance', () => {
  const program = `Iterable<int> scan(List<int> values) sync* { for (var value in values) { if (value < 0) yield value; } }
void main() {
  final values = List<int>.filled(100000, 0);
  for (var i = 0; i < 11; i++) { scan(values).isEmpty; }
  print('finished');
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('Dart field initializers see primary constructor parameters typed as the constructor types them', () => {
  const program = `class C(this.x) { final int x; final values = [x]; }
class Box<T>({required this.value}) { final T value; final values = [value]; final int Function() f = () => 1; }
class D(int n) { final int Function() read = () => n; }
class P<T>({required this._x}) { final T _x; final values = [_x]; }
void main() {
  List<int> values = C(4).values;
  print([values, Box(value: 7).values.runtimeType, D(5).read(), P(x: 4).values.runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[[4], List<int>, 5, List<int>]\n',
  });
});

test.each([
  'final int value = (n = 3);',
  'final int value = ++n;',
  'final int Function() f = () { n = 5; return n; };',
])('Dart rejects assigning a primary constructor parameter in the field initializer %s', (field) => {
  expect(executeProgram('dart', `class C(int n) { ${field} }\nvoid main() { C(4); }`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'プライマリコンストラクタの引数 n には、初期化子の中で代入できません。' }],
  });
});

test('Dart HashMap.update hashes and compares keys as the VM does', () => {
  const program = `import 'dart:collection';
class K {
  final int v;
  K(this.v);
  int get hashCode { print('hash$v'); return v; }
  bool operator ==(Object o) { print('eq$v'); return o is K && o.v == v; }
}
void main() {
  for (final m in [HashMap<K, int>(), HashMap<K, int>(equals: (a, b) { print('E\${a.v}'); return a.v == b.v; }, hashCode: (k) { print('H\${k.v}'); return k.v; }), HashMap<K, int>.identity()]) {
    final k = K(7);
    print(m.update(k, (x) => x + 1, ifAbsent: () => 0));
    print(m.update(k, (x) => x + 1, ifAbsent: () => 0));
    print(m.update(K(7), (x) => x + 1, ifAbsent: () => 10));
    try { m.update(K(8), (x) => x + 1); } catch (e) { print(e); }
    print(m.length);
    print('==');
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "hash7\n0\nhash7\neq7\n1\nhash7\neq7\n2\nhash8\nInvalid argument (key): Key not in map.: Instance of 'K'\n1\n==\nhash7\n0\nhash7\neq7\n1\nhash7\neq7\n2\nhash8\nInvalid argument (key): Key not in map.: Instance of 'K'\n1\n==\n0\n1\n10\nInvalid argument (key): Key not in map.: Instance of 'K'\n2\n==\n",
  });
});

test('Dart HashMap key and value views and iterators match the VM classes', () => {
  const program = `import 'dart:collection';
late HashMap<int, Object> m2;
class V { bool operator ==(Object other) { m2[2] = 'x'; return false; } int get hashCode => 1; }
void main() {
  final m = HashMap<int, String>()..[1] = 'old';
  final i = m.values.iterator;
  print(i.moveNext()); m[1] = 'new'; print(i.current);
  final k = m.keys.iterator;
  try { print(k.current); } catch (e) { print(e.runtimeType); }
  print([k.moveNext(), k.current, k.moveNext()]);
  try { print(k.current); } catch (e) { print(e.runtimeType); }
  final a = m.keys.iterator.runtimeType, b = m.values.iterator.runtimeType;
  print([a, b, a == b, {a, b}.length, a.hashCode, b.hashCode, m.keys.runtimeType.hashCode, m.values.runtimeType.hashCode]);
  final h = HashMap<String, double>.identity();
  print([h.keys.iterator.runtimeType.hashCode, h.values.iterator.runtimeType.hashCode]);
  m2 = HashMap<int, Object>()..[1] = V();
  try { print(m2.values.contains(3)); } catch (e) { print(e.runtimeType); }
  print(m2.length);
  m.keys.forEach(print); m.values.forEach(print);
  print([m.keys.isNotEmpty, m.values.isNotEmpty, m.keys.contains(1), m.values.contains('new')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'true\nnew\n_TypeError\n[true, 1, false]\n_TypeError\n[_HashMapKeyIterator<int, String>, _HashMapValueIterator<int, String>, false, 2, 1068096129, 396333034, 540613826, 963203138]\n[829608544, 115932755]\nfalse\n2\n1\nnew\n[true, true, true, true]\n',
  });
});

test('Dart types closure parameters with unresolved type parameters as Object?', () => {
  const program = `import 'dart:collection';
void f<T>(Object o, [int Function(T, T)? c]) { print(T); }
class W<T> { W.from(Object o, [int Function(T, T)? c]) { print(T); } }
T g<T extends num>(T Function(T) c) => c(1 as T);
void main() {
  f(<int>[], (a, b) => 0);
  f(<int>[]);
  W.from(1, (a, b) => 0);
  print(SplayTreeSet((a, b) => 0).runtimeType);
  print(g((a) => a));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Object?\ndynamic\nObject?\nSplayTreeSet<Object?>\n1\n',
  });
  expect(
    executeProgram('dart', "import 'dart:collection';\nvoid main() { SplayTreeSet((a, b) => a.length - b.length); }")
  ).toMatchObject({ kind: 'compileError' });
});

test('Dart closure arguments constrain the type parameters they leave unresolved', () => {
  const program = `import 'dart:collection';
class K { int v = 1; }
void f<T>(int Function(T, T) c) { print(T); }
void h<T>(void Function(void Function(T)) c) { print(T); }
R g<R>(R Function() c) { print(R); return 0 as R; }
void main() {
  f((a, K b) => 0);
  f((a, b) => 0);
  print(SplayTreeSet((K a, b) => a.v - 1).runtimeType);
  h((g) {});
  try { g(() => throw 0); } catch (e) {}
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'K\nObject?\nSplayTreeSet<K>\nNever\nNever\n',
  });
  expect(
    executeProgram(
      'dart',
      'class K { int v = 1; }\nvoid f<T extends K>(int Function(T) c) {}\nvoid main() { f((a) => a.v); }'
    )
  ).toMatchObject({ kind: 'compileError' });
});

test.each(['final int a = n!; final int b = n;', 'final int a = n!, b = n;'])(
  'Dart field initializers do not share primary parameter promotions: %s',
  (fields) => {
    expect(executeProgram('dart', `class C(int? n) { ${fields} }\nvoid main() { print(C(4).b); }`)).toMatchObject({
      kind: 'compileError',
    });
    expect(
      executeProgram('dart', 'class C(int? n) { final int a = n! + n; }\nvoid main() { print(C(4).a); }')
    ).toMatchObject({
      kind: 'executed',
      stdout: '8\n',
    });
  }
);

test('Dart upper bounds of lists and sets are Iterable', () => {
  const program = `void main() {
  final values = [<int>[], <int>{}];
  values.add([1].where((x) => true));
  print([values.runtimeType, [<String>['x'], <String>{'y'}].runtimeType, values.length]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<Iterable<int>>, List<Iterable<String>>, 3]\n',
  });
});

test('Dart primary constructor bodies keep their initializer lists', () => {
  const program = `class B { final int x; B(this.x); }
class C(int? n) { final int a, b; this: a = n!, b = n; }
class D(int n) extends B { int? c; this: c = n, assert(n > 0), super(n * 2) { print('body'); } }
void main() {
  final d = D(4);
  print([C(4).b, d.c, d.x]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'body\n[4, 4, 8]\n' });
});

test('Dart primary constructors type super formals, protect parameters before the body, and allow one body', () => {
  const program = `class B { final int x; B.named(this.x); }
class C(super.x) extends B { final values = [x]; this: super.named(); }
class D(int n) { final int x; this: x = n { n = 7; print(n); } }
void main() {
  print([C(4).values.runtimeType, D(4).x]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '7\n[List<int>, 4]\n' });
  for (const invalid of [
    'class C(int n) { final int x; this: x = (n = 5); }',
    'class C(int n) { final int x; this: x = ++n; }',
    'class C(int n) { final int x; this: x = n; this: x = n + 1; }',
  ]) {
    expect(executeProgram('dart', `${invalid}\nvoid main() { print(C(4).x); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('Dart extension type primary constructors run their initializer lists and bodies', () => {
  expect(
    executeProgram(
      'dart',
      "extension type E(int n) { this { print('body'); } }\nvoid main() { print([E(4), const F(3)]); }\nextension type const F(int n) {}"
    )
  ).toMatchObject({ kind: 'executed', stdout: 'body\n[4, 3]\n' });
  expect(
    executeProgram('dart', 'extension type const E(int n) { this: assert(n > 0); }\nvoid main() { print(const E(0)); }')
  ).toMatchObject({ kind: 'compileError' });
});

test('Dart brace spreads of fields and getters infer sets and maps from their types', () => {
  const program = `class A {
  final items = [1, 2, 1];
  Map<String, int> get m => {'a': 1};
  void show() { print([{...items}, {...m}]); }
}
List<int> get items => [3, 3];
void main() { A().show(); print({...items}); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[{1, 2}, {a: 1}]\n{3}\n' });
});

test.each([
  'mixin M { int x; }\nclass C with M {}\nvoid main() { print(C().x); }',
  'mixin M<T> { T t; }\nvoid main() {}',
  'mixin M { final int x; }\nvoid main() {}',
  'class A { int x; factory A() => throw 1; }\nvoid main() {}',
])('Dart requires initializers on fields no generative constructor can set: %s', (program) => {
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 0 })],
  });
});

test('Dart accepts nullable, late, and initialized fields without generative constructors', () => {
  const program =
    'mixin M { int? x; late int y; int z = 1; final w = 2; dynamic d; }\nclass C with M {}\nvoid main() { print([C().x, C().z, C().d]); }';
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[null, 1, null]\n' });
});

test.each([
  'class B extends A implements A {}',
  'class B extends A implements A, C {}',
  'mixin M on A, A {}',
  'mixin M on A implements A {}',
  'class B implements Object {}',
  'mixin M implements Object {}',
  'mixin M {}\nclass B = A with M implements A;',
])('Dart rejects a supertype listed twice across clauses: %s', (declaration) => {
  expect(executeProgram('dart', `class A {}\nclass C {}\n${declaration}\nvoid main() {}`)).toMatchObject({
    kind: 'compileError',
  });
  for (const valid of [
    'mixin M {}\nclass B with M implements M {}',
    'mixin M on A, C implements A, C {}',
    'enum E implements Object { a }',
    'mixin M {}\nclass B extends A with M implements A {}',
    'mixin M {}\nmixin N {}\nclass B = A with M, N implements A;',
  ]) {
    expect(executeProgram('dart', `class A {}\nclass C {}\n${valid}\nvoid main() {}`)).toMatchObject({
      kind: 'executed',
    });
  }
});

test('Dart extension types are Objects only through the supertypes they implement', () => {
  for (const use of ['Object y = E(1);', 'f(E(1));', 'print(<Object>[E(1)]);', 'Object y = F(1);']) {
    const program = `extension type E(int v) {}\nextension type F(int v) implements E {}\nvoid f(Object o) {}\nvoid main() { ${use} }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `extension type E(int v) implements Object {}
extension type F(int v) implements E {}
extension type G(int v) implements int {}
extension type H(int v) {}
void main() { Object a = F(1); Object b = G(2); Object? c = H(3); print([a, b, c]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 3]\n' });
});

test('Dart fully annotated closures constrain type arguments alongside the other arguments', () => {
  const program = `T f16<T>(T a, T Function(T) g) => g(a);
T apply2<T>(T a, T b, T Function(T, T) g) => g(a, b);
void main() {
  var x = f16(1, (num y) => y * 1.5);
  var y = apply2(1, 2, (num p, num q) => p / q);
  num z = x;
  print([z, x.runtimeType, y]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1.5, double, 0.5]\n' });
});

test('Dart throws only dynamic values and subtypes of Object', () => {
  for (const program of [
    'extension type E(int v) {}\nvoid main() { throw E(1); }',
    'extension type E(int? v) {}\nvoid main() { throw E(null); }',
    'extension type E(int v) {}\nvoid f<T extends E>(T t) { throw t; }\nvoid main() {}',
    'void f(int? x) { throw x; }\nvoid main() {}',
    'void f<T extends Object>(T? t) { throw t; }\nvoid main() {}',
    'void f<T extends int>(T? t) { Object o = t; }\nvoid main() {}',
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid =
    'extension type E(int v) implements Object {}\nvoid main() { try { throw E(1); } catch (e) { print(e); } }';
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '1\n' });
});

test('Dart chooses a call context type argument over a closure argument bound', () => {
  for (const use of [
    'print([1, 2, 3].fold(0, (int a, int b) => a + b));',
    'print(f16(1, (int y) => y * 2));',
    'print([1, g((a) => a)]);',
  ]) {
    const program = `T f16<T>(T a, T Function(T) g) => g(a);\nT g<T extends num>(T Function(T) c) => c(1 as T);\nvoid main() { ${use} }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid =
    'T id<T>(T x) => x;\nvoid main() { var s = [1, 2, 3].fold(0, (int a, int b) => a + b); num n = id(2); print([s, n, id(1)]); }';
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[6, 2, 1]\n' });
});

test('Dart function literal arguments see assignments in later arguments', () => {
  const program = `void f({required int seed, required int Function(int) g}) { print(g(seed)); }
T h<T>({required T seed, required T Function(T) g}) => g(seed);
void main() {
  int x;
  f(g: (int n) => n + x, seed: x = 4);
  int y;
  var r = h(g: (int n) => n + y, seed: y = 5);
  print(r);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '8\n10\n' });
});

test.each([
  'void f(final int p) {}',
  'class A { A(final int x); }',
  'class A { final int x; A(final this.x); }',
  'void f({required final int a}) {}',
  'class A { void m(late int x) {} }',
  'final g = (const int p) => p;',
])('Dart rejects parameter modifiers outside primary constructor fields: %s', (declaration) => {
  expect(executeProgram('dart', `${declaration}\nvoid main() {}`)).toMatchObject({ kind: 'compileError' });
  const valid =
    'class P(final int x, var int y) {}\nextension type E(final int x) {}\nvoid main() { print([P(1, 2).x, E(3).x]); }';
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[1, 3]\n' });
});

test('Dart extension types redeclare inherited members with any signature', () => {
  const program = `extension type E(int value) implements Object { int f(int n) => n; int get g => value; }
extension type F(E value) implements E { String f(String n) => n; String get g => 'g'; }
extension type G(int value) implements int { String get isEven => 'x'; }
void main() { final f = F(E(3)); print([f.value.value, f.f('ok'), f.g, G(3).isEven]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[3, ok, g, x]\n' });
});

test.each([
  'void f<T>(List<void Function(T)> a, T t) {}\nvoid main() { f([(x) { String s = x; }], 1); }',
  'void f<T>(Set<void Function(T)> a) {}\nvoid main() { f({(x) { x.foo(); }}); }',
  'void f<T>((void Function(T), int) a) {}\nvoid main() { f(((x) { x.foo(); }, 1)); }',
])('Dart types closures nested in generic call arguments by Object?: %s', (program) => {
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
});

test('Dart extension types must redeclare members inherited from several extension types', () => {
  const declarations = 'extension type E(int value) { int f() => 1; }\nextension type F(int data) { int f() => 2; }';
  expect(
    executeProgram(
      'dart',
      `${declarations}\nextension type G(int item) implements E, F {}\nvoid main() { print(G(1).f()); }`
    )
  ).toMatchObject({ kind: 'compileError' });
  const privates = 'extension type E(int value) { int _f() => 1; }\nextension type F(int data) { int _f() => 2; }';
  expect(
    executeProgram(
      'dart',
      `${privates}\nextension type G(int item) implements E, F {}\nvoid main() { print(G(1)._f()); }`
    )
  ).toMatchObject({ kind: 'compileError' });
  const valid = `${declarations}
extension type G(int item) implements E, F { int f() => 3; }
extension type H(int d) implements E {}
extension type I(int d) implements E, H {}
void main() { print([G(1).f(), I(1).f()]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[3, 1]\n' });
});

test('Dart enum generative constructors are constant without const', () => {
  const program = `enum E { a(1), b(2); final int v; E(this.v); }
enum F { a.named(3); final int v; F.named(int v) : v = v * 2; }
void main() { print([E.b.v, F.a.v]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 6]\n' });
  for (const invalid of ["enum E { a; E() { print('x'); } }", 'enum E { a(1); int v; E(this.v); }']) {
    expect(executeProgram('dart', `${invalid}\nvoid main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart collection literal arguments infer their types from annotated closures', () => {
  const program = `void f<T>(List<T Function(T)> a) { print(T); }
void g<T>(Map<String, void Function(T)> a) { print(T); }
void h<T>(Set<void Function(T)> a) { print(T); }
void k<T>(Map<void Function(T), int> a) { print(T); }
void main() { f([(int x) => x]); g({'a': (int x) {}}); h({(int x) {}}); g({...{'a': (int x) {}}}); k({...{(int x) {}: 1}}); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'int\nint\nint\nint\nint\n' });
});

test('Dart spread maps keep their turtles while the target hashes keys', () => {
  const program = `final scout = Turtle(1, 0);
class Key {
  final int n;
  Key(this.n);
  int get hashCode { scout.canMoveForward(); return n; }
  bool operator ==(Object other) => other is Key && n == other.n;
}
Map<Key, Turtle> make() => {Key(1): Turtle(2, 1), Key(2): Turtle(1, 1)};
void main() {
  var m = <Key, Turtle>{Key(0): Turtle(3, 0), ...make()};
  print(m.length);
  print(scout.canMoveForward());
}`;
  const result = executeProgram('dart', program);
  expect(result).toMatchObject({ kind: 'executed', stdout: '3\nfalse\n' });
  expect(result.kind === 'executed' && result.finalTurtles).toHaveLength(4);
});

test('Dart extension type redeclarations infer nothing from inherited members', () => {
  const program = `extension type E(int value) { int f(int x) => x; int get g => 1; }
extension type F(int value) implements E { f(x) => x; get g => 'g'; }
void main() { print([F(1).f('ok'), F(1).g]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[ok, g]\n' });
});

test('Dart upper bounds with extension types that implement no Object are Object?', () => {
  const program = `extension type E(int v) {}
extension type F(int v) {}
extension type G(int v) implements Object {}
void main() { print([[E(1), 2].runtimeType, [E(1), F(2)].runtimeType, [G(1), 2].runtimeType]); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<Object?>, List<Object?>, List<Object>]\n',
  });
  expect(
    executeProgram('dart', 'extension type E(int? v) {}\nvoid main() { var b = true; Object o = b ? E(null) : 1; }')
  ).toMatchObject({ kind: 'compileError' });
});

test('Dart empty collection literals take the greatest closure of a partly unresolved context', () => {
  const program = `void f<T>(List<List<T>> a) { print(a.runtimeType); }
void g<T>(Map<String, List<T>> a) { print(a.runtimeType); }
void h<T>(List<T> a) { print([T, a.runtimeType]); }
class C<T> { final List<List<T>> rows; C(this.rows); }
void main() { f([]); g({}); h([]); print(C([]).rows.runtimeType); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'List<List<Object?>>\n_Map<String, List<Object?>>\n[dynamic, List<dynamic>]\nList<List<Object?>>\n',
  });
});

test('Dart generic calls keep Never constraints from typed collection arguments', () => {
  const program = `void f<T>(List<T> xs) { print(T); }
void g<T>(Map<String, List<T>> m) { print(T); }
void h<T>(List<void Function(T)> a) { print(T); }
Never k<S>(S x) => throw 0;
void t<T>(T Function(int) cb) { print(T); }
void main() { f(<Never>[]); g(<String, List<Never>>{}); h([(g) {}]); t(k); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Never\nNever\nObject?\nNever\n' });
});

test('Dart generic classes infer their own constructors from contexts naming their type parameters', () => {
  const program = `class Stack<T> {
  final List<T> items;
  Stack(this.items);
  factory Stack.empty() => Stack([]);
  Stack<T> cleared() => Stack([]);
}
class Cache<K, V> { final Map<K, V> m; Cache(this.m); factory Cache.empty() => Cache({}); }
void main() { print([Stack<int>.empty().items.runtimeType, Stack<int>([1]).cleared().items.length, Cache<int, String>.empty().m.runtimeType]); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[List<int>, 0, _Map<int, String>]\n',
  });
});

test('Dart infers nothing from generic callbacks whose bounds refer to their own type parameters', () => {
  expect(
    executeProgram(
      'dart',
      'int g<S extends Comparable<S>>(int x) => x;\nvoid f<T>(T Function<S extends Comparable<S>>(T) cb) { print(T); }\nvoid main() { f(g); }'
    )
  ).toMatchObject({ kind: 'compileError' });
  const valid = `int g<S extends List<int>>(int x) => x;
void f<T>(T Function<S extends List<int>>(T) cb) { print(T); }
void h<T>(void Function(void Function<S extends Comparable<S>>(T)) cb) { print(T); }
void main() { f(g); h((g) {}); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: 'int\ndynamic\n' });
});

test.each(['var y = {...x};', 'var y = {if (true) ...x};'])(
  'Dart rejects brace literals whose dynamic spreads leave set or map undecided: %s',
  (declaration) => {
    expect(executeProgram('dart', `void main() { dynamic x = {1: 2}; ${declaration} }`)).toMatchObject({
      kind: 'compileError',
    });
    const valid = `void main() {
  dynamic x = {1: 2};
  Map<int, int> y = {...x};
  Map<int, int> z = {...{...x}};
  Set<int> e = {...{}};
  Set<int> p = {...(true ? {} : {})};
  print([y, z, e, p, {}.runtimeType, {...x, 3: 4}, {if (true) ...{}}.runtimeType, {...{}, ...x}, {...{}, 1}.runtimeType]);
}`;
    expect(executeProgram('dart', valid)).toMatchObject({
      kind: 'executed',
      stdout:
        '[{1: 2}, {1: 2}, {}, {}, _Map<dynamic, dynamic>, {1: 2, 3: 4}, _Map<dynamic, dynamic>, {1: 2}, _Set<dynamic>]\n',
    });
    expect(executeProgram('dart', 'void main() { var y = {...{}, ...<int>{1}}; }')).toMatchObject({
      kind: 'compileError',
    });
    const wrapped = 'void main() { print([{...(true ? {} : {}), 1}.runtimeType, [...[1], ...[2.0]].runtimeType]); }';
    expect(executeProgram('dart', wrapped)).toMatchObject({ kind: 'executed', stdout: '[_Set<dynamic>, List<num>]\n' });
  }
);

test('Dart call contexts choose type arguments over arguments that only constrain them', () => {
  const program = `class Tree<T> { T? val; Tree(this.val); }
class Node<T> { T? value; Node<T>? next; Node({this.value, this.next}); }
void main() {
  Tree<int> u = Tree(null);
  Node<int> n = Node(value: null);
  List<Tree<int>> l = [Tree(null)];
  print([u.runtimeType, n.runtimeType, l.runtimeType, Tree(null).runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[Tree<int>, Node<int>, List<Tree<int>>, Tree<Null>]\n',
  });
  expect(executeProgram('dart', 'T id<T>(T x) => x;\nvoid main() { int y = id(null); }')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('引数') })],
  });
});

test('Dart generic functions accept self-referential bounds over F-bounded classes', () => {
  const program = `abstract class Shape<T extends Shape<T>> { T copy(); }
class Sq extends Shape<Sq> { Sq copy() => Sq(); }
class C { static String s<T extends Shape<T>>(T x) => '\${x.copy().runtimeType}'; }
void s<T extends Shape<T>>(T x) { print(x.copy().runtimeType); }
void main() { s(Sq()); print(C.s(Sq())); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Sq\nSq\n' });
  expect(
    executeProgram(
      'dart',
      'abstract class Shape<T extends Shape<T>> {}\nvoid s<T extends Shape<int>>(T x) {}\nvoid main() {}'
    )
  ).toMatchObject({ kind: 'compileError' });
});

test('Dart extension types must redeclare members inherited both as extension and class members', () => {
  const header = 'class A { int f() => 1; }\nextension type E(A e) implements A { int f() => 2; }';
  expect(executeProgram('dart', `${header}\nextension type G(A z) implements E, A {}\nvoid main() {}`)).toMatchObject({
    kind: 'compileError',
  });
  const valid = `${header}
extension type G(A z) implements E, A { int f() => 3; }
extension type H(A e) implements A {}
extension type I(A z) implements H, A {}
void main() { print([G(A()).f(), I(A()).f()]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[3, 1]\n' });
});

test('Dart instantiates generic tear-offs nested in collection and record arguments', () => {
  const program = `Never g<S>(S n) => throw 0;
S id<S>(S n) => n;
void f<T>(List<T Function(int)> cb) { print(T); }
void h<T>((T Function(int), int) cb) { print(T); }
void main() { f([g]); f([id]); h((g, 1)); (int Function(int), int) r = (id, 1); print(r.$1(5)); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'Never\nint\nNever\n5\n' });
});

test('Dart string interpolation evaluates every operand before converting any', () => {
  const program = `class T { String s; T(this.s); String toString() { print('toString \${s}'); return s; } }
int g() { print('g'); return 1; }
void main() {
  var stack = [1, 2, 3];
  print('stack: $stack, popped: \${stack.removeLast()}');
  print('\${T('a')} \${g()}');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'stack: [1, 2], popped: 3\ng\ntoString a\na 1\n',
  });
});

test('Dart braces with only scoped spreads take the kind their spreads compile as', () => {
  const program = `void main() {
  Object x = [1, 2];
  Object y = {1: 2};
  print([{for (var xs in [[1, 2]]) ...xs}, {if (x is List<int>) ...x}, {if (y is Map<int, int>) ...y}]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[{1, 2}, {1, 2}, {1: 2}]\n' });
});

test('Dart assignment expressions keep a dynamic value type', () => {
  const program = `void main() {
  dynamic d = 1;
  num x = 0;
  num? z;
  var y = x = d;
  var w = z ??= d;
  print([y.isEven, w.isEven, x.runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[false, false, int]\n' });
  const operators = `class A { dynamic operator +(int n) => B(); }
class B extends A { int get extra => 3; }
void main() { A a = A(); var y = a += 1; A b = A(); var z = ++b; print([y.extra, z.extra]); }`;
  expect(executeProgram('dart', operators)).toMatchObject({ kind: 'executed', stdout: '[3, 3]\n' });
  expect(executeProgram('dart', 'void main() { dynamic d = 1; num x = 0; x = d; x.isEven; }')).toMatchObject({
    kind: 'compileError',
  });
});

test('Dart explicit extension applications are only member and operator receivers', () => {
  const header =
    'extension E on int { int get twice => this * 2; int operator -(int o) => this + o; void m() { print(this); } }';
  expect(executeProgram('dart', `${header}\nvoid main() { print([E(1).twice, E(5) - 1]); E(2).m(); }`)).toMatchObject({
    kind: 'executed',
    stdout: '[2, 6]\n2\n',
  });
  for (const use of ['print(E(1));', 'var x = E(1);', 'print((E(1)).twice);', 'print(E(1)!);', 'print(E(1)!.twice);']) {
    expect(executeProgram('dart', `${header}\nvoid main() { ${use} }`)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart explicit extension applications call the selected extension operators', () => {
  const program = `extension S on String { String operator +(String v) => 'extension'; }
extension E on int { int operator -() => 50; int operator +(int o) => 7; }
extension F on int { int operator +(int o) => 8; }
void main() { print([S('a') + 'b', 'a' + 'b', -E(1), E(1) + 2, F(1) + 2, 1 + 2]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[extension, ab, 50, 7, 8, 3]\n' });
  const call = `extension G on int Function(int) { int call(int x) => 50; }
extension H on dynamic { int call(int x) => 60; }
int f(int x) => x;
void main() { print([G(f)(1), H(f)(1), f(1)]); }`;
  expect(executeProgram('dart', call)).toMatchObject({ kind: 'executed', stdout: '[50, 60, 1]\n' });
});

test('Dart unqualified extension members bind to the enclosing extension', () => {
  const program = `class C { int x = 5; int f() => 2; int get v => 20; }
extension E on C {
  int f() => 1;
  int get v => 10;
  set x(int value) { print('E.x = $value'); }
  int get x => 9;
  void g() { x = 3; print([f(), v, x, f.call()]); }
}
extension F on int { int f() => 3; int g() => f(); }
extension G on int { int f() => 4; }
void main() { var c = C(); E(c).g(); print([c.x, F(0).g()]); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'E.x = 3\n[1, 10, 9, 1]\n[5, 3]\n',
  });
});

test('Dart dot shorthands take the context of their whole selector chain', () => {
  const header = `class A {
  static A get inst => A();
  A();
  static A? maybe() => A();
  A get me => this;
  A next() => A();
  String toString() => 'A!';
}`;
  const program = `${header}
void main() {
  A b = .inst.next().me;
  A? c = .maybe()?.next();
  List<A> l = [.new().next()];
  int i = .parse('-1').abs();
  print([b, c, l, i]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[A!, A!, [A!], 1]\n' });
  for (const use of ["int i = .parse('-1').abs() + 1;", '.inst.next();']) {
    expect(executeProgram('dart', `${header}\nvoid main() { ${use} }`)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart type annotations may be super-bounded while instantiations stay regular-bounded', () => {
  const header = 'class Box<T extends num> { final T? value; Box([this.value]); }';
  const program = `${header}
void main() {
  Box<dynamic> b = Box<int>(1);
  List<Box<Object?>> l = [Box<double>(2.5)];
  Object o = b;
  print([b.value, l.first.value, o is Box<void>, Box<dynamic>]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2.5, true, Box<dynamic>]\n' });
  for (const rest of [
    'void main() { Box<dynamic>(); }',
    'void main() { var f = Box<dynamic>.new; }',
    'class C extends Box<dynamic> {} void main() {}',
    'typedef B = Box<dynamic>; void main() {}',
    'void main() { Box<String>? b; }',
  ]) {
    expect(executeProgram('dart', `${header}\n${rest}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart static members cannot share a name with inherited instance members', () => {
  for (const program of [
    'class A { int count = 0; } class B extends A { static int count = 5; } void main() {}',
    'class A { set x(int v) {} } class B extends A { static int get x => 1; } void main() {}',
    'mixin M { int y = 0; } class B with M { static int y = 1; } void main() {}',
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const allowed = `class A { static void f() {} static int c = 0; }
class B extends A { void f() { print('B.f'); } static int c = 1; }
void main() { B().f(); print(B.c); }`;
  expect(executeProgram('dart', allowed)).toMatchObject({ kind: 'executed', stdout: 'B.f\n1\n' });
});

test('Dart constants stay constant through implicit casts checked before main', () => {
  const program = `const dynamic value = 1;
const int top = value;
void f([int x = value]) { print(x); }
void main() {
  const xs = <int>[value];
  const m = <String, int>{'a': value};
  f();
  print([xs, m, top]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1\n[[1], {a: 1}, 1]\n' });
  for (const main of ["print('before'); const xs = <int>[value];", "print('before'); const int x = value;"]) {
    expect(executeProgram('dart', `const dynamic value = 'a';\nvoid main() { ${main} }`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('Dart record literal fields take implicit casts from their context', () => {
  const program = `void main() {
  dynamic d = 1;
  (int, int) r = (d, 2);
  ({int x, int y}) s = (x: d, y: 2);
  print([r, s]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[(1, 2), (x: 1, y: 2)]\n' });
  expect(executeProgram('dart', 'void main() { dynamic d = 1; var t = (d, 2); (int, int) r = t; }')).toMatchObject({
    kind: 'compileError',
  });
});

test('Dart dot shorthand chains on the right of == take the left type', () => {
  const program = `class P {
  final int x;
  const P(this.x);
  static P make(int v) => P(v);
  P get me => this;
  bool operator ==(Object o) => o is P && o.x == x;
  int get hashCode => x;
}
void main() { P p = P(0); print([p == .make(0), p != .new(1).me, 3 == .parse('3')]); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[true, true, true]\n' });
});

test('Dart branches instantiate generic tear-offs from their context before joining', () => {
  const program = `S id<S>(S x) => x;
void main() {
  int Function(int)? g;
  int Function(int) a = true ? id : (int x) => x;
  int Function(int) b = switch (1) { 1 => id, _ => (int x) => x };
  int Function(int) c = g ?? id;
  var d = g ?? id;
  print([a(1), b(2), c(3), d.runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 3, (int) => int]\n' });
});

test('Dart infers type arguments from the call method of a callable object', () => {
  const program = `class C { int call(int x) => x + 1; }
void h<T>(T Function(int) c) => print([T, c(1)]);
void f<T>(List<T Function(int)> l) => print([T, l[0](1)]);
void g<T>((T Function(int), int) r) => print([T, r.$1(1)]);
void main() { h(C()); f([C()]); g((C(), 1)); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[int, 2]\n[int, 2]\n[int, 2]\n',
  });
  const map = `class C { int call(int x) => x + 1; }
void h<T>(Map<String, T Function(int)> fs) => print(T);
void main() { h({'a': C()}); }`;
  expect(executeProgram('dart', map)).toMatchObject({ kind: 'compileError' });
});

test('Dart comparison operators are not associative', () => {
  for (const expression of [
    '1 == 1 == true',
    '1 != 2 != true',
    '1 < 2 < 3',
    '1 is int is bool',
    '1 as num as int',
    '1 as int is int',
  ]) {
    expect(executeProgram('dart', `void main() { print(${expression}); }`)).toMatchObject({ kind: 'compileError' });
  }
  expect(
    executeProgram(
      'dart',
      'void main() { print([1 < 2 == true, (1 == 1) == true, (1 as num) as int, 1 < 2 is bool]); }'
    )
  ).toMatchObject({ kind: 'executed', stdout: '[true, true, 1, true]\n' });
});

test('Dart rejects reading a name declared only as a setter', () => {
  for (const program of [
    'extension E on int { set x(int n) {} void f() { print(x); } } void main() { E(0).f(); }',
    'class C { int x = 5; } extension E on C { set x(int n) {} void f() { print(x); } } void main() { E(C()).f(); }',
    'class C { set x(int n) {} void f() { print(x); } } void main() { C().f(); }',
    'class C { set x(int n) {} void f() { print(x); } } extension E on C { int get x => 20; } void main() { C().f(); }',
    'class C { set x(int n) {} } extension E on C { int x() => 20; } void main() { print(C().x()); }',
    'class C { int get x => 1; } extension E on C { set x(int n) {} } void main() { C().x = 2; }',
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `class A { int get x => 1; }
class B extends A { set x(int n) { print('set $n'); } void f() { print(x); x = 2; } }
extension E on int { set y(int n) { print('y $n'); } void g() { y = 3; } }
void main() { B().f(); E(0).g(); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '1\nset 2\ny 3\n' });
});

test('Dart gives clamp and remainder arguments a double context', () => {
  const program = `double ratio(double x) => x.clamp(0, 1);
void main() {
  double? e = 2.5.clamp(1, 2);
  double h = 7.remainder(2);
  Object o = 2.5.clamp(0, 1);
  print([ratio(2.5), e, h, o.runtimeType]);
  nullAware(2.5, 9);
}
void nullAware(double? d, int? i) {
  double? a = d?.clamp(0, 1);
  int? b = i?.clamp(0, 5);
  int? c = i?.remainder(2);
  print([a, b, c]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1.0, 2.0, 1.0, int]\n[1.0, 5, 1]\n',
  });
  expect(executeProgram('dart', 'void main() { double d = 5.clamp(1, 3); }')).toMatchObject({ kind: 'compileError' });
});

test('Dart flow analysis treats checks decided by static types as constant', () => {
  const program = `int f(String s) { while (s != null) { return 1; } }
void main() {
  var x = 0;
  String a;
  if (x != null) a = 'a';
  int b;
  if (x is Null) {} else { b = 2; }
  int c;
  if (x case int _) c = 3;
  Null n = null;
  int d;
  if (n == null) d = 4;
  print([a, b, c, d, f('s')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[a, 2, 3, 4, 1]\n' });
  expect(executeProgram('dart', 'void main() { int? x; int y; if (x != null) y = 1; print(y); }')).toMatchObject({
    kind: 'compileError',
  });
});

test('equality checks covariant parameters before handling null', () => {
  const declaration = 'class C { bool operator ==(covariant C other) => true; }';
  const program = `${declaration}
void compare(C? value, C? other) {
  print([value == other, value != other]);
}
void main() {
  compare(C(), C());
  compare(null, C());
  compare(C(), null);
  compare(null, null);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[true, false]\n[false, true]\n[false, true]\n[true, false]\n',
  });
  const dynamicProgram = `${declaration}
void compare(C? left, dynamic right) {
  try { print(left == right); } catch (e) { print(e); }
  try { print(left != right); } catch (e) { print(e); }
}
void main() {
  compare(null, 1);
  compare(C(), 'wrong');
  compare(C(), null);
  compare(C(), C());
  dynamic left = null;
  dynamic right = 1;
  print(left == right);
}`;
  expect(executeProgram('dart', dynamicProgram)).toMatchObject({
    kind: 'executed',
    stdout:
      "type 'int' is not a subtype of type 'C?'\n".repeat(2) +
      "type 'String' is not a subtype of type 'C?'\n".repeat(2) +
      'false\ntrue\ntrue\nfalse\nfalse\n',
  });
  for (const comparison of ['value == 1', "value != 'wrong'"]) {
    expect(
      executeProgram(
        'dart',
        `${declaration} void compare(C? value) { print(${comparison}); } void main() { compare(null); }`
      )
    ).toMatchObject({ kind: 'compileError' });
  }
});

test('dynamic bitwise operations dispatch on the receiver before checking the argument', () => {
  const program = `void main() {
  dynamic a = 1.5;
  dynamic b = 1;
  try { print(a & 1); } catch (error) { print(error); }
  try { a <<= 'x'; } catch (error) { print(error); }
  try { print(b ^ 1.5); } catch (error) { print(error); }
  print(b | 2);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      "NoSuchMethodError: Class 'double' has no instance method '&'.",
      'Receiver: 1.5',
      'Tried calling: &(1)',
      "NoSuchMethodError: Class 'double' has no instance method '<<'.",
      'Receiver: 1.5',
      'Tried calling: <<("x")',
      "type 'double' is not a subtype of type 'int' of 'other'",
      '3',
      '',
    ].join('\n'),
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
  const encoding = `import 'dart:convert';
void main() {
  var bytes = List<int>.filled(750001, 0);
  try { print(base64Url.encode(bytes).length); } catch (error) { print(error); }
}`;
  const normalization = `import 'dart:convert';
void main() {
  var text = 'AA' + 'x' * 999998;
  try { print(base64.normalize(text, 0, 2).length); } catch (error) { print(error); }
  print(base64.normalize(text.substring(0, text.length - 2), 0, 2).length);
}`;
  expect(executeProgram('dart', encoding)).toMatchObject({ kind: 'executed', stdout: 'Out of Memory\n' });
  expect(executeProgram('dart', normalization)).toMatchObject({
    kind: 'executed',
    stdout: 'Out of Memory\n1000000\n',
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

test('wildcard locals and loop bindings stop retaining turtles after their scopes exit', () => {
  const source = `Iterable<Turtle> turtles() sync* {
  yield Turtle(1, 1);
}
Iterable<int> exercise() sync* {
  { var _ = Turtle(2, 2); }
  for (final _ in turtles()) { break; }
  yield 1;
}
void main() {
  { var _ = Turtle(4, 4); var _ = Turtle(5, 5); }
  for (final _ in turtles()) {}
  for (final _ in exercise()) {}
  var other = Turtle(3, 3);
  print(other.canMoveForward());
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
    finalTurtles: [{ x: 3, y: 3 }],
  });
});

test('counted loops destructure initializers and capture bindings per iteration', () => {
  const source = `Iterable<int> numbers() sync* {
  for (var (i, end) = (0, 2); i < end; i++) yield i;
}
void main() {
  final closures = <int Function()>[];
  for (var (i, end) = (0, 3); i < end; i++) {
    closures.add(() => i);
  }
  print(closures.map((f) => f()).toList());
  final expressions = [for (var [i, end] = [0, 3]; i < end; i++) () => i];
  print(expressions.map((f) => f()).toList());
  print(numbers().toList());
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[0, 1, 2]\n[0, 1, 2]\n[0, 1]\n' });
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

test('generic closures infer positional and named parameter types from their context', () => {
  const program = `void main() {
  T Function<T>(T) identity = <U>(x) => x;
  T Function<T extends num>({required T value}) named = <U extends num>({required value}) => value;
  print(identity<int>(1));
  print(named<double>(value: 2.5));
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '1\n2.5\n' });
});

// ECMAScript's backtracking order, the groups each iteration of a loop clears, lookbehind's backward matching, and
// Unicode and case-insensitive modes.
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

test('regular expression captures use the storage budget only when materialized', () => {
  const limit = { kind: 'limitExceeded', limit: 'storage' };
  expect(
    executeProgram(
      'dart',
      `void main() {
        final regex = RegExp('(a)' * 2048);
        final input = 'a' * 2048;
        final matches = <RegExpMatch>[];
        for (var i = 0; i < 600; i++) matches.add(regex.firstMatch(input)!);
        print(matches.length);
      }`
    )
  ).toEqual(limit);
  expect(
    executeProgram(
      'dart',
      `void main() {
        final regex = RegExp('(a)' * 1024);
        final matches = regex.allMatches('a' * (1024 * 520)).toList();
        print(matches.length);
      }`
    )
  ).toEqual(limit);
  expect(
    executeProgram(
      'dart',
      `void main() {
        final regex = RegExp('(a)' * 2048);
        final input = 'a' * 2048;
        for (var i = 0; i < 600; i++) {
          if (!regex.hasMatch(input)) throw StateError('missing match');
        }
        print('done');
      }`
    )
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout: 'done\n' });
});

// Neither compiling a host RegExp nor a host BigInt operation can be interrupted, so they must stop at the limits
// before they start.
test.each([
  {
    name: 'a regular expression with too many captures to compile',
    body: "  print(RegExp('(a)' * 250000).hasMatch('a'));",
  },
  {
    name: 'a gcd of BigInts with millions of bits',
    body: `  final a = (BigInt.one << 2000000) - BigInt.one;
  final b = (BigInt.one << 1000000) - BigInt.from(3);
  print(a.gcd(b));`,
  },
])('$name stops at the operation limit', ({ body }) => {
  expect(executeProgram('dart', `void main() {\n${body}\n}\n`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test('large regular expressions within the budget retain capture numbers', () => {
  const program = `void main() {
    final regex = RegExp('(a)' * 2048);
    final match = regex.firstMatch('a' * 2048)!;
    print([match.groupCount, match[2048]]);
    print(identical(regex, RegExp('(a)' * 2048)));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2048, a]\ntrue\n' });
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
  // Members the SDK has and the interpreter does not implement: instance, inherited, static, and constructor.
  for (const statement of [
    'print(stdout.nonBlocking)',
    'print(utf8.encoder.startChunkedConversion)',
    "File('a.txt').statSync()",
    'print(Directory.systemTemp)',
    'Map.unmodifiableOf({})',
  ]) {
    const result = executeProgram('dart', `import 'dart:convert'; import 'dart:io'; void main() { ${statement}; }`);
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
int relational(int? x) => switch (x) { != null => x + 1, _ => 0 };
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
  { name: 'isolates', program: "import 'dart:isolate';\n\nvoid main() {\n  print(Isolate.current);\n}\n" },
  { name: 'zones', program: "import 'dart:async';\n\nvoid main() {\n  runZoned(() => print('zoned'));\n}\n" },
  { name: 'platform details', program: "import 'dart:io';\n\nvoid main() {\n  print(Platform.operatingSystem);\n}\n" },
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

test('Map.unmodifiable returns the exported view over an independent snapshot', () => {
  const program = `import 'dart:collection';
int hashes = 0;
class Key {
  final int id;
  Key(this.id);
  int get hashCode { hashes++; return id; }
}
void main() {
  final key = Key(1);
  final original = {key: 1};
  final snapshot = Map<Key, int>.unmodifiable(original);
  final view = UnmodifiableMapView<Key, int>(original);
  print([snapshot.runtimeType, snapshot is UnmodifiableMapView<Key, int>]);
  original[key] = 2;
  print([(snapshot as UnmodifiableMapView<Key, int>)[key], view[key]]);
  hashes = 0;
  snapshot.forEach((k, v) { print([k.id, v]); });
  print([snapshot.values.toList(), snapshot.entries.single.value, snapshot.containsValue(1), hashes]);
  final cast = snapshot.cast<Object, num>();
  print([cast is UnmodifiableMapView<Object, num>, cast[key]]);
  try { cast[key] = 6; } catch (e) { print(e); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '[UnmodifiableMapView<Key, int>, true]\n[1, 2]\n[1, 1]\n[[1], 1, true, 0]\n[true, 1]\n' +
      'Unsupported operation: Cannot modify unmodifiable map\n',
  });
});

test('set spreads detect list length changes from hashing and equality callbacks', () => {
  const program = `var source = <Key>[];
class Key {
  final bool append;
  Key(this.append);
  int get hashCode {
    if (append && source.length == 1) source.add(Key(append));
    return 0;
  }
  bool operator ==(Object other) {
    if (!append && source.length == 2) source.removeLast();
    return false;
  }
}
void main() {
  source = [Key(true)];
  try { print({...source}.length); } catch (e) { print(e.runtimeType); }
  print(source.length);
  source = [Key(false), Key(false)];
  try { print({...source}.length); } catch (e) { print(e.runtimeType); }
  print(source.length);
  source = [Key(false), Key(false)];
  try { print((<Key>{}..addAll(source)).length); } catch (e) { print(e.runtimeType); }
  print(source.length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'ConcurrentModificationError\n2\nConcurrentModificationError\n1\nConcurrentModificationError\n1\n',
  });
});

test('list append exposes the reserved slot to iterator getters and keeps partial writes', () => {
  const program = `import 'dart:collection';
late List<int?> target;
class Source extends Iterable<int?> {
  final String mode;
  Source(this.mode);
  Iterator<int?> get iterator => Cursor(mode);
}
class Cursor implements Iterator<int?> {
  final String mode;
  Cursor(this.mode);
  int step = 0;
  bool moveNext() {
    if (step++ == 0) return true;
    print(target.length);
    if (mode == 'next') target.add(2);
    return mode == 'next';
  }
  int? get current {
    print(target.length);
    if (mode == 'throw') throw StateError('current');
    if (mode == 'remove') target.clear();
    if (mode == 'last') target.add(3);
    return 1;
  }
}
class View extends ListBase<int?> {
  int get length { print('length'); return 1; }
  set length(int n) {}
  int? operator [](int i) { print(target.length); return i + 2; }
  void operator []=(int i, int? value) {}
}
void main() {
  for (final mode in ['plain', 'throw', 'remove', 'last', 'next']) {
    target = [0];
    try { target.addAll(Source(mode)); } catch (e) { print(e.runtimeType); }
    print(target);
  }
  target = [0];
  target.addAll(View());
  target.addAll(List<int?>.unmodifiable([7, 8]));
  try { target.addAll(target); } catch (e) { print(e.runtimeType); }
  print(target);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '2\n2\n[0, 1]',
      '2\nStateError\n[0, null]',
      '2\nRangeError\n[]',
      '2\n3\n[0, 1, 3]',
      '2\n2\nConcurrentModificationError\n[0, 1, 2]',
      'length\nlength\nlength\n1\nlength\nConcurrentModificationError\n[0, 2, 7, 8]',
      '',
    ].join('\n'),
  });
});

test('modifiable lists cast fillRange values before checking the range', () => {
  const program = `void main() {
  for (final values in <List<int>>[<int>[1], List<int>.filled(1, 1), const <int>[1]]) {
    try { values.fillRange(-1, 2); } catch (e) { print(e.runtimeType); }
    try { values.fillRange(-1, 2, 5); } catch (e) { print(e.runtimeType); }
  }
  final nullable = <int?>[1];
  nullable.fillRange(0, 1);
  print(nullable);
}
`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '_TypeError\nRangeError\n_TypeError\nRangeError\nUnsupportedError\nUnsupportedError\n[null]\n',
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

test('write captures invalidate promotions from the point the closure can exist', () => {
  const program = `void expression(Object? value, bool change) {
  if (value is String) {
    print(value.length);
    if (change) {
      var assign = () { value = 1; };
      assign();
    } else {
      print(value.length);
    }
  }
}
void declaration(Object? value) {
  if (value is String) {
    print(value.length);
    void assign() { value = 1; }
    assign();
  }
}
void main() {
  expression('hello', false);
  declaration('Dart');
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '5\n5\n4\n' });
  const invalid = `void use(Object? value, bool change) {
  if (change) {
    void assign() { value = 1; }
    assign();
  }
  if (value is String) print(value.length);
}
void main() { use('hello', false); }`;
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
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

test('stored boolean promotions survive until the relevant path may be written', () => {
  const valid = `void sample(Object? x, Object? y) {
  final before = x is String;
  if (before) print(x.length);
  final both = x is String && y is String;
  try { print('try'); } finally { x = 1; }
  if (both) print(y.length);
}
void main() { sample('hello', 'Dart'); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '5\ntry\n4\n' });
  for (const body of [
    'final matches = x is String; if (change) x = 1; if (matches) print(x.length);',
    'final matches = x is String; while (change) { x = 1; break; } if (matches) print(x.length);',
    'var matches = x is String; matches = true; if (matches) print(x.length);',
    'final matches = x is String; void later() { if (matches) print(x.length); } x = 1; later();',
  ]) {
    const program = `void probe(Object? x, bool change) { ${body} } void main() {}`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart assignment promotions use tests consumed by control flow', () => {
  const valid = `class Check {
  final bool value;
  Check(num n) : assert(n is int), value = (n = 3) != 0 && n.isEven;
}
void main() {
  print(Check(1).value);
  num asserted = 1;
  assert(asserted is int);
  asserted = 3;
  print(asserted.isEven);
  num branched = 1;
  if (!(branched is int)) {}
  branched = 3;
  print(branched.isEven);
  num logical = 1;
  final test = true && logical is int;
  logical = 3;
  print([test, logical.isEven]);
}`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\nfalse\n[true, false]\n',
  });
  for (const statements of [
    'print(n is int); n = 3; print(n.isEven);',
    'var test = n is int; n = 3; print(n.isEven);',
    'final test = !(n is int); n = 3; print(n.isEven);',
    'final test = n is int; n = 3; if (test) print(n.isEven);',
    'assert(true, n is int ? 1 : 2); n = 3; print(n.isEven);',
    'assert(n is int); print(n.isEven);',
  ]) {
    const program = `void main() { num n = 1; ${statements} }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
});

test('consuming a stored Dart condition contributes its tested types', () => {
  for (const use of [
    'if (stored) {}',
    'if (!stored) {}',
    'if (stored && true) {}',
    'assert(stored);',
    'final selected = stored ? 1 : 2;',
    'while (stored) { break; }',
    'bool copied = stored; if (copied) {}',
    'n = 2; if (stored) {}',
  ]) {
    const program = `void main() { num n = 1; bool stored = n is int; ${use} n = 3; print(n.isEven); }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: 'false\n' });
  }
  for (const use of ['print(stored);', 'stored = true; if (stored) {}']) {
    const invalid = `void main() { num n = 1; bool stored = n is int; ${use} n = 3; print(n.isEven); }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('writes preserve or recover Dart promotions supported by the value type', () => {
  const valid = `void probe(num n, Object value) {
  if (n is int) {
    n = 2;
    print(n.isEven);
    n++;
    print(n.isOdd);
    n += 3;
    print(n.isEven);
    (n,) = (5,);
    print(n.isOdd);
    n = 2.5;
    n = 4;
    print(n.isEven);
  }
  if (value is String) print(value.length);
  value = 'Dart';
  print(value.length);
}
void pattern(Object value) {
  if (value case String() || int()) print(value);
  value = 'Dart';
  print(value.length);
}
void cast(Object value) {
  value as String;
  value = 1;
  value = 'Dart';
  print(value.length);
}
void main() {
  probe(9, 'SDK');
  pattern(1);
  cast('SDK');
}`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\ntrue\ntrue\ntrue\n3\n4\n1\n4\n4\n',
  });
  const invalid = 'void f(num n) { if (n is int) { n = 2.5; print(n.isEven); } } void main() {}';
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
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

test('JSON encodes long escaped values and keys without splitting surrogate pairs', () => {
  const program = String.raw`import 'dart:convert';
void main() {
  final boundary = '\n' + 'x' * 1022 + '😀' + String.fromCharCode(0xd800);
  final escaped = jsonEncode(boundary);
  print([escaped.length, escaped.startsWith(r'"\n'), escaped.endsWith(r'😀\ud800"')]);
  print([jsonEncode('\n' + 'x' * 999995).length, jsonEncode({'\n' + 'x' * 999990: 1}).length]);
  print(jsonEncode(List<int>.filled(1000, 0)).length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[1034, true, true]\n[999999, 999998]\n2001\n',
  });
});

test('JSON decoding distinguishes truncated unicode escapes from invalid digits', () => {
  const program = String.raw`import 'dart:convert';
void main() {
  for (final source in [r'"\u', r'"\u1', r'"\u12', r'"\u123', r'"\u1G', r'"\u12"', r'["\u1', r'"\u1234', r'"\u0061"']) {
    try { print(jsonDecode(source)); } on FormatException catch (error) { print([error.message, error.offset]); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[Unterminated string, 3]\n[Unterminated string, 4]\n[Unterminated string, 5]\n[Unterminated string, 6]\n' +
      '[Invalid unicode escape, 2]\n[Invalid unicode escape, 2]\n[Unterminated string, 5]\n[Unterminated string, 7]\na\n',
  });
});

test('JSON decoding keeps long strings, keys, and error offsets across scan boundaries', () => {
  const program = String.raw`import 'dart:convert';
void main() {
  print(jsonDecode('"' + 'x' * 900000 + '"').length);
  final key = (jsonDecode('{"' + 'q' * 900000 + r'\n":1}') as Map).keys.single as String;
  print([key.length, key.endsWith('\n')]);
  final pair = jsonDecode('"' + 'x' * 1023 + '😀' + r'\uD800"') as String;
  print([pair.length, pair.substring(1023, 1025), pair.codeUnitAt(1025)]);
  for (final suffix in [r'\u12q4"', '\n"', r'\x"', String.fromCharCode(92)]) {
    try { jsonDecode('"' + 'x' * 1024 + suffix); }
    on FormatException catch (e) { print([e.message, e.offset]); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '900000\n[900001, true]\n[1026, 😀, 55296]\n' +
      '[Invalid unicode escape, 1026]\n[Control character in string, 1025]\n[Unrecognized string escape, 1027]\n' +
      '[Unterminated string, 1026]\n',
  });
});

test('Function.apply requires VM symbols for named argument keys', () => {
  const source = `class NamedKey implements Symbol { final String name = 'x'; }
class EmptyKey implements Symbol {}
void f({int x = 0}) { print(x); }
void main() {
  Function.apply(f, [], {#x: 3});
  for (final key in [NamedKey(), EmptyKey()]) {
    try { Function.apply(f, [], {key: 1}); }
    catch (e) { print(e.runtimeType); print(e); }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "3\n_TypeError\ntype 'NamedKey' is not a subtype of type 'Symbol' in type cast\n_TypeError\ntype 'EmptyKey' is not a subtype of type 'Symbol' in type cast\n",
  });
});

test('Function.apply snapshots map length and uses the map forEach override', () => {
  const source = `import 'dart:collection';
class Arguments extends MapBase<Symbol, dynamic> {
  final data = <Symbol, dynamic>{#x: 7};
  bool stopped = false;
  int get length { print('length'); return data.length; }
  Iterable<Symbol> get keys => data.keys;
  dynamic operator [](Object? key) => data[key];
  void operator []=(Symbol key, dynamic value) { data[key] = value; }
  void clear() => data.clear();
  dynamic remove(Object? key) => data.remove(key);
  void forEach(void Function(Symbol, dynamic) callback) {
    print('forEach');
    if (stopped) throw 'stop';
    callback(#x, 9);
  }
}
void f({int x = 0}) { print(x); }
void main() {
  var args = Arguments();
  Function.apply(f, [], args);
  args.stopped = true;
  try { Function.apply(f, [], args); } catch (e) { print(e); }
  args.clear();
  Function.apply(f, [], args);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'length\nforEach\n9\nlength\nforEach\nstop\nlength\n0\n',
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
});

test('floating-point power uses the VM arithmetic and special values', () => {
  const source = `import 'dart:math';
void main() {
  print([pow(11 / 7, 3.0), pow(15 / 7, 3.0), pow(-0.0, 3.0), pow(-0.0, 0.5)]);
  print([pow(-double.infinity, 0.5), pow(1.0, double.nan), pow(double.nan, 0.0), pow(-1.0, double.infinity)]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[3.8804664723032065, 9.839650145772593, -0.0, 0.0]\n[Infinity, 1.0, 1.0, 1.0]\n',
  });
});

test('int.parse uses its VM error callback only for invalid numbers', () => {
  const source = `void main() {
  int fallback(String input) { print('fallback: <$input>'); return 42; }
  print(int.parse('3', onError: fallback));
  print(int.parse('bad', onError: fallback));
  print(int.parse('', radix: 1, onError: fallback));
  try { int.parse('bad', radix: 9223372036854775807, onError: fallback); } catch (e) { print(e); }
  print(int.parse('9223372036854775808', onError: fallback));
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '3\nfallback: <bad>\n42\nfallback: <>\n42\nRangeError: Radix 9223372036854775807 not in range 2..36\n' +
      'fallback: <9223372036854775808>\n42\n',
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

test('missing-method errors format their invocation only when printed', () => {
  const program = `class Receiver {
  Type get runtimeType { print('type'); return String; }
}
class Counted extends Invocation {
  Symbol get memberName { print('member'); return #missing; }
  List<Type> get typeArguments => [];
  List<dynamic> get positionalArguments => [];
  Map<Symbol, dynamic> get namedArguments => {};
  bool get isMethod => true;
  bool get isGetter => false;
  bool get isSetter => false;
  bool get isAccessor => false;
}
class Generic<T> {}
class Argument {
  String toString() { print('argument'); return 'changed'; }
}
void main() {
  final error = NoSuchMethodError.withInvocation(Receiver(), Counted());
  print('made'); print(error); print(error);
  try { dynamic receiver = Receiver(); receiver.missing(); }
  catch (e) { print('caught'); print(e); print(e); }
  try { dynamic value = Generic<int>(); value.missing(); }
  catch (e) { print(e); }
  dynamic f = (int x) => x;
  try { f(Argument(), 2); }
  catch (e) { print('closure'); print(e); print(e); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'made\n' +
      'member\ntype\nNoSuchMethodError: String has no missing method accepting arguments ()\n'.repeat(2) +
      'caught\n' +
      (
        "type\nNoSuchMethodError: Class 'String' has no instance method 'missing'.\n" +
        "Receiver: Instance of 'Receiver'\nTried calling: missing()\n"
      ).repeat(2) +
      "NoSuchMethodError: Class 'Generic<int>' has no instance method 'missing'.\n" +
      "Receiver: Instance of 'Generic<int>'\nTried calling: missing()\nclosure\n" +
      (
        "NoSuchMethodError: Closure call with mismatched arguments: function 'main.<anonymous closure>'\n" +
        "Receiver: Closure: (int) => int\nTried calling: main.<anonymous closure>(Instance of 'Argument', 2)\n" +
        'Found: main.<anonymous closure>(int) => int\n'
      ).repeat(2),
  });
});

test('failed calls bound the complete description of their arguments', () => {
  const program = `external void missing(String left, String right);
void bounded(void Function() call) {
  try { call(); } catch (error) {
    print(error.runtimeType);
    try { print(error.toString().length); } catch (formatting) { print(formatting.runtimeType); }
  }
}
void main() {
  final text = 'x' * 600000;
  dynamic object = Object();
  try { object.missing(1, z: 3, a: 2); } catch (error) { print(error); }
  bounded(() { object.missing(text, text); });
  bounded(() { object.missing(z: text, a: text); });
  dynamic f = () {};
  bounded(() { f(text, text); });
  bounded(() { missing(text, text); });
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "NoSuchMethodError: Class 'Object' has no instance method 'missing'.\nReceiver: Instance of 'Object'\nTried calling: missing(1, a: 2, z: 3)\n" +
      'NoSuchMethodError\nOutOfMemoryError\n'.repeat(4),
  });
});

test('unsupported SDK exports respect import prefixes and visibility', () => {
  for (const [declaration, body] of [
    ["import 'dart:convert';", 'print(JsonUtf8Encoder());'],
    ["import 'dart:convert' as codec show htmlEscape;", "print(codec.htmlEscape.convert('<'));"],
    ["import 'dart:collection' as collections;", 'collections.LinkedList<collections.LinkedListEntry>();'],
    ['', 'WeakReference<Object>? value; print(value);'],
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

test('specialized tear-offs print declared named parameters in declaration order', () => {
  const program = `T f<T>({int z = 0, required T a}) => a;
class C<T> { T f({int z = 0, required T a}) => a; }
void main() {
  print(f);
  print(f<int>);
  print(f<int>.runtimeType);
  print(C<int>().f.runtimeType);
  final closure = <T>({int z = 0, required T a}) => a;
  print(closure.runtimeType);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      "Closure: <Y0>({int z, required Y0 a}) => Y0 from Function 'f': static.",
      "Closure: ({int z, required int a}) => int from Function 'f': static.",
      '({int z, required int a}) => int',
      '({int z, required Object? a}) => int',
      '<Y0>({required Y0 a, int z}) => Y0',
      '',
    ].join('\n'),
  });
});

test('explicit generic tear-offs validate and reify their written arguments', () => {
  const declarations = `T identity<T>(T value) => value;
  T numeric<T extends num>(T value) => value;
  typedef Callback<T> = T Function(T);
  class Methods {
    T instance<T>(T value) => value;
    static T method<T>(T value) => value;
  }`;
  const program = `${declarations}
  const canonical = identity<int>;
  void main() {
    T local<T>(T value) => value;
    final T Function<T>(T) variable = identity;
    final object = Methods();
    final concrete = object.instance<String>;
    print([canonical(1), (local<int>)(2), (variable<int>)(3), concrete('hello'), (Methods.method<int>)(4)]);
    print([identical(canonical, identity<int>), concrete == object.instance<String>, concrete is String Function(String)]);
    print(Callback<int>);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2, 3, hello, 4]\n[true, true, true]\n(int) => int\n',
  });
  for (const expression of [
    'numeric<String>',
    'identity<int, int>',
    '((int n) => n)<int>',
    'maybe<int>',
    'dynamicFunction<int>',
    'Methods()?.instance<int>',
  ]) {
    const invalid = `${declarations} void main() {
      T Function<T>(T)? maybe;
      dynamic dynamicFunction = identity;
      print(${expression});
    }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('dynamic extension-type tear-offs check declaration defaults against specialized bounds', () => {
  const program = `extension type Box<T>(T value) {
    R f<R extends T>(R x) { print('body'); return x; }
  }
  extension type Pair<T>((T, T) value) {
    R f<R extends T>(R x) { print('body'); return x; }
  }
  extension type Reader<T>(T Function() read) {
    R f<R extends T>(R x) { print('body'); return x; }
  }
  extension type Bounded<T extends num>(T value) {
    R f<R extends List<T>>(R x) => x;
  }
  void main() {
    for (dynamic f in [Box<num>(1).f, Pair<num>((1, 2)).f, Reader<num>(() => 1).f]) {
      try { print(f(2)); } catch (e) { print(e); }
      try { print(Function.apply(f, [2])); } catch (e) { print(e); }
      print(f<int>(3));
    }
    dynamic generic = Bounded<int>(1).f;
    try { print(generic(<int>[2])); } catch (e) { print(e); }
    try { print(Function.apply(generic, [<int>[2]])); } catch (e) { print(e); }
    print(generic<List<int>>(<int>[2]));
    print(Function.apply(Bounded<int>(1).f<List<int>>, [<int>[2]]));
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      (
        "type 'dynamic' is not a subtype of type 'num' of 'R'\n" +
        "type '_Type' is not a subtype of type 'num' of 'R'\nbody\n3\n"
      ).repeat(3) +
      "type 'List<num>' is not a subtype of type 'List<int>' of 'R'\n" +
      "type '_Type' is not a subtype of type 'List<int>' of 'R'\n[2]\n[2]\n",
  });
});

test('extension-type method tear-offs keep the static signature on erased receivers', () => {
  const program = `extension type Box<T>(T value) { T echo(T value) => value; }
  extension type Pair<A, B>((A, B) value) {
    R describe<R>(R value) { print([A, B, R]); return value; }
    bool accepts(Object? value) => value is A;
  }
  extension type Swapped<A, B>(Pair<B, A> pair) implements Pair<B, A> {}
  extension type Reader<T>(T Function() read) { T value() => read(); }
  void main() {
    final primitive = Box<int>(1).echo;
    final record = Pair<int, int>((1, 2)).accepts;
    final inherited = Swapped<int, String>(Pair<String, int>(('x', 1))).describe<bool>;
    final function = Reader<int>(() => 3).value;
    print(primitive.runtimeType);
    print([record(1), record('x')]);
    print(inherited(true));
    print(function());
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '(int) => int\n[true, false]\n[String, int, bool]\ntrue\n3\n',
  });
});

test('null-aware selectors keep a nullable result on a non-null receiver', () => {
  const program = `class Methods { int use(int value) => value; int get count => 2; }
  void main() {
    final object = Methods();
    int assigned;
    int? result = object?.use(assigned = 1);
    print([result, assigned]);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 1]\n' });
  const invalid = program.replace('int? result', 'int result');
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
});

test('record fields use active positional getters and reject private or reserved names', () => {
  const program = `void main() {
    final record = (1, $0: 2, $01: 3, $2: 4);
    dynamic dynamicRecord = record;
    print([record.$1, record.$0, record.$01, record.$2, dynamicRecord.$2]);
    if (record case (var one, $0: var zero, $01: var zeroOne, $2: var two)) print([one, zero, zeroOne, two]);
    final (int, {String $2}) typed = (1, $2: 'a');
    print(typed.$2);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2, 3, 4, 4]\n[1, 2, 3, 4]\na\n',
  });
  for (const [source, name] of [
    ['print((_private: 1));', '_private'],
    ['({int _private}) value;', '_private'],
    ['print((1, $1: 2));', '$1'],
    ['(int, {int $1}) value;', '$1'],
    ['({int hashCode}) value;', 'hashCode'],
  ]) {
    const actual = executeProgram('dart', `void main() { ${source} }`);
    expect(actual.kind).toBe('compileError');
    if (actual.kind === 'compileError') expect(actual.diagnostics[0]?.message).toContain(name);
  }
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

test('named mixin applications forward generative constructors and keep declared class identity', () => {
  const program = `class Child extends Abstract<int> {
    Child({super.value}) : super.named(7);
  }
  abstract class Abstract<T extends num> = Base<T> with Empty<T>;
  class Concrete<T extends num> = Base<T> with Empty<T>, Fields<T> implements HasName;
  abstract class HasName { String get name; }
  mixin Empty<T extends num> {
    Type get item => T;
  }
  mixin Fields<T extends num> {
    final name = 'mixed';
    final items = <T>[];
  }
  class Base<T extends num> {
    final int number;
    final int value;
    const Base.named(this.number, {this.value = 11});
    factory Base.onlyFactory() => Base.named(1);
  }
  class Constant = Base<int> with Empty<int>;
  void main() {
    final direct = Concrete<double>.named(5);
    final child = Child();
    print([direct.runtimeType, direct.item, direct.name, direct.items.runtimeType, direct.value]);
    print([child.number, child.value, child.item]);
    print(identical(const Constant.named(1), const Constant.named(1)));
    final make = Concrete<int>.named;
    print(make(3, value: 13).value);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[Concrete<double>, double, mixed, List<double>, 11]\n[7, 11, int]\ntrue\n13\n',
  });
  for (const expression of ['Abstract<int>.named(1)', 'Concrete<int>.onlyFactory()', 'const Concrete<int>.named(1)']) {
    const invalid = program.replace(
      'final direct = Concrete<double>.named(5);',
      `print(${expression});\n    final direct = Concrete<double>.named(5);`
    );
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
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

test('overrides infer argument and result types in their own method parameter scope', () => {
  const program = `class A<T> {
  X f<X extends T>(X x) => x;
  X g<X extends T>({required X x}) => x;
  T Function(T) get callback => (x) => x;
  set sink(T Function(T) callback) { print(callback(value)); }
  final T value;
  A(this.value);
}
class B extends A<num> {
  B(): super(0);
  S f<S extends num>(x) => x;
  g<S extends num>({required x}) => x;
  get callback => (num x) => x + 1;
  set sink(callback) { print(callback(3)); }
}
void main() {
  final b = B();
  print([b.f<int>(1), b.g<double>(x: 2.5), b.callback(4)]);
  b.sink = (num x) => x * 2;
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[1, 2.5, 5]\n6\n',
  });
});

test('omitted override types use the combined inherited signature', () => {
  const program = `abstract class A<T> {
  void f(T x);
  num get x;
  set value(int x);
}
abstract class B<T> {
  void f(T x);
  int get x;
  set value(num x);
}
class C implements A<int>, B<num> {
  void f(x) { print(x); }
  get x => 1;
  set value(x) { print(x); }
}
class D implements B<num>, A<int> {
  void f(x) { print(x); }
  var x = 2;
  set value(x) { print(x); }
}
void main() {
  final c = C();
  c.f(1.5);
  c.value = 2.5;
  int a = c.x;
  final d = D();
  int b = d.x;
  d.f(3.5);
  print([a, b]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1.5\n2.5\n3.5\n[1, 2]\n',
  });
  const ambiguous = `abstract class A { void f(int x); }
abstract class B { void f(String x); }
class C implements A, B { void f(x) { print(x); } }
void main() { C().f(1); }`;
  expect(executeProgram('dart', ambiguous)).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('dart', ambiguous.replace('void f(x)', 'void f(Object x)'))).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
  });
});

test('extensions reject conflicting Object member names and allow other names', () => {
  for (const declaration of [
    "extension E on int { String toString() => 'custom'; }",
    'extension E on int { int get hashCode => 1; }',
    'extension E on int { static int hashCode = 1; }',
    'extension E on int { bool operator ==(Object x) => true; }',
    'extension type E(int value) { set runtimeType(Type x) {} }',
    "extension type E(int value) { static String toString() => 'custom'; }",
    'extension type E(int hashCode) {}',
  ]) {
    const result = executeProgram('dart', `${declaration} void main() {}`);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain('Object のメンバー');
  }
  const valid = `extension E on int { static int hash(Object? x) => 1; }
extension type View(int i) { static int hash(Object? x) => 2; View.toString() : i = 1; }
void main() { print([E.hash(null), View.hash(null), View.toString().i]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[1, 2, 1]\n' });
});

test('unused constructor redirects reject cycles and abstract generative targets', () => {
  for (const declarations of [
    'class A { factory A() = B; } abstract class B implements A { B(); }',
    'class A { factory A() = A.named; factory A.named() = A; }',
    'class A { A() : this.named(); A.named() : this(); }',
    'class A { A() : this(); }',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() { print('ready'); }`)).toMatchObject({
      kind: 'compileError',
    });
  }
  const valid = `class A { factory A() = B; }
abstract class B implements A { factory B() = C; }
class C implements B { C(); }
class D {
  int value;
  D() : this.other();
  D.other() : this.last(3);
  D.last(this.value);
}
void main() { print([A().runtimeType, D().value]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[C, 3]\n',
  });
});

test('specialized enum switches cover only constants that can inhabit the subject type', () => {
  const program = `enum E<T> {
  a(1), b<String>('text'), c(2.5);
  const E(this.value);
  final T value;
}
int exact(E<int> x) => switch (x) { E.a => 1 };
int statement(E<String> x) { switch (x) { case E.b: return 2; } }
int bounded<T extends num>(E<T> x) => switch (x) { E.a => 1, E.c => 3 };
int any<T>(E<T> x) => switch (x) { E.a => 1, E.b => 2, E.c => 3 };
int nested((E<int>?, bool) x) => switch (x) { (E.a, _) => 1, (null, _) => 0 };
int typed<T extends num>(E<T> x) => switch (x) { E<int>() || E<double>() => 4 };
void main() {
  print([exact(E.a), statement(E.b), bounded(E.c), any(E.a), any(E.b),
    nested((E.a, true)), nested((null, false)), typed(E.c)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[1, 2, 3, 1, 2, 1, 0, 4]\n',
  });
  const incomplete = program.replace('E.a => 1, E.c => 3', 'E.a => 1');
  const result = executeProgram('dart', incomplete);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain('E.c');
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

test('bodyless methods can leave optional defaults to the implementation', () => {
  const program = `abstract class Shape {
  double area({int scale});
}
class Square implements Shape {
  double area({int scale = 1}) => 4.0 * scale;
}
mixin Operation { int apply([int count]); }
class External { external void run({int count}); }
void main() {
  Shape shape = Square();
  print([shape.area(), shape.area(scale: 3)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[4.0, 12.0]\n' });
  expect(executeProgram('dart', program.replace('scale = 1', 'scale'))).toMatchObject({ kind: 'compileError' });
});

test('optional parameter defaults require explicit const for collections and constructors', () => {
  const declaration = 'class A { const A(); }';
  for (const expression of ['<int>[]', '<int, int>{}', 'A()', '(1, [2])']) {
    expect(
      executeProgram('dart', `${declaration} void use([Object value = ${expression}]) {} void main() {}`)
    ).toMatchObject({
      kind: 'compileError',
    });
  }
  const program = `${declaration}
void use([Object list = const <int>[], Object object = const A(), Object record = (1, 2)]) {
  print([list, object.runtimeType, record, identical(record, const (1, 2))]);
}
void main() { use(); }`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[[], A, (1, 2), true]\n' });
});

test('prefixed Null types reject type arguments', () => {
  const source = "import 'dart:core' as c; void main() { c.Null value = null; c.print(value); }";
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: 'null\n' });
  expect(executeProgram('dart', source.replace('c.Null value', 'c.Null<c.int> value'))).toMatchObject({
    kind: 'compileError',
  });
});

test('type tests reject void operands before execution', () => {
  for (const comparison of ['is Object', 'is! Null']) {
    const program = `void main() { if (print('operand') ${comparison}) print('matched'); }`;
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

test('a Unicode regular expression matches the text RegExp.escape escaped', () => {
  const program = `void main() {
  var literal = RegExp.escape('a-b/c');
  print([literal, RegExp(literal, unicode: true).hasMatch('a-b/c')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[a-b/c, true]\n',
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

test('Dart arithmetic supplies a double context to the right operand of int operators', () => {
  const program = `double area(int side) => side * 2 - 1;
double take(double value) => value;
class Box { final double size; Box(int n) : size = n * 2; }
void main() {
  int n = 3;
  double sum = 1 + 2;
  double product = n * 2;
  double nested = 2 * 3 + 1;
  double modulo = n % 2;
  double? optional = n == 3 ? n * 2 : n + 1;
  final List<double> values = [n * 2, n + 1];
  double Function() f = () => n * 2;
  double quotient = n / 9007199254740993;
  print([sum, product, nested, modulo, optional, values, area(n), take(1 + 2), f(), Box(n).size, quotient]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[3.0, 6.0, 7.0, 1.0, 6.0, [6.0, 4.0], 5.0, 3.0, 6.0, 6.0, 3.3306690738754696e-16]\n',
  });
  for (const expression of ['1 + n', 'n + 9007199254740993', 'n << 2']) {
    const invalid = `void main() { int n = 3; double d = ${expression}; print(d); }`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart types FutureOr and nullable types by their normal form', async () => {
  // Expected output from Dart SDK 3.13.7: a FutureOr of a top type or of Object is that type, and a nullable FutureOr
  // of a nullable type is the FutureOr itself, in upper bounds, awaits, and async returns.
  const program = `import 'dart:async';
T id<T>(T t) => t;
FutureOr<int?> f1() async => null;
FutureOr<Object> f2() async => 2;
Future<void> main() async {
  print([true ? id<FutureOr<int?>>(1) : id<int?>(2)].runtimeType);
  print([true ? id<FutureOr<int>>(1) : id<String>('s')].runtimeType);
  print([true ? id<FutureOr<int>?>(1) : id<String>('s')].runtimeType);
  print([true ? id<FutureOr<int>>(1) : id<double>(2)].runtimeType);
  print([true ? id<FutureOr<Object>>(1) : id<int?>(2)].runtimeType);
  print([await id<FutureOr<int?>>(null)].runtimeType);
  print(await f1());
  print(await f2());
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'List<FutureOr<int?>>\nList<Object>\nList<Object?>\nList<FutureOr<num>>\nList<Object?>\nList<int?>\nnull\n2\n',
  });
  const literal = 'import "dart:async"; void main() { Future<int>? Function() f = () async {}; print(f); }';
  expect(executeProgram('dart', literal)).toMatchObject({ kind: 'compileError' });
});

test('Dart num arithmetic returns double from a double operand or contextual literal', () => {
  const program = `double twice(num value) => value * 2;
void examples(num value, double fraction) {
  double sum = value + 1;
  double diff = value - 1;
  double mod = value % 2;
  double nested = value * 2.0 + 1;
  final inferred = value + fraction;
  double typed = inferred;
  List<double> values = [value * fraction, value - fraction, value % fraction];
  print([sum, diff, mod, nested, typed, values, twice(value)]);
}
void main() {
  examples(3, 1.5);
  Object value = 3;
  if (value is num) {
    double result = value.abs() * 2;
    print(result);
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '[4.0, 2.0, 1.0, 7.0, 4.5, [4.5, 1.5, 0.0], 6.0]\n6.0\n',
  });
  const invalid = 'void f(num value, int other) { double result = value * other; } void main() {}';
  expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
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
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '74\n24\n1\n1\n' });
  const wide = `void main() {
    final modulus = (BigInt.one << 1000000) - BigInt.from(3);
    final base = (BigInt.one << 999999) + BigInt.from(123);
    final exponent = (BigInt.one << 128) - BigInt.one;
    print(base.modPow(exponent, modulus));
  }`;
  expect(executeProgram('dart', wide)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test('BigInt Euclidean operations charge the operands and preserve inverse errors', () => {
  const source = `void main() {
  final n = BigInt.one << 400000;
  print([n.gcd(BigInt.zero).bitLength, n.gcd(BigInt.one), n.modInverse(BigInt.one)]);
  print([n.gcd(BigInt.from(12)), n.modInverse(BigInt.from(7)), BigInt.from(-5).modInverse(BigInt.from(11))]);
  for (final m in [BigInt.zero, BigInt.from(-3), BigInt.two]) {
    try { print(BigInt.zero.modInverse(m)); } catch (e) { print(e); print(e.runtimeType); }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[400001, 1, 0]\n[4, 4, 2]\n' +
      'Invalid argument(s): Modulus must be strictly positive: 0\nArgumentError\n' +
      'Invalid argument(s): Modulus must be strictly positive: -3\nArgumentError\nException: Not coprime\n_Exception\n',
  });
});

test('BigInt radix formatting and parsing use their SDK error labels', () => {
  const program = `void show(Object? Function() run) { try { print(run()); } catch (e) { print(e); } }
void main() {
  show(() => BigInt.from(1).toRadixString(37));
  show(() => BigInt.one.toRadixString(1));
  show(() => BigInt.parse('1', radix: 37));
  show(() => BigInt.tryParse('1', radix: 37));
  show(() => 1.toRadixString(37));
  show(() => BigInt.from(31).toRadixString(16));
  show(() => BigInt.parse('1f', radix: 16));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'RangeError: Invalid value: Not in inclusive range 2..36: 37\n' +
      'RangeError: Invalid value: Not in inclusive range 2..36: 1\n' +
      'RangeError (radix): Invalid value: Not in inclusive range 2..36: 37\n'.repeat(3) +
      '1f\n31\n',
  });
});

test('BigInt parsing checks literal syntax before validating the radix', () => {
  const program = `void main() {
    for (final text in ['', ' ', '+', 'a?', '- 2']) {
      print(BigInt.tryParse(text, radix: 1));
      try { BigInt.parse(text, radix: 37); } catch (error) { print(error.runtimeType); }
    }
    try { BigInt.tryParse('a', radix: 1); } catch (error) { print(error.runtimeType); }
    try { BigInt.parse('0x', radix: 37); } catch (error) { print(error.runtimeType); }
    print([BigInt.parse(' +101 ', radix: 2), BigInt.parse('z', radix: 36), BigInt.tryParse('2', radix: 2)]);
  }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'null\nFormatException\n'.repeat(5) + 'RangeError\nRangeError\n[5, 35, null]\n',
  });
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
    print([StackTrace.empty.runtimeType, StackTrace.empty.toString()]);
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
    stdout: '[_StringStackTrace, ]\ntrue\ntrue\ntrue\n[true, true]\n[true, true]\ntrue\n',
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

test('negative growable list lengths report the rejected backing capacity', () => {
  const program = `void main() {
  for (final write in <void Function()>[
    () { final list = [1]; list.length = -2; },
    () => List<int>.generate(-2, (i) { print('unexpected'); return i; }),
    () => List<int>.filled(-100, 0, growable: true),
    () { final list = [1]; list.length = -3; },
    () => List<int>.filled(-2, 0),
    () => List<int>.generate(-4, (i) => i, growable: false),
  ]) {
    try { write(); } catch (e) { print(e); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: [-1, -1, -99, -3, -2, -4]
      .map((value) => `RangeError (length): Invalid value: Not in inclusive range 0..576460752303423487: ${value}\n`)
      .join(''),
  });
});

test('Dart iterable skip and take report their SDK validation labels', () => {
  const program = `void main() {
  for (final values in <Iterable<int>>[
    {1, 2}, {1: 2}.keys, [1, 2].where((i) => i > 0),
    [1, 2].expand((i) => [i]), 'dart'.runes, [1, 2], [1, 2].skip(1),
  ]) {
    try { values.skip(-1); } catch (e) { print(e); }
  }
  try { ({1, 2}).take(-1); } catch (e) { print(e); }
  print({1, 2, 3}.skip(1).toList());
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'RangeError (count): Invalid value: Not greater than or equal to 0: -1\n'.repeat(5) +
      'RangeError (start): Invalid value: Not greater than or equal to 0: -1\n' +
      'RangeError (count): Invalid value: Not greater than or equal to 0: -1\n' +
      'RangeError (takeCount): Invalid value: Not greater than or equal to 0: -1\n[2, 3]\n',
  });
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

test('nullable branches promote values only on their executed paths', () => {
  const source = `int? key() => 1;
void main() {
  int? x = key();
  print({?x: x.isEven});
  x ?? (throw StateError('null'));
  print(x.isOdd);
  String? s;
  s ?? (s = 'dart');
  print(s.length);
}
void check(String? text) { assert(text == null, text.length); }
class C { C(String? text) : assert(text == null, text.length); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '{1: false}\ntrue\n4\n' });
  for (const invalid of [
    'int? key() => null; void main() { int value; print({?key(): (value = 1)}); print(value); }',
    'void f<T extends Map<int, int>?>(T map) { print({...map}); } void main() {}',
    'class A { int get n => 1; } class B extends A { int get n => super?.n; } void main() {}',
    'class D extends Duration { D() : super._microseconds(3); } void main() {}',
  ]) {
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
  const bounds = `int add<T extends U, U extends int>(T x) => x + 1;
void show<T extends Map<int, int>?>(T x) { print({...?x}); }
void main() { print(add<int, int>(2)); show<Map<int, int>?>(null); show({1: 2}); }`;
  expect(executeProgram('dart', bounds)).toMatchObject({ kind: 'executed', stdout: '3\n{}\n{1: 2}\n' });
});

test('non-null promotions retain generic identity through nullable bounds', () => {
  const source = `void check<T>(T? value) { if (value != null) throw value; }
void printEven<T extends U, U extends int?>(T value) {
  value ?? (throw StateError('null'));
  print(value.isEven);
}
void printMap<T extends int?>(T? value) { print({?value: value.isEven}); }
void main() {
  try { check(2); } catch (error) { print(error); }
  printEven<int, int?>(2);
  printMap<int?>(2);
  printMap<int?>(null);
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '2\ntrue\n{2: true}\n{}\n' });

  for (const type of ['T extends dynamic', 'T extends Null', 'T extends U, U extends dynamic']) {
    const checked = `void check<${type}>(T? value) { if (value != null) throw value; } void main() {}`;
    const coalesced = `void check<${type}>(T? value) { value ?? (throw 1); throw value; } void main() {}`;
    expect(executeProgram('dart', checked)).toMatchObject({ kind: 'compileError' });
    expect(executeProgram('dart', coalesced)).toMatchObject({ kind: 'compileError' });
  }
  const asserted = `Never direct<T extends Null>(T? value) => throw value!;
Never dependent<T extends U, U extends Null>(T? value) { value!; throw value; }
void main() {
  try { direct(null); } catch (error) { print(error.runtimeType); }
  try { dependent<Null, Null>(null); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', asserted)).toMatchObject({ kind: 'executed', stdout: '_TypeError\n_TypeError\n' });
});

test('an asserted Null-bound receiver permits unreachable selectors and operators', () => {
  for (const expression of ['value!.missing', 'value!.missing()', 'value![0]', 'value!()', 'value! + 1', '-value!']) {
    const source = `Object check<T extends Null>(T? value) => ${expression};
void main() { try { check(null); } catch (error) { print(error.runtimeType); } }`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '_TypeError\n' });
  }
  for (const statement of ['value!.missing = 2', 'value![0]++']) {
    const source = `void check<T extends Null>(T? value) { ${statement}; }
void main() { try { check(null); } catch (error) { print(error.runtimeType); } }`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '_TypeError\n' });
  }
});

test('super rejects null-aware property writes and accepts null-aware indexing', () => {
  for (const operation of ['super?.x = 2', 'super?.x += 1', 'super?.x++', '++super?.x']) {
    const source = `class A { int x = 1; } class B extends A { void run() { ${operation}; } } void main() {}`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const source = `class A {
  int value = 1;
  int operator [](int i) => value;
  void operator []=(int i, int next) { value = next; }
}
class B extends A {
  void run() {
    print(super?[0]);
    super?[0] = 2;
    super?[0] += 3;
    print(super?[0]++);
    print(super?[0]);
  }
}
void main() { B().run(); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '1\n5\n6\n' });
});

test('super delegation uses the originating library of a forwarded constructor', () => {
  const aliases = `mixin M {}
mixin N {}
class D = Duration with M;
class F = D with N;`;
  for (const name of ['D', 'F']) {
    const source = `${aliases} class E extends ${name} { E() : super._microseconds(3); } void main() {}`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const direct = `${aliases} void main() { print(D._microseconds(3).inMicroseconds); }`;
  expect(executeProgram('dart', direct)).toMatchObject({ kind: 'executed', stdout: '3\n' });
  const sameLibrary = `class A { A._private(); }
mixin M {}
class B = A with M;
class C extends B { C() : super._private(); }
void main() { print(C().runtimeType); }`;
  expect(executeProgram('dart', sameLibrary)).toMatchObject({ kind: 'executed', stdout: 'C\n' });
});

test('const constructors delegate only to const constructors', () => {
  for (const declaration of [
    'class E extends Error { const E(); }',
    "class E extends ArgumentError { const E() : super('message'); }",
    'abstract class A { const factory A() = B; } class B implements A { B(); }',
  ]) {
    expect(executeProgram('dart', `${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const source = `import 'dart:collection';
abstract class L extends ListBase<int> { const L(); }
abstract class M extends MapBase<int, int> { const M(); }
abstract class S extends SetBase<int> { const S(); }
class D extends Duration { const D() : super(seconds: 1); }
void main() { print(const D().inSeconds); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '1\n' });
});

test('static method calls respect the declaring library through aliases', () => {
  for (const source of [
    "void main() { print(Error._safeToString('hello')); }",
    "typedef Alias = Error; void main() { print(Alias._safeToString('hello')); }",
    'void main() { print(Object._smear(1)); }',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const source = `class C { static C _make() => C(); }
typedef Alias = C;
void main() {
  C value = ._make();
  print([value.runtimeType, Alias._make().runtimeType, Error.safeToString('hello')]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[C, C, "hello"]\n' });
});

test('qualified writes update extension static fields and accessors', () => {
  const source = `extension Counter on String {
  static int count = 0;
  static int get twice => count * 2;
  static set twice(int value) { count = value ~/ 2; }
  static void increase() { twice += 2; }
}
void main() {
  Counter.count = 3;
  print(Counter.count++);
  Counter.twice += 2;
  Counter.increase();
  print([Counter.count, Counter.twice]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '3\n[6, 12]\n' });
});

test('generic result contexts combine covariant and contravariant positions', () => {
  const source = `Map<T, T> makeMap<T>() => {};
(List<T>, Set<T>) makePair<T>() => (<T>[], <T>{});
void Function(T) callback<T>() => (T value) => print(value);
void Function({required T value}) namedCallback<T>() => ({required T value}) => print(value);
void main() {
  Map<int, String> map = makeMap();
  (List<int>, Set<String>) pair = makePair();
  print(map.runtimeType);
  print(pair.runtimeType);
  void Function(int) typed = callback();
  void Function({required String value}) named = namedCallback();
  dynamic a = typed;
  dynamic b = named;
  try { a('bad'); } catch (error) { print(error.runtimeType); }
  try { b(value: 1); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '_Map<Never, Never>\n(List<Never>, _Set<Never>)\n_TypeError\n_TypeError\n',
  });
});

test('collection import combinators expose the SDK iterable extensions', () => {
  const source = `import 'dart:core' hide IterableExtensions, NullableIterableExtensions;
import 'dart:collection' show IterableExtensions, NullableIterableExtensions;
void main() { print([1].firstOrNull); print([1, null, 2].nonNulls.toList()); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '1\n[1, 2]\n' });
  expect(
    executeProgram('dart', source.replace('show IterableExtensions, NullableIterableExtensions', 'show ListBase'))
  ).toMatchObject({ kind: 'compileError' });
});

test('symbols keep the public interface separate from the VM representation', () => {
  const source = `class Custom implements Symbol {
  String toString() => 'custom';
}
class Missing {
  dynamic noSuchMethod(Invocation invocation) =>
      invocation.memberName == Symbol.unaryMinus ? 42 : super.noSuchMethod(invocation);
}
void main() {
  print(Custom());
  print((-(Missing() as dynamic)));
  print(Symbol.empty);
  print(identical(Symbol.empty, const Symbol('')));
  print(Symbol('text').runtimeType);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'custom\n42\nSymbol("")\ntrue\nSymbol\n',
  });
  expect(
    executeProgram('dart', "class Invalid extends Symbol { Invalid() : super('x'); } void main() {}")
  ).toMatchObject({
    kind: 'compileError',
  });
});

test('codec byte lists wrap writes and code units remain an unmodifiable view', () => {
  const source = `import 'dart:convert';
void main() {
  var bytes = utf8.encode('abc');
  bytes[0] = 256;
  bytes.setRange(1, 3, [-1, 257]);
  var decoded = base64.decode('YQ==');
  decoded[0] = -1;
  print([bytes, bytes.runtimeType, decoded, decoded.runtimeType]);
  var units = 'x' * 1000000;
  print([units.codeUnits.length, units.codeUnits.first, '😀'.codeUnits]);
  try { units.codeUnits[0] = 1; } catch (error) { print(error); }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[[0, 255, 1], Uint8List, [255], Uint8List]\n[1000000, 120, [55357, 56832]]\nUnsupported operation: Cannot modify an unmodifiable list\n',
  });
});

test('packed lists preserve SDK copy results and mutation restrictions', () => {
  const source = `import 'dart:convert';
void main() {
  final bytes = utf8.encode('ab');
  final slice = bytes.sublist(0);
  final concatenated = bytes + bytes;
  slice[0] = -1;
  concatenated[0] = 300;
  print([slice.runtimeType, slice, bytes, concatenated.runtimeType, concatenated]);
  for (final list in [bytes, 'ab'.codeUnits]) {
    try { list.removeWhere((value) { print(value); return false; }); } catch (error) { print(error); }
    try { list.addAll([]); } catch (error) { print(error); }
    try { list.setAll(0, []); } catch (error) { print(error); }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[Uint8List, [255, 98], [97, 98], List<int>, [300, 98, 97, 98]]\n' +
      'Unsupported operation: Cannot remove from a fixed-length list\n' +
      'Unsupported operation: Cannot add to a fixed-length list\n' +
      'Unsupported operation: Cannot remove from an unmodifiable list\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      'Unsupported operation: Cannot modify an unmodifiable list\n',
  });
});

test('codec byte lists preserve source evaluation order for mapping and bulk writes', () => {
  const source = `import 'dart:convert';
Iterable<int> values() sync* { yield 1; throw 'oops'; }
void main() {
  final bytes = utf8.encode('AB');
  try { bytes.setAll(0, values()); } catch (error) { print(bytes); }
  try { bytes.setRange(0, 0, <int>[], -1); } catch (error) { print(error.runtimeType); }
  try { bytes.setRange(0, 0, values()); } catch (error) { print(error); }
  bytes.fillRange(0, 0);
  try { bytes.fillRange(0, 1); } catch (error) { print(error.runtimeType); }
  try { bytes.fillRange(-1, 2); } catch (error) { print(error.runtimeType); }
  print(bytes.map((value) { print(value); return value; }).skip(1).first);
  try { bytes.map((value) { if (value == 65) throw 'skipped'; return value; }).skip(1).first; }
  catch (error) { print(error); }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[65, 66]\nRangeError\noops\nArgumentError\nRangeError\n65\n66\n66\nskipped\n',
  });
});

test('codec byte list search tear-offs enforce their reified element type', () => {
  const source = `import 'dart:convert';
void main() {
  List<num> data = utf8.encode('ABA');
  for (final find in [data.indexOf, data.lastIndexOf]) {
    print(find(65));
    try { print(find(65.0)); } catch (error) { print(error.runtimeType); }
  }
  dynamic bytes = data;
  print(bytes.getRange(1).toList());
  print(base64.decode('QUI=').getRange(1).toList());
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '0\n_TypeError\n2\n_TypeError\n[66, 65]\n[66]\n',
  });
});

test('ListQueue commits the tail and invalidates iterators only after a list copy finishes', () => {
  const source = `import 'dart:collection';
class Source extends ListBase<int> {
  int get length { print('length'); return 2; }
  set length(int value) {}
  int operator [](int index) {
    print('read ' + index.toString());
    if (index == 1) throw 'bad';
    return 7;
  }
  void operator []=(int index, int value) {}
}
void main() {
  final queue = ListQueue<int>()..add(3);
  final before = queue.iterator;
  try { queue.addAll(Source()); } catch (_) { print(queue); }
  print(before.moveNext());
  queue.addAll(<int>[]);
  try { before.moveNext(); } catch (error) { print(error.runtimeType); }

  final wrapped = ListQueue<int>.of([0, 1, 2, 3, 4, 5, 6]);
  for (var i = 0; i < 5; i++) wrapped.removeFirst();
  try { wrapped.addAll(Source()); } catch (_) { print(wrapped); }
  wrapped.addAll([7, 8, 9, 10]);
  wrapped.addFirst(4);
  print(wrapped);
  wrapped.addAll([11, 12, 13, 14]);
  wrapped.removeWhere((value) => value.isEven);
  print(wrapped.toList());
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'length\nread 1\n{3}\ntrue\nConcurrentModificationError\n' +
      'length\nread 0\nread 1\n{5, 6}\n{4, 5, 6, 7, 8, 9, 10}\n[5, 7, 9, 11, 13]\n',
  });
});

test('cast views preserve source reads and reject immutable writes before callbacks', () => {
  const source = `void main() {
  final view = <Object>{1, 'ok'}.cast<String>();
  print([view.last, view.elementAt(1), view.toString(), view.contains(1)]);
  try { print(view.first); } catch (e) { print(e.runtimeType); }
  final set = const <int>{1}.cast<num>();
  final list = const <int>[1].cast<num>();
  final map = const <int,int>{1:2}.cast<num,num>();
  for (final action in <void Function()>[
    () => set.removeWhere((x) { print('called'); return false; }),
    () => list.addAll(const []),
    () => list.setRange(0, 0, const []),
    () => map.addAll(const {}),
    () => map.update(1, (x) { print('called'); return x; }),
    () => const <int,int>{}.updateAll((k,v) => v),
    () => const <int,int>{}.addEntries(const []),
  ]) {
    try { action(); print('completed'); } catch (e) { print(e.runtimeType); }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[ok, ok, {1, ok}, true]\n_TypeError\n' + 'UnsupportedError\n'.repeat(7),
  });
});

test('queue casts remain live and enforce both directions of type checking', () => {
  const source = `import 'dart:collection';
void main() {
  final source = ListQueue<num>()..addAll([1, 2.5]);
  final Queue<int> view = source.cast<int>();
  view.addFirst(0);
  view.addLast(3);
  try { print(view.elementAt(2)); } catch (e) { print(e.runtimeType); }
  print(view.remove(2.5));
  print([view, view.removeFirst(), source]);
  final ints = ListQueue<int>()..add(1);
  final wide = Queue.castFrom<int, num>(ints);
  try { wide.addAll([2, 3.5, 4]); } catch (e) { print(e.runtimeType); }
  print(ints);
  print(wide.cast<int>().removeLast());
  print(ints);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '_TypeError\ntrue\n[{1, 3}, 0, {1, 3}]\n_TypeError\n{1, 2}\n2\n{1}\n',
  });
});

test('linked queue entries expose live links and retain detached element behavior', () => {
  const source = `import 'dart:collection';
void main() {
  final q = DoubleLinkedQueue<int>()..addAll([1, 2, 3]);
  final DoubleLinkedQueueEntry<int> first = q.firstEntry()!;
  final last = q.lastEntry()!;
  first.element = 4;
  first.append(5);
  last.prepend(6);
  print([first.previousEntry(), last.nextEntry(), first.nextEntry()!.element, last.previousEntry()!.element]);
  print(q);
  q.forEachEntry((entry) {
    if (entry.element == 4) { entry.append(7); entry.remove(); }
    print(entry.element);
  });
  print([q, q.length, first.nextEntry()]);
  first.append(8);
  print([q, first.nextEntry()!.element]);
  q.clear();
  print([q.firstEntry(), q.lastEntry(), last.nextEntry(), last.remove()]);
  final standalone = DoubleLinkedQueueEntry<int>(9)..append(10);
  print(standalone.nextEntry()!.element);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[null, null, 5, 6]\n{4, 5, 2, 6, 3}\n4\n5\n2\n6\n3\n' +
      '[{7, 5, 2, 6, 3}, 5, null]\n[{7, 5, 2, 6, 3}, 8]\n[null, null, null, 3]\n10\n',
  });
});

test('pattern start errors use the SDK argument labels', () => {
  const program = `void main() {
  for (final start in [-1, 5]) {
    try { RegExp('a').allMatches('xyz', start); } catch (e) { print(e); }
    try { RegExp('a').matchAsPrefix('xyz', start); } catch (e) { print(e); }
    try { 'a'.matchAsPrefix('xyz', start); } catch (e) { print(e); }
    try { 'a'.allMatches('xyz', start); } catch (e) { print(e); }
  }
  print(RegExp('').matchAsPrefix('xyz', 3)?.start);
  print(''.matchAsPrefix('xyz', 3)?.start);
}`;
  const expected = [-1, 5].map((start) => {
    const message = `Invalid value: Not in inclusive range 0..3: ${start}\n`;
    return `RangeError: ${message}`.repeat(3) + `RangeError (start): ${message}`;
  });
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: expected.join('') + '3\n3\n' });
});

test('regex group names use a fresh ordered set or the canonical empty list', () => {
  const source = `void main() {
  final match = RegExp(r'(?<first>a)(?<second>b)').firstMatch('ab')!;
  print(match.groupNames);
  final names = match.groupNames as Set<String>;
  names.add('third');
  print(names);
  print(match.groupNames);
  print([match[1], match.namedGroup('second')]);
  final empty = RegExp('a').firstMatch('a')!.groupNames;
  print(identical(empty, const <String>[]));
  try { (empty as List<String>).add('invalid'); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '{first, second}\n{first, second, third}\n{first, second}\n[a, b]\ntrue\nUnsupportedError\n',
  });
});

test('string pattern calls preserve omitted starts and explicit zero', () => {
  const source = `class PatternWithDefault implements Pattern {
  Iterable<Match> allMatches(String text, [int start = 1]) {
    print(start);
    return 'a'.allMatches(text, start);
  }
  Match? matchAsPrefix(String text, [int start = 0]) => null;
}
void main() {
  final pattern = PatternWithDefault();
  print('aa'.replaceFirst(pattern, 'b'));
  print('aaa'.replaceFirst(pattern, 'b', 2));
  print('aa'.replaceFirstMapped(pattern, (_) => 'b'));
  print('aa'.replaceAll(pattern, 'b'));
  print('aa'.replaceAllMapped(pattern, (_) => 'b'));
  print('aa'.split(pattern));
  print('aa'.splitMapJoin(pattern, onMatch: (_) => 'b'));
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\nab\n2\naab\n0\nba\n1\nab\n1\nab\n1\n[a, ]\n1\nab\n',
  });
});

test('StringBuffer meters appends and preserves snapshots across writes and clear', () => {
  const source = `void main() {
  final buffer = StringBuffer();
  for (var i = 0; i < 50000; i++) buffer.write('x');
  print(buffer.length);
  final snapshot = buffer.toString();
  buffer.write('');
  buffer.writeln('end');
  print([snapshot.length, buffer.length, buffer.toString().endsWith('end\\n')]);
  try { buffer.write('x' * 1000000); } catch (error) { print(error.runtimeType); }
  print(buffer.length);
  buffer.clear();
  print([buffer.isEmpty, buffer.toString(), snapshot.length]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '50000\n[50000, 50004, true]\nOutOfMemoryError\n50004\n[true, , 50000]\n',
  });
});

test('SDK class defaults dispatch through overrides on learner subclasses', () => {
  const source = `class Shift extends Duration {
  final int shift;
  const Shift(this.shift) : super();
  int get inMicroseconds => shift;
}
class Calls extends Invocation {
  Symbol get memberName => #call;
  List<dynamic> get positionalArguments => [];
  Map<Symbol, dynamic> get namedArguments => {};
  bool get isMethod => false;
  bool get isGetter => true;
  bool get isSetter => false;
}
class UpperBuffer extends StringBuffer {
  UpperBuffer() : super('hi');
  int get length => 0;
  void write(Object? x) => super.write(x.toString().toUpperCase());
}
void main() {
  const shifted = Shift(5000000);
  const five = Duration(seconds: 5);
  print([shifted.inSeconds, (shifted + const Duration(seconds: 1)).inSeconds, (five + shifted).inSeconds]);
  print([shifted == five, shifted.hashCode == five.hashCode, shifted.compareTo(five), identical(shifted, shifted.abs())]);
  print([const Shift(-5000000).abs().inSeconds, const Shift(-5000000).isNegative]);
  final invocation = Calls();
  print([invocation.isAccessor, identical(invocation.typeArguments, const <Type>[])]);
  final buffer = UpperBuffer();
  print([buffer.isEmpty, buffer.isNotEmpty, buffer.toString()]);
  buffer.writeln('ok');
  print(buffer.toString().codeUnits);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[5, 6, 10]\n[true, true, 0, true]\n[5, true]\n[true, true]\n[true, false, HI]\n[72, 73, 79, 75, 10]\n',
  });
});

test('raw object patterns use a matched instance or instantiate to bounds', () => {
  const source = `class Box<T extends num> { final T value; Box(this.value); }
class TextBox<T extends String> { final T value; TextBox(this.value); }
void main() {
  Object box = Box<int>(1);
  if (box case Box(value: var value)) print([value].runtimeType);
  Box<int> typed = Box<int>(1);
  if (typed case Box(value: var value)) print([value].runtimeType);
  Object text = TextBox<String>('text');
  print(switch (text) { TextBox(value: var value) => [value].runtimeType, _ => Null });
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'List<num>\nList<int>\nList<String>\n',
  });
});

test('object patterns infer through raw aliases and close dependent bounds independently', () => {
  const source = `class Box<T extends Iterable<U>, U extends num> {
  final T value;
  final U other;
  Box(this.value, this.other);
}
class NumberBox<T extends num> {
  final T value;
  NumberBox(this.value);
}
typedef Alias<T extends num> = NumberBox<T>;
class Child extends NumberBox<int> { Child() : super(1); }
void main() {
  Object subject = Box<List<int>, int>([1], 1);
  if (subject case Box(value: var v, other: var o)) print([[v].runtimeType, [o].runtimeType]);
  Box raw = Box<List<int>, int>([1], 1);
  print([raw.value].runtimeType);
  NumberBox<int>? narrowed = Child();
  if (narrowed case Alias(value: var v)) print([v].runtimeType);
  NumberBox<double> fraction = NumberBox(1.0);
  print(switch (fraction) { Alias(value: var v) => [v].runtimeType });
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[List<Iterable<Object?>>, List<num>]\nList<Iterable<num>>\nList<int>\nList<double>\n',
  });
});

test('object patterns infer raw alias arguments from the subject type', () => {
  const source = `class Pair<X, Y> {
  final X x;
  final Y y;
  Pair(this.x, this.y);
}
typedef Same<T extends num> = Pair<T, T>;
typedef Row<T> = (T, {T named});
typedef Mapper<T> = T Function(T);
int map(num value) => 1;
void main() {
  Pair<num, int> pair = Pair<int, int>(1, 2);
  if (pair case Same(x: var x, y: var y)) print(([x].runtimeType, [y].runtimeType));
  Pair<int, double> mixed = Pair(1, 2.0);
  if (mixed case Same()) print('match'); else print('no match');
  (int, {int named}) row = (3, named: 4);
  if (row case Row($1: var x, named: var y)) print(([x].runtimeType, [y].runtimeType));
  int Function(num) mapper = map;
  if (mapper case Mapper(call: var f)) {
    print(f(2.5));
    print([f].runtimeType == <num Function(num)>[].runtimeType);
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '(List<int>, List<int>)\nno match\n(List<int>, List<int>)\n1\ntrue\n',
  });
});

test('inferred fields resolve dependencies across later classes, mixins, and globals', () => {
  const declarations = `class First {
  var value = Later().value;
  var items = Mixed().items;
}
class Later { late var value = initial; }
class Mixed with Items<String> {}
mixin Items<T> { var items = <T>[]; }
var initial = 1;
`;
  expect(
    executeProgram(
      'dart',
      `${declarations} void main() {
  print([First().value].runtimeType);
  print(First().items.runtimeType);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'List<int>\nList<String>\n' });
  expect(
    executeProgram('dart', `${declarations} void main() { print('before'); First().value = 'invalid'; }`)
  ).toMatchObject({ kind: 'compileError' });
  expect(
    executeProgram('dart', 'class Owner { var value = initial; } var initial = Owner().value; void main() {}')
  ).toMatchObject({ kind: 'compileError' });
});

test('runtime function bounds erase extension types and retain dependent parameters', () => {
  const program = `extension type Id(int value) {}
T identity<T extends Id>(T value) => value;
class Box {
  U method<T extends Id, U extends T>(U value) => value;
}
typedef WithId = T Function<T extends Id>(T);
typedef WithInt = T Function<T extends int>(T);
void main() {
  print(identity.runtimeType);
  print(WithId == WithInt);
  dynamic call = identity;
  print(call<int>(1));
  dynamic box = Box();
  print(box.method<int, int>(2));
  dynamic method = box.method;
  print(method<int, int>(3));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '<Y0 extends int>(Y0) => Y0\ntrue\n1\n2\n3\n',
  });
});

test('generic bounds reject cycles through extension type representations', () => {
  for (const declaration of ['class C<T extends Id<T>> {}', 'void call<T extends Id<T>>() {}']) {
    const source = `extension type Id<X>(X value) {} ${declaration} void main() { print('valid'); }`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
    expect(executeProgram('dart', source.replace('X value', 'List<X> value'))).toMatchObject({
      kind: 'executed',
      stdout: 'valid\n',
    });
  }
});

test('extension type representations reject direct and transitive cycles', () => {
  for (const declarations of [
    'extension type E(E value) {}',
    'extension type E(List<E> value) {}',
    'extension type A(B value) {} extension type B(A value) {}',
    'extension type E(T Function<T extends E>(T) value) {}',
  ]) {
    expect(executeProgram('dart', `${declarations} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  expect(
    executeProgram('dart', 'extension type E<T>(List<T> value) {} void main() { print(E<E<int>>); }')
  ).toMatchObject({ kind: 'executed', stdout: 'List<List<int>>\n' });
});

test('extension type constructors reject super initializers and formals', () => {
  for (const constructor of [
    'E.bad() : super();',
    'E.bad() : x = 1, super();',
    'E.bad(int super.value) : x = value;',
  ]) {
    expect(executeProgram('dart', `extension type E(int x) { ${constructor} } void main() {}`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('wide record switches partition fields that their patterns inspect', () => {
  const program = `typedef Wide = (bool, bool, bool, bool, bool, bool, bool, bool, bool);
int first(Wide value) => switch (value) {
  (true, _, _, _, _, _, _, _, _) => 1,
  (false, _, _, _, _, _, _, _, _) => 0,
};
int last(Wide value) => switch (value) {
  (_, _, _, _, _, _, _, _, true) => 1,
  (_, _, _, _, _, _, _, _, false) => 0,
};
int firstInList(List<Wide> values) => switch (values) {
  [] => -1,
  [(true, _, _, _, _, _, _, _, _), ...] => 1,
  [(false, _, _, _, _, _, _, _, _), ...] => 0,
};
void main() {
  final value = (true, false, false, false, false, false, false, false, false);
  print([first(value), last(value), firstInList([value])]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 0, 1]\n' });
  expect(executeProgram('dart', program.replace('  (_, _, _, _, _, _, _, _, false) => 0,\n', ''))).toMatchObject({
    kind: 'compileError',
  });
});

test('record switch coverage keeps field correlations across arms', () => {
  for (const { width, nested } of [
    { width: 9, nested: false },
    { width: 10, nested: false },
    { width: 10, nested: true },
  ]) {
    const fields = Array.from({ length: width }, (_, index) => index);
    const record = (values: readonly string[], lastField: string): string => {
      const tuple = `(${values.join(', ')})`;
      return nested ? `(${tuple}, ${lastField})` : tuple;
    };
    const type = record(
      fields.map(() => 'bool'),
      'bool'
    );
    const allTrue = fields.map(() => 'true');
    const allFalse = fields.map(() => 'false');
    const arms = fields.map((firstFalse) => {
      const pattern = fields.map((field) => (field < firstFalse ? 'true' : field === firstFalse ? 'false' : '_'));
      return `${record(pattern, '_')} => ${firstFalse}`;
    });
    const fallback = `${record(allTrue, '_')} => ${width}`;
    const program = (
      cases: string[]
    ): string => `int firstFalse(${type} value) => switch (value) { ${cases.join(', ')} };
void main() {
  print(firstFalse(${record(allTrue, 'false')}));
  print(firstFalse(${record(allFalse, 'false')}));
}`;
    for (const cases of [
      [...arms, fallback],
      [fallback, ...arms.toReversed()],
    ]) {
      expect(executeProgram('dart', program(cases))).toMatchObject({ kind: 'executed', stdout: `${width}\n0\n` });
    }
    expect(executeProgram('dart', program(arms))).toMatchObject({ kind: 'compileError' });
  }
});

test('bounded Dart switch partitions follow correlated records into lists and object fields', () => {
  for (const width of [8, 9, 10]) {
    const fields = Array.from({ length: width }, (_, index) => index);
    const arms = fields.map((firstFalse) => {
      const pattern = fields.map((index) => (index < firstFalse ? 'true' : index === firstFalse ? 'false' : '_'));
      return { pattern: `(${pattern.join(', ')})`, result: firstFalse };
    });
    const trueValues = `(${fields.map(() => 'true').join(', ')})`;
    const falseValues = `(${fields.map(() => 'false').join(', ')})`;
    const finished = [{ pattern: trueValues, result: width }, ...arms.toReversed()];
    const program = (recordArms: typeof arms): string => `typedef Wide = (${fields.map(() => 'bool').join(', ')});
sealed class Selection {}
class Box extends Selection { final Wide value; Box(this.value); }
int head(List<Wide> r) => switch (r) {
  [] => -1,
  ${recordArms.map(({ pattern, result }) => `[${pattern}, ...] => ${result}`).join(', ')},
};
int tail(List<Wide> r) => switch (r) {
  [] => -1,
  ${recordArms.map(({ pattern, result }) => `[..., ${pattern}] => ${result}`).join(', ')},
};
int field(Selection r) => switch (r) {
  ${recordArms.map(({ pattern, result }) => `Box(value: ${pattern}) => ${result}`).join(', ')},
};
void main() {
  print([head([]), head([${falseValues}, ${trueValues}]), tail([${falseValues}, ${trueValues}]), field(Box(${trueValues}))]);
}`;
    expect(executeProgram('dart', program(finished))).toMatchObject({
      kind: 'executed',
      stdout: `[-1, 0, ${width}, ${width}]\n`,
    });
    expect(executeProgram('dart', program(arms))).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart list coverage skips arms contradicted by an earlier position', () => {
  for (const width of [9, 10]) {
    const positions = Array.from({ length: width }, (_, index) => index);
    const shorter = positions.map(
      (length) =>
        `[${positions
          .slice(0, length)
          .map(() => '_')
          .join(', ')}] => -1`
    );
    const longer = `[${positions.map(() => '_').join(', ')}, _, ...] => -2`;
    const firstFalse = positions.map((first) => {
      const pattern = positions.map((index) => (index < first ? 'true' : index === first ? 'false' : '_'));
      return `[${pattern.join(', ')}] => ${first}`;
    });
    const trueValues = positions.map(() => 'true').join(', ');
    const falseValues = positions.map(() => 'false').join(', ');
    const allTrue = `[${trueValues}] => ${width}`;
    const program = (exactLength: string[]): string => `int select(List<bool> values) => switch (values) {
  ${[...shorter, longer, ...exactLength].join(',\n  ')}
};
void main() {
  print([select([]), select([${falseValues}]), select([${trueValues}]), select([${trueValues}, false])]);
}`;
    for (const arms of [
      [...firstFalse, allTrue],
      [allTrue, ...firstFalse.toReversed()],
    ]) {
      expect(executeProgram('dart', program(arms))).toMatchObject({
        kind: 'executed',
        stdout: `[-1, 0, ${width}, -2]\n`,
      });
    }
    expect(executeProgram('dart', program(firstFalse))).toMatchObject({ kind: 'compileError' });
  }
});

test('Dart rest subpatterns exhaust their own list space', () => {
  const width = 9;
  const positions = Array.from({ length: width }, (_, index) => index);
  const falseValues = `(${positions.map(() => 'false').join(', ')})`;
  const allTrue = `(${positions.map(() => 'true').join(', ')})`;
  const firstFalse = positions.map((first) => {
    const values = positions.map((index) => (index < first ? 'true' : index === first ? 'false' : '_'));
    return `(${values.join(', ')})`;
  });
  for (const prefix of [false, true]) {
    const baseArms = prefix ? ['[] => -1', '[_] => -2'] : ['[] => -1'];
    const correlated = [...firstFalse, allTrue].map((record, value) => {
      const pattern = prefix ? `[_, ...[..., ${record}]]` : `[...[${record}, ...]]`;
      return `${pattern} => ${value}`;
    });
    const program = (coversEmptyRest: boolean): string => {
      const emptyRest = prefix ? '[_, ...[]] => -3' : '[...[]] => -3';
      const cases = [...baseArms, ...(coversEmptyRest ? [emptyRest] : []), ...correlated];
      return `typedef Wide = (${positions.map(() => 'bool').join(', ')});
int select(List<Wide> list) => switch (list) { ${cases.join(', ')} };
void main() { print(select([${prefix ? `${falseValues}, ` : ''}${falseValues}])); }`;
    };
    expect(executeProgram('dart', program(false))).toMatchObject({ kind: 'compileError' });
    expect(executeProgram('dart', program(true))).toMatchObject({ kind: 'executed', stdout: '0\n' });
  }
});

test('Dart logical-or coverage keeps the first equivalent list restriction', () => {
  for (const cases of [
    '[] => 0, ([true, ...] || [false, ...]) => 2',
    '[] => 0, ([true, ...] || <bool>[false, ...]) => 2',
    '[] => 0, [...[]] => 1, ([...[true, ...]] || [...[false, ...]]) => 2',
    '[] => 0, [...[]] => 1, ([...[false, ...]] || [...[true, ...]]) => 2',
    '[] => 0, [...[]] => 1, [...([true, ...] || [false, ...])] => 2',
  ]) {
    const program = `int select(List<bool> values) => switch (values) { ${cases} };
void main() { print(select([false])); }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'compileError' });
  }
  const valid = `int separate(List<bool> x) => switch (x) {
  [] => 0, [...[]] => 1, [...[true, ...]] => 2, [...[false, ...]] => 3,
};
int lengths(List<bool> x) => switch (x) { ([] || [_]) => 0, [_, _, ...] => 2 };
int elements(List<num> x) => switch (x) { [] => 0, (<int>[_, ...] || <num>[_, ...]) => 2 };
int record((List<bool>,) x) => switch (x) { ([],) => 0, (([true, ...],) || ([false, ...],)) => 2 };
void main() { print([separate([false]), lengths([false]), elements([0.5]), record(([false],))]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[3, 0, 2, 2]\n' });
});

test('constructor formals and tear-offs use inferred field types', () => {
  const declarations = `class Parent {
  var value = Later().value;
  Parent(this.value);
}
class Child extends Parent { Child(super.value); }
mixin M {}
class Mixed = Parent with M;
class Later { var value = 1; }
`;
  expect(
    executeProgram(
      'dart',
      `${declarations} void main() {
  print(Parent.new.runtimeType);
  print(Child.new.runtimeType);
  print(Mixed.new.runtimeType);
  print([Mixed(2).value].runtimeType);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '(int) => Parent\n(int) => Child\n(int) => Mixed\nList<int>\n' });
  expect(executeProgram('dart', `${declarations} void main() { Mixed('invalid'); }`)).toMatchObject({
    kind: 'compileError',
  });
  expect(
    executeProgram('dart', 'class Cycle { var value = Cycle(0).value; Cycle(this.value); } void main() {}')
  ).toMatchObject({ kind: 'compileError' });
});

test('raw object pattern aliases infer invariant generic function bounds', () => {
  const source = `typedef Direct<X> = void Function<T extends X>(T);
typedef Nested<X> = void Function<T extends List<X>>(T);
typedef Result<X> = X Function<T extends num>(T);
void writeNumber<A extends num>(A value) => print(value);
void writeList<B extends List<int>>(B value) => print(value);
T echo<T extends num>(T value) => value;
void main() {
  void Function<A extends num>(A) number = writeNumber;
  if (number case Direct(call: var f)) f(2); else print('no match');
  void Function<B extends List<int>>(B) list = writeList;
  if (list case Nested(call: var f)) f(<int>[3]); else print('no match');
  T Function<T extends num>(T) result = echo;
  if (result case Result()) print('match'); else print('no match');
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '2\n[3]\nno match\n' });
});

test('switches over generic nullable bounds cover the null case', () => {
  for (const source of [
    'int f<T extends bool?>(T input) => switch (input) { true => 1, false => 0 }; void main() {}',
    'enum E { x } int f<T extends E?>(T input) => switch (input) { E.x => 1 }; void main() {}',
  ]) {
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const source = `enum E { x }
int f<T extends U, U extends E?>(T input) => switch (input) { E.x => 1, null => 0 };
void main() { print([f<E?, E?>(null), f<E, E?>(E.x)]); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[0, 1]\n' });
});

test('List.writeIterable checks the start and retains writes before overflow', () => {
  const source = `Iterable<int> values() sync* {
  print('first');
  yield 7;
  print('second');
  yield 8;
  print('finished');
}
void main() {
  var target = [0, 0];
  try { List.writeIterable(target, -1, values()); } catch (e) { print(e); }
  try { List.writeIterable(target, 1, values()); } catch (e) { print(e); }
  List.writeIterable(target, target.length, const []);
  print(target);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'RangeError (at): Invalid value: Not in inclusive range 0..2: -1\nfirst\nsecond\n' +
      'RangeError: Index out of range: index should be less than 2: 2\n[0, 7]\n',
  });
});

test('private named field formals use public labels for calls and forwarding', () => {
  const source = `class Box {
  final int _value;
  final int after;
  const Box({this._value = 5}) : after = _value + 1;
}
class Child extends Box {
  const Child({super.value});
}
void main() {
  print([const Box().after, const Box(value: 7)._value, Child()._value, Child(value: 9)._value]);
  dynamic make = Box.new;
  print(make(value: 4).after);
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[6, 7, 5, 9]\n5\n' });
  for (const invalid of [
    source.replace('Child(value: 9)', 'Child(_value: 9)'),
    'void show({required int _value}) {} void main() {}',
    'typedef F = void Function({required int _value}); void main() {}',
    'class Box { int __x; Box({required this.__x}); } void main() {}',
    'class Box { int _x; Box(int x, {required this._x}); } void main() {}',
  ]) {
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('bodyless top-level functions and accessors require the external modifier', () => {
  const declarations = ['void greet();', 'int get answer;', 'set answer(int value);'];
  for (const declaration of declarations) {
    expect(executeProgram('dart', `${declaration} void main() {}`)).toMatchObject({ kind: 'compileError' });
  }
  const external = declarations.map((declaration) => `external ${declaration}`).join('\n');
  expect(executeProgram('dart', `${external} void main() { print('ready'); }`)).toMatchObject({
    kind: 'executed',
    stdout: 'ready\n',
  });
});

test('mixin super accesses use the combined constraint interface', () => {
  const program = `class A {
  int get a => 1;
  num choose(num value) => value;
}
mixin class B<T> {
  T? stored;
  T? get value => stored;
  set value(T? next) => stored = next;
  T id(T input) => input;
  int choose(num value) => value.toInt();
  int operator [](int index) => index + 3;
}
mixin M<T> on A, B<T> {
  T update(T value) {
    super.value = value;
    return super.id(super.value!);
  }
  int read() => super[0] + super.a + super.choose(1);
}
class C extends A with B<int>, M<int> {}
void main() { print([C().update(2), C().read()]); }
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 5]\n' });
});

test('mixin classes allow trivial and factory constructors', () => {
  const program = `mixin class M {
  M.named();
  factory M() => M.named();
  int get value => 2;
}
class C with M {}
void main() { print([M().value, M.named().value, C().value]); }
`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 2, 2]\n' });
  for (const constructor of [
    'M() {}',
    'M([int x = 0]);',
    'int x; M(this.x);',
    'M() : super();',
    'external M();',
    'external const M();',
  ]) {
    expect(executeProgram('dart', `mixin class M { ${constructor} } void main() {}`)).toMatchObject({
      kind: 'compileError',
    });
  }
});

test('mixin class superclasses resolve to Object through aliases', () => {
  const source = `typedef Root = Object;
mixin class First extends Object {}
mixin class Other extends Root {}
void main() { print([First() is Object, Other() is Object]); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[true, true]\n' });
  expect(executeProgram('dart', `class Base {} ${source.replace('Root = Object', 'Root = Base')}`)).toMatchObject({
    kind: 'compileError',
  });
  for (const inheritance of ['with Parts', 'extends Object with Parts', 'extends Root with Parts']) {
    const invalid = `mixin Parts {} typedef Root = Object; mixin class Mixed ${inheritance} {} void main() {}`;
    expect(executeProgram('dart', invalid)).toMatchObject({ kind: 'compileError' });
  }
});

test('empty iterables preserve SDK wrapper identities and index errors', () => {
  const source = `void main() {
  for (final empty in [const Iterable<int>.empty(), Iterable<int>.generate(0)]) {
    try { empty.elementAt(0); } catch (error) { print(error); }
    print([identical(empty, empty.where((_) => true)), identical(empty, empty.skip(1)),
      identical(empty, empty.take(1)), empty.map<String>((_) => 'never').runtimeType, empty.iterator.runtimeType]);
  }
}`;
  const output =
    'RangeError (index): Invalid value: Only valid value is 0: 0\n' +
    '[true, true, true, EmptyIterable<String>, EmptyIterator<Never>]\n';
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: output.repeat(2) });
});

test('constant type tests and casts exclude lexically bound type variables', () => {
  for (const expression of ['1 is T', '1 is! T', 'const [] is List<T>', '(null as T?) == null']) {
    const source = `void inspect<T>() { const value = ${expression}; print(value); } void main() { inspect<int>(); }`;
    expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError' });
  }
  const source = `void inspect<T>() {
  const known = 1 is num;
  const localSignature = 1 is U Function<U>();
  print([known, localSignature, 1 is T]);
}
void main() { inspect<int>(); inspect<String>(); }`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[true, false, true]\n[true, false, false]\n',
  });
});

test('enhanced enums keep their implicit constructor alongside named factories', () => {
  const source = `enum Choice {
  a;
  factory Choice.fromInt(int value) => a;
  factory Choice.first() => a;
}
void main() { print([Choice.fromInt(1), Choice.first()]); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[Choice.a, Choice.a]\n' });
  expect(executeProgram('dart', source.replace('  a;', '  a;\n  const Choice.named();'))).toMatchObject({
    kind: 'compileError',
  });
});

test('nested Never expressions end only the paths that evaluate them', () => {
  const source = `Never fail() => throw StateError('bad input');
int fromInitializer() { final result = fail(); }
int fromArgument() { print(fail()); }
int fromChain() { fail().unknown(); }
int fromCondition(bool choice) { choice ? fail() : fail(); }
int skipped(String? text) { text?.padLeft(fail()).length; return 5; }
int deferred() { late final value = fail(); return 7; }
void main() {
  for (final f in <int Function()>[fromInitializer, fromArgument, fromChain, () => fromCondition(false)]) {
    try { print(f()); } catch (e) { print(e); }
  }
  print(skipped(null));
  print(deferred());
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Bad state: bad input\n'.repeat(4) + '5\n7\n',
  });
  for (const result of ['return 5;', 'return 7;']) {
    expect(executeProgram('dart', source.replace(result, ''))).toMatchObject({ kind: 'compileError' });
  }
});

test('safe diagnostics format record fields without invoking learner methods', () => {
  const source = String.raw`import 'dart:collection';
import 'dart:convert';
import 'dart:math';
class Foo {
  String toString() => throw StateError('format failed');
}
void main() {
  final regex = RegExp('a\x00b', caseSensitive: false, multiLine: true);
  final bytes = utf8.encode('abc');
  final random = Random(1);
  print(Error.safeToString((a: 'x\x00y', b: (Foo(), bytes), c: const [1], d: String)));
  print(ArgumentError.value((Foo(),), 'value'));
  print(Error.safeToString(regex));
  print(Error.safeToString(bytes));
  print(Error.safeToString((const {1: 2}, HashSet<int>()..add(1))));
  print([random.runtimeType, random.runtimeType == Random, random.nextInt(10), random]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "Record (a: x, b: Record (Instance of 'Foo', _Uint8List), c: _ImmutableList len:1, d: Type: String)\n" +
      "Invalid argument (value): Record (Instance of 'Foo')\n" +
      "RegExp: pattern=a flags=im\n_Uint8List\nRecord (_ConstMap len:1, Instance of '_HashSet<int>')\n" +
      "[_Random, false, 4, Instance of '_Random']\n",
  });
});

test('VM descriptions normalize unpaired surrogates and preserve a pair at a chunk boundary', () => {
  const source = `void main() {
  final broken = String.fromCharCodes([0xd800, 0x61, 0xdc00]);
  print(Error.safeToString((broken,)).codeUnits.sublist(8, 11));
  print(RegExp(broken).toString().codeUnits.sublist(16, 19));
  final paired = 'a' * 1023 + String.fromCharCode(0x10000);
  print(Error.safeToString((paired,)).codeUnits.sublist(1031, 1033));
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[65533, 97, 65533]\n[65533, 97, 65533]\n[55296, 56320]\n',
  });
});

test('default codecs return canonical converters and callback-bearing codecs do not', () => {
  const source = `import 'dart:convert';
void main() {
  final malformed = const Utf8Codec(allowMalformed: true);
  final custom = JsonCodec(reviver: (_, value) => value, toEncodable: (_) => 7);
  print([identical(json.encoder, const JsonEncoder()), identical(json.decoder, const JsonDecoder()),
    identical(utf8.decoder, const Utf8Decoder()), identical(malformed.decoder, const Utf8Decoder(allowMalformed: true))]);
  print([identical(custom.encoder, custom.encoder), identical(custom.decoder, custom.decoder)]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[true, true, true, true]\n[false, false]\n',
  });
});

test('file failures at a path written as a directory or under a file are unavailable, and others are the OS errors', () => {
  const source = `import 'dart:io';
void main() {
  File('f.txt').writeAsStringSync('x');
  Directory('d').createSync();
  print(Directory('d/').existsSync());
  for (final run in [
    () => File('f.txt/').readAsStringSync(),
    () => File('f.txt/b.txt').writeAsStringSync('z'),
    () => Directory('f.txt/sub').createSync(recursive: true),
    () => File('missing.txt').readAsStringSync(),
  ]) {
    try { run(); } catch (e) { print(e); }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: [
      'true',
      'Unsupported operation: 末尾が区切り文字のパスでのファイル操作の失敗は、この採点環境では使えません。',
      'Unsupported operation: 途中にファイルがあるパスでのファイル操作の失敗は、この採点環境では使えません。',
      'Unsupported operation: 途中にファイルがあるパスでのファイル操作の失敗は、この採点環境では使えません。',
      "PathNotFoundException: Cannot open file, path = 'missing.txt' (OS Error: No such file or directory, errno = 2)",
      '',
    ].join('\n'),
  });
});

test('Expando finds a Type key as identical does, whichever evaluation made it', () => {
  const source = `class A {}
void main() {
  final m = Expando<String>();
  m[int] = 'x';
  m[A().runtimeType] = 'a';
  print([m[int], m[A], m[String]]);
  m[int] = null;
  print(m[int]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[x, a, null]\nnull\n' });
});

test.each(['await for (var i = 0; i < 2; i++) { print(i); }', 'print([await for (var i = 0; i < 2; i++) i]);'])(
  'await on a C-style for is a compile error, as the SDK reports it: %s',
  (body) => {
    expect(executeProgram('dart', `Future<void> main() async { ${body} }`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 0, message: 'await は、for-in の for にしか付けられません。' }],
    });
  }
);

test('an unavailable dart:async name is unavailable through a prefix too', () => {
  const source = `import 'dart:async' as async;
void main() { print(async.Zone.current); }`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: 'Zone（非同期処理）は、この採点環境では使えません。' }],
  });
});

test('a cascade section whose ??= value awaits waits for it, in the order of the sections', () => {
  const source = `class Box { int? x; Map<int, int> m = {}; }
Future<int> f(int x) async { print('f $x'); return x; }
Future<void> main() async {
  final b = Box()..x ??= await f(1)..x ??= await f(2);
  Box? n;
  n?..x ??= await f(3);
  final c = Box()..m[await f(4)] ??= await f(5);
  print([b.x, n, c.m]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'f 1\nf 4\nf 5\n[1, null, {4: 5}]\n',
  });
});

test('awaits in a branch or a short-circuit operand run only when it does, each part once and in order', () => {
  const source = `var log = <String>[];
Future<T> f<T>(String s, T v) async { log.add('f$s'); await Future<void>.value(); return v; }
T t<T>(String s, T v) { log.add('t$s'); return v; }
void show(String label, Object? v) { print('$label $v $log'); log = []; }
Future<void> main() async {
  show('a', t('a', false) && await f('b', true));
  show('b', t('a', true) && t('b', false) && await f('c', true));
  show('c', t('a', false) || await f('b', false));
  show('d', t<int?>('a', null) ?? t<int?>('b', null) ?? await f('c', 3));
  show('e', t<int?>('a', 1) ?? await f('b', 2));
  show('f', await f('a', false) ? t('b', 1) : t('c', 2) + await f('d', 3));
  show('g', [t('x', 0), t('a', true) ? await f('b', 1) : 0, await f('y', 9)]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: [
      'a false [ta]',
      'b false [ta, tb]',
      'c false [ta, fb]',
      'd 3 [ta, tb, fc]',
      'e 1 [ta]',
      'f 5 [fa, tc, fd]',
      'g [0, 1, 9] [tx, ta, fb, fy]',
      '',
    ].join('\n'),
  });
});

test('??=, cascade sections and switch expression bodies that await run as ordered, guarded parts', () => {
  const source = `var log = <String>[];
Future<T> f<T>(String s, T v) async { log.add('f$s'); await Future<void>.value(); return v; }
T t<T>(String s, T v) { log.add('t$s'); return v; }
void show(String label, Object? v) { print('$label $v $log'); log = []; }
class B { int? x; Map<int, int?> m = {}; void m2(int v) { log.add('m$v'); } B me(String s) { log.add('me$s'); return this; } }
Future<void> main() async {
  final b = B();
  show('a', b.m[await f<int>('k', 1)] ??= await f('v', 2));
  show('b', b.m[t<int>('k', 1)] ??= await f('v', 3));
  B? n;
  show('c', n?..m2(t('a', 1))..x = await f('b', 2));
  show('d', (B()..me('a').x = await f('b', 1)..me('c').m2(await f('d', 2))).x);
  show('e', switch (await f('a', 3)) { 1 => 'one', int v when v > 2 => await f('b', 'big'), _ => 'other' });
  show('f', switch (t('a', 5)) { < 3 => t('b', 'small'), _ => t('c', 'x') + await f('d', 'y') });
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: [
      'a 2 [fk, fv]',
      'b 2 [tk]',
      'c null []',
      'd 1 [mea, fb, mec, fd, m2]',
      'e big [fa, fb]',
      'f xy [ta, tc, fd]',
      '',
    ].join('\n'),
  });
});

test.each([
  'Future<Object> f() async { return g(); }',
  'Future<Object?> f() async { return vf(); }',
  'Future<Object?> f() async => vf();',
])('an async function whose value type is not void or dynamic rejects a void value: %s', (declaration) => {
  const source = `Future<void> g() async {}\nvoid vf() {}\n${declaration}\nvoid main() {}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 2 }] });
});

test('an async function literal whose context is Future<Object?> may return a void value, as its type is inferred', () => {
  const source = `void vf() {}
Future<void> main() async {
  Future<Object?> Function() k = () async { return vf(); };
  Future<Object?> Function() a = () async => vf();
  await k();
  await a();
  print('x');
}`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: 'x\n' });
});

test('an async function returning Future<void> may return a future of void, and not another value', () => {
  const accepted = `Future<void> g() async {}
Future<void> f() async { return g(); }
Future<void> h() async { return Future.value(1); }
Future<void> main() async { await f(); await h(); print('x'); }`;
  expect(executeProgram('dart', accepted)).toMatchObject({ kind: 'executed', stdout: 'x\n' });
  expect(executeProgram('dart', 'Future<void> f() async { return 1; }\nvoid main() {}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: '戻り値の型が void の関数は、値を返せません。' }],
  });
});

test('is Null and is! Null split a nullable type parameter as any nullable type', () => {
  const source = `int whole<T extends num>(T? v) {
  if (v is! Null) return v.toInt();
  return 0;
}
T firstOr<T>(T? value, T fallback) {
  if (value is Null) return fallback;
  T result = value;
  return result;
}
void main() { print([whole<double>(2.5), whole<int>(null), firstOr<int>(null, 4)]); }`;
  expect(executeProgram('dart', source)).toMatchObject({ kind: 'executed', stdout: '[2, 0, 4]\n' });
});

test('byte writes keep a byte order mark and text reads drop one, as the VM decodes them', () => {
  const source = `import 'dart:io';
void main() {
  File('c.txt').writeAsBytesSync([0xEF, 0xBB, 0xBF, 0x41]);
  print([File('c.txt').readAsBytesSync(), File('c.txt').readAsStringSync().codeUnits]);
  File('d.txt').writeAsStringSync('\\uFEFFhello');
  print([File('d.txt').readAsStringSync().length, File('d.txt').lengthSync()]);
  File('e.txt').writeAsStringSync('\\ud800x');
  print(File('e.txt').readAsStringSync().codeUnits);
  print(stdin.readLineSync()?.codeUnits);
}`;
  expect(executeProgram('dart', source, { stdin: '\uFEFFabc\n' })).toMatchObject({
    kind: 'executed',
    stdout: '[[239, 187, 191, 65], [65]]\n[5, 8]\n[65533, 120]\n[97, 98, 99]\n',
  });
});

test('json.decoder streams give the value or an end-of-input error at the end, and reject an error before it', () => {
  const source = `import 'dart:convert';
Future<void> main() async {
  print(await Stream.fromIterable(['[1,', ' 2', ', {"a":', ' "b"}]']).transform(json.decoder).toList());
  for (final chunks in [['[1,', '2'], ['', '[1,', ''], ['[1,', ' x]']]) {
    try {
      await Stream.fromIterable(chunks).transform(json.decoder).toList();
    } catch (error) {
      print(error.toString().replaceAll('\\n', '|'));
    }
  }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: [
      '[[1, 2, {a: b}]]',
      'FormatException: Unexpected end of input (at character 2)|2| ^|',
      'FormatException: Unexpected end of input (at character 1)||^|',
      'Unsupported operation: 途中に JSON として読めない部分があるテキストを流す json.decoder のストリームは、この採点環境では使えません。',
      '',
    ].join('\n'),
  });
});

test('turtle collection skips primitive lists while following reference lists', () => {
  const source = `void main() {
  final numbers = List<num?>.filled(100000, 1);
  final references = List<Object?>.filled(1, Turtle(0, 1));
  final turtle = Turtle(0, 0);
  print(turtle.canMoveForward());
  for (var i = 0; i < 1000; i++) { turtle.canMoveForward(); }
  references[0] = null;
  print(turtle.canMoveForward());
  print(numbers.length);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\ntrue\n100000\n',
    finalTurtles: [{ x: 0, y: 0 }],
  });
});

test('learner externals do not link to library natives with the same name', () => {
  const source = `import 'dart:math' as math;
external double sqrt(num value);
class Random {
  external factory Random([int? seed]);
}
void main() {
  try { print(sqrt(9)); } catch (e) { print(e.runtimeType); }
  try { print(Random(1)); } catch (e) { print(e.runtimeType); }
  print([math.sqrt(9), math.Random(1).nextInt(10)]);
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: 'NoSuchMethodError\nNoSuchMethodError\n[3.0, 4]\n',
  });
});

test('error representations escape isolated surrogates without splitting pairs', () => {
  const source = `void main() {
  var isolated = String.fromCharCodes([0xd800, 0xdc00, 0xdc00]);
  var boundary = 'x' * 1023 + isolated;
  var quoted = Error.safeToString(boundary);
  print(quoted.substring(1024).codeUnits);
  print(int.tryParse('', radix: 37));
  try { int.parse('', radix: 37); } on FormatException catch (error) { print([error.message, error.offset]); }
}`;
  expect(executeProgram('dart', source)).toMatchObject({
    kind: 'executed',
    stdout: '[55296, 56320, 92, 117, 100, 99, 48, 48, 34]\nnull\n[Invalid radix-37 number, 0]\n',
  });
});

test('Dart MapBase exposes live value views with SDK runtime types and cached iterator values', () => {
  const program = `import 'dart:collection';
class Table<K,V> extends MapBase<K,V> {
  final Map<K,V> data = {};
  Iterable<K> get keys => data.keys;
  V? operator [](Object? key) => data[key];
  void operator []=(K key, V value) { data[key] = value; }
  V? remove(Object? key) => data.remove(key);
  void clear() => data.clear();
}
void main() {
  final table = Table<int,int>()..[1] = 2;
  final values = table.values;
  final cursor = values.iterator;
  print([values.runtimeType, values.runtimeType.hashCode, cursor.runtimeType, cursor.runtimeType.hashCode]);
  print(cursor.moveNext());
  table[1] = 3;
  print([cursor.current, values.first, values.single, values.last]);
  print(cursor.moveNext());
  final nullable = Table<String,int?>()..['a'] = null;
  final nullableCursor = nullable.values.iterator;
  print([nullableCursor.current, nullableCursor.moveNext(), nullableCursor.current, nullableCursor.moveNext(), nullableCursor.current]);
  print([nullable.values.runtimeType, nullableCursor.runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[_MapBaseValueIterable<int, int>, 466365603, _MapBaseValueIterator<int, int>, 902193949]\n' +
      'true\n[2, 3, 3, 3]\nfalse\n[null, true, null, false, null]\n' +
      '[_MapBaseValueIterable<String, int?>, _MapBaseValueIterator<String, int?>]\n',
  });
});

test('Dart loops retain tested types for later assignment promotion', () => {
  const program = `void counted(num n) {
  for (var i = 0; i < 1; i++) { if (n is int) {} }
  n = 4; print(n.isEven);
}
void whileLoop(num n) {
  var i = 0;
  while (i++ < 1) { assert(n is int); continue; }
  n = 4; print(n.isEven);
}
void forIn(num n) {
  for (final _ in [1]) { final value = n is int ? 1 : 2; print(value); }
  n = 4; print(n.isEven);
}
Iterable<bool> generator(num n) sync* {
  for (final _ in [1]) { if (n is int) continue; }
  n = 4; yield n.isEven;
}
void collection(num n, num m) {
  print([for (final _ in [1]) if (n is int) 1]);
  n = 4; print(n.isEven);
  print([for (var i = 0; i < 1; i++) if (m is int) 1]);
  m = 4; print(m.isEven);
}
void main() { counted(0); whileLoop(0); forIn(0); print(generator(0).toList()); collection(0,0); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\n1\ntrue\n[true]\n[1]\ntrue\n[1]\ntrue\n',
  });
});

test('Dart coverage deduplicates list restrictions through null suffixes and retains assertion null spaces', () => {
  for (const pattern of [
    '(([true, ...])? || [false, ...]?)',
    '([true, ...]! || [false, ...]!)',
    '([true, ...]? || [false, ...])',
    '(([true, ...] || [false, ...])? || [true, ...])',
  ]) {
    const program = (fallback: string): string => `int select(List<bool>? x) => switch (x) {
  null => -1, [] => 0, ${pattern} => 2${fallback},
};
void main() { print([select([false]), select([true]), select(null)]); }`;
    expect(executeProgram('dart', program(''))).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('すべての値') })],
    });
    expect(executeProgram('dart', program(', _ => 3'))).toMatchObject({ kind: 'executed', stdout: '[2, 2, -1]\n' });
  }
  for (const pattern of [
    '([true, ...] || [false, ...]!)',
    '(([true, ...]?)! || [false, ...]?)',
    '(([true, ...]!)? || [false, ...]?)',
    '(([true, ...] || [false, ...])! || [true, ...])',
    '([true, ...]? || [false, ...]? || [_, ...]!)',
    '((null || [true, ...]) || [false, ...])',
  ]) {
    const program = `int select(List<bool>? x) => switch (x) {
  null => -1, [] => 0, ${pattern} => 2,
};
void main() { print([select([false]), select([true]), select(null)]); }`;
    expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[2, 2, -1]\n' });
  }
  const nullable = `int select(List<bool>? x) => switch (x) { [] => 0, ([_, ...]? || [_, ...]!) => 1 };
int nested(List<bool>? x) => switch (x) { [] => 0, (([_, ...]!)? || [_, ...]?) => 1 };
void main() { print([select([false]), nested([false])]); }`;
  expect(executeProgram('dart', nullable)).toMatchObject({ kind: 'executed', stdout: '[1, 1]\n' });
});

test('Dart codec byte iterators preserve SDK identity and read bytes on advancement', () => {
  const program = `import 'dart:convert';
void main() {
  final bytes = utf8.encode('hi');
  final type = bytes.iterator.runtimeType;
  print([type, type.hashCode, base64.decode('aGk=').iterator.runtimeType == type,
    const Utf8Encoder().convert('hi').iterator.runtimeType == type,
    bytes.sublist(1).iterator.runtimeType == type, [1].iterator.runtimeType == type]);
  final cursor = bytes.iterator;
  try { print(cursor.current); } catch (error) { print(error.runtimeType); }
  print(cursor.moveNext());
  bytes[0] = 10;
  bytes[1] = 20;
  print([cursor.current, cursor.moveNext(), cursor.current, cursor.moveNext(), cursor.moveNext()]);
  try { print(cursor.current); } catch (error) { print(error.runtimeType); }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[_TypedListIterator<int>, 134930630, true, true, true, false]\n_TypeError\ntrue\n[104, true, 20, false, false]\n_TypeError\n',
  });
});

test('Dart list intersections preserve ordinary properties and share list restriction identity', () => {
  const main = 'void main() { print([select([false]), select([true]), select(null)]); }';
  const source = (pattern: string, fallback = ''): string => `int select(List<bool>? x) => switch (x) {
  null => -1, [] => 0, ${pattern} => 2${fallback},
};
${main}`;
  for (const pattern of [
    '(([true, ...] && List<bool>()) || [false, ...])',
    '([true, ...] || ([false, ...] && List<bool>()))',
    '(([true, ...] && List<bool>())? || [false, ...]?)',
    '([true, ...]? || ([false, ...] && List<bool>())?)',
    '((Object() && [true, ...]) || [false, ...])',
    '(([true, ...] && [_, ...]) || [false, ...])',
    '((([true, ...] || [false, ...]) && List<bool>()) || [true, ...])',
    '(([true, ...] && ([true, ...] as List<bool>)) || [false, ...])',
    '((([true, ...] as List<bool>) && [true, ...]) || [false, ...]!)',
    '(([true, ...] && ([true, ...] as List<bool>?)) || [false, ...])',
    '((([true, ...] as List<bool>)? && [true, ...]) || [false, ...])',
    '(((([true, ...] || [false, ...]) as List<bool>) && [true, ...]) || [false, ...])',
    '(([true, ...] && ([...] as List<bool>)) || [false, ...])',
  ]) {
    expect(executeProgram('dart', source(pattern))).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringContaining('すべての値') })],
    });
    expect(executeProgram('dart', source(pattern, ', _ => 3'))).toMatchObject({
      kind: 'executed',
      stdout: '[2, 2, -1]\n',
    });
  }
  for (const pattern of [
    '(([true, ...] && List<bool>(length: _)) || [false, ...])',
    '(([true, ...] && List<bool>(length: _))? || [false, ...]?)',
    '(([true, ...] as List<bool>) || [false, ...])',
  ]) {
    expect(executeProgram('dart', source(pattern))).toMatchObject({ kind: 'executed', stdout: '[2, 2, -1]\n' });
  }
});

test('named super formals and explicit super arguments share argument validation', () => {
  for (const program of [
    `class A { final int x; A({this.x = 0}); }
class B extends A { B({super.x}) : super(x: 2); }
void main() { print(B(x: 1).x); }`,
    `class A { final int x; A.named({required this.x}); }
class B extends A { B({required super.x}) : super.named(x: 3); }
void main() { print(B(x: 1).x); }`,
  ]) {
    expect(executeProgram('dart', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: '名前付き引数 x が重複しています。' })],
    });
  }
  const valid = `class A {
  final int x, y;
  const A.named({required this.x, required this.y});
}
class B extends A { const B({required super.x}) : super.named(y: 3); }
void main() { final b = const B(x: 2); print([b.x, b.y]); }`;
  expect(executeProgram('dart', valid)).toMatchObject({ kind: 'executed', stdout: '[2, 3]\n' });
});

test('Dart collection views preserve efficient length and lazy mapping', () => {
  const program = `import 'dart:collection';
import 'dart:convert';

class ListView extends ListBase<int> {
  final List<int> data = [7,8];
  int get length => data.length;
  set length(int count) { data.length = count; }
  int operator [](int index) => data[index];
  void operator []=(int index, int value) { data[index] = value; }
}
Iterable<int> noisy() sync* {
  print('source');
  yield 13;
}
void inspect(Iterable<int> values) {
  print([values.runtimeType, values.runtimeType.hashCode]);
  var mapped = values.map((x) { print('map $x'); return x; });
  print([mapped.take(1).length, mapped.skip(1).length]);
}
void main() {
  final bytes = utf8.encode('hi');
  final mapped = bytes.map((x) { print('byte $x'); return x; });
  print([mapped.runtimeType, mapped.runtimeType.hashCode, mapped.take(1).length, mapped.skip(1).length]);
  print(mapped.take(1).toList());
  final base64Mapped = base64.decode('aGk=').map((x) => x.toString());
  print([base64Mapped.runtimeType, base64Mapped.runtimeType.hashCode, base64Mapped.toList()]);
  final set = HashSet<int>.of([1,2,3]);
  for(final view in [bytes.followedBy([4]), ListView().followedBy(set), set.followedBy([4])]) { inspect(view); }
  inspect(bytes.followedBy(noisy()));
  inspect(set.followedBy(noisy()));
  inspect(set.take(2));
  inspect(set.skip(1));
  for(final operation in [set.take,set.skip]) {
    try { operation(-1); } catch(error) { print(error); }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[EfficientLengthMappedIterable<int, int>, 538845270, 1, 1]\n' +
      'byte 104\n' +
      '[104]\n' +
      '[EfficientLengthMappedIterable<int, String>, 794324298, [104, 105]]\n' +
      '[EfficientLengthFollowedByIterable<int>, 16609695]\n' +
      '[1, 2]\n' +
      '[EfficientLengthFollowedByIterable<int>, 16609695]\n' +
      '[1, 4]\n' +
      '[EfficientLengthFollowedByIterable<int>, 16609695]\n' +
      '[1, 3]\n' +
      '[FollowedByIterable<int>, 927751392]\n' +
      'map 104\n' +
      'map 104\n' +
      'map 105\n' +
      'source\n' +
      'map 13\n' +
      '[1, 2]\n' +
      '[FollowedByIterable<int>, 927751392]\n' +
      'map 1\n' +
      'map 1\n' +
      'map 2\n' +
      'map 3\n' +
      'source\n' +
      'map 13\n' +
      '[1, 3]\n' +
      '[EfficientLengthTakeIterable<int>, 586615924]\n' +
      '[1, 1]\n' +
      '[EfficientLengthSkipIterable<int>, 361295448]\n' +
      '[1, 1]\n' +
      'RangeError (takeCount): Invalid value: Not greater than or equal to 0: -1\n' +
      'RangeError (count): Invalid value: Not greater than or equal to 0: -1\n',
  });
});

test('Dart hash predicates observe removals before the next bucket entry', () => {
  const program = `import 'dart:collection';

void setFilter() {
  var reading = false;
  final set = HashSet<int>(hashCode: (n) { if (reading) print('hash $n'); return 0; });
  set.addAll([1, 2, 3, 4]);
  final cursor = set.iterator;
  cursor.moveNext();
  reading = true;
  try {
    set.removeWhere((key) {
      print(['set', key, set.length]);
      if (key == 2) throw 'stop';
      return key.isEven;
    });
  } catch (error) { print(error); }
  print(set.toList());
  try { cursor.moveNext(); } catch (error) { print(error.runtimeType); }
  set.retainWhere((key) { print(['retain', key, set.length]); return key > 2; });
  print(set.toList());
  reading = false;
  try {
    set.removeWhere((key) { set.add(7); return true; });
  } catch (error) { print(error.runtimeType); }
  print(set.toList());
}
void mapFilter() {
  var reading = false;
  final map = HashMap<int,int>(hashCode: (n) { if (reading) print('hash $n'); return 0; });
  map.addAll({1: 10, 2: 20, 3: 30, 4: 40});
  reading = true;
  try {
    map.removeWhere((key, value) {
      print(['map', key, value, map.length]);
      if (key == 2) throw 'stop';
      return key.isEven;
    });
  } catch (error) { print(error); }
  print(map);
  reading = false;
  try {
    map.removeWhere((key, value) {
      if (key == 2) { map[7] = 70; }
      return true;
    });
  } catch (error) { print(error.runtimeType); }
  print(map);
  final identity = HashMap<int, int>.identity()..addAll({1: 10, 2: 20, 3: 30});
  identity.removeWhere((key, value) {
    print(['identity', key, value, identity.length]);
    identity[key] = -value;
    return key.isOdd;
  });
  print(identity);
}
void main() { setFilter(); mapFilter(); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[set, 4, 4]\n' +
      '[set, 3, 3]\n' +
      '[set, 2, 3]\n' +
      'stop\n' +
      '[3, 2, 1]\n' +
      'ConcurrentModificationError\n' +
      '[retain, 3, 3]\n' +
      '[retain, 2, 3]\n' +
      '[retain, 1, 2]\n' +
      '[3]\n' +
      'ConcurrentModificationError\n' +
      '[7, 3]\n' +
      '[map, 4, 40, 4]\n' +
      '[map, 3, 30, 3]\n' +
      '[map, 2, 20, 3]\n' +
      'stop\n' +
      '{3: 30, 2: 20, 1: 10}\n' +
      'ConcurrentModificationError\n' +
      '{7: 70, 2: 20, 1: 10}\n' +
      '[identity, 1, 10, 3]\n' +
      '[identity, 2, 20, 2]\n' +
      '[identity, 3, 30, 2]\n' +
      '{2: -20}\n',
  });
});

test('Dart custom HashSet containsAll validates before delegating each lookup', () => {
  const program = `import 'dart:collection';
void main() {
  var count = 0;
  var denySecond = false;
  final set = HashSet<int>(
    isValidKey: (key) { count++; print(['validate', key, count]); return key is int && (!denySecond || count.isOdd); },
    hashCode: (key) { print(['hash', key]); return key; },
  );
  set.add(1);
  print(set.containsAll([1, 1]));
  print(set.containsAll(['bad', 1]));
  print(set.containsAll([2, 1]));
  count = 0;
  denySecond = true;
  print(set.containsAll([1]));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[hash, 1]\n' +
      '[validate, 1, 1]\n' +
      '[validate, 1, 2]\n' +
      '[hash, 1]\n' +
      '[validate, 1, 3]\n' +
      '[validate, 1, 4]\n' +
      '[hash, 1]\n' +
      'true\n' +
      '[validate, bad, 5]\n' +
      'false\n' +
      '[validate, 2, 6]\n' +
      '[validate, 2, 7]\n' +
      '[hash, 2]\n' +
      'false\n' +
      '[validate, 1, 1]\n' +
      '[validate, 1, 2]\n' +
      'false\n',
  });
});

test('Dart cast views preserve set factories and unmodifiable-list behavior', () => {
  const program = `import 'dart:collection';

class Equal {
  bool operator ==(Object other) => other is Equal;
  int get hashCode => 0;
}
void identityViews() {
  for (final set in [HashSet<Equal>.identity(), LinkedHashSet<Equal>.identity(), Set<Equal>.identity()]) {
    set.addAll([Equal(), Equal()]);
    final view = set.cast<Object>().cast<Object?>();
    print([view.toSet().runtimeType, view.toSet().length, view.union({Equal()}).length, view.difference({}).length]);
  }
}
void policyViews() {
  final sorted = SplayTreeSet<int>.of([1,3,2], (a,b) => b.compareTo(a));
  final sortedView = sorted.cast<num>();
  print([sortedView.toSet(), sortedView.union({4}), sortedView.intersection({1,3}), sortedView.difference({2})]);
  try { sortedView.toSet().add(2.5); } catch(error) { print(error.runtimeType); }
  final hash = HashSet<int>(equals: (a,b) => a.abs() == b.abs(), hashCode: (n) => n.abs())..add(2);
  final linked = LinkedHashSet<int>(equals: (a,b) => a.abs() == b.abs(), hashCode: (n) => n.abs())..add(2);
  for (final set in [hash, linked]) {
    final view = set.cast<num>();
    final copy = view.toSet();
    print([copy.runtimeType, copy.add(-2), copy.length, view.difference({}).runtimeType]);
  }
  print(HashSet<int>.of([1,9,17]).cast<num>().toSet().runtimeType);
  print((const <int>{1,2}).cast<num>().toSet().runtimeType);
}
void readOnlyList() {
  final original = [1,2];
  final view = UnmodifiableListView<int>(original).cast<num>();
  original[0] = 3;
  print([view.runtimeType, view]);
  try { view.add(2.5); } catch(error) { print(error); }
  try { view.fillRange(0, 0); } catch(error) { print(error); }
  try { view[0] = 2.5; } catch(error) { print(error); }
  final narrowed = view.cast<double>();
  print(narrowed.runtimeType);
  try { print(narrowed[0]); } catch(error) { print(error.runtimeType); }
}
void main() { identityViews(); policyViews(); readOnlyList(); }`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[_IdentityHashSet<Object?>, 2, 3, 2]\n' +
      '[CompactLinkedIdentityHashSet<Object?>, 2, 3, 2]\n' +
      '[CompactLinkedIdentityHashSet<Object?>, 2, 3, 2]\n' +
      '[{3, 2, 1}, {4, 3, 2, 1}, {3, 1}, {3, 1}]\n' +
      '_TypeError\n' +
      '[_HashSet<num>, true, 2, _HashSet<num>]\n' +
      '[_Set<num>, true, 2, CastSet<int, num>]\n' +
      '_HashSet<num>\n' +
      '_Set<num>\n' +
      '[UnmodifiableListView<num>, [3, 2]]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      'Unsupported operation: Cannot modify an unmodifiable list\n' +
      'Unsupported operation: Cannot modify an unmodifiable list\n' +
      'UnmodifiableListView<double>\n' +
      '_TypeError\n',
  });
});

test('Dart codec byte list map errors name the SDK callback parameter', () => {
  const program = `import 'dart:convert';
void main() {
  for (dynamic bytes in [utf8.encode('a'), base64.decode('YQ==')]) {
    for (final Object? bad in [1, null]) {
      try { bytes.map(bad); } catch (error) { print(error); }
    }
  }
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "type 'int' is not a subtype of type '(int) => dynamic' of 'f'\n" +
      "type 'Null' is not a subtype of type '(int) => dynamic' of 'f'\n" +
      "type 'int' is not a subtype of type '(int) => dynamic' of 'f'\n" +
      "type 'Null' is not a subtype of type '(int) => dynamic' of 'f'\n",
  });
});

test('Dart invocation mirrors give VM positional arguments their native list type', () => {
  const program = `class H {
  dynamic noSuchMethod(Invocation call) {
    final args = call.positionalArguments;
    print([call.isGetter, call.isSetter, args.runtimeType, args]);
    try { args.add(7); } catch(error) { print(error); }
  }
}
abstract class Method { void missing(int value); }
class Implementation implements Method {
  dynamic noSuchMethod(Invocation call) {
    print([call.positionalArguments.runtimeType, call.positionalArguments]);
  }
}
void main() {
  dynamic h = H();
  h.f(1);
  h.f(null, 2);
  h.x = 1;
  h.f();
  h.f(named: 1);
  h.x;
  Implementation().missing(1);
  print(Invocation.method(#written, [1]).positionalArguments.runtimeType);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[false, false, List<dynamic>, [1]]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[false, false, List<dynamic>, [null, 2]]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[false, true, List<dynamic>, [1]]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[false, false, List<Object?>, []]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[false, false, List<Object?>, []]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[true, false, List<Object?>, []]\n' +
      'Unsupported operation: Cannot add to an unmodifiable list\n' +
      '[List<dynamic>, [1]]\n' +
      'List<Object?>\n',
  });
});

test('Dart native list callbacks consume the shared execution budget', () => {
  const program = `void main() {
  final outer = List<int>.filled(1100, 1);
  final inner = List<int>.filled(1100, 2);
  outer.forEach((_) => inner.forEach((_) {}));
  print('done');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'limitExceeded',
    limit: expect.stringMatching(/^(operations|time)$/),
  });
});

test('Dart constrains a type parameter by Null matching its nullable form only when its bound admits Null', () => {
  const program = `extension E<T extends Object> on List<T?> { List<T> fresh() => <T>[]; }
List<T> wrap<T>(T? value) => <T>[];
void main() {
  print(wrap(null).runtimeType);
  final a = <Null>[null].nonNulls.toList();
  a.add(1);
  print(a.runtimeType);
  final b = <Null>[null].fresh();
  b.add('x');
  print(b);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'List<Null>\nList<Object>\n[x]\n',
  });
});

test('Dart nonNulls preserves its lazy view identity and iterator states', () => {
  const program = `import 'dart:collection';
class Source extends Iterable<int?> {
  Iterator<int?> get iterator { print('iterator'); return Cursor(); }
}
class Cursor implements Iterator<int?> {
  int index = 0;
  bool moveNext() {
    index++;
    if (index == 3) throw 'stop';
    return index < 6;
  }
  int? get current {
    print(['read', index]);
    return index == 2 || index == 4 ? index : null;
  }
}
void show(Iterator<int> cursor) {
  try { print(cursor.current); } catch (error) { print(error); }
}
void main() {
  final filtered = Source().nonNulls;
  print([filtered.runtimeType, filtered.runtimeType.hashCode, filtered.first]);
  final cursor = filtered.iterator;
  print([cursor.runtimeType, cursor.runtimeType.hashCode]);
  show(cursor);
  print(cursor.moveNext());
  show(cursor);
  try { cursor.moveNext(); } catch (error) { print(error); }
  show(cursor);
  print(cursor.moveNext());
  show(cursor);
  print(cursor.moveNext());
  show(cursor);
  final values = <int?>[null];
  final live = values.nonNulls;
  print(live.isEmpty);
  values.add(4);
  print([live.isNotEmpty, live.toList()]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'iterator\n' +
      '[read, 1]\n' +
      '[read, 2]\n' +
      '[NonNullsIterable<int>, 325788693, 2]\n' +
      'iterator\n' +
      '[NonNullsIterator<int>, 540098490]\n' +
      'Bad state: No element\n' +
      '[read, 1]\n' +
      '[read, 2]\n' +
      'true\n' +
      '2\n' +
      'stop\n' +
      'Bad state: No element\n' +
      '[read, 4]\n' +
      'true\n' +
      '4\n' +
      '[read, 5]\n' +
      'false\n' +
      'Bad state: No element\n' +
      'true\n' +
      '[true, [4]]\n',
  });
});

test('Dart unmodifiable set casts filter the source before casting results', () => {
  const program = `void describe(Set<int> view) {
  try { print(view.intersection({1})); } catch (error) { print(error.runtimeType); }
  try { print(view.difference({'x'})); } catch (error) { print(error.runtimeType); }
}
void main() {
  final view = Set<Object>.unmodifiable([1, 'x']).cast<int>();
  describe(view);
  describe(view.cast<num>().cast<int>());
  describe(<Object>{1, 'x'}.cast<int>());
  describe((const <Object>{1, 'x'}).cast<int>());
  try { view.add(2); } catch (error) { print(error); }
  try { view.toSet(); } catch (error) { print(error.runtimeType); }
  print(Set<Object>.unmodifiable([1]).cast<num>().toSet().runtimeType);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '{1}\n' +
      '{1}\n' +
      '{1}\n' +
      '{1}\n' +
      '_TypeError\n' +
      '_TypeError\n' +
      '_TypeError\n' +
      '_TypeError\n' +
      'Unsupported operation: Cannot change an unmodifiable set\n' +
      '_TypeError\n' +
      '_Set<num>\n',
  });
});

test.each([
  [
    'an if inside a for',
    'void main() {\n  for (var i = 0; i < 3; i++) {\n    if (i == 1) {\n      print(i);\n  }\n  print(9);\n}',
    2,
  ],
  [
    'an if inside a while',
    'void main() {\n  var x = 0;\n  while (x < 3) {\n    if (x == 1) {\n      print(x);\n    x++;\n  }\n}',
    3,
  ],
  ['an if in a function', 'void f(int x) {\n  if (x > 0) {\n    print(x);\n}\n\nvoid main() {\n  f(1);\n}', 1],
  [
    'an if in a method',
    'class A {\n  void f() {\n    if (true) {\n      print(1);\n  }\n  void g() {\n    print(2);\n  }\n}\nvoid main() {}',
    2,
  ],
  [
    'the outer for',
    'void main() {\n  for (var i = 0; i < 3; i++) {\n    for (var j = 0; j < 3; j++) {\n      print(j);\n    }\n  print(9);\n}',
    1,
  ],
])('Dart reports the misindented block of %s as missing its }', (_block, program, row) => {
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row, message: '「}」が足りません。' }],
  });
});

test('Dart missing semicolon diagnostics use the statement row in recovered control-flow bodies', () => {
  for (const body of [
    'var l = [1, 2];\nfor (var value in l) {\n  print(value)\n}',
    'var x = 0;\nfor (var i = 0; i < 2; i++) {\n  x++\n}',
    'var x = 0;\nwhile (x < 3) {\n  x++\n}',
    'var x = 0;\ndo {\n  x++\n} while (x < 3);',
    'var x = 1;\nif (x > 0) {\n  x += 1\n} else {\n  x = 0;\n}',
    'var x = 1;\nif (x > 0) { x = 2; } else {\n  x = 0\n}\nprint(x);',
  ]) {
    expect(executeProgram('dart', `void main() {\n${body}\n}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 3, message: '「;」が足りません。' }],
    });
  }
  for (const [program, rows] of [
    ['void main() {\n  var x = 0;\n  x++\n}', [2]],
    ['class C { void f() {\n  var x = 0;\n  if (x == 0) {\n    x++\n  }\n} }\nvoid main() {}', [3]],
    ['void main() {\n  for (var i = 0; i < 1; i++) {\n    if (i == 0) {\n      print(i)\n    }\n  }\n}', [3]],
    ['void main() {\n  if (true) {\n    print(0)\n  } else {\n    print(1)\n  }\n  print(2);\n}', [2, 4]],
    ['void main() {\n  switch (1) {\n    case 1:\n      print(1)\n      break;\n  }\n}', [3]],
    ['void main() {\n  switch (1) {\n    default:\n      print(2)\n      break;\n  }\n}', [3]],
    ['void main() {\n  if (true)\n    print(1);\n  else\n    print(2)\n  print(3);\n}', [4]],
    ['void main() {\n  for (var i = 0; i < 2; i++)\n    print(i)\n  print(9);\n}', [2]],
    ['void main() {\n  var x = 0;\n  do {\n    x++;\n  } while (x < 3)\n  print(x);\n}', [4]],
  ] as const) {
    expect(executeProgram('dart', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: rows.map((row) => ({ row, message: '「;」が足りません。' })),
    });
  }
});

test('Dart directives pick conditional imports by the VM environment and accept tool-only lines', () => {
  const program = `#!/usr/bin/env dart
library my.tools;
export 'dart:math';
import 'dart:math' if (dart.library.io) 'dart:collection' as picked;
import 'dart:math' if (dart.library.html) 'dart:collection' as kept;
typedef int Compare(int a, int b);
class Holder {
  final int Function(int) f;
  Holder(int this.f(int x));
}
int apply(int f(int x), [String g(Object)?]) => f(3);
void main() {
  print(picked.Queue.of([1]));
  print(kept.max(1, 2));
  Compare compare = (a, b) => a - b;
  print([compare.runtimeType, apply((x) => x * 2), Holder((x) => x + 1).f(1)]);
  print([bool.fromEnvironment('dart.library.io'), bool.hasEnvironment('dart.library.html')]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: '{1}\n2\n[(int, int) => int, 6, 2]\n[true, false]\n',
  });
  for (const directive of ["part of 'main.dart';", "export 'tools.dart';", "int f() native 'f';"]) {
    expect(executeProgram('dart', `${directive}\nvoid main() {}`)).toMatchObject({ kind: 'compileError' });
  }
});

// Dart SDK 3.13.7 (`dart run`) prints the expected output: the order of microtasks, timers, and resumed awaits, the
// update a concurrent `+=` loses, and the cleanup of an `async*` body whose listener cancelled.
test('Dart async functions, timers, and streams run in the order of the VM event loop', () => {
  const program = `import 'dart:async';
int total = 0;
Future<int> later(int x) async {
  await null;
  return x;
}
Future<void> add(int x) async {
  total += await later(x);
}
Stream<int> count(int n) async* {
  try {
    for (var i = 1; i <= n; i++) yield i;
  } finally {
    print('count closed');
  }
}
void main() async {
  scheduleMicrotask(() => print('microtask'));
  Timer(Duration(milliseconds: 5), () => print('timer 5'));
  Timer.run(() => print('timer 0'));
  print('main \${[1, await later(2), 3]}');
  await Future.wait([add(1), add(2)]);
  print('total $total');
  var controller = StreamController<String>.broadcast();
  controller.stream.listen((event) => print('heard $event'));
  controller.add('a');
  await for (var i in count(5)) {
    if (i == 2) break;
    print('loop $i');
  }
  print(await count(3).map((i) => i * 10).toList());
  try {
    await Future<int>.error(StateError('no')).timeout(Duration(seconds: 1));
  } on StateError catch (e) {
    print(e);
  }
  await Future.delayed(Duration(milliseconds: 10));
  print('end');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'microtask\nmain [1, 2, 3]\ntotal 2\nheard a\nloop 1\ncount closed\ncount closed\n[10, 20, 30]\n' +
      'Bad state: no\ntimer 0\ntimer 5\nend\n',
  });
});

test('an unhandled asynchronous error ends a Dart run before later events', () => {
  const program = `import 'dart:async';
void main() {
  Future.error(StateError('x'));
  Timer(Duration(seconds: 1), () => print('later'));
  scheduleMicrotask(() => print('microtask'));
  print('end');
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'end\n',
    uncaughtException: 'Unhandled exception:\nBad state: x',
  });
});

test.each([
  'int f() async => 1;',
  'void g() { await null; }',
  "Future<int> f() async => 'x';",
  'Future<int> f() async {}',
  "Stream<int> f() async* { yield 'a'; }",
  'Stream<int> f() async* { return 1; }',
  'void g() async { await for (var x in [1]) {} }',
])('misused async syntax `%s` is a compile error', (declaration) => {
  expect(executeProgram('dart', `${declaration}\nvoid main() {}`)).toMatchObject({ kind: 'compileError' });
});

// Dart SDK 3.13.7 (`dart run`) on macOS prints the expected output, whose errno for a non-empty directory is macOS's.
test('Dart reads standard input and the files of its run with the SDK messages', () => {
  const program = `import 'dart:convert';
import 'dart:io';
void main() async {
  print([stdin.readLineSync(), stdin.readByteSync(), stdin.readLineSync(), stdin.readLineSync()]);
  final file = File('notes/a.txt');
  Directory('notes').createSync();
  file.writeAsStringSync('one\\ntwo\\n');
  await file.writeAsString('three\\n', mode: FileMode.append);
  print([file.readAsLinesSync(), file.lengthSync(), await File('input.txt').readAsString()]);
  await for (final line in file.openRead().transform(utf8.decoder).transform(const LineSplitter())) print(line);
  print(Directory('notes').listSync().map((entity) => entity.path).toList());
  for (final action in [() => File('none.txt').readAsStringSync(), () => Directory('notes').deleteSync()]) {
    try {
      action();
    } on FileSystemException catch (error) {
      print(error);
    }
  }
  File('notes/a.txt').renameSync('b.txt');
  Directory('notes').deleteSync();
  File('log.txt').openWrite().write('unclosed');
}`;
  expect(executeProgram('dart', program, { stdin: 'first\nXsecond\n', files: { 'input.txt': 'given' } })).toMatchObject(
    {
      kind: 'executed',
      stdout:
        '[first, 88, second, null]\n[[one, two, three], 14, given]\none\ntwo\nthree\n[notes/a.txt]\n' +
        "PathNotFoundException: Cannot open file, path = 'none.txt' (OS Error: No such file or directory, errno = 2)\n" +
        "FileSystemException: Deletion failed, path = 'notes' (OS Error: Directory not empty, errno = 66)\n",
      finalFiles: { 'b.txt': 'one\ntwo\nthree\n', 'input.txt': 'given', 'log.txt': 'unclosed' },
    }
  );
});

test('Dart DateTime computes and prints dates as the SDK does', () => {
  const program = `void main() {
  final date = DateTime.utc(2024, 2, 29, 13, 5, 9, 7, 3);
  print([date, date.weekday, date.toIso8601String(), date.add(const Duration(days: 1, hours: 12))]);
  print([DateTime.utc(2024, 3, 1).difference(DateTime.utc(2024, 1, 1)), DateTime.utc(2024, 13, 35)]);
  print([DateTime.parse('2023-10-05T08:30:00Z'), DateTime.tryParse('nope'), date.copyWith(year: 2000)]);
  print([DateTime.fromMillisecondsSinceEpoch(0, isUtc: true), DateTime.utc(-5), DateTime.utc(12345)]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[2024-02-29 13:05:09.007003Z, 4, 2024-02-29T13:05:09.007003Z, 2024-03-02 01:05:09.007003Z]\n' +
      '[1440:00:00.000000, 2025-02-04 00:00:00.000Z]\n' +
      '[2023-10-05 08:30:00.000Z, null, 2000-02-29 13:05:09.007003Z]\n' +
      '[1970-01-01 00:00:00.000Z, -0005-01-01 00:00:00.000Z, 12345-01-01 00:00:00.000Z]\n',
  });
});

test('a deferred Dart import reaches its library only after loadLibrary', () => {
  const program = `import 'dart:math' deferred as m;
Future<void> main() async {
  try {
    print(m.max(1, 2));
  } catch (error) {
    print(error);
  }
  await m.loadLibrary();
  print(m.max(1, 2));
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout: 'Deferred library m was not loaded.\n2\n',
  });
  const typed = "import 'dart:math' deferred as m;\nm.Random? random;\nvoid main() {}";
  expect(executeProgram('dart', typed)).toMatchObject({ kind: 'compileError' });
});

test('Dart types conditional, if-null, and switch expressions with FutureOr', () => {
  const program = `import 'dart:async';
Future<int> later(int x) async => x;
FutureOr<int> either(bool now) => now ? 1 : later(2);
void main() async {
  final c = true;
  FutureOr<int?> x = 1;
  FutureOr<int?> y = null;
  print([c ? x : 3, y ?? 3, x!]);
  int? n;
  FutureOr<int> z = n ?? later(3);
  FutureOr<int> w = switch (c) { false => 1, _ => later(4) };
  print([await either(false), await z, await w]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({ kind: 'executed', stdout: '[1, 3, 1]\n[2, 3, 4]\n' });
});

// Dart SDK 3.13.7 (`dart run`) prints the expected output.
test('Dart evaluates the parts around an await once, in source order', () => {
  const program = `Future<int> f(int x) async {
  print('f $x');
  await null;
  return x;
}
int g(String s) {
  print('g $s');
  return s.length;
}
var total = 1;
Future<int> bump() async {
  total += 10;
  return 1;
}
void main() async {
  print(g('a') + await f(1) + g('bb'));
  total += await bump();
  int? m;
  m ??= await f(2);
  m ??= await f(3);
  final t = true;
  print([total, m, t || await f(4) > 0, t ? await f(5) : await f(6), switch (await f(7)) { 7 => g('s'), _ => 0 }]);
  final list = <int>[]..add(await f(8))..add(g('c'))..add(await f(9));
  var a = await f(10), b = a + await f(11);
  print([list, a, b]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'g a\nf 1\ng bb\n4\nf 2\nf 5\nf 7\ng s\n[2, 2, true, 5, 1]\nf 8\ng c\nf 9\nf 10\nf 11\n[[8, 1, 9], 10, 21]\n',
  });
});

test('Dart collection for elements await each element once in order', () => {
  const program = `Future<int> later(int x) async {
  await null;
  print('later $x');
  return x * 10;
}
Iterable<int> numbers() sync* {
  print('numbers 1');
  yield 1;
  print('numbers 2');
  yield 2;
}
Stream<int> stream() async* {
  yield 1;
  yield 2;
}
void main() async {
  print([for (var i = 0; i < 2; i++) await later(i), for (var x in numbers()) await later(x)]);
  print([0, await for (var x in stream()) if (x.isOdd) await later(x) else x]);
  var count = 0;
  print([for (var i = 0; i < 3; i += 1, count++) if (i.isEven) await later(i) else count += 10, count]);
  print([for (var x in numbers()) x, await later(3)]);
  print({for (var i = 0; i < 1000; i++) i: await Future.value(i)}.length);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'later 0\nlater 1\nnumbers 1\nlater 1\nnumbers 2\nlater 2\n[0, 10, 10, 20]\nlater 1\n[0, 10, 2]\n' +
      'later 0\nlater 2\n[0, 11, 20, 13]\nnumbers 1\nnumbers 2\nlater 3\n[1, 2, 30]\n1000\n',
  });
});

// Dart SDK 3.13.7 (`dart run`) prints the expected output, except Uri.base, which there is the shell's directory.
test('Dart parses, resolves, and encodes URIs, holds Expando entries, and draws secure random numbers', () => {
  const program = `import 'dart:convert';
import 'dart:io';
import 'dart:math';
void main() {
  final uri = Uri.parse('https://user@dart.dev:8080/a/./b/../c%20d?x=1&x=2&y=%E3%81%82#top');
  print([uri.host, uri.port, uri.path, uri.pathSegments, uri.queryParametersAll, uri.normalizePath(), uri.runtimeType]);
  print([Uri.parse('http://a/b/c/d;p?q').resolve('../../g'), Uri.https('dart.dev', '/q', {'k': 'a b'})]);
  print([Uri.encodeComponent('a b&é'), Uri.decodeQueryComponent('a+b%2B'), Uri.dataFromBytes([0, 255]), Uri.base]);
  print([File.fromUri(Uri.file('/tmp/a b.txt')), Directory('d').uri, ascii.encode('A'), latin1.decode([233])]);
  try {
    Uri.parse('http://[::1');
  } on FormatException catch (error) {
    print(error.message);
  }
  final tags = Expando<String>('tag');
  final key = Object();
  tags[key] = 'kept';
  print([tags[key], tags[Object()], tags]);
  try {
    tags[1] = 'number';
  } on ArgumentError catch (error) {
    print(error.message);
  }
  final random = Random.secure();
  print([List.generate(50, (_) => random.nextInt(6)).every((value) => value >= 0 && value < 6), random.runtimeType]);
}`;
  expect(executeProgram('dart', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '[dart.dev, 8080, /a/c%20d, [a, c d], {x: [1, 2], y: [あ]}, https://user@dart.dev:8080/a/c%20d?x=1&x=2&y=%E3%81%82#top, _Uri]\n' +
      '[http://a/g, https://dart.dev/q?k=a+b]\n' +
      '[a%20b%26%C3%A9, a b+, data:application/octet-stream;base64,AP8=, file:///]\n' +
      "[File: '/tmp/a b.txt', d/, [65], é]\n" +
      'Missing end `]` to match `[` in host\n' +
      '[kept, null, Expando:tag]\n' +
      'Cannot be a string, number, boolean, record, null, Pointer, Struct or Union\n' +
      '[true, _SecureRandom]\n',
  });
});
