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

internal class MovingWindow<T>(private val backing: List<T>) : List<T>, RandomAccess {
    private var start = 0
    override var size = 0
        private set

    fun move(fromIndex: Int, toIndex: Int) {
        if (fromIndex < 0 || toIndex > backing.size)
            throw IndexOutOfBoundsException("fromIndex: $fromIndex, toIndex: $toIndex, size: \${backing.size}")
        if (fromIndex > toIndex)
            throw IllegalArgumentException("fromIndex: $fromIndex > toIndex: $toIndex")
        start = fromIndex
        size = toIndex - fromIndex
    }

    override fun isEmpty(): Boolean = size == 0
    override fun get(index: Int): T {
        if (index !in 0 until size) throw IndexOutOfBoundsException("index: $index, size: $size")
        return backing[start + index]
    }
    override fun contains(element: T): Boolean = indexOf(element) >= 0
    override fun containsAll(elements: Collection<T>): Boolean = elements.all { contains(it) }
    override fun indexOf(element: T): Int = indexOfFirst { it == element }
    override fun lastIndexOf(element: T): Int = indexOfLast { it == element }
    override fun iterator(): Iterator<T> = listIterator()
    override fun listIterator(): ListIterator<T> = listIterator(0)
    override fun listIterator(index: Int): ListIterator<T> {
        if (index < 0 || index > size) throw IndexOutOfBoundsException("index: $index, size: $size")
        return MovingWindowIterator(this, index)
    }
    override fun subList(fromIndex: Int, toIndex: Int): List<T> {
        if (fromIndex < 0 || toIndex > size)
            throw IndexOutOfBoundsException("fromIndex: $fromIndex, toIndex: $toIndex, size: $size")
        val window = MovingWindow(backing)
        window.move(start + fromIndex, start + toIndex)
        return window
    }
    override fun equals(other: Any?): Boolean = sameListContents(other)
    override fun hashCode(): Int = listContentHash()
    override fun toString(): String = renderListContents()
}

private class MovingWindowIterator<T>(private val window: MovingWindow<T>, private var index: Int) : ListIterator<T> {
    override fun hasNext(): Boolean = index < window.size
    override fun hasPrevious(): Boolean = index > 0
    override fun nextIndex(): Int = index
    override fun previousIndex(): Int = index - 1
    override fun next(): T {
        if (!hasNext()) throw NoSuchElementException()
        return window[index++]
    }
    override fun previous(): T {
        if (!hasPrevious()) throw NoSuchElementException()
        return window[--index]
    }
}

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
        ReversedListIterator(backing.listIterator(positionIndex(index)), backing)
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

    override fun equals(other: Any?): Boolean = sameListContents(other)
    override fun hashCode(): Int = listContentHash()
    override fun toString(): String = renderListContents()
}

private fun <T> List<T>.sameListContents(other: Any?): Boolean {
    if (this === other) return true
    if (other !is List<*> || size != other.size) return false
    val right = other.iterator()
    for (item in this) if (item != right.next()) return false
    return true
}

private fun <T> List<T>.listContentHash(): Int {
    var hash = 1
    for (element in this) hash = 31 * hash + (element?.hashCode() ?: 0)
    return hash
}

private fun <T> List<T>.renderListContents(): String =
    joinToString(prefix = "[", postfix = "]") { if (it === this) "(this Collection)" else it.toString() }

private open class ReversedListIterator<T>(private val backing: ListIterator<T>, private val source: List<T>) : ListIterator<T> {
    override fun hasNext(): Boolean = backing.hasPrevious()
    override fun next(): T = backing.previous()
    override fun hasPrevious(): Boolean = backing.hasNext()
    override fun previous(): T = backing.next()
    override fun nextIndex(): Int = source.size - backing.nextIndex()
    override fun previousIndex(): Int = nextIndex() - 1
}

private class MutableReversedList<T>(private val backing: MutableList<T>) : ReversedList<T>(backing), MutableList<T> {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is List<*>) return false
        val left = listIterator()
        val right = other.listIterator()
        while (left.hasNext() && right.hasNext()) {
            if (left.next() != right.next()) return false
        }
        return !left.hasNext() && !right.hasNext()
    }

    override fun iterator(): MutableIterator<T> = listIterator()
    override fun listIterator(): MutableListIterator<T> = listIterator(0)
    override fun listIterator(index: Int): MutableListIterator<T> =
        MutableReversedListIterator(backing.listIterator(positionIndex(index)), backing)
    override fun add(element: T): Boolean {
        backing.add(0, element)
        return true
    }
    override fun add(index: Int, element: T) = backing.add(positionIndex(index), element)
    override fun addAll(elements: Collection<T>): Boolean {
        var changed = false
        for (element in elements) {
            add(element)
            changed = true
        }
        return changed
    }
    override fun addAll(index: Int, elements: Collection<T>): Boolean {
        if (index < 0 || index > size) throw IndexOutOfBoundsException("Index: $index, Size: $size")
        var next = index
        for (element in elements) add(next++, element)
        return next != index
    }
    override fun remove(element: T): Boolean {
        val index = indexOf(element)
        if (index < 0) return false
        removeAt(index)
        return true
    }
    override fun removeAt(index: Int): T = backing.removeAt(elementIndex(index))
    override fun set(index: Int, element: T): T = backing.set(elementIndex(index), element)
    override fun removeAll(elements: Collection<T>): Boolean = removeByMembership(elements, true)
    override fun retainAll(elements: Collection<T>): Boolean = removeByMembership(elements, false)

    private fun removeByMembership(elements: Collection<T>, removeIfPresent: Boolean): Boolean {
        val cursor = iterator()
        var changed = false
        while (cursor.hasNext()) {
            if ((cursor.next() in elements) == removeIfPresent) {
                cursor.remove()
                changed = true
            }
        }
        return changed
    }
    override fun clear() = backing.clear()
    override fun subList(fromIndex: Int, toIndex: Int): MutableList<T> =
        MutableReversedList(backing.subList(positionIndex(toIndex), positionIndex(fromIndex)))
}

private class MutableReversedListIterator<T>(private val backing: MutableListIterator<T>, source: List<T>) :
    ReversedListIterator<T>(backing, source), MutableListIterator<T> {
    override fun remove() = backing.remove()
    override fun set(element: T) = backing.set(element)
    override fun add(element: T) {
        backing.add(element)
        backing.previous()
    }
}

fun <T> List<T>.asReversed(): List<T> = ReversedList(this)

@JvmName("asReversedMutable")
fun <T> MutableList<T>.asReversed(): MutableList<T> = MutableReversedList(this)
`;
