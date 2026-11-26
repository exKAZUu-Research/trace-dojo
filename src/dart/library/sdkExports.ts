import type { ClassInfo } from '../classes';
import { SDK_MEMBERS } from './sdkMembers';

/** The library of dart:core's Uri, apart from the rest because it encodes with dart:convert. */
export const URI_LIBRARY = 'dart:_uri';

// Dart SDK 3.13.7 public declarations and explicit re-exports. Keep unavailable names visible to diagnostics.
const SDK_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'dart:async',
    new Set(
      `
    AsyncError Completer ControllerCallback ControllerCancelCallback CreatePeriodicTimerHandler CreateTimerHandler
    DeferredLoadException ErrorCallbackHandler EventSink ForkHandler Future FutureExtensions FutureIterable FutureOr
    FutureRecord2 FutureRecord3 FutureRecord4 FutureRecord5 FutureRecord6 FutureRecord7 FutureRecord8 FutureRecord9
    HandleUncaughtErrorHandler MultiStreamController ParallelWaitError PrintHandler RegisterBinaryCallbackHandler
    RegisterCallbackHandler RegisterUnaryCallbackHandler RunBinaryHandler RunHandler RunUnaryHandler runZoned
    runZonedGuarded scheduleMicrotask ScheduleMicrotaskHandler Stream StreamConsumer StreamController StreamIterator
    StreamSink StreamSubscription StreamTransformer StreamTransformerBase StreamView SynchronousStreamController
    TimeoutException Timer unawaited Zone ZoneBinaryCallback ZoneCallback ZoneDelegate ZoneSpecification
    ZoneUnaryCallback
  `
        .trim()
        .split(/\s+/)
    ),
  ],
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

/** The SDK's members of a class of the interpreter's libraries, by the library the SDK declares the class in. */
function sdkMembersOf(cls: ClassInfo): readonly [string, string, string] | undefined {
  return SDK_MEMBERS[cls.library === URI_LIBRARY ? 'dart:core' : cls.library]?.[cls.name];
}

/** How a member is used: a write uses its setter, which the table writes `name=`. */
export type MemberAccess = 'read' | 'write';

function hasName(names: string, name: string): boolean {
  return ` ${names} `.includes(` ${name} `);
}

function tableName(name: string, access: MemberAccess): string {
  return access === 'write' ? `${name}=` : name;
}

/**
 * Whether the SDK gives instances of a class a member for the access, through the nearest SDK classes it is or
 * extends; the interpreter's own supertypes of an SDK class are not consulted, since its hierarchy may differ.
 */
export function isSdkInstanceMember(cls: ClassInfo, name: string, access: MemberAccess): boolean {
  return sdkInstanceMemberOwner(cls, name, access) !== undefined;
}

/** The nearest SDK class whose instances have the member, as {@link isSdkInstanceMember} finds it. */
export function sdkInstanceMemberOwner(
  cls: ClassInfo,
  name: string,
  access: MemberAccess,
  visited = new Set<ClassInfo>()
): ClassInfo | undefined {
  if (visited.has(cls)) return undefined;
  visited.add(cls);
  const members = cls.library ? sdkMembersOf(cls) : undefined;
  if (members) return hasName(members[0], tableName(name, access)) ? cls : undefined;
  for (const type of [cls.superclass, ...cls.interfaces, ...cls.mixins, ...cls.onTypes]) {
    const owner = type && sdkInstanceMemberOwner(type.cls, name, access, visited);
    if (owner) return owner;
  }
  return undefined;
}

/** Whether the SDK's class has a static member for the access, or a constructor (`''` the unnamed one). */
export function isSdkStaticMember(cls: ClassInfo, name: string, access: MemberAccess): boolean {
  const members = cls.library ? sdkMembersOf(cls) : undefined;
  if (members === undefined) return false;
  // The unnamed constructor has no name of its own, which every list would match, so it is looked up as `new`.
  if (name === '') return access === 'read' && hasName(members[2], 'new');
  return hasName(members[1], tableName(name, access)) || (access === 'read' && hasName(members[2], name));
}
