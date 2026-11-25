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
}

namespace System.Collections.Generic {
  public interface IAsyncEnumerable<out T> { IAsyncEnumerator<T> GetAsyncEnumerator(); }
  public interface IAsyncEnumerator<out T> : IAsyncDisposable {
    T Current { get; }
    System.Threading.Tasks.ValueTask<bool> MoveNextAsync();
  }
}

namespace System.Threading.Tasks {
  public enum TaskStatus { Created = 0, WaitingForActivation = 1, WaitingToRun = 2, Running = 3, WaitingForChildrenToComplete = 4, RanToCompletion = 5, Canceled = 6, Faulted = 7 }
  public class Task : IDisposable {
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
    public static Task Run(Action action);
    public static Task<TResult> Run<TResult>(Func<TResult> function);
    public static Task Run(Func<Task?> function);
    public static Task<TResult> Run<TResult>(Func<Task<TResult>?> function);
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
    public TResult Result { get; }
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
  }
  public class TaskCompletionSource<TResult> {
    public TaskCompletionSource();
    public Task<TResult> Task { get; }
    public void SetResult(TResult result);
    public bool TrySetResult(TResult result);
    public void SetException(Exception exception);
    public bool TrySetException(Exception exception);
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
