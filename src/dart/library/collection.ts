/**
 * dart:collection as the interpreter declares it. The hash map and set transcribe the VM's `_HashMap` and `_HashSet`
 * (buckets indexed by `hashCode`, entries prepended, doubled when three quarters full), whose iteration order programs
 * see. The source must not contain `${`.
 */
export const COLLECTION_SOURCE = String.raw`
typedef IterableMixin<E> = Iterable<E>;
typedef IterableBase<E> = Iterable<E>;

// Lists the program implements

abstract mixin class ListBase<E> implements List<E> {
  const ListBase();
  static String listToString(List list) => Iterable.iterableToFullString(list, '[', ']');
  int get length;
  set length(int newLength);
  E operator [](int index);
  void operator []=(int index, E value);
  Iterator<E> get iterator => ListIterator<E>(this);
  E elementAt(int index) => this[index];
  Iterable<E> followedBy(Iterable<E> other) =>
      FollowedByIterable<E>.firstEfficient(this, other);
  void forEach(void Function(E element) action) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      action(this[i]);
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
  }
  bool get isEmpty => length == 0;
  bool get isNotEmpty => !isEmpty;
  E get first {
    if (length == 0) throw StateError("No element");
    return this[0];
  }
  void set first(E value) {
    if (length == 0) throw StateError("No element");
    this[0] = value;
  }
  E get last {
    if (length == 0) throw StateError("No element");
    return this[length - 1];
  }
  void set last(E value) {
    if (length == 0) throw StateError("No element");
    this[length - 1] = value;
  }
  E get single {
    if (length == 0) throw StateError("No element");
    if (length > 1) throw StateError("Too many elements");
    return this[0];
  }
  bool contains(Object? element) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (this[i] == element) return true;
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    return false;
  }
  bool every(bool Function(E element) test) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (!test(this[i])) return false;
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    return true;
  }
  bool any(bool Function(E element) test) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (test(this[i])) return true;
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    return false;
  }
  E firstWhere(bool Function(E element) test, {E Function()? orElse}) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      E element = this[i];
      if (test(element)) return element;
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E lastWhere(bool Function(E element) test, {E Function()? orElse}) {
    int length = this.length;
    for (int i = length - 1; i >= 0; i--) {
      E element = this[i];
      if (test(element)) return element;
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E singleWhere(bool Function(E element) test, {E Function()? orElse}) {
    int length = this.length;
    late E match;
    bool matchFound = false;
    for (int i = 0; i < length; i++) {
      E element = this[i];
      if (test(element)) {
        if (matchFound) {
          throw StateError("Too many elements");
        }
        matchFound = true;
        match = element;
      }
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    if (matchFound) return match;
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  String join([String separator = ""]) {
    if (length == 0) return "";
    StringBuffer buffer = StringBuffer()..writeAll(this, separator);
    return buffer.toString();
  }
  Iterable<E> where(bool Function(E element) test) => WhereIterable<E>(this, test);
  Iterable<T> whereType<T>() => WhereTypeIterable<T>(this);
  Iterable<T> map<T>(T Function(E element) f) => MappedListIterable<E, T>(this, f);
  Iterable<T> expand<T>(Iterable<T> Function(E element) f) =>
      ExpandIterable<E, T>(this, f);
  E reduce(E Function(E previousValue, E element) combine) {
    int length = this.length;
    if (length == 0) throw StateError("No element");
    E value = this[0];
    for (int i = 1; i < length; i++) {
      value = combine(value, this[i]);
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    return value;
  }
  T fold<T>(T initialValue, T Function(T previousValue, E element) combine) {
    var value = initialValue;
    int length = this.length;
    for (int i = 0; i < length; i++) {
      value = combine(value, this[i]);
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    return value;
  }
  Iterable<E> skip(int count) => SubListIterable<E>(this, count, null);
  Iterable<E> skipWhile(bool Function(E element) test) {
    return SkipWhileIterable<E>(this, test);
  }
  Iterable<E> take(int count) =>
      SubListIterable<E>(this, 0, count);
  Iterable<E> takeWhile(bool Function(E element) test) {
    return TakeWhileIterable<E>(this, test);
  }
  List<E> toList({bool growable = true}) {
    if (this.isEmpty) return List<E>.empty(growable: growable);
    var first = this[0];
    var result = List<E>.filled(this.length, first, growable: growable);
    for (int i = 1; i < this.length; i++) {
      result[i] = this[i];
    }
    return result;
  }
  Set<E> toSet() {
    Set<E> result = Set<E>();
    for (int i = 0; i < length; i++) {
      result.add(this[i]);
    }
    return result;
  }
  void add(E element) {
    this[this.length++] = element;
  }
  void addAll(Iterable<E> iterable) {
    int i = this.length;
    for (E element in iterable) {
      assert(this.length == i || (throw ConcurrentModificationError(this)));
      add(element);
      i++;
    }
  }
  bool remove(Object? element) {
    for (int i = 0; i < this.length; i++) {
      if (this[i] == element) {
        this._closeGap(i, i + 1);
        return true;
      }
    }
    return false;
  }
  void _closeGap(int start, int end) {
    int length = this.length;
    assert(0 <= start);
    assert(start < end);
    assert(end <= length);
    int size = end - start;
    for (int i = end; i < length; i++) {
      this[i - size] = this[i];
    }
    this.length = length - size;
  }
  void removeWhere(bool Function(E element) test) {
    _filter(test, false);
  }
  void retainWhere(bool Function(E element) test) {
    _filter(test, true);
  }
  void _filter(bool Function(E element) test, bool retainMatching) {
    List<E> retained = <E>[];
    int length = this.length;
    for (int i = 0; i < length; i++) {
      var element = this[i];
      if (test(element) == retainMatching) {
        retained.add(element);
      }
      if (length != this.length) {
        throw ConcurrentModificationError(this);
      }
    }
    if (retained.length != this.length) {
      this.setRange(0, retained.length, retained);
      this.length = retained.length;
    }
  }
  void clear() {
    this.length = 0;
  }
  List<R> cast<R>() => List.castFrom<E, R>(this);
  E removeLast() {
    if (length == 0) {
      throw StateError("No element");
    }
    E result = this[length - 1];
    length--;
    return result;
  }
  external void sort([int Function(E a, E b)? compare]);
  void shuffle([Random? random]) {
    random ??= Random();
    int length = this.length;
    while (length > 1) {
      int pos = random.nextInt(length);
      length -= 1;
      var tmp = this[length];
      this[length] = this[pos];
      this[pos] = tmp;
    }
  }
  Map<int, E> asMap() {
    return ListMapView<E>(this);
  }
  List<E> operator +(List<E> other) => [...this, ...other];
  List<E> sublist(int start, [int? end]) {
    int listLength = this.length;
    end ??= listLength;
    RangeError.checkValidRange(start, end, listLength);
    return List.of(getRange(start, end));
  }
  Iterable<E> getRange(int start, int end) {
    RangeError.checkValidRange(start, end, this.length);
    return SubListIterable<E>(this, start, end);
  }
  void removeRange(int start, int end) {
    RangeError.checkValidRange(start, end, this.length);
    if (end > start) {
      _closeGap(start, end);
    }
  }
  void fillRange(int start, int end, [E? fill]) {
    E value = fill as E;
    RangeError.checkValidRange(start, end, this.length);
    for (int i = start; i < end; i++) {
      this[i] = value;
    }
  }
  void setRange(int start, int end, Iterable<E> iterable, [int skipCount = 0]) {
    RangeError.checkValidRange(start, end, this.length);
    if (start == end) return;
    RangeError.checkNotNegative(skipCount, "skipCount");
    _copyRange(start, end, iterable, skipCount);
  }
  void _copyRange(int start, int end, Iterable<E> iterable, int skipCount) {
    int length = end - start;
    List<E> otherList;
    int otherStart;
    if (iterable is List<E>) {
      otherList = iterable;
      otherStart = skipCount;
    } else {
      otherList = iterable.skip(skipCount).toList(growable: false);
      otherStart = 0;
    }
    if (otherStart + length > otherList.length) {
      throw StateError("Too few elements");
    }
    if (otherStart < start) {
      for (int i = length - 1; i >= 0; i--) {
        this[start + i] = otherList[otherStart + i];
      }
    } else {
      for (int i = 0; i < length; i++) {
        this[start + i] = otherList[otherStart + i];
      }
    }
  }
  void replaceRange(int start, int end, Iterable<E> newContents) =>
      replaceListRange<E>(this, start, end, newContents, _closeGap);
  int indexOf(Object? element, [int start = 0]) {
    if (start < 0) start = 0;
    for (int i = start; i < this.length; i++) {
      if (this[i] == element) return i;
    }
    return -1;
  }
  int indexWhere(bool Function(E element) test, [int start = 0]) {
    if (start < 0) start = 0;
    for (int i = start; i < this.length; i++) {
      if (test(this[i])) return i;
    }
    return -1;
  }
  int lastIndexOf(Object? element, [int? start]) {
    if (start == null || start >= this.length) start = this.length - 1;
    for (int i = start; i >= 0; i--) {
      if (this[i] == element) return i;
    }
    return -1;
  }
  int lastIndexWhere(bool Function(E element) test, [int? start]) {
    if (start == null || start >= this.length) start = this.length - 1;
    for (int i = start; i >= 0; i--) {
      if (test(this[i])) return i;
    }
    return -1;
  }
  void insert(int index, E element) {
    index;
    var length = this.length;
    RangeError.checkValueInInterval(index, 0, length, "index");
    add(element);
    if (index != length) {
      setRange(index + 1, length + 1, this, index);
      this[index] = element;
    }
  }
  E removeAt(int index) {
    E result = this[index];
    _closeGap(index, index + 1);
    return result;
  }
  void insertAll(int index, Iterable<E> iterable) {
    RangeError.checkValueInInterval(index, 0, length, "index");
    if (index == length) {
      addAll(iterable);
      return;
    }
    if (iterable is! EfficientLengthIterable || identical(iterable, this)) {
      iterable = iterable.toList();
    }
    int insertionLength = iterable.length;
    if (insertionLength == 0) {
      return;
    }
    int oldLength = length;
    for (int i = oldLength - insertionLength; i < oldLength; ++i) {
      add(this[i > 0 ? i : 0]);
    }
    if (iterable.length != insertionLength) {
      this.length -= insertionLength;
      throw ConcurrentModificationError(iterable);
    }
    int oldCopyStart = index + insertionLength;
    if (oldCopyStart < oldLength) {
      setRange(oldCopyStart, oldLength, this, index);
    }
    setAll(index, iterable);
  }
  void setAll(int index, Iterable<E> iterable) {
    if (iterable is List) {
      setRange(index, index + iterable.length, iterable);
    } else {
      for (E element in iterable) {
        this[index++] = element;
      }
    }
  }
  Iterable<E> get reversed => ReversedListIterable<E>(this);
  String toString() => Iterable.iterableToFullString(this, '[', ']');
}

/** The view Set.cast returns, as the SDK's CastSet (internal/cast.dart). */
class CastSet<S, T> extends CastIterableBase<S, T> implements Set<T> {
  final Set<S> _source;
  final Set<R> Function<R>()? _emptySet;
  CastSet(Set<S> source, [this._emptySet]) : _source = source, super(source);
  Set<R> cast<R>() => CastSet<S, R>(_source, _emptySet);
  bool add(T value) => _source.add(value as S);
  void addAll(Iterable<T> elements) => _source.addAll(CastIterable<T, S>(elements));
  bool containsAll(Iterable<Object?> elements) => _source.containsAll(elements);
  T? lookup(Object? key) => _source.lookup(key) as T?;
  bool remove(Object? value) => _source.remove(value);
  void removeAll(Iterable<Object?> elements) => _source.removeAll(elements);
  void retainAll(Iterable<Object?> elements) => _source.retainAll(elements);
  void removeWhere(bool Function(T element) test) => _source.removeWhere((S element) => test(element as T));
  void retainWhere(bool Function(T element) test) => _source.retainWhere((S element) => test(element as T));
  void clear() {
    _source.clear();
  }
  Set<T> toSet() => _newSet()..addAll(this);
  Set<T> union(Set<T> other) => toSet()..addAll(other);
  Set<T> intersection(Set<Object?> other) => _filter(other, true);
  Set<T> difference(Set<Object?> other) => _filter(other, false);
  Set<T> _newSet() {
    var factory = _emptySet;
    return factory == null ? <T>{} : factory<T>();
  }
  Set<T> _filter(Set<Object?> other, bool include) {
    if (_emptySet == null) {
      var source = include ? _source.intersection(other) : _source.difference(other);
      return CastSet<S, T>(source);
    }
    var result = _newSet();
    for (var element in this) {
      if (other.contains(element) == include) result.add(element);
    }
    return result;
  }
}

/** The view Map.cast returns, as the SDK's CastMap (internal/cast.dart). */
class CastMap<SK, SV, K, V> extends MapBase<K, V> {
  final Map<SK, SV> _source;
  CastMap(this._source);
  Map<RK, RV> cast<RK, RV>() => CastMap<SK, SV, RK, RV>(_source);
  bool containsValue(Object? value) => _source.containsValue(value);
  bool containsKey(Object? key) => _source.containsKey(key);
  V? operator [](Object? key) => _source[key] as V?;
  void operator []=(K key, V value) {
    _source[key as SK] = value as SV;
  }
  V putIfAbsent(K key, V Function() ifAbsent) => _source.putIfAbsent(key as SK, () => ifAbsent() as SV) as V;
  void addAll(Map<K, V> other) => _source.addAll(CastMap<K, V, SK, SV>(other));
  V? remove(Object? key) => _source.remove(key) as V?;
  void clear() {
    _source.clear();
  }
  void forEach(void Function(K key, V value) f) {
    _source.forEach((SK key, SV value) {
      f(key as K, value as V);
    });
  }
  Iterable<K> get keys => _source.keys.cast<K>();
  Iterable<V> get values => _source.values.cast<V>();
  int get length => _source.length;
  bool get isEmpty => _source.isEmpty;
  bool get isNotEmpty => _source.isNotEmpty;
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) {
    return _source.update(key as SK, (SV value) => update(value as V) as SV,
        ifAbsent: (ifAbsent == null) ? null : () => ifAbsent() as SV) as V;
  }
  void updateAll(V Function(K key, V value) update) {
    _source.updateAll((SK key, SV value) => update(key as K, value as V) as SV);
  }
  Iterable<MapEntry<K, V>> get entries =>
      _source.entries.map<MapEntry<K, V>>((MapEntry<SK, SV> e) => MapEntry<K, V>(e.key as K, e.value as V));
  void removeWhere(bool Function(K key, V value) test) {
    _source.removeWhere((SK key, SV value) => test(key as K, value as V));
  }
}

/** The view List.cast returns, as the SDK's CastList (internal/cast.dart). */
class CastList<S, T> extends ListBase<T> {
  final List<S> _source;
  CastList(this._source);
  List<R> cast<R>() => CastList<S, R>(_source);
  int get length => _source.length;
  bool get isEmpty => _source.isEmpty;
  bool get isNotEmpty => _source.isNotEmpty;
  bool contains(Object? other) => _source.contains(other);
  T operator [](int index) => _source[index] as T;
  void operator []=(int index, T value) {
    _source[index] = value as S;
  }
  void set length(int length) {
    _source.length = length;
  }
  void add(T value) {
    _source.add(value as S);
  }
  void addAll(Iterable<T> values) => _source.addAll(CastIterable<T, S>(values));
  void sort([int Function(T v1, T v2)? compare]) {
    _source.sort(compare == null ? null : (S v1, S v2) => compare(v1 as T, v2 as T));
  }
  void shuffle([Random? random]) {
    _source.shuffle(random);
  }
  void insert(int index, T element) {
    _source.insert(index, element as S);
  }
  void insertAll(int index, Iterable<T> elements) => _source.insertAll(index, CastIterable<T, S>(elements));
  void setAll(int index, Iterable<T> elements) => _source.setAll(index, CastIterable<T, S>(elements));
  bool remove(Object? value) => _source.remove(value);
  T removeAt(int index) => _source.removeAt(index) as T;
  T removeLast() => _source.removeLast() as T;
  void removeWhere(bool Function(T element) test) {
    _source.removeWhere((S element) => test(element as T));
  }
  void retainWhere(bool Function(T element) test) {
    _source.retainWhere((S element) => test(element as T));
  }
  Iterable<T> getRange(int start, int end) => CastIterable<S, T>(_source.getRange(start, end));
  void setRange(int start, int end, Iterable<T> elements, [int skipCount = 0]) {
    _source.setRange(start, end, CastIterable<T, S>(elements), skipCount);
  }
  void replaceRange(int start, int end, Iterable<T> elements) {
    _source.replaceRange(start, end, CastIterable<T, S>(elements));
  }
  void removeRange(int start, int end) {
    _source.removeRange(start, end);
  }
  void fillRange(int start, int end, [T? fillValue]) {
    _source.fillRange(start, end, fillValue as S);
  }
}

typedef ListMixin<E> = ListBase<E>;

class CodeUnits extends _UnmodifiableListBase<int> {
  external int get length;
  external int operator [](int index);
}

class _Uint8List extends ListBase<int> {
  external int get length;
  set length(int value) => throw UnsupportedError("Cannot resize a fixed-length list");
  external int operator [](int index);
  external void operator []=(int index, int value);
  external _Uint8List sublist(int start, [int? end]);
  Iterator<int> get iterator => _TypedListIterator<int>(this);
  Iterable<int> getRange(int start, [int? end]) => super.getRange(start, end ?? length);
  Iterable<T> map<T>(T Function(int) f) => EfficientLengthMappedIterable<int, T>(this, f);
  int indexOf(covariant int element, [int start = 0]) => super.indexOf(element, start);
  int lastIndexOf(covariant int element, [int? start]) => super.lastIndexOf(element, start);
  void add(int value) => throw UnsupportedError("Cannot add to a fixed-length list");
  void addAll(Iterable<int> values) => throw UnsupportedError("Cannot add to a fixed-length list");
  void insert(int index, int value) => throw UnsupportedError("Cannot insert into a fixed-length list");
  void insertAll(int index, Iterable<int> values) => throw UnsupportedError("Cannot insert into a fixed-length list");
  bool remove(Object? element) => throw _cannotRemove();
  void removeWhere(bool Function(int) test) => throw _cannotRemove();
  void retainWhere(bool Function(int) test) => throw _cannotRemove();
  int removeAt(int index) => throw _cannotRemove();
  int removeLast() => throw _cannotRemove();
  void removeRange(int start, int end) => throw _cannotRemove();
  void replaceRange(int start, int end, Iterable<int> values) => throw _cannotRemove();
  void clear() => throw _cannotRemove();

  void setAll(int index, Iterable<int> iterable) => setRange(index, iterable.length + index, iterable);
  void setRange(int start, int end, Iterable<int> iterable, [int skipCount = 0]) {
    RangeError.checkValidRange(start, end, length);
    RangeError.checkNotNegative(skipCount, "skipCount");
    _copyRange(start, end, iterable, skipCount);
  }
  void fillRange(int start, int end, [int? fillValue]) {
    RangeError.checkValidRange(start, end, length);
    if (start == end) return;
    if (fillValue == null) throw ArgumentError.notNull("fillValue");
    for (int index = start; index < end; index++) this[index] = fillValue;
  }
  UnsupportedError _cannotRemove() => UnsupportedError("Cannot remove from a fixed-length list");
}

class _TypedListIterator<E> implements Iterator<E> {
  final List<E> _source;
  final int _length;
  int _index = 0;
  E? _current;

  _TypedListIterator(List<E> source) : _source = source, _length = source.length;

  E get current => _current as E;

  bool moveNext() {
    if (_index >= _length) {
      _current = null;
      return false;
    }
    _current = _source[_index++];
    return true;
  }
}

abstract class _UnmodifiableListBase<E> extends ListBase<E> {
  set length(int newLength) => throw UnsupportedError("Cannot change the length of an unmodifiable list");
  void operator []=(int index, E value) => throw UnsupportedError("Cannot modify an unmodifiable list");
  set first(E value) => throw UnsupportedError("Cannot modify an unmodifiable list");
  set last(E value) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void setAll(int index, Iterable<E> values) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void setRange(int start, int end, Iterable<E> values, [int skipCount = 0]) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void fillRange(int start, int end, [E? fill]) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void sort([int Function(E a, E b)? compare]) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void shuffle([Random? random]) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void add(E value) => throw UnsupportedError("Cannot add to an unmodifiable list");
  void addAll(Iterable<E> iterable) => throw UnsupportedError("Cannot add to an unmodifiable list");
  void insert(int index, E value) => throw UnsupportedError("Cannot add to an unmodifiable list");
  void insertAll(int index, Iterable<E> values) => throw UnsupportedError("Cannot add to an unmodifiable list");
  bool remove(Object? element) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void removeWhere(bool Function(E) test) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void retainWhere(bool Function(E) test) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  E removeAt(int index) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  E removeLast() => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void removeRange(int start, int end) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void replaceRange(int start, int end, Iterable<E> values) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void clear() => throw UnsupportedError("Cannot clear an unmodifiable list");
}

class UnmodifiableListView<E> extends _UnmodifiableListBase<E> {
  final Iterable<E> _source;
  UnmodifiableListView(Iterable<E> source) : _source = source;
  int get length => _source.length;
  E operator [](int index) => _source.elementAt(index);
  List<R> cast<R>() => UnmodifiableListView<R>(_source.cast<R>());
}

// Maps the program implements

abstract mixin class MapBase<K, V> implements Map<K, V> {
  const MapBase();
  static String mapToString(Map<Object?, Object?> m) => _mapToString(m);
  Iterable<K> get keys;
  V? operator [](Object? key);
  void operator []=(K key, V value);
  V? remove(Object? key);
  void clear();
  Map<RK, RV> cast<RK, RV>() => Map.castFrom<K, V, RK, RV>(this);
  void forEach(void Function(K key, V value) action) {
    for (K key in keys) action(key, this[key] as V);
  }
  void addAll(Map<K, V> other) {
    other.forEach((K key, V value) {
      this[key] = value;
    });
  }
  bool containsValue(Object? value) {
    for (K key in keys) {
      if (this[key] == value) return true;
    }
    return false;
  }
  V putIfAbsent(K key, V Function() ifAbsent) {
    if (containsKey(key)) return this[key] as V;
    return this[key] = ifAbsent();
  }
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) {
    if (this.containsKey(key)) return this[key] = update(this[key] as V);
    if (ifAbsent != null) return this[key] = ifAbsent();
    throw ArgumentError.value(key, "key", "Key not in map.");
  }
  void updateAll(V Function(K key, V value) update) {
    for (var key in this.keys) this[key] = update(key, this[key] as V);
  }
  Iterable<MapEntry<K, V>> get entries => keys.map((K key) => MapEntry<K, V>(key, this[key] as V));
  Map<K2, V2> map<K2, V2>(MapEntry<K2, V2> Function(K key, V value) transform) {
    var result = <K2, V2>{};
    for (var key in this.keys) {
      var entry = transform(key, this[key] as V);
      result[entry.key] = entry.value;
    }
    return result;
  }
  void addEntries(Iterable<MapEntry<K, V>> newEntries) {
    for (var entry in newEntries) this[entry.key] = entry.value;
  }
  void removeWhere(bool Function(K key, V value) test) {
    var keysToRemove = <K>[];
    for (var key in keys) {
      if (test(key, this[key] as V)) keysToRemove.add(key);
    }
    for (var key in keysToRemove) this.remove(key);
  }
  bool containsKey(Object? key) => keys.contains(key);
  int get length => keys.length;
  bool get isEmpty => keys.isEmpty;
  bool get isNotEmpty => keys.isNotEmpty;
  Iterable<V> get values => _MapBaseValueIterable<K, V>(this);
  String toString() => MapBase.mapToString(this);
}

class _MapBaseValueIterable<K, V> extends EfficientLengthIterable<V> {
  final Map<K, V> _source;
  _MapBaseValueIterable(this._source);
  int get length => _source.length;
  bool get isEmpty => _source.isEmpty;
  bool get isNotEmpty => _source.isNotEmpty;
  V get first => _source[_source.keys.first] as V;
  V get single => _source[_source.keys.single] as V;
  V get last => _source[_source.keys.last] as V;
  Iterator<V> get iterator => _MapBaseValueIterator<K, V>(_source);
}

class _MapBaseValueIterator<K, V> implements Iterator<V> {
  final Map<K, V> _source;
  final Iterator<K> _keys;
  V? _current;

  _MapBaseValueIterator(Map<K, V> source) : _source = source, _keys = source.keys.iterator;

  V get current => _current as V;

  bool moveNext() {
    final moved = _keys.moveNext();
    _current = moved ? _source[_keys.current] : null;
    return moved;
  }
}

typedef MapMixin<K, V> = MapBase<K, V>;

abstract class _UnmodifiableMapBase<K, V> extends MapBase<K, V> {
  void operator []=(K key, V value) => throw UnsupportedError("Cannot modify unmodifiable map");
  V? remove(Object? key) => throw UnsupportedError("Cannot modify unmodifiable map");
  void clear() => throw UnsupportedError("Cannot modify unmodifiable map");
  void addAll(Map<K, V> other) => throw UnsupportedError("Cannot modify unmodifiable map");
  void addEntries(Iterable<MapEntry<K, V>> entries) => throw UnsupportedError("Cannot modify unmodifiable map");
  V putIfAbsent(K key, V Function() ifAbsent) => throw UnsupportedError("Cannot modify unmodifiable map");
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) => throw UnsupportedError("Cannot modify unmodifiable map");
  void updateAll(V Function(K key, V value) update) => throw UnsupportedError("Cannot modify unmodifiable map");
  void removeWhere(bool Function(K key, V value) test) => throw UnsupportedError("Cannot modify unmodifiable map");
}

class UnmodifiableMapView<K, V> extends _UnmodifiableMapBase<K, V> {
  final Map<K, V> _map;
  UnmodifiableMapView(Map<K, V> map) : _map = map;
  Map<RK, RV> cast<RK, RV>() => UnmodifiableMapView<RK, RV>(_map.cast<RK, RV>());
  V? operator [](Object? key) => _map[key];
  Iterable<K> get keys => _map.keys;
  Iterable<V> get values => _map.values;
  Iterable<MapEntry<K, V>> get entries => _map.entries;
  bool get isEmpty => _map.isEmpty;
  bool get isNotEmpty => _map.isNotEmpty;
  int get length => _map.length;
  bool containsKey(Object? key) => _map.containsKey(key);
  bool containsValue(Object? value) => _map.containsValue(value);
  void forEach(void Function(K, V) action) => _map.forEach(action);
  Map<KK, VV> map<KK, VV>(MapEntry<KK, VV> Function(K, V) transform) => _map.map<KK, VV>(transform);
  String toString() => _map.toString();
}

/** The map List.asMap returns: a view of the list, as the VM ListMapView. */
class ListMapView<E> extends _UnmodifiableMapBase<int, E> {
  final List<E> _values;
  ListMapView(this._values);
  E? operator [](Object? key) => containsKey(key) ? _values[key as int] : null;
  int get length => _values.length;
  Iterable<E> get values => SubListIterable<E>(_values, 0, null);
  Iterable<int> get keys => _ListIndicesIterable(_values);
  bool get isEmpty => _values.isEmpty;
  bool get isNotEmpty => _values.isNotEmpty;
  bool containsValue(Object? value) => _values.contains(value);
  bool containsKey(Object? key) => key is int && key >= 0 && key < length;
  void forEach(void Function(int key, E value) f) {
    int length = _values.length;
    for (int i = 0; i < length; i++) {
      f(i, _values[i]);
      if (length != _values.length) throw ConcurrentModificationError(_values);
    }
  }
}

class _ListIndicesIterable extends ListIterable<int> {
  final List<Object?> _backedList;
  _ListIndicesIterable(this._backedList);
  int get length => _backedList.length;
  int elementAt(int index) {
    RangeError.checkValidIndex(index, this);
    return index;
  }
}

// Sets the program implements

abstract mixin class SetBase<E> implements Set<E> {
  const SetBase();
  static String setToString(Set set) => Iterable.iterableToFullString(set, '{', '}');
  bool add(E value);
  bool contains(Object? element);
  E? lookup(Object? element);
  bool remove(Object? value);
  Iterator<E> get iterator;
  Set<E> toSet();
  int get length;
  bool get isEmpty => length == 0;
  bool get isNotEmpty => length != 0;
  Set<R> cast<R>() => Set.castFrom<E, R>(this);
  Iterable<E> followedBy(Iterable<E> other) => FollowedByIterable<E>.firstEfficient(this, other);
  Iterable<T> whereType<T>() => WhereTypeIterable<T>(this);
  void clear() {
    removeAll(toList());
  }
  void addAll(Iterable<E> elements) {
    for (E element in elements) add(element);
  }
  void removeAll(Iterable<Object?> elements) {
    for (Object? element in elements) remove(element);
  }
  void retainAll(Iterable<Object?> elements) {
    Set<E> toRemove = toSet();
    for (Object? o in elements) toRemove.remove(o);
    removeAll(toRemove);
  }
  void removeWhere(bool Function(E element) test) {
    List<Object?> toRemove = [];
    for (E element in this) {
      if (test(element)) toRemove.add(element);
    }
    removeAll(toRemove);
  }
  void retainWhere(bool Function(E element) test) {
    List<Object?> toRemove = [];
    for (E element in this) {
      if (!test(element)) toRemove.add(element);
    }
    removeAll(toRemove);
  }
  bool containsAll(Iterable<Object?> other) {
    for (var o in other) {
      if (!contains(o)) return false;
    }
    return true;
  }
  Set<E> union(Set<E> other) => toSet()..addAll(other);
  Set<E> intersection(Set<Object?> other) {
    Set<E> result = toSet();
    for (E element in this) {
      if (!other.contains(element)) result.remove(element);
    }
    return result;
  }
  Set<E> difference(Set<Object?> other) {
    Set<E> result = toSet();
    for (E element in this) {
      if (other.contains(element)) result.remove(element);
    }
    return result;
  }
  List<E> toList({bool growable = true}) => List<E>.of(this, growable: growable);
  Iterable<T> map<T>(T Function(E e) f) => EfficientLengthMappedIterable<E, T>(this, f);
  E get single {
    if (length > 1) throw StateError("Too many elements");
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    E result = it.current;
    return result;
  }
  String toString() => Iterable.iterableToFullString(this, '{', '}');
  Iterable<E> where(bool Function(E element) f) => WhereIterable<E>(this, f);
  Iterable<T> expand<T>(Iterable<T> Function(E element) f) => ExpandIterable<E, T>(this, f);
  void forEach(void Function(E element) f) {
    for (E element in this) f(element);
  }
  E reduce(E Function(E value, E element) combine) {
    Iterator<E> iterator = this.iterator;
    if (!iterator.moveNext()) throw StateError("No element");
    E value = iterator.current;
    while (iterator.moveNext()) value = combine(value, iterator.current);
    return value;
  }
  T fold<T>(T initialValue, T Function(T previousValue, E element) combine) {
    var value = initialValue;
    for (E element in this) value = combine(value, element);
    return value;
  }
  bool every(bool Function(E element) f) {
    for (E element in this) {
      if (!f(element)) return false;
    }
    return true;
  }
  String join([String separator = ""]) {
    var buffer = StringBuffer();
    buffer.writeAll(this, separator);
    return buffer.toString();
  }
  bool any(bool Function(E element) test) {
    for (E element in this) {
      if (test(element)) return true;
    }
    return false;
  }
  Iterable<E> take(int count) {
    RangeError.checkNotNegative(count, "takeCount");
    return EfficientLengthTakeIterable<E>(this, count);
  }
  Iterable<E> takeWhile(bool Function(E value) test) => TakeWhileIterable<E>(this, test);
  Iterable<E> skip(int count) {
    RangeError.checkNotNegative(count, "count");
    return EfficientLengthSkipIterable<E>(this, count);
  }
  Iterable<E> skipWhile(bool Function(E value) test) => SkipWhileIterable<E>(this, test);
  E get first {
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    return it.current;
  }
  E get last {
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    E result;
    do {
      result = it.current;
    } while (it.moveNext());
    return result;
  }
  E firstWhere(bool Function(E value) test, {E Function()? orElse}) {
    for (E element in this) {
      if (test(element)) return element;
    }
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E lastWhere(bool Function(E value) test, {E Function()? orElse}) {
    late E result;
    bool foundMatching = false;
    for (E element in this) {
      if (test(element)) {
        result = element;
        foundMatching = true;
      }
    }
    if (foundMatching) return result;
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E singleWhere(bool Function(E value) test, {E Function()? orElse}) {
    late E result;
    bool foundMatching = false;
    for (E element in this) {
      if (test(element)) {
        if (foundMatching) throw StateError("Too many elements");
        result = element;
        foundMatching = true;
      }
    }
    if (foundMatching) return result;
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E elementAt(int index) {
    RangeError.checkNotNegative(index, "index");
    int elementIndex = 0;
    for (E element in this) {
      if (index == elementIndex) return element;
      elementIndex++;
    }
    throw IndexError.withLength(index, elementIndex, indexable: this, name: "index");
  }
}

typedef SetMixin<E> = SetBase<E>;

// LinkedHashMap and LinkedHashSet are dart:core's map and set, which this library exports.

// Hash maps and sets, in the VM's bucket order

class _HashKeyPolicy<K> {
  final bool Function(K, K)? equals;
  final int Function(K)? hashCodeOf;
  final bool Function(dynamic)? isValidKey;
  final bool identity;
  const _HashKeyPolicy({this.equals, this.hashCodeOf, this.isValidKey, this.identity = false});
  bool accepts(Object? key) {
    if (identity) return true;
    final test = isValidKey;
    return test == null ? key is K : test(key);
  }
  int hash(Object? key) {
    if (identity) return identityHashCode(key);
    final hasher = hashCodeOf;
    return hasher == null ? key.hashCode : hasher(key as K);
  }
  bool equal(Object? left, Object? right) {
    if (identity) return identical(left, right);
    final compare = equals;
    return compare == null ? left == right : compare(left as K, right as K);
  }
}

abstract final class HashMap<K, V> implements Map<K, V> {
  factory HashMap({bool Function(K, K)? equals, int Function(K)? hashCode, bool Function(dynamic)? isValidKey}) {
    if (equals == null && hashCode == null && isValidKey == null) return _HashMap<K, V>();
    if (isValidKey == null && identical(equals, identical) && identical(hashCode, identityHashCode)) {
      return _IdentityHashMap<K, V>();
    }
    return _CustomHashMap<K, V>(_HashKeyPolicy<K>(equals: equals, hashCodeOf: hashCode, isValidKey: isValidKey));
  }
  factory HashMap.identity() => _IdentityHashMap<K, V>();
  factory HashMap.from(Map<dynamic, dynamic> other) {
    HashMap<K, V> result = _HashMap<K, V>();
    other.forEach((dynamic k, dynamic v) {
      result[k as K] = v as V;
    });
    return result;
  }
  factory HashMap.of(Map<K, V> other) => _HashMap<K, V>()..addAll(other);
  factory HashMap.fromIterable(Iterable iterable, {K Function(dynamic element)? key, V Function(dynamic element)? value}) {
    HashMap<K, V> map = _HashMap<K, V>();
    for (var element in iterable) {
      map[key == null ? element as K : key(element)] = value == null ? element as V : value(element);
    }
    return map;
  }
  factory HashMap.fromIterables(Iterable<K> keys, Iterable<V> values) {
    HashMap<K, V> map = _HashMap<K, V>();
    Iterator<K> keyIterator = keys.iterator;
    Iterator<V> valueIterator = values.iterator;
    bool hasNextKey = keyIterator.moveNext();
    bool hasNextValue = valueIterator.moveNext();
    while (hasNextKey && hasNextValue) {
      map[keyIterator.current] = valueIterator.current;
      hasNextKey = keyIterator.moveNext();
      hasNextValue = valueIterator.moveNext();
    }
    if (hasNextKey || hasNextValue) throw ArgumentError("Iterables do not have same length.");
    return map;
  }
  factory HashMap.fromEntries(Iterable<MapEntry<K, V>> entries) => _HashMap<K, V>()..addEntries(entries);
}

class _HashMapEntry<K, V> {
  final K key;
  V value;
  final int hashCode;
  _HashMapEntry<K, V>? next;
  _HashMapEntry(this.key, this.value, this.hashCode, this.next);
}

class _HashMap<K, V> extends MapBase<K, V> implements HashMap<K, V> {
  final _HashKeyPolicy<K>? _policy;
  _HashMap([this._policy]);
  bool _keysEqual(Object? left, Object? right) {
    final policy = _policy;
    return policy == null ? left == right : policy.equal(left, right);
  }
  int _elementCount = 0;
  List<_HashMapEntry<K, V>?> _buckets = List<_HashMapEntry<K, V>?>.filled(8, null);
  int _modificationCount = 0;
  int get length => _elementCount;
  bool get isEmpty => _elementCount == 0;
  bool get isNotEmpty => _elementCount != 0;
  Iterable<K> get keys => _HashMapKeyIterable<K, V>(this);
  Iterable<V> get values => _HashMapValueIterable<K, V>(this);
  bool containsKey(Object? key) {
    if (_policy != null && !_policy!.accepts(key)) return false;
    final hashCode = _policy?.hash(key) ?? key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && _keysEqual(entry.key, key)) return true;
      entry = entry.next;
    }
    return false;
  }
  bool containsValue(Object? value) {
    final buckets = _buckets;
    final length = buckets.length;
    for (int i = 0; i < length; i++) {
      var entry = buckets[i];
      while (entry != null) {
        if (entry.value == value) return true;
        entry = entry.next;
      }
    }
    return false;
  }
  V? operator [](Object? key) {
    if (_policy != null && !_policy!.accepts(key)) return null;
    final hashCode = _policy?.hash(key) ?? key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && _keysEqual(entry.key, key)) return entry.value;
      entry = entry.next;
    }
    return null;
  }
  void operator []=(K key, V value) {
    final hashCode = _policy?.hash(key) ?? key.hashCode;
    final buckets = _buckets;
    final length = buckets.length;
    final index = hashCode & (length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && _keysEqual(entry.key, key)) {
        entry.value = value;
        return;
      }
      entry = entry.next;
    }
    _addEntry(buckets, index, length, key, value, hashCode);
  }
  V putIfAbsent(K key, V Function() ifAbsent) {
    final hashCode = _policy?.hash(key) ?? key.hashCode;
    final buckets = _buckets;
    final length = buckets.length;
    final index = hashCode & (length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && _keysEqual(entry.key, key)) return entry.value;
      entry = entry.next;
    }
    final stamp = _modificationCount;
    final V value = ifAbsent();
    if (stamp == _modificationCount) {
      _addEntry(buckets, index, length, key, value, hashCode);
    } else {
      this[key] = value;
    }
    return value;
  }
  // The VM's _HashMap.update, which _CustomHashMap inherits: it hashes with key.hashCode and compares with ==.
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) {
    final identity = _policy?.identity ?? false;
    final hashCode = identity ? identityHashCode(key) : key.hashCode;
    final buckets = _buckets;
    final length = buckets.length;
    final index = hashCode & (length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && (identity ? identical(entry.key, key) : entry.key == key)) {
        return entry.value = update(entry.value);
      }
      entry = entry.next;
    }
    if (ifAbsent != null) {
      V newValue = ifAbsent();
      _addEntry(buckets, index, length, key, newValue, hashCode);
      return newValue;
    } else {
      throw ArgumentError.value(key, "key", "Key not in map.");
    }
  }
  void addAll(Map<K, V> other) {
    other.forEach((K key, V value) {
      this[key] = value;
    });
  }
  void forEach(void Function(K key, V value) action) {
    final stamp = _modificationCount;
    final buckets = _buckets;
    final length = buckets.length;
    for (int i = 0; i < length; i++) {
      var entry = buckets[i];
      while (entry != null) {
        action(entry.key, entry.value);
        if (stamp != _modificationCount) throw ConcurrentModificationError(this);
        entry = entry.next;
      }
    }
  }
  void removeWhere(bool Function(K key, V value) test) {
    final buckets = _buckets;
    var stamp = _modificationCount;
    for (int index = 0; index < buckets.length; index++) {
      var entry = buckets[index];
      _HashMapEntry<K, V>? previous;
      while (entry != null) {
        final remove = test(entry.key, entry.value);
        if (stamp != _modificationCount) throw ConcurrentModificationError(this);
        final next = entry.next;
        if (remove) {
          _removeEntry(entry, previous, index);
          stamp = _modificationCount;
        } else {
          previous = entry;
        }
        entry = next;
      }
    }
  }
  V? remove(Object? key) {
    if (_policy != null && !_policy!.accepts(key)) return null;
    final hashCode = _policy?.hash(key) ?? key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    _HashMapEntry<K, V>? previous = null;
    while (entry != null) {
      final next = entry.next;
      if (hashCode == entry.hashCode && _keysEqual(entry.key, key)) {
        _removeEntry(entry, previous, index);
        return entry.value;
      }
      previous = entry;
      entry = next;
    }
    return null;
  }
  void clear() {
    _buckets = List<_HashMapEntry<K, V>?>.filled(8, null);
    if (_elementCount > 0) {
      _elementCount = 0;
      _modificationCount = (_modificationCount + 1) & 0x3fffffff;
    }
  }
  void _removeEntry(_HashMapEntry<K, V> entry, _HashMapEntry<K, V>? previousInBucket, int bucketIndex) {
    if (previousInBucket == null) {
      _buckets[bucketIndex] = entry.next;
    } else {
      previousInBucket.next = entry.next;
    }
    _elementCount--;
    _modificationCount = (_modificationCount + 1) & 0x3fffffff;
  }
  void _addEntry(List<_HashMapEntry<K, V>?> buckets, int index, int length, K key, V value, int hashCode) {
    final entry = _HashMapEntry<K, V>(key, value, hashCode, buckets[index]);
    buckets[index] = entry;
    final newElements = _elementCount + 1;
    _elementCount = newElements;
    if ((newElements << 2) > ((length << 1) + length)) _resize();
    _modificationCount = (_modificationCount + 1) & 0x3fffffff;
  }
  void _resize() {
    final oldBuckets = _buckets;
    final oldLength = oldBuckets.length;
    final newLength = oldLength << 1;
    final newBuckets = List<_HashMapEntry<K, V>?>.filled(newLength, null);
    for (int i = 0; i < oldLength; i++) {
      var entry = oldBuckets[i];
      while (entry != null) {
        final next = entry.next;
        final hashCode = entry.hashCode;
        final index = hashCode & (newLength - 1);
        entry.next = newBuckets[index];
        newBuckets[index] = entry;
        entry = next;
      }
    }
    _buckets = newBuckets;
  }
  Set<K> _newKeySet() {
    final policy = _policy;
    if (policy == null) return _HashSet<K>();
    if (policy.identity) return _IdentityHashSet<K>();
    return _CustomHashSet<K>(policy);
  }
}

class _IdentityHashMap<K, V> extends _HashMap<K, V> {
  _IdentityHashMap() : super(_HashKeyPolicy<K>(identity: true));
}

class _CustomHashMap<K, V> extends _HashMap<K, V> {
  _CustomHashMap(_HashKeyPolicy<K> policy) : super(policy);
}

class _HashMapKeyIterable<K, V> extends EfficientLengthIterable<K> {
  final _HashMap<K, V> _map;
  _HashMapKeyIterable(this._map);
  int get length => _map.length;
  bool get isEmpty => _map.isEmpty;
  bool contains(Object? key) => _map.containsKey(key);
  Set<K> toSet() => _map._newKeySet()..addAll(this);
  Iterator<K> get iterator => _HashMapIterator<K, V, K>(_map, 0);
}

class _HashMapValueIterable<K, V> extends EfficientLengthIterable<V> {
  final _HashMap<K, V> _map;
  _HashMapValueIterable(this._map);
  int get length => _map.length;
  bool get isEmpty => _map.isEmpty;
  Iterator<V> get iterator => _HashMapIterator<K, V, V>(_map, 1);
}

class _HashMapIterator<K, V, E> implements Iterator<E> {
  final _HashMap<K, V> _map;
  final int _kind;
  final int _stamp;
  int _index = 0;
  _HashMapEntry<K, V>? _entry;
  E? _current;
  _HashMapIterator(this._map, this._kind) : _stamp = _map._modificationCount;
  bool moveNext() {
    if (_stamp != _map._modificationCount) throw ConcurrentModificationError(_map);
    var entry = _entry;
    if (entry != null) {
      final next = entry.next;
      if (next != null) {
        _entry = next;
        _current = (_kind == 0 ? next.key : next.value) as E;
        return true;
      }
      _entry = null;
    }
    final buckets = _map._buckets;
    final length = buckets.length;
    for (int i = _index; i < length; i++) {
      entry = buckets[i];
      if (entry != null) {
        _index = i + 1;
        _entry = entry;
        _current = (_kind == 0 ? entry.key : entry.value) as E;
        return true;
      }
    }
    _index = length;
    _current = null;
    return false;
  }
  E get current => _current as E;
}

abstract final class HashSet<E> implements Set<E> {
  factory HashSet({bool Function(E, E)? equals, int Function(E)? hashCode, bool Function(dynamic)? isValidKey}) {
    if (equals == null && hashCode == null && isValidKey == null) return _HashSet<E>();
    if (isValidKey == null && identical(equals, identical) && identical(hashCode, identityHashCode)) {
      return _IdentityHashSet<E>();
    }
    return _CustomHashSet<E>(_HashKeyPolicy<E>(equals: equals, hashCodeOf: hashCode, isValidKey: isValidKey));
  }
  factory HashSet.identity() => _IdentityHashSet<E>();
  factory HashSet.from(Iterable<dynamic> elements) {
    HashSet<E> result = _HashSet<E>();
    for (final e in elements) {
      result.add(e as E);
    }
    return result;
  }
  factory HashSet.of(Iterable<E> elements) => _HashSet<E>()..addAll(elements);
}

class _HashSetEntry<E> {
  final E key;
  final int hashCode;
  _HashSetEntry<E>? next;
  _HashSetEntry(this.key, this.hashCode, this.next);
}

class _HashSet<E> extends SetBase<E> implements HashSet<E> {
  final _HashKeyPolicy<E>? _policy;
  _HashSet([this._policy]);
  Set<R> cast<R>() => Set.castFrom<E, R>(this, newSet: _newSimilarSet);
  Set<R> _newSimilarSet<R>() => HashSet<R>();
  bool _keysEqual(Object? left, Object? right) {
    final policy = _policy;
    return policy == null ? left == right : policy.equal(left, right);
  }
  int _elementCount = 0;
  List<_HashSetEntry<E>?> _buckets = List<_HashSetEntry<E>?>.filled(8, null);
  int _modificationCount = 0;
  Iterator<E> get iterator => _HashSetIterator<E>(this);
  int get length => _elementCount;
  bool get isEmpty => _elementCount == 0;
  bool get isNotEmpty => _elementCount != 0;
  bool contains(Object? object) {
    if (_policy != null && !_policy!.accepts(object)) return false;
    int index = (_policy?.hash(object) ?? object.hashCode) & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      if (_keysEqual(entry.key, object)) return true;
      entry = entry.next;
    }
    return false;
  }
  E? lookup(Object? object) {
    if (_policy != null && !_policy!.accepts(object)) return null;
    int index = (_policy?.hash(object) ?? object.hashCode) & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      var key = entry.key;
      if (_keysEqual(key, object)) return key;
      entry = entry.next;
    }
    return null;
  }
  bool add(E element) {
    final hashCode = _policy?.hash(element) ?? element.hashCode;
    final index = hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      if (_keysEqual(entry.key, element)) return false;
      entry = entry.next;
    }
    _addEntry(element, hashCode, index);
    return true;
  }
  void addAll(Iterable<E> objects) {
    for (E object in objects) add(object);
  }
  void removeWhere(bool Function(E) test) => _filterWhere(test, true);
  void retainWhere(bool Function(E) test) => _filterWhere(test, false);
  void _filterWhere(bool Function(E) test, bool removeMatching) {
    final length = _buckets.length;
    for (int index = 0; index < length; index++) {
      var entry = _buckets[index];
      _HashSetEntry<E>? previous;
      while (entry != null) {
        final stamp = _modificationCount;
        final remove = test(entry.key) == removeMatching;
        if (stamp != _modificationCount) throw ConcurrentModificationError(this);
        final next = entry.next;
        if (remove) {
          _removeEntry(entry, previous, index);
        } else {
          previous = entry;
        }
        entry = next;
      }
    }
  }
  bool remove(Object? object) {
    if (_policy != null && !_policy!.accepts(object)) return false;
    final hashCode = _policy?.hash(object) ?? object.hashCode;
    final index = hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    _HashSetEntry<E>? previous = null;
    while (entry != null) {
      if (_keysEqual(entry.key, object)) {
        _removeEntry(entry, previous, index);
        return true;
      }
      previous = entry;
      entry = entry.next;
    }
    return false;
  }
  void _removeEntry(_HashSetEntry<E> entry, _HashSetEntry<E>? previous, int index) {
    final next = entry.next;
    entry.next = null;
    if (previous == null) {
      _buckets[index] = next;
    } else {
      previous.next = next;
    }
    _elementCount--;
    _modificationCount = (_modificationCount + 1) & 0x3fffffff;
  }
  void clear() {
    _buckets = List<_HashSetEntry<E>?>.filled(8, null);
    if (_elementCount > 0) {
      _elementCount = 0;
      _modificationCount = (_modificationCount + 1) & 0x3fffffff;
    }
  }
  void _addEntry(E key, int hashCode, int index) {
    _buckets[index] = _HashSetEntry<E>(key, hashCode, _buckets[index]);
    int newElements = _elementCount + 1;
    _elementCount = newElements;
    int length = _buckets.length;
    if (newElements > length * 3 ~/ 4) _resize();
    _modificationCount = (_modificationCount + 1) & 0x3fffffff;
  }
  void _resize() {
    int oldLength = _buckets.length;
    int newLength = oldLength << 1;
    var oldBuckets = _buckets;
    var newBuckets = List<_HashSetEntry<E>?>.filled(newLength, null);
    for (int i = 0; i < oldLength; i++) {
      var entry = oldBuckets[i];
      while (entry != null) {
        var next = entry.next;
        int newIndex = entry.hashCode & (newLength - 1);
        entry.next = newBuckets[newIndex];
        newBuckets[newIndex] = entry;
        entry = next;
      }
    }
    _buckets = newBuckets;
  }
  HashSet<E> _newSet() {
    final policy = _policy;
    if (policy == null) return _HashSet<E>();
    if (policy.identity) return _IdentityHashSet<E>();
    return _CustomHashSet<E>(policy);
  }
  Set<E> toSet() => _newSet()..addAll(this);
  Set<E> intersection(Set<Object?> other) => _filter(other, true);
  Set<E> difference(Set<Object?> other) => _filter(other, false);
  Set<E> _filter(Set<Object?> other, bool include) {
    var result = _newSet();
    for (var element in this) {
      if (other.contains(element) == include) result.add(element);
    }
    return result;
  }
}

class _IdentityHashSet<E> extends _HashSet<E> {
  _IdentityHashSet() : super(_HashKeyPolicy<E>(identity: true));
  Set<R> _newSimilarSet<R>() => HashSet<R>.identity();
}

class _CustomHashSet<E> extends _HashSet<E> {
  _CustomHashSet(_HashKeyPolicy<E> policy) : super(policy);
  bool containsAll(Iterable<Object?> elements) {
    final policy = _policy!;
    for (final element in elements) {
      if (!policy.accepts(element) || !contains(element)) return false;
    }
    return true;
  }
}

class _HashSetIterator<E> implements Iterator<E> {
  final _HashSet<E> _set;
  final int _modificationCount;
  int _index = 0;
  _HashSetEntry<E>? _next;
  E? _current;
  _HashSetIterator(this._set) : _modificationCount = _set._modificationCount;
  bool moveNext() {
    if (_modificationCount != _set._modificationCount) throw ConcurrentModificationError(_set);
    if (_next != null) {
      _current = _next!.key;
      _next = _next!.next;
      return true;
    }
    List<_HashSetEntry<E>?> buckets = _set._buckets;
    while (_index < buckets.length) {
      _next = buckets[_index];
      _index = _index + 1;
      if (_next != null) {
        _current = _next!.key;
        _next = _next!.next;
        return true;
      }
    }
    _current = null;
    return false;
  }
  E get current => _current as E;
}

// Sorted maps and sets

// As the SDK's _dynamicCompare, a key that is not Comparable fails the implicit cast of the parameter.
int _defaultCompare(dynamic a, dynamic b) => Comparable.compare(a, b);

class _SplayTreeNode<K> {
  final K key;
  _SplayTreeNode<K>? _left;
  _SplayTreeNode<K>? _right;
  _SplayTreeNode(this.key);
}

class _SplayTreeSetNode<K> extends _SplayTreeNode<K> {
  _SplayTreeSetNode(K key) : super(key);
}

class _SplayTreeMapNode<K, V> extends _SplayTreeNode<K> {
  V value;
  _SplayTreeMapNode(K key, this.value) : super(key);
}

/**
 * The SDK's top-down splay tree (collection/splay_tree.dart), held by SplayTreeMap and SplayTreeSet, which report
 * concurrent modification of themselves as the SDK's classes, which are the tree, do.
 */
class _SplayTree<K> {
  final Object _owner;
  _SplayTreeNode<K>? _root;
  int _count = 0;
  int _modificationCount = 0;
  int _splayCount = 0;
  final int Function(K, K) _compare;
  final bool Function(Object?)? _validKey;
  _SplayTree(this._owner, this._compare, this._validKey);

  int _splay(K key) {
    final root = _root;
    if (root == null) {
      _compare(key, key);
      return -1;
    }
    _SplayTreeNode<K>? right;
    _SplayTreeNode<K>? newTreeRight;
    _SplayTreeNode<K>? left;
    _SplayTreeNode<K>? newTreeLeft;
    var current = root;
    var compare = _compare;
    int comparison;
    while (true) {
      comparison = compare(current.key, key);
      if (comparison > 0) {
        var currentLeft = current._left;
        if (currentLeft == null) break;
        comparison = compare(currentLeft.key, key);
        if (comparison > 0) {
          current._left = currentLeft._right;
          currentLeft._right = current;
          current = currentLeft;
          currentLeft = current._left;
          if (currentLeft == null) break;
        }
        if (right == null) {
          newTreeRight = current;
        } else {
          right._left = current;
        }
        right = current;
        current = currentLeft;
      } else if (comparison < 0) {
        var currentRight = current._right;
        if (currentRight == null) break;
        comparison = compare(currentRight.key, key);
        if (comparison < 0) {
          current._right = currentRight._left;
          currentRight._left = current;
          current = currentRight;
          currentRight = current._right;
          if (currentRight == null) break;
        }
        if (left == null) {
          newTreeLeft = current;
        } else {
          left._right = current;
        }
        left = current;
        current = currentRight;
      } else {
        break;
      }
    }
    if (left != null) {
      left._right = current._left;
      current._left = newTreeLeft;
    }
    if (right != null) {
      right._left = current._right;
      current._right = newTreeRight;
    }
    if (!identical(_root, current)) {
      _root = current;
      _splayCount++;
    }
    return comparison;
  }

  _SplayTreeNode<K> _splayMin(_SplayTreeNode<K> node) {
    var current = node;
    var modified = 0;
    while (true) {
      var left = current._left;
      if (left != null) {
        current._left = left._right;
        left._right = current;
        current = left;
        modified = 1;
      } else {
        break;
      }
    }
    _splayCount += modified;
    return current;
  }

  _SplayTreeNode<K> _splayMax(_SplayTreeNode<K> node) {
    var current = node;
    var modified = 0;
    while (true) {
      var right = current._right;
      if (right != null) {
        current._right = right._left;
        right._left = current;
        current = right;
        modified = 1;
      } else {
        break;
      }
    }
    _splayCount += modified;
    return current;
  }

  void _removeRoot() {
    final root = _root!;
    final left = root._left;
    final right = root._right;
    if (left == null) {
      _root = right;
    } else if (right == null) {
      _root = left;
    } else {
      _root = _splayMax(left).._right = right;
    }
    _count--;
    _modificationCount++;
  }

  void _addNewRoot(_SplayTreeNode<K> node, int comparison) {
    final root = _root;
    if (root != null) {
      if (comparison < 0) {
        node._left = root;
        node._right = root._right;
        root._right = null;
      } else {
        node._right = root;
        node._left = root._left;
        root._left = null;
      }
    }
    _modificationCount++;
    _count++;
    _root = node;
  }

  void _clear() {
    _root = null;
    _count = 0;
    _modificationCount++;
  }

  _SplayTreeNode<K>? _untypedLookup(Object? key) {
    final isValidKey = _validKey;
    if (isValidKey == null) {
      if (key is! K) return null;
    } else {
      if (!isValidKey(key)) return null;
    }
    if (_splay(key as K) == 0) return _root;
    return null;
  }
}

final class SplayTreeMap<K, V> extends MapBase<K, V> {
  late final _SplayTree<K> _tree;
  SplayTreeMap([int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    _tree = _SplayTree<K>(this, compare ?? _defaultCompare, isValidKey);
  }
  factory SplayTreeMap.from(Map<Object?, Object?> other, [int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    if (other is Map<K, V>) return SplayTreeMap<K, V>.of(other, compare, isValidKey);
    SplayTreeMap<K, V> result = SplayTreeMap<K, V>(compare, isValidKey);
    other.forEach((dynamic k, dynamic v) {
      result[k] = v;
    });
    return result;
  }
  factory SplayTreeMap.of(Map<K, V> other, [int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) =>
      SplayTreeMap<K, V>(compare, isValidKey)..addAll(other);
  factory SplayTreeMap.fromIterable(Iterable iterable, {K Function(dynamic element)? key, V Function(dynamic element)? value, int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey}) {
    SplayTreeMap<K, V> map = SplayTreeMap<K, V>(compare, isValidKey);
    for (var element in iterable) {
      map[key == null ? element as K : key(element)] = value == null ? element as V : value(element);
    }
    return map;
  }
  factory SplayTreeMap.fromIterables(Iterable<K> keys, Iterable<V> values, [int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    SplayTreeMap<K, V> map = SplayTreeMap<K, V>(compare, isValidKey);
    Iterator<K> keyIterator = keys.iterator;
    Iterator<V> valueIterator = values.iterator;
    bool hasNextKey = keyIterator.moveNext();
    bool hasNextValue = valueIterator.moveNext();
    while (hasNextKey && hasNextValue) {
      map[keyIterator.current] = valueIterator.current;
      hasNextKey = keyIterator.moveNext();
      hasNextValue = valueIterator.moveNext();
    }
    if (hasNextKey || hasNextValue) throw ArgumentError("Iterables do not have same length.");
    return map;
  }
  V? operator [](Object? key) => (_tree._untypedLookup(key) as _SplayTreeMapNode<K, V>?)?.value;
  V? remove(Object? key) {
    final root = _tree._untypedLookup(key) as _SplayTreeMapNode<K, V>?;
    if (root == null) return null;
    _tree._removeRoot();
    return root.value;
  }
  void operator []=(K key, V value) {
    int comparison = _tree._splay(key);
    if (comparison == 0) {
      (_tree._root as _SplayTreeMapNode<K, V>).value = value;
      return;
    }
    _tree._addNewRoot(_SplayTreeMapNode<K, V>(key, value), comparison);
  }
  V putIfAbsent(K key, V Function() ifAbsent) {
    int comparison = _tree._splay(key);
    if (comparison == 0) return (_tree._root as _SplayTreeMapNode<K, V>).value;
    int originalModificationCount = _tree._modificationCount;
    int originalSplayCount = _tree._splayCount;
    V value = ifAbsent();
    if (originalModificationCount != _tree._modificationCount || originalSplayCount != _tree._splayCount) {
      comparison = _tree._splay(key);
      if (comparison == 0) {
        (_tree._root as _SplayTreeMapNode<K, V>).value = value;
        return value;
      }
    }
    _tree._addNewRoot(_SplayTreeMapNode<K, V>(key, value), comparison);
    return value;
  }
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) {
    var comparison = _tree._splay(key);
    if (comparison == 0) {
      final originalModificationCount = _tree._modificationCount;
      final originalSplayCount = _tree._splayCount;
      var newValue = update((_tree._root as _SplayTreeMapNode<K, V>).value);
      if (originalModificationCount != _tree._modificationCount) throw ConcurrentModificationError(this);
      if (originalSplayCount != _tree._splayCount) {
        comparison = _tree._splay(key);
        if (comparison != 0) throw ConcurrentModificationError(this);
      }
      (_tree._root as _SplayTreeMapNode<K, V>).value = newValue;
      return newValue;
    }
    if (ifAbsent != null) {
      final originalModificationCount = _tree._modificationCount;
      final originalSplayCount = _tree._splayCount;
      var newValue = ifAbsent();
      if (originalModificationCount != _tree._modificationCount) throw ConcurrentModificationError(this);
      if (originalSplayCount != _tree._splayCount) {
        comparison = _tree._splay(key);
        if (comparison == 0) throw ConcurrentModificationError(this);
      }
      _tree._addNewRoot(_SplayTreeMapNode<K, V>(key, newValue), comparison);
      return newValue;
    }
    throw ArgumentError.value(key, "key", "Key not in map.");
  }
  void updateAll(V Function(K key, V value) update) {
    if (_tree._root == null) return;
    var iterator = _SplayTreeMapEntryIterator<K, V>(_tree);
    while (iterator.moveNext()) {
      var node = iterator.current;
      var newValue = update(node.key, node.value);
      iterator._replaceValue(newValue);
    }
  }
  void addAll(Map<K, V> other) {
    other.forEach((K key, V value) {
      this[key] = value;
    });
  }
  bool get isEmpty => _tree._root == null;
  bool get isNotEmpty => !isEmpty;
  void forEach(void Function(K key, V value) f) {
    Iterator<MapEntry<K, V>> nodes = _SplayTreeMapEntryIterator<K, V>(_tree);
    while (nodes.moveNext()) {
      MapEntry<K, V> node = nodes.current;
      f(node.key, node.value);
    }
  }
  int get length => _tree._count;
  void clear() {
    _tree._clear();
  }
  bool containsKey(Object? key) => _tree._untypedLookup(key) != null;
  bool containsValue(Object? value) {
    int initialSplayCount = _tree._splayCount;
    bool visit(_SplayTreeNode<K>? node) {
      while (node != null) {
        if ((node as _SplayTreeMapNode<K, V>).value == value) return true;
        if (initialSplayCount != _tree._splayCount) throw ConcurrentModificationError(this);
        if (node._right != null && visit(node._right)) return true;
        node = node._left;
      }
      return false;
    }
    return visit(_tree._root);
  }
  Iterable<K> get keys => _SplayTreeKeyIterable<K, _SplayTreeMapNode<K, V>>(_tree);
  Iterable<V> get values => _SplayTreeValueIterable<K, V>(_tree);
  Iterable<MapEntry<K, V>> get entries => _SplayTreeMapEntryIterable<K, V>(_tree);
  K? firstKey() {
    final root = _tree._root;
    if (root == null) return null;
    return (_tree._root = _tree._splayMin(root)).key;
  }
  K? lastKey() {
    final root = _tree._root;
    if (root == null) return null;
    return (_tree._root = _tree._splayMax(root)).key;
  }
  K? lastKeyBefore(K key) {
    if (key == null) throw ArgumentError(key);
    if (_tree._root == null) return null;
    int comparison = _tree._splay(key);
    if (comparison < 0) return _tree._root!.key;
    _SplayTreeNode<K>? node = _tree._root!._left;
    if (node == null) return null;
    var nodeRight = node._right;
    while (nodeRight != null) {
      node = nodeRight;
      nodeRight = node._right;
    }
    return node!.key;
  }
  K? firstKeyAfter(K key) {
    if (key == null) throw ArgumentError(key);
    if (_tree._root == null) return null;
    int comparison = _tree._splay(key);
    if (comparison > 0) return _tree._root!.key;
    _SplayTreeNode<K>? node = _tree._root!._right;
    if (node == null) return null;
    var nodeLeft = node._left;
    while (nodeLeft != null) {
      node = nodeLeft;
      nodeLeft = node._left;
    }
    return node!.key;
  }
}

abstract class _SplayTreeIterator<K, T> implements Iterator<T> {
  final _SplayTree<K> _tree;
  final List<_SplayTreeNode<K>> _path = [];
  int? _modificationCount;
  int _splayCount;
  _SplayTreeIterator(_SplayTree<K> tree) : _tree = tree, _splayCount = tree._splayCount;
  T get current {
    if (_path.isEmpty) return null as T;
    var node = _path.last;
    return _getValue(node);
  }
  void _rebuildPath(K key) {
    _path.clear();
    var comparison = _tree._splay(key);
    if (comparison == 0) {
      _path.add(_tree._root!);
      _splayCount = _tree._splayCount;
      return;
    }
    throw ConcurrentModificationError(this);
  }
  bool moveNext() {
    if (_modificationCount != _tree._modificationCount) {
      if (_modificationCount == null) {
        _modificationCount = _tree._modificationCount;
        var node = _tree._root;
        while (node != null) {
          _path.add(node);
          node = node._left;
        }
        return _path.isNotEmpty;
      }
      throw ConcurrentModificationError(_tree._owner);
    }
    if (_path.isEmpty) return false;
    if (_splayCount != _tree._splayCount) _rebuildPath(_path.last.key);
    var node = _path.last;
    var next = node._right;
    if (next != null) {
      while (next != null) {
        _path.add(next);
        next = next._left;
      }
      return true;
    }
    _path.removeLast();
    while (_path.isNotEmpty && identical(_path.last._right, node)) {
      node = _path.removeLast();
    }
    return _path.isNotEmpty;
  }
  T _getValue(_SplayTreeNode<K> node);
}

class _SplayTreeKeyIterable<K, Node> extends EfficientLengthIterable<K> {
  final _SplayTree<K> _tree;
  _SplayTreeKeyIterable(this._tree);
  int get length => _tree._count;
  bool get isEmpty => _tree._count == 0;
  Iterator<K> get iterator => _SplayTreeKeyIterator<K, Node>(_tree);
  bool contains(Object? element) => _tree._untypedLookup(element) != null;
  Set<K> toSet() => SplayTreeSet<K>._copied(_tree);
}

class _SplayTreeValueIterable<K, V> extends EfficientLengthIterable<V> {
  final _SplayTree<K> _tree;
  _SplayTreeValueIterable(this._tree);
  int get length => _tree._count;
  bool get isEmpty => _tree._count == 0;
  Iterator<V> get iterator => _SplayTreeValueIterator<K, V>(_tree);
}

class _SplayTreeMapEntryIterable<K, V> extends EfficientLengthIterable<MapEntry<K, V>> {
  final _SplayTree<K> _tree;
  _SplayTreeMapEntryIterable(this._tree);
  int get length => _tree._count;
  bool get isEmpty => _tree._count == 0;
  Iterator<MapEntry<K, V>> get iterator => _SplayTreeMapEntryIterator<K, V>(_tree);
}

class _SplayTreeKeyIterator<K, Node> extends _SplayTreeIterator<K, K> {
  _SplayTreeKeyIterator(_SplayTree<K> tree) : super(tree);
  K _getValue(_SplayTreeNode<K> node) => node.key;
}

class _SplayTreeValueIterator<K, V> extends _SplayTreeIterator<K, V> {
  _SplayTreeValueIterator(_SplayTree<K> tree) : super(tree);
  V? _current;
  bool moveNext() {
    var result = super.moveNext();
    _current = result ? (_path.last as _SplayTreeMapNode<K, V>).value : null;
    return result;
  }
  V _getValue(_SplayTreeNode<K> node) => _current as V;
}

class _SplayTreeMapEntryIterator<K, V> extends _SplayTreeIterator<K, MapEntry<K, V>> {
  _SplayTreeMapEntryIterator(_SplayTree<K> tree) : super(tree);
  MapEntry<K, V>? _current;
  MapEntry<K, V> _getValue(_SplayTreeNode<K> node) =>
      _current ??= MapEntry<K, V>(node.key, (node as _SplayTreeMapNode<K, V>).value);
  bool moveNext() {
    _current = null;
    return super.moveNext();
  }
  void _replaceValue(V value) {
    if (_modificationCount != _tree._modificationCount) throw ConcurrentModificationError(_tree._owner);
    if (_splayCount != _tree._splayCount) _rebuildPath(_path.last.key);
    (_path.last as _SplayTreeMapNode<K, V>).value = value;
  }
}

final class SplayTreeSet<E> extends SetBase<E> {
  late final _SplayTree<E> _tree;
  SplayTreeSet([int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    _tree = _SplayTree<E>(this, compare ?? _defaultCompare, isValidKey);
  }
  SplayTreeSet._copied(_SplayTree<E> source) {
    _tree = _SplayTree<E>(this, source._compare, source._validKey);
    var root = source._root;
    if (root != null) {
      _tree._root = _copyNode(root);
      _tree._count = source._count;
    }
  }
  factory SplayTreeSet.from(Iterable elements, [int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    if (elements is Iterable<E>) return SplayTreeSet<E>.of(elements, compare, isValidKey);
    SplayTreeSet<E> result = SplayTreeSet<E>(compare, isValidKey);
    for (var element in elements) {
      result.add(element as dynamic);
    }
    return result;
  }
  factory SplayTreeSet.of(Iterable<E> elements, [int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) =>
      SplayTreeSet<E>(compare, isValidKey)..addAll(elements);
  Set<R> cast<R>() => Set.castFrom<E, R>(this, newSet: _newSimilarSet);
  Set<R> _newSimilarSet<R>() => SplayTreeSet<R>((a, b) => _tree._compare(a as E, b as E), _tree._validKey);
  Iterator<E> get iterator => _SplayTreeKeyIterator<E, _SplayTreeSetNode<E>>(_tree);
  int get length => _tree._count;
  bool get isEmpty => _tree._root == null;
  bool get isNotEmpty => _tree._root != null;
  E get first {
    final root = _tree._root;
    if (root == null) throw StateError("No element");
    return (_tree._root = _tree._splayMin(root)).key;
  }
  E get last {
    final root = _tree._root;
    if (root == null) throw StateError("No element");
    return (_tree._root = _tree._splayMax(root)).key;
  }
  E get single {
    if (_tree._count == 1) return _tree._root!.key;
    throw _tree._count == 0 ? StateError("No element") : StateError("Too many elements");
  }
  bool contains(Object? element) => _tree._untypedLookup(element) != null;
  bool add(E element) => _add(element);
  bool _add(E element) {
    int compare = _tree._splay(element);
    if (compare == 0) return false;
    _tree._addNewRoot(_SplayTreeSetNode<E>(element), compare);
    return true;
  }
  bool remove(Object? object) {
    if (_tree._untypedLookup(object) == null) return false;
    _tree._removeRoot();
    return true;
  }
  void addAll(Iterable<E> elements) {
    for (E element in elements) {
      _add(element);
    }
  }
  void removeAll(Iterable<Object?> elements) {
    for (Object? element in elements) {
      if (_tree._untypedLookup(element) != null) _tree._removeRoot();
    }
  }
  void retainAll(Iterable<Object?> elements) {
    SplayTreeSet<E> retainSet = SplayTreeSet<E>(_tree._compare, _tree._validKey);
    final int originalModificationCount = _tree._modificationCount;
    for (Object? object in elements) {
      if (originalModificationCount != _tree._modificationCount) throw ConcurrentModificationError(this);
      final root = _tree._untypedLookup(object);
      if (root != null) retainSet.add(root.key);
    }
    if (retainSet._tree._count != _tree._count) {
      _tree._root = retainSet._tree._root;
      _tree._count = retainSet._tree._count;
      _tree._modificationCount++;
    }
  }
  E? lookup(Object? object) => _tree._untypedLookup(object)?.key;
  Set<E> intersection(Set<Object?> other) => _filter(other, true);
  Set<E> difference(Set<Object?> other) => _filter(other, false);
  SplayTreeSet<E> _filter(Set<Object?> other, bool include) {
    _SplayTreeNode<E>? root = null;
    var count = 0;
    for (E element in this) {
      if (other.contains(element) == include) {
        root = _SplayTreeSetNode<E>(element).._left = root;
        count++;
      }
    }
    var result = SplayTreeSet<E>(_tree._compare, _tree._validKey);
    result._tree._root = root;
    result._tree._count = count;
    return result;
  }
  Set<E> union(Set<E> other) => _clone()..addAll(other);
  SplayTreeSet<E> _clone() => SplayTreeSet<E>._copied(_tree);
  void clear() {
    _tree._clear();
  }
  Set<E> toSet() => _clone();
  String toString() => Iterable.iterableToFullString(this, '{', '}');
}

_SplayTreeSetNode<E> _copyNode<E>(_SplayTreeNode<E> source) {
  _SplayTreeSetNode<E> result = _SplayTreeSetNode<E>(source.key);
  _SplayTreeNode<E> target = result;
  while (true) {
    var sourceLeft = source._left;
    var sourceRight = source._right;
    if (sourceLeft != null) {
      if (sourceRight != null) {
        target._left = _copyNode<E>(sourceLeft);
      } else {
        source = sourceLeft;
        target = target._left = _SplayTreeSetNode<E>(source.key);
        continue;
      }
    } else if (sourceRight == null) {
      break;
    }
    source = sourceRight;
    target = target._right = _SplayTreeSetNode<E>(sourceRight.key);
  }
  return result;
}

// Queues

abstract interface class Queue<E> implements EfficientLengthIterable<E> {
  factory Queue() => ListQueue<E>();
  factory Queue.from(Iterable elements) => ListQueue<E>.from(elements);
  factory Queue.of(Iterable<E> elements) => ListQueue<E>.of(elements);
  static Queue<T> castFrom<S, T>(Queue<S> source) => CastQueue<S, T>(source);
  Queue<R> cast<R>();
  void add(E value);
  void addFirst(E value);
  void addLast(E value);
  void addAll(Iterable<E> iterable);
  E removeFirst();
  E removeLast();
  bool remove(Object? value);
  void removeWhere(bool Function(E element) test);
  void retainWhere(bool Function(E element) test);
  void clear();
}

class CastQueue<S, T> extends CastIterableBase<S, T> implements Queue<T> {
  final Queue<S> _queue;
  CastQueue(Queue<S> source) : _queue = source, super(source);
  Queue<R> cast<R>() => CastQueue<S, R>(_queue);
  T removeFirst() => _queue.removeFirst() as T;
  T removeLast() => _queue.removeLast() as T;
  void add(T value) => _queue.add(value as S);
  void addFirst(T value) => _queue.addFirst(value as S);
  void addLast(T value) => _queue.addLast(value as S);
  bool remove(Object? value) => _queue.remove(value);
  void addAll(Iterable<T> elements) => _queue.addAll(CastIterable<T, S>(elements));
  void removeWhere(bool Function(T element) test) => _queue.removeWhere((S element) => test(element as T));
  void retainWhere(bool Function(T element) test) => _queue.retainWhere((S element) => test(element as T));
  void clear() => _queue.clear();
}

final class ListQueue<E> extends ListIterable<E> implements Queue<E> {
  static const int _initialCapacity = 8;
  List<E?> _table;
  int _head = 0;
  int _tail = 0;
  int _modificationCount = 0;

  ListQueue([int? initialCapacity]) : _table = List<E?>.filled(_capacity(initialCapacity), null);
  factory ListQueue.from(Iterable<dynamic> elements) {
    if (elements is List<dynamic>) {
      int count = elements.length;
      var queue = ListQueue<E>(count + 1);
      for (int i = 0; i < count; i++) queue._table[i] = elements[i] as E;
      queue._tail = count;
      return queue;
    }
    int capacity = elements is EfficientLengthIterable ? elements.length : _initialCapacity;
    var queue = ListQueue<E>(capacity);
    for (var element in elements) queue.addLast(element as E);
    return queue;
  }
  factory ListQueue.of(Iterable<E> elements) => ListQueue<E>()..addAll(elements);

  Queue<R> cast<R>() => Queue.castFrom<E, R>(this);
  Iterator<E> get iterator => _QueueIterator<E>(this);
  int get length => (_tail - _head) & (_table.length - 1);
  bool get isEmpty => _head == _tail;
  bool get isNotEmpty => _head != _tail;
  E get first {
    if (isEmpty) throw StateError("No element");
    return _table[_head] as E;
  }
  E get last {
    if (isEmpty) throw StateError("No element");
    return _table[(_tail - 1) & (_table.length - 1)] as E;
  }
  E get single {
    if (isEmpty) throw StateError("No element");
    if (length > 1) throw StateError("Too many elements");
    return _table[_head] as E;
  }
  E elementAt(int index) {
    IndexError.check(index, length, indexable: this);
    return _table[(_head + index) & (_table.length - 1)] as E;
  }
  void forEach(void Function(E) action) {
    int stamp = _modificationCount;
    for (int i = _head; i != _tail; i = (i + 1) & (_table.length - 1)) {
      action(_table[i] as E);
      _checkModification(stamp);
    }
  }
  List<E> toList({bool growable = true}) {
    int count = length;
    if (count == 0) return List<E>.empty(growable: growable);
    var result = List<E>.filled(count, first, growable: growable);
    for (int i = 0; i < count; i++) result[i] = elementAt(i);
    return result;
  }
  void add(E value) => addLast(value);
  void addAll(Iterable<E> elements) {
    if (elements is! List<E>) {
      for (var element in elements) addLast(element);
      return;
    }
    int count = elements.length;
    int size = length;
    if (size + count >= _table.length) {
      _preGrow(size + count);
      _table.setRange(size, size + count, elements);
      _tail += count;
    } else {
      int endSpace = _table.length - _tail;
      if (count < endSpace) {
        _table.setRange(_tail, _tail + count, elements);
        _tail += count;
      } else {
        int prefix = count - endSpace;
        _table.setRange(_tail, _tail + endSpace, elements);
        _table.setRange(0, prefix, elements, endSpace);
        _tail = prefix;
      }
    }
    _modificationCount++;
  }
  bool remove(Object? value) {
    for (int i = _head; i != _tail; i = (i + 1) & (_table.length - 1)) {
      if (_table[i] == value) {
        _remove(i);
        _modificationCount++;
        return true;
      }
    }
    return false;
  }
  void removeWhere(bool Function(E element) test) => _filterWhere(test, true);
  void retainWhere(bool Function(E element) test) => _filterWhere(test, false);
  void clear() {
    if (isEmpty) return;
    for (int i = _head; i != _tail; i = (i + 1) & (_table.length - 1)) _table[i] = null;
    _head = _tail = 0;
    _modificationCount++;
  }
  String toString() => Iterable.iterableToFullString(this, "{", "}");
  void addLast(E value) {
    _table[_tail] = value;
    _tail = (_tail + 1) & (_table.length - 1);
    if (_head == _tail) _grow();
    _modificationCount++;
  }
  void addFirst(E value) {
    _head = (_head - 1) & (_table.length - 1);
    _table[_head] = value;
    if (_head == _tail) _grow();
    _modificationCount++;
  }
  E removeFirst() {
    if (isEmpty) throw StateError("No element");
    E result = _table[_head] as E;
    _table[_head] = null;
    _head = (_head + 1) & (_table.length - 1);
    _modificationCount++;
    return result;
  }
  E removeLast() {
    if (isEmpty) throw StateError("No element");
    _tail = (_tail - 1) & (_table.length - 1);
    E result = _table[_tail] as E;
    _table[_tail] = null;
    _modificationCount++;
    return result;
  }

  void _filterWhere(bool Function(E) test, bool removeMatching) {
    int stamp = _modificationCount;
    int i = _head;
    while (i != _tail) {
      bool matches = test(_table[i] as E);
      _checkModification(stamp);
      if (matches == removeMatching) {
        i = _remove(i);
        stamp = ++_modificationCount;
      } else {
        i = (i + 1) & (_table.length - 1);
      }
    }
  }
  void _checkModification(int expected) {
    if (expected != _modificationCount) throw ConcurrentModificationError(this);
  }
  int _remove(int offset) {
    int mask = _table.length - 1;
    int before = (offset - _head) & mask;
    int after = (_tail - offset) & mask;
    if (before < after) {
      for (int i = offset; i != _head;) {
        int previous = (i - 1) & mask;
        _table[i] = _table[previous];
        i = previous;
      }
      _table[_head] = null;
      _head = (_head + 1) & mask;
      return (offset + 1) & mask;
    }
    _tail = (_tail - 1) & mask;
    for (int i = offset; i != _tail;) {
      int next = (i + 1) & mask;
      _table[i] = _table[next];
      i = next;
    }
    _table[_tail] = null;
    return offset;
  }
  void _grow() {
    var next = List<E?>.filled(_table.length * 2, null);
    var split = _table.length - _head;
    next.setRange(0, split, _table, _head);
    next.setRange(split, split + _head, _table);
    _tail = _table.length;
    _table = next;
    _head = 0;
  }
  void _preGrow(int count) {
    var next = List<E?>.filled(_roundCapacity(count + (count >> 1)), null);
    int size = length;
    if (_head <= _tail) {
      next.setRange(0, size, _table, _head);
    } else {
      int split = _table.length - _head;
      next.setRange(0, split, _table, _head);
      next.setRange(split, size, _table);
    }
    _head = 0;
    _tail = size;
    _table = next;
  }
  static int _capacity(int? initial) {
    if (initial == null || initial < _initialCapacity) return _initialCapacity;
    return _roundCapacity(initial);
  }
  static int _roundCapacity(int requested) {
    int result = 1;
    while (result < requested && result > 0) result <<= 1;
    return result;
  }
}

final class DoubleLinkedQueue<E> extends Iterable<E> implements Queue<E> {
  final _DoubleLinkedQueueSentinel<E> _anchor = _DoubleLinkedQueueSentinel<E>();
  int _count = 0;

  DoubleLinkedQueue();

  factory DoubleLinkedQueue.from(Iterable<dynamic> elements) {
    var queue = DoubleLinkedQueue<E>();
    for (var element in elements) queue.addLast(element as E);
    return queue;
  }
  factory DoubleLinkedQueue.of(Iterable<E> elements) => DoubleLinkedQueue<E>()..addAll(elements);

  Queue<R> cast<R>() => Queue.castFrom<E, R>(this);
  int get length => _count;
  bool get isEmpty => _count == 0;
  Iterator<E> get iterator => _DoubleLinkedQueueIterator<E>(this);
  DoubleLinkedQueueEntry<E>? firstEntry() => _anchor._next!._entry;
  DoubleLinkedQueueEntry<E>? lastEntry() => _anchor._previous!._entry;

  E get first => _firstEntry().element;
  E get last => _lastEntry().element;
  E get single {
    if (_count > 1) throw StateError("Too many elements");
    return first;
  }

  DoubleLinkedQueueEntry<E> _firstEntry() {
    final entry = firstEntry();
    if (entry == null) throw StateError("No element");
    return entry;
  }
  DoubleLinkedQueueEntry<E> _lastEntry() {
    final entry = lastEntry();
    if (entry == null) throw StateError("No element");
    return entry;
  }

  void add(E value) => addLast(value);
  void addFirst(E value) => _insert(_anchor._next!, value);
  void addLast(E value) => _insert(_anchor, value);
  void addAll(Iterable<E> iterable) {
    for (final value in iterable) addLast(value);
  }
  void _insert(_DoubleLinkedQueueLink<E> next, E value) {
    _DoubleLinkedQueueElement<E>(value, this)._link(next._previous, next);
    _count++;
  }

  E removeFirst() => _firstEntry().remove();
  E removeLast() => _lastEntry().remove();

  bool remove(Object? value) {
    var cursor = _anchor._next!;
    while (true) {
      final entry = cursor._entry;
      if (entry == null) return false;
      final equal = entry.element == value;
      cursor = _nextOf(entry);
      if (equal) {
        entry.remove();
        return true;
      }
    }
  }

  void removeWhere(bool Function(E element) test) => _filter(test, true);
  void retainWhere(bool Function(E element) test) => _filter(test, false);
  void _filter(bool Function(E) test, bool removeMatching) {
    var cursor = _anchor._next!;
    while (true) {
      final entry = cursor._entry;
      if (entry == null) return;
      final matches = test(entry.element);
      cursor = _nextOf(entry);
      if (matches == removeMatching) entry.remove();
    }
  }

  _DoubleLinkedQueueLink<E> _nextOf(DoubleLinkedQueueEntry<E> entry) {
    if (!identical(entry._queue, this)) throw ConcurrentModificationError(this);
    return entry._next!;
  }

  void forEachEntry(void Function(DoubleLinkedQueueEntry<E> entry) action) {
    var cursor = _anchor._next!;
    while (true) {
      final entry = cursor._entry;
      if (entry == null) return;
      cursor = _nextOf(entry);
      action(entry);
      if (identical(entry._queue, this)) cursor = entry._next!;
    }
  }
  void clear() {
    while (!isEmpty) removeFirst();
  }
  String toString() => Iterable.iterableToFullString(this, "{", "}");
}

abstract class _DoubleLinkedQueueLink<E> {
  _DoubleLinkedQueueLink<E>? _previous;
  _DoubleLinkedQueueLink<E>? _next;
  DoubleLinkedQueueEntry<E>? get _entry;
  void _link(_DoubleLinkedQueueLink<E>? previous, _DoubleLinkedQueueLink<E>? next) {
    _previous = previous;
    _next = next;
    if (previous != null) previous._next = this;
    if (next != null) next._previous = this;
  }
  void _unlink() {
    final previous = _previous;
    final next = _next;
    if (previous != null) previous._next = next;
    if (next != null) next._previous = previous;
    _previous = null;
    _next = null;
  }
}

class _DoubleLinkedQueueSentinel<E> extends _DoubleLinkedQueueLink<E> {
  _DoubleLinkedQueueSentinel() { _link(this, this); }
  DoubleLinkedQueueEntry<E>? get _entry => null;
}

class DoubleLinkedQueueEntry<E> extends _DoubleLinkedQueueLink<E> {
  E element;
  DoubleLinkedQueue<E>? _queue;
  DoubleLinkedQueueEntry(this.element);
  DoubleLinkedQueueEntry<E> get _entry => this;
  DoubleLinkedQueueEntry<E>? previousEntry() => _previous?._entry;
  DoubleLinkedQueueEntry<E>? nextEntry() => _next?._entry;
  void append(E element) => _insert(element, this, _next);
  void prepend(E element) => _insert(element, _previous, this);
  void _insert(E element, _DoubleLinkedQueueLink<E>? previous, _DoubleLinkedQueueLink<E>? next) {
    _newEntry(element)._link(previous, next);
    final queue = _queue;
    if (queue != null) queue._count++;
  }
  DoubleLinkedQueueEntry<E> _newEntry(E element) => DoubleLinkedQueueEntry<E>(element);
  E remove() {
    final queue = _queue;
    if (queue != null) queue._count--;
    _queue = null;
    _unlink();
    return element;
  }
}

class _DoubleLinkedQueueElement<E> extends DoubleLinkedQueueEntry<E> {
  _DoubleLinkedQueueElement(E element, DoubleLinkedQueue<E>? queue) : super(element) { _queue = queue; }
  DoubleLinkedQueueEntry<E> _newEntry(E element) => _DoubleLinkedQueueElement<E>(element, _queue);
}

class _DoubleLinkedQueueIterator<E> implements Iterator<E> {
  DoubleLinkedQueue<E>? _queue;
  _DoubleLinkedQueueLink<E>? _next;
  E? _current;
  _DoubleLinkedQueueIterator(DoubleLinkedQueue<E> queue) : _queue = queue, _next = queue._anchor._next;
  E get current => _current as E;
  bool moveNext() {
    final next = _next?._entry;
    if (next == null) {
      _queue = null;
      _next = null;
      _current = null;
      return false;
    }
    _next = _queue!._nextOf(next);
    _current = next.element;
    return true;
  }
}

class _QueueIterator<E> implements Iterator<E> {
  final ListQueue<E> _queue;
  final int _stamp;
  final int _end;
  int _position;
  E? _current;
  _QueueIterator(this._queue)
      : _stamp = _queue._modificationCount, _end = _queue._tail, _position = _queue._head;
  E get current => _current as E;
  bool moveNext() {
    _queue._checkModification(_stamp);
    if (_position == _end) {
      _current = null;
      return false;
    }
    _current = _queue._table[_position];
    _position = (_position + 1) & (_queue._table.length - 1);
    return true;
  }
}
`;
