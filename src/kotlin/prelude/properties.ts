import { kotlin } from './source';

/** `kotlin.properties`: the delegates of `Delegates`, transcribed from Kotlin's standard library. */
export const PROPERTIES_SOURCE = kotlin`
package kotlin.properties

import kotlin.reflect.KProperty

fun interface ReadOnlyProperty<in T, out V> {
    operator fun getValue(thisRef: T, property: KProperty<*>): V
}

interface ReadWriteProperty<in T, V> : ReadOnlyProperty<T, V> {
    override operator fun getValue(thisRef: T, property: KProperty<*>): V
    operator fun setValue(thisRef: T, property: KProperty<*>, value: V)
}

abstract class ObservableProperty<V>(initialValue: V) : ReadWriteProperty<Any?, V> {
    private var value = initialValue
    protected open fun beforeChange(property: KProperty<*>, oldValue: V, newValue: V): Boolean = true
    protected open fun afterChange(property: KProperty<*>, oldValue: V, newValue: V) {}
    override fun getValue(thisRef: Any?, property: KProperty<*>): V = value
    override fun setValue(thisRef: Any?, property: KProperty<*>, value: V) {
        val oldValue = this.value
        if (!beforeChange(property, oldValue, value)) return
        this.value = value
        afterChange(property, oldValue, value)
    }
    override fun toString(): String = "ObservableProperty(value=$value)"
}

class ObservableDelegate<T>(initialValue: T, private val onChange: (property: KProperty<*>, oldValue: T, newValue: T) -> Unit) : ObservableProperty<T>(initialValue) {
    override fun afterChange(property: KProperty<*>, oldValue: T, newValue: T) = onChange(property, oldValue, newValue)
}

class VetoableDelegate<T>(initialValue: T, private val onChange: (property: KProperty<*>, oldValue: T, newValue: T) -> Boolean) : ObservableProperty<T>(initialValue) {
    override fun beforeChange(property: KProperty<*>, oldValue: T, newValue: T): Boolean = onChange(property, oldValue, newValue)
}

class NotNullVar<T : Any> : ReadWriteProperty<Any?, T> {
    private var value: T? = null
    override fun getValue(thisRef: Any?, property: KProperty<*>): T =
        value ?: throw IllegalStateException("Property \${property.name} should be initialized before get.")
    override fun setValue(thisRef: Any?, property: KProperty<*>, value: T) {
        this.value = value
    }
    override fun toString(): String = "NotNullProperty(" + (if (value != null) "value=$value" else "value not initialized yet") + ")"
}

object Delegates {
    fun <T : Any> notNull(): ReadWriteProperty<Any?, T> = NotNullVar()
    inline fun <T> observable(initialValue: T, crossinline onChange: (property: KProperty<*>, oldValue: T, newValue: T) -> Unit): ReadWriteProperty<Any?, T> =
        ObservableDelegate(initialValue) { property, oldValue, newValue -> onChange(property, oldValue, newValue) }
    inline fun <T> vetoable(initialValue: T, crossinline onChange: (property: KProperty<*>, oldValue: T, newValue: T) -> Boolean): ReadWriteProperty<Any?, T> =
        VetoableDelegate(initialValue) { property, oldValue, newValue -> onChange(property, oldValue, newValue) }
}
`;
