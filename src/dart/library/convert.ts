/** dart:convert as the interpreter declares it: JSON, UTF-8, Base64, and line splitting. The source must not contain `${`. */
export const CONVERT_SOURCE = String.raw`
abstract mixin class Codec<S, T> {
  const Codec();
  T encode(S input);
  S decode(T encoded);
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
  JsonEncoder get encoder => JsonEncoder(_toEncodable);
  JsonDecoder get decoder => JsonDecoder(_reviver);
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
  List<int> encode(String input) => _utf8Encode(input);
  String decode(List<int> codeUnits, {bool? allowMalformed}) => _utf8Decode(codeUnits, allowMalformed ?? _allowMalformed);
  Utf8Encoder get encoder => const Utf8Encoder();
  Utf8Decoder get decoder => Utf8Decoder(allowMalformed: _allowMalformed);
}

final class Utf8Encoder extends Converter<String, List<int>> {
  const Utf8Encoder();
  List<int> convert(String string) => _utf8Encode(string);
}

final class Utf8Decoder extends Converter<List<int>, String> {
  final bool _allowMalformed;
  const Utf8Decoder({bool allowMalformed = false}) : _allowMalformed = allowMalformed;
  String convert(List<int> codeUnits) => _utf8Decode(codeUnits, _allowMalformed);
}

external List<int> _utf8Encode(String input);
external String _utf8Decode(List<int> codeUnits, bool allowMalformed);

const Base64Codec base64 = Base64Codec();
const Base64Codec base64Url = Base64Codec.urlSafe();

String base64Encode(List<int> bytes) => base64.encode(bytes);
String base64UrlEncode(List<int> bytes) => base64Url.encode(bytes);
List<int> base64Decode(String source) => base64.decode(source);

final class Base64Codec extends Codec<List<int>, String> {
  final bool _urlSafe;
  const Base64Codec() : _urlSafe = false;
  const Base64Codec.urlSafe() : _urlSafe = true;
  String encode(List<int> input) => _base64Encode(input, _urlSafe);
  List<int> decode(String encoded) => _base64Decode(encoded);
  String normalize(String source, [int start = 0, int? end]) => _base64Encode(_base64Decode(source.substring(start, end)), _urlSafe);
}

external String _base64Encode(List<int> bytes, bool urlSafe);
external List<int> _base64Decode(String source);

class LineSplitter extends Converter<String, List<String>> {
  const LineSplitter();
  static Iterable<String> split(String lines, [int start = 0, int? end]) => _splitLines(lines.substring(start, end));
  List<String> convert(String data) => _splitLines(data);
}

List<String> _splitLines(String data) {
  var lines = <String>[];
  var start = 0;
  var i = 0;
  while (i < data.length) {
    var char = data.codeUnitAt(i);
    if (char == 10 || char == 13) {
      lines.add(data.substring(start, i));
      if (char == 13 && i + 1 < data.length && data.codeUnitAt(i + 1) == 10) i++;
      start = i + 1;
    }
    i++;
  }
  if (start < data.length) lines.add(data.substring(start));
  return lines;
}
`;
