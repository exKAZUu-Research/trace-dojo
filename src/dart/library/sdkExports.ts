// Dart SDK 3.13.7 public declarations and explicit re-exports. Keep unavailable names visible to diagnostics.
const SDK_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'dart:collection',
    new Set(
      `
    DoubleLinkedQueue DoubleLinkedQueueEntry HashMap HashSet HasNextIterator IterableExtensions
    LinkedHashMap LinkedHashSet LinkedList LinkedListEntry ListBase ListQueue MapBase MapView
    NullableIterableExtensions Queue SetBase SplayTreeMap SplayTreeSet UnmodifiableListView
    UnmodifiableMapBase UnmodifiableMapView UnmodifiableSetView
  `
        .trim()
        .split(/\s+/)
    ),
  ],
  [
    'dart:convert',
    new Set(
      `
    ascii AsciiCodec AsciiDecoder AsciiEncoder base64 Base64Codec base64Decode Base64Decoder
    base64Encode Base64Encoder base64Url base64UrlEncode ByteConversionSink ChunkedConversionSink
    ClosableStringSink Codec Converter Encoding HtmlEscape htmlEscape HtmlEscapeMode json JsonCodec
    JsonCyclicError jsonDecode JsonDecoder jsonEncode JsonEncoder JsonUnsupportedObjectError
    JsonUtf8Encoder latin1 Latin1Codec Latin1Decoder Latin1Encoder LineSplitter StringConversionSink
    unicodeBomCharacterRune unicodeReplacementCharacterRune utf8 Utf8Codec Utf8Decoder Utf8Encoder
  `
        .trim()
        .split(/\s+/)
    ),
  ],
  [
    'dart:core',
    new Set(
      `
    ArgumentError AssertionError BigInt bool Comparable ConcurrentModificationError DateTime
    DateTimeCopyWith Deprecated deprecated double Duration Enum EnumByName EnumName Error Exception
    Expando Finalizer FormatException Function Future FutureExtensions FutureIterable FutureRecord2
    FutureRecord3 FutureRecord4 FutureRecord5 FutureRecord6 FutureRecord7 FutureRecord8 FutureRecord9
    identical identityHashCode IndexError int IntegerDivisionByZeroException Invocation Iterable
    IterableExtensions Iterator List Map MapEntry Match NoSuchMethodError Null
    NullableIterableExtensions num Object OutOfMemoryError override ParallelWaitError Pattern pragma
    print RangeError Record RegExp RegExpMatch RuneIterator Runes Set Sink StackOverflowError StackTrace
    StateError Stopwatch Stream String StringBuffer StringSink Symbol Type TypeError UnimplementedError
    UnsupportedError Uri UriData WeakReference
  `
        .trim()
        .split(/\s+/)
    ),
  ],
  [
    'dart:io',
    new Set(
      `
    BadCertificateCallback BytesBuilder CertificateException CompressionOptions ConnectionTask
    ContentType Cookie Datagram Directory exit exitCode File FileLock FileMode FileStat
    FileSystemCreateEvent FileSystemDeleteEvent FileSystemEntity FileSystemEntityType FileSystemEvent
    FileSystemException FileSystemModifyEvent FileSystemMoveEvent gzip GZipCodec HandshakeException
    HeaderValue HttpClient HttpClientBasicCredentials HttpClientBearerCredentials HttpClientCredentials
    HttpClientDigestCredentials HttpClientRequest HttpClientResponse HttpClientResponseCompressionState
    HttpConnectionInfo HttpConnectionsInfo HttpDate HttpException HttpHeaders HttpOverrides HttpRequest
    HttpResponse HttpServer HttpSession HttpStatus InterfaceAddress InternetAddress InternetAddressType
    IOException IOOverrides IOSink Link NetworkInterface OSError PathAccessException PathExistsException
    PathNotFoundException pid Pipe Platform Process ProcessException ProcessInfo ProcessResult
    ProcessSignal ProcessStartMode RandomAccessFile RawDatagramSocket RawSecureServerSocket
    RawSecureSocket RawServerSocket RawSocket RawSocketEvent RawSocketOption RawSynchronousSocket
    RawZLibFilter ReadPipe RedirectException RedirectInfo ResourceHandle SameSite SecureServerSocket
    SecureSocket SecurityContext ServerSocket SignalException sleep Socket SocketControlMessage
    SocketDirection SocketException SocketMessage SocketOption stderr Stdin stdin StdinException
    StdioType stdioType Stdout stdout StdoutException SystemEncoding systemEncoding TlsException
    TlsProtocolVersion WebSocket WebSocketException WebSocketStatus WebSocketTransformer WritePipe
    X509Certificate zlib ZLibCodec ZLibDecoder ZLibEncoder ZLibOption
  `
        .trim()
        .split(/\s+/)
    ),
  ],
  [
    'dart:math',
    new Set(
      `
    acos asin atan atan2 cos e exp ln10 ln2 log log10e log2e max min MutableRectangle pi Point pow
    Random Rectangle sin sqrt sqrt1_2 sqrt2 tan
  `
        .trim()
        .split(/\s+/)
    ),
  ],
]);

export function isSdkExport(library: string, name: string): boolean {
  return SDK_EXPORTS.get(library)?.has(name) ?? false;
}
