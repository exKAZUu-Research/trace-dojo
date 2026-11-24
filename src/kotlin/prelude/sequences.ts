import { kotlin } from './source';

/** `kotlin.sequences`: lazily evaluated sequences, transcribed from Kotlin's standard library. */
export const SEQUENCES_SOURCE = kotlin`
package kotlin.sequences

interface Sequence<out T> {
    operator fun iterator(): Iterator<T>
}

/** An iterator that computes its next element only when asked, as Kotlin's AbstractIterator does. */
internal class StepIterator<T>(private val step: (StepIterator<T>) -> Unit) : Iterator<T> {
    private var state = 2
    private var nextValue: Any? = null

    override fun hasNext(): Boolean {
        if (state == 1) return false
        if (state == 0) return true
        state = 3
        step(this)
        return state == 0
    }

    @Suppress("UNCHECKED_CAST")
    override fun next(): T {
        if (!hasNext()) throw NoSuchElementException()
        state = 2
        return nextValue as T
    }

    fun emit(value: T) {
        nextValue = value
        state = 0
    }

    fun finish() {
        state = 1
    }
}

internal class IteratorSequence<T>(private val factory: () -> Iterator<T>) : Sequence<T> {
    override fun iterator(): Iterator<T> = factory()
}

internal class ConstrainedOnceSequence<T>(private val sequence: Sequence<T>) : Sequence<T> {
    private var used = false
    override fun iterator(): Iterator<T> {
        if (used) throw IllegalStateException("This sequence can be consumed only once.")
        used = true
        return sequence.iterator()
    }
}

fun <T> Sequence(iterator: () -> Iterator<T>): Sequence<T> = IteratorSequence(iterator)

fun <T> sequenceOf(vararg elements: T): Sequence<T> = elements.asSequence()

fun <T> emptySequence(): Sequence<T> = IteratorSequence { emptyList<T>().iterator() }

fun <T> Iterable<T>.asSequence(): Sequence<T> = IteratorSequence { this.iterator() }

fun <T> Array<out T>.asSequence(): Sequence<T> = IteratorSequence { this.iterator() }

fun IntArray.asSequence(): Sequence<Int> = IteratorSequence { this.iterator() }

fun CharSequence.asSequence(): Sequence<Char> = IteratorSequence { this.iterator() }

fun <K, V> Map<out K, V>.asSequence(): Sequence<Map.Entry<K, V>> = entries.asSequence()

fun <T> Sequence<T>.asSequence(): Sequence<T> = this

fun <T> Iterator<T>.asSequence(): Sequence<T> = Sequence { this }.constrainOnce()

fun <T> Sequence<T>.constrainOnce(): Sequence<T> = if (this is ConstrainedOnceSequence<*>) this else ConstrainedOnceSequence(this)

fun <T> Sequence<T>.asIterable(): Iterable<T> = SequenceIterable(this)

internal class SequenceIterable<T>(private val sequence: Sequence<T>) : Iterable<T> {
    override fun iterator(): Iterator<T> = sequence.iterator()
}

fun <T : Any> generateSequence(nextFunction: () -> T?): Sequence<T> =
    generatedSequence<T>(nextFunction, { _: T -> nextFunction() }).constrainOnce()

fun <T : Any> generateSequence(seed: T?, nextFunction: (T) -> T?): Sequence<T> =
    if (seed == null) emptySequence() else generatedSequence<T>({ seed }, nextFunction)

fun <T : Any> generateSequence(seedFunction: () -> T?, nextFunction: (T) -> T?): Sequence<T> =
    generatedSequence(seedFunction, nextFunction)

internal fun <T : Any> generatedSequence(seedFunction: () -> T?, nextFunction: (T) -> T?): Sequence<T> = Sequence {
    var current: T? = null
    var started = false
    StepIterator<T> { step ->
        current = if (started) nextFunction(current as T) else seedFunction()
        started = true
        val value = current
        if (value == null) step.finish() else step.emit(value)
    }
}

fun <T, R> Sequence<T>.map(transform: (T) -> R): Sequence<R> = Sequence {
    val source = iterator()
    StepIterator<R> { step -> if (source.hasNext()) step.emit(transform(source.next())) else step.finish() }
}

fun <T, R> Sequence<T>.mapIndexed(transform: (index: Int, T) -> R): Sequence<R> = Sequence {
    val source = iterator()
    var index = 0
    StepIterator<R> { step -> if (source.hasNext()) step.emit(transform(index++, source.next())) else step.finish() }
}

fun <T, R : Any> Sequence<T>.mapNotNull(transform: (T) -> R?): Sequence<R> = map(transform).filterNotNull()

fun <T> Sequence<T>.filter(predicate: (T) -> Boolean): Sequence<T> = Sequence {
    val source = iterator()
    StepIterator<T> { step ->
        var found = false
        while (!found && source.hasNext()) {
            val element = source.next()
            if (predicate(element)) {
                step.emit(element)
                found = true
            }
        }
        if (!found) step.finish()
    }
}

fun <T> Sequence<T>.filterNot(predicate: (T) -> Boolean): Sequence<T> = filter { !predicate(it) }

fun <T> Sequence<T>.filterIndexed(predicate: (index: Int, T) -> Boolean): Sequence<T> {
    var index = 0
    return filter { predicate(index++, it) }
}

@Suppress("UNCHECKED_CAST")
fun <T : Any> Sequence<T?>.filterNotNull(): Sequence<T> = filter { it != null } as Sequence<T>

@Suppress("UNCHECKED_CAST")
inline fun <reified R> Sequence<*>.filterIsInstance(): Sequence<R> = filter { it is R } as Sequence<R>

fun <T> Sequence<T>.take(n: Int): Sequence<T> {
    require(n >= 0) { "Requested element count $n is less than zero." }
    return Sequence {
        val source = iterator()
        var left = n
        StepIterator<T> { step -> if (left > 0 && source.hasNext()) { left--; step.emit(source.next()) } else step.finish() }
    }
}

fun <T> Sequence<T>.takeWhile(predicate: (T) -> Boolean): Sequence<T> = Sequence {
    val source = iterator()
    var done = false
    StepIterator<T> { step ->
        if (!done && source.hasNext()) {
            val element = source.next()
            if (predicate(element)) step.emit(element) else { done = true; step.finish() }
        } else step.finish()
    }
}

fun <T> Sequence<T>.drop(n: Int): Sequence<T> {
    require(n >= 0) { "Requested element count $n is less than zero." }
    return Sequence {
        val source = iterator()
        var left = n
        StepIterator<T> { step ->
            while (left > 0 && source.hasNext()) { source.next(); left-- }
            if (source.hasNext()) step.emit(source.next()) else step.finish()
        }
    }
}

fun <T> Sequence<T>.dropWhile(predicate: (T) -> Boolean): Sequence<T> = Sequence {
    val source = iterator()
    var dropping = true
    StepIterator<T> { step ->
        var emitted = false
        while (!emitted && source.hasNext()) {
            val element = source.next()
            if (dropping && predicate(element)) continue
            dropping = false
            step.emit(element)
            emitted = true
        }
        if (!emitted) step.finish()
    }
}

fun <T> Sequence<T>.onEach(action: (T) -> Unit): Sequence<T> = map { action(it); it }

fun <T> Sequence<T>.onEachIndexed(action: (index: Int, T) -> Unit): Sequence<T> = mapIndexed { index, element -> action(index, element); element }

fun <T, R> Sequence<T>.flatMap(transform: (T) -> Sequence<R>): Sequence<R> = Sequence {
    val source = iterator()
    var inner: Iterator<R>? = null
    StepIterator<R> { step ->
        var emitted = false
        while (!emitted) {
            val current = inner
            if (current != null && current.hasNext()) {
                step.emit(current.next())
                emitted = true
            } else if (source.hasNext()) {
                inner = transform(source.next()).iterator()
            } else break
        }
        if (!emitted) step.finish()
    }
}

@JvmName("flatMapIterable")
fun <T, R> Sequence<T>.flatMap(transform: (T) -> Iterable<R>): Sequence<R> = flatMap { transform(it).asSequence() }

fun <T> Sequence<Sequence<T>>.flatten(): Sequence<T> = flatMap { it }

fun <T> Sequence<T>.distinct(): Sequence<T> = distinctBy { it }

fun <T, K> Sequence<T>.distinctBy(selector: (T) -> K): Sequence<T> = Sequence {
    val seen = HashSet<K>()
    iterator().asSequence().filter { seen.add(selector(it)) }.iterator()
}

fun <T> Sequence<T>.withIndex(): Sequence<IndexedValue<T>> = mapIndexed { index, value -> IndexedValue(index, value) }

infix fun <T, R> Sequence<T>.zip(other: Sequence<R>): Sequence<Pair<T, R>> = zip(other) { a, b -> a to b }

fun <T, R, V> Sequence<T>.zip(other: Sequence<R>, transform: (a: T, b: R) -> V): Sequence<V> = Sequence {
    val first = iterator()
    val second = other.iterator()
    StepIterator<V> { step -> if (first.hasNext() && second.hasNext()) step.emit(transform(first.next(), second.next())) else step.finish() }
}

fun <T> Sequence<T>.zipWithNext(): Sequence<Pair<T, T>> = zipWithNext { a, b -> a to b }

fun <T, R> Sequence<T>.zipWithNext(transform: (a: T, b: T) -> R): Sequence<R> = Sequence {
    val source = iterator()
    var hasPrevious = false
    var previous: Any? = null
    StepIterator<R> { step ->
        if (!hasPrevious && source.hasNext()) { previous = source.next(); hasPrevious = true }
        @Suppress("UNCHECKED_CAST")
        if (hasPrevious && source.hasNext()) {
            val current = source.next()
            step.emit(transform(previous as T, current))
            previous = current
        } else step.finish()
    }
}

fun <T> Sequence<T>.chunked(size: Int): Sequence<List<T>> = windowed(size, size, true)

fun <T, R> Sequence<T>.chunked(size: Int, transform: (List<T>) -> R): Sequence<R> = windowed(size, size, true).map(transform)

fun <T> Sequence<T>.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false): Sequence<List<T>> {
    require(size > 0 && step > 0) { if (size != step) "Both size $size and step $step must be greater than zero." else "size $size must be greater than zero." }
    return Sequence {
        val source = iterator()
        val buffer = ArrayList<T>()
        var skip = 0
        StepIterator<List<T>> { emitter ->
            while (skip > 0 && source.hasNext()) { source.next(); skip-- }
            while (buffer.size < size && source.hasNext()) buffer.add(source.next())
            if (buffer.size == size || (partialWindows && buffer.isNotEmpty())) {
                emitter.emit(ArrayList(buffer))
                if (step >= buffer.size) { skip = step - buffer.size; buffer.clear() } else repeat(step) { buffer.removeAt(0) }
            } else emitter.finish()
        }
    }
}

fun <T, R> Sequence<T>.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false, transform: (List<T>) -> R): Sequence<R> =
    windowed(size, step, partialWindows).map(transform)

fun <T, R> Sequence<T>.runningFold(initial: R, operation: (acc: R, T) -> R): Sequence<R> = Sequence {
    val source = iterator()
    var accumulator = initial
    var started = false
    StepIterator<R> { step ->
        if (!started) { started = true; step.emit(accumulator) }
        else if (source.hasNext()) { accumulator = operation(accumulator, source.next()); step.emit(accumulator) }
        else step.finish()
    }
}

fun <T, R> Sequence<T>.scan(initial: R, operation: (acc: R, T) -> R): Sequence<R> = runningFold(initial, operation)

operator fun <T> Sequence<T>.plus(element: T): Sequence<T> = sequenceOf(this, sequenceOf(element)).flatten()

operator fun <T> Sequence<T>.plus(elements: Sequence<T>): Sequence<T> = sequenceOf(this, elements).flatten()

operator fun <T> Sequence<T>.plus(elements: Iterable<T>): Sequence<T> = sequenceOf(this, elements.asSequence()).flatten()

operator fun <T> Sequence<T>.minus(element: T): Sequence<T> = Sequence {
    var removed = false
    iterator().asSequence().filter { if (!removed && it == element) { removed = true; false } else true }.iterator()
}

fun <T : Comparable<T>> Sequence<T>.sorted(): Sequence<T> = Sequence { toMutableList().apply { sort() }.iterator() }

fun <T : Comparable<T>> Sequence<T>.sortedDescending(): Sequence<T> = sortedWith(reverseOrder())

fun <T> Sequence<T>.sortedWith(comparator: Comparator<in T>): Sequence<T> = Sequence { toMutableList().apply { sortWith(comparator) }.iterator() }

inline fun <T, R : Comparable<R>> Sequence<T>.sortedBy(crossinline selector: (T) -> R?): Sequence<T> = sortedWith(compareBy(selector))

inline fun <T, R : Comparable<R>> Sequence<T>.sortedByDescending(crossinline selector: (T) -> R?): Sequence<T> = sortedWith(compareByDescending(selector))

fun <T> Sequence<T>.ifEmpty(defaultValue: () -> Sequence<T>): Sequence<T> = Sequence {
    val source = iterator()
    if (source.hasNext()) source else defaultValue().iterator()
}

fun <T> Sequence<T>.toList(): List<T> {
    val list = ArrayList<T>()
    for (element in this) list.add(element)
    return list
}

fun <T> Sequence<T>.toMutableList(): MutableList<T> = toList() as MutableList<T>

fun <T> Sequence<T>.toSet(): Set<T> = toCollection(LinkedHashSet<T>())

fun <T> Sequence<T>.toMutableSet(): MutableSet<T> = toCollection(LinkedHashSet<T>())

fun <T> Sequence<T>.toHashSet(): HashSet<T> = toCollection(HashSet<T>())

fun <T, C : MutableCollection<in T>> Sequence<T>.toCollection(destination: C): C {
    for (element in this) destination.add(element)
    return destination
}

fun <K, V> Sequence<Pair<K, V>>.toMap(): Map<K, V> = toList().toMap()

inline fun <T, K, V> Sequence<T>.associate(transform: (T) -> Pair<K, V>): Map<K, V> = toList().associate(transform)

inline fun <T, K> Sequence<T>.associateBy(keySelector: (T) -> K): Map<K, T> = toList().associateBy(keySelector)

inline fun <K, V> Sequence<K>.associateWith(valueSelector: (K) -> V): Map<K, V> = toList().associateWith(valueSelector)

inline fun <T, K> Sequence<T>.groupBy(keySelector: (T) -> K): Map<K, List<T>> = toList().groupBy(keySelector)

inline fun <T> Sequence<T>.forEach(action: (T) -> Unit) {
    for (element in this) action(element)
}

inline fun <T> Sequence<T>.forEachIndexed(action: (index: Int, T) -> Unit) {
    var index = 0
    for (element in this) action(index++, element)
}

fun <T> Sequence<T>.first(): T {
    val source = iterator()
    if (!source.hasNext()) throw NoSuchElementException("Sequence is empty.")
    return source.next()
}

inline fun <T> Sequence<T>.first(predicate: (T) -> Boolean): T {
    for (element in this) if (predicate(element)) return element
    throw NoSuchElementException("Sequence contains no element matching the predicate.")
}

fun <T> Sequence<T>.firstOrNull(): T? {
    val source = iterator()
    return if (source.hasNext()) source.next() else null
}

inline fun <T> Sequence<T>.firstOrNull(predicate: (T) -> Boolean): T? {
    for (element in this) if (predicate(element)) return element
    return null
}

inline fun <T> Sequence<T>.find(predicate: (T) -> Boolean): T? = firstOrNull(predicate)

fun <T> Sequence<T>.last(): T {
    val source = iterator()
    if (!source.hasNext()) throw NoSuchElementException("Sequence is empty.")
    var last = source.next()
    while (source.hasNext()) last = source.next()
    return last
}

fun <T> Sequence<T>.lastOrNull(): T? = toList().lastOrNull()

inline fun <T> Sequence<T>.last(predicate: (T) -> Boolean): T = toList().last(predicate)

fun <T> Sequence<T>.single(): T = toList().single()

fun <T> Sequence<T>.elementAt(index: Int): T =
    elementAtOrElse(index) { throw IndexOutOfBoundsException("Sequence doesn't contain element at index $it.") }

inline fun <T> Sequence<T>.elementAtOrElse(index: Int, defaultValue: (Int) -> T): T {
    if (index < 0) return defaultValue(index)
    var count = 0
    for (element in this) if (index == count++) return element
    return defaultValue(index)
}

fun <T> Sequence<T>.elementAtOrNull(index: Int): T? = elementAtOrElse(index) { null }

operator fun <T> Sequence<T>.contains(element: T): Boolean = indexOf(element) >= 0

fun <T> Sequence<T>.indexOf(element: T): Int {
    var index = 0
    for (item in this) {
        if (item == element) return index
        index++
    }
    return -1
}

fun <T> Sequence<T>.count(): Int {
    var count = 0
    for (element in this) count++
    return count
}

inline fun <T> Sequence<T>.count(predicate: (T) -> Boolean): Int {
    var count = 0
    for (element in this) if (predicate(element)) count++
    return count
}

fun <T> Sequence<T>.any(): Boolean = iterator().hasNext()

inline fun <T> Sequence<T>.any(predicate: (T) -> Boolean): Boolean {
    for (element in this) if (predicate(element)) return true
    return false
}

inline fun <T> Sequence<T>.all(predicate: (T) -> Boolean): Boolean {
    for (element in this) if (!predicate(element)) return false
    return true
}

fun <T> Sequence<T>.none(): Boolean = !iterator().hasNext()

inline fun <T> Sequence<T>.none(predicate: (T) -> Boolean): Boolean = !any(predicate)

inline fun <T, R> Sequence<T>.fold(initial: R, operation: (acc: R, T) -> R): R {
    var accumulator = initial
    for (element in this) accumulator = operation(accumulator, element)
    return accumulator
}

inline fun <S, T : S> Sequence<T>.reduce(operation: (acc: S, T) -> S): S {
    val source = iterator()
    if (!source.hasNext()) throw UnsupportedOperationException("Empty sequence can't be reduced.")
    var accumulator: S = source.next()
    while (source.hasNext()) accumulator = operation(accumulator, source.next())
    return accumulator
}

@JvmName("sumOfInt")
fun Sequence<Int>.sum(): Int {
    var sum = 0
    for (element in this) sum += element
    return sum
}

@JvmName("sumOfLong")
fun Sequence<Long>.sum(): Long {
    var sum = 0L
    for (element in this) sum += element
    return sum
}

@JvmName("sumOfDouble")
fun Sequence<Double>.sum(): Double {
    var sum = 0.0
    for (element in this) sum += element
    return sum
}

@JvmName("averageOfInt")
fun Sequence<Int>.average(): Double = toList().average()

@JvmName("averageOfDouble")
fun Sequence<Double>.average(): Double = toList().average()

@JvmName("sumOfInt")
inline fun <T> Sequence<T>.sumOf(selector: (T) -> Int): Int {
    var sum = 0
    for (element in this) sum += selector(element)
    return sum
}

@JvmName("sumOfLong")
inline fun <T> Sequence<T>.sumOf(selector: (T) -> Long): Long {
    var sum = 0L
    for (element in this) sum += selector(element)
    return sum
}

@JvmName("sumOfDouble")
inline fun <T> Sequence<T>.sumOf(selector: (T) -> Double): Double {
    var sum = 0.0
    for (element in this) sum += selector(element)
    return sum
}

fun <T : Comparable<T>> Sequence<T>.max(): T = toList().max()

fun <T : Comparable<T>> Sequence<T>.min(): T = toList().min()

fun <T : Comparable<T>> Sequence<T>.maxOrNull(): T? = toList().maxOrNull()

fun <T : Comparable<T>> Sequence<T>.minOrNull(): T? = toList().minOrNull()

inline fun <T, R : Comparable<R>> Sequence<T>.maxBy(selector: (T) -> R): T = toList().maxBy(selector)

inline fun <T, R : Comparable<R>> Sequence<T>.minBy(selector: (T) -> R): T = toList().minBy(selector)

inline fun <T, R : Comparable<R>> Sequence<T>.maxByOrNull(selector: (T) -> R): T? = toList().maxByOrNull(selector)

inline fun <T, R : Comparable<R>> Sequence<T>.minByOrNull(selector: (T) -> R): T? = toList().minByOrNull(selector)

inline fun <T> Sequence<T>.partition(predicate: (T) -> Boolean): Pair<List<T>, List<T>> = toList().partition(predicate)

fun <T> Sequence<T>.joinToString(separator: CharSequence = ", ", prefix: CharSequence = "", postfix: CharSequence = "", limit: Int = -1, truncated: CharSequence = "...", transform: ((T) -> CharSequence)? = null): String =
    toList().joinToString(separator, prefix, postfix, limit, truncated, transform)
`;
