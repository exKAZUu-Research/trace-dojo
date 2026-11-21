import { kotlin } from './source';

/** `kotlin.comparisons`, transcribed from Kotlin's standard library. */
export const COMPARISONS_SOURCE = kotlin`
package kotlin.comparisons

fun <T : Comparable<*>> compareValues(a: T?, b: T?): Int {
    if (a === b) return 0
    if (a == null) return -1
    if (b == null) return 1
    return (a as Comparable<Any>).compareTo(b)
}

fun <T> compareValuesBy(a: T, b: T, vararg selectors: (T) -> Comparable<*>?): Int {
    for (fn in selectors) {
        val v1 = fn(a)
        val v2 = fn(b)
        val diff = compareValues(v1, v2)
        if (diff != 0) return diff
    }
    return 0
}

fun <T> compareBy(vararg selectors: (T) -> Comparable<*>?): Comparator<T> {
    if (selectors.size <= 0) throw IllegalArgumentException("Failed requirement.")
    return Comparator { a, b -> compareValuesBy(a, b, *selectors) }
}

inline fun <T> compareBy(crossinline selector: (T) -> Comparable<*>?): Comparator<T> =
    Comparator { a, b -> compareValues(selector(a), selector(b)) }

inline fun <T> compareByDescending(crossinline selector: (T) -> Comparable<*>?): Comparator<T> =
    Comparator { a, b -> compareValues(selector(b), selector(a)) }

inline fun <T> Comparator<T>.thenBy(crossinline selector: (T) -> Comparable<*>?): Comparator<T> =
    Comparator { a, b ->
        val previousCompare = this@thenBy.compare(a, b)
        if (previousCompare != 0) previousCompare else compareValues(selector(a), selector(b))
    }

inline fun <T> Comparator<T>.thenByDescending(crossinline selector: (T) -> Comparable<*>?): Comparator<T> =
    Comparator { a, b ->
        val previousCompare = this@thenByDescending.compare(a, b)
        if (previousCompare != 0) previousCompare else compareValues(selector(b), selector(a))
    }

infix fun <T> Comparator<T>.then(comparator: Comparator<in T>): Comparator<T> =
    Comparator { a, b ->
        val previousCompare = this@then.compare(a, b)
        if (previousCompare != 0) previousCompare else comparator.compare(a, b)
    }

fun <T> Comparator<T>.reversed(): Comparator<T> = Comparator { a, b -> this@reversed.compare(b, a) }

fun <T : Comparable<T>> naturalOrder(): Comparator<T> = NaturalOrderComparator as Comparator<T>

fun <T : Comparable<T>> reverseOrder(): Comparator<T> = ReverseOrderComparator as Comparator<T>

internal object NaturalOrderComparator : Comparator<Comparable<Any>> {
    override fun compare(a: Comparable<Any>, b: Comparable<Any>): Int = a.compareTo(b)
}

internal object ReverseOrderComparator : Comparator<Comparable<Any>> {
    override fun compare(a: Comparable<Any>, b: Comparable<Any>): Int = b.compareTo(a)
}

fun <T : Comparable<T>> maxOf(a: T, b: T): T = if (a >= b) a else b
fun <T : Comparable<T>> minOf(a: T, b: T): T = if (a <= b) a else b
fun <T : Comparable<T>> maxOf(a: T, b: T, c: T): T = maxOf(a, maxOf(b, c))
fun <T : Comparable<T>> minOf(a: T, b: T, c: T): T = minOf(a, minOf(b, c))
fun <T> maxOf(a: T, b: T, comparator: Comparator<in T>): T = if (comparator.compare(a, b) >= 0) a else b
fun <T> minOf(a: T, b: T, comparator: Comparator<in T>): T = if (comparator.compare(a, b) <= 0) a else b
fun <T> maxOf(a: T, b: T, c: T, comparator: Comparator<in T>): T = maxOf(a, maxOf(b, c, comparator), comparator)
fun <T> minOf(a: T, b: T, c: T, comparator: Comparator<in T>): T = minOf(a, minOf(b, c, comparator), comparator)
fun <T> maxOf(a: T, vararg other: T, comparator: Comparator<in T>): T {
    var result = a
    for (element in other) result = maxOf(result, element, comparator)
    return result
}
fun <T> minOf(a: T, vararg other: T, comparator: Comparator<in T>): T {
    var result = a
    for (element in other) result = minOf(result, element, comparator)
    return result
}
${numericExtremes()}
`;

