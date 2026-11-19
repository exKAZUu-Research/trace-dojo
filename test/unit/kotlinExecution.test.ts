import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Programs with the output of Kotlin 2.4.21 on the JVM (Java 25), which the interpreter must reproduce exactly. */
test.each([
  {
    name: 'the iteration order of hash maps and sets',
    source: `fun main() {
    val m = hashMapOf("banana" to 1, "apple" to 2, "cherry" to 3, "date" to 4, "elderberry" to 5)
    println(m)
    println(hashSetOf("zeta", "alpha", "mu", "beta", 100.toString()))
    println(mutableSetOf(3, 1, 2) + listOf(10, -1))
}`,
    stdout: '{banana=1, date=4, apple=2, cherry=3, elderberry=5}\n[zeta, mu, 100, beta, alpha]\n[3, 1, 2, 10, -1]\n',
  },
  {
    name: 'seeded random numbers',
    source: `import kotlin.random.Random
fun main() {
    val r = Random(42)
    println(List(5) { r.nextInt(100) })
    println(r.nextDouble())
    println(r.nextLong())
    println(listOf(1, 2, 3, 4, 5).shuffled(Random(7)))
}`,
    stdout: '[33, 40, 41, 2, 41]\n0.15133155838385304\n-412065243263358597\n[5, 3, 4, 1, 2]\n',
  },
  {
    name: 'numbers and formatted output',
    source: `import kotlin.math.pow
fun main() {
    println(1.0 / 3)
    println(100.0)
    println(1e20)
    println(1.0e-5)
    println(7.0f / 3)
    println(0.1 + 0.2)
    println(10000.0 * (1 + 0.05 / 4).pow(4 * 10))
    println(String.format("%5.2f|%-5d|%s|%,d|%08.3f|%x|%e", 3.14159, 42, "hi", 1234567, -3.5, 255, 12345.678))
    println(10.0.toString() + 1.toString() + 'c'.toString() + 3L.toString())
    println(Int.MAX_VALUE + 1)
    println(-7 / 2 + -7 % 2 + (-7).mod(3))
}`,
    stdout:
      '0.3333333333333333\n100.0\n1.0E20\n1.0E-5\n2.3333333\n0.30000000000000004\n16436.194634870102\n 3.14|42   |hi|1,234,567|-003.500|ff|1.234568e+04\n10.01c3\n-2147483648\n-2\n',
  },
  {
    name: 'data classes',
    source: `data class Point(val x: Int, val y: Int)
data class Named(val name: String, val tags: List<String>)
fun main() {
    val p = Point(1, 2)
    println(p)
    println(p == Point(1, 2))
    println(p.hashCode())
    println(p.copy(y = 5))
    val (x, y) = p
    println(x + y)
    println(Named("a", listOf("x", "y")))
    println(setOf(Point(1, 2), Point(1, 2)).size)
}`,
    stdout: 'Point(x=1, y=2)\ntrue\n33\nPoint(x=1, y=5)\n3\nNamed(name=a, tags=[x, y])\n1\n',
  },
  {
    name: 'sealed classes, data objects, and enums',
    source: `sealed class Shape {
    data class Circle(val r: Double) : Shape()
    data class Rect(val w: Double, val h: Double) : Shape()
    data object Empty : Shape()
}
enum class Dir { N, E, S, W; fun turn() = entries[(ordinal + 1) % entries.size] }
fun area(s: Shape): Double = when (s) {
    is Shape.Circle -> 3.0 * s.r * s.r
    is Shape.Rect -> s.w * s.h
    Shape.Empty -> 0.0
}
fun main() {
    println(listOf(Shape.Circle(1.0), Shape.Rect(2.0, 3.0), Shape.Empty).map { area(it) })
    println(Shape.Empty)
    println(Dir.W.turn())
}`,
    stdout: '[3.0, 6.0, 0.0]\nEmpty\nN\n',
  },
  {
    name: 'durations',
    source: `import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
fun main() {
    println(30.minutes == 0.5.hours)
    println(90.minutes)
    println(1.5.hours + 15.minutes)
    println(25.hours)
}`,
    stdout: 'true\n1h 30m\n1h 45m\n1d 1h\n',
  },
  {
    name: 'standard error, which the screen does not show',
    source: `fun main() {
    System.err.println("oops")
    System.out.println("ok")
    print(1)
    println()
}`,
    stdout: 'ok\n1\n',
  },
])('runs $name as Kotlin does', ({ source, stdout }) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test.each([
  {
    name: 'an index out of bounds',
    source: 'fun main() {\n    println("before")\n    println(listOf(1, 2)[5])\n}',
    stdout: 'before\n',
    uncaughtException: 'java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 2',
  },
  {
    name: 'a division by zero',
    source: 'fun main() {\n    val z = 0\n    println(1 / z)\n}',
    stdout: '',
    uncaughtException: 'java.lang.ArithmeticException: / by zero',
  },
  {
    name: 'endless recursion',
    source: 'fun f(n: Int): Int = f(n + 1) + 1\nfun main() {\n    println(f(0))\n}',
    stdout: '',
    uncaughtException: 'java.lang.StackOverflowError',
  },
])('stops at $name as Kotlin does', ({ source, stdout, uncaughtException }) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException });
});

