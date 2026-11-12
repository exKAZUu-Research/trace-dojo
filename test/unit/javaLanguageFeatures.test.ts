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
  [
    'primitive optionals and the long and float overloads of Math.clamp',
    'long clamped = Math.clamp(9_000_000_000_000L, 1L, 100L); float limited = Math.clamp(1.5f, 0.0f, 2.0f); String optionals = OptionalInt.of(7) + " " + OptionalDouble.of(2.5) + " " + OptionalLong.of(3L).getAsLong() + " " + OptionalInt.empty(); String nanBound = ""; try { Math.clamp(1.0, Double.NaN, 2.0); } catch (IllegalArgumentException e) { nanBound = e.getMessage(); } double radians = Math.toRadians(0.708); boolean zeros = OptionalDouble.of(-0.0).equals(OptionalDouble.of(0.0)); boolean nans = OptionalDouble.of(Double.NaN).equals(OptionalDouble.of(Double.NaN));',
    {},
    {
      clamped: 100,
      limited: 1.5,
      optionals: 'OptionalInt[7] OptionalDouble[2.5] 3 OptionalInt.empty',
      zeros: false,
      nans: true,
    },
  ],
  [
    'class literals of primitive, array, and void types',
    'String names = int.class.getName() + " " + boolean.class + " " + void.class + " " + int[].class.getName() + " " + String[][].class.getSimpleName(); boolean same = int[].class == new int[0].getClass();',
    {},
    { names: 'int boolean void [I String[][]', same: true },
  ],
  [
    'System.arraycopy, Collections.rotate and disjoint, and array stores through builtins',
    'int[] x = {1, 2, 3, 4, 5}; System.arraycopy(x, 0, x, 1, 4); String copied = Arrays.toString(x); String bounds = ""; try { System.arraycopy(x, 0, new int[3], 0, 5); } catch (ArrayIndexOutOfBoundsException e) { bounds = e.getMessage(); } List<Integer> r = new ArrayList<>(List.of(1, 2, 3, 4)); Collections.rotate(r, 1); String rotated = r.toString(); boolean disjoint = Collections.disjoint(List.of(1), Set.of(2)); Object[] strings = new String[] {"a"}; String stored = "ok"; try { Arrays.fill(strings, 1); } catch (ArrayStoreException e) { stored = e.getMessage(); } Object[] backed = new String[] {"p", "q"}; List<Object> view = Arrays.asList(backed); String replaced = ""; try { view.replaceAll(v -> v.equals("p") ? "r" : 1); } catch (ArrayStoreException e) { replaced = Arrays.toString(backed); }',
    {},
    {
      copied: '[1, 1, 2, 3, 4]',
      bounds: 'arraycopy: last destination index 5 out of bounds for int[3]',
      rotated: '[4, 1, 2, 3]',
      disjoint: true,
      stored: 'java.lang.Integer',
      replaced: '[r, q]',
    },
  ],
  [
    'float formatting, relative format indices, array names, and copyOfRange failures',
    'String rejected = ""; try { String.format("%-s", "a"); } catch (java.util.MissingFormatWidthException e) { rejected = e.getMessage(); } String radix = ""; try { Integer.parseInt("5", 40); } catch (NumberFormatException e) { radix = e.getMessage(); } String formatted = String.format("%.2f %.1f %s %<s", 1.005f, 0.35f, "a"); boolean named = ("" + new String[0]).startsWith("[Ljava.lang.String;@"); String range = ""; try { Arrays.copyOfRange(new int[3], 0, -1); } catch (IllegalArgumentException e) { range = e.getMessage(); }',
    {},
    {
      formatted: '1.00 0.3 a a',
      named: true,
      range: '0 > -1',
      rejected: '%-s',
      radix: 'radix 40 greater than Character.MAX_RADIX',
    },
  ],
  [
    'StringBuffer, appendCodePoint, Class<Void>, and method reference null messages',
    'StringBuffer buffer = new StringBuffer("x"); buffer.appendCodePoint(66); String built = buffer.toString() + new StringBuilder().appendCodePoint(0x1D7CF).length(); Class<Void> v = void.class; java.util.function.Function<String, Integer> f = String::length; String npe = "none"; try { f.apply(null); } catch (NullPointerException e) { npe = String.valueOf(e.getMessage()); }',
    {},
    { built: 'xB2', npe: 'null' },
  ],
  [
    'a generic field read by its simple name in a subclass',
    'Child child = new Child(); Parent raw = child; raw.value = 1; String read = ""; try { read = child.read(); } catch (ClassCastException e) { read = "cce"; }',
    {
      declarations:
        'class Parent<T> { T value; }\nclass Child extends Parent<String> { String read() { return value; } }',
    },
    { read: 'cce' },
  ],
  [
    'Map.replaceAll and the locale-taking text overloads',
    'Map<String, Integer> m = new TreeMap<>(Map.of("a", 1, "b", 2)); m.replaceAll((k, v) -> v * 10); String replaced = m.toString(); String localized = "ABC".toLowerCase(Locale.ROOT) + String.format(Locale.US, "%.2f", 1.5) + Locale.JAPAN;',
    {},
    { replaced: '{a=10, b=20}', localized: 'abc1.50ja_JP' },
  ],
  [
    'string methods that return the receiver or the pooled empty string',
    'String s = "abc"; StringBuilder sb = new StringBuilder("ab"); boolean same = s.replaceAll("x", "y") == s && s.replaceFirst("x", "y") == s && s.replace("b", "b") == s && s.split("x")[0] == s; boolean pooled = s.substring(3) == "" && s.repeat(0) == "" && "  ".strip() == "" && sb.substring(2, 2) == "" && new StringBuilder().toString() == "" && s.replace("abc", "") == "" && s.replaceAll(".", "") == ""; boolean fresh = sb.substring(0) == "ab" || s.replaceAll("b", "b") == s || s.replace("abc", "abc") == s || s.replace("", "") == s;',
    {},
    { same: true, pooled: true, fresh: false },
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
  [
    'an annotation of an undeclared type',
    'class A {}\n@Missing class B {}',
    'この採点環境には、アノテーション Missing がありません。',
  ],
  [
    'an annotation outside its targets',
    '@java.lang.annotation.Target(java.lang.annotation.ElementType.METHOD) @interface M {}\n@M class B {}',
    'アノテーション @M はここには付けられません。',
  ],
  [
    'a variable arity record component before another',
    'class A {}\nrecord R(int... xs, int y) {}',
    '可変長引数は最後の引数にしか使えません。',
  ],
  [
    'Type.super naming a class that does not enclose the code',
    'class A { String n() { return ""; } }\nclass B { String m() { return A.super.n(); } }',
    'A.super は、このクラスか外側のクラスにしか使えません。',
  ],
  [
    'an intersection cast with a class after &',
    'class A {}\nclass B { Object o = (Runnable & A) null; }',
    '交差型の & の後ろには、インターフェースしか書けません。',
  ],
  [
    'a subclass of an inner class without an enclosing instance',
    'class Outer { class Inner {} }\nclass Sub extends Outer.Inner { Sub() { super(); } }',
    'Inner のコンストラクタを呼び出すには、Outer のオブジェクトが必要です。',
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

test('Java runs varargs records and lambdas, qualified super, generic constructors, annotations, and intersection casts', () => {
  const program = `import java.io.Serializable;
import java.lang.annotation.*;
import java.util.*;
import java.util.function.*;
@Retention(RetentionPolicy.RUNTIME) @Target({ElementType.TYPE_USE, ElementType.METHOD}) @interface Tag { String value() default ""; }
@interface Note { int[] ids() default {}; }
record Scores(@Note String name, int... values) { @Override public String name() { return name.toUpperCase(); } }
record Box<T>(T value) {}
interface Summer { int of(int... xs); }
class Base { String who = "base"; String name() { return "base"; } }
class Derived extends Base {
  String name() { return "derived"; }
  Supplier<String> parentName() { return super::name; }
  class Inner { String names() { return Derived.super.name() + Derived.super.who + Derived.this.name(); } }
}
class Pair<A> { final A first; final String tag; <B> Pair(A first, B tag) { this.first = first; this.tag = String.valueOf(tag); } }
@Note(ids = {1, 2}) public class Main {
  int base = 2;
  @Tag("m") int times(@Tag Main this, int x) { return base * x; }
  static int digits()[] { return new int[] {4, 2}; }
  static int count(CharSequence text) { return text.length(); }
  public static void main(String[] args) {
    Scores s = new Scores("ann", 3, 4);
    Summer sum = (int... xs) -> Arrays.stream(xs).sum();
    System.out.println(s.name() + s.values().length + new Scores("bo").values().length + sum.of(1, 2) + sum.of());
    Derived d = new Derived();
    System.out.println(d.parentName().get() + " " + d.new Inner().names());
    Pair<String> p = new <Integer>Pair<String>("x", 7);
    System.out.println(p.first + p.tag + new Main().times(5) + digits()[1]);
    @Tag List<@Tag String> tags = new ArrayList<>();
    int @Tag [] grid = new int @Tag [2];
    Runnable r = (Runnable & Serializable) () -> tags.add("run");
    r.run();
    System.out.println(tags + " " + grid.length + " " + (r instanceof Serializable) + " " + ("s" instanceof Serializable));
    System.out.println(count("abc") + count(new StringBuilder("de")) + " " + ((CharSequence) "xyz").subSequence(1, 3));
    for (Object o = "abc"; o instanceof String str && !str.isEmpty(); o = str.substring(1)) System.out.print(str + " ");
    Box<String> box = new Box<>("hello");
    if (box instanceof Box(var v)) System.out.println(v.length());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout: 'ANN2030\nbase basebasederived\nx7102\n[run] 2 true true\n5 yz\nabc bc c 5\n',
    uncaughtException: undefined,
  });
});

test('Java gives an inner superclass the enclosing instance that outer.super(...) names', () => {
  const program = `class Outer { String name; Outer(String n) { name = n; } class Inner { final String tag; Inner(String t) { tag = t; } String get() { return name + tag; } } }
class Sub extends Outer.Inner { Sub(Outer o, String t) { o.super(t + "!"); } }
public class Main {
  public static void main(String[] a) {
    System.out.println(new Sub(new Outer("x"), "y").get());
    Outer none = null;
    try { new Sub(none, "z"); } catch (NullPointerException e) { System.out.println("NPE"); }
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout: 'xy!\nNPE\n' });
});

test('Java wraps an exception from a static initializer and rejects later uses of the class, as the JVM does', () => {
  const program = `class Bad { static int v; static { System.out.println("init"); if (true) throw new IllegalStateException("bad init"); } static void f() {} }
class Deep { static { recurse(0); } static int recurse(int n) { return recurse(n + 1) + 1; } static int x = 1; }
class Nested { static class Inner { static int v = Integer.parseInt("x"); } }
public class Main {
  public static void main(String[] a) {
    try { Bad.f(); } catch (ExceptionInInitializerError e) { System.out.println("1 " + e + " / " + e.getCause() + " / " + e.getMessage()); }
    try { System.out.println(Bad.v); } catch (NoClassDefFoundError e) { System.out.println("2 " + e + " / " + e.getCause()); }
    try { new Bad(); } catch (Throwable e) { System.out.println("3 " + e); }
    try { System.out.println(Deep.x); } catch (StackOverflowError e) { System.out.println("4 SOE"); }
    try { System.out.println(Deep.x); } catch (Throwable e) { System.out.println("5 " + e); }
    try { System.out.println(Nested.Inner.v); } catch (Throwable e) { System.out.println("6 " + e + " / " + e.getCause()); }
    ExceptionInInitializerError made = new ExceptionInInitializerError(new RuntimeException("r"));
    System.out.println(made + " " + made.getCause() + " " + new ExceptionInInitializerError("m").getMessage());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'init\n1 java.lang.ExceptionInInitializerError / java.lang.IllegalStateException: bad init / null\n2 java.lang.NoClassDefFoundError: Could not initialize class Bad / java.lang.ExceptionInInitializerError: Exception java.lang.IllegalStateException: bad init [in thread "main"]\n3 java.lang.NoClassDefFoundError: Could not initialize class Bad\n4 SOE\n5 java.lang.NoClassDefFoundError: Could not initialize class Deep\n6 java.lang.ExceptionInInitializerError / java.lang.NumberFormatException: For input string: "x"\njava.lang.ExceptionInInitializerError java.lang.RuntimeException: r m\n',
  });
});

test("Java's lists report indexes outside them with the exception and message of each JDK list class", () => {
  const program = `import java.util.*;
public class Main {
  static void t(String label, Runnable r) { try { r.run(); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] a) {
    t("nCopies", () -> Collections.nCopies(3, "x").get(5));
    t("single", () -> Collections.singletonList(1).get(1));
    t("emptyNeg", () -> Collections.emptyList().get(-1));
    t("unmodOf", () -> Collections.unmodifiableList(List.of(1, 2, 3)).get(5));
    t("unmodLinked", () -> Collections.unmodifiableList(new LinkedList<>(List.of(1))).get(5));
    t("unmodAsList", () -> Collections.unmodifiableList(Arrays.asList(1)).get(5));
    t("linkedSet", () -> new LinkedList<>(List.of(1)).set(3, 1));
    t("linkedRemove", () -> new LinkedList<>(List.of(1)).remove(3));
    t("linkedAdd", () -> new LinkedList<>(List.of(1)).add(3, 1));
    t("asListSet", () -> Arrays.asList(1).set(3, 1));
    t("of12set", () -> List.of(1).set(3, 1));
    t("copyOf1", () -> List.copyOf(List.of(1)).get(4));
    t("copyOf2", () -> List.copyOf(new ArrayList<>(List.of(1, 2))).get(4));
    t("stack", () -> new Stack<Integer>().get(0));
    t("vectorish", () -> { Stack<Integer> s = new Stack<>(); s.push(1); s.set(2, 1); });
    t("linkedGetFirst", () -> new LinkedList<Integer>().getFirst());
    t("ofIndexOf", () -> System.out.println(List.of(1, 2).indexOf(2)));
    System.out.println(List.of(1).getClass().getName() + " " + List.of(1, 2, 3).getClass().getName() + " " + List.of().getClass().getName() + " " + Collections.emptyList().getClass().getName() + " " + Collections.singletonList(1).getClass().getName() + " " + Arrays.asList(1).getClass().getName() + " " + Collections.nCopies(2, 1).getClass().getName() + " " + Collections.unmodifiableList(new ArrayList<>()).getClass().getName() + " " + Collections.unmodifiableList(new LinkedList<>()).getClass().getName() + " " + java.util.stream.Stream.of(1).toList().getClass().getName());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'nCopies java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 3\nsingle java.lang.IndexOutOfBoundsException: Index: 1, Size: 1\nemptyNeg java.lang.IndexOutOfBoundsException: Index: -1\nunmodOf java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 3\nunmodLinked java.lang.IndexOutOfBoundsException: Index: 5, Size: 1\nunmodAsList java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 1\nlinkedSet java.lang.IndexOutOfBoundsException: Index: 3, Size: 1\nlinkedRemove java.lang.IndexOutOfBoundsException: Index: 3, Size: 1\nlinkedAdd java.lang.IndexOutOfBoundsException: Index: 3, Size: 1\nasListSet java.lang.ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 1\nof12set java.lang.UnsupportedOperationException\ncopyOf1 java.lang.IndexOutOfBoundsException: Index: 4 Size: 1\ncopyOf2 java.lang.IndexOutOfBoundsException: Index: 4 Size: 2\nstack java.lang.ArrayIndexOutOfBoundsException: Array index out of range: 0\nvectorish java.lang.ArrayIndexOutOfBoundsException: Array index out of range: 2\nlinkedGetFirst java.util.NoSuchElementException\n1\njava.util.ImmutableCollections$List12 java.util.ImmutableCollections$ListN java.util.ImmutableCollections$ListN java.util.Collections$EmptyList java.util.Collections$SingletonList java.util.Arrays$ArrayList java.util.Collections$CopiesList java.util.Collections$UnmodifiableRandomAccessList java.util.Collections$UnmodifiableList java.util.ImmutableCollections$ListN\n',
  });
});

test('Java offers primitive functional interfaces, Predicate factories, and utilities that compute as the JDK does', () => {
  const program = `import java.util.*;
import java.util.function.*;
import java.util.stream.*;
enum Op { A { }, B }
public class Main {
  public static void main(String[] args) {
    IntSupplier supplier = () -> 3;
    LongPredicate big = x -> x > 2;
    IntPredicate even = x -> x % 2 == 0;
    ObjIntConsumer<String> show = (s, i) -> System.out.print(s + i + " ");
    show.accept("x", supplier.getAsInt());
    System.out.println(big.negate().test(3) + " " + even.and(x -> x > 2).test(4) + " " + Predicate.isEqual("a").test("a") + " " + Predicate.not(Predicate.isEqual("a")).test("a"));
    List<Integer> dst = new ArrayList<>(List.of(0, 0, 0));
    Collections.copy(dst, List.of(1, 2));
    System.out.println(dst + " " + Collections.singleton(5));
    System.out.println(Integer.compareUnsigned(-1, 1) + " " + Integer.toUnsignedLong(-1) + " " + Integer.rotateLeft(1, 33) + " " + Integer.decode("-0x10") + " " + Integer.decode("010") + " " + Character.charCount(0x1F600));
    try { Integer.decode("0x-1"); } catch (NumberFormatException e) { System.out.println(e.getMessage()); }
    System.out.println(Stream.of(1e16, 1.0, 1.0, -1e16).collect(Collectors.summingDouble(x -> x)) + " " + Stream.of(1e16, 1.0, 1.0, -1e16).collect(Collectors.averagingDouble(x -> x)));
    System.out.println(Op.A.getDeclaringClass() + " " + Op.B.getDeclaringClass());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'x3 false true true false\n[1, 2, 0] [5]\n1 4294967295 2 -16 8 2\nSign character in wrong position\n2.0 0.5\nclass Op class Op\n',
  });
});

test('Java appends any CharSequence to string builders and writers through Appendable', () => {
  const program = `import java.io.*;
public class Main {
  static void fill(Appendable out) throws IOException { out.append("ab").append('c').append(new StringBuilder("xyz"), 1, 3); }
  public static void main(String[] args) throws IOException {
    StringBuilder sb = new StringBuilder();
    fill(sb);
    sb.append((CharSequence) null).append("hello", 1, 3).append(new StringBuilder("!"));
    System.out.println(sb);
    StringWriter sw = new StringWriter();
    fill(sw);
    sw.append(new StringBuilder("q")).append(null).append("hey", 0, 2);
    System.out.println(sw);
    PrintWriter pw = new PrintWriter(System.out, true);
    pw.append(sb, 0, 2).append('\\n');
    pw.flush();
    try { sb.append("abc", 2, 1); } catch (IndexOutOfBoundsException e) { System.out.println(e); }
    try { sw.append("abc", 2, 1); } catch (IndexOutOfBoundsException e) { System.out.println(e); }
    try { sw.append(new StringBuilder("abc"), 2, 5); } catch (IndexOutOfBoundsException e) { System.out.println(e); }
    try { sw.append(null, 0, 9); } catch (IndexOutOfBoundsException e) { System.out.println(e); }
    Appendable a = sb;
    System.out.println(a instanceof CharSequence);
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'abcyznullel!\nabcyzqnullhe\nab\njava.lang.IndexOutOfBoundsException: Range [2, 1) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [2, 1) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [2, 5) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [0, 9) out of bounds for length 4\ntrue\n',
  });
});

test('Java runs method references to array types and generic members of generic classes', () => {
  const program = `import java.util.*;
import java.util.function.*;
public class Main {
  static class Outer<T> { T v; Outer(T v) { this.v = v; } class Inner { T get() { return v; } } }
  static class Pair<K, V> implements Map.Entry<K, V> { K k; V v; Pair(K k, V v) { this.k = k; this.v = v; } public K getKey() { return k; } public V getValue() { return v; } public V setValue(V nv) { V o = v; v = nv; return o; } }
  static abstract class Shape<T extends Number> { abstract T size(); String describe() { return "size " + size(); } }
  <T> T pick(T a) { return a; }
  static void swapFirst(List<?> list) { swapHelper(list); }
  static <T> void swapHelper(List<T> list) { T t = list.get(0); list.set(0, list.get(1)); list.set(1, t); }
  public static void main(String[] args) {
    Outer<String> o = new Outer<>("ov");
    Outer<String>.Inner in = o.new Inner();
    System.out.println(in.get().length());
    Map.Entry<String, Integer> e = new Pair<>("k", 1); e.setValue(5); System.out.println(e.getKey() + e.getValue());
    Shape<Integer> sq = new Shape<>() { int side = 3; { side++; } Integer size() { return side * side; } };
    System.out.println(sq.describe());
    Main m = new Main();
    Function<String, String> f = m::<String>pick; System.out.println(f.apply("p"));
    Function<List<String>, Integer> size = List<String>::size; System.out.println(size.apply(List.of("a", "b")));
    UnaryOperator<int[]> cl = int[]::clone; int[] src = {1}; int[] cp = cl.apply(src); cp[0] = 2; System.out.println(src[0] + "" + cp[0]);
    IntFunction<String[]> mk = String[]::new; System.out.println(mk.apply(3).length);
    List<Runnable> rs = new ArrayList<>();
    for (int i = 0; i < 3; i++) { int j = i; rs.add(() -> System.out.print(j)); }
    for (String s : List.of("a", "b")) rs.add(() -> System.out.print(s));
    rs.forEach(Runnable::run); System.out.println();
    List<Object> mixed = new ArrayList<>(List.of(1, 2)); swapFirst(mixed); System.out.println(mixed);
    Integer boxed = 3; switch (boxed) { case 3 -> System.out.println("three"); default -> System.out.println("no"); }
    Character ch = 'x'; switch (ch) { case 'x': System.out.println("ex"); break; default: break; }
    var list = new ArrayList<>(); list.add(1); list.add("s"); System.out.println(list);
    for (var x : new int[] {4, 5}) System.out.print(x); System.out.println();
    Integer nul = null;
    try { int y = args.length == 0 ? nul : 0; } catch (NullPointerException ex) { System.out.println("NPE"); }
    switch ("Aa") { case "BB" -> System.out.println("BB"); case "Aa" -> System.out.println("Aa"); default -> System.out.println("none"); }
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout: '2\nk5\nsize 16\np\n2\n12\n3\n012ab\n[2, 1]\nthree\nex\n[1, s]\n45\nNPE\nAa\n',
  });
});

test("Java's DoubleStream sums with compensation and orders, compares, and reduces doubles as the JDK does", () => {
  const program = `import java.util.*;
import java.util.stream.*;
public class Main {
  record Item(String name, double price) {}
  public static void main(String[] args) {
    List<Item> items = List.of(new Item("a", 1.5), new Item("b", 2.25), new Item("c", 0.1));
    System.out.println(items.stream().mapToDouble(Item::price).sum());
    System.out.println(items.stream().mapToDouble(Item::price).average().getAsDouble());
    System.out.println(items.stream().mapToDouble(Item::price).max().getAsDouble() + " " + items.stream().mapToDouble(i -> i.price()).min());
    System.out.println(DoubleStream.of(1e16, 1.0, 1.0, -1e16).sum() + " " + DoubleStream.of(1e16, 1.0, 1.0, -1e16).average().getAsDouble());
    System.out.println(DoubleStream.of(Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).sum() + " " + DoubleStream.of(Double.POSITIVE_INFINITY, 1).sum());
    System.out.println(DoubleStream.of().average() + " " + DoubleStream.of().sum() + " " + DoubleStream.of(3, 1, 2).sorted().boxed().toList());
    System.out.println(Arrays.toString(DoubleStream.of(0.0, -0.0, Double.NaN, 0.0, Double.NaN).distinct().toArray()));
    System.out.println(Arrays.toString(DoubleStream.of(2, Double.NaN, -0.0, 0.0, -1).sorted().toArray()));
    System.out.println(DoubleStream.of(1, Double.NaN).max() + " " + DoubleStream.of(-0.0, 0.0).max() + " " + DoubleStream.of(0.0, -0.0).min());
    double[] arr = {1.5, 2.5};
    System.out.println(Arrays.stream(arr).map(x -> x * 2).filter(x -> x > 3).count() + " " + Arrays.stream(arr).mapToObj(x -> "v" + x).collect(Collectors.joining(",")));
    System.out.println(IntStream.rangeClosed(1, 4).mapToDouble(i -> i / 2.0).sum() + " " + IntStream.range(0, 3).asDoubleStream().boxed().toList());
    System.out.println(DoubleStream.of(1.7, 2.2).mapToInt(x -> (int) x).sum() + " " + DoubleStream.of(1, 2, 3).reduce(0, (a, b) -> a + b) + " " + DoubleStream.of(1, 2).reduce(Double::sum));
    System.out.println(DoubleStream.of(1, 2, 3).anyMatch(x -> x > 2) + " " + DoubleStream.of(1, 2).limit(1).findFirst().getAsDouble() + " " + DoubleStream.of(4, 5).skip(1).boxed().toList());
    DoubleStream.of(0.1, 0.2).forEach(x -> System.out.print(x + ";"));
    System.out.println();
    System.out.println(items.stream().mapToDouble(Item::price).map(Math::floor).sum());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '3.85\n1.2833333333333334\n2.25 OptionalDouble[0.1]\n2.0 0.5\nNaN Infinity\nOptionalDouble.empty 0.0 [1.0, 2.0, 3.0]\n[0.0, -0.0, NaN]\n[-1.0, -0.0, 0.0, 2.0, NaN]\nOptionalDouble[NaN] OptionalDouble[0.0] OptionalDouble[-0.0]\n1 v1.5,v2.5\n5.0 [0.0, 1.0, 2.0]\n3 6.0 OptionalDouble[3.0]\ntrue 1.0 [5.0]\n0.1;0.2;\n3.0\n',
  });
});

test('Java summarizes ints and doubles in IntSummaryStatistics and DoubleSummaryStatistics as the JDK does', () => {
  const program = `import java.util.*;
import java.util.stream.*;
public class Main {
  public static void main(String[] args) {
    IntSummaryStatistics is = IntStream.of(4, -2, 9).summaryStatistics();
    System.out.println(is + " " + is.getCount() + " " + is.getSum() + " " + is.getMin() + " " + is.getMax() + " " + is.getAverage());
    IntSummaryStatistics empty = new IntSummaryStatistics();
    System.out.println(empty + " " + empty.getAverage());
    empty.accept(Integer.MAX_VALUE); empty.accept(Integer.MAX_VALUE); empty.combine(is);
    System.out.println(empty.getSum() + " " + empty.getCount());
    DoubleSummaryStatistics ds = DoubleStream.of(0.1, 0.2, 0.3).summaryStatistics();
    System.out.println(ds + " " + ds.getSum() + " " + ds.getAverage() + " " + ds.getMax());
    DoubleSummaryStatistics de = new DoubleSummaryStatistics();
    System.out.println(de + " " + de.getMin() + " " + de.getAverage());
    de.accept(1e16); de.accept(1); de.accept(1); de.combine(DoubleStream.of(-1e16, Double.NaN).summaryStatistics());
    System.out.println(de.getSum() + " " + de.getMax() + " " + de.getMin());
    System.out.println(Stream.of("aa", "b", "cccc").collect(Collectors.summarizingInt(String::length)));
    System.out.println(Stream.of(1.5, 2.5).collect(Collectors.summarizingDouble(x -> x)).getSum());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'IntSummaryStatistics{count=3, sum=11, min=-2, average=3.666667, max=9} 3 11 -2 9 3.6666666666666665\nIntSummaryStatistics{count=0, sum=0, min=2147483647, average=0.000000, max=-2147483648} 0.0\n4294967305 5\nDoubleSummaryStatistics{count=3, sum=0.600000, min=0.100000, average=0.200000, max=0.300000} 0.6 0.19999999999999998 0.3\nDoubleSummaryStatistics{count=0, sum=0.000000, min=Infinity, average=0.000000, max=-Infinity} Infinity 0.0\nNaN NaN NaN\nIntSummaryStatistics{count=3, sum=7, min=1, average=2.333333, max=4}\n4.0\n',
  });
});

test("Java's LongStream ranges, maps, and sums longs with Java's wrapping arithmetic", () => {
  const program = `import java.util.*;
import java.util.stream.*;
public class Main {
  public static void main(String[] args) {
    System.out.println(LongStream.rangeClosed(1, 20).reduce(1, (x, y) -> x * y));
    System.out.println(LongStream.rangeClosed(1, 21).reduce(1, (x, y) -> x * y));
    System.out.println(LongStream.range(0, 5).sum() + " " + LongStream.range(5, 0).count() + " " + LongStream.of(Long.MAX_VALUE, 1).sum());
    System.out.println(LongStream.of(3, 1, 2).sorted().boxed().toList() + " " + LongStream.of(4, 9).max() + " " + LongStream.of().min() + " " + LongStream.of(1, 2).average());
    System.out.println(Stream.of("a", "bbb").mapToLong(String::length).sum() + " " + IntStream.of(1, 2).mapToLong(i -> i * 10_000_000_000L).sum() + " " + IntStream.range(0, 3).asLongStream().boxed().toList());
    long[] arr = {5, 6};
    System.out.println(Arrays.stream(arr).map(x -> x * x).filter(x -> x > 25).findFirst() + " " + Arrays.toString(LongStream.of(7, 7, 8).distinct().toArray()) + " " + LongStream.of(2, 3).mapToObj(Long::toString).collect(Collectors.joining("-")));
    System.out.println(LongStream.of(1, 2, 3).mapToInt(x -> (int) x * 2).sum() + " " + LongStream.rangeClosed(1, 3).anyMatch(x -> x == 3) + " " + LongStream.of(10).limit(1).skip(0).count());
    LongStream.of(1, 2).forEach(x -> System.out.print(x + ","));
    System.out.println();
    System.out.println(DoubleStream.of(1, 2).mapToInt(x -> (int) x).sum() + " " + IntStream.of(1).asDoubleStream().sum());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '2432902008176640000\n-4249290049419214848\n10 0 -9223372036854775808\n[1, 2, 3] OptionalLong[9] OptionalLong.empty OptionalDouble[1.5]\n4 30000000000 [0, 1, 2]\nOptionalLong[36] [7, 8] 2-3\n12 true 1\n1,2,\n3 1.0\n',
  });
});

test('Java collects longs with summingLong, averagingLong, and LongSummaryStatistics as the JDK does', () => {
  const program = `import java.util.*;
import java.util.stream.*;
public class Main {
  record P(String n, long a) {}
  public static void main(String[] args) {
    List<P> ps = List.of(new P("x", 3_000_000_000L), new P("y", 5), new P("z", -2));
    System.out.println(ps.stream().mapToLong(P::a).sum() + " " + ps.stream().collect(Collectors.summingLong(P::a)) + " " + ps.stream().collect(Collectors.averagingLong(P::a)));
    System.out.println(ps.stream().collect(Collectors.summarizingLong(P::a)));
    System.out.println(Stream.<P>empty().collect(Collectors.averagingLong(P::a)) + " " + Stream.of(Long.MAX_VALUE, 1L).collect(Collectors.summingLong(x -> x)));
    LongSummaryStatistics ls = LongStream.of(4, 9, -1).summaryStatistics();
    ls.accept(7); ls.accept(10L);
    System.out.println(ls + " " + ls.getMin() + " " + ls.getMax() + " " + ls.getSum() + " " + ls.getAverage());
    LongSummaryStatistics empty = new LongSummaryStatistics();
    System.out.println(empty + " " + empty.getMin() + " " + empty.getMax());
    empty.combine(ls);
    System.out.println(empty.getCount() + " " + empty.getSum());
    System.out.println(IntStream.of(Integer.MAX_VALUE, Integer.MAX_VALUE).summaryStatistics().getSum() + " " + Stream.of(1, 2).collect(Collectors.summarizingInt(x -> x)).getMax());
    System.out.println(Stream.of(1.5).collect(Collectors.summarizingDouble(x -> x)));
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      '3000000003 3000000003 1.000000001E9\nLongSummaryStatistics{count=3, sum=3000000003, min=-2, average=1000000001.000000, max=3000000000}\n0.0 -9223372036854775808\nLongSummaryStatistics{count=5, sum=29, min=-1, average=5.800000, max=10} -1 10 29 5.8\nLongSummaryStatistics{count=0, sum=0, min=9223372036854775807, average=0.000000, max=-9223372036854775808} 9223372036854775807 -9223372036854775808\n5 29\n4294967294 2\nDoubleSummaryStatistics{count=1, sum=1.500000, min=1.500000, average=1.500000, max=1.500000}\n',
  });
});

test('Java creates empty streams of objects and of each primitive type', () => {
  const program = `import java.util.*;
import java.util.stream.*;
public class Main {
  public static void main(String[] args) {
    System.out.println(Stream.empty().count() + " " + IntStream.empty().sum() + " " + LongStream.empty().max() + " " + DoubleStream.empty().average() + " " + Stream.<String>empty().findFirst());
    Stream<Integer> s = Stream.empty();
    System.out.println(s.map(x -> x + 1).toList());
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 0 OptionalLong.empty OptionalDouble.empty Optional.empty\n[]\n',
  });
});

test("Java's String.codePoints pairs surrogates, and Objects.requireNonNullElse falls back as the JDK does", () => {
  const program = `import java.util.*;
public class Main {
  public static void main(String[] args) {
    System.out.println("h😀\\uD83Dx".codePoints().count() + " " + Arrays.toString("a😀".codePoints().toArray()) + " " + "ab".codePoints().map(c -> c + 1).sum());
    System.out.println(Objects.requireNonNullElse(null, "fallback") + " " + Objects.requireNonNullElse("value", "fallback"));
    try { Objects.requireNonNullElse(null, null); } catch (NullPointerException e) { System.out.println(e.getMessage()); }
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 [97, 128512] 197\nfallback value\ndefaultObj\n',
  });
});

test("Java's lists check listIterator positions and subList ranges with each JDK list's exception and message", () => {
  const program = `import java.util.*;
public class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    List<Integer> a = new ArrayList<>(List.of(1, 2));
    t("li", () -> a.listIterator(5));
    t("liNeg", () -> a.listIterator(-1));
    t("liLinked", () -> new LinkedList<>(a).listIterator(5));
    t("liOf", () -> List.of(1, 2).listIterator(5));
    t("liOf3", () -> List.of(1, 2, 3).listIterator(5));
    t("liAsList", () -> Arrays.asList(1, 2).listIterator(5));
    t("sub5", () -> a.subList(0, 5));
    t("subNeg", () -> a.subList(-1, 1));
    t("sub21", () -> a.subList(2, 1));
    t("subLinked", () -> new LinkedList<>(a).subList(0, 5));
    t("subOf", () -> List.of(1, 2).subList(0, 5));
    t("subOf3", () -> List.of(1, 2, 3).subList(2, 1));
    t("subAsList", () -> Arrays.asList(1, 2).subList(-1, 1));
    t("addAt", () -> a.add(5, 9));
    t("addAtLinked", () -> new LinkedList<>(a).add(5, 9));
    t("addAtNeg", () -> a.add(-1, 9));
    t("removeLinked", () -> new LinkedList<>(a).remove(5));
    t("setStack", () -> { Stack<Integer> s = new Stack<>(); s.push(1); s.set(-1, 2); });
    t("addAll", () -> a.addAll(5, List.of(1)));
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'li java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\nliNeg java.lang.IndexOutOfBoundsException: Index: -1, Size: 2\nliLinked java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\nliOf java.lang.IndexOutOfBoundsException: Index: 5 Size: 2\nliOf3 java.lang.IndexOutOfBoundsException: Index: 5 Size: 3\nliAsList java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\nsub5 java.lang.IndexOutOfBoundsException: toIndex = 5\nsubNeg java.lang.IndexOutOfBoundsException: fromIndex = -1\nsub21 java.lang.IllegalArgumentException: fromIndex(2) > toIndex(1)\nsubLinked java.lang.IndexOutOfBoundsException: toIndex = 5\nsubOf java.lang.IndexOutOfBoundsException: toIndex = 5\nsubOf3 java.lang.IllegalArgumentException: fromIndex(2) > toIndex(1)\nsubAsList java.lang.IndexOutOfBoundsException: fromIndex = -1\naddAt java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\naddAtLinked java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\naddAtNeg java.lang.IndexOutOfBoundsException: Index: -1, Size: 2\nremoveLinked java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\nsetStack java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 10\naddAll java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\n',
  });
});

