import { kotlin } from './source';

/** `kotlin.time`: durations, transcribed from Kotlin's standard library, which holds them in nanoseconds. */
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

class Duration internal constructor(internal val nanos: Long) : Comparable<Duration> {
    operator fun plus(other: Duration): Duration = Duration(nanos + other.nanos)
    operator fun minus(other: Duration): Duration = Duration(nanos - other.nanos)
    operator fun times(scale: Int): Duration = Duration(nanos * scale)
    operator fun div(scale: Int): Duration = Duration(nanos / scale)
    operator fun div(other: Duration): Double = nanos.toDouble() / other.nanos.toDouble()
    operator fun unaryMinus(): Duration = Duration(-nanos)
    override fun compareTo(other: Duration): Int = nanos.compareTo(other.nanos)
    override fun equals(other: Any?): Boolean = other is Duration && nanos == other.nanos
    override fun hashCode(): Int = (nanos xor (nanos ushr 32)).toInt()
    fun isNegative(): Boolean = nanos < 0L
    fun isPositive(): Boolean = nanos > 0L
    val absoluteValue: Duration get() = if (isNegative()) -this else this
    val inWholeDays: Long get() = nanos / 86400000000000L
    val inWholeHours: Long get() = nanos / 3600000000000L
    val inWholeMinutes: Long get() = nanos / 60000000000L
    val inWholeSeconds: Long get() = nanos / 1000000000L
    val inWholeMilliseconds: Long get() = nanos / 1000000L
    val inWholeMicroseconds: Long get() = nanos / 1000L
    val inWholeNanoseconds: Long get() = nanos
    fun toDouble(unit: DurationUnit): Double = nanos.toDouble() / unit.nanos.toDouble()
    fun toLong(unit: DurationUnit): Long = nanos / unit.nanos

    override fun toString(): String {
        if (nanos == 0L) return "0s"
        val isNegative = isNegative()
        val absolute = if (isNegative) -nanos else nanos
        val days = absolute / 86400000000000L
        val hours = ((absolute / 3600000000000L) % 24L).toInt()
        val minutes = ((absolute / 60000000000L) % 60L).toInt()
        val seconds = ((absolute / 1000000000L) % 60L).toInt()
        val nanoseconds = (absolute % 1000000000L).toInt()
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
        val Int.nanoseconds: Duration get() = toDuration(DurationUnit.NANOSECONDS)
        val Int.microseconds: Duration get() = toDuration(DurationUnit.MICROSECONDS)
        val Int.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Int.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Int.minutes: Duration get() = toDuration(DurationUnit.MINUTES)
        val Int.hours: Duration get() = toDuration(DurationUnit.HOURS)
        val Int.days: Duration get() = toDuration(DurationUnit.DAYS)
        val Long.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Long.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Double.milliseconds: Duration get() = toDuration(DurationUnit.MILLISECONDS)
        val Double.seconds: Duration get() = toDuration(DurationUnit.SECONDS)
        val Double.minutes: Duration get() = toDuration(DurationUnit.MINUTES)
        val Double.hours: Duration get() = toDuration(DurationUnit.HOURS)
        val Double.days: Duration get() = toDuration(DurationUnit.DAYS)
    }
}

fun Int.toDuration(unit: DurationUnit): Duration = Duration(this.toLong() * unit.nanos)
fun Long.toDuration(unit: DurationUnit): Duration = Duration(this * unit.nanos)
fun Double.toDuration(unit: DurationUnit): Duration {
    if (isNaN()) throw IllegalArgumentException("Duration value cannot be NaN.")
    return Duration(kotlin.math.round(this * unit.nanos.toDouble()).toLong())
}

inline fun measureTime(block: () -> Unit): Duration {
    val start = monotonicNanos()
    block()
    return Duration(monotonicNanos() - start)
}

internal external fun monotonicNanos(): Long
`;