/** `kotlin.random`, with Kotlin's XorWow generator, whose seeded sequences match the JVM's. */
export const RANDOM_SOURCE = kotlin`
package kotlin.random

abstract class Random {
    abstract fun nextBits(bitCount: Int): Int

    open fun nextInt(): Int = nextBits(32)

    open fun nextInt(until: Int): Int = nextInt(0, until)

    open fun nextInt(from: Int, until: Int): Int {
        checkRangeBounds(from, until)
        val n = until - from
        if (n > 0 || n == Int.MIN_VALUE) {
            val rnd = if (n and -n == n) {
                val bitCount = fastLog2(n)
                nextBits(bitCount)
            } else {
                var v: Int
                do {
                    val bits = nextInt().ushr(1)
                    v = bits % n
                } while (bits - v + (n - 1) < 0)
                v
            }
            return from + rnd
        } else {
            while (true) {
                val rnd = nextInt()
                if (rnd in from until until) return rnd
            }
        }
    }

    open fun nextLong(): Long = nextInt().toLong().shl(32) + nextInt()

    open fun nextLong(until: Long): Long = nextLong(0L, until)

    open fun nextLong(from: Long, until: Long): Long {
        checkRangeBounds(from, until)
        val n = until - from
        if (n > 0L) {
            val rnd: Long
            if (n and -n == n) {
                val nLow = n.toInt()
                val nHigh = (n ushr 32).toInt()
                rnd = when {
                    nLow != 0 -> {
                        val bitCount = fastLog2(nLow)
                        nextBits(bitCount).toLong() and 0xFFFFFFFFL
                    }
                    nHigh == 1 -> nextInt().toLong() and 0xFFFFFFFFL
                    else -> {
                        val bitCount = fastLog2(nHigh)
                        nextBits(bitCount).toLong().shl(32) + (nextInt().toLong() and 0xFFFFFFFFL)
                    }
                }
            } else {
                var v: Long
                do {
                    val bits = nextLong().ushr(1)
                    v = bits % n
                } while (bits - v + (n - 1L) < 0L)
                rnd = v
            }
            return from + rnd
        } else {
            while (true) {
                val rnd = nextLong()
                if (rnd in from until until) return rnd
            }
        }
    }

    open fun nextBoolean(): Boolean = nextBits(1) != 0

    open fun nextDouble(): Double = doubleFromParts(nextBits(26), nextBits(27))

    open fun nextDouble(until: Double): Double = nextDouble(0.0, until)

    open fun nextDouble(from: Double, until: Double): Double {
        checkRangeBounds(from, until)
        val size = until - from
        val r = if (size.isInfinite() && from.isFinite() && until.isFinite()) {
            val r1 = nextDouble() * (until / 2 - from / 2)
            from + r1 + r1
        } else {
            from + nextDouble() * size
        }
        return if (r >= until) until.nextDown() else r
    }

    open fun nextFloat(): Float = nextBits(24) / (1 shl 24).toFloat()

    companion object Default : Random() {
        private val defaultRandom: Random = xorWowRandom(platformSeed(), platformSeed())
        override fun nextBits(bitCount: Int): Int = defaultRandom.nextBits(bitCount)
        override fun nextInt(): Int = defaultRandom.nextInt()
        override fun nextInt(until: Int): Int = defaultRandom.nextInt(until)
        override fun nextInt(from: Int, until: Int): Int = defaultRandom.nextInt(from, until)
        override fun nextLong(): Long = defaultRandom.nextLong()
        override fun nextBoolean(): Boolean = defaultRandom.nextBoolean()
        override fun nextDouble(): Double = defaultRandom.nextDouble()
        override fun nextFloat(): Float = defaultRandom.nextFloat()
    }
}

internal external fun platformSeed(): Int

fun Random(seed: Int): Random = xorWowRandom(seed, seed.shr(31))

fun Random(seed: Long): Random = xorWowRandom(seed.toInt(), seed.shr(32).toInt())

internal fun xorWowRandom(seed1: Int, seed2: Int): Random =
    XorWowRandom(seed1, seed2, 0, 0, seed1.inv(), (seed1 shl 10) xor (seed2 ushr 4))

fun Random.nextInt(range: IntRange): Int = when {
    range.isEmpty() -> throw IllegalArgumentException("Cannot get random in empty range: $range")
    range.last < Int.MAX_VALUE -> nextInt(range.first, range.last + 1)
    range.first > Int.MIN_VALUE -> nextInt(range.first - 1, range.last) + 1
    else -> nextInt()
}

internal fun checkRangeBounds(from: Int, until: Int) {
    if (!(until > from)) throw IllegalArgumentException(boundsErrorMessage(from, until))
}

internal fun checkRangeBounds(from: Long, until: Long) {
    if (!(until > from)) throw IllegalArgumentException(boundsErrorMessage(from, until))
}

internal fun checkRangeBounds(from: Double, until: Double) {
    if (!(until > from)) throw IllegalArgumentException(boundsErrorMessage(from, until))
}

internal fun boundsErrorMessage(from: Any, until: Any): String = "Random range is empty: [$from, $until)."

internal fun fastLog2(value: Int): Int = 31 - Integer.numberOfLeadingZeros(value)

internal fun Int.takeUpperBits(bitCount: Int): Int = this.ushr(32 - bitCount) and (-bitCount).shr(31)

internal fun doubleFromParts(hi26: Int, low27: Int): Double = (hi26.toLong().shl(27) + low27) / (1L shl 53).toDouble()

internal object Integer {
    fun numberOfLeadingZeros(value: Int): Int {
        if (value == 0) return 32
        var n = 0
        var x = value
        while (x and (1 shl 31) == 0) {
            n++
            x = x shl 1
        }
        return n
    }
}

class XorWowRandom internal constructor(
    private var x: Int,
    private var y: Int,
    private var z: Int,
    private var w: Int,
    private var v: Int,
    private var addend: Int
) : Random() {
    init {
        require((x or y or z or w or v) != 0) { "Initial state must have at least one non-zero element." }
        repeat(64) { nextInt() }
    }

    override fun nextInt(): Int {
        var t = x
        t = t xor (t ushr 2)
        x = y
        y = z
        z = w
        val v0 = v
        w = v0
        t = (t xor (t shl 1)) xor v0 xor (v0 shl 4)
        v = t
        addend += 362437
        return t + addend
    }

    override fun nextBits(bitCount: Int): Int = nextInt().takeUpperBits(bitCount)
}
`;

