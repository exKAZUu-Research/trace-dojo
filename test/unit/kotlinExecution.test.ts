import { expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['list', 'val items = mutableListOf<Ranked>()\n    for (i in 0 until 40) items.add(ranked(i))'],
  ['array', 'val items = Array(40) { ranked(it) }'],
])('keeps turtles in the sort buffer of a Kotlin %s', (_kind, initialization) => {
  const source = `class Ranked(val rank: Int, val turtle: Turtle)
fun ranked(i: Int): Ranked = Ranked((i * 17) % 40, Turtle(i % 7, i / 7))
fun main() {
    ${initialization}
    items.sortWith(Comparator { a, b ->
        a.turtle.canMoveForward()
        a.rank.compareTo(b.rank)
    })
    println(items.size)
}`;
  const result = executeProgram('kotlin', source);
  expect(result).toMatchObject({ kind: 'executed', stdout: '40\n' });
  expect('finalTurtles' in result && result.finalTurtles).toHaveLength(40);
});

test.each(['ArrayList(source)', 'source.toTypedArray()'])(
  'keeps prior turtles during native copying with %s',
  (copy) => {
    const source = `class SpawnIterator : Iterator<Turtle> {
    var count = 0
    override fun hasNext(): Boolean = count < 3
    override fun next(): Turtle {
        val turtle = Turtle(count++, 0)
        turtle.canMoveForward()
        return turtle
    }
}
class Spawn : Collection<Turtle> by emptyList<Turtle>() {
    override val size: Int get() = 3
    override fun iterator(): Iterator<Turtle> = SpawnIterator()
}
fun main() {
    val source = Spawn()
    val turtles = ${copy}
    println(turtles.size)
}`;
    const result = executeProgram('kotlin', source);
    expect(result).toMatchObject({ kind: 'executed', stdout: '3\n' });
    expect('finalTurtles' in result && result.finalTurtles.map(({ x }) => x)).toEqual([0, 1, 2]);
  }
);

test.each(['contains', 'split'])('charges the execution budget during CharSequence %s', (operation) => {
  const source = `fun main() {
    val s: CharSequence = StringBuilder("a".repeat(100000))
    val delimiter = "a".repeat(1024) + "b"
    println(s.${operation}(delimiter))
}`;
  // A frozen clock keeps a slow host from stopping the run by time before the operation charge does.
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    expect(executeProgram('kotlin', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    now.mockRestore();
  }
});

test('keeps temporary Kotlin assignment receivers on the board during operand evaluation', () => {
  const source = `class Holder {
    val turtle = Turtle(1, 0)
    var number = 0
        set(value) {
            field = value
            atNeighbor()
        }
}

fun atNeighbor(): Int {
    val t = Turtle(0, 0, "R")
    t.turnRight()
    println(t.canMoveForward())
    return 0
}

fun replacement(): Turtle {
    atNeighbor()
    return Turtle(2, 0)
}

fun main() {
    arrayOf(Turtle(1, 0))[atNeighbor()] = Turtle(2, 0)
    arrayOf(Turtle(1, 0))[0] = replacement()
    Holder().number += atNeighbor()
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\nfalse\nfalse\n',
  });
});

test.each(['==', '==='])('keeps both Kotlin %s operands reachable while evaluating equality', (operator) => {
  const source = `fun rhs(): Turtle {
    val probe = Turtle(0, 0)
    println(probe.canMoveForward())
    return probe
}
fun main() { println(Turtle(0, 1) ${operator} rhs()) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: 'false\nfalse\n' });
});

test('keeps Kotlin try completions reachable while finally runs', () => {
  const source = `class Stop(val turtle: Turtle) : RuntimeException()

fun checkNeighbor() {
    val probe = Turtle(0, 0)
    println(probe.canMoveForward())
}

fun returned(): Turtle {
    try { return Turtle(0, 1) }
    finally { checkNeighbor() }
}

fun caught(): Turtle = try { throw Stop(Turtle(0, 1)) }
catch (e: Stop) { e.turtle }
finally { checkNeighbor() }

fun thrown() {
    try {
        try { throw Stop(Turtle(0, 1)) }
        finally { checkNeighbor() }
    } catch (e: Stop) {
        println(e.turtle.canMoveForward())
    }
}

fun main() {
    returned().turnRight()
    caught().turnRight()
    thrown()
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\nfalse\ntrue\n',
  });
});

test('reads Kotlin progression endpoints within the execution budget', () => {
  const source = `fun main() {
    val ascending = 1L..1000000L
    val descending = 2000000L downTo 0L step 3L
    val chars = 'z' downTo 'a' step 4
    println(ascending.lastOrNull())
    println(descending.lastOrNull())
    println(chars.firstOrNull())
    println(chars.lastOrNull())
    println((4L..1L).firstOrNull())
    println(('z'..'a').lastOrNull())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '1000000\n2\nz\nb\nnull\nnull\n',
  });
});

