/** dart:convert as the interpreter declares it: JSON, UTF-8, Base64, and line splitting. The source must not contain `${`. */
export const CONVERT_SOURCE = String.raw`
abstract mixin class Codec<S, T> {
  const Codec();
  Converter<S, T> get encoder;
  Converter<T, S> get decoder;
  T encode(S input) => encoder.convert(input);
  S decode(T encoded) => decoder.convert(encoded);
}

abstract mixin class Converter<S, T> {
  const Converter();
  T convert(S input);
}

abstract class Encoding extends Codec<String, List<int>> {
  const Encoding();
  String get name;
}

class JsonUnsupportedObjectError extends Error {
  final Object? unsupportedObject;
  final Object? cause;
  final String? partialResult;
  JsonUnsupportedObjectError(this.unsupportedObject, {this.cause, this.partialResult});
  String toString() {
    String safeString = Error.safeToString(unsupportedObject);
    String prefix;
    if (cause != null) {
      prefix = "Converting object to an encodable object failed:";
    } else {
      prefix = "Converting object did not return an encodable object:";
    }
    return prefix + " " + safeString;
  }
}

class JsonCyclicError extends JsonUnsupportedObjectError {
  JsonCyclicError(Object? object) : super(object);
  String toString() => "Cyclic error in JSON stringify";
}

const JsonCodec json = JsonCodec();

String jsonEncode(Object? object, {Object? Function(Object? nonEncodable)? toEncodable}) => _jsonEncode(object, toEncodable, null);

dynamic jsonDecode(String source, {Object? Function(Object? key, Object? value)? reviver}) => _jsonDecode(source, reviver);

external String _jsonEncode(Object? object, Object? Function(Object? nonEncodable)? toEncodable, String? indent);
external dynamic _jsonDecode(String source, Object? Function(Object? key, Object? value)? reviver);

final class JsonCodec extends Codec<Object?, String> {
  final Object? Function(Object? key, Object? value)? _reviver;
  final Object? Function(dynamic)? _toEncodable;
  const JsonCodec({Object? Function(Object? key, Object? value)? reviver, Object? Function(dynamic object)? toEncodable})
      : _reviver = reviver,
        _toEncodable = toEncodable;
  JsonCodec.withReviver(dynamic Function(Object? key, Object? value) reviver) : this(reviver: reviver);
  dynamic decode(String source, {Object? Function(Object? key, Object? value)? reviver}) => _jsonDecode(source, reviver ?? _reviver);
  String encode(Object? value, {Object? Function(dynamic object)? toEncodable}) => _jsonEncode(value, toEncodable ?? _toEncodable, null);
  JsonEncoder get encoder => _toEncodable == null ? const JsonEncoder() : JsonEncoder(_toEncodable);
  JsonDecoder get decoder => _reviver == null ? const JsonDecoder() : JsonDecoder(_reviver);
}

final class JsonEncoder extends Converter<Object?, String> {
  final String? indent;
  final Object? Function(dynamic)? _toEncodable;
  const JsonEncoder([Object? Function(dynamic object)? toEncodable]) : indent = null, _toEncodable = toEncodable;
  const JsonEncoder.withIndent(this.indent, [Object? Function(dynamic object)? toEncodable]) : _toEncodable = toEncodable;
  String convert(Object? object) => _jsonEncode(object, _toEncodable, indent);
}

final class JsonDecoder extends Converter<String, Object?> {
  final Object? Function(Object? key, Object? value)? _reviver;
  const JsonDecoder([Object? Function(Object? key, Object? value)? reviver]) : _reviver = reviver;
  dynamic convert(String input) => _jsonDecode(input, _reviver);
}

const Utf8Codec utf8 = Utf8Codec();

final class Utf8Codec extends Encoding {
  final bool _allowMalformed;
  const Utf8Codec({bool allowMalformed = false}) : _allowMalformed = allowMalformed;
  String get name => "utf-8";
  _Uint8List encode(String input) => _utf8Encode(input);
  String decode(List<int> codeUnits, {bool? allowMalformed}) => _utf8Decode(codeUnits, allowMalformed ?? _allowMalformed);
  Utf8Encoder get encoder => const Utf8Encoder();
  Utf8Decoder get decoder => _allowMalformed ? const Utf8Decoder(allowMalformed: true) : const Utf8Decoder();
}

final class Utf8Encoder extends Converter<String, List<int>> {
  const Utf8Encoder();
  _Uint8List convert(String string, [int start = 0, int? end]) => _utf8Encode(string, start, end);
}

final class Utf8Decoder extends Converter<List<int>, String> {
  final bool _allowMalformed;
  const Utf8Decoder({bool allowMalformed = false}) : _allowMalformed = allowMalformed;
  String convert(List<int> codeUnits, [int start = 0, int? end]) => _utf8Decode(codeUnits, _allowMalformed, start, end);
}

external _Uint8List _utf8Encode(String input, [int start = 0, int? end]);
external String _utf8Decode(List<int> codeUnits, bool allowMalformed, [int start = 0, int? end]);

const Base64Codec base64 = Base64Codec();
const Base64Codec base64Url = Base64Codec.urlSafe();

String base64Encode(List<int> bytes) => base64.encode(bytes);
String base64UrlEncode(List<int> bytes) => base64Url.encode(bytes);
_Uint8List base64Decode(String source) => base64.decode(source);

final class Base64Codec extends Codec<List<int>, String> {
  final Base64Encoder encoder;
  const Base64Codec() : encoder = const Base64Encoder();
  const Base64Codec.urlSafe() : encoder = const Base64Encoder.urlSafe();
  Base64Decoder get decoder => const Base64Decoder();
  _Uint8List decode(String encoded) => decoder.convert(encoded);
  String normalize(String source, [int start = 0, int? end]) => _base64Normalize(source, start, end);
}

final class Base64Encoder extends Converter<List<int>, String> {
  final bool _urlSafe;
  const Base64Encoder() : _urlSafe = false;
  const Base64Encoder.urlSafe() : _urlSafe = true;
  String convert(List<int> input) => _base64Encode(input, _urlSafe);
}

final class Base64Decoder extends Converter<String, List<int>> {
  const Base64Decoder();
  _Uint8List convert(String input, [int start = 0, int? end]) => _base64Decode(input, start, end);
}

external String _base64Encode(List<int> bytes, bool urlSafe);
external _Uint8List _base64Decode(String source, int start, int? end);
external String _base64Normalize(String source, int start, int? end);

final class LineSplitter {
  const LineSplitter();
  static Iterable<String> split(String lines, [int start = 0, int? end]) =>
      _LineSplitIterable(lines, start, RangeError.checkValidRange(start, end, lines.length));
  List<String> convert(String data) => split(data).toList();
}

class _LineSplitIterable extends Iterable<String> {
  final String _source;
  final int _start;
  final int _end;
  _LineSplitIterable(this._source, this._start, this._end);
  Iterator<String> get iterator => _LineSplitIterator(_source, _start, _end);
}

class _LineSplitIterator implements Iterator<String> {
  final String _source;
  int _start;
  final int _end;
  int _lineStart = 0;
  int _lineEnd = -1;
  String? _current;
  _LineSplitIterator(this._source, this._start, this._end);
  bool moveNext() {
    _current = null;
    _lineStart = _start;
    _lineEnd = -1;
    for (int i = _start; i < _end; i++) {
      int code = _source.codeUnitAt(i);
      if (code != 10 && code != 13) continue;
      _lineEnd = i;
      _start = i + 1;
      if (code == 13 && _start < _end && _source.codeUnitAt(_start) == 10) _start++;
      return true;
    }
    if (_start == _end) return false;
    _lineEnd = _end;
    _start = _end;
    return true;
  }
  String get current => _current ??= (_lineEnd >= 0
      ? _source.substring(_lineStart, _lineEnd)
      : (throw StateError("No element")));
}
`;
