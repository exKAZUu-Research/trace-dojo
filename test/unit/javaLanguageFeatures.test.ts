import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

/** Runs `body` in `main`, after `members` of `Main` and the top-level `declarations`, returning main's final variables. */
function finalVarsOf(body: string, members = '', declarations = ''): unknown {
  const program = `import java.util.*;\nimport java.util.function.*;\nimport java.util.stream.*;\n${declarations}\npublic class Main {\n${members}\n  public static void main(String[] args) {\n${body}\n  }\n}`;
  return traceProgram('java', program, program).finalVars;
}

interface Context {
  members?: string;
  declarations?: string;
}

// The expected values are what Java 21 computes for the same programs.
test.each<[name: string, body: string, context: Context, expected: Record<string, unknown>]>([
  [
    'long, float, byte, and short arithmetic',
    'long big = Integer.MAX_VALUE + 1L; float f = 0.1f * 3; byte b = (byte) 200; short s = (short) 70000; String text = "" + f + " " + (1L << 40);',
    {},
    { big: 2_147_483_648, f: 0.3, b: -56, s: 4464, text: '0.3 1099511627776' },
  ],
  [
    'interfaces with default methods and enums with constant bodies',
    'Shape sq = new Square(2); String d = sq.describe(); int r = Op.PLUS.apply(2, 3) * Op.TIMES.apply(2, 3); String names = Arrays.toString(Op.values());',
    {
      declarations: `interface Shape { double area(); default String describe() { return "area " + area(); } }
class Square implements Shape { final double side; Square(double side) { this.side = side; } public double area() { return side * side; } }
enum Op { PLUS { int apply(int a, int b) { return a + b; } }, TIMES { int apply(int a, int b) { return a * b; } }; abstract int apply(int a, int b); }`,
    },
    { d: 'area 4.0', r: 30, names: '[PLUS, TIMES]' },
  ],
  [
    'switch expressions, pattern matching, and text blocks',
    `Object o = new Point(2, 2);
String kind = switch (o) { case Point(int x, int y) when x == y -> "diagonal " + x; case Point p -> "point"; default -> "other"; };
int days = switch ("FEB") { case "JAN", "MAR" -> 31; case "FEB" -> { int d = 28; yield d; } default -> 30; };
String block = """
    a
      b
    """;`,
    { declarations: 'record Point(int x, int y) {}' },
    { kind: 'diagonal 2', days: 28, block: 'a\n  b\n' },
  ],
  [
    'generics and the Integer cache',
    'Integer a = 127, b = 127, c = 128, d = 128; boolean small = a == b; boolean large = c == d; Box<String> box = new Box<>("x"); String value = box.get() + Main.<Integer>first(List.of(9));',
    {
      members: 'static <T> T first(List<T> items) { return items.get(0); }',
      declarations:
        'class Box<T> { private final T value; Box(T value) { this.value = value; } T get() { return value; } }',
    },
    { a: 127, b: 127, c: 128, d: 128, small: true, large: false, value: 'x9' },
  ],
  [
    "collections in Java's iteration order",
    'Map<String, Integer> counts = new HashMap<>(); for (String w : "the cat the end".split(" ")) counts.merge(w, 1, Integer::sum); String text = counts.toString(); Deque<Integer> dq = new ArrayDeque<>(); dq.push(1); dq.offerLast(2); String deque = dq.toString();',
    {},
    { text: '{the=2, cat=1, end=1}', deque: '[1, 2]' },
  ],
  [
    'lambdas, method references, and streams',
    'List<String> words = List.of(" kiwi ", "fig", "apple"); int total = words.stream().map(String::trim).mapToInt(s -> s.length()).sum(); String sorted = words.stream().map(String::trim).sorted(Comparator.comparing(String::length)).collect(Collectors.joining(",")); int base = 10; Function<Integer, Integer> add = x -> x + base; int eleven = add.apply(1);',
    {},
    { total: 12, sorted: 'fig,kiwi,apple', base: 10, eleven: 11 },
  ],
  [
    'inner, local, and anonymous classes',
    `Main outer = new Main(); Main.Counter c = outer.new Counter(); c.tick(); c.tick();
int base = 5;
class Local { int plus(int x) { return x + base; } }
int local = new Local().plus(1);
Comparator<String> byLength = new Comparator<>() { public int compare(String x, String y) { return x.length() - y.length(); } };
int compared = byLength.compare("aa", "b");`,
    { members: 'int count; class Counter { void tick() { count++; } }' },
    { base: 5, local: 6, compared: 1 },
  ],
  [
    'records, sealed interfaces, and try-with-resources',
    `Shape s = new Circle(1);
double area = switch (s) { case Circle c -> 3 * c.r() * c.r(); case Square q -> q.side() * q.side(); };
String text = new Circle(2).toString(); boolean same = new Circle(2).equals(new Circle(2));
StringBuilder log = new StringBuilder();
try (Res r = new Res(log)) { log.append("use;"); }
String closed = log.toString();`,
    {
      declarations: `sealed interface Shape permits Circle, Square {}
record Circle(double r) implements Shape {}
record Square(double side) implements Shape {}
class Res implements AutoCloseable { final StringBuilder log; Res(StringBuilder log) { this.log = log; } public void close() { log.append("close;"); } }`,
    },
    { area: 3, text: 'Circle[r=2.0]', same: true, closed: 'use;close;' },
  ],
  [
    'seeded random numbers, formatting, and constant strings',
    'Random random = new Random(42); int first = random.nextInt(100); String formatted = String.format("%5.2f|%,d", 3.14159, 1234567); boolean interned = "ab" == "a" + "b";',
    {},
    { first: 30, formatted: ' 3.14|1,234,567', interned: true },
  ],
])('Java runs %s as javac and the JVM do', (_, body, { members, declarations }, expected) => {
  expect(finalVarsOf(body, members, declarations)).toMatchObject(expected);
});

