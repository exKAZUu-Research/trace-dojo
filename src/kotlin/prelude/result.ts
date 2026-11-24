import { kotlin } from './source';

/** `kotlin.Result` and `runCatching`, transcribed from Kotlin's standard library. */
export const RESULT_SOURCE = kotlin`
package kotlin

class Result<out T> internal constructor(internal val value: Any?) {
    val isSuccess: Boolean get() = value !is Failure
    val isFailure: Boolean get() = value is Failure

    @Suppress("UNCHECKED_CAST")
    fun getOrNull(): T? = if (value is Failure) null else value as T

    fun exceptionOrNull(): Throwable? {
        val failure = value
        return if (failure is Failure) failure.exception else null
    }

    override fun toString(): String = if (value is Failure) value.toString() else "Success($value)"
    override fun equals(other: Any?): Boolean = other is Result<*> && value == other.value
    override fun hashCode(): Int = value?.hashCode() ?: 0

    companion object {
        fun <T> success(value: T): Result<T> = Result(value)
        fun <T> failure(exception: Throwable): Result<T> = Result(Failure(exception))
    }

    internal class Failure(val exception: Throwable) {
        override fun equals(other: Any?): Boolean = other is Failure && exception == other.exception
        override fun hashCode(): Int = exception.hashCode()
        override fun toString(): String = "Failure($exception)"
    }
}

inline fun <R> runCatching(block: () -> R): Result<R> =
    try {
        Result.success(block())
    } catch (e: Throwable) {
        Result.failure(e)
    }

inline fun <T, R> T.runCatching(block: T.() -> R): Result<R> =
    try {
        Result.success(block())
    } catch (e: Throwable) {
        Result.failure(e)
    }

@Suppress("UNCHECKED_CAST")
fun <T> Result<T>.getOrThrow(): T {
    val failure = value
    if (failure is Result.Failure) throw failure.exception
    return failure as T
}

@Suppress("UNCHECKED_CAST")
inline fun <R, T : R> Result<T>.getOrElse(onFailure: (exception: Throwable) -> R): R {
    val exception = exceptionOrNull() ?: return value as T
    return onFailure(exception)
}

@Suppress("UNCHECKED_CAST")
fun <R, T : R> Result<T>.getOrDefault(defaultValue: R): R = if (isFailure) defaultValue else value as T

@Suppress("UNCHECKED_CAST")
inline fun <R, T> Result<T>.fold(onSuccess: (value: T) -> R, onFailure: (exception: Throwable) -> R): R {
    val exception = exceptionOrNull() ?: return onSuccess(value as T)
    return onFailure(exception)
}

@Suppress("UNCHECKED_CAST")
inline fun <R, T> Result<T>.map(transform: (value: T) -> R): Result<R> =
    if (isSuccess) Result.success(transform(value as T)) else Result(value)

@Suppress("UNCHECKED_CAST")
inline fun <R, T> Result<T>.mapCatching(transform: (value: T) -> R): Result<R> =
    if (isSuccess) runCatching { transform(value as T) } else Result(value)

@Suppress("UNCHECKED_CAST")
inline fun <R, T : R> Result<T>.recover(transform: (exception: Throwable) -> R): Result<R> {
    val exception = exceptionOrNull() ?: return this
    return Result.success(transform(exception))
}

inline fun <R, T : R> Result<T>.recoverCatching(transform: (exception: Throwable) -> R): Result<R> {
    val exception = exceptionOrNull() ?: return this
    return runCatching { transform(exception) }
}

inline fun <T> Result<T>.onFailure(action: (exception: Throwable) -> Unit): Result<T> {
    exceptionOrNull()?.let { action(it) }
    return this
}

@Suppress("UNCHECKED_CAST")
inline fun <T> Result<T>.onSuccess(action: (value: T) -> Unit): Result<T> {
    if (isSuccess) action(value as T)
    return this
}
`;

/** `kotlin.system.exitProcess`, which ends the program. */
export const SYSTEM_EXIT_SOURCE = kotlin`
package kotlin.system

external fun exitProcess(status: Int): Nothing
`;
