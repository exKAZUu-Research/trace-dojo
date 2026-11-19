/** The declarations of the collection, LINQ, and text library types, in C# (see `systemSource.ts`). */
export const COLLECTIONS_SOURCE = String.raw`
namespace System.Collections {
  public interface IEnumerable { IEnumerator GetEnumerator(); }
  public interface IEnumerator { object Current { get; } bool MoveNext(); void Reset(); }
  public interface ICollection : IEnumerable { int Count { get; } }
  public interface IList : ICollection { }
  public interface IDictionary : ICollection { }
  public interface IComparer { int Compare(object? x, object? y); }
  public interface IEqualityComparer { bool Equals(object? x, object? y); int GetHashCode(object obj); }
}

namespace System.Collections.Generic {
  public interface IEnumerable<out T> : System.Collections.IEnumerable { new IEnumerator<T> GetEnumerator(); }
  public interface IEnumerator<out T> : System.Collections.IEnumerator, IDisposable { new T Current { get; } }
  public interface IReadOnlyCollection<out T> : IEnumerable<T> { int Count { get; } }
  public interface IReadOnlyList<out T> : IReadOnlyCollection<T> { T this[int index] { get; } }
  public interface ICollection<T> : IEnumerable<T> {
    int Count { get; }
    bool IsReadOnly { get; }
    void Add(T item);
    void Clear();
    bool Contains(T item);
    void CopyTo(T[] array, int arrayIndex);
    bool Remove(T item);
  }
  public interface IList<T> : ICollection<T> {
    T this[int index] { get; set; }
    int IndexOf(T item);
    void Insert(int index, T item);
    void RemoveAt(int index);
  }
  public interface ISet<T> : ICollection<T> {
    new bool Add(T item);
    void UnionWith(IEnumerable<T> other);
    void IntersectWith(IEnumerable<T> other);
    void ExceptWith(IEnumerable<T> other);
    void SymmetricExceptWith(IEnumerable<T> other);
    bool IsSubsetOf(IEnumerable<T> other);
    bool IsSupersetOf(IEnumerable<T> other);
    bool Overlaps(IEnumerable<T> other);
    bool SetEquals(IEnumerable<T> other);
  }
  public interface IReadOnlySet<T> : IReadOnlyCollection<T> { bool Contains(T item); }
  public interface IReadOnlyDictionary<TKey, TValue> : IReadOnlyCollection<KeyValuePair<TKey, TValue>> {
    TValue this[TKey key] { get; }
    IEnumerable<TKey> Keys { get; }
    IEnumerable<TValue> Values { get; }
    bool ContainsKey(TKey key);
    bool TryGetValue(TKey key, out TValue value);
  }
  public interface IDictionary<TKey, TValue> : ICollection<KeyValuePair<TKey, TValue>> {
    TValue this[TKey key] { get; set; }
    ICollection<TKey> Keys { get; }
    ICollection<TValue> Values { get; }
    void Add(TKey key, TValue value);
    bool ContainsKey(TKey key);
    bool Remove(TKey key);
    bool TryGetValue(TKey key, out TValue value);
  }
  public interface IComparer<in T> { int Compare(T? x, T? y); }
  public interface IEqualityComparer<in T> { bool Equals(T? x, T? y); int GetHashCode(T obj); }

  public abstract class Comparer<T> : IComparer<T> {
    public static Comparer<T> Default { get; }
    public static Comparer<T> Create(Comparison<T> comparison);
    public abstract int Compare(T? x, T? y);
  }
  public abstract class EqualityComparer<T> : IEqualityComparer<T> {
    public static EqualityComparer<T> Default { get; }
    public static EqualityComparer<T> Create(Func<T?, T?, bool> equals, Func<T, int>? getHashCode = null);
    public abstract bool Equals(T? x, T? y);
    public abstract int GetHashCode(T obj);
  }

  public struct KeyValuePair<TKey, TValue> {
    private TKey key;
    private TValue value;
    public KeyValuePair(TKey key, TValue value);
    public TKey Key { get; }
    public TValue Value { get; }
    public void Deconstruct(out TKey key, out TValue value);
    public override string ToString();
  }
  public static class KeyValuePair {
    public static KeyValuePair<TKey, TValue> Create<TKey, TValue>(TKey key, TValue value);
  }

  public class List<T> : IList<T>, IReadOnlyList<T>, System.Collections.IList {
    public List();
    public List(int capacity);
    public List(IEnumerable<T> collection);
    public int Capacity { get; set; }
    public int Count { get; }
    public bool IsReadOnly { get; }
    public T this[int index] { get; set; }
    public void Add(T item);
    public void AddRange(IEnumerable<T> collection);
    public System.Collections.ObjectModel.ReadOnlyCollection<T> AsReadOnly();
    public int BinarySearch(T item);
    public int BinarySearch(T item, IComparer<T>? comparer);
    public void Clear();
    public bool Contains(T item);
    public List<TOutput> ConvertAll<TOutput>(Converter<T, TOutput> converter);
    public void CopyTo(T[] array);
    public void CopyTo(T[] array, int arrayIndex);
    public void CopyTo(int index, T[] array, int arrayIndex, int count);
    public bool Exists(Predicate<T> match);
    public T? Find(Predicate<T> match);
    public List<T> FindAll(Predicate<T> match);
    public int FindIndex(Predicate<T> match);
    public int FindIndex(int startIndex, Predicate<T> match);
    public T? FindLast(Predicate<T> match);
    public int FindLastIndex(Predicate<T> match);
    public void ForEach(Action<T> action);
    public Enumerator GetEnumerator();
    public List<T> GetRange(int index, int count);
    public List<T> Slice(int start, int length);
    public int IndexOf(T item);
    public int IndexOf(T item, int index);
    public int IndexOf(T item, int index, int count);
    public void Insert(int index, T item);
    public void InsertRange(int index, IEnumerable<T> collection);
    public int LastIndexOf(T item);
    public int LastIndexOf(T item, int index);
    public int LastIndexOf(T item, int index, int count);
    public bool Remove(T item);
    public int RemoveAll(Predicate<T> match);
    public void RemoveAt(int index);
    public void RemoveRange(int index, int count);
    public void Reverse();
    public void Reverse(int index, int count);
    public void Sort();
    public void Sort(Comparison<T> comparison);
    public void Sort(IComparer<T>? comparer);
    public void Sort(int index, int count, IComparer<T>? comparer);
    public T[] ToArray();
    public void TrimExcess();
    public bool TrueForAll(Predicate<T> match);
    public struct Enumerator : IEnumerator<T> {
      public T Current { get; }
      public bool MoveNext();
      public void Dispose();
    }
  }
  public class Dictionary<TKey, TValue> : IDictionary<TKey, TValue>, IReadOnlyDictionary<TKey, TValue> where TKey : notnull {
    public Dictionary();
    public Dictionary(int capacity);
    public Dictionary(IEqualityComparer<TKey>? comparer);
    public Dictionary(IDictionary<TKey, TValue> dictionary);
    public Dictionary(IEnumerable<KeyValuePair<TKey, TValue>> collection);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public TValue this[TKey key] { get; set; }
    public KeyCollection Keys { get; }
    public ValueCollection Values { get; }
    public IEqualityComparer<TKey> Comparer { get; }
    public void Add(TKey key, TValue value);
    public void Clear();
    public bool ContainsKey(TKey key);
    public bool ContainsValue(TValue value);
    public Enumerator GetEnumerator();
    public bool Remove(TKey key);
    public bool Remove(TKey key, out TValue value);
    public bool TryAdd(TKey key, TValue value);
    public bool TryGetValue(TKey key, out TValue value);
    public TValue GetValueOrDefault(TKey key);
    public TValue GetValueOrDefault(TKey key, TValue defaultValue);
    public void TrimExcess();
    public int EnsureCapacity(int capacity);
    public struct Enumerator : IEnumerator<KeyValuePair<TKey, TValue>> {
      public KeyValuePair<TKey, TValue> Current { get; }
      public bool MoveNext();
      public void Dispose();
    }
    public sealed class KeyCollection : ICollection<TKey>, IReadOnlyCollection<TKey> {
      public int Count { get; }
      public bool IsReadOnly { get; }
      public Enumerator GetEnumerator();
      public bool Contains(TKey item);
      public void CopyTo(TKey[] array, int index);
      public struct Enumerator : IEnumerator<TKey> {
        public TKey Current { get; }
        public bool MoveNext();
        public void Dispose();
      }
    }
    public sealed class ValueCollection : ICollection<TValue>, IReadOnlyCollection<TValue> {
      public int Count { get; }
      public bool IsReadOnly { get; }
      public Enumerator GetEnumerator();
      public bool Contains(TValue item);
      public void CopyTo(TValue[] array, int index);
      public struct Enumerator : IEnumerator<TValue> {
        public TValue Current { get; }
        public bool MoveNext();
        public void Dispose();
      }
    }
  }
  public class SortedDictionary<TKey, TValue> : IDictionary<TKey, TValue>, IReadOnlyDictionary<TKey, TValue> where TKey : notnull {
    public SortedDictionary();
    public SortedDictionary(IComparer<TKey>? comparer);
    public SortedDictionary(IDictionary<TKey, TValue> dictionary);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public TValue this[TKey key] { get; set; }
    public ICollection<TKey> Keys { get; }
    public ICollection<TValue> Values { get; }
    public void Add(TKey key, TValue value);
    public void Clear();
    public bool ContainsKey(TKey key);
    public bool ContainsValue(TValue value);
    public IEnumerator<KeyValuePair<TKey, TValue>> GetEnumerator();
    public bool Remove(TKey key);
    public bool TryAdd(TKey key, TValue value);
    public bool TryGetValue(TKey key, out TValue value);
  }
  public class SortedList<TKey, TValue> : IDictionary<TKey, TValue>, IReadOnlyDictionary<TKey, TValue> where TKey : notnull {
    public SortedList();
    public SortedList(IComparer<TKey>? comparer);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public TValue this[TKey key] { get; set; }
    public IList<TKey> Keys { get; }
    public IList<TValue> Values { get; }
    public void Add(TKey key, TValue value);
    public void Clear();
    public bool ContainsKey(TKey key);
    public bool ContainsValue(TValue value);
    public IEnumerator<KeyValuePair<TKey, TValue>> GetEnumerator();
    public int IndexOfKey(TKey key);
    public bool Remove(TKey key);
    public void RemoveAt(int index);
    public bool TryGetValue(TKey key, out TValue value);
  }
  public class HashSet<T> : ISet<T>, IReadOnlySet<T> {
    public HashSet();
    public HashSet(IEnumerable<T> collection);
    public HashSet(IEqualityComparer<T>? comparer);
    public HashSet(IEnumerable<T> collection, IEqualityComparer<T>? comparer);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public bool Add(T item);
    public void Clear();
    public bool Contains(T item);
    public void CopyTo(T[] array);
    public void CopyTo(T[] array, int arrayIndex);
    public void ExceptWith(IEnumerable<T> other);
    public Enumerator GetEnumerator();
    public void IntersectWith(IEnumerable<T> other);
    public bool IsProperSubsetOf(IEnumerable<T> other);
    public bool IsProperSupersetOf(IEnumerable<T> other);
    public bool IsSubsetOf(IEnumerable<T> other);
    public bool IsSupersetOf(IEnumerable<T> other);
    public bool Overlaps(IEnumerable<T> other);
    public bool Remove(T item);
    public int RemoveWhere(Predicate<T> match);
    public bool SetEquals(IEnumerable<T> other);
    public void SymmetricExceptWith(IEnumerable<T> other);
    public bool TryGetValue(T equalValue, out T actualValue);
    public void UnionWith(IEnumerable<T> other);
    public struct Enumerator : IEnumerator<T> {
      public T Current { get; }
      public bool MoveNext();
      public void Dispose();
    }
  }
  public class SortedSet<T> : ISet<T>, IReadOnlySet<T> {
    public SortedSet();
    public SortedSet(IEnumerable<T> collection);
    public SortedSet(IComparer<T>? comparer);
    public SortedSet(IEnumerable<T> collection, IComparer<T>? comparer);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public T? Min { get; }
    public T? Max { get; }
    public bool Add(T item);
    public void Clear();
    public bool Contains(T item);
    public void CopyTo(T[] array, int arrayIndex);
    public void ExceptWith(IEnumerable<T> other);
    public IEnumerator<T> GetEnumerator();
    public SortedSet<T> GetViewBetween(T? lowerValue, T? upperValue);
    public void IntersectWith(IEnumerable<T> other);
    public bool IsSubsetOf(IEnumerable<T> other);
    public bool IsSupersetOf(IEnumerable<T> other);
    public bool Overlaps(IEnumerable<T> other);
    public bool Remove(T item);
    public int RemoveWhere(Predicate<T> match);
    public IEnumerable<T> Reverse();
    public bool SetEquals(IEnumerable<T> other);
    public void SymmetricExceptWith(IEnumerable<T> other);
    public void UnionWith(IEnumerable<T> other);
  }
  public class Queue<T> : IReadOnlyCollection<T>, System.Collections.ICollection {
    public Queue();
    public Queue(int capacity);
    public Queue(IEnumerable<T> collection);
    public int Count { get; }
    public void Clear();
    public bool Contains(T item);
    public T Dequeue();
    public void Enqueue(T item);
    public Enumerator GetEnumerator();
    public T Peek();
    public T[] ToArray();
    public bool TryDequeue(out T result);
    public bool TryPeek(out T result);
    public void TrimExcess();
    public struct Enumerator : IEnumerator<T> {
      public T Current { get; }
      public bool MoveNext();
      public void Dispose();
    }
  }
  public class Stack<T> : IReadOnlyCollection<T>, System.Collections.ICollection {
    public Stack();
    public Stack(int capacity);
    public Stack(IEnumerable<T> collection);
    public int Count { get; }
    public void Clear();
    public bool Contains(T item);
    public Enumerator GetEnumerator();
    public T Peek();
    public T Pop();
    public void Push(T item);
    public T[] ToArray();
    public bool TryPeek(out T result);
    public bool TryPop(out T result);
    public void TrimExcess();
    public struct Enumerator : IEnumerator<T> {
      public T Current { get; }
      public bool MoveNext();
      public void Dispose();
    }
  }
  public class LinkedList<T> : ICollection<T>, IReadOnlyCollection<T> {
    public LinkedList();
    public LinkedList(IEnumerable<T> collection);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public LinkedListNode<T>? First { get; }
    public LinkedListNode<T>? Last { get; }
    public void Add(T item);
    public LinkedListNode<T> AddAfter(LinkedListNode<T> node, T value);
    public LinkedListNode<T> AddBefore(LinkedListNode<T> node, T value);
    public LinkedListNode<T> AddFirst(T value);
    public LinkedListNode<T> AddLast(T value);
    public void Clear();
    public bool Contains(T value);
    public void CopyTo(T[] array, int index);
    public LinkedListNode<T>? Find(T value);
    public LinkedListNode<T>? FindLast(T value);
    public IEnumerator<T> GetEnumerator();
    public bool Remove(T value);
    public void Remove(LinkedListNode<T> node);
    public void RemoveFirst();
    public void RemoveLast();
  }
  public sealed class LinkedListNode<T> {
    public LinkedListNode(T value);
    public LinkedList<T>? List { get; }
    public LinkedListNode<T>? Next { get; }
    public LinkedListNode<T>? Previous { get; }
    public T Value { get; set; }
  }
  public class PriorityQueue<TElement, TPriority> {
    public PriorityQueue();
    public PriorityQueue(IComparer<TPriority>? comparer);
    public int Count { get; }
    public void Clear();
    public TElement Dequeue();
    public void Enqueue(TElement element, TPriority priority);
    public TElement EnqueueDequeue(TElement element, TPriority priority);
    public TElement Peek();
    public bool TryDequeue(out TElement element, out TPriority priority);
    public bool TryPeek(out TElement element, out TPriority priority);
  }
  public class KeyNotFoundException : SystemException {
    public KeyNotFoundException();
    public KeyNotFoundException(string? message);
    public KeyNotFoundException(string? message, Exception? innerException);
  }
  public static class CollectionExtensions {
    public static TValue? GetValueOrDefault<TKey, TValue>(this IReadOnlyDictionary<TKey, TValue> dictionary, TKey key);
    public static TValue GetValueOrDefault<TKey, TValue>(this IReadOnlyDictionary<TKey, TValue> dictionary, TKey key, TValue defaultValue);
    public static bool TryAdd<TKey, TValue>(this IDictionary<TKey, TValue> dictionary, TKey key, TValue value);
  }
}

namespace System.Collections.ObjectModel {
  public class ReadOnlyCollection<T> : IList<T>, IReadOnlyList<T> {
    public ReadOnlyCollection(IList<T> list);
    public int Count { get; }
    public bool IsReadOnly { get; }
    public T this[int index] { get; }
    public bool Contains(T value);
    public int IndexOf(T value);
    public IEnumerator<T> GetEnumerator();
  }
}

namespace System.Linq {
  public interface IGrouping<out TKey, out TElement> : IEnumerable<TElement> { TKey Key { get; } }
  public interface ILookup<TKey, TElement> : IEnumerable<IGrouping<TKey, TElement>> {
    int Count { get; }
    IEnumerable<TElement> this[TKey key] { get; }
    bool Contains(TKey key);
  }
  public interface IOrderedEnumerable<out TElement> : IEnumerable<TElement> { }
  public static class Enumerable {
    public static TSource Aggregate<TSource>(this IEnumerable<TSource> source, Func<TSource, TSource, TSource> func);
    public static TAccumulate Aggregate<TSource, TAccumulate>(this IEnumerable<TSource> source, TAccumulate seed, Func<TAccumulate, TSource, TAccumulate> func);
    public static TResult Aggregate<TSource, TAccumulate, TResult>(this IEnumerable<TSource> source, TAccumulate seed, Func<TAccumulate, TSource, TAccumulate> func, Func<TAccumulate, TResult> resultSelector);
    public static bool All<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static bool Any<TSource>(this IEnumerable<TSource> source);
    public static bool Any<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<TSource> Append<TSource>(this IEnumerable<TSource> source, TSource element);
    public static IEnumerable<TSource> AsEnumerable<TSource>(this IEnumerable<TSource> source);
    public static decimal Average(this IEnumerable<decimal> source);
    public static double Average(this IEnumerable<double> source);
    public static double Average(this IEnumerable<int> source);
    public static double Average(this IEnumerable<long> source);
    public static float Average(this IEnumerable<float> source);
    public static decimal Average<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector);
    public static double Average<TSource>(this IEnumerable<TSource> source, Func<TSource, double> selector);
    public static double Average<TSource>(this IEnumerable<TSource> source, Func<TSource, int> selector);
    public static double Average<TSource>(this IEnumerable<TSource> source, Func<TSource, long> selector);
    public static float Average<TSource>(this IEnumerable<TSource> source, Func<TSource, float> selector);
    public static decimal? Average(this IEnumerable<decimal?> source);
    public static double? Average(this IEnumerable<double?> source);
    public static double? Average(this IEnumerable<int?> source);
    public static double? Average(this IEnumerable<long?> source);
    public static float? Average(this IEnumerable<float?> source);
    public static decimal? Average<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal?> selector);
    public static double? Average<TSource>(this IEnumerable<TSource> source, Func<TSource, double?> selector);
    public static double? Average<TSource>(this IEnumerable<TSource> source, Func<TSource, int?> selector);
    public static double? Average<TSource>(this IEnumerable<TSource> source, Func<TSource, long?> selector);
    public static float? Average<TSource>(this IEnumerable<TSource> source, Func<TSource, float?> selector);
    public static IEnumerable<TResult> Cast<TResult>(this System.Collections.IEnumerable source);
    public static IEnumerable<TSource[]> Chunk<TSource>(this IEnumerable<TSource> source, int size);
    public static IEnumerable<TSource> Concat<TSource>(this IEnumerable<TSource> first, IEnumerable<TSource> second);
    public static bool Contains<TSource>(this IEnumerable<TSource> source, TSource value);
    public static bool Contains<TSource>(this IEnumerable<TSource> source, TSource value, IEqualityComparer<TSource>? comparer);
    public static int Count<TSource>(this IEnumerable<TSource> source);
    public static int Count<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<KeyValuePair<TKey, int>> CountBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, IEqualityComparer<TKey>? keyComparer = null);
    public static IEnumerable<TSource?> DefaultIfEmpty<TSource>(this IEnumerable<TSource> source);
    public static IEnumerable<TSource> DefaultIfEmpty<TSource>(this IEnumerable<TSource> source, TSource defaultValue);
    public static IEnumerable<TSource> Distinct<TSource>(this IEnumerable<TSource> source);
    public static IEnumerable<TSource> Distinct<TSource>(this IEnumerable<TSource> source, IEqualityComparer<TSource>? comparer);
    public static IEnumerable<TSource> DistinctBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static TSource ElementAt<TSource>(this IEnumerable<TSource> source, int index);
    public static TSource? ElementAtOrDefault<TSource>(this IEnumerable<TSource> source, int index);
    public static IEnumerable<TResult> Empty<TResult>();
    public static IEnumerable<TSource> Except<TSource>(this IEnumerable<TSource> first, IEnumerable<TSource> second);
    public static IEnumerable<TSource> ExceptBy<TSource, TKey>(this IEnumerable<TSource> first, IEnumerable<TKey> second, Func<TSource, TKey> keySelector);
    public static TSource First<TSource>(this IEnumerable<TSource> source);
    public static TSource First<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static TSource? FirstOrDefault<TSource>(this IEnumerable<TSource> source);
    public static TSource FirstOrDefault<TSource>(this IEnumerable<TSource> source, TSource defaultValue);
    public static TSource? FirstOrDefault<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static TSource FirstOrDefault<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate, TSource defaultValue);
    public static IEnumerable<IGrouping<TKey, TSource>> GroupBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IEnumerable<IGrouping<TKey, TElement>> GroupBy<TSource, TKey, TElement>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, Func<TSource, TElement> elementSelector);
    public static IEnumerable<TResult> GroupBy<TSource, TKey, TResult>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, Func<TKey, IEnumerable<TSource>, TResult> resultSelector);
    public static IEnumerable<TResult> GroupJoin<TOuter, TInner, TKey, TResult>(this IEnumerable<TOuter> outer, IEnumerable<TInner> inner, Func<TOuter, TKey> outerKeySelector, Func<TInner, TKey> innerKeySelector, Func<TOuter, IEnumerable<TInner>, TResult> resultSelector);
    public static IEnumerable<(int Index, TSource Item)> Index<TSource>(this IEnumerable<TSource> source);
    public static IEnumerable<TSource> Intersect<TSource>(this IEnumerable<TSource> first, IEnumerable<TSource> second);
    public static IEnumerable<TSource> IntersectBy<TSource, TKey>(this IEnumerable<TSource> first, IEnumerable<TKey> second, Func<TSource, TKey> keySelector);
    public static IEnumerable<TResult> Join<TOuter, TInner, TKey, TResult>(this IEnumerable<TOuter> outer, IEnumerable<TInner> inner, Func<TOuter, TKey> outerKeySelector, Func<TInner, TKey> innerKeySelector, Func<TOuter, TInner, TResult> resultSelector);
    public static TSource Last<TSource>(this IEnumerable<TSource> source);
    public static TSource Last<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static TSource? LastOrDefault<TSource>(this IEnumerable<TSource> source);
    public static TSource LastOrDefault<TSource>(this IEnumerable<TSource> source, TSource defaultValue);
    public static TSource? LastOrDefault<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static long LongCount<TSource>(this IEnumerable<TSource> source);
    public static decimal Max(this IEnumerable<decimal> source);
    public static double Max(this IEnumerable<double> source);
    public static int Max(this IEnumerable<int> source);
    public static long Max(this IEnumerable<long> source);
    public static float Max(this IEnumerable<float> source);
    public static TSource? Max<TSource>(this IEnumerable<TSource> source);
    public static decimal Max<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector);
    public static double Max<TSource>(this IEnumerable<TSource> source, Func<TSource, double> selector);
    public static int Max<TSource>(this IEnumerable<TSource> source, Func<TSource, int> selector);
    public static long Max<TSource>(this IEnumerable<TSource> source, Func<TSource, long> selector);
    public static float Max<TSource>(this IEnumerable<TSource> source, Func<TSource, float> selector);
    public static TResult? Max<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, TResult> selector);
    public static TSource? MaxBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static decimal Min(this IEnumerable<decimal> source);
    public static double Min(this IEnumerable<double> source);
    public static int Min(this IEnumerable<int> source);
    public static long Min(this IEnumerable<long> source);
    public static float Min(this IEnumerable<float> source);
    public static TSource? Min<TSource>(this IEnumerable<TSource> source);
    public static decimal Min<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector);
    public static double Min<TSource>(this IEnumerable<TSource> source, Func<TSource, double> selector);
    public static int Min<TSource>(this IEnumerable<TSource> source, Func<TSource, int> selector);
    public static long Min<TSource>(this IEnumerable<TSource> source, Func<TSource, long> selector);
    public static float Min<TSource>(this IEnumerable<TSource> source, Func<TSource, float> selector);
    public static TResult? Min<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, TResult> selector);
    public static TSource? MinBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IEnumerable<TResult> OfType<TResult>(this System.Collections.IEnumerable source);
    public static IOrderedEnumerable<T> Order<T>(this IEnumerable<T> source);
    public static IOrderedEnumerable<T> Order<T>(this IEnumerable<T> source, IComparer<T>? comparer);
    public static IOrderedEnumerable<TSource> OrderBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IOrderedEnumerable<TSource> OrderBy<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, IComparer<TKey>? comparer);
    public static IOrderedEnumerable<TSource> OrderByDescending<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IOrderedEnumerable<TSource> OrderByDescending<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, IComparer<TKey>? comparer);
    public static IOrderedEnumerable<T> OrderDescending<T>(this IEnumerable<T> source);
    public static IEnumerable<TSource> Prepend<TSource>(this IEnumerable<TSource> source, TSource element);
    public static IEnumerable<int> Range(int start, int count);
    public static IEnumerable<TResult> Repeat<TResult>(TResult element, int count);
    public static IEnumerable<TSource> Reverse<TSource>(this IEnumerable<TSource> source);
    public static IEnumerable<TResult> Select<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, TResult> selector);
    public static IEnumerable<TResult> Select<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, int, TResult> selector);
    public static IEnumerable<TResult> SelectMany<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, IEnumerable<TResult>> selector);
    public static IEnumerable<TResult> SelectMany<TSource, TResult>(this IEnumerable<TSource> source, Func<TSource, int, IEnumerable<TResult>> selector);
    public static IEnumerable<TResult> SelectMany<TSource, TCollection, TResult>(this IEnumerable<TSource> source, Func<TSource, IEnumerable<TCollection>> collectionSelector, Func<TSource, TCollection, TResult> resultSelector);
    public static bool SequenceEqual<TSource>(this IEnumerable<TSource> first, IEnumerable<TSource> second);
    public static TSource Single<TSource>(this IEnumerable<TSource> source);
    public static TSource Single<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static TSource? SingleOrDefault<TSource>(this IEnumerable<TSource> source);
    public static TSource? SingleOrDefault<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<TSource> Skip<TSource>(this IEnumerable<TSource> source, int count);
    public static IEnumerable<TSource> SkipLast<TSource>(this IEnumerable<TSource> source, int count);
    public static IEnumerable<TSource> SkipWhile<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<TSource> SkipWhile<TSource>(this IEnumerable<TSource> source, Func<TSource, int, bool> predicate);
    public static decimal Sum(this IEnumerable<decimal> source);
    public static double Sum(this IEnumerable<double> source);
    public static int Sum(this IEnumerable<int> source);
    public static long Sum(this IEnumerable<long> source);
    public static float Sum(this IEnumerable<float> source);
    public static decimal Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector);
    public static double Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, double> selector);
    public static int Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, int> selector);
    public static long Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, long> selector);
    public static float Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, float> selector);
    public static decimal? Sum(this IEnumerable<decimal?> source);
    public static double? Sum(this IEnumerable<double?> source);
    public static int? Sum(this IEnumerable<int?> source);
    public static long? Sum(this IEnumerable<long?> source);
    public static float? Sum(this IEnumerable<float?> source);
    public static decimal? Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal?> selector);
    public static double? Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, double?> selector);
    public static int? Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, int?> selector);
    public static long? Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, long?> selector);
    public static float? Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, float?> selector);
    public static IEnumerable<TSource> Take<TSource>(this IEnumerable<TSource> source, int count);
    public static IEnumerable<TSource> TakeLast<TSource>(this IEnumerable<TSource> source, int count);
    public static IEnumerable<TSource> TakeWhile<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<TSource> TakeWhile<TSource>(this IEnumerable<TSource> source, Func<TSource, int, bool> predicate);
    public static IOrderedEnumerable<TSource> ThenBy<TSource, TKey>(this IOrderedEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IOrderedEnumerable<TSource> ThenBy<TSource, TKey>(this IOrderedEnumerable<TSource> source, Func<TSource, TKey> keySelector, IComparer<TKey>? comparer);
    public static IOrderedEnumerable<TSource> ThenByDescending<TSource, TKey>(this IOrderedEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static IOrderedEnumerable<TSource> ThenByDescending<TSource, TKey>(this IOrderedEnumerable<TSource> source, Func<TSource, TKey> keySelector, IComparer<TKey>? comparer);
    public static TSource[] ToArray<TSource>(this IEnumerable<TSource> source);
    public static Dictionary<TKey, TSource> ToDictionary<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector) where TKey : notnull;
    public static Dictionary<TKey, TElement> ToDictionary<TSource, TKey, TElement>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, Func<TSource, TElement> elementSelector) where TKey : notnull;
    public static Dictionary<TKey, TValue> ToDictionary<TKey, TValue>(this IEnumerable<KeyValuePair<TKey, TValue>> source) where TKey : notnull;
    public static HashSet<TSource> ToHashSet<TSource>(this IEnumerable<TSource> source);
    public static List<TSource> ToList<TSource>(this IEnumerable<TSource> source);
    public static ILookup<TKey, TSource> ToLookup<TSource, TKey>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector);
    public static ILookup<TKey, TElement> ToLookup<TSource, TKey, TElement>(this IEnumerable<TSource> source, Func<TSource, TKey> keySelector, Func<TSource, TElement> elementSelector);
    public static IEnumerable<TSource> Union<TSource>(this IEnumerable<TSource> first, IEnumerable<TSource> second);
    public static IEnumerable<TSource> UnionBy<TSource, TKey>(this IEnumerable<TSource> first, IEnumerable<TSource> second, Func<TSource, TKey> keySelector);
    public static IEnumerable<TSource> Where<TSource>(this IEnumerable<TSource> source, Func<TSource, bool> predicate);
    public static IEnumerable<TSource> Where<TSource>(this IEnumerable<TSource> source, Func<TSource, int, bool> predicate);
    public static IEnumerable<(TFirst First, TSecond Second)> Zip<TFirst, TSecond>(this IEnumerable<TFirst> first, IEnumerable<TSecond> second);
    public static IEnumerable<TResult> Zip<TFirst, TSecond, TResult>(this IEnumerable<TFirst> first, IEnumerable<TSecond> second, Func<TFirst, TSecond, TResult> resultSelector);
  }
}

namespace System.Linq.Internal {
  /** The generic collection interfaces of an array, which .NET implements for arrays in its SZArrayHelper. */
  public sealed class ArrayHelper<T> : IList<T>, IReadOnlyList<T> {
    public int Count { get; }
    public bool IsReadOnly { get; }
    public T this[int index] { get; set; }
    public void Add(T item);
    public void Clear();
    public bool Contains(T item);
    public void CopyTo(T[] array, int arrayIndex);
    public IEnumerator<T> GetEnumerator();
    public int IndexOf(T item);
    public void Insert(int index, T item);
    public bool Remove(T item);
    public void RemoveAt(int index);
  }
  public static class CollectionBuilder { public static void AddAll<T>(ICollection<T> target, IEnumerable<T> items); }
  public sealed class Iterator<T> : IOrderedEnumerable<T> { public IEnumerator<T> GetEnumerator(); }
  public sealed class Enumerator<T> : IEnumerator<T> { public T Current { get; } public bool MoveNext(); public void Reset(); public void Dispose(); }
  public sealed class Grouping<TKey, TElement> : IGrouping<TKey, TElement> { public TKey Key { get; } public IEnumerator<TElement> GetEnumerator(); }
  public sealed class Lookup<TKey, TElement> : ILookup<TKey, TElement> {
    public int Count { get; }
    public IEnumerable<TElement> this[TKey key] { get; }
    public bool Contains(TKey key);
    public IEnumerator<IGrouping<TKey, TElement>> GetEnumerator();
  }
}

namespace System.Text {
  public sealed class StringBuilder {
    public StringBuilder();
    public StringBuilder(int capacity);
    public StringBuilder(string? value);
    public int Length { get; set; }
    public int Capacity { get; set; }
    public char this[int index] { get; set; }
    public StringBuilder Append(bool value);
    public StringBuilder Append(char value);
    public StringBuilder Append(char value, int repeatCount);
    public StringBuilder Append(char[]? value);
    public StringBuilder Append(decimal value);
    public StringBuilder Append(double value);
    public StringBuilder Append(short value);
    public StringBuilder Append(int value);
    public StringBuilder Append(long value);
    public StringBuilder Append(object? value);
    public StringBuilder Append(sbyte value);
    public StringBuilder Append(float value);
    public StringBuilder Append(string? value);
    public StringBuilder Append(string? value, int startIndex, int count);
    public StringBuilder Append(StringBuilder? value);
    public StringBuilder Append(ushort value);
    public StringBuilder Append(uint value);
    public StringBuilder Append(ulong value);
    public StringBuilder Append(byte value);
    public StringBuilder AppendFormat(string format, object? arg0);
    public StringBuilder AppendFormat(string format, object? arg0, object? arg1);
    public StringBuilder AppendFormat(string format, object? arg0, object? arg1, object? arg2);
    public StringBuilder AppendFormat(string format, params object?[] args);
    public StringBuilder AppendJoin(string? separator, params object?[] values);
    public StringBuilder AppendJoin(string? separator, params string?[] values);
    public StringBuilder AppendJoin<T>(string? separator, IEnumerable<T> values);
    public StringBuilder AppendJoin(char separator, params object?[] values);
    public StringBuilder AppendLine();
    public StringBuilder AppendLine(string? value);
    public StringBuilder Clear();
    public bool Equals(StringBuilder? sb);
    public StringBuilder Insert(int index, bool value);
    public StringBuilder Insert(int index, char value);
    public StringBuilder Insert(int index, decimal value);
    public StringBuilder Insert(int index, double value);
    public StringBuilder Insert(int index, int value);
    public StringBuilder Insert(int index, long value);
    public StringBuilder Insert(int index, object? value);
    public StringBuilder Insert(int index, string? value);
    public StringBuilder Insert(int index, string? value, int count);
    public StringBuilder Remove(int startIndex, int length);
    public StringBuilder Replace(char oldChar, char newChar);
    public StringBuilder Replace(char oldChar, char newChar, int startIndex, int count);
    public StringBuilder Replace(string oldValue, string? newValue);
    public StringBuilder Replace(string oldValue, string? newValue, int startIndex, int count);
    public override string ToString();
    public string ToString(int startIndex, int length);
  }
}

namespace System.Text.RegularExpressions {
  public enum RegexOptions { None = 0, IgnoreCase = 1, Multiline = 2, ExplicitCapture = 4, Compiled = 8, Singleline = 16, IgnorePatternWhitespace = 32, RightToLeft = 64, ECMAScript = 256, CultureInvariant = 512, NonBacktracking = 1024 }
  public class Regex {
    public Regex(string pattern);
    public Regex(string pattern, RegexOptions options);
    public RegexOptions Options { get; }
    public bool IsMatch(string input);
    public Match Match(string input);
    public Match Match(string input, int startat);
    public MatchCollection Matches(string input);
    public string Replace(string input, string replacement);
    public string Replace(string input, MatchEvaluator evaluator);
    public string Replace(string input, string replacement, int count);
    public string[] Split(string input);
    public string[] GetGroupNames();
    public override string ToString();
    public static string Escape(string str);
    public static string Unescape(string str);
    public static bool IsMatch(string input, string pattern);
    public static bool IsMatch(string input, string pattern, RegexOptions options);
    public static Match Match(string input, string pattern);
    public static Match Match(string input, string pattern, RegexOptions options);
    public static MatchCollection Matches(string input, string pattern);
    public static MatchCollection Matches(string input, string pattern, RegexOptions options);
    public static string Replace(string input, string pattern, string replacement);
    public static string Replace(string input, string pattern, string replacement, RegexOptions options);
    public static string Replace(string input, string pattern, MatchEvaluator evaluator);
    public static string[] Split(string input, string pattern);
    public static string[] Split(string input, string pattern, RegexOptions options);
  }
  public sealed class RegexParseException : ArgumentException { }
  public delegate string MatchEvaluator(Match match);
  public class Capture {
    public int Index { get; }
    public int Length { get; }
    public string Value { get; }
    public override string ToString();
  }
  public class Group : Capture {
    public bool Success { get; }
    public string Name { get; }
  }
  public class Match : Group {
    public static Match Empty { get; }
    public virtual GroupCollection Groups { get; }
    public Match NextMatch();
    public virtual string Result(string replacement);
  }
  public class MatchCollection : IList<Match>, IReadOnlyList<Match> {
    public int Count { get; }
    public bool IsReadOnly { get; }
    public virtual Match this[int i] { get; }
    public IEnumerator<Match> GetEnumerator();
  }
  public class GroupCollection : IList<Group>, IReadOnlyList<Group> {
    public int Count { get; }
    public bool IsReadOnly { get; }
    public Group this[int groupnum] { get; }
    public Group this[string groupname] { get; }
    public IEnumerator<Group> GetEnumerator();
  }
}
`;