test.each([
  [
    '@Override on a method that overrides nothing',
    'class A { void f() {} }\nclass B extends A { @Override void g() {} }',
    'メソッド g には @Override が付いていますが、親クラスやインターフェースのメソッドをオーバーライドしていません。',
  ],
  [
    'a lambda reading a local assigned again',
    'class C { void f() { int x = 1;\nRunnable r = () -> System.out.println(x); x = 2; } }',
    'ラムダ式の中から使うローカル変数 x は、final か実質的に final (一度しか代入しない) である必要があります。',
  ],
  [
    'a switch expression that misses a case',
    'enum E { A, B }\nclass C { int f(E e) { return switch (e) { case A -> 1; }; } }',
    'switch 式がすべての場合を網羅していません。default を書いてください。',
  ],
  [
    'an interface method implemented without public',
    'interface I { void f(); }\nclass C implements I { void f() {} }',
    'メソッド f はインターフェース I のメソッドをオーバーライドするので、public を付ける必要があります。',
  ],
  [
    'a class extending a sealed interface it is not permitted to',
    'sealed interface S permits A {}\nfinal class B implements S {}\nfinal class A implements S {}',
    'B は sealed な S の permits に含まれていないので、継承できません。',
  ],
])('Java rejects %s', (_, declarations, message) => {
  const source = `${declarations}\npublic class Main { public static void main(String[] args) {} }`;
  expect(executeProgram('java', source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message }],
  });
});

// The expected values are what Java 25 computes, which launches compact source files and instance main methods.
test('Java runs a compact source file whose instance main reads its fields, methods, and classes', () => {
  const program = `int count = 41;
void main() {
  count++;
  String greeting = greet("Ann");
  int total = new Helper().twice();
  IO.println(greeting);
}
String greet(String name) { return "Hi " + name + " " + count; }
class Helper { int twice() { return count * 2; } }`;
  expect(traceProgram('java', program, program).finalVars).toEqual({ greeting: 'Hi Ann 42', total: 84 });
});

test('Java runs unnamed variables and statements before super(...) as Java 25 does', () => {
  const program = `import java.util.*;
record Point(int x, int y) {}
class Base { final int size; Base(int size) { this.size = size; } }
class Doubled extends Base { Doubled(int n) { int twice = n * 2; super(twice); } }
public class Main {
  public static void main(String[] args) {
    int count = 0;
    for (var _ : List.of(1, 2, 3)) count++;
    int _ = 5;
    String kind = switch ((Object) new Point(1, 2)) { case Point(int x, _) when x > 0 -> "right"; case Point _, String _ -> "other"; default -> "none"; };
    int size = new Doubled(4).size;
  }
}`;
  expect(traceProgram('java', program, program).finalVars).toEqual({ count: 3, kind: 'right', size: 8 });
});

test('Java concatenates numbers and characters onto a String with +=', () => {
  expect(finalVarsOf('String s = "x"; s += 1 + 2; s += \'c\'; s += 1.5;')).toEqual({ s: 'x3c1.5' });
});

test("Java's map views follow later changes to the map and remove the entries behind them", () => {
  expect(
    finalVarsOf(
      'Map<String, Integer> m = new TreeMap<>(); Set<String> keys = m.keySet(); m.put("a", 1); m.put("b", 2); m.remove("a"); m.put("c", 3); keys.remove("c"); String seen = keys.toString() + m.values();'
    )
  ).toEqual({ seen: '[b][2]' });
});

test('Java captures a local assigned once on each branch, and evaluates a bound method reference once', () => {
  expect(
    finalVarsOf(
      'int x; if (args.length == 0) x = 1; else x = 2; Supplier<Integer> f = () -> x * 10; int got = f.get(); StringBuilder sb = new StringBuilder("a"); Supplier<String> s = sb::toString; sb = new StringBuilder("b"); String kept = s.get();'
    )
  ).toEqual({ x: 1, got: 10, kept: 'a' });
});

test.each([
  ['an Optional', 'Optional<Turtle> held = Optional.of(new Turtle());', ''],
  [
    'a value returned while resources close',
    'Turtle t = make(); t.前に進む();',
    'static class R implements AutoCloseable { public void close() { int[] junk = new int[100]; } }\nstatic Turtle make() { try (R r = new R()) { return new Turtle(); } }',
  ],
])('a turtle that %s holds stays on the board', (_, body, members) => {
  const program = `import java.util.*;\npublic class Main {\n${members}\n  public static void main(String[] args) {\n${body}\n  }\n}`;
  expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', finalTurtles: [expect.anything()] });
});
