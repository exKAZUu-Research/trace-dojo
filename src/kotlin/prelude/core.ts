import { arithmeticResult, NUMBER_OPERATOR_NAMES, SIGNED_NUMBER_KINDS, UNSIGNED_NUMBER_KINDS } from '../operators';
import type { ArithmeticOperator, NumericKind } from '../operators';
import { kotlin } from './source';

/** The classes of `kotlin` that the language itself relies on. */
export const CORE_SOURCE = kotlin`
package kotlin

open external class Any {
    external constructor()
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
    external operator fun not(): Boolean
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
    external operator fun plus(other: Int): Char
    external operator fun minus(other: Int): Char
    external operator fun minus(other: Char): Int
    external operator fun inc(): Char
    external operator fun dec(): Char
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
${numberOperators('Byte')}
    external operator fun unaryMinus(): Int
    operator fun unaryPlus(): Int = toInt()
    external operator fun inc(): Byte
    external operator fun dec(): Byte
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
${unsignedConversions()}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Byte = -128
        const val MAX_VALUE: Byte = 127
        const val SIZE_BYTES: Int = 1
        const val SIZE_BITS: Int = 8
    }
}

class Short private constructor() : Number(), Comparable<Short> {
${numberOperators('Short')}
    external operator fun unaryMinus(): Int
    operator fun unaryPlus(): Int = toInt()
    external operator fun inc(): Short
    external operator fun dec(): Short
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
${unsignedConversions()}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Short = -32768
        const val MAX_VALUE: Short = 32767
        const val SIZE_BYTES: Int = 2
        const val SIZE_BITS: Int = 16
    }
}

class Int private constructor() : Number(), Comparable<Int> {
${numberOperators('Int')}
    external operator fun unaryMinus(): Int
    operator fun unaryPlus(): Int = this
    external operator fun inc(): Int
    external operator fun dec(): Int
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
    external fun toChar(): Char
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
${unsignedConversions()}
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
${numberOperators('Long')}
    external operator fun unaryMinus(): Long
    operator fun unaryPlus(): Long = this
    external operator fun inc(): Long
    external operator fun dec(): Long
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    external override fun toShort(): Short
    external override fun toByte(): Byte
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
${unsignedConversions()}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Long = -9223372036854775807L - 1L
        const val MAX_VALUE: Long = 9223372036854775807L
        const val SIZE_BYTES: Int = 8
        const val SIZE_BITS: Int = 64
    }
}

class Float private constructor() : Number(), Comparable<Float> {
${numberOperators('Float')}
    external operator fun unaryMinus(): Float
    operator fun unaryPlus(): Float = this
    external operator fun inc(): Float
    external operator fun dec(): Float
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    @DeprecatedError external override fun toShort(): Short
    @DeprecatedError external override fun toByte(): Byte
${unsignedConversions(true)}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Float = 1.4E-45f
        const val MAX_VALUE: Float = 3.4028235E38f
        const val POSITIVE_INFINITY: Float = 1.0f / 0.0f
        const val NEGATIVE_INFINITY: Float = -1.0f / 0.0f
        const val NaN: Float = 0.0f / 0.0f
        const val SIZE_BYTES: Int = 4
        const val SIZE_BITS: Int = 32
    }
}

class Double private constructor() : Number(), Comparable<Double> {
${numberOperators('Double')}
    external operator fun unaryMinus(): Double
    operator fun unaryPlus(): Double = this
    external operator fun inc(): Double
    external operator fun dec(): Double
    external override fun toDouble(): Double
    external override fun toFloat(): Float
    external override fun toLong(): Long
    external override fun toInt(): Int
    @DeprecatedError external override fun toShort(): Short
    @DeprecatedError external override fun toByte(): Byte
${unsignedConversions(true)}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: Double = 4.9E-324
        const val MAX_VALUE: Double = 1.7976931348623157E308
        const val POSITIVE_INFINITY: Double = 1.0 / 0.0
        const val NEGATIVE_INFINITY: Double = -1.0 / 0.0
        const val NaN: Double = 0.0 / 0.0
        const val SIZE_BYTES: Int = 8
        const val SIZE_BITS: Int = 64
    }
}

class UByte private constructor() : Comparable<UByte> {
${numberOperators('UByte')}
${unsignedDivision('UByte')}
    external operator fun inc(): UByte
    external operator fun dec(): UByte
    ${unsignedValueConversions()}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: UByte = 0u
        const val MAX_VALUE: UByte = 255u
        const val SIZE_BYTES: Int = 1
        const val SIZE_BITS: Int = 8
    }
}

class UShort private constructor() : Comparable<UShort> {
${numberOperators('UShort')}
${unsignedDivision('UShort')}
    external operator fun inc(): UShort
    external operator fun dec(): UShort
    ${unsignedValueConversions()}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: UShort = 0u
        const val MAX_VALUE: UShort = 65535u
        const val SIZE_BYTES: Int = 2
        const val SIZE_BITS: Int = 16
    }
}

class UInt private constructor() : Comparable<UInt> {
${numberOperators('UInt')}
${unsignedDivision('UInt')}
    external operator fun inc(): UInt
    external operator fun dec(): UInt
    ${unsignedValueConversions()}
    ${unsignedWideBits('UInt')}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: UInt = 0u
        const val MAX_VALUE: UInt = 4294967295u
        const val SIZE_BYTES: Int = 4
        const val SIZE_BITS: Int = 32
    }
}

class ULong private constructor() : Comparable<ULong> {
${numberOperators('ULong')}
${unsignedDivision('ULong')}
    external operator fun inc(): ULong
    external operator fun dec(): ULong
    ${unsignedValueConversions()}
    ${unsignedWideBits('ULong')}
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
    companion object {
        const val MIN_VALUE: ULong = 0uL
        const val MAX_VALUE: ULong = 18446744073709551615uL
        const val SIZE_BYTES: Int = 8
        const val SIZE_BITS: Int = 64
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
    external fun clone(): Array<T>
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

/** Kotlin declares the arithmetic and `compareTo` of each signed number type for every signed number type as the argument. */
function unsignedConversions(floating = false): string {
  const targets = floating ? ['UInt', 'ULong'] : ['UByte', 'UShort', 'UInt', 'ULong'];
  return targets.map((target) => `    external fun to${target}(): ${target}`).join('\n');
}

function unsignedValueConversions(): string {
  const kinds = [...SIGNED_NUMBER_KINDS, ...UNSIGNED_NUMBER_KINDS];
  return kinds.map((kind) => `external fun to${kind}(): ${kind}`).join('\n    ');
}

function unsignedWideBits(kind: 'UInt' | 'ULong'): string {
  return [
    ...['and', 'or', 'xor'].map((name) => `external infix fun ${name}(other: ${kind}): ${kind}`),
    ...['shl', 'shr'].map((name) => `external infix fun ${name}(bitCount: Int): ${kind}`),
    `external fun inv(): ${kind}`,
  ].join('\n    ');
}

function numberOperators(kind: NumericKind): string {
  const operands: readonly NumericKind[] = kind.startsWith('U') ? UNSIGNED_NUMBER_KINDS : SIGNED_NUMBER_KINDS;
  return operands
    .flatMap((other) => [
      ...Object.entries(NUMBER_OPERATOR_NAMES).map(
        ([operator, name]) =>
          `    external operator fun ${name}(other: ${other}): ${arithmeticResult(kind, other, operator as ArithmeticOperator)}`
      ),
      `    external ${other === kind ? 'override' : 'operator'} fun compareTo(other: ${other}): Int`,
    ])
    .join('\n');
}

function unsignedDivision(kind: (typeof UNSIGNED_NUMBER_KINDS)[number]): string {
  return UNSIGNED_NUMBER_KINDS.flatMap((other) => {
    const result = arithmeticResult(kind, other, '/');
    const remainder = result === other ? 'rem(other)' : `rem(other).to${other}()`;
    return [
      `    inline fun floorDiv(other: ${other}): ${result} = div(other)`,
      `    inline fun mod(other: ${other}): ${other} = ${remainder}`,
    ];
  }).join('\n');
}