test('Java infers what a lambda that only throws leaves open from the primitive type its result is assigned to', () => {
  for (const [program, stdout] of [
    [
      `import java.util.function.*;
public class Main {
  static <T> T timed(Supplier<T> s) { return s.get(); }
  static void timed(Runnable r) { r.run(); }
  public static void main(String[] args) {
    try { int r = timed(() -> { throw new RuntimeException("x"); }); } catch (RuntimeException e) { System.out.println(e.getMessage()); }
    String s = timed(() -> "v"); System.out.println(s);
    timed(() -> System.out.println("run"));
  }
}`,
      'x\nv\nrun\n',
    ],
    [
      `import java.util.*;
import java.util.function.*;
public class Main {
  static <T> T get(Supplier<T> s) { return s.get(); }
  static <T, R> R apply(Function<T, R> f, T t) { return f.apply(t); }
  public static void main(String[] args) {
    long a = get(() -> 5);
    double b = get(() -> 2);
    int c = apply(s -> s.length(), "four");
    try { int e = get(() -> { throw new IllegalStateException("thrown"); }); } catch (IllegalStateException e) { System.out.println(e.getMessage()); }
    try { boolean f = get(() -> { throw new RuntimeException("bool"); }); } catch (RuntimeException e) { System.out.println(e.getMessage()); }
    System.out.println(a + " " + b + " " + c);
    int sum = List.of(1, 2, 3).stream().reduce(0, (x, y) -> x + y);
    System.out.println(sum);
  }
}`,
      'thrown\nbool\n5 2.0 4\n6\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java reports regular expression syntax errors with the description, index, and caret of PatternSyntaxException', () => {
  const program = `import java.util.regex.*;
public class Main {
  public static void main(String[] args) {
    for (String p : new String[] {"+", "*", "?", "a|*", "(+)", "[a", "(a", "a)", "a{3,2}", "{", "a{", "x**", "\\\\", "[z-a]", "a(?<n>b)\\\\k<m>", "(?<1a>x)", "\\\\p{Foo}", ")"}) {
      try { "1+2*3".split(p); System.out.println(p + " ok"); }
      catch (PatternSyntaxException e) { System.out.println("[" + e.getMessage() + "]"); }
    }
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "[Dangling meta character '+' near index 0\n+\n^]\n[Dangling meta character '*' near index 0\n*\n^]\n[Dangling meta character '?' near index 0\n?\n^]\n[Dangling meta character '*' near index 2\na|*\n  ^]\n[Dangling meta character '+' near index 1\n(+)\n ^]\n[Unclosed character class near index 1\n[a\n ^]\n[Unclosed group near index 2\n(a]\n[Unmatched closing ')' near index 0\na)\n^]\n[Illegal repetition range near index 5\na{3,2}\n     ^]\n[Illegal repetition near index 1\n{]\n[Illegal repetition near index 2\na{]\n[Dangling meta character '*' near index 2\nx**\n  ^]\n[Unescaped trailing backslash near index 1\n\\]\n[Illegal character range near index 3\n[z-a]\n   ^]\n[named capturing group <m> does not exist near index 12\na(?<n>b)\\k<m>\n            ^]\n[capturing group name does not start with a Latin letter near index 3\n(?<1a>x)\n   ^]\n[Unknown character property name {Foo} near index 6\n\\p{Foo}\n      ^]\n[Unmatched closing ')'\n)]\n",
  });
});

test('Java reads quantified anchors and back references to missing groups in regular expressions as Pattern does', () => {
  const program = `import java.util.regex.*;
public class Main {
  public static void main(String[] args) {
    String[] patterns = {"a|b", "(a|b)+", "(?:x)*", "[a]+", "\\\\d+", ".*", "^\\\\s*$", "(?i)a+", "a{2}", "x*?", "(?<n>a)+", "\\\\Q+\\\\E+", "(?x) a + ", "a(?i)b*", "\\\\bx+", "(?=a)a+", "a{2,}?", "[+*?]+", "\\\\++", "^*", "$?", "a|", "|a", "()+", "\\\\101", "(a)\\\\1+"};
    for (String p : patterns) {
      try { System.out.println(p + " " + "AAaa+bx".replaceAll(p, "_")); }
      catch (PatternSyntaxException e) { System.out.println("[" + e.getMessage() + "]"); }
    }
    try { "1+2".split("+"); } catch (PatternSyntaxException e) { System.out.println(e.getDescription() + "|" + e.getIndex() + "|" + e.getPattern()); }
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "a|b AA__+_x\n(a|b)+ AA_+_x\n(?:x)* _A_A_a_a_+_b__\n[a]+ AA_+bx\n\\d+ AAaa+bx\n.* __\n^\\s*$ AAaa+bx\n(?i)a+ _+bx\na{2} AA_+bx\nx*? _A_A_a_a_+_b_x_\n(?<n>a)+ AA_+bx\n\\Q+\\E+ AAaa_bx\n(?x) a +  AA_+bx\na(?i)b* AA__+bx\n\\bx+ AAaa+bx\n(?=a)a+ AA_+bx\na{2,}? AA_+bx\n[+*?]+ AAaa_bx\n\\++ AAaa_bx\n^* _A_A_a_a_+_b_x_\n$? _A_A_a_a_+_b_x_\na| _A_A___+_b_x_\n|a _A_A_a_a_+_b_x_\n()+ _A_A_a_a_+_b_x_\n\\101 AAaa+bx\n(a)\\1+ AA_+bx\nDangling meta character '+'|0|+\n",
  });
});

test("Java's subList is a view that writes through to its list and fails once the list changes in size", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
public class Main {
  public static void main(String[] args) {
    List<Integer> list = new ArrayList<>(List.of(1, 2, 3, 4, 5, 6));
    list.subList(1, 3).clear();
    System.out.println(list);
    List<Integer> mid = list.subList(1, 3);
    mid.set(0, 40); mid.add(99); mid.remove(Integer.valueOf(5));
    System.out.println(mid + " " + list + " " + mid.size());
    Collections.sort(list.subList(0, 3), Collections.reverseOrder());
    System.out.println(list);
    list.subList(0, 2).replaceAll(x -> x * 10);
    System.out.println(list + " " + list.subList(1, 4).indexOf(990) + " " + list.subList(1, 4).contains(6) + " " + list.subList(2, 2).isEmpty());
    int sum = 0; for (int x : list.subList(1, 3)) sum += x; System.out.println(sum);
    List<Integer> nested = list.subList(0, 4).subList(1, 3); nested.clear(); System.out.println(list);
    list.subList(0, 1).removeIf(x -> x > 100); System.out.println(list);
    List<String> linked = new LinkedList<>(List.of("a", "b", "c", "d"));
    linked.subList(1, 3).add(0, "x"); System.out.println(linked);
    List<String> fixed = Arrays.asList("p", "q", "r");
    fixed.subList(0, 2).set(1, "Q"); System.out.println(fixed);
    try { fixed.subList(0, 1).add("z"); } catch (UnsupportedOperationException e) { System.out.println("UOE"); }
    try { List.of(1, 2).subList(0, 1).set(0, 3); } catch (UnsupportedOperationException e) { System.out.println("UOE2"); }
    List<Integer> nums = new ArrayList<>(List.of(1, 2, 3));
    Iterator<Integer> it = nums.iterator(); nums.subList(0, 1).clear();
    try { it.next(); } catch (ConcurrentModificationException e) { System.out.println("CME"); }
    System.out.println(nums.subList(0, 2).toString() + nums.subList(0, 2).equals(List.of(2, 3)) + " " + new ArrayList<>(nums.subList(1, 2)) + " " + nums.subList(0, 2).stream().mapToInt(x -> x).sum());
  }
}`,
      '[1, 4, 5, 6]\n[40, 99] [1, 40, 99, 6] 2\n[99, 40, 1, 6]\n[990, 400, 1, 6] -1 true true\n401\n[990, 6]\n[6]\n[a, x, b, c, d]\n[p, Q, r]\nUOE\nUOE2\nCME\n[2, 3]true [3] 5\n',
    ],
    [
      `import java.util.*;
public class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    List<Integer> list = new ArrayList<>(List.of(1, 2, 3, 4));
    List<Integer> view = list.subList(1, 3);
    list.add(5);
    t("get", () -> view.get(0));
    t("size", () -> view.size());
    t("print", () -> System.out.println(view));
    t("set", () -> view.set(0, 9));
    List<Integer> second = list.subList(0, 2);
    list.set(0, 7);
    t("afterSet", () -> System.out.println(second));
    List<Integer> nested = list.subList(0, 4).subList(1, 3);
    nested.add(8);
    t("parentOfNested", () -> System.out.println(list));
    t("sort", () -> Collections.sort(view));
    t("forEach", () -> { for (int x : view) {} });
  }
}`,
      'get java.util.ConcurrentModificationException\nsize java.util.ConcurrentModificationException\nprint java.util.ConcurrentModificationException\nset java.util.ConcurrentModificationException\n[7, 2]\nafterSet ok\n[7, 2, 3, 8, 4, 5]\nparentOfNested ok\nsort java.util.ConcurrentModificationException\nforEach java.util.ConcurrentModificationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's deques iterate in reverse, and LinkedHashMap orders by access and evicts through removeEldestEntry", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
public class Main {
  public static void main(String[] args) {
    Deque<Integer> dq = new ArrayDeque<>(List.of(1, 2, 3, 4));
    Iterator<Integer> it = dq.descendingIterator();
    while (it.hasNext()) { int x = it.next(); System.out.print(x); if (x % 2 == 0) it.remove(); }
    System.out.println(" " + dq);
    LinkedList<String> ll = new LinkedList<>(List.of("a", "b", "c"));
    for (Iterator<String> i = ll.descendingIterator(); i.hasNext();) System.out.print(i.next());
    System.out.println();
    Iterator<String> j = ll.descendingIterator(); j.next(); ll.add("d");
    try { j.next(); } catch (ConcurrentModificationException e) { System.out.println("CME"); }
    Iterator<Integer> k = dq.descendingIterator();
    try { k.remove(); } catch (IllegalStateException e) { System.out.println("ISE"); }
    Iterator<Integer> e = new ArrayDeque<Integer>().descendingIterator();
    try { e.next(); } catch (NoSuchElementException ex) { System.out.println("NSE"); }
  }
}`,
      '4321 [1, 3]\ncba\nCME\nISE\nNSE\n',
    ],
    [
      `import java.util.*;
public class Main {
  static class Lru<K, V> extends LinkedHashMap<K, V> {
    final int capacity;
    Lru(int capacity) { super(16, 0.75f, true); this.capacity = capacity; }
    @Override protected boolean removeEldestEntry(Map.Entry<K, V> eldest) { return size() > capacity; }
  }
  public static void main(String[] args) {
    Lru<String, Integer> cache = new Lru<>(2);
    cache.put("a", 1); cache.put("b", 2); cache.get("a"); cache.put("c", 3);
    System.out.println(cache);
    Map<Integer, String> access = new LinkedHashMap<>(4, 0.75f, true);
    access.put(1, "x"); access.put(2, "y"); access.put(3, "z");
    access.get(1); access.put(2, "Y"); access.getOrDefault(3, "d");
    System.out.println(access);
    Iterator<Integer> it = access.keySet().iterator(); access.get(3); access.put(3, "Z"); System.out.println(it.next());
    Map<Integer, Integer> bounded = new LinkedHashMap<>() { protected boolean removeEldestEntry(Map.Entry<Integer, Integer> e) { return size() > 3; } };
    for (int i = 0; i < 6; i++) bounded.put(i, i * i);
    System.out.println(bounded);
    Map<String, Integer> plain = new LinkedHashMap<>(); plain.put("x", 1); plain.put("y", 2); plain.get("x"); plain.put("x", 3);
    System.out.println(plain);
  }
}`,
      '{a=1, c=3}\n{1=x, 2=Y, 3=z}\n1\n{3=9, 4=16, 5=25}\n{x=3, y=2}\n',
    ],
    [
      `import java.util.*;
public class Main {
  static class Sorted extends TreeMap<String, Integer> {}
  static class Ordered extends LinkedHashSet<String> {}
  public static void main(String[] args) {
    Sorted s = new Sorted(); s.put("b", 1); s.put("a", 2); s.put("c", 3); System.out.println(s + " " + s.firstKey());
    Ordered o = new Ordered(); o.add("z"); o.add("a"); o.add("m"); System.out.println(o);
    Map<String, Integer> m = new HashMap<>() {{ put("k1", 1); put("k2", 2); }}; System.out.println(m);
    LinkedHashMap<String, Integer> lru = new LinkedHashMap<>(4, 0.75f, true);
    lru.put("a", 1); lru.put("b", 2); lru.put("c", 3);
    try { for (String k : lru.keySet()) lru.get(k); } catch (ConcurrentModificationException e) { System.out.println("CME"); }
    lru.replace("a", 10); lru.merge("b", 5, Integer::sum); lru.compute("c", (k, v) -> v + 100); lru.putIfAbsent("a", 0);
    System.out.println(lru);
    try { new LinkedHashMap<String, String>(-1, 0.75f, true); } catch (IllegalArgumentException e) { System.out.println(e.getMessage()); }
    try { new LinkedHashMap<String, String>(1, 0f); } catch (IllegalArgumentException e) { System.out.println(e.getMessage()); }
  }
}`,
      '{a=2, b=1, c=3} a\n[z, a, m]\n{k1=1, k2=2}\nCME\n{b=7, c=103, a=10}\nIllegal initial capacity: -1\nIllegal load factor: 0.0\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's Collections give empty and one-element sets and maps, which may hold null and reject changes", () => {
  const program = `import java.util.*;
public class Main {
  public static void main(String[] args) {
    System.out.println(Collections.singleton(5) + " " + Collections.singletonMap("k", 1) + " " + Collections.emptyMap() + " " + Collections.emptySet());
    try { Collections.singleton(1).add(2); } catch (UnsupportedOperationException e) { System.out.println("UOE"); }
    try { Collections.<String, Integer>emptyMap().put("a", 1); } catch (UnsupportedOperationException e) { System.out.println("UOE2"); }
    Set<String> withNull = Collections.singleton(null);
    Map<String, Integer> nullValue = Collections.singletonMap(null, null);
    System.out.println(withNull + " " + withNull.contains(null) + " " + nullValue + " " + nullValue.containsKey(null) + " " + Collections.emptySet().contains(1) + " " + Collections.emptyMap().get("x") + " " + Collections.emptySet().size());
    Map<String, List<Integer>> m = new HashMap<>(Collections.singletonMap("a", List.of(1)));
    System.out.println(m + " " + Collections.emptyMap().equals(Map.of()) + " " + Collections.singleton(3).equals(Set.of(3)));
  }
}`;
  expect(executeProgram('java', program)).toMatchObject({
    kind: 'executed',
    stdout: '[5] {k=1} {} []\nUOE\nUOE2\n[null] true {null=null} true false null 0\n{a=[1]} true true\n',
  });
});

test('Java appends a CharSequence by its characters, bounds generic constructors by class parameters, and rejects null compositions as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.io.*;
class Main {
  static class C implements CharSequence {
    public int length() { return 3; }
    public char charAt(int i) { return (char) ('a' + i); }
    public CharSequence subSequence(int a, int b) { return "abc".subSequence(a, b); }
    public String toString() { return "wrong"; }
  }
  public static void main(String[] args) throws IOException {
    CharSequence c = new C();
    StringBuilder sb = new StringBuilder().append(c).append(c, 1, 3).append((CharSequence) null).append((CharSequence) null, 1, 3).append(new StringBuilder("x"), 0, 1);
    System.out.println(sb);
    try { sb.append(c, 2, 5); } catch (IndexOutOfBoundsException e) { System.out.println(e); }
    StringWriter w = new StringWriter(); w.append(c); w.append(c, 0, 2); System.out.println(w);
    StringBuffer buf = new StringBuffer(); buf.append(c); System.out.println(buf);
  }
}`,
      'abcbcnullulx\njava.lang.IndexOutOfBoundsException: Range [2, 5) out of bounds for length 3\nwrongab\nabc\n',
    ],
    [
      `import java.util.*;
class Box<T> {
  final T value;
  <U extends T> Box(U value) { this.value = value; }
  <U extends Comparable<T>> Box(U key, T value) { this.value = value; System.out.println("key " + key); }
}
class Main {
  public static void main(String[] args) {
    Box<Number> b = new Box<Number>(1);
    System.out.println(b.value);
    Box<String> c = new Box<>("k", "v");
    System.out.println(c.value);
  }
}`,
      '1\nkey k\nv\n',
    ],
    [
      `import java.util.function.*;
class Main {
  static void t(Runnable r) { try { r.run(); System.out.println("no exception"); } catch (NullPointerException e) { System.out.println("NPE"); } }
  public static void main(String[] args) {
    IntPredicate p = x -> false;
    LongPredicate l = x -> true;
    Predicate<String> s = x -> true;
    t(() -> p.and(null));
    t(() -> l.or(null));
    t(() -> s.and(null));
    t(() -> s.or(null));
    System.out.println(p.or(x -> x > 1).test(2) + " " + l.and(x -> x > 1).test(0) + " " + s.negate().test("a"));
  }
}`,
      'NPE\nNPE\nNPE\nNPE\ntrue false false\n',
    ],
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    try { Collections.unmodifiableList(null); } catch (NullPointerException e) { System.out.println("NPE"); }
    System.out.println(Collections.unmodifiableList(new LinkedList<>(List.of(1))).getClass().getName());
  }
}`,
      'NPE\njava.util.Collections$UnmodifiableList\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's summary statistics are consumers, and LinkedHashMap counts computeIfAbsent hits and copies without evicting, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
import java.util.function.*;
import java.util.stream.*;
class Main {
  static class Box { <T> Box(T t) { System.out.println("object"); } <T extends Number> Box(T t) { System.out.println("number"); } }
  static class Cache extends LinkedHashMap<Integer, Integer> {
    Cache(Map<Integer, Integer> m) { super(m); }
    protected boolean removeEldestEntry(Map.Entry<Integer, Integer> e) { return size() > 1; }
  }
  public static void main(String[] args) {
    IntSummaryStatistics s = new IntSummaryStatistics();
    IntStream.of(1, 2).forEach(s);
    LongSummaryStatistics l = new LongSummaryStatistics();
    IntStream.of(3, 4).forEach(l);
    LongStream.of(5).forEach(l);
    DoubleSummaryStatistics d = new DoubleSummaryStatistics(); DoubleStream.of(1.5).forEach(d);
    System.out.println(s.getSum() + " " + l.getSum() + " " + d.getSum());
    Map<Integer, Integer> m = new LinkedHashMap<>(16, .75f, true);
    m.put(1, 1); m.put(2, 2); m.computeIfAbsent(1, k -> 9); System.out.println(m);
    Function<Integer, Box> f = Box::<Object>new; f.apply(1);
    Cache c = new Cache(new TreeMap<>(Map.of(1, 2, 3, 4)));
    System.out.println(c);
    c.put(5, 6);
    System.out.println(c);
  }
}`,
      '3 12 1.5\n{2=2, 1=1}\nobject\n{1=2, 3=4}\n{3=4, 5=6}\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's sublists have the JDK's classes, index checks, and positional removal, fail on every read once their list changed, and the hidden JDK collections are Serializable", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("of3", () -> List.of(1, 2, 3).subList(0, 2).get(5));
    t("linked", () -> new LinkedList<>(List.of(1, 2, 3, 4)).subList(0, 2).get(5));
    t("of2", () -> List.of(1, 2).subList(0, 1).get(5));
    t("asList", () -> Arrays.asList(1, 2, 3).subList(0, 2).get(5));
    t("stack", () -> { Stack<Integer> s = new Stack<>(); s.push(1); s.push(2); s.subList(0, 1).get(5); });
    t("array", () -> new ArrayList<>(List.of(1, 2, 3)).subList(0, 2).get(5));
    t("liOf", () -> List.of(1, 2, 3).subList(0, 2).listIterator(5));
    t("liArray", () -> new ArrayList<>(List.of(1, 2, 3)).subList(0, 2).listIterator(5));
    t("asListSet", () -> Arrays.asList(1, 2, 3).subList(0, 2).set(0, 9));
    t("asListAdd", () -> Arrays.asList(1, 2, 3).subList(0, 2).add(9));
    t("ofSet", () -> List.of(1, 2, 3).subList(0, 2).set(0, 9));
    List<Integer> a = new ArrayList<>(List.of(1, 1, 2)); int[] n = {0};
    a.subList(0, 3).removeIf(x -> n[0]++ == 0); System.out.println(a);
    List<Integer> l = new LinkedList<>(List.of(1, 1, 2)); int[] m = {0};
    l.subList(0, 3).removeIf(x -> m[0]++ == 0); System.out.println(l);
    List<Integer> b = new ArrayList<>(List.of(1, 2, 3)); List<Integer> v = b.subList(1, 3); b.add(4);
    t("copy", () -> new ArrayList<>(v));
    t("addAll", () -> new ArrayList<Integer>().addAll(v));
    t("stream", () -> v.stream().count());
    t("equals", () -> List.of(2, 3).equals(v));
    t("join", () -> String.join(",", new ArrayList<String>(List.of("x")).subList(0, 1)));
    List<String> strs = new ArrayList<>(List.of("p", "q")); List<String> sv = strs.subList(0, 1); strs.add("r");
    t("join2", () -> String.join(",", sv));
    List<Integer> c = new ArrayList<>(List.of(5, 6, 7)); List<Integer> cv = c.subList(0, 2); cv.add(8);
    System.out.println(c + " " + cv + " " + cv.getClass().getSimpleName() + " " + c.subList(0, 2).subList(0, 1).getClass().getName());
  }
}`,
      'of3 java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 2\nlinked java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 2\nof2 java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 1\nasList java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 2\nstack java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 1\narray java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 2\nliOf java.lang.IndexOutOfBoundsException: Index: 5 Size: 2\nliArray java.lang.IndexOutOfBoundsException: Index: 5, Size: 2\nasListSet ok\nasListAdd java.lang.UnsupportedOperationException\nofSet java.lang.UnsupportedOperationException\n[1, 2]\n[1, 2]\ncopy java.util.ConcurrentModificationException\naddAll java.util.ConcurrentModificationException\nstream java.util.ConcurrentModificationException\nequals java.util.ConcurrentModificationException\njoin ok\njoin2 java.util.ConcurrentModificationException\n[5, 6, 8, 7] [5, 6, 8] SubList java.util.ArrayList$SubList\n',
    ],
    [
      `import java.io.*;
import java.util.*;
class Main {
  static String s(Object o) { return o instanceof Serializable ? "S" : "-"; }
  public static void main(String[] args) {
    System.out.println(s(List.of()) + s(List.of(1)) + s(List.of(1, 2, 3)) + s(Arrays.asList(1)) + s(Collections.emptyList()) + s(Collections.singletonList(1)) + s(Collections.nCopies(2, 1)) + s(Collections.unmodifiableList(new ArrayList<>())) + s(Collections.unmodifiableList(new LinkedList<>())));
    System.out.println(s(Set.of(1)) + s(Map.of(1, 2)) + s(Collections.emptySet()) + s(Collections.singleton(1)) + s(Collections.emptyMap()) + s(Collections.singletonMap(1, 2)) + s(Collections.unmodifiableSet(new HashSet<>())) + s(Collections.unmodifiableMap(new HashMap<>())) + s(new HashMap<>(Map.of(1, 2)).keySet()));
    List<Integer> a = new ArrayList<>(List.of(1, 2, 3));
    System.out.println(s(a.subList(0, 1)) + s(List.of(1, 2).subList(0, 1)) + s(Arrays.asList(1, 2).subList(0, 1)) + s(new LinkedList<>(a).subList(0, 1)));
    System.out.println(a.subList(0, 1).getClass().getName() + " " + List.of(1, 2).subList(0, 1).getClass().getName() + " " + Arrays.asList(1, 2).subList(0, 1).getClass().getName() + " " + new LinkedList<>(a).subList(0, 1).getClass().getName());
  }
}`,
      'SSSSSSSSS\nSSSSSSSS-\n----\njava.util.ArrayList$SubList java.util.ImmutableCollections$SubList java.util.AbstractList$RandomAccessSubList java.util.AbstractList$SubList\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java checks receiver parameters, accepts TYPE_USE annotations on classes and constructors, and counts sorts and evictions as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.lang.annotation.*;
@Target(ElementType.TYPE_USE) @interface Mark {}
@Mark class A { @Mark A() {} }
class Main<T> {
  int v = 3;
  int get(Main<T> this) { return v; }
  class Inner { int w = 4; Inner(Main<T> Main.this) {} int sum(Main<T>.Inner this) { return w + v; } }
  public static void main(String[] args) {
    Main<String> m = new Main<>();
    System.out.println(m.get() + " " + m.new Inner().sum());
    new A();
  }
}`,
      '3 7\n',
    ],
    [
      `import java.util.*;
class Main {
  static class MyL extends LinkedList<Integer> {}
  static class MyS extends Stack<Integer> {}
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    Map<Integer, Integer> m = new LinkedHashMap<>();
    for (int i = 0; i < 80000; i++) m.put(i, i);
    System.out.println(m.size());
    MyL l = new MyL(); l.add(1);
    t("myl", () -> l.get(5));
    t("anon", () -> new LinkedList<Integer>() {}.get(0));
    MyS s = new MyS(); s.push(1);
    t("mys", () -> s.get(5));
    List<Integer> a = new ArrayList<>(List.of(3, 2, 1)); Iterator<Integer> it = a.iterator();
    Collections.sort(a.subList(1, 3)); a.subList(0, 2).sort(null);
    System.out.println(it.next() + " " + a);
    Iterator<Integer> it2 = a.iterator(); a.sort(null);
    t("arraySort", () -> it2.next());
    List<Integer> ll = new LinkedList<>(List.of(2, 1)); Iterator<Integer> it3 = ll.iterator(); Collections.sort(ll);
    t("linkedSort", () -> System.out.println(it3.next()));
    List<Integer> fs = Arrays.asList(2, 1); Iterator<Integer> it4 = fs.iterator(); fs.sort(null);
    t("asListSort", () -> System.out.println(it4.next()));
    Stack<Integer> st = new Stack<>(); st.push(2); st.push(1); Iterator<Integer> it5 = st.iterator(); st.sort(null);
    t("stackSort", () -> it5.next());
  }
}`,
      '80000\nmyl java.lang.IndexOutOfBoundsException: Index: 5, Size: 1\nanon java.lang.IndexOutOfBoundsException: Index: 0, Size: 0\nmys java.lang.ArrayIndexOutOfBoundsException: Array index out of range: 5\n1 [1, 3, 2]\narraySort java.util.ConcurrentModificationException\n1\nlinkedSort ok\n1\nasListSort ok\nstackSort java.util.ConcurrentModificationException\n',
    ],
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    List<Integer> a = new ArrayList<>(List.of(3, 2, 1)); Iterator<Integer> it = a.iterator();
    Collections.sort(a.subList(1, 3));
    System.out.println(it.next());
    Iterator<Integer> it2 = a.iterator();
    a.subList(0, 2).sort(null);
    System.out.println(it2.next());
  }
}`,
      '3\n1\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's sublists remove through their iterators, keep unmodifiable wrappers, and annotations nest as element values, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.io.*;
import java.util.*;
@interface Tag { String value(); }
@interface Tags { Tag[] value(); }
@interface One { Tag value(); }
@interface Named { Tag tag(); }
@Tags({@Tag("a"), @Tag("b")}) @One(@Tag("x")) @Named(tag = @Tag("y"))
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    List<Integer> a = new ArrayList<>(List.of(1, 2, 3));
    Iterator<Integer> it = a.subList(0, 2).iterator(); it.next(); it.remove(); System.out.println(a);
    List<Integer> l = new LinkedList<>(List.of(1, 2, 3));
    Iterator<Integer> li = l.subList(0, 2).iterator(); li.next(); li.remove(); System.out.println(l);
    List<Integer> u = Collections.unmodifiableList(new ArrayList<>(List.of(1, 2)));
    List<Integer> ub = u.subList(0, 1);
    System.out.println(ub.getClass().getName() + " " + (ub instanceof Serializable) + " " + ub);
    List<Integer> ul = Collections.unmodifiableList(new LinkedList<>(List.of(1, 2)));
    System.out.println(ul.subList(0, 1).getClass().getName() + " " + (ul.subList(0, 1) instanceof Serializable));
    t("ubAdd", () -> ub.add(3));
    Iterator<Integer> fi = Arrays.asList(1, 2).subList(0, 1).iterator();
    t("fi1", () -> fi.remove()); fi.next(); t("fi2", () -> fi.remove());
    t("fsRemoveIf", () -> Arrays.asList(1, 2).subList(0, 1).removeIf(x -> true));
    List<Integer> r = new ArrayList<>(List.of(1, 2, 3));
    List<Integer> nested = r.subList(0, 3).subList(1, 2);
    r.add(4);
    System.out.println("nested ok " + r);
  }
}`,
      '[2, 3]\n[2, 3]\njava.util.Collections$UnmodifiableRandomAccessList true [1]\njava.util.Collections$UnmodifiableList true\nubAdd java.lang.UnsupportedOperationException\nfi1 java.lang.IllegalStateException\nfi2 java.lang.UnsupportedOperationException\nfsRemoveIf java.lang.UnsupportedOperationException\nnested ok [1, 2, 3, 4]\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java checks receiver type arguments, skips annotations on varargs and wildcards, and checks sublists through unmodifiable wrappers, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.lang.annotation.*;
import java.util.*;
@Target(ElementType.TYPE_USE) @interface Mark {}
class Main<T> {
  int v = 1;
  int get(Main<T> this) { return v; }
  class Inner { int sum(Main<T>.Inner this) { return v + 1; } }
  static int len(String @Mark ... xs) { return xs.length; }
  public static void main(String[] args) {
    List<@Mark ? extends String> values = List.of("ok");
    List<@Mark ?> any = values;
    String first = values.get(0); System.out.println(first + any.size() + len("a", "b") + new Main<String>().get() + new Main<String>().new Inner().sum());
    List<Integer> root = new ArrayList<>(List.of(1, 2, 3));
    List<Integer> wrap = Collections.unmodifiableList(root.subList(0, 2));
    root.add(4);
    try { System.out.println(wrap.size()); } catch (ConcurrentModificationException e) { System.out.println("CME size"); }
    try { System.out.println(wrap.get(0)); } catch (ConcurrentModificationException e) { System.out.println("CME get"); }
    try { for (int x : wrap) System.out.println(x); } catch (ConcurrentModificationException e) { System.out.println("CME iter"); }
  }
}`,
      'ok1212\nCME size\nCME get\nCME iter\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's access-ordered maps record reads through unmodifiable wrappers and map equality, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    Map<Integer, Integer> cache = new LinkedHashMap<>(16, 0.75f, true);
    cache.put(1, 1); cache.put(2, 2); cache.put(3, 3);
    Map<Integer, Integer> view = Collections.unmodifiableMap(cache);
    view.get(1); System.out.println(cache);
    view.getOrDefault(2, 0); System.out.println(cache);
    Map<Integer, Integer> expected = new LinkedHashMap<>();
    expected.put(1, 1); expected.put(2, 2); expected.put(3, 3);
    System.out.println(expected.equals(cache) + " " + cache);
    Map<Integer, Integer> other = new LinkedHashMap<>(); other.put(3, 3); other.put(9, 9);
    System.out.println(other.equals(cache) + " " + cache);
    Iterator<Integer> it = cache.keySet().iterator(); view.get(1);
    try { it.next(); System.out.println("no CME"); } catch (ConcurrentModificationException e) { System.out.println("CME"); }
  }
}`,
      '{2=2, 3=3, 1=1}\n{3=3, 1=1, 2=2}\ntrue {1=1, 2=2, 3=3}\nfalse {1=1, 2=2, 3=3}\nCME\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java accepts TYPE_USE annotations on enum constants and checks a sublist when it creates an iterator, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.lang.annotation.*;
import java.util.*;
@Target(ElementType.TYPE_USE) @interface Mark {}
enum E { @Mark A, @Mark B { public String toString() { return "b"; } } }
class Main {
  public static void main(String[] args) {
    System.out.println(E.A + " " + E.B);
    List<Integer> root = new ArrayList<>(List.of(1, 2, 3));
    List<Integer> view = root.subList(0, 2);
    List<Integer> w = Collections.unmodifiableList(view);
    List<Integer> nested = root.subList(0, 3).subList(0, 1);
    root.add(4);
    try { w.iterator(); System.out.println("iterator ok"); } catch (Exception e) { System.out.println(e); }
    try { view.iterator(); System.out.println("iterator ok"); } catch (Exception e) { System.out.println(e); }
    try { nested.iterator(); System.out.println("iterator ok"); } catch (Exception e) { System.out.println(e); }
  }
}`,
      'A b\njava.util.ConcurrentModificationException\njava.util.ConcurrentModificationException\njava.util.ConcurrentModificationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java iterators of sublists and their wrappers answer hasNext without their lists' checks, as the JDK's do", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    List<Integer> root = new ArrayList<>(List.of(1, 2, 3));
    List<Integer> view = root.subList(0, 2);
    List<Integer> w = Collections.unmodifiableList(view);
    Iterator<Integer> a = w.iterator(); Iterator<Integer> b = view.iterator();
    ListIterator<Integer> c = w.listIterator(); ListIterator<Integer> d = view.listIterator();
    root.add(4);
    for (Iterator<Integer> it : List.of(a, b, c, d)) {
      try { System.out.println(it.hasNext()); it.next(); } catch (Exception e) { System.out.println(e); }
    }
  }
}`,
      'true\njava.util.ConcurrentModificationException\ntrue\njava.util.ConcurrentModificationException\ntrue\njava.util.ConcurrentModificationException\ntrue\njava.util.ConcurrentModificationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's empty and singleton collections of Collections reject only removals that would change them, as the JDK's do", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("esClear", () -> Collections.emptySet().clear());
    t("esRemoveIf", () -> System.out.println(Collections.<Integer>emptySet().removeIf(x -> true)));
    t("esRemove", () -> System.out.println(Collections.emptySet().remove(1)));
    t("esAdd", () -> Collections.<Integer>emptySet().add(1));
    t("emClear", () -> Collections.emptyMap().clear());
    t("emRemove", () -> System.out.println(Collections.emptyMap().remove(1)));
    t("emPut", () -> Collections.<Integer, Integer>emptyMap().put(1, 1));
    t("elClear", () -> Collections.emptyList().clear());
    t("elRemoveIf", () -> System.out.println(Collections.<Integer>emptyList().removeIf(x -> true)));
    t("elRemove", () -> System.out.println(Collections.emptyList().remove((Object) 1)));
    t("sRemove", () -> System.out.println(Collections.singleton(1).remove(2)));
    t("sRemove1", () -> System.out.println(Collections.singleton(1).remove(1)));
    t("sClear", () -> Collections.singleton(1).clear());
    t("sRemoveIf", () -> System.out.println(Collections.singleton(1).removeIf(x -> false)));
    t("slRemove", () -> System.out.println(Collections.singletonList(1).remove((Object) 2)));
    t("slRemoveIf", () -> System.out.println(Collections.singletonList(1).removeIf(x -> false)));
    t("smRemove", () -> System.out.println(Collections.singletonMap(1, 1).remove(2)));
    t("smClear", () -> Collections.singletonMap(1, 1).clear());
    System.out.println(Collections.emptySet().getClass().getName() + " " + Collections.singleton(1).getClass().getName() + " " + Collections.emptyMap().getClass().getName() + " " + Collections.singletonMap(1, 1).getClass().getName());
  }
}`,
      'esClear ok\nfalse\nesRemoveIf ok\nfalse\nesRemove ok\nesAdd java.lang.UnsupportedOperationException\nemClear ok\nnull\nemRemove ok\nemPut java.lang.UnsupportedOperationException\nelClear ok\nfalse\nelRemoveIf ok\nfalse\nelRemove ok\nfalse\nsRemove ok\nsRemove1 java.lang.UnsupportedOperationException\nsClear java.lang.UnsupportedOperationException\nsRemoveIf java.lang.UnsupportedOperationException\nfalse\nslRemove ok\nslRemoveIf java.lang.UnsupportedOperationException\nnull\nsmRemove ok\nsmClear java.lang.UnsupportedOperationException\njava.util.Collections$EmptySet java.util.Collections$SingletonSet java.util.Collections$EmptyMap java.util.Collections$SingletonMap\n',
    ],
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("ncRemove", () -> System.out.println(Collections.nCopies(2, 1).remove((Object) 3)));
    t("ncRemoveIf", () -> System.out.println(Collections.nCopies(2, 1).removeIf(x -> x == 3)));
    t("ncRemoveIf1", () -> System.out.println(Collections.nCopies(2, 1).removeIf(x -> x == 1)));
    t("ncClear0", () -> Collections.nCopies(0, 1).clear());
    t("ncClear", () -> Collections.nCopies(2, 1).clear());
    t("elRemoveAt", () -> Collections.emptyList().remove(0));
    t("smRemove2", () -> System.out.println(Collections.singletonMap(1, 1).remove(1, 2)));
    t("smRemove3", () -> System.out.println(Collections.singletonMap(1, 1).remove(1, 1)));
    System.out.println(Collections.emptySet().equals(Set.of()) + " " + Collections.singleton(1).equals(Set.of(1)) + " " + Collections.singletonMap(1, 2) + " " + Collections.emptyMap().equals(Map.of()) + " " + Collections.singleton(3) + " " + Collections.singletonMap(1, 2).hashCode());
    Iterator<Integer> it = Collections.singleton(1).iterator(); it.next();
    t("sItRemove", () -> it.remove());
  }
}`,
      'false\nncRemove ok\nfalse\nncRemoveIf ok\nncRemoveIf1 java.lang.UnsupportedOperationException\nncClear0 ok\nncClear java.lang.UnsupportedOperationException\nelRemoveAt java.lang.UnsupportedOperationException\nsmRemove2 java.lang.UnsupportedOperationException\nsmRemove3 java.lang.UnsupportedOperationException\ntrue true {1=2} true [3] 3\nsItRemove java.lang.UnsupportedOperationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java returns an unmodifiable list unwrapped again and compares an invalidated sublist with itself, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    List<Integer> once = Collections.unmodifiableList(Arrays.asList(1, 2));
    List<Integer> twice = Collections.unmodifiableList(once);
    System.out.println(once == twice);
    t("get", () -> twice.get(3));
    List<Integer> of = Collections.unmodifiableList(Collections.unmodifiableList(List.of(1, 2)));
    t("li", () -> of.listIterator(3));
    t("ofGet", () -> of.get(3));
    List<Integer> ll = Collections.unmodifiableList(Collections.unmodifiableList(new LinkedList<>(List.of(1))));
    t("ll", () -> ll.get(3));
    List<Integer> root = new ArrayList<>(List.of(1, 2));
    List<Integer> v = root.subList(0, 1);
    List<Integer> w = Collections.unmodifiableList(v);
    root.add(3);
    t("vv", () -> System.out.println(v.equals(v)));
    t("ww", () -> System.out.println(w.equals(w)));
    t("vw", () -> System.out.println(v.equals(w)));
  }
}`,
      'true\nget java.lang.ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 2\nli java.lang.IndexOutOfBoundsException: Index: 3 Size: 2\nofGet java.lang.IndexOutOfBoundsException: Index: 3 Size: 2\nll java.lang.IndexOutOfBoundsException: Index: 3, Size: 1\ntrue\nvv ok\ntrue\nww ok\nvw java.util.ConcurrentModificationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's no-op removals from Collections' sets and maps keep their iterators valid, and removeIf rejects a null predicate, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    Set<Integer> s = Collections.emptySet(); Iterator<Integer> i = s.iterator(); s.clear(); s.remove(1);
    t("set", () -> i.next());
    Map<Integer, Integer> m = Collections.emptyMap(); Iterator<Integer> k = m.keySet().iterator(); m.clear(); m.remove(1);
    t("map", () -> k.next());
    Set<Integer> one = Collections.singleton(1); Iterator<Integer> j = one.iterator(); one.remove(2);
    t("one", () -> System.out.println(j.next()));
    t("nullEmpty", () -> Collections.<Integer>emptyList().removeIf(null));
    t("nullSet", () -> Collections.<Integer>emptySet().removeIf(null));
    t("nullCopies", () -> Collections.nCopies(0, 1).removeIf(null));
    t("nullArray", () -> new ArrayList<Integer>().removeIf(null));
  }
}`,
      'set java.util.NoSuchElementException\nmap java.util.NoSuchElementException\n1\none ok\nnullEmpty java.lang.NullPointerException\nnullSet java.lang.NullPointerException\nnullCopies java.lang.NullPointerException\nnullArray java.lang.NullPointerException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java wraps a sublist whose list changed without reading it and returns an unmodifiable list as it is, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    List<Integer> r = new ArrayList<>(List.of(1, 2));
    List<Integer> v = r.subList(0, 1);
    List<Integer> w = Collections.unmodifiableList(v);
    r.add(3);
    t("rewrap", () -> System.out.println(w == Collections.unmodifiableList(w)));
    t("wrapView", () -> Collections.unmodifiableList(v));
    t("readView", () -> Collections.unmodifiableList(v).size());
  }
}`,
      'true\nrewrap ok\nwrapView ok\nreadView java.util.ConcurrentModificationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java accepts qualified receiver names, rejects removeIf on immutable collections first, and fails map equality that reorders its own entries, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  int v = 2;
  int f(Main Main.this) { return v; }
  class Inner { Inner(Main Main.this) {} int g(Main.Inner Inner.this) { return v; } }
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    Main m = new Main();
    System.out.println(m.f() + m.new Inner().g());
    t("of", () -> List.of(1).removeIf(null));
    t("single", () -> Collections.singleton(1).removeIf(null));
    t("wrap", () -> Collections.unmodifiableList(new ArrayList<Integer>()).removeIf(null));
    t("empty", () -> Collections.<Integer>emptyList().removeIf(null));
    Map<Integer, Integer> a = new LinkedHashMap<>(16, .75f, true); a.put(1, 1); a.put(2, 2);
    t("eq2", () -> System.out.println(a.equals(Collections.unmodifiableMap(a))));
    a.put(3, 3);
    t("eq3", () -> System.out.println(a.equals(Collections.unmodifiableMap(a))));
    System.out.println(a);
    Map<Integer, Integer> b = new LinkedHashMap<>(16, .75f, true); b.put(1, 1);
    System.out.println(b.equals(Collections.unmodifiableMap(b)) + " " + b.equals(b));
  }
}`,
      '4\nof java.lang.UnsupportedOperationException\nsingle java.lang.UnsupportedOperationException\nwrap java.lang.UnsupportedOperationException\nempty java.lang.NullPointerException\neq2 java.util.ConcurrentModificationException\neq3 java.util.ConcurrentModificationException\n{1=1, 3=3, 2=2}\ntrue true\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java checks an annotation-valued element default as an element value, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.lang.annotation.*;
@Target({}) @interface Tag { String value(); }
@Target(ElementType.FIELD) @interface Field { String value(); }
@interface One { Tag value() default @Tag("x"); Field field() default @Field("y"); Tag[] all() default {@Tag("a")}; }
@One class Main { public static void main(String[] args) { System.out.println("ok"); } }`,
      'ok\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's empty and singleton collections of Collections reject removeAll and retainAll only when they would remove, as the JDK's do", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("esRemoveAll", () -> System.out.println(Collections.emptySet().removeAll(List.of(1))));
    t("elRetainAll", () -> System.out.println(Collections.emptyList().retainAll(List.of(1))));
    t("slRemoveAll", () -> System.out.println(Collections.singletonList(1).removeAll(List.of(2))));
    t("slRemoveAll1", () -> System.out.println(Collections.singletonList(1).removeAll(List.of(1))));
    t("sRetainAll", () -> System.out.println(Collections.singleton(1).retainAll(List.of(1))));
    t("sRetainAll0", () -> System.out.println(Collections.singleton(1).retainAll(List.of())));
    t("ncRemoveAll", () -> System.out.println(Collections.nCopies(2, 1).removeAll(List.of(3))));
    t("ofRemoveAll", () -> System.out.println(List.of(1).removeAll(List.of(3))));
    t("wrapRemoveAll", () -> System.out.println(Collections.unmodifiableList(new ArrayList<Integer>()).removeAll(List.of(3))));
    t("arrayNull", () -> new ArrayList<Integer>().removeAll(null));
    t("ofNull", () -> List.of(1).removeAll(null));
  }
}`,
      'false\nesRemoveAll ok\nfalse\nelRetainAll ok\nfalse\nslRemoveAll ok\nslRemoveAll1 java.lang.UnsupportedOperationException\nfalse\nsRetainAll ok\nsRetainAll0 java.lang.UnsupportedOperationException\nfalse\nncRemoveAll ok\nofRemoveAll java.lang.UnsupportedOperationException\nwrapRemoveAll java.lang.UnsupportedOperationException\narrayNull java.lang.NullPointerException\nofNull java.lang.UnsupportedOperationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java wraps a LinkedList's sublist in the sequential unmodifiable list class, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    List<Integer> x = new LinkedList<>(List.of(1, 2, 3));
    List<Integer> v = x.subList(0, 2);
    System.out.println(Collections.unmodifiableList(v).getClass().getName() + " " + Collections.unmodifiableList(v.subList(0, 1)).getClass().getName());
    x.add(4);
    System.out.println(Collections.unmodifiableList(v).getClass().getName());
    List<Integer> y = new ArrayList<>(List.of(1, 2));
    System.out.println(Collections.unmodifiableList(y.subList(0, 1)).getClass().getName() + " " + Collections.unmodifiableList(Arrays.asList(1, 2).subList(0, 1)).getClass().getName());
  }
}`,
      'java.util.Collections$UnmodifiableList java.util.Collections$UnmodifiableList\njava.util.Collections$UnmodifiableList\njava.util.Collections$UnmodifiableRandomAccessList java.util.Collections$UnmodifiableRandomAccessList\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java ignores comments inside receiver parameters, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `class Outer { class Inner { Inner(Outer /* owner */ Outer.this) {} Inner(Outer Outer /* owner */ .this, int x) {} } }
