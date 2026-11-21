import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Programs with the output of Kotlin 2.4.21 on the JVM (Java 25), which the interpreter must reproduce exactly. */
test.each([
  {
    name: 'when type tests cover sealed and nullable Boolean alternatives',
    source: `sealed interface Shape
class Circle : Shape
class Square : Shape
fun asNumber(shape: Shape): Int = when (shape) { !is Circle -> 1; is Circle -> 2 }
fun nullable(x: Boolean?): Int = when (x) { is Boolean -> if (x) 1 else 0; null -> 2 }
fun main() {
    println(asNumber(Circle()))
    println(asNumber(Square()))
    println(nullable(true))
    println(nullable(null))
}`,
    stdout: '2\n1\n1\n2\n',
  },
  {
    name: 'JVM distinguishes character mappings, sequence results, and array storage hashes',
    source: `fun main() {
    println('İ'.lowercaseChar())
    println('ᾀ'.uppercaseChar())
    println('ß'.titlecase())
    println('ﬀ'.titlecase())
    println('ǳ'.titlecaseChar())
    val sequence: CharSequence = "abc"
    val reversed = sequence.reversed() as StringBuilder
    reversed.append('!')
    println(reversed)
    println(ubyteArrayOf(255u).contentHashCode())
    println(ushortArrayOf(65535u).contentHashCode())
    val empty: UByteArray? = null
    println(empty.contentHashCode())
    try { println("alpha".trimMargin(" ")) } catch (error: IllegalArgumentException) { println(error.message) }
}`,
    stdout: 'i\nᾈ\nSs\nFf\nǲ\ncba!\n30\n30\n0\nmarginPrefix must be non-blank string.\n',
  },
  {
    name: 'custom sequences and generic iterator overrides use the declared interfaces',
    source: `class Text(private val text: String) : CharSequence {
    override val length: Int get() = text.length
    override fun get(index: Int): Char = text[index]
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = text.substring(startIndex, endIndex)
    override fun toString(): String = "description"
}
class OneIterator : Iterator<Int> {
    private var hasItem = true
    override fun hasNext(): Boolean = hasItem
    override fun next(): Int { hasItem = false; return 7 }
}
class Numbers : Collection<Int> by listOf(7) {
    override fun iterator(): Iterator<Int> = OneIterator()
}
fun main() {
    val item: CharSequence = Text("contents")
    println(StringBuilder(item))
    val copy = ArrayList(Numbers())
    val x: Any = copy[0]
    println(x is Int)
    println(x == 7)
    println(copy.hashCode())
}`,
    stdout: 'contents\ntrue\ntrue\n38\n',
  },
  {
    name: 'map and entry equality dispatch through their declared interfaces',
    source: `class Wrapped(private val map: Map<String, Int?>) : Map<String, Int?> by map
class Entry(override val key: String, override val value: Int?) : Map.Entry<String, Int?>
fun main() {
    val map = mapOf("a" to 3, "b" to null)
    println(map == Wrapped(mapOf("a" to 3, "b" to null)))
    println(map == Wrapped(mapOf("a" to 3, "c" to null)))
    val empty: Map<String, Int?> = emptyMap()
    println(empty == Wrapped(empty))
    println(map.entries.first() == Entry("a", 3))
    val mutable = mutableMapOf("a" to 1)
    val view = mutable.values
    val views = hashSetOf(view)
    mutable["b"] = 2
    println(view in views)
}`,
    stdout: 'true\nfalse\ntrue\ntrue\ntrue\n',
  },
  {
    name: 'a new hash key is hashed once for each insertion',
    source: `var hashes = 0
class Key {
    override fun hashCode(): Int { hashes++; return 42 }
}
fun main() {
    val key = Key()
    val map = HashMap<Key, Int>()
    map[key] = 5
    println(hashes)
    val set = HashSet<Key>()
    set.add(key)
    println(hashes)
    set.add(key)
    println(hashes)
}`,
    stdout: '1\n2\n3\n',
  },

  {
    name: 'comparators observe the JVM mutation order of arrays, lists, and sublists',
    source: `fun main() {
    val list = mutableListOf(3, 1, 2)
    list.sortWith(Comparator { a, b -> println(list); a.compareTo(b) })
    println(list)
    val values = arrayOf(3, 1, 2)
    values.sortWith(Comparator { a, b -> println(values.contentToString()); a.compareTo(b) })
    println(values.contentToString())
    val root = mutableListOf(0, 3, 1, 2, 4)
    val view = root.subList(1, 4)
    try {
        view.sortWith(Comparator { a, b ->
            println(view)
            if (view[0] == 1) throw IllegalArgumentException()
            a.compareTo(b)
        })
    } catch (error: IllegalArgumentException) {
        println(root)
    }
}`,
    stdout:
      '[3, 1, 2]\n[3, 1, 2]\n[1, 3, 2]\n[1, 3, 2]\n[1, 2, 3]\n[3, 1, 2]\n[3, 1, 2]\n[1, 3, 2]\n[1, 3, 2]\n[1, 2, 3]\n[3, 1, 2]\n[3, 1, 2]\n[1, 3, 2]\n[0, 1, 3, 2, 4]\n',
  },
  {
    name: 'nonnull captured writes preserve null-check refinements',
    source: `fun main() {
    var count: Int? = 3
    val setCount = { count = 5 }
    if (count != null) { count--; count += 5; println(count + 1) }
    setCount()
    while (count != null && count > 0) count--
    println(count)
    var name: String? = "hello"
    val setName = { name = "home" }
    if (name != null) println(name.length)
    setName()
}`,
    stdout: '8\n0\n5\n',
  },
  {
    name: 'Kotlin indentation and Unicode case properties use JVM predicates',
    source: String.raw`fun main() {
    println("\u3000first\n\u00a0second".trimIndent())
    println("\n\u3000first\n   \n\u00a0third\n".trimIndent().replace(' ', '.'))
    println("|\n|margin\n|".trimMargin().replace('\n', ':'))
    println('\u0085'.isWhitespace())
    println('Ⅳ'.isUpperCase())
    println('ⅳ'.isLowerCase())
    println('Ⓐ'.isUpperCase())
    println('ⓐ'.isLowerCase())
}`,
    stdout: 'first\nsecond\nfirst\n..\nthird\n:margin:\nfalse\ntrue\ntrue\ntrue\ntrue\n',
  },
  {
    name: 'ArrayList removeIf defers structural changes until callbacks finish',
    source: `fun main() {
    val values = mutableListOf("-1", "2", "bad", "-3")
    try { values.removeIf { it.toInt() < 0 } } catch (error: NumberFormatException) { println(values) }
    val list = mutableListOf(0, 1, 2, 3, 4, 5)
    list.subList(1, 5).removeIf { println(list); it % 2 == 0 }
    println(list)
    val set = linkedSetOf(1, 2, 3)
    set.removeIf { println(set); it % 2 == 1 }
    println(set)
}`,
    stdout:
      '[-1, 2, bad, -3]\n[0, 1, 2, 3, 4, 5]\n[0, 1, 2, 3, 4, 5]\n[0, 1, 2, 3, 4, 5]\n[0, 1, 2, 3, 4, 5]\n[0, 1, 3, 5]\n[1, 2, 3]\n[2, 3]\n[2, 3]\n[2]\n',
  },

  {
    name: 'delegate forwarders override inherited implementations through each interface',
    source: `interface Speaker { fun speak(): String }
open class Base : Speaker { override fun speak(): String = "base" }
class Impl : Speaker { override fun speak(): String = "delegate" }
class Both(d: Speaker) : Base(), Speaker by d
class Own(d: Speaker) : Base(), Speaker by d { override fun speak() = "own" }
interface A { fun f(): Any = 3 }
interface B { fun f(): String }
class BImpl : B { override fun f() = "jvm" }
class C(b: B) : A, B by b
fun main() {
    println(Both(Impl()).speak())
    println(Own(Impl()).speak())
    val c = C(BImpl())
    val a: A = c
    val b: B = c
    println(c.f().length)
    println(a.f())
    println(b.f())
}`,
    stdout: 'delegate\nown\n3\njvm\njvm\n',
  },
  {
    name: 'array clone copies the outer storage and keeps shared references',
    source: `fun main() {
    val values = intArrayOf(1, 2, 3)
    val copy = values.clone()
    copy[0] = 9
    println(values.contentToString())
    println(copy.contentToString())
    val rows = arrayOf(values)
    val cloned: Array<IntArray> = rows.clone()
    println(rows === cloned)
    println(rows[0] === cloned[0])
}`,
    stdout: '[1, 2, 3]\n[9, 2, 3]\nfalse\ntrue\n',
  },
  {
    name: 'captures remain stable when later writes target shadowed locals',
    source: `fun main() {
    var value: Any = "old"
    value = "home"
    val printLength = { if (value is String) value.length else 0 }
    val setOther = { var value = 1; value++ }
    setOther()
    println(printLength())
}`,
    stdout: '4\n',
  },

  {
    name: 'deep array formatting abbreviates cycles while expanding reused arrays',
    source: `fun main() {
    val root = arrayOfNulls<Any>(2)
    val nested = arrayOfNulls<Any>(1)
    root[0] = nested
    root[1] = nested
    nested[0] = root
    println(root.contentDeepToString())
    val shared = arrayOf(1, 2)
    println(arrayOf(shared, shared).contentDeepToString())
    val empty: Array<Int>? = null
    println(empty.contentDeepToString())
}`,
    stdout: '[[[...]], [[...]]]\n[[1, 2], [1, 2]]\nnull\n',
  },
  {
    name: 'function and constructor defaults can read earlier parameters',
    source: `fun total(a: Int = 2, b: Int = a + 3) = a + b
class Pairing(val text: String = "hi", val length: Int = text.length)
fun main() {
    println(total())
    println(total(a = 5))
    println(Pairing().length)
    println(Pairing("hello").length)
}`,
    stdout: '7\n13\n2\n5\n',
  },

  {
    name: 'in-order named arguments can precede positional arguments',
    source: `fun point(x: Int, y: Int, z: Int = 7) { println("$x,$y,$z") }
fun main() {
    point(x = 1, 2)
    point(1, y = 2, 3)
    point(z = 3, x = 1, y = 2)
    println(listOf(1, 2).joinToString(separator = ",", "[", "]"))
}`,
    stdout: '1,2,7\n1,2,3\n1,2,3\n[1,2]\n',
  },
  {
    name: 'String and CharSequence overloads preserve return types and delimiters',
    source: `fun main() {
    val text: CharSequence = StringBuilder(" hello ")
    println(text.startsWith(StringBuilder("he"), 1))
    println(text.endsWith("LO ", ignoreCase = true))
    println(text.trim().dropLast(1))
    println(text.trim().takeLast(2))
    println(text.removePrefix(" ").removeSuffix(" "))
    println(text.trim().filter { it != 'l' } is StringBuilder)
    println(text.trim().padEnd(8, '.') is StringBuilder)
    println(text.replaceRange(1..2, "HE"))
    println("report.2024.csv".substringAfterLast('.'))
    println("report.2024.csv".substringBeforeLast('.'))
    println("untitled".substringBefore(':', "none"))
    println("untitled".substringAfterLast(':', "none"))
    val narrowed: String = "hello".takeWhile { it != 'l' }
    println(narrowed)
}`,
    stdout: 'true\ntrue\nhell\nlo\nhello\ntrue\ntrue\n HEllo \ncsv\nreport.2024\nnone\nnone\nhe\n',
  },
  {
    name: 'Turtle painted-cell checks have English and Japanese names',
    source: `fun main() {
    val turtle = Turtle()
    println(turtle.isFrontPainted())
    println(turtle.前のマスが塗られているか())
}`,
    stdout: 'false\nfalse\n',
  },
  {
    name: 'floating-point literal overflow rounds to infinity',
    source: `fun main() { println(1e309); println(-1.0e400); println(1e39f) }`,
    stdout: 'Infinity\n-Infinity\nInfinity\n',
  },
  {
    name: 'each do-while iteration has its own captured cell',
    source: `fun main() {
    var i = 0
    val reads = mutableListOf<() -> Int>()
    do {
        var x = i++
        reads.add { x++ }
        if (x == 1) continue
    } while (x < 2)
    println(reads.map { it() })
    println(reads.map { it() })
}`,
    stdout: '[0, 1, 2]\n[1, 2, 3]\n',
  },
  {
    name: 'smart casts narrow mutable local reads while assignments retain the declared type',
    source: `fun main() {
    var first: Int? = 3
    if (first != null) println(first--)
    if (first != null) println(++first)
    var second: Int? = 5
    if (second != null) { second += 2; println(second) }
    var third: Int? = 7
    third = third!!
    third--
    println(third)
    var remaining: Int? = 2
    while (remaining != null && remaining > 0) remaining--
    println(remaining)
    second = null
    println(second)
}`,
    stdout: '3\n3\n7\n6\n0\nnull\n',
  },
  {
    name: 'primitive interface properties are boxed across delegated accessors',
    source: `class IntLazy(override val value: Int) : Lazy<Int> {
    override fun isInitialized(): Boolean = true
}
class Wrapper(private val holder: Lazy<Int>) : Lazy<Int> by holder
fun main() {
    val wildcard: Lazy<*> = Wrapper(IntLazy(7))
    val number = wildcard.value
    println(number is Int)
    println(number == 7)
    println(number.hashCode())
}`,
    stdout: 'true\ntrue\n7\n',
  },
  {
    name: 'random-access list predicates compact survivors before shrinking the list',
    source: `fun main() {
    val numbers = mutableListOf(1, 2, 3)
    numbers.removeAll { println(numbers.size); it % 2 == 1 }
    println(numbers)
    val text = mutableListOf("1", "bad", "2")
    try { text.retainAll { it.toInt() > 1 } } catch (e: NumberFormatException) { println(text) }
}`,
    stdout: '3\n3\n3\n[2]\n[1, bad, 2]\n',
  },

  {
    name: 'map copying dispatches the entries of a delegated map',
    source: `class Scores(private val backing: Map<String, Int>) : Map<String, Int> by backing
fun main() {
    val original = Scores(mapOf("a" to 1, "b" to 2))
    println(HashMap(original))
    println(LinkedHashMap(original))
    val copy = mutableMapOf<String, Int>()
    copy.putAll(original)
    println(copy)
}`,
    stdout: '{a=1, b=2}\n{a=1, b=2}\n{a=1, b=2}\n',
  },
  {
    name: 'data classes display and hash arrays by content while keeping reference equality',
    source: `data class Vector(val coords: IntArray?, val names: Array<String?>, val mask: UIntArray)
fun main() {
    val vector = Vector(intArrayOf(1, 2), arrayOf("foo", null), uintArrayOf(0xffffffffu))
    val withoutCoords = vector.copy(coords = null)
    println(vector)
    println(vector.hashCode())
    println(withoutCoords)
    println(withoutCoords.hashCode())
    println(vector == vector.copy(coords = intArrayOf(1, 2)))
}`,
    stdout:
      'Vector(coords=[1, 2], names=[foo, null], mask=UIntArray(storage=[-1]))\n98597669\nVector(coords=null, names=[foo, null], mask=UIntArray(storage=[-1]))\n97642435\nfalse\n',
  },
  {
    name: 'data objects hash their package and enclosing names',
    source: `package lesson
sealed class Status { data object Pending : Status(); data object Done : Status() }
fun main() {
    println(Status.Pending.hashCode())
    println(Status.Done.hashCode())
}`,
    stdout: '1169886993\n1804410952\n',
  },
  {
    name: 'object sorting detects natural runs across the entire input',
    source: `fun main() {
    var comparisons = 0
    val sorted = (128 downTo 1).toMutableList()
    sorted.sortWith(Comparator { a, b -> comparisons++; a.compareTo(b) })
    println(comparisons)
    println(sorted.first())
    println(sorted.last())
    val mixed = (0 until 128).map { if (it < 42) it + 128 else it }.toMutableList()
    comparisons = 0
    var digest = 0
    mixed.sortWith(Comparator { a, b ->
        comparisons++
        digest = digest * 31 + a * 313 + b
        a.compareTo(b)
    })
    println(comparisons)
    println(digest)
    println(mixed.hashCode())
}`,
    stdout: '127\n1\n128\n147\n1754895719\n-618020799\n',
  },

  {
    name: 'Kotlin collection types remain visible with a java.util wildcard import',
    source: `import java.util.*
fun main() {
    val list: List<Int> = ArrayList<Int>()
    val map: Map<String, Int> = HashMap<String, Int>()
    val set: Set<Int> = HashSet<Int>()
    val comparator = Comparator<Int> { a, b -> a - b }
    println(list)
    println(map)
    println(set)
    println(comparator.compare(1, 2))
    println(kotlin.collections.ArrayDeque(listOf(3)))
}`,
    stdout: '[]\n{}\n[]\n-1\n[3]\n',
  },
  {
    name: 'read-only runtime collection markers distinguish Kotlin and Java implementations',
    source: `enum class E { A }
fun main() {
    val empty: Any = emptyList<Int>()
    println(empty is MutableList<*>)
    try { println(empty as MutableList<Int>) } catch (error: ClassCastException) { println(error.message) }
    println(emptyList<Int>().iterator() is MutableIterator<*>)
    println(emptySet<Int>() is MutableSet<*>)
    println(emptyMap<Int, Int>() is MutableMap<*, *>)
    println(emptyMap<Int, Int>().keys is MutableSet<*>)
    println(E.entries is MutableList<*>)
    println(intArrayOf(1).asList().subList(0, 1) is MutableList<*>)
    println(listOf(1) is MutableList<*>)
    println(buildList { add(1) } is MutableList<*>)
}`,
    stdout:
      'false\nkotlin.collections.EmptyList cannot be cast to kotlin.collections.MutableList\nfalse\nfalse\nfalse\nfalse\nfalse\nfalse\ntrue\ntrue\n',
  },
  {
    name: 'Duration conversion ties, infinite arithmetic, and large finite values',
    source: `import kotlin.time.*
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.nanoseconds
fun main() {
    println(0.5.toDuration(DurationUnit.NANOSECONDS))
    println(2.5.toDuration(DurationUnit.NANOSECONDS))
    println((-1.5).toDuration(DurationUnit.NANOSECONDS))
    println(1.seconds / 0)
    println((-1).seconds / 0)
    println(Duration.INFINITE.inWholeNanoseconds)
    println((-Duration.INFINITE).toLong(DurationUnit.DAYS))
    println((Duration.INFINITE / -2).isNegative())
    println((Duration.INFINITE + 1.seconds).isFinite())
    println(365000L.days + 2.nanoseconds)
    try { println(Duration.ZERO / 0) } catch (error: IllegalArgumentException) { println(error.message) }
    try { println(Duration.INFINITE * 0) } catch (error: IllegalArgumentException) { println(error.message) }
    try { println(Duration.INFINITE - Duration.INFINITE) } catch (error: IllegalArgumentException) { println(error.message) }
}`,
    stdout:
      '1ns\n3ns\n-1ns\nInfinity\n-Infinity\n9223372036854775807\n-9223372036854775808\ntrue\nfalse\n365000d\nDividing zero duration by zero yields an undefined result.\nMultiplying infinite duration by zero yields an undefined result.\nSumming infinite durations of different signs yields an undefined result.\n',
  },
  {
    name: 'zip transforms combine arrays, iterables, and character sequences',
    source: `fun main() {
    println("abc".zip("xy") { a, b -> "$a$b" })
    println(intArrayOf(1, 2).zip(intArrayOf(3, 4)) { a, b -> a + b })
    println(arrayOf(1, 2).zip(listOf(3, 4)) { a, b -> a + b })
    println(listOf(1, 2).zip(arrayOf(3, 4)))
    println(listOf(1, 2).zip(arrayOf(3, 4)) { a, b -> a + b })
}`,
    stdout: '[ax, by]\n[4, 6]\n[4, 6]\n[(1, 3), (2, 4)]\n[4, 6]\n',
  },
  {
    name: 'nullable string conversions and array content operations',
    source: `fun show(text: String?, values: IntArray?, other: Array<Int>?) {
    println(text.equals(null))
    println(text.equals("TRUE", ignoreCase = true))
    println(text.toBoolean())
    println(values.contentToString())
    println(values.contentEquals(null))
    println(other.contentToString())
    println(other.contentEquals(null))
}
fun main() {
    show(null, null, null)
    show("True", intArrayOf(1), arrayOf(2))
}`,
    stdout: 'true\nfalse\nfalse\nnull\ntrue\nnull\ntrue\nfalse\ntrue\ntrue\n[1]\nfalse\n[2]\nfalse\n',
  },
  {
    name: 'generic nested arguments use constraints from the receiver and earlier arguments',
    source: `fun show(action: () -> Any?) { println(action()) }
fun main() {
    println(mapOf("a" to listOf(1)).getOrDefault("b", emptyList()))
    println(listOf(1, 2) + listOf())
    println(setOf(1).union(emptySet()))
    println(mapOf(1 to 2) + emptyMap())
    println(listOf(1, 2, 3).toCollection(ArrayList()))
    println(listOf(1, 2, 3).toCollection(HashSet()))
    println(listOf(1, 2, 3).toCollection(mutableListOf()))
    println(maxOf(listOf(1), listOf(2), compareBy { it.size }))
    println(mutableListOf(1).ifEmpty { emptyList() })
    println(mutableSetOf(1).ifEmpty { emptySet() })
    println(arrayListOf(1).ifEmpty { emptyList() })
    show { listOf(1, 2).filter { it > 0 }.ifEmpty { emptyList() } }
    println(listOf(1, 2).ifEmpty { emptySet() })
    println(mutableListOf(1).ifEmpty { mutableSetOf() })
    println(setOf(1).ifEmpty { emptyList() })
    val mixed: Collection<Int> = emptyList<Int>().ifEmpty { emptySet() }
    println(mixed)
    println(linkedSetOf<Int>().ifEmpty { mutableListOf() })
    val nested = mutableListOf(listOf(1))
    nested += listOf(emptyList())
    println(nested)
    println(listOf(listOf(1)) + listOf(listOf()))
    println(mapOf(1 to emptyList<Int>()) + mapOf(2 to emptyList()))
    println(listOf(1).zip(listOf()) { a: Int, b: String -> a })
}`,
    stdout:
      '[]\n[1, 2]\n[1]\n{1=2}\n[1, 2, 3]\n[1, 2, 3]\n[1, 2, 3]\n[1]\n[1]\n[1]\n[1]\n[1, 2]\n[1, 2]\n[1]\n[1]\n[]\n[]\n[[1], []]\n[[1], []]\n{1=[], 2=[]}\n[]\n',
  },
  {
    name: 'ArrayDeque and list builder positional errors match Kotlin/JVM wording',
    source: `fun main() {
    val deque = ArrayDeque(listOf(1, 2, 3))
    try { deque.add(5, 0) } catch (error: IndexOutOfBoundsException) { println(error.message) }
    try { deque.addAll(7, listOf(0)) } catch (error: IndexOutOfBoundsException) { println(error.message) }
    val iterator = deque.listIterator(deque.size)
    try { iterator.next() } catch (error: NoSuchElementException) { println(error.message) }
    try { deque.listIterator().previous() } catch (error: NoSuchElementException) { println(error.message) }
    try { buildList { add(1); add(5, 0) } } catch (error: IndexOutOfBoundsException) { println(error.message) }
}`,
    stdout:
      'index: 5, size: 3\nindex: 7, size: 3\njava.lang.IndexOutOfBoundsException: index: 3, size: 3\njava.lang.IndexOutOfBoundsException: index: -1, size: 3\nindex: 5, size: 1\n',
  },
  {
    name: 'case-insensitive matches at surrogate boundaries',
    source: `fun main() {
    val s = "𐐀"
    val lead = s.substring(0, 1)
    val trail = s.substring(1)
    println(s.indexOf(trail, ignoreCase = true))
    println(s.lastIndexOf(trail, ignoreCase = true))
    println(s.contains(trail, ignoreCase = true))
    println(s.startsWith(lead, ignoreCase = true))
    println(s.endsWith(trail, ignoreCase = true))
    println(s.replace(trail, "X", ignoreCase = true)[1])
    println(s.split(trail, ignoreCase = true).size)
    println(s.contains("𐐨", ignoreCase = true))
}`,
    stdout: '1\n1\ntrue\ntrue\ntrue\nX\n2\ntrue\n',
  },
  {
    name: 'empty lastIndexOf uses Kotlin String and CharSequence search bounds',
    source: `fun main() {
    println("abc".lastIndexOf("", 99, true))
    println("abc".lastIndexOf("", 99, false))
    println("".lastIndexOf("", 99, true))
    val builder: CharSequence = StringBuilder("abc")
    println(builder.lastIndexOf("", 99, true))
    println(builder.lastIndexOf("", 99, false))
    println(builder.indexOf("", 99, false))
}`,
    stdout: '2\n3\n-1\n2\n2\n-1\n',
  },
  {
    name: 'direct floating range membership and explicit range contains use JVM rounding',
    source: `fun main() {
    val range = 0.1f..0.2f
    val value = 0.1
    println(value in (0.1f..0.2f))
    println(value in 0.1f.rangeTo(0.2f))
    println(value in range)
    println(range.contains(value))
    println(2.0000000001 !in (1.0f..2.0f))
}`,
    stdout: 'false\nfalse\ntrue\ntrue\ntrue\n',
  },
  {
    name: 'empty collection calls carry the enclosing inference constraints',
    source: `fun main() {
    println(listOf("ab", "c").flatMap { if (it.length > 1) listOf(it) else emptyList() })
    println(listOf("ab", "c").flatMap { if (it.length > 1) setOf(it) else emptySet() })
    println(listOf(1, 2).filter { it > 0 }.ifEmpty { emptyList() })
}`,
    stdout: '[ab]\n[ab]\n[1, 2]\n',
  },
  {
    name: 'collection renderers enforce the string length bound',
    source: `fun main() {
    val value = "a".repeat(400000)
    try { listOf(value, value, value).toString() } catch (error: OutOfMemoryError) { println("list") }
    try { mapOf(1 to value, 2 to value, 3 to value).toString() } catch (error: OutOfMemoryError) { println("map") }
    try { arrayOf(value, value, value).contentToString() } catch (error: OutOfMemoryError) { println("array") }
}`,
    stdout: 'list\nmap\narray\n',
  },
  {
    name: 'character digits respect their radix and unicode letter width',
    source: `fun main() {
    println('f'.digitToInt(16))
    println('Ａ'.digitToInt(16))
    println('٤'.digitToIntOrNull(16))
    println("Ｆ".toInt(16))
    println('g'.digitToIntOrNull(16))
    try { println('x'.digitToInt(16)) } catch (error: IllegalArgumentException) { println(error.message) }
    try { println('z'.digitToIntOrNull(37)) } catch (error: IllegalArgumentException) { println(error.message) }
}`,
    stdout: '15\n10\n4\n15\nnull\nChar x is not a digit in the given radix=16\nradix 37 was not in valid range 2..36\n',
  },
  {
    name: 'binary search over comparable values, comparator values, and derived keys',
    source: `fun main() {
    val values = listOf("a", "ccc", "dddd")
    println(values.binarySearch(0, 2) { it.compareTo("ccc") })
    println(values.binarySearch("bb", compareBy<String> { it.length }))
    println(values.binarySearchBy(4) { it.length })
    println(listOf(1, 3, 5).binarySearch(3))
}`,
    stdout: '1\n-2\n2\n1\n',
  },
  {
    name: 'iterable predicate search order and nullable matches',
    source: `fun main() {
    val values = setOf(1, 2, 3)
    println(values.last { it < 3 })
    println(values.lastOrNull { it > 3 })
    println(values.findLast { it % 2 == 1 })
    println(values.indexOfFirst { it % 2 == 0 })
    println(values.indexOfLast { it < 3 })
    println(setOf(1, null).last { it == null })
    val seen = mutableListOf<Int>()
    val list = listOf(1, 2, 3)
    list.last { seen.add(it); it == 2 }
    println(seen)
    seen.clear()
    val iterable: Iterable<Int> = list
    iterable.last { seen.add(it); it == 2 }
    println(seen)
}`,
    stdout: '2\nnull\n3\n1\n1\nnull\n[3, 2]\n[1, 2, 3]\n',
  },
  {
    name: 'derived property types and values see assignments in preceding init blocks',
    source: `class A(x: Int) {
    val n: Int
    init { n = x * 2 }
    val k = n + 1
    val values = listOf(n, k)
}
fun main() { println(A(3).values) }`,
    stdout: '[6, 7]\n',
  },
  {
    name: 'window transforms observe updates made before later windows',
    source: `fun main() {
    val values = mutableListOf(1, 2, 3, 4)
    println(values.windowed(2) { if (it[0] == 1) values[2] = 9; it.sum() })
    println(values.chunked(2) { if (it[0] == 1) values[2] = 8; it.sum() })
    println(setOf(1, 2, 3, 4, 5).windowed(3, 2, true) { it.toList() })
    val text = StringBuilder("abcd")
    println(text.chunked(2) { if (it[0] == 'a') text[2] = 'X'; it.toString() })
    println(text.windowed(2) { it.toString() })
}`,
    stdout: '[3, 11, 13]\n[3, 12]\n[[1, 2, 3], [3, 4, 5], [5]]\n[ab, Xd]\n[ab, bX, Xd]\n',
  },
  {
    name: 'collection builders freeze map entries, key views, and mutable aliases',
    source: `fun main() {
    val set = buildSet { add(1); add(2) } as MutableSet<Int>
    val map = buildMap { put(1, "a"); put(2, "b") } as MutableMap<Int, String>
    try { set.remove(4) } catch (error: UnsupportedOperationException) { println("set") }
    try { map[3] = "c" } catch (error: UnsupportedOperationException) { println("map") }
    try { map.keys.clear() } catch (error: UnsupportedOperationException) { println("keys") }
    try { map.entries.iterator().next().setValue("d") } catch (error: UnsupportedOperationException) { println("entry") }
    println(set)
    println(map)
}`,
    stdout: 'set\nmap\nkeys\nentry\n[1, 2]\n{1=a, 2=b}\n',
  },
  {
    name: 'empty array slice ranges bypass endpoint bounds',
    source: `fun main() {
    println(intArrayOf(1, 2, 3).sliceArray(2..0).contentToString())
    println(arrayOf("a", "b").sliceArray(10..5).contentToString())
}`,
    stdout: '[]\n[]\n',
  },
  {
    name: 'PrintStream character array overload and standard error',
    source: `fun main() {
    System.out.print(charArrayOf('o', 'k'))
    System.out.println(charArrayOf('h', 'i'))
    System.err.println(charArrayOf('n', 'o'))
    val missing: CharArray? = null
    try { System.out.println(missing) } catch (error: NullPointerException) { println(error.message) }
}`,
    stdout: 'okhi\nCannot read the array length because "cbuf" is null\n',
  },
  {
    name: 'sorting and reversing respect finalized list mutability',
    source: `fun main() {
    val list = buildList { add(2); add(1) } as MutableList<Int>
    try { list.reverse() } catch (error: UnsupportedOperationException) { println("reverse") }
    try { list.sort() } catch (error: UnsupportedOperationException) { println("sort") }
    println(list)
}`,
    stdout: 'reverse\nsort\n[2, 1]\n',
  },
  {
    name: 'generic postfix syntax binds within operators',
    source: `fun main() {
    println(mapOf("a" to mutableListOf<Int>()))
    println(3 !in listOf<Int>())
    println(3 in listOf<Int>(3))
    println(-maxOf<Int>(1, 2))
    println(!listOf<Int>().isEmpty())
    println(1 until emptyList<Int>().size)
    println(1 to 2 to maxOf<Int>(1, 2))
    println("a" to listOf<Int>(7)[0])
    println((1 to 2).first)
}`,
    stdout: '{a=[]}\ntrue\ntrue\n-2\nfalse\n1..-1\n((1, 2), 2)\n(a, 7)\n1\n',
  },
  {
    name: 'Kotlin ArrayDeque supports both queue ends and indexed list edits',
    source: `fun main() {
    val queue = ArrayDeque(listOf(2, 3))
    queue.addFirst(1)
    queue.addLast(4)
    queue[1] = 9
    println(queue.removeLast())
    println(queue.removeFirst())
    println(queue)
    println(queue.first())
    val view = queue.subList(0, 1)
    view.add(8)
    println(queue.joinToString())
    val asAny: Any = queue
    println(asAny is RandomAccess)
    val empty = ArrayDeque<Int>(1)
    println(empty.lastOrNull())
    try {
        empty.removeFirst()
    } catch (error: NoSuchElementException) {
        println(error.message)
    }
}`,
    stdout: '4\n1\n[9, 3]\n9\n9, 8, 3\nfalse\nnull\nArrayDeque is empty.\n',
  },
  {
    name: 'empty sublist insertions preserve the root iterator',
    source: `fun main() {
    val root = mutableListOf(1, 2, 3)
    val view = root.subList(0, 2)
    val iterator = root.iterator()
    println(view.addAll(emptyList()))
    println(view.addAll(0, emptyList()))
    println(iterator.next())
    root.add(4)
    println(view.addAll(1, emptyList()))
    try {
        view.addAll(1, listOf(9))
    } catch (error: ConcurrentModificationException) {
        println("stale")
    }
}`,
    stdout: 'false\nfalse\n1\nfalse\nstale\n',
  },
  {
    name: 'sorting an ArrayList invalidates its iterator and backed sublist',
    source: `fun main() {
    val root = mutableListOf(3, 1, 2)
    val view = root.subList(0, 2)
    val iterator = root.iterator()
    root.sort()
    println(root)
    try {
        println(view.size)
    } catch (error: ConcurrentModificationException) {
        println("stale view")
    }
    try {
        println(iterator.next())
    } catch (error: ConcurrentModificationException) {
        println("stale iterator")
    }
}`,
    stdout: '[1, 2, 3]\nstale view\nstale iterator\n',
  },
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
    name: 'Float literals and text parse directly to binary32',
    source: `fun main() {
    println("1.0000000596046448".toFloat())
    println(1.0000000596046448f)
    println("1.0000001788139343".toFloatOrNull())
    println(1.0000001788139343f)
    println("0x1.0000010000000000000000000001p0".toFloat())
    println("0x1.fffffep127".toFloat())
    println("0x1.ffffffp127".toFloat())
    println("-0x1p-150".toFloat())
    println("0x1.00000001p-150".toFloat())
}`,
    stdout: '1.0000001\n1.0000001\n1.0000001\n1.0000001\n1.0000001\n3.4028235E38\nInfinity\n-0.0\n1.4E-45\n',
  },
  {
    name: 'a semicolon before the first property accessor',
    source: `var age: Int = 0; set(value) { field = value + 1 }
val answer: Int; get() = 42
class Counter {
    var count = 1
        ; /* after initializer */ get() = field + 1; set(value) { field = value }
}
fun get(): Int = 6
fun main() {
    age = 2
    val counter = Counter()
    println(age)
    println(answer)
    println(counter.count)
    counter.count = 4
    println(counter.count)
    val local = 4; println(get())
    println(local)
}`,
    stdout: '3\n42\n2\n5\n6\n4\n',
  },
  {
    name: 'JVM entry selection and initialization order',
    source: `val indirect = readInt() + 1
val flag = readFlag()
val deferred = { later }
val later = 3
val enabled = true
fun readInt(): Int = later
fun readFlag(): Boolean = enabled
fun argument(): Int { println("argument"); return 4 }
open class Parent { companion object { init { println("parent") } } }
class Child(val n: Int) : Parent() { companion object { init { println("child") } } }
fun checkCallback(value: String?, stop: () -> Nothing): Int {
    if (value == null) stop()
    return value.length
}
fun callCallback(stop: () -> Nothing): Int { stop() }
fun main() { println("zero arguments") }
fun main(args: Array<String>) {
    println(args.size)
    println(indirect)
    println(flag)
    println(deferred())
    println(Child(argument()).n)
    println(Child(argument()).n)
    println(checkCallback("ok") { error("unused") })
    try { callCallback { error("no return") } } catch (e: IllegalStateException) { println(e.message) }
}`,
    stdout: '0\n1\nfalse\n3\nparent\nchild\nargument\n4\nargument\n4\n2\nno return\n',
  },
  {
    name: 'captured writes preserve only nullability on open receiver types',
    source: `interface Animal { fun sound(): String }
class Dog : Animal {
    override fun sound() = "woof"
    fun dogOnly() = "dog only"
}
class Cat : Animal { override fun sound() = "meow" }
fun main() {
    var animal: Animal? = Dog()
    val swap = { animal = Cat() }
    if (animal != null) {
        println(animal.sound())
    }
    swap()
    if (animal != null) {
        println(animal.sound())
    }
}`,
    stdout: 'woof\nmeow\n',
  },
  {
    name: 'private and protected nested imports use the referencing scope',
    source: `package demo
import demo.Outer.Hidden
import demo.Base.Visible
class Outer {
    private class Hidden(val n: Int)
    fun show() = Hidden(3).n
}
open class Base {
    protected class Visible(val n: Int)
}
class Derived : Base() {
    fun show() = Visible(4).n
}
fun main() { println(Outer().show()); println(Derived().show()) }`,
    stdout: '3\n4\n',
  },
  {
    name: 'custom CharSequence operations observe only the necessary reads',
    source: String.raw`class Chars(private val backing: CharSequence) : CharSequence by backing {
    override fun get(index: Int): Char {
        print("get $index;")
        return backing[index]
    }
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence {
        print("sub $startIndex-$endIndex;")
        return backing.subSequence(startIndex, endIndex)
    }
}
fun main() {
    val chars: CharSequence = Chars("abc")
    println(chars.indexOf("a"))
    println(chars.lastIndexOf('b'))
    println(chars.isBlank())
    println(chars.contains(Chars("bc")))
    println("xyabc".removeSuffix(Chars("bc")))
    println(chars.split("b"))
}`,
    stdout:
      'get 0;0\nget 2;get 1;1\nget 0;false\nget 0;get 0;get 0;get 1;get 1;get 2;true\n' +
      'get 0;get 1;xya\nget 0;get 1;sub 0-1;get 2;sub 2-3;[a, c]\n',
  },
  {
    name: 'captured writes of a single subtype preserve matching smart casts',
    source: `open class Shape
class Circle : Shape() { val radius: Int = 1 }
fun main() {
    var shape: Shape? = Circle()
    val replace = { shape = Circle() }
    if (shape != null && shape is Circle) println(shape.radius)
    replace()
    when (shape) {
        is Circle -> println(shape.radius)
        else -> println("unknown")
    }
}`,
    stdout: '1\n1\n',
  },
  {
    name: 'CharSequence collection overloads use the Kotlin signatures',
    source: String.raw`import kotlin.random.Random
fun main() {
    val chars: CharSequence = StringBuilder("aba")
    println(listOf(chars.none(), chars.any(), "".none(), "".any()))
    println(listOf(chars.lastOrNull { it.isLetter() }, chars.single { it == 'b' }, chars.findLast { it == 'a' }))
    println(listOf(chars.substring(1..2), chars.elementAtOrNull(9), chars.elementAtOrElse(9) { 'z' }))
    println(chars.associate { it to it.code })
    println(chars.associateBy({ it.code }, { it.toString() }))
    println(listOf(chars.maxByOrNull { it.code }, chars.minBy { it.code }))
    println(listOf(chars.reduceOrNull { acc, c -> if (c > acc) c else acc }, "".reduceOrNull { acc, _ -> acc }))
    println(chars.foldIndexed("") { index, acc, c -> "$acc$index$c" })
    println(chars.runningFold("") { acc, c -> acc + c })
    println(chars.scan(0) { acc, c -> acc + c.code })
    val builder: StringBuilder = StringBuilder("ab").onEach { print(it) }
    println(builder)
    println(listOf(chars.indexOfAny(charArrayOf('z', 'b')), chars.lastIndexOfAny(listOf("ab", "ba"))))
    println(listOf(chars.commonSuffixWith("xxA", true), chars.repeat(2), chars.contentEquals("ABA", true), chars.random(Random(42))))
}`,
    stdout:
      '[false, true, true, false]\n[a, b, a]\n[ba, null, z]\n{a=97, b=98}\n{97=a, 98=b}\n[b, a]\n[b, null]\n0a1b2a\n[, a, ab, aba]\n[0, 97, 195, 292]\nabab\n[1, 1]\n[a, abaaba, true, a]\n',
  },
  {
    name: 'CharSequence callbacks observe mutations before the next character read',
    source: String.raw`fun main() {
    val b = StringBuilder("ab")
    val chars: CharSequence = b
    println(chars.fold("") { result, c ->
        if (c == 'a') b.setCharAt(1, 'x')
        result + c
    })
    b.setCharAt(1, 'b')
    println(chars.flatMap { c ->
        if (c == 'a') b.setCharAt(1, 'x')
        listOf(c)
    })
    b.setCharAt(1, 'b')
    println(chars.associateWith { c ->
        if (c == 'a') b.setCharAt(1, 'x')
        c.code
    })
    b.setCharAt(1, 'b')
    println(chars.maxOf { c ->
        if (c == 'a') b.setCharAt(1, 'x')
        c.code
    })
    val long = StringBuilder("abc")
    val mutableChars: CharSequence = long
    println(mutableChars.zipWithNext { lhs, rhs ->
        long.setCharAt(1, 'x')
        "$lhs$rhs"
    })
}`,
    stdout: 'ax\n[a, x]\n{a=97, x=120}\n120\n[ab, xc]\n',
  },
  {
    name: 'unsigned array initializer overloads and boxed numeric accumulators',
    source: String.raw`@OptIn(ExperimentalUnsignedTypes::class)
fun main() {
    println(UByteArray(3) { (it + 255).toUByte() }.contentToString())
    println(UShortArray(3) { (it + 65535).toUShort() }.contentToString())
    println(UIntArray(3) { it.toUInt() }.contentToString())
    println(ULongArray(3) { it.toULong() + ULong.MAX_VALUE }.contentToString())
    val long = arrayOf(Long.MAX_VALUE, 2L)
    val float = arrayOf(100000000f, 1f, -100000000f)
    val short = arrayOf(32767.toShort(), 2.toShort())
    val byte = arrayOf(127.toByte(), 2.toByte())
    println(listOf(long.sum(), float.sum(), short.sum(), byte.sum()))
    println(listOf(long.average(), float.average(), short.average(), byte.average()))
    println(arrayOf<Long>().average())
}`,
    stdout:
      '[255, 0, 1]\n[65535, 0, 1]\n[0, 1, 2]\n[18446744073709551615, 0, 1]\n[-9223372036854775807, 0.0, 32769, 129]\n[4.611686018427388E18, 0.3333333333333333, 16384.5, 64.5]\nNaN\n',
  },
  {
    name: 'inline writes remain local to the enclosing function',
    source: String.raw`fun main() {
    var value: Any = "text"
    listOf(1).forEach { value = it }
    if (value is String) println(value.length) else println("not string")
    val check = { if (value is String) value.length else 0 }
    println(check())
}`,
    stdout: 'not string\n0\n',
  },
  {
    name: 'default-method interfaces initialize before the class and complementary tests cover open sealed branches',
    source: String.raw`interface Default {
    val number: Int get() = 1
    companion object { init { println("default") } }
}
interface Abstract : Default {
    fun name(): String
    companion object { init { println("abstract") } }
}
interface Also {
    fun also(): Int = 2
    companion object { init { println("also") } }
}
class Impl : Abstract, Also {
    override fun name(): String = "impl"
    companion object { init { println("impl") } }
}
sealed interface Shape
interface Tagged
open class Group : Shape
class Marked : Shape, Tagged
fun choose(s: Shape): Int = when (s) {
    is Tagged -> 1
    !is Tagged -> 2
}
fun main() {
    println("start")
    Impl()
    println(choose(Group()))
    println(choose(Marked()))
}`,
    stdout: 'start\ndefault\nalso\nimpl\n2\n1\n',
  },
  {
    name: 'a when over a nullable Nothing subject exhausts its null case',
    source: `fun isNull(value: Nothing?): Int = when (value) { is Nothing? -> 1 }
fun main() {
    val v = null
    println(when (v) { null -> 2 })
    println(isNull(v))
}`,
    stdout: '2\n1\n',
  },
  {
    name: 'upcasting a receiver preserves the original variable type',
    source: `fun main() {
    val builder = StringBuilder("abc")
    val sequence = builder as CharSequence
    builder.setCharAt(1, 'x')
    println(sequence)
    val text: String? = "abc"
    val general = text as CharSequence
    println(text.length)
    println(general)
}`,
    stdout: 'axc\n3\nabc\n',
  },
  {
    name: 'a Nothing-returning infix call terminates while safe calls can be skipped',
    source: String.raw`infix fun Int.abort(reason: String): Nothing = error(reason)
fun compute(): Int { 1 abort "stop" }
class Sink {
    fun drop(message: String) { println(message) }
}
fun check(sink: Sink?): Int {
    sink?.drop(error("must be skipped"))
    return 3
}
fun main() {
    try { println(compute()) } catch (e: IllegalStateException) { println(e.message) }
    println(check(null))
}`,
    stdout: 'stop\n3\n',
  },
  {
    name: 'covariant overrides coexist with inherited JVM bridges',
    source: String.raw`open class Base(open val value: Any) {
    open fun get(): Any = value
}
open class Parent : Base("parent") {
    override val value: String get() = "ok"
    override fun get(): String = "from " + value
}
class Child : Parent() {
    override val value: String = "child"
    override fun get(): String = super.get()
}
fun main() { println(Child().get()) }`,
    stdout: 'from child\n',
  },
  {
    name: 'text overloads preserve selector types, ranges, and destinations',
    source: String.raw`fun main() {
    val s = "abc"
    println(s.sumOf { it.code.toLong() })
    println(s.sumOf { it.code.toDouble() })
    println(s.sumOf { it.code.toUInt() })
    println(s.sumOf { it.code.toULong() })
    println(s.groupBy({ it }, { it.code }))
    println(s.toCharArray(0, 2).contentToString())
    val target = charArrayOf('-', '-', '-', '-')
    println(s.toCharArray(target, 1, 1, 3).contentToString())
    println(listOf(s.reduceIndexed { index, acc, char -> if (index == 2) char else acc },
        s.reduceIndexedOrNull { _, acc, _ -> acc }, s.reduceRight { _, acc -> acc },
        "".reduceRightOrNull { _, acc -> acc }, s.runningReduce { _, char -> char }))
    println(s.mapIndexedNotNull { index, char -> if (index == 1) null else char.toString() })
    println(s.mapTo(mutableListOf<Int>()) { it.code })
    println(s.filterTo(StringBuilder("prefix-")) { it != 'b' })
    println(s.firstNotNullOf { if (it == 'c') it.code else null })
    println(s.firstNotNullOfOrNull { if (it == 'q') it.code else null })
    println(s.findAnyOf(listOf("bc", "c")))
    println(s.findLastAnyOf(listOf("bc", "c")))
    println(s.minWithOrNull(compareBy<Char> { it.code }))
    println(s.maxWith(compareBy<Char> { it.code }))
    println(s.toCollection(mutableListOf('z')))
    println(s.toHashSet().size)
    println(s.regionMatches(1, StringBuilder("bC"), 0, 2, ignoreCase = true))
}`,
    stdout:
      '294\n294.0\n294\n294\n{a=[97], b=[98], c=[99]}\n[a, b]\n[-, b, c, -]\n[c, a, c, null, [a, b, c]]\n[a, c]\n[97, 98, 99]\nprefix-ac\n99\nnull\n(1, bc)\n(2, c)\na\nc\n[z, a, b, c]\n3\ntrue\n',
  },
  {
    name: 'library accessors permit Kotlin overrides without descriptor collisions',
    source: String.raw`class Valid : Exception() {
    override val message: String get() = "custom"
}
class Text(private val backing: CharSequence) : CharSequence by backing {
    override val length: Int get() = backing.length
}
fun main() { println(Valid().message); println(Text("abc").length) }`,
    stdout: 'custom\n3\n',
  },
  {
    name: 'ArrayList removeIf preserves JVM callback null checks',
    source: String.raw`fun main() {
    val a = mutableListOf(1, 2, 3)
    try {
        a.removeIf { if (it == 1) a.clear(); false }
    } catch (error: NullPointerException) {
        println("null check")
    }
    println(a)
    val nullable = mutableListOf<Int?>(1, 2, 3)
    try {
        nullable.removeIf { println(it); if (it == 1) nullable.clear(); false }
    } catch (error: Exception) {
        println(error)
    }
}`,
    stdout: 'null check\n[]\n1\nnull\nnull\njava.util.ConcurrentModificationException\n',
  },
  {
    name: 'generated interface bridges initialize their interface companions',
    source: String.raw`interface Named : Comparable<String> {
    override fun compareTo(other: String): Int
    companion object { init { println("comparison interface") } }
}
interface Base {
    val token: Any
}
interface Derived : Base {
    override val token: String
    companion object { init { println("property interface") } }
}
class Item : Named, Derived {
    override fun compareTo(other: String): Int = 0
    override val token: String = "item"
}
fun main() { println("start"); Item() }`,
    stdout: 'start\ncomparison interface\nproperty interface\n',
  },
  {
    name: 'ArrayList growth gives a running sort the previous element buffer',
    source: String.raw`fun sortAndGrow(list: MutableList<Int>, changeAt: Int) {
    var comparisons = 0
    try {
        list.sortWith(Comparator { a, b ->
            comparisons++
            if (comparisons == changeAt) list.add(4)
            a.compareTo(b)
        })
    } catch (error: ConcurrentModificationException) {
        println(list)
    }
}
fun main() {
    sortAndGrow(mutableListOf(3, 1, 2), 1)
    sortAndGrow(mutableListOf(3, 1, 2), 3)
    val roomy = ArrayList<Int>(10)
    roomy.addAll(listOf(3, 1, 2))
    sortAndGrow(roomy, 1)
    val empty = mutableListOf<Int>()
    empty.addAll(listOf(3, 1, 2))
    sortAndGrow(empty, 1)
}`,
    stdout: '[3, 1, 2, 4]\n[1, 3, 2, 4]\n[1, 2, 3, 4]\n[1, 2, 3, 4]\n',
  },
  {
    name: 'malformed JVM format specifiers fail before formatting any arguments',
    source: String.raw`class Noisy {
    override fun toString(): String {
        println("unexpected side effect")
        return "noise"
    }
}
fun main() {
    for (pattern in listOf("%.d", "%5", "%1$", "%08,3d", "%!", "%- ", "%", "%Q %5")) {
        try { println(pattern.format(1)) } catch (error: Exception) { println(error.message) }
    }
    try { println("%s %5".format(Noisy())) } catch (error: Exception) { println(error.message) }
}`,
    stdout:
      "Conversion = '.'\nConversion = '5'\nConversion = '1'\nConversion = '0'\nConversion = '!'\nConversion = '-'\nConversion = '%'\nConversion = 'Q'\nConversion = '5'\n",
  },
  {
    name: 'a data class equality overload preserves structural equals',
    source: String.raw`data class Point(val x: Int) {
    fun equals(other: Int): Boolean = x == other
}
data class Custom(val x: Int) {
    override fun equals(other: Any?): Boolean = false
    override fun hashCode(): Int = 0
}
fun main() {
    val a = Point(1)
    val b = Point(1)
    println(a == b)
    println(a.equals(1))
    println(setOf(a).contains(b))
    println(Custom(1) == Custom(1))
}`,
    stdout: 'true\ntrue\ntrue\nfalse\n',
  },
  {
    name: 'escaped infix names resolve like ordinary escaped calls',
    source: 'infix fun Int.`is`(n: Int) = this == n\nfun main() { println(1 `is` 1); println(1.`is`(1)) }',
    stdout: 'true\ntrue\n',
  },
  {
    name: 'mutable maps retain the same live views across reads and writes',
    source: `fun main() {
    val map = mutableMapOf("a" to 1)
    val values = map.values
    val views = hashSetOf(values)
    println(map.values in views)
    println(map.values === values)
    println(map.keys === map.keys)
    println(map.entries === map.entries)
    map["b"] = 2
    println(values)
}`,
    stdout: 'true\ntrue\ntrue\ntrue\n[1, 2]\n',
  },
  {
    name: 'a delegated local var shares its delegate across lambda calls',
    source: `import kotlin.properties.Delegates
fun main() {
    var score: Int by Delegates.notNull()
    score = 5
    val up = { score += 2; score }
    println(up())
    println(score)
}`,
    stdout: '7\n7\n',
  },
  {
    name: 'failed JVM class initialization cannot expose an object or enum entry',
    source: `object Broken { init { println("object"); error("object failure") }; val value = 7 }
enum class BrokenEnum {
    One;
    init { println("enum"); error("enum failure") }
    companion object { val value = 9 }
}
fun probe(action: () -> Unit) {
    try { action() } catch (e: Throwable) {
        println(e)
        println(e.cause)
    }
}
fun main() {
    probe { println(Broken.value) }
    probe { println(Broken.value) }
    probe { println(BrokenEnum.value) }
    probe { println(BrokenEnum.One) }
}`,
    stdout:
      'object\njava.lang.ExceptionInInitializerError\njava.lang.IllegalStateException: object failure\n' +
      'java.lang.NoClassDefFoundError: Could not initialize class Broken\n' +
      'java.lang.ExceptionInInitializerError: Exception java.lang.IllegalStateException: object failure [in thread "main"]\n' +
      'enum\njava.lang.ExceptionInInitializerError\njava.lang.IllegalStateException: enum failure\n' +
      'java.lang.NoClassDefFoundError: Could not initialize class BrokenEnum\n' +
      'java.lang.ExceptionInInitializerError: Exception java.lang.IllegalStateException: enum failure [in thread "main"]\n',
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
            try { this.n = if (seed > 0) seed + 1 else seed - 1 }
            finally { break }
        }
    }
}
class SuppressedException {
    val first: Int
    val n: Int
    init {
        while (true) {
            try {
                first = fail()
                n = when (first) {
                    0 -> fail()
                    else -> 4
                }
            }
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
    val suppressed = SuppressedException()
    println(suppressed.first)
    println(suppressed.n)
    found(false)
}`,
    stdout: '1\n2\n3\n0\n0\n0\n',
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
    val indexed = letters.withIndex()
    val groups = letters.groupingBy { it }
    letters.append("aba")
    println(iterable.toList())
    println(groups.eachCount())
    letters[0] = 'c'
    println(groups.eachCount())
    println(indexed.toList())

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
    stdout:
      '[a, b, a]\n{a=2, b=1}\n{c=1, b=1, a=1}\n[IndexedValue(index=0, value=c), IndexedValue(index=1, value=b), IndexedValue(index=2, value=a)]\n0\n{1=2, 2=1}\n{3=1, 1=1, 2=1}\n6\n',
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
  ['a float array searched by equality', false, 'fun main() { println(floatArrayOf(1.0f).indexOf(1.0f)) }'],
  ['an error-deprecated char conversion', false, "fun main() { println('a'.toUpperCase()) }"],
  ['an error-deprecated Double conversion', false, 'fun main() { println(3.5.toShort()) }'],
  ['an error-deprecated Float conversion', false, 'fun main() { println(3.5f.toByte()) }'],
  ['a double array tested for element membership', false, 'fun main() { println(1.0 in doubleArrayOf(1.0)) }'],
  [
    'when comparing a string subject with a character',
    false,
    'fun main() { val grade = "A"; when (grade) { \'A\' -> println(1); else -> println(2) } }',
  ],
  [
    'when comparing an enum subject with a string',
    false,
    'enum class E { A }; fun main() { when (E.A) { "A" -> println(1); else -> println(2) } }',
  ],
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
    'an outer local val assignment whose RHS already writes the val',
    false,
    'fun main() { val x: Int; x = if (true) { x = 1; 2 } else 3; println(x) }',
  ],
  [
    'an outer property assignment whose RHS already writes the val',
    false,
    'class A { val n: Int; init { n = if (true) { n = 1; 2 } else 3 } }; fun main() { println(A().n) }',
  ],
  [
    'a finally block reading a field only assigned inside try',
    false,
    `class A {
    val n: Int
    init {
        while (true) {
            try { n = 3 }
            finally { println(n); break }
        }
    }
}
fun main() { println(A().n) }`,
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
  [
    'a positional argument after an out-of-order named argument',
    false,
    'fun point(x: Int, y: Int) {}\nfun main() { point(y = 2, 1) }',
  ],
  [
    'a return from a crossinline comparator selector',
    false,
    'fun main() { listOf(3, 1).sortedBy { if (it == 3) return; it } }',
  ],
  [
    'a break from a crossinline comparator selector',
    false,
    'fun main() { while (true) { listOf(3, 1).sortedBy { if (it == 3) break; it } } }',
  ],
  [
    'a function default reading its own unassigned parameter',
    false,
    'fun invalid(x: Int = x + 1) = x\nfun main() { println(invalid()) }',
  ],
  [
    'a constructor default reading its own unassigned parameter',
    false,
    'class Invalid(val text: String = text)\nfun main() { println(Invalid().text) }',
  ],
  [
    'a constructor default reading a later unassigned parameter',
    false,
    'class Invalid(val a: Int = b, val b: Int = 1)\nfun main() { println(Invalid().a) }',
  ],
  [
    'a smart cast in a closure before a later write to its captured variable',
    false,
    'fun main() { var value: Any = "a"; val read = { if (value is String) value.length else 0 }; value = 1; println(read()) }',
  ],
  [
    'a smart cast in a closure before a sibling closure captures and writes the variable',
    false,
    'fun main() { var value: Any = "a"; val read = { if (value is String) value.length else 0 }; val set = { value = 1 }; println(read()) }',
  ],
  [
    'conflicting delegated members without an explicit override',
    false,
    'interface A { fun f(): String }; interface B { fun f(): String }; class C(a: A, b: B) : A by a, B by b; fun main() {}',
  ],
  [
    'a null check of a captured variable that a closure may set to null',
    false,
    'fun main() { var value: Int? = 1; val reset = { value = null }; if (value != null) println(value + 1); reset() }',
  ],
  [
    'a forward read in a direct top-level initializer',
    false,
    'val a: Int = b + 1\nval b = 3\nfun main() { println(a) }',
  ],
  [
    'a forward read in an inline top-level initializer',
    false,
    'val a = run { b }; val b = 3; fun main() { println(a) }',
  ],
  ['an invalid JVM main array element type', false, 'fun main(args: Array<Int>) { println(args.size) }'],
  ['an invalid JVM main return type', false, 'fun main() = 1'],
  [
    'a writable local property using a read-only delegate',
    false,
    'fun main() { var number: Int by lazy { 1 }; println(number) }',
  ],
  [
    'overloads with the same JVM signature after erasure',
    false,
    'fun total(values: List<Int>): Int = values.sum()\nfun total(values: List<String>): Int = values.size\nfun main() { println(total(listOf(1, 2))) }',
  ],
  [
    'a method with the JVM signature of a generated getter',
    false,
    'class Score(val value: Int) { fun getValue(): Int = value + 1 }; fun main() { println(Score(3).getValue()) }',
  ],
  ['an unnamed loop variable', false, 'fun main() { for (_ in 1..3) println("x") }'],
  ['an escaped underscore loop variable', true, 'fun main() { for (`_` in 1..3) println(`_`) }'],
  [
    'an uninitialized delegate read from a class initializer',
    false,
    'class A {\n    val first = second\n    val second by lazy { 4 }\n}\nfun main() { println(A().first) }',
  ],
  [
    'a smart cast invalidated by an inline write in a capturing lambda',
    false,
    'fun main() { var x: Any = "s"; val f = { run { x = 1 }; if (x is String) x.length else 0 }; println(f()) }',
  ],
  [
    'a declaration with the signature of an inherited getter',
    false,
    'open class Base(val value: Int)\nclass Child : Base(3) {\n    fun getValue(): Int = 7\n}\nfun main() { println(Child().getValue()) }',
  ],
  [
    'inherited methods with conflicting erased signatures',
    false,
    'interface X { fun get(values: List<Int>): Int }; interface Y { fun get(values: List<String>): Int }; abstract class Mixed : X, Y; fun main() {}',
  ],
  ['calling toTypedArray on an object array', false, 'fun main() { println(arrayOf(1, 2).toTypedArray()) }'],
  ['duplicate nested classes', false, 'class A { class B; class B }; fun main() { println(A.B()) }'],
  [
    'a nested class with the name of the companion',
    false,
    'class A { companion object; class Companion }; fun main() {}',
  ],
  [
    'a method that clashes with an inherited Throwable accessor',
    false,
    'class Problem : Exception() { fun getMessage(): String = "custom" }\nfun main() { println(Problem().getMessage()) }',
  ],
  [
    'a method that clashes with a delegated CharSequence accessor',
    false,
    'class Letters : CharSequence by "abc" { fun getLength(): Int = 7 }\nfun main() { println(Letters().getLength()) }',
  ],
  ['a zero-argument main returning Unit?', false, 'fun main(): Unit? = println("executed")'],
  ['an array-argument main returning Unit?', false, 'fun main(args: Array<String>): Unit? = println(args.size)'],
  [
    'a missing return after a safe assignment with a terminal RHS',
    false,
    'class Box { var value = 0 }\nclass Stop { val never: Nothing get() = error("never") }\nfun compute(b: Box?, s: Stop): Int { b?.value = s.never }\nfun main() { println(compute(null, Stop())) }',
  ],
  [
    'complementary type tests without null coverage in a nullable sealed when',
    false,
    'sealed interface Shape\ninterface Tagged\nopen class Group:Shape\nclass Marked:Shape,Tagged\nfun choose(s:Shape?):Int=when(s){is Tagged->1;!is Tagged->2}\nfun main() { println(choose(null)) }',
  ],
  ['a class with conflicting visibility modifiers', false, 'private public class A\nfun main() {}'],
  ['a function with conflicting visibility modifiers', false, 'internal private fun f() = 1; fun main() {}'],
  ['a Nothing-returning function that falls through', false, 'fun bad(): Nothing { println("bad") }; fun main() {}'],
  ['a Nothing-returning function that always throws', true, 'fun abort(): Nothing { error("done") }; fun main() {}'],
  [
    'a nullable is test does not prove the subject nonnull',
    false,
    'fun size(value: Any?) { if (value is String?) println(value.length) }; fun main() {}',
  ],
  [
    'a nullable negated is test does not prove the subject nonnull',
    false,
    'fun size(value: Any?) { if (value !is String?) return; println(value.length) }; fun main() {}',
  ],
  [
    'a private nested type reached by its package',
    false,
    'package demo\nclass Outer { private class Hidden }; fun main() { val value: demo.Outer.Hidden? = null }',
  ],
  [
    'a private nested type used outside its owner after import',
    false,
    'package demo\nimport demo.Outer.Hidden\nclass Outer { private class Hidden }; fun main() { Hidden() }',
  ],
  [
    'a private superclass property read through super',
    false,
    'open class Parent { private val x = 1 }; class Child : Parent() { fun peek() = super.x }; fun main() {}',
  ],
  [
    'a private object member through its qualifier',
    false,
    'object Vault { private val secret = 7 }; fun main() { println(Vault.secret) }',
  ],
  [
    'a private companion member through its qualifier',
    false,
    'class Vault { companion object { private val secret = 7 } }; fun main() { println(Vault.secret) }',
  ],
  [
    'a private companion property from its enclosing class',
    true,
    'class Vault { companion object { private val secret = 7 }; fun reveal() = Vault.secret }; fun main() { println(Vault().reveal()) }',
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
    'a Java method mapped to a mutable Kotlin collection',
    'fun main() { mutableMapOf("a" to 1).putIfAbsent("b", 2) }',
    'MutableMap<String, Int> の putIfAbsentは、この採点環境では使えません。',
  ],
  [
    'a Java method inherited by read-only Kotlin collections',
    'fun main() { listOf(1).stream() }',
    'List<Int> の streamは、この採点環境では使えません。',
  ],
  [
    'an instance method of a Java-backed Kotlin type alias',
    'fun main() { StringBuilder("abc").capacity() }',
    'StringBuilder の capacityは、この採点環境では使えません。',
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
    'a Java class through a wildcard import',
    'import java.util.*\nfun main() { println(LinkedList<Int>()) }',
    'Java のクラスの直接の利用（java.util.LinkedList）は、この採点環境では使えません。',
  ],
  [
    'a Java wildcard import before the implicit Kotlin class',
    'import java.util.*\nfun main() { println(ArrayDeque<Int>()) }',
    'Java のクラスの直接の利用（java.util.ArrayDeque）は、この採点環境では使えません。',
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
  ['fun main() { "abc".getBytes() }', 'String には getBytes がありません。'],
  ['fun main() { mapOf("a" to 1).putIfAbsent("b", 2) }', 'Map<String, Int> には putIfAbsent がありません。'],
])('reports a missing member for %s', (program, message) => {
  expect(executeProgram('kotlin', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message }],
  });
});