test.each(['Token.values()', 'enumValues<Token>()'])('charges repeated %s array copies to the Kotlin heap', (call) => {
  const names = Array.from({ length: 200 }, (_, index) => `TOKEN${index}`).join(', ');
  const source = `enum class Token { ${names} }
fun main() {
    val kept = mutableListOf<Any>()
    repeat(6000) { kept.add(${call}) }
    println(kept.size)
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'java.lang.OutOfMemoryError: Java heap space',
  });
});

/** Programs with the output of Kotlin 2.4.21 on the JVM (Java 25), which the interpreter must reproduce exactly. */
test.each([
  {
    name: 'values assigned on every normal try or catch path remain initialized after finally',
    source: `fun read(trigger: Boolean): String {
    var text: String
    try {
        text = if (trigger) error("throw") else "body"
    } catch (e: IllegalStateException) {
        text = "handler"
    } finally {
        println("finally")
    }
    return text
}
fun bothBranches(test: Boolean): Int {
    if (test) return 1 else return 2
}
fun main() {
    println(read(false))
    println(read(true))
    println(bothBranches(true))
}`,
    stdout: `finally
body
finally
handler
1
`,
  },
  {
    name: 'uppercase format conversions use lowercase error letters and uppercase output',
    source: `fun main() {
    try { println(String.format("%X", 1.5)) } catch (e: Exception) { println(e.message) }
    try { println("%E".format(5)) } catch (e: Exception) { println(e.message) }
    try { println("%C".format("text")) } catch (e: Exception) { println(e.message) }
    println("%X".format(255))
}`,
    stdout: `x != java.lang.Double
e != java.lang.Integer
c != java.lang.String
FF
`,
  },
  {
    name: 'empty built lists reuse a singleton and close the original builder',
    source: `fun main() {
    val first = buildList<Int> {}
    val second = buildList<Int> {}
    println(first === second)
    var leaked: MutableList<Int>? = null
    val cleared = buildList<Int> {
        leaked = this
        add(1)
        clear()
    }
    println(first === cleared)
    println(first === emptyList<Int>())
    println(cleared === leaked)
    try {
        leaked!!.add(2)
    } catch (e: UnsupportedOperationException) {
        println("original closed")
    }
}`,
    stdout: `true
true
false
false
original closed
`,
  },
  {
    name: 'map builder equality reads the other map’s entries without calling get',
    source: `class ObservedMap : Map<Int, String> by mapOf(1 to "one", 2 to "two") {
    override fun get(key: Int): String? {
        error("get should not be called for key $key")
    }
    override val entries: Set<Map.Entry<Int, String>>
        get() { println("entries"); return mapOf(1 to "one", 2 to "two").entries }
}
fun main() {
    val built = buildMap<Int, String> { put(1, "one"); put(2, "two") }
    println(built == ObservedMap())
    println(buildMap<Int, String> { put(1, "one"); put(2, "two") } == ObservedMap())
}`,
    stdout: `entries
true
entries
true
`,
  },
  {
    name: 'map builders remove the last matching value using the stored value’s equality',
    source: `class Match(val id: Int) {
    override fun equals(other: Any?): Boolean {
        println("compare $id")
        return other is Match && other.id == 0
    }
    override fun hashCode(): Int = id
    override fun toString(): String = "Match($id)"
}

fun main() {
    val builder = buildMap {
        put(1, "same")
        put(2, "same")
        values.remove("same")
    }
    println(builder)
    val ordinary = mutableMapOf(1 to "same", 2 to "same")
    ordinary.values.remove("same")
    println(ordinary)
    println(buildMap {
        put(1, Match(1))
        put(2, Match(2))
        values.remove(Match(0))
    })
}`,
    stdout: `{1=same}
{2=same}
compare 2
{1=Match(1)}
`,
  },
  {
    name: 'floating point neighbors use the precision of each imported overload',
    source: `import kotlin.math.nextUp
import kotlin.math.nextDown

fun main() {
    println(1.0f.nextUp())
    println(1.0f.nextDown())
    println(1.0.nextUp())
    println(1.0.nextDown())
    println((-0.0f).nextUp())
    println(0.0f.nextDown())
    println((-Float.MIN_VALUE).nextUp())
    println(Float.MIN_VALUE.nextDown())
    println(Float.POSITIVE_INFINITY.nextDown())
    println(Double.NEGATIVE_INFINITY.nextUp())
    println(Float.POSITIVE_INFINITY.nextUp())
    println(Double.NaN.nextDown())
}`,
    stdout: `1.0000001
0.99999994
1.0000000000000002
0.9999999999999999
1.4E-45
-1.4E-45
-0.0
0.0
3.4028235E38
-1.7976931348623157E308
Infinity
NaN
`,
  },
  {
    name: 'map and set builder growth rehashes in insertion order and invalidates old cursors',
    source: `class Key(val n: Int, val failAt: Int = 0) {
    var calls = 0
    override fun hashCode(): Int {
        calls++
        println("hash $n")
        if (calls == failAt) error("rehash $n")
        return n
    }
    override fun equals(other: Any?): Boolean = other is Key && n == other.n
    override fun toString(): String = n.toString()
}

fun main() {
    println(buildMap<Key, Int>(1) {
        put(Key(1), 1)
        val entry = entries.first()
        put(Key(2), 2)
        try {
            println(entry.key)
        } catch (e: ConcurrentModificationException) {
            println(e.message)
        }
    })
    println(buildSet<Key>(1) { add(Key(1)); add(Key(2)) })

    println(buildMap<Key, Int>(1) {
        put(Key(3), 3)
        val extra = mapOf(Key(4) to 4, Key(5) to 5)
        putAll(extra)
    })

    println(buildSet<Key>(1) {
        add(Key(6, 2))
        val cursor = iterator()
        try {
            add(Key(7))
        } catch (e: IllegalStateException) {
            println(e.message)
        }
        try {
            cursor.next()
        } catch (e: ConcurrentModificationException) {
            println("iterator invalidated")
        }
        println(size)
    })
}`,
    stdout: `hash 1
hash 2
hash 1
hash 2
The backing map has been modified after this entry was obtained.
{1=1, 2=2}
hash 1
hash 2
hash 1
hash 2
[1, 2]
hash 3
hash 4
hash 5
hash 3
hash 4
hash 5
{3=3, 4=4, 5=5}
hash 6
hash 7
hash 6
rehash 6
iterator invalidated
1
[6]
`,
  },
  {
    name: 'two-argument map forEach checks structural changes after live traversal',
    source: `fun main() {
    for (map in listOf(hashMapOf(1 to "a", 2 to "b"), linkedMapOf(1 to "a", 2 to "b"))) {
        try {
            map.forEach { key, value ->
                println("$key=$value")
                if (key == 1) map[3] = "c"
            }
        } catch (e: ConcurrentModificationException) {
            println("modified")
        }
    }
    mapOf(7 to "one").forEach { key, value -> println("$key=$value") }
}`,
    stdout: '1=a\n2=b\n3=c\nmodified\n1=a\n2=b\n3=c\nmodified\n7=one\n',
  },
  {
    name: 'set intersection and subtraction preserve membership for custom and large collections',
    source: `class Membership(private val values: Collection<Int>) : Collection<Int> by values {
    override fun contains(element: Int): Boolean { println("contains $element"); return element == 1 }
}
fun main() {
    val a = (0 until 1000).toList()
    val b = (1000 until 2000).toSet()
    println((a intersect b).size)
    println((a subtract b).size)
    val receiver = listOf(1, 2, 3)
    val membership = Membership(listOf(2, 2, 2))
    println(receiver intersect membership)
    println(receiver subtract membership)
    println(receiver subtract Membership(listOf(2)))
}`,
    stdout:
      '0\n1000\ncontains 1\ncontains 2\ncontains 3\n[1]\ncontains 1\ncontains 2\ncontains 3\n[2, 3]\ncontains 1\ncontains 2\ncontains 3\n[2, 3]\n',
  },
  {
    name: 'collection bulk addition uses source sizes and iterators without indexed reads',
    source: `class Probe(private val items: List<Int>) : List<Int> by items {
    override val size: Int get() { println("size"); return items.size }
    override fun get(index: Int): Int { println("get $index"); return items[index] }
    override fun iterator(): Iterator<Int> { println("iterator"); return items.iterator() }
}
fun main() {
    println(listOf(1).flatMap { Probe(listOf(2)) })
    println(listOf(Probe(listOf(3))).flatten())
    println(mapOf(1 to 2).flatMap { Probe(listOf(4)) })
    println(listOf(1) + Probe(listOf(5)))
    println(listOf(1) union Probe(listOf(6)))
    println(listOf(1).flatMap { Probe(emptyList()) })
}`,
    stdout:
      'size\niterator\n[2]\nsize\niterator\n[3]\nsize\niterator\n[4]\nsize\nsize\niterator\n[1, 5]\niterator\n[1, 6]\nsize\n[]\n',
  },
  {
    name: 'builder copies validate backing ranges independently of toString padding',
    source: `class Source(val destination: StringBuilder) : CharSequence by "xy" {
    override fun get(index: Int): Char {
        if (index == 0) destination.append('λ')
        return "xy"[index]
    }
}
fun main() {
    for (capacity in listOf(2, 3, 16)) {
        val builder = StringBuilder(capacity).append("abc")
        builder.insert(1, Source(builder))
        println("capacity $capacity")
        println(builder.toString().map { it.code })
        try { println(builder.substring(0).map { it.code }) } catch(e: Exception) { println(e.toString()) }
        try { println(builder.subSequence(0, 5).toString().map { it.code }) } catch(e: Exception) { println(e.toString()) }
        try { println(StringBuilder().append(builder).toString().map { it.code }) } catch(e: Exception) { println(e.toString()) }
    }
}`,
    stdout:
      'capacity 2\n[30817, 25209, 99, 0, 0]\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 3\njava.lang.ArrayIndexOutOfBoundsException: arraycopy: last source index 10 out of bounds for byte[6]\ncapacity 3\n[30817, 25209, 99, 0, 0]\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\njava.lang.ArrayIndexOutOfBoundsException: arraycopy: last source index 10 out of bounds for byte[8]\ncapacity 16\n[30817, 25209, 99, 0, 0]\n[30817, 25209, 99, 0, 0]\n[30817, 25209, 99, 0, 0]\n[30817, 25209, 99, 0, 0]\n',
  },
  {
    name: 'map copies retain the entries inserted before a later getter fails',
    source: `class SuppliedEntry(val number: Int, val mode: Int) : Map.Entry<Int, Int> {
    override val key: Int get() {
        if (number == 2 && mode == 0) error("key")
        return number
    }
    override val value: Int get() {
        if (number == 2 && mode == 1) error("value")
        return number
    }
}
class Source(val mode: Int) : Map<Int, Int> by mapOf(1 to 1, 2 to 2) {
    override val entries: Set<Map.Entry<Int, Int>> get() = setOf(SuppliedEntry(1,mode),SuppliedEntry(2,mode))
}
fun main() {
    for(mode in 0..1) {
        val destination = linkedMapOf<Int, Int>()
        try { destination.putAll(Source(mode)) } catch(e: IllegalStateException) { println(e.message) }
        println(destination)
    }
}`,
    stdout: 'key\n{1=1}\nvalue\n{1=1}\n',
  },
  {
    name: 'map entry equality reads the value after a custom key getter',
    source: `class Candidate(private val change: () -> Unit) : Map.Entry<Int, Int> {
    override val key: Int get() { change(); return 1 }
    override val value: Int get() = 2
}
fun main() {
    for (map in listOf(hashMapOf(1 to 1), linkedMapOf(1 to 1))) {
        val entry = map.entries.first()
        println(entry == Candidate { map[1] = 2 })
        println(entry.value)
    }
}`,
    stdout: 'true\n2\ntrue\n2\n',
  },
  {
    name: 'inherited hash-map equality retains live entry advancement',
    source: `class Scores : HashMap<Int, Int>()
class OrderedScores : LinkedHashMap<Int, Int>()
class Other(val target: MutableMap<Int, Int>) : Map<Int, Int> by mapOf(1 to 1, 2 to 2) {
    override fun get(key: Int): Int? { if (key == 1) target.remove(2); return key }
}
fun main() {
    for (map in listOf<MutableMap<Int, Int>>(Scores(), OrderedScores(), HashMap<Int, Int>())) {
        map[1] = 1
        map[2] = 2
        try { println(map == Other(map)) } catch(e: Exception) { println(e.toString()) }
    }
}`,
    stdout:
      'java.util.ConcurrentModificationException\njava.util.ConcurrentModificationException\njava.util.ConcurrentModificationException\n',
  },
  {
    name: 'generic result inference projects mutable siblings and range supertypes',
    source: `fun main() {
    val ready = 3 > 2
    val names = mutableListOf("a", "b")
    val tags = mutableSetOf(1)
    val scores = mutableMapOf("a" to 1)
    val a = if (ready) emptyList() else names
    val b = if (ready) names else emptyList()
    val c = if (ready) emptySet() else tags
    val d = if (ready) emptyMap() else scores
    val e = when { ready -> emptyList(); else -> arrayListOf("x") }
    val f = if (ready) emptyList() else setOf(1)
    val g = try { emptyList() } catch (e: Exception) { names }
    val h = if (ready) emptyList() else 1..3
    println(a); println(b); println(c); println(d); println(e); println(f); println(g); println(h)
    println(if (ready) emptyList() else names)
    println(listOf(emptyList(), names))
}`,
    stdout: '[]\n[a, b]\n[]\n{}\n[]\n[]\n[]\n[]\n[]\n[[], [a, b]]\n',
  },
  {
    name: 'branch and argument result types infer from later or earlier siblings',
    source: `fun main() {
    val show = false
    val items = listOf(1, 2, 3)
    val fromIf = if (show) emptyList() else items
    val fromWhen = when (items.size) {
        1 -> mutableListOf()
        else -> mutableListOf("a")
    }
    val fromTry = try {
        if (!show) throw IllegalStateException()
        emptyList()
    } catch (error: IllegalStateException) {
        listOf(error.message ?: "caught")
    }
    println(fromIf.sum())
    println(fromWhen.first().length)
    println(fromTry)
    println(items.map { if (it == 1) emptyList() else listOf(it) })
    println(listOf(emptyList(), listOf("a")))
    val subject: Any = "smart"
    val fromGuard = when (subject) {
        is Int -> emptyList()
        is String -> listOf(subject.length)
        else -> emptyList()
    }
    println(fromGuard)
    val bothTypes = when (items.size) {
        1 -> emptyList()
        2 -> listOf(1)
        else -> listOf("a")
    }
    println(bothTypes)
}`,
    stdout: '6\n1\n[caught]\n[[], [2], [3]]\n[[], [a]]\n[5]\n[a]\n',
  },
  {
    name: 'extension resolution checks property specificity, arguments, and local function values',
    source: `val Any.label: String get() = "any"
val String.label: String get() = "string"
val Any.applyLocal: (Int) -> String get() = { "any $it" }
val String.applyLocal: (String) -> String get() = { "string $it" }
val arbitrary: String.(Int) -> String = { "top $it" }
fun String.take(): String = this
fun String.repeat(text: String): String = "$this$text"
class Member { fun repeat(n: Int): String = "member $n" }
fun main() {
    println("hello".label)
    println("hello".applyLocal(4))
    println("hello".applyLocal("a"))
    println("a".repeat(2))
    println("abc".take(2))
    println("a".repeat("b"))
    println("hello".take())
    println("a".arbitrary(3))
    val take: String.(Int) -> String = { "local $it" }
    val repeat: String.(Boolean) -> String = { "local $it" }
    println("abc".take(2))
    println("a".repeat(true))
    println("a".repeat(2))
    run {
        val repeat: Member.(Int) -> String = { "callback $it" }
        println(Member().repeat(5))
    }
    val arbitrary: Member.(Int) -> String = { "wrong receiver $it" }
    println("a".arbitrary(3))
}`,
    stdout: 'string\nany 4\nstring a\naa\nab\nab\nhello\ntop 3\nlocal 2\nlocal true\naa\nmember 5\ntop 3\n',
  },
  {
    name: 'seeded sampling handles inclusive endpoints and checks custom collections once',
    source: `import kotlin.random.Random
import kotlin.random.nextLong
class Once(private val values: Collection<Int>) : Collection<Int> by values {
    var checks = 0
    override fun isEmpty(): Boolean {
        if (++checks > 1) error("second emptiness check")
        println("check")
        return values.isEmpty()
    }
}
fun main() {
    val seeded = Random(1)
    println(seeded.nextLong(1L..1L))
    try { seeded.nextLong(5L..4L) } catch (e: IllegalArgumentException) { println(e.message) }
    println(seeded.nextLong(Long.MAX_VALUE..Long.MAX_VALUE))
    println(seeded.nextLong(Long.MIN_VALUE..Long.MAX_VALUE))
    println(Once(listOf(7)).randomOrNull())
    println(Once(listOf(8)).randomOrNull(Random(9)))
    println(Once(emptySet()).randomOrNull(Random(9)))
    println((1..1).randomOrNull())
    println((5L..4L).randomOrNull(seeded))
    println(('a'..'a').randomOrNull(seeded))
    println((Int.MAX_VALUE..Int.MAX_VALUE).randomOrNull(seeded))
}`,
    stdout:
      '1\nCannot get random in empty range: 5..4\n9223372036854775807\n-2264386607786871955\ncheck\n7\ncheck\n8\ncheck\nnull\n1\nnull\na\n2147483647\n',
  },
  {
    name: 'comparable extrema accept any number of operands',
    source: `fun main() {
    println(maxOf("b", "a", "d", "c"))
    println(minOf("b", "a", "d", "c"))
    println(maxOf("alone"))
}`,
    stdout: 'd\na\nalone\n',
  },
  {
    name: 'comparisons invoke user code for identical operands and reject empty selector lists',
    source: `class Score : Comparable<Score> {
    override fun compareTo(other: Score): Int {
        println("compare")
        return 0
    }
}
fun main() {
    val score = Score()
    println(compareValues(score, score))
    println(compareBy<Score> { it }.compare(score, score))
    try { compareValuesBy(1, 2) } catch (e: IllegalArgumentException) { println(e.message) }
}`,
    stdout: 'compare\n0\ncompare\n0\nFailed requirement.\n',
  },
  {
    name: 'nullable extension setters receive null on direct and compound writes',
    source: `var String?.count: Int
    get() = if (this == null) 0 else length
    set(value) { println(if (this == null) "null $value" else "$this $value") }
fun main() {
    val text: String? = null
    text.count = 2
    text.count += 1
    text?.count = 9
}`,
    stdout: 'null 2\nnull 1\n',
  },
  {
    name: 'primitive extension property writes share the receiver representation of reads',
    source: `var Int.score: Int
    get() { println("int get $this"); return this }
    set(value) { println("int set \${this + value}") }
var Long.score: Long
    get() { println("long get $this"); return this }
    set(value) { println("long set \${this + value}") }
fun main() {
    2.score = 3
    2.score += 3
    println(2.score++)
    2L.score = 3L
    2L.score += 3L
    println(2L.score++)
}`,
    stdout:
      'int set 5\nint get 2\nint set 7\nint get 2\nint set 5\n2\nlong set 5\nlong get 2\nlong set 7\nlong get 2\nlong set 5\n2\n',
  },
  {
    name: 'setter bodies can shadow their input parameters',
    source: `class Box {
    var first: Int = 0
        set(value) {
            val value = value.coerceAtLeast(0)
            field = value
        }
    var second: Int = 0
        set(newValue: Int) {
            val newValue = newValue.coerceAtLeast(0)
            field = newValue
        }
}
fun main() {
    val box = Box()
    box.first = -2
    box.second = 3
    println(box.first)
    println(box.second)
}`,
    stdout: '0\n3\n',
  },
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
    stdout: 'i\nSs\nFf\nǲ\ncba!\n30\n30\n0\nmarginPrefix must be non-blank string.\n',
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
    name: 'Duration scaling with fractional, integral, and non-finite Doubles',
    source: `import kotlin.time.*
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.nanoseconds
import kotlin.time.Duration.Companion.seconds
fun main() {
    println(2.seconds * 2.5)
    println(2.seconds / 2.5)
    println(2.5 * 2.seconds)
    println(3 * 2.seconds)
    println(1.nanoseconds * 0.5)
    println((-1).nanoseconds * 0.5)
    println(3.nanoseconds / 2.0)
    println(365000L.days * 0.5)
    println(365000L.days * Double.MAX_VALUE)
    println(1.seconds / -0.0)
    println(Duration.INFINITE / -2.5)
    try { println(Duration.ZERO * Double.POSITIVE_INFINITY) } catch (error: IllegalArgumentException) { println(error.message) }
    try { println(Duration.INFINITE / Double.POSITIVE_INFINITY) } catch (error: IllegalArgumentException) { println(error.message) }
    try { println(1.seconds * Double.NaN) } catch (error: IllegalArgumentException) { println(error.message) }
}`,
    stdout:
      '5s\n800ms\n5s\n6s\n1ns\n0s\n1ns\n182500d\nInfinity\n-Infinity\n-Infinity\nDuration value cannot be NaN.\nDuration value cannot be NaN.\nCannot round NaN value.\n',
  },
  {
    name: 'Float mathematical overloads retain Float precision and signed zero',
    source: `import kotlin.math.*
fun main() {
    val logarithm: Float = ln(2f)
    println(listOf(logarithm, log10(2f), log2(2f), log(27f, 3f), exp(0.5f)))
    println(listOf(sqrt(2f), cbrt(2f), hypot(3f, 4f), log(2f, 1f)))
    println(listOf(sin(1f), cos(1f), tan(1f), asin(0.5f), acos(0.5f), atan(1f), atan2(1f, -1f)))
    println(listOf(floor(-0.1f), ceil(-0.1f), round(-0.5f), truncate(-0.1f), (-0.0f).sign))
}`,
    stdout:
      '[0.6931472, 0.30103, 1.0, 3.0, 1.6487212]\n[1.4142135, 1.2599211, 5.0, NaN]\n[0.84147096, 0.5403023, 1.5574077, 0.5235988, 1.0471976, 0.7853982, 2.3561945]\n[-1.0, -0.0, -0.0, -0.0, -0.0]\n',
  },
  {
    name: 'ArrayList copies use the logical size after removing elements',
    source: `import kotlin.random.Random
fun main() {
    val list = mutableListOf<Int>()
    for (value in 10 downTo 1) list.add(value)
    repeat(7) { list.removeAt(list.lastIndex) }
    println(list.toList())
    println(list.toMutableList())
    println(list.toTypedArray().contentToString())
    println(list.reversed())
    println(list.sorted())
    println(list.distinct())
    println(list.shuffled(Random(7)))
    println(ArrayList(list))
}`,
    stdout: '[10, 9, 8]\n[10, 9, 8]\n[10, 9, 8]\n[8, 9, 10]\n[8, 9, 10]\n[10, 9, 8]\n[9, 10, 8]\n[10, 9, 8]\n',
  },
  {
    name: 'nullable Unit returns preserve null in functions and callbacks',
    source: `fun maybeUnit(take: Boolean): Unit? { if (!take) return null; return Unit }
fun receive(block: () -> Unit?): Unit? = block()
fun fail(): Unit { return error("unit") }
fun main() {
    val callback: () -> Unit? = { null }
    val nonNull: () -> Unit = { "discarded" }
    println(maybeUnit(false))
    println(maybeUnit(true))
    println(callback())
    println(receive { null })
    println(nonNull())
    try { fail() } catch (e: IllegalStateException) { println(e.message) }
}`,
    stdout: 'null\nkotlin.Unit\nnull\nnull\nkotlin.Unit\nunit\n',
  },
  {
    name: 'boxing an inherited primitive narrows the type without adding a default method',
    source: `interface Base {
    val token: Int?
    fun test(): Boolean?
}
interface Narrowed : Base {
    override val token: Int
    override fun test(): Boolean
    companion object { init { println("narrowed") } }
}
interface Child : Narrowed {
    override val token: Int
    override fun test(): Boolean
    companion object { init { println("child") } }
}
class Item : Child {
    override val token = 1
    override fun test() = true
}
interface Generic { fun value(): Any }
interface Specialized : Generic {
    override fun value(): Int
    companion object { init { println("specialized") } }
}
class NumberItem : Specialized { override fun value() = 2 }

fun main() {
    val item: Base = Item()
    println(item.token)
    println(item.test())
    println(NumberItem().value())
}`,
    stdout: '1\ntrue\nspecialized\n2\n',
  },
  {
    name: 'ArrayList subclasses inherit backed mutations, sorting, and list views',
    source: `open class Scores(initial: Collection<Int>) : ArrayList<Int>(initial) {
    override fun add(element: Int): Boolean = super.add(element * 2)
    fun total() = sum()
}
class MoreScores : Scores(listOf(3, 1))
fun main() {
    val scores = MoreScores()
    scores.add(2)
    println(scores)
    println(scores.total())
    val iterator = scores.iterator()
    scores.sortWith(compareBy { it })
    try { println(iterator.next()) } catch (error: ConcurrentModificationException) { println("modified") }
    val view = scores.subList(1, 3)
    view.removeIf { it % 2 == 0 }
    println(scores)
    println(view)
}`,
    stdout: '[3, 1, 4]\n8\nmodified\n[1, 3]\n[3]\n',
  },
  {
    name: 'enum methods can use JVM names absent from java.lang.Enum',
    source: `enum class Color {
    RED;
    fun getName(): String = "custom"
    fun getOrdinal(): Int = 7
}
fun main() {
    println(Color.RED.name)
    println(Color.RED.getName())
    println(Color.RED.ordinal)
    println(Color.RED.getOrdinal())
}`,
    stdout: 'RED\ncustom\n0\n7\n',
  },
  {
    name: 'formatting validates non-argument conversions and combines reuse with other flags',
    source: `import java.util.IllegalFormatException
fun main() {
    for (pattern in listOf(
        "%.2n", "%+n", "%5n", "%05%", "%.2%", "%-5%%5%", "%d %,<d", "%1\\$d %2\\$<d %d", "%d %<<d", "%2\\$<s"
    )) {
        try { println(pattern.format(1234, 5678)) }
        catch (error: IllegalFormatException) { println(error) }
    }
}`,
    stdout:
      "java.util.IllegalFormatPrecisionException: 2\njava.util.IllegalFormatFlagsException: Flags = '+'\njava.util.IllegalFormatWidthException: 5\njava.util.IllegalFormatFlagsException: Flags = '0'\njava.util.IllegalFormatPrecisionException: 2\n%        %\n1234 1,234\n1234 1234 1234\njava.util.DuplicateFormatFlagsException: Flags = '<'\njava.util.MissingFormatArgumentException: Format specifier '%<s'\n",
  },
  {
    name: 'Float formatting selects the nearest decimal and resolves ties to even',
    source: `fun main() {
    println(-3850040.25f)
    println(324442.125f)
    println(-403805.625f)
    println(Float.MIN_VALUE)
    println(Float.MAX_VALUE)
    println(-0f)
}`,
    stdout: '-3850040.2\n324442.12\n-403805.62\n1.4E-45\n3.4028235E38\n-0.0\n',
  },
  {
    name: 'set equality and map views use hash lookup with identity and exception handling',
    source: `var hashCalls = 0
var failHash = false
class Key(val index: Int) {
    override fun hashCode(): Int {
        hashCalls++
        if (failHash) throw NullPointerException("hash")
        return index
    }
    override fun equals(other: Any?): Boolean = other is Key && other.index == index
}
class Candidate(override val key: Key, override val value: String) : MutableMap.MutableEntry<Key, String> {
    override fun setValue(newValue: String): String = error("not writable")
}
class Observed(private val source: Set<Key>) : Set<Key> by source {
    override val size: Int get() { println("size"); return source.size }
    override fun iterator(): Iterator<Key> { println("iterator"); return source.iterator() }
}
fun main() {
    val a = hashSetOf(Key(3), Key(5))
    val b = hashSetOf(Key(3), Key(5))
    hashCalls = 0
    println(a == a)
    println(hashCalls)
    println(a == Observed(b))
    println(hashCalls)
    failHash = true
    println(a == b)
    failHash = false

    val map = mutableMapOf(Key(3) to "a", Key(5) to "b")
    hashCalls = 0
    println(Key(3) in map.keys)
    println(Candidate(Key(5), "b") in map.entries)
    println(map.entries.remove(Candidate(Key(5), "other")))
    println(map.entries.remove(Candidate(Key(5), "b")))
    println(map.keys.remove(Key(3)))
    println(map.isEmpty())
    println(hashCalls)
    val integers = (0 until 1500).toSet()
    println(integers == (0 until 1500).toSet())
    val keys = (0 until 1500).associateWith { it }.keys
    var hits = 0
    repeat(1000) { if (-1 in keys) hits++ }
    println(hits)
}`,
    stdout: 'true\n0\nsize\niterator\ntrue\n2\nfalse\ntrue\ntrue\nfalse\ntrue\ntrue\ntrue\n5\ntrue\n0\n',
  },
  {
    name: 'bulk filtering calls supplied membership and preserves partial ArrayList changes',
    source: `class Allowed : Collection<String> by listOf("a") {
    override fun contains(element: String): Boolean {
        if (element == "!") error("membership")
        return element.equals("a", ignoreCase = true)
    }
}
fun main() {
    val allowed = Allowed()
    val list = mutableListOf("A", "discard", "a", "!", "rest")
    try { list.retainAll(allowed) } catch (error: IllegalStateException) { println(error.message) }
    println(list)

    val root = mutableListOf("outside", "A", "discard", "a", "!", "rest")
    val view = root.subList(1, 5)
    try { view.retainAll(allowed) } catch (error: IllegalStateException) { println(error.message) }
    println(root)
    try { println(view.size) } catch (error: ConcurrentModificationException) { println("invalidated") }

    val set = mutableSetOf("A", "b")
    set.retainAll(allowed)
    println(set)
    val map = linkedMapOf("A" to 1, "b" to 2, "a" to 3)
    map.keys.retainAll(allowed)
    println(map)
    val removed = mutableSetOf("A", "b", "a")
    removed.removeAll(allowed)
    println(removed)
}`,
    stdout: 'membership\n[A, a, !, rest]\nmembership\n[outside, A, a, !, rest]\ninvalidated\n[A]\n{A=1, a=3}\n[A, b]\n',
  },
  {
    name: 'anonymous lambda parameters do not hide a named underscore or prevent local shadowing',
    source: `fun main() {
    val callback: (Int, Int, Int) -> Int = { \`_\`, _, _ -> \`_\` }
    println(callback(7, 2, 3))
    val shadows = { item: Int -> val item = item + 1; item }
    println(shadows(4))
}`,
    stdout: '7\n5\n',
  },
  {
    name: 'compound assignment chooses applicable mutations, writes, and safe accesses',
    source: `class Board(val numbers: MutableList<Int>)
fun value(): Int { println("rhs"); return 3 }
fun add(board: Board?) { board?.numbers += value() }
fun main() {
    var xs = mutableListOf(1)
    xs += 2
    xs += listOf(3, 4)
    println(xs)
    var readOnly: List<Int> = listOf(5)
    readOnly += 6
    println(readOnly)
    val indexed = arrayOf(mutableListOf(7))
    indexed[0] += 8
    println(indexed[0])
    add(null)
    val board = Board(mutableListOf(1))
    add(board)
    println(board.numbers)
}`,
    stdout: '[1, 2, 3, 4]\n[5, 6]\n[7, 8]\nrhs\n[1, 3]\n',
  },
  {
    name: 'signed numeric overloads preserve Kotlin promotions and return types',
    source: `import kotlin.math.*
fun main() {
    println((-5L).sign)
    println(0L.sign)
    println(Long.MAX_VALUE.sign)
    val intMod: Int = (-7L).mod(3)
    val byteMod: Byte = 7L.mod((-3).toByte())
    val shortMod: Short = 7.toByte().mod((-3).toShort())
    val longMod: Long = 7.mod(-3L)
    println(listOf(intMod, byteMod, shortMod, longMod))
    println(listOf((-7).floorDiv(2L), 7L.floorDiv(-2), 7.toByte().floorDiv((-2).toShort()), Long.MIN_VALUE.floorDiv(-1)))
    val single: Float = (-5.5f).mod(2f)
    val mixed: Double = (-5.5f).mod(2.0)
    println(listOf(single, mixed, 7.0.mod(-2f), (-0.0f).mod(3f)))
    println(listOf(2.5f.roundToLong(), (-2.5f).roundToLong(), Float.POSITIVE_INFINITY.roundToLong()))
    println(listOf(Byte.SIZE_BITS, Short.SIZE_BITS, Int.SIZE_BITS, Long.SIZE_BITS, Float.SIZE_BITS, Double.SIZE_BITS))
}`,
    stdout:
      '-1\n0\n1\n[2, -2, -2, -2]\n[-4, -4, -4, -9223372036854775808]\n[0.5, 0.5, -1.0, -0.0]\n[3, -2, 9223372036854775807]\n[8, 16, 32, 64, 32, 64]\n',
  },
  {
    name: 'package-qualified mutable variables support ordinary, compound, and increment assignments',
    source: `package demo
private var count = 1
var scores = mutableListOf(2)
fun main() {
    demo.count++
    demo.count += 3
    demo.count = demo.count + 4
    demo.scores += 3
    println(count)
    println(scores)
}`,
    stdout: '9\n[2, 3]\n',
  },
  {
    name: 'delegated boxed property getters can coexist with primitive helper methods',
    source: `class Wrapper(delegate: Lazy<Int>) : Lazy<Int> by delegate {
    fun getValue(): Int = 7
}
fun main() {
    val wrapper = Wrapper(lazy { 2 })
    println(wrapper.value)
    println(wrapper.getValue())
}`,
    stdout: '2\n7\n',
  },
  {
    name: 'character predicates follow JDK assignments and preserve surrogates',
    source: `fun main() {
    for (code in listOf(0x0378, 0xFFFF, 0xD800, 0xE000, 0x0041, 0x0661)) {
        val c = Char(code)
        println(listOf(c.isDefined(), c.isLetter(), c.isLetterOrDigit(), c.isDigit()))
    }
}`,
    stdout:
      '[false, false, false, false]\n[false, false, false, false]\n[true, false, false, false]\n[true, false, false, false]\n[true, true, true, false]\n[true, false, true, true]\n',
  },
  {
    name: 'interface delegation chooses the most specific inherited iterator',
    source: `class Tracked(val data: MutableList<Int>) : MutableList<Int> by data
class TrackedSet(val data: MutableSet<Int>) : MutableSet<Int> by data
fun main() {
    val list = Tracked(mutableListOf(1, 2, 3))
    val iterator: MutableIterator<Int> = list.iterator()
    println(iterator.next())
    iterator.remove()
    list.add(4)
    println(list.size)
    println(list.data)
    val set = TrackedSet(mutableSetOf(4, 5))
    val setIterator: MutableIterator<Int> = set.iterator()
    println(setIterator.next())
    setIterator.remove()
    println(set.data)
}`,
    stdout: '1\n3\n[2, 3, 4]\n4\n[5]\n',
  },
  {
    name: 'generic superclass constructors use their declared type arguments',
    source: `class Tracked : ArrayList<Int>()
class Sized : ArrayList<String>(4)
fun main() {
    val numbers = Tracked()
    numbers.add(1)
    println(numbers)
    val words = Sized()
    words.add("ready")
    println(words)
}`,
    stdout: '[1]\n[ready]\n',
  },
  {
    name: 'list reversal follows virtual index swaps or two list iterators',
    source: `class Observed : ArrayList<Int>() {
    override fun get(index: Int): Int {
        println("read " + index)
        return super.get(index)
    }
    override fun set(index: Int, element: Int): Int {
        println("write " + index + " " + element + " " + this)
        return super.set(index, element)
    }
}
class Sequential(private val data: MutableList<Int>) : MutableList<Int> by data {
    override fun listIterator(): MutableListIterator<Int> {
        println("forward iterator")
        return data.listIterator()
    }
    override fun listIterator(index: Int): MutableListIterator<Int> {
        println("backward iterator " + index)
        return data.listIterator(index)
    }
}
fun main() {
    val list = Observed()
    list.addAll(listOf(1, 2, 3))
    list.reverse()
    println(list)
    val backing = (1..20).toMutableList()
    val linked = Sequential(backing)
    linked.reverse()
    println(backing)
}`,
    stdout:
      'read 0\nwrite 2 1 [1, 2, 3]\nwrite 0 3 [1, 2, 1]\n[3, 2, 1]\nforward iterator\nbackward iterator 20\n[20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]\n',
  },
  {
    name: 'a delegated local can shadow a parameter and a local from an outer block',
    source: `fun check(value: Int) {
    val value by lazy { value + 1 }
    println(value)
    if (true) {
        val value by lazy { value + 1 }
        println(value)
    }
}
fun main() { check(4) }`,
    stdout: '5\n6\n',
  },
  {
    name: 'list equality uses each JVM list implementation’s access order',
    source: `class ObservedIterator(private val data: ListIterator<Int>) : ListIterator<Int> by data {
    override fun next(): Int {
        val value = data.next()
        println("next " + value)
        return value
    }
}
class Observed(private val data: List<Int>) : List<Int> by data {
    override val size: Int get() { println("size"); return data.size }
    override fun isEmpty(): Boolean { println("empty"); return data.isEmpty() }
    override fun iterator(): Iterator<Int> {
        println("iterator")
        return ObservedIterator(data.listIterator())
    }
    override fun listIterator(): ListIterator<Int> {
        println("listIterator")
        return ObservedIterator(data.listIterator())
    }
    override fun get(index: Int): Int {
        println("get " + index)
        return data[index]
    }
}
class Mutation(private val action: () -> Unit) {
    override fun equals(other: Any?): Boolean { action(); return false }
    override fun hashCode(): Int = 0
}
fun main() {
    val other: List<Int> = Observed(listOf(9, 2, 3))
    println(listOf(1, 2, 3) == other)
    println(mutableListOf(1, 2, 3) == other)
    println(mutableListOf(0, 1, 2, 3).subList(1, 4) == other)
    println(buildList { addAll(listOf(1, 2, 3)) } == other)
    println(intArrayOf(1, 2, 3).asList() == other)
    println(emptyList<Int>() == other)
    println(listOf(3, 2, 1).asReversed() == other)
    println(mutableListOf(3, 2, 1).asReversed() == other)
    val left = mutableListOf<Mutation>()
    left.add(Mutation { left.clear() })
    val right = mutableListOf(Mutation {})
    try { println(left == right) } catch (error: ConcurrentModificationException) { println("modified") }
}`,
    stdout:
      'listIterator\nnext 9\nfalse\niterator\nnext 9\nfalse\niterator\nnext 9\nfalse\nsize\nget 0\nfalse\nsize\niterator\nnext 9\nfalse\nempty\nfalse\nsize\niterator\nnext 9\nfalse\nlistIterator\nnext 9\nfalse\nmodified\n',
  },
  {
    name: 'map and collection operators use the array and iterable overloads',
    source: `fun main() {
    val map = mapOf("a" to 1, "b" to 2)
    println(map + listOf("c" to 3, "a" to 4))
    println(map + arrayOf("d" to 4))
    println(map - listOf("a"))
    println(map - arrayOf("b"))
    println(map - arrayOf("a", "b"))
    val mutable = mutableMapOf("a" to 1, "b" to 2)
    mutable += listOf("c" to 3)
    mutable += arrayOf("d" to 4)
    mutable += mapOf("e" to 5)
    mutable -= listOf("a", "b")
    mutable -= arrayOf("d")
    println(mutable)

    println(listOf(1, 2, 1) - arrayOf(1))
    println(setOf(1, 2) + arrayOf(3, 2))
    println(setOf(1, 2) - arrayOf(2))
    val list = mutableListOf(1, 2)
    list += arrayOf(3, 4)
    list -= arrayOf(2, 3)
    println(list)
    val set = mutableSetOf(1, 2)
    set += arrayOf(3, 4)
    set -= arrayOf(1, 4)
    println(set)
    println(list.removeAll(arrayOf(1)))
    println(list.retainAll(arrayOf(4, 5)))
    println(list)
    println(set.removeAll(arrayOf(2)))
    println(set.retainAll(arrayOf(7)))
    println(set)
    println(mutable.keys.removeAll(arrayOf("c")))
    println(mutable.values.retainAll(arrayOf(5)))
    println(mutable)
}`,
    stdout:
      '{a=4, b=2, c=3}\n{a=1, b=2, d=4}\n{b=2}\n{a=1}\n{}\n{c=3, e=5}\n[2]\n[1, 2, 3]\n[1]\n[1, 4]\n[2, 3]\ntrue\nfalse\n[4]\ntrue\ntrue\n[]\ntrue\nfalse\n{e=5}\n',
  },
  {
    name: 'hexadecimal floating parsing applies exponent scaling before rounding',
    source: `fun main() {
    for (text in listOf("0x2p-1075", "0x1.8p-1074", "-0x1p-1075", "0x1p-1074", "0x1.fffffffffffffp1023", "0x1.fffffffffffff8p1023")) {
        println(text.toDoubleOrNull())
    }
    println("0x1.000001p0".toFloat())
    println("0x1.0000010000001p0".toFloat())
    for (text in listOf("0x1p128", "0x1.ffffffp127", "-0x1p128", "0x1.fffffep127", "0x1p-150")) {
        val value = text.toFloat()
        println(value.isInfinite())
        println(value.toDouble())
    }
}`,
    stdout:
      '4.9E-324\n9.9E-324\n-0.0\n4.9E-324\n1.7976931348623157E308\nInfinity\n1.0\n1.0000001\ntrue\nInfinity\ntrue\nInfinity\ntrue\n-Infinity\nfalse\n3.4028234663852886E38\nfalse\n0.0\n',
  },
  {
    name: 'ArrayList subclass rendering interleaves its iterator and element callbacks',
    source: `class Item(private val label: String) {
    override fun toString(): String { println("render " + label); return label }
}
class ItemsIterator : MutableIterator<Item> {
    var index = 0
    override fun hasNext(): Boolean = index < 2
    override fun next(): Item {
        index++
        println("next " + index)
        return Item(index.toString())
    }
    override fun remove() {}
}
class Items : ArrayList<Item>() {
    override fun iterator(): MutableIterator<Item> {
        println("iterator")
        return ItemsIterator()
    }
}
fun main() { println(Items()) }`,
    stdout: 'iterator\nnext 1\nrender 1\nnext 2\nrender 2\n[1, 2]\n',
  },
  {
    name: 'ArrayLists and sublists use fail-fast iterators while rendering elements',
    source: `class Item(private val mutate: () -> Unit) {
    override fun toString(): String {
        mutate()
        return "item"
    }
}
fun main() {
    val list = mutableListOf<Any>()
    list.add(Item { list.add("new") })
    list.add("last")
    try { println(list) } catch (e: ConcurrentModificationException) { println("modified") }
    println(list.size)

    val cleared = mutableListOf<Any>()
    cleared.add(Item { cleared.clear() })
    cleared.add("last")
    try { println(cleared) } catch (e: ConcurrentModificationException) { println("cleared") }
    println(cleared.size)

    val backing = mutableListOf<Any>()
    backing.add(Item { backing.add("new") })
    backing.add("last")
    val view = backing.subList(0, 2)
    try { println(view) } catch (e: ConcurrentModificationException) { println("view modified") }
    println(backing.size)

    val self = mutableListOf<Any>()
    self.add(self)
    println(self)
}`,
    stdout: 'modified\n3\ncleared\n0\nview modified\n3\n[(this Collection)]\n',
  },
  {
    name: 'map value lookup follows live HashMap buckets and LinkedHashMap insertion order',
    source: `class EntryValue(val id: Int, private val visit: (Int) -> Unit = {}) {
    override fun equals(other: Any?): Boolean {
        if (other !is EntryValue) return false
        visit(other.id)
        return false
    }
    override fun hashCode(): Int = id
}
fun check(map: MutableMap<Int, EntryValue>, keyStep: Int) {
    map[keyStep] = EntryValue(1)
    map[2 * keyStep] = EntryValue(2)
    map[4 * keyStep] = EntryValue(4)
    val target = EntryValue(9) { id ->
        println(id)
        if (id == 1) {
            map.remove(2 * keyStep)
            map[3 * keyStep] = EntryValue(3)
        }
        if (id == 2) error("visited removed value")
    }
    println(map.values.contains(target))
}
fun removingCurrent(map: MutableMap<Int, EntryValue>, keyStep: Int) {
    map[keyStep] = EntryValue(1)
    map[2 * keyStep] = EntryValue(2)
    println(map.containsValue(EntryValue(9) { id ->
        println(id)
        if (id == 1) map.remove(keyStep)
    }))
}
fun main() {
    check(HashMap(32), 1)
    check(HashMap(32), 32)
    check(LinkedHashMap(), 1)
    removingCurrent(HashMap(32), 32)
    removingCurrent(LinkedHashMap(), 1)
    val view = linkedMapOf(1 to EntryValue(1), 2 to EntryValue(2))
    try {
        view.values.remove(EntryValue(9) { view.remove(2) })
    } catch (e: ConcurrentModificationException) { println("modified") }
}`,
    stdout: '1\n3\n4\nfalse\n1\n4\n3\nfalse\n1\n4\n3\nfalse\n1\n2\nfalse\n1\nfalse\nmodified\n',
  },
  {
    name: 'digits and character array ranges use Kotlin JVM values and bounds',
    source: `fun main() {
    println(0.digitToChar())
    println(9.digitToChar())
    println(10.digitToChar(11))
    println(35.digitToChar(36))
    for (digit in listOf(-1, 10)) {
        try { println(digit.digitToChar()) } catch (e: IllegalArgumentException) { println(e.message) }
    }
    for ((digit, radix) in listOf(0 to 1, -1 to 16, 16 to 16, 8 to 37)) {
        try { println(digit.digitToChar(radix)) } catch (e: IllegalArgumentException) { println(e.message) }
    }
    val chars = charArrayOf('a', 'b', 'c')
    println(String(chars, 1, 2))
    println(String(chars, 3, 0))
    for ((offset, length) in listOf(-1 to 0, 0 to -1, 2 to 2, Int.MAX_VALUE to 1)) {
        try { println(String(chars, offset, length)) } catch (e: Exception) { println(e) }
    }
}`,
    stdout:
      '0\n9\nA\nZ\nInt -1 is not a decimal digit\nInt 10 is not a decimal digit\nInvalid radix: 1. Valid radix values are in range 2..36\nDigit -1 does not represent a valid digit in radix 16\nDigit 16 does not represent a valid digit in radix 16\nInvalid radix: 37. Valid radix values are in range 2..36\nbc\n\njava.lang.StringIndexOutOfBoundsException: Range [-1, -1 + 0) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + -1) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [2, 2 + 2) out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Range [2147483647, 2147483647 + 1) out of bounds for length 3\n',
  },
  {
    name: 'character array concatenation distinguishes an inverted range from an out-of-bounds range',
    source: `fun main() {
    val chars = charArrayOf('a', 'b', 'c')
    println(chars.concatToString(1, 3))
    for ((start, end) in listOf(-1 to 0, 0 to -1, 2 to 4, 2 to 1, 4 to 4)) {
        try { println(chars.concatToString(start, end)) } catch (e: Exception) { println(e) }
    }
}`,
    stdout:
      'bc\njava.lang.IndexOutOfBoundsException: startIndex: -1, endIndex: 0, size: 3\njava.lang.IllegalArgumentException: startIndex: 0 > endIndex: -1\njava.lang.IndexOutOfBoundsException: startIndex: 2, endIndex: 4, size: 3\njava.lang.IllegalArgumentException: startIndex: 2 > endIndex: 1\njava.lang.IndexOutOfBoundsException: startIndex: 4, endIndex: 4, size: 3\n',
  },
  {
    name: 'inherited implementations and later overrides dispatch through interface references',
    source: `open class Animal { fun speak() = "animal" }
interface Speaker { fun speak(): String }
class Dog : Animal(), Speaker
open class Cat { open fun purr() = "purr"; val lives = 9 }
interface Purrer { fun purr(): String; val lives: Int }
open class Tom : Cat(), Purrer
class Kitten : Tom() { override fun purr() = "kitten" }
interface NumberSource { val value: Number }
open class IntSource { val value: Int = 1 }
class Value : IntSource(), NumberSource
fun main() {
    println(Dog().speak())
    val speaker: Speaker = Dog()
    println(speaker.speak())
    val purrer: Purrer = Tom()
    println(purrer.purr() + purrer.lives)
    val kitten: Purrer = Kitten()
    println(kitten.purr())
    val number: NumberSource = Value()
    println(number.value)
}`,
    stdout: 'animal\nanimal\npurr9\nkitten\n1\n',
  },
  {
    name: 'assignment and increment through super call the parent accessors directly',
    source: `open class Parent {
    open var value = 1
    protected var counter = 2
}
class Child : Parent() {
    override var value: Int
        get() = super.value + 1
        set(value) { super.value = value * 2 }
    fun exercise() {
        value = 3
        println(value)
        super.value += 3
        println(value)
        println(super.value++)
        println(++super.value)
        super.counter += 2
        println(super.counter)
    }
}
interface DefaultState {
    var amount: Int
        get() = 1
        set(value) { println("interface " + value) }
}
class UsesInterface : DefaultState {
    override var amount: Int
        get() = super.amount + 1
        set(value) { super.amount = value }
}
fun main() {
    Child().exercise()
    val state = UsesInterface()
    state.amount = 5
    println(state.amount)
}`,
    stdout: '7\n10\n9\n11\n4\ninterface 5\n2\n',
  },
  {
    name: 'a shared interface root dispatches to the most specific default',
    source: `interface Base { fun move() = "base" }
interface First : Base { override fun move() = "first" }
interface Second : Base
class Diamond : First, Second
interface Walker { fun walk() = "walk" }
interface Swimmer { fun walk() = "swim" }
class Duck : Walker, Swimmer {
    override fun walk() = "both"
}
fun main() { println(Diamond().move()); println(Duck().walk()) }`,
    stdout: 'first\nboth\n',
  },
  {
    name: 'ArrayDeque rendering is fail-fast and ListBuilder rendering keeps its initial range',
    source: `class Rendered(private val mutate: () -> Unit) {
    override fun toString(): String { mutate(); return "item" }
}
fun main() {
    val deque = ArrayDeque<Any>()
    deque.add(Rendered { deque.add("new") })
    deque.add("last")
    try { println(deque) } catch (error: ConcurrentModificationException) { println("added") }
    println(deque.size)
    deque.clear()
    deque.add(Rendered { deque.clear() })
    deque.add("last")
    try { println(deque) } catch (error: ConcurrentModificationException) { println("cleared") }

    deque.add(Rendered { deque.add("new") })
    deque.add("last")
    val view = deque.subList(0, 2)
    try { println(view) } catch (error: ConcurrentModificationException) { println("view changed") }

    buildList<Any> {
        val builder = this
        add(Rendered { builder.add("new") })
        add("last")
        println(this)
        println(size)
    }
    buildList<Any> {
        val builder = this
        add(Rendered { builder.clear() })
        add("last")
        println(this)
        println(size)
    }
}`,
    stdout: 'added\n3\ncleared\nview changed\n[item, last]\n3\n[item, null]\n0\n',
  },
  {
    name: 'hash map equality checks live iterator versions only on advancement',
    source: `class Other(val target: MutableMap<Int, Int>, val at: Int) : Map<Int, Int> by mapOf(1 to 1, 2 to 2) {
    override fun get(key: Int): Int? {
        if (key == at) target.remove(2)
        return key
    }
}
fun main() {
    for (hash in listOf(true, false)) {
        for (at in listOf(1, 2)) {
            val map = if (hash) hashMapOf(1 to 1, 2 to 2) else linkedMapOf(1 to 1, 2 to 2)
            try { println(map == Other(map, at)) } catch (e: Exception) { println(e) }
            println(map)
        }
    }
}`,
    stdout:
      'java.util.ConcurrentModificationException\n{1=1}\ntrue\n{1=1}\njava.util.ConcurrentModificationException\n{1=1}\ntrue\n{1=1}\n',
  },
  {
    name: 'singleton lookup skips hashing and native getOrDefault looks up one key',
    source: `var hashes = 0
var equalities = 0
class Key(private val value: Int) {
    override fun equals(other: Any?): Boolean {
        equalities++
        return other is Key && value == other.value
    }
    override fun hashCode(): Int {
        hashes++
        return value
    }
}
class Observed : Map<Key, Int?> by emptyMap<Key, Int?>() {
    override fun get(key: Key): Int? { println("get"); return null }
    override fun containsKey(key: Key): Boolean {
        println("contains")
        return false
    }
}
fun main() {
    val key = Key(1)
    val set = setOf(key)
    val map = mapOf(key to 7)
    println(hashes)
    println(set.contains(key))
    println(map[key])
    println(map.getOrDefault(Key(2), 9))
    println(hashes)
    println(equalities)
    println(map.hashCode())
    println(hashes)

    val hashMap = hashMapOf<Key, Int?>(key to null)
    hashes = 0
    println(hashMap.getOrDefault(Key(1), 9))
    println(hashes)
    hashes = 0
    println(hashMap.getOrDefault(Key(2), 9))
    println(hashes)
    println(Observed().getOrDefault(key, 9))
}`,
    stdout: '0\ntrue\n7\n9\n0\n3\n6\n1\nnull\n1\n9\n1\nget\ncontains\n9\n',
  },
  {
    name: 'mixed signed range endpoints widen to the JVM range type',
    source: `fun main() {
    val byte: Byte = 1
    val short: Short = 2
    val int = 4
    val long = 5L
    println((byte..short).toList())
    println((byte..int).toList())
    println((byte..long).toList())
    println((short..<int).toList())
    println((short..<long).toList())
    println((int..<long).toList())
    println((1L..<int).toList())
    println((1L..<short).toList())
    println((byte..<Int.MIN_VALUE).toList())
    println((short..<Long.MIN_VALUE).toList())
}`,
    stdout: '[1, 2]\n[1, 2, 3, 4]\n[1, 2, 3, 4, 5]\n[2, 3]\n[2, 3, 4]\n[4]\n[1, 2, 3]\n[1]\n[]\n[]\n',
  },
  {
    name: 'star-projected collections can read, search, and remove elements',
    source: `fun main() {
    val values: MutableList<*> = mutableListOf(1, 2)
    println(values[0])
    println(values.contains("a"))
    println(values.remove("a"))
    println(values.indexOf("a"))
    println(values.addAll(emptyList()))
    val array: Array<*> = arrayOf(3)
    println(array[0])
    println(array.contains("a"))
    val map: MutableMap<*, *> = mutableMapOf("a" to 4)
    println(map["a"])
    println(map.containsKey("a"))
    println(map.containsValue(4))
    println(map.remove("x"))
}`,
    stdout: '1\nfalse\nfalse\n-1\nfalse\n3\nfalse\n4\ntrue\ntrue\nnull\n',
  },
  {
    name: 'text ranges use the JVM builder callbacks and bounds',
    source: `class Logged : CharSequence {
    override val length: Int
        get() { println("length"); return 3 }
    override fun get(index: Int): Char {
        println("get $index")
        return "abc"[index]
    }
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence {
        println("subSequence $startIndex $endIndex")
        return "abc".subSequence(startIndex, endIndex)
    }
}

fun main() {
    println("abc".replaceRange(1..1, "x"))
    println("abc".removeRange(100, 100))
    try { println("abc".replaceRange(5, 6, "x")) }
    catch (e: IndexOutOfBoundsException) { println(e.message) }
    try { println("abc".removeRange(1, 100)) }
    catch (e: NegativeArraySizeException) { println(e.message) }
    val s = Logged()
    println(s.replaceRange(1, 2, "X"))
    println(s.removeRange(1, 2))
    println(s.removeRange(12, 12))
}`,
    stdout:
      'axc\nabc\nRange [0, 5) out of bounds for length 3\n-96\nlength\nget 0\nlength\nlength\nget 2\naXc\nlength\nlength\nget 0\nlength\nlength\nget 2\nac\nlength\nsubSequence 0 3\nabc\n',
  },
  {
    name: 'collection subtraction, reverse traversal, and flattening use JVM callbacks',
    source: `class Sequential(private val items: List<Int> = listOf(1, 2, 3)) : List<Int> by items {
    override val size: Int get() = 3
    override fun get(index: Int): Int {
        println("get $index")
        return index + 1
    }
    override fun listIterator(index: Int): ListIterator<Int> {
        println("listIterator $index")
        return listOf(1, 2, 3).listIterator(index)
    }
    override fun iterator(): Iterator<Int> {
        println("iterator")
        return listOf(1, 2, 3).iterator()
    }
}
class Single(private val items: List<Int> = listOf(2)) : List<Int> by items {
    override val size: Int get() = 1
    override fun get(index: Int): Int { println("get $index"); return 2 }
    override fun iterator(): Iterator<Int> { println("iterator"); return listOf(2).iterator() }
}
class Membership(private val items: Set<Int> = setOf(2)) : Set<Int> by items {
    override val size: Int get() = 1
    override fun iterator(): Iterator<Int> { println("iteration"); return listOf(2).iterator() }
    override fun contains(element: Int): Boolean { println("contains $element"); return element == 2 }
}
fun main() {
    val m = Membership()
    println(listOf(1, 2, 3) - m)
    println(linkedSetOf(1, 2, 3) - m)
    println(Sequential().takeLast(2))
    println(Sequential().takeLastWhile { it > 1 })
    println(Sequential().dropLastWhile { it > 2 })
    for (take in listOf(true, false)) {
        val list = arrayListOf(1, 2, 3)
        try {
            if (take) list.takeLastWhile { list.clear(); true }
            else list.dropLastWhile { list.clear(); true }
        } catch (e: ConcurrentModificationException) { println("modified") }
    }
    val singleton = Single()
    println(listOf(1).flatMap { singleton })
    println(listOf(singleton).flatten())
    println(mapOf("key" to 1).flatMap { singleton })
}`,
    stdout:
      'contains 1\ncontains 2\ncontains 3\n[1, 3]\ncontains 1\ncontains 2\ncontains 3\n[1, 3]\nlistIterator 1\n[2, 3]\nlistIterator 3\n[2, 3]\nlistIterator 3\niterator\n[1, 2]\nmodified\nmodified\niterator\n[2]\niterator\n[2]\niterator\n[2]\n',
  },
  {
    name: 'array searches and seeded random sampling support primitive overloads',
    source: `import kotlin.random.Random

fun main() {
    val seed = Random(71)
    println(longArrayOf(1, 2, 3).random(seed))
    println(charArrayOf('a', 'b', 'c').randomOrNull(seed))
    println(arrayOf("x", "y", "z").random(seed))
    println(intArrayOf().randomOrNull())
    try { charArrayOf().random(seed) }
    catch (e: NoSuchElementException) { println(e.message) }
    val values = intArrayOf(1, 2, 3)
    println(values.lastOrNull { v ->
        println("visit $v")
        if (v == 2) values[1] = 9
        v < 3
    })
    println(arrayOf("abc", "def").findLast { it.startsWith("a") })
    println(booleanArrayOf(true, false).lastOrNull { it })
}`,
    stdout: '1\nc\ny\nnull\nArray is empty.\nvisit 3\nvisit 2\n2\nabc\ntrue\n',
  },
  {
    name: 'lambda control statements infer Unit and exhaustive branches retain their value',
    source: `fun main() {
    val n = 3
    val p = true
    println(5.let { if (it > 2) { println(it) } else if (it > 1) { println(-it) } })
    println(n.let { when (it) { 3 -> println("matched") } })
    println(listOf(1, 2).map { if (it > 1) println(it) })
    val fn = { x: Int -> if (x > 1) println(x) }
    println(fn(4))
    println(n.let { if (p) 2 else if (!p) 4 })
    println(n.let { when (it) { 3 -> 9 } })
    println(n.let { try { if (it > 1) 4 } finally { println("finally") } })
    println(p.let { when (it) { true -> 1; false -> 2 } })
}`,
    stdout:
      '5\nkotlin.Unit\nmatched\nkotlin.Unit\n2\n[kotlin.Unit, kotlin.Unit]\n4\nkotlin.Unit\nkotlin.Unit\nkotlin.Unit\nfinally\nkotlin.Unit\n1\n',
  },
  {
    name: 'list hashing and searches follow the backing list modification checks',
    source: `class Key(private val change: () -> Unit, private val number: Int = 1) {
    override fun hashCode(): Int { change(); return number }
    override fun equals(other: Any?): Boolean { change(); return true }
}
fun main() {
    for (kind in 0..2) {
        val root: MutableList<Key> = if (kind == 2) ArrayDeque<Key>() else ArrayList<Key>()
        root.add(Key({ root.clear() }))
        root.add(Key({}))
        val view = if (kind == 1) root.subList(0, 1) else root
        try { println(view.hashCode()) }
        catch (e: ConcurrentModificationException) { println("hash detected") }
    }
    for (kind in 0..3) {
        val root = arrayListOf(Key({}), Key({}))
        val view = if (kind == 3) root else root.subList(0, 2)
        val key = Key({ root.clear() })
        try {
            when (kind) {
                0 -> println(view.indexOf(key))
                1 -> println(view.lastIndexOf(key))
                else -> println(view.contains(key))
            }
        } catch (e: ConcurrentModificationException) { println("search detected") }
    }
    var list: MutableList<Key>? = null
    val built = buildList {
        list = this
        add(Key({ list!![1] = Key({}, 9) }))
        add(Key({}, 2))
        println(hashCode())
    }
    println(built.size)
}`,
    stdout:
      'hash detected\nhash detected\nhash detected\nsearch detected\nsearch detected\nsearch detected\ntrue\n1001\n2\n',
  },
  {
    name: 'array ranges use JVM sorting and bounds, and unsplit results preserve list mutability',
    source: `@OptIn(ExperimentalUnsignedTypes::class)
fun main() {
    val numbers = intArrayOf(3, 1, 2, 0)
    numbers.sort(toIndex = 3)
    println(numbers.toList())
    numbers.sortDescending(0, 3)
    println(numbers.toList())
    val letters = charArrayOf('d', 'a', 'b', 'c')
    letters.reverse(1, 4)
    println(letters.concatToString())
    letters.sort(1, 4)
    println(letters.concatToString())
    val unsigned = uintArrayOf(5u, 8u, 2u, 1u)
    unsigned.sortDescending(1, 4)
    println(unsigned.toList())
    val words = arrayOf("b", "A", "a", "c")
    words.sortWith(Comparator { a, b -> b.compareTo(a, ignoreCase = true) }, 0, 3)
    println(words.toList())
    words.sort(1, 4)
    println(words.toList())
    words.sortDescending(0, 3)
    println(words.toList())
    try { numbers.sort(0, 7) }
    catch (e: Exception) { println(e) }
    try { numbers.reverse(0, 7) }
    catch (e: Exception) { println(e) }
    try { numbers.sort(7, -1) }
    catch (e: Exception) { println(e) }
    for (parts in listOf("hello".split(','), "a,b".split(",", limit = 1), "ab".split(',', '.'), "a,b".split(','))) {
        try {
            (parts as MutableList<String>).add("x")
            println(parts)
        } catch (e: UnsupportedOperationException) { println("fixed") }
    }
}`,
    stdout:
      '[1, 2, 3, 0]\n[3, 2, 1, 0]\ndcba\ndabc\n[5, 8, 2, 1]\n[b, A, a, c]\n[b, A, a, c]\n[b, a, A, c]\njava.lang.ArrayIndexOutOfBoundsException: Array index out of range: 7\njava.lang.IndexOutOfBoundsException: fromIndex: 0, toIndex: 7, size: 4\njava.lang.IllegalArgumentException: fromIndex(7) > toIndex(-1)\nfixed\nfixed\n[ab, x]\n[a, b, x]\n',
  },
  {
    name: 'StringBuilder sequence reads observe the JVM backing storage and validation order',
    source: `class Observed(private val edit: () -> Unit) : CharSequence {
    override val length: Int get() { println("length"); return 2 }
    override fun get(index: Int): Char {
        println("read $index")
        if (index == 0) edit()
        return "bc"[index]
    }
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = "bc".substring(startIndex, endIndex)
    override fun toString(): String = "label"
}
fun main() {
    for (position in 0..3) {
        val builder = StringBuilder("abc")
        builder.insert(position, builder as CharSequence)
        println(builder.toString())
    }
    val builder = StringBuilder("a")
    builder.append(Observed({ builder.append("x") }))
    println(builder.toString())
    builder.setLength(1)
    builder.append(Observed({ builder.setLength(0) }))
    println(builder.toString())

    val grown = StringBuilder(1).append("a")
    grown.append(Observed({ grown.setCharAt(0, 'X') }))
    println(grown.toString())
    val retained = StringBuilder(8).append("a")
    retained.append(Observed({ retained.setCharAt(0, 'X') }))
    println(retained.toString())
    for (offset in listOf(-1, 9)) {
        try { builder.insert(offset, Observed({ println("unexpected") })) }
        catch (e: IndexOutOfBoundsException) { println(e.message) }
    }
    println(Observed({}).padStart(4, '_').toString())
    println(Observed({}).padEnd(4, '_').toString())
}`,
    stdout:
      'abcabc\naaaabc\nababac\nabcabc\nlength\nlength\nread 0\nread 1\nabc\nlength\nlength\nread 0\nread 1\nabc\nlength\nlength\nread 0\nread 1\nabc\nlength\nlength\nread 0\nread 1\nXbc\nlength\nRange [-1, 3) out of bounds for length 3\nlength\nRange [9, 3) out of bounds for length 3\nlength\nlength\nlength\nlength\nread 0\nread 1\n__bc\nlength\nlength\nlength\nread 0\nread 1\nlength\nbc__\n',
  },
  {
    name: 'collection callbacks respect reference identity, live hashing, and builder capacity',
    source: `class Key(val value: Int, val callback: () -> Unit = {}) {
    override fun hashCode(): Int { callback(); return value }
    override fun equals(other: Any?): Boolean {
        println("equals")
        return other is Key && other.value == value
    }
}
fun describe(value: Key?) {
    when (value) {
        (null) -> println("null")
        else -> println("value")
    }
}
fun main() {
    val key = Key(1)
    println(arrayOf(key).contentEquals(arrayOf(key)))
    val a = hashMapOf(key to key).entries.first()
    println(a == a)
    println(a == hashMapOf(key to key).entries.first())
    describe(key)
    describe(null)
    for (linked in listOf(false, true)) {
        val map: MutableMap<Key, Int> = if (linked) LinkedHashMap<Key, Int>(4) else HashMap<Key, Int>(4)
        map[Key(1)] = 10
        map[Key(2)] = 20
        map[Key(3)] = 30
        println(map.getOrDefault(Key(1, { map[Key(4)] = 40 }), 7))
        println(map.size)
    }
    val set = linkedSetOf<Key>()
    var modify = false
    set.add(Key(1, { if (modify) set.clear() }))
    set.add(Key(2))
    modify = true
    try { println(set.hashCode()) }
    catch (e: ConcurrentModificationException) { println("set modified") }
    for (view in listOf(false, true)) {
        val map = linkedMapOf<Int, Key>()
        map[1] = Key(1, { map.clear() })
        map[2] = Key(2)
        try { println(if (view) map.entries.hashCode() else map.hashCode()) }
        catch (e: ConcurrentModificationException) { println("map modified") }
    }

    val captured: Int
    println(buildList(2) { captured = 4; add(1); add(2) })
    println(captured)
    println(buildSet(3) { add(2); add(1); add(2) })
    println(buildMap(4) { put(2, 3); put(1, 4) })
    try { buildList<Int>(-1) {} } catch (e: IllegalArgumentException) { println(e.message) }
    try { buildSet<Int>(-1) {} } catch (e: IllegalArgumentException) { println(e.message) }
    try { buildMap<Int, Int>(-1) {} } catch (e: IllegalArgumentException) { println(e.message) }
}`,
    stdout:
      'true\ntrue\ntrue\nvalue\nnull\n7\n4\n7\n4\nset modified\nmap modified\nmap modified\n[1, 2]\n4\n[2, 1]\n{2=3, 1=4}\ncapacity must be non-negative.\ncapacity must be non-negative.\ncapacity must be non-negative.\n',
  },
  {
    name: 'StringBuilder nullable character arrays use JVM member overloads',
    source: `fun main() {
    val empty: CharArray? = null
    try { println(StringBuilder("ab").append(empty)) } catch (e: Exception) { println(e) }
    try { println(StringBuilder("ab").insert(1, empty)) } catch (e: Exception) { println(e) }
    println(StringBuilder().appendLine(empty).append('!'))
}`,
    stdout:
      'java.lang.NullPointerException: Cannot read the array length because "str" is null\njava.lang.NullPointerException: Cannot read the array length because "str" is null\nnull\n!\n',
  },
  {
    name: 'Comparable clamps and conditional numeric selector overloads match Kotlin',
    source: `class Bound(private val n: Int) : Comparable<Bound> {
    override fun compareTo(other: Bound): Int = n.compareTo(other.n)
    override fun toString(): String = "Bound($n)"
}
fun main() {
    println("z".coerceIn("a".."m"))
    println("b".coerceIn("a", null))
    println("b".coerceAtLeast("c"))
    println("b".coerceAtMost("a"))
    println(Bound(5).coerceIn(Bound(1), Bound(3)))
    println(Bound(5).coerceIn(Bound(1)..Bound(3)))
    try { println("a".coerceIn("d".."b")) } catch (e: IllegalArgumentException) { println(e.message) }
    println(listOf(1, 2).sumOf { if (it == 1) 1 else 2L })
    println(listOf(1, 2).sumOf { when (it) { 1 -> 1; else -> 2L } })
    println(intArrayOf(1, 2).sumOf { if (it == 1) 1 else 2L })
    println(listOf(1, 2).sumOf { try { if (it == 1) 1 else 2L } finally { Unit } })
}`,
    stdout: 'm\nb\nc\na\nBound(3)\nBound(3)\nCannot coerce value to an empty range: d..b.\n3\n3\n3\n3\n',
  },
  {
    name: 'reversed and moving list views and map entries preserve JVM iteration',
    source: `class Checks(private val items: List<Int> = listOf(2)) : Collection<Int> by items {
    override fun contains(element: Int): Boolean { println("contains $element"); return element == 2 }
}
class WindowValue(private val label: String, private val change: () -> Unit = {}) {
    override fun toString(): String { change(); return label }
    override fun hashCode(): Int { change(); return label.length }
}
fun main() {
    for (indexed in listOf(false, true)) {
        val backing = mutableListOf(1, 2, 3)
        val reverse = backing.asReversed()
        try {
            if (indexed) reverse.addAll(1, reverse) else reverse.addAll(reverse)
        } catch (e: ConcurrentModificationException) { println("concurrent") }
        println(backing)
    }
    val origin = mutableListOf(1, 2, 3)
    val reverse = origin.asReversed()
    reverse.removeAll(Checks())
    println(origin)
    origin.add(2)
    reverse.retainAll(Checks())
    println(origin)

    for (hash in listOf(false, true)) {
        val values = mutableListOf<WindowValue>()
        values.add(WindowValue("first", { values[1] = WindowValue("longer") }))
        values.add(WindowValue("old"))
        values.windowed(2) { window ->
            if (hash) println(window.hashCode()) else println(window)
        }
    }
    val singleton = mapOf("key" to 4)
    val keys = singleton.keys as MutableSet<String>
    val vals = singleton.values as MutableCollection<Int>
    println(keys.remove("absent"))
    println(vals.remove(5))
    try { println(vals.remove(4)) } catch (e: UnsupportedOperationException) { println("immutable") }

    val map = mutableMapOf("key" to 4)
    val entry = map.entries.iterator().next()
    println(entry === map.iterator().next())
    println(entry === map.entries.iterator().next())
    map.remove("key")
    map["key"] = 5
    println(entry === map.entries.iterator().next())
    println(entry.value)
    val built = buildMap { put("key", 1); println(entries.first() === entries.first()) }
    println(built.entries.first() === built.entries.first())
}`,
    stdout:
      'concurrent\n[3, 1, 2, 3]\nconcurrent\n[1, 2, 3, 3]\ncontains 3\ncontains 2\ncontains 1\n[1, 3]\ncontains 2\ncontains 3\ncontains 1\n[2]\n[first, longer]\n1122\nfalse\nfalse\nimmutable\ntrue\ntrue\nfalse\n4\nfalse\nfalse\n',
  },
  {
    name: 'unsigned progressions, sums, bit operations and numeric parsing',
    source: `fun main() {
    for (i in 1u..3u) print(i)
    println()
    println((0u until 4u).toList())
    println((5u downTo 1u step 2).toList())
    println((1u..4u).first)
    println((1uL..3uL).sum())
    println(listOf(3u, 1u).sum())
    println(arrayOf(3uL, 1uL).sum())
    println((UInt.MAX_VALUE - 2u..UInt.MAX_VALUE).toList())
    println((ULong.MAX_VALUE downTo ULong.MAX_VALUE - 4uL step 2).toList())
    println((0u..<0u).firstOrNull())
    println((1uL..4uL).reversed().last())
    println(2uL in (1u..3u))
    println(ULong.MAX_VALUE in (1u..3u))
    println(5uL shl 2)
    println(5uL and 3uL)
    println(5u.inv())
    println(5u.floorDiv(2u))
    println("12".toULong())
    println("ff".toUByte(16))
    println("g".toUIntOrNull(16))
    println("18446744073709551616".toULongOrNull())
    try { println("-1".toULong()) } catch (e: Exception) { println(e) }
}`,
    stdout:
      "123\n[0, 1, 2, 3]\n[5, 3, 1]\n1\n6\n4\n4\n[4294967293, 4294967294, 4294967295]\n[18446744073709551615, 18446744073709551613, 18446744073709551611]\nnull\n1\ntrue\nfalse\n20\n1\n4294967290\n2\n12\n255\nnull\nnull\njava.lang.NumberFormatException: Invalid number format: '-1'\n",
  },
  {
    name: 'unsigned arithmetic and narrow radix parsing follow Kotlin numeric rules',
    source: `fun main() {
    println("7f".toByte(16))
    println("-80".toByte(16))
    println("80".toByteOrNull(16))
    println("100".toShortOrNull(2))
    println("-8000".toShort(16))
    println("8000".toShortOrNull(16))
    try { println("80".toByte(16)) } catch (e: Exception) { println(e) }
    try { println("g".toShort(16)) } catch (e: Exception) { println(e) }
    try { println("1".toByteOrNull(1)) } catch (e: Exception) { println(e) }
    for (word in listOf("ǳabc", "ǆabc", "ǅabc", "ßabc", "𐐨abc")) println(word.capitalize())
    val byte: UByte = 255u
    val short: UShort = 256u
    val int: UInt = 4_294_967_295u
    val long: ULong = 4_294_967_296uL
    println(byte.compareTo(short))
    println(int.compareTo(long))
    println(long.compareTo(int))
    println(int.plus(1u))
    println(byte.plus(short))
    println(0u.minus(1u))
    println(int.times(2u))
    println(long.div(short))
    println(long.rem(7u))
    println(byte.inc())
    println(0uL.dec())
    try { println(int.div(0u)) } catch (e: ArithmeticException) { println(e.message) }
}`,
    stdout:
      '127\n-128\nnull\n4\n-32768\nnull\njava.lang.NumberFormatException: Value out of range. Value:"80" Radix:16\njava.lang.NumberFormatException: For input string: "g" under radix 16\njava.lang.IllegalArgumentException: radix 1 was not in valid range 2..36\nǲabc\nǅabc\nǅabc\nSSabc\n𐐨abc\n-1\n-1\n1\n0\n511\n4294967295\n4294967294\n16777216\n4\n0\n18446744073709551615\n/ by zero\n',
  },
  {
    name: 'reentrant builder recoding and enum list identity match Kotlin JVM',
    source: `class EncodedInput(val destination: StringBuilder) : CharSequence by "xy" {
    override fun get(index: Int): Char {
        if (index == 0) destination.append('λ')
        return "xy"[index]
    }
}
enum class Direction { LEFT, RIGHT }
enum class NoEntries {}
fun main() {
    for (capacity in listOf(2, 3, 16)) {
        val builder = StringBuilder(capacity).append("abc")
        builder.insert(1, EncodedInput(builder))
        println(builder.toString().map { it.code })
        for (index in 3..4) {
            try { println(builder[index].code) } catch (e: Exception) { println(e) }
        }
        val sequence: CharSequence = builder
        try { println(sequence[4].code) } catch (e: Exception) { println(e) }
    }
    val list = Direction.entries
    println(list === Direction.entries)
    println(NoEntries.entries === NoEntries.entries)
    println(list)
    println(Direction.values() === Direction.values())
    val values = Direction.values()
    values[0] = Direction.RIGHT
    println(Direction.entries)
    println(Direction.valueOf("LEFT") === list[0])
}`,
    stdout:
      '[30817, 25209, 99, 0, 0]\njava.lang.StringIndexOutOfBoundsException: Index 3 out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Index 4 out of bounds for length 3\njava.lang.StringIndexOutOfBoundsException: Index 4 out of bounds for length 3\n[30817, 25209, 99, 0, 0]\n0\njava.lang.StringIndexOutOfBoundsException: Index 4 out of bounds for length 4\njava.lang.StringIndexOutOfBoundsException: Index 4 out of bounds for length 4\n[30817, 25209, 99, 0, 0]\n0\n0\n0\ntrue\ntrue\n[LEFT, RIGHT]\nfalse\n[LEFT, RIGHT]\ntrue\n',
  },
  {
    name: 'explicit ArrayList capacities allocate storage and preserve JVM size errors',
    source: `fun main() {
    for (capacity in listOf(Int.MAX_VALUE, Int.MAX_VALUE - 1, Int.MAX_VALUE - 2, -1, 0, 12)) {
        try { println(ArrayList<Int>(capacity).size) } catch (e: Exception) { println(e) } catch (e: Error) { println(e) }
    }
}`,
    stdout:
      'java.lang.OutOfMemoryError: Requested array size exceeds VM limit\njava.lang.OutOfMemoryError: Requested array size exceeds VM limit\njava.lang.OutOfMemoryError: Java heap space\njava.lang.IllegalArgumentException: Illegal Capacity: -1\n0\n0\n',
  },
  {
    name: 'fixed JVM lists and their views read only the first element before rejecting insertion',
    source: `class Source : Collection<String> by listOf("new", "second") {
    override val size: Int get() { println("size"); return 2 }
    override fun iterator(): Iterator<String> = ReadingIterator()
}
class ReadingIterator : Iterator<String> {
    var visits = 0
    override fun hasNext(): Boolean { println("has"); return visits < 2 }
    override fun next(): String { visits++; println("next $visits"); return "new" }
}
fun main() {
    for (values in listOf(listOf("x"), listOf("x", "y"), arrayOf("x").asList())) {
        val list = values as MutableList<String>
        println(list.addAll(emptyList()))
        println(list.addAll(0, emptyList()))
        try { list.addAll(-1, emptyList()) } catch (e: Exception) { println(e) }
        try { list.addAll(Source()) } catch (e: Exception) { println(e) }
        try { list.addAll(0, Source()) } catch (e: Exception) { println(e) }
        val view = list.subList(0, list.size)
        println(view.addAll(0, emptyList()))
        try { view.addAll(Source()) } catch (e: Exception) { println(e) }
        try { view.addAll(0, Source()) } catch (e: Exception) { println(e) }
        println(list)
    }
    val fixed = buildList { add("z") } as MutableList<String>
    try { fixed.addAll(emptyList()) } catch (e: Exception) { println(e) }
}`,
    stdout:
      'false\nfalse\njava.lang.IndexOutOfBoundsException: Index: -1, Size: 1\nhas\nnext 1\njava.lang.UnsupportedOperationException\nhas\nnext 1\njava.lang.UnsupportedOperationException\nfalse\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\n[x]\nfalse\nfalse\njava.lang.IndexOutOfBoundsException: Index: -1, Size: 2\nhas\nnext 1\njava.lang.UnsupportedOperationException\nhas\nnext 1\njava.lang.UnsupportedOperationException\nfalse\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\n[x, y]\nfalse\nfalse\njava.lang.IndexOutOfBoundsException: Index: -1, Size: 1\nhas\nnext 1\njava.lang.UnsupportedOperationException\nhas\nnext 1\njava.lang.UnsupportedOperationException\nfalse\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\nsize\nhas\nnext 1\njava.lang.UnsupportedOperationException\n[x]\njava.lang.UnsupportedOperationException\n',
  },
  {
    name: 'reversed searches and removals respect the iterator and singleton mutability',
    source: `class Search(private val edit: () -> Unit = {}, private val matches: Boolean = false) {
    override fun equals(other: Any?): Boolean { edit(); return matches }
}
fun main() {
    for (operation in 0..3) {
        val items = mutableListOf(Search(), Search())
        val reverse = items.asReversed()
        val query = Search({ items.add(Search()) }, operation == 3)
        try {
            when (operation) {
                0 -> println(reverse.indexOf(query))
                1 -> println(reverse.lastIndexOf(query))
                else -> println(reverse.remove(query))
            }
        } catch (e: ConcurrentModificationException) { println("concurrent") }
        println(items.size)
    }
    val singleton = listOf("only") as MutableList<String>
    println(singleton.remove("absent"))
    println(singleton.subList(0, 1).remove("absent"))
    try { singleton.remove("only") } catch (e: UnsupportedOperationException) { println("immutable") }
}`,
    stdout: 'concurrent\n3\nconcurrent\n3\nconcurrent\n3\nconcurrent\n3\nfalse\nfalse\nimmutable\n',
  },
  {
    name: 'top-level and qualified property calls fall through same-named function overloads',
    source: `package calls
val scale: (Int) -> Int = { it * 10 }
fun scale(a: Int, b: Int) = a + b
val twice: (Int) -> Int = { it * 2 }
fun twice(s: String) = s + s
val prefer: (Int) -> String = { "property $it" }
fun prefer(i: Int) = "function $i"
class K {
    fun scale(s: String) = s
    fun run() = scale(2)
}
fun main() {
    println(scale(2))
    println(scale(2, 5))
    println(twice(4))
    println(twice("a"))
    println(prefer(5))
    println(K().run())
    println(calls.scale(3))
    println(calls.scale(3, 4))
}`,
    stdout: '20\n7\n8\naa\nfunction 5\n20\n30\n7\n',
  },
  {
    name: 'function properties preserve member and extension levels on nullable and non-null receivers',
    source: `class Item {
    fun implicit() = format("inside")
}
val Item.format: (String) -> String
    get() = { "property $it" }
fun Item.format(value: String) = "function $value"

val Item?.label: (Int) -> String
    get() = { if (this == null) "null $it" else "item $it" }
fun Item?.label(value: String) = "function $value"

class Both {
    val choose: (Int) -> String = { "member $it" }
}
val Both.choose: (String) -> String
    get() = { "extension $it" }
fun main() {
    println(Item().format("outside"))
    println(Item().implicit())
    val missing: Item? = null
    println(missing.label(2))
    println(missing.label("word"))
    println(Both().choose(4))
    println(Both().choose("word"))
}`,
    stdout: 'function outside\nfunction inside\nnull 2\nfunction word\nmember 4\nextension word\n',
  },
  {
    name: 'function properties resolve by applicability among member and extension functions',
    source: `class D {
    val format: (String) -> String
        get() {
            print("get ")
            return { "<$it>" }
        }
    fun format(a: Int, b: Int) = "$a$b"
    fun run() = format("implicit")
    val same: (String) -> String = { "property $it" }
    fun same(s: String) = "method $s"
}
fun D.format(s: String) = "extension $s"
fun D.format(s: Boolean) = "extension $s"
class C {
    val go: (Int) -> Int = { it * 10 }
    fun go() = 1
    fun go(a: Int, b: Int) = a + b
    fun t() = go(2)
}
class Other {
    val same = same("getter")
    fun same(s: String) = "method $s"
}
fun main() {
    val d = D()
    println(d.format(1, 2))
    println(d.format("explicit"))
    println(d.format(true))
    println(d.run())
    println(d.same("priority"))
    println(C().t())
    println(Other().same)
    val missing: D? = null
    println(missing?.format("safe"))
}`,
    stdout: '12\nget <explicit>\nextension true\nget <implicit>\nmethod priority\n20\nmethod getter\nnull\n',
  },
  {
    name: 'local function calls fall through by applicability and unsigned values use JVM boxing',
    source: `fun add(x: Int): Int = 100 + x
fun display(x: Int): String = "number $x"
class Calls {
    fun go(x: Int): Int = x + 1
    fun run(): Int {
        val go: (Int, Int) -> Int = { a, b -> a * b }
        return go(4)
    }
}
fun main() {
    val add: (Int, Int) -> Int = { a, b -> a * b }
    println(add(2, 3))
    println(add(2))
    println(mutableListOf(1).apply { add(2) })
    println(Calls().run())
    val display: (String) -> String = { "text $it" }
    println(display(2))
    println(display("x"))
    println(display(x = 3))
    val byte: UByte = 255u
    val short: UShort = 65_535u
    val long = 18_446_744_073_709_551_615uL
    val a: Any = byte
    val b: Any = byte
    val c: Any = 1u.toUShort()
    val d: Any = 1u.toUShort()
    println(a === b)
    println(c === d)
    println(byte.hashCode())
    println(short.hashCode())
    println(long.toUByte())
    println(long.toUShort())
    println(long.toUInt())
    println(byte.toULong())
    println(0x1_FFFFu.toUShort())
    println(byte.toByte())
    println(short.toShort())
}`,
    stdout:
      '6\n102\n[1, 2]\n5\nnumber 2\ntext x\nnumber 3\nfalse\nfalse\n-1\n-1\n255\n65535\n4294967295\n255\n65535\n-1\n-1\n',
  },
  {
    name: 'exactly-once scope lambdas initialize deferred vals',
    source: `fun main() {
    val first: Int
    run { first = 3 }
    println(first)
    val second: String
    "hello".let { second = it }
    println(second)
    val nested: Int
    Unit.apply { Unit.also { run { nested = 5 } } }
    println(nested)
    val dependent: String
    val received = with("a") {
        dependent = this
        dependent + "b"
    }
    println(received + dependent)
}`,
    stdout: '3\nhello\n5\naba\n',
  },
  {
    name: 'builder resize restores encoded capacity after reentrant recoding',
    source: `class ResizeSource(val builder: StringBuilder) : CharSequence by "xy" {
    override fun get(index: Int): Char {
        if (index == 0) builder.setCharAt(0, 'λ')
        return "xy"[index]
    }
}
fun main() {
    for (size in listOf(4, 5, 6)) {
        val builder = StringBuilder(2).append("abc")
        builder.insert(1, ResizeSource(builder))
        builder.setLength(size)
        println(builder.toString().map { it.code })
    }
}`,
    stdout: '[30817, 25209, 99, 0]\n[30817, 25209, 99, 0, 0]\n[30817, 25209, 99, 0, 0, 0]\n',
  },
  {
    name: 'builder materialization checks recoded storage only when compaction is possible',
    source: `class RecodeSource(val builder: StringBuilder, val overwrite: Boolean) : CharSequence by "xy" {
    override fun get(index: Int): Char {
        if (index == 0) {
            if (overwrite) builder.setCharAt(0, 'λ')
            else builder.clear().append('λ')
        }
        return "xy"[index]
    }
}
fun main() {
    for (insert in listOf(false, true)) for (overwrite in listOf(false, true)) {
        val builder = StringBuilder(3).append("abc")
        val source = RecodeSource(builder, overwrite)
        if (insert) builder.insert(1, source) else builder.append(source)
        try { println(builder.toString()) } catch (e: Exception) { println(e) }
    }
}`,
    stdout:
      'java.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\njava.lang.StringIndexOutOfBoundsException: Range [0, 0 + 5) out of bounds for length 4\n',
  },
  {
    name: 'builder insert and appendLine honor their typed arguments and callbacks',
    source: `class Change(private val action: () -> Unit, private val label: String) {
    override fun toString(): String {
        action()
        return label
    }
}
class Letters : CharSequence {
    override val length: Int get() { print("length "); return 3 }
    override fun get(index: Int): Char = "abc"[index]
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = "abc".substring(startIndex, endIndex)
    override fun toString(): String = "label"
}
fun main() {
    val append = StringBuilder("a")
    append.insert(0, Change({ append.append("b") }, "x"))
    println(append)
    val clear = StringBuilder("a")
    clear.insert(0, Change({ clear.clear() }, "y"))
    println(clear)
    val chars = charArrayOf('x', 'y')
    println(StringBuilder("ab").insert(1, chars))
    println(StringBuilder().appendLine(chars).append('!'))
    println(StringBuilder().appendLine(Letters()).append('!'))
    println(StringBuilder("xy").insert(1, Letters()))
}`,
    stdout: 'xab\ny\naxyb\nxy\n!\nlength length abc\n!\nlength length xabcy\n',
  },
  {
    name: 'PrintStream formatting publishes each field before formatting the next one',
    source: `import java.util.*

class Formatting {
    override fun toString(): String {
        print("inside ")
        return "value"
    }
}
fun main() {
    try { System.out.printf("before: %s; %d", "ok", "bad") }
    catch (error: IllegalFormatConversionException) { println("caught") }
    try { System.out.printf("missing %s %d", "argument") }
    catch (error: MissingFormatArgumentException) { println("caught") }
    try { System.out.printf("unknown %z", "argument") }
    catch (error: UnknownFormatConversionException) { println("caught") }
    System.out.printf("start %s end%n", Formatting())
    println("start %s end".format(Formatting()))
    System.err.printf("discarded %d", 1)
}`,
    stdout: 'before: ok; caught\nmissing argument caught\ncaught\nstart inside value end\ninside start value end\n',
  },
  {
    name: 'map set and map view rendering detects concurrent changes through iterators',
    source: `class EntryText(private val change: () -> Unit, private val name: String) {
    override fun toString(): String { change(); return name }
}
fun main() {
    val map = linkedMapOf<Int, Any>()
    map[1] = EntryText({ map.remove(2) }, "one")
    map[2] = "two"
    try { println(map) } catch (error: ConcurrentModificationException) { println("map modified") }

    val set = linkedSetOf<Any>()
    set.add(EntryText({ set.clear() }, "one"))
    set.add("two")
    try { println(set) } catch (error: ConcurrentModificationException) { println("set modified") }

    val backing = linkedMapOf<Int, Any>()
    backing[1] = EntryText({ backing.clear() }, "one")
    backing[2] = "two"
    try { println(backing.values) } catch (error: ConcurrentModificationException) { println("values modified") }

    val own = linkedMapOf<Int, Any>()
    own[1] = own
    println(own)
}`,
    stdout: 'map modified\nset modified\nvalues modified\n{1=(this Map)}\n',
  },
  {
    name: 'Comparable values use closed and half-open ranges',
    source: `class Score(val number: Int) : Comparable<Score> {
    override fun compareTo(other: Score): Int = number.compareTo(other.number)
    override fun toString(): String = number.toString()
}
fun main() {
    val letters = "a".."c"
    println(letters)
    println("b" in letters)
    println("c" in "a"..<"c")
    println(("w".."a") == ("z".."b"))
    println(("w"..<"a").hashCode())
    val ranks = Score(1)..Score(3)
    println(Score(2) in ranks)
    println(Score(3) in (Score(1)..<Score(3)))
    val letter = "b"
    when (letter) {
        in "a".."d" -> println("inside")
        else -> println("outside")
    }
}`,
    stdout: 'a..c\ntrue\nfalse\ntrue\n-1\ntrue\nfalse\ninside\n',
  },
  {
    name: 'null equality callbacks and floating point format precision match the JVM',
    source: `var comparisons = 0
class Key {
    override fun equals(other: Any?): Boolean { comparisons++; return false }
    override fun hashCode(): Int = 0
}
fun equal(first: Any?, second: Any?): Boolean = first == second
fun direct(first: Any?): Boolean = first == (null)
fun main() {
    val key = Key()
    println(listOf<Any?>(null, "x").contains(key))
    println(comparisons)
    comparisons = 0
    val map = hashMapOf<Any?, Int>(null to 1)
    println(map[key])
    println(comparisons)
    comparisons = 0
    println(equal(key, null))
    println(direct(key))
    println(comparisons)
    println("[%.2f] [%8.1f] [%-6.3E] [%.0g]".format(null as Any?, null, null, null))
}`,
    stdout: 'false\n2\nnull\n1\nfalse\nfalse\n1\n[nu] [       n] [NUL   ] []\n',
  },
  {
    name: 'rendering uses the original builder buffer and live fixed-size views',
    source: `class Element(private val mutate: () -> Unit) {
    override fun toString(): String { mutate(); return "item" }
}
fun main() {
    buildList<Any> {
        val list = this
        add(Element { repeat(20) { list.add(it) }; list[1] = "changed" })
        add("last")
        println(this)
        println(this[1])
    }
    buildList<Any> {
        val list = this
        add(Element { repeat(20) { list.add(it) }; list.clear() })
        add("last")
        println(this)
        println(size)
    }

    val array = arrayOf<Any>("before", "old", "after")
    array[0] = Element { array[1] = "changed" }
    println(array.asList().subList(0, 2))
    println(array[1])
    val fixed = listOf<Any>("before", "old", "after") as MutableList<Any>
    fixed[0] = Element { fixed[1] = "changed" }
    println(fixed.subList(0, 2))
    println(fixed[1])
}`,
    stdout: '[item, last]\nchanged\n[item, last]\n0\n[item, changed]\nchanged\n[item, changed]\nchanged\n',
  },
  {
    name: 'set insertion follows the source iterator and keeps partial changes',
    source: `class SourceIterator(private val target: Set<Int>) : Iterator<Int> {
    private var count = 0
    override fun hasNext(): Boolean = count < 3
    override fun next(): Int {
        println(target)
        if (count == 2) error("done")
        count++
        return count
    }
}
class Source(private val target: Set<Int>) : Collection<Int> by listOf(1, 2, 3) {
    override fun iterator(): Iterator<Int> = SourceIterator(target)
}

fun main() {
    val target = mutableSetOf<Int>()
    val earlier = target.iterator()
    try { target.addAll(Source(target)) } catch (error: IllegalStateException) { println(error.message) }
    println(target)
    try { earlier.next() } catch (error: ConcurrentModificationException) { println("modified") }
}`,
    stdout: '[]\n[1]\n[1, 2]\ndone\n[1, 2]\nmodified\n',
  },
  {
    name: 'delegated non-Int removes can coexist with nullable overloads',
    source: `class Floating(private val values: MutableList<Double>) : MutableList<Double> by values {
    fun remove(value: Double?): Boolean = value == null
}
class Wide(private val values: MutableSet<Long>) : MutableSet<Long> by values {
    fun remove(value: Long?): Boolean = value == null
}
fun main() {
    val doubles = Floating(mutableListOf(1.0))
    println(doubles.remove(null))
    val wide = Wide(mutableSetOf(1L))
    println(wide.remove(null))
    val doublesAsList: MutableList<Double> = doubles
    val wideAsSet: MutableSet<Long> = wide
    println(doublesAsList.remove(1.0))
    println(wideAsSet.remove(1L))
}`,
    stdout: 'true\ntrue\ntrue\ntrue\n',
  },
  {
    name: 'bounded types, generated data components, and signed Char progressions',
    source: `enum class Direction { NORTH, SOUTH }
data class Point(val row: Int, val column: Int) {
    fun component1(scale: Int): Int = row * scale
}
fun ordinal(value: Enum<Direction>): Int = value.ordinal
fun start(range: ClosedRange<Int>): Int = range.start
fun main() {
    println(ordinal(Direction.SOUTH))
    println(start(3..5))
    val point = Point(3, 4)
    val (row, column) = point
    println(listOf(row, column, point.component1(2)))
    try { println(CharProgression.fromClosedRange('z', 'a', Int.MIN_VALUE)) }
    catch (error: IllegalArgumentException) { println(error.message) }
    println(CharProgression.fromClosedRange('z', 'v', -2).toList())
}`,
    stdout: '1\n3\n[3, 4, 6]\nStep must be greater than Int.MIN_VALUE to avoid overflow on negation.\n[z, x, v]\n',
  },
  {
    name: 'collection value searches use JVM bucket order and live list slots',
    source: `class Item(val id: Int) {
    override fun equals(other: Any?): Boolean {
        if (other is Item && other.id == 2) error("second bucket")
        return other is Item && id == other.id
    }
    override fun hashCode(): Int = id
}
val values = mutableListOf<Cell>()
class Cell(val id: Int) {
    override fun equals(other: Any?): Boolean {
        if (other is Cell && other.id == 1) values[1] = Cell(9)
        return other is Cell && other.id == id
    }
    override fun hashCode(): Int = id
}
fun main() {
    val hashed = hashMapOf(2 to Item(2), 1 to Item(1))
    println(hashed.containsValue(Item(1)))
    println(Item(1) in hashed.values)
    val linked = linkedMapOf(2 to Item(2), 1 to Item(1))
    try { println(linked.containsValue(Item(1))) } catch (error: IllegalStateException) { println(error.message) }
    values.addAll(listOf(Cell(1), Cell(2), Cell(3)))
    values.removeAt(2)
    println(values.contains(Cell(9)))
    values[1] = Cell(2)
    val view = values.subList(0, 2)
    println(view.indexOf(Cell(9)))
}`,
    stdout: 'true\ntrue\nsecond bucket\ntrue\n1\n',
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
    name: 'drop skips whole collections and reads list suffixes in JVM order',
    source: `class DropProbe(private val values: List<Int>) : List<Int> by values {
    override val size: Int get() { println("size"); return values.size }
    override fun isEmpty(): Boolean { println("isEmpty"); return values.isEmpty() }
    override fun get(index: Int): Int { println("get $index"); return values[index] }
    override fun iterator(): Iterator<Int> { println("iterator"); return values.iterator() }
    override fun listIterator(index: Int): ListIterator<Int> { println("listIterator $index"); return values.listIterator(index) }
}
class RandomDrop(private val list: DropProbe) : List<Int> by list, RandomAccess
fun main() {
    val list = DropProbe(listOf(0, 1, 2, 3))
    println(list.drop(4))
    println(list.drop(3))
    println(list.drop(2))
    println(RandomDrop(list).drop(2))
    println((0..3).drop(2))
    val large = IntArray(150000).asList()
    println(large.drop(150000).size)
}`,
    stdout:
      'size\n[]\nsize\nisEmpty\nsize\nget 3\n[3]\nsize\nlistIterator 2\n[2, 3]\nsize\nsize\nget 2\nget 3\n[2, 3]\n[2, 3]\n0\n',
  },
  {
    name: 'zip sizes and traverses iterable and array operands in JVM order',
    source: `class ZipIterator(private val id: Int, private val values: Iterator<Int>) : Iterator<Int> {
    override fun hasNext(): Boolean = values.hasNext()
    override fun next(): Int { println("next $id"); return values.next() }
}
class ZipSource(val id: Int) : Collection<Int> by listOf(1, 2) {
    override val size: Int get() { println("size $id"); return 2 }
    override fun iterator(): Iterator<Int> {
        println("iterator $id")
        return ZipIterator(id, listOf(1, 2).iterator())
    }
}
fun main() {
    println(ZipSource(1).zip(ZipSource(2)))
    println(ZipSource(3).zip(ZipSource(4)) { a, b -> a + b })
    println(ZipSource(5).zip(arrayOf("a")))
    println(intArrayOf(10).zip(ZipSource(6)) { a, b -> a + b })
}`,
    stdout:
      'iterator 1\niterator 2\nsize 1\nsize 2\nnext 1\nnext 2\nnext 1\nnext 2\n[(1, 1), (2, 2)]\niterator 3\niterator 4\nsize 3\nsize 4\nnext 3\nnext 4\nnext 3\nnext 4\n[2, 4]\nsize 5\niterator 5\nnext 5\nnext 5\n[(1, a)]\nsize 6\niterator 6\nnext 6\nnext 6\n[11]\n',
  },
  {
    name: 'map predicates check emptiness before accessing entries',
    source: `class MapProbe(private val data: Map<Int, Int>) : Map<Int, Int> by data {
    override fun isEmpty(): Boolean { println("empty"); return data.isEmpty() }
    override val entries: Set<Map.Entry<Int, Int>>
        get() { println("entries"); return data.entries }
}
fun main() {
    for (map in listOf(MapProbe(emptyMap()), MapProbe(mapOf(1 to 2, 3 to 4)))) {
        println(map.any())
        println(map.none())
        println(map.any { it.value == 2 })
        println(map.all { it.value == 2 })
        println(map.none { it.value == 2 })
        println(map.count { it.value == 2 })
    }
}`,
    stdout:
      'empty\nfalse\nempty\ntrue\nempty\nfalse\nempty\ntrue\nempty\ntrue\nempty\n0\nempty\ntrue\nempty\nfalse\nempty\nentries\ntrue\nempty\nentries\nfalse\nempty\nentries\nfalse\nempty\nentries\n1\n',
  },
  {
    name: 'empty collection factories and empty map views share JVM singletons',
    source: `fun main() {
    val list = emptyList<Int>()
    val set = emptySet<Int>()
    val map = emptyMap<Int, Int>()
    println(list === emptyList<Int>())
    println(set === emptySet<Int>())
    println(map === emptyMap<Int, Int>())
    println(list === listOf<Int>())
    println(set === setOf<Int>())
    println(map === mapOf<Int, Int>())
    println(set === map.keys)
    println(map.values === list)
    println(map.entries === emptySet<Map.Entry<Int, Int>>())
    println(emptyList<Int>() === listOf(1).drop(1))
    println(mutableListOf<Int>() === mutableListOf<Int>())
    println(mutableSetOf<Int>() === mutableSetOf<Int>())
    println(mutableMapOf<Int, Int>() === mutableMapOf<Int, Int>())
}`,
    stdout: 'true\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse\nfalse\nfalse\n',
  },
  {
    name: 'map toList selects its result from the actual entry iterator',
    source: `class ConversionMap(private val data: Map<Int, Int>, private val reportedSize: Int) : Map<Int, Int> by data {
    override val size: Int get() { println("size"); return reportedSize }
    override val entries: Set<Map.Entry<Int, Int>>
        get() { println("entries"); return data.entries }
}
fun main() {
    println(ConversionMap(emptyMap(), 0).toList())
    println(ConversionMap(emptyMap(), 1).toList())
    val fixed = ConversionMap(mutableMapOf(1 to 2), 2).toList() as MutableList<Pair<Int, Int>>
    try { fixed.add(3 to 4) } catch (error: UnsupportedOperationException) { println("fixed") }
    println(fixed)
    val copied = ConversionMap(mapOf(1 to 2, 3 to 4), 2).toList() as MutableList<Pair<Int, Int>>
    copied.add(5 to 6)
    println(copied)
}`,
    stdout:
      'size\n[]\nsize\nentries\n[]\nsize\nentries\nfixed\n[(1, 2)]\nsize\nentries\nsize\n[(1, 2), (3, 4), (5, 6)]\n',
  },
  {
    name: 'sibling inference fills nested generic arguments while preserving concrete components and evaluation order',
    source: `fun key(name: String): String {
    println(name)
    return name
}
fun main() {
    val plain = listOf("c")
    val names = mutableListOf("a", "b")
    println(mapOf("x" to emptyList(), "y" to plain))
    println(mapOf("y" to names, "x" to emptyList()))
    val mutable = mutableMapOf("x" to mutableListOf(), "y" to names)
    mutable["x"]?.add("z")
    println(mutable)
    println(listOf(Pair(1, emptyList()), Pair("y", plain)))
    println(listOf(Pair("y", plain), Pair(1, emptyList())))
    println(mapOf(1 to emptyList(), "y" to plain))
    println(mapOf("y" to plain, 1 to emptyList()))
    println(mapOf("k" to emptySet(), "j" to setOf(1)))
    println(mapOf(key("first") to emptyList(), key("second") to plain))
}`,
    stdout:
      '{x=[], y=[c]}\n{y=[a, b], x=[]}\n{x=[z], y=[a, b]}\n[(1, []), (y, [c])]\n[(y, [c]), (1, [])]\n{1=[], y=[c]}\n{y=[c], 1=[]}\n{k=[], j=[1]}\nfirst\nsecond\n{first=[], second=[c]}\n',
  },
  {
    name: 'type tests on primitive and boxed locals keep their smart casts',
    source: `fun main() {
    val n = 3
    if (n is Int) println(n)
    when (n) {
        is Int -> println(n + 1)
    }
    val a: Any = 5
    if (a is Int) println(a * 2)
}`,
    stdout: '3\n4\n10\n',
  },
  {
    name: 'enum constructor arguments leave the locals of the function that first reads the enum',
    source: `enum class Size(val n: Int) { S(when (1) { 1 -> 5; else -> 6 }) }

fun main() {
    val x = 42
    println(Size.S.n)
    println(x)
}`,
    stdout: '5\n42\n',
  },
  {
    name: 'explicit imports take priority over declarations of the same package',
    source: `import kotlin.math.PI
import kotlin.math.abs

fun abs(x: Int): Int = 42
val PI: Double = 1.0

fun main() {
    println(abs(-1))
    println(PI)
}`,
    stdout: '1\n3.141592653589793\n',
  },
  {
    name: 'floating sign copies handle Int, signed zero, and infinity',
    source: `import kotlin.math.withSign

fun signed(value: Double, sign: Double): Double = value.withSign(sign)
fun floatSigned(value: Float, sign: Float): Float = value.withSign(sign)

fun main() {
    println(3.0.withSign(-1))
    println(3.0f.withSign(-1))
    println(floatSigned(3.0f, -1.0f))
    println(signed(-3.0, 0.0))
    println(signed(0.0, -0.0))
    println(floatSigned(0.0f, -0.0f))
    println(signed(Double.POSITIVE_INFINITY, -1.0))
}`,
    stdout: '-3.0\n-3.0\n-3.0\n3.0\n-0.0\n-0.0\n-Infinity\n',
  },
  {
    name: 'String replacements use JVM character and case matching',
    source: `fun main() {
    println("aAa".replace('A', 'x', ignoreCase = true))
    println("aAa".replace('A', 'x'))
    println("aAa".replaceFirst("A", "x", ignoreCase = true))
    println("aAa".replaceFirst('a', 'x'))
    println("KkK".replaceFirst(oldChar = 'k', newChar = 'x', ignoreCase = true))
    println("𐐀𐐨".replaceFirst("𐐨", "x", ignoreCase = true))
    println("𐐀𐐨".replace("𐐨", "x", ignoreCase = true))
    println("abc".replaceFirst("", "x"))
    println("abc".replaceFirst("q", "x", ignoreCase = true))
}`,
    stdout: 'xxx\naxa\nxAa\nxAa\nxkK\nx𐐨\nxx\nxabc\nabc\n',
  },
  {
    name: 'character extrema check emptiness once and read the first character before the last index',
    source: `class ExtremaSequence(private val value: String) : CharSequence by value {
    override val length: Int get() { println("length"); return value.length }
    override fun get(index: Int): Char {
        println("get $index")
        return value[index]
    }
}
fun main() {
    val empty = ExtremaSequence("")
    println(empty.maxOrNull())
    println(empty.minOrNull())
    try { empty.max() } catch (error: NoSuchElementException) { println("empty max") }
    val text = ExtremaSequence("bac")
    println(text.maxOrNull())
    println(text.minOrNull())
    println(text.min())
}`,
    stdout:
      'length\nnull\nlength\nnull\nlength\nempty max\nlength\nget 0\nlength\nget 1\nget 2\nc\nlength\nget 0\nlength\nget 1\nget 2\na\nlength\nget 0\nlength\nget 1\nget 2\na\n',
  },
  {
    name: 'character sequence conversions use Kotlin length-based paths',
    source: `class CharProbe(private val value: String) : CharSequence by value {
    override val length: Int get() { println("length"); return value.length }
    override fun get(index: Int): Char { println("get $index"); return value[index] }
}
fun main() {
    for (value in listOf("", "x", "xyx")) {
        val sequence = CharProbe(value)
        println(sequence.toList())
        println(sequence.toSet())
    }
}`,
    stdout:
      'length\n[]\nlength\n[]\nlength\nget 0\n[x]\nlength\nget 0\n[x]\nlength\nlength\nlength\nget 0\nlength\nget 1\nlength\nget 2\nlength\n[x, y, x]\nlength\nlength\nlength\nget 0\nlength\nget 1\nlength\nget 2\nlength\n[x, y]\n',
  },
  {
    name: 'slicing calls index collections in JVM order and preserves array kinds',
    source: `class IndexSelection(private val data: List<Int>) : Collection<Int> by data {
    override val size: Int get() { println("size"); return data.size }
    override fun iterator(): Iterator<Int> { println("iterator"); return data.iterator() }
}
@OptIn(ExperimentalUnsignedTypes::class)
fun main() {
    val empty = IndexSelection(emptyList())
    val list = listOf(1, 2, 3)
    val sequence: CharSequence = "abc"
    println(list.slice(empty) is MutableList<*>)
    println(sequence.slice(empty) is String)
    println(arrayOf("a", "b").slice(empty) is MutableList<*>)
    println(intArrayOf(10, 20).sliceArray(empty).contentToString())
    val indices = IndexSelection(listOf(1, 0, 1))
    println(list.slice(indices))
    println(sequence.slice(indices))
    println(arrayOf("a", "b").slice(indices))
    println(arrayOf("a", null).sliceArray(indices).contentToString())
    println(intArrayOf(10, 20).slice(indices))
    println(uintArrayOf(10u, 20u).sliceArray(indices).contentToString())
    try {
        println(intArrayOf(1).slice(listOf(4)))
    } catch (error: ArrayIndexOutOfBoundsException) {
        println(error.message)
    }
}`,
    stdout:
      'size\nfalse\nsize\ntrue\nsize\nfalse\nsize\niterator\n[]\nsize\niterator\n[2, 1, 2]\nsize\niterator\nbab\nsize\niterator\n[b, a, b]\nsize\niterator\n[null, a, null]\nsize\niterator\n[20, 10, 20]\nsize\niterator\n[20, 10, 20]\nIndex 4 out of bounds for length 1\n',
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
    name: 'custom list sorting checks size and writes through its list iterator',
    source: `class LoggedListIterator(private val cursor: MutableListIterator<Int>) : MutableListIterator<Int> by cursor {
    override fun next(): Int {
        val value = cursor.next()
        println("advance $value")
        return value
    }
    override fun set(element: Int) {
        println("write $element")
        cursor.set(element)
    }
}
class SortProbe(private val items: MutableList<Int>) : MutableList<Int> by items {
    override val size: Int get() { println("size"); return items.size }
    override fun iterator(): MutableIterator<Int> { println("iterator"); return items.iterator() }
    override fun listIterator(): MutableListIterator<Int> {
        println("listIterator")
        return LoggedListIterator(items.listIterator())
    }
    override fun set(index: Int, element: Int): Int {
        println("indexed set")
        return items.set(index, element)
    }
}
fun main() {
    SortProbe(mutableListOf()).sort()
    SortProbe(mutableListOf(1)).sortWith(compareBy { it })
    val ascending = mutableListOf(3, 1, 2)
    SortProbe(ascending).sort()
    println(ascending)
    val descending = mutableListOf(1, 3, 2)
    SortProbe(descending).sortWith(compareByDescending { it })
    println(descending)
}`,
    stdout:
      'size\nsize\nsize\nsize\niterator\nlistIterator\nadvance 3\nwrite 1\nadvance 1\nwrite 2\nadvance 2\nwrite 3\n[1, 2, 3]\nsize\nsize\niterator\nlistIterator\nadvance 1\nwrite 3\nadvance 3\nwrite 2\nadvance 2\nwrite 1\n[3, 2, 1]\n',
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
    name: 'sumOf and maxOf pick the Int overload for branches of integer literals',
    source: `fun main() {
    val scores = listOf(1, 2, 3)
    println(scores.sumOf { if (it > 1) 1 else 0 })
    println(scores.maxOf { when (it) { 1 -> 10; else -> 1 } })
    println(scores.sumOf { it.toLong() })
    val counts = mutableMapOf<String, Long>()
    counts["a"] = (counts["a"] ?: 0) + 1
    val total: Long = if (counts.isEmpty()) 0 else counts.getValue("a")
    println("$counts $total \${counts.getOrPut("b") { 0 } + 1L}")
    println(scores.map { if (it > 1) it.toLong() else 0 })
    val fallback: Long = counts.getOrElse("z") { if (scores.size > 1) 5 else 0 }
    println(fallback * 3000000000)
    println(if (scores.size > 5) 3L else { println("side"); 5 })
}`,
    stdout: '2\n10\n6\n{a=1} 1 1\n[0, 2, 3]\n15000000000\nside\n5\n',
  },
  {
    name: 'fun-interface constructors take their type arguments from the call or the expected type',
    source: `import kotlin.properties.ReadOnlyProperty
class A(val n: String) {
    val typed: String by ReadOnlyProperty<A, String> { owner, _ -> owner.n + "!" }
}
val declared: Int by ReadOnlyProperty<Any?, Int> { _, _ -> 1 }
fun main() {
    println(A("a").typed)
    println(declared + 1)
    println(listOf(3, 1, 2).sortedWith(Comparator { a, b -> a - b }))
    val byLength: Comparator<String> = Comparator { a, b -> a.length - b.length }
    println(byLength.compare("a", "bb"))
}`,
    stdout: 'a!\n2\n[1, 2, 3]\n-1\n',
  },
  {
    name: 'smart casts from try survive finally unless finally changes them',
    source: `class Box(val text: String?)
fun main() {
    var box = Box(null)
    try { println(0) } finally { box = Box("abc"); requireNotNull(box.text) }
    println(box.text.length)
    var x: Any = 0
    x = 1
    try { x = "a".repeat(2) } finally { if (x is String) println(x.length) }
    println(x.length)
    var items: Collection<Int> = listOf(1)
    try { items = mutableListOf(2) } finally {}
    items.add(3)
    println(items)
    var y: Any = 0
    try { y = "hello" } finally { y = 5 }
    println(y + 1)
}`,
    stdout: '0\n3\n2\n2\n[2, 3]\n6\n',
  },
  {
    name: 'finally sees assignments before a pending jump',
    source: `fun main() {
    var count = 0
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
    name: 'array single predicates preserve array-specific failures and the matched value',
    source: `fun report(action: () -> Unit) {
    try { action() } catch (e: Exception) { println(e) }
}
fun main() {
    report { arrayOf("a", "b").single { it == "z" } }
    report { intArrayOf(1, 2, 3).single { println(it); it > 0 } }
    println(arrayOf<String?>(null, "present").single { it == null })
    val elements = arrayOf("first", "second")
    println(elements.single {
        if (it == "second") elements[0] = "new"
        it == "first"
    })
}`,
    stdout:
      'java.util.NoSuchElementException: Array contains no element matching the predicate.\n1\n2\njava.lang.IllegalArgumentException: Array contains more than one matching element.\nnull\nfirst\n',
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
    name: 'primary-constructor properties use virtual getters in initializers',
    source: `open class Base(open val x: Int, plain: Int) {
    val snapshot = x
    init { println("base $x plain $plain") }
}
class Child(override val x: Int) : Base(x, x)
fun main() {
    val child = Child(5)
    println("\${child.snapshot} \${child.x}")
}`,
    stdout: 'base 0 plain 5\n0 5\n',
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
    name: 'parentheses change no expression but a callee',
    source: `fun pick(f: (Number) -> Unit, n: Int = 0) { f(3) }
fun pick(f: (Int) -> Unit, s: String = "") { f(4) }
fun show(x: String?, flag: Boolean) {
    if (x?.isNotEmpty() ?: (false)) println(x.length)
    println(when (flag) { (true) -> 1; (false) -> 2 })
}
fun main() {
    show("ab", true)
    val empty = if (false) listOf(1) else (emptyList())
    println(empty)
    println(listOf("bb", "a").maxWithOrNull((compareBy { it.length })))
    pick(({ n: Number -> println(n) }))
    println((31 * 2L).toInt())
    var x = 1
    (x) = 2
    println(x)
    val f = { 5 }
    println((f)())
}`,
    stdout: '2\n1\n[]\nbb\n3\n62\n2\n5\n',
  },
  {
    name: 'conditions implying a non-null safe-call result smart-cast its receivers',
    source: `class Box(val text: String?)
fun show(x: String?, box: Box?, any: Any?) {
    val n = x?.length ?: return
    println(x.length + n)
    if (x?.length is Int) println(x.length)
    if (x?.isNotEmpty() ?: false) println(x.length)
    if (x?.isEmpty() == false) println(x.length)
    if (!box?.text.isNullOrEmpty()) println(box.text.length)
    when (box?.text?.length) { 3 -> println(box.text.length); else -> println(0) }
    requireNotNull(box?.text)
    println(box.text.length)
    val s = any as? String ?: return
    println(any.length + s.length)
}
fun main() { show("ab", Box("xyz"), "q") }`,
    stdout: '4\n2\n2\n2\n3\n3\n3\n2\n',
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

test('requires a return after an indexed assignment ends a non-Unit function', () => {
  expect(
    executeProgram(
      'kotlin',
      'fun value(): Int {\n    val numbers = intArrayOf(0)\n    numbers[0] = 1\n}\nfun main() { println(value()) }'
    )
  ).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 3 }] });
});

test.each(['listOf(1).sumOf { error("stop") }', 'intArrayOf(1).sumOf { throw IllegalArgumentException("stop") }'])(
  'rejects ambiguous selector overloads before running %s',
  (call) => {
    expect(executeProgram('kotlin', `fun main() { println("before"); ${call} }`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: expect.stringContaining('sumOf') }],
    });
  }
);

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

test('encodes JVM stdout and stderr without splitting surrogate pairs across writes', () => {
  const source = `fun main() {
    val high = "😀".take(1)
    val low = "😀".drop(1)
    println(high)
    print(low)
    print(high)
    print(low)
    print(high)
    println("end")
    System.out.print(low)
    System.out.println(high)
    System.err.print(high)
    System.out.print("ignored stderr here")
    System.err.print(low)
    print(high)
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '?\n?😀?end\n??\nignored stderr here',
    stderr: '😀',
    uncaughtException: undefined,
  });
});

test('stops an endless loop at the execution limit', () => {
  expect(executeProgram('kotlin', 'fun main() {\n    var i = 0\n    while (true) i++\n}')).toMatchObject({
    kind: 'limitExceeded',
  });
});

/** Programs with whether kotlinc 2.4.21 compiles them, which decides whether the interpreter may run them. */
test.each([
  [
    'two unrelated interface default functions',
    false,
    'interface A { fun f() = 1 }\ninterface B { fun f() = 2 }\nclass C : A, B\nfun main() {}',
  ],
  [
    'two unrelated interface default properties on an abstract class',
    false,
    'interface A { val x: Int get() = 1 }\ninterface B { val x: Int get() = 2 }\nabstract class C : A, B\nfun main() {}',
  ],
  [
    'unrelated interface and class defaults',
    false,
    'open class A { fun f() = 1 }\ninterface B { fun f() = 2 }\nclass C : A(), B\nfun main() {}',
  ],
  [
    'two concrete overrides of a shared interface root',
    false,
    'interface Base { fun f() = 0 }\ninterface A : Base { override fun f() = 1 }\ninterface B : Base { override fun f() = 2 }\nclass C : A, B\nfun main() {}',
  ],
  [
    'an inherited return type incompatible with an interface contract',
    false,
    'open class A { fun f() = "text" }\ninterface B { fun f(): Int }\nclass C : A(), B\nfun main() {}',
  ],
  [
    'a val inherited as the implementation of an interface var',
    false,
    'open class A { val x = 1 }\ninterface B { var x: Int }\nclass C : A(), B\nfun main() {}',
  ],
  [
    'a write through super to a val',
    false,
    'open class A { val x = 1 }\nclass C : A() { fun change() { super.x = 2 } }\nfun main() {}',
  ],
  [
    'adding a value through a star-projected mutable list',
    false,
    'fun main() { val items: MutableList<*> = mutableListOf(1); items.add("wrong") }',
  ],
  [
    'adding null through a star-projected mutable list',
    false,
    'fun main() { val items: MutableList<*> = mutableListOf(1); items.add(null) }',
  ],
  [
    'writing a read value through a star-projected mutable list',
    false,
    'fun main() { val items: MutableList<*> = mutableListOf(1); items[0] = items[0] }',
  ],
  [
    'assigning through a star-projected Array',
    false,
    'fun main() { val items: Array<*> = arrayOf(1); items[0] = "wrong" }',
  ],
  [
    'writing through a star-projected MutableMap',
    false,
    'fun main() { val items: MutableMap<*, *> = mutableMapOf("key" to 1); items["key"] = "wrong" }',
  ],
  [
    'ambiguous user overloads whose lambda results differ',
    false,
    'fun choose(block: () -> Int, number: Int = 0) { println(block()) }\nfun choose(block: () -> String, text: String = "") { println(block()) }\nfun main() { choose({ 42 }) }',
  ],
  ['reassigning a val initialized in a scope function', false, 'fun main() { val n: Int; run { n = 3 }; n = 4 }'],
  [
    'initializing a val inside an unknown inline invocation',
    false,
    'fun main() { val n: Int; repeat(1) { n = 3 }; println(n) }',
  ],
  [
    'reading a val after a safe call can skip initialization',
    false,
    'fun main() { val text: String? = null; val n: Int; text?.let { n = 3 }; println(n) }',
  ],
  [
    'initializing a val inside a stored lambda',
    false,
    'fun main() { val n: Int; val store = { n = 3 }; store(); println(n) }',
  ],
  ['a cycle between open classes', false, 'open class A : B()\nopen class B : A()\nfun main() {}'],
  ['a cycle between interfaces', false, 'interface A : B\ninterface B : A\nfun main() {}'],
  [
    'a lambda with two parameters of the same name',
    false,
    'fun main() { val f = { x: Int, x: Int -> x }; println(f(1, 2)) }',
  ],
  ['a package-qualified val reassignment', false, 'package demo\nval score = 1\nfun main() { demo.score = 2 }'],
  [
    'a method that clashes with a specialized delegated getter',
    false,
    'class Wrapper(delegate: Lazy<Int>) : Lazy<Int> by delegate { fun getValue(): Int? = 7 }\nfun main() {}',
  ],
  [
    'a generic superclass constructor with incompatible elements',
    false,
    'class Tracked : ArrayList<Int>(listOf("wrong"))\nfun main() {}',
  ],
  [
    'a nullable Int method that clashes with delegated collection remove',
    false,
    'class Ints(private val values: MutableList<Int>) : MutableList<Int> by values {\n    fun remove(value: Int?): Boolean = value == null\n}\nfun main() {}',
  ],
  [
    'an invalid nested range type argument',
    false,
    'fun main() { val invalid: List<ClosedRange<Any>>? = null; println(invalid) }',
  ],
  [
    'an invalid recursive enum bound',
    false,
    'fun invalid(x: Enum<String>?) { println(x) }; fun main() { invalid(null) }',
  ],
  [
    'a function that collides with a generated data component',
    false,
    'data class Point(val x: Int) { fun component1(): String = "x" }; fun main() {}',
  ],
  ['a type mismatch', false, 'fun main() {\n    val x: Int = "a"\n    println(x)\n}'],
  ['a delegated local redeclaring a local', false, 'fun main() { val x = 1; val x by lazy { 2 }; println(x) }'],
  ['a delegated local redeclaring a delegated local', false, 'fun main() { val x by lazy { 1 }; val x by lazy { 2 } }'],
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
    'a setter reading an uninitialized local after a block-bodied getter',
    false,
    `var property: Int = 1
    get() { return field }
    set(value) {
        val missing: Int
        field = missing
    }
fun main() { println("started"); property = 2 }`,
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
  ['fallthrough in a Unit? function', false, 'fun f(): Unit? {}; fun main() { println(f()) }'],
  ['a bare return from a Unit? function', false, 'fun f(): Unit? { return }; fun main() { println(f()) }'],
  [
    'a callback with an incompatible Unit? result',
    false,
    'fun f(block: () -> Unit?) = block(); fun main() { f { 1 } }',
  ],
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
  [
    'a top-level initializer with a computed getter',
    false,
    'val answer: Int = 1\n    get() = 2\nfun main() { println(answer) }',
  ],
  [
    'a top-level initializer whose getter calls a function named field',
    false,
    `fun field(): Int = 3
    val answer: Int = 0
        get() = field()
    fun main() { println(answer) }`,
  ],
  [
    'a member initializer whose getter calls a function named field',
    false,
    `class Sample {
        fun field(): Int = 4
        val value: Int = 0
            get() = field()
    }
    fun main() { println(Sample().value) }`,
  ],
  [
    'an initializer with computed getter and setter',
    false,
    `class Sample {
        var answer: Int = 0
            get() = 2
            set(value) { println(value) }
    }
    fun main() { println(Sample().answer) }`,
  ],
  [
    'an initializer where field is another object’s member',
    false,
    `class Other(val field: Int)
    class Sample(val other: Other) {
        val answer: Int = 0
            get() = other.field
    }
    fun main() { println(Sample(Other(2)).answer) }`,
  ],
  [
    'an initializer where field is a local variable',
    false,
    `val answer: Int = 0
        get() {
            val field = 3
            return field
        }
    fun main() { println(answer) }`,
  ],
  [
    'a nonlocal return from the two-argument map callback',
    false,
    `fun probe(): Int {
        mapOf(1 to 2).forEach { key, value -> return key + value }
        return 0
    }
    fun main() { println(probe()) }`,
  ],
  [
    'a break from outside the two-argument map callback',
    false,
    `fun main() {
        while (true) {
            mapOf(1 to 2).forEach { key, value -> break }
        }
    }`,
  ],
  [
    'an initializer where a do-while condition reads a loop local named field',
    false,
    `val answer: Int = 0
        get() {
            do { val field = 1 } while (field < 0)
            return 2
        }
    fun main() { println(answer) }`,
  ],
  [
    'an initializer where a do-while condition reads the backing field past a nested binding',
    true,
    `val answer: Int = 0
        get() {
            do { run { val field = 1; println(field) } } while (field < 0)
            return 2
        }
    fun main() { println(answer) }`,
  ],
  [
    'an initializer where field is a lambda parameter',
    false,
    `val answer: Int = 0
        get() = listOf(4).sumOf { field: Int -> field }
    fun main() { println(answer) }`,
  ],
  [
    'an explicit setter parameter that differs from the property type',
    false,
    'class Sample { var answer = 1\n    set(value: String) { println(value) } }\nfun main() { Sample() }',
  ],
  [
    'an initializer with a field reference in a nested lambda',
    true,
    'val answer: Int = 2\n    get() = run { field + 3 }\nfun main() { println(answer) }',
  ],
  [
    'an assignment completed by try alone when a catch can finish without it',
    false,
    'fun failure(): Int { throw IllegalStateException() }\nfun main() { var x: Int; try { x = failure() } catch (e: Exception) { println("caught") }; println(x) }',
  ],
  [
    'a smart cast invalidated by a catch branch',
    false,
    `fun main() {
        var text: String? = "ready"
        if (text != null) {
            try { "bad".toInt() } catch (e: NumberFormatException) { text = null }
            println(text.length)
        }
    }`,
  ],
  [
    'a non-Unit function whose sole return is in if (true)',
    false,
    'fun missing(): Int { if (true) return 1 }\nfun main() { println(missing()) }',
  ],
  [
    'a non-Unit function returning only in the constant-true arm of an if',
    false,
    'fun missing(): Int { if (!false) return 1 else println("missing") }\nfun main() { println(missing()) }',
  ],
  ['nextUp without its math import', false, 'fun main() { println(1.0.nextUp()) }'],
  ['Locale without its import', false, 'fun main() {\n    val l: Locale? = null\n}'],
])('decides whether %s compiles as kotlinc does', (_name, compiles, source) => {
  expect(executeProgram('kotlin', source).kind === 'compileError').toBe(!compiles);
});

test('resolves ordinary field calls and callable backing fields in accessors', () => {
  const source = `fun field(): Int = 3
val answer: Int
    get() = field()

class Sample {
    fun field(): Int = 4
    val value: Int
        get() = field()
    var callback: () -> Int = { 5 }
        get() = { field() + 1 }
        set(next) { field = next }
}

fun main() {
    val sample = Sample()
    println(answer)
    println(sample.value)
    println(sample.callback())
    sample.callback = { 7 }
    println(sample.callback())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '3\n4\n6\n8\n' });
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
    'a JVM class implicitly imported by Kotlin',
    'fun main() { println(StringBuffer()) }',
    'Java のクラスの直接の利用（java.lang.StringBuffer）は、この採点環境では使えません。',
  ],
  [
    'a Java method mapped to a mutable Kotlin collection',
    'fun main() { mutableListOf(1).parallelStream() }',
    'MutableList<Int> の parallelStreamは、この採点環境では使えません。',
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
    'standard input through a wildcard import',
    'import java.util.*\nfun main() { println(Scanner(System.`in`).nextInt()) }',
    'Java の Scanner（readln() を使ってください）は、この採点環境では使えません。',
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
    'Java の Scanner（readln() を使ってください）は、この採点環境では使えません。',
  ],
  [
    'standard input through System',
    'fun main() { println(System.`in`.read()) }',
    'Java の System.in（readln() を使ってください）は、この採点環境では使えません。',
  ],
])('rejects %s as unavailable', (_name, source, message) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ message }] });
});

test('resolves nested classes through the superclass and qualified interface names', () => {
  const source = `class Element(val value: Int = 3)
open class Parent { class Element(val value: Int = 4) }
open class Middle : Parent()
interface Contract {
    class Element(val value: Int = 5)
    fun readNested(): Int = Element().value
}
class Child : Parent() { fun read(): Int = Element().value }
class Grandchild : Middle() { fun read(): Int = Element().value }
class Implementation : Contract { fun read(): Int = Element().value }
fun main() {
    println(Child().read())
    println(Grandchild().read())
    println(Implementation().read())
    println(Implementation().readNested())
    println(Contract.Element().value)
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '4\n4\n3\n5\n5\n' });
});

