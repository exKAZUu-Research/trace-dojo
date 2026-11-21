import { forwardingSelectorExtrema, kotlin } from './source';

/** The extension functions of `kotlin.collections`, transcribed from Kotlin's standard library. */
export const COLLECTION_FUNCTIONS_SOURCE = kotlin`
package kotlin.collections

data class IndexedValue<out T>(val index: Int, val value: T)

internal fun <T> Iterable<T>.collectionSizeOrDefault(default: Int): Int = if (this is Collection<*>) this.size else default

internal fun <T> List<T>.optimizeReadOnlyList(): List<T> = when (size) {
    0 -> emptyList()
    1 -> listOf(this[0])
    else -> this
}

val <T> Collection<T>.indices: IntRange get() = 0..size - 1
val <T> List<T>.lastIndex: Int get() = this.size - 1

fun <T> Collection<T>.isNotEmpty(): Boolean = !isEmpty()
fun <T> Collection<T>?.isNullOrEmpty(): Boolean = this == null || this.isEmpty()
fun <T> Collection<T>?.orEmpty(): Collection<T> = this ?: emptyList()
fun <T> List<T>?.orEmpty(): List<T> = this ?: emptyList()
inline fun <C : Collection<*>, R> C.ifEmpty(defaultValue: () -> R): R where C : R = if (isEmpty()) defaultValue() else this

operator fun <T> Iterator<T>.iterator(): Iterator<T> = this

inline fun <T> Iterable<T>.forEach(action: (T) -> Unit) {
    for (element in this) action(element)
}

inline fun <T> Iterable<T>.forEachIndexed(action: (index: Int, T) -> Unit) {
    var index = 0
    for (item in this) action(index++, item)
}

inline fun <T, C : Iterable<T>> C.onEach(action: (T) -> Unit): C {
    for (element in this) action(element)
    return this
}

inline fun <T, R> Iterable<T>.map(transform: (T) -> R): List<R> {
    val destination = ArrayList<R>(collectionSizeOrDefault(10))
    for (item in this) destination.add(transform(item))
    return destination
}

inline fun <T, R> Iterable<T>.mapIndexed(transform: (index: Int, T) -> R): List<R> {
    val destination = ArrayList<R>(collectionSizeOrDefault(10))
    var index = 0
    for (item in this) destination.add(transform(index++, item))
    return destination
}

inline fun <T, R : Any> Iterable<T>.mapNotNull(transform: (T) -> R?): List<R> {
    val destination = ArrayList<R>()
    for (element in this) {
        val transformed = transform(element)
        if (transformed != null) destination.add(transformed)
    }
    return destination
}

inline fun <T, R : Any> Iterable<T>.mapIndexedNotNull(transform: (index: Int, T) -> R?): List<R> {
    val destination = ArrayList<R>()
    var index = 0
    for (element in this) {
        val transformed = transform(index++, element)
        if (transformed != null) destination.add(transformed)
    }
    return destination
}

inline fun <T, R> Iterable<T>.flatMap(transform: (T) -> Iterable<R>): List<R> {
    val destination = ArrayList<R>()
    for (element in this) destination.addAll(transform(element).toList())
    return destination
}

fun <T> Iterable<Iterable<T>>.flatten(): List<T> {
    val result = ArrayList<T>()
    for (element in this) result.addAll(element.toList())
    return result
}

inline fun <T> Iterable<T>.filter(predicate: (T) -> Boolean): List<T> {
    val destination = ArrayList<T>()
    for (element in this) if (predicate(element)) destination.add(element)
    return destination
}

inline fun <T> Iterable<T>.filterNot(predicate: (T) -> Boolean): List<T> {
    val destination = ArrayList<T>()
    for (element in this) if (!predicate(element)) destination.add(element)
    return destination
}

inline fun <T> Iterable<T>.filterIndexed(predicate: (index: Int, T) -> Boolean): List<T> {
    val destination = ArrayList<T>()
    var index = 0
    for (element in this) if (predicate(index++, element)) destination.add(element)
    return destination
}

fun <T : Any> Iterable<T?>.filterNotNull(): List<T> {
    val destination = ArrayList<T>()
    for (element in this) if (element != null) destination.add(element)
    return destination
}

inline fun <T> Iterable<T>.any(predicate: (T) -> Boolean): Boolean {
    if (this is Collection && isEmpty()) return false
    for (element in this) if (predicate(element)) return true
    return false
}

fun <T> Iterable<T>.any(): Boolean {
    if (this is Collection) return !isEmpty()
    return iterator().hasNext()
}

inline fun <T> Iterable<T>.all(predicate: (T) -> Boolean): Boolean {
    if (this is Collection && isEmpty()) return true
    for (element in this) if (!predicate(element)) return false
    return true
}

inline fun <T> Iterable<T>.none(predicate: (T) -> Boolean): Boolean {
    if (this is Collection && isEmpty()) return true
    for (element in this) if (predicate(element)) return false
    return true
}

fun <T> Iterable<T>.none(): Boolean {
    if (this is Collection) return isEmpty()
    return !iterator().hasNext()
}

inline fun <T> Iterable<T>.count(predicate: (T) -> Boolean): Int {
    if (this is Collection && isEmpty()) return 0
    var count = 0
    for (element in this) if (predicate(element)) count++
    return count
}

fun <T> Iterable<T>.count(): Int {
    if (this is Collection) return size
    var count = 0
    for (element in this) count++
    return count
}

fun <T> Collection<T>.count(): Int = size

fun <T> List<T>.first(): T {
    if (isEmpty()) throw NoSuchElementException("List is empty.")
    return this[0]
}

fun <T> Iterable<T>.first(): T {
    if (this is List) return this.first()
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException("Collection is empty.")
    return iterator.next()
}

inline fun <T> Iterable<T>.first(predicate: (T) -> Boolean): T {
    for (element in this) if (predicate(element)) return element
    throw NoSuchElementException("Collection contains no element matching the predicate.")
}

fun <T> List<T>.firstOrNull(): T? = if (isEmpty()) null else this[0]

fun <T> Iterable<T>.firstOrNull(): T? {
    if (this is List) return if (isEmpty()) null else this[0]
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    return iterator.next()
}

inline fun <T> Iterable<T>.firstOrNull(predicate: (T) -> Boolean): T? {
    for (element in this) if (predicate(element)) return element
    return null
}

inline fun <T, R : Any> Iterable<T>.firstNotNullOf(transform: (T) -> R?): R =
    firstNotNullOfOrNull(transform) ?: throw NoSuchElementException("No element of the collection was transformed to a non-null value.")

inline fun <T, R : Any> Iterable<T>.firstNotNullOfOrNull(transform: (T) -> R?): R? {
    for (element in this) {
        val result = transform(element)
        if (result != null) return result
    }
    return null
}

fun <T> List<T>.last(): T {
    if (isEmpty()) throw NoSuchElementException("List is empty.")
    return this[lastIndex]
}

fun <T> Iterable<T>.last(): T {
    if (this is List) return this.last()
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException("Collection is empty.")
    var last = iterator.next()
    while (iterator.hasNext()) last = iterator.next()
    return last
}

inline fun <T> List<T>.last(predicate: (T) -> Boolean): T {
    var index = lastIndex
    while (index >= 0) {
        val element = this[index]
        if (predicate(element)) return element
        index--
    }
    throw NoSuchElementException("List contains no element matching the predicate.")
}

fun <T> List<T>.lastOrNull(): T? = if (isEmpty()) null else this[size - 1]

inline fun <T> List<T>.lastOrNull(predicate: (T) -> Boolean): T? {
    var index = lastIndex
    while (index >= 0) {
        val element = this[index]
        if (predicate(element)) return element
        index--
    }
    return null
}

inline fun <T> Iterable<T>.find(predicate: (T) -> Boolean): T? = firstOrNull(predicate)

inline fun <T> List<T>.findLast(predicate: (T) -> Boolean): T? = lastOrNull(predicate)

fun <T> List<T>.single(): T = when (size) {
    0 -> throw NoSuchElementException("List is empty.")
    1 -> this[0]
    else -> throw IllegalArgumentException("List has more than one element.")
}

fun <T> Iterable<T>.single(): T {
    if (this is List) return single()
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException("Collection is empty.")
    val single = iterator.next()
    if (iterator.hasNext()) throw IllegalArgumentException("Collection has more than one element.")
    return single
}

fun <T> Iterable<T>.singleOrNull(): T? {
    if (this is List) return if (size == 1) this[0] else null
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    val single = iterator.next()
    return if (iterator.hasNext()) null else single
}

inline fun <T> Iterable<T>.single(predicate: (T) -> Boolean): T {
    var single: T? = null
    var found = false
    for (element in this) {
        if (predicate(element)) {
            if (found) throw IllegalArgumentException("Collection contains more than one matching element.")
            single = element
            found = true
        }
    }
    if (!found) throw NoSuchElementException("Collection contains no element matching the predicate.")
    return single as T
}

fun <T> List<T>.singleOrNull(): T? = if (size == 1) this[0] else null

inline fun <T> Iterable<T>.singleOrNull(predicate: (T) -> Boolean): T? {
    var single: T? = null
    var found = false
    for (element in this) {
        if (predicate(element)) {
            if (found) return null
            single = element
            found = true
        }
    }
    if (!found) return null
    return single
}

inline fun <T> List<T>.indexOfFirst(predicate: (T) -> Boolean): Int {
    var index = 0
    for (item in this) {
        if (predicate(item)) return index
        index++
    }
    return -1
}

inline fun <T> List<T>.indexOfLast(predicate: (T) -> Boolean): Int {
    var index = lastIndex
    while (index >= 0) {
        if (predicate(this[index])) return index
        index--
    }
    return -1
}

fun <T> List<T>.getOrNull(index: Int): T? = if (index >= 0 && index < size) get(index) else null

inline fun <T> List<T>.getOrElse(index: Int, defaultValue: (Int) -> T): T = if (index >= 0 && index < size) get(index) else defaultValue(index)

fun <T> List<T>.elementAt(index: Int): T = get(index)

fun <T> Iterable<T>.elementAt(index: Int): T {
    if (this is List) return get(index)
    if (index < 0) throw IndexOutOfBoundsException("Collection doesn't contain element at index $index.")
    var count = 0
    for (element in this) {
        if (index == count++) return element
    }
    throw IndexOutOfBoundsException("Collection doesn't contain element at index $index.")
}

fun <T> List<T>.elementAtOrNull(index: Int): T? = getOrNull(index)

operator fun <T> List<T>.component1(): T = get(0)
operator fun <T> List<T>.component2(): T = get(1)
operator fun <T> List<T>.component3(): T = get(2)
operator fun <T> List<T>.component4(): T = get(3)
operator fun <T> List<T>.component5(): T = get(4)

operator fun <@OnlyInputTypes T> Iterable<T>.contains(element: T): Boolean {
    if (this is Collection) return contains(element)
    return indexOf(element) >= 0
}

fun <@OnlyInputTypes T> Iterable<T>.indexOf(element: T): Int {
    if (this is List) return this.indexOf(element)
    var index = 0
    for (item in this) {
        if (element == item) return index
        index++
    }
    return -1
}

fun Iterable<Int>.sum(): Int {
    var sum = 0
    for (element in this) sum += element
    return sum
}

@JvmName("sumOfLong")
fun Iterable<Long>.sum(): Long {
    var sum = 0L
    for (element in this) sum += element
    return sum
}

@JvmName("sumOfDouble")
fun Iterable<Double>.sum(): Double {
    var sum = 0.0
    for (element in this) sum += element
    return sum
}

@JvmName("sumOfFloat")
fun Iterable<Float>.sum(): Float {
    var sum = 0.0f
    for (element in this) sum += element
    return sum
}

inline fun <T> Iterable<T>.sumOf(selector: (T) -> Int): Int {
    var sum = 0
    for (element in this) sum += selector(element)
    return sum
}

@JvmName("sumOfLong")
inline fun <T> Iterable<T>.sumOf(selector: (T) -> Long): Long {
    var sum = 0L
    for (element in this) sum += selector(element)
    return sum
}

@JvmName("sumOfDouble")
inline fun <T> Iterable<T>.sumOf(selector: (T) -> Double): Double {
    var sum = 0.0
    for (element in this) sum += selector(element)
    return sum
}

fun Iterable<Int>.average(): Double {
    var sum = 0.0
    var count = 0
    for (element in this) {
        sum += element
        count++
    }
    return if (count == 0) Double.NaN else sum / count
}

@JvmName("averageOfDouble")
fun Iterable<Double>.average(): Double {
    var sum = 0.0
    var count = 0
    for (element in this) {
        sum += element
        count++
    }
    return if (count == 0) Double.NaN else sum / count
}

@JvmName("averageOfLong")
fun Iterable<Long>.average(): Double {
    var sum = 0.0
    var count = 0
    for (element in this) {
        sum += element.toDouble()
        count++
    }
    return if (count == 0) Double.NaN else sum / count
}

fun <T : Comparable<T>> Iterable<T>.max(): T {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var max = iterator.next()
    while (iterator.hasNext()) {
        val e = iterator.next()
        if (max < e) max = e
    }
    return max
}

fun <T : Comparable<T>> Iterable<T>.min(): T {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var min = iterator.next()
    while (iterator.hasNext()) {
        val e = iterator.next()
        if (min > e) min = e
    }
    return min
}

fun <T : Comparable<T>> Iterable<T>.maxOrNull(): T? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var max = iterator.next()
    while (iterator.hasNext()) {
        val e = iterator.next()
        if (max < e) max = e
    }
    return max
}

fun <T : Comparable<T>> Iterable<T>.minOrNull(): T? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var min = iterator.next()
    while (iterator.hasNext()) {
        val e = iterator.next()
        if (min > e) min = e
    }
    return min
}

inline fun <T, R : Comparable<R>> Iterable<T>.maxBy(selector: (T) -> R): T {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var maxElem = iterator.next()
    if (!iterator.hasNext()) return maxElem
    var maxValue = selector(maxElem)
    do {
        val e = iterator.next()
        val v = selector(e)
        if (maxValue < v) {
            maxElem = e
            maxValue = v
        }
    } while (iterator.hasNext())
    return maxElem
}

inline fun <T, R : Comparable<R>> Iterable<T>.minBy(selector: (T) -> R): T {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var minElem = iterator.next()
    if (!iterator.hasNext()) return minElem
    var minValue = selector(minElem)
    do {
        val e = iterator.next()
        val v = selector(e)
        if (minValue > v) {
            minElem = e
            minValue = v
        }
    } while (iterator.hasNext())
    return minElem
}

inline fun <T, R : Comparable<R>> Iterable<T>.maxByOrNull(selector: (T) -> R): T? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var maxElem = iterator.next()
    if (!iterator.hasNext()) return maxElem
    var maxValue = selector(maxElem)
    do {
        val e = iterator.next()
        val v = selector(e)
        if (maxValue < v) {
            maxElem = e
            maxValue = v
        }
    } while (iterator.hasNext())
    return maxElem
}

inline fun <T, R : Comparable<R>> Iterable<T>.minByOrNull(selector: (T) -> R): T? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var minElem = iterator.next()
    if (!iterator.hasNext()) return minElem
    var minValue = selector(minElem)
    do {
        val e = iterator.next()
        val v = selector(e)
        if (minValue > v) {
            minElem = e
            minValue = v
        }
    } while (iterator.hasNext())
    return minElem
}

inline fun <T, R : Comparable<R>> Iterable<T>.maxOf(selector: (T) -> R): R {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var maxValue = selector(iterator.next())
    while (iterator.hasNext()) {
        val v = selector(iterator.next())
        if (maxValue < v) maxValue = v
    }
    return maxValue
}

inline fun <T, R : Comparable<R>> Iterable<T>.minOf(selector: (T) -> R): R {
    val iterator = iterator()
    if (!iterator.hasNext()) throw NoSuchElementException()
    var minValue = selector(iterator.next())
    while (iterator.hasNext()) {
        val v = selector(iterator.next())
        if (minValue > v) minValue = v
    }
    return minValue
}

inline fun <T, R : Comparable<R>> Iterable<T>.maxOfOrNull(selector: (T) -> R): R? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var maxValue = selector(iterator.next())
    while (iterator.hasNext()) {
        val v = selector(iterator.next())
        if (maxValue < v) maxValue = v
    }
    return maxValue
}

inline fun <T, R : Comparable<R>> Iterable<T>.minOfOrNull(selector: (T) -> R): R? {
    val iterator = iterator()
    if (!iterator.hasNext()) return null
    var minValue = selector(iterator.next())
    while (iterator.hasNext()) {
        val v = selector(iterator.next())
        if (minValue > v) minValue = v
    }
    return minValue
}

${floatingExtremaSource()}

fun <T> Iterable<T>.maxWith(comparator: Comparator<in T>): T {
    val values = iterator()
    if (!values.hasNext()) throw NoSuchElementException()
    return values.extremumWith(comparator, true)
}

fun <T> Iterable<T>.minWith(comparator: Comparator<in T>): T {
    val values = iterator()
    if (!values.hasNext()) throw NoSuchElementException()
    return values.extremumWith(comparator, false)
}

fun <T> Iterable<T>.maxWithOrNull(comparator: Comparator<in T>): T? {
    val values = iterator()
    return if (values.hasNext()) values.extremumWith(comparator, true) else null
}

fun <T> Iterable<T>.minWithOrNull(comparator: Comparator<in T>): T? {
    val values = iterator()
    return if (values.hasNext()) values.extremumWith(comparator, false) else null
}

private fun <T> Iterator<T>.extremumWith(comparator: Comparator<in T>, findMaximum: Boolean): T {
    var result = next()
    while (hasNext()) {
        val element = next()
        val order = comparator.compare(result, element)
        if (if (findMaximum) order < 0 else order > 0) result = element
    }
    return result
}

inline fun <T, R> Iterable<T>.fold(initial: R, operation: (acc: R, T) -> R): R {
    var accumulator = initial
    for (element in this) accumulator = operation(accumulator, element)
    return accumulator
}

inline fun <T, R> Iterable<T>.foldIndexed(initial: R, operation: (index: Int, acc: R, T) -> R): R {
    var index = 0
    var accumulator = initial
    for (element in this) accumulator = operation(index++, accumulator, element)
    return accumulator
}

inline fun <T, R> List<T>.foldRight(initial: R, operation: (T, acc: R) -> R): R {
    val items = listIterator(size)
    var accumulator = initial
    while (items.hasPrevious()) accumulator = operation(items.previous(), accumulator)
    return accumulator
}

inline fun <S, T : S> List<T>.reduceRight(operation: (T, acc: S) -> S): S {
    val items = listIterator(size)
    if (!items.hasPrevious()) throw UnsupportedOperationException("Empty list can't be reduced.")
    var accumulator: S = items.previous()
    while (items.hasPrevious()) accumulator = operation(items.previous(), accumulator)
    return accumulator
}

inline fun <S, T : S> Iterable<T>.reduce(operation: (acc: S, T) -> S): S {
    val iterator = this.iterator()
    if (!iterator.hasNext()) throw UnsupportedOperationException("Empty collection can't be reduced.")
    var accumulator: S = iterator.next()
    while (iterator.hasNext()) accumulator = operation(accumulator, iterator.next())
    return accumulator
}

inline fun <S, T : S> Iterable<T>.reduceIndexed(operation: (index: Int, acc: S, T) -> S): S {
    val iterator = this.iterator()
    if (!iterator.hasNext()) throw UnsupportedOperationException("Empty collection can't be reduced.")
    var index = 1
    var accumulator: S = iterator.next()
    while (iterator.hasNext()) accumulator = operation(index++, accumulator, iterator.next())
    return accumulator
}

inline fun <S, T : S> Iterable<T>.reduceOrNull(operation: (acc: S, T) -> S): S? {
    val iterator = this.iterator()
    if (!iterator.hasNext()) return null
    var accumulator: S = iterator.next()
    while (iterator.hasNext()) accumulator = operation(accumulator, iterator.next())
    return accumulator
}

inline fun <T, R> Iterable<T>.runningFold(initial: R, operation: (acc: R, T) -> R): List<R> {
    val result = ArrayList<R>(collectionSizeOrDefault(9) + 1)
    result.add(initial)
    var accumulator = initial
    for (element in this) {
        accumulator = operation(accumulator, element)
        result.add(accumulator)
    }
    return result
}

inline fun <T, R> Iterable<T>.scan(initial: R, operation: (acc: R, T) -> R): List<R> = runningFold(initial, operation)

inline fun <S, T : S> Iterable<T>.runningReduce(operation: (acc: S, T) -> S): List<S> {
    val iterator = this.iterator()
    if (!iterator.hasNext()) return emptyList()
    var accumulator: S = iterator.next()
    val result = ArrayList<S>(collectionSizeOrDefault(10))
    result.add(accumulator)
    while (iterator.hasNext()) {
        accumulator = operation(accumulator, iterator.next())
        result.add(accumulator)
    }
    return result
}

fun <T> Iterable<T>.toList(): List<T> {
    if (this is Collection) {
        return when (size) {
            0 -> emptyList()
            1 -> listOf(if (this is List) get(0) else iterator().next())
            else -> this.toMutableList()
        }
    }
    return this.toMutableList().optimizeReadOnlyList()
}

fun <T> Collection<T>.toMutableList(): MutableList<T> = ArrayList(this)

fun <T> Iterable<T>.toMutableList(): MutableList<T> {
    if (this is Collection<T>) return ArrayList(this)
    val result = ArrayList<T>()
    for (item in this) result.add(item)
    return result
}

fun <T> Iterable<T>.toSet(): Set<T> {
    if (this is Collection) {
        return when (size) {
            0 -> emptySet()
            1 -> setOf(if (this is List) this[0] else iterator().next())
            else -> toCollection(LinkedHashSet<T>(mapCapacity(size)))
        }
    }
    val set = toCollection(LinkedHashSet<T>())
    return when (set.size) {
        0 -> emptySet()
        1 -> setOf(set.iterator().next())
        else -> set
    }
}

fun <T> Iterable<T>.toMutableSet(): MutableSet<T> = when (this) {
    is Collection -> LinkedHashSet(this)
    else -> toCollection(LinkedHashSet<T>())
}

fun <T> Iterable<T>.toHashSet(): HashSet<T> = toCollection(HashSet<T>(mapCapacity(collectionSizeOrDefault(12))))

fun <T, C : MutableCollection<in T>> Iterable<T>.toCollection(destination: C): C {
    for (item in this) destination.add(item)
    return destination
}

internal fun mapCapacity(expectedSize: Int): Int = when {
    expectedSize < 0 -> expectedSize
    expectedSize < 3 -> expectedSize + 1
    expectedSize < 1073741824 -> ((expectedSize / 0.75f) + 1.0f).toInt()
    else -> Int.MAX_VALUE
}

fun <T> Iterable<T>.distinct(): List<T> = this.toMutableSet().toList()

inline fun <T, K> Iterable<T>.distinctBy(selector: (T) -> K): List<T> {
    val set = HashSet<K>()
    val list = ArrayList<T>()
    for (e in this) {
        val key = selector(e)
        if (set.add(key)) list.add(e)
    }
    return list
}

fun <T> Iterable<T>.reversed(): List<T> {
    if (this is Collection && size <= 1) return toList()
    val list = toMutableList()
    list.reverse()
    return list
}

fun <T : Comparable<T>> Iterable<T>.sorted(): List<T> {
    if (this is Collection) {
        if (size <= 1) return this.toList()
        val list = NativeLists.of(this)
        list.sortWith(naturalOrder())
        return list
    }
    val list = toMutableList()
    list.sortWith(naturalOrder())
    return list
}

fun <T : Comparable<T>> Iterable<T>.sortedDescending(): List<T> = sortedWith(reverseOrder())

fun <T> Iterable<T>.sortedWith(comparator: Comparator<in T>): List<T> {
    if (this is Collection) {
        if (size <= 1) return this.toList()
        val list = NativeLists.of(this)
        list.sortWith(comparator)
        return list
    }
    val list = toMutableList()
    list.sortWith(comparator)
    return list
}

inline fun <T, R : Comparable<R>> Iterable<T>.sortedBy(crossinline selector: (T) -> R?): List<T> = sortedWith(compareBy(selector))

inline fun <T, R : Comparable<R>> Iterable<T>.sortedByDescending(crossinline selector: (T) -> R?): List<T> = sortedWith(compareByDescending(selector))

fun <T : Comparable<T>> MutableList<T>.sort() {
    if (size > 1) sortWith(naturalOrder())
}

fun <T : Comparable<T>> MutableList<T>.sortDescending() {
    if (size > 1) sortWith(reverseOrder())
}

inline fun <T, R : Comparable<R>> MutableList<T>.sortBy(crossinline selector: (T) -> R?) {
    if (size > 1) sortWith(compareBy(selector))
}

inline fun <T, R : Comparable<R>> MutableList<T>.sortByDescending(crossinline selector: (T) -> R?) {
    if (size > 1) sortWith(compareByDescending(selector))
}

external fun <T> MutableList<T>.sortWith(comparator: Comparator<in T>)

external fun <T> MutableList<T>.reverse()

fun <T> MutableList<T>.shuffle() = shuffle(kotlin.random.Random)

fun <T> MutableList<T>.shuffle(random: kotlin.random.Random) {
    var i = lastIndex
    while (i >= 1) {
        val j = random.nextInt(i + 1)
        val copy = this[i]
        this[i] = this[j]
        this[j] = copy
        i--
    }
}

fun <T> Collection<T>.random(): T = random(kotlin.random.Random)
fun <T> Collection<T>.random(random: kotlin.random.Random): T {
    if (isEmpty()) throw NoSuchElementException("Collection is empty.")
    return elementAt(random.nextInt(size))
}
fun <T> Array<out T>.random(): T = random(kotlin.random.Random)
fun <T> Array<out T>.random(random: kotlin.random.Random): T {
    if (isEmpty()) throw NoSuchElementException("Array is empty.")
    return get(random.nextInt(size))
}
fun IntArray.random(): Int = random(kotlin.random.Random)
fun IntArray.random(random: kotlin.random.Random): Int {
    if (isEmpty()) throw NoSuchElementException("Array is empty.")
    return get(random.nextInt(size))
}
fun <T> Iterable<T>.shuffled(): List<T> = toMutableList().apply { shuffle() }
fun <T> Iterable<T>.shuffled(random: kotlin.random.Random): List<T> = toMutableList().apply { shuffle(random) }

fun <T> Collection<T>.randomOrNull(): T? = if (isEmpty()) null else random()

fun <T> Iterable<T>.take(n: Int): List<T> {
    if (n < 0) throw IllegalArgumentException("Requested element count $n is less than zero.")
    if (n == 0) return emptyList()
    if (this is Collection<T>) {
        if (n >= size) return toList()
        if (n == 1) return listOf(first())
    }
    var count = 0
    val list = ArrayList<T>(n)
    for (item in this) {
        list.add(item)
        if (++count == n) break
    }
    return list.optimizeReadOnlyList()
}

fun <T> List<T>.takeLast(n: Int): List<T> {
    if (n < 0) throw IllegalArgumentException("Requested element count $n is less than zero.")
    if (n == 0) return emptyList()
    val size = size
    if (n >= size) return toList()
    if (n == 1) return listOf(last())
    val list = ArrayList<T>(n)
    for (index in size - n until size) list.add(this[index])
    return list
}

inline fun <T> Iterable<T>.takeWhile(predicate: (T) -> Boolean): List<T> {
    val list = ArrayList<T>()
    for (item in this) {
        if (!predicate(item)) break
        list.add(item)
    }
    return list
}

inline fun <T> List<T>.takeLastWhile(predicate: (T) -> Boolean): List<T> {
    if (isEmpty()) return emptyList()
    var index = lastIndex
    while (index >= 0) {
        if (!predicate(this[index])) return drop(index + 1)
        index--
    }
    return toList()
}

fun <T> Iterable<T>.drop(n: Int): List<T> {
    if (n < 0) throw IllegalArgumentException("Requested element count $n is less than zero.")
    if (n == 0) return toList()
    val list = ArrayList<T>()
    var count = 0
    for (item in this) {
        if (count >= n) list.add(item) else ++count
    }
    return list.optimizeReadOnlyList()
}

fun <T> List<T>.dropLast(n: Int): List<T> {
    if (n < 0) throw IllegalArgumentException("Requested element count $n is less than zero.")
    return take((size - n).coerceAtLeast(0))
}

inline fun <T> Iterable<T>.dropWhile(predicate: (T) -> Boolean): List<T> {
    var yielding = false
    val list = ArrayList<T>()
    for (item in this) {
        if (yielding) list.add(item)
        else if (!predicate(item)) {
            list.add(item)
            yielding = true
        }
    }
    return list
}

inline fun <T> List<T>.dropLastWhile(predicate: (T) -> Boolean): List<T> {
    var index = lastIndex
    while (index >= 0) {
        if (!predicate(this[index])) return take(index + 1)
        index--
    }
    return emptyList()
}

fun <T> List<T>.slice(indices: IntRange): List<T> {
    if (indices.isEmpty()) return listOf()
    return this.subList(indices.start, indices.endInclusive + 1).toList()
}

fun <T> List<T>.slice(indices: Iterable<Int>): List<T> {
    val list = ArrayList<T>()
    for (index in indices) list.add(get(index))
    return list
}

fun <T> Iterable<T>.chunked(size: Int): List<List<T>> = windowed(size, size, partialWindows = true)
fun <T, R> Iterable<T>.chunked(size: Int, transform: (List<T>) -> R): List<R> = chunked(size).map(transform)
fun <T, R> Iterable<T>.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false, transform: (List<T>) -> R): List<R> =
    windowed(size, step, partialWindows).map(transform)

fun <T> Iterable<T>.windowed(size: Int, step: Int = 1, partialWindows: Boolean = false): List<List<T>> {
    if (!(size > 0 && step > 0)) {
        throw IllegalArgumentException(if (size != step) "Both size $size and step $step must be greater than zero." else "size $size must be greater than zero.")
    }
    val list = this.toList()
    val thisSize = list.size
    val resultCapacity = thisSize / step + if (thisSize % step == 0) 0 else 1
    val result = ArrayList<List<T>>(resultCapacity)
    var index = 0
    while (0 <= index && index < thisSize) {
        val windowSize = size.coerceAtMost(thisSize - index)
        if (windowSize < size && !partialWindows) break
        val window = ArrayList<T>(windowSize)
        for (i in 0 until windowSize) window.add(list[i + index])
        result.add(window)
        index += step
    }
    return result
}

infix fun <T, R> Iterable<T>.zip(other: Iterable<R>): List<Pair<T, R>> {
    val first = iterator()
    val second = other.iterator()
    val list = ArrayList<Pair<T, R>>()
    while (first.hasNext() && second.hasNext()) list.add(first.next() to second.next())
    return list
}

inline fun <T, R, V> Iterable<T>.zip(other: Iterable<R>, transform: (a: T, b: R) -> V): List<V> {
    val first = iterator()
    val second = other.iterator()
    val list = ArrayList<V>()
    while (first.hasNext() && second.hasNext()) list.add(transform(first.next(), second.next()))
    return list
}

fun <T> Iterable<T>.zipWithNext(): List<Pair<T, T>> {
    val iterator = iterator()
    if (!iterator.hasNext()) return emptyList()
    val result = mutableListOf<Pair<T, T>>()
    var current = iterator.next()
    while (iterator.hasNext()) {
        val next = iterator.next()
        result.add(current to next)
        current = next
    }
    return result
}

inline fun <T, R> Iterable<T>.zipWithNext(transform: (a: T, b: T) -> R): List<R> {
    val iterator = iterator()
    if (!iterator.hasNext()) return emptyList()
    val result = mutableListOf<R>()
    var current = iterator.next()
    while (iterator.hasNext()) {
        val next = iterator.next()
        result.add(transform(current, next))
        current = next
    }
    return result
}

fun <T, R> Iterable<Pair<T, R>>.unzip(): Pair<List<T>, List<R>> {
    val listT = ArrayList<T>(collectionSizeOrDefault(10))
    val listR = ArrayList<R>(collectionSizeOrDefault(10))
    for (pair in this) {
        listT.add(pair.first)
        listR.add(pair.second)
    }
    return listT to listR
}

inline fun <T> Iterable<T>.partition(predicate: (T) -> Boolean): Pair<List<T>, List<T>> {
    val first = ArrayList<T>()
    val second = ArrayList<T>()
    for (element in this) {
        if (predicate(element)) first.add(element) else second.add(element)
    }
    return Pair(first, second)
}

inline fun <T, K> Iterable<T>.groupBy(keySelector: (T) -> K): Map<K, List<T>> {
    val destination = LinkedHashMap<K, MutableList<T>>()
    for (element in this) {
        val key = keySelector(element)
        val list = destination.getOrPut(key) { ArrayList<T>() }
        list.add(element)
    }
    return destination
}

inline fun <T, K, V> Iterable<T>.groupBy(keySelector: (T) -> K, valueTransform: (T) -> V): Map<K, List<V>> {
    val destination = LinkedHashMap<K, MutableList<V>>()
    for (element in this) {
        val key = keySelector(element)
        val list = destination.getOrPut(key) { ArrayList<V>() }
        list.add(valueTransform(element))
    }
    return destination
}

inline fun <T, K> Iterable<T>.groupingBy(crossinline keySelector: (T) -> K): Grouping<T, K> {
    val source = this
    return Grouping(source.toList(), source.map { keySelector(it) })
}

class Grouping<T, K>(val elements: List<T>, val keys: List<K>) {
    fun eachCount(): Map<K, Int> {
        val destination = LinkedHashMap<K, Int>()
        for (key in keys) destination[key] = (destination[key] ?: 0) + 1
        return destination
    }
}

inline fun <T, K, V> Iterable<T>.associate(transform: (T) -> Pair<K, V>): Map<K, V> {
    val destination = LinkedHashMap<K, V>(mapCapacity(collectionSizeOrDefault(10)).coerceAtLeast(16))
    for (element in this) {
        val pair = transform(element)
        destination.put(pair.first, pair.second)
    }
    return destination
}

inline fun <T, K> Iterable<T>.associateBy(keySelector: (T) -> K): Map<K, T> {
    val destination = LinkedHashMap<K, T>(mapCapacity(collectionSizeOrDefault(10)).coerceAtLeast(16))
    for (element in this) destination.put(keySelector(element), element)
    return destination
}

inline fun <T, K, V> Iterable<T>.associateBy(keySelector: (T) -> K, valueTransform: (T) -> V): Map<K, V> {
    val destination = LinkedHashMap<K, V>(mapCapacity(collectionSizeOrDefault(10)).coerceAtLeast(16))
    for (element in this) destination.put(keySelector(element), valueTransform(element))
    return destination
}

inline fun <K, V> Iterable<K>.associateWith(valueSelector: (K) -> V): Map<K, V> {
    val result = LinkedHashMap<K, V>(mapCapacity(collectionSizeOrDefault(10)).coerceAtLeast(16))
    for (element in this) result.put(element, valueSelector(element))
    return result
}

fun <K, V> Iterable<Pair<K, V>>.toMap(): Map<K, V> {
    val result = LinkedHashMap<K, V>()
    for (pair in this) result.put(pair.first, pair.second)
    return when (result.size) {
        0 -> emptyMap()
        1 -> mapOf(pair = result.entries.iterator().next().toPair())
        else -> result
    }
}

fun <T> Iterable<T>.joinToString(separator: CharSequence = ", ", prefix: CharSequence = "", postfix: CharSequence = "", limit: Int = -1, truncated: CharSequence = "...", transform: ((T) -> CharSequence)? = null): String {
    val buffer = StringBuilder()
    buffer.append(prefix)
    var count = 0
    for (element in this) {
        if (++count > 1) buffer.append(separator)
        if (limit < 0 || count <= limit) {
            when {
                transform != null -> buffer.append(transform(element))
                element == null -> buffer.append("null")
                element is CharSequence -> buffer.append(element)
                element is Char -> buffer.append(element)
                else -> buffer.append(element.toString())
            }
        } else break
    }
    if (limit >= 0 && count > limit) buffer.append(truncated)
    buffer.append(postfix)
    return buffer.toString()
}

operator fun <T> Collection<T>.plus(element: T): List<T> {
    val result = ArrayList<T>(size + 1)
    result.addAll(this)
    result.add(element)
    return result
}

operator fun <T> Collection<T>.plus(elements: Iterable<T>): List<T> {
    val result = ArrayList<T>(this)
    result.addAll(elements.toList())
    return result
}

operator fun <T> Collection<T>.plus(elements: Array<out T>): List<T> {
    val result = ArrayList<T>(this)
    for (element in elements) result.add(element)
    return result
}

operator fun <T> Iterable<T>.minus(element: T): List<T> {
    val result = ArrayList<T>(collectionSizeOrDefault(10))
    var removed = false
    for (item in this) {
        if (!removed && item == element) removed = true else result.add(item)
    }
    return result
}

operator fun <T> Iterable<T>.minus(elements: Iterable<T>): List<T> {
    val other = elements.toList()
    if (other.isEmpty()) return this.toList()
    return this.filterNot { it in other }
}

fun <T> Collection<T>.plusElement(element: T): List<T> = plus(element)

operator fun <T> Set<T>.plus(element: T): Set<T> {
    val result = LinkedHashSet<T>(this)
    result.add(element)
    return result
}

operator fun <T> Set<T>.plus(elements: Iterable<T>): Set<T> {
    val result = LinkedHashSet<T>(this)
    result.addAll(elements)
    return result
}

operator fun <T> Set<T>.minus(element: T): Set<T> {
    val result = LinkedHashSet<T>()
    var removed = false
    for (item in this) {
        if (!removed && item == element) removed = true else result.add(item)
    }
    return result
}

operator fun <T> Set<T>.minus(elements: Iterable<T>): Set<T> {
    val other = elements.toList()
    val result = LinkedHashSet<T>()
    for (item in this) if (item !in other) result.add(item)
    return result
}

infix fun <T> Iterable<T>.union(other: Iterable<T>): Set<T> {
    val set = this.toMutableSet()
    set.addAll(other.toList())
    return set
}

infix fun <T> Iterable<T>.intersect(other: Iterable<T>): Set<T> {
    val set = this.toMutableSet()
    set.retainAll(other.toList())
    return set
}

infix fun <T> Iterable<T>.subtract(other: Iterable<T>): Set<T> {
    val set = this.toMutableSet()
    set.removeAll(other.toList())
    return set
}

fun <T> MutableCollection<in T>.addAll(elements: Iterable<T>): Boolean {
    var result = false
    for (item in elements) if (add(item)) result = true
    return result
}

fun <T> MutableCollection<in T>.addAll(elements: Array<out T>): Boolean {
    var result = false
    for (item in elements) if (add(item)) result = true
    return result
}

operator fun <T> MutableCollection<in T>.plusAssign(element: T) {
    this.add(element)
}

operator fun <T> MutableCollection<in T>.plusAssign(elements: Iterable<T>) {
    this.addAll(elements)
}

operator fun <T> MutableCollection<in T>.minusAssign(element: T) {
    this.remove(element)
}

operator fun <T> MutableCollection<in T>.minusAssign(elements: Iterable<T>) {
    this.removeAll(if (elements is Collection<T>) elements else elements.toList())
}

fun <T> MutableIterable<T>.removeAll(predicate: (T) -> Boolean): Boolean = filterInPlace(predicate, true)

fun <T> MutableIterable<T>.retainAll(predicate: (T) -> Boolean): Boolean = filterInPlace(predicate, false)

fun <T> MutableCollection<T>.removeIf(predicate: (T) -> Boolean): Boolean = filterInPlace(predicate, true)

private fun <T> MutableIterable<T>.filterInPlace(predicate: (T) -> Boolean, predicateResultToRemove: Boolean): Boolean {
    var result = false
    val iterator = this.iterator()
    while (iterator.hasNext()) {
        if (predicate(iterator.next()) == predicateResultToRemove) {
            iterator.remove()
            result = true
        }
    }
    return result
}

// These are the JDK's List.removeFirst and removeLast, which Kotlin calls on the JVM since JDK 21 and which throw no message.
fun <T> MutableList<T>.addFirst(element: T) = add(0, element)
fun <T> MutableList<T>.addLast(element: T) { add(element) }

fun <T> MutableList<T>.removeFirst(): T = if (isEmpty()) throw NoSuchElementException() else removeAt(0)
fun <T> MutableList<T>.removeLast(): T = if (isEmpty()) throw NoSuchElementException() else removeAt(lastIndex)
fun <T> MutableList<T>.removeFirstOrNull(): T? = if (isEmpty()) null else removeAt(0)
fun <T> MutableList<T>.removeLastOrNull(): T? = if (isEmpty()) null else removeAt(lastIndex)

fun <T> MutableList<T>.fill(value: T) {
    for (index in 0 until size) this[index] = value
}

inline fun <T> buildList(builderAction: MutableList<T>.() -> Unit): List<T> {
    val list = NativeLists.builder<T>()
    list.builderAction()
    return list.build()
}

inline fun <E> buildSet(builderAction: MutableSet<E>.() -> Unit): Set<E> {
    val set = LinkedHashSet<E>()
    set.builderAction()
    return set
}

inline fun <K, V> buildMap(builderAction: MutableMap<K, V>.() -> Unit): Map<K, V> {
    val map = LinkedHashMap<K, V>()
    map.builderAction()
    return map
}

fun <T> Iterable<T>.toTypedArray(): Array<T> = NativeLists.toArray(this)

fun Collection<Int>.toIntArray(): IntArray {
    val result = IntArray(size)
    var index = 0
    for (element in this) result[index++] = element
    return result
}

fun Collection<Double>.toDoubleArray(): DoubleArray {
    val result = DoubleArray(size)
    var index = 0
    for (element in this) result[index++] = element
    return result
}

fun <T : Comparable<T>> List<T?>.binarySearch(element: T?, fromIndex: Int = 0, toIndex: Int = size): Int {
    when {
        fromIndex > toIndex -> throw IllegalArgumentException("fromIndex ($fromIndex) is greater than toIndex ($toIndex).")
        fromIndex < 0 -> throw IndexOutOfBoundsException("fromIndex ($fromIndex) is less than zero.")
        toIndex > size -> throw IndexOutOfBoundsException("toIndex ($toIndex) is greater than size ($size).")
    }
    var low = fromIndex
    var high = toIndex - 1
    while (low <= high) {
        val mid = (low + high).ushr(1)
        val midVal = get(mid)
        val cmp = compareValues(midVal, element)
        if (cmp < 0) low = mid + 1 else if (cmp > 0) high = mid - 1 else return mid
    }
    return -(low + 1)
}

object NativeLists {
    external fun <T> of(elements: Collection<T>): MutableList<T>
    external fun <T> builder(): ListBuilder<T>
    external fun <T> toArray(elements: Iterable<T>): Array<T>
}

// Maps.

fun <K, V> Map<out K, V>.isNotEmpty(): Boolean = !isEmpty()
fun <K, V> Map<out K, V>?.isNullOrEmpty(): Boolean = this == null || isEmpty()
fun <K, V> Map<K, V>?.orEmpty(): Map<K, V> = this ?: emptyMap()

operator fun <K, V> Map<out K, V>.contains(key: K): Boolean = containsKey(key)

operator fun <K, V> MutableMap<K, V>.set(key: K, value: V) {
    put(key, value)
}

operator fun <K, V> Map<out K, V>.iterator(): Iterator<Map.Entry<K, V>> = entries.iterator()

@JvmName("mutableIterator")
operator fun <K, V> MutableMap<K, V>.iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> = entries.iterator()

operator fun <K, V> Map.Entry<K, V>.component1(): K = key
operator fun <K, V> Map.Entry<K, V>.component2(): V = value

fun <K, V> Map.Entry<K, V>.toPair(): Pair<K, V> = Pair(key, value)

fun <K, V> Map<out K, V>.getOrDefault(key: K, defaultValue: V): V {
    val value = get(key)
    return if (value == null && !containsKey(key)) defaultValue else value as V
}

inline fun <K, V> Map<K, V>.getOrElse(key: K, defaultValue: () -> V): V = get(key) ?: defaultValue()

inline fun <K, V> MutableMap<K, V>.getOrPut(key: K, defaultValue: () -> V): V {
    val value = get(key)
    return if (value == null) {
        val answer = defaultValue()
        put(key, answer)
        answer
    } else {
        value
    }
}

fun <K, V> Map<K, V>.getValue(key: K): V {
    val value = get(key)
    if (value == null && !containsKey(key)) throw NoSuchElementException("Key $key is missing in the map.")
    return value as V
}

inline fun <K, V> Map<out K, V>.forEach(action: (Map.Entry<K, V>) -> Unit) {
    for (element in this) action(element)
}

inline fun <K, V> Map<out K, V>.forEach(action: (K, V) -> Unit) {
    for (element in this) action(element.key, element.value)
}

inline fun <K, V, R> Map<out K, V>.map(transform: (Map.Entry<K, V>) -> R): List<R> {
    val destination = ArrayList<R>(size)
    for (item in this) destination.add(transform(item))
    return destination
}

inline fun <K, V, R : Any> Map<out K, V>.mapNotNull(transform: (Map.Entry<K, V>) -> R?): List<R> {
    val destination = ArrayList<R>()
    for (element in this) {
        val transformed = transform(element)
        if (transformed != null) destination.add(transformed)
    }
    return destination
}

inline fun <K, V, R> Map<out K, V>.flatMap(transform: (Map.Entry<K, V>) -> Iterable<R>): List<R> {
    val destination = ArrayList<R>()
    for (element in this) destination.addAll(transform(element).toList())
    return destination
}

inline fun <K, V, R> Map<out K, V>.mapValues(transform: (Map.Entry<K, V>) -> R): Map<K, R> {
    val destination = LinkedHashMap<K, R>(mapCapacity(size))
    for (element in this) destination.put(element.key, transform(element))
    return destination
}

inline fun <K, V, R> Map<out K, V>.mapKeys(transform: (Map.Entry<K, V>) -> R): Map<R, V> {
    val destination = LinkedHashMap<R, V>(mapCapacity(size))
    for (element in this) destination.put(transform(element), element.value)
    return destination
}

inline fun <K, V> Map<out K, V>.filter(predicate: (Map.Entry<K, V>) -> Boolean): Map<K, V> {
    val destination = LinkedHashMap<K, V>()
    for (element in this) if (predicate(element)) destination.put(element.key, element.value)
    return destination
}

inline fun <K, V> Map<out K, V>.filterNot(predicate: (Map.Entry<K, V>) -> Boolean): Map<K, V> {
    val destination = LinkedHashMap<K, V>()
    for (element in this) if (!predicate(element)) destination.put(element.key, element.value)
    return destination
}

inline fun <K, V> Map<out K, V>.filterKeys(predicate: (K) -> Boolean): Map<K, V> {
    val result = LinkedHashMap<K, V>()
    for (entry in this) if (predicate(entry.key)) result.put(entry.key, entry.value)
    return result
}

inline fun <K, V> Map<out K, V>.filterValues(predicate: (V) -> Boolean): Map<K, V> {
    val result = LinkedHashMap<K, V>()
    for (entry in this) if (predicate(entry.value)) result.put(entry.key, entry.value)
    return result
}

inline fun <K, V> Map<out K, V>.count(predicate: (Map.Entry<K, V>) -> Boolean): Int {
    var count = 0
    for (element in this) if (predicate(element)) count++
    return count
}

fun <K, V> Map<out K, V>.count(): Int = size

inline fun <K, V> Map<out K, V>.any(predicate: (Map.Entry<K, V>) -> Boolean): Boolean {
    for (element in this) if (predicate(element)) return true
    return false
}

inline fun <K, V> Map<out K, V>.all(predicate: (Map.Entry<K, V>) -> Boolean): Boolean {
    for (element in this) if (!predicate(element)) return false
    return true
}

inline fun <K, V> Map<out K, V>.none(predicate: (Map.Entry<K, V>) -> Boolean): Boolean {
    for (element in this) if (predicate(element)) return false
    return true
}

inline fun <K, V, R : Comparable<R>> Map<out K, V>.maxByOrNull(selector: (Map.Entry<K, V>) -> R): Map.Entry<K, V>? = entries.maxByOrNull(selector)
inline fun <K, V, R : Comparable<R>> Map<out K, V>.minByOrNull(selector: (Map.Entry<K, V>) -> R): Map.Entry<K, V>? = entries.minByOrNull(selector)
inline fun <K, V, R : Comparable<R>> Map<out K, V>.maxBy(selector: (Map.Entry<K, V>) -> R): Map.Entry<K, V> = entries.maxBy(selector)
inline fun <K, V, R : Comparable<R>> Map<out K, V>.minBy(selector: (Map.Entry<K, V>) -> R): Map.Entry<K, V> = entries.minBy(selector)
${forwardingSelectorExtrema('Map<out K, V>', 'Map.Entry<K, V>', 'entries', 'K, V, ').join('\n')}

inline fun <K, V> Map<out K, V>.sumOf(selector: (Map.Entry<K, V>) -> Int): Int {
    var sum = 0
    for (element in this) sum += selector(element)
    return sum
}

@JvmName("sumOfDouble")
inline fun <K, V> Map<out K, V>.sumOf(selector: (Map.Entry<K, V>) -> Double): Double {
    var sum = 0.0
    for (element in this) sum += selector(element)
    return sum
}

fun <K, V> Map<out K, V>.toList(): List<Pair<K, V>> {
    if (size == 0) return emptyList()
    val result = ArrayList<Pair<K, V>>(size)
    for (entry in this) result.add(Pair(entry.key, entry.value))
    return result
}

fun <K, V> Map<out K, V>.toMutableMap(): MutableMap<K, V> = LinkedHashMap(this)

fun <K, V> Map<out K, V>.toMap(): Map<K, V> = when (size) {
    0 -> emptyMap()
    1 -> mapOf(pair = entries.iterator().next().toPair())
    else -> LinkedHashMap(this)
}

operator fun <K, V> Map<out K, V>.plus(pair: Pair<K, V>): Map<K, V> {
    if (this.isEmpty()) return mapOf(pair)
    val result = LinkedHashMap<K, V>(this)
    result.put(pair.first, pair.second)
    return result
}

operator fun <K, V> Map<out K, V>.plus(map: Map<out K, V>): Map<K, V> {
    val result = LinkedHashMap<K, V>(this)
    result.putAll(map)
    return result
}

operator fun <K, V> Map<out K, V>.minus(key: K): Map<K, V> {
    val result = LinkedHashMap<K, V>(this)
    result.remove(key)
    return result
}

operator fun <K, V> MutableMap<in K, in V>.plusAssign(pair: Pair<K, V>) {
    put(pair.first, pair.second)
}

operator fun <K, V> MutableMap<K, V>.minusAssign(key: K) {
    remove(key)
}

fun <K, V> MutableMap<in K, in V>.putAll(pairs: Iterable<Pair<K, V>>) {
    for (pair in pairs) put(pair.first, pair.second)
}

fun <K, V> Map<out K, V>.containsKeyOf(key: K): Boolean = containsKey(key)
`;

