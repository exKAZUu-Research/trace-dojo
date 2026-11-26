import { kotlin } from './source';

/** Small packages of the prelude: output, reflection's property references, and trace-dojo's Turtle. */
export const IO_SOURCE = kotlin`
package kotlin.io

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.File
import java.io.PrintWriter

external fun println(message: Any?)
external fun println()
external fun print(message: Any?)

external fun readLine(): String?
external fun readln(): String
external fun readlnOrNull(): String?

external fun File.readText(): String
external fun File.writeText(text: String)
external fun File.appendText(text: String)
external fun File.bufferedReader(): BufferedReader
external fun File.bufferedWriter(): BufferedWriter
external fun File.printWriter(): PrintWriter

fun File.readLines(): List<String> {
    val lines = ArrayList<String>()
    bufferedReader().use { reader ->
        while (true) lines.add(reader.readLine() ?: break)
    }
    return lines
}

// Not inline, as the stdlib's is not, so that its lambda cannot return from the caller.
fun File.forEachLine(action: (line: String) -> Unit) {
    for (line in readLines()) action(line)
}

inline fun <T> File.useLines(block: (Sequence<String>) -> T): T = block(readLines().asSequence())

// The forms that name a charset, which can only be UTF-8 here, as Charsets.UTF_8 is.
fun File.readText(charset: java.nio.charset.Charset): String = readText()
fun File.writeText(text: String, charset: java.nio.charset.Charset) { writeText(text) }
fun File.appendText(text: String, charset: java.nio.charset.Charset) { appendText(text) }
fun File.readLines(charset: java.nio.charset.Charset): List<String> = readLines()
fun File.bufferedReader(charset: java.nio.charset.Charset): BufferedReader = bufferedReader()
fun File.bufferedWriter(charset: java.nio.charset.Charset): BufferedWriter = bufferedWriter()
fun File.printWriter(charset: java.nio.charset.Charset): PrintWriter = printWriter()
fun File.forEachLine(charset: java.nio.charset.Charset, action: (line: String) -> Unit) = forEachLine(action)
inline fun <T> File.useLines(charset: java.nio.charset.Charset, block: (Sequence<String>) -> T): T = useLines(block)

// A reader's lines and text, as Kotlin's extensions of java.io.Reader and BufferedReader read them.
fun BufferedReader.lineSequence(): Sequence<String> = generateSequence { readLine() }.constrainOnce()

fun BufferedReader.readLines(): List<String> {
    val lines = ArrayList<String>()
    forEachLine { lines.add(it) }
    return lines
}

inline fun <T> BufferedReader.useLines(block: (Sequence<String>) -> T): T = use { block(it.lineSequence()) }

fun BufferedReader.forEachLine(action: (line: String) -> Unit): Unit = useLines { it.forEach(action) }

fun BufferedReader.readText(): String {
    val text = StringBuilder()
    while (true) {
        val char = read()
        if (char < 0) break
        text.append(char.toChar())
    }
    return text.toString()
}

val File.extension: String
    get() = name.substringAfterLast('.', "")

val File.nameWithoutExtension: String
    get() = name.substringBeforeLast(".")

inline fun <T : Closeable?, R> T.use(block: (T) -> R): R {
    var closed = false
    try {
        return block(this)
    } catch (e: Throwable) {
        closed = true
        try {
            this?.close()
        } catch (_: Throwable) {
        }
        throw e
    } finally {
        if (!closed) this?.close()
    }
}

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

/** \`java.io\`: the files of a run's file system and the readers and writers of their text, as Java provides them. */
export const JAVA_IO_SOURCE = kotlin`
package java.io

interface Closeable {
    fun close()
}