test('validates compile-time annotations and executes value classes and unsigned arrays', () => {
  const source = `import kotlin.ExperimentalUnsignedTypes

@kotlin.jvm.JvmInline()
value class Index(val value: Int)

@kotlin.OptIn(markerClass = [ExperimentalUnsignedTypes::class, kotlin.ExperimentalStdlibApi::class])
fun main() {
    @OptIn(*arrayOf(ExperimentalUnsignedTypes::class))
    val indices = uintArrayOf(1u, 2u)
    println(Index(indices.size))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: 'Index(value=2)\n' });
});

test.each([
  '@OptIn(MissingMarker::class) fun main() {}',
  '@OptIn(123) fun main() {}',
  '@OptIn(String::class) fun main() {}',
  '@OptIn(markers = [ExperimentalUnsignedTypes::class]) fun main() {}',
  '@OptIn(markerClass = ExperimentalUnsignedTypes::class) fun main() {}',
  'class ExperimentalUnsignedTypes\n@OptIn(ExperimentalUnsignedTypes::class) fun main() {}',
  '@OptIn(markerClass = [kotlin.MissingMarker::class]) fun main() {}',
  'fun main() { @OptIn(MissingMarker::class) val answer = 42; println(answer) }',
  '@JvmInline class Index(val value: Int)\nfun main() {}',
  '@JvmInline fun main() {}',
  '@JvmInline(1) value class Index(val value: Int)\nfun main() {}',
])('rejects invalid compile-time annotations in %s', (source) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'compileError' });
});

test('only object arrays support mapNotNull', () => {
  const objectArray = 'fun main() { println(arrayOf(1, null, 2).mapNotNull { it }) }';
  expect(executeProgram('kotlin', objectArray)).toMatchObject({ kind: 'executed', stdout: '[1, 2]\n' });
  for (const array of ['intArrayOf(1, 2)', 'booleanArrayOf(true, false)', 'uintArrayOf(1u, 2u)']) {
    expect(executeProgram('kotlin', `fun main() { println(${array}.mapNotNull { it }) }`)).toMatchObject({
      kind: 'compileError',
    });
  }
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

test("runs Java's default map methods with its null rules, and a map's default for getValue", () => {
  const source = `fun main() {
    val counts = mutableMapOf<String, Int>()
    for (w in "a b a c".split(" ")) counts.merge(w, 1, Int::plus)
    println(counts.merge("c", 1) { _, _ -> null })
    val groups = mutableMapOf<Int, MutableList<String>>()
    for (s in listOf("aa", "b", "cc")) groups.computeIfAbsent(s.length) { mutableListOf() }.add(s)
    println(listOf(counts, groups, counts.putIfAbsent("a", 9), groups.computeIfPresent(9) { _, v -> v }))
    val withDefault = mutableMapOf<String, Int>().withDefault { 0 }
    withDefault["k"] = withDefault.getValue("k") + 1
    println(listOf(withDefault, withDefault["q"], withDefault.getValue("q")))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'null\n[{a=2, b=1}, {2=[aa, cc], 1=[b]}, 2, null]\n[{k=1}, null, 0]\n',
  });
});