test('stops an endless loop at the execution limit', () => {
  expect(executeProgram('kotlin', 'fun main() {\n    var i = 0\n    while (true) i++\n}')).toMatchObject({
    kind: 'limitExceeded',
  });
});

/** Programs with whether kotlinc 2.4.21 compiles them, which decides whether the interpreter may run them. */
test.each([
  ['a type mismatch', false, 'fun main() {\n    val x: Int = "a"\n    println(x)\n}'],
  ['a member of a nullable value', false, 'fun main() {\n    val s: String? = null\n    println(s.length)\n}'],
  ['a safe call on a nullable value', true, 'fun main() {\n    val s: String? = null\n    println(s?.length)\n}'],
  ['an assignment to a val', false, 'fun main() {\n    val x = 1\n    x = 2\n    println(x)\n}'],
  ['a missing parenthesis', false, 'fun main() {\n    println("a"\n}'],
  ['an unknown name', false, 'fun main() {\n    println(y)\n}'],
  ['a missing return', false, 'fun f(x: Int): Int {\n    if (x > 0) return 1\n}\nfun main() {\n    println(f(1))\n}'],
  ['an uninitialized val', false, 'fun main() {\n    val x: Int\n    println(x)\n}'],
  ['a private member from outside', false, 'class A {\n    private val x = 1\n}\nfun main() {\n    println(A().x)\n}'],
  [
    'a protected member from outside',
    false,
    'open class Base {\n    protected fun p() = 1\n}\nfun main() {\n    println(Base().p())\n}',
  ],
  [
    'private members from the class, its companion, and its nested classes',
    true,
    'class A {\n    private val q = 2\n    companion object {\n        private val secret = 3\n        fun peek(a: A) = a.q\n    }\n    fun useSecret() = secret\n    class Nested {\n        fun look(a: A) = a.q + secret\n    }\n}\nfun main() {\n    println(A.peek(A()) + A().useSecret() + A.Nested().look(A()))\n}',
  ],
  ['an instance of a sealed class', false, 'sealed class Shape\nfun main() {\n    println(Shape())\n}'],
])('decides whether %s compiles as kotlinc does', (_name, compiles, source) => {
  expect(executeProgram('kotlin', source).kind === 'compileError').toBe(!compiles);
});

test.each([
  [
    'standard input',
    'fun main() {\n    val s = readln()\n    println(s)\n}',
    '標準入力（readln）は、この採点環境では使えません。',
  ],
  [
    'files',
    'import java.io.File\nfun main() {\n    println(File("a.txt").readText())\n}',
    'ファイルの読み書きは、この採点環境では使えません。',
  ],
])('rejects %s as unavailable', (_name, source, message) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ message }] });
});