class Main {
  int f(Main /* owner */ Main.this) { return 1; }
  int g(Main /* plain */ this) { return 2; }
  public static void main(String[] args) {
    new Outer().new Inner(); new Outer().new Inner(1);
    System.out.println(new Main().f() + new Main().g());
  }
}`,
      '3\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's Collections empty and singleton collections accept an empty addAll, as the JDK's do", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("es", () -> System.out.println(Collections.emptySet().addAll(List.of())));
    t("s", () -> System.out.println(Collections.singleton(1).addAll(List.of())));
    t("s1", () -> System.out.println(Collections.singleton(1).addAll(List.of(2))));
    t("el", () -> System.out.println(Collections.emptyList().addAll(List.of())));
    t("sl", () -> System.out.println(Collections.singletonList(1).addAll(List.of(2))));
    t("nc", () -> System.out.println(Collections.nCopies(1, 1).addAll(List.of())));
    t("of", () -> System.out.println(Set.of().addAll(List.of())));
    t("ofl", () -> System.out.println(List.of().addAll(List.of())));
  }
}`,
      'false\nes ok\nfalse\ns ok\ns1 java.lang.UnsupportedOperationException\nfalse\nel ok\nsl java.lang.UnsupportedOperationException\nfalse\nnc ok\nof java.lang.UnsupportedOperationException\nofl java.lang.UnsupportedOperationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java checks the position of an indexed addAll on Collections' lists first, as the JDK does", () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    t("el1", () -> System.out.println(Collections.emptyList().addAll(1, List.of())));
    t("el0", () -> System.out.println(Collections.emptyList().addAll(0, List.of())));
    t("sl", () -> System.out.println(Collections.singletonList(1).addAll(-1, List.of())));
    t("nc", () -> System.out.println(Collections.nCopies(2, 1).addAll(3, List.of(1))));
    t("nc2", () -> System.out.println(Collections.nCopies(2, 1).addAll(2, List.of(1))));
  }
}`,
      'el1 java.lang.IndexOutOfBoundsException: Index: 1, Size: 0\nfalse\nel0 ok\nsl java.lang.IndexOutOfBoundsException: Index: -1, Size: 1\nnc java.lang.IndexOutOfBoundsException: Index: 3, Size: 2\nnc2 java.lang.UnsupportedOperationException\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test("Java's Stack sublists are synchronized random-access lists, as the JDK's are", () => {
  for (const [program, stdout] of [
    [
      `import java.io.*;