external class File {
    external constructor(pathname: String)
    external constructor(parent: String?, child: String)
    external constructor(parent: File?, child: String)
    external val name: String
    external val path: String
    external val absolutePath: String
    external val parent: String?
    external val parentFile: File?
    external val isFile: Boolean
    external val isDirectory: Boolean
    external fun exists(): Boolean
    external fun length(): Long
    external fun delete(): Boolean
    external fun mkdir(): Boolean
    external fun mkdirs(): Boolean
    external fun createNewFile(): Boolean
    external fun renameTo(dest: File): Boolean
    external fun list(): Array<String>?
    external fun listFiles(): Array<File>?
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

external class BufferedReader : Closeable {
    external fun readLine(): String?
    external fun read(): Int
    external fun ready(): Boolean
    external override fun close()
}

external class BufferedWriter : Closeable {
    external fun write(text: String)
    // Writer's other writes, of one character's code, of characters, and of a part of a string, as java.io.Writer has.
    fun write(c: Int) { write(c.toChar().toString()) }
    fun write(chars: CharArray) { write(chars.concatToString()) }
    fun write(text: String, off: Int, len: Int) { write(text.substring(off, off + len)) }
    fun write(chars: CharArray, off: Int, len: Int) { write(chars.concatToString(off, off + len)) }
    external fun newLine()
    external fun flush()
    external override fun close()
}

external class PrintWriter : Closeable {
    external fun print(value: Any?)
    external fun println(value: Any?)
    external fun println()
    external fun flush()
    external override fun close()
}
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

    external fun currentTimeMillis(): Long
    external fun nanoTime(): Long

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

/** The number of `FunctionN` interfaces, from `Function0` to `Function22`, as on the JVM. */
export const FUNCTION_INTERFACE_COUNT = 23;

/** `kotlin.jvm.functions`: the interfaces of function types, which classes implement as `class C : (Int) -> Int`. */
export const FUNCTIONS_SOURCE = `package kotlin.jvm.functions

${Array.from({ length: FUNCTION_INTERFACE_COUNT }, (_, arity) => {
  const params = Array.from({ length: arity }, (_, index) => `in P${index + 1}`);
  const values = Array.from({ length: arity }, (_, index) => `p${index + 1}: P${index + 1}`);
  return `interface Function${arity}<${[...params, 'out R'].join(', ')}> : Function<R> {
    operator fun invoke(${values.join(', ')}): R
}`;
}).join('\n\n')}
`;

/** The number of `KFunctionN` interfaces, which references of functions with that many parameters implement. */
export const REFERENCE_ARITY_COUNT = 23;

function functionReferenceSource(arity: number): string {
  const typeParams = Array.from({ length: arity }, (_, index) => `P${index + 1}`);
  const values = typeParams.map((type, index) => `p${index + 1}: ${type}`);
  const names = typeParams.map((_, index) => `p${index + 1}`);
  const variance = [...typeParams.map((type) => `in ${type}`), 'out R'].join(', ');
  const args = [...typeParams, 'R'].join(', ');
  return `interface KFunction${arity}<${variance}> : KFunction<R>, kotlin.jvm.functions.Function${arity}<${args}>

internal class FunctionReference${arity}<${args}>(override val name: String, private val target: kotlin.jvm.functions.Function${arity}<${args}>) : KFunction${arity}<${args}> {
    override fun invoke(${values.join(', ')}): R = target.invoke(${names.join(', ')})
    override fun toString(): String = "function " + name + REFLECTION_UNAVAILABLE
}`;
}

/**
 * \`kotlin.reflect\`: classes and callable references, as Kotlin/JVM provides them without its full reflection library,
 * which tells a class's names and a callable's name.
 */
export const REFLECT_SOURCE = `package kotlin.reflect

internal const val REFLECTION_UNAVAILABLE = " (Kotlin reflection is not available)"

interface KClassifier

interface KCallable<out R> {
    val name: String
}

interface KFunction<out R> : KCallable<R>, Function<R>

interface KProperty<out V> : KCallable<V> {
    override val name: String
}

interface KMutableProperty<V> : KProperty<V>

interface KProperty0<out V> : KProperty<V>, () -> V {
    fun get(): V
}

interface KMutableProperty0<V> : KProperty0<V>, KMutableProperty<V> {
    fun set(value: V)
}

interface KProperty1<T, out V> : KProperty<V>, (T) -> V {
    fun get(receiver: T): V
}

interface KMutableProperty1<T, V> : KProperty1<T, V>, KMutableProperty<V> {
    fun set(receiver: T, value: V)
}

external class PropertyReference : KProperty<Any?> {
    external override val name: String
}

internal class PropertyReference0<V>(override val name: String, private val getter: () -> V) : KProperty0<V> {
    override fun get(): V = getter()
    override fun invoke(): V = getter()
    override fun toString(): String = "property " + name + REFLECTION_UNAVAILABLE
}

internal class MutablePropertyReference0<V>(override val name: String, private val getter: () -> V, private val setter: (V) -> Unit) : KMutableProperty0<V> {
    override fun get(): V = getter()
    override fun set(value: V) = setter(value)
    override fun invoke(): V = getter()
    override fun toString(): String = "property " + name + REFLECTION_UNAVAILABLE
}

internal class PropertyReference1<T, V>(override val name: String, private val getter: (T) -> V) : KProperty1<T, V> {
    override fun get(receiver: T): V = getter(receiver)
    override fun invoke(p1: T): V = getter(p1)
    override fun toString(): String = "property " + name + REFLECTION_UNAVAILABLE
}

internal class MutablePropertyReference1<T, V>(override val name: String, private val getter: (T) -> V, private val setter: (T, V) -> Unit) : KMutableProperty1<T, V> {
    override fun get(receiver: T): V = getter(receiver)
    override fun set(receiver: T, value: V) = setter(receiver, value)
    override fun invoke(p1: T): V = getter(p1)
    override fun toString(): String = "property " + name + REFLECTION_UNAVAILABLE
}

external class KClass<T : Any> : KClassifier {
    external val simpleName: String?
    external val qualifiedName: String?
    external fun isInstance(value: Any?): Boolean
    external override fun equals(other: Any?): Boolean
    external override fun hashCode(): Int
    external override fun toString(): String
}

${Array.from({ length: REFERENCE_ARITY_COUNT }, (_, arity) => functionReferenceSource(arity)).join('\n\n')}
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
  ['java.io', 'IOException', 'Exception', 'java.io.IOException'],
  ['java.util.regex', 'PatternSyntaxException', 'IllegalArgumentException', 'java.util.regex.PatternSyntaxException'],
  ['java.io', 'FileNotFoundException', 'IOException', 'java.io.FileNotFoundException'],
  ['kotlin.io', 'ReadAfterEOFException', 'RuntimeException', 'kotlin.io.ReadAfterEOFException'],
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
