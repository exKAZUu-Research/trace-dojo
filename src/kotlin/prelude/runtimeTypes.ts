import { kotlin } from './source';

/** Small packages of the prelude: output, reflection's property references, and trace-dojo's Turtle. */
export const IO_SOURCE = kotlin`
package kotlin.io

external fun println(message: Any?)
external fun println()
external fun print(message: Any?)

// The overloads that kotlin.io declares on the JVM, so that resolving a call chooses among them as kotlinc does.
fun println(message: Boolean) = println(message as Any?)
fun print(message: Boolean) = print(message as Any?)
fun println(message: Byte) = println(message as Any?)
fun print(message: Byte) = print(message as Any?)
fun println(message: Char) = println(message as Any?)
fun print(message: Char) = print(message as Any?)
fun println(message: Double) = println(message as Any?)
fun print(message: Double) = print(message as Any?)
fun println(message: Float) = println(message as Any?)
fun print(message: Float) = print(message as Any?)
fun println(message: Int) = println(message as Any?)
fun print(message: Int) = print(message as Any?)
fun println(message: Long) = println(message as Any?)
fun print(message: Long) = print(message as Any?)
fun println(message: Short) = println(message as Any?)
fun print(message: Short) = print(message as Any?)
fun println(message: CharArray) = println(message.concatToString())
fun print(message: CharArray) = print(message.concatToString())
`;

