import {
  forwardingSelectorExtrema,
  NUMERIC_AGGREGATE_TYPES,
  numericAggregates,
  UNSIGNED_NUMERIC_AGGREGATE_TYPES,
} from './source';

/**
 * The functions of arrays, generated for `Array<T>` and each primitive array as Kotlin's standard library generates
 * them. Most go through `asList()`, a list of the array's elements, which keeps their results and messages those of
 * lists where Kotlin's are the same.
 */

/** The arrays of unsigned numbers, with their elements' type, which `@OptIn(ExperimentalUnsignedTypes::class)` allows. */
export const UNSIGNED_ARRAYS = [
  ['UByteArray', 'UByte'],
  ['UShortArray', 'UShort'],
  ['UIntArray', 'UInt'],
  ['ULongArray', 'ULong'],
] as const;

interface ArrayKind {
  /** The receiver as a function declares it, such as `Array<out T>` or `IntArray`. */
  receiver: string;
  /** The type parameters the functions declare before their own, such as `T, ` for `Array<out T>`. */
  typeParameters: string;
  element: string;
  /** The type of the elements' sum, for arrays of numbers. */
  sum: string | undefined;
  isComparable: boolean;
  zero: string;
}

const KINDS: ArrayKind[] = [
  { receiver: 'Array<out T>', typeParameters: 'T, ', element: 'T', sum: undefined, isComparable: false, zero: 'null' },
  ...NUMERIC_AGGREGATE_TYPES.map((kind): ArrayKind => ({
    ...kind,
    receiver: `${kind.element}Array`,
    typeParameters: '',
    isComparable: true,
  })),
  {
    receiver: 'CharArray',
    typeParameters: '',
    element: 'Char',
    sum: undefined,
    isComparable: true,
    zero: String.raw`'\\u0000'`,
  },
  {
    receiver: 'BooleanArray',
    typeParameters: '',
    element: 'Boolean',
    sum: undefined,
    isComparable: false,
    zero: 'false',
  },
  ...UNSIGNED_ARRAYS.map(([receiver, element]): ArrayKind => ({
    receiver,
    typeParameters: '',
    element,
    sum: element === 'ULong' ? 'ULong' : 'UInt',
    isComparable: true,
    zero: element === 'ULong' ? '0uL' : '0u',
  })),
];

/** The generic part of a function's type parameters, such as `<T, R>`, or nothing. */
function generics(kind: ArrayKind, own: string): string {
  const all = `${kind.typeParameters}${own}`.replace(/, $/, '');
  return all ? `<${all}> ` : '';
}

