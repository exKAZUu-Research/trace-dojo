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
  [
    'a stream pipeline',
    'java.util.stream.Stream<Integer> s = make(); int done = 1;',
    'static java.util.stream.Stream<Integer> make() { Turtle t = new Turtle(); return java.util.stream.Stream.of(1).map(v -> { t.前に進む(); return v; }); }',
  ],
  [
    "a map's view",
    'Collection<Integer> v = make(); int done = 1;',
    'static Collection<Integer> make() { Map<Turtle, Integer> m = new HashMap<>(); m.put(new Turtle(), 1); return m.values(); }',
  ],
])('a turtle that %s holds stays on the board', (_, body, members) => {
  const program = `import java.util.*;\npublic class Main {\n${members}\n  public static void main(String[] args) {\n${body}\n  }\n}`;
  expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', finalTurtles: [expect.anything()] });
});

test('Java infers lambdas inside generic calls passed as arguments, and comparator chains with method references', () => {
  expect(
    finalVarsOf(
      'List<String> l = new ArrayList<>(List.of("ccc", "a", "bb")); l.sort(Comparator.comparing(s -> s.length())); String sorted = l.toString(); String grouped = l.stream().collect(Collectors.groupingBy(s -> s.length(), Collectors.counting())).toString(); l.sort(Comparator.comparing(String::length).thenComparing(String::toString).reversed()); String chained = l.toString(); var typed = Comparator.comparingInt((String s) -> s.length()); int order = typed.compare("aa", "b");'
    )
  ).toEqual({ sorted: '[a, bb, ccc]', grouped: '{1=1, 2=1, 3=1}', chained: '[ccc, bb, a]', order: 1 });
});

test('Java rejects changes to unmodifiable collections through default methods and utilities', () => {
  expect(
    finalVarsOf(
      'String result = ""; for (Runnable r : List.<Runnable>of(() -> List.of(1).replaceAll(x -> x), () -> Map.of("a", 1).merge("a", 1, Integer::sum), () -> Collections.sort(Collections.unmodifiableList(new ArrayList<>(List.of(2, 1)))))) { try { r.run(); result += "ok "; } catch (UnsupportedOperationException e) { result += "uoe "; } }'
    )
  ).toEqual({ result: 'uoe uoe uoe ' });
});

test("Java's map views, iterators, forEach, and streams read a collection's contents when the JDK does", () => {
  expect(
    finalVarsOf(
      `Map<String, Integer> m = new HashMap<>(Map.of("a", 1, "b", 2));
Iterator<Integer> values = m.values().iterator(); int first = values.next(); m.put("b", 9); m.put("a", 9); int second = values.next();
var counted = m.keySet().stream().filter(k -> true); List<Integer> list = new ArrayList<>(); var mapped = list.stream().map(x -> x * 2); m.put("c", 3); list.add(4); String streams = counted.count() + " " + mapped.toList();
String cme = ""; for (Runnable r : List.<Runnable>of(() -> { for (String k : m.keySet()) if (k.equals("a")) m.remove("b"); }, () -> { Set<Integer> s = new HashSet<>(List.of(1, 2)); for (int x : s) s.remove(x); }, () -> { Map<String, Integer> one = new HashMap<>(Map.of("a", 1)); for (String k : one.keySet()) one.put(k + "x", 1); })) { try { r.run(); cme += "ok "; } catch (ConcurrentModificationException e) { cme += "cme "; } }
StringBuilder visited = new StringBuilder(); Map<String, Integer> f = new HashMap<>(Map.of("a", 1, "b", 2)); try { f.forEach((k, v) -> { if (k.equals("a")) f.remove("b"); visited.append(k); }); } catch (ConcurrentModificationException e) { visited.append("!"); }
String seen = visited.toString();`
    )
  ).toEqual({ first: 1, second: 9, streams: '3 [8]', cme: 'cme cme ok ', seen: 'a!' });
});

