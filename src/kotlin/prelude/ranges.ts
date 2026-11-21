import { kotlin, mixedIntegralOverloads } from './source';

/** `kotlin.ranges`: ranges and progressions, written as the standard library writes them. */
export const RANGES_SOURCE = kotlin`
package kotlin.ranges

interface ClosedRange<T : Comparable<T>> {
    val start: T
    val endInclusive: T
    operator fun contains(value: T): Boolean = value >= start && value <= endInclusive
    fun isEmpty(): Boolean = start > endInclusive
}

interface OpenEndRange<T : Comparable<T>> {
    val start: T
    val endExclusive: T
    operator fun contains(value: T): Boolean = value >= start && value < endExclusive
    fun isEmpty(): Boolean = start >= endExclusive
}

interface ClosedFloatingPointRange<T : Comparable<T>> : ClosedRange<T> {
    fun lessThanOrEquals(a: T, b: T): Boolean
    override fun contains(value: T): Boolean = lessThanOrEquals(start, value) && lessThanOrEquals(value, endInclusive)
    override fun isEmpty(): Boolean = !lessThanOrEquals(start, endInclusive)
}

private class ComparableRange<T : Comparable<T>>(override val start: T, override val endInclusive: T) : ClosedRange<T> {
    override fun equals(other: Any?): Boolean =
        other is ComparableRange<*> && (isEmpty() && other.isEmpty() || start == other.start && endInclusive == other.endInclusive)
    override fun hashCode(): Int = if (isEmpty()) -1 else 31 * start.hashCode() + endInclusive.hashCode()
    override fun toString(): String = "$start..$endInclusive"
}

private class ComparableOpenEndRange<T : Comparable<T>>(override val start: T, override val endExclusive: T) : OpenEndRange<T> {
    override fun equals(other: Any?): Boolean =
        other is ComparableOpenEndRange<*> && (isEmpty() && other.isEmpty() || start == other.start && endExclusive == other.endExclusive)
    override fun hashCode(): Int = if (isEmpty()) -1 else 31 * start.hashCode() + endExclusive.hashCode()
    override fun toString(): String = "$start..<$endExclusive"
}

operator fun <T : Comparable<T>> T.rangeTo(that: T): ClosedRange<T> = ComparableRange(this, that)
operator fun <T : Comparable<T>> T.rangeUntil(that: T): OpenEndRange<T> = ComparableOpenEndRange(this, that)

${floatingRanges()}
${mixedIntegralProgressions()}
${mixedRangeMembership()}

fun <T : Comparable<T>> T.coerceIn(range: ClosedFloatingPointRange<T>): T {
    if (range.isEmpty()) throw IllegalArgumentException("Cannot coerce value to an empty range: $range.")
    if (range.lessThanOrEquals(this, range.start) && !range.lessThanOrEquals(range.start, this)) return range.start
    if (range.lessThanOrEquals(range.endInclusive, this) && !range.lessThanOrEquals(this, range.endInclusive)) return range.endInclusive
    return this
}

private fun mod(a: Int, b: Int): Int {
    val mod = a % b
    return if (mod >= 0) mod else mod + b
}

private fun mod(a: Long, b: Long): Long {
    val mod = a % b
    return if (mod >= 0L) mod else mod + b
}

private fun differenceModulo(a: Int, b: Int, c: Int): Int = mod(mod(a, c) - mod(b, c), c)

private fun differenceModulo(a: Long, b: Long, c: Long): Long = mod(mod(a, c) - mod(b, c), c)

internal fun getProgressionLastElement(start: Int, end: Int, step: Int): Int = when {
    step > 0 -> if (start >= end) end else end - differenceModulo(end, start, step)
    step < 0 -> if (start <= end) end else end + differenceModulo(start, end, -step)
    else -> throw IllegalArgumentException("Step is zero.")
}

internal fun getProgressionLastElement(start: Long, end: Long, step: Long): Long = when {
    step > 0L -> if (start >= end) end else end - differenceModulo(end, start, step)
    step < 0L -> if (start <= end) end else end + differenceModulo(start, end, -step)
    else -> throw IllegalArgumentException("Step is zero.")
}

private fun checkIntProgressionStep(step: Int) {
    if (step == 0) throw IllegalArgumentException("Step must be non-zero.")
    if (step == Int.MIN_VALUE) throw IllegalArgumentException("Step must be greater than Int.MIN_VALUE to avoid overflow on negation.")
}

open class IntProgression internal constructor(val first: Int, val last: Int, val step: Int) : Iterable<Int> {
    override fun iterator(): Iterator<Int> = IntProgressionIterator(first, last, step)
    open fun isEmpty(): Boolean = if (step > 0) first > last else first < last
    override fun equals(other: Any?): Boolean =
        other is IntProgression && (isEmpty() && other.isEmpty() || first == other.first && last == other.last && step == other.step)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * (31 * first + last) + step)
    override fun toString(): String = if (step > 0) "$first..$last step $step" else "$first downTo $last step \${-step}"
    companion object {
        fun fromClosedRange(rangeStart: Int, rangeEnd: Int, step: Int): IntProgression {
            checkIntProgressionStep(step)
            return IntProgression(rangeStart, getProgressionLastElement(rangeStart, rangeEnd, step), step)
        }
    }
}

open class LongProgression internal constructor(val first: Long, val last: Long, val step: Long) : Iterable<Long> {
    override fun iterator(): Iterator<Long> = LongProgressionIterator(first, last, step)
    open fun isEmpty(): Boolean = if (step > 0L) first > last else first < last
    override fun equals(other: Any?): Boolean =
        other is LongProgression && (isEmpty() && other.isEmpty() || first == other.first && last == other.last && step == other.step)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * (31 * (first xor (first ushr 32)) + (last xor (last ushr 32))) + (step xor (step ushr 32))).toInt()
    override fun toString(): String = if (step > 0L) "$first..$last step $step" else "$first downTo $last step \${-step}"
    companion object {
        fun fromClosedRange(rangeStart: Long, rangeEnd: Long, step: Long): LongProgression {
            if (step == 0L) throw IllegalArgumentException("Step must be non-zero.")
            if (step == Long.MIN_VALUE) throw IllegalArgumentException("Step must be greater than Long.MIN_VALUE to avoid overflow on negation.")
            return LongProgression(rangeStart, getProgressionLastElement(rangeStart, rangeEnd, step), step)
        }
    }
}

open class CharProgression internal constructor(val first: Char, val last: Char, val step: Int) : Iterable<Char> {
    override fun iterator(): Iterator<Char> = CharProgressionIterator(first, last, step)
    open fun isEmpty(): Boolean = if (step > 0) first > last else first < last
    override fun equals(other: Any?): Boolean =
        other is CharProgression && (isEmpty() && other.isEmpty() || first == other.first && last == other.last && step == other.step)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * (31 * first.code + last.code) + step)
    override fun toString(): String = if (step > 0) "$first..$last step $step" else "$first downTo $last step \${-step}"
    companion object {
        fun fromClosedRange(rangeStart: Char, rangeEnd: Char, step: Int): CharProgression {
            checkIntProgressionStep(step)
            return CharProgression(rangeStart, getProgressionLastElement(rangeStart.code, rangeEnd.code, step).toChar(), step)
        }
    }
}

class IntProgressionIterator(first: Int, last: Int, val step: Int) : Iterator<Int> {
    private val finalElement: Int = last
    private var hasNextValue: Boolean = if (step > 0) first <= last else first >= last
    private var nextValue: Int = if (hasNextValue) first else finalElement
    override fun hasNext(): Boolean = hasNextValue
    override fun next(): Int {
        val value = nextValue
        if (value == finalElement) {
            if (!hasNextValue) throw NoSuchElementException()
            hasNextValue = false
        } else {
            nextValue += step
        }
        return value
    }
}

class LongProgressionIterator(first: Long, last: Long, val step: Long) : Iterator<Long> {
    private val finalElement: Long = last
    private var hasNextValue: Boolean = if (step > 0L) first <= last else first >= last
    private var nextValue: Long = if (hasNextValue) first else finalElement
    override fun hasNext(): Boolean = hasNextValue
    override fun next(): Long {
        val value = nextValue
        if (value == finalElement) {
            if (!hasNextValue) throw NoSuchElementException()
            hasNextValue = false
        } else {
            nextValue += step
        }
        return value
    }
}

class CharProgressionIterator(first: Char, last: Char, val step: Int) : Iterator<Char> {
    private val finalElement: Int = last.code
    private var hasNextValue: Boolean = if (step > 0) first <= last else first >= last
    private var nextValue: Int = if (hasNextValue) first.code else finalElement
    override fun hasNext(): Boolean = hasNextValue
    override fun next(): Char {
        val value = nextValue
        if (value == finalElement) {
            if (!hasNextValue) throw NoSuchElementException()
            hasNextValue = false
        } else {
            nextValue += step
        }
        return value.toChar()
    }
}

class IntRange(start: Int, endInclusive: Int) : IntProgression(start, endInclusive, 1), ClosedRange<Int>, OpenEndRange<Int> {
    override val start: Int get() = first
    override val endInclusive: Int get() = last
    override val endExclusive: Int get() {
        if (last == Int.MAX_VALUE) throw IllegalStateException("Cannot return the exclusive upper bound of a range that includes MAX_VALUE.")
        return last + 1
    }
    override fun contains(value: Int): Boolean = first <= value && value <= last
    override fun isEmpty(): Boolean = first > last
    override fun equals(other: Any?): Boolean =
        other is IntRange && (isEmpty() && other.isEmpty() || first == other.first && last == other.last)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * first + last)
    override fun toString(): String = "$first..$last"
    companion object {
        val EMPTY: IntRange = IntRange(1, 0)
    }
}

class LongRange(start: Long, endInclusive: Long) : LongProgression(start, endInclusive, 1L), ClosedRange<Long>, OpenEndRange<Long> {
    override val start: Long get() = first
    override val endInclusive: Long get() = last
    override val endExclusive: Long get() {
        if (last == Long.MAX_VALUE) throw IllegalStateException("Cannot return the exclusive upper bound of a range that includes MAX_VALUE.")
        return last + 1L
    }
    override fun contains(value: Long): Boolean = first <= value && value <= last
    override fun isEmpty(): Boolean = first > last
    override fun equals(other: Any?): Boolean =
        other is LongRange && (isEmpty() && other.isEmpty() || first == other.first && last == other.last)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * (first xor (first ushr 32)) + (last xor (last ushr 32))).toInt()
    override fun toString(): String = "$first..$last"
    companion object {
        val EMPTY: LongRange = LongRange(1L, 0L)
    }
}

class CharRange(start: Char, endInclusive: Char) : CharProgression(start, endInclusive, 1), ClosedRange<Char>, OpenEndRange<Char> {
    override val start: Char get() = first
    override val endInclusive: Char get() = last
    override val endExclusive: Char get() {
        if (last == Char.MAX_VALUE) throw IllegalStateException("Cannot return the exclusive upper bound of a range that includes MAX_VALUE.")
        return last + 1
    }
    override fun contains(value: Char): Boolean = first <= value && value <= last
    override fun isEmpty(): Boolean = first > last
    override fun equals(other: Any?): Boolean =
        other is CharRange && (isEmpty() && other.isEmpty() || first == other.first && last == other.last)
    override fun hashCode(): Int = if (isEmpty()) -1 else (31 * first.code + last.code)
    override fun toString(): String = "$first..$last"
    companion object {
        val EMPTY: CharRange = CharRange(1.toChar(), 0.toChar())
    }
}

infix fun Int.downTo(to: Int): IntProgression = IntProgression.fromClosedRange(this, to, -1)
infix fun Long.downTo(to: Long): LongProgression = LongProgression.fromClosedRange(this, to, -1L)
infix fun Char.downTo(to: Char): CharProgression = CharProgression.fromClosedRange(this, to, -1)

infix fun Int.until(to: Int): IntRange {
    if (to <= Int.MIN_VALUE) return IntRange.EMPTY
    return this..(to - 1)
}
infix fun Long.until(to: Long): LongRange {
    if (to <= Long.MIN_VALUE) return LongRange.EMPTY
    return this..(to - 1L)
}
infix fun Char.until(to: Char): CharRange {
    if (to <= '\\u0000') return CharRange.EMPTY
    return this..(to - 1)
}

internal fun checkStepIsPositive(isPositive: Boolean, step: Number) {
    if (!isPositive) throw IllegalArgumentException("Step must be positive, was: $step.")
}

infix fun IntProgression.step(step: Int): IntProgression {
    checkStepIsPositive(step > 0, step)
    return IntProgression.fromClosedRange(first, last, if (this.step > 0) step else -step)
}
infix fun LongProgression.step(step: Long): LongProgression {
    checkStepIsPositive(step > 0L, step)
    return LongProgression.fromClosedRange(first, last, if (this.step > 0L) step else -step)
}
infix fun CharProgression.step(step: Int): CharProgression {
    checkStepIsPositive(step > 0, step)
    return CharProgression.fromClosedRange(first, last, if (this.step > 0) step else -step)
}

fun IntProgression.first(): Int = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else first
fun IntProgression.last(): Int = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else last
fun IntProgression.firstOrNull(): Int? = if (isEmpty()) null else first
fun IntProgression.lastOrNull(): Int? = if (isEmpty()) null else last
fun LongProgression.first(): Long = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else first
fun LongProgression.last(): Long = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else last
fun CharProgression.first(): Char = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else first
fun CharProgression.last(): Char = if (isEmpty()) throw NoSuchElementException("Progression $this is empty.") else last

fun IntProgression.reversed(): IntProgression = IntProgression.fromClosedRange(last, first, -step)
fun LongProgression.reversed(): LongProgression = LongProgression.fromClosedRange(last, first, -step)
fun CharProgression.reversed(): CharProgression = CharProgression.fromClosedRange(last, first, -step)

fun Int.coerceAtLeast(minimumValue: Int): Int = if (this < minimumValue) minimumValue else this
fun Long.coerceAtLeast(minimumValue: Long): Long = if (this < minimumValue) minimumValue else this
fun Double.coerceAtLeast(minimumValue: Double): Double = if (this < minimumValue) minimumValue else this
fun Int.coerceAtMost(maximumValue: Int): Int = if (this > maximumValue) maximumValue else this
fun Long.coerceAtMost(maximumValue: Long): Long = if (this > maximumValue) maximumValue else this
fun Double.coerceAtMost(maximumValue: Double): Double = if (this > maximumValue) maximumValue else this
fun Int.coerceIn(minimumValue: Int, maximumValue: Int): Int {
    if (minimumValue > maximumValue) throw IllegalArgumentException("Cannot coerce value to an empty range: maximum $maximumValue is less than minimum $minimumValue.")
    if (this < minimumValue) return minimumValue
    if (this > maximumValue) return maximumValue
    return this
}
fun Long.coerceIn(minimumValue: Long, maximumValue: Long): Long {
    if (minimumValue > maximumValue) throw IllegalArgumentException("Cannot coerce value to an empty range: maximum $maximumValue is less than minimum $minimumValue.")
    if (this < minimumValue) return minimumValue
    if (this > maximumValue) return maximumValue
    return this
}
fun Double.coerceIn(minimumValue: Double, maximumValue: Double): Double {
    if (minimumValue > maximumValue) throw IllegalArgumentException("Cannot coerce value to an empty range: maximum $maximumValue is less than minimum $minimumValue.")
    if (this < minimumValue) return minimumValue
    if (this > maximumValue) return maximumValue
    return this
}
fun Int.coerceIn(range: ClosedRange<Int>): Int {
    if (range.isEmpty()) throw IllegalArgumentException("Cannot coerce value to an empty range: $range.")
    return if (this < range.start) range.start else if (this > range.endInclusive) range.endInclusive else this
}
fun Long.coerceIn(range: ClosedRange<Long>): Long {
    if (range.isEmpty()) throw IllegalArgumentException("Cannot coerce value to an empty range: $range.")
    return if (this < range.start) range.start else if (this > range.endInclusive) range.endInclusive else this
}

fun Float.coerceAtLeast(minimumValue: Float): Float = if (this < minimumValue) minimumValue else this
fun Float.coerceAtMost(maximumValue: Float): Float = if (this > maximumValue) maximumValue else this
fun Float.coerceIn(minimumValue: Float, maximumValue: Float): Float {
    if (minimumValue > maximumValue) throw IllegalArgumentException("Cannot coerce value to an empty range: maximum $maximumValue is less than minimum $minimumValue.")
    if (this < minimumValue) return minimumValue
    if (this > maximumValue) return maximumValue
    return this
}

fun IntRange.random(): Int = random(kotlin.random.Random)
fun IntRange.random(random: kotlin.random.Random): Int {
    if (isEmpty()) throw NoSuchElementException("Cannot get random in empty range: $this")
    return when {
        last < Int.MAX_VALUE -> random.nextInt(first, last + 1)
        first > Int.MIN_VALUE -> random.nextInt(first - 1, last) + 1
        else -> random.nextInt()
    }
}
fun LongRange.random(): Long = random(kotlin.random.Random)
fun LongRange.random(random: kotlin.random.Random): Long {
    if (isEmpty()) throw NoSuchElementException("Cannot get random in empty range: $this")
    return when {
        last < Long.MAX_VALUE -> random.nextLong(first, last + 1L)
        first > Long.MIN_VALUE -> random.nextLong(first - 1L, last) + 1L
        else -> random.nextLong()
    }
}
fun CharRange.random(): Char = random(kotlin.random.Random)
fun CharRange.random(random: kotlin.random.Random): Char {
    if (isEmpty()) throw NoSuchElementException("Cannot get random in empty range: $this")
    return random.nextInt(first.code, last.code + 1).toChar()
}
`;

