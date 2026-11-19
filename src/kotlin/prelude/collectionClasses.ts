import { kotlin } from './source';

/** The native classes of `kotlin.collections` and the functions that create them. */
export const COLLECTION_CLASSES_SOURCE = kotlin`
package kotlin.collections

abstract external class NativeList<E> : MutableList<E>, RandomAccess {
    external override val size: Int
    external override fun isEmpty(): Boolean
    external override fun contains(element: E): Boolean
    external override fun containsAll(elements: Collection<E>): Boolean
    external override fun get(index: Int): E
    external override fun indexOf(element: E): Int
    external override fun lastIndexOf(element: E): Int
    external override fun iterator(): MutableIterator<E>
    external override fun listIterator(): ListIterator<E>
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
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

external class ArrayList<E> : NativeList<E> {
    external constructor()
    external constructor(initialCapacity: Int)
    external constructor(elements: Collection<E>)
}

external class ArraysList<E> : NativeList<E>
external class SingletonList<E> : NativeList<E>
external class EmptyList<E> : NativeList<E>
external class SubList<E> : NativeList<E>
external class EnumEntriesList<E> : NativeList<E>

external class ItemIterator<T> : MutableIterator<T>, ListIterator<T> {
    external override fun hasNext(): Boolean
    external override fun next(): T
    external override fun remove()
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

fun <T : Any> listOfNotNull(element: T?): List<T> = if (element != null) listOf(element) else emptyList()
fun <T : Any> listOfNotNull(vararg elements: T?): List<T> = elements.filterNotNull()
`;
