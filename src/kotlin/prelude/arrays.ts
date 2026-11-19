/**
 * The functions of arrays, generated for `Array<T>` and each primitive array as Kotlin's standard library generates
 * them. Most go through `asList()`, a list of the array's elements, which keeps their results and messages those of
 * lists where Kotlin's are the same.
 */

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
  { receiver: 'IntArray', typeParameters: '', element: 'Int', sum: 'Int', isComparable: true, zero: '0' },
  { receiver: 'LongArray', typeParameters: '', element: 'Long', sum: 'Long', isComparable: true, zero: '0L' },
  { receiver: 'DoubleArray', typeParameters: '', element: 'Double', sum: 'Double', isComparable: true, zero: '0.0' },
  { receiver: 'FloatArray', typeParameters: '', element: 'Float', sum: 'Float', isComparable: true, zero: '0.0f' },
  { receiver: 'ShortArray', typeParameters: '', element: 'Short', sum: undefined, isComparable: true, zero: '0' },
  { receiver: 'ByteArray', typeParameters: '', element: 'Byte', sum: undefined, isComparable: true, zero: '0' },
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
  { receiver: 'UIntArray', typeParameters: '', element: 'UInt', sum: undefined, isComparable: true, zero: '0u' },
];

/** The generic part of a function's type parameters, such as `<T, R>`, or nothing. */
function generics(kind: ArrayKind, own: string): string {
  const all = `${kind.typeParameters}${own}`.replace(/, $/, '');
  return all ? `<${all}> ` : '';
}

