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
}

final class AsciiEncoder extends _UnicodeSubsetEncoder {
  const AsciiEncoder() : super(_asciiMask);
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
