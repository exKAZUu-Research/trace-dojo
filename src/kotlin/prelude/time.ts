import { kotlin } from './source';

/** `kotlin.time`: Duration values and conversions. */
export const TIME_SOURCE = kotlin`
package kotlin.time

enum class DurationUnit(internal val nanos: Long) {
    NANOSECONDS(1L),
    MICROSECONDS(1000L),
    MILLISECONDS(1000000L),
    SECONDS(1000000000L),
    MINUTES(60000000000L),
    HOURS(3600000000000L),
    DAYS(86400000000000L)
}

class Duration internal constructor(internal val raw: Long) : Comparable<Duration> {
    operator fun plus(other: Duration): Duration = Duration(durationPlus(raw, other.raw))
    operator fun minus(other: Duration): Duration = this + (-other)
    operator fun times(scale: Int): Duration = Duration(durationTimes(raw, scale))
    operator fun times(scale: Double): Duration = Duration(durationTimes(raw, scale))
    operator fun div(scale: Int): Duration = Duration(durationDiv(raw, scale))
    operator fun div(scale: Double): Duration = Duration(durationDiv(raw, scale))
    operator fun div(other: Duration): Double = durationRatio(raw, other.raw)
    operator fun unaryMinus(): Duration = Duration(-(raw shr 1) * 2L + (raw and 1L))
    override fun compareTo(other: Duration): Int = durationCompare(raw, other.raw)
    override fun equals(other: Any?): Boolean = other is Duration && raw == other.raw
    override fun hashCode(): Int = (raw xor (raw ushr 32)).toInt()
    fun isNegative(): Boolean = raw < 0L
    fun isPositive(): Boolean = raw > 0L
    fun isInfinite(): Boolean = raw == Long.MAX_VALUE || raw == Long.MIN_VALUE + 3L
    fun isFinite(): Boolean = !isInfinite()
    val absoluteValue: Duration get() = if (isNegative()) -this else this
    val inWholeDays: Long get() = toLong(DurationUnit.DAYS)
    val inWholeHours: Long get() = toLong(DurationUnit.HOURS)
    val inWholeMinutes: Long get() = toLong(DurationUnit.MINUTES)
    val inWholeSeconds: Long get() = toLong(DurationUnit.SECONDS)
    val inWholeMilliseconds: Long get() = toLong(DurationUnit.MILLISECONDS)
    val inWholeMicroseconds: Long get() = toLong(DurationUnit.MICROSECONDS)
    val inWholeNanoseconds: Long get() = toLong(DurationUnit.NANOSECONDS)
    fun toDouble(unit: DurationUnit): Double = durationToDouble(raw, unit.nanos)
    fun toLong(unit: DurationUnit): Long = durationToLong(raw, unit.nanos)

    override fun toString(): String {
        if (raw == 0L) return "0s"
        if (isInfinite()) return if (isNegative()) "-Infinity" else "Infinity"
        val isNegative = isNegative()
        val absolute = absoluteValue
        val days = absolute.inWholeDays
        val hours = (absolute.inWholeHours % 24L).toInt()
        val minutes = (absolute.inWholeMinutes % 60L).toInt()
        val seconds = (absolute.inWholeSeconds % 60L).toInt()
        val nanoseconds = durationSubsecondNanos(absolute.raw)
        val builder = StringBuilder()
        if (isNegative) builder.append('-')
        val hasDays = days != 0L
        val hasHours = hours != 0
        val hasMinutes = minutes != 0
        val hasSeconds = seconds != 0 || nanoseconds != 0
        var components = 0
        if (hasDays) {
            builder.append(days).append('d')
            components++
        }
        if (hasHours || (hasDays && (hasMinutes || hasSeconds))) {
            if (components++ > 0) builder.append(' ')
            builder.append(hours).append('h')
        }
        if (hasMinutes || (hasSeconds && (hasHours || hasDays))) {
            if (components++ > 0) builder.append(' ')
            builder.append(minutes).append('m')
        }
        if (hasSeconds) {
            if (components++ > 0) builder.append(' ')
            when {
                seconds != 0 || hasDays || hasHours || hasMinutes -> appendFractional(builder, seconds, nanoseconds, 9, "s")
                nanoseconds >= 1000000 -> appendFractional(builder, nanoseconds / 1000000, nanoseconds % 1000000, 6, "ms")
                nanoseconds >= 1000 -> appendFractional(builder, nanoseconds / 1000, nanoseconds % 1000, 3, "us")
                else -> builder.append(nanoseconds).append("ns")
            }
        }
        if (isNegative && components > 1) {
            builder.insert(1, '(')
            builder.append(')')
        }
        return builder.toString()
    }

    private fun appendFractional(builder: StringBuilder, whole: Int, fractional: Int, fractionalSize: Int, unit: String) {
        builder.append(whole)
        if (fractional != 0) {
            builder.append('.')
            val fracString = fractional.toString().padStart(fractionalSize, '0')
            val nonZeroDigits = fracString.indexOfLast { it != '0' } + 1
            if (nonZeroDigits < 3) builder.append(fracString.substring(0, nonZeroDigits))
            else builder.append(fracString.substring(0, ((nonZeroDigits + 2) / 3) * 3))
        }
        builder.append(unit)
    }

    companion object {
        val ZERO: Duration = Duration(0L)
        val INFINITE: Duration = Duration(Long.MAX_VALUE)
        val Int.nanoseconds: Duration get() = toDuration(DurationUnit.NANOSECONDS)
        val Int.microseconds: Duration get() = toDuration(DurationUnit.MICROSECONDS)
        val Int.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Int.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Int.minutes: Duration get() = toDuration(DurationUnit.MINUTES)
        val Int.hours: Duration get() = toDuration(DurationUnit.HOURS)
        val Int.days: Duration get() = toDuration(DurationUnit.DAYS)
        val Long.nanoseconds: Duration get() = toDuration(DurationUnit.NANOSECONDS)
        val Long.microseconds: Duration get() = toDuration(DurationUnit.MICROSECONDS)
        val Long.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Long.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Long.minutes: Duration get() = toDuration(DurationUnit.MINUTES)
        val Long.hours: Duration get() = toDuration(DurationUnit.HOURS)
        val Long.days: Duration get() = toDuration(DurationUnit.DAYS)
        val Double.nanoseconds: Duration get() = toDuration(DurationUnit.NANOSECONDS)
        val Double.microseconds: Duration get() = toDuration(DurationUnit.MICROSECONDS)
        val Double.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Double.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Double.minutes: Duration get() = toDuration(DurationUnit.MINUTES)
        val Double.hours: Duration get() = toDuration(DurationUnit.HOURS)
        val Double.days: Duration get() = toDuration(DurationUnit.DAYS)
    }
}

fun Int.toDuration(unit: DurationUnit): Duration = toLong().toDuration(unit)
fun Long.toDuration(unit: DurationUnit): Duration = Duration(durationFromLong(this, unit.nanos))
fun Double.toDuration(unit: DurationUnit): Duration = Duration(durationFromDouble(this, unit.nanos))
inline operator fun Int.times(duration: Duration): Duration = duration * this
inline operator fun Double.times(duration: Duration): Duration = duration * this

inline fun measureTime(block: () -> Unit): Duration {
    val start = monotonicNanos()
    block()
    return (monotonicNanos() - start).toDuration(DurationUnit.NANOSECONDS)
}

internal external fun durationFromLong(value: Long, unit: Long): Long
internal external fun durationFromDouble(value: Double, unit: Long): Long
internal external fun durationPlus(left: Long, right: Long): Long
internal external fun durationTimes(raw: Long, scale: Int): Long
internal external fun durationTimes(raw: Long, scale: Double): Long
internal external fun durationDiv(raw: Long, scale: Int): Long
internal external fun durationDiv(raw: Long, scale: Double): Long
internal external fun durationRatio(left: Long, right: Long): Double
internal external fun durationCompare(left: Long, right: Long): Int
internal external fun durationToDouble(raw: Long, unit: Long): Double
internal external fun durationToLong(raw: Long, unit: Long): Long
internal external fun durationSubsecondNanos(raw: Long): Int

internal external fun monotonicNanos(): Long
`;