function floatingRanges(): string {
  return ['Double', 'Float'].flatMap((type) => [true, false].map((closed) => floatingRange(type, closed))).join('\n');
}

function floatingRange(type: string, closed: boolean): string {
  const range = closed ? 'ClosedFloatingPointRange' : 'OpenEndRange';
  const implementation = closed ? `Closed${type}Range` : `OpenEnd${type}Range`;
  const end = closed ? 'endInclusive' : 'endExclusive';
  const comparison = closed ? '<=' : '<';
  const operator = closed ? 'rangeTo' : 'rangeUntil';
  const display = closed ? '..' : '..<';
  const ordering = closed ? `override fun lessThanOrEquals(a: ${type}, b: ${type}): Boolean = a <= b` : '';
  return kotlin`
private class ${implementation}(override val start: ${type}, override val ${end}: ${type}) : ${range}<${type}> {
    ${ordering}
    override fun contains(value: ${type}): Boolean = start <= value && value ${comparison} ${end}
    override fun isEmpty(): Boolean = !(start ${comparison} ${end})
    override fun equals(other: Any?): Boolean =
        other is ${implementation} && (isEmpty() && other.isEmpty() || start == other.start && ${end} == other.${end})
    override fun hashCode(): Int = if (isEmpty()) -1 else 31 * start.hashCode() + ${end}.hashCode()
    override fun toString(): String = start.toString() + "${display}" + ${end}.toString()
}

operator fun ${type}.${operator}(that: ${type}): ${range}<${type}> = ${implementation}(this, that)
`;
}

