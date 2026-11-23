export const TEXT_COLLECTIONS_SOURCE = `
package kotlin.text

fun CharSequence.any(): Boolean = !isEmpty()
fun CharSequence.none(): Boolean = isEmpty()
fun CharSequence.elementAtOrNull(index: Int): Char? = getOrNull(index)
inline fun CharSequence.elementAtOrElse(index: Int, defaultValue: (Int) -> Char): Char = getOrElse(index, defaultValue)

inline fun CharSequence.lastOrNull(predicate: (Char) -> Boolean): Char? {
    for (index in lastIndex downTo 0) {
        val element = this[index]
        if (predicate(element)) return element
    }
    return null
}
inline fun CharSequence.findLast(predicate: (Char) -> Boolean): Char? = lastOrNull(predicate)
inline fun CharSequence.single(predicate: (Char) -> Boolean): Char {
    var match: Char? = null
    for (element in this) if (predicate(element)) {
        if (match != null) throw IllegalArgumentException("Char sequence contains more than one matching element.")
        match = element
    }
    return match ?: throw NoSuchElementException("Char sequence contains no character matching the predicate.")
}
inline fun CharSequence.singleOrNull(predicate: (Char) -> Boolean): Char? {
    var match: Char? = null
    for (element in this) if (predicate(element)) {
        if (match != null) return null
        match = element
    }
    return match
}

fun CharSequence.random(): Char = random(kotlin.random.Random)
fun CharSequence.random(random: kotlin.random.Random): Char {
    if (isEmpty()) throw NoSuchElementException("Char sequence is empty.")
    return this[random.nextInt(length)]
}
fun CharSequence.randomOrNull(): Char? = randomOrNull(kotlin.random.Random)
fun CharSequence.randomOrNull(random: kotlin.random.Random): Char? =
    if (isEmpty()) null else this[random.nextInt(length)]

inline fun <S : CharSequence> S.onEach(action: (Char) -> Unit): S {
    for (element in this) action(element)
    return this
}
inline fun <S : CharSequence> S.onEachIndexed(action: (Int, Char) -> Unit): S {
    for (index in indices) action(index, this[index])
    return this
}

inline fun <K, V> CharSequence.associate(transform: (Char) -> Pair<K, V>): Map<K, V> =
    associateTo(LinkedHashMap<K, V>(), transform)
inline fun <K, V, M : MutableMap<in K, in V>> CharSequence.associateTo(destination: M, transform: (Char) -> Pair<K, V>): M {
    for (element in this) {
        val pair = transform(element)
        destination.put(pair.first, pair.second)
    }
    return destination
}
inline fun <K> CharSequence.associateBy(keySelector: (Char) -> K): Map<K, Char> =
    associateByTo(LinkedHashMap<K, Char>(), keySelector)
inline fun <K, V> CharSequence.associateBy(keySelector: (Char) -> K, valueTransform: (Char) -> V): Map<K, V> =
    associateByTo(LinkedHashMap<K, V>(), keySelector, valueTransform)
inline fun <K, M : MutableMap<in K, in Char>> CharSequence.associateByTo(destination: M, keySelector: (Char) -> K): M {
    for (element in this) destination.put(keySelector(element), element)
    return destination
}
inline fun <K, V, M : MutableMap<in K, in V>> CharSequence.associateByTo(destination: M, keySelector: (Char) -> K, valueTransform: (Char) -> V): M {
    for (element in this) destination.put(keySelector(element), valueTransform(element))
    return destination
}
inline fun <V, M : MutableMap<in Char, in V>> CharSequence.associateWithTo(destination: M, valueSelector: (Char) -> V): M {
    for (element in this) destination.put(element, valueSelector(element))
    return destination
}

inline fun <R : Comparable<R>> CharSequence.maxBy(selector: (Char) -> R): Char =
    maxByOrNull(selector) ?: throw NoSuchElementException()
inline fun <R : Comparable<R>> CharSequence.minBy(selector: (Char) -> R): Char =
    minByOrNull(selector) ?: throw NoSuchElementException()
inline fun <R : Comparable<R>> CharSequence.maxByOrNull(selector: (Char) -> R): Char? =
    bestBy(true, selector)
inline fun <R : Comparable<R>> CharSequence.minByOrNull(selector: (Char) -> R): Char? =
    bestBy(false, selector)

private inline fun <R : Comparable<R>> CharSequence.bestBy(largest: Boolean, selector: (Char) -> R): Char? {
    if (isEmpty()) return null
    var best = this[0]
    val last = lastIndex
    if (last == 0) return best
    var key = selector(best)
    for (index in 1..last) {
        val element = this[index]
        val next = selector(element)
        if (if (largest) key < next else key > next) {
            best = element
            key = next
        }
    }
    return best
}

${charSelectorExtrema()}
inline fun <R> CharSequence.foldIndexed(initial: R, operation: (Int, R, Char) -> R): R {
    var result = initial
    for (index in indices) result = operation(index, result, this[index])
    return result
}
inline fun <R> CharSequence.foldRight(initial: R, operation: (Char, R) -> R): R {
    var result = initial
    for (index in lastIndex downTo 0) result = operation(this[index], result)
    return result
}
inline fun <R> CharSequence.foldRightIndexed(initial: R, operation: (Int, Char, R) -> R): R {
    var result = initial
    for (index in lastIndex downTo 0) result = operation(index, this[index], result)
    return result
}
inline fun CharSequence.reduceOrNull(operation: (Char, Char) -> Char): Char? =
    reduceIndexedOrNull { _, acc, element -> operation(acc, element) }
inline fun CharSequence.reduceIndexed(operation: (Int, Char, Char) -> Char): Char =
    reduceIndexedOrNull(operation) ?: throw UnsupportedOperationException("Empty char sequence can't be reduced.")
inline fun CharSequence.reduceIndexedOrNull(operation: (Int, Char, Char) -> Char): Char? {
    val end = lastIndex
    if (end < 0) return null
    var result = this[0]
    for (index in 1..end) result = operation(index, result, this[index])
    return result
}
inline fun CharSequence.reduceRight(operation: (Char, Char) -> Char): Char =
    reduceRightOrNull(operation) ?: throw UnsupportedOperationException("Empty char sequence can't be reduced.")
inline fun CharSequence.reduceRightOrNull(operation: (Char, Char) -> Char): Char? =
    reduceRightIndexedOrNull { _, element, acc -> operation(element, acc) }
inline fun CharSequence.reduceRightIndexed(operation: (Int, Char, Char) -> Char): Char =
    reduceRightIndexedOrNull(operation) ?: throw UnsupportedOperationException("Empty char sequence can't be reduced.")
inline fun CharSequence.reduceRightIndexedOrNull(operation: (Int, Char, Char) -> Char): Char? {
    val end = lastIndex
    if (end < 0) return null
    var result = this[end]
    for (index in end - 1 downTo 0) result = operation(index, this[index], result)
    return result
}
inline fun CharSequence.runningReduce(operation: (Char, Char) -> Char): List<Char> =
    runningReduceIndexed { _, acc, element -> operation(acc, element) }
inline fun CharSequence.runningReduceIndexed(operation: (Int, Char, Char) -> Char): List<Char> {
    if (isEmpty()) return emptyList()
    var result = this[0]
    val values = ArrayList<Char>(length)
    values.add(result)
    for (index in 1..lastIndex) {
        result = operation(index, result, this[index])
        values.add(result)
    }
    return values
}

inline fun <R> CharSequence.runningFold(initial: R, operation: (R, Char) -> R): List<R> {
    if (isEmpty()) return listOf(initial)
    val result = ArrayList<R>(length + 1)
    result.add(initial)
    var accumulator = initial
    for (element in this) {
        accumulator = operation(accumulator, element)
        result.add(accumulator)
    }
    return result
}

inline fun <R> CharSequence.runningFoldIndexed(initial: R, operation: (Int, R, Char) -> R): List<R> {
    if (isEmpty()) return listOf(initial)
    val result = ArrayList<R>(length + 1)
    result.add(initial)
    var accumulator = initial
    for (index in indices) {
        accumulator = operation(index, accumulator, this[index])
        result.add(accumulator)
    }
    return result
}

inline fun <R> CharSequence.scan(initial: R, operation: (R, Char) -> R): List<R> =
    runningFold(initial, operation)
inline fun <R> CharSequence.scanIndexed(initial: R, operation: (Int, R, Char) -> R): List<R> =
    runningFoldIndexed(initial, operation)

${charSumOfSource()}

inline fun <K> CharSequence.groupBy(keySelector: (Char) -> K): Map<K, List<Char>> =
    groupBy(keySelector) { it }
inline fun <K, V> CharSequence.groupBy(keySelector: (Char) -> K, valueTransform: (Char) -> V): Map<K, List<V>> =
    groupByTo(LinkedHashMap<K, MutableList<V>>(), keySelector, valueTransform)
inline fun <K, M : MutableMap<in K, MutableList<Char>>> CharSequence.groupByTo(destination: M, keySelector: (Char) -> K): M =
    groupByTo(destination, keySelector) { it }
inline fun <K, V, M : MutableMap<in K, MutableList<V>>> CharSequence.groupByTo(
    destination: M, keySelector: (Char) -> K, valueTransform: (Char) -> V
): M {
    for (element in this) {
        val key = keySelector(element)
        val values = destination.get(key) ?: ArrayList<V>().also { destination.put(key, it) }
        values.add(valueTransform(element))
    }
    return destination
}

inline fun <R : Any> CharSequence.firstNotNullOf(transform: (Char) -> R?): R =
    firstNotNullOfOrNull(transform) ?: throw NoSuchElementException("No element of the char sequence was transformed to a non-null value.")
inline fun <R : Any> CharSequence.firstNotNullOfOrNull(transform: (Char) -> R?): R? {
    for (element in this) {
        val value = transform(element)
        if (value != null) return value
    }
    return null
}

inline fun <R, C : MutableCollection<in R>> CharSequence.mapTo(destination: C, transform: (Char) -> R): C {
    for (element in this) destination.add(transform(element))
    return destination
}
inline fun <R, C : MutableCollection<in R>> CharSequence.mapIndexedTo(destination: C, transform: (Int, Char) -> R): C {
    var index = 0
    for (element in this) destination.add(transform(index++, element))
    return destination
}
inline fun <R : Any, C : MutableCollection<in R>> CharSequence.mapNotNullTo(destination: C, transform: (Char) -> R?): C {
    for (element in this) {
        val value = transform(element)
        if (value != null) destination.add(value)
    }
    return destination
}
inline fun <R : Any> CharSequence.mapIndexedNotNull(transform: (Int, Char) -> R?): List<R> =
    mapIndexedNotNullTo(ArrayList<R>(), transform)
inline fun <R : Any, C : MutableCollection<in R>> CharSequence.mapIndexedNotNullTo(
    destination: C, transform: (Int, Char) -> R?
): C {
    var index = 0
    for (element in this) {
        val value = transform(index++, element)
        if (value != null) destination.add(value)
    }
    return destination
}

inline fun CharSequence.filterTo(destination: StringBuilder, predicate: (Char) -> Boolean): StringBuilder {
    for (element in this) if (predicate(element)) destination.append(element)
    return destination
}
inline fun CharSequence.filterNotTo(destination: StringBuilder, predicate: (Char) -> Boolean): StringBuilder =
    filterTo(destination) { !predicate(it) }
inline fun CharSequence.filterIndexedTo(destination: StringBuilder, predicate: (Int, Char) -> Boolean): StringBuilder {
    var index = 0
    for (element in this) if (predicate(index++, element)) destination.append(element)
    return destination
}

fun <C : MutableCollection<in Char>> CharSequence.toCollection(destination: C): C {
    for (element in this) destination.add(element)
    return destination
}
fun CharSequence.toHashSet(): HashSet<Char> = toCollection(HashSet<Char>(mapCapacity(length)))

fun CharSequence.maxWith(comparator: Comparator<in Char>): Char = maxWithOrNull(comparator) ?: throw NoSuchElementException()
fun CharSequence.minWith(comparator: Comparator<in Char>): Char = minWithOrNull(comparator) ?: throw NoSuchElementException()
fun CharSequence.maxWithOrNull(comparator: Comparator<in Char>): Char? = bestWith(comparator, true)
fun CharSequence.minWithOrNull(comparator: Comparator<in Char>): Char? = bestWith(comparator, false)
private fun CharSequence.bestWith(comparator: Comparator<in Char>, largest: Boolean): Char? {
    if (isEmpty()) return null
    var best = this[0]
    for (index in 1..lastIndex) {
        val next = this[index]
        val order = comparator.compare(best, next)
        if (if (largest) order < 0 else order > 0) best = next
    }
    return best
}
`;

