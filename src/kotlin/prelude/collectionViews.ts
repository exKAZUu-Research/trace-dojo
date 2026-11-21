import { kotlin } from './source';

export const COLLECTION_VIEWS_SOURCE = kotlin`
package kotlin.collections

private class IndexingIterable<T>(private val backing: Iterable<T>) : Iterable<IndexedValue<T>> {
    override fun iterator(): Iterator<IndexedValue<T>> = IndexingIterator(backing.iterator())
}

private class IndexingIterator<T>(private val backing: Iterator<T>) : Iterator<IndexedValue<T>> {
    private var index = 0
    override fun hasNext(): Boolean = backing.hasNext()
    override fun next(): IndexedValue<T> = IndexedValue(index++, backing.next())
}

fun <T> Iterable<T>.withIndex(): Iterable<IndexedValue<T>> = IndexingIterable(this)

private open class ReversedList<T>(private val backing: List<T>) : List<T> {
    override val size: Int get() = backing.size
    override fun isEmpty(): Boolean = backing.isEmpty()
    override fun get(index: Int): T = backing[elementIndex(index)]
    override fun contains(element: T): Boolean = indexOf(element) >= 0
    override fun containsAll(elements: Collection<T>): Boolean = elements.all { contains(it) }
    override fun indexOf(element: T): Int {
        val index = backing.lastIndexOf(element)
        return if (index < 0) -1 else size - 1 - index
    }
    override fun lastIndexOf(element: T): Int {
        val index = backing.indexOf(element)
        return if (index < 0) -1 else size - 1 - index
    }
    override fun iterator(): Iterator<T> = listIterator()
    override fun listIterator(): ListIterator<T> = listIterator(0)
    override fun listIterator(index: Int): ListIterator<T> =
        ReversedListIterator(backing.listIterator(positionIndex(index)), size)
    override fun subList(fromIndex: Int, toIndex: Int): List<T> =
        ReversedList(backing.subList(positionIndex(toIndex), positionIndex(fromIndex)))

    protected fun elementIndex(index: Int): Int {
        if (index < 0 || index >= size)
            throw IndexOutOfBoundsException("Element index $index must be in range [0..\${size - 1}].")
        return size - 1 - index
    }
    protected fun positionIndex(index: Int): Int {
        if (index < 0 || index > size)
            throw IndexOutOfBoundsException("Position index $index must be in range [0..$size].")
        return size - index
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is List<*> || size != other.size) return false
        for (index in indices) if (this[index] != other[index]) return false
        return true
    }
    override fun hashCode(): Int {
        var hash = 1
        for (element in this) hash = 31 * hash + (element?.hashCode() ?: 0)
        return hash
    }
    override fun toString(): String =
        joinToString(prefix = "[", postfix = "]") { if (it === this) "(this Collection)" else it.toString() }
}

private class ReversedListIterator<T>(private val backing: ListIterator<T>, private val size: Int) : ListIterator<T> {
    override fun hasNext(): Boolean = backing.hasPrevious()
    override fun next(): T = backing.previous()
    override fun hasPrevious(): Boolean = backing.hasNext()
    override fun previous(): T = backing.next()
    override fun nextIndex(): Int = size - backing.nextIndex()
    override fun previousIndex(): Int = nextIndex() - 1
}

private class MutableReversedList<T>(private val backing: MutableList<T>) : ReversedList<T>(backing), MutableList<T> {
    override fun iterator(): MutableIterator<T> = MutableReversedIterator(backing.listIterator(size))
    override fun add(element: T): Boolean {
        backing.add(0, element)
        return true
    }
    override fun add(index: Int, element: T) = backing.add(positionIndex(index), element)
    override fun addAll(elements: Collection<T>): Boolean = addAll(size, elements)
    override fun addAll(index: Int, elements: Collection<T>): Boolean =
        backing.addAll(positionIndex(index), elements.reversed())
    override fun remove(element: T): Boolean {
        val index = indexOf(element)
        if (index < 0) return false
        removeAt(index)
        return true
    }
    override fun removeAt(index: Int): T = backing.removeAt(elementIndex(index))
    override fun set(index: Int, element: T): T = backing.set(elementIndex(index), element)
    override fun removeAll(elements: Collection<T>): Boolean = backing.removeAll(elements)
    override fun retainAll(elements: Collection<T>): Boolean = backing.retainAll(elements)
    override fun clear() = backing.clear()
    override fun subList(fromIndex: Int, toIndex: Int): MutableList<T> =
        MutableReversedList(backing.subList(positionIndex(toIndex), positionIndex(fromIndex)))
}

private class MutableReversedIterator<T>(private val backing: ListIterator<T>) : MutableIterator<T> {
    override fun hasNext(): Boolean = backing.hasPrevious()
    override fun next(): T = backing.previous()
    override fun remove() = (backing as MutableIterator<T>).remove()
}

fun <T> List<T>.asReversed(): List<T> = ReversedList(this)

@JvmName("asReversedMutable")
fun <T> MutableList<T>.asReversed(): MutableList<T> = MutableReversedList(this)
`;