function mixedIntegralProgressions(): string {
  return mixedIntegralOverloads((from, to, result) => {
    const receiver = from === result ? 'this' : `to${result}()`;
    const end = to === result ? 'to' : `to.to${result}()`;
    const other = to === result ? 'other' : `other.to${result}()`;
    const rangeTo = `operator fun ${from}.rangeTo(other: ${to}): ${result}Range = ${receiver}.rangeTo(${other})`;
    return [
      `infix fun ${from}.until(to: ${to}): ${result}Range = ${receiver}.until(${end})`,
      `infix fun ${from}.downTo(to: ${to}): ${result}Progression = ${receiver}.downTo(${end})`,
      ...((from === 'Int' && to === 'Long') || (from === 'Long' && to === 'Int') ? [] : [rangeTo]),
      `operator fun ${from}.rangeUntil(other: ${to}): ${result}Range = ${receiver}.rangeUntil(${other})`,
    ];
  });
}

function mixedRangeMembership(): string {
  const integral = ['Byte', 'Short', 'Int', 'Long'];
  const groups = [integral, ['Float', 'Double']];
  return groups
    .flatMap((types) =>
      types.flatMap((target, index) =>
        types.flatMap((source, sourceIndex) => {
          if (source === target) return [];
          const fits =
            types === integral && sourceIndex > index
              ? `value >= ${target}.MIN_VALUE.to${source}() && value <= ${target}.MAX_VALUE.to${source}() && `
              : '';
          return [
            `@JvmName("${target}RangeContains${source}") operator fun ClosedRange<${target}>.contains(value: ${source}): Boolean = ${fits}contains(value.to${target}())`,
          ];
        })
      )
    )
    .join('\n');
}