test('Java lets utilities that write nothing run on unmodifiable collections, and rejects writes through entries and iterators', () => {
  expect(
    finalVarsOf(
      'String result = ""; for (Runnable r : List.<Runnable>of(() -> Collections.addAll(List.of(1), new Integer[0]), () -> Collections.reverse(List.of(1)), () -> Collections.shuffle(List.of(1), new Random(1)), () -> Map.of("a", 1).entrySet().iterator().next().setValue(2), () -> { Iterator<Integer> it = Set.of(1).iterator(); it.next(); it.remove(); }, () -> new HashMap<>(Map.of("a", 1)).keySet().addAll(Set.of("b")))) { try { r.run(); result += "ok "; } catch (UnsupportedOperationException e) { result += "uoe "; } }'
    )
  ).toEqual({ result: 'ok ok ok uoe uoe uoe ' });
});

test('Java reads regular expressions with its own syntax: class intersection, POSIX and Unicode classes, escapes, and flags', () => {
  expect(
    finalVarsOf(
      String.raw`String consonants = "Hello World".replaceAll("[a-z&&[^aeiou]]", "_");
String classes = "Hello, World! 5pm".replaceAll("\\p{Punct}", "") + " " + "Wörld ñ".replaceAll("\\p{L}", "x") + " " + "a1_".replaceAll("[\\w&&[^_]]", ".");
String escapes = "a-b".replaceAll("\\e", "E") + "ab".replaceAll("\\a", "A") + " " + "a  b".replaceAll("\\h", "_") + " " + "[a]".replaceAll("\\Q[a]\\E", "Q");
String flags = "Hello hello".replaceAll("(?i:h)ello", "X") + " " + "ABC abc".replaceAll("(?i)(?s)b", "-") + " " + "ab".replaceAll("(?x) a b # c", "X") + " " + "abc".matches("a(?i)BC");
String rejected = ""; try { "aaa".replaceAll("a++", "x"); } catch (java.util.regex.PatternSyntaxException e) { rejected = "unsupported"; }`
    )
  ).toEqual({
    consonants: 'He__o Wo___',
    classes: 'Hello World 5pm xxxxx x .._',
    escapes: 'a-bab a__b Q',
    flags: 'X X A-C a-c X true',
    rejected: 'unsupported',
  });
});

test("Java compares a map's key and entry sets as sets, and casts a generic method's result where its type is needed", () => {
  expect(
    finalVarsOf(
      'Map<String, Integer> m = new HashMap<>(Map.of("a", 1, "b", 2)); String views = m.keySet().equals(Set.of("a", "b")) + " " + new HashSet<>(m.keySet()).equals(m.keySet()) + " " + m.keySet().hashCode() + " " + m.entrySet().hashCode() + " " + (m.keySet() == m.keySet()); String cast = ""; Object kept = new Box<String>().get(); try { String[] sa = new Box<String>().toArr(); } catch (ClassCastException e) { cast += "array "; } try { String s = new Box<String>().get(); } catch (ClassCastException e) { cast += "scalar"; }',
      '',
      'class Box<T> { Object[] d = new Object[2]; Object o = 3; @SuppressWarnings("unchecked") T[] toArr() { return (T[]) d; } @SuppressWarnings("unchecked") T get() { return (T) o; } }'
    )
  ).toEqual({ views: 'true true 195 192 true', kept: 3, cast: 'array scalar' });
});

test("Java reads Unicode digits by Character.digit's rule, and formats with the alternate form and %g", () => {
  expect(
    finalVarsOf(
      'int a = Integer.parseInt("١٢٣") + Integer.parseInt("１２"); int b = Integer.parseInt("१२", 16); int c = Character.digit(\'๑\', 10) + Character.getNumericValue(\'Ⅻ\'); String astral = ""; try { Integer.parseInt("𝟏"); } catch (NumberFormatException e) { astral = "rejected"; } String f = String.format("%#x %#o %.3g %5.2g", 255, 8, 1234.567, 3.2); double h = Double.parseDouble("0x1.8p1") + 0x1p-1;'
    )
  ).toEqual({ a: 135, b: 18, c: 13, astral: 'rejected', f: '0xff 010 1.23e+03   3.2', h: 3.5 });
});