test('reads standard input and the files of a run, and leaves the files it writes', () => {
  const source = `import java.io.File
fun main() {
    val count = readln().toInt()
    File("out.txt").writeText("x".repeat(count))
    File("out.txt").appendText("!")
    println(File("in.txt").readLines() + readlnOrNull())
}`;
  expect(executeProgram('kotlin', source, { stdin: '3\n', files: { 'in.txt': 'a\nb\n' } })).toMatchObject({
    kind: 'executed',
    stdout: '[a, b, null]\n',
    finalFiles: { 'in.txt': 'a\nb\n', 'out.txt': 'xxx!' },
  });
});

test('keeps what writers write until they flush or close, and loses what an unclosed writer holds', () => {
  const source = `import java.io.File
fun main() {
    val printed = File("printed.txt")
    val writer = printed.printWriter()
    writer.println("x")
    println(printed.readText().length)
    writer.close()
    writer.println("after close")
    val buffered = File("buffered.txt").bufferedWriter()
    buffered.write("hello")
    buffered.close()
    try { buffered.write("!") } catch (e: java.io.IOException) { println(e.message) }
    File("lost.txt").bufferedWriter().write("never flushed")
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '0\nStream closed\n',
    finalFiles: { 'printed.txt': 'x\n', 'buffered.txt': 'hello', 'lost.txt': '' },
  });
});

test.each([
  ['a local function', 'fun main() {\n  fun local(x: Int) = x + 100; println(local(1))\n}', false],
  ['an anonymous function', 'fun main() {\n  val f = fun(x: Int) = x + 1; println(f(1))\n}', false],
  ['a block body', 'fun main() {\n  fun local(x: Int): Int { return x }; println(local(1))\n}', true],
  ['a semicolon at the end of the row', 'fun main() {\n  fun local(x: Int) = x;\n  println(local(1))\n}', true],
  ['top-level functions', 'fun top() = 1; fun main() { println(top()) }', true],
])('compiles a statement after %s on the row of its semicolon only when kotlinc does', (_name, source, compiles) => {
  expect(executeProgram('kotlin', source).kind === 'compileError').toBe(!compiles);
});

const SUSPEND_LOG = `var log = ""
suspend fun f(x: Int): Int { log += "f$x "; return x }
fun g(x: Int): Int { log += "g$x "; return x }
`;

test.each([
  ['an operand before a suspend call', 'println(g(1) + f(2))', '3\ng1 f2 \n'],
  ['a variable read before a suspend call changes it', 'println(log.length + f(1))', '1\nf1 \n'],
  ['a destructuring declaration', 'val (a, b) = Pair(f(1), f(2))\n    println(a + b)', '3\nf1 f2 \n'],
  [
    'indexed and compound assignments',
    'val a = intArrayOf(0, 0)\n    a[g(1)] = f(5)\n    a[0] += f(3)\n    println(a.toList())',
    '[3, 5]\ng1 f5 f3 \n',
  ],
  ['short-circuit operators', 'println(f(1) > 0 && f(2) > 5 || f(3) == 3)', 'true\nf1 f2 f3 \n'],
  [
    'when with a subject variable and a value',
    'when (val r = f(2)) { 2 -> println("two $r") else -> println("other") }\n    println(when (f(3)) { 3 -> f(30) else -> 0 })',
    'two 2\n30\nf2 f3 f30 \n',
  ],
  [
    'when whose type tests smart-cast its subject',
    'val v: Any = "abc"\n    println(when (v) { is Int -> f(v + 1); is String -> f(v.length); else -> 0 })',
    '3\nf3 \n',
  ],
  [
    'when whose every branch returns',
    'suspend fun sign(x: Int): Int { when (x) { 0 -> return f(0); else -> return f(x / kotlin.math.abs(x)) } }\n    println(sign(-3))',
    '-1\nf-1 \n',
  ],
  [
    'try as a value',
    'val x = try { f(1) / 0 } catch (e: ArithmeticException) { f(7) } finally { g(9) }\n    println(x)',
    '7\nf1 f7 g9 \n',
  ],
  [
    'loop conditions',
    'var i = 0\n    while (f(i) < 2) i++\n    do { i-- } while (f(i) > 0)\n    println(i)',
    '0\nf0 f1 f2 f1 f0 \n',
  ],
  [
    'inline lambdas with labeled returns',
    'println(listOf(1, 2, 3).map { if (it == 2) return@map 0; it + f(it) })',
    '[2, 0, 6]\nf1 f3 \n',
  ],
  [
    'inline lambdas chosen by their result type',
    'println(listOf(1, 2, 3).filter { f(it) % 2 == 1 }.sumOf { f(it * 10) })',
    '40\nf1 f2 f3 f10 f30 \n',
  ],
  [
    'safe calls and assignments',
    'val b: StringBuilder? = null\n    println(b?.append(f(1)))\n    val c: StringBuilder? = StringBuilder()\n    println(c?.append(f(2)))',
    'null\n2\nf2 \n',
  ],
])("runs suspend calls in %s in kotlinc's order", (_name, body, stdout) => {
  const source = `${SUSPEND_LOG}suspend fun main() {
    ${body}
    print(log)
    println()
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout });
});