/** `System.out` and `System.err`, which Kotlin programs reach through Java's `java.lang`. */
export const SYSTEM_SOURCE = kotlin`
package java.lang

import java.util.Locale

class PrintStream internal constructor(private val isError: Boolean) {
    fun println(message: CharArray?) { println(renderChars(message)) }
    fun println(message: String?) { writeStream(isError, message.toString() + "\\n") }
    fun println(message: Any?) { println(message.toString()) }
    fun println() { writeStream(isError, "\\n") }
    fun print(message: CharArray?) { print(renderChars(message)) }
    fun print(message: String?) { writeStream(isError, message.toString()) }
    fun print(message: Any?) { print(message.toString()) }
    // The output is a buffer the grader reads at the end, so flushing it changes nothing.
    fun flush() {}
    fun append(value: CharSequence?): PrintStream {
        print(value.toString())
        return this
    }
    fun append(value: Char): PrintStream {
        print(value.toString())
        return this
    }
    fun write(byte: Int) { writeStream(isError, (byte and 0xFF).toChar().toString()) }

    private fun renderChars(message: CharArray?): String {
        if (message == null) throw NullPointerException("Cannot read the array length because \\"cbuf\\" is null")
        return message.concatToString()
    }

    fun format(pattern: String, vararg args: Any?): PrintStream {
        formatStream(isError, pattern, args)
        return this
    }
    fun format(locale: Locale?, pattern: String, vararg args: Any?): PrintStream {
        formatStream(isError, pattern, args)
        return this
    }
    fun printf(pattern: String, vararg args: Any?): PrintStream = format(pattern, *args)
    fun printf(locale: Locale?, pattern: String, vararg args: Any?): PrintStream = format(locale, pattern, *args)
}

object System {
    val out: PrintStream = PrintStream(false)
    val err: PrintStream = PrintStream(true)

    fun lineSeparator(): String = "\\n"

    /** Checks its arrays and range in HotSpot's order, with its messages, as the Java interpreter's does. */
    fun arraycopy(src: Any?, srcPos: Int, dest: Any?, destPos: Int, length: Int) {
        if (src == null || dest == null) throw NullPointerException()
        val from = arrayKindOf(src)
            ?: throw ArrayStoreException("arraycopy: source type ${'$'}{runtimeClassName(src)} is not an array")
        val to = arrayKindOf(dest)
            ?: throw ArrayStoreException("arraycopy: destination type ${'$'}{runtimeClassName(dest)} is not an array")
        if (from != to) throw ArrayStoreException("arraycopy: type mismatch: can not copy ${'$'}from[] into ${'$'}to[]")
        val srcSize = arraySizeOf(src)
        val destSize = arraySizeOf(dest)
        if (srcPos < 0) outOfBounds("source index ${'$'}srcPos out of bounds for ${'$'}from[${'$'}srcSize]")
        if (destPos < 0) outOfBounds("destination index ${'$'}destPos out of bounds for ${'$'}to[${'$'}destSize]")
        if (length < 0) outOfBounds("length ${'$'}length is negative")
        if (srcPos + length > srcSize) outOfBounds("last source index ${'$'}{srcPos + length} out of bounds for ${'$'}from[${'$'}srcSize]")
        if (destPos + length > destSize)
            outOfBounds("last destination index ${'$'}{destPos + length} out of bounds for ${'$'}to[${'$'}destSize]")
        val end = srcPos + length
        when (src) {
            is IntArray -> src.copyInto(dest as IntArray, destPos, srcPos, end)
            is LongArray -> src.copyInto(dest as LongArray, destPos, srcPos, end)
            is DoubleArray -> src.copyInto(dest as DoubleArray, destPos, srcPos, end)
            is FloatArray -> src.copyInto(dest as FloatArray, destPos, srcPos, end)
            is CharArray -> src.copyInto(dest as CharArray, destPos, srcPos, end)
            is BooleanArray -> src.copyInto(dest as BooleanArray, destPos, srcPos, end)
            is ByteArray -> src.copyInto(dest as ByteArray, destPos, srcPos, end)
            is ShortArray -> src.copyInto(dest as ShortArray, destPos, srcPos, end)
            else -> (src as Array<Any?>).copyInto(dest as Array<Any?>, destPos, srcPos, end)
        }
    }

    private fun outOfBounds(message: String): Nothing = throw ArrayIndexOutOfBoundsException("arraycopy: ${'$'}message")

    /** An array's element kind as HotSpot's messages name it: int and the like, or object array. */
    private fun arrayKindOf(array: Any): String? = when (array) {
        is IntArray -> "int"
        is LongArray -> "long"
        is DoubleArray -> "double"
        is FloatArray -> "float"
        is CharArray -> "char"
        is BooleanArray -> "boolean"
        is ByteArray -> "byte"
        is ShortArray -> "short"
        is Array<*> -> "object array"
        else -> null
    }

    private fun arraySizeOf(array: Any): Int = when (array) {
        is IntArray -> array.size
        is LongArray -> array.size
        is DoubleArray -> array.size
        is FloatArray -> array.size
        is CharArray -> array.size
        is BooleanArray -> array.size
        is ByteArray -> array.size
        is ShortArray -> array.size
        else -> (array as Array<*>).size
    }
}

internal external fun writeStream(isError: Boolean, text: String)
internal external fun runtimeClassName(value: Any): String
internal external fun formatStream(isError: Boolean, pattern: String, args: Array<out Any?>)
`;

export const REFLECT_SOURCE = kotlin`
package kotlin.reflect

interface KProperty<out V> {
    val name: String
}

external class PropertyReference : KProperty<Any?> {
    external override val name: String
}
`;

export const TURTLE_SOURCE = kotlin`
package tracedojo

external class Turtle {
    external constructor()
    external constructor(x: Int, y: Int)
    external constructor(x: Int, y: Int, color: String?)
    external fun 前に進む()
    external fun forward()
    external fun 後に戻る()
    external fun backward()
    external fun 右を向く()
    external fun turnRight()
    external fun 左を向く()
    external fun turnLeft()
    external fun 前に進めるか(): Boolean
    external fun canMoveForward(): Boolean
    external fun 前のマスが塗られているか(): Boolean
    external fun remove()
}
`;

