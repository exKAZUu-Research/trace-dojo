import { UNSIGNED_ARRAYS } from './arrays';
import { kotlin } from './source';

/** The general functions and classes of `kotlin`: pairs, scope functions, preconditions, lazy values, and arrays. */
export const STANDARD_SOURCE = kotlin`
package kotlin

data class Pair<out A, out B>(val first: A, val second: B) {
    override fun toString(): String = "($first, $second)"
}

data class Triple<out A, out B, out C>(val first: A, val second: B, val third: C) {
    override fun toString(): String = "($first, $second, $third)"
}

infix fun <A, B> A.to(that: B): Pair<A, B> = Pair(this, that)

fun <T> Pair<T, T>.toList(): List<T> = listOf(first, second)
fun <T> Triple<T, T, T>.toList(): List<T> = listOf(first, second, third)

inline fun <T, R> T.let(block: (T) -> R): R = block(this)
inline fun <T> T.also(block: (T) -> Unit): T {
    block(this)
    return this
}
inline fun <T> T.apply(block: T.() -> Unit): T {
    block()
    return this
}
inline fun <T, R> T.run(block: T.() -> R): R = block()
inline fun <R> run(block: () -> R): R = block()
inline fun <T, R> with(receiver: T, block: T.() -> R): R = receiver.block()
inline fun <T> T.takeIf(predicate: (T) -> Boolean): T? = if (predicate(this)) this else null
inline fun <T> T.takeUnless(predicate: (T) -> Boolean): T? = if (!predicate(this)) this else null

inline fun repeat(times: Int, action: (Int) -> Unit) {
    for (index in 0 until times) action(index)
}

inline fun require(value: Boolean) {
    if (!value) throw IllegalArgumentException("Failed requirement.")
}

inline fun require(value: Boolean, lazyMessage: () -> Any) {
    if (!value) throw IllegalArgumentException(lazyMessage().toString())
}

inline fun <T : Any> requireNotNull(value: T?): T {
    if (value == null) throw IllegalArgumentException("Required value was null.")
    return value
}

inline fun <T : Any> requireNotNull(value: T?, lazyMessage: () -> Any): T {
    if (value == null) throw IllegalArgumentException(lazyMessage().toString())
    return value
}

inline fun check(value: Boolean) {
    if (!value) throw IllegalStateException("Check failed.")
}

inline fun check(value: Boolean, lazyMessage: () -> Any) {
    if (!value) throw IllegalStateException(lazyMessage().toString())
}

inline fun <T : Any> checkNotNull(value: T?): T {
    if (value == null) throw IllegalStateException("Required value was null.")
    return value
}

inline fun <T : Any> checkNotNull(value: T?, lazyMessage: () -> Any): T {
    if (value == null) throw IllegalStateException(lazyMessage().toString())
    return value
}

fun error(message: Any): Nothing = throw IllegalStateException(message.toString())

fun TODO(): Nothing = throw NotImplementedError("An operation is not implemented.")
fun TODO(reason: String): Nothing = throw NotImplementedError("An operation is not implemented: $reason")

fun Any?.toString(): String = if (this == null) "null" else this.toString()
operator fun String?.plus(other: Any?): String = (if (this == null) "null" else this) + other.toString()
fun Any?.hashCode(): Int = if (this == null) 0 else hashCode()

interface Lazy<out T> {
    val value: T
    fun isInitialized(): Boolean
}

private object UninitializedValue

class SynchronizedLazyImpl<out T>(initializer: () -> T) : Lazy<T> {
    private var initializer: (() -> T)? = initializer
    private var holder: Any? = UninitializedValue
    override val value: T
        get() {
            if (holder === UninitializedValue) {
                holder = initializer!!()
                initializer = null
            }
            return holder as T
        }
    override fun isInitialized(): Boolean = holder !== UninitializedValue
    override fun toString(): String = if (isInitialized()) value.toString() else "Lazy value not initialized yet."
}

fun <T> lazy(initializer: () -> T): Lazy<T> = SynchronizedLazyImpl(initializer)

operator fun <T> Lazy<T>.getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): T = value

fun Int.mod(other: Int): Int {
    val r = this % other
    return if (r != 0 && (r xor other) < 0) r + other else r
}
fun Long.mod(other: Long): Long {
    val r = this % other
    return if (r != 0L && (r xor other) < 0L) r + other else r
}
fun Double.mod(other: Double): Double {
    val r = this % other
    return if (r != 0.0 && (r < 0.0) != (other < 0.0)) r + other else r
}
fun Int.floorDiv(other: Int): Int {
    val q = this / other
    return if ((this xor other) < 0 && q * other != this) q - 1 else q
}
fun Long.floorDiv(other: Long): Long {
    val q = this / other
    return if ((this xor other) < 0L && q * other != this) q - 1L else q
}
fun Double.isNaN(): Boolean = this != this
fun Float.isNaN(): Boolean = this != this
fun Double.isInfinite(): Boolean = this == Double.POSITIVE_INFINITY || this == Double.NEGATIVE_INFINITY
fun Float.isInfinite(): Boolean = this == Float.POSITIVE_INFINITY || this == Float.NEGATIVE_INFINITY
fun Double.isFinite(): Boolean = !isInfinite() && !isNaN()
fun Float.isFinite(): Boolean = !isInfinite() && !isNaN()
external fun Double.nextDown(): Double
external fun Double.nextUp(): Double

fun interface Comparator<T> {
    fun compare(a: T, b: T): Int
}

class IntArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Int
    external operator fun set(index: Int, value: Int)
    external operator fun iterator(): Iterator<Int>
}

class LongArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Long
    external operator fun set(index: Int, value: Long)
    external operator fun iterator(): Iterator<Long>
}

class DoubleArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Double
    external operator fun set(index: Int, value: Double)
    external operator fun iterator(): Iterator<Double>
}

class FloatArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Float
    external operator fun set(index: Int, value: Float)
    external operator fun iterator(): Iterator<Float>
}

class ShortArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Short
    external operator fun set(index: Int, value: Short)
    external operator fun iterator(): Iterator<Short>
}

class ByteArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Byte
    external operator fun set(index: Int, value: Byte)
    external operator fun iterator(): Iterator<Byte>
}

class CharArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Char
    external operator fun set(index: Int, value: Char)
    external operator fun iterator(): Iterator<Char>
}

class BooleanArray private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): Boolean
    external operator fun set(index: Int, value: Boolean)
    external operator fun iterator(): Iterator<Boolean>
}

${UNSIGNED_ARRAYS.map(
  ([name, element]) => `class ${name} private constructor() {
    external constructor(size: Int)
    external val size: Int
    external operator fun get(index: Int): ${element}
    external operator fun set(index: Int, value: ${element})
    external operator fun iterator(): Iterator<${element}>
    external override fun toString(): String
}`
).join('\n\n')}
`;