test("reads the variables of the enclosing function in local classes' initializers and constructors", () => {
  const source = `fun main() {
    val seed = 7
    val o = object { val v = seed }
    class C(val x: Int) { val v = seed + x; constructor() : this(seed) }
    println(listOf(o.v, C(1).v, C().v))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[7, 8, 14]\n' });
});

test('chooses overloads and infers result types from the callable references calls pass', () => {
  const source = `fun len(s: String) = s.length
fun main() {
    println(listOf("a", "bb").map(String::length))
    println(listOf("a", "bb").map(::len))
    println(" x ".let(String::trim))
    println(listOf("ab", "c").sumOf(String::length))
    println(pick(String::length))
    println(doubled(4))
    val five = 5
    println(listOf((five::toString)(), (five::inc)()))
}
val doubled = ::twiceOf
fun twiceOf(x: Int) = x * 2
fun pick(f: (String) -> Int) = 1
fun pick(f: (String, Int) -> Int) = 2`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2]\n[1, 2]\nx\n3\n1\n8\n[5, 6]\n',
  });
});

test('initializes an enum entry with a body once, with the arguments it passes', () => {
  const source = `enum class P(val n: Int) {
    X(1) { override fun d() = "x$n" };
    init { println("init $n") }
    abstract fun d(): String
}
fun main() { println(P.X.d()) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: 'init 1\nx1\n' });
});

