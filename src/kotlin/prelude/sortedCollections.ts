import { kotlin } from './source';

/**
 * `java.util.TreeMap` and `TreeSet`, which Kotlin's `sortedMapOf` and `sortedSetOf` create: a map or set whose
 * iteration follows its keys' order. Each keeps its entries in an insertion-ordered table, which it re-sorts when a key
 * is added, so that its views and iterators follow the order as the JVM's do.
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

@Suppress("UNCHECKED_CAST")
internal fun <T> compareInOrder(comparator: Comparator<in T>?, a: T, b: T): Int =
    if (comparator != null) comparator.compare(a, b) else (a as Comparable<Any?>).compareTo(b)

class TreeMap<K, V> private constructor(
    private val order: Comparator<in K>?,
    private val table: LinkedHashMap<K, V>
) : SortedMap<K, V>, MutableMap<K, V> by table {
    constructor() : this(null, LinkedHashMap())
    constructor(comparator: Comparator<in K>?) : this(comparator, LinkedHashMap())
    constructor(map: Map<out K, V>) : this(null, LinkedHashMap()) {
        putAll(map)
    }

    override fun comparator(): Comparator<in K>? = order

    override fun put(key: K, value: V): V? {
        if (table.containsKey(key)) return table.put(key, value)
        compareInOrder(order, key, key)
        table.put(key, value)
        resort()
        return null
    }

    override fun putAll(from: Map<out K, V>) {
        for ((key, value) in from) put(key, value)
    }

    override fun get(key: K): V? = table[key]

    private fun resort() {
        val entries = table.entries.map { it.key to it.value }.sortedWith { a, b -> compareInOrder(order, a.first, b.first) }
        table.clear()
        for ((key, value) in entries) table.put(key, value)
    }

    override fun firstKey(): K = if (table.isEmpty()) throw NoSuchElementException() else table.keys.first()
    override fun lastKey(): K = if (table.isEmpty()) throw NoSuchElementException() else table.keys.last()
    override fun headMap(toKey: K): SortedMap<K, V> = filtered { compareInOrder(order, it, toKey) < 0 }
    override fun tailMap(fromKey: K): SortedMap<K, V> = filtered { compareInOrder(order, it, fromKey) >= 0 }
    override fun subMap(fromKey: K, toKey: K): SortedMap<K, V> =
        filtered { compareInOrder(order, it, fromKey) >= 0 && compareInOrder(order, it, toKey) < 0 }

    private fun filtered(predicate: (K) -> Boolean): SortedMap<K, V> {
        val result = TreeMap<K, V>(order)
        for ((key, value) in table) if (predicate(key)) result.put(key, value)
        return result
    }

    override fun equals(other: Any?): Boolean = table == other
    override fun hashCode(): Int = table.hashCode()
    override fun toString(): String = table.toString()
}

class TreeSet<E> private constructor(
    private val order: Comparator<in E>?,
    private val table: LinkedHashSet<E>
) : SortedSet<E>, MutableSet<E> by table {
    constructor() : this(null, LinkedHashSet())
    constructor(comparator: Comparator<in E>?) : this(comparator, LinkedHashSet())
    constructor(elements: Collection<E>) : this(null, LinkedHashSet()) {
        addAll(elements)
    }

    override fun comparator(): Comparator<in E>? = order

    override fun add(element: E): Boolean {
        compareInOrder(order, element, element)
        if (table.contains(element)) return false
        table.add(element)
        val sorted = table.sortedWith { a, b -> compareInOrder(order, a, b) }
        table.clear()
        table.addAll(sorted)
        return true
    }

    override fun addAll(elements: Collection<E>): Boolean {
        var changed = false
        for (element in elements) if (add(element)) changed = true
        return changed
    }

    override fun first(): E = if (table.isEmpty()) throw NoSuchElementException() else table.iterator().next()
    override fun last(): E = if (table.isEmpty()) throw NoSuchElementException() else table.toList().last()
    override fun headSet(toElement: E): SortedSet<E> = filtered { compareInOrder(order, it, toElement) < 0 }
    override fun tailSet(fromElement: E): SortedSet<E> = filtered { compareInOrder(order, it, fromElement) >= 0 }
    override fun subSet(fromElement: E, toElement: E): SortedSet<E> =
        filtered { compareInOrder(order, it, fromElement) >= 0 && compareInOrder(order, it, toElement) < 0 }

    private fun filtered(predicate: (E) -> Boolean): SortedSet<E> {
        val result = TreeSet<E>(order)
        for (element in table) if (predicate(element)) result.add(element)
        return result
    }

    override fun equals(other: Any?): Boolean = table == other
    override fun hashCode(): Int = table.hashCode()
    override fun toString(): String = table.toString()
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
