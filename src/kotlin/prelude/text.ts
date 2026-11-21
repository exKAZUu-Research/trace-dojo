import { UNSIGNED_NUMBER_KINDS } from '../operators';
import { kotlin } from './source';

/** `java.util.Locale`, which the prelude declares only for the overloads of `format` that take one. */
export const UTIL_SOURCE = kotlin`
package java.util

class Locale private constructor()
`;

/** `kotlin.text`: `StringBuilder` and the functions of strings and characters. */
export const TEXT_SOURCE = kotlin`
package kotlin.text

import java.util.Locale

external class StringBuilder : CharSequence, Comparable<StringBuilder> {
    external constructor()
    external constructor(capacity: Int)
    external constructor(content: String)
    external constructor(content: CharSequence)
    external override val length: Int
    external override operator fun get(index: Int): Char
    external override fun subSequence(startIndex: Int, endIndex: Int): CharSequence
    external fun append(value: Any?): StringBuilder
    external fun append(value: String?): StringBuilder
    external fun append(value: CharSequence?): StringBuilder
    external fun append(value: CharSequence?, startIndex: Int, endIndex: Int): StringBuilder
    external fun append(value: Char): StringBuilder
    external fun append(value: Int): StringBuilder
    external fun append(value: Long): StringBuilder
    external fun append(value: Double): StringBuilder
    external fun append(value: Boolean): StringBuilder
    external fun append(value: CharArray?): StringBuilder
    external fun insert(index: Int, value: Any?): StringBuilder
    external fun insert(index: Int, value: String?): StringBuilder
    external fun insert(index: Int, value: CharArray?): StringBuilder
    external fun insert(index: Int, value: CharSequence?): StringBuilder
    external fun insert(index: Int, value: CharSequence?, startIndex: Int, endIndex: Int): StringBuilder
    external fun reverse(): StringBuilder
    external fun deleteCharAt(index: Int): StringBuilder
    external fun delete(startIndex: Int, endIndex: Int): StringBuilder
    external fun setLength(newLength: Int)
    external fun setCharAt(index: Int, value: Char)
    external fun indexOf(string: String): Int
    external fun lastIndexOf(string: String): Int
    external fun substring(startIndex: Int): String
    external fun substring(startIndex: Int, endIndex: Int): String
    external fun replace(startIndex: Int, endIndex: Int, value: String): StringBuilder
    external override fun compareTo(other: StringBuilder): Int
    external override fun toString(): String
}

fun StringBuilder.appendLine(): StringBuilder = append('\\n')
fun StringBuilder.appendLine(value: Any?): StringBuilder = append(value).append('\\n')
fun StringBuilder.appendLine(value: String?): StringBuilder = append(value).append('\\n')
fun StringBuilder.appendLine(value: CharArray): StringBuilder = append(value).append('\\n')
fun StringBuilder.appendLine(value: CharSequence?): StringBuilder = append(value).append('\\n')
fun StringBuilder.clear(): StringBuilder {
    setLength(0)
    return this
}
operator fun StringBuilder.set(index: Int, value: Char) = setCharAt(index, value)

inline fun buildString(builderAction: StringBuilder.() -> Unit): String = StringBuilder().apply(builderAction).toString()

val CharSequence.indices: IntRange get() = 0..length - 1
val CharSequence.lastIndex: Int get() = this.length - 1

fun CharSequence.isEmpty(): Boolean = length == 0
fun CharSequence.isNotEmpty(): Boolean = length > 0
external fun CharSequence.isBlank(): Boolean
fun CharSequence.isNotBlank(): Boolean = !isBlank()
fun CharSequence?.isNullOrEmpty(): Boolean = this == null || this.length == 0
fun CharSequence?.isNullOrBlank(): Boolean = this == null || this.isBlank()
fun String?.orEmpty(): String = this ?: ""
inline fun <C : CharSequence, R> C.ifEmpty(defaultValue: () -> R): R where C : R = if (isEmpty()) defaultValue() else this
inline fun <C : CharSequence, R> C.ifBlank(defaultValue: () -> R): R where C : R = if (isBlank()) defaultValue() else this

inline fun CharSequence.trim(predicate: (Char) -> Boolean): CharSequence {
    var start = 0
    var end = length - 1
    while (start <= end && predicate(this[start])) start++
    while (end >= start && predicate(this[end])) end--
    return subSequence(start, end + 1)
}
inline fun CharSequence.trimStart(predicate: (Char) -> Boolean): CharSequence {
    for (index in 0 until length) if (!predicate(this[index])) return subSequence(index, length)
    return ""
}
inline fun CharSequence.trimEnd(predicate: (Char) -> Boolean): CharSequence {
    for (index in lastIndex downTo 0) if (!predicate(this[index])) return subSequence(0, index + 1)
    return ""
}
inline fun String.trim(predicate: (Char) -> Boolean): String = (this as CharSequence).trim(predicate).toString()
inline fun String.trimStart(predicate: (Char) -> Boolean): String = (this as CharSequence).trimStart(predicate).toString()
inline fun String.trimEnd(predicate: (Char) -> Boolean): String = (this as CharSequence).trimEnd(predicate).toString()
fun CharSequence.trim(): CharSequence = trim { it.isWhitespace() }
fun CharSequence.trimStart(): CharSequence = trimStart { it.isWhitespace() }
fun CharSequence.trimEnd(): CharSequence = trimEnd { it.isWhitespace() }
fun CharSequence.trim(vararg chars: Char): CharSequence = trim { it in chars }
fun CharSequence.trimStart(vararg chars: Char): CharSequence = trimStart { it in chars }
fun CharSequence.trimEnd(vararg chars: Char): CharSequence = trimEnd { it in chars }
fun String.trim(vararg chars: Char): String = trim { it in chars }
fun String.trimStart(vararg chars: Char): String = trimStart { it in chars }
fun String.trimEnd(vararg chars: Char): String = trimEnd { it in chars }

inline fun CharSequence.getOrElse(index: Int, defaultValue: (Int) -> Char): Char =
    if (index >= 0 && index < length) this[index] else defaultValue(index)
fun CharSequence.single(): Char = when (length) {
    0 -> throw NoSuchElementException("Char sequence is empty.")
    1 -> this[0]
    else -> throw IllegalArgumentException("Char sequence has more than one element.")
}
fun CharSequence.singleOrNull(): Char? = if (length == 1) this[0] else null
inline fun CharSequence.last(predicate: (Char) -> Boolean): Char {
    var index = length - 1
    while (index >= 0) {
        val char = this[index]
        if (predicate(char)) return char
        index--
    }
    throw NoSuchElementException("Char sequence contains no character matching the predicate.")
}
inline fun CharSequence.reduce(operation: (acc: Char, Char) -> Char): Char {
    if (isEmpty()) throw UnsupportedOperationException("Empty char sequence can't be reduced.")
    var accumulator = this[0]
    for (index in 1 until length) accumulator = operation(accumulator, this[index])
    return accumulator
}
inline fun <R> CharSequence.fold(initial: R, operation: (acc: R, Char) -> R): R {
    var result = initial
    for (element in this) result = operation(result, element)
    return result
}
inline fun <R> CharSequence.flatMap(transform: (Char) -> Iterable<R>): List<R> =
    flatMapTo(ArrayList<R>(), transform)
inline fun <R, C : MutableCollection<in R>> CharSequence.flatMapTo(destination: C, transform: (Char) -> Iterable<R>): C {
    for (element in this) destination.addAll(transform(element))
    return destination
}
inline fun <R> CharSequence.flatMapIndexed(transform: (Int, Char) -> Iterable<R>): List<R> =
    flatMapIndexedTo(ArrayList<R>(), transform)
inline fun <R, C : MutableCollection<in R>> CharSequence.flatMapIndexedTo(destination: C, transform: (Int, Char) -> Iterable<R>): C {
    var index = 0
    for (element in this) destination.addAll(transform(index++, element))
    return destination
}
inline fun <V> CharSequence.associateWith(valueSelector: (Char) -> V): Map<Char, V> =
    associateWithTo(LinkedHashMap<Char, V>(), valueSelector)
inline fun CharSequence.partition(predicate: (Char) -> Boolean): Pair<String, String> {
    val first = StringBuilder()
    val second = StringBuilder()
    for (char in this) if (predicate(char)) first.append(char) else second.append(char)
    return Pair(first.toString(), second.toString())
}
fun CharSequence.zipWithNext(): List<Pair<Char, Char>> = zipWithNext { a, b -> a to b }
inline fun <R> CharSequence.zipWithNext(transform: (Char, Char) -> R): List<R> {
    val pairs = length - 1
    if (pairs < 1) return emptyList()
    val result = ArrayList<R>(pairs)
    for (index in 0 until pairs) result.add(transform(this[index], this[index + 1]))
    return result
}
fun CharSequence.asIterable(): Iterable<Char> =
    if (this is String && isEmpty()) emptyList() else CharSequenceIterable(this)

private class CharSequenceIterable(private val source: CharSequence) : Iterable<Char> {
    override fun iterator(): Iterator<Char> = source.iterator()
}
fun <R> CharSequence.chunked(size: Int, transform: (CharSequence) -> R): List<R> =
    windowed(size, size, partialWindows = true, transform = transform)
fun CharSequence.slice(indices: IntRange): CharSequence =
    if (indices.isEmpty()) "" else subSequence(indices.first, indices.last + 1)
fun CharSequence.slice(indices: Iterable<Int>): CharSequence {
    val size = indices.collectionSizeOrDefault(10)
    if (size == 0) return ""
    val part = StringBuilder(size)
    for (index in indices) part.append(this[index])
    return part
}
fun String.slice(indices: Iterable<Int>): String = (this as CharSequence).slice(indices).toString()
fun CharSequence.subSequence(range: IntRange): CharSequence = subSequence(range.start, range.endInclusive + 1)
fun String.slice(indices: IntRange): String = if (indices.isEmpty()) "" else substring(indices.first, indices.last + 1)
fun CharSequence.replaceRange(startIndex: Int, endIndex: Int, replacement: CharSequence): CharSequence {
    if (endIndex < startIndex) throw IndexOutOfBoundsException("End index ($endIndex) is less than start index ($startIndex).")
    return StringBuilder().append(this, 0, startIndex).append(replacement).append(this, endIndex, length)
}
fun CharSequence.replaceRange(range: IntRange, replacement: CharSequence): CharSequence =
    replaceRange(range.start, range.endInclusive + 1, replacement)
fun String.replaceRange(range: IntRange, replacement: CharSequence): String =
    replaceRange(range.start, range.endInclusive + 1, replacement)
fun CharSequence.removeRange(startIndex: Int, endIndex: Int): CharSequence {
    if (endIndex < startIndex) throw IndexOutOfBoundsException("End index ($endIndex) is less than start index ($startIndex).")
    if (startIndex == endIndex) return subSequence(0, length)
    return StringBuilder(length - (endIndex - startIndex)).append(this, 0, startIndex).append(this, endIndex, length)
}
fun CharSequence.removeRange(range: IntRange): CharSequence = removeRange(range.start, range.endInclusive + 1)
fun String.removeRange(range: IntRange): String = removeRange(range.start, range.endInclusive + 1)
fun String.replaceRange(startIndex: Int, endIndex: Int, replacement: CharSequence): String =
    (this as CharSequence).replaceRange(startIndex, endIndex, replacement).toString()
fun String.removeRange(startIndex: Int, endIndex: Int): String =
    (this as CharSequence).removeRange(startIndex, endIndex).toString()
fun String.replaceAfter(delimiter: String, replacement: String, missingDelimiterValue: String = this): String {
    val index = indexOf(delimiter)
    return if (index == -1) missingDelimiterValue else replaceRange(index + delimiter.length, length, replacement)
}
fun String.replaceBefore(delimiter: String, replacement: String, missingDelimiterValue: String = this): String {
    val index = indexOf(delimiter)
    return if (index == -1) missingDelimiterValue else replaceRange(0, index, replacement)
}
fun CharSequence.commonPrefixWith(other: CharSequence, ignoreCase: Boolean = false): String {
    val shorter = minOf(length, other.length)
    var index = 0
    while (index < shorter && this[index].equals(other[index], ignoreCase)) index++
    if (hasSurrogatePairAt(index - 1) || other.hasSurrogatePairAt(index - 1)) index--
    return subSequence(0, index).toString()
}
fun CharSequence.commonSuffixWith(other: CharSequence, ignoreCase: Boolean = false): String {
    val left = length
    val right = other.length
    val shorter = minOf(left, right)
    var count = 0
    while (count < shorter && this[left - count - 1].equals(other[right - count - 1], ignoreCase)) count++
    if (hasSurrogatePairAt(left - count - 1) || other.hasSurrogatePairAt(right - count - 1)) count--
    return subSequence(left - count, left).toString()
}
private fun CharSequence.hasSurrogatePairAt(index: Int): Boolean =
    index >= 0 && index < length - 1 && this[index].code in 0xd800..0xdbff && this[index + 1].code in 0xdc00..0xdfff

fun String.removeSurrounding(prefix: CharSequence, suffix: CharSequence): String =
    if (length >= prefix.length + suffix.length && hasTextAt(prefix, 0, false) && hasTextAt(suffix, length - suffix.length, false))
        substring(prefix.length, length - suffix.length)
    else this

operator fun CharSequence.iterator(): CharIterator = CharIterator(this)

class CharIterator(private val text: CharSequence) : Iterator<Char> {
    private var index = 0
    override fun hasNext(): Boolean = index < text.length
    override fun next(): Char = text[index++]
}

external fun String.uppercase(): String
external fun String.lowercase(): String
external fun String.trim(): String
external fun String.trimStart(): String
external fun String.trimEnd(): String
external fun String.trimIndent(): String
external fun String.trimMargin(marginPrefix: String = "|"): String
external fun String.substring(startIndex: Int): String
external fun String.substring(startIndex: Int, endIndex: Int): String
fun String.substring(range: IntRange): String = substring(range.start, range.endInclusive + 1)
fun CharSequence.substring(range: IntRange): String = subSequence(range.start, range.endInclusive + 1).toString()
fun CharSequence.substring(startIndex: Int, endIndex: Int = length): String = subSequence(startIndex, endIndex).toString()
fun CharSequence.startsWith(prefix: CharSequence, ignoreCase: Boolean = false): Boolean =
    hasTextAt(prefix, 0, ignoreCase)
fun CharSequence.startsWith(prefix: CharSequence, startIndex: Int, ignoreCase: Boolean = false): Boolean =
    hasTextAt(prefix, startIndex, ignoreCase)
fun CharSequence.endsWith(suffix: CharSequence, ignoreCase: Boolean = false): Boolean =
    hasTextAt(suffix, length - suffix.length, ignoreCase)

private external fun CharSequence.hasTextAt(other: CharSequence, startIndex: Int, ignoreCase: Boolean): Boolean

external fun String.startsWith(prefix: String, ignoreCase: Boolean = false): Boolean
fun String.startsWith(prefix: String, startIndex: Int, ignoreCase: Boolean = false): Boolean =
    startIndex >= 0 && startIndex <= length - prefix.length && substring(startIndex, startIndex + prefix.length).equals(prefix, ignoreCase)
external fun String.endsWith(suffix: String, ignoreCase: Boolean = false): Boolean
fun CharSequence.startsWith(char: Char, ignoreCase: Boolean = false): Boolean =
    length > 0 && this[0].equals(char, ignoreCase)
fun CharSequence.endsWith(char: Char, ignoreCase: Boolean = false): Boolean =
    length > 0 && this[length - 1].equals(char, ignoreCase)
external operator fun CharSequence.contains(other: CharSequence): Boolean
external fun CharSequence.contains(other: CharSequence, ignoreCase: Boolean): Boolean
operator fun CharSequence.contains(char: Char, ignoreCase: Boolean = false): Boolean =
    indexOf(char, ignoreCase = ignoreCase) >= 0

operator fun Char.plus(other: String): String = toString() + other
external fun CharSequence.indexOf(string: String, startIndex: Int = 0, ignoreCase: Boolean = false): Int
external fun CharSequence.indexOf(char: Char, startIndex: Int = 0, ignoreCase: Boolean = false): Int
external fun CharSequence.lastIndexOf(string: String, startIndex: Int = lastIndex, ignoreCase: Boolean = false): Int
external fun CharSequence.lastIndexOf(char: Char, startIndex: Int = lastIndex, ignoreCase: Boolean = false): Int
external fun CharSequence.indexOfAny(chars: CharArray, startIndex: Int = 0, ignoreCase: Boolean = false): Int
external fun CharSequence.indexOfAny(strings: Collection<String>, startIndex: Int = 0, ignoreCase: Boolean = false): Int
external fun CharSequence.lastIndexOfAny(chars: CharArray, startIndex: Int = lastIndex, ignoreCase: Boolean = false): Int
external fun CharSequence.lastIndexOfAny(strings: Collection<String>, startIndex: Int = lastIndex, ignoreCase: Boolean = false): Int
external fun CharSequence.findAnyOf(strings: Collection<String>, startIndex: Int = 0, ignoreCase: Boolean = false): Pair<Int, String>?
external fun CharSequence.findLastAnyOf(strings: Collection<String>, startIndex: Int = lastIndex, ignoreCase: Boolean = false): Pair<Int, String>?
external fun CharSequence.regionMatches(thisOffset: Int, other: CharSequence, otherOffset: Int, length: Int, ignoreCase: Boolean = false): Boolean
external infix fun CharSequence?.contentEquals(other: CharSequence?): Boolean
external fun CharSequence?.contentEquals(other: CharSequence?, ignoreCase: Boolean): Boolean
external fun String.replace(oldValue: String, newValue: String, ignoreCase: Boolean = false): String
external fun String.replace(oldChar: Char, newChar: Char): String
external fun String.replaceFirst(oldValue: String, newValue: String): String
external fun String.repeat(n: Int): String
fun CharSequence.repeat(n: Int): String {
    if (n < 0) throw IllegalArgumentException("Count 'n' must be non-negative, but was $n.")
    if (n == 0) return ""
    if (n == 1) return toString()
    when (length) {
        0 -> return ""
        1 -> {
            val char = this[0]
            return String(CharArray(n) { char })
        }
    }
    val result = StringBuilder(n * length)
    for (index in 1..n) result.append(this)
    return result.toString()
}
external fun CharSequence.split(vararg delimiters: String, ignoreCase: Boolean = false, limit: Int = 0): List<String>
external fun CharSequence.split(vararg delimiters: Char, ignoreCase: Boolean = false, limit: Int = 0): List<String>
external fun CharSequence.lines(): List<String>
external fun String.reversed(): String
fun CharSequence.reversed(): CharSequence = StringBuilder(this).reverse()
external fun String.toCharArray(): CharArray
external fun String.toCharArray(startIndex: Int = 0, endIndex: Int = length): CharArray
external fun String.toCharArray(destination: CharArray, destinationOffset: Int = 0, startIndex: Int = 0, endIndex: Int = length): CharArray
fun CharSequence.padStart(length: Int, padChar: Char = ' '): CharSequence {
    if (length < 0) throw IllegalArgumentException("Desired length $length is less than zero.")
    if (length <= this.length) return subSequence(0, this.length)
    val result = StringBuilder(length)
    for (index in 1..(length - this.length)) result.append(padChar)
    return result.append(this)
}
fun CharSequence.padEnd(length: Int, padChar: Char = ' '): CharSequence {
    if (length < 0) throw IllegalArgumentException("Desired length $length is less than zero.")
    if (length <= this.length) return subSequence(0, this.length)
    val result = StringBuilder(length).append(this)
    for (index in 1..(length - this.length)) result.append(padChar)
    return result
}
external fun String.padStart(length: Int, padChar: Char = ' '): String
external fun String.padEnd(length: Int, padChar: Char = ' '): String
external fun String?.equals(other: String?, ignoreCase: Boolean = false): Boolean
external fun String.compareTo(other: String, ignoreCase: Boolean): Int
external fun String.format(vararg args: Any?): String
// The overload taking a Locale, which only a null literal can reach, so that \`"%d".format(null)\` passes the null as
// the locale and no argument, as kotlinc resolves it.
external fun String.format(locale: Locale?, vararg args: Any?): String
fun String.Companion.format(format: String, vararg args: Any?): String = format.format(*args)
fun CharSequence.removePrefix(prefix: CharSequence): CharSequence =
    subSequence(if (startsWith(prefix)) prefix.length else 0, length)
fun CharSequence.removeSuffix(suffix: CharSequence): CharSequence =
    subSequence(0, if (endsWith(suffix)) length - suffix.length else length)
fun CharSequence.removeSurrounding(delimiter: CharSequence): CharSequence = removeSurrounding(delimiter, delimiter)
fun CharSequence.removeSurrounding(prefix: CharSequence, suffix: CharSequence): CharSequence {
    if (length >= prefix.length + suffix.length && startsWith(prefix) && endsWith(suffix))
        return subSequence(prefix.length, length - suffix.length)
    return subSequence(0, length)
}
fun String.removePrefix(prefix: CharSequence): String =
    if (hasTextAt(prefix, 0, false)) substring(prefix.length) else this
fun String.removeSuffix(suffix: CharSequence): String =
    if (hasTextAt(suffix, length - suffix.length, false)) substring(0, length - suffix.length) else this
fun String.removeSurrounding(delimiter: CharSequence): String {
    if (length >= delimiter.length + delimiter.length &&
        hasTextAt(delimiter, 0, false) && hasTextAt(delimiter, length - delimiter.length, false))
        return substring(delimiter.length, length - delimiter.length)
    return this
}
external fun String.substringBefore(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringAfter(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringBeforeLast(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringAfterLast(delimiter: String, missingDelimiterValue: String = this): String
fun String.substringBefore(delimiter: Char, missingDelimiterValue: String = this): String = substringBefore(delimiter.toString(), missingDelimiterValue)
fun String.substringAfter(delimiter: Char, missingDelimiterValue: String = this): String = substringAfter(delimiter.toString(), missingDelimiterValue)
fun String.substringBeforeLast(delimiter: Char, missingDelimiterValue: String = this): String = substringBeforeLast(delimiter.toString(), missingDelimiterValue)
fun String.substringAfterLast(delimiter: Char, missingDelimiterValue: String = this): String = substringAfterLast(delimiter.toString(), missingDelimiterValue)
external fun String.toInt(): Int
external fun String.toInt(radix: Int): Int
external fun String.toIntOrNull(): Int?
external fun String.toIntOrNull(radix: Int): Int?
external fun String.toLong(): Long
external fun String.toLong(radix: Int): Long
external fun String.toLongOrNull(): Long?
external fun String.toLongOrNull(radix: Int): Long?
${UNSIGNED_NUMBER_KINDS.flatMap((kind) => [
  `external fun String.to${kind}(radix: Int = 10): ${kind}`,
  `external fun String.to${kind}OrNull(radix: Int = 10): ${kind}?`,
]).join('\n')}
external fun String.toShort(): Short
external fun String.toShort(radix: Int): Short
external fun String.toShortOrNull(): Short?
external fun String.toShortOrNull(radix: Int): Short?
external fun String.toByte(): Byte
external fun String.toByte(radix: Int): Byte
external fun String.toByteOrNull(): Byte?
external fun String.toByteOrNull(radix: Int): Byte?
fun String.toUIntOrNull(): UInt? {
    if (startsWith('-')) return null
    val value = toLongOrNull() ?: return null
    return if (value <= 4294967295L) value.toUInt() else null
}
fun String.toUInt(): UInt = toUIntOrNull() ?: throw NumberFormatException("Invalid number format: '$this'")
external fun String.toDouble(): Double
external fun String.toDoubleOrNull(): Double?
external fun String.toFloat(): Float
external fun String.toFloatOrNull(): Float?

external fun String?.toBoolean(): Boolean
external fun String.toBooleanStrict(): Boolean
external fun String.capitalize(): String
external fun String.decapitalize(): String
fun CharSequence.first(): Char {
    if (isEmpty()) throw NoSuchElementException("Char sequence is empty.")
    return this[0]
}
fun CharSequence.last(): Char {
    if (isEmpty()) throw NoSuchElementException("Char sequence is empty.")
    return this[lastIndex]
}
fun CharSequence.firstOrNull(): Char? = if (isEmpty()) null else this[0]
fun CharSequence.lastOrNull(): Char? = if (isEmpty()) null else this[length - 1]
fun CharSequence.getOrNull(index: Int): Char? = if (index >= 0 && index < length) get(index) else null
fun CharSequence.elementAt(index: Int): Char = get(index)
inline fun CharSequence.first(predicate: (Char) -> Boolean): Char {
    for (element in this) if (predicate(element)) return element
    throw NoSuchElementException("Char sequence contains no character matching the predicate.")
}
inline fun CharSequence.firstOrNull(predicate: (Char) -> Boolean): Char? {
    for (element in this) if (predicate(element)) return element
    return null
}
inline fun CharSequence.find(predicate: (Char) -> Boolean): Char? = firstOrNull(predicate)
fun CharSequence.take(n: Int): CharSequence {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return subSequence(0, n.coerceAtMost(length))
}
fun CharSequence.drop(n: Int): CharSequence {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return subSequence(n.coerceAtMost(length), length)
}
fun CharSequence.takeLast(n: Int): CharSequence {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return subSequence(length - n.coerceAtMost(length), length)
}
fun CharSequence.dropLast(n: Int): CharSequence {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return take((length - n).coerceAtLeast(0))
}
fun String.take(n: Int): String = (this as CharSequence).take(n).toString()
fun String.drop(n: Int): String = (this as CharSequence).drop(n).toString()
fun String.takeLast(n: Int): String = (this as CharSequence).takeLast(n).toString()
fun String.dropLast(n: Int): String = (this as CharSequence).dropLast(n).toString()
inline fun CharSequence.takeWhile(predicate: (Char) -> Boolean): CharSequence {
    for (index in 0 until length) if (!predicate(this[index])) return subSequence(0, index)
    return subSequence(0, length)
}
inline fun CharSequence.dropWhile(predicate: (Char) -> Boolean): CharSequence {
    for (index in 0 until length) if (!predicate(this[index])) return subSequence(index, length)
    return ""
}
inline fun CharSequence.takeLastWhile(predicate: (Char) -> Boolean): CharSequence {
    for (index in lastIndex downTo 0) if (!predicate(this[index])) return subSequence(index + 1, length)
    return subSequence(0, length)
}
inline fun CharSequence.dropLastWhile(predicate: (Char) -> Boolean): CharSequence {
    for (index in lastIndex downTo 0) if (!predicate(this[index])) return subSequence(0, index + 1)
    return ""
}
inline fun String.takeWhile(predicate: (Char) -> Boolean): String = (this as CharSequence).takeWhile(predicate).toString()
inline fun String.dropWhile(predicate: (Char) -> Boolean): String = (this as CharSequence).dropWhile(predicate).toString()
inline fun String.takeLastWhile(predicate: (Char) -> Boolean): String = (this as CharSequence).takeLastWhile(predicate).toString()
inline fun String.dropLastWhile(predicate: (Char) -> Boolean): String = (this as CharSequence).dropLastWhile(predicate).toString()
inline fun CharSequence.filter(predicate: (Char) -> Boolean): CharSequence {
    val destination = StringBuilder()
    for (index in 0 until length) {
        val element = this[index]
        if (predicate(element)) destination.append(element)
    }
    return destination
}
inline fun CharSequence.filterNot(predicate: (Char) -> Boolean): CharSequence = filter { !predicate(it) }
inline fun CharSequence.filterIndexed(predicate: (Int, Char) -> Boolean): CharSequence {
    val destination = StringBuilder()
    for (index in 0 until length) {
        val element = this[index]
        if (predicate(index, element)) destination.append(element)
    }
    return destination
}
inline fun String.filter(predicate: (Char) -> Boolean): String = (this as CharSequence).filter(predicate).toString()
inline fun String.filterNot(predicate: (Char) -> Boolean): String = (this as CharSequence).filterNot(predicate).toString()
inline fun String.filterIndexed(predicate: (Int, Char) -> Boolean): String = (this as CharSequence).filterIndexed(predicate).toString()
inline fun <R> CharSequence.map(transform: (Char) -> R): List<R> {
    val destination = ArrayList<R>(length)
    for (item in this) destination.add(transform(item))
    return destination
}
inline fun <R> CharSequence.mapIndexed(transform: (index: Int, Char) -> R): List<R> {
    val destination = ArrayList<R>(length)
    var index = 0
    for (item in this) destination.add(transform(index++, item))
    return destination
}
inline fun <R : Any> CharSequence.mapNotNull(transform: (Char) -> R?): List<R> {
    val destination = ArrayList<R>()
    for (element in this) {
        val transformed = transform(element)
        if (transformed != null) destination.add(transformed)
    }
    return destination
}
inline fun CharSequence.forEach(action: (Char) -> Unit) {
    for (element in this) action(element)
}
inline fun CharSequence.forEachIndexed(action: (index: Int, Char) -> Unit) {
    var index = 0
    for (item in this) action(index++, item)
}
inline fun CharSequence.count(predicate: (Char) -> Boolean): Int {
    var count = 0
    for (element in this) if (predicate(element)) ++count
    return count
}
fun CharSequence.count(): Int = length
inline fun CharSequence.any(predicate: (Char) -> Boolean): Boolean {
    for (element in this) if (predicate(element)) return true
    return false
}
inline fun CharSequence.all(predicate: (Char) -> Boolean): Boolean {
    for (element in this) if (!predicate(element)) return false
    return true
}
inline fun CharSequence.none(predicate: (Char) -> Boolean): Boolean {
    for (element in this) if (predicate(element)) return false
    return true
}
inline fun CharSequence.indexOfFirst(predicate: (Char) -> Boolean): Int {
    for (index in indices) if (predicate(this[index])) return index
    return -1
}
inline fun CharSequence.indexOfLast(predicate: (Char) -> Boolean): Int {
    var index = lastIndex
    while (index >= 0) {
        if (predicate(this[index])) return index
        index--
    }
    return -1
}
inline fun <K> CharSequence.groupingBy(crossinline keySelector: (Char) -> K): Grouping<Char, K> = asIterable().groupingBy(keySelector)
fun CharSequence.toList(): List<Char> {
    val result = ArrayList<Char>(length)
    for (char in this) result.add(char)
    return result.optimizeReadOnlyList()
}
fun CharSequence.toMutableList(): MutableList<Char> {
    val result = ArrayList<Char>(length)
    for (char in this) result.add(char)
    return result
}
fun CharSequence.toSet(): Set<Char> = toList().toSet()
fun CharSequence.withIndex(): Iterable<IndexedValue<Char>> = asIterable().withIndex()
fun CharSequence.chunked(size: Int): List<String> = windowed(size, size, partialWindows = true)
fun CharSequence.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false): List<String> =
    windowed(size, step, partialWindows) { it.toString() }

fun <R> CharSequence.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false, transform: (CharSequence) -> R): List<R> {
    checkWindowSizeStep(size, step)
    val thisSize = length
    val result = ArrayList<R>(thisSize / step + if (thisSize % step == 0) 0 else 1)
    var index = 0
    while (index in 0 until thisSize) {
        val count = size.coerceAtMost(thisSize - index)
        if (!partialWindows && count < size) break
        result.add(transform(subSequence(index, index + count)))
        index += step
    }
    return result
}
infix fun CharSequence.zip(other: CharSequence): List<Pair<Char, Char>> =
    zip(other) { a, b -> a to b }

inline fun <V> CharSequence.zip(other: CharSequence, transform: (a: Char, b: Char) -> V): List<V> {
    val length = minOf(this.length, other.length)
    val list = ArrayList<V>(length)
    for (i in 0 until length) list.add(transform(this[i], other[i]))
    return list
}
fun CharSequence.max(): Char {
    if (isEmpty()) throw NoSuchElementException()
    var max = this[0]
    for (i in 1..lastIndex) {
        val e = this[i]
        if (max < e) max = e
    }
    return max
}
fun CharSequence.min(): Char {
    if (isEmpty()) throw NoSuchElementException()
    var min = this[0]
    for (i in 1..lastIndex) {
        val e = this[i]
        if (min > e) min = e
    }
    return min
}
fun CharSequence.maxOrNull(): Char? = if (isEmpty()) null else max()
fun CharSequence.minOrNull(): Char? = if (isEmpty()) null else min()
inline fun String.replaceFirstChar(transform: (Char) -> CharSequence): String =
    if (isNotEmpty()) transform(this[0]).toString() + substring(1) else this
@JvmName("replaceFirstCharWithChar")
inline fun String.replaceFirstChar(transform: (Char) -> Char): String =
    if (isNotEmpty()) transform(this[0]).toString() + substring(1) else this
fun CharArray.concatToString(): String = String(this, 0, size)
fun CharArray.concatToString(startIndex: Int, endIndex: Int): String {
    if (startIndex < 0 || endIndex > size)
        throw IndexOutOfBoundsException("startIndex: $startIndex, endIndex: $endIndex, size: $size")
    if (startIndex > endIndex) throw IllegalArgumentException("startIndex: $startIndex > endIndex: $endIndex")
    return String(this, startIndex, endIndex - startIndex)
}
fun String(chars: CharArray): String = chars.concatToString()
external fun String(chars: CharArray, offset: Int, length: Int): String

external fun Char.isDigit(): Boolean
external fun Char.isLetter(): Boolean
external fun Char.isLetterOrDigit(): Boolean
external fun Char.isWhitespace(): Boolean
external fun Char.isUpperCase(): Boolean
external fun Char.isLowerCase(): Boolean
external fun Char.uppercaseChar(): Char
external fun Char.lowercaseChar(): Char
external fun Char.uppercase(): String
external fun Char.lowercase(): String
external fun Char.titlecase(): String
external fun Char.titlecaseChar(): Char
external fun Char.digitToInt(): Int
external fun Char.digitToInt(radix: Int): Int
external fun Char.digitToIntOrNull(): Int?
external fun Char.digitToIntOrNull(radix: Int): Int?
@DeprecatedError external fun Char.toUpperCase(): Char
@DeprecatedError external fun Char.toLowerCase(): Char
external fun Char.isDefined(): Boolean
external fun Char.equals(other: Char, ignoreCase: Boolean = false): Boolean
external operator fun Char.plus(other: String): String

fun Int.digitToChar(): Char {
    if (this < 0 || this > 9) throw IllegalArgumentException("Int $this is not a decimal digit")
    return ('0'.code + this).toChar()
}
fun Int.digitToChar(radix: Int): Char {
    if (radix < 2 || radix > 36) throw IllegalArgumentException("Invalid radix: $radix. Valid radix values are in range 2..36")
    if (this < 0 || this >= radix) throw IllegalArgumentException("Digit $this does not represent a valid digit in radix $radix")
    val first = if (this < 10) '0'.code else 'A'.code - 10
    return (first + this).toChar()
}
external fun Int.toString(radix: Int): String
external fun Long.toString(radix: Int): String
external fun Char(code: Int): Char
`;