test('keeps what local functions and classes captured in lambdas that outlive the block declaring them', () => {
  const source = `fun main() {
    val xs = mutableListOf<() -> Int>()
    for (i in 1..2) {
        class K { fun v() = i }
        fun fact(k: Int): Int {
            return if (k <= 1) i else k * fact(k - 1)
        }
        xs.add { K().v() * 100 + fact(3) }
    }
    println(xs.map { it() })
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[106, 212]\n' });
});

test.each([
  ['String::length', true],
  ['String::uppercase', false],
])('checks the function type of %s passed for a fun interface', (reference, compiles) => {
  const source = `fun interface S { fun m(s: String): Int }
fun use(s: S) = s.m("abc")
fun main() { println(use(${reference})) }`;
  expect(executeProgram('kotlin', source).kind).toBe(compiles ? 'executed' : 'compileError');
});

test('calls values through invoke operators declared as extensions', () => {
  const source = `class A(val n: Int)
operator fun A.invoke(x: Int): Int = n + x
operator fun String.invoke(k: Int) = repeat(k)
fun main() {
    val a = A(1)
    println(a(2))
    println("ab"(2))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '3\nabab\n' });
});

test('finds and merges the elements of sorted sets and maps by their order, as java.util.TreeSet and TreeMap do', () => {
  const source = `fun main() {
    val t = sortedSetOf(5, 2, 9, 7)
    println(listOf(t.ceiling(3), t.floor(3), t.higher(7), t.lower(2)))
    println(t.descendingSet())
    println(t.subSet(2, false, 7, true))
    println(listOf(t.pollFirst(), t.pollLast()))
    println(t)
    val parity = Comparator<Int> { a, b -> a % 2 - b % 2 }
    val odd = sortedSetOf(parity, 1, 3)
    println(listOf(odd, odd.add(5), odd.contains(7)))
    val m = sortedMapOf(parity, 1 to "a", 3 to "b")
    println(listOf(m, 5 in m.keys, odd == setOf(7)))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '[5, 2, 9, null]\n[9, 7, 5, 2]\n[5, 7]\n[2, 9]\n[5, 7]\n[[1], false, true]\n[{1=b}, true, true]\n',
  });
});

test("gives views of sorted sets and maps that read and write them, as java.util's do", () => {
  const source = `fun main() {
    val s = sortedSetOf(3, 1, 2)
    val head = s.headSet(3)
    val descending = s.descendingSet()
    s.add(0)
    val tail = s.tailSet(2)
    tail.add(7)
    println(listOf(head, descending, s))
    try { tail.add(0) } catch (e: Exception) { println(e) }
    val m = sortedMapOf(1 to "a", 2 to "b")
    val headMap = m.headMap(2)
    m[0] = "z"
    println(headMap)
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[[0, 1, 2], [7, 3, 2, 1, 0], [0, 1, 2, 3, 7]]\njava.lang.IllegalArgumentException: key out of range\n{0=z, 1=a}\n',
  });
});