function functionsOf(kind: ArrayKind): string {
  const { receiver: r, element: e } = kind;
  const g = (own = ''): string => generics(kind, own);
  const onlyInput = kind.typeParameters ? '<@OnlyInputTypes T> ' : '';
  const lines = [
    `external fun ${g()}${r}.asList(): List<${e}>`,
    `external fun ${g()}${r}?.contentToString(): String`,
    `external fun ${g()}${r}.copyOf(): ${r.replace('out ', '')}`,
    `external fun ${g()}${r}.copyOf(newSize: Int): ${r === 'Array<out T>' ? 'Array<T?>' : r}`,
    `external fun ${g()}${r}.copyOfRange(fromIndex: Int, toIndex: Int): ${r.replace('out ', '')}`,
    `external infix fun ${g()}${r}?.contentEquals(other: ${r}?): Boolean`,
    `val ${g()}${r}.indices: IntRange get() = 0..size - 1`,
    `val ${g()}${r}.lastIndex: Int get() = size - 1`,
    `fun ${g()}${r}.isEmpty(): Boolean = size == 0`,
    `fun ${g()}${r}.isNotEmpty(): Boolean = size != 0`,
    `inline fun ${g()}${r}.forEach(action: (${e}) -> Unit) { for (element in this) action(element) }`,
    `inline fun ${g()}${r}.forEachIndexed(action: (index: Int, ${e}) -> Unit) { var index = 0; for (item in this) action(index++, item) }`,
    `inline fun ${g('R')}${r}.map(transform: (${e}) -> R): List<R> = asList().map(transform)`,
    `inline fun ${g('R')}${r}.mapIndexed(transform: (index: Int, ${e}) -> R): List<R> = asList().mapIndexed(transform)`,
    `inline fun ${g('R : Any')}${r}.mapNotNull(transform: (${e}) -> R?): List<R> = asList().mapNotNull(transform)`,
    `inline fun ${g('R')}${r}.flatMap(transform: (${e}) -> Iterable<R>): List<R> = asList().flatMap(transform)`,
    `inline fun ${g()}${r}.filter(predicate: (${e}) -> Boolean): List<${e}> = asList().filter(predicate)`,
    `inline fun ${g()}${r}.filterNot(predicate: (${e}) -> Boolean): List<${e}> = asList().filterNot(predicate)`,
    `inline fun ${g()}${r}.filterIndexed(predicate: (index: Int, ${e}) -> Boolean): List<${e}> = asList().filterIndexed(predicate)`,
    `inline fun ${g()}${r}.any(predicate: (${e}) -> Boolean): Boolean = asList().any(predicate)`,
    `fun ${g()}${r}.any(): Boolean = size != 0`,
    `inline fun ${g()}${r}.all(predicate: (${e}) -> Boolean): Boolean = asList().all(predicate)`,
    `inline fun ${g()}${r}.none(predicate: (${e}) -> Boolean): Boolean = asList().none(predicate)`,
    `fun ${g()}${r}.none(): Boolean = size == 0`,
    `inline fun ${g()}${r}.count(predicate: (${e}) -> Boolean): Int = asList().count(predicate)`,
    `fun ${g()}${r}.count(): Int = size`,
    `fun ${g()}${r}.first(): ${e} { if (isEmpty()) throw NoSuchElementException("Array is empty."); return this[0] }`,
    `inline fun ${g()}${r}.first(predicate: (${e}) -> Boolean): ${e} { for (element in this) if (predicate(element)) return element; throw NoSuchElementException("Array contains no element matching the predicate.") }`,
    `fun ${g()}${r}.firstOrNull(): ${e}? = if (isEmpty()) null else this[0]`,
    `inline fun ${g()}${r}.firstOrNull(predicate: (${e}) -> Boolean): ${e}? = asList().firstOrNull(predicate)`,
    `fun ${g()}${r}.last(): ${e} { if (isEmpty()) throw NoSuchElementException("Array is empty."); return this[lastIndex] }`,
    `inline fun ${g()}${r}.last(predicate: (${e}) -> Boolean): ${e} { var index = lastIndex; while (index >= 0) { val element = this[index]; if (predicate(element)) return element; index-- }; throw NoSuchElementException("Array contains no element matching the predicate.") }`,
    `fun ${g()}${r}.lastOrNull(): ${e}? = if (isEmpty()) null else this[size - 1]`,
    `inline fun ${g()}${r}.find(predicate: (${e}) -> Boolean): ${e}? = asList().firstOrNull(predicate)`,
    `inline fun ${g()}${r}.lastOrNull(predicate: (${e}) -> Boolean): ${e}? {
        for (index in lastIndex downTo 0) {
            val element = this[index]
            if (predicate(element)) return element
        }
        return null
    }`,
    `inline fun ${g()}${r}.findLast(predicate: (${e}) -> Boolean): ${e}? = lastOrNull(predicate)`,
    `fun ${g()}${r}.single(): ${e} = when (size) { 0 -> throw NoSuchElementException("Array is empty."); 1 -> this[0]; else -> throw IllegalArgumentException("Array has more than one element.") }`,
    `fun ${g()}${r}.getOrNull(index: Int): ${e}? = if (index >= 0 && index < size) get(index) else null`,
    `inline fun ${g()}${r}.getOrElse(index: Int, defaultValue: (Int) -> ${e}): ${e} = if (index >= 0 && index < size) get(index) else defaultValue(index)`,
    `fun ${g()}${r}.elementAt(index: Int): ${e} = get(index)`,
    ...(e === 'Float' || e === 'Double'
      ? []
      : [
          `fun ${onlyInput}${r}.indexOf(element: ${e}): Int = asList().indexOf(element)`,
          `fun ${onlyInput}${r}.lastIndexOf(element: ${e}): Int = asList().lastIndexOf(element)`,
          `operator fun ${onlyInput}${r}.contains(element: ${e}): Boolean = indexOf(element) >= 0`,
        ]),
    `inline fun ${g()}${r}.indexOfFirst(predicate: (${e}) -> Boolean): Int = asList().indexOfFirst(predicate)`,
    `inline fun ${g()}${r}.indexOfLast(predicate: (${e}) -> Boolean): Int = asList().indexOfLast(predicate)`,
    `inline fun ${g('R')}${r}.fold(initial: R, operation: (acc: R, ${e}) -> R): R = asList().fold(initial, operation)`,
    `inline fun ${g('R')}${r}.foldIndexed(initial: R, operation: (index: Int, acc: R, ${e}) -> R): R = asList().foldIndexed(initial, operation)`,
    `@OverloadResolutionByLambdaReturnType inline fun ${g()}${r}.sumOf(selector: (${e}) -> Int): Int = asList().sumOf(selector)`,
    `@JvmName("sumOfDouble") @OverloadResolutionByLambdaReturnType inline fun ${g()}${r}.sumOf(selector: (${e}) -> Double): Double = asList().sumOf(selector)`,
    `@JvmName("sumOfLong") @OverloadResolutionByLambdaReturnType inline fun ${g()}${r}.sumOf(selector: (${e}) -> Long): Long = asList().sumOf(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.maxBy(selector: (${e}) -> R): ${e} { if (isEmpty()) throw NoSuchElementException(); return asList().maxBy(selector) }`,
    `inline fun ${g('R : Comparable<R>')}${r}.minBy(selector: (${e}) -> R): ${e} { if (isEmpty()) throw NoSuchElementException(); return asList().minBy(selector) }`,
    `inline fun ${g('R : Comparable<R>')}${r}.maxByOrNull(selector: (${e}) -> R): ${e}? = asList().maxByOrNull(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.minByOrNull(selector: (${e}) -> R): ${e}? = asList().minByOrNull(selector)`,
    ...arrayUtilities(kind),
    ...forwardingSelectorExtrema(r, e, 'asList()', kind.typeParameters),
    `inline fun ${g('R : Comparable<R>')}${r}.sortedBy(crossinline selector: (${e}) -> R?): List<${e}> = asList().sortedBy(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.sortedByDescending(crossinline selector: (${e}) -> R?): List<${e}> = asList().sortedByDescending(selector)`,
    `fun ${g()}${r}.sortedWith(comparator: Comparator<in ${e}>): List<${e}> = asList().sortedWith(comparator)`,
    `fun ${g()}${r}.toList(): List<${e}> = asList().toList()`,
    `fun ${g()}${r}.toMutableList(): MutableList<${e}> = ArrayList(asList())`,
    `fun ${g()}${r}.toSet(): Set<${e}> = asList().toSet()`,
    `fun ${g()}${r}.toMutableSet(): MutableSet<${e}> = asList().toMutableSet()`,
    `fun ${g()}${r}.toHashSet(): HashSet<${e}> = asList().toHashSet()`,
    `fun ${g()}${r}.distinct(): List<${e}> = asList().distinct()`,
    `inline fun ${g('K')}${r}.distinctBy(selector: (${e}) -> K): List<${e}> = asList().distinctBy(selector)`,
    `fun ${g()}${r}.reversed(): List<${e}> = asList().reversed()`,
    `fun ${g()}${r}.take(n: Int): List<${e}> = asList().take(n)`,
    `fun ${g()}${r}.drop(n: Int): List<${e}> = asList().drop(n)`,
    `fun ${g()}${r}.takeLast(n: Int): List<${e}> = asList().takeLast(n)`,
    `fun ${g()}${r}.dropLast(n: Int): List<${e}> = asList().dropLast(n)`,
    `inline fun ${g()}${r}.takeWhile(predicate: (${e}) -> Boolean): List<${e}> = asList().takeWhile(predicate)`,
    `inline fun ${g()}${r}.dropWhile(predicate: (${e}) -> Boolean): List<${e}> = asList().dropWhile(predicate)`,
    `fun ${g()}${r}.slice(indices: IntRange): List<${e}> = asList().slice(indices)`,
    `fun ${g()}${r}.slice(indices: Iterable<Int>): List<${e}> = sliceByIndex(indices) { get(it) }`,
    `fun ${g()}${r}.withIndex(): Iterable<IndexedValue<${e}>> = asList().withIndex()`,
    `inline fun ${g('K')}${r}.groupBy(keySelector: (${e}) -> K): Map<K, List<${e}>> = asList().groupBy(keySelector)`,
    `inline fun ${g('K, V')}${r}.associate(transform: (${e}) -> Pair<K, V>): Map<K, V> = asList().associate(transform)`,
    `inline fun ${g('K')}${r}.associateBy(keySelector: (${e}) -> K): Map<K, ${e}> = asList().associateBy(keySelector)`,
    `inline fun ${g()}${r}.partition(predicate: (${e}) -> Boolean): Pair<List<${e}>, List<${e}>> = asList().partition(predicate)`,
    `infix fun ${g('R')}${r}.zip(other: Iterable<R>): List<Pair<${e}, R>> = asList().zip(other)`,
    `inline fun ${g('R, V')}${r}.zip(other: Iterable<R>, transform: (a: ${e}, b: R) -> V): List<V> = asList().zip(other, transform)`,
    `fun ${g()}${r}.joinToString(separator: CharSequence = ", ", prefix: CharSequence = "", postfix: CharSequence = "", limit: Int = -1, truncated: CharSequence = "...", transform: ((${e}) -> CharSequence)? = null): String = asList().joinToString(separator, prefix, postfix, limit, truncated, transform)`,
    `fun ${g()}${r}.random(): ${e} = random(kotlin.random.Random)`,
    `fun ${g()}${r}.random(random: kotlin.random.Random): ${e} {
        if (isEmpty()) throw NoSuchElementException("Array is empty.")
        return get(random.nextInt(size))
    }`,
    `fun ${g()}${r}.randomOrNull(): ${e}? = randomOrNull(kotlin.random.Random)`,
    `fun ${g()}${r}.randomOrNull(random: kotlin.random.Random): ${e}? =
        if (isEmpty()) null else get(random.nextInt(size))`,
    `external fun ${g()}${r}.fill(element: ${e}, fromIndex: Int = 0, toIndex: Int = size)`,
    `fun ${g()}${r}.reverse() = reverse(0, size)`,
    `external fun ${g()}${r}.reverse(fromIndex: Int, toIndex: Int)`,
    `inline fun ${g()}${r}.single(predicate: (${e}) -> Boolean): ${e} {
    var single: ${e}? = null
    var found = false
    for (element in this) {
        if (predicate(element)) {
            if (found) throw IllegalArgumentException("Array contains more than one matching element.")
            single = element
            found = true
        }
    }
    if (!found) throw NoSuchElementException("Array contains no element matching the predicate.")
    return single as ${e}
}`,
    `inline fun ${g()}${r}.singleOrNull(predicate: (${e}) -> Boolean): ${e}? = asList().singleOrNull(predicate)`,
    `fun ${g()}${r}.singleOrNull(): ${e}? = if (size == 1) this[0] else null`,
    `inline fun ${g()}${r}.reduce(operation: (acc: ${e}, ${e}) -> ${e}): ${e} { if (isEmpty()) throw UnsupportedOperationException("Empty array can't be reduced."); var accumulator = this[0]; for (index in 1..lastIndex) accumulator = operation(accumulator, this[index]); return accumulator }`,
    `inline fun ${g()}${r}.reduceOrNull(operation: (acc: ${e}, ${e}) -> ${e}): ${e}? = if (isEmpty()) null else reduce(operation)`,
    `inline fun ${g('R')}${r}.scan(initial: R, operation: (acc: R, ${e}) -> R): List<R> = asList().scan(initial, operation)`,
    `inline fun ${g('R')}${r}.runningFold(initial: R, operation: (acc: R, ${e}) -> R): List<R> = asList().runningFold(initial, operation)`,
    `inline fun ${g()}${r}.onEach(action: (${e}) -> Unit): ${r.replace('out ', '')} { for (element in this) action(element); return this as ${r.replace('out ', '')} }`,
    `inline fun ${g('V')}${r}.associateWith(valueSelector: (${e}) -> V): Map<${e}, V> = asList().associateWith(valueSelector)`,
    `fun ${g()}${r}.elementAtOrNull(index: Int): ${e}? = getOrNull(index)`,
    `infix fun ${g('R')}${r}.zip(other: Array<out R>): List<Pair<${e}, R>> = asList().zip(other.asList())`,
    `inline fun ${g('R, V')}${r}.zip(other: Array<out R>, transform: (a: ${e}, b: R) -> V): List<V> = asList().zip(other.asList(), transform)`,
    ...(kind.typeParameters
      ? []
      : [
          `infix fun ${r}.zip(other: ${r}): List<Pair<${e}, ${e}>> = asList().zip(other.asList())`,
          `inline fun <V> ${r}.zip(other: ${r}, transform: (a: ${e}, b: ${e}) -> V): List<V> = asList().zip(other.asList(), transform)`,
        ]),
    `fun ${g()}${r}.reversedArray(): ${r.replace('out ', '')} = copyOf().also { it.reverse() }`,
    `external fun ${g()}${r}.sliceArray(indices: Collection<Int>): ${r.replace('out ', '')}`,
    `fun ${g()}${r}.sliceArray(indices: IntRange): ${r.replace('out ', '')} = if (indices.isEmpty()) copyOfRange(0, 0) else copyOfRange(indices.first, indices.last + 1)`,
    ...[1, 2, 3, 4, 5].map((n) => `operator fun ${g()}${r}.component${n}(): ${e} = get(${n - 1})`),
  ];
  if (!kind.typeParameters) lines.push(`fun ${r}.toTypedArray(): Array<${e}> = asList().toTypedArray()`);
  if (kind.sum) lines.push(...numericAggregates(r, { ...kind, sum: kind.sum }, false));
  if (kind.isComparable) {
    const floating = e === 'Double' || e === 'Float';
    const keepMax = floating ? 'max = kotlin.math.max(max, e)' : 'if (max < e) max = e';
    const keepMin = floating ? 'min = kotlin.math.min(min, e)' : 'if (min > e) min = e';
    lines.push(
      `fun ${r}.max(): ${e} { if (isEmpty()) throw NoSuchElementException(); var max = this[0]; for (i in 1..lastIndex) { val e = this[i]; ${keepMax} }; return max }`,
      `fun ${r}.min(): ${e} { if (isEmpty()) throw NoSuchElementException(); var min = this[0]; for (i in 1..lastIndex) { val e = this[i]; ${keepMin} }; return min }`,
      `fun ${r}.maxOrNull(): ${e}? = if (isEmpty()) null else max()`,
      `fun ${r}.minOrNull(): ${e}? = if (isEmpty()) null else min()`,
      `fun ${r}.sort() = sort(0, size)`,
      `external fun ${r}.sort(fromIndex: Int = 0, toIndex: Int = size)`,
      `fun ${r}.sortDescending() = sortDescending(0, size)`,
      `fun ${r}.sortDescending(fromIndex: Int, toIndex: Int) { sort(fromIndex, toIndex); reverse(fromIndex, toIndex) }`,
      `fun ${r}.sortedArray(): ${r} = copyOf().also { it.sort() }`,
      `fun ${r}.sortedArrayDescending(): ${r} = copyOf().also { it.sortDescending() }`,
      `fun ${r}.sorted(): List<${e}> = asList().sorted()`,
      `fun ${r}.sortedDescending(): List<${e}> = asList().sortedDescending()`
    );
  }
  return lines.join('\n');
}

