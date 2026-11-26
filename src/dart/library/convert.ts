/** dart:convert as the interpreter declares it: JSON, UTF-8, ASCII, Latin-1, Base64, and line splitting. The source must not contain `${`. */
export const CONVERT_SOURCE = String.raw`
abstract mixin class Codec<S, T> {
  const Codec();
  Converter<S, T> get encoder;
  Converter<T, S> get decoder;
  T encode(S input) => encoder.convert(input);
  S decode(T encoded) => decoder.convert(encoded);
  Codec<S, R> fuse<R>(Codec<T, R> other) {
    return _FusedCodec<S, T, R>(this, other);
  }
  Codec<T, S> get inverted => _InvertedCodec<T, S>(this);
}

class _FusedCodec<S, M, T> extends Codec<S, T> {
  final Codec<S, M> _first;
  final Codec<M, T> _second;
  Converter<S, T> get encoder => _first.encoder.fuse<T>(_second.encoder);
  Converter<T, S> get decoder => _second.decoder.fuse<S>(_first.decoder);
  _FusedCodec(this._first, this._second);
}

class _InvertedCodec<T, S> extends Codec<T, S> {
  final Codec<S, T> _codec;
  _InvertedCodec(Codec<S, T> codec) : _codec = codec;
  Converter<T, S> get encoder => _codec.decoder;
  Converter<S, T> get decoder => _codec.encoder;
  Codec<S, T> get inverted => _codec;
}

abstract mixin class Converter<S, T> implements StreamTransformer<S, T> {
  const Converter();
  T convert(S input);
  Converter<S, TT> fuse<TT>(Converter<T, TT> other) {
    return _FusedConverter<S, T, TT>(this, other);
  }
  Stream<T> bind(Stream<S> stream) => stream.map(convert);
  StreamTransformer<RS, RT> cast<RS, RT>() => StreamTransformer.castFrom<S, T, RS, RT>(this);
}

class _FusedConverter<S, M, T> extends Converter<S, T> {
  final Converter<S, M> _first;
  final Converter<M, T> _second;
  _FusedConverter(this._first, this._second);
  T convert(S input) => _second.convert(_first.convert(input));
}

abstract class Encoding extends Codec<String, List<int>> {
  const Encoding();
  Converter<String, List<int>> get encoder;
  Converter<List<int>, String> get decoder;
  Future<String> decodeStream(Stream<List<int>> byteStream) {
    return decoder
        .bind(byteStream)
        .fold(StringBuffer(), (StringBuffer buffer, String string) => buffer..write(string))
        .then((StringBuffer buffer) => buffer.toString());
  }
  String get name;
  static const Map<String, Encoding> _nameToEncoding = <String, Encoding>{
    "iso_8859-1:1987": latin1,
    "iso-ir-100": latin1,
    "iso_8859-1": latin1,
    "iso-8859-1": latin1,
    "latin1": latin1,
    "l1": latin1,
    "ibm819": latin1,
    "cp819": latin1,
    "csisolatin1": latin1,
    "iso-ir-6": ascii,
    "ansi_x3.4-1968": ascii,
    "ansi_x3.4-1986": ascii,
    "iso_646.irv:1991": ascii,
    "iso646-us": ascii,
    "us-ascii": ascii,
    "us": ascii,
    "ibm367": ascii,
    "cp367": ascii,
    "csascii": ascii,
    "ascii": ascii,
    "csutf8": utf8,
    "utf-8": utf8,
  };
  static Encoding? getByName(String? name) {
    if (name == null) return null;
    return _nameToEncoding[name.toLowerCase()];
  }
}

const AsciiCodec ascii = AsciiCodec();
const int _asciiMask = 0x7F;

final class AsciiCodec extends Encoding {
  final bool _allowInvalid;
  const AsciiCodec({bool allowInvalid = false}) : _allowInvalid = allowInvalid;
  String get name => "us-ascii";
  _Uint8List encode(String source) => encoder.convert(source);
  String decode(List<int> bytes, {bool? allowInvalid}) {
    if (allowInvalid ?? _allowInvalid) {
      return const AsciiDecoder(allowInvalid: true).convert(bytes);
    } else {
      return const AsciiDecoder(allowInvalid: false).convert(bytes);
    }
  }
  AsciiEncoder get encoder => const AsciiEncoder();
  AsciiDecoder get decoder =>
      _allowInvalid ? const AsciiDecoder(allowInvalid: true) : const AsciiDecoder(allowInvalid: false);
}

class _UnicodeSubsetEncoder extends Converter<String, List<int>> {
  final int _subsetMask;
  const _UnicodeSubsetEncoder(this._subsetMask);
  _Uint8List convert(String string, [int start = 0, int? end]) {
    var stringLength = string.length;
    end = RangeError.checkValidRange(start, end, stringLength);
    var length = end - start;
    var result = _Uint8List(length);
    for (var i = 0; i < length; i++) {
      var codeUnit = string.codeUnitAt(start + i);
      if ((codeUnit & ~_subsetMask) != 0) {
        throw ArgumentError.value(string, "string", "Contains invalid characters.");
      }
      result[i] = codeUnit;
    }
    return result;
  }
  Stream<List<int>> bind(Stream<String> stream) =>
      Stream<List<int>>.eventTransformed(stream, (EventSink<List<int>> sink) => _UnicodeSubsetEncoderSink(_subsetMask, sink));
}

final class AsciiEncoder extends _UnicodeSubsetEncoder {
  const AsciiEncoder() : super(_asciiMask);
}

// From the SDK's lib/convert/ascii.dart (3.13.7), class _UnicodeSubsetEncoderSink. Modifications: it is the event
// sink of an encoder's stream transformation, so it implements EventSink<String> and adds to an EventSink<List<int>>.
class _UnicodeSubsetEncoderSink implements EventSink<String> {
  final EventSink<List<int>> _sink;
  final int _subsetMask;

  _UnicodeSubsetEncoderSink(this._subsetMask, this._sink);

  void close() {
    _sink.close();
  }

  void add(String source) {
    addSlice(source, 0, source.length, false);
  }

  void addSlice(String source, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, source.length);
    for (var i = start; i < end; i++) {
      var codeUnit = source.codeUnitAt(i);
      if ((codeUnit & ~_subsetMask) != 0) {
        throw ArgumentError(
          "Source contains invalid character with code point: $codeUnit.",
        );
      }
    }
    _sink.add(source.codeUnits.sublist(start, end));
    if (isLast) {
      close();
    }
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }
}

abstract class _UnicodeSubsetDecoder extends Converter<List<int>, String> {
  final bool _allowInvalid;
  final int _subsetMask;
  const _UnicodeSubsetDecoder(this._allowInvalid, this._subsetMask);
  String convert(List<int> bytes, [int start = 0, int? end]) {
    end = RangeError.checkValidRange(start, end, bytes.length);
    for (var i = start; i < end; i++) {
      var byte = bytes[i];
      if ((byte & ~_subsetMask) != 0) {
        if (!_allowInvalid) {
          throw FormatException("Invalid value in input: $byte");
        }
        return _convertInvalid(bytes, start, end);
      }
    }
    return String.fromCharCodes(bytes, start, end);
  }
  String _convertInvalid(List<int> bytes, int start, int end) {
    var buffer = StringBuffer();
    for (var i = start; i < end; i++) {
      var value = bytes[i];
      if ((value & ~_subsetMask) != 0) value = 0xFFFD;
      buffer.writeCharCode(value);
    }
    return buffer.toString();
  }
}

final class AsciiDecoder extends _UnicodeSubsetDecoder {
  const AsciiDecoder({bool allowInvalid = false}) : super(allowInvalid, _asciiMask);
  Stream<String> bind(Stream<List<int>> stream) => Stream<String>.eventTransformed(
        stream,
        (EventSink<String> sink) => _allowInvalid
            ? _ErrorHandlingAsciiDecoderSink(_Utf8ConversionSink(sink, false))
            : _SimpleAsciiDecoderSink(sink),
      );
}

// From the SDK's lib/convert/ascii.dart (3.13.7), classes _ErrorHandlingAsciiDecoderSink and
// _SimpleAsciiDecoderSink. Modifications: they are the event sinks of a decoder's stream transformation, so they
// implement EventSink<List<int>> instead of extending ByteConversionSink, and add to an EventSink<String> (or the
// UTF-8 sink) instead of a StringConversionSink.
class _ErrorHandlingAsciiDecoderSink implements EventSink<List<int>> {
  final _Utf8ConversionSink _utf8Sink;
  _ErrorHandlingAsciiDecoderSink(this._utf8Sink);

  void close() {
    _utf8Sink.close();
  }

  void add(List<int> source) {
    addSlice(source, 0, source.length, false);
  }

  void addSlice(List<int> source, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, source.length);
    for (var i = start; i < end; i++) {
      if ((source[i] & ~_asciiMask) != 0) {
        if (i > start) _utf8Sink.addSlice(source, start, i, false);
        // Add UTF-8 encoding of U+FFFD.
        _utf8Sink.add(const <int>[0xEF, 0xBF, 0xBD]);
        start = i + 1;
      }
    }
    if (start < end) {
      _utf8Sink.addSlice(source, start, end, isLast);
    } else if (isLast) {
      close();
    }
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _utf8Sink.addError(error, stackTrace);
  }
}

class _SimpleAsciiDecoderSink implements EventSink<List<int>> {
  final EventSink<String> _sink;
  _SimpleAsciiDecoderSink(this._sink);

  void close() {
    _sink.close();
  }

  void add(List<int> source) {
    for (var i = 0; i < source.length; i++) {
      if ((source[i] & ~_asciiMask) != 0) {
        throw FormatException("Source contains non-ASCII bytes.");
      }
    }
    _sink.add(String.fromCharCodes(source));
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }
}

const Latin1Codec latin1 = Latin1Codec();
const int _latin1Mask = 0xFF;

final class Latin1Codec extends Encoding {
  final bool _allowInvalid;
  const Latin1Codec({bool allowInvalid = false}) : _allowInvalid = allowInvalid;
  String get name => "iso-8859-1";
  _Uint8List encode(String source) => encoder.convert(source);
  String decode(List<int> bytes, {bool? allowInvalid}) {
    if (allowInvalid ?? _allowInvalid) {
      return const Latin1Decoder(allowInvalid: true).convert(bytes);
    } else {
      return const Latin1Decoder(allowInvalid: false).convert(bytes);
    }
  }
  Latin1Encoder get encoder => const Latin1Encoder();
  Latin1Decoder get decoder =>
      _allowInvalid ? const Latin1Decoder(allowInvalid: true) : const Latin1Decoder(allowInvalid: false);
}

final class Latin1Encoder extends _UnicodeSubsetEncoder {
  const Latin1Encoder() : super(_latin1Mask);
}

final class Latin1Decoder extends _UnicodeSubsetDecoder {
  const Latin1Decoder({bool allowInvalid = false}) : super(allowInvalid, _latin1Mask);
  Stream<String> bind(Stream<List<int>> stream) => Stream<String>.eventTransformed(
        stream,
        (EventSink<String> sink) => _allowInvalid ? _Latin1AllowInvalidDecoderSink(sink) : _Latin1DecoderSink(sink),
      );
}

// From the SDK's lib/convert/latin1.dart (3.13.7), classes _Latin1DecoderSink and _Latin1AllowInvalidDecoderSink.
// Modifications: they are the event sinks of a decoder's stream transformation, so they implement
// EventSink<List<int>> and add to an EventSink<String>; every list is checked, as the VM's do for a list that is not
// a Uint8List.
class _Latin1DecoderSink implements EventSink<List<int>> {
  EventSink<String>? _sink;
  _Latin1DecoderSink(this._sink);

  void close() {
    _sink!.close();
    _sink = null;
  }

  void add(List<int> source) {
    addSlice(source, 0, source.length, false);
  }

  void _addSliceToSink(List<int> source, int start, int end, bool isLast) {
    _sink!.add(String.fromCharCodes(source, start, end));
    if (isLast) close();
  }

  void addSlice(List<int> source, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, source.length);
    if (start == end) return;
    _checkValidLatin1(source, start, end);
    _addSliceToSink(source, start, end, isLast);
  }

  static void _checkValidLatin1(List<int> source, int start, int end) {
    var mask = 0;
    for (var i = start; i < end; i++) {
      mask |= source[i];
    }
    if (mask >= 0 && mask <= _latin1Mask) {
      return;
    }
    _reportInvalidLatin1(source, start, end); // Always throws.
  }

  static void _reportInvalidLatin1(List<int> source, int start, int end) {
    // Find the index of the first non-Latin-1 character code.
    for (var i = start; i < end; i++) {
      var char = source[i];
      if (char < 0 || char > _latin1Mask) {
        throw FormatException(
          "Source contains non-Latin-1 characters.",
          source,
          i,
        );
      }
    }
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink!.addError(error, stackTrace);
  }
}

class _Latin1AllowInvalidDecoderSink extends _Latin1DecoderSink {
  _Latin1AllowInvalidDecoderSink(EventSink<String> super.sink);

  void addSlice(List<int> source, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, source.length);
    for (var i = start; i < end; i++) {
      var char = source[i];
      if (char > _latin1Mask || char < 0) {
        if (i > start) _addSliceToSink(source, start, i, false);
        // Add UTF-8 encoding of U+FFFD.
        _addSliceToSink(const [0xFFFD], 0, 1, false);
        start = i + 1;
      }
    }
    if (start < end) {
      _addSliceToSink(source, start, end, isLast);
    }
    if (isLast) {
      close();
    }
  }
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
  Stream<String> bind(Stream<Object?> stream) =>
      Stream<String>.eventTransformed(stream, (EventSink<String> sink) => _JsonEncoderSink(sink, _toEncodable, indent));
}

// From the SDK's lib/convert/json.dart (3.13.7): _JsonEncoderSink, _JsonStringifier, _JsonPrettyPrintMixin,
// _JsonStringStringifier and _JsonStringStringifierPretty, with their comments removed; and from
// lib/convert/string_conversion.dart, _StringConversionSinkAsStringSinkAdapter. They encode a stream's value, adding
// each piece the stringifier writes, as the SDK's do. Modifications: the sinks implement EventSink and add to an
// EventSink<String> in place of a StringConversionSink; a single conversion stays native (nativeConvert.ts), with
// the same text and errors, since the Dart stringifier would charge operations for each character.
class _JsonEncoderSink implements EventSink<Object?> {
  final String? _indent;
  final Object? Function(dynamic)? _toEncodable;
  final EventSink<String> _sink;
  bool _isDone = false;

  _JsonEncoderSink(this._sink, this._toEncodable, this._indent);

  void add(Object? o) {
    if (_isDone) {
      throw StateError("Only one call to add allowed");
    }
    _isDone = true;
    var stringSink = _StringConversionSinkAsStringSinkAdapter(_sink);
    _JsonStringStringifier.printOn(o, stringSink, _toEncodable, _indent);
    stringSink.close();
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }

  void close() {
    /* do nothing */
  }
}

class _StringConversionSinkAsStringSinkAdapter implements StringSink {
  static const _MIN_STRING_SIZE = 16;

  final StringBuffer _buffer;
  final EventSink<String> _chunkedSink;

  _StringConversionSinkAsStringSinkAdapter(this._chunkedSink)
    : _buffer = StringBuffer();

  void close() {
    if (_buffer.isNotEmpty) _flush();
    _chunkedSink.close();
  }

  void writeCharCode(int charCode) {
    _buffer.writeCharCode(charCode);
    if (_buffer.length > _MIN_STRING_SIZE) _flush();
  }

  void write(Object? o) {
    if (_buffer.isNotEmpty) _flush();
    _chunkedSink.add(o.toString());
  }

  void writeln([Object? o = ""]) {
    _buffer.writeln(o);
    if (_buffer.length > _MIN_STRING_SIZE) _flush();
  }

  void writeAll(Iterable objects, [String separator = ""]) {
    if (_buffer.isNotEmpty) _flush();
    var iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    if (separator.isEmpty) {
      do {
        _chunkedSink.add(iterator.current.toString());
      } while (iterator.moveNext());
    } else {
      _chunkedSink.add(iterator.current.toString());
      while (iterator.moveNext()) {
        write(separator);
        _chunkedSink.add(iterator.current.toString());
      }
    }
  }

  void _flush() {
    var accumulated = _buffer.toString();
    _buffer.clear();
    _chunkedSink.add(accumulated);
  }
}

dynamic _defaultToEncodable(dynamic object) => object.toJson();

abstract class _JsonStringifier {
  static const int backspace = 0x08;
  static const int tab = 0x09;
  static const int newline = 0x0a;
  static const int carriageReturn = 0x0d;
  static const int formFeed = 0x0c;
  static const int quote = 0x22;
  static const int char_0 = 0x30;
  static const int backslash = 0x5c;
  static const int char_b = 0x62;
  static const int char_d = 0x64;
  static const int char_f = 0x66;
  static const int char_n = 0x6e;
  static const int char_r = 0x72;
  static const int char_t = 0x74;
  static const int char_u = 0x75;
  static const int surrogateMin = 0xd800;
  static const int surrogateMask = 0xfc00;
  static const int surrogateLead = 0xd800;
  static const int surrogateTrail = 0xdc00;

  final List _seen = [];

  final dynamic Function(dynamic) _toEncodable;

  _JsonStringifier(dynamic Function(dynamic o)? toEncodable)
    : _toEncodable = toEncodable ?? _defaultToEncodable;

  String? get _partialResult;

  void writeString(String characters);

  void writeStringSlice(String characters, int start, int end);

  void writeCharCode(int charCode);

  void writeNumber(num number);

  static int hexDigit(int x) => x < 10 ? 48 + x : 87 + x;

  void writeStringContent(String s) {
    var offset = 0;
    final length = s.length;
    for (var i = 0; i < length; i++) {
      var charCode = s.codeUnitAt(i);
      if (charCode > backslash) {
        if (charCode >= surrogateMin) {
          if (((charCode & surrogateMask) == surrogateLead &&
                  !(i + 1 < length &&
                      (s.codeUnitAt(i + 1) & surrogateMask) ==
                          surrogateTrail)) ||
              ((charCode & surrogateMask) == surrogateTrail &&
                  !(i - 1 >= 0 &&
                      (s.codeUnitAt(i - 1) & surrogateMask) ==
                          surrogateLead))) {
            if (i > offset) writeStringSlice(s, offset, i);
            offset = i + 1;
            writeCharCode(backslash);
            writeCharCode(char_u);
            writeCharCode(char_d);
            writeCharCode(hexDigit((charCode >> 8) & 0xf));
            writeCharCode(hexDigit((charCode >> 4) & 0xf));
            writeCharCode(hexDigit(charCode & 0xf));
          }
        }
        continue;
      }
      if (charCode < 32) {
        if (i > offset) writeStringSlice(s, offset, i);
        offset = i + 1;
        writeCharCode(backslash);
        switch (charCode) {
          case backspace:
            writeCharCode(char_b);
            break;
          case tab:
            writeCharCode(char_t);
            break;
          case newline:
            writeCharCode(char_n);
            break;
          case formFeed:
            writeCharCode(char_f);
            break;
          case carriageReturn:
            writeCharCode(char_r);
            break;
          default:
            writeCharCode(char_u);
            writeCharCode(char_0);
            writeCharCode(char_0);
            writeCharCode(hexDigit((charCode >> 4) & 0xf));
            writeCharCode(hexDigit(charCode & 0xf));
            break;
        }
      } else if (charCode == quote || charCode == backslash) {
        if (i > offset) writeStringSlice(s, offset, i);
        offset = i + 1;
        writeCharCode(backslash);
        writeCharCode(charCode);
      }
    }
    if (offset == 0) {
      writeString(s);
    } else if (offset < length) {
      writeStringSlice(s, offset, length);
    }
  }

  void _checkCycle(Object? object) {
    for (var i = 0; i < _seen.length; i++) {
      if (identical(object, _seen[i])) {
        throw JsonCyclicError(object);
      }
    }
    _seen.add(object);
  }

  void _removeSeen(Object? object) {
    assert(_seen.isNotEmpty);
    assert(identical(_seen.last, object));
    _seen.removeLast();
  }

  void writeObject(Object? object) {
    if (writeJsonValue(object)) return;
    _checkCycle(object);
    try {
      var customJson = _toEncodable(object);
      if (!writeJsonValue(customJson)) {
        throw JsonUnsupportedObjectError(object, partialResult: _partialResult);
      }
      _removeSeen(object);
    } catch (e) {
      throw JsonUnsupportedObjectError(
        object,
        cause: e,
        partialResult: _partialResult,
      );
    }
  }

  bool writeJsonValue(Object? object) {
    if (object is num) {
      if (!object.isFinite) return false;
      writeNumber(object);
      return true;
    } else if (identical(object, true)) {
      writeString('true');
      return true;
    } else if (identical(object, false)) {
      writeString('false');
      return true;
    } else if (object == null) {
      writeString('null');
      return true;
    } else if (object is String) {
      writeString('"');
      writeStringContent(object);
      writeString('"');
      return true;
    } else if (object is List) {
      _checkCycle(object);
      writeList(object);
      _removeSeen(object);
      return true;
    } else if (object is Map) {
      _checkCycle(object);
      var success = writeMap(object);
      _removeSeen(object);
      return success;
    } else {
      return false;
    }
  }

  void writeList(List<Object?> list) {
    writeString('[');
    if (list.isNotEmpty) {
      writeObject(list[0]);
      for (var i = 1; i < list.length; i++) {
        writeString(',');
        writeObject(list[i]);
      }
    }
    writeString(']');
  }

  bool writeMap(Map<Object?, Object?> map) {
    if (map.isEmpty) {
      writeString("{}");
      return true;
    }
    var keyValueList = List<Object?>.filled(map.length * 2, null);
    var i = 0;
    var allStringKeys = true;
    map.forEach((key, value) {
      if (key is! String) {
        allStringKeys = false;
      }
      keyValueList[i++] = key;
      keyValueList[i++] = value;
    });
    if (!allStringKeys) return false;
    writeString('{');
    var separator = '"';
    for (var i = 0; i < keyValueList.length; i += 2) {
      writeString(separator);
      separator = ',"';
      writeStringContent(keyValueList[i] as String);
      writeString('":');
      writeObject(keyValueList[i + 1]);
    }
    writeString('}');
    return true;
  }
}

mixin _JsonPrettyPrintMixin implements _JsonStringifier {
  int _indentLevel = 0;

  void writeIndentation(int indentLevel);

  void writeList(List<Object?> list) {
    if (list.isEmpty) {
      writeString('[]');
    } else {
      writeString('[\n');
      _indentLevel++;
      writeIndentation(_indentLevel);
      writeObject(list[0]);
      for (var i = 1; i < list.length; i++) {
        writeString(',\n');
        writeIndentation(_indentLevel);
        writeObject(list[i]);
      }
      writeString('\n');
      _indentLevel--;
      writeIndentation(_indentLevel);
      writeString(']');
    }
  }

  bool writeMap(Map<Object?, Object?> map) {
    if (map.isEmpty) {
      writeString("{}");
      return true;
    }
    var keyValueList = List<Object?>.filled(map.length * 2, null);
    var i = 0;
    var allStringKeys = true;
    map.forEach((key, value) {
      if (key is! String) {
        allStringKeys = false;
      }
      keyValueList[i++] = key;
      keyValueList[i++] = value;
    });
    if (!allStringKeys) return false;
    writeString('{\n');
    _indentLevel++;
    var separator = "";
    for (var i = 0; i < keyValueList.length; i += 2) {
      writeString(separator);
      separator = ",\n";
      writeIndentation(_indentLevel);
      writeString('"');
      writeStringContent(keyValueList[i] as String);
      writeString('": ');
      writeObject(keyValueList[i + 1]);
    }
    writeString('\n');
    _indentLevel--;
    writeIndentation(_indentLevel);
    writeString('}');
    return true;
  }
}

class _JsonStringStringifier extends _JsonStringifier {
  final StringSink _sink;

  _JsonStringStringifier(
    this._sink,
    dynamic Function(dynamic object)? _toEncodable,
  ) : super(_toEncodable);

  static String stringify(
    Object? object,
    dynamic Function(dynamic object)? toEncodable,
    String? indent,
  ) {
    var output = StringBuffer();
    printOn(object, output, toEncodable, indent);
    return output.toString();
  }

  static void printOn(
    Object? object,
    StringSink output,
    dynamic Function(dynamic o)? toEncodable,
    String? indent,
  ) {
    _JsonStringifier stringifier;
    if (indent == null) {
      stringifier = _JsonStringStringifier(output, toEncodable);
    } else {
      stringifier = _JsonStringStringifierPretty(output, toEncodable, indent);
    }
    stringifier.writeObject(object);
  }

  String? get _partialResult => _sink is StringBuffer ? _sink.toString() : null;

  void writeNumber(num number) {
    _sink.write(number.toString());
  }

  void writeString(String string) {
    _sink.write(string);
  }

  void writeStringSlice(String string, int start, int end) {
    _sink.write(string.substring(start, end));
  }

  void writeCharCode(int charCode) {
    _sink.writeCharCode(charCode);
  }
}

class _JsonStringStringifierPretty extends _JsonStringStringifier
    with _JsonPrettyPrintMixin {
  final String _indent;

  _JsonStringStringifierPretty(super.sink, super.toEncodable, this._indent);

  void writeIndentation(int count) {
    for (var i = 0; i < count; i++) writeString(_indent);
  }
}

final class JsonDecoder extends Converter<String, Object?> {
  final Object? Function(Object? key, Object? value)? _reviver;
  const JsonDecoder([Object? Function(Object? key, Object? value)? reviver]) : _reviver = reviver;
  dynamic convert(String input) => _jsonDecode(input, _reviver);
  Stream<Object?> bind(Stream<String> stream) =>
      Stream<Object?>.eventTransformed(stream, (EventSink<Object?> sink) => _JsonStringDecoderSink(sink, _reviver));
}

/**
 * In place of the SDK's _JsonStringDecoderSink, whose chunked parser (the VM's convert_patch.dart) reads each chunk
 * as it comes: the chunks are kept and the text is parsed once when the stream ends, which is when the SDK gives the
 * value too. A text that ends too early fails there, as the chunked parser fails it, at the end of the last chunk; an
 * error before the end the chunked parser reports in the chunk it is in and goes on from its own state, with a second
 * error or a value it had completed, so such a text is reported as unavailable.
 */
class _JsonStringDecoderSink implements EventSink<String> {
  final EventSink<Object?> _sink;
  final Object? Function(Object? key, Object? value)? _reviver;
  final StringBuffer _text = StringBuffer();
  String _lastChunk = "";

  _JsonStringDecoderSink(this._sink, this._reviver);

  void add(String chunk) {
    _text.write(chunk);
    _lastChunk = chunk;
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }

  void close() {
    final text = _text.toString();
    Object? value;
    try {
      value = _jsonDecode(text, _reviver);
    } on FormatException catch (error) {
      if (error.offset != text.length) {
        _unavailable("途中に JSON として読めない部分があるテキストを流す json.decoder のストリーム");
      }
      throw FormatException(error.message, _lastChunk, _lastChunk.length);
    }
    _sink.add(value);
    _sink.close();
  }
}

const Utf8Codec utf8 = Utf8Codec();

/** The Unicode Replacement character U+FFFD, which a decoder writes for malformed input it allows. */
const int unicodeReplacementCharacterRune = 0xFFFD;

/** The Unicode Byte Order Marker character U+FEFF. */
const int unicodeBomCharacterRune = 0xFEFF;

final class Utf8Codec extends Encoding {
  final bool _allowMalformed;
  const Utf8Codec({bool allowMalformed = false}) : _allowMalformed = allowMalformed;
  String get name => "utf-8";
  _Uint8List encode(String input) => _utf8Encode(input);
  String decode(List<int> codeUnits, {bool? allowMalformed}) {
    // Switch between const objects to avoid allocation.
    Utf8Decoder decoder = allowMalformed ?? _allowMalformed
        ? const Utf8Decoder(allowMalformed: true)
        : const Utf8Decoder(allowMalformed: false);
    return decoder.convert(codeUnits);
  }
  Utf8Encoder get encoder => const Utf8Encoder();
  Utf8Decoder get decoder => _allowMalformed ? const Utf8Decoder(allowMalformed: true) : const Utf8Decoder();
}

final class Utf8Encoder extends Converter<String, List<int>> {
  const Utf8Encoder();
  _Uint8List convert(String string, [int start = 0, int? end]) => _utf8Encode(string, start, end);
  Stream<List<int>> bind(Stream<String> stream) =>
      Stream<List<int>>.eventTransformed(stream, (EventSink<List<int>> sink) => _Utf8EncoderSink(sink));
}

/**
 * Encodes a stream of strings as the SDK's _Utf8EncoderSink (lib/convert/utf.dart) does: a chunk that ends inside a
 * surrogate pair keeps its lead surrogate for the next chunk, an empty chunk adds nothing, and a lead surrogate left
 * at the end is written as U+FFFD. The encoding itself is the native one the converter uses.
 */
class _Utf8EncoderSink implements EventSink<String> {
  final EventSink<List<int>> _sink;
  int _carry = 0;
  _Utf8EncoderSink(this._sink);

  void add(String str) {
    if (str.isEmpty) return;
    var text = _carry == 0 ? str : String.fromCharCode(_carry) + str;
    _carry = 0;
    final last = text.codeUnitAt(text.length - 1);
    if (last & 0xFC00 == 0xD800) {
      _carry = last;
      text = text.substring(0, text.length - 1);
    }
    _sink.add(_utf8Encode(text));
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }

  void close() {
    if (_carry != 0) {
      _carry = 0;
      _sink.add(const <int>[0xEF, 0xBF, 0xBD]);
    }
    _sink.close();
  }
}

final class Utf8Decoder extends Converter<List<int>, String> {
  final bool _allowMalformed;
  const Utf8Decoder({bool allowMalformed = false}) : _allowMalformed = allowMalformed;
  String convert(List<int> codeUnits, [int start = 0, int? end]) =>
      _Utf8Decoder(_allowMalformed).convertSingle(codeUnits, start, end);
  Stream<String> bind(Stream<List<int>> stream) =>
      Stream<String>.eventTransformed(stream, (EventSink<String> sink) => _Utf8ConversionSink(sink, _allowMalformed));
}

// From the SDK's lib/convert/string_conversion.dart (3.13.7), class _Utf8ConversionSink. Modifications: it is the
// event sink a decoder's stream transformation adds to, so it implements EventSink<List<int>> instead of extending
// ByteConversionSink and adds what it decodes to an EventSink<String> instead of a StringConversionSink's addSlice.
class _Utf8ConversionSink implements EventSink<List<int>> {
  final _Utf8Decoder _decoder;
  final EventSink<String> _chunkedSink;
  final StringBuffer _buffer;
  _Utf8ConversionSink(EventSink<String> sink, bool allowMalformed)
    : this._(sink, StringBuffer(), allowMalformed);

  _Utf8ConversionSink._(
    this._chunkedSink,
    StringBuffer stringBuffer,
    bool allowMalformed,
  ) : _decoder = _Utf8Decoder(allowMalformed),
      _buffer = stringBuffer;

  void close() {
    _decoder.flush(_buffer);
    if (_buffer.isNotEmpty) {
      var accumulated = _buffer.toString();
      _buffer.clear();
      _chunkedSink.add(accumulated);
    }
    _chunkedSink.close();
  }

  void add(List<int> chunk) {
    addSlice(chunk, 0, chunk.length, false);
  }

  void addSlice(List<int> chunk, int startIndex, int endIndex, bool isLast) {
    _buffer.write(_decoder.convertChunked(chunk, startIndex, endIndex));
    if (_buffer.isNotEmpty) {
      var accumulated = _buffer.toString();
      _chunkedSink.add(accumulated);
      _buffer.clear();
      return;
    }
    if (isLast) close();
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _chunkedSink.addError(error, stackTrace);
  }
}

// From the SDK's lib/convert/utf.dart (3.13.7), class _Utf8Decoder, with the VM's patch of it
// (lib/_internal/vm/lib/convert_patch.dart). Modifications: convertSingle and convertChunked run natively
// (nativeConvert.ts), which also hold the state machine's tables, so typeTable, transitionTable, the state
// characters, decodeGeneral, _makeUint8List and the patch's scanning are left out; the patch's constructor is used.
class _Utf8Decoder {
  /// Decode malformed UTF-8 as replacement characters (instead of throwing)?
  final bool allowMalformed;

  /// Decoder DFA state.
  int _state;

  /// Partially decoded character. Meaning depends on state. Not used when in
  /// the initial/accept state. When in an error state, contains the index into
  /// the input of the error.
  int _charOrIndex = 0;

  /// How many bytes of the BOM have been read so far. Set to -1 when the BOM
  /// has been skipped (or was not present).
  int _bomIndex = 0;

  // States (offsets into transition table).
  static const int IA = 0x00; // Initial / Accept
  static const int BB = 0x10; // Before BOM
  static const int AB = 0x20; // After BOM
  static const int X1 = 0x30; // Expecting one extension byte
  static const int X2 = 0x3A; // Expecting two extension bytes
  static const int X3 = 0x44; // Expecting three extension bytes
  static const int TO = 0x4E; // Possibly overlong 3-byte
  static const int TS = 0x58; // Possibly surrogate
  static const int QO = 0x62; // Possibly overlong 4-byte
  static const int QR = 0x6C; // Possibly out-of-range 4-byte
  static const int B1 = 0x76; // One byte into BOM
  static const int B2 = 0x80; // Two bytes into BOM
  static const int E1 = 0x41; // Error: Missing extension byte
  static const int E2 = 0x43; // Error: Unexpected extension byte
  static const int E3 = 0x45; // Error: Invalid byte
  static const int E4 = 0x47; // Error: Overlong encoding
  static const int E5 = 0x49; // Error: Out of range
  static const int E6 = 0x4B; // Error: Surrogate
  static const int E7 = 0x4D; // Error: Unfinished

  // Aliases for states.
  static const int initial = IA;
  static const int accept = IA;
  static const int beforeBom = BB;
  static const int afterBom = AB;
  static const int errorMissingExtension = E1;
  static const int errorUnexpectedExtension = E2;
  static const int errorInvalid = E3;
  static const int errorOverlong = E4;
  static const int errorOutOfRange = E5;
  static const int errorSurrogate = E6;
  static const int errorUnfinished = E7;

  static bool isErrorState(int state) => (state & 1) != 0;

  static String errorDescription(int state) {
    switch (state) {
      case errorMissingExtension:
        return "Missing extension byte";
      case errorUnexpectedExtension:
        return "Unexpected extension byte";
      case errorInvalid:
        return "Invalid UTF-8 byte";
      case errorOverlong:
        return "Overlong encoding";
      case errorOutOfRange:
        return "Out of unicode range";
      case errorSurrogate:
        return "Encoded surrogate";
      case errorUnfinished:
        return "Unfinished UTF-8 octet sequence";
      default:
        return "";
    }
  }

  // The VM decoder handles BOM explicitly instead of via the state machine.
  _Utf8Decoder(this.allowMalformed) : _state = initial;

  external String convertSingle(List<int> codeUnits, int start, int? maybeEnd);

  external String convertChunked(List<int> codeUnits, int start, int? maybeEnd);

  /// Whether the decoder expects the continuation of unfinished multi-byte
  /// UTF8-encoding.
  bool get expectsContinuation => _state > afterBom;

  /// Flushes this decoder as if closed.
  ///
  /// This method throws if the input was partial and the decoder was
  /// constructed with allowMalformed set to false.
  void flush(StringSink sink) {
    final int state = _state;
    _state = initial;
    if (state <= afterBom) {
      return;
    }
    // Unfinished sequence.
    if (allowMalformed) {
      sink.writeCharCode(unicodeReplacementCharacterRune);
    } else {
      throw FormatException(errorDescription(errorUnfinished), null, null);
    }
  }
}

external _Uint8List _utf8Encode(String input, [int start = 0, int? end]);

const Base64Codec base64 = Base64Codec();
const Base64Codec base64Url = Base64Codec.urlSafe();

String base64Encode(List<int> bytes) => base64.encode(bytes);
String base64UrlEncode(List<int> bytes) => base64Url.encode(bytes);
_Uint8List base64Decode(String source) => base64.decode(source);

// From the SDK's lib/convert/base64.dart (3.13.7): Base64Codec, Base64Encoder, _Base64Encoder, _Base64EncoderSink,
// _AsciiBase64EncoderSink, Base64Decoder, _Base64Decoder and _Base64DecoderSink, with their comments removed.
// Modifications: the single conversions and normalize are native (nativeConvert.ts), with the same results, since
// the Dart code would charge an operation for each character and stop long inputs the SDK converts; the encoder and
// decoder transform streams through these chunk sinks, which implement EventSink, so the StringConversionSink forms
// (_Utf8Base64EncoderSink) and the buffer cache of _BufferCachingBase64Encoder, which needs Uint8List.view, are left
// out; _Uint8List stands for Uint8List and a constant list for _inverseAlphabet's Int8List; an error message is
// built without interpolating an expression.
const int _paddingChar = 0x3d; // '='.

final class Base64Codec extends Codec<List<int>, String> {
  final Base64Encoder _encoder;
  const Base64Codec() : _encoder = const Base64Encoder();
  const Base64Codec.urlSafe() : _encoder = const Base64Encoder.urlSafe();

  Base64Encoder get encoder => _encoder;

  Base64Decoder get decoder => const Base64Decoder();

  _Uint8List decode(String encoded) => decoder.convert(encoded);

  String normalize(String source, [int start = 0, int? end]) => _base64Normalize(source, start, end);
}


final class Base64Encoder extends Converter<List<int>, String> {
  final bool _urlSafe;

  const Base64Encoder() : _urlSafe = false;
  const Base64Encoder.urlSafe() : _urlSafe = true;

  String convert(List<int> input) => _base64Encode(input, _urlSafe);

  Stream<String> bind(Stream<List<int>> stream) =>
      Stream<String>.eventTransformed(stream, (EventSink<String> sink) => _AsciiBase64EncoderSink(sink, _urlSafe));
}

class _Base64Encoder {
  static const String _base64Alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  static const String _base64UrlAlphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  static const int _valueShift = 2;

  static const int _countMask = 3;

  static const int _sixBitMask = 0x3F;

  int _state = 0;

  final String _alphabet;

  _Base64Encoder(bool urlSafe)
    : _alphabet = urlSafe ? _base64UrlAlphabet : _base64Alphabet;

  static int _encodeState(int count, int bits) {
    assert(count <= _countMask);
    return bits << _valueShift | count;
  }

  static int _stateBits(int state) => state >> _valueShift;

  static int _stateCount(int state) => state & _countMask;

  _Uint8List createBuffer(int bufferLength) => _Uint8List(bufferLength);

  _Uint8List? encode(List<int> bytes, int start, int end, bool isLast) {
    assert(0 <= start);
    assert(start <= end);
    assert(end <= bytes.length);
    var length = end - start;

    var count = _stateCount(_state);
    var byteCount = (count + length);
    var fullChunks = byteCount ~/ 3;
    var partialChunkLength = byteCount - fullChunks * 3;
    var bufferLength = fullChunks * 4;
    if (isLast && partialChunkLength > 0) {
      bufferLength += 4; // Room for padding.
    }
    var output = createBuffer(bufferLength);
    _state = encodeChunk(
      _alphabet,
      bytes,
      start,
      end,
      isLast,
      output,
      0,
      _state,
    );
    if (bufferLength > 0) return output;
    return null;
  }

  static int encodeChunk(
    String alphabet,
    List<int> bytes,
    int start,
    int end,
    bool isLast,
    _Uint8List output,
    int outputIndex,
    int state,
  ) {
    var bits = _stateBits(state);
    var expectedChars = 3 - _stateCount(state);

    var byteOr = 0;
    for (var i = start; i < end; i++) {
      var byte = bytes[i];
      byteOr |= byte;
      bits = ((bits << 8) | byte) & 0xFFFFFF; // Never store more than 24 bits.
      expectedChars--;
      if (expectedChars == 0) {
        output[outputIndex++] = alphabet.codeUnitAt((bits >> 18) & _sixBitMask);
        output[outputIndex++] = alphabet.codeUnitAt((bits >> 12) & _sixBitMask);
        output[outputIndex++] = alphabet.codeUnitAt((bits >> 6) & _sixBitMask);
        output[outputIndex++] = alphabet.codeUnitAt(bits & _sixBitMask);
        expectedChars = 3;
        bits = 0;
      }
    }
    if (byteOr >= 0 && byteOr <= 255) {
      if (isLast && expectedChars < 3) {
        writeFinalChunk(alphabet, output, outputIndex, 3 - expectedChars, bits);
        return 0;
      }
      return _encodeState(3 - expectedChars, bits);
    }

    var i = start;
    while (i < end) {
      var byte = bytes[i];
      if (byte < 0 || byte > 255) break;
      i++;
    }
    throw ArgumentError.value(
      bytes,
      "Not a byte value at index " + i.toString() + ": 0x" + bytes[i].toRadixString(16),
    );
  }

  static void writeFinalChunk(
    String alphabet,
    _Uint8List output,
    int outputIndex,
    int count,
    int bits,
  ) {
    assert(count > 0);
    if (count == 1) {
      output[outputIndex++] = alphabet.codeUnitAt((bits >> 2) & _sixBitMask);
      output[outputIndex++] = alphabet.codeUnitAt((bits << 4) & _sixBitMask);
      output[outputIndex++] = _paddingChar;
      output[outputIndex++] = _paddingChar;
    } else {
      assert(count == 2);
      output[outputIndex++] = alphabet.codeUnitAt((bits >> 10) & _sixBitMask);
      output[outputIndex++] = alphabet.codeUnitAt((bits >> 4) & _sixBitMask);
      output[outputIndex++] = alphabet.codeUnitAt((bits << 2) & _sixBitMask);
      output[outputIndex++] = _paddingChar;
    }
  }
}

abstract class _Base64EncoderSink implements EventSink<List<int>> {
  void add(List<int> source) {
    _add(source, 0, source.length, false);
  }

  void close() {
    _add(const [], 0, 0, true);
  }

  void addSlice(List<int> source, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, source.length);
    _add(source, start, end, isLast);
  }

  void _add(List<int> source, int start, int end, bool isLast);
}

class _AsciiBase64EncoderSink extends _Base64EncoderSink {
  final EventSink<String> _sink;
  final _Base64Encoder _encoder;

  _AsciiBase64EncoderSink(this._sink, bool urlSafe)
    : _encoder = _Base64Encoder(urlSafe);

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }

  void _add(List<int> source, int start, int end, bool isLast) {
    var buffer = _encoder.encode(source, start, end, isLast);
    if (buffer != null) {
      var string = String.fromCharCodes(buffer);
      _sink.add(string);
    }
    if (isLast) {
      _sink.close();
    }
  }
}

final class Base64Decoder extends Converter<String, List<int>> {
  const Base64Decoder();

  _Uint8List convert(String input, [int start = 0, int? end]) => _base64Decode(input, start, end);

  Stream<List<int>> bind(Stream<String> stream) =>
      Stream<List<int>>.eventTransformed(stream, (EventSink<List<int>> sink) => _Base64DecoderSink(sink));
}

class _Base64Decoder {
  static const int _valueShift = 2;

  static const int _countMask = 3;

  static const int _invalid = -2;

  static const int _padding = -1;

  static const int __ = _invalid;
  static const int _p = _padding;

  static const List<int> _inverseAlphabet = [
    __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, //
    __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, //
    __, __, __, __, __, _p, __, __, __, __, __, 62, __, 62, __, 63, //
    52, 53, 54, 55, 56, 57, 58, 59, 60, 61, __, __, __, _p, __, __, //
    __, 00, 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, //
    15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, __, __, __, __, 63, //
    __, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, //
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, __, __, __, __, __, //
  ];

  static const int _char_percent = 0x25; // '%'.
  static const int _char_3 = 0x33; // '3'.
  static const int _char_d = 0x64; // 'd'.

  int _state = 0;

  static int _encodeCharacterState(int count, int bits) {
    assert(count == (count & _countMask));
    return (bits << _valueShift | count);
  }

  static int _stateCount(int state) {
    assert(state >= 0);
    return state & _countMask;
  }

  static int _stateBits(int state) {
    assert(state >= 0);
    return state >> _valueShift;
  }

  static int _encodePaddingState(int expectedPadding) {
    assert(expectedPadding >= 0);
    assert(expectedPadding <= 5);
    return -expectedPadding - 1; // ~expectedPadding adapted to dart2js.
  }

  static int _statePadding(int state) {
    assert(state < 0);
    return -state - 1; // ~state adapted to dart2js.
  }

  static bool _hasSeenPadding(int state) => state < 0;

  _Uint8List? decode(String input, int start, int end) {
    assert(0 <= start);
    assert(start <= end);
    assert(end <= input.length);
    if (_hasSeenPadding(_state)) {
      _state = _checkPadding(input, start, end, _state);
      return null;
    }
    if (start == end) return _Uint8List(0);
    var buffer = _allocateBuffer(input, start, end, _state);
    _state = decodeChunk(input, start, end, buffer, 0, _state);
    return buffer;
  }

  void close(String? input, int? end) {
    if (_state < _encodePaddingState(0)) {
      throw FormatException("Missing padding character", input, end);
    }
    if (_state > 0) {
      throw FormatException(
        "Invalid length, must be multiple of four",
        input,
        end,
      );
    }
    _state = _encodePaddingState(0);
  }

  static int decodeChunk(
    String input,
    int start,
    int end,
    _Uint8List output,
    int outIndex,
    int state,
  ) {
    assert(!_hasSeenPadding(state));
    const asciiMask = 127;
    const asciiMax = 127;
    const eightBitMask = 0xFF;
    const bitsPerCharacter = 6;

    var bits = _stateBits(state);
    var count = _stateCount(state);
    var charOr = 0;
    final inverseAlphabet = _Base64Decoder._inverseAlphabet;
    for (var i = start; i < end; i++) {
      var char = input.codeUnitAt(i);
      charOr |= char;
      var code = inverseAlphabet[char & asciiMask];
      if (code >= 0) {
        bits = ((bits << bitsPerCharacter) | code) & 0xFFFFFF;
        count = (count + 1) & 3;
        if (count == 0) {
          assert(outIndex + 3 <= output.length);
          output[outIndex++] = (bits >> 16) & eightBitMask;
          output[outIndex++] = (bits >> 8) & eightBitMask;
          output[outIndex++] = bits & eightBitMask;
          bits = 0;
        }
        continue;
      } else if (code == _padding && count > 1) {
        if (charOr < 0 || charOr > asciiMax) break;
        if (count == 3) {
          if ((bits & 0x03) != 0) {
            throw FormatException("Invalid encoding before padding", input, i);
          }
          output[outIndex++] = bits >> 10;
          output[outIndex++] = bits >> 2;
        } else {
          if ((bits & 0x0F) != 0) {
            throw FormatException("Invalid encoding before padding", input, i);
          }
          output[outIndex++] = bits >> 4;
        }
        //
        var expectedPadding = (3 - count) * 3;
        if (char == _char_percent) expectedPadding += 2;
        state = _encodePaddingState(expectedPadding);
        return _checkPadding(input, i + 1, end, state);
      }
      throw FormatException("Invalid character", input, i);
    }
    if (charOr >= 0 && charOr <= asciiMax) {
      return _encodeCharacterState(count, bits);
    }
    int i;
    for (i = start; i < end; i++) {
      var char = input.codeUnitAt(i);
      if (char < 0 || char > asciiMax) break;
    }
    throw FormatException("Invalid character", input, i);
  }

  static final _Uint8List _emptyBuffer = _Uint8List(0);

  static _Uint8List _allocateBuffer(
    String input,
    int start,
    int end,
    int state,
  ) {
    assert(state >= 0);
    var paddingStart = _trimPaddingChars(input, start, end);
    var length = _stateCount(state) + (paddingStart - start);
    var bufferLength = (length >> 2) * 3;
    var remainderLength = length & 3;
    if (remainderLength != 0 && paddingStart < end) {
      bufferLength += remainderLength - 1;
    }
    if (bufferLength > 0) return _Uint8List(bufferLength);
    return _emptyBuffer;
  }

  static int _trimPaddingChars(String input, int start, int end) {
    var padding = 0;
    var index = end;
    var newEnd = end;
    while (index > start && padding < 2) {
      index--;
      var char = input.codeUnitAt(index);
      if (char == _paddingChar) {
        padding++;
        newEnd = index;
        continue;
      }
      if ((char | 0x20) == _char_d) {
        if (index == start) break;
        index--;
        char = input.codeUnitAt(index);
      }
      if (char == _char_3) {
        if (index == start) break;
        index--;
        char = input.codeUnitAt(index);
      }
      if (char == _char_percent) {
        padding++;
        newEnd = index;
        continue;
      }
      break;
    }
    return newEnd;
  }

  static int _checkPadding(String input, int start, int end, int state) {
    assert(_hasSeenPadding(state));
    if (start == end) return state;
    var expectedPadding = _statePadding(state);
    assert(expectedPadding >= 0);
    assert(expectedPadding < 6);
    while (expectedPadding > 0) {
      var char = input.codeUnitAt(start);
      if (expectedPadding == 3) {
        if (char == _paddingChar) {
          expectedPadding -= 3;
          start++;
          break;
        }
        if (char == _char_percent) {
          expectedPadding--;
          start++;
          if (start == end) break;
          char = input.codeUnitAt(start);
        } else {
          break;
        }
      }
      var expectedPartialPadding = expectedPadding;
      if (expectedPartialPadding > 3) expectedPartialPadding -= 3;
      if (expectedPartialPadding == 2) {
        if (char != _char_3) break;
        start++;
        expectedPadding--;
        if (start == end) break;
        char = input.codeUnitAt(start);
      }
      if ((char | 0x20) != _char_d) break;
      start++;
      expectedPadding--;
      if (start == end) break;
    }
    if (start != end) {
      throw FormatException("Invalid padding character", input, start);
    }
    return _encodePaddingState(expectedPadding);
  }
}

class _Base64DecoderSink implements EventSink<String> {
  final EventSink<List<int>> _sink;
  final _Base64Decoder _decoder = _Base64Decoder();

  _Base64DecoderSink(this._sink);

  void add(String string) {
    if (string.isEmpty) return;
    var buffer = _decoder.decode(string, 0, string.length);
    if (buffer != null) _sink.add(buffer);
  }

  void close() {
    _decoder.close(null, null);
    _sink.close();
  }

  void addSlice(String string, int start, int end, bool isLast) {
    RangeError.checkValidRange(start, end, string.length);
    if (start == end) return;
    var buffer = _decoder.decode(string, start, end);
    if (buffer != null) _sink.add(buffer);
    if (isLast) {
      _decoder.close(string, end);
      _sink.close();
    }
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }
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
    // An empty chunk leaves the state as it is, as the SDK's sink skips it.
    if (chunk.isEmpty) return;
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