function floatingExtremaSource(): string {
  return ['Double', 'Float']
    .flatMap((type) => ['min', 'max'].map((operation) => floatingExtremum(type, operation)))
    .join('\n');
}

function floatingExtremum(type: string, operation: string): string {
  return kotlin`
@JvmName("${operation}Of${type}Elements")
fun Iterable<${type}>.${operation}(): ${type} = ${operation}OrNull() ?: throw NoSuchElementException()

@JvmName("${operation}OrNullOf${type}Elements")
fun Iterable<${type}>.${operation}OrNull(): ${type}? {
    val values = iterator()
    if (!values.hasNext()) return null
    var result = values.next()
    while (values.hasNext()) result = kotlin.math.${operation}(result, values.next())
    return result
}

@JvmName("${operation}Of${type}Results")
inline fun <T> Iterable<T>.${operation}Of(selector: (T) -> ${type}): ${type} =
    ${operation}OfOrNull(selector) ?: throw NoSuchElementException()

@JvmName("${operation}OfOrNullOf${type}Results")
inline fun <T> Iterable<T>.${operation}OfOrNull(selector: (T) -> ${type}): ${type}? {
    val values = iterator()
    if (!values.hasNext()) return null
    var result = selector(values.next())
    while (values.hasNext()) result = kotlin.math.${operation}(result, selector(values.next()))
    return result
}
`;
}
