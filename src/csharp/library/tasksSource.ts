/**
 * The declarations of the library's asynchronous programming types, in C#: tasks, their awaiters, and the async
 * stream and disposal interfaces. Members without bodies are implemented natively (see `nativesTasks.ts`).
 */
export const TASKS_SOURCE = String.raw`
namespace System {
  public interface IAsyncDisposable { System.Threading.Tasks.ValueTask DisposeAsync(); }
  public class AggregateException : Exception {
    public AggregateException();
    public AggregateException(string? message);
    public AggregateException(params Exception[] innerExceptions);
    public AggregateException(string? message, params Exception[] innerExceptions);
    public System.Collections.ObjectModel.ReadOnlyCollection<Exception> InnerExceptions { get; }
    public AggregateException Flatten();
    public override string Message { get; }
  }
  public class OperationCanceledException : SystemException {
    public OperationCanceledException();
    public OperationCanceledException(string? message);
    public OperationCanceledException(string? message, Exception? innerException);
    public OperationCanceledException(System.Threading.CancellationToken token);
    public OperationCanceledException(string? message, System.Threading.CancellationToken token);
    public OperationCanceledException(string? message, Exception? innerException, System.Threading.CancellationToken token);
    public System.Threading.CancellationToken CancellationToken { get; }
  }
  public class Lazy<T> {
    public Lazy();
    public Lazy(bool isThreadSafe);
    public Lazy(Func<T> valueFactory);
    public Lazy(Func<T> valueFactory, bool isThreadSafe);
    public Lazy(Func<T> valueFactory, System.Threading.LazyThreadSafetyMode mode);
    public Lazy(System.Threading.LazyThreadSafetyMode mode);
    public Lazy(T value);
    public bool IsValueCreated { get; }
    public T Value { get; }
    public override string? ToString();
  }
}

namespace System.Threading {
  public enum LazyThreadSafetyMode { None = 0, PublicationOnly = 1, ExecutionAndPublication = 2 }
  public static class Timeout {
    public const int Infinite = -1;
    public static readonly TimeSpan InfiniteTimeSpan = new TimeSpan(0, 0, 0, 0, -1);
  }
  public sealed class Thread {
    public static void Sleep(int millisecondsTimeout);
    public static void Sleep(TimeSpan timeout);
  }
  public class CancellationTokenSource : IDisposable {
    public CancellationTokenSource();
    public CancellationTokenSource(int millisecondsDelay);
    public CancellationTokenSource(TimeSpan delay);
    public bool IsCancellationRequested { get; }
    public CancellationToken Token { get; }
    public void Cancel();
    public System.Threading.Tasks.Task CancelAsync();
    public void CancelAfter(int millisecondsDelay);
    public void CancelAfter(TimeSpan delay);
    public bool TryReset();
    public void Dispose();
    public static CancellationTokenSource CreateLinkedTokenSource(CancellationToken token);
    public static CancellationTokenSource CreateLinkedTokenSource(CancellationToken token1, CancellationToken token2);
    public static CancellationTokenSource CreateLinkedTokenSource(params CancellationToken[] tokens);
  }
  public readonly struct CancellationToken : IEquatable<CancellationToken> {
    private readonly CancellationTokenSource? _source;
    public CancellationToken(bool canceled);
    public static CancellationToken None { get; }
    public bool IsCancellationRequested { get; }
    public bool CanBeCanceled { get; }
    public void ThrowIfCancellationRequested();
    public CancellationTokenRegistration Register(Action callback);
    public CancellationTokenRegistration Register(Action callback, bool useSynchronizationContext);
    public CancellationTokenRegistration Register(Action<object?> callback, object? state);
    public bool Equals(CancellationToken other);
    public override bool Equals(object? other);
    public override int GetHashCode();
    public static bool operator ==(CancellationToken left, CancellationToken right);
    public static bool operator !=(CancellationToken left, CancellationToken right);
  }
  public readonly struct CancellationTokenRegistration : IDisposable, IEquatable<CancellationTokenRegistration> {
    private readonly CancellationTokenSource? _source;
    private readonly long _id;
    public CancellationToken Token { get; }
    public void Dispose();
    public bool Unregister();
    public bool Equals(CancellationTokenRegistration other);
    public override bool Equals(object? obj);
    public override int GetHashCode();
  }
}

namespace System.Collections.Generic {
  public interface IAsyncEnumerable<out T> { IAsyncEnumerator<T> GetAsyncEnumerator(); }
  public interface IAsyncEnumerator<out T> : IAsyncDisposable {
    T Current { get; }
    System.Threading.Tasks.ValueTask<bool> MoveNextAsync();
  }
}

namespace System.Threading.Tasks {
  public class TaskCanceledException : OperationCanceledException {
    public TaskCanceledException();
    public TaskCanceledException(string? message);
    public TaskCanceledException(string? message, Exception? innerException);
    public TaskCanceledException(string? message, Exception? innerException, System.Threading.CancellationToken token);
    public TaskCanceledException(Task? task);
    public Task? Task { get; }
  }
  [Flags] public enum TaskContinuationOptions { None = 0, PreferFairness = 1, LongRunning = 2, AttachedToParent = 4, DenyChildAttach = 8, HideScheduler = 16, LazyCancellation = 32, RunContinuationsAsynchronously = 64, NotOnRanToCompletion = 65536, NotOnFaulted = 131072, OnlyOnCanceled = 196608, NotOnCanceled = 262144, OnlyOnFaulted = 327680, OnlyOnRanToCompletion = 393216, ExecuteSynchronously = 524288 }
  [Flags] public enum TaskCreationOptions { None = 0, PreferFairness = 1, LongRunning = 2, AttachedToParent = 4, DenyChildAttach = 8, HideScheduler = 16, RunContinuationsAsynchronously = 64 }
  public class TaskFactory {
    public Task StartNew(Action action);
    public Task StartNew(Action action, System.Threading.CancellationToken cancellationToken);
    public Task StartNew(Action action, TaskCreationOptions creationOptions);
    public Task StartNew(Action<object?> action, object? state);
    public Task StartNew(Action<object?> action, object? state, System.Threading.CancellationToken cancellationToken);
    public Task StartNew(Action<object?> action, object? state, TaskCreationOptions creationOptions);
    public Task<TResult> StartNew<TResult>(Func<TResult> function);
    public Task<TResult> StartNew<TResult>(Func<TResult> function, System.Threading.CancellationToken cancellationToken);
    public Task<TResult> StartNew<TResult>(Func<TResult> function, TaskCreationOptions creationOptions);
    public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state);
    public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state, System.Threading.CancellationToken cancellationToken);
    public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state, TaskCreationOptions creationOptions);
  }
  public static class TaskExtensions {
    public static Task Unwrap(this Task<Task> task);
    public static Task<TResult> Unwrap<TResult>(this Task<Task<TResult>> task);
  }
  public enum TaskStatus { Created = 0, WaitingForActivation = 1, WaitingToRun = 2, Running = 3, WaitingForChildrenToComplete = 4, RanToCompletion = 5, Canceled = 6, Faulted = 7 }
  public class Task : IDisposable {
    public Task(Action action);
    public Task(Action action, System.Threading.CancellationToken cancellationToken);
    public Task(Action<object?> action, object? state);
    public static TaskFactory Factory { get; }
    public object? AsyncState { get; }
    public void Start();
    public void RunSynchronously();
    public static Task CompletedTask { get; }
    public TaskStatus Status { get; }
    public bool IsCompleted { get; }
    public bool IsCompletedSuccessfully { get; }
    public bool IsFaulted { get; }
    public bool IsCanceled { get; }
    public AggregateException? Exception { get; }
    public int Id { get; }
    public static int? CurrentId { get; }
    public System.Runtime.CompilerServices.TaskAwaiter GetAwaiter();
    public System.Runtime.CompilerServices.ConfiguredTaskAwaitable ConfigureAwait(bool continueOnCapturedContext);
    public void Wait();
    public bool Wait(int millisecondsTimeout);
    public bool Wait(TimeSpan timeout);
    public void Dispose();
    public static Task Delay(int millisecondsDelay);
    public static Task Delay(TimeSpan delay);
    public static Task Delay(int millisecondsDelay, System.Threading.CancellationToken cancellationToken);
    public static Task Delay(TimeSpan delay, System.Threading.CancellationToken cancellationToken);
    public static Task Run(Action action);
    public static Task Run(Action action, System.Threading.CancellationToken cancellationToken);
    public static Task<TResult> Run<TResult>(Func<TResult> function);
    public static Task<TResult> Run<TResult>(Func<TResult> function, System.Threading.CancellationToken cancellationToken);
    public static Task Run(Func<Task?> function);
    public static Task Run(Func<Task?> function, System.Threading.CancellationToken cancellationToken);
    public static Task<TResult> Run<TResult>(Func<Task<TResult>?> function);
    public static Task<TResult> Run<TResult>(Func<Task<TResult>?> function, System.Threading.CancellationToken cancellationToken);
    public Task ContinueWith(Action<Task> continuationAction);
    public Task ContinueWith(Action<Task> continuationAction, System.Threading.CancellationToken cancellationToken);
    public Task ContinueWith(Action<Task> continuationAction, TaskContinuationOptions continuationOptions);
    public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction);
    public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction, System.Threading.CancellationToken cancellationToken);
    public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction, TaskContinuationOptions continuationOptions);
    public static Task FromCanceled(System.Threading.CancellationToken cancellationToken);
    public static Task<TResult> FromCanceled<TResult>(System.Threading.CancellationToken cancellationToken);
    public static Task<TResult> FromResult<TResult>(TResult result);
    public static Task FromException(Exception exception);
    public static Task<TResult> FromException<TResult>(Exception exception);
    public static Task WhenAll(params Task[] tasks);
    public static Task WhenAll(IEnumerable<Task> tasks);
    public static Task<TResult[]> WhenAll<TResult>(params Task<TResult>[] tasks);
    public static Task<TResult[]> WhenAll<TResult>(IEnumerable<Task<TResult>> tasks);
    public static Task<Task> WhenAny(params Task[] tasks);
    public static Task<Task> WhenAny(IEnumerable<Task> tasks);
    public static Task<Task<TResult>> WhenAny<TResult>(params Task<TResult>[] tasks);
    public static Task<Task<TResult>> WhenAny<TResult>(IEnumerable<Task<TResult>> tasks);
    public static void WaitAll(params Task[] tasks);
    public static int WaitAny(params Task[] tasks);
    public static System.Runtime.CompilerServices.YieldAwaitable Yield();
  }
  public class Task<TResult> : Task {
    public Task(Func<TResult> function);
    public Task(Func<TResult> function, System.Threading.CancellationToken cancellationToken);
    public Task(Func<object?, TResult> function, object? state);
    public TResult Result { get; }
    public Task ContinueWith(Action<Task<TResult>> continuationAction);
    public Task ContinueWith(Action<Task<TResult>> continuationAction, System.Threading.CancellationToken cancellationToken);
    public Task ContinueWith(Action<Task<TResult>> continuationAction, TaskContinuationOptions continuationOptions);
    public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction);
    public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction, System.Threading.CancellationToken cancellationToken);
    public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction, TaskContinuationOptions continuationOptions);
    public new System.Runtime.CompilerServices.TaskAwaiter<TResult> GetAwaiter();
    public new System.Runtime.CompilerServices.ConfiguredTaskAwaitable<TResult> ConfigureAwait(bool continueOnCapturedContext);
  }
  public class TaskCompletionSource {
    public TaskCompletionSource();
    public Task Task { get; }
    public void SetResult();
    public bool TrySetResult();
    public void SetException(Exception exception);
    public bool TrySetException(Exception exception);
    public void SetCanceled();
    public void SetCanceled(System.Threading.CancellationToken cancellationToken);
    public bool TrySetCanceled();
    public bool TrySetCanceled(System.Threading.CancellationToken cancellationToken);
  }
  public class TaskCompletionSource<TResult> {
    public TaskCompletionSource();
    public Task<TResult> Task { get; }
    public void SetResult(TResult result);
    public bool TrySetResult(TResult result);
    public void SetException(Exception exception);
    public bool TrySetException(Exception exception);
    public void SetCanceled();
    public void SetCanceled(System.Threading.CancellationToken cancellationToken);
    public bool TrySetCanceled();
    public bool TrySetCanceled(System.Threading.CancellationToken cancellationToken);
  }
  public readonly struct ValueTask {
    private readonly Task? _task;
    public ValueTask(Task task);
    public static ValueTask CompletedTask { get; }
    public bool IsCompleted { get; }
    public bool IsCompletedSuccessfully { get; }
    public bool IsFaulted { get; }
    public System.Runtime.CompilerServices.ValueTaskAwaiter GetAwaiter();
    public System.Runtime.CompilerServices.ConfiguredTaskAwaitable ConfigureAwait(bool continueOnCapturedContext);
    public Task AsTask();
    public static ValueTask<TResult> FromResult<TResult>(TResult result);
  }
  public readonly struct ValueTask<TResult> {
    private readonly Task<TResult>? _task;
    public ValueTask(TResult result);
    public ValueTask(Task<TResult> task);
    public TResult Result { get; }
    public bool IsCompleted { get; }
    public bool IsCompletedSuccessfully { get; }
    public bool IsFaulted { get; }
    public System.Runtime.CompilerServices.ValueTaskAwaiter<TResult> GetAwaiter();
    public System.Runtime.CompilerServices.ConfiguredTaskAwaitable<TResult> ConfigureAwait(bool continueOnCapturedContext);
    public Task<TResult> AsTask();
  }
}

namespace System.Runtime.CompilerServices {
  public interface INotifyCompletion { void OnCompleted(Action continuation); }
  public interface ICriticalNotifyCompletion : INotifyCompletion { void UnsafeOnCompleted(Action continuation); }
  public readonly struct TaskAwaiter : ICriticalNotifyCompletion {
    private readonly System.Threading.Tasks.Task _task;
    public bool IsCompleted { get; }
    public void GetResult();
    public void OnCompleted(Action continuation);
    public void UnsafeOnCompleted(Action continuation);
  }
  public readonly struct TaskAwaiter<TResult> : ICriticalNotifyCompletion {
    private readonly System.Threading.Tasks.Task<TResult> _task;
    public bool IsCompleted { get; }
    public TResult GetResult();
    public void OnCompleted(Action continuation);
    public void UnsafeOnCompleted(Action continuation);
  }
  public readonly struct ValueTaskAwaiter : ICriticalNotifyCompletion {
    private readonly System.Threading.Tasks.Task _task;
    public bool IsCompleted { get; }
    public void GetResult();
    public void OnCompleted(Action continuation);
    public void UnsafeOnCompleted(Action continuation);
  }
  public readonly struct ValueTaskAwaiter<TResult> : ICriticalNotifyCompletion {
    private readonly System.Threading.Tasks.Task<TResult> _task;
    public bool IsCompleted { get; }
    public TResult GetResult();
    public void OnCompleted(Action continuation);
    public void UnsafeOnCompleted(Action continuation);
  }
  public readonly struct ConfiguredTaskAwaitable {
    private readonly System.Threading.Tasks.Task _task;
    public ConfiguredTaskAwaiter GetAwaiter();
    public readonly struct ConfiguredTaskAwaiter : ICriticalNotifyCompletion {
      private readonly System.Threading.Tasks.Task _task;
      public bool IsCompleted { get; }
      public void GetResult();
      public void OnCompleted(Action continuation);
      public void UnsafeOnCompleted(Action continuation);
    }
  }
  public readonly struct ConfiguredTaskAwaitable<TResult> {
    private readonly System.Threading.Tasks.Task<TResult> _task;
    public ConfiguredTaskAwaiter GetAwaiter();
    public readonly struct ConfiguredTaskAwaiter : ICriticalNotifyCompletion {
      private readonly System.Threading.Tasks.Task<TResult> _task;
      public bool IsCompleted { get; }
      public TResult GetResult();
      public void OnCompleted(Action continuation);
      public void UnsafeOnCompleted(Action continuation);
    }
  }
  public readonly struct YieldAwaitable {
    public YieldAwaiter GetAwaiter();
    public readonly struct YieldAwaiter : ICriticalNotifyCompletion {
      public bool IsCompleted { get; }
      public void GetResult();
      public void OnCompleted(Action continuation);
      public void UnsafeOnCompleted(Action continuation);
    }
  }
}
`;
