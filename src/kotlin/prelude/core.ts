import { kotlin } from './source';

/** The classes of `kotlin` that the language itself relies on. */
export const CORE_SOURCE = kotlin`
package kotlin

open external class Any {
    open external operator fun equals(other: Any?): Boolean
    open external fun hashCode(): Int
    open external fun toString(): String
}

object Unit {
    override fun toString(): String = "kotlin.Unit"
}

interface Function<out R>

interface Comparable<in T> {
    operator fun compareTo(other: T): Int
}

interface CharSequence {
    val length: Int
    operator fun get(index: Int): Char
    fun subSequence(startIndex: Int, endIndex: Int): CharSequence
}

abstract class Number {
    abstract fun toDouble(): Double
    abstract fun toFloat(): Float
    abstract fun toLong(): Long
    abstract fun toInt(): Int
    abstract fun toShort(): Short
    abstract fun toByte(): Byte
}

class Boolean private constructor() : Comparable<Boolean> {
    external infix fun and(other: Boolean): Boolean
    external infix fun or(other: Boolean): Boolean
    external infix fun xor(other: Boolean): Boolean
    external override fun compareTo(other: Boolean): Int
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object
}

class Char private constructor() : Comparable<Char> {
    external val code: Int
    external override fun compareTo(other: Char): Int
    external fun toInt(): Int
    external fun toLong(): Long
    external fun toDouble(): Double
    external operator fun rangeTo(other: Char): CharRange
    external operator fun rangeUntil(other: Char): CharRange
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Char = '\\u0000'
        const val MAX_VALUE: Char = '￿'
    }
}

class Byte private constructor() : Number(), Comparable<Byte> {
    external operator fun plus(other: Byte): Int
    external operator fun minus(other: Byte): Int
    external operator fun times(other: Byte): Int
    external operator fun div(other: Byte): Int
    external operator fun rem(other: Byte): Int
    external operator fun unaryMinus(): Int
    external operator fun inc(): Byte
    external operator fun dec(): Byte
    external override fun compareTo(other: Byte): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external fun toChar(): Char
    external fun toUByte(): UByte
    external fun toUInt(): UInt
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Byte = -128
        const val MAX_VALUE: Byte = 127
    }
}

class Short private constructor() : Number(), Comparable<Short> {
    external operator fun plus(other: Short): Int
    external operator fun minus(other: Short): Int
    external operator fun times(other: Short): Int
    external operator fun div(other: Short): Int
    external operator fun rem(other: Short): Int
    external operator fun unaryMinus(): Int
    external operator fun inc(): Short
    external operator fun dec(): Short
    external override fun compareTo(other: Short): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external fun toChar(): Char
    external fun toUShort(): UShort
    external fun toUInt(): UInt
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Short = -32768
        const val MAX_VALUE: Short = 32767
    }
}

class Int private constructor() : Number(), Comparable<Int> {
    external operator fun plus(other: Int): Int
    external operator fun minus(other: Int): Int
    external operator fun times(other: Int): Int
    external operator fun div(other: Int): Int
    external operator fun rem(other: Int): Int
    external operator fun unaryMinus(): Int
    external operator fun inc(): Int
    external operator fun dec(): Int
    external override fun compareTo(other: Int): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external fun toChar(): Char
    external fun toUInt(): UInt
    external fun toULong(): ULong
    external infix fun and(other: Int): Int
    external infix fun or(other: Int): Int
    external infix fun xor(other: Int): Int
    external infix fun shl(bitCount: Int): Int
    external infix fun shr(bitCount: Int): Int
    external infix fun ushr(bitCount: Int): Int
    external fun inv(): Int
    external operator fun rangeTo(other: Int): IntRange
    external operator fun rangeTo(other: Long): LongRange
    external operator fun rangeUntil(other: Int): IntRange
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Int = -2147483648
        const val MAX_VALUE: Int = 2147483647
        const val SIZE_BYTES: Int = 4
        const val SIZE_BITS: Int = 32
    }
}

class Long private constructor() : Number(), Comparable<Long> {
    external operator fun plus(other: Long): Long
    external operator fun minus(other: Long): Long
    external operator fun times(other: Long): Long
    external operator fun div(other: Long): Long
    external operator fun rem(other: Long): Long
    external operator fun unaryMinus(): Long
    external operator fun inc(): Long
    external operator fun dec(): Long
    external override fun compareTo(other: Long): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external fun toChar(): Char
    external fun toULong(): ULong
    external fun toUInt(): UInt
    external infix fun and(other: Long): Long
    external infix fun or(other: Long): Long
    external infix fun xor(other: Long): Long
    external infix fun shl(bitCount: Int): Long
    external infix fun shr(bitCount: Int): Long
    external infix fun ushr(bitCount: Int): Long
    external fun inv(): Long
    external operator fun rangeTo(other: Long): LongRange
    external operator fun rangeTo(other: Int): LongRange
    external operator fun rangeUntil(other: Long): LongRange
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Long = -9223372036854775807L - 1L
        const val MAX_VALUE: Long = 9223372036854775807L
    }
}

class Float private constructor() : Number(), Comparable<Float> {
    external operator fun plus(other: Float): Float
    external operator fun minus(other: Float): Float
    external operator fun times(other: Float): Float
    external operator fun div(other: Float): Float
    external operator fun rem(other: Float): Float
    external operator fun unaryMinus(): Float
    external operator fun inc(): Float
    external operator fun dec(): Float
    external override fun compareTo(other: Float): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Float = 1.4E-45f
        const val MAX_VALUE: Float = 3.4028235E38f
        const val POSITIVE_INFINITY: Float = 1.0f / 0.0f
        const val NEGATIVE_INFINITY: Float = -1.0f / 0.0f
        const val NaN: Float = 0.0f / 0.0f
    }
}

class Double private constructor() : Number(), Comparable<Double> {
    external operator fun plus(other: Double): Double
    external operator fun minus(other: Double): Double
    external operator fun times(other: Double): Double
    external operator fun div(other: Double): Double
    external operator fun rem(other: Double): Double
    external operator fun unaryMinus(): Double
    external operator fun inc(): Double
    external operator fun dec(): Double
    external override fun compareTo(other: Double): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Double = 4.9E-324
        const val MAX_VALUE: Double = 1.7976931348623157E308
        const val POSITIVE_INFINITY: Double = 1.0 / 0.0
        const val NEGATIVE_INFINITY: Double = -1.0 / 0.0
        const val NaN: Double = 0.0 / 0.0
    }
}

class UByte private constructor() : Comparable<UByte> {
    external override fun compareTo(other: UByte): Int
    external fun toInt(): Int
    external fun toLong(): Long
    external fun toUInt(): UInt
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

class UShort private constructor() : Comparable<UShort> {
    external override fun compareTo(other: UShort): Int
    external fun toInt(): Int
    external fun toLong(): Long
    external fun toUInt(): UInt
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

class UInt private constructor() : Comparable<UInt> {
    external override fun compareTo(other: UInt): Int
    external fun toInt(): Int
    external fun toLong(): Long
    external fun toULong(): ULong
    external fun toDouble(): Double
    external infix fun and(other: UInt): UInt
    external infix fun or(other: UInt): UInt
    external infix fun xor(other: UInt): UInt
    external infix fun shl(bitCount: Int): UInt
    external infix fun shr(bitCount: Int): UInt
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: UInt = 0u
        const val MAX_VALUE: UInt = 4294967295u
    }
}

class ULong private constructor() : Comparable<ULong> {
    external override fun compareTo(other: ULong): Int
    external fun toInt(): Int
    external fun toLong(): Long
    external fun toUInt(): UInt
    external fun toDouble(): Double
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: ULong = 0uL
        const val MAX_VALUE: ULong = 18446744073709551615uL
    }
}

class String private constructor() : Comparable<String>, CharSequence {
    external override val length: Int
    external override operator fun get(index: Int): Char
    external override fun subSequence(startIndex: Int, endIndex: Int): CharSequence
    external override fun compareTo(other: String): Int
    external operator fun plus(other: Any?): String
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object
}

class Array<T> private constructor() {
    external val size: Int
    external operator fun get(index: Int): T
    external operator fun set(index: Int, value: T)
    external operator fun iterator(): Iterator<T>
}

abstract class Enum<E : Enum<E>>(val name: String, val ordinal: Int) : Comparable<E> {
    final override fun compareTo(other: E): Int = ordinal - other.ordinal
    final override fun equals(other: Any?): Boolean = this === other
    final override fun hashCode(): Int = super.hashCode()
    override fun toString(): String = name
}

open external class Throwable {
    external constructor()
    external constructor(message: String?)
    external constructor(message: String?, cause: Throwable?)
    external constructor(cause: Throwable?)
    open external val message: String?
    open external val cause: Throwable?
    external fun printStackTrace()
    external override fun toString(): String
}
`;