export const MATH_SOURCE = kotlin`
package kotlin.math

const val PI: Double = 3.141592653589793
const val E: Double = 2.718281828459045

external fun sqrt(x: Double): Double
external fun cbrt(x: Double): Double
external fun sin(x: Double): Double
external fun cos(x: Double): Double
external fun tan(x: Double): Double
external fun asin(x: Double): Double
external fun acos(x: Double): Double
external fun atan(x: Double): Double
external fun atan2(y: Double, x: Double): Double
external fun exp(x: Double): Double
external fun ln(x: Double): Double
external fun log10(x: Double): Double
external fun log2(x: Double): Double
external fun log(x: Double, base: Double): Double
external fun hypot(x: Double, y: Double): Double
external fun floor(x: Double): Double
external fun ceil(x: Double): Double
external fun round(x: Double): Double
external fun truncate(x: Double): Double
external fun abs(x: Double): Double
external fun sign(x: Double): Double
external fun max(a: Double, b: Double): Double
external fun min(a: Double, b: Double): Double
external fun sqrt(x: Float): Float
inline fun cbrt(x: Float): Float = cbrt(x.toDouble()).toFloat()
inline fun sin(x: Float): Float = sin(x.toDouble()).toFloat()
inline fun cos(x: Float): Float = cos(x.toDouble()).toFloat()
inline fun tan(x: Float): Float = tan(x.toDouble()).toFloat()
inline fun asin(x: Float): Float = asin(x.toDouble()).toFloat()
inline fun acos(x: Float): Float = acos(x.toDouble()).toFloat()
inline fun atan(x: Float): Float = atan(x.toDouble()).toFloat()
inline fun atan2(y: Float, x: Float): Float = atan2(y.toDouble(), x.toDouble()).toFloat()
inline fun exp(x: Float): Float = exp(x.toDouble()).toFloat()
inline fun ln(x: Float): Float = ln(x.toDouble()).toFloat()
inline fun log10(x: Float): Float = log10(x.toDouble()).toFloat()
fun log2(x: Float): Float = log2(x.toDouble()).toFloat()
fun log(x: Float, base: Float): Float = log(x.toDouble(), base.toDouble()).toFloat()
inline fun hypot(x: Float, y: Float): Float = hypot(x.toDouble(), y.toDouble()).toFloat()
inline fun floor(x: Float): Float = floor(x.toDouble()).toFloat()
inline fun ceil(x: Float): Float = ceil(x.toDouble()).toFloat()
inline fun round(x: Float): Float = round(x.toDouble()).toFloat()
fun truncate(x: Float): Float = truncate(x.toDouble()).toFloat()
external fun abs(x: Float): Float
inline fun sign(x: Float): Float = sign(x.toDouble()).toFloat()
external fun max(a: Float, b: Float): Float
external fun min(a: Float, b: Float): Float

fun abs(n: Int): Int = if (n < 0) -n else n
fun abs(n: Long): Long = if (n < 0L) -n else n
fun max(a: Int, b: Int): Int = if (a >= b) a else b
fun min(a: Int, b: Int): Int = if (a <= b) a else b
fun max(a: Long, b: Long): Long = if (a >= b) a else b
fun min(a: Long, b: Long): Long = if (a <= b) a else b

external fun Double.pow(x: Double): Double
external fun Double.pow(n: Int): Double
external fun Float.pow(x: Float): Float
external fun Float.pow(n: Int): Float
external fun Double.roundToInt(): Int
external fun Double.roundToLong(): Long
external fun Float.roundToInt(): Int

val Double.absoluteValue: Double get() = abs(this)
val Float.absoluteValue: Float get() = abs(this)
val Int.absoluteValue: Int get() = abs(this)
val Long.absoluteValue: Long get() = abs(this)
val Double.sign: Double get() = sign(this)
val Float.sign: Float get() = sign(this)
val Int.sign: Int get() = when {
    this < 0 -> -1
    this > 0 -> 1
    else -> 0
}

fun Double.withSign(sign: Double): Double = if ((this < 0.0 || 1.0 / this < 0.0) != (sign < 0.0 || 1.0 / sign < 0.0)) -this else this
`;

/** The overloads of `maxOf` and `minOf` that `kotlin.comparisons` declares for each number type: of two, three, and more. */
function numericExtremes(): string {
  return ['Int', 'Long', 'Float', 'Double']
    .flatMap((type) =>
      (
        [
          ['maxOf', '>=', 'max'],
          ['minOf', '<=', 'min'],
        ] as const
      ).flatMap(([name, operator, math]) => [
        // Floating-point values compare as kotlin.math does, where NaN wins and -0.0 is less than 0.0.
        type === 'Float' || type === 'Double'
          ? `fun ${name}(a: ${type}, b: ${type}): ${type} = kotlin.math.${math}(a, b)`
          : `fun ${name}(a: ${type}, b: ${type}): ${type} = if (a ${operator} b) a else b`,
        `fun ${name}(a: ${type}, b: ${type}, c: ${type}): ${type} = ${name}(a, ${name}(b, c))`,
        `fun ${name}(a: ${type}, vararg other: ${type}): ${type} {\n    var result = a\n    for (e in other) result = ${name}(result, e)\n    return result\n}`,
      ])
    )
    .join('\n');
}
