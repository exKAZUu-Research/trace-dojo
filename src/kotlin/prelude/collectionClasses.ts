import { kotlin } from './source';

const listReaders = (iterator: string): string => kotlin`
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun contains(element: E): Boolean
    external override fun containsAll(elements: Collection<E>): Boolean
    external override fun get(index: Int): E
    external override fun indexOf(element: E): Int
    external override fun lastIndexOf(element: E): Int
    external override fun listIterator(): ${iterator}<E>
    external override fun listIterator(index: Int): ${iterator}<E>
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
`;

/** The native classes of `kotlin.collections` and the functions that create them. */
export const COLLECTION_CLASSES_SOURCE = kotlin`
package kotlin.collections

abstract external class NativeList<E> : MutableList<E> {
    ${listReaders('MutableListIterator')}
    external override fun iterator(): MutableIterator<E>
    external override fun subList(fromIndex: Int, toIndex: Int): MutableList<E>
    external override fun add(element: E): Boolean
    external override fun add(index: Int, element: E)
    external override fun addAll(elements: Collection<E>): Boolean
    external override fun addAll(index: Int, elements: Collection<E>): Boolean
    external override fun remove(element: E): Boolean
    external override fun removeAt(index: Int): E
    external override fun set(index: Int, element: E): E
    external override fun removeAll(elements: Collection<E>): Boolean
    external override fun retainAll(elements: Collection<E>): Boolean
    external override fun clear()

}

abstract external class RandomAccessList<E> : NativeList<E>, RandomAccess

open external class ArrayList<E> : RandomAccessList<E> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(elements: Collection<E>)
}

external class ArrayDeque<E> : NativeList<E> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(elements: Collection<E>)

    fun addFirst(element: E) { add(0, element) }
    fun addLast(element: E) { add(element) }
    fun first(): E = get(dequeIndex(0))
    fun last(): E = get(dequeIndex(size - 1))
    fun firstOrNull(): E? = if (isEmpty()) null else first()
    fun lastOrNull(): E? = if (isEmpty()) null else last()
    fun removeFirst(): E = removeAt(dequeIndex(0))
    fun removeLast(): E = removeAt(dequeIndex(size - 1))
    fun removeFirstOrNull(): E? = if (isEmpty()) null else removeFirst()
    fun removeLastOrNull(): E? = if (isEmpty()) null else removeLast()

    private fun dequeIndex(index: Int): Int {
        if (isEmpty()) throw NoSuchElementException("ArrayDeque is empty.")
        return index
    }
}

external class PrimitiveArrayList<E> : List<E>, RandomAccess {
    ${listReaders('ListIterator')}
    external override fun iterator(): Iterator<E>
    external override fun subList(fromIndex: Int, toIndex: Int): List<E>
}

external class ArraysList<E> : RandomAccessList<E>
external class SingletonList<E> : RandomAccessList<E>
external class EmptyList<E> : RandomAccessList<E>
external class SubList<E> : RandomAccessList<E>
external class SequentialSubList<E> : NativeList<E>
external class EnumEntriesList<E> : RandomAccessList<E>

/** What \`buildList\` builds, which becomes read-only once built, as kotlin.collections.builders.ListBuilder does. */
external class ListBuilder<E> : RandomAccessList<E> {
    internal external fun build(): List<E>
}

external class ItemIterator<T> : MutableListIterator<T> {
    external override fun hasNext(): Boolean
    external override fun next(): T
    external override fun remove()
    external override fun add(element: T)
    external override fun set(element: T)
    external override fun hasPrevious(): Boolean
    external override fun previous(): T
    external override fun nextIndex(): Int
    external override fun previousIndex(): Int
}

abstract external class NativeMap<K, V> : MutableMap<K, V> {
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun containsKey(key: K): Boolean
    external override fun containsValue(value: V): Boolean
    external override fun get(key: K): V?
    external override fun put(key: K, value: V): V?
    external override fun remove(key: K): V?
    external override fun putAll(from: Map<out K, V>)
    external override fun clear()
    external override val keys: MutableSet<K>
    external override val values: MutableCollection<V>
    external override val entries: MutableSet<MutableMap.MutableEntry<K, V>>
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

open external class HashMap<K, V> : NativeMap<K, V> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(original: Map<out K, V>)
}

open external class LinkedHashMap<K, V> : HashMap<K, V> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(original: Map<out K, V>)
}

external class SingletonMap<K, V> : NativeMap<K, V>
external class EmptyMap<K, V> : NativeMap<K, V>

internal external class MapBuilder<K, V> : NativeMap<K, V> {
    external constructor(capacity: Int)
    external fun build(): Map<K, V>
}

abstract external class NativeSet<E> : MutableSet<E> {
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun contains(element: E): Boolean
    external override fun containsAll(elements: Collection<E>): Boolean
    external override fun iterator(): MutableIterator<E>
    external override fun add(element: E): Boolean
    external override fun remove(element: E): Boolean
    external override fun addAll(elements: Collection<E>): Boolean
    external override fun removeAll(elements: Collection<E>): Boolean
    external override fun retainAll(elements: Collection<E>): Boolean
    external override fun clear()
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

open external class HashSet<E> : NativeSet<E> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(elements: Collection<E>)
}

open external class LinkedHashSet<E> : HashSet<E> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(elements: Collection<E>)
}

external class SingletonSet<E> : NativeSet<E>
external class EmptySet<E> : NativeSet<E>

internal external class SetBuilder<E> : NativeSet<E> {
    external constructor(capacity: Int)
    external fun build(): Set<E>
}

external class MapKeysOrEntries<E> : MutableSet<E> {
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun contains(element: E): Boolean
    external override fun containsAll(elements: Collection<E>): Boolean
    external override fun iterator(): MutableIterator<E>
    external override fun add(element: E): Boolean
    external override fun remove(element: E): Boolean
    external override fun addAll(elements: Collection<E>): Boolean
    external override fun removeAll(elements: Collection<E>): Boolean
    external override fun retainAll(elements: Collection<E>): Boolean
    external override fun clear()
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

external class MapValues<E> : MutableCollection<E> {
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun contains(element: E): Boolean
    external override fun containsAll(elements: Collection<E>): Boolean
    external override fun iterator(): MutableIterator<E>
    external override fun add(element: E): Boolean
    external override fun remove(element: E): Boolean
    external override fun addAll(elements: Collection<E>): Boolean
    external override fun removeAll(elements: Collection<E>): Boolean
    external override fun retainAll(elements: Collection<E>): Boolean
    external override fun clear()
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

external class StoreIterator<T> : MutableIterator<T> {
    external override fun hasNext(): Boolean
    external override fun next(): T
    external override fun remove()
}

external class NativeEntry<K, V> : MutableMap.MutableEntry<K, V> {
    external override val key: K
    external override val value: V
    external override fun setValue(newValue: V): V
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

external fun <T> listOf(): List<T>
external fun <T> listOf(element: T): List<T>
external fun <T> listOf(vararg elements: T): List<T>
external fun <T> emptyList(): List<T>
external fun <T> mutableListOf(): MutableList<T>
external fun <T> mutableListOf(vararg elements: T): MutableList<T>
external fun <T> arrayListOf(): ArrayList<T>
external fun <T> arrayListOf(vararg elements: T): ArrayList<T>
external fun <T> setOf(): Set<T>
external fun <T> setOf(element: T): Set<T>
external fun <T> setOf(vararg elements: T): Set<T>
external fun <T> emptySet(): Set<T>
external fun <T> mutableSetOf(): MutableSet<T>
external fun <T> mutableSetOf(vararg elements: T): MutableSet<T>
external fun <T> hashSetOf(): HashSet<T>
external fun <T> hashSetOf(vararg elements: T): HashSet<T>
external fun <T> linkedSetOf(vararg elements: T): LinkedHashSet<T>
external fun <K, V> mapOf(): Map<K, V>
external fun <K, V> mapOf(pair: Pair<K, V>): Map<K, V>
external fun <K, V> mapOf(vararg pairs: Pair<K, V>): Map<K, V>
external fun <K, V> emptyMap(): Map<K, V>
external fun <K, V> mutableMapOf(): MutableMap<K, V>
external fun <K, V> mutableMapOf(vararg pairs: Pair<K, V>): MutableMap<K, V>
external fun <K, V> hashMapOf(): HashMap<K, V>
external fun <K, V> hashMapOf(vararg pairs: Pair<K, V>): HashMap<K, V>
external fun <K, V> linkedMapOf(vararg pairs: Pair<K, V>): LinkedHashMap<K, V>

inline fun <T> List(size: Int, init: (Int) -> T): List<T> = MutableList(size, init)
inline fun <T> MutableList(size: Int, init: (Int) -> T): MutableList<T> {
    val list = ArrayList<T>(size)
    for (index in 0 until size) list.add(init(index))
    return list
}

fun <T : Any> listOfNotNull(element: T?): List<T> = if (element != null) listOf(element) else emptyList()
fun <T : Any> listOfNotNull(vararg elements: T?): List<T> = elements.filterNotNull()
`;
