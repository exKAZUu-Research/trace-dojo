import { kotlin } from './source';

/**
 * `java.util.TreeMap` and `TreeSet`, internal as programs may not name Java's classes, which Kotlin's `sortedMapOf`
 * and `sortedSetOf` create: a map or set whose iteration follows its keys' order. A TreeMap keeps its entries in a list
 * sorted by its order, where one binary search finds keys by comparing them, as the JVM's tree finds them by comparing,
 * though with other stored keys than the tree's path visits; a TreeSet is the keys of a TreeMap, as the JVM's is.
 */
export const SORTED_COLLECTIONS_SOURCE = kotlin`
package java.util

internal interface SortedMap<K, V> : MutableMap<K, V> {
    fun comparator(): Comparator<in K>?
    fun firstKey(): K
    fun lastKey(): K
    fun headMap(toKey: K): SortedMap<K, V>
    fun tailMap(fromKey: K): SortedMap<K, V>
    fun subMap(fromKey: K, toKey: K): SortedMap<K, V>
}

internal interface SortedSet<E> : MutableSet<E> {
    fun comparator(): Comparator<in E>?
    fun first(): E
    fun last(): E
    fun headSet(toElement: E): SortedSet<E>
    fun tailSet(fromElement: E): SortedSet<E>
    fun subSet(fromElement: E, toElement: E): SortedSet<E>
}

internal interface NavigableSet<E> : SortedSet<E> {
    fun lower(e: E): E?
    fun floor(e: E): E?
    fun ceiling(e: E): E?
    fun higher(e: E): E?
    fun pollFirst(): E?
    fun pollLast(): E?
    fun descendingSet(): NavigableSet<E>
    fun descendingIterator(): MutableIterator<E>
    fun headSet(toElement: E, inclusive: Boolean): NavigableSet<E>
    fun tailSet(fromElement: E, inclusive: Boolean): NavigableSet<E>
    fun subSet(fromElement: E, fromInclusive: Boolean, toElement: E, toInclusive: Boolean): NavigableSet<E>
}

@Suppress("UNCHECKED_CAST")
internal fun <T> compareInOrder(comparator: Comparator<in T>?, a: T, b: T): Int =
    if (comparator != null) comparator.compare(a, b) else (a as Comparable<Any?>).compareTo(b)

/** A bound of a sorted map's view: the key it starts or ends at, and whether the key itself is in the view. */
internal class OrderBound<K>(val key: K, val inclusive: Boolean)

/** The entries of a TreeMap and of every view of it, in its order, with the count of changes iterators fail fast on. */
internal class TreeStore<K, V> {
    val nodes = ArrayList<TreeMapEntry<K, V>>()
    var modCount = 0
}

/**
 * A TreeMap, or a view of one between two bounds, as headMap, tailMap, and subMap give, which reads and writes the
 * entries of the map it views, as java.util.TreeMap's views do.
 */
internal class TreeMap<K, V> private constructor(
    private val order: Comparator<in K>?,
    private val store: TreeStore<K, V>,
    private val low: OrderBound<K>?,
    private val high: OrderBound<K>?
) : AbstractMap<K, V>(), SortedMap<K, V> {
    constructor() : this(null, TreeStore(), null, null)
    constructor(comparator: Comparator<in K>?) : this(comparator, TreeStore(), null, null)
    constructor(map: Map<out K, V>) : this(null, TreeStore(), null, null) {
        putAll(map)
    }

    internal val modCount: Int get() = store.modCount
    private val nodes: ArrayList<TreeMapEntry<K, V>> get() = store.nodes

    override fun comparator(): Comparator<in K>? = order

    /**
     * The index among all the entries of the entry whose key the order counts as \`key\`, or -(the index it would go at
     * + 1): the one search of the map, as java.util.TreeMap finds keys by comparing them, never by equals or hashCode.
     */
    internal fun search(key: K): Int {
        var low = 0
        var high = nodes.size - 1
        while (low <= high) {
            val middle = (low + high) ushr 1
            // The key sought comes first, as java.util.TreeMap passes it to the comparator.
            val comparison = compareInOrder(order, key, nodes[middle].key)
            if (comparison > 0) low = middle + 1 else if (comparison < 0) high = middle - 1 else return middle
        }
        return -(low + 1)
    }

    private fun insertion(found: Int): Int = if (found >= 0) found else -(found + 1)

    // The view's entries are those from lowIndex() up to before highIndex(), among all the entries.
    internal fun lowIndex(): Int {
        val bound = low ?: return 0
        val found = search(bound.key)
        return if (found >= 0 && !bound.inclusive) found + 1 else insertion(found)
    }

    internal fun highIndex(): Int {
        val bound = high ?: return nodes.size
        val found = search(bound.key)
        return if (found >= 0 && bound.inclusive) found + 1 else insertion(found)
    }

    private fun tooLow(key: K): Boolean {
        val bound = low ?: return false
        val comparison = compareInOrder(order, key, bound.key)
        return comparison < 0 || (comparison == 0 && !bound.inclusive)
    }

    private fun tooHigh(key: K): Boolean {
        val bound = high ?: return false
        val comparison = compareInOrder(order, key, bound.key)
        return comparison > 0 || (comparison == 0 && !bound.inclusive)
    }

    internal fun inRange(key: K): Boolean = !tooLow(key) && !tooHigh(key)

    internal fun nodeAt(index: Int): TreeMapEntry<K, V> = nodes[index]

    internal fun removeNodeAt(index: Int): TreeMapEntry<K, V> {
        store.modCount++
        return nodes.removeAt(index)
    }

    private fun find(key: K): Int {
        if (order == null && key == null) throw NullPointerException()
        return if (inRange(key)) search(key) else -1
    }

    override val size: Int get() = highIndex() - lowIndex()
    override fun containsKey(key: K): Boolean = find(key) >= 0
    override fun get(key: K): V? = find(key).let { if (it >= 0) nodes[it].value else null }

    override fun put(key: K, value: V): V? {
        if (nodes.isEmpty()) compareInOrder(order, key, key)
        if (!inRange(key)) throw IllegalArgumentException("key out of range")
        val index = search(key)
        if (index >= 0) return nodes[index].setValue(value)
        nodes.add(-(index + 1), TreeMapEntry(key, value))
        store.modCount++
        return null
    }

    override fun remove(key: K): V? = find(key).let { if (it >= 0) removeNodeAt(it).value else null }

    override fun clear() {
        val from = lowIndex()
        repeat(highIndex() - from) { nodes.removeAt(from) }
        store.modCount++
    }

    override val keys: MutableSet<K> get() = TreeMapKeys(this)
    override val values: MutableCollection<V> get() = TreeMapValues(this)
    override val entries: MutableSet<MutableMap.MutableEntry<K, V>> get() = TreeMapEntries(this)

    override fun firstKey(): K = lowIndex().let { if (it < highIndex()) nodes[it].key else throw NoSuchElementException() }
    override fun lastKey(): K = (highIndex() - 1).let { if (it >= lowIndex()) nodes[it].key else throw NoSuchElementException() }

    // The keys around a key within the view, which a TreeSet's navigation reads.
    internal fun keyAt(index: Int): List<K> = if (index >= lowIndex() && index < highIndex()) listOf(nodes[index].key) else listOf()
    internal fun ceilingKey(key: K): List<K> = keyAt(maxOf(insertion(search(key)), lowIndex()))
    internal fun higherKey(key: K): List<K> =
        keyAt(maxOf(search(key).let { if (it >= 0) it + 1 else insertion(it) }, lowIndex()))
    internal fun floorKey(key: K): List<K> =
        keyAt(minOf(search(key).let { if (it >= 0) it else insertion(it) - 1 }, highIndex() - 1))
    internal fun lowerKey(key: K): List<K> =
        keyAt(minOf(search(key).let { if (it >= 0) it - 1 else insertion(it) - 1 }, highIndex() - 1))

    override fun headMap(toKey: K): SortedMap<K, V> = view(low, narrowed(toKey, false))
    override fun tailMap(fromKey: K): SortedMap<K, V> = view(narrowed(fromKey, true), high)
    override fun subMap(fromKey: K, toKey: K): SortedMap<K, V> = subView(fromKey, true, toKey, false)

    internal fun headView(toKey: K, inclusive: Boolean): TreeMap<K, V> = view(low, narrowed(toKey, inclusive))
    internal fun tailView(fromKey: K, inclusive: Boolean): TreeMap<K, V> = view(narrowed(fromKey, inclusive), high)
    internal fun subView(fromKey: K, fromInclusive: Boolean, toKey: K, toInclusive: Boolean): TreeMap<K, V> {
        if (compareInOrder(order, fromKey, toKey) > 0) throw IllegalArgumentException("fromKey > toKey")
        return view(narrowed(fromKey, fromInclusive), narrowed(toKey, toInclusive))
    }

    // A view's bound must lie within the view it narrows, as java.util.TreeMap's views require.
    private fun narrowed(key: K, inclusive: Boolean): OrderBound<K> {
        compareInOrder(order, key, key)
        val within = if (inclusive) inRange(key) else !(low?.let { compareInOrder(order, key, it.key) < 0 } ?: false) &&
            !(high?.let { compareInOrder(order, key, it.key) > 0 } ?: false)
        if (!within) throw IllegalArgumentException("key out of range")
        return OrderBound(key, inclusive)
    }

    private fun view(from: OrderBound<K>?, to: OrderBound<K>?): TreeMap<K, V> = TreeMap(order, store, from, to)
}

/** java.util.AbstractMap's members, which read the map through its entries. */
internal abstract class AbstractMap<K, V> : MutableMap<K, V> {
    override fun isEmpty(): Boolean = size == 0
    override fun containsValue(value: V): Boolean = entries.any { it.value == value }

    override fun putAll(from: Map<out K, V>) {
        for ((key, value) in from) put(key, value)
    }

    @Suppress("UNCHECKED_CAST")
    override fun equals(other: Any?): Boolean {
        if (other === this) return true
        if (other !is Map<*, *> || other.size != size) return false
        val map = other as Map<Any?, Any?>
        for (entry in entries) {
            val value = entry.value
            if (value == null) {
                if (!(map[entry.key] == null && map.containsKey(entry.key))) return false
            } else if (value != map[entry.key]) {
                return false
            }
        }
        return true
    }

    override fun hashCode(): Int {
        var hash = 0
        for (entry in entries) hash += entry.hashCode()
        return hash
    }

    override fun toString(): String = entries.joinToString(", ", "{", "}")
}

internal class TreeMapEntry<K, V>(override val key: K, override var value: V) : MutableMap.MutableEntry<K, V> {
    override fun setValue(newValue: V): V {
        val old = value
        value = newValue
        return old
    }

    override fun equals(other: Any?): Boolean = other is Map.Entry<*, *> && key == other.key && value == other.value
    override fun hashCode(): Int = (key?.hashCode() ?: 0) xor (value?.hashCode() ?: 0)
    override fun toString(): String = "$key=$value"
}

/**
 * An iterator over a TreeMap's entries in its view, in order or in reverse, which removes through the map, and fails
 * fast on other changes.
 */
internal class TreeMapIterator<K, V, T>(
    private val map: TreeMap<K, V>,
    private val isDescending: Boolean,
    private val select: (TreeMapEntry<K, V>) -> T
) : MutableIterator<T> {
    private var next = if (isDescending) map.highIndex() - 1 else map.lowIndex()
    private var last = -1
    private var expected = map.modCount
    // Whether an entry followed the last one returned, as java.util.TreeMap's iterator holds the next entry: changes
    // after that step do not change the answer, and the next step then fails fast.
    private var hadNext = inView()

    private fun inView(): Boolean = if (isDescending) next >= map.lowIndex() else next < map.highIndex()

    override fun hasNext(): Boolean = if (map.modCount == expected) inView() else hadNext

    override fun next(): T {
        if (map.modCount != expected) throw ConcurrentModificationException()
        if (!inView()) throw NoSuchElementException()
        last = next
        next = if (isDescending) next - 1 else next + 1
        hadNext = inView()
        return select(map.nodeAt(last))
    }

    override fun remove() {
        if (last < 0) throw IllegalStateException()
        if (map.modCount != expected) throw ConcurrentModificationException()
        map.removeNodeAt(last)
        if (!isDescending) next = last
        last = -1
        expected = map.modCount
        hadNext = inView()
    }
}

/** java.util.AbstractSet's members, which find elements through the set's own contains and remove. */
internal abstract class AbstractSet<E> : MutableSet<E> {
    override fun isEmpty(): Boolean = size == 0
    override fun containsAll(elements: Collection<E>): Boolean = elements.all { contains(it) }

    override fun addAll(elements: Collection<E>): Boolean {
        var changed = false
        for (element in elements) if (add(element)) changed = true
        return changed
    }

    override fun removeAll(elements: Collection<E>): Boolean {
        var modified = false
        if (size > elements.size) {
            for (element in elements) if (remove(element)) modified = true
        } else {
            val iterator = iterator()
            while (iterator.hasNext()) {
                if (elements.contains(iterator.next())) {
                    iterator.remove()
                    modified = true
                }
            }
        }
        return modified
    }

    override fun retainAll(elements: Collection<E>): Boolean {
        var modified = false
        val iterator = iterator()
        while (iterator.hasNext()) {
            if (!elements.contains(iterator.next())) {
                iterator.remove()
                modified = true
            }
        }
        return modified
    }

    @Suppress("UNCHECKED_CAST")
    override fun equals(other: Any?): Boolean {
        if (other === this) return true
        if (other !is Set<*> || other.size != size) return false
        return try {
            containsAll(other as Collection<E>)
        } catch (e: ClassCastException) {
            false
        } catch (e: NullPointerException) {
            false
        }
    }

    override fun hashCode(): Int {
        var hash = 0
        for (element in this) hash += element?.hashCode() ?: 0
        return hash
    }

    override fun toString(): String = joinToString(", ", "[", "]")
}

private class TreeMapKeys<K, V>(private val map: TreeMap<K, V>) : AbstractSet<K>() {
    override val size: Int get() = map.size
    override fun contains(element: K): Boolean = map.containsKey(element)
    override fun iterator(): MutableIterator<K> = TreeMapIterator(map, false) { it.key }
    override fun add(element: K): Boolean = throw UnsupportedOperationException()

    override fun remove(element: K): Boolean {
        val before = map.size
        map.remove(element)
        return map.size != before
    }

    override fun clear() = map.clear()
}

private class TreeMapEntries<K, V>(private val map: TreeMap<K, V>) : AbstractSet<MutableMap.MutableEntry<K, V>>() {
    override val size: Int get() = map.size
    override fun iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> = TreeMapIterator(map, false) { it }
    override fun add(element: MutableMap.MutableEntry<K, V>): Boolean = throw UnsupportedOperationException()

    override fun contains(element: MutableMap.MutableEntry<K, V>): Boolean {
        val index = if (map.inRange(element.key)) map.search(element.key) else -1
        return index >= 0 && map.nodeAt(index).value == element.value
    }

    override fun remove(element: MutableMap.MutableEntry<K, V>): Boolean {
        val index = if (map.inRange(element.key)) map.search(element.key) else -1
        if (index < 0 || map.nodeAt(index).value != element.value) return false
        map.removeNodeAt(index)
        return true
    }

    override fun clear() = map.clear()
}

private class TreeMapValues<K, V>(private val map: TreeMap<K, V>) : MutableCollection<V> {
    override val size: Int get() = map.size
    override fun isEmpty(): Boolean = map.isEmpty()
    override fun contains(element: V): Boolean = map.containsValue(element)
    override fun containsAll(elements: Collection<V>): Boolean = elements.all { contains(it) }
    override fun iterator(): MutableIterator<V> = TreeMapIterator(map, false) { it.value }
    override fun add(element: V): Boolean = throw UnsupportedOperationException()
    override fun addAll(elements: Collection<V>): Boolean = throw UnsupportedOperationException()

    override fun remove(element: V): Boolean {
        val iterator = iterator()
        while (iterator.hasNext()) {
            if (iterator.next() == element) {
                iterator.remove()
                return true
            }
        }
        return false
    }

    override fun removeAll(elements: Collection<V>): Boolean = removeWhere { it in elements }
    override fun retainAll(elements: Collection<V>): Boolean = removeWhere { it !in elements }
    override fun clear() = map.clear()
    override fun toString(): String = joinToString(", ", "[", "]")

    private fun removeWhere(predicate: (V) -> Boolean): Boolean {
        var modified = false
        val iterator = iterator()
        while (iterator.hasNext()) {
            if (predicate(iterator.next())) {
                iterator.remove()
                modified = true
            }
        }
        return modified
    }
}

/**
 * A TreeSet, or a view of one, as headSet, tailSet, subSet, and descendingSet give: the keys of a TreeMap or of a
 * view of it, in its order or in reverse, so that every view reads and writes the elements of the set it views.
 */
internal class TreeSet<E> private constructor(
    private val map: TreeMap<E, Boolean>,
    private val isDescending: Boolean
) : AbstractSet<E>(), NavigableSet<E> {
    constructor() : this(TreeMap<E, Boolean>(), false)
    constructor(comparator: Comparator<in E>?) : this(TreeMap<E, Boolean>(comparator), false)
    constructor(elements: Collection<E>) : this(TreeMap<E, Boolean>(), false) {
        addAll(elements)
    }

    override fun comparator(): Comparator<in E>? {
        val order = map.comparator()
        return if (isDescending) Comparator<E> { a, b -> compareInOrder(order, b, a) } else order
    }

    override val size: Int get() = map.size
    override fun contains(element: E): Boolean = map.containsKey(element)
    override fun add(element: E): Boolean = map.put(element, true) == null
    override fun remove(element: E): Boolean = map.remove(element) != null
    override fun iterator(): MutableIterator<E> = TreeMapIterator(map, isDescending) { it.key }
    override fun descendingIterator(): MutableIterator<E> = TreeMapIterator(map, !isDescending) { it.key }
    override fun clear() = map.clear()

    override fun first(): E = if (isDescending) map.lastKey() else map.firstKey()
    override fun last(): E = if (isDescending) map.firstKey() else map.lastKey()

    // In reverse, what is lower is higher in the map's order.
    @Suppress("UNCHECKED_CAST")
    private fun one(found: List<E>): E? = if (found.isEmpty()) null else found[0]
    override fun lower(e: E): E? = one(if (isDescending) map.higherKey(e) else map.lowerKey(e))
    override fun floor(e: E): E? = one(if (isDescending) map.ceilingKey(e) else map.floorKey(e))
    override fun ceiling(e: E): E? = one(if (isDescending) map.floorKey(e) else map.ceilingKey(e))
    override fun higher(e: E): E? = one(if (isDescending) map.lowerKey(e) else map.higherKey(e))

    override fun pollFirst(): E? = poll(isDescending)
    override fun pollLast(): E? = poll(!isDescending)

    private fun poll(fromHigh: Boolean): E? {
        if (map.isEmpty()) return null
        return map.removeNodeAt(if (fromHigh) map.highIndex() - 1 else map.lowIndex()).key
    }

    override fun headSet(toElement: E): SortedSet<E> = headSet(toElement, false)
    override fun tailSet(fromElement: E): SortedSet<E> = tailSet(fromElement, true)
    override fun subSet(fromElement: E, toElement: E): SortedSet<E> = subSet(fromElement, true, toElement, false)

    override fun headSet(toElement: E, inclusive: Boolean): NavigableSet<E> =
        TreeSet(if (isDescending) map.tailView(toElement, inclusive) else map.headView(toElement, inclusive), isDescending)

    override fun tailSet(fromElement: E, inclusive: Boolean): NavigableSet<E> =
        TreeSet(if (isDescending) map.headView(fromElement, inclusive) else map.tailView(fromElement, inclusive), isDescending)

    override fun subSet(fromElement: E, fromInclusive: Boolean, toElement: E, toInclusive: Boolean): NavigableSet<E> {
        val view =
            if (isDescending) map.subView(toElement, toInclusive, fromElement, fromInclusive)
            else map.subView(fromElement, fromInclusive, toElement, toInclusive)
        return TreeSet(view, isDescending)
    }

    override fun descendingSet(): NavigableSet<E> = TreeSet(map, !isDescending)
}
`;