test('removes elements of sorted sets by their order after their hash codes change', () => {
  const source = `data class P(val name: String, var score: Int)
fun main() {
    val s = sortedSetOf(compareBy<P> { it.name }, P("a", 1), P("b", 2))
    s.first().score = 9
    println(listOf(s.pollFirst(), s.size))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[P(name=a, score=9), 1]\n' });
});

test('looks keys up in sorted sets and maps within the operation limit', () => {
  const source = `fun main() {
    val s = sortedSetOf<Int>()
    val m = sortedMapOf<Int, Int>()
    for (i in 0 until 100) { s.add(i); m[i] = i }
    var count = 0
    for (i in 0 until 5000) if (i % 100 in s && m[i % 100] == i % 100) count++
    println(count)
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '5000\n' });
});

test("gives regexes Kotlin/JVM's options, escapes, and errors", () => {
  const source = `fun main() {
    println(Regex("É", RegexOption.IGNORE_CASE).matches("é"))
    println(Regex("b", RegexOption.IGNORE_CASE).options.size)
    println(Regex(Regex.escape("a\\\\Eb")).matches("a\\\\Eb"))
    try { Regex("a").find("aaa", 9) } catch (e: Exception) { println(e) }
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n1\ntrue\njava.lang.IndexOutOfBoundsException: Illegal start index\n',
  });
});

test.each([
  ["the library's constants", 'const val M = Int.MAX_VALUE + 0L\nfun main() { println(M) }', true],
  [
    'the types of constants',
    "const val B: Boolean = true\nconst val C: Char = 'x'\nfun main() { println(listOf(B, C)) }",
    true,
  ],
  ['a type that may be null', 'const val Y: Int? = 1\nfun main() { println(Y) }', false],
  ['a lateinit Boolean', 'class A { lateinit var b: Boolean }\nfun main() { println(1) }', false],
  [
    'an override whose extension receiver differs',
    'open class B { open fun String.f() = "b" }\nclass S : B() { override fun Int.f() = "s" }\nfun main() { println(1) }',
    false,
  ],
  ['a type that is not primitive', 'const val X: Any = 1\nfun main() { println(X) }', false],
])('compiles const vals of %s only as kotlinc does', (_name, source, compiles) => {
  expect(executeProgram('kotlin', source).kind).toBe(compiles ? 'executed' : 'compileError');
});

test.each([
  ['a modifier of classes on a function', 'sealed fun f() = 1\nfun main() { println(f()) }', false],
  ['a modifier of functions on a class', 'suspend class A\nfun main() { println(1) }', false],
  ['a getter less visible than its property', 'class A { var x = 0; private get }\nfun main() { println(1) }', false],
  [
    'modifiers on the declarations they apply to',
    'data object O\nclass D { companion object { const val K = 1 } }\nfun main() { println(listOf(O, D.K)) }',
    true,
  ],
  [
    'an annotation with arguments on a class',
    'annotation class A(val s: String)\n@A("x") class C\nfun main() { println(1) }',
    true,
  ],
  [
    'an annotation missing its argument on a class',
    'annotation class A(val s: String)\n@A class C\nfun main() { println(1) }',
    false,
  ],
  [
    'an interface declared in a function body',
    'fun main() {\n  interface I { fun f() = 1 }\n  class C : I\n  println(C().f())\n}',
    false,
  ],
  [
    'a spread argument for a parameter that is not vararg',
    'fun f(x: Int) = x\nfun main() { println(f(*intArrayOf(1))) }',
    false,
  ],
  [
    'a spread argument for a vararg',
    'fun g(vararg x: Int) = x.sum()\nfun main() { println(g(*intArrayOf(1, 2), 3)) }',
    true,
  ],
  [
    "an integer literal for an annotation's String",
    'annotation class A(val s: String)\n@A(1) fun f() = 1\nfun main() { println(f()) }',
    false,
  ],
  [
    "integer literals for an annotation's Long and Byte",
    'annotation class N(val n: Long, val b: Byte)\n@N(1, 2) fun f() = 1\nfun main() { println(f()) }',
    true,
  ],
])('compiles %s only as kotlinc does', (_name, source, compiles) => {
  expect(executeProgram('kotlin', source).kind).toBe(compiles ? 'executed' : 'compileError');
});

test('keeps the anonymous types of private properties that object expressions initialize', () => {
  const source = `interface Greeter { fun hi(): String }
class Service(val name: String) {
    private val greeter = object : Greeter { override fun hi() = "hello " + name }
    private val counter = object { var n = 0 }
    fun run(): String { counter.n++; return greeter.hi() + counter.n }
}
private val shared = object { fun twice(x: Int) = x * 2 }
fun main() { println(Service("u").run()); println(shared.twice(3)) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: 'hello u1\n6\n' });
});