import java.util.*;
class Main {
  static class MyStack extends Stack<Integer> {}
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    Stack<Integer> s = new Stack<>(); s.push(1); s.push(2); s.push(3);
    List<Integer> v = s.subList(0, 2);
    System.out.println(v.getClass().getName() + " " + Collections.unmodifiableList(v).getClass().getName() + " " + (v instanceof Serializable));
    System.out.println(v.subList(0, 1).getClass().getName() + " " + Collections.unmodifiableList(v.subList(0, 1)).getClass().getName());
    MyStack m = new MyStack(); m.push(1);
    System.out.println(Collections.unmodifiableList(m.subList(0, 1)).getClass().getName());
    t("get", () -> v.get(5));
    v.add(9); v.remove(0); System.out.println(s + " " + v);
    v.removeIf(x -> x == 9); System.out.println(s);
    Iterator<Integer> it = v.iterator(); it.next(); it.remove(); System.out.println(s + " " + v);
  }
}`,
      'java.util.Collections$SynchronizedRandomAccessList java.util.Collections$UnmodifiableRandomAccessList true\njava.util.Collections$SynchronizedRandomAccessList java.util.Collections$UnmodifiableRandomAccessList\njava.util.Collections$UnmodifiableRandomAccessList\nget java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 2\n[2, 9, 3] [2, 9]\n[2, 3]\n[3] []\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java compares an unmodifiable map as its backing map and walks a map in iteration order for equality, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  static void t(String label, Runnable r) { try { r.run(); System.out.println(label + " ok"); } catch (RuntimeException e) { System.out.println(label + " " + e); } }
  public static void main(String[] args) {
    Map<Integer, Integer> a = new LinkedHashMap<>(16, .75f, true); a.put(1, 1); a.put(2, 2);
    System.out.println(Collections.unmodifiableMap(a).equals(a) + " " + a);
    System.out.println(Collections.unmodifiableMap(Collections.unmodifiableMap(a)).equals(a) + " " + a);
    t("self", () -> System.out.println(a.equals(Collections.unmodifiableMap(a))));
    Map<Integer, Integer> h = new HashMap<>(); h.put(2, 2); h.put(1, 1);
    Map<Integer, Integer> b = new LinkedHashMap<>(16, .75f, true); b.put(2, 2); b.put(1, 1);
    System.out.println(h.equals(b) + " " + b);
    Map<String, Integer> hs = new HashMap<>(); hs.put("b", 2); hs.put("a", 1);
    Map<String, Integer> bs = new LinkedHashMap<>(16, .75f, true); bs.put("b", 2); bs.put("a", 1);
    System.out.println(hs.equals(bs) + " " + bs);
    Map<Integer, Integer> c = new LinkedHashMap<>(16, .75f, true); c.put(2, 2); c.put(1, 1);
    System.out.println(Collections.unmodifiableMap(h).equals(c) + " " + c);
  }
}`,
      'true {1=1, 2=2}\ntrue {1=1, 2=2}\nself java.util.ConcurrentModificationException\ntrue {1=1, 2=2}\ntrue {a=1, b=2}\ntrue {1=1, 2=2}\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
});

