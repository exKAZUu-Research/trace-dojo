/**
 * dart:collection as the interpreter declares it. The hash map and set transcribe the VM's `_HashMap` and `_HashSet`
 * (buckets indexed by `hashCode`, entries prepended, doubled when three quarters full), whose iteration order programs
 * see. The source must not contain `${`.
 */
export const COLLECTION_SOURCE = String.raw`
abstract mixin class IterableMixin<E> implements Iterable<E> {
  Iterator<E> get iterator;
  Iterable<R> cast<R>() => Iterable.castFrom<E, R>(this);
  Iterable<E> followedBy(Iterable<E> other) => _followedBy(this, other);
  Iterable<T> map<T>(T Function(E e) toElement) => _mapped<E, T>(this, toElement);
  Iterable<E> where(bool Function(E element) test) => _whereOf(this, test);
  Iterable<T> whereType<T>() => _whereTypeOf<T>(this);
  Iterable<T> expand<T>(Iterable<T> Function(E element) toElements) => _expandOf<E, T>(this, toElements);
  bool contains(Object? element) {
    for (E e in this) {
      if (e == element) return true;
    }
    return false;
  }
  void forEach(void Function(E element) action) {
    for (E element in this) action(element);
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
  bool every(bool Function(E element) test) {
    for (E element in this) {
      if (!test(element)) return false;
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
  List<E> toList({bool growable = true}) => List<E>.of(this, growable: growable);
  Set<E> toSet() => Set<E>.of(this);
  int get length {
    int count = 0;
    Iterator<E> it = iterator;
    while (it.moveNext()) count++;
    return count;
  }
  bool get isEmpty => !iterator.moveNext();
  bool get isNotEmpty => !isEmpty;
  Iterable<E> take(int count) => _takeOf(this, count);
  Iterable<E> takeWhile(bool Function(E value) test) => _takeWhileOf(this, test);
  Iterable<E> skip(int count) => _skipOf(this, count);
  Iterable<E> skipWhile(bool Function(E value) test) => _skipWhileOf(this, test);
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
  E get single {
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    E result = it.current;
    if (it.moveNext()) throw StateError("Too many elements");
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
  E singleWhere(bool Function(E element) test, {E Function()? orElse}) {
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
  String toString() => Iterable.iterableToShortString(this, '(', ')');
}

abstract class IterableBase<E> extends Iterable<E> {
  const IterableBase();
  static String iterableToShortString(Iterable iterable, [String leftDelimiter = '(', String rightDelimiter = ')']) =>
      Iterable.iterableToShortString(iterable, leftDelimiter, rightDelimiter);
  static String iterableToFullString(Iterable iterable, [String leftDelimiter = '(', String rightDelimiter = ')']) =>
      Iterable.iterableToFullString(iterable, leftDelimiter, rightDelimiter);
}

Iterable<E> _followedBy<E>(Iterable<E> first, Iterable<E> second) => [first, second].expand((e) => e);
Iterable<T> _mapped<E, T>(Iterable<E> source, T Function(E) f) => source.toList(growable: false).map(f);
Iterable<E> _whereOf<E>(Iterable<E> source, bool Function(E) f) => source.toList(growable: false).where(f);
Iterable<T> _whereTypeOf<T>(Iterable<Object?> source) => source.toList(growable: false).whereType<T>();
Iterable<T> _expandOf<E, T>(Iterable<E> source, Iterable<T> Function(E) f) => source.toList(growable: false).expand(f);
Iterable<E> _takeOf<E>(Iterable<E> source, int count) => source.toList(growable: false).take(count);
Iterable<E> _takeWhileOf<E>(Iterable<E> source, bool Function(E) f) => source.toList(growable: false).takeWhile(f);
Iterable<E> _skipOf<E>(Iterable<E> source, int count) => source.toList(growable: false).skip(count);
Iterable<E> _skipWhileOf<E>(Iterable<E> source, bool Function(E) f) => source.toList(growable: false).skipWhile(f);

// Lists the program implements

/** ListMixin as the SDK's ListBase (collection/list.dart) implements it on top of length and the index operators. */
abstract mixin class ListMixin<E> implements List<E> {
  int get length;
  set length(int newLength);
  E operator [](int index);
  void operator []=(int index, E value);
  Iterator<E> get iterator => ListIterator<E>(this);
  E elementAt(int index) => this[index];
  Iterable<E> followedBy(Iterable<E> other) =>
      FollowedByIterable<E>(this, other);
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
  void sort([int Function(E a, E b)? compare]) {
    // The VM sorts the list itself with the algorithm List.sort runs on a copy, so the order and the calls agree.
    var copy = toList();
    copy.sort(compare);
    for (int i = 0; i < copy.length; i++) this[i] = copy[i];
  }
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
    int length = end - start;
    if (length == 0) return;
    RangeError.checkNotNegative(skipCount, "skipCount");
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
  void replaceRange(int start, int end, Iterable<E> newContents) {
    RangeError.checkValidRange(start, end, this.length);
    if (start == this.length) {
      addAll(newContents);
      return;
    }
    if (!_isEfficientLength(newContents)) {
      newContents = newContents.toList();
    }
    int removeLength = end - start;
    int insertLength = newContents.length;
    if (removeLength >= insertLength) {
      int insertEnd = start + insertLength;
      this.setRange(start, insertEnd, newContents);
      if (removeLength > insertLength) {
        _closeGap(insertEnd, end);
      }
    } else if (end == this.length) {
      int i = start;
      for (E element in newContents) {
        if (i < end) {
          this[i] = element;
        } else {
          add(element);
        }
        i++;
      }
    } else {
      int delta = insertLength - removeLength;
      int oldLength = this.length;
      int insertEnd = start + insertLength; // aka. end + delta.
      for (int i = oldLength - delta; i < oldLength; ++i) {
        add(this[i > 0 ? i : 0]);
      }
      if (insertEnd < oldLength) {
        this.setRange(insertEnd, oldLength, this, end);
      }
      this.setRange(start, insertEnd, newContents);
    }
  }
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
    if (!_isEfficientLength(iterable) || identical(iterable, this)) {
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

bool _isEfficientLength(Iterable<Object?> iterable) => iterable is List || iterable is Set || iterable is ListIterable;

abstract class ListBase<E> with ListMixin<E> {
  static String listToString(List list) => Iterable.iterableToFullString(list, '[', ']');
}

class UnmodifiableListView<E> extends ListBase<E> {
  final Iterable<E> _source;
  UnmodifiableListView(Iterable<E> source) : _source = source;
  int get length => _source.length;
  set length(int newLength) => throw UnsupportedError("Cannot change the length of an unmodifiable list");
  E operator [](int index) => _source.elementAt(index);
  void operator []=(int index, E value) => throw UnsupportedError("Cannot modify an unmodifiable list");
  void add(E value) => throw UnsupportedError("Cannot add to an unmodifiable list");
  void addAll(Iterable<E> iterable) => throw UnsupportedError("Cannot add to an unmodifiable list");
  bool remove(Object? element) => throw UnsupportedError("Cannot remove from an unmodifiable list");
  void clear() => throw UnsupportedError("Cannot clear an unmodifiable list");
  void sort([int Function(E a, E b)? compare]) => throw UnsupportedError("Cannot modify an unmodifiable list");
}

// Maps the program implements

abstract mixin class MapMixin<K, V> implements Map<K, V> {
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
    for (var key in this.keys.toList()) this[key] = update(key, this[key] as V);
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
  Iterable<V> get values => keys.map((K key) => this[key] as V);
  String toString() => MapBase.mapToString(this);
}

abstract class MapBase<K, V> with MapMixin<K, V> {
  static String mapToString(Map<Object?, Object?> m) => m.isEmpty ? '{}' : _mapToStringOf(m);
}

String _mapToStringOf(Map<Object?, Object?> m) {
  var parts = <String>[];
  m.forEach((k, v) {
    parts.add(k.toString() + ': ' + v.toString());
  });
  return '{' + parts.join(', ') + '}';
}

class UnmodifiableMapView<K, V> extends MapBase<K, V> {
  final Map<K, V> _map;
  UnmodifiableMapView(Map<K, V> map) : _map = map;
  V? operator [](Object? key) => _map[key];
  void operator []=(K key, V value) => throw UnsupportedError("Cannot modify unmodifiable map");
  Iterable<K> get keys => _map.keys;
  V? remove(Object? key) => throw UnsupportedError("Cannot modify unmodifiable map");
  void clear() => throw UnsupportedError("Cannot modify unmodifiable map");
  int get length => _map.length;
  bool containsKey(Object? key) => _map.containsKey(key);
}

/** The map List.asMap returns: a view of the list, as the VM ListMapView. */
class ListMapView<E> extends MapBase<int, E> {
  final List<E> _values;
  ListMapView(this._values);
  E? operator [](Object? key) => containsKey(key) ? _values[key as int] : null;
  void operator []=(int key, E value) => throw UnsupportedError("Cannot modify unmodifiable map");
  E? remove(Object? key) => throw UnsupportedError("Cannot modify unmodifiable map");
  void clear() => throw UnsupportedError("Cannot modify unmodifiable map");
  void addAll(Map<int, E> other) => throw UnsupportedError("Cannot modify unmodifiable map");
  void addEntries(Iterable<MapEntry<int, E>> entries) => throw UnsupportedError("Cannot modify unmodifiable map");
  E putIfAbsent(int key, E Function() ifAbsent) => throw UnsupportedError("Cannot modify unmodifiable map");
  E update(int key, E Function(E value) update, {E Function()? ifAbsent}) => throw UnsupportedError("Cannot modify unmodifiable map");
  void updateAll(E Function(int key, E value) update) => throw UnsupportedError("Cannot modify unmodifiable map");
  void removeWhere(bool Function(int key, E value) test) => throw UnsupportedError("Cannot modify unmodifiable map");
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

abstract mixin class SetMixin<E> implements Set<E> {
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
  Iterable<E> followedBy(Iterable<E> other) => _followedBy(this, other);
  Iterable<T> whereType<T>() => _whereTypeOf<T>(this);
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
  Iterable<T> map<T>(T Function(E e) f) => _mapped<E, T>(this, f);
  E get single {
    if (length > 1) throw StateError("Too many elements");
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    E result = it.current;
    return result;
  }
  String toString() => Iterable.iterableToFullString(this, '{', '}');
  Iterable<E> where(bool Function(E element) f) => _whereOf(this, f);
  Iterable<T> expand<T>(Iterable<T> Function(E element) f) => _expandOf<E, T>(this, f);
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
  Iterable<E> take(int n) => _takeOf(this, n);
  Iterable<E> takeWhile(bool Function(E value) test) => _takeWhileOf(this, test);
  Iterable<E> skip(int n) => _skipOf(this, n);
  Iterable<E> skipWhile(bool Function(E value) test) => _skipWhileOf(this, test);
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

abstract class SetBase<E> with SetMixin<E> {
  static String setToString(Set set) => Iterable.iterableToFullString(set, '{', '}');
}

// LinkedHashMap and LinkedHashSet are dart:core's map and set, which this library exports.

// Hash maps and sets, in the VM's bucket order

abstract final class HashMap<K, V> implements Map<K, V> {
  factory HashMap({bool Function(K, K)? equals, int Function(K)? hashCode, bool Function(dynamic)? isValidKey}) => _HashMap<K, V>();
  factory HashMap.identity() => _HashMap<K, V>();
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
  int _elementCount = 0;
  List<_HashMapEntry<K, V>?> _buckets = List<_HashMapEntry<K, V>?>.filled(8, null);
  int _modificationCount = 0;
  int get length => _elementCount;
  bool get isEmpty => _elementCount == 0;
  bool get isNotEmpty => _elementCount != 0;
  Iterable<K> get keys => _HashMapKeyIterable<K, V>(this);
  Iterable<V> get values => _HashMapValueIterable<K, V>(this);
  bool containsKey(Object? key) {
    final hashCode = key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == key) return true;
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
    final hashCode = key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == key) return entry.value;
      entry = entry.next;
    }
    return null;
  }
  void operator []=(K key, V value) {
    final hashCode = key.hashCode;
    final buckets = _buckets;
    final length = buckets.length;
    final index = hashCode & (length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == key) {
        entry.value = value;
        return;
      }
      entry = entry.next;
    }
    _addEntry(buckets, index, length, key, value, hashCode);
  }
  V putIfAbsent(K key, V Function() ifAbsent) {
    final hashCode = key.hashCode;
    final buckets = _buckets;
    final length = buckets.length;
    final index = hashCode & (length - 1);
    var entry = buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == key) return entry.value;
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
  V? remove(Object? key) {
    final hashCode = key.hashCode;
    final buckets = _buckets;
    final index = hashCode & (buckets.length - 1);
    var entry = buckets[index];
    _HashMapEntry<K, V>? previous = null;
    while (entry != null) {
      final next = entry.next;
      if (hashCode == entry.hashCode && entry.key == key) {
        _removeEntry(entry, previous, index);
        _elementCount--;
        _modificationCount = (_modificationCount + 1) & 0x3fffffff;
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
}

class _HashMapKeyIterable<K, V> extends Iterable<K> {
  final _HashMap<K, V> _map;
  _HashMapKeyIterable(this._map);
  int get length => _map.length;
  bool get isEmpty => _map.isEmpty;
  bool contains(Object? key) => _map.containsKey(key);
  Iterator<K> get iterator => _HashMapIterator<K, V, K>(_map, 0);
}

class _HashMapValueIterable<K, V> extends Iterable<V> {
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
  factory HashSet({bool Function(E, E)? equals, int Function(E)? hashCode, bool Function(dynamic)? isValidKey}) => _HashSet<E>();
  factory HashSet.identity() => _HashSet<E>();
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
  int _elementCount = 0;
  List<_HashSetEntry<E>?> _buckets = List<_HashSetEntry<E>?>.filled(8, null);
  int _modificationCount = 0;
  Iterator<E> get iterator => _HashSetIterator<E>(this);
  int get length => _elementCount;
  bool get isEmpty => _elementCount == 0;
  bool get isNotEmpty => _elementCount != 0;
  bool contains(Object? object) {
    int index = object.hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      if (entry.key == object) return true;
      entry = entry.next;
    }
    return false;
  }
  E? lookup(Object? object) {
    int index = object.hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      var key = entry.key;
      if (key == object) return key;
      entry = entry.next;
    }
    return null;
  }
  bool add(E element) {
    final hashCode = element.hashCode;
    final index = hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == element) return false;
      entry = entry.next;
    }
    _addEntry(element, hashCode, index);
    return true;
  }
  void addAll(Iterable<E> objects) {
    for (E object in objects) add(object);
  }
  bool remove(Object? object) {
    final hashCode = object.hashCode;
    final index = hashCode & (_buckets.length - 1);
    var entry = _buckets[index];
    _HashSetEntry<E>? previous = null;
    while (entry != null) {
      if (hashCode == entry.hashCode && entry.key == object) {
        if (previous == null) {
          _buckets[index] = entry.next;
        } else {
          previous.next = entry.next;
        }
        _elementCount--;
        _modificationCount = (_modificationCount + 1) & 0x3fffffff;
        return true;
      }
      previous = entry;
      entry = entry.next;
    }
    return false;
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
  HashSet<E> _newSet() => _HashSet<E>();
  Set<E> toSet() => _HashSet<E>()..addAll(this);
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

int _defaultCompare(Object? a, Object? b) => Comparable.compare(a as Comparable, b as Comparable);

class SplayTreeMap<K, V> extends MapBase<K, V> {
  final List<K> _keys = <K>[];
  final List<V> _values = <V>[];
  final int Function(K, K) _compare;
  int _modificationCount = 0;
  SplayTreeMap([int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey])
      : _compare = compare ?? _defaultCompare;
  factory SplayTreeMap.from(Map<dynamic, dynamic> other, [int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    SplayTreeMap<K, V> result = SplayTreeMap<K, V>(compare);
    other.forEach((dynamic k, dynamic v) {
      result[k as K] = v as V;
    });
    return result;
  }
  factory SplayTreeMap.of(Map<K, V> other, [int Function(K key1, K key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) =>
      SplayTreeMap<K, V>(compare)..addAll(other);
  factory SplayTreeMap.fromIterables(Iterable<K> keys, Iterable<V> values, [int Function(K key1, K key2)? compare]) {
    SplayTreeMap<K, V> map = SplayTreeMap<K, V>(compare);
    var keyList = keys.toList();
    var valueList = values.toList();
    if (keyList.length != valueList.length) throw ArgumentError("Iterables do not have same length.");
    for (int i = 0; i < keyList.length; i++) map[keyList[i]] = valueList[i];
    return map;
  }
  int _find(Object? key) {
    int low = 0;
    int high = _keys.length - 1;
    K target = key as K;
    while (low <= high) {
      int middle = (low + high) ~/ 2;
      int comparison = _compare(_keys[middle], target);
      if (comparison == 0) return middle;
      if (comparison < 0) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -(low + 1);
  }
  V? operator [](Object? key) {
    if (key is! K) return null;
    int index = _find(key);
    return index >= 0 ? _values[index] : null;
  }
  void operator []=(K key, V value) {
    int index = _find(key);
    if (index >= 0) {
      _values[index] = value;
      return;
    }
    _keys.insert(-index - 1, key);
    _values.insert(-index - 1, value);
    _modificationCount++;
  }
  V? remove(Object? key) {
    if (key is! K) return null;
    int index = _find(key);
    if (index < 0) return null;
    _keys.removeAt(index);
    _modificationCount++;
    return _values.removeAt(index);
  }
  void clear() {
    _keys.clear();
    _values.clear();
    _modificationCount++;
  }
  bool containsKey(Object? key) => key is K && _find(key) >= 0;
  bool containsValue(Object? value) => _values.contains(value);
  int get length => _keys.length;
  bool get isEmpty => _keys.isEmpty;
  bool get isNotEmpty => _keys.isNotEmpty;
  Iterable<K> get keys => _keys.toList(growable: false);
  Iterable<V> get values => _values.toList(growable: false);
  void forEach(void Function(K key, V value) f) {
    int stamp = _modificationCount;
    for (int i = 0; i < _keys.length; i++) {
      f(_keys[i], _values[i]);
      if (stamp != _modificationCount) throw ConcurrentModificationError(this);
    }
  }
  K? firstKey() => _keys.isEmpty ? null : _keys.first;
  K? lastKey() => _keys.isEmpty ? null : _keys.last;
  K? lastKeyBefore(K key) {
    for (int i = _keys.length - 1; i >= 0; i--) {
      if (_compare(_keys[i], key) < 0) return _keys[i];
    }
    return null;
  }
  K? firstKeyAfter(K key) {
    for (int i = 0; i < _keys.length; i++) {
      if (_compare(_keys[i], key) > 0) return _keys[i];
    }
    return null;
  }
}

class SplayTreeSet<E> extends SetBase<E> {
  final List<E> _elements = <E>[];
  final int Function(E, E) _compare;
  int _modificationCount = 0;
  SplayTreeSet([int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey])
      : _compare = compare ?? _defaultCompare;
  factory SplayTreeSet.from(Iterable elements, [int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) {
    SplayTreeSet<E> result = SplayTreeSet<E>(compare);
    for (var element in elements) {
      result.add(element as E);
    }
    return result;
  }
  factory SplayTreeSet.of(Iterable<E> elements, [int Function(E key1, E key2)? compare, bool Function(dynamic potentialKey)? isValidKey]) =>
      SplayTreeSet<E>(compare)..addAll(elements);
  int _find(Object? key) {
    int low = 0;
    int high = _elements.length - 1;
    E target = key as E;
    while (low <= high) {
      int middle = (low + high) ~/ 2;
      int comparison = _compare(_elements[middle], target);
      if (comparison == 0) return middle;
      if (comparison < 0) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -(low + 1);
  }
  Iterator<E> get iterator => _SplayTreeSetIterator<E>(this);
  int get length => _elements.length;
  bool get isEmpty => _elements.isEmpty;
  bool get isNotEmpty => _elements.isNotEmpty;
  E get first {
    if (_elements.isEmpty) throw StateError("No element");
    return _elements.first;
  }
  E get last {
    if (_elements.isEmpty) throw StateError("No element");
    return _elements.last;
  }
  bool contains(Object? element) => element is E && _find(element) >= 0;
  bool add(E element) {
    int index = _find(element);
    if (index >= 0) return false;
    _elements.insert(-index - 1, element);
    _modificationCount++;
    return true;
  }
  bool remove(Object? object) {
    if (object is! E) return false;
    int index = _find(object);
    if (index < 0) return false;
    _elements.removeAt(index);
    _modificationCount++;
    return true;
  }
  E? lookup(Object? object) {
    if (object is! E) return null;
    int index = _find(object);
    return index >= 0 ? _elements[index] : null;
  }
  void clear() {
    _elements.clear();
    _modificationCount++;
  }
  Set<E> toSet() => SplayTreeSet<E>(_compare)..addAll(_elements);
  E? lastBefore(E element) {
    for (int i = _elements.length - 1; i >= 0; i--) {
      if (_compare(_elements[i], element) < 0) return _elements[i];
    }
    return null;
  }
  E? firstAfter(E element) {
    for (int i = 0; i < _elements.length; i++) {
      if (_compare(_elements[i], element) > 0) return _elements[i];
    }
    return null;
  }
}

class _SplayTreeSetIterator<E> implements Iterator<E> {
  final SplayTreeSet<E> _set;
  final int _stamp;
  int _index = 0;
  E? _current;
  _SplayTreeSetIterator(this._set) : _stamp = _set._modificationCount;
  bool moveNext() {
    if (_stamp != _set._modificationCount) throw ConcurrentModificationError(_set);
    if (_index >= _set._elements.length) {
      _current = null;
      return false;
    }
    _current = _set._elements[_index++];
    return true;
  }
  E get current => _current as E;
}

// Queues

abstract interface class Queue<E> implements Iterable<E> {
  factory Queue() => ListQueue<E>();
  factory Queue.from(Iterable elements) => ListQueue<E>.from(elements);
  factory Queue.of(Iterable<E> elements) => ListQueue<E>.of(elements);
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

class ListQueue<E> extends Iterable<E> implements Queue<E> {
  final List<E> _elements = <E>[];
  int _modificationCount = 0;
  ListQueue([int? initialCapacity]);
  factory ListQueue.from(Iterable<dynamic> elements) {
    ListQueue<E> queue = ListQueue<E>();
    for (final element in elements) {
      queue.addLast(element as E);
    }
    return queue;
  }
  factory ListQueue.of(Iterable<E> elements) => ListQueue<E>()..addAll(elements);
  Iterator<E> get iterator => _QueueIterator<E>(this);
  int get length => _elements.length;
  bool get isEmpty => _elements.isEmpty;
  bool get isNotEmpty => _elements.isNotEmpty;
  E get first {
    if (_elements.isEmpty) throw StateError("No element");
    return _elements.first;
  }
  E get last {
    if (_elements.isEmpty) throw StateError("No element");
    return _elements.last;
  }
  E get single {
    if (_elements.isEmpty) throw StateError("No element");
    if (_elements.length > 1) throw StateError("Too many elements");
    return _elements.first;
  }
  E elementAt(int index) {
    RangeError.checkValidIndex(index, this, "index", _elements.length);
    return _elements[index];
  }
  List<E> toList({bool growable = true}) => _elements.toList(growable: growable);
  void add(E value) {
    _elements.add(value);
    _modificationCount++;
  }
  void addAll(Iterable<E> elements) {
    for (var element in elements) add(element);
  }
  bool remove(Object? value) {
    bool removed = _elements.remove(value);
    if (removed) _modificationCount++;
    return removed;
  }
  void removeWhere(bool Function(E element) test) {
    _elements.removeWhere(test);
    _modificationCount++;
  }
  void retainWhere(bool Function(E element) test) {
    _elements.retainWhere(test);
    _modificationCount++;
  }
  void clear() {
    _elements.clear();
    _modificationCount++;
  }
  String toString() => Iterable.iterableToFullString(this, "{", "}");
  void addLast(E value) => add(value);
  void addFirst(E value) {
    _elements.insert(0, value);
    _modificationCount++;
  }
  E removeFirst() {
    if (_elements.isEmpty) throw StateError("No element");
    _modificationCount++;
    return _elements.removeAt(0);
  }
  E removeLast() {
    if (_elements.isEmpty) throw StateError("No element");
    _modificationCount++;
    return _elements.removeLast();
  }
}

class DoubleLinkedQueue<E> extends ListQueue<E> {
  DoubleLinkedQueue() : super();
  factory DoubleLinkedQueue.from(Iterable<dynamic> elements) {
    DoubleLinkedQueue<E> queue = DoubleLinkedQueue<E>();
    for (final element in elements) {
      queue.addLast(element as E);
    }
    return queue;
  }
  factory DoubleLinkedQueue.of(Iterable<E> elements) => DoubleLinkedQueue<E>()..addAll(elements);
}

class _QueueIterator<E> implements Iterator<E> {
  final ListQueue<E> _queue;
  final int _stamp;
  int _position = 0;
  E? _current;
  _QueueIterator(this._queue) : _stamp = _queue._modificationCount;
  E get current => _current as E;
  bool moveNext() {
    if (_stamp != _queue._modificationCount) throw ConcurrentModificationError(_queue);
    if (_position >= _queue._elements.length) {
      _current = null;
      return false;
    }
    _current = _queue._elements[_position++];
    return true;
  }
}
`;