test('reads FunctionN types as the function types kotlinc reads them as', () => {
  const source = `fun apply(f: Function1<Int, Int>, x: Int) = f(x)
class Doubler : Function1<Int, Int> { override fun invoke(p1: Int) = p1 * 2 }
fun main() { println(listOf(apply({ it * 2 }, 3), Doubler()(4))) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[6, 8]\n' });
});

test.each([
  [
    'a local function',
    'fun main() {\n    tailrec fun loop(n: Int): Int = if (n == 0) 0 else loop(n - 1)\n    println(loop(100000))\n}',
    '0\n',
  ],
  [
    'a member extension',
    'class C(val base: Int) {\n    tailrec fun Int.up(acc: Int): Int = if (acc >= this) acc + base else up(acc + 1)\n    fun run() = 5.up(0)\n}\nfun main() { println(C(100).run()) }',
    '105\n',
  ],
  [
    'a suspend function',
    'tailrec suspend fun loop(n: Int): Int = if (n == 0) 0 else loop(n - 1)\nsuspend fun main() { println(loop(3)) }',
    '0\n',
  ],
])('runs a tailrec %s', (_kind, source, stdout) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout });
});

test('checks reified type arguments in both the ordinary and the suspend version of an inline function', () => {
  const source = `inline fun <reified T> isOf(x: Any, f: (Int) -> Unit): Boolean { f(1); return x is T }
fun main() {
    println(listOf(isOf<String>("a") { }, isOf<String>(5) { }))
    println(sequence { yield(if (isOf<String>(5) { yield(8) }) 1 else 0) }.toList())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[true, false]\n[8, 0]\n' });
});

test('normalizes the paths of files as java.io.File does', () => {
  const source = `import java.io.File
fun main() { println(listOf(File("a/b/").name, File("a", "/b").path, File("a") == File("a/"))) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[b, a/b, true]\n' });
});

test('finds operators and infix functions where a call of them finds them', () => {
  const source = `data class V(val x: Int)
class Ops { operator fun V.times(k: Int) = V(x * k) }
fun main() {
    operator fun V.div(k: Int) = V(x / k)
    infix fun Int.pow(e: Int): Int { var r = 1; repeat(e) { r *= this }; return r }
    println(listOf(V(6) / 3, 2 pow 3, with(Ops()) { V(2) * 5 }))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[V(x=2), 8, V(x=10)]\n' });
});

test("catches only the exceptions of a reified type parameter's type", () => {
  const source = `inline fun <reified E : Throwable> caught(block: () -> Unit): String {
    try { block(); return "none" } catch (e: E) { return "caught" }
}
fun main() {
    println(caught<IllegalStateException> { throw IllegalStateException("x") })
    println(caught<IllegalArgumentException> { throw IllegalStateException("y") })
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'caught\n',
    uncaughtException: 'java.lang.IllegalStateException: y',
  });
});

test.each([
  [
    "an inner class's header reading the class around it",
    'open class Base(val t: String)\nclass Outer(val s: String) { inner class In : Base(s + "?") }\nfun main() { println(Outer("a").In().t) }',
    'a?\n',
  ],
  [
    'a lateinit property read in an init block',
    'class L { lateinit var s: String; init { s = "x"; println(s) } }\nfun main() { L() }',
    'x\n',
  ],
  [
    'a file at the root',
    'import java.io.File\nfun main() { println(listOf(File("/").parent, File("/a").parent)) }',
    '[null, /]\n',
  ],
  [
    'a regex group the pattern lacks',
    'fun main() { try { Regex("(a)").find("a")!!.groups[5] } catch (e: Exception) { println(e) } }',
    'java.lang.IndexOutOfBoundsException: No group 5\n',
  ],
  [
    'an iterator of a sorted map after its last element',
    'fun main() { val m = sortedMapOf(1 to "a", 2 to "b"); for (k in m.keys) if (k == 2) m[3] = "c"; println(m) }',
    '{1=a, 2=b, 3=c}\n',
  ],
])('runs %s as kotlinc does', (_name, source, stdout) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  [
    'a member extension on an explicit receiver',
    'class Ctx(val name: String) { fun Ctx.label() = this.name + this@Ctx.name }\nfun main() { with(Ctx("A")) { println(Ctx("B").label()) } }',
    'BA\n',
  ],
  [
    'a member property called through its invoke operator',
    'class Adder(val base: Int) { operator fun invoke(x: Int) = base + x }\nclass Holder { val adder = Adder(100) }\nfun main() { println(Holder().adder(1)) }',
    '101\n',
  ],
  [
    'an override of a generic function',
    'interface Mapper { fun <T> map(x: T): String }\nclass M : Mapper { override fun <T> map(x: T): String = "m$x" }\nfun main() { println(M().map(1)) }',
    'm1\n',
  ],
  [
    'a not operator',
    'class Money(val cents: Int) { operator fun not() = cents == 0 }\nfun main() { println(!Money(5)) }',
    'false\n',
  ],
])('calls %s as kotlinc does', (_name, source, stdout) => {
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout });
});

test("runs sequences' indexed filters and overloads chosen by their lambdas' results as kotlinc does", () => {
  const source = `fun main() {
    val even = sequenceOf(1, 2, 3).filterIndexed { i, _ -> i % 2 == 0 }
    println(listOf(even.toList(), even.toList()))
    println(sequenceOf(1, 2).flatMap { listOf(it, it) }.toList())
    println(sequenceOf(1.5, 2.25).sumOf { it })
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '[[1, 3], [1, 3]]\n[1, 1, 2, 2]\n3.75\n',
  });
});

test("runs initializers with their own locals and objects before a secondary constructor's body", () => {
  const source = `interface R { fun run2(): Int }
class K {
    val a: Int
    val r = object : R { override fun run2() = 7 }
    init { val t = 40; a = t + 2 }
    constructor(z: Int) { println(z + a + r.run2()) }
}
fun main() { K(1) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '50\n' });
});

test('reports coroutine and thread functions written without their imports as unavailable', () => {
  for (const name of ['runBlocking', 'launch', 'thread']) {
    expect(executeProgram('kotlin', `fun main() { ${name} { println(1) } }`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: expect.stringContaining('この採点環境では使えません') }],
    });
  }
});

test('gives suspending lambdas their primitive receivers as values', () => {
  const source =
    'fun main() { println(sequence { with(3) { yield(this * 2) }; with(8L) { yield(this + 1) } }.toList()) }';
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[6, 9]\n' });
});

test('reads enum entries imported under an alias', () => {
  const source = `package demo
import demo.Color.GREEN as G
enum class Color { RED, GREEN }
fun main() { println(listOf(G, G == Color.GREEN)) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[GREEN, true]\n' });
});

test('reads regex groups by name, as Kotlin/JVM does', () => {
  const source = `fun main() {
    val m = Regex("(?<year>\\\\d{4})-(\\\\d{2})").find("on 2024-05")!!
    println(m.groups["year"]?.value)
    println(m.groups.get("year")?.range)
    println(runCatching { m.groups["month"] }.exceptionOrNull())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '2024\n3..6\njava.lang.IllegalArgumentException: No group with name <month>\n',
  });
});

/**
 * The forms a call takes, each of which chooses its receivers, its target, and whether it suspends on its own path:
 * the declarations, with `S` where `suspend` goes, and a call of them that gives 42.
 */
const CALL_FORMS: [string, string, string][] = [
  ['a function', 'S fun f(x: Int): Int = x + 1', 'f(41)'],
  ['a member', 'class C { S fun f(x: Int): Int = x + 1 }', 'C().f(41)'],
  ['a member extension', 'class C { S fun Int.f(): Int = this + 1 }', 'with(C()) { 41.f() }'],
  [
    'a member through super',
    'open class A { open S fun f(x: Int): Int = x }\nclass B : A() { override S fun f(x: Int): Int = super.f(x) + 1 }',
    'B().f(41)',
  ],
  ['an invoke operator', 'class C { S operator fun invoke(x: Int): Int = x + 1 }', 'C().let { c -> c(41) }'],
  ['an extension invoke operator', 'class C\nS operator fun C.invoke(x: Int): Int = x + 1', 'C().let { c -> c(41) }'],
];

test.each(
  CALL_FORMS.flatMap(([form, declarations, call]) =>
    ['', 'suspend '].flatMap((modifier) =>
      [false, true].map((isLocal) => [form, modifier, isLocal, declarations.replaceAll('S ', modifier), call] as const)
    )
  )
)('calls %s %sdeclared locally: %s', (_form, modifier, isLocal, declarations, call) => {
  const source = isLocal
    ? `${modifier}fun main() {
    var g: ${modifier}() -> Int = { 0 }
    run {
        ${declarations.replaceAll('\n', '\n        ')}
        g = { ${call} }
    }
    println(g())
}`
    : `${declarations}
${modifier}fun main() { println(${call}) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '42\n' });
});

test('calls suspend functions through super, but not member extensions, which super cannot receive', () => {
  const source = `open class A {
    open suspend fun f(x: Int): Int = x
    open fun g(): Int = 1
    open fun Int.g(): Int = this + 1
}
class B : A() {
    override suspend fun f(x: Int): Int = super.f(x) * 2
    fun h(): Int = with(10) { super.g() }
}
suspend fun main() { println(B().f(5)); println(B().h()) }`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '10\n1\n' });
  const extension = `open class A { open fun Int.f(): Int = this }
class B : A() { override fun Int.f(): Int = super.f() + 1 }
fun main() { with(B()) { println(41.f()) } }`;
  expect(executeProgram('kotlin', extension).kind).toBe('compileError');
});

test('calls suspend member extensions, dispatching on the value of their class', () => {
  const source = `open class A { open suspend fun Int.tag(): String = "A$this" }
class C : A() { override suspend fun Int.tag(): String = "C$this" }
suspend fun main() {
    with(A()) { println(1.tag()) }
    with(C() as A) { println(listOf(2, 3).map { it.tag() }) }
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: 'A1\n[C2, C3]\n' });
});

test('suspends a sequence builder inside the inline lambdas and branches its block runs', () => {
  const source = `fun main() {
    val filtered = sequence { listOf(1, 2, 3).filter { yield(it); it > 1 }.forEach { yield(it * 10) } }
    println(filtered.toList())
    val branches = iterator { for (i in 1..3) { val v = if (i % 2 == 0) { yield(i); i * 10 } else -i; yield(v) } }
    for (x in branches) print("$x ")
    println()
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: '[1, 2, 3, 20, 30]\n-1 2 20 -3 \n',
  });
});

test.each([
  ['a local function', 'fun main() {\n  inline fun twice(b: () -> Int) = b() + b()\n  println(twice { 1 })\n}', false],
  [
    'a local class member',
    'fun main() {\n  class L { inline fun twice(b: () -> Int) = b() + b() }\n  println(L().twice { 1 })\n}',
    true,
  ],
])('accepts inline on %s only where kotlinc does', (_name, source, compiles) => {
  expect(executeProgram('kotlin', source).kind === 'compileError').toBe(!compiles);
});

test('increments through a safe call and infers a fun interface from its lambda', () => {
  const source = `class C { var n = 1 }
fun interface Mapper<A, B> { fun map(a: A): B }
fun main() {
    var c: C? = C()
    println(c?.n++)
    println(++c?.n)
    c = null
    println(c?.n++)
    println(listOf(3, 1, 2).sortedWith(Comparator { a: Int, b: Int -> b - a }))
    println(Mapper { s: String -> s.length }.map("abc"))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '1\n3\nnull\n[3, 2, 1]\n3\n' });
  expect(executeProgram('kotlin', 'fun main() { println(Comparator { a, b -> 0 }) }')).toMatchObject({
    kind: 'compileError',
  });
});

test("fails a sequence builder's iterator after its block throws or is resumed from inside, as kotlinc does", () => {
  const source = `fun main() {
    val it = sequence { yield(1); throw IllegalStateException("boom") }.iterator()
    println(it.next())
    try { it.hasNext() } catch (e: Exception) { println(e) }
    try { it.hasNext() } catch (e: Exception) { println(e) }
    lateinit var inner: Iterator<Int>
    inner = iterator { yield(1); inner.hasNext() }
    inner.next()
    try { inner.next() } catch (e: Exception) { println(e) }
    println(sequence { println(yield(1)) }.toList())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '1\njava.lang.IllegalStateException: boom\njava.lang.IllegalStateException: Iterator has failed.\n' +
      'java.lang.IllegalStateException: Iterator has failed.\nkotlin.Unit\n[1]\n',
  });
});

test('returns from the lambdas of repeat and forEach that suspend by their implicit labels', () => {
  const source = `fun main() {
    val s = sequence {
        repeat(4) { if (it == 1) return@repeat; if (it == 3) return@sequence; yield(it) }
        yield(99)
    }
    println(s.toList())
    println(sequence { listOf(1, 2, 3).forEach { if (it == 2) return@forEach; yield(it) } }.toList())
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({ kind: 'executed', stdout: '[0, 2]\n[1, 3]\n' });
});

test('stops single and joinToString on infinite sequences where kotlinc does', () => {
  const source = `fun main() {
    val naturals = generateSequence(1) { it + 1 }
    try { naturals.single() } catch (e: Exception) { println(e) }
    println(naturals.joinToString(limit = 3))
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'java.lang.IllegalArgumentException: Sequence has more than one element.\n1, 2, 3, ...\n',
  });
});

test('runs a sequence builder only as far as its consumer asks, suspending at each yield', () => {
  const source = `suspend fun SequenceScope<Int>.countTo(n: Int) { for (i in 1..n) yield(i) }
fun main() {
    val numbers = sequence {
        println("start")
        countTo(2)
        var n = 10
        while (true) yield(n++)
    }
    for (x in numbers.take(4)) println("got $x")
}`;
  expect(executeProgram('kotlin', source)).toMatchObject({
    kind: 'executed',
    stdout: 'start\ngot 1\ngot 2\ngot 10\ngot 11\n',
  });
});