function charSelectorExtrema(): string {
  return ['min', 'max']
    .flatMap((direction) =>
      [false, true].flatMap((orNull) =>
        ['R', 'Double', 'Float'].map((type) => charSelectorExtremum(direction, type, orNull))
      )
    )
    .join('\n');
}

function charSelectorExtremum(direction: string, type: string, orNull: boolean): string {
  const generic = type === 'R' ? '<R : Comparable<R>> ' : '';
  const method = `${direction}Of${orNull ? 'OrNull' : ''}`;
  const label = type === 'R' ? '' : `@JvmName("${method}${type}") `;
  const comparison =
    type === 'R'
      ? `if (best ${direction === 'min' ? '>' : '<'} next) best = next`
      : `best = kotlin.math.${direction}(best, next)`;
  return `${label}@OverloadResolutionByLambdaReturnType inline fun ${generic}CharSequence.${method}(selector: (Char) -> ${type}): ${type}${orNull ? '?' : ''} {
    if (isEmpty()) ${orNull ? 'return null' : 'throw NoSuchElementException()'}
    var best = selector(this[0])
    for (index in 1..lastIndex) {
        val next = selector(this[index])
        ${comparison}
    }
    return best
}`;
}

function charSumOfSource(): string {
  const types = [
    ['Int', '0'],
    ['Long', '0L'],
    ['Double', '0.0'],
    ['UInt', '0u'],
    ['ULong', '0uL'],
  ];
  return types
    .map(
      ([type, zero]) => `@JvmName("sumOf${type}")
@OverloadResolutionByLambdaReturnType inline fun CharSequence.sumOf(selector: (Char) -> ${type}): ${type} {
    var result = ${zero}
    for (element in this) result += selector(element)
    return result
}`
    )
    .join('\n');
}