function functionsOf(kind: ArrayKind): string {
  const { receiver: r, element: e } = kind;
  const g = (own = ''): string => generics(kind, own);
  const lines = [
    `external fun ${g()}${r}.asList(): List<${e}>`,
    `external fun ${g()}${r}.contentToString(): String`,
    `external fun ${g()}${r}.copyOf(): ${r.replace('out ', '')}`,
    `external fun ${g()}${r}.copyOfRange(fromIndex: Int, toIndex: Int): ${r.replace('out ', '')}`,
    `external infix fun ${g()}${r}.contentEquals(other: ${r}): Boolean`,
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
    `inline fun ${g()}${r}.findLast(predicate: (${e}) -> Boolean): ${e}? = asList().lastOrNull(predicate)`,
    `fun ${g()}${r}.single(): ${e} = when (size) { 0 -> throw NoSuchElementException("Array is empty."); 1 -> this[0]; else -> throw IllegalArgumentException("Array has more than one element.") }`,
    `fun ${g()}${r}.getOrNull(index: Int): ${e}? = if (index >= 0 && index < size) get(index) else null`,
    `inline fun ${g()}${r}.getOrElse(index: Int, defaultValue: (Int) -> ${e}): ${e} = if (index >= 0 && index < size) get(index) else defaultValue(index)`,
    `fun ${g()}${r}.elementAt(index: Int): ${e} = get(index)`,
    `fun ${g()}${r}.indexOf(element: ${e}): Int = asList().indexOf(element)`,
    `fun ${g()}${r}.lastIndexOf(element: ${e}): Int = asList().lastIndexOf(element)`,
    `inline fun ${g()}${r}.indexOfFirst(predicate: (${e}) -> Boolean): Int = asList().indexOfFirst(predicate)`,
    `inline fun ${g()}${r}.indexOfLast(predicate: (${e}) -> Boolean): Int = asList().indexOfLast(predicate)`,
    `operator fun ${g()}${r}.contains(element: ${e}): Boolean = indexOf(element) >= 0`,
    `inline fun ${g('R')}${r}.fold(initial: R, operation: (acc: R, ${e}) -> R): R = asList().fold(initial, operation)`,
    `inline fun ${g('R')}${r}.foldIndexed(initial: R, operation: (index: Int, acc: R, ${e}) -> R): R = asList().foldIndexed(initial, operation)`,
    `inline fun ${g()}${r}.sumOf(selector: (${e}) -> Int): Int = asList().sumOf(selector)`,
    `@JvmName("sumOfDouble") inline fun ${g()}${r}.sumOf(selector: (${e}) -> Double): Double = asList().sumOf(selector)`,
    `@JvmName("sumOfLong") inline fun ${g()}${r}.sumOf(selector: (${e}) -> Long): Long = asList().sumOf(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.maxBy(selector: (${e}) -> R): ${e} { if (isEmpty()) throw NoSuchElementException(); return asList().maxBy(selector) }`,
    `inline fun ${g('R : Comparable<R>')}${r}.minBy(selector: (${e}) -> R): ${e} { if (isEmpty()) throw NoSuchElementException(); return asList().minBy(selector) }`,
    `inline fun ${g('R : Comparable<R>')}${r}.maxByOrNull(selector: (${e}) -> R): ${e}? = asList().maxByOrNull(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.minByOrNull(selector: (${e}) -> R): ${e}? = asList().minByOrNull(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.maxOf(selector: (${e}) -> R): R = asList().maxOf(selector)`,
    `inline fun ${g('R : Comparable<R>')}${r}.minOf(selector: (${e}) -> R): R = asList().minOf(selector)`,
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
    `fun ${g()}${r}.withIndex(): Iterable<IndexedValue<${e}>> = asList().withIndex()`,
    `inline fun ${g('K')}${r}.groupBy(keySelector: (${e}) -> K): Map<K, List<${e}>> = asList().groupBy(keySelector)`,
    `inline fun ${g('K, V')}${r}.associate(transform: (${e}) -> Pair<K, V>): Map<K, V> = asList().associate(transform)`,
    `inline fun ${g('K')}${r}.associateBy(keySelector: (${e}) -> K): Map<K, ${e}> = asList().associateBy(keySelector)`,
    `inline fun ${g()}${r}.partition(predicate: (${e}) -> Boolean): Pair<List<${e}>, List<${e}>> = asList().partition(predicate)`,
    `infix fun ${g('R')}${r}.zip(other: Iterable<R>): List<Pair<${e}, R>> = asList().zip(other)`,
    `fun ${g()}${r}.joinToString(separator: CharSequence = ", ", prefix: CharSequence = "", postfix: CharSequence = "", limit: Int = -1, truncated: CharSequence = "...", transform: ((${e}) -> CharSequence)? = null): String = asList().joinToString(separator, prefix, postfix, limit, truncated, transform)`,
    `fun ${g()}${r}.random(): ${e} { if (isEmpty()) throw NoSuchElementException("Array is empty."); return get(kotlin.random.Random.nextInt(size)) }`,
    `external fun ${g()}${r}.fill(element: ${e}, fromIndex: Int = 0, toIndex: Int = size)`,
    `external fun ${g()}${r}.reverse()`,
    `fun ${g()}${r}.toTypedArray(): Array<${e}> = asList().toTypedArray()`,
  ];
  if (kind.sum) {
    lines.push(
      `fun ${r}.sum(): ${kind.sum} { var sum: ${kind.sum} = ${kind.zero}; for (element in this) sum += element; return sum }`,
      `fun ${r}.average(): Double { var sum = 0.0; var count = 0; for (element in this) { sum += element; ++count }; return if (count == 0) Double.NaN else sum / count }`
    );
  }
  if (kind.isComparable) {
    lines.push(
      `fun ${r}.max(): ${e} { if (isEmpty()) throw NoSuchElementException(); var max = this[0]; for (i in 1..lastIndex) { val e = this[i]; if (max < e) max = e }; return max }`,
      `fun ${r}.min(): ${e} { if (isEmpty()) throw NoSuchElementException(); var min = this[0]; for (i in 1..lastIndex) { val e = this[i]; if (min > e) min = e }; return min }`,
      `fun ${r}.maxOrNull(): ${e}? = if (isEmpty()) null else max()`,
      `fun ${r}.minOrNull(): ${e}? = if (isEmpty()) null else min()`,
      `external fun ${r}.sort()`,
      `fun ${r}.sortDescending() { if (size > 1) { sort(); reverse() } }`,
      `fun ${r}.sorted(): List<${e}> = asList().sorted()`,
      `fun ${r}.sortedDescending(): List<${e}> = asList().sortedDescending()`
    );
  }
  return lines.join('\n');
}

