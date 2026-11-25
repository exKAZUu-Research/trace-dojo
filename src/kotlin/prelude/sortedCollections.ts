import { kotlin } from './source';

/**
 * `java.util.TreeMap` and `TreeSet`, which Kotlin's `sortedMapOf` and `sortedSetOf` create: a map or set whose
 * iteration follows its keys' order. A TreeMap keeps its entries in a list sorted by its order, where one binary search
 * finds keys by comparing them, as the JVM's tree does; a TreeSet is the keys of a TreeMap, as the JVM's is.
 */
export const SORTED_COLLECTIONS_SOURCE = kotlin`
package java.util

interface SortedMap<K, V> : MutableMap<K, V> {
    fun comparator(): Comparator<in K>?
    fun firstKey(): K
    fun lastKey(): K
    fun headMap(toKey: K): SortedMap<K, V>
    fun tailMap(fromKey: K): SortedMap<K, V>
    fun subMap(fromKey: K, toKey: K): SortedMap<K, V>
}

interface SortedSet<E> : MutableSet<E> {
    fun comparator(): Comparator<in E>?
    fun first(): E
    fun last(): E
    fun headSet(toElement: E): SortedSet<E>
    fun tailSet(fromElement: E): SortedSet<E>
    fun subSet(fromElement: E, toElement: E): SortedSet<E>
}

interface NavigableSet<E> : SortedSet<E> {
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

class TreeMap<K, V> private constructor(
    private val order: Comparator<in K>?,
    private val nodes: ArrayList<TreeMapEntry<K, V>>
) : SortedMap<K, V> {
    constructor() : this(null, ArrayList())
    constructor(comparator: Comparator<in K>?) : this(comparator, ArrayList())
    constructor(map: Map<out K, V>) : this(null, ArrayList()) {
        putAll(map)
    }

    /** The count of changes to the keys, by which iterators fail fast as java.util.TreeMap's do. */
    internal var modCount = 0
        private set

    override fun comparator(): Comparator<in K>? = order
    override val size: Int get() = nodes.size
    override fun isEmpty(): Boolean = nodes.isEmpty()

    /**
     * The index of the entry whose key the order counts as \`key\`, or -(the index it would go at + 1): the one search
     * of the map, as java.util.TreeMap finds keys by comparing them, never by equals or hashCode.
     */
    internal fun search(key: K): Int {
        var low = 0
        var high = nodes.size - 1
        while (low <= high) {
            val middle = (low + high) ushr 1
            val comparison = compareInOrder(order, nodes[middle].key, key)
            if (comparison < 0) low = middle + 1 else if (comparison > 0) high = middle - 1 else return middle
        }
        return -(low + 1)
    }

    internal fun nodeAt(index: Int): TreeMapEntry<K, V> = nodes[index]

    internal fun removeNodeAt(index: Int): TreeMapEntry<K, V> {
        modCount++
        return nodes.removeAt(index)
    }

    private fun find(key: K): Int {
        if (order == null && key == null) throw NullPointerException()
        return search(key)
    }

    override fun containsKey(key: K): Boolean = find(key) >= 0
    override fun containsValue(value: V): Boolean = nodes.any { it.value == value }
    override fun get(key: K): V? = find(key).let { if (it >= 0) nodes[it].value else null }

    override fun put(key: K, value: V): V? {
        if (nodes.isEmpty()) compareInOrder(order, key, key)
        val index = search(key)
        if (index >= 0) return nodes[index].setValue(value)
        nodes.add(-(index + 1), TreeMapEntry(key, value))
        modCount++
        return null
    }

    override fun putAll(from: Map<out K, V>) {
        for ((key, value) in from) put(key, value)
    }

    override fun remove(key: K): V? = find(key).let { if (it >= 0) removeNodeAt(it).value else null }

    override fun clear() {
        nodes.clear()
        modCount++
    }

    override val keys: MutableSet<K> get() = TreeMapKeys(this)
    override val values: MutableCollection<V> get() = TreeMapValues(this)
    override val entries: MutableSet<MutableMap.MutableEntry<K, V>> get() = TreeMapEntries(this)

    override fun firstKey(): K = if (nodes.isEmpty()) throw NoSuchElementException() else nodes[0].key
    override fun lastKey(): K = if (nodes.isEmpty()) throw NoSuchElementException() else nodes[nodes.size - 1].key
    override fun headMap(toKey: K): SortedMap<K, V> = filtered { compareInOrder(order, it, toKey) < 0 }
    override fun tailMap(fromKey: K): SortedMap<K, V> = filtered { compareInOrder(order, it, fromKey) >= 0 }
    override fun subMap(fromKey: K, toKey: K): SortedMap<K, V> =
        filtered { compareInOrder(order, it, fromKey) >= 0 && compareInOrder(order, it, toKey) < 0 }

    private fun filtered(predicate: (K) -> Boolean): SortedMap<K, V> {
        val result = TreeMap<K, V>(order)
        for (node in nodes) if (predicate(node.key)) result.put(node.key, node.value)
        return result
    }

    // java.util.AbstractMap's equals, hashCode, and toString.
    @Suppress("UNCHECKED_CAST")
    override fun equals(other: Any?): Boolean {
        if (other === this) return true
        if (other !is Map<*, *> || other.size != size) return false
        val map = other as Map<Any?, Any?>
        for (node in nodes) {
            val value = node.value
            if (value == null) {
                if (!(map[node.key] == null && map.containsKey(node.key))) return false
            } else if (value != map[node.key]) {
                return false
            }
        }
        return true
    }

    override fun hashCode(): Int {
        var hash = 0
        for (node in nodes) hash += node.hashCode()
        return hash
    }

    override fun toString(): String = nodes.joinToString(", ", "{", "}")
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

/** An iterator over a TreeMap's entries in order, which removes through the map, and fails fast on other changes. */
internal class TreeMapIterator<K, V, T>(
    private val map: TreeMap<K, V>,
    private val select: (TreeMapEntry<K, V>) -> T
) : MutableIterator<T> {
    private var next = 0
    private var last = -1
    private var expected = map.modCount

    override fun hasNext(): Boolean = next < map.size

    override fun next(): T {
        if (map.modCount != expected) throw ConcurrentModificationException()
        if (next >= map.size) throw NoSuchElementException()
        last = next
        return select(map.nodeAt(next++))
    }

    override fun remove() {
        if (last < 0) throw IllegalStateException()
        if (map.modCount != expected) throw ConcurrentModificationException()
        map.removeNodeAt(last)
        next = last
        last = -1
        expected = map.modCount
    }
}

/** java.util.AbstractSet's members, which find elements through the set's own contains and remove. */
abstract class AbstractSet<E> : MutableSet<E> {
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
    override fun iterator(): MutableIterator<K> = TreeMapIterator(map) { it.key }
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
    override fun iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> = TreeMapIterator(map) { it }
    override fun add(element: MutableMap.MutableEntry<K, V>): Boolean = throw UnsupportedOperationException()

    override fun contains(element: MutableMap.MutableEntry<K, V>): Boolean {
        val index = map.search(element.key)
        return index >= 0 && map.nodeAt(index).value == element.value
    }

    override fun remove(element: MutableMap.MutableEntry<K, V>): Boolean {
        val index = map.search(element.key)
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
    override fun iterator(): MutableIterator<V> = TreeMapIterator(map) { it.value }
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

class TreeSet<E> private constructor(private val map: TreeMap<E, Boolean>) : AbstractSet<E>(), NavigableSet<E> {
    constructor() : this(TreeMap<E, Boolean>())
    constructor(comparator: Comparator<in E>?) : this(TreeMap<E, Boolean>(comparator))
    constructor(elements: Collection<E>) : this(TreeMap<E, Boolean>()) {
        addAll(elements)
    }

    override fun comparator(): Comparator<in E>? = map.comparator()
    override val size: Int get() = map.size
    override fun contains(element: E): Boolean = map.containsKey(element)
    override fun add(element: E): Boolean = map.put(element, true) == null
    override fun remove(element: E): Boolean = map.remove(element) != null
    override fun iterator(): MutableIterator<E> = map.keys.iterator()
    override fun clear() = map.clear()

    override fun first(): E = map.firstKey()
    override fun last(): E = map.lastKey()
    override fun headSet(toElement: E): SortedSet<E> = headSet(toElement, false)
    override fun tailSet(fromElement: E): SortedSet<E> = tailSet(fromElement, true)
    override fun subSet(fromElement: E, toElement: E): SortedSet<E> = subSet(fromElement, true, toElement, false)
    override fun headSet(toElement: E, inclusive: Boolean): NavigableSet<E> =
        filtered { below(it, toElement, inclusive) }
    override fun tailSet(fromElement: E, inclusive: Boolean): NavigableSet<E> =
        filtered { below(fromElement, it, inclusive) }
    override fun subSet(fromElement: E, fromInclusive: Boolean, toElement: E, toInclusive: Boolean): NavigableSet<E> {
        if (compareInOrder(comparator(), fromElement, toElement) > 0) throw IllegalArgumentException("fromKey > toKey")
        return filtered { below(fromElement, it, fromInclusive) && below(it, toElement, toInclusive) }
    }

    // The neighbors of a value, from where the map's one search finds it or would put it.
    private fun keyAt(index: Int): E? = if (index in 0 until map.size) map.nodeAt(index).key else null
    private fun insertion(found: Int): Int = if (found >= 0) found else -(found + 1)

    override fun lower(e: E): E? = map.search(e).let { keyAt(if (it >= 0) it - 1 else insertion(it) - 1) }
    override fun floor(e: E): E? = map.search(e).let { keyAt(if (it >= 0) it else insertion(it) - 1) }
    override fun ceiling(e: E): E? = keyAt(insertion(map.search(e)))
    override fun higher(e: E): E? = map.search(e).let { keyAt(if (it >= 0) it + 1 else insertion(it)) }
    override fun pollFirst(): E? = if (map.isEmpty()) null else map.removeNodeAt(0).key
    override fun pollLast(): E? = if (map.isEmpty()) null else map.removeNodeAt(map.size - 1).key

    override fun descendingSet(): NavigableSet<E> {
        val order = comparator()
        val result = TreeSet<E>(Comparator<E> { a, b -> compareInOrder(order, b, a) })
        result.addAll(this)
        return result
    }

    override fun descendingIterator(): MutableIterator<E> {
        val set = this
        val elements = toList().asReversed().iterator()
        return object : MutableIterator<E> {
            private var current: E? = null
            private var hasCurrent = false
            override fun hasNext(): Boolean = elements.hasNext()
            override fun next(): E {
                val element = elements.next()
                current = element
                hasCurrent = true
                return element
            }
            @Suppress("UNCHECKED_CAST")
            override fun remove() {
                if (!hasCurrent) throw IllegalStateException()
                set.remove(current as E)
                hasCurrent = false
            }
        }
    }

    private fun below(a: E, b: E, inclusive: Boolean): Boolean {
        val comparison = compareInOrder(comparator(), a, b)
        return if (inclusive) comparison <= 0 else comparison < 0
    }

    private fun filtered(predicate: (E) -> Boolean): TreeSet<E> {
        val result = TreeSet<E>(comparator())
        for (element in this) if (predicate(element)) result.add(element)
        return result
    }
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