/** `Array<T>`'s functions that need its elements to be comparable or nullable, and the arrays' factories. */
function arrayUtilities(kind: ArrayKind): string[] {
  const { receiver, element, typeParameters, isComparable } = kind;
  const g = generics(kind, '');
  const result = receiver.replace('out ', '');
  const cast = typeParameters ? ` as ${result}` : '';
  const mutableReceiver = typeParameters ? '(this as Array<T>)' : 'this';
  const unsigned = element.startsWith('U');
  const lines = [
    `external fun ${g}${receiver}.copyInto(destination: ${result}, destinationOffset: Int = 0, startIndex: Int = 0, endIndex: Int = size): ${result}`,
    `external fun ${g}${receiver}?.contentHashCode(): Int`,
    `operator fun ${g}${receiver}.plus(element: ${element}): ${result} {
        val result = copyOf(size + 1)${cast}
        result[size] = element
        return result
    }`,
    `operator fun ${g}${receiver}.plus(elements: ${receiver}): ${result} {
        val result = copyOf(size + elements.size)${cast}
        return elements.copyInto(result, size)
    }`,
    `operator fun ${g}${receiver}.plus(elements: Collection<${element}>): ${result} {
        val result = copyOf(size + elements.size)${cast}
        var index = size
        for (element in elements) result[index++] = element
        return result
    }`,
    `fun ${g}${receiver}.shuffle() = shuffle(kotlin.random.Random)`,
    `fun ${g}${receiver}.shuffle(random: kotlin.random.Random) {
        val array = ${mutableReceiver}
        for (index in lastIndex downTo 1) {
            val other = random.nextInt(index + 1)
            val element = array[index]
            array[index] = array[other]
            array[other] = element
        }
    }`,
  ];
  if (!unsigned)
    lines.push(
      `fun ${g}${receiver}.asIterable(): Iterable<${element}> = if (isEmpty()) emptyList() else ArrayElements(asList())`
    );
  if (!unsigned && (isComparable || typeParameters)) {
    const comparable = typeParameters ? '(this[it] as Comparable<T>)' : 'this[it]';
    lines.push(`fun ${g}${receiver}.binarySearch(element: ${element}, fromIndex: Int = 0, toIndex: Int = size): Int =
        binarySearchArray(size, fromIndex, toIndex) { ${comparable}.compareTo(element) }`);
  }
  return lines;
}

