import { kotlin } from './source';

/** The interfaces and classes of `kotlin.collections`, whose implementations are natives. */
export const COLLECTION_TYPES_SOURCE = kotlin`
package kotlin.collections

interface Iterator<out T> {
    operator fun next(): T
    operator fun hasNext(): Boolean
}

interface MutableIterator<out T> : Iterator<T> {
    fun remove()
}

interface ListIterator<out T> : Iterator<T> {
    fun hasPrevious(): Boolean
    fun previous(): T
    fun nextIndex(): Int
    fun previousIndex(): Int
}

interface Iterable<out T> {
    operator fun iterator(): Iterator<T>
}

interface MutableIterable<out T> : Iterable<T> {
    override fun iterator(): MutableIterator<T>
}

interface Collection<out E> : Iterable<E> {
    val size: Int
    fun isEmpty(): Boolean
    operator fun contains(element: E): Boolean
    fun containsAll(elements: Collection<E>): Boolean
}

interface MutableCollection<E> : Collection<E>, MutableIterable<E> {
    override fun iterator(): MutableIterator<E>
    fun add(element: E): Boolean
    fun remove(element: E): Boolean
    fun addAll(elements: Collection<E>): Boolean
    fun removeAll(elements: Collection<E>): Boolean
    fun retainAll(elements: Collection<E>): Boolean
    fun clear()
}

interface List<out E> : Collection<E> {
    operator fun get(index: Int): E
    fun indexOf(element: E): Int
    fun lastIndexOf(element: E): Int
    fun listIterator(): ListIterator<E>
    fun listIterator(index: Int): ListIterator<E>
    fun subList(fromIndex: Int, toIndex: Int): List<E>
}

interface MutableList<E> : List<E>, MutableCollection<E> {
    fun add(index: Int, element: E)
    fun removeAt(index: Int): E
    operator fun set(index: Int, element: E): E
    fun addAll(index: Int, elements: Collection<E>): Boolean
    override fun subList(fromIndex: Int, toIndex: Int): MutableList<E>
}

interface Set<out E> : Collection<E>

interface MutableSet<E> : Set<E>, MutableCollection<E>

interface Map<K, out V> {
    val size: Int
    fun isEmpty(): Boolean
    fun containsKey(key: K): Boolean
    fun containsValue(value: V): Boolean
    operator fun get(key: K): V?
    val keys: Set<K>
    val values: Collection<V>
    val entries: Set<Map.Entry<K, V>>
    interface Entry<out K, out V> {
        val key: K
        val value: V
    }
}

interface MutableMap<K, V> : Map<K, V> {
    fun put(key: K, value: V): V?
    fun remove(key: K): V?
    fun putAll(from: Map<out K, V>)
    fun clear()
    override val keys: MutableSet<K>
    override val values: MutableCollection<V>
    override val entries: MutableSet<MutableMap.MutableEntry<K, V>>
    interface MutableEntry<K, V> : Map.Entry<K, V> {
        fun setValue(newValue: V): V
    }
}

interface RandomAccess
`;