test("Java casts a generic result where javac's checkcast does, and not where it does not", () => {
  expect(
    finalVarsOf(
      'Box<String> b = new Box<>(5); String casts = ""; for (Runnable r : List.<Runnable>of(() -> { int n = b.arr().length; }, () -> { for (String s : b.arr()) {} }, () -> { String s = "" + b.get(); }, () -> { var v = b.get(); }, () -> { String s = true ? b.get() : "x"; }, () -> { int n = b.data.length; }, () -> { Supplier<String> sp = b::get; sp.get(); }, () -> { Comparable<String> c = b.get(); }, () -> { Object o = b.get(); }, () -> { boolean x = b.get() == null; }, () -> b.get())) { try { r.run(); casts += "-"; } catch (ClassCastException e) { casts += "C"; } }',
      '',
      'class Box<T> { Object o; T[] data; @SuppressWarnings("unchecked") Box(Object o) { this.o = o; data = (T[]) new Object[] {o}; } @SuppressWarnings("unchecked") T get() { return (T) o; } @SuppressWarnings("unchecked") T[] arr() { return (T[]) new Object[] {o}; } }'
    )
  ).toEqual({ casts: 'CCCCCC-----' });
});

test('Java casts the elements an Iterator or a function receives from a polluted collection, as javac and the JVM do', () => {
  expect(
    finalVarsOf(
      'List<String> ls = new ArrayList<>(List.of("a")); ((List) ls).add(7); String casts = ""; for (Runnable r : List.<Runnable>of(() -> { for (String s : ls) {} }, () -> { for (Object o : ls) {} }, () -> ls.forEach(s -> s.length()), () -> ls.forEach((Object o) -> o.hashCode()), () -> ls.stream().map(String::length).forEach(x -> {}))) { try { r.run(); casts += "-"; } catch (ClassCastException e) { casts += "C"; } }'
    )
  ).toEqual({ casts: 'C-C-C' });
});

test('Java types lambdas and method references by casts, conditional branches, and switch expression arms', () => {
  expect(
    finalVarsOf(
      'StringBuilder out = new StringBuilder(); Runnable a = args.length == 0 ? () -> out.append("t") : () -> out.append("f"); a.run(); Runnable b = switch (1) { case 1 -> () -> out.append("s"); default -> out::reverse; }; b.run(); Object c = (Runnable) () -> out.append("c"); ((Runnable) c).run(); Supplier<String> d = args.length == 0 ? out::toString : () -> "x"; String result = d.get();'
    )
  ).toEqual({ result: 'tsc' });
});

test("Java's bulk operations, priority queue iterators, and unmodifiable wrappers follow the JDK's traversal rules", () => {
  expect(
    finalVarsOf(
      `List<Integer> a = new ArrayList<>(List.of(1, 2, 3)); String bulk = ""; try { a.removeIf(n -> { a.add(9); return n == 2; }); } catch (ConcurrentModificationException e) { bulk = a.toString(); }
PriorityQueue<Integer> q = new PriorityQueue<>(); for (int x : new int[] {0, 4, 1, 5, 6, 2, 3}) q.add(x); Iterator<Integer> i = q.iterator(); String seen = ""; while (i.hasNext()) { int x = i.next(); seen += x; if (x == 6) i.remove(); }
Set<Integer> s = new HashSet<>(Set.of(1)); Iterator<Integer> u = Collections.unmodifiableSet(s).iterator(); s.add(2); String wrapped = ""; try { u.next(); } catch (ConcurrentModificationException e) { wrapped = "cme"; }
List<String> nulls = new ArrayList<>(Arrays.asList("b", null, "a")); nulls.sort(Comparator.nullsFirst(Comparator.naturalOrder())); String sorted = nulls.toString();`
    )
  ).toEqual({ bulk: '[1, 2, 3, 9, 9, 9]', seen: '0415623', wrapped: 'cme', sorted: '[null, a, b]' });
});
