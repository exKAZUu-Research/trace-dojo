/** dart:convert as the interpreter declares it: JSON, UTF-8, Base64, and line splitting. The source must not contain `${`. */
export const CONVERT_SOURCE = String.raw`
abstract mixin class Codec<S, T> {
  const Codec();
  Converter<S, T> get encoder;
  Converter<T, S> get decoder;
  T encode(S input) => encoder.convert(input);
  S decode(T encoded) => decoder.convert(encoded);
}

abstract mixin class Converter<S, T> implements StreamTransformer<S, T> {
  const Converter();
  T convert(S input);
  Stream<T> bind(Stream<S> stream) => stream.map(convert);
  StreamTransformer<RS, RT> cast<RS, RT>() => StreamTransformer.castFrom<S, T, RS, RT>(this);
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
  Stream<String> bind(Stream<List<int>> stream) =>
      Stream<String>.eventTransformed(stream, (EventSink<String> sink) => _Utf8ChunkSink(sink, _allowMalformed));
}

/** Decodes the chunks of a byte stream, holding a character's bytes that a chunk splits until the next chunk. */
class _Utf8ChunkSink implements EventSink<List<int>> {
  final EventSink<String> _sink;
  final bool _allowMalformed;
  List<int> _pending = <int>[];
  _Utf8ChunkSink(this._sink, this._allowMalformed);
  void add(List<int> chunk) {
    var bytes = [..._pending, ...chunk];
    var end = bytes.length;
    var start = end - 1;
    while (start >= 0 && start > end - 4 && (bytes[start] & 0xC0) == 0x80) start--;
    if (start >= 0) {
      var lead = bytes[start];
      var length = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
      if (start + length > end) end = start;
    }
    _pending = bytes.sublist(end);
    if (end > 0) _sink.add(_utf8Decode(bytes, _allowMalformed, 0, end));
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }
  void close() {
    if (_pending.isNotEmpty) _sink.add(_utf8Decode(_pending, _allowMalformed));
    _sink.close();
  }
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

final class LineSplitter extends StreamTransformerBase<String, String> {
  const LineSplitter();
  static Iterable<String> split(String lines, [int start = 0, int? end]) =>
      _LineSplitIterable(lines, start, RangeError.checkValidRange(start, end, lines.length));
  List<String> convert(String data) => split(data).toList();
  Stream<String> bind(Stream<String> stream) =>
      Stream<String>.eventTransformed(stream, (EventSink<String> sink) => _LineSplitterSink(sink));
}

/** Splits the chunks of a string stream into lines, holding a line that a chunk ends in the middle of. */
class _LineSplitterSink implements EventSink<String> {
  final EventSink<String> _sink;
  String _carry = "";
  /** Whether the last chunk ended with a carriage return, whose CRLF the next chunk may end. */
  bool _skipLineFeed = false;
  _LineSplitterSink(this._sink);
  void add(String chunk) {
    var text = _carry + chunk;
    if (_skipLineFeed && text.isNotEmpty && text.codeUnitAt(0) == 10) text = text.substring(1);
    var end = text.length;
    while (end > 0 && text.codeUnitAt(end - 1) != 10 && text.codeUnitAt(end - 1) != 13) end--;
    for (var line in LineSplitter.split(text, 0, end)) _sink.add(line);
    _carry = text.substring(end);
    _skipLineFeed = end > 0 && end == text.length && text.codeUnitAt(end - 1) == 13;
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }
  void close() {
    for (var line in LineSplitter.split(_carry)) _sink.add(line);
    _sink.close();
  }
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