/** The functions of `kotlin.collections` that create sorted maps and sets. */
export const SORTED_COLLECTION_FUNCTIONS_SOURCE = kotlin`
package kotlin.collections

import java.util.SortedMap
import java.util.SortedSet
import java.util.TreeMap
import java.util.TreeSet

fun <K : Comparable<K>, V> Map<out K, V>.toSortedMap(): SortedMap<K, V> = TreeMap<K, V>(this)

fun <K, V> Map<out K, V>.toSortedMap(comparator: Comparator<in K>): SortedMap<K, V> {
    val map = TreeMap<K, V>(comparator)
    map.putAll(this)
    return map
}

fun <K : Comparable<K>, V> sortedMapOf(vararg pairs: Pair<K, V>): SortedMap<K, V> {
    val map = TreeMap<K, V>()
    for ((key, value) in pairs) map.put(key, value)
    return map
}

fun <K, V> sortedMapOf(comparator: Comparator<in K>, vararg pairs: Pair<K, V>): SortedMap<K, V> {
    val map = TreeMap<K, V>(comparator)
    for ((key, value) in pairs) map.put(key, value)
    return map
}

fun <T : Comparable<T>> sortedSetOf(vararg elements: T): TreeSet<T> {
    val set = TreeSet<T>()
    for (element in elements) set.add(element)
    return set
}

fun <T> sortedSetOf(comparator: Comparator<in T>, vararg elements: T): TreeSet<T> {
    val set = TreeSet<T>(comparator)
    for (element in elements) set.add(element)
    return set
}

fun <T : Comparable<T>> Iterable<T>.toSortedSet(): SortedSet<T> {
    val set = TreeSet<T>()
    for (element in this) set.add(element)
    return set
}

fun <T> Iterable<T>.toSortedSet(comparator: Comparator<in T>): SortedSet<T> {
    val set = TreeSet<T>(comparator)
    for (element in this) set.add(element)
    return set
}

fun <T : Comparable<T>> Array<out T>.toSortedSet(): SortedSet<T> = asList().toSortedSet()
`;
