/** dart:math, as the interpreter declares it. The sources must not contain `${`. */
export const MATH_SOURCE = String.raw`
const double e = 2.718281828459045;
const double ln10 = 2.302585092994046;
const double ln2 = 0.6931471805599453;
const double log2e = 1.4426950408889634;
const double log10e = 0.4342944819032518;
const double pi = 3.1415926535897932;
const double sqrt1_2 = 0.7071067811865476;
const double sqrt2 = 1.4142135623730951;

external T min<T extends num>(T a, T b);
external T max<T extends num>(T a, T b);
external double atan2(num a, num b);
external num pow(num x, num exponent);
external double sin(num radians);
external double cos(num radians);
external double tan(num radians);
external double acos(num x);
external double asin(num x);
external double atan(num x);
external double sqrt(num x);
external double exp(num x);
external double log(num x);
external int _systemHash(int first, int second, [int? third, int? fourth]);

abstract interface class Random {
  external factory Random([int? seed]);
  external factory Random.secure();
  external int nextInt(int max);
  external double nextDouble();
  external bool nextBool();
}

class Point<T extends num> {
  final T x;
  final T y;
  const Point(T x, T y) : this.x = x, this.y = y;
  String toString() => "Point(" + x.toString() + ", " + y.toString() + ")";
  bool operator ==(Object other) => other is Point<num> && x == other.x && y == other.y;
  int get hashCode => _systemHash(x.hashCode, y.hashCode);
  Point<T> operator +(Point<T> other) => Point<T>((x + other.x) as T, (y + other.y) as T);
  Point<T> operator -(Point<T> other) => Point<T>((x - other.x) as T, (y - other.y) as T);
  Point<T> operator *(num factor) => Point<T>((x * factor) as T, (y * factor) as T);
  double get magnitude => sqrt(x * x + y * y);
  double distanceTo(Point<T> other) {
    var dx = x - other.x;
    var dy = y - other.y;
    return sqrt(dx * dx + dy * dy);
  }
  T squaredDistanceTo(Point<T> other) {
    var dx = x - other.x;
    var dy = y - other.y;
    return (dx * dx + dy * dy) as T;
  }
}

abstract mixin class _RectangleBase<T extends num> {
  T get left;
  T get top;
  T get width;
  T get height;
  T get right => (left + width) as T;
  T get bottom => (top + height) as T;
  String toString() => "Rectangle (" + left.toString() + ", " + top.toString() + ") " + width.toString() + " x " + height.toString();
  bool operator ==(Object other) => other is Rectangle && left == other.left && top == other.top && right == other.right && bottom == other.bottom;
  int get hashCode => _systemHash(left.hashCode, top.hashCode, right.hashCode, bottom.hashCode);
  Rectangle<T>? intersection(Rectangle<T> other) {
    var x0 = max(left, other.left);
    var x1 = min(left + width, other.left + other.width);
    if (x0 <= x1) {
      var y0 = max(top, other.top);
      var y1 = min(top + height, other.top + other.height);
      if (y0 <= y1) return Rectangle<T>(x0, y0, (x1 - x0) as T, (y1 - y0) as T);
    }
    return null;
  }
  bool intersects(Rectangle<num> other) => left <= other.left + other.width && other.left <= left + width && top <= other.top + other.height && other.top <= top + height;
  Rectangle<T> boundingBox(Rectangle<T> other) {
    var right = max(this.left + this.width, other.left + other.width);
    var bottom = max(this.top + this.height, other.top + other.height);
    var left = min(this.left, other.left);
    var top = min(this.top, other.top);
    return Rectangle<T>(left, top, (right - left) as T, (bottom - top) as T);
  }
  bool containsRectangle(Rectangle<num> another) => left <= another.left && left + width >= another.left + another.width && top <= another.top && top + height >= another.top + another.height;
  bool containsPoint(Point<num> another) => another.x >= left && another.x <= left + width && another.y >= top && another.y <= top + height;
  Point<T> get topLeft => Point<T>(this.left, this.top);
  Point<T> get topRight => Point<T>((this.left + this.width) as T, this.top);
  Point<T> get bottomRight => Point<T>((this.left + this.width) as T, (this.top + this.height) as T);
  Point<T> get bottomLeft => Point<T>(this.left, (this.top + this.height) as T);
}

class Rectangle<T extends num> with _RectangleBase<T> {
  final T left;
  final T top;
  final T width;
  final T height;
  const Rectangle(this.left, this.top, T width, T height)
      : width = (width < 0 ? (width == double.negativeInfinity ? 0.0 : -width * 0) : width + 0) as T,
        height = (height < 0 ? (height == double.negativeInfinity ? 0.0 : -height * 0) : height + 0) as T;
  factory Rectangle.fromPoints(Point<T> a, Point<T> b) {
    T left = min(a.x, b.x);
    T width = (max(a.x, b.x) - left) as T;
    T top = min(a.y, b.y);
    T height = (max(a.y, b.y) - top) as T;
    return Rectangle<T>(left, top, width, height);
  }
}

class MutableRectangle<T extends num> with _RectangleBase<T> implements Rectangle<T> {
  T left;
  T top;
  T _width;
  T _height;
  MutableRectangle(this.left, this.top, T width, T height)
      : _width = width < 0 ? _clampToZero<T>(width) : (width + 0) as T,
        _height = height < 0 ? _clampToZero<T>(height) : (height + 0) as T;
  factory MutableRectangle.fromPoints(Point<T> a, Point<T> b) {
    T left = min(a.x, b.x);
    T width = (max(a.x, b.x) - left) as T;
    T top = min(a.y, b.y);
    T height = (max(a.y, b.y) - top) as T;
    return MutableRectangle<T>(left, top, width, height);
  }
  T get width => _width;
  set width(T width) { _width = width < 0 ? _clampToZero<T>(width) : width; }
  T get height => _height;
  set height(T height) { _height = height < 0 ? _clampToZero<T>(height) : height; }
}

T _clampToZero<T extends num>(T value) => (value == double.negativeInfinity ? 0.0 : -value * 0) as T;
`;

/** dart:io, of which the interpreter has only the standard output and error streams and `exit`. */
export const IO_SOURCE = String.raw`
abstract interface class IOSink implements StringSink {
  external void write(Object? object);
  external void writeln([Object? object = ""]);
  external void writeAll(Iterable<dynamic> objects, [String separator = ""]);
  external void writeCharCode(int charCode);
}

class Stdout implements IOSink {
  final bool _isError;
  Stdout._(this._isError);
  external void write(Object? object);
  external void writeln([Object? object = ""]);
  external void writeAll(Iterable<dynamic> objects, [String separator = ""]);
  external void writeCharCode(int charCode);
}

final Stdout stdout = Stdout._(false);
final Stdout stderr = Stdout._(true);

external Never exit(int code);
`;

/** dart:collection, as the interpreter declares it, with the VM's hash maps transcribed so that their order matches. */
export { COLLECTION_SOURCE } from './collection';

/** dart:convert, as the interpreter declares it. */
export { CONVERT_SOURCE } from './convert';
