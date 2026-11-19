/**
 * dart:core as the interpreter declares it: `external` members run natives, and the rest is Dart transcribed from the
 * SDK so that results match it. The source must not contain `${`, which the template would interpolate.
 */
export const CORE_SOURCE = String.raw`
class Object {
  const Object();
  external bool operator ==(Object other);
  external int get hashCode;
  external String toString();
  external dynamic noSuchMethod(Invocation invocation);
  external Type get runtimeType;
  static int hash(Object? object1, Object? object2, [Object? object3, Object? object4, Object? object5, Object? object6, Object? object7, Object? object8]) => _hashValues([object1, object2, object3, object4, object5, object6, object7, object8]);
  static int hashAll(Iterable<Object?> objects) => _hashValues(objects.toList());
  external static int _hashValues(List<Object?> values);
}

abstract final class Invocation {
  Symbol get memberName;
  List<Type> get typeArguments;
  List<dynamic> get positionalArguments;
  Map<Symbol, dynamic> get namedArguments;
  bool get isMethod;
  bool get isGetter;
  bool get isSetter;
  bool get isAccessor;
}

final class _InvocationMirror implements Invocation {
  final String _name;
  final int _kind;
  final List<dynamic> positionalArguments;
  final Map<Symbol, dynamic> namedArguments;
  final List<Type> typeArguments;
  _InvocationMirror._(this._name, this._kind, this.positionalArguments, this.namedArguments, this.typeArguments);
  Symbol get memberName => Symbol(_name);
  bool get isMethod => _kind == 0;
  bool get isGetter => _kind == 1;
  bool get isSetter => _kind == 2;
  bool get isAccessor => _kind != 0;
}

final class Null {
  external int get hashCode;
  external String toString();
}

final class bool {
  external int get hashCode;
  external bool operator &(bool other);
  external bool operator |(bool other);
  external bool operator ^(bool other);
  external String toString();
  external static bool parse(String source, {bool caseSensitive = true});
  external static bool? tryParse(String source, {bool caseSensitive = true});
}

abstract class Comparable<T> {
  int compareTo(T other);
  static int compare(Comparable a, Comparable b) => a.compareTo(b);
}

typedef Comparator<T> = int Function(T a, T b);

sealed class num implements Comparable<num> {
  external bool operator ==(Object other);
  external int get hashCode;
  external int compareTo(num other);
  external num operator +(num other);
  external num operator -(num other);
  external num operator *(num other);
  external num operator %(num other);
  external double operator /(num other);
  external int operator ~/(num other);
  external num operator -();
  external num remainder(num other);
  external bool operator <(num other);
  external bool operator <=(num other);
  external bool operator >(num other);
  external bool operator >=(num other);
  external bool get isNaN;
  external bool get isNegative;
  external bool get isInfinite;
  external bool get isFinite;
  external num abs();
  external num get sign;
  external int round();
  external int floor();
  external int ceil();
  external int truncate();
  external double roundToDouble();
  external double floorToDouble();
  external double ceilToDouble();
  external double truncateToDouble();
  external num clamp(num lowerLimit, num upperLimit);
  external int toInt();
  external double toDouble();
  external String toStringAsFixed(int fractionDigits);
  external String toStringAsExponential([int? fractionDigits]);
  external String toStringAsPrecision(int precision);
  external String toString();
  external static num parse(String input, [num Function(String input)? onError]);
  external static num? tryParse(String input);
}

abstract final class int extends num {
  external const factory int.fromEnvironment(String name, {int defaultValue = 0});
  external int operator &(int other);
  external int operator |(int other);
  external int operator ^(int other);
  external int operator ~();
  external int operator <<(int shiftAmount);
  external int operator >>(int shiftAmount);
  external int operator >>>(int shiftAmount);
  external int modPow(int exponent, int modulus);
  external int modInverse(int modulus);
  external int gcd(int other);
  external bool get isEven;
  external bool get isOdd;
  external int get bitLength;
  external int toUnsigned(int width);
  external int toSigned(int width);
  external int operator -();
  external int abs();
  external int get sign;
  external int round();
  external int floor();
  external int ceil();
  external int truncate();
  external double roundToDouble();
  external double floorToDouble();
  external double ceilToDouble();
  external double truncateToDouble();
  external String toString();
  external String toRadixString(int radix);
  external static int parse(String source, {int? radix});
  external static int? tryParse(String source, {int? radix});
}

abstract final class double extends num {
  static const double nan = 0.0 / 0.0;
  static const double infinity = 1.0 / 0.0;
  static const double negativeInfinity = -infinity;
  static const double minPositive = 5e-324;
  static const double maxFinite = 1.7976931348623157e+308;
  external double remainder(num other);
  external double operator +(num other);
  external double operator -(num other);
  external double operator *(num other);
  external double operator %(num other);
  external double operator /(num other);
  external int operator ~/(num other);
  external double operator -();
  external double abs();
  external double get sign;
  external int round();
  external int floor();
  external int ceil();
  external int truncate();
  external double roundToDouble();
  external double floorToDouble();
  external double ceilToDouble();
  external double truncateToDouble();
  external String toString();
  external static double parse(String source);
  external static double? tryParse(String source);
}

abstract class Pattern {
  Iterable<Match> allMatches(String string, [int start = 0]);
  Match? matchAsPrefix(String string, [int start = 0]);
}

abstract interface class Match {
  int get start;
  int get end;
  String? group(int group);
  String? operator [](int group);
  List<String?> groups(List<int> groupIndices);
  int get groupCount;
  String get input;
  Pattern get pattern;
}

abstract final class String implements Comparable<String>, Pattern {
  external factory String.fromCharCodes(Iterable<int> charCodes, [int start = 0, int? end]);
  external factory String.fromCharCode(int charCode);
  external const factory String.fromEnvironment(String name, {String defaultValue = ""});
  external String operator [](int index);
  external int codeUnitAt(int index);
  external int get length;
  external int get hashCode;
  external bool operator ==(Object other);
  external int compareTo(String other);
  external bool endsWith(String other);
  external bool startsWith(Pattern pattern, [int index = 0]);
  external int indexOf(Pattern pattern, [int start = 0]);
  external int lastIndexOf(Pattern pattern, [int? start]);
  external bool get isEmpty;
  external bool get isNotEmpty;
  external String operator +(String other);
  external String substring(int start, [int? end]);
  external String trim();
  external String trimLeft();
  external String trimRight();
  external String operator *(int times);
  external String padLeft(int width, [String padding = ' ']);
  external String padRight(int width, [String padding = ' ']);
  external bool contains(Pattern other, [int startIndex = 0]);
  external String replaceFirst(Pattern from, String to, [int startIndex = 0]);
  external String replaceFirstMapped(Pattern from, String Function(Match match) replace, [int startIndex = 0]);
  external String replaceAll(Pattern from, String replace);
  external String replaceAllMapped(Pattern from, String Function(Match match) replace);
  external String replaceRange(int start, int? end, String replacement);
  external List<String> split(Pattern pattern);
  external String splitMapJoin(Pattern pattern, {String Function(Match)? onMatch, String Function(String)? onNonMatch});
  external List<int> get codeUnits;
  external Runes get runes;
  external String toLowerCase();
  external String toUpperCase();
  external String toString();
  external Iterable<Match> allMatches(String string, [int start = 0]);
  external Match? matchAsPrefix(String string, [int start = 0]);
}

final class Runes extends Iterable<int> {
  final String string;
  Runes(this.string);
  external Iterator<int> get iterator;
  external int get last;
}

abstract interface class StringSink {
  void write(Object? object);
  void writeAll(Iterable<dynamic> objects, [String separator = ""]);
  void writeln([Object? object = ""]);
  void writeCharCode(int charCode);
}

final class StringBuffer implements StringSink {
  external StringBuffer([Object content = ""]);
  external int get length;
  external bool get isEmpty;
  external bool get isNotEmpty;
  external void write(Object? object);
  external void writeCharCode(int charCode);
  void writeAll(Iterable<dynamic> objects, [String separator = ""]) {
    Iterator<dynamic> iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    if (separator.isEmpty) {
      do {
        write(iterator.current);
      } while (iterator.moveNext());
    } else {
      write(iterator.current);
      while (iterator.moveNext()) {
        write(separator);
        write(iterator.current);
      }
    }
  }
  external void writeln([Object? obj = ""]);
  external void clear();
  external String toString();
}

abstract final class Function {
  external static dynamic apply(Function fn, List<dynamic>? positionalArguments, [Map<Symbol, dynamic>? namedArguments]);
  external int get hashCode;
  external bool operator ==(Object other);
}

abstract final class Record {
  external Type get runtimeType;
  external int get hashCode;
  external bool operator ==(Object other);
  external String toString();
}

abstract class Type {
  external int get hashCode;
  external bool operator ==(Object other);
  external String toString();
}

class Symbol {
  final String _name;
  const Symbol(String name) : _name = name;
  int get hashCode => _name.hashCode;
  bool operator ==(Object other) => other is Symbol && other._name == _name;
  String toString() => 'Symbol("' + _name + '")';
}

abstract interface class StackTrace {
  static const StackTrace empty = _EmptyStackTrace();
  external static StackTrace get current;
}

class _EmptyStackTrace implements StackTrace {
  const _EmptyStackTrace();
  String toString() => '';
}

class _StackTraceText implements StackTrace {
  final String _text;
  _StackTraceText(this._text);
  String toString() => _text;
}

abstract class Enum {
  external int get index;
  external String get _name;
  external String toString();
  static int compareByIndex<T extends Enum>(T value1, T value2) => value1.index - value2.index;
  static int compareByName<T extends Enum>(T value1, T value2) => value1.name.compareTo(value2.name);
}

extension EnumName on Enum {
  String get name => _name;
}

extension EnumByName<T extends Enum> on Iterable<T> {
  T byName(String name) {
    for (var value in this) {
      if (value._name == name) return value;
    }
    throw ArgumentError.value(name, "name", "No enum value with that name");
  }
  Map<String, T> asNameMap() => <String, T>{for (var value in this) value._name: value};
}

final class Duration implements Comparable<Duration> {
  static const int microsecondsPerMillisecond = 1000;
  static const int millisecondsPerSecond = 1000;
  static const int secondsPerMinute = 60;
  static const int minutesPerHour = 60;
  static const int hoursPerDay = 24;
  static const int microsecondsPerSecond = microsecondsPerMillisecond * millisecondsPerSecond;
  static const int microsecondsPerMinute = microsecondsPerSecond * secondsPerMinute;
  static const int microsecondsPerHour = microsecondsPerMinute * minutesPerHour;
  static const int microsecondsPerDay = microsecondsPerHour * hoursPerDay;
  static const int millisecondsPerMinute = millisecondsPerSecond * secondsPerMinute;
  static const int millisecondsPerHour = millisecondsPerMinute * minutesPerHour;
  static const int millisecondsPerDay = millisecondsPerHour * hoursPerDay;
  static const int secondsPerHour = secondsPerMinute * minutesPerHour;
  static const int secondsPerDay = secondsPerHour * hoursPerDay;
  static const int minutesPerDay = minutesPerHour * hoursPerDay;
  static const Duration zero = Duration(seconds: 0);
  final int _duration;
  const Duration({int days = 0, int hours = 0, int minutes = 0, int seconds = 0, int milliseconds = 0, int microseconds = 0})
      : this._microseconds(microseconds + microsecondsPerMillisecond * milliseconds + microsecondsPerSecond * seconds + microsecondsPerMinute * minutes + microsecondsPerHour * hours + microsecondsPerDay * days);
  const Duration._microseconds(this._duration);
  Duration operator +(Duration other) => Duration._microseconds(_duration + other._duration);
  Duration operator -(Duration other) => Duration._microseconds(_duration - other._duration);
  Duration operator *(num factor) => Duration._microseconds((_duration * factor).round());
  Duration operator ~/(int quotient) {
    if (quotient == 0) throw IntegerDivisionByZeroException();
    return Duration._microseconds(_duration ~/ quotient);
  }
  bool operator <(Duration other) => _duration < other._duration;
  bool operator >(Duration other) => _duration > other._duration;
  bool operator <=(Duration other) => _duration <= other._duration;
  bool operator >=(Duration other) => _duration >= other._duration;
  int get inDays => _duration ~/ Duration.microsecondsPerDay;
  int get inHours => _duration ~/ Duration.microsecondsPerHour;
  int get inMinutes => _duration ~/ Duration.microsecondsPerMinute;
  int get inSeconds => _duration ~/ Duration.microsecondsPerSecond;
  int get inMilliseconds => _duration ~/ Duration.microsecondsPerMillisecond;
  int get inMicroseconds => _duration;
  bool operator ==(Object other) => other is Duration && _duration == other.inMicroseconds;
  int get hashCode => _duration.hashCode;
  int compareTo(Duration other) => _duration.compareTo(other._duration);
  String toString() {
    var microseconds = inMicroseconds;
    var sign = "";
    var negative = microseconds < 0;
    var hours = microseconds ~/ microsecondsPerHour;
    microseconds = microseconds.remainder(microsecondsPerHour);
    if (negative) {
      hours = 0 - hours;
      microseconds = 0 - microseconds;
      sign = "-";
    }
    var minutes = microseconds ~/ microsecondsPerMinute;
    microseconds = microseconds.remainder(microsecondsPerMinute);
    var minutesPadding = minutes < 10 ? "0" : "";
    var seconds = microseconds ~/ microsecondsPerSecond;
    microseconds = microseconds.remainder(microsecondsPerSecond);
    var secondsPadding = seconds < 10 ? "0" : "";
    var microsecondsText = microseconds.toString().padLeft(6, "0");
    return "$sign$hours:$minutesPadding$minutes:$secondsPadding$seconds.$microsecondsText";
  }
  bool get isNegative => _duration < 0;
  Duration abs() => Duration._microseconds(_duration < 0 ? -_duration : _duration);
  Duration operator -() => Duration._microseconds(0 - _duration);
}

// Errors and exceptions

class Error {
  Error();
  external StackTrace? get stackTrace;
  static String safeToString(Object? object) => _safeToString(object);
  external static String _safeToString(Object? object);
  external static Never throwWithStackTrace(Object error, StackTrace stackTrace);
}

class AssertionError extends Error {
  final Object? message;
  AssertionError([this.message]);
  String toString() {
    if (message != null) return "Assertion failed: " + Error.safeToString(message);
    return "Assertion failed";
  }
}

class TypeError extends Error {
  TypeError();
}

class _TypeError extends TypeError {
  final String _message;
  _TypeError._withMessage(this._message);
  String toString() => _message;
}

class ArgumentError extends Error {
  final bool _hasValue;
  final dynamic invalidValue;
  final String? name;
  final dynamic message;
  ArgumentError([this.message, this.name]) : invalidValue = null, _hasValue = false;
  ArgumentError.value(value, [this.name, this.message]) : invalidValue = value, _hasValue = true;
  ArgumentError.notNull([this.name]) : _hasValue = false, message = "Must not be null", invalidValue = null;
  static T checkNotNull<T>(T? argument, [String? name]) => argument ?? (throw ArgumentError.notNull(name));
  String get _errorName => "Invalid argument" + (!_hasValue ? "(s)" : "");
  String get _errorExplanation => "";
  String toString() {
    String? name = this.name;
    String nameString = (name == null) ? "" : " ($name)";
    Object? message = this.message;
    var messageString = (message == null) ? "" : ": $message";
    String prefix = "$_errorName$nameString$messageString";
    if (!_hasValue) return prefix;
    String explanation = _errorExplanation;
    String errorValue = Error.safeToString(invalidValue);
    return "$prefix$explanation: $errorValue";
  }
}

class RangeError extends ArgumentError {
  final num? start;
  final num? end;
  RangeError(var message) : start = null, end = null, super(message);
  RangeError.value(num value, [String? name, String? message]) : start = null, end = null, super.value(value, name, message ?? "Value not in range");
  RangeError.range(num invalidValue, int? minValue, int? maxValue, [String? name, String? message])
      : start = minValue, end = maxValue, super.value(invalidValue, name, message ?? "Invalid value");
  factory RangeError.index(int index, dynamic indexable, [String? name, String? message, int? length]) = IndexError;
  static void checkValueInInterval(int value, int minValue, int maxValue, [String? name, String? message]) {
    if (value < minValue || value > maxValue) throw RangeError.range(value, minValue, maxValue, name, message);
  }
  static int checkValidIndex(int index, dynamic indexable, [String? name, int? length, String? message]) {
    length ??= indexable.length as int;
    if (0 > index || index >= length) throw IndexError.withLength(index, length, indexable: indexable, name: name ?? "index", message: message);
    return index;
  }
  static int checkValidRange(int start, int? end, int length, [String? startName, String? endName, String? message]) {
    if (0 > start || start > length) throw RangeError.range(start, 0, length, startName ?? "start", message);
    if (end != null) {
      if (start > end || end > length) throw RangeError.range(end, start, length, endName ?? "end", message);
      return end;
    }
    return length;
  }
  static int checkNotNegative(int value, [String? name, String? message]) {
    if (value < 0) throw RangeError.range(value, 0, null, name ?? "index", message);
    return value;
  }
  String get _errorName => "RangeError";
  String get _errorExplanation {
    String explanation = "";
    num? start = this.start;
    num? end = this.end;
    if (start == null) {
      if (end != null) explanation = ": Not less than or equal to $end";
    } else if (end == null) {
      explanation = ": Not greater than or equal to $start";
    } else if (end > start) {
      explanation = ": Not in inclusive range $start..$end";
    } else if (end < start) {
      explanation = ": Valid value range is empty";
    } else {
      explanation = ": Only valid value is $start";
    }
    return explanation;
  }
}

class IndexError extends ArgumentError implements RangeError {
  final dynamic indexable;
  final int length;
  int get start => 0;
  int get end => length - 1;
  IndexError(int invalidValue, dynamic indexable, [String? name, String? message, int? length])
      : this.indexable = indexable, this.length = length ?? indexable.length, super.value(invalidValue, name, message ?? "Index out of range");
  IndexError.withLength(int invalidValue, this.length, {this.indexable, String? name, String? message})
      : super.value(invalidValue, name, message ?? "Index out of range");
  String get _errorName => "RangeError";
  String get _errorExplanation {
    int invalidValue = this.invalidValue;
    if (invalidValue < 0) return ": index must not be negative";
    if (length == 0) return ": no indices are valid";
    return ": index should be less than $length";
  }
}

class UnsupportedError extends Error {
  final String? message;
  UnsupportedError(String this.message);
  String toString() => "Unsupported operation: $message";
}

class UnimplementedError extends Error implements UnsupportedError {
  final String? message;
  UnimplementedError([this.message]);
  String toString() {
    var message = this.message;
    return (message != null) ? "UnimplementedError: $message" : "UnimplementedError";
  }
}

class StateError extends Error {
  final String message;
  StateError(this.message);
  String toString() => "Bad state: $message";
}

class ConcurrentModificationError extends Error {
  final Object? modifiedObject;
  ConcurrentModificationError([this.modifiedObject]);
  String toString() {
    if (modifiedObject == null) return "Concurrent modification during iteration.";
    return "Concurrent modification during iteration: " + Error.safeToString(modifiedObject) + ".";
  }
}

class OutOfMemoryError implements Error {
  const OutOfMemoryError();
  String toString() => "Out of Memory";
  StackTrace? get stackTrace => null;
}

class StackOverflowError implements Error {
  const StackOverflowError();
  String toString() => "Stack Overflow";
  StackTrace? get stackTrace => null;
}

class NoSuchMethodError extends Error {
  final String _message;
  NoSuchMethodError._withInvocation(Object? receiver, Invocation invocation) : _message = _describe(receiver, invocation);
  external static String _describe(Object? receiver, Invocation invocation);
  String toString() => _message;
}

abstract interface class LateInitializationError implements Error {}

class LateError extends Error implements LateInitializationError {
  final String _message;
  LateError(this._message);
  String toString() => "LateInitializationError: $_message";
}

class _MessageError extends Error {
  final String _message;
  _MessageError(this._message);
  String toString() => _message;
}

abstract interface class Exception {
  factory Exception([var message]) => _Exception(message);
}

class _Exception implements Exception {
  final dynamic message;
  _Exception([this.message]);
  String toString() {
    Object? message = this.message;
    if (message == null) return "Exception";
    return "Exception: $message";
  }
}

class FormatException implements Exception {
  final String message;
  final dynamic source;
  final int? offset;
  const FormatException([this.message = "", this.source, this.offset]);
  String toString() {
    String report = "FormatException";
    Object? message = this.message;
    if (message != null && "" != message) report = "$report: $message";
    int? offset = this.offset;
    Object? source = this.source;
    if (source is String) {
      if (offset != null && (offset < 0 || offset > source.length)) offset = null;
      if (offset == null) {
        if (source.length > 78) source = source.substring(0, 75) + "...";
        return "$report\n$source";
      }
      int lineNum = 1;
      int lineStart = 0;
      bool previousCharWasCR = false;
      for (int i = 0; i < offset; i++) {
        int char = source.codeUnitAt(i);
        if (char == 0x0a) {
          if (lineStart != i || !previousCharWasCR) lineNum++;
          lineStart = i + 1;
          previousCharWasCR = false;
        } else if (char == 0x0d) {
          lineNum++;
          lineStart = i + 1;
          previousCharWasCR = true;
        }
      }
      if (lineNum > 1) {
        report += " (at line $lineNum, character " + (offset - lineStart + 1).toString() + ")\n";
      } else {
        report += " (at character " + (offset + 1).toString() + ")\n";
      }
      int lineEnd = source.length;
      for (int i = offset; i < source.length; i++) {
        int char = source.codeUnitAt(i);
        if (char == 0x0a || char == 0x0d) {
          lineEnd = i;
          break;
        }
      }
      int length = lineEnd - lineStart;
      int start = lineStart;
      int end = lineEnd;
      String prefix = "";
      String postfix = "";
      if (length > 78) {
        int index = offset - lineStart;
        if (index < 75) {
          end = start + 75;
          postfix = "...";
        } else if (end - offset < 75) {
          start = end - 75;
          prefix = "...";
        } else {
          start = offset - 36;
          end = offset + 36;
          prefix = postfix = "...";
        }
      }
      String slice = source.substring(start, end);
      int markOffset = offset - start + prefix.length;
      return "$report$prefix$slice$postfix\n" + (" " * markOffset) + "^\n";
    } else {
      if (offset != null) report += " (at offset $offset)";
      return report;
    }
  }
}

class IntegerDivisionByZeroException implements Exception, UnsupportedError {
  String? get message => "Division resulted in non-finite value";
  const IntegerDivisionByZeroException();
  StackTrace? get stackTrace => null;
  String toString() => "IntegerDivisionByZeroException";
}

// Annotations

class Deprecated {
  final String message;
  const Deprecated(this.message);
  String toString() => "Deprecated feature: $message";
}

const Deprecated deprecated = Deprecated("next release");

class _Override {
  const _Override();
}

const Object override = _Override();

class pragma {
  final String name;
  final Object? options;
  const pragma(this.name, [this.options]);
}

// Functions

external void print(Object? object);
external bool identical(Object? a, Object? b);
external int identityHashCode(Object? object);

// Iteration

abstract interface class Iterator<E> {
  bool moveNext();
  E get current;
}

abstract mixin class Iterable<E> {
  const Iterable();
  factory Iterable.generate(int count, [E Function(int index)? generator]) => _GeneratorIterable<E>(count, generator);
  factory Iterable.empty() => _EmptyIterable<E>();
  static Iterable<T> castFrom<S, T>(Iterable<S> source) => source.cast<T>();
  Iterator<E> get iterator;
  Iterable<R> cast<R>() => CastIterable<E, R>(this);
  Iterable<E> followedBy(Iterable<E> other) => FollowedByIterable<E>(this, other);
  Iterable<T> map<T>(T Function(E e) toElement) => MappedIterable<E, T>(this, toElement);
  Iterable<E> where(bool Function(E element) test) => WhereIterable<E>(this, test);
  Iterable<T> whereType<T>() => WhereTypeIterable<T>(this);
  Iterable<T> expand<T>(Iterable<T> Function(E element) toElements) => ExpandIterable<E, T>(this, toElements);
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
    while (iterator.moveNext()) {
      value = combine(value, iterator.current);
    }
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
    Iterator<E> iterator = this.iterator;
    if (!iterator.moveNext()) return "";
    var first = iterator.current.toString();
    if (!iterator.moveNext()) return first;
    var buffer = StringBuffer(first);
    if (separator.isEmpty) {
      do {
        buffer.write(iterator.current.toString());
      } while (iterator.moveNext());
    } else {
      do {
        buffer
          ..write(separator)
          ..write(iterator.current.toString());
      } while (iterator.moveNext());
    }
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
    while (it.moveNext()) {
      count++;
    }
    return count;
  }
  bool get isEmpty => !iterator.moveNext();
  bool get isNotEmpty => !isEmpty;
  Iterable<E> take(int count) {
    RangeError.checkNotNegative(count, "takeCount");
    return TakeIterable<E>(this, count);
  }
  Iterable<E> takeWhile(bool Function(E value) test) => TakeWhileIterable<E>(this, test);
  Iterable<E> skip(int count) {
    RangeError.checkNotNegative(count, "skipCount");
    return SkipIterable<E>(this, count);
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
  E get single {
    Iterator<E> it = iterator;
    if (!it.moveNext()) throw StateError("No element");
    E result = it.current;
    if (it.moveNext()) throw StateError("Too many elements");
    return result;
  }
  E firstWhere(bool Function(E element) test, {E Function()? orElse}) {
    for (E element in this) {
      if (test(element)) return element;
    }
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E lastWhere(bool Function(E element) test, {E Function()? orElse}) {
    Iterator<E> iterator = this.iterator;
    E result;
    do {
      if (!iterator.moveNext()) {
        if (orElse != null) return orElse();
        throw StateError("No element");
      }
      result = iterator.current;
    } while (!test(result));
    while (iterator.moveNext()) {
      E current = iterator.current;
      if (test(current)) result = current;
    }
    return result;
  }
  E singleWhere(bool Function(E element) test, {E Function()? orElse}) {
    Iterator<E> iterator = this.iterator;
    E result;
    do {
      if (!iterator.moveNext()) {
        if (orElse != null) return orElse();
        throw StateError("No element");
      }
      result = iterator.current;
    } while (!test(result));
    while (iterator.moveNext()) {
      if (test(iterator.current)) throw StateError("Too many elements");
    }
    return result;
  }
  E elementAt(int index) {
    RangeError.checkNotNegative(index, "index");
    var iterator = this.iterator;
    var skipCount = index;
    while (iterator.moveNext()) {
      if (skipCount == 0) return iterator.current;
      skipCount--;
    }
    throw IndexError.withLength(index, index - skipCount, indexable: this, name: "index");
  }
  String toString() => Iterable.iterableToShortString(this, '(', ')');
  static String iterableToShortString(Iterable iterable, [String leftDelimiter = '(', String rightDelimiter = ')']) {
    if (_isToStringVisiting(iterable)) {
      if (leftDelimiter == "(" && rightDelimiter == ")") return "(...)";
      return "$leftDelimiter...$rightDelimiter";
    }
    List<String> parts = <String>[];
    _toStringVisitingAdd(iterable);
    try {
      _iterablePartsToStrings(iterable, parts);
    } finally {
      _toStringVisitingRemove(iterable);
    }
    return (StringBuffer(leftDelimiter)
          ..writeAll(parts, ", ")
          ..write(rightDelimiter))
        .toString();
  }
  static String iterableToFullString(Iterable iterable, [String leftDelimiter = '(', String rightDelimiter = ')']) {
    if (_isToStringVisiting(iterable)) return "$leftDelimiter...$rightDelimiter";
    StringBuffer buffer = StringBuffer(leftDelimiter);
    _toStringVisitingAdd(iterable);
    try {
      buffer.writeAll(iterable, ", ");
    } finally {
      _toStringVisitingRemove(iterable);
    }
    buffer.write(rightDelimiter);
    return buffer.toString();
  }
}

external bool _isToStringVisiting(Object o);
external void _toStringVisitingAdd(Object o);
external void _toStringVisitingRemove(Object o);

void _iterablePartsToStrings(Iterable<Object?> iterable, List<Object> parts) {
  const int lengthLimit = 80;
  const int headCount = 3;
  const int tailCount = 2;
  const int maxCount = 100;
  const int overhead = 2;
  const int ellipsisSize = 3;
  int length = 0;
  int count = 0;
  Iterator<Object?> it = iterable.iterator;
  while (length < lengthLimit || count < headCount) {
    if (!it.moveNext()) return;
    String next = "" + it.current.toString();
    parts.add(next);
    length += next.length + overhead;
    count++;
  }
  String penultimateString;
  String ultimateString;
  Object? penultimate;
  Object? ultimate;
  if (!it.moveNext()) {
    if (count <= headCount + tailCount) return;
    ultimateString = parts.removeLast() as String;
    penultimateString = parts.removeLast() as String;
  } else {
    penultimate = it.current;
    count++;
    if (!it.moveNext()) {
      if (count <= headCount + 1) {
        parts.add("$penultimate");
        return;
      }
      ultimateString = "$penultimate";
      penultimateString = parts.removeLast() as String;
      length += ultimateString.length + overhead;
    } else {
      ultimate = it.current;
      count++;
      while (it.moveNext()) {
        penultimate = ultimate;
        ultimate = it.current;
        count++;
        if (count > maxCount) {
          while (length > lengthLimit - ellipsisSize - overhead && count > headCount) {
            length -= (parts.removeLast() as String).length + overhead;
            count--;
          }
          parts.add("...");
          return;
        }
      }
      penultimateString = "$penultimate";
      ultimateString = "$ultimate";
      length += ultimateString.length + penultimateString.length + 2 * overhead;
    }
  }
  String? elision;
  if (count > parts.length + tailCount) {
    elision = "...";
    length += ellipsisSize + overhead;
  }
  while (length > lengthLimit && parts.length > headCount) {
    length -= (parts.removeLast() as String).length + overhead;
    if (elision == null) {
      elision = "...";
      length += ellipsisSize + overhead;
    }
  }
  if (elision != null) parts.add(elision);
  parts.add(penultimateString);
  parts.add(ultimateString);
}

class _EmptyIterable<E> extends Iterable<E> {
  const _EmptyIterable();
  Iterator<E> get iterator => _EmptyIterator<E>();
  int get length => 0;
}

class _EmptyIterator<E> implements Iterator<E> {
  const _EmptyIterator();
  bool moveNext() => false;
  E get current => throw StateError("No element");
}

class _GeneratorIterable<E> extends ListIterable<E> {
  final int _count;
  final E Function(int)? _generator;
  _GeneratorIterable(this._count, this._generator) {
    RangeError.checkNotNegative(_count, "count");
  }
  int get length => _count;
  E elementAt(int index) {
    RangeError.checkValidIndex(index, this, "index", _count);
    return _generate(index);
  }
  E _generate(int index) {
    var generator = _generator;
    if (generator == null) return index as E;
    return generator(index);
  }
  Iterator<E> get iterator => _GeneratorIterator<E>(this);
}

class _GeneratorIterator<E> implements Iterator<E> {
  final _GeneratorIterable<E> _iterable;
  int _index = 0;
  E? _current;
  _GeneratorIterator(this._iterable);
  bool moveNext() {
    if (_index < _iterable._count) {
      _current = _iterable._generate(_index);
      _index++;
      return true;
    }
    _current = null;
    return false;
  }
  E get current => _current as E;
}

class MappedIterable<S, T> extends Iterable<T> {
  final Iterable<S> _iterable;
  final T Function(S) _f;
  MappedIterable(this._iterable, this._f);
  Iterator<T> get iterator => MappedIterator<S, T>(_iterable.iterator, _f);
  int get length => _iterable.length;
  bool get isEmpty => _iterable.isEmpty;
  T get first => _f(_iterable.first);
  T get last => _f(_iterable.last);
  T get single => _f(_iterable.single);
  T elementAt(int index) => _f(_iterable.elementAt(index));
}

class MappedIterator<S, T> implements Iterator<T> {
  T? _current;
  final Iterator<S> _iterator;
  final T Function(S) _f;
  MappedIterator(this._iterator, this._f);
  bool moveNext() {
    if (_iterator.moveNext()) {
      _current = _f(_iterator.current);
      return true;
    }
    _current = null;
    return false;
  }
  T get current => _current as T;
}

class WhereIterable<E> extends Iterable<E> {
  final Iterable<E> _iterable;
  final bool Function(E) _f;
  WhereIterable(this._iterable, this._f);
  Iterator<E> get iterator => WhereIterator<E>(_iterable.iterator, _f);
  Iterable<T> map<T>(T Function(E element) toElement) => MappedIterable<E, T>(this, toElement);
}

class WhereIterator<E> implements Iterator<E> {
  final Iterator<E> _iterator;
  final bool Function(E) _f;
  WhereIterator(this._iterator, this._f);
  bool moveNext() {
    while (_iterator.moveNext()) {
      if (_f(_iterator.current)) return true;
    }
    return false;
  }
  E get current => _iterator.current;
}

class WhereTypeIterable<T> extends Iterable<T> {
  final Iterable<Object?> _source;
  WhereTypeIterable(this._source);
  Iterator<T> get iterator => WhereTypeIterator<T>(_source.iterator);
}

class WhereTypeIterator<T> implements Iterator<T> {
  final Iterator<Object?> _source;
  WhereTypeIterator(this._source);
  bool moveNext() {
    while (_source.moveNext()) {
      if (_source.current is T) return true;
    }
    return false;
  }
  T get current => _source.current as T;
}

class ExpandIterable<S, T> extends Iterable<T> {
  final Iterable<S> _iterable;
  final Iterable<T> Function(S) _f;
  ExpandIterable(this._iterable, this._f);
  Iterator<T> get iterator => ExpandIterator<S, T>(_iterable.iterator, _f);
}

class ExpandIterator<S, T> implements Iterator<T> {
  final Iterator<S> _iterator;
  final Iterable<T> Function(S) _f;
  Iterator<T> _currentExpansion = _EmptyIterator<T>();
  T? _current;
  ExpandIterator(this._iterator, this._f);
  T get current => _current as T;
  bool moveNext() {
    while (!_currentExpansion.moveNext()) {
      _current = null;
      if (_iterator.moveNext()) {
        _currentExpansion = _f(_iterator.current).iterator;
      } else {
        return false;
      }
    }
    _current = _currentExpansion.current;
    return true;
  }
}

class TakeIterable<E> extends Iterable<E> {
  final Iterable<E> _iterable;
  final int _takeCount;
  TakeIterable(this._iterable, this._takeCount);
  Iterator<E> get iterator => TakeIterator<E>(_iterable.iterator, _takeCount);
}

class TakeIterator<E> implements Iterator<E> {
  final Iterator<E> _iterator;
  int _remaining;
  TakeIterator(this._iterator, this._remaining);
  bool moveNext() {
    _remaining--;
    if (_remaining >= 0) return _iterator.moveNext();
    _remaining = -1;
    return false;
  }
  E get current {
    if (_remaining < 0) return null as E;
    return _iterator.current;
  }
}

class TakeWhileIterable<E> extends Iterable<E> {
  final Iterable<E> _iterable;
  final bool Function(E) _f;
  TakeWhileIterable(this._iterable, this._f);
  Iterator<E> get iterator => TakeWhileIterator<E>(_iterable.iterator, _f);
}

class TakeWhileIterator<E> implements Iterator<E> {
  final Iterator<E> _iterator;
  final bool Function(E) _f;
  bool _isFinished = false;
  TakeWhileIterator(this._iterator, this._f);
  bool moveNext() {
    if (_isFinished) return false;
    if (!_iterator.moveNext() || !_f(_iterator.current)) {
      _isFinished = true;
      return false;
    }
    return true;
  }
  E get current {
    if (_isFinished) return null as E;
    return _iterator.current;
  }
}

class SkipIterable<E> extends Iterable<E> {
  final Iterable<E> _iterable;
  final int _skipCount;
  SkipIterable(this._iterable, this._skipCount);
  Iterator<E> get iterator => SkipIterator<E>(_iterable.iterator, _skipCount);
}

class SkipIterator<E> implements Iterator<E> {
  final Iterator<E> _iterator;
  int _skipCount;
  SkipIterator(this._iterator, this._skipCount);
  bool moveNext() {
    for (int i = 0; i < _skipCount; i++) _iterator.moveNext();
    _skipCount = 0;
    return _iterator.moveNext();
  }
  E get current => _iterator.current;
}

class SkipWhileIterable<E> extends Iterable<E> {
  final Iterable<E> _iterable;
  final bool Function(E) _f;
  SkipWhileIterable(this._iterable, this._f);
  Iterator<E> get iterator => SkipWhileIterator<E>(_iterable.iterator, _f);
}

class SkipWhileIterator<E> implements Iterator<E> {
  final Iterator<E> _iterator;
  final bool Function(E) _f;
  bool _hasSkipped = false;
  SkipWhileIterator(this._iterator, this._f);
  bool moveNext() {
    if (!_hasSkipped) {
      _hasSkipped = true;
      while (_iterator.moveNext()) {
        if (!_f(_iterator.current)) return true;
      }
    }
    return _iterator.moveNext();
  }
  E get current => _iterator.current;
}

class FollowedByIterable<E> extends Iterable<E> {
  final Iterable<E> _first;
  final Iterable<E> _second;
  FollowedByIterable(this._first, this._second);
  Iterator<E> get iterator => FollowedByIterator<E>(_first, _second);
}

class FollowedByIterator<E> implements Iterator<E> {
  Iterator<E> _currentIterator;
  Iterable<E>? _nextIterable;
  FollowedByIterator(Iterable<E> first, this._nextIterable) : _currentIterator = first.iterator;
  bool moveNext() {
    if (_currentIterator.moveNext()) return true;
    if (_nextIterable != null) {
      _currentIterator = _nextIterable!.iterator;
      _nextIterable = null;
      return _currentIterator.moveNext();
    }
    return false;
  }
  E get current => _currentIterator.current;
}

class CastIterable<S, T> extends Iterable<T> {
  final Iterable<S> _source;
  CastIterable(this._source);
  Iterator<T> get iterator => CastIterator<S, T>(_source.iterator);
}

class CastIterator<S, T> implements Iterator<T> {
  final Iterator<S> _source;
  CastIterator(this._source);
  bool moveNext() => _source.moveNext();
  T get current => _source.current as T;
}

class _SyncStarIterable<E> extends Iterable<E> {
  _SyncStarIterable._();
  external Iterator<E> get iterator;
}

class _SyncStarIterator<E> implements Iterator<E> {
  _SyncStarIterator._();
  external bool moveNext();
  external E get current;
}

/** An iterable with an efficient length and indexed elements, as the VM's ListIterable. */
abstract class ListIterable<E> extends Iterable<E> {
  ListIterable();
  int get length;
  E elementAt(int index);
  Iterator<E> get iterator => ListIterator<E>(this);
  void forEach(void Function(E element) action) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      action(elementAt(i));
      if (length != this.length) throw ConcurrentModificationError(this);
    }
  }
  bool get isEmpty => length == 0;
  E get first {
    if (length == 0) throw StateError("No element");
    return elementAt(0);
  }
  E get last {
    if (length == 0) throw StateError("No element");
    return elementAt(length - 1);
  }
  E get single {
    if (length == 0) throw StateError("No element");
    if (length > 1) throw StateError("Too many elements");
    return elementAt(0);
  }
  bool contains(Object? element) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (elementAt(i) == element) return true;
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    return false;
  }
  Iterable<T> map<T>(T Function(E element) toElement) => MappedListIterable<E, T>(this, toElement);
  Iterable<E> skip(int count) => SubListIterable<E>(this, count, null);
  Iterable<E> take(int count) => SubListIterable<E>(this, 0, count);
}

class MappedListIterable<S, T> extends ListIterable<T> {
  final Iterable<S> _source;
  final T Function(S) _f;
  MappedListIterable(this._source, this._f);
  int get length => _source.length;
  T elementAt(int index) => _f(_source.elementAt(index));
}

class ReversedListIterable<E> extends ListIterable<E> {
  final Iterable<E> _source;
  ReversedListIterable(this._source);
  int get length => _source.length;
  E elementAt(int index) => _source.elementAt(_source.length - 1 - index);
}

class SubListIterable<E> extends ListIterable<E> {
  final Iterable<E> _source;
  final int _start;
  final int? _endOrLength;
  SubListIterable(this._source, this._start, this._endOrLength) {
    RangeError.checkNotNegative(_start, "start");
    int? endOrLength = _endOrLength;
    if (endOrLength != null) {
      RangeError.checkNotNegative(endOrLength, "end");
      if (_start > endOrLength) throw RangeError.range(_start, 0, endOrLength, "start");
    }
  }
  int get _endIndex {
    int length = _source.length;
    int? endOrLength = _endOrLength;
    if (endOrLength == null || endOrLength > length) return length;
    return endOrLength;
  }
  int get _startIndex {
    int length = _source.length;
    if (_start > length) return length;
    return _start;
  }
  int get length {
    int length = _source.length;
    if (_start >= length) return 0;
    int? endOrLength = _endOrLength;
    if (endOrLength == null || endOrLength >= length) return length - _start;
    return endOrLength - _start;
  }
  E elementAt(int index) {
    int realIndex = _startIndex + index;
    if (index < 0 || realIndex >= _endIndex) throw IndexError.withLength(index, length, indexable: this, name: "index");
    return _source.elementAt(realIndex);
  }
  Iterable<E> skip(int count) {
    RangeError.checkNotNegative(count, "count");
    int newStart = _start + count;
    int? endOrLength = _endOrLength;
    if (endOrLength != null && newStart >= endOrLength) return Iterable<E>.empty();
    return SubListIterable<E>(_source, newStart, _endOrLength);
  }
  Iterable<E> take(int count) {
    RangeError.checkNotNegative(count, "count");
    int? endOrLength = _endOrLength;
    if (endOrLength == null) return SubListIterable<E>(_source, _start, _start + count);
    int newEnd = _start + count;
    if (endOrLength < newEnd) return this;
    return SubListIterable<E>(_source, _start, newEnd);
  }
}

class ListIterator<E> implements Iterator<E> {
  final Iterable<E> _iterable;
  final int _length;
  int _index = 0;
  E? _current;
  ListIterator(Iterable<E> iterable) : _iterable = iterable, _length = iterable.length;
  E get current => _current as E;
  bool moveNext() {
    int length = _iterable.length;
    if (_length != length) throw ConcurrentModificationError(_iterable);
    if (_index >= length) {
      _current = null;
      return false;
    }
    _current = _iterable.elementAt(_index);
    _index++;
    return true;
  }
}

extension IterableExtensions<T> on Iterable<T> {
  T? get firstOrNull {
    var iterator = this.iterator;
    if (iterator.moveNext()) return iterator.current;
    return null;
  }
  T? get lastOrNull {
    if (isEmpty) return null;
    return last;
  }
  T? get singleOrNull {
    var iterator = this.iterator;
    if (iterator.moveNext()) {
      var result = iterator.current;
      if (!iterator.moveNext()) return result;
    }
    return null;
  }
  T? elementAtOrNull(int index) {
    RangeError.checkNotNegative(index, "index");
    var iterator = this.iterator;
    for (var i = 0; i <= index; i++) {
      if (!iterator.moveNext()) return null;
    }
    return iterator.current;
  }
  Iterable<(int, T)> get indexed sync* {
    var index = 0;
    for (var element in this) yield (index++, element);
  }
}

extension NullableIterableExtensions<T extends Object> on Iterable<T?> {
  Iterable<T> get nonNulls sync* {
    for (var element in this) {
      if (element != null) yield element;
    }
  }
}

// Lists

abstract interface class List<E> extends Iterable<E> {
  external factory List.filled(int length, E fill, {bool growable = false});
  external factory List.empty({bool growable = false});
  external factory List.from(Iterable elements, {bool growable = true});
  external factory List.of(Iterable<E> elements, {bool growable = true});
  external factory List.generate(int length, E Function(int index) generator, {bool growable = true});
  external factory List.unmodifiable(Iterable elements);
  static List<T> castFrom<S, T>(List<S> source) => source.cast<T>();
  static void copyRange<T>(List<T> target, int at, List<T> source, [int? start, int? end]) {
    start ??= 0;
    end = RangeError.checkValidRange(start, end, source.length);
    int length = end - start;
    if (target.length < at + length) throw ArgumentError.value(target, "target", "Not big enough to hold " + length.toString() + " elements at position " + at.toString());
    if (!identical(source, target) || start >= at) {
      for (int i = 0; i < length; i++) target[at + i] = source[start + i];
    } else {
      for (int i = length; --i >= 0;) target[at + i] = source[start + i];
    }
  }
  external E operator [](int index);
  external void operator []=(int index, E value);
  external int get length;
  external set length(int newLength);
  external E get first;
  external set first(E value);
  external E get last;
  external set last(E value);
  external E get single;
  external bool get isEmpty;
  external bool get isNotEmpty;
  external Iterator<E> get iterator;
  external void add(E value);
  external void addAll(Iterable<E> iterable);
  Iterable<E> get reversed => ReversedListIterable<E>(this);
  external void sort([int Function(E a, E b)? compare]);
  external void shuffle([dynamic random]);
  external int indexOf(E element, [int start = 0]);
  external int indexWhere(bool Function(E element) test, [int start = 0]);
  external int lastIndexWhere(bool Function(E element) test, [int? start]);
  external int lastIndexOf(E element, [int? start]);
  external void clear();
  external void insert(int index, E element);
  external void insertAll(int index, Iterable<E> iterable);
  external void setAll(int index, Iterable<E> iterable);
  external bool remove(Object? value);
  external E removeAt(int index);
  external E removeLast();
  external void removeWhere(bool Function(E element) test);
  external void retainWhere(bool Function(E element) test);
  external List<E> operator +(List<E> other);
  external List<E> sublist(int start, [int? end]);
  Iterable<E> getRange(int start, int end) {
    RangeError.checkValidRange(start, end, this.length);
    return SubListIterable<E>(this, start, end);
  }
  external void setRange(int start, int end, Iterable<E> iterable, [int skipCount = 0]);
  external void removeRange(int start, int end);
  external void fillRange(int start, int end, [E? fillValue]);
  external void replaceRange(int start, int end, Iterable<E> replacements);
  external Map<int, E> asMap();
  external bool contains(Object? element);
  external void forEach(void Function(E element) action);
  external String join([String separator = ""]);
  external E elementAt(int index);
  external List<R> cast<R>();
  external bool operator ==(Object other);
  external int get hashCode;
  external String toString();
  Iterable<R> map<R>(R Function(E e) toElement) => MappedListIterable<E, R>(this, toElement);
  Iterable<E> where(bool Function(E element) test) => WhereIterable<E>(this, test);
  Iterable<T> whereType<T>() => WhereTypeIterable<T>(this);
  Iterable<T> expand<T>(Iterable<T> Function(E element) toElements) => ExpandIterable<E, T>(this, toElements);
  Iterable<E> followedBy(Iterable<E> other) => FollowedByIterable<E>(this, other);
  E reduce(E Function(E value, E element) combine) {
    int length = this.length;
    if (length == 0) throw StateError("No element");
    E value = this[0];
    for (int i = 1; i < length; i++) {
      value = combine(value, this[i]);
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    return value;
  }
  T fold<T>(T initialValue, T Function(T previousValue, E element) combine) {
    var value = initialValue;
    int length = this.length;
    for (int i = 0; i < length; i++) {
      value = combine(value, this[i]);
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    return value;
  }
  bool every(bool Function(E element) test) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (!test(this[i])) return false;
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    return true;
  }
  bool any(bool Function(E element) test) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      if (test(this[i])) return true;
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    return false;
  }
  E firstWhere(bool Function(E element) test, {E Function()? orElse}) {
    int length = this.length;
    for (int i = 0; i < length; i++) {
      E element = this[i];
      if (test(element)) return element;
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  E lastWhere(bool Function(E element) test, {E Function()? orElse}) {
    int length = this.length;
    for (int i = length - 1; i >= 0; i--) {
      E element = this[i];
      if (test(element)) return element;
      if (length != this.length) throw ConcurrentModificationError(this);
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
        if (matchFound) throw StateError("Too many elements");
        matchFound = true;
        match = element;
      }
      if (length != this.length) throw ConcurrentModificationError(this);
    }
    if (matchFound) return match;
    if (orElse != null) return orElse();
    throw StateError("No element");
  }
  Iterable<E> skip(int count) => SubListIterable<E>(this, count, null);
  Iterable<E> skipWhile(bool Function(E element) test) => SkipWhileIterable<E>(this, test);
  Iterable<E> take(int count) => SubListIterable<E>(this, 0, count);
  Iterable<E> takeWhile(bool Function(E element) test) => TakeWhileIterable<E>(this, test);
  List<E> toList({bool growable = true}) => List<E>.of(this, growable: growable);
  Set<E> toSet() => Set<E>.of(this);
}

class _ListIterator<E> implements ListIterator<E> {
  _ListIterator._();
  external bool moveNext();
  external E get current;
}

// Sets and maps

abstract interface class Set<E> extends Iterable<E> {
  Set._base();
  external factory Set();
  external factory Set.identity();
  external factory Set.from(Iterable elements);
  external factory Set.of(Iterable<E> elements);
  external factory Set.unmodifiable(Iterable<E> elements);
  static Set<T> castFrom<S, T>(Set<S> source, {Set<R> Function<R>()? newSet}) => source.cast<T>();
  external Iterator<E> get iterator;
  external bool contains(Object? value);
  external bool add(E value);
  external void addAll(Iterable<E> elements);
  external bool remove(Object? value);
  external E? lookup(Object? object);
  external void removeAll(Iterable<Object?> elements);
  external void retainAll(Iterable<Object?> elements);
  external void removeWhere(bool Function(E element) test);
  external void retainWhere(bool Function(E element) test);
  external bool containsAll(Iterable<Object?> other);
  external Set<E> intersection(Set<Object?> other);
  external Set<E> union(Set<E> other);
  external Set<E> difference(Set<Object?> other);
  external void clear();
  external Set<R> cast<R>();
  external int get length;
  external bool get isEmpty;
  external bool get isNotEmpty;
  external E get first;
  external E get last;
  external Set<E> toSet();
  external String toString();
}

class _Set<E> extends Set<E> implements LinkedHashSet<E> {
  _Set._() : super._base();
}

abstract final class LinkedHashSet<E> implements Set<E> {
  factory LinkedHashSet({bool Function(E, E)? equals, int Function(E)? hashCode, bool Function(dynamic)? isValidKey}) => _newSet<E>();
  factory LinkedHashSet.identity() => _newSet<E>();
  factory LinkedHashSet.from(Iterable<dynamic> elements) => Set<E>.from(elements) as LinkedHashSet<E>;
  factory LinkedHashSet.of(Iterable<E> elements) => Set<E>.of(elements) as LinkedHashSet<E>;
}

LinkedHashSet<E> _newSet<E>() => <E>{} as LinkedHashSet<E>;

class _SetIterator<E> implements Iterator<E> {
  _SetIterator._();
  external bool moveNext();
  external E get current;
}

final class MapEntry<K, V> {
  final K key;
  final V value;
  const factory MapEntry(K key, V value) = MapEntry<K, V>._;
  const MapEntry._(this.key, this.value);
  String toString() => "MapEntry(" + key.toString() + ": " + value.toString() + ")";
}

abstract interface class Map<K, V> {
  Map._base();
  external factory Map();
  external factory Map.from(Map other);
  external factory Map.of(Map<K, V> other);
  external factory Map.unmodifiable(Map<dynamic, dynamic> other);
  external factory Map.identity();
  external factory Map.fromIterable(Iterable iterable, {K Function(dynamic element)? key, V Function(dynamic element)? value});
  external factory Map.fromIterables(Iterable<K> keys, Iterable<V> values);
  external factory Map.fromEntries(Iterable<MapEntry<K, V>> entries);
  static Map<K2, V2> castFrom<K, V, K2, V2>(Map<K, V> source) => source.cast<K2, V2>();
  external Map<RK, RV> cast<RK, RV>();
  external bool containsValue(Object? value);
  external bool containsKey(Object? key);
  external V? operator [](Object? key);
  external void operator []=(K key, V value);
  external Iterable<MapEntry<K, V>> get entries;
  Map<K2, V2> map<K2, V2>(MapEntry<K2, V2> Function(K key, V value) convert) {
    var result = <K2, V2>{};
    for (var key in this.keys) {
      var entry = convert(key, this[key] as V);
      result[entry.key] = entry.value;
    }
    return result;
  }
  external void addEntries(Iterable<MapEntry<K, V>> newEntries);
  V update(K key, V Function(V value) update, {V Function()? ifAbsent}) {
    if (this.containsKey(key)) {
      return this[key] = update(this[key] as V);
    }
    if (ifAbsent != null) {
      return this[key] = ifAbsent();
    }
    throw ArgumentError.value(key, "key", "Key not in map.");
  }
  void updateAll(V Function(K key, V value) update) {
    for (var key in this.keys.toList()) {
      this[key] = update(key, this[key] as V);
    }
  }
  external void removeWhere(bool Function(K key, V value) test);
  V putIfAbsent(K key, V Function() ifAbsent) {
    if (containsKey(key)) return this[key] as V;
    return this[key] = ifAbsent();
  }
  external void addAll(Map<K, V> other);
  external V? remove(Object? key);
  external void clear();
  void forEach(void Function(K key, V value) action) {
    for (var key in this.keys) {
      action(key, this[key] as V);
    }
  }
  external Iterable<K> get keys;
  external Iterable<V> get values;
  external int get length;
  external bool get isEmpty;
  external bool get isNotEmpty;
  String toString() => _mapToString(this);
}

class _Map<K, V> extends Map<K, V> implements LinkedHashMap<K, V> {
  _Map._() : super._base();
}

abstract final class LinkedHashMap<K, V> implements Map<K, V> {
  factory LinkedHashMap({bool Function(K, K)? equals, int Function(K)? hashCode, bool Function(dynamic)? isValidKey}) => _newMap<K, V>();
  factory LinkedHashMap.identity() => _newMap<K, V>();
  factory LinkedHashMap.from(Map<dynamic, dynamic> other) => Map<K, V>.from(other) as LinkedHashMap<K, V>;
  factory LinkedHashMap.of(Map<K, V> other) => Map<K, V>.of(other) as LinkedHashMap<K, V>;
  factory LinkedHashMap.fromIterable(Iterable iterable, {K Function(dynamic element)? key, V Function(dynamic element)? value}) =>
      Map<K, V>.fromIterable(iterable, key: key, value: value) as LinkedHashMap<K, V>;
  factory LinkedHashMap.fromIterables(Iterable<K> keys, Iterable<V> values) => Map<K, V>.fromIterables(keys, values) as LinkedHashMap<K, V>;
  factory LinkedHashMap.fromEntries(Iterable<MapEntry<K, V>> entries) => Map<K, V>.fromEntries(entries) as LinkedHashMap<K, V>;
}

LinkedHashMap<K, V> _newMap<K, V>() => <K, V>{} as LinkedHashMap<K, V>;

String _mapToString(Map<Object?, Object?> m) {
  if (_isToStringVisiting(m)) return '{...}';
  var result = StringBuffer();
  try {
    _toStringVisitingAdd(m);
    result.write('{');
    bool first = true;
    m.forEach((Object? k, Object? v) {
      if (!first) {
        result.write(', ');
      }
      first = false;
      result.write(k);
      result.write(': ');
      result.write(v);
    });
    result.write('}');
  } finally {
    _toStringVisitingRemove(m);
  }
  return result.toString();
}

class _CompactKeysIterable<K> extends Iterable<K> {
  _CompactKeysIterable._();
  external Iterator<K> get iterator;
  external int get length;
  external bool contains(Object? element);
}

class _CompactValuesIterable<V> extends Iterable<V> {
  _CompactValuesIterable._();
  external Iterator<V> get iterator;
  external int get length;
}

class _CompactEntriesIterable<K, V> extends Iterable<MapEntry<K, V>> {
  _CompactEntriesIterable._();
  external Iterator<MapEntry<K, V>> get iterator;
  external int get length;
}

class _MapIterator<E> implements Iterator<E> {
  _MapIterator._();
  external bool moveNext();
  external E get current;
}

// Big integers

abstract final class BigInt implements Comparable<BigInt> {
  BigInt._base();
  external static BigInt get zero;
  external static BigInt get one;
  external static BigInt get two;
  external static BigInt parse(String source, {int? radix});
  external static BigInt? tryParse(String source, {int? radix});
  external factory BigInt.from(num value);
  external BigInt abs();
  external BigInt operator -();
  external BigInt operator +(BigInt other);
  external BigInt operator -(BigInt other);
  external BigInt operator *(BigInt other);
  external double operator /(BigInt other);
  external BigInt operator ~/(BigInt other);
  external BigInt operator %(BigInt other);
  external BigInt remainder(BigInt other);
  external BigInt operator <<(int shiftAmount);
  external BigInt operator >>(int shiftAmount);
  external BigInt operator &(BigInt other);
  external BigInt operator |(BigInt other);
  external BigInt operator ^(BigInt other);
  external BigInt operator ~();
  external bool operator <(BigInt other);
  external bool operator <=(BigInt other);
  external bool operator >(BigInt other);
  external bool operator >=(BigInt other);
  external bool operator ==(Object other);
  external int get hashCode;
  external int compareTo(BigInt other);
  external BigInt toUnsigned(int width);
  external BigInt toSigned(int width);
  external int get bitLength;
  external int get sign;
  external bool get isEven;
  external bool get isOdd;
  external bool get isNegative;
  external BigInt pow(int exponent);
  external BigInt modPow(BigInt exponent, BigInt modulus);
  external BigInt modInverse(BigInt modulus);
  external BigInt gcd(BigInt other);
  external bool get isValidInt;
  external int toInt();
  external double toDouble();
  external String toString();
  external String toRadixString(int radix);
}

final class _BigIntImpl extends BigInt {
  _BigIntImpl._() : super._base();
}

// Regular expressions

abstract interface class RegExp implements Pattern {
  RegExp._base();
  external factory RegExp(String source, {bool multiLine = false, bool caseSensitive = true, bool unicode = false, bool dotAll = false});
  external static String escape(String text);
  external RegExpMatch? firstMatch(String input);
  external Iterable<RegExpMatch> allMatches(String input, [int start = 0]);
  external RegExpMatch? matchAsPrefix(String string, [int start = 0]);
  external bool hasMatch(String input);
  external String? stringMatch(String input);
  external String get pattern;
  external bool get isMultiLine;
  external bool get isCaseSensitive;
  external bool get isUnicode;
  external bool get isDotAll;
  external String toString();
}

abstract interface class RegExpMatch implements Match {
  RegExpMatch._base();
  external int get start;
  external int get end;
  external String? group(int group);
  external String? operator [](int group);
  external List<String?> groups(List<int> groupIndices);
  external int get groupCount;
  external String get input;
  external Pattern get pattern;
  external String? namedGroup(String name);
  external Iterable<String> get groupNames;
}

class _RegExp extends RegExp {
  _RegExp._() : super._base();
}

class _RegExpMatch extends RegExpMatch {
  _RegExpMatch._() : super._base();
}

class _StringMatch implements Match {
  final int start;
  final String input;
  final String pattern;
  _StringMatch(this.start, this.input, this.pattern);
  int get end => start + pattern.length;
  String operator [](int g) => group(g);
  int get groupCount => 0;
  String group(int group) {
    if (group != 0) throw RangeError.value(group);
    return pattern;
  }
  List<String> groups(List<int> groups) {
    List<String> result = <String>[];
    for (int g in groups) result.add(group(g));
    return result;
  }
}

class _MatchesIterable extends Iterable<RegExpMatch> {
  _MatchesIterable._();
  external Iterator<RegExpMatch> get iterator;
}

class _MatchesIterator implements Iterator<RegExpMatch> {
  _MatchesIterator._();
  external bool moveNext();
  external RegExpMatch get current;
}

// The turtle of trace-dojo

class Turtle {
  external Turtle([int x = 0, int y = 0, String color = '#']);
  external void forward();
  external void backward();
  external void turnRight();
  external void turnLeft();
  external bool canMoveForward();
  external bool isFrontPainted();
  external void remove();
}
`;