const GENERIC_ARRAY_SOURCE = `
fun <T : Any> Array<out T?>.filterNotNull(): List<T> = asList().filterNotNull()
fun <T : Comparable<T>> Array<out T>.max(): T = asList().max()
fun <T : Comparable<T>> Array<out T>.min(): T = asList().min()
fun <T : Comparable<T>> Array<out T>.maxOrNull(): T? = asList().maxOrNull()
fun <T : Comparable<T>> Array<out T>.minOrNull(): T? = asList().minOrNull()
fun <T : Comparable<T>> Array<out T>.sorted(): List<T> = asList().sorted()
fun <T : Comparable<T>> Array<out T>.sortedDescending(): List<T> = asList().sortedDescending()
fun <T : Comparable<T>> Array<out T>.sort() = sortWith<T>(naturalOrder<T>(), 0, size)
fun <T> Array<out T>.sort(fromIndex: Int = 0, toIndex: Int = size) =
    sortWith<T>(NaturalOrderComparator as Comparator<T>, fromIndex, toIndex)
fun <T> Array<out T>.sortWith(comparator: Comparator<in T>) = sortWith<T>(comparator, 0, size)
external fun <T> Array<out T>.sortWith(comparator: Comparator<in T>, fromIndex: Int = 0, toIndex: Int = size)
inline fun <T, R : Comparable<R>> Array<out T>.sortBy(crossinline selector: (T) -> R?) = sortWith(compareBy(selector))
${[...NUMERIC_AGGREGATE_TYPES, ...UNSIGNED_NUMERIC_AGGREGATE_TYPES].flatMap((kind) => numericAggregates(`Array<out ${kind.element}>`, kind, true)).join('\n')}
fun <T : Comparable<T>> Array<out T>.sortDescending() = sortDescending(0, size)
fun <T : Comparable<T>> Array<out T>.sortDescending(fromIndex: Int, toIndex: Int) =
    sortWith<T>(reverseOrder<T>(), fromIndex, toIndex)
fun <T : Comparable<T>> Array<T>.sortedArray(): Array<T> = copyOf().also { it.sort() }
fun <T : Comparable<T>> Array<T>.sortedArrayDescending(): Array<T> = copyOf().also { it.sortDescending() }
fun <T> Array<out T>?.contentDeepToString(): String = if (this == null) "null" else deepArrayString(this, HashSet<Any>())
private fun deepArrayString(array: Array<*>, active: MutableSet<Any>): String {
    if (!active.add(array)) return "[...]"
    try {
        return array.joinToString(", ", "[", "]") { deepString(it, active) }
    } finally {
        active.remove(array)
    }
}
private fun deepString(element: Any?, active: MutableSet<Any>): String = when (element) {
    is Array<*> -> deepArrayString(element, active)
    is IntArray -> element.contentToString()
    is LongArray -> element.contentToString()
    is DoubleArray -> element.contentToString()
    is FloatArray -> element.contentToString()
    is ShortArray -> element.contentToString()
    is ByteArray -> element.contentToString()
    is CharArray -> element.contentToString()
    is BooleanArray -> element.contentToString()
    else -> element.toString()
}
private class ArrayElements<T>(private val values: List<T>) : Iterable<T> {
    override fun iterator(): Iterator<T> = values.iterator()
}

private inline fun binarySearchArray(size: Int, fromIndex: Int, toIndex: Int, compareAt: (Int) -> Int): Int {
    if (fromIndex > toIndex) throw IllegalArgumentException("fromIndex($fromIndex) > toIndex($toIndex)")
    if (fromIndex < 0) throw ArrayIndexOutOfBoundsException("Array index out of range: $fromIndex")
    if (toIndex > size) throw ArrayIndexOutOfBoundsException("Array index out of range: $toIndex")
    var low = fromIndex
    var high = toIndex - 1
    while (low <= high) {
        val index = (low + high).ushr(1)
        val order = compareAt(index)
        if (order < 0) low = index + 1 else if (order > 0) high = index - 1 else return index
    }
    return -low - 1
}

fun <T> Array<out T>.binarySearch(element: T, comparator: Comparator<in T>, fromIndex: Int = 0, toIndex: Int = size): Int =
    binarySearchArray(size, fromIndex, toIndex) { comparator.compare(this[it], element) }

${KINDS.filter(({ element }) => element !== 'T' && !element.startsWith('U'))
  .map(
    ({ receiver, element }) => `fun Array<out ${element}>.to${receiver}(): ${receiver} = ${receiver}(size) { this[it] }`
  )
  .join('\n')}

external fun <reified T> arrayOf(vararg elements: T): Array<T>
external fun <T> arrayOfNulls(size: Int): Array<T?>

@Suppress("UNCHECKED_CAST")
inline fun <T> Array(size: Int, init: (Int) -> T): Array<T> {
    val array = arrayOfNulls<T>(size)
    for (index in 0 until size) array[index] = init(index)
    return array as Array<T>
}
${KINDS.filter(({ typeParameters }) => typeParameters.length === 0)
  .map(
    ({ receiver, element }) => `inline fun ${receiver}(size: Int, init: (Int) -> ${element}): ${receiver} {
    val array = ${receiver}(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}`
  )
  .join('\n')}
external fun <T> emptyArray(): Array<T>
external fun intArrayOf(vararg elements: Int): IntArray
external fun longArrayOf(vararg elements: Long): LongArray
external fun doubleArrayOf(vararg elements: Double): DoubleArray
external fun floatArrayOf(vararg elements: Float): FloatArray
external fun shortArrayOf(vararg elements: Short): ShortArray
external fun byteArrayOf(vararg elements: Byte): ByteArray
external fun charArrayOf(vararg elements: Char): CharArray
external fun booleanArrayOf(vararg elements: Boolean): BooleanArray
${UNSIGNED_ARRAYS.map(([name, element]) => `external fun ${arrayFactoryName(name)}(vararg elements: ${element}): ${name}`).join('\n')}
`;

/** The prelude's functions of arrays, in package `kotlin.collections`. */
export function arraysSource(): string {
  return `package kotlin.collections\n\n${KINDS.map(functionsOf).join('\n\n')}\n${GENERIC_ARRAY_SOURCE}`;
}

/** The function that makes an array of its arguments, such as `intArrayOf` for `IntArray` and `ubyteArrayOf`. */
export function arrayFactoryName(arrayName: string): string {
  return arrayName.startsWith('U')
    ? `u${arrayName.charAt(1).toLowerCase()}${arrayName.slice(2)}Of`
    : `${arrayName.charAt(0).toLowerCase()}${arrayName.slice(1)}Of`;
}