/** The exceptions of the JVM and of Kotlin that the library throws and programs catch, with their JVM names. */
export const EXCEPTIONS: [kotlinPackage: string, name: string, parent: string, jvmName: string][] = [
  ['kotlin', 'Exception', 'Throwable', 'java.lang.Exception'],
  ['kotlin', 'Error', 'Throwable', 'java.lang.Error'],
  ['kotlin', 'RuntimeException', 'Exception', 'java.lang.RuntimeException'],
  ['kotlin', 'IllegalArgumentException', 'RuntimeException', 'java.lang.IllegalArgumentException'],
  ['kotlin', 'IllegalStateException', 'RuntimeException', 'java.lang.IllegalStateException'],
  ['kotlin', 'IndexOutOfBoundsException', 'RuntimeException', 'java.lang.IndexOutOfBoundsException'],
  ['kotlin', 'ArrayIndexOutOfBoundsException', 'IndexOutOfBoundsException', 'java.lang.ArrayIndexOutOfBoundsException'],
  [
    'kotlin',
    'StringIndexOutOfBoundsException',
    'IndexOutOfBoundsException',
    'java.lang.StringIndexOutOfBoundsException',
  ],
  ['kotlin', 'NullPointerException', 'RuntimeException', 'java.lang.NullPointerException'],
  ['kotlin', 'ArithmeticException', 'RuntimeException', 'java.lang.ArithmeticException'],
  ['kotlin', 'ClassCastException', 'RuntimeException', 'java.lang.ClassCastException'],
  ['kotlin', 'NumberFormatException', 'IllegalArgumentException', 'java.lang.NumberFormatException'],
  ['kotlin', 'UnsupportedOperationException', 'RuntimeException', 'java.lang.UnsupportedOperationException'],
  ['kotlin', 'NoSuchElementException', 'RuntimeException', 'java.util.NoSuchElementException'],
  ['kotlin', 'ConcurrentModificationException', 'RuntimeException', 'java.util.ConcurrentModificationException'],
  ['kotlin', 'NotImplementedError', 'Error', 'kotlin.NotImplementedError'],
  ['kotlin', 'UninitializedPropertyAccessException', 'RuntimeException', 'kotlin.UninitializedPropertyAccessException'],
  ['kotlin', 'AssertionError', 'Error', 'java.lang.AssertionError'],
  ['kotlin', 'StackOverflowError', 'Error', 'java.lang.StackOverflowError'],
  ['kotlin', 'OutOfMemoryError', 'Error', 'java.lang.OutOfMemoryError'],
  ['kotlin', 'InstantiationError', 'Error', 'java.lang.InstantiationError'],
  ['java.lang', 'LinkageError', 'Error', 'java.lang.LinkageError'],
  ['java.lang', 'ExceptionInInitializerError', 'LinkageError', 'java.lang.ExceptionInInitializerError'],
  ['java.lang', 'NoClassDefFoundError', 'LinkageError', 'java.lang.NoClassDefFoundError'],
  ['java.lang', 'NegativeArraySizeException', 'RuntimeException', 'java.lang.NegativeArraySizeException'],
  ['java.lang', 'ArrayStoreException', 'RuntimeException', 'java.lang.ArrayStoreException'],
  ['java.util', 'IllegalFormatException', 'IllegalArgumentException', 'java.util.IllegalFormatException'],
  ...[
    'DuplicateFormatFlagsException',
    'IllegalFormatArgumentIndexException',
    'IllegalFormatFlagsException',
    'IllegalFormatWidthException',
    'IllegalFormatConversionException',
    'MissingFormatArgumentException',
    'UnknownFormatConversionException',
    'MissingFormatWidthException',
    'IllegalFormatPrecisionException',
    'IllegalFormatCodePointException',
    'FormatFlagsConversionMismatchException',
  ].map((name): [string, string, string, string] => ['java.util', name, 'IllegalFormatException', `java.util.${name}`]),
];

/** The exception classes of the prelude, each with Throwable's four constructors, as one source per package. */
export function exceptionSources(): string[] {
  const packages = Map.groupBy(EXCEPTIONS, ([packageName]) => packageName);
  return [...packages].map(([packageName, exceptions]) => {
    const classes = exceptions.map(
      ([
        ,
        name,
        parent,
      ]) => `${name === 'IllegalFormatArgumentIndexException' ? 'internal ' : ''}open external class ${name} : ${parent} {
    external constructor()
    external constructor(message: String?)
    external constructor(message: String?, cause: Throwable?)
    external constructor(cause: Throwable?)
}`
    );
    return `package ${packageName}\n\n${classes.join('\n\n')}\n`;
  });
}
