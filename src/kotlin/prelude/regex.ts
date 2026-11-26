import { kotlin } from './source';

/** `kotlin.text.Regex` and its matches, as Kotlin/JVM provides them over `java.util.regex`. */
export const REGEX_SOURCE = kotlin`
package kotlin.text

enum class RegexOption { IGNORE_CASE, MULTILINE, LITERAL, UNIX_LINES, COMMENTS, DOT_MATCHES_ALL, CANON_EQ }

data class MatchGroup(val value: String, val range: IntRange)

interface MatchGroupCollection : Collection<MatchGroup?> {
    operator fun get(index: Int): MatchGroup?
}

interface MatchNamedGroupCollection : MatchGroupCollection {
    operator fun get(name: String): MatchGroup?
}

operator fun MatchGroupCollection.get(name: String): MatchGroup? {
    val namedGroups = this as? MatchNamedGroupCollection
        ?: throw UnsupportedOperationException("Retrieving groups by name is not supported on this platform.")
    return namedGroups[name]
}

interface MatchResult {
    val range: IntRange
    val value: String
    val groups: MatchGroupCollection
    val groupValues: List<String>
    val destructured: Destructured
        get() = Destructured(this)
    fun next(): MatchResult?

    class Destructured(val match: MatchResult) {
        operator fun component1(): String = match.groupValues[1]
        operator fun component2(): String = match.groupValues[2]
        operator fun component3(): String = match.groupValues[3]
        operator fun component4(): String = match.groupValues[4]
        operator fun component5(): String = match.groupValues[5]
        operator fun component6(): String = match.groupValues[6]
        operator fun component7(): String = match.groupValues[7]
        operator fun component8(): String = match.groupValues[8]
        operator fun component9(): String = match.groupValues[9]
        operator fun component10(): String = match.groupValues[10]
        fun toList(): List<String> = match.groupValues.subList(1, match.groupValues.size)
    }
}

internal class MatchGroups(private val list: List<MatchGroup?>, private val names: Map<String, Int>) :
    MatchNamedGroupCollection, Collection<MatchGroup?> by list {
    // Shown as a list, as Kotlin/JVM's groups are an AbstractCollection.
    override fun toString(): String = list.toString()
    // As java.util.regex.Matcher.group, which throws for a group the pattern lacks.
    override fun get(index: Int): MatchGroup? =
        if (index < 0 || index >= list.size) throw IndexOutOfBoundsException("No group \$index") else list[index]
    override fun get(name: String): MatchGroup? {
        val index = names[name] ?: throw IllegalArgumentException("No group with name <\$name>")
        return list[index]
    }
}

/** A match, from the group boundaries \`data\` holds in pairs, the whole match's first, with -1 for a group that took no part. */
internal class MatcherMatchResult(private val regex: Regex, private val input: String, private val data: IntArray, private val names: Map<String, Int>) : MatchResult {
    override val range: IntRange get() = data[0] until data[1]
    override val value: String get() = input.substring(data[0], data[1])
    override val groupValues: List<String>
        get() = List(data.size / 2) { index -> if (data[2 * index] < 0) "" else input.substring(data[2 * index], data[2 * index + 1]) }
    override val groups: MatchGroupCollection
        get() = MatchGroups(
            List(data.size / 2) { index ->
                if (data[2 * index] < 0) null else MatchGroup(input.substring(data[2 * index], data[2 * index + 1]), data[2 * index] until data[2 * index + 1])
            },
            names
        )
    override fun next(): MatchResult? {
        val nextIndex = data[1] + if (data[0] == data[1]) 1 else 0
        return if (nextIndex <= input.length) regex.find(input, nextIndex) else null
    }
}

external class Regex {
    external constructor(pattern: String)
    external constructor(pattern: String, option: RegexOption)
    internal external constructor(pattern: String, options: Array<RegexOption>)
    external val pattern: String
    // A set however the options are given, as Kotlin/JVM's Regex keeps them.
    val options: Set<RegexOption> get() = optionList().toSet()
    internal external fun optionList(): List<RegexOption>
    internal external fun matchData(input: String, startIndex: Int, isWhole: Boolean): IntArray?
    internal external fun groupNameArray(): Array<String>
    internal fun groupNames(): Map<String, Int> =
        groupNameArray().withIndex().filter { it.value != "" }.associate { it.value to it.index }
    // A CharSequence reaches the native code as its String, as find's does.
    fun replace(input: CharSequence, replacement: String): String = replaceText(input.toString(), replacement, true)
    fun replaceFirst(input: CharSequence, replacement: String): String =
        replaceText(input.toString(), replacement, false)
    internal external fun replaceText(input: String, replacement: String, isGlobal: Boolean): String

    fun find(input: CharSequence, startIndex: Int = 0): MatchResult? {
        // Kotlin/JVM's find leaves the check to java.util.regex.Matcher.find, whose message this is.
        if (startIndex < 0 || startIndex > input.length) throw IndexOutOfBoundsException("Illegal start index")
        val text = input.toString()
        val data = matchData(text, startIndex, false) ?: return null
        return MatcherMatchResult(this, text, data, groupNames())
    }

    fun findAll(input: CharSequence, startIndex: Int = 0): Sequence<MatchResult> {
        if (startIndex < 0 || startIndex > input.length)
            throw IndexOutOfBoundsException("Start index out of bounds: $startIndex, input length: \${input.length}")
        return generatedSequence({ find(input, startIndex) }, MatchResult::next)
    }

    fun matchEntire(input: CharSequence): MatchResult? {
        val text = input.toString()
        val data = matchData(text, 0, true) ?: return null
        return MatcherMatchResult(this, text, data, groupNames())
    }

    infix fun matches(input: CharSequence): Boolean = matchEntire(input) != null

    fun containsMatchIn(input: CharSequence): Boolean = find(input) != null

    fun replace(input: CharSequence, transform: (MatchResult) -> CharSequence): String {
        var match: MatchResult? = find(input) ?: return input.toString()
        var lastStart = 0
        val length = input.length
        val builder = StringBuilder(length)
        do {
            val found = match!!
            builder.append(input.substring(lastStart, found.range.start))
            builder.append(transform(found))
            lastStart = found.range.endInclusive + 1
            match = found.next()
        } while (lastStart < length && match != null)
        if (lastStart < length) builder.append(input.substring(lastStart, length))
        return builder.toString()
    }

    fun split(input: CharSequence, limit: Int = 0): List<String> {
        require(limit >= 0) { "Limit must be non-negative, but was \$limit" }
        var match = find(input)
        if (limit == 1 || match == null) return listOf(input.toString())
        val result = ArrayList<String>()
        var lastStart = 0
        val lastSplit = limit - 1
        while (match != null) {
            result.add(input.substring(lastStart, match.range.start))
            lastStart = match.range.endInclusive + 1
            if (lastSplit >= 0 && result.size == lastSplit) break
            match = match.next()
        }
        result.add(input.substring(lastStart, input.length))
        return result
    }

    override fun toString(): String = pattern

    companion object {
        fun fromLiteral(literal: String): Regex = Regex(literal, RegexOption.LITERAL)
        // java.util.regex.Pattern.quote, which ends the quotation around each \\E the literal holds.
        fun escape(literal: String): String =
            "\\\\Q" + literal.replace("\\\\E", "\\\\E\\\\\\\\E\\\\Q") + "\\\\E"
        external fun escapeReplacement(literal: String): String
    }
}

fun String.toRegex(): Regex = Regex(this)
fun String.toRegex(option: RegexOption): Regex = Regex(this, option)
// Regex's constructor of a set of options, whose elements reach the native code as an array: only Kotlin code can
// iterate every kind of set.
fun Regex(pattern: String, options: Set<RegexOption>): Regex = Regex(pattern, options.toTypedArray())
fun String.toRegex(options: Set<RegexOption>): Regex = Regex(this, options)
fun CharSequence.replace(regex: Regex, replacement: String): String = regex.replace(this, replacement)
fun CharSequence.replace(regex: Regex, transform: (MatchResult) -> CharSequence): String = regex.replace(this, transform)
fun CharSequence.replaceFirst(regex: Regex, replacement: String): String = regex.replaceFirst(this, replacement)
fun CharSequence.split(regex: Regex, limit: Int = 0): List<String> = regex.split(this, limit)
infix fun CharSequence.matches(regex: Regex): Boolean = regex.matches(this)
operator fun CharSequence.contains(regex: Regex): Boolean = regex.containsMatchIn(this)
`;
