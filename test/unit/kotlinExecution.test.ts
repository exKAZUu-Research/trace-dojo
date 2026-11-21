import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Programs with the output of Kotlin 2.4.21 on the JVM (Java 25), which the interpreter must reproduce exactly. */
test.each([
  {
    name: 'negative source indices in array copies',
    source: `fun main() {
    try {
        intArrayOf(1, 2, 3).copyOfRange(-1, 2)
    } catch (error: IndexOutOfBoundsException) {
        println(error.message)
    }
    try {
        arrayOf("x").copyOfRange(-1, 0)
    } catch (error: IndexOutOfBoundsException) {
        println(error.message)
    }
}`,
    stdout:
      'arraycopy: source index -1 out of bounds for int[3]\narraycopy: source index -1 out of bounds for object array[1]\n',
  },
  {
    name: 'map putAll keeps iterators valid until it inserts a key',
    source: `fun main() {
    val map = linkedMapOf("a" to 1, "b" to 2)
    val iterator = map.entries.iterator()
    map.putAll(mapOf("a" to 3))
    map.putAll(emptyMap())
    println(iterator.next())
    map.putAll(mapOf("c" to 4))
    try {
        println(iterator.next())
    } catch (error: ConcurrentModificationException) {
        println("invalidated")
    }
}`,
    stdout: 'a=3\ninvalidated\n',
  },
  {
    name: 'mixed Float comparisons round integer operands to Float',
    source: `fun main() {
    val x = 16_777_216f
    val i = 16_777_217
    val high = 18014399583223809L
    val low = 18014398509481984f
    println(listOf((x < i), (i > x), (x >= i), (i.toLong() <= x), (high > low), (low < high), (high.toFloat() > low)))
}`,
    stdout: '[false, false, true, true, true, true, true]\n',
  },
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
    name: 'val initialization on a single write through loop exits',
    source: `class One {
    val n: Int
    init {
        do { n = 1 } while (false)
    }
}
class BreakPath {
    val n: Int
    init {
        while (true) {
            n = 2
            break
        }
    }
}
class FinallyPath(seed: Int) {
    val n: Int
    init {
        while (true) {
            try { this.n = seed + 1 }
            finally { break }
        }
    }
}
class SuppressedException {
    val n: Int
    init {
        while (true) {
            try { n = fail() }
            finally { break }
        }
    }
    private fun fail(): Int = throw IllegalStateException()
}
fun found(stops: Boolean) {
    val result: Int
    var remaining = 2
    while (true) {
        if (stops || remaining == 0) {
            result = remaining
            break
        }
        remaining--
    }
    println(result)
}
fun main() {
    println(One().n)
    println(BreakPath().n)
    println(FinallyPath(2).n)
    println(SuppressedException().n)
    found(false)
}`,
    stdout: '1\n2\n3\n0\n0\n',
  },
  {
    name: 'finally sees assignments before a pending jump',
    source: `fun main() {
    var count: Int
    do {
        try {
            count = 7
            break
        } finally {
            println(count)
            if (true) continue
        }
    } while (count < 0)
    println(count)
}`,
    stdout: '7\n7\n',
  },
  {
    name: 'finally assignments on normal, break, and continue paths',
    source: `fun breakExit() {
    var value: Int
    do {
        try { break }
        finally { value = 2 }
    } while (false)
    println(value)
}
fun continueExit(fail: Boolean) {
    var value: Int
    do {
        try {
            try {
                if (fail) throw IllegalArgumentException()
                continue
            } catch (error: IllegalArgumentException) {
                continue
            } finally {
                value = 3
            }
        } finally {
            value = 4
        }
    } while (value < 0)
    println(value)
}
fun normalExit() {
    var value: Int
    try { println("try") }
    finally { value = 5 }
    println(value)
}
fun overridingExit() {
    var value: Int
    do {
        try { break }
        finally {
            value = 6
            continue
        }
    } while (value < 0)
    println(value)
}
fun main() {
    breakExit()
    continueExit(false)
    continueExit(true)
    normalExit()
    overridingExit()
}`,
    stdout: '2\n4\n4\ntry\n5\n6\n',
  },
  {
    name: 'local names take precedence over unavailable Java APIs',
    source: `import java.util.*
class Scanner {
    val io = "local"
}
fun main() {
    val java = Scanner()
    println(java.io)
}`,
    stdout: 'local\n',
  },
  {
    name: 'string content that resembles property accessors',
    source: 'fun main() { println(" get()=1; set(x)") }',
    stdout: ' get()=1; set(x)\n',
  },
  {
    name: 'case-insensitive matches keep JVM characters and UTF-16 indices',
    source: `fun main() {
    println("İabc".indexOf("ABC", ignoreCase = true))
    println("İ".equals("i", ignoreCase = true))
    println("i".contains("İ", ignoreCase = true))
    println("hello".contains('E', ignoreCase = true))
    println("İ".startsWith('i', ignoreCase = true))
    println(StringBuilder("hello").endsWith('O', ignoreCase = true))
    println("İaİ".lastIndexOf("i", ignoreCase = true))
    println("sſ".endsWith("SS", ignoreCase = true))
    println("Σσς".replace("σ", "x", ignoreCase = true))
    println("İ-a-i".split("i", ignoreCase = true))
    println("𐐀".equals("𐐨", ignoreCase = true))
    println(StringBuilder("𐐀").indexOf("𐐨", ignoreCase = true))
    println("𐐀".compareTo("a", ignoreCase = true))
    println("a".compareTo("𐐀", ignoreCase = true))
    println("𐐀".compareTo("字", ignoreCase = true))
    println("abc".replace("", "-", ignoreCase = true))
    println('İ'.equals('i', ignoreCase = true))
}`,
    stdout: '1\ntrue\ntrue\ntrue\ntrue\ntrue\n2\ntrue\nxxx\n[, -a-, ]\ntrue\n-1\n55200\n-55200\n43217\n-a-b-c-\ntrue\n',
  },
  {
    name: 'indentation trimming normalizes Windows and classic Mac line endings',
    source: `fun main() {
    println("  a\\r\\n  b\\r  c\\n  d".trimIndent())
    println(" |a\\r\\n |b\\r |c".trimMargin())
}`,
    stdout: 'a\nb\nc\nd\na\nb\nc\n',
  },
  {
    name: 'integer parsing bounds with long input and leading zeroes',
    source: `fun main() {
    val zeroes = "0".repeat(50000)
    println((zeroes + "9223372036854775807").toLongOrNull())
    println("-9223372036854775808".toLongOrNull())
    println("9223372036854775808".toLongOrNull())
    println("9".repeat(500000).toIntOrNull())
    println("ff".toIntOrNull(16))
}`,
    stdout: '9223372036854775807\n-9223372036854775808\nnull\nnull\n255\n',
  },
  {
    name: 'array copying, searching, shuffling, and map operations',
    source: `import kotlin.random.Random
fun main() {
    val contents = intArrayOf(3, 1, 2)
    contents.shuffle(Random(42))
    println(contents.toList())
    println((contents + 9).toList())
    println((contents + intArrayOf(7, 8)).toList())
    println((longArrayOf(1) + listOf(2L, 3L)).toList())
    println((arrayOf("x") + arrayOf("y")).toList())
    println((arrayOf("x") + "z").toList())
    println(intArrayOf(1, 3, 5).binarySearch(3))
    println(intArrayOf(1, 3, 5).binarySearch(4))
    val target = IntArray(5)
    contents.copyInto(target, 1)
    println(target.toList())
    target.copyInto(target, 2, 1, 4)
    println(target.toList())
    val iterable = target.asIterable()
    target[0] = -1
    println(iterable.first())
    println(intArrayOf(2, 3).contentHashCode())
    println(arrayOf(2, 3).toIntArray().toList())
    val labels = mapOf(1 to "a")
    println(labels.none())
    println(emptyMap<Int, String>().ifEmpty { mapOf(0 to "empty") })
    println(labels.onEach { println(it.key) }.firstNotNullOf { it.value })
}`,
    stdout:
      '[1, 3, 2]\n[1, 3, 2, 9]\n[1, 3, 2, 7, 8]\n[1, 2, 3]\n[x, y]\n[x, z]\n1\n-3\n[0, 1, 3, 2, 0]\n[0, 1, 1, 3, 2]\n-1\n1026\n[2, 3]\nfalse\n{0=empty}\n1\na\n',
  },
  {
    name: 'floating ranges and mixed numeric progressions and membership',
    source: `import kotlin.random.Random
fun main() {
    val value = 2.5
    println(value in 0.0..3.0)
    println(when (value) { in 2.0..<3.0 -> "middle"; else -> "outside" })
    println(3.0 in 2.0..<3.0)
    println((1.0..2.0).toString())
    println((Float.NaN..3.0f).isEmpty())
    println(5.0.coerceIn(1.0..3.0))
    println(0.5f.coerceAtLeast(1.0f))
    println(8L.coerceIn(1L..3L))
    println((0 until 3L).toList())
    println((3L downTo 1).toList())
    val small = 1
    val big = 5L
    println(small in 1L..3L)
    println(big in 1..10)
    println(Long.MAX_VALUE in 1..10)
    println(when (small) { in 1L..3L -> "mixed"; else -> "outside" })
    val items: List<Any> = listOf("x", 1)
    println(1 in items)
    println((1L..20L).random(Random(4)))
}`,
    stdout:
      'true\nmiddle\nfalse\n1.0..2.0\ntrue\n3.0\n1.0\n3\n[0, 1, 2]\n[3, 2, 1]\ntrue\ntrue\nfalse\nmixed\ntrue\n3\n',
  },
  {
    name: 'split limits and delimiter order with empty delimiters',
    source: `fun main() {
    println("abc".split("", limit = 2))
    println("abc".split("b", ""))
    println("abc".split("", "b"))
    println("".split(""))
    println("abc".split("", limit = 1))
}`,
    stdout: '[, abc]\n[, a, , c, ]\n[, a, b, c, ]\n[, ]\n[abc]\n',
  },
  {
    name: 'mutable list iterators through nested reversed views',
    source: `fun main() {
    val source = mutableListOf(1, 2, 3)
    val view = source.asReversed().asReversed()
    val iterator: MutableListIterator<Int> = view.listIterator(1)
    println(iterator.next())
    iterator.set(9)
    iterator.add(8)
    println(iterator.previous())
    iterator.remove()
    println(source)
    val forward = view.iterator()
    println(forward.next())
    forward.remove()
    println(source)
    view.addFirst(0)
    view.addLast(7)
    println(source)
    val inserted = source.asReversed().listIterator()
    inserted.add(10)
    inserted.set(11)
    println(source)
    inserted.remove()
    println(source)
}`,
    stdout: '2\n8\n[1, 9, 3]\n1\n[9, 3]\n[0, 9, 3, 7]\n[0, 9, 3, 7, 11]\n[0, 9, 3, 7]\n',
  },
  {
    name: 'sublists share parent changes and compose with reversed views',
    source: `fun main() {
    val source = mutableListOf(8, 3, 2, 1, 7)
    val view = source.subList(1, 4)
    view.reverse()
    println(source)
    source[1] = 9
    println(view)
    val nested = view.subList(1, 3).asReversed()
    nested.add(0, 4)
    println(source)
    println(view)
    println(nested)
    view.sort()
    println(source)
    source.add(10)
    try {
        println(view.size)
    } catch (error: ConcurrentModificationException) {
        println("stale")
    }
}`,
    stdout: '[8, 1, 2, 3, 7]\n[9, 2, 3]\n[8, 9, 2, 3, 4, 7]\n[9, 2, 3, 4]\n[4, 3, 2]\n[8, 2, 3, 4, 9, 7]\nstale\n',
  },
  {
    name: 'character iterables and grouping traverse their sources on demand',
    source: `fun main() {
    val letters = StringBuilder()
    val iterable = letters.asIterable()
    val groups = letters.groupingBy { it }
    letters.append("aba")
    println(iterable.toList())
    println(groups.eachCount())
    letters[0] = 'c'
    println(groups.eachCount())

    val words = mutableListOf("a", "b")
    var calls = 0
    val byLength = words.groupingBy {
        calls++
        it.length
    }
    println(calls)
    words.add("cc")
    println(byLength.eachCount())
    words[0] = "ddd"
    println(byLength.eachCount())
    println(calls)
}`,
    stdout: '[a, b, a]\n{a=2, b=1}\n{c=1, b=1, a=1}\n0\n{1=2, 2=1}\n{3=1, 1=1, 2=1}\n6\n',
  },
  {
    name: 'bulk mutations through a reversed view',
    source: `fun main() {
    val source = mutableListOf(1, 3, 2)
    val view = source.asReversed()
    view.sort()
    println(view)
    println(source)
    view.reverse()
    println(view)
    println(source)
}`,
    stdout: '[1, 2, 3]\n[3, 2, 1]\n[3, 2, 1]\n[1, 2, 3]\n',
  },
  {
    name: 'indexed and reversed collection views stay backed by their source',
    source: `fun main() {
    val values = mutableListOf(1, 2, 3)
    val indexed = values.withIndex()
    val readonly: List<Int> = values
    val reverse = readonly.asReversed()
    val mutableReverse = values.asReversed()
    values[0] = 9
    println(indexed.map { it.index + it.value })
    println(reverse)
    mutableReverse[0] = 5
    mutableReverse.add(1, 8)
    println(values)
    println(reverse)
    println(indexed.map { it.value })
}`,
    stdout: '[9, 3, 5]\n[3, 2, 9]\n[9, 2, 8, 5]\n[5, 8, 2, 9]\n[9, 2, 8, 5]\n',
  },
  {
    name: 'mutable primary-constructor properties in initializers and captures',
    source: `open class Base(val original: Int)
class Counter(var n: Int = 1, val next: Int = n + 1) : Base(n) {
    val read = { n }
    val label: String by lazy { "c" + n.toString() }
    init {
        n = next + 1
        println(n)
    }
    val after = n
}
fun main() {
    val counter = Counter()
    println(counter.original)
    println(counter.after)
    counter.n = 10
    println(counter.read())
    println(counter.label)
}`,
    stdout: '3\n1\n3\n10\nc10\n',
  },
  {
    name: 'typed properties infer their generic delegates',
    source: `import kotlin.properties.Delegates
class Count {
    var value: Int by Delegates.notNull()
}
var label: String? by Delegates.observable(null) { _, old, new ->
    println(old?.length.toString() + " -> " + new?.length.toString())
}
fun main() {
    val count = Count()
    count.value = 42
    println(count.value)
    label = "item"
    label = null
    val items: List<Int> by lazy { emptyList() }
    println(items)
}`,
    stdout: '42\nnull -> 4\n4 -> null\n[]\n',
  },
  {
    name: 'typed power extensions',
    source: `import kotlin.math.pow
fun main() {
    println(2.0.pow(3.0))
    println(2.0f.pow(3))
}`,
    stdout: '8.0\n8.0\n',
  },
  {
    name: 'rounding just below a half and at the double precision boundary',
    source: `import kotlin.math.roundToInt
import kotlin.math.roundToLong
fun main() {
    println(0.49999999999999994.roundToInt())
    println(0.5.roundToInt())
    println((-0.5).roundToInt().toDouble())
    println(4503599627370497.0.roundToLong())
}`,
    stdout: '0\n1\n0.0\n4503599627370497\n',
  },
  {
    name: 'JDK hash collection sizing when copying entries',
    source: `fun main() {
    val source = linkedMapOf(4 to "a", 0 to "b", 8 to "c")
    println(HashMap(source).keys)
    val destination = HashMap<Int, String>()
    destination.putAll(source)
    println(destination.keys)
    println(HashSet(listOf(0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21)))
}`,
    stdout: '[4, 0, 8]\n[4, 0, 8]\n[0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21]\n',
  },
  {
    name: 'library enum entries used directly before other library calls',
    source: `import kotlin.time.DurationUnit
import kotlin.time.toDuration
fun main() {
    println(DurationUnit.SECONDS)
    println(DurationUnit.entries)
    println(DurationUnit.values().size)
    println(5.toDuration(DurationUnit.valueOf("SECONDS")))
}`,
    stdout: 'SECONDS\n[NANOSECONDS, MICROSECONDS, MILLISECONDS, SECONDS, MINUTES, HOURS, DAYS]\n7\n5s\n',
  },
  {
    name: 'right reductions, comparator extrema, and adjacent characters',
    source: `fun main() {
    val numbers = listOf(1, 2, 3)
    println(numbers.foldRight(0) { element, acc -> element - acc })
    println(numbers.reduceRight { element, acc -> element - acc })
    println(numbers.maxWithOrNull(compareBy<Int> { -it }))
    println(emptyList<Int>().minWithOrNull(compareBy<Int> { it }))
    println("abc".zipWithNext { a, b -> a.toString() + b.toString() })
}`,
    stdout: '2\n2\n1\nnull\n[ab, bc]\n',
  },
  {
    name: 'floating-point selectors on arrays, maps, and text',
    source: `fun main() {
    println(intArrayOf(1, 2).minOf { if (it == 1) Double.NaN else 1.0 })
    println(arrayOf(1, 2).maxOfOrNull { if (it == 1) Float.NaN else 1.0f })
    println(mapOf(1 to 1, 2 to 2).minOf { if (it.key == 1) Double.NaN else 1.0 })
    println("ab".minOf { if (it == 'a') Double.NaN else 1.0 })
    println(emptyMap<Int, Int>().maxOfOrNull { it.value.toDouble() })
    println(arrayOf(3, 1).minOf { it.toString() })
}`,
    stdout: 'NaN\nNaN\nNaN\nNaN\nnull\n1\n',
  },
  {
    name: 'floating-point collection and selector extrema',
    source: `fun main() {
    println(listOf(1.0f, Float.NaN).min())
    println(listOf(1, 2).minOf { if (it == 1) Double.NaN else 1.0 })
    println(listOf(1, 2).maxOfOrNull { if (it == 1) -0.0f else 0.0f })
    println(listOf(2, 1).minOf { it.toString() })
    println(emptyList<Float>().minOrNull())
}`,
    stdout: 'NaN\nNaN\n0.0\n1\nnull\n',
  },
  {
    name: 'collection subtraction removes every matching occurrence',
    source: `fun main() {
    val values = mutableListOf(1, 1, 2, 3, 3, 4)
    values -= listOf(1, 3)
    println(values)
    values -= values
    println(values)
}`,
    stdout: '[2, 4]\n[]\n',
  },
  {
    name: 'formatted Java streams with chaining',
    source: `fun main() {
    System.out.printf("%s: %03d", "points", 7).println()
    System.out.format(null, "%.2f%n", 1.25)
    System.err.printf("hidden: %d", 2)
}`,
    stdout: 'points: 007\n1.25\n',
  },
  {
    name: 'explicit calls to Char and Boolean operators',
    source: `fun main() {
    println('a'.plus(2))
    println('c'.minus(1))
    println('a'.minus('c'))
    println(Char.MAX_VALUE.inc().code)
    println(Char.MIN_VALUE.dec().code)
    println(true.not())
}`,
    stdout: 'c\nb\n-2\n0\n65535\nfalse\n',
  },
  {
    name: 'smart casts under Boolean negation',
    source: `fun show(text: String?, value: Any) {
    if (!(text == null)) println(text.length)
    if (!(value !is String)) println(value.length)
    if (!(text == null || text.isEmpty())) println(text[0])
}
fun main() { show("abc", "do") }`,
    stdout: '3\n2\na\n',
  },
  {
    name: 'resized copies of primitive and reference arrays',
    source: `fun main() {
    val source = intArrayOf(1, 2, 3)
    println(source.copyOf(2).contentToString())
    println(source.copyOf(4).contentToString())
    println(booleanArrayOf(true).copyOf(2).contentToString())
    val refs: Array<String?> = arrayOf("x").copyOf(2)
    println(refs.contentToString())
    println(source.contentToString())
    try { source.copyOf(-1) } catch (e: NegativeArraySizeException) { println(e.message) }
}`,
    stdout: '[1, 2]\n[1, 2, 3, 0]\n[true, false]\n[x, null]\n[1, 2, 3]\n-1\n',
  },
  {
    name: 'inherited defaults through base and derived receiver types',
    source: `open class Parent {
    open fun greet(name: String = "world", message: String = "Hi " + name): String = message
}
class Child : Parent() {
    override fun greet(name: String, message: String): String = message + "!"
}
fun main() {
    println(Child().greet())
    val parent: Parent = Child()
    println(parent.greet("Kotlin"))
    println(Child().greet(message = "Hello"))
}`,
    stdout: 'Hi world!\nHi Kotlin!\nHello!\n',
  },
  {
    name: 'growing a StringBuilder in a loop',
    source: `fun main() {
    val builder = StringBuilder()
    for (index in 0 until 10000) builder.append(index)
    println(builder.length)
    println(builder.substring(38880))
}`,
    stdout: '38890\n9799989999\n',
  },
  {
    name: 'NaN and signed zero in floating-point array extrema',
    source: `fun main() {
    println(doubleArrayOf(1.0, Double.NaN).max())
    println(floatArrayOf(0.0f, -0.0f).min())
    println(doubleArrayOf(-0.0, 0.0).maxOrNull())
    println(floatArrayOf(2.0f, Float.NaN).minOrNull())
}`,
    stdout: 'NaN\n-0.0\n0.0\nNaN\n',
  },
  {
    name: 'live primitive array iterators and list views',
    source: `fun main() {
    val values = intArrayOf(1, 2, 3)
    val view = values.asList()
    val sublist = view.subList(1, 3)
    val snapshot = view.toList()
    val iterator = sublist.listIterator()
    values[0] = 9
    for (value in values) {
        print(value)
        values[1] = 8
    }
    println()
    println(view)
    println(sublist)
    println(iterator.next())
    println(view is MutableList<*>)
    println(snapshot)
}`,
    stdout: '983\n[9, 8, 3]\n[8, 3]\n8\nfalse\n[1, 2, 3]\n',
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
  {
    name: 'numbers: receivers of lambdas, mixed operands, constants, boxes, and rounding',
    source: `fun main() {
    println(5.run { this * 2 })
    println(1.5.run { this * 2 })
    println(10.0.div(4))
    println(3.times(2.5))
    val l: Long = 2147483647 + 1
    println(l)
    val a: Int? = 127; val b: Int? = 127; val c: Int? = 1000; val d: Int? = 1000
    println("\${a === b} \${c === d}")
    println(-9223372036854775807 - 1)
    println(kotlin.math.round(-0.5))
    println(listOf(3.0, Double.NaN, 1.0).min())
    println('٣'.digitToInt())
    println("a\\u0041b")
}`,
    stdout: '10\n3.0\n2.5\n7.5\n-2147483648\ntrue false\n-9223372036854775808\n-0.0\nNaN\n3\naAb\n',
  },
  {
    name: 'inference, smart casts of safe calls, and calls of function values',
    source: `val sq: Int.() -> Int = { this * this }
var hits = 0
    set(value) { field = value * 2 }
class Box(val v: Int) { infix fun plusB(o: Box) = Box(v + o.v) }
class B { var c = 1 }
fun main() {
    println(square(3) + 1)
    val m = mutableMapOf<String, MutableList<Int>>()
    m.getOrPut("a") { mutableListOf() }.add(1)
    println(m)
    val fs: List<(Int) -> Int> = listOf({ it + 1 })
    println(fs[0](1))
    val longs: List<Long> = listOf(1, 2)
    println(longs.sum())
    println(maxOf(1, 2L))
    val s: String? = "abc"
    if (s?.length != null) println(s.length)
    val n: String? = null
    println(n + "x")
    println('a' + "bc")
    println(5.sq())
    hits = 3
    println(hits)
    println((Box(1) plusB Box(2)).v)
    val b: B? = B()
    b?.c = 5
    println(b?.c)
    println(1 + listOf<Int>().size)
    println(if (s != null) listOf(1) else emptyList())
}
fun square(x: Int) = x * x`,
    stdout: '10\n{a=[1]}\n2\n3\n2\n3\nnullx\nabc\n25\n6\n3\n5\n1\n[1]\n',
  },
  {
    name: 'the standard library, with the JDK 25 wording of its exceptions',
    source: `fun main() {
    println(HashMap(mapOf(20 to 1, 10 to 2, 1000 to 3, 17 to 4)))
    println("abcabc".lastIndexOf("b", 3))
    println("a,b,c".split(",", limit = 2))
    println("xxaxx".trim('x'))
    println(arrayOf(1, 2, 3).reduce { a, b -> a + b })
    println(setOf(1).single())
    println(5 in 10 downTo 1)
    println(listOf("bb", "a").sortedWith(Comparator { x, y -> x.length - y.length }))
    println(StringBuilder().append(charArrayOf('a', 'b')))
    try { "%,x".format(1) } catch (e: Exception) { println(e) }
    try { "abc".substring(2, 1) } catch (e: Exception) { println(e) }
    try { (1..0).first() } catch (e: Exception) { println(e) }
}`,
    stdout:
      '{1000=3, 17=4, 10=2, 20=1}\n1\n[a, b,c]\na\n6\n1\ntrue\n[a, bb]\nab\njava.util.FormatFlagsConversionMismatchException: Conversion = x, Flags = ,\njava.lang.StringIndexOutOfBoundsException: Range [2, 1) out of bounds for length 3\njava.util.NoSuchElementException: Progression 1..0 is empty.\n',
  },
  {
    name: 'an instance of Any',
    source:
      'fun main() {\n    val a = Any()\n    println(a == a)\n    println(a.toString().startsWith("java.lang.Object@"))\n}',
    stdout: 'true\ntrue\n',
  },
  {
    name: 'the calls that kotlinc resolves among the JVM overloads of the library',
    source: `fun main() {
    val it = mutableListOf(1, 2, 3).listIterator(1)
    println("\${it.next()} \${it.previousIndex()}")
    val built = buildList { add(1) }
    try { built[1] } catch (e: Exception) { println(e) }
    try { (built as MutableList<Int>).add(2) } catch (e: Exception) { println(e) }
    try { "%d".format(null) } catch (e: Exception) { println(e) }
    println("%e".format(Double.MIN_VALUE))
    println(charArrayOf('a', 'b'))
    val long: Long = 1.plus(2).shl(1)
    println(long)
    println(arrayOf(1, 2L)[0] is Long)
    (1..3).onEach { print(it) }
    println()
    try { "ab".repeat(Int.MAX_VALUE) } catch (e: Throwable) { println(e) }
}`,
    stdout:
      "2 1\njava.lang.IndexOutOfBoundsException: index: 1, size: 1\njava.lang.UnsupportedOperationException\njava.util.MissingFormatArgumentException: Format specifier '%d'\n4.900000e-324\nab\n6\ntrue\n123\njava.lang.NegativeArraySizeException: -2\n",
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
    name: 'an exhausted character sequence iterator',
    source: `fun main() {
    val chars: CharSequence = StringBuilder("ab")
    val iterator = chars.iterator()
    println(iterator.next())
    println(iterator.next())
    println(iterator.next())
}`,
    stdout: 'a\nb\n',
    uncaughtException: 'java.lang.StringIndexOutOfBoundsException: Index 2 out of bounds for length 2',
  },
  {
    name: 'a replacement whose expanded text exceeds the interpreter limit',
    source: `fun main() {
    val original = "a".repeat(2000)
    println(original.replace("A", "b".repeat(600), ignoreCase = true))
}`,
    stdout: '',
    uncaughtException: 'java.lang.OutOfMemoryError: Java heap space',
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
  {
    name: 'a format conversion that does not fit its argument',
    source: 'fun main() {\n    println("before")\n    println("%d".format(1.5))\n}',
    stdout: 'before\n',
    uncaughtException: 'java.util.IllegalFormatConversionException: d != java.lang.Double',
  },
  {
    name: 'an array of a negative size',
    source: 'fun main() {\n    val a = IntArray(-1)\n    println(a.size)\n}',
    stdout: '',
    uncaughtException: 'java.lang.NegativeArraySizeException: -1',
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
  [
    'a super call that omits an inherited default argument',
    false,
    `open class A { open fun f(x: Int, y: Int = 2): Int = x + y }
open class B : A() { override fun f(x: Int, y: Int): Int = x + y }
class C : B() { override fun f(x: Int, y: Int): Int = super.f(x) }
fun main() { println(C().f(1)) }`,
  ],
  ['a member of a nullable value', false, 'fun main() {\n    val s: String? = null\n    println(s.length)\n}'],
  ['a safe call on a nullable value', true, 'fun main() {\n    val s: String? = null\n    println(s?.length)\n}'],
  ['an assignment to a val', false, 'fun main() {\n    val x = 1\n    x = 2\n    println(x)\n}'],
  ['a missing parenthesis', false, 'fun main() {\n    println("a"\n}'],
  ['a top-level math power call', false, 'fun main() { println(kotlin.math.pow(2.0, 3.0)) }'],
  [
    'an unrelated element type in an array membership check',
    false,
    'fun main() { val n = 1; println(n in arrayOf("x")) }',
  ],
  [
    'an unrelated element type in an array index lookup',
    false,
    'fun main() { val n = 1; println(arrayOf("x").lastIndexOf(n)) }',
  ],
  ['an integer tested against a floating-point range', false, 'fun main() { val n = 1; println(n in 0.0..2.0) }'],
  ['a floating-point value tested against an integer range', false, 'fun main() { val n = 1.5f; println(n in 0..2) }'],
  ['membership inferred from unrelated element types', false, 'fun main() { println(1 in listOf("x")) }'],
  ['a direct Grouping constructor call', false, 'fun main() { println(Grouping(listOf(1), listOf("a"))) }'],
  ['an unknown name', false, 'fun main() {\n    println(y)\n}'],
  ['a missing return', false, 'fun f(x: Int): Int {\n    if (x > 0) return 1\n}\nfun main() {\n    println(f(1))\n}'],
  ['an uninitialized val', false, 'fun main() {\n    val x: Int\n    println(x)\n}'],
  ['a local var read before its first assignment', false, 'fun main() { var n: Int; n = n + 1; println(n) }'],
  ['a local val read before its first assignment', false, 'fun main() { val n: Int; n = n + 1; println(n) }'],
  [
    'a field read before its first assignment',
    false,
    'class A { val n: Int; init { n = this.n + 1 } }; fun main() { println(A().n) }',
  ],
  [
    'a local assignment whose RHS can throw before a finally break',
    false,
    `fun fail(): Int = throw IllegalStateException()
fun main() {
    var n: Int
    while (true) {
        try { n = fail() }
        finally { break }
    }
    println(n)
}`,
  ],
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
  ['an assignment to a parameter', false, 'fun f(x: Int) {\n    x = 2\n    println(x)\n}\nfun main() { f(1) }'],
  ['a local declared twice', false, 'fun main() {\n    val a = 1\n    val a = 2\n    println(a)\n}'],
  [
    'a local that hides a parameter',
    true,
    'fun f(a: Int): Int {\n    val a = 2\n    return a\n}\nfun main() { println(f(1)) }',
  ],
  [
    'an override of another type',
    false,
    'open class A { open fun f(): Int = 1 }\nclass B : A() { override fun f(): String = "a" }\nfun main() { println(B().f()) }',
  ],
  [
    'a protected member through a receiver of the superclass',
    false,
    'open class A { protected fun f() = 1 }\nclass B : A() { fun g(a: A) = a.f() }\nfun main() { println(B().g(A())) }',
  ],
  [
    'a protected member through a receiver of the subclass',
    true,
    'open class A { protected fun f() = 1 }\nclass B : A() { fun g(b: B) = b.f() + f() }\nfun main() { println(B().g(B())) }',
  ],
  ['an is check that can never hold', false, 'fun main() {\n    val s = "x"\n    if (s is Int) println(1)\n}'],
  [
    'else before another branch of when',
    false,
    'fun main() {\n    val x = 1\n    when (x) {\n        else -> println(1)\n        1 -> println(2)\n    }\n}',
  ],
  [
    'an Int literal among the branches of a Long subject',
    false,
    'fun main() {\n    val l: Long = 5\n    println(when (l) { 5L -> "five"; 6 -> "six"; else -> "?" })\n}',
  ],
  ['a private nested class from outside', false, 'class O { private class N }\nfun main() { println(O.N()) }'],
  [
    'a property read before its initializer',
    false,
    'class A {\n    val y = x + 1\n    val x = 1\n}\nfun main() { println(A().y) }',
  ],
  [
    'a smart cast by require',
    true,
    'fun main() {\n    val x: String? = "a"\n    require(x != null)\n    println(x.length)\n}',
  ],
  ['a conversion of a Byte to a Char', false, 'fun main() {\n    val b: Byte = 1\n    println(b.toChar())\n}'],
  ['a superclass without a constructor call', false, 'open class A\nclass B : A\nfun main() { println(1) }'],
  ['a data class parameter without val', false, 'data class D(x: Int)\nfun main() { println(D(1)) }'],
  ['an assignment to a loop variable', false, 'fun main() {\n    for (i in 0..3) {\n        i = 5\n    }\n}'],
  ['open at the top level', false, 'open fun f() = 1\nfun main() { println(f()) }'],
  [
    'an is check of a function type',
    false,
    'fun main() {\n    val f: Any = { x: Int -> x }\n    println(f is (Int) -> Int)\n}',
  ],
  ['an unknown escape', false, 'fun main() {\n    println("\\q")\n}'],
  ['a variable of the type Nothing?', true, 'fun main() {\n    val n = null\n    println(n)\n}'],
  ['a class of the library that Kotlin does not have', false, 'fun main() {\n    println(EmptyList<Int>())\n}'],
  [
    'a var that a smart-cast value initializes, which keeps the declared type',
    true,
    'class Node(val v: Int, var next: Node?)\nfun main() {\n    var head: Node? = null\n    for (i in 1..3) head = Node(i, head)\n    var c = head\n    while (c != null) {\n        println(c.v)\n        c = c.next\n    }\n}',
  ],
  [
    'a smart cast from the body of a for loop, which may not run',
    false,
    'class Node(val v: Int, var next: Node?)\nfun main() {\n    var head: Node? = null\n    for (i in 1..3) head = Node(i, head)\n    println(head.v)\n}',
  ],
  [
    'a when that a smart cast leaves exhaustive',
    true,
    'enum class C { R, G, B }\nfun f(c: C): String {\n    if (c == C.R) return "first"\n    return when (c) { C.G -> "g"; C.B -> "b" }\n}\nfun main() { println(f(C.R)); println(f(C.B)) }',
  ],
  [
    'a when on a variable whose declared type keeps every case',
    false,
    'enum class C { R, G, B }\nfun main() {\n    val c: C = C.R\n    println(when (c) { C.R -> "r"; C.G -> "g" })\n}',
  ],
  [
    'arrayOf whose reified type argument is an intersection of types',
    false,
    'fun main() {\n    println(arrayOf(1, "s").size)\n}',
  ],
  ['println of a Nothing value, which every overload accepts', false, 'fun main() {\n    println(TODO())\n}'],
  [
    'an inferred override with an incompatible function result',
    false,
    'open class Base { open fun item(): Int = 1 }; class Child : Base() { override fun item() = "wrong" }; fun main() {}',
  ],
  [
    'an inferred override with an incompatible property type',
    false,
    'open class Base { open val item: Int = 1 }; class Child : Base() { override val item = "wrong" }; fun main() {}',
  ],
  [
    'an inferred mutable property overriding a read-only property covariantly',
    true,
    'open class Base { open val item: Any = 1 }; class Child : Base() { override var item = "right" }; fun main() {}',
  ],
  [
    'repeated writes to a class val in separate init blocks',
    false,
    'class A { val n: Int; init { n = 1 }; init { this.n = 2 } }\nfun main() { println(A().n) }',
  ],
  [
    'writes to a class val from a repeating loop',
    false,
    'class A { val n: Int; init { n = 1; for (i in 1..2) this.n = i } }\nfun main() { println(A().n) }',
  ],
  [
    'distinct branches initializing a class val once',
    true,
    'class A(flag: Boolean) { val n: Int; init { if (flag) n = 1 else this.n = 2 } }\nfun main() { println(A(true).n) }',
  ],
  [
    'a class val write that can repeat after continue',
    false,
    `class A {
    val n: Int
    init {
        var count = 0
        while (true) {
            n = count++
            if (count < 2) continue
            break
        }
    }
}
fun main() { println(A().n) }`,
  ],
  [
    'a class val reassigned after finally writes it',
    false,
    `class A {
    val n: Int
    init {
        try { println("try") } finally { n = 1 }
        n = 2
    }
}
fun main() { println(A().n) }`,
  ],
  [
    'a read after finally continues on an exceptional path before assignment',
    false,
    `fun mayThrow() {}
fun main() {
    var count: Int
    do {
        try {
            mayThrow()
            count = 7
            break
        } finally {
            if (true) continue
        }
    } while (count < 0)
    println(count)
}`,
  ],
  [
    'a read after a finally that only conditionally assigns',
    false,
    'fun run(set: Boolean) { var n: Int; do { try { break } finally { if (set) n = 1 } } while (false); println(n) }\nfun main() { run(false) }',
  ],
  [
    'a read after breaking from a do-while before assignment',
    false,
    'fun run(stop: Boolean) { var n: Int; do { if (stop) break; n = 1 } while (false); println(n) }\nfun main() { run(true) }',
  ],
  [
    'a condition reached by continue before assignment',
    false,
    'fun run(stop: Boolean) { var n: Int; do { if (stop) continue; n = 1 } while (n < 1) }\nfun main() { run(true) }',
  ],
  [
    'a read after all do-while exits assign the variable',
    true,
    'fun run(stop: Boolean) { var n: Int; do { if (stop) { n = 2; break }; n = 1 } while (false); println(n) }\nfun main() { run(true) }',
  ],
  [
    'a setter on the line of an expression getter without a semicolon',
    false,
    'class A {\n    var c = 1\n    var f: Int get() = c  set(v) { c = v }\n}\nfun main() { val a = A(); a.f = 2; println(a.f) }',
  ],
  [
    'a setter after a getter and a semicolon',
    true,
    'class A {\n    var c = 1\n    var f: Int get() = c; set(v) { c = v }\n}\nfun main() { val a = A(); a.f = 2; println(a.f) }',
  ],
  [
    'the list builder that buildList uses',
    false,
    'class ListBuilderUser\nfun main() {\n    println(ListBuilder<Int>())\n}',
  ],
  ['Locale without its import', false, 'fun main() {\n    val l: Locale? = null\n}'],
])('decides whether %s compiles as kotlinc does', (_name, compiles, source) => {
  expect(executeProgram('kotlin', source).kind === 'compileError').toBe(!compiles);
});

test.each([
  [
    'an implicitly imported Java class',
    'fun main() { println(Math.abs(-3)) }',
    'Java のクラスの直接の利用（java.lang.Math）は、この採点環境では使えません。',
  ],
  [
    'a standard text extension outside the interpreter',
    'fun main() { println("abc".chunkedSequence(1)) }',
    'String の chunkedSequenceは、この採点環境では使えません。',
  ],
  [
    'the Result companion',
    'fun main() { println(Result.success(1)) }',
    'kotlin.Resultは、この採点環境では使えません。',
  ],
  [
    'a JVM class implicitly imported by Kotlin',
    'fun main() { println(StringBuffer()) }',
    'Java のクラスの直接の利用（java.lang.StringBuffer）は、この採点環境では使えません。',
  ],
  [
    'a recognized static System method',
    'fun main() { println(System.currentTimeMillis()) }',
    'System.currentTimeMillisは、この採点環境では使えません。',
  ],
  [
    'an imported standard time function',
    'import kotlin.system.measureTimeMillis\nfun main() { println(measureTimeMillis { }) }',
    'kotlin.system.measureTimeMillisは、この採点環境では使えません。',
  ],
  [
    'an omitted collection factory',
    'fun main() { println(sortedMapOf(1 to 2)) }',
    'kotlin.collections.sortedMapOfは、この採点環境では使えません。',
  ],
  [
    'a standard-list member outside the interpreter',
    'fun main() { println(listOf(1, 2).foldRightIndexed(0) { i, v, acc -> acc + i * v }) }',
    'List<Int> の foldRightIndexedは、この採点環境では使えません。',
  ],
  [
    'a standard-map member outside the interpreter',
    'fun main() { println(mapOf(1 to "a").maxWithOrNull(compareBy { it.key })) }',
    'Map<Int, String> の maxWithOrNullは、この採点環境では使えません。',
  ],
  [
    'filterIsInstance',
    'fun main() { println(listOf(1, "a").filterIsInstance<Int>()) }',
    '型で要素を絞り込む filterIsInstanceは、この採点環境では使えません。',
  ],
  [
    'standard input',
    'fun main() {\n    val s = readln()\n    println(s)\n}',
    '標準入力（readln）は、この採点環境では使えません。',
  ],
  [
    'standard input through a wildcard import',
    'import java.util.*\nfun main() { println(Scanner(System.`in`).nextInt()) }',
    '標準入力は、この採点環境では使えません。',
  ],
  [
    'standard input through a qualified class name',
    'fun main() { println(java.util.Scanner(System.`in`).nextInt()) }',
    '標準入力は、この採点環境では使えません。',
  ],
  [
    'a qualified file constructor',
    'fun main() { println(java.io.File("a.txt").readText()) }',
    'ファイルの読み書きは、この採点環境では使えません。',
  ],
  [
    'a qualified file type',
    'fun main() { val file: java.io.File? = null; println(file) }',
    'ファイルの読み書きは、この採点環境では使えません。',
  ],
  [
    'standard input through System',
    'fun main() { println(System.`in`.read()) }',
    '標準入力は、この採点環境では使えません。',
  ],
  [
    'files',
    'import java.io.File\nfun main() {\n    println(File("a.txt").readText())\n}',
    'ファイルの読み書きは、この採点環境では使えません。',
  ],
])('rejects %s as unavailable', (_name, source, message) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ message }] });
});

test("prints the same identity hashes whatever ran before in the server's process", () => {
  const program = 'class A\nfun main() {\n    println(hashSetOf(A(), A(), A()).map { it.hashCode() })\n}';
  const first = executeProgram('kotlin', program);
  executeProgram('kotlin', 'class B\nfun main() {\n    repeat(100) { println(B()) }\n}');
  expect(executeProgram('kotlin', program)).toEqual(first);
});

test.each([
  ['class Counter\nfun main() { Counter().missing() }', 'Counter には missing がありません。'],
  ['fun main() { println("abc".lenght) }', 'String には lenght がありません。'],
  ['fun main() { println(listOf(1).sizee) }', 'List<Int> には sizee がありません。'],
  ['fun main() { "abc".substrin(1) }', 'String には substrin がありません。'],
  ['fun main() { "abc".toSortedMap() }', 'String には toSortedMap がありません。'],
])('reports a missing member for %s', (program, message) => {
  expect(executeProgram('kotlin', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message }],
  });
});
