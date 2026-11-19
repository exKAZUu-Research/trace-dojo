import { kotlin } from './source';

/** `kotlin.text`: `StringBuilder` and the functions of strings and characters. */
export const TEXT_SOURCE = kotlin`
package kotlin.text

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
    external fun append(value: Char): StringBuilder
    external fun append(value: Int): StringBuilder
    external fun append(value: Long): StringBuilder
    external fun append(value: Double): StringBuilder
    external fun append(value: Boolean): StringBuilder
    external fun insert(index: Int, value: Any?): StringBuilder
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

operator fun CharSequence.iterator(): CharIterator = CharIterator(this)

class CharIterator(private val text: CharSequence) : Iterator<Char> {
    private var index = 0
    override fun hasNext(): Boolean = index < text.length
    override fun next(): Char {
        if (index >= text.length) throw NoSuchElementException(index.toString())
        return text[index++]
    }
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
fun CharSequence.substring(startIndex: Int, endIndex: Int = length): String = subSequence(startIndex, endIndex).toString()
external fun String.startsWith(prefix: String, ignoreCase: Boolean = false): Boolean
external fun String.endsWith(suffix: String, ignoreCase: Boolean = false): Boolean
fun String.startsWith(char: Char): Boolean = this.length > 0 && this[0] == char
fun String.endsWith(char: Char): Boolean = this.length > 0 && this[length - 1] == char
external operator fun CharSequence.contains(other: CharSequence): Boolean
fun CharSequence.contains(other: CharSequence, ignoreCase: Boolean): Boolean =
    if (ignoreCase) toString().lowercase().contains(other.toString().lowercase()) else contains(other)
operator fun CharSequence.contains(char: Char): Boolean = indexOf(char) >= 0
external fun CharSequence.indexOf(string: String, startIndex: Int = 0): Int
external fun CharSequence.indexOf(char: Char, startIndex: Int = 0): Int
external fun CharSequence.lastIndexOf(string: String): Int
external fun CharSequence.lastIndexOf(char: Char): Int
external fun String.replace(oldValue: String, newValue: String, ignoreCase: Boolean = false): String
external fun String.replace(oldChar: Char, newChar: Char): String
external fun String.replaceFirst(oldValue: String, newValue: String): String
external fun String.repeat(n: Int): String
external fun CharSequence.split(vararg delimiters: String): List<String>
external fun CharSequence.split(vararg delimiters: Char): List<String>
external fun CharSequence.lines(): List<String>
external fun String.reversed(): String
fun CharSequence.reversed(): CharSequence = toString().reversed()
external fun String.toCharArray(): CharArray
external fun String.padStart(length: Int, padChar: Char = ' '): String
external fun String.padEnd(length: Int, padChar: Char = ' '): String
external fun String.equals(other: String?, ignoreCase: Boolean): Boolean
external fun String.compareTo(other: String, ignoreCase: Boolean): Int
external fun String.format(vararg args: Any?): String
fun String.Companion.format(format: String, vararg args: Any?): String = format.format(*args)
external fun String.removePrefix(prefix: CharSequence): String
external fun String.removeSuffix(suffix: CharSequence): String
external fun String.removeSurrounding(delimiter: CharSequence): String
external fun String.substringBefore(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringAfter(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringBeforeLast(delimiter: String, missingDelimiterValue: String = this): String
external fun String.substringAfterLast(delimiter: String, missingDelimiterValue: String = this): String
fun String.substringBefore(delimiter: Char): String = substringBefore(delimiter.toString())
fun String.substringAfter(delimiter: Char): String = substringAfter(delimiter.toString())
external fun String.toInt(): Int
external fun String.toInt(radix: Int): Int
external fun String.toIntOrNull(): Int?
external fun String.toLong(): Long
external fun String.toLongOrNull(): Long?
external fun String.toDouble(): Double
external fun String.toDoubleOrNull(): Double?
external fun String.toFloat(): Float
external fun String.toBoolean(): Boolean
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
fun String.take(n: Int): String {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return substring(0, n.coerceAtMost(length))
}
fun String.drop(n: Int): String {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return substring(n.coerceAtMost(length))
}
fun String.takeLast(n: Int): String {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    val length = length
    return substring(length - n.coerceAtMost(length))
}
fun String.dropLast(n: Int): String {
    if (n < 0) throw IllegalArgumentException("Requested character count $n is less than zero.")
    return take((length - n).coerceAtLeast(0))
}
inline fun String.takeWhile(predicate: (Char) -> Boolean): String {
    for (index in 0 until length) if (!predicate(get(index))) return substring(0, index)
    return this
}
inline fun String.dropWhile(predicate: (Char) -> Boolean): String {
    for (index in this.indices) if (!predicate(this[index])) return substring(index)
    return ""
}
inline fun String.filter(predicate: (Char) -> Boolean): String {
    val destination = StringBuilder()
    for (index in 0 until length) {
        val element = get(index)
        if (predicate(element)) destination.append(element)
    }
    return destination.toString()
}
inline fun String.filterNot(predicate: (Char) -> Boolean): String {
    val destination = StringBuilder()
    for (element in this) if (!predicate(element)) destination.append(element)
    return destination.toString()
}
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
inline fun CharSequence.sumOf(selector: (Char) -> Int): Int {
    var sum = 0
    for (element in this) sum += selector(element)
    return sum
}
inline fun <K> CharSequence.groupBy(keySelector: (Char) -> K): Map<K, List<Char>> {
    val destination = LinkedHashMap<K, MutableList<Char>>()
    for (element in this) {
        val key = keySelector(element)
        val list = destination.getOrPut(key) { ArrayList<Char>() }
        list.add(element)
    }
    return destination
}
inline fun <K> CharSequence.groupingBy(crossinline keySelector: (Char) -> K): Grouping<Char, K> = toList().groupingBy(keySelector)
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
fun CharSequence.withIndex(): Iterable<IndexedValue<Char>> = toList().withIndex()
fun CharSequence.chunked(size: Int): List<String> = windowed(size, size, partialWindows = true)
fun CharSequence.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false): List<String> {
    if (!(size > 0 && step > 0)) {
        throw IllegalArgumentException(if (size != step) "Both size $size and step $step must be greater than zero." else "size $size must be greater than zero.")
    }
    val result = ArrayList<String>()
    var index = 0
    while (index < length) {
        val end = index + size
        if (end > length) {
            if (!partialWindows) break
            result.add(substring(index, length))
        } else {
            result.add(substring(index, end))
        }
        index += step
    }
    return result
}
infix fun CharSequence.zip(other: CharSequence): List<Pair<Char, Char>> {
    val length = minOf(this.length, other.length)
    val list = ArrayList<Pair<Char, Char>>(length)
    for (i in 0 until length) list.add(this[i] to other[i])
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
fun CharArray.concatToString(): String {
    val builder = StringBuilder()
    for (c in this) builder.append(c)
    return builder.toString()
}
fun String(chars: CharArray): String = chars.concatToString()

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
external fun Char.digitToInt(): Int
external fun Char.digitToIntOrNull(): Int?
external fun Char.toUpperCase(): Char
external fun Char.toLowerCase(): Char
external fun Char.isDefined(): Boolean
fun Char.equals(other: Char, ignoreCase: Boolean = false): Boolean =
    if (this == other) true else if (!ignoreCase) false else this.uppercaseChar() == other.uppercaseChar() || this.lowercaseChar() == other.lowercaseChar()
external operator fun Char.plus(other: String): String

external fun Int.toString(radix: Int): String
external fun Long.toString(radix: Int): String
external fun Char(code: Int): Char
`;