/** `Array<T>`'s functions that need its elements to be comparable or nullable, and the arrays' factories. */
const GENERIC_ARRAY_SOURCE = `
fun <T : Any> Array<out T?>.filterNotNull(): List<T> = asList().filterNotNull()
fun <T : Comparable<T>> Array<out T>.max(): T = asList().max()
fun <T : Comparable<T>> Array<out T>.min(): T = asList().min()
fun <T : Comparable<T>> Array<out T>.maxOrNull(): T? = asList().maxOrNull()
fun <T : Comparable<T>> Array<out T>.minOrNull(): T? = asList().minOrNull()
fun <T : Comparable<T>> Array<out T>.sorted(): List<T> = asList().sorted()
fun <T : Comparable<T>> Array<out T>.sortedDescending(): List<T> = asList().sortedDescending()
fun <T : Comparable<T>> Array<out T>.sort() = asList().toMutableList().let { list -> list.sort(); list.forEachIndexed { index, element -> (this as Array<T>)[index] = element } }
fun <T> Array<out T>.sortWith(comparator: Comparator<in T>) = asList().toMutableList().let { list -> list.sortWith(comparator); list.forEachIndexed { index, element -> (this as Array<T>)[index] = element } }
inline fun <T, R : Comparable<R>> Array<out T>.sortBy(crossinline selector: (T) -> R?) = sortWith(compareBy(selector))
fun Array<out Int>.sum(): Int = asList().sum()
fun Array<out Double>.sum(): Double = asList().sum()
operator fun <T> Array<T>.plus(element: T): Array<T> = (asList() + element).toTypedArray()

external fun <T> arrayOf(vararg elements: T): Array<T>
external fun <T> arrayOfNulls(size: Int): Array<T?>

@Suppress("UNCHECKED_CAST")
inline fun <T> Array(size: Int, init: (Int) -> T): Array<T> {
    val array = arrayOfNulls<T>(size)
    for (index in 0 until size) array[index] = init(index)
    return array as Array<T>
}
inline fun IntArray(size: Int, init: (Int) -> Int): IntArray {
    val array = IntArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun LongArray(size: Int, init: (Int) -> Long): LongArray {
    val array = LongArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun DoubleArray(size: Int, init: (Int) -> Double): DoubleArray {
    val array = DoubleArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun FloatArray(size: Int, init: (Int) -> Float): FloatArray {
    val array = FloatArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun ShortArray(size: Int, init: (Int) -> Short): ShortArray {
    val array = ShortArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun ByteArray(size: Int, init: (Int) -> Byte): ByteArray {
    val array = ByteArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun CharArray(size: Int, init: (Int) -> Char): CharArray {
    val array = CharArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun BooleanArray(size: Int, init: (Int) -> Boolean): BooleanArray {
    val array = BooleanArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
inline fun UIntArray(size: Int, init: (Int) -> UInt): UIntArray {
    val array = UIntArray(size)
    for (index in 0 until size) array[index] = init(index)
    return array
}
external fun <T> emptyArray(): Array<T>
external fun intArrayOf(vararg elements: Int): IntArray
external fun longArrayOf(vararg elements: Long): LongArray
external fun doubleArrayOf(vararg elements: Double): DoubleArray
external fun floatArrayOf(vararg elements: Float): FloatArray
external fun shortArrayOf(vararg elements: Short): ShortArray
external fun byteArrayOf(vararg elements: Byte): ByteArray
external fun charArrayOf(vararg elements: Char): CharArray
external fun booleanArrayOf(vararg elements: Boolean): BooleanArray
external fun uintArrayOf(vararg elements: UInt): UIntArray
`;

/** The prelude's functions of arrays, in package `kotlin.collections`. */
export function arraysSource(): string {
  return `package kotlin.collections\n\n${KINDS.map(functionsOf).join('\n\n')}\n${GENERIC_ARRAY_SOURCE}`;
}
