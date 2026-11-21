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
    if (isEmpty()) null else reduce(operation)

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
  return `${label}inline fun ${generic}CharSequence.${method}(selector: (Char) -> ${type}): ${type}${orNull ? '?' : ''} {
    if (isEmpty()) ${orNull ? 'return null' : 'throw NoSuchElementException()'}
    var best = selector(this[0])
    for (index in 1..lastIndex) {
        val next = selector(this[index])
        ${comparison}
    }
    return best
}`;
}