test('Java returns an unmodifiable set or map as it is when wrapped again, as the JDK does', () => {
  for (const [program, stdout] of [
    [
      `import java.util.*;
class Main {
  public static void main(String[] args) {
    Map<Integer, Integer> a = new LinkedHashMap<>(16, .75f, true); a.put(1, 1); a.put(2, 2);
    Map<Integer, Integer> w = Collections.unmodifiableMap(a);
    Map<Integer, Integer> v = Collections.unmodifiableMap(w);
    System.out.println((w == v) + " " + v.equals(w) + " " + w.equals(v) + " " + Collections.unmodifiableMap(v).equals(w) + " " + a);
    Set<Integer> s = Collections.unmodifiableSet(new HashSet<>(Set.of(1)));
    Set<Integer> k = Collections.unmodifiableSet(a.keySet());
    System.out.println((s == Collections.unmodifiableSet(s)) + " " + (k == Collections.unmodifiableSet(k)));
  }
}`,
      'true true true true {1=1, 2=2}\ntrue true\n',
    ],
  ]) {
    expect(executeProgram('java', program)).toMatchObject({ kind: 'executed', stdout });
  }
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
      String.raw`int a = Integer.parseInt("١٢٣") + Integer.parseInt("１２"); int b = Integer.parseInt("१२", 16); int c = Character.digit('๑', 10) + Character.getNumericValue('Ⅻ'); String astral = ""; try { Integer.parseInt("𝟏"); } catch (NumberFormatException e) { astral = "rejected"; } String f = String.format("%#x %#o %.3g %5.2g", 255, 8, 1234.567, 3.2); double h = Double.parseDouble("0x1.8p1") + 0x1p-1; String numerals = Character.getNumericValue('\u0BF1') + " " + Character.getNumericValue('\u324A') + " " + Character.getNumericValue('\uF96B') + " " + Character.getNumericValue('\u2044') + " " + Character.getNumericValue('\u00BD');`
    )
  ).toEqual({
    a: 135,
    b: 18,
    c: 13,
    astral: 'rejected',
    f: '0xff 010 1.23e+03   3.2',
    h: 3.5,
    numerals: '100 30 3 -1 -2',
  });
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
List<String> live = new ArrayList<>(List.of("a", "b")); live.removeIf(x -> { if (x.equals("a")) live.set(1, "c"); return x.equals("c"); }); String liveText = live.toString();
Map<Integer, Integer> viewed = new HashMap<>(Map.of(1, 1)); String viewCme = ""; try { viewed.keySet().removeIf(x -> { viewed.put(2, 2); return true; }); } catch (ConcurrentModificationException e) { viewCme = "cme" + viewed; }
Map<String, Integer> counts = new HashMap<>(); for (String w : "one two three four five six seven eight nine ten eleven twelve thirteen one".split(" ")) counts.merge(w, 1, Integer::sum); String counted = counts.toString();
List<Integer> linked = new LinkedList<>(List.of(1, 2, 3)); try { linked.removeIf(x -> { if (x == 3) throw new RuntimeException(); return x == 1; }); } catch (RuntimeException e) {} String linkedText = linked.toString();
StringBuilder collecting = new StringBuilder(); Stream.of(1, 2).peek(x -> collecting.append(x)).collect(Collectors.toCollection(() -> { collecting.append("S"); return new ArrayList<Integer>(); })); String collectOrder = collecting.toString();
PriorityQueue<Integer> heap = new PriorityQueue<>(); for (int x : new int[] {0, 10, 1, 11, 12, 2, 3, 13, 14, 15, 16, 4, 5, 6, 7}) heap.add(x); heap.removeIf(x -> x == 10); heap.removeAll(List.of(1)); String polled = ""; while (!heap.isEmpty()) polled += heap.poll() + ",";
Deque<Integer> deque = new ArrayDeque<>(List.of(1, 2, 3)); try { deque.removeIf(x -> { if (x == 3) throw new RuntimeException(); return x == 1; }); } catch (RuntimeException e) {} String dequeText = deque.toString();
enum Shade { R, G, B } Map<Shade, Integer> shades = new EnumMap<>(Shade.class); shades.computeIfAbsent(Shade.R, k -> { shades.put(Shade.G, 1); return 2; }); String enumMapText = shades.toString(); shades.replaceAll((k, v) -> { if (k == Shade.R) shades.remove(k); return v + 10; }); String replacedShades = shades.toString();
Map<Integer, Long> memo = new HashMap<>(); String memoCme = ""; try { memo.computeIfAbsent(3, k -> memo.computeIfAbsent(2, j -> 1L) + 1); } catch (ConcurrentModificationException e) { memoCme = "cme"; }
Map<String, Integer> keyed = new HashMap<>(Map.of("a", 1)); Set<String> readOnlyKeys = Collections.unmodifiableSet(keyed.keySet()); keyed.put("b", 2); String keysText = readOnlyKeys.toString(); Iterator<String> pending = readOnlyKeys.iterator(); keyed.clear(); boolean stillPending = pending.hasNext();
TreeSet<Integer> tree = new TreeSet<>(List.of(1)); Iterator<Integer> walked = tree.iterator(); walked.next(); tree.add(2); String treeEnd = ""; try { walked.next(); } catch (RuntimeException e) { treeEnd = e.getClass().getSimpleName(); }
PriorityQueue<Object> plain = new PriorityQueue<>(); String uncomparable = ""; try { plain.add(new Object()); } catch (ClassCastException e) { uncomparable = "cce " + plain.size(); }
String arrays = Arrays.toString(new TreeSet<>(List.of("b", "a")).toArray(new String[0])) + Arrays.toString(new ArrayDeque<>(List.of(3, 1)).toArray());
Map<String, List<String>> folded = Stream.of("a", "A").collect(Collectors.groupingBy(s -> s, () -> new TreeMap<>(String.CASE_INSENSITIVE_ORDER), Collectors.toList())); String foldedText = folded.toString();
String badRange = ""; try { "abc".matches("[a-"); } catch (java.util.regex.PatternSyntaxException e) { badRange = "pse"; }
boolean signedZeros = Arrays.equals(new double[] {-0.0}, new double[] {0.0}); String generalPrecision = String.format("%.3b|%#.0f", true, 2.0); List<? super Number> sup = new ArrayList<Object>(); List<? super Integer> lower = sup; lower.add(3); String lowerText = lower.toString();
String exhausted = ""; try { i.next(); } catch (NoSuchElementException e) { exhausted += "N"; } try { i.remove(); } catch (IllegalStateException e) { exhausted += "I"; } exhausted += q;
Set<Integer> s = new HashSet<>(Set.of(1)); Iterator<Integer> u = Collections.unmodifiableSet(s).iterator(); s.add(2); String wrapped = ""; try { u.next(); } catch (ConcurrentModificationException e) { wrapped = "cme"; }
List<String> nulls = new ArrayList<>(Arrays.asList("b", null, "a")); nulls.sort(Comparator.nullsFirst(Comparator.naturalOrder())); String sorted = nulls.toString();`
    )
  ).toEqual({
    bulk: '[1, 2, 3, 9, 9, 9]',
    seen: '0415623',
    exhausted: 'NI[0, 3, 1, 5, 4, 2]',
    liveText: '[a]',
    linkedText: '[2, 3]',
    collectOrder: 'S12',
    badRange: 'pse',
    signedZeros: false,
    generalPrecision: 'tru|2.',
    lowerText: '[3]',
    arrays: '[a, b][3, 1]',
    foldedText: '{a=[a, A]}',
    uncomparable: 'cce 0',
    treeEnd: 'NoSuchElementException',
    memoCme: 'cme',
    enumMapText: '{R=2, G=1}',
    replacedShades: '{R=12, G=11}',
    keysText: '[a, b]',
    stillPending: true,
    polled: '0,2,3,4,5,6,7,11,12,13,14,15,16,',
    dequeText: '[1, 2, 3]',
    viewCme: 'cme{1=1, 2=2}',
    counted:
      '{nine=1, six=1, one=2, seven=1, three=1, two=1, thirteen=1, eight=1, four=1, twelve=1, eleven=1, ten=1, five=1}',
    wrapped: 'cme',
    sorted: '[null, a, b]',
  });
});
