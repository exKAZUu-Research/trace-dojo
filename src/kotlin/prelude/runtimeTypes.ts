import { kotlin } from './source';

/** Small packages of the prelude: output, reflection's property references, and trace-dojo's Turtle. */
export const IO_SOURCE = kotlin`
package kotlin.io

external fun println(message: Any?)
external fun println()
external fun print(message: Any?)
`;

/** `System.out` and `System.err`, which Kotlin programs reach through Java's `java.lang`. */
export const SYSTEM_SOURCE = kotlin`
package java.lang

class PrintStream internal constructor(private val isError: Boolean) {
    fun println(message: Any?) {
        writeStream(isError, message.toString() + "\\n")
    }
    fun println() {
        writeStream(isError, "\\n")
    }
    fun print(message: Any?) {
        writeStream(isError, message.toString())
    }
}

object System {
    val out: PrintStream = PrintStream(false)
    val err: PrintStream = PrintStream(true)
}

internal external fun writeStream(isError: Boolean, text: String)
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
];

/** The exception classes of the prelude, each with Throwable's four constructors. */
export function exceptionsSource(): string {
  const classes = EXCEPTIONS.map(
    ([, name, parent]) => `open external class ${name} : ${parent} {
    external constructor()
    external constructor(message: String?)
    external constructor(message: String?, cause: Throwable?)
    external constructor(cause: Throwable?)
}`
  );
  return `package kotlin\n\n${classes.join('\n\n')}\n`;
}
