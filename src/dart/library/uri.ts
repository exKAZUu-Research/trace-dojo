/**
 * dart:core's Uri and UriData from Dart SDK 3.13.7: `sdk/lib/core/uri.dart`, most of its comments removed, with the
 * VM's `_makeQueryFromParameters` (`vm/lib/uri_patch.dart`) and `_uriEncode` (`vm_shared/lib/uri_encode_patch.dart`)
 * inlined, and `hexDigitValue` and `parseHexByte` copied from dart:_internal. Where the SDK reads the platform,
 * `Uri.base` is the working directory of a run's files (`Uri.directory("/")`) and `_isWindows` is false, as on macOS
 * and Linux; `_Uint8List` stands for Uint8List, and `data:` URIs encode base64 by `convert` instead of a chunked sink.
 */
export const URI_SOURCE = String.raw`
const int _SPACE = 0x20;
const int _PERCENT = 0x25;
const int _AMPERSAND = 0x26;
const int _PLUS = 0x2B;
const int _DOT = 0x2E;
const int _SLASH = 0x2F;
const int _DIGIT_0 = 0x30;
const int _COLON = 0x3A;
const int _EQUALS = 0x3d;
const int _UPPER_CASE_A = 0x41;
const int _UPPER_CASE_Z = 0x5A;
const int _LEFT_BRACKET = 0x5B;
const int _BACKSLASH = 0x5C;
const int _RIGHT_BRACKET = 0x5D;
const int _LOWER_CASE_A = 0x61;
const int _LOWER_CASE_F = 0x66;
const int _LOWER_CASE_V = 0x76;
const int _LOWER_CASE_Z = 0x7A;

const String _hexDigits = "0123456789ABCDEF";

abstract interface class Uri {
  static Uri get base => Uri.directory("/");

  factory Uri({
    String? scheme,
    String? userInfo,
    String? host,
    int? port,
    String? path,
    Iterable<String>? pathSegments,
    String? query,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
    String? fragment,
  }) = _Uri;

  factory Uri.http(
    String authority, [
    String unencodedPath,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
  ]) = _Uri.http;

  factory Uri.https(
    String authority, [
    String unencodedPath,
    Map<String, dynamic>? queryParameters,
  ]) = _Uri.https;

  factory Uri.file(String path, {bool? windows}) = _Uri.file;

  factory Uri.directory(String path, {bool? windows}) = _Uri.directory;

  factory Uri.dataFromString(
    String content, {
    String? mimeType,
    Encoding? encoding,
    Map<String, String>? parameters,
    bool base64 = false,
  }) {
    UriData data = UriData.fromString(
      content,
      mimeType: mimeType,
      encoding: encoding,
      parameters: parameters,
      base64: base64,
    );
    return data.uri;
  }

  factory Uri.dataFromBytes(
    List<int> bytes, {
    String mimeType = "application/octet-stream",
    Map<String, String>? parameters,
    bool percentEncoded = false,
  }) {
    UriData data = UriData.fromBytes(
      bytes,
      mimeType: mimeType,
      parameters: parameters,
      percentEncoded: percentEncoded,
    );
    return data.uri;
  }

  String get scheme;

  String get authority;

  String get userInfo;

  String get host;

  int get port;

  String get path;

  String get query;

  String get fragment;

  List<String> get pathSegments;

  Map<String, String> get queryParameters;

  Map<String, List<String>> get queryParametersAll;

  bool get isAbsolute;

  bool get hasScheme => scheme.isNotEmpty;

  bool get hasAuthority;

  bool get hasPort;

  bool get hasQuery;

  bool get hasFragment;

  bool get hasEmptyPath;

  bool get hasAbsolutePath;

  String get origin;

  bool isScheme(String scheme);

  String toFilePath({bool? windows});

  UriData? get data;

  int get hashCode;

  bool operator ==(Object other);

  String toString();

  Uri replace({
    String? scheme,
    String? userInfo,
    String? host,
    int? port,
    String? path,
    Iterable<String>? pathSegments,
    String? query,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
    String? fragment,
  });

  Uri removeFragment();

  Uri resolve(String reference);

  Uri resolveUri(Uri reference);

  Uri normalizePath();

  static Uri parse(String uri, [int start = 0, int? end]) {
    end ??= uri.length;

    if (end >= start + 5) {
      int dataDelta = _startsWithData(uri, start);
      if (dataDelta == 0) {
        if (start > 0 || end < uri.length) uri = uri.substring(start, end);
        return UriData._parse(uri, 5, null).uri;
      } else if (dataDelta == 0x20) {
        return UriData._parse(uri.substring(start + 5, end), 0, null).uri;
      }
    }

    var indices = List<int>.filled(8, 0, growable: false);

    indices
      ..[0] = 0
      ..[_schemeEndIndex] = start - 1
      ..[_hostStartIndex] = start - 1
      ..[_notSimpleIndex] = start - 1
      ..[_portStartIndex] = start
      ..[_pathStartIndex] = start
      ..[_queryStartIndex] = end
      ..[_fragmentStartIndex] = end;
    var state = _scan(uri, start, end, _uriStart, indices);
    if (state >= _nonSimpleEndStates) {
      indices[_notSimpleIndex] = end;
    }
    int schemeEnd = indices[_schemeEndIndex];
    if (schemeEnd >= start) {
      state = _scan(uri, start, schemeEnd, _schemeStart, indices);
      if (state == _schemeStart) {
        indices[_notSimpleIndex] = schemeEnd;
      }
    }

    int hostStart = indices[_hostStartIndex] + 1;
    int portStart = indices[_portStartIndex];
    int pathStart = indices[_pathStartIndex];
    int queryStart = indices[_queryStartIndex];
    int fragmentStart = indices[_fragmentStartIndex];

    String? scheme;

    if (fragmentStart < queryStart) queryStart = fragmentStart;
    if (pathStart < hostStart) {
      pathStart = queryStart;
    } else if (pathStart <= schemeEnd) {
      pathStart = schemeEnd + 1;
    }
    if (portStart < hostStart) portStart = pathStart;

    assert(hostStart == start || schemeEnd <= hostStart);
    assert(hostStart <= portStart);
    assert(schemeEnd <= pathStart);
    assert(portStart <= pathStart);
    assert(pathStart <= queryStart);
    assert(queryStart <= fragmentStart);

    bool isSimple = indices[_notSimpleIndex] < start;

    if (isSimple) {
      if (hostStart > schemeEnd + 3) {
        isSimple = false;
      } else if (portStart > start && portStart + 1 == pathStart) {
        isSimple = false;
      } else if (uri.startsWith(r"\", pathStart) ||
          hostStart > start &&
              (uri.startsWith(r"\", hostStart - 1) ||
                  uri.startsWith(r"\", hostStart - 2))) {
        isSimple = false;
      } else if (queryStart < end &&
              (queryStart == pathStart + 2 &&
                  uri.startsWith("..", pathStart)) ||
          (queryStart > pathStart + 2 &&
              uri.startsWith("/..", queryStart - 3))) {
        isSimple = false;
      } else {
        if (schemeEnd == start + 4) {
          if (uri.startsWith("file", start)) {
            scheme = "file";
            if (hostStart <= start) {
              String schemeAuth = "file://";
              int delta = 2;
              if (!uri.startsWith("/", pathStart)) {
                schemeAuth = "file:///";
                delta = 3;
              }
              uri = schemeAuth + uri.substring(pathStart, end);
              schemeEnd -= start;
              hostStart = 7;
              portStart = 7;
              pathStart = 7;
              queryStart += delta - start;
              fragmentStart += delta - start;
              start = 0;
              end = uri.length;
            } else if (pathStart == queryStart) {
              if (start == 0 && end == uri.length) {
                uri = uri.replaceRange(pathStart, queryStart, "/");
                queryStart += 1;
                fragmentStart += 1;
                end += 1;
              } else {
                uri =
                    "${'${'}uri.substring(start, pathStart)}/"
                    "${'${'}uri.substring(queryStart, end)}";
                schemeEnd -= start;
                hostStart -= start;
                portStart -= start;
                pathStart -= start;
                queryStart += 1 - start;
                fragmentStart += 1 - start;
                start = 0;
                end = uri.length;
              }
            }
          } else if (uri.startsWith("http", start)) {
            scheme = "http";
            if (portStart > start &&
                portStart + 3 == pathStart &&
                uri.startsWith("80", portStart + 1)) {
              if (start == 0 && end == uri.length) {
                uri = uri.replaceRange(portStart, pathStart, "");
                pathStart -= 3;
                queryStart -= 3;
                fragmentStart -= 3;
                end -= 3;
              } else {
                uri =
                    uri.substring(start, portStart) +
                    uri.substring(pathStart, end);
                schemeEnd -= start;
                hostStart -= start;
                portStart -= start;
                pathStart -= 3 + start;
                queryStart -= 3 + start;
                fragmentStart -= 3 + start;
                start = 0;
                end = uri.length;
              }
            }
          }
        } else if (schemeEnd == start + 5 && uri.startsWith("https", start)) {
          scheme = "https";
          if (portStart > start &&
              portStart + 4 == pathStart &&
              uri.startsWith("443", portStart + 1)) {
            if (start == 0 && end == uri.length) {
              uri = uri.replaceRange(portStart, pathStart, "");
              pathStart -= 4;
              queryStart -= 4;
              fragmentStart -= 4;
              end -= 3;
            } else {
              uri =
                  uri.substring(start, portStart) +
                  uri.substring(pathStart, end);
              schemeEnd -= start;
              hostStart -= start;
              portStart -= start;
              pathStart -= 4 + start;
              queryStart -= 4 + start;
              fragmentStart -= 4 + start;
              start = 0;
              end = uri.length;
            }
          }
        }
      }
    }

    if (isSimple) {
      if (start > 0 || end < uri.length) {
        uri = uri.substring(start, end);
        schemeEnd -= start;
        hostStart -= start;
        portStart -= start;
        pathStart -= start;
        queryStart -= start;
        fragmentStart -= start;
      }
      return _SimpleUri(
        uri,
        schemeEnd,
        hostStart,
        portStart,
        pathStart,
        queryStart,
        fragmentStart,
        scheme,
      );
    }

    return _Uri.notSimple(
      uri,
      start,
      end,
      schemeEnd,
      hostStart,
      portStart,
      pathStart,
      queryStart,
      fragmentStart,
      scheme,
    );
  }

  static Uri? tryParse(String uri, [int start = 0, int? end]) {
    try {
      return parse(uri, start, end);
    } on FormatException {
      return null;
    }
  }

  static String encodeComponent(String component) {
    return _Uri._uriEncode(_unreserved2396Mask, component, utf8, false);
  }

  /**
   * Encodes the string [component] according to the HTML 4.01 rules
   * for encoding the posting of a HTML form as a query string
   * component.

   * The component is first encoded to bytes using [encoding].
   * The default is to use [utf8] encoding, which preserves all
   * the characters that don't need encoding.

   * Then the resulting bytes are "percent-encoded". This transforms
   * spaces (U+0020) to a plus sign ('+') and all bytes that are not
   * the ASCII decimal digits, letters or one of '-._~' are written as
   * a percent sign '%' followed by the two-digit hexadecimal
   * representation of the byte.

   * Note that the set of characters which are percent-encoded is a
   * superset of what HTML 4.01 requires, since it refers to RFC 1738
   * for reserved characters.
   *
   * When manually encoding query components remember to encode each
   * part separately before building the query string.
   *
   * To avoid the need for explicitly encoding the query use the
   * [queryParameters] optional named arguments when constructing a
   * [Uri].
   *
   * See https://www.w3.org/TR/html401/interact/forms.html#h-17.13.4.2 for more
   * details.
   */
  static String encodeQueryComponent(
    String component, {
    Encoding encoding = utf8,
  }) {
    return _Uri._uriEncode(_unreservedMask, component, encoding, true);
  }

  static String decodeComponent(String encodedComponent) {
    return _Uri._uriDecode(
      encodedComponent,
      0,
      encodedComponent.length,
      utf8,
      false,
    );
  }

  static String decodeQueryComponent(
    String encodedComponent, {
    Encoding encoding = utf8,
  }) {
    return _Uri._uriDecode(
      encodedComponent,
      0,
      encodedComponent.length,
      encoding,
      true,
    );
  }

  static String encodeFull(String uri) {
    return _Uri._uriEncode(_encodeFullMask, uri, utf8, false);
  }

  static String decodeFull(String uri) {
    return _Uri._uriDecode(uri, 0, uri.length, utf8, false);
  }

  static Map<String, String> splitQueryString(
    String query, {
    Encoding encoding = utf8,
  }) {
    return query.split("&").fold({}, (map, element) {
      int index = element.indexOf("=");
      if (index == -1) {
        if (element != "") {
          map[decodeQueryComponent(element, encoding: encoding)] = "";
        }
      } else if (index != 0) {
        var key = element.substring(0, index);
        var value = element.substring(index + 1);
        map[decodeQueryComponent(key, encoding: encoding)] =
            decodeQueryComponent(value, encoding: encoding);
      }
      return map;
    });
  }

  static List<int> parseIPv4Address(
    String host, [
    int start = 0,
    int? end,
  ]) {
    end = RangeError.checkValidRange(start, end, host.length);
    var list = _Uint8List(4);
    _parseIPv4Address(host, start, end, list, 0);
    return list;
  }

  static Never _ipv4FormatError(String msg, String source, int position) {
    throw FormatException('Illegal IPv4 address, $msg', source, position);
  }

  static void _parseIPv4Address(
    String host,
    int start,
    int end,
    _Uint8List target,
    int targetOffset,
  ) {
    assert(target.length >= targetOffset + 4);
    var cursor = start;
    var octetStart = cursor;
    var octetIndex = 0;
    var octetValue = 0;
    while (true) {
      var char = cursor >= end ? 0 : host.codeUnitAt(cursor);
      var digit = char ^ _DIGIT_0;
      if (digit <= 9) {
        if (octetValue != 0 || cursor == octetStart) {
          octetValue = octetValue * 10 + digit;
          if (octetValue <= 255) {
            cursor++;
            continue;
          }
          _ipv4FormatError(
            "each part must be in the range 0..255",
            host,
            octetStart,
          );
        }
        _ipv4FormatError("parts must not have leading zeros", host, octetStart);
      }
      if (cursor == octetStart) {
        if (cursor == end) break; // Report as missing part.
        _ipv4FormatError("invalid character", host, cursor);
      }
      target[targetOffset + octetIndex++] = octetValue;
      if (char == _DOT) {
        if (octetIndex < 4) {
          octetValue = 0;
          octetStart = ++cursor;
          continue;
        }
        break; // Too many parts (fourth ${'`'}.${'`'}).
      }
      if (cursor == end) {
        if (octetIndex == 4) return;
        break; // Too few parts.
      }
      _ipv4FormatError("invalid character", host, cursor);
    }
    _ipv4FormatError(
      'IPv4 address should contain exactly 4 parts',
      host,
      cursor,
    );
  }

  static bool _validateIPvAddress(String host, int start, int end) {
    assert(0 <= start && start <= end && end <= host.length);
    if (start == end) throw FormatException("Empty IP address", host, start);
    var firstChar = host.codeUnitAt(start);
    if (firstChar == _LOWER_CASE_V) {
      var error = _validateIPvFutureAddress(host, start, end);
      if (error != null) throw error;
      return false;
    }
    parseIPv6Address(host, start, end);
    return true;
  }

  static FormatException? _validateIPvFutureAddress(
    String host,
    int start,
    int end,
  ) {
    assert(host.startsWith('v', start));
    start++;
    var cursor = start;
    var char = 0;
    while (true) {
      if (cursor < end) {
        char = host.codeUnitAt(cursor++);
        if (char ^ _DIGIT_0 <= 9) continue;
        var ucChar = char | 0x20;
        if (ucChar >= _LOWER_CASE_A && ucChar <= _LOWER_CASE_F) continue;
        if (char == _DOT) {
          if (cursor - 1 == start) {
            return FormatException(
              "Missing hex-digit in IPvFuture address",
              host,
              cursor,
            );
          }
          break;
        }
        return FormatException("Unexpected character", host, cursor - 1);
      }
      if (cursor - 1 == start) {
        return FormatException(
          "Missing hex-digit in IPvFuture address",
          host,
          cursor,
        );
      }
      return FormatException("Missing '.' in IPvFuture address", host, cursor);
    }
    if (cursor == end) {
      return FormatException(
        "Missing address in IPvFuture address, host, cursor",
      );
    }
    while (true) {
      var char = host.codeUnitAt(cursor);
      if (_charTables.codeUnitAt(char) & _ipvFutureAddressCharsMask != 0) {
        if (++cursor < end) continue;
        return null;
      }
      return FormatException(
        "Invalid IPvFuture address character",
        host,
        cursor,
      );
    }
  }

  static List<int> parseIPv6Address(String host, [int start = 0, int? end]) {
    end ??= RangeError.checkValidRange(start, end, host.length);

    Never error(String msg, int? position) {
      throw FormatException('Illegal IPv6 address, $msg', host, position);
    }

    if (end - start < 2) error('address is too short', null);
    _Uint8List result = _Uint8List(16);
    int partStart = start;
    int wildcardAt = -1;
    int partCount = 0;
    int hexValue = 0;
    bool decValue = true;
    int cursor = start;
    if (host.codeUnitAt(cursor) == _COLON) {
      if (host.codeUnitAt(cursor + 1) == _COLON) {
        wildcardAt = 0;
        partCount = 1;
        partStart = cursor += 2;
      } else {
        error('invalid start colon', cursor);
      }
    }
    while (true) {
      var char = cursor >= end ? 0 : host.codeUnitAt(cursor);
      handleDigit:
      {
        int hexDigit;
        if (char ^ _DIGIT_0 case var digit when digit <= 9) {
          hexDigit = digit;
        } else if (char | 0x20 case var letter
            when letter >= _LOWER_CASE_A && letter <= _LOWER_CASE_F) {
          hexDigit = letter - (_LOWER_CASE_A - 10);
          decValue = false;
        } else {
          break handleDigit; // Not a digit.
        }
        if (cursor < partStart + 4) {
          hexValue = hexValue * 16 + hexDigit;
          cursor++;
          continue;
        }
        error('an IPv6 part can contain a maximum of 4 hex digits', partStart);
      }
      if (cursor > partStart) {
        if (char == _DOT) {
          if (decValue) {
            if (partCount <= 6) {
              _parseIPv4Address(host, partStart, end, result, partCount * 2);
              cursor = end; // Throws if IPv4 does not extend to end.
              partCount += 2;
              break; // Must be last.
            }
            error('an address must contain at most 8 parts', partStart);
          }
          break; // Any other dot is just an invalid character.
        }
        result[partCount * 2] = hexValue >> 8;
        result[partCount * 2 + 1] = hexValue & 0xFF;
        partCount++;
        if (char == _COLON) {
          if (partCount < 8) {
            hexValue = 0;
            decValue = true;
            cursor++;
            partStart = cursor;
            continue;
          }
          error('an address must contain at most 8 parts', cursor);
        }
        break; // Unexpected character or the end sentinel.
      }
      if (char == _COLON) {
        if (wildcardAt < 0) {
          wildcardAt = partCount;
          partCount++; // A wildcard fills at least one part.
          partStart = ++cursor;
          continue;
        }
        error('only one wildcard ${'`'}::${'`'} is allowed', cursor);
      }
      if (wildcardAt != partCount - 1) {
        error('missing part', cursor);
      }
      break; // Error if not at end.
    }
    if (cursor < end) error('invalid character', cursor);
    if (partCount < 8) {
      if (wildcardAt < 0) {
        error(
          'an address without a wildcard must contain exactly 8 parts',
          end,
        );
      }
      var partAfterWildcard = wildcardAt + 1;
      int partsAfterWildcard = partCount - partAfterWildcard;
      if (partsAfterWildcard > 0) {
        var positionAfterWildcard = partAfterWildcard * 2;
        var bytesAfterWildcard = partsAfterWildcard * 2;
        var newPositionAfterWildcard = result.length - bytesAfterWildcard;
        result.setRange(
          newPositionAfterWildcard,
          result.length,
          result,
          positionAfterWildcard,
        );
        result.fillRange(positionAfterWildcard, newPositionAfterWildcard, 0);
      }
    }
    return result;
  }
}

sealed class _PlatformUri implements Uri {}

final class _Uri implements _PlatformUri {
  final String scheme;

  final String _userInfo;

  final String? _host;

  int? _port;

  final String path;

  final String? _query;

  final String? _fragment;

  late final String _text = this._initializeText();

  late final List<String> pathSegments = _computePathSegments(this.path);

  late final int hashCode = this._text.hashCode;

  late final Map<String, String> queryParameters =
      UnmodifiableMapView<String, String>(Uri.splitQueryString(this.query));

  late final Map<String, List<String>> queryParametersAll =
      _computeQueryParametersAll(this.query);

  _Uri._internal(
    this.scheme,
    this._userInfo,
    this._host,
    this._port,
    this.path,
    this._query,
    this._fragment,
  );

  factory _Uri.notSimple(
    String uri,
    int start,
    int end,
    int schemeEnd,
    int hostStart,
    int portStart,
    int pathStart,
    int queryStart,
    int fragmentStart,
    String? scheme,
  ) {
    if (scheme == null) {
      scheme = "";
      if (schemeEnd > start) {
        scheme = _makeScheme(uri, start, schemeEnd);
      } else if (schemeEnd == start) {
        _fail(uri, start, "Invalid empty scheme");
      }
    }
    String userInfo = "";
    String? host;
    int? port;
    if (hostStart > start) {
      int userInfoStart = schemeEnd + 3;
      if (userInfoStart < hostStart) {
        userInfo = _makeUserInfo(uri, userInfoStart, hostStart - 1);
      }
      host = _makeHost(uri, hostStart, portStart, false);
      if (portStart + 1 < pathStart) {
        int portNumber =
            int.tryParse(uri.substring(portStart + 1, pathStart)) ??
            (throw FormatException("Invalid port", uri, portStart + 1));
        port = _makePort(portNumber, scheme);
      }
    }
    String path = _makePath(
      uri,
      pathStart,
      queryStart,
      null,
      scheme,
      host != null,
    );
    String? query;
    if (queryStart < fragmentStart) {
      query = _makeQuery(uri, queryStart + 1, fragmentStart, null);
    }
    String? fragment;
    if (fragmentStart < end) {
      fragment = _makeFragment(uri, fragmentStart + 1, end);
    }
    return _Uri._internal(scheme, userInfo, host, port, path, query, fragment);
  }

  factory _Uri({
    String? scheme,
    String? userInfo,
    String? host,
    int? port,
    String? path,
    Iterable<String>? pathSegments,
    String? query,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
    String? fragment,
  }) {
    if (scheme == null) {
      scheme = "";
    } else {
      scheme = _makeScheme(scheme, 0, scheme.length);
    }
    userInfo = _makeUserInfo(userInfo, 0, _stringOrNullLength(userInfo));
    if (userInfo == null) {
      throw "unreachable";
    }
    host = _makeHost(host, 0, _stringOrNullLength(host), false);
    if (query == "") query = null;
    query = _makeQuery(query, 0, _stringOrNullLength(query), queryParameters);
    fragment = _makeFragment(fragment, 0, _stringOrNullLength(fragment));
    port = _makePort(port, scheme);
    bool isFile = (scheme == "file");
    if (host == null && (userInfo.isNotEmpty || port != null || isFile)) {
      host = "";
    }
    bool hasAuthority = (host != null);
    path = _makePath(
      path,
      0,
      _stringOrNullLength(path),
      pathSegments,
      scheme,
      hasAuthority,
    );
    if (path == null) {
      throw "unreachable";
    }
    if (scheme.isEmpty && host == null && !path.startsWith('/')) {
      bool allowScheme = scheme.isNotEmpty || host != null;
      path = _normalizeRelativePath(path, allowScheme);
    } else {
      path = _removeDotSegments(path);
    }
    if (host == null && path.startsWith("//")) {
      host = "";
    }
    return _Uri._internal(scheme, userInfo, host, port, path, query, fragment);
  }

  factory _Uri.http(
    String authority, [
    String unencodedPath = '',
    Map<String, dynamic>? queryParameters,
  ]) {
    return _makeHttpUri("http", authority, unencodedPath, queryParameters);
  }

  factory _Uri.https(
    String authority, [
    String unencodedPath = '',
    Map<String, dynamic>? queryParameters,
  ]) {
    return _makeHttpUri("https", authority, unencodedPath, queryParameters);
  }

  String get authority {
    if (!hasAuthority) return "";
    var sb = StringBuffer();
    _writeAuthority(sb);
    return sb.toString();
  }

  String get userInfo => _userInfo;

  String get host {
    String? host = _host;
    if (host == null) return "";
    if (host.startsWith('[') && !host.startsWith('v', 1)) {
      return host.substring(1, host.length - 1);
    }
    return host;
  }

  int get port {
    return _port ?? _defaultPort(scheme);
  }

  static int _defaultPort(String scheme) {
    if (scheme == "http") return 80;
    if (scheme == "https") return 443;
    return 0;
  }

  String get query => _query ?? "";

  String get fragment => _fragment ?? "";

  bool isScheme(String scheme) {
    String thisScheme = this.scheme;
    if (scheme == null) return thisScheme.isEmpty;
    if (scheme.length != thisScheme.length) return false;
    return _caseInsensitiveStartsWith(scheme, thisScheme, 0);
  }

  static Never _fail(String uri, int index, String message) {
    throw FormatException(message, uri, index);
  }

  static _Uri _makeHttpUri(
    String scheme,
    String? authority,
    String unencodedPath,
    Map<String, dynamic>? queryParameters,
  ) {
    var userInfo = "";
    String? host;
    int? port;

    if (authority != null && authority.isNotEmpty) {
      var hostStart = 0;
      for (int i = 0; i < authority.length; i++) {
        const int atSign = 0x40;
        if (authority.codeUnitAt(i) == atSign) {
          userInfo = authority.substring(0, i);
          hostStart = i + 1;
          break;
        }
      }
      var hostEnd = hostStart;
      if (hostStart < authority.length &&
          authority.codeUnitAt(hostStart) == _LEFT_BRACKET) {
        int escapeForZoneID = -1;
        for (; hostEnd < authority.length; hostEnd++) {
          int char = authority.codeUnitAt(hostEnd);
          if (char == _PERCENT && escapeForZoneID < 0) {
            escapeForZoneID = hostEnd;
            if (authority.startsWith("25", hostEnd + 1)) {
              hostEnd += 2; // Might as well skip the already checked escape.
            }
          } else if (char == _RIGHT_BRACKET) {
            break;
          }
        }
        if (hostEnd == authority.length) {
          throw FormatException(
            "Invalid IPv6 host entry.",
            authority,
            hostStart,
          );
        }
        bool isIPv6 = Uri._validateIPvAddress(
          authority,
          hostStart + 1,
          (escapeForZoneID < 0) ? hostEnd : escapeForZoneID,
        );
        hostEnd++; // Skip the closing bracket.
        if (hostEnd != authority.length &&
            authority.codeUnitAt(hostEnd) != _COLON) {
          throw FormatException("Invalid end of authority", authority, hostEnd);
        }
      }
      for (; hostEnd < authority.length; hostEnd++) {
        if (authority.codeUnitAt(hostEnd) == _COLON) {
          var portString = authority.substring(hostEnd + 1);
          if (portString.isNotEmpty) port = int.parse(portString);
          break;
        }
      }
      host = authority.substring(hostStart, hostEnd);
    }
    return _Uri(
      scheme: scheme,
      userInfo: userInfo,
      host: host,
      port: port,
      pathSegments: unencodedPath.split("/"),
      queryParameters: queryParameters,
    );
  }

  factory _Uri.file(String path, {bool? windows}) {
    return (windows ?? _Uri._isWindows)
        ? _makeWindowsFileUrl(path, false)
        : _makeFileUri(path, false);
  }

  factory _Uri.directory(String path, {bool? windows}) {
    return (windows ?? _Uri._isWindows)
        ? _makeWindowsFileUrl(path, true)
        : _makeFileUri(path, true);
  }

  static bool get _isWindows => false;

  static void _checkNonWindowsPathReservedCharacters(
    List<String> segments,
    bool argumentError,
  ) {
    for (var segment in segments) {
      if (segment.contains("/")) {
        if (argumentError) {
          throw ArgumentError("Illegal path character $segment");
        } else {
          throw UnsupportedError("Illegal path character $segment");
        }
      }
    }
  }

  static void _checkWindowsPathReservedCharacters(
    List<String> segments,
    bool argumentError, [
    int firstSegment = 0,
  ]) {
    for (var segment in segments.skip(firstSegment)) {
      if (segment.contains(RegExp(r'["*/:<>?\\|]'))) {
        if (argumentError) {
          throw ArgumentError("Illegal character in path");
        } else {
          throw UnsupportedError("Illegal character in path: $segment");
        }
      }
    }
  }

  static void _checkWindowsDriveLetter(int charCode, bool argumentError) {
    if ((_UPPER_CASE_A <= charCode && charCode <= _UPPER_CASE_Z) ||
        (_LOWER_CASE_A <= charCode && charCode <= _LOWER_CASE_Z)) {
      return;
    }
    if (argumentError) {
      throw ArgumentError(
        "Illegal drive letter " + String.fromCharCode(charCode),
      );
    } else {
      throw UnsupportedError(
        "Illegal drive letter " + String.fromCharCode(charCode),
      );
    }
  }

  static Uri _makeFileUri(String path, bool slashTerminated) {
    const String sep = "/";
    var segments = path.split(sep);
    if (slashTerminated && segments.isNotEmpty && segments.last.isNotEmpty) {
      segments.add(""); // Extra separator at end.
    }
    if (path.startsWith(sep)) {
      return Uri(scheme: "file", pathSegments: segments);
    } else {
      return Uri(pathSegments: segments);
    }
  }

  static _makeWindowsFileUrl(String path, bool slashTerminated) {
    if (path.startsWith(r"\\?\")) {
      if (path.startsWith(r"UNC\", 4)) {
        path = path.replaceRange(0, 7, r'\');
      } else {
        path = path.substring(4);
        if (path.length < 3 ||
            path.codeUnitAt(1) != _COLON ||
            path.codeUnitAt(2) != _BACKSLASH) {
          throw ArgumentError.value(
            path,
            "path",
            r"Windows paths with \\?\ prefix must be absolute",
          );
        }
      }
    } else {
      path = path.replaceAll("/", r'\');
    }
    const String sep = r'\';
    if (path.length > 1 && path.codeUnitAt(1) == _COLON) {
      _checkWindowsDriveLetter(path.codeUnitAt(0), true);
      if (path.length == 2 || path.codeUnitAt(2) != _BACKSLASH) {
        throw ArgumentError.value(
          path,
          "path",
          "Windows paths with drive letter must be absolute",
        );
      }
      var pathSegments = path.split(sep);
      if (slashTerminated && pathSegments.last.isNotEmpty) {
        pathSegments.add(""); // Extra separator at end.
      }
      _checkWindowsPathReservedCharacters(pathSegments, true, 1);
      return Uri(scheme: "file", pathSegments: pathSegments);
    }

    if (path.startsWith(sep)) {
      if (path.startsWith(sep, 1)) {
        int pathStart = path.indexOf(r'\', 2);
        String hostPart = (pathStart < 0)
            ? path.substring(2)
            : path.substring(2, pathStart);
        String pathPart = (pathStart < 0) ? "" : path.substring(pathStart + 1);
        var pathSegments = pathPart.split(sep);
        _checkWindowsPathReservedCharacters(pathSegments, true);
        if (slashTerminated && pathSegments.last.isNotEmpty) {
          pathSegments.add(""); // Extra separator at end.
        }
        return Uri(scheme: "file", host: hostPart, pathSegments: pathSegments);
      } else {
        var pathSegments = path.split(sep);
        if (slashTerminated && pathSegments.last.isNotEmpty) {
          pathSegments.add(""); // Extra separator at end.
        }
        _checkWindowsPathReservedCharacters(pathSegments, true);
        return Uri(scheme: "file", pathSegments: pathSegments);
      }
    } else {
      var pathSegments = path.split(sep);
      _checkWindowsPathReservedCharacters(pathSegments, true);
      if (slashTerminated &&
          pathSegments.isNotEmpty &&
          pathSegments.last.isNotEmpty) {
        pathSegments.add(""); // Extra separator at end.
      }
      return Uri(pathSegments: pathSegments);
    }
  }

  Uri replace({
    String? scheme,
    String? userInfo,
    String? host,
    int? port,
    String? path,
    Iterable<String>? pathSegments,
    String? query,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
    String? fragment,
  }) {
    bool schemeChanged = false;
    if (scheme != null) {
      scheme = _makeScheme(scheme, 0, scheme.length);
      schemeChanged = (scheme != this.scheme);
    } else {
      scheme = this.scheme;
    }

    bool isFile = (scheme == "file");
    if (userInfo != null) {
      userInfo = _makeUserInfo(userInfo, 0, userInfo.length);
    } else {
      userInfo = this._userInfo;
    }

    if (port != null) {
      port = _makePort(port, scheme);
    } else {
      port = this._port;
      if (schemeChanged) {
        port = _makePort(port, scheme);
      }
    }
    if (host != null) {
      host = _makeHost(host, 0, host.length, false);
    } else if (this.hasAuthority) {
      host = this._host;
    } else if (userInfo.isNotEmpty || port != null || isFile) {
      host = "";
    }

    bool hasAuthority = host != null;
    if (path != null || pathSegments != null) {
      path = _makePath(
        path,
        0,
        _stringOrNullLength(path),
        pathSegments,
        scheme,
        hasAuthority,
      );
    } else {
      var currentPath = this.path;
      if ((isFile || (hasAuthority && !currentPath.isEmpty)) &&
          !currentPath.startsWith('/')) {
        currentPath = "/" + currentPath;
      }
      path = currentPath;
    }

    if (query != null || queryParameters != null) {
      query = _makeQuery(query, 0, _stringOrNullLength(query), queryParameters);
    } else {
      query = this._query;
    }

    if (fragment != null) {
      fragment = _makeFragment(fragment, 0, fragment.length);
    } else {
      fragment = this._fragment;
    }

    return _Uri._internal(scheme, userInfo, host, port, path, query, fragment);
  }

  Uri removeFragment() {
    if (!this.hasFragment) return this;
    return _Uri._internal(scheme, _userInfo, _host, _port, path, _query, null);
  }

  static List<String> _computePathSegments(String pathToSplit) {
    if (pathToSplit.isNotEmpty && pathToSplit.codeUnitAt(0) == _SLASH) {
      pathToSplit = pathToSplit.substring(1);
    }
    return (pathToSplit.isEmpty)
        ? const <String>[]
        : List<String>.unmodifiable(
            pathToSplit.split("/").map(Uri.decodeComponent),
          );
  }

  static Map<String, List<String>> _computeQueryParametersAll(String? query) {
    if (query == null || query.isEmpty) return const <String, List<String>>{};
    Map<String, List<String>> queryParameterLists = _splitQueryStringAll(query);
    queryParameterLists.updateAll(_toUnmodifiableStringList);
    return Map<String, List<String>>.unmodifiable(queryParameterLists);
  }

  Uri normalizePath() {
    String path = _normalizePath(this.path, scheme, hasAuthority);
    if (identical(path, this.path)) return this;
    return this.replace(path: path);
  }

  static int? _makePort(int? port, String scheme) {
    if (port != null && port == _defaultPort(scheme)) return null;
    return port;
  }

  static String? _makeHost(String? host, int start, int end, bool strictIPv6) {
    if (host == null) return null;
    if (start == end) return "";
    if (host.codeUnitAt(start) == _LEFT_BRACKET) {
      if (host.codeUnitAt(end - 1) != _RIGHT_BRACKET) {
        _fail(host, start, 'Missing end ${'`'}]${'`'} to match ${'`'}[${'`'} in host');
      }
      String zoneID = "";
      int index = end - 1;
      if (host.codeUnitAt(start + 1) != _LOWER_CASE_V) {
        index = _checkZoneID(host, start + 1, end - 1);
        if (index < end - 1) {
          int zoneIDstart = (host.startsWith("25", index + 1))
              ? index + 3
              : index + 1;
          zoneID = _normalizeZoneID(host, zoneIDstart, end - 1, "%25");
        }
      }
      bool isIPv6 = Uri._validateIPvAddress(host, start + 1, index);
      var hostChars = host.substring(start + 1, index);
      if (isIPv6) hostChars = hostChars.toLowerCase();
      return '[$hostChars$zoneID]';
    }
    if (!strictIPv6) {
      for (int i = start; i < end; i++) {
        if (host.codeUnitAt(i) == _COLON) {
          String zoneID = "";
          int index = _checkZoneID(host, start, end);
          if (index < end) {
            int zoneIDstart = (host.startsWith("25", index + 1))
                ? index + 3
                : index + 1;
            zoneID = _normalizeZoneID(host, zoneIDstart, end, "%25");
          }
          Uri.parseIPv6Address(host, start, index);
          return '[${'${'}host.substring(start, index)}$zoneID]';
        }
      }
    }
    return _normalizeRegName(host, start, end);
  }

  static int _checkZoneID(String host, int start, int end) {
    int index = host.indexOf('%', start);
    index = (index >= start && index < end) ? index : end;
    return index;
  }

  static bool _isZoneIDChar(int char) {
    return char < 127 && (_charTables.codeUnitAt(char) & _zoneIDMask) != 0;
  }

  static String _normalizeZoneID(
    String host,
    int start,
    int end, [
    String prefix = '',
  ]) {
    StringBuffer? buffer;
    if (prefix != '') {
      buffer = StringBuffer(prefix);
    }
    int sectionStart = start;
    int index = start;
    bool isNormalized = true;

    while (index < end) {
      int char = host.codeUnitAt(index);
      if (char == _PERCENT) {
        String? replacement = _normalizeEscape(host, index, true);
        if (replacement == null && isNormalized) {
          index += 3;
          continue;
        }
        buffer ??= StringBuffer();
        String slice = host.substring(sectionStart, index);
        buffer.write(slice);
        int sourceLength = 3;
        if (replacement == null) {
          replacement = host.substring(index, index + 3);
        } else if (replacement == "%") {
          _fail(host, index, "ZoneID should not contain % anymore");
        }
        buffer.write(replacement);
        index += sourceLength;
        sectionStart = index;
        isNormalized = true;
      } else if (_isZoneIDChar(char)) {
        if (isNormalized && _UPPER_CASE_A <= char && _UPPER_CASE_Z >= char) {
          buffer ??= StringBuffer();
          if (sectionStart < index) {
            buffer.write(host.substring(sectionStart, index));
            sectionStart = index;
          }
          isNormalized = false;
        }
        index++;
      } else {
        int sourceLength = 1;
        if ((char & 0xFC00) == 0xD800 && (index + 1) < end) {
          int tail = host.codeUnitAt(index + 1);
          if ((tail & 0xFC00) == 0xDC00) {
            char = 0x10000 + ((char & 0x3ff) << 10) + (tail & 0x3ff);
            sourceLength = 2;
          }
        }
        String slice = host.substring(sectionStart, index);
        (buffer ??= StringBuffer())
          ..write(slice)
          ..write(_escapeChar(char));
        index += sourceLength;
        sectionStart = index;
      }
    }
    if (buffer == null) return host.substring(start, end);
    if (sectionStart < end) {
      String slice = host.substring(sectionStart, end);
      buffer.write(slice);
    }
    return buffer.toString();
  }

  static bool _isRegNameChar(int char) {
    return char < 127 && (_charTables.codeUnitAt(char) & _regNameMask) != 0;
  }

  static String _normalizeRegName(String host, int start, int end) {
    StringBuffer? buffer;
    int sectionStart = start;
    int index = start;
    bool isNormalized = true;

    while (index < end) {
      int char = host.codeUnitAt(index);
      if (char == _PERCENT) {
        String? replacement = _normalizeEscape(host, index, true);
        if (replacement == null && isNormalized) {
          index += 3;
          continue;
        }
        buffer ??= StringBuffer();
        String slice = host.substring(sectionStart, index);
        if (!isNormalized) slice = slice.toLowerCase();
        buffer.write(slice);
        int sourceLength = 3;
        if (replacement == null) {
          replacement = host.substring(index, index + 3);
        } else if (replacement == "%") {
          replacement = "%25";
          sourceLength = 1;
        }
        buffer.write(replacement);
        index += sourceLength;
        sectionStart = index;
        isNormalized = true;
      } else if (_isRegNameChar(char)) {
        if (isNormalized && _UPPER_CASE_A <= char && _UPPER_CASE_Z >= char) {
          buffer ??= StringBuffer();
          if (sectionStart < index) {
            buffer.write(host.substring(sectionStart, index));
            sectionStart = index;
          }
          isNormalized = false;
        }
        index++;
      } else if (_isGeneralDelimiter(char)) {
        _fail(host, index, "Invalid character");
      } else {
        int sourceLength = 1;
        if ((char & 0xFC00) == 0xD800 && (index + 1) < end) {
          int tail = host.codeUnitAt(index + 1);
          if ((tail & 0xFC00) == 0xDC00) {
            char = 0x10000 + ((char & 0x3ff) << 10) + (tail & 0x3ff);
            sourceLength = 2;
          }
        }
        String slice = host.substring(sectionStart, index);
        if (!isNormalized) slice = slice.toLowerCase();
        (buffer ??= StringBuffer())
          ..write(slice)
          ..write(_escapeChar(char));
        index += sourceLength;
        sectionStart = index;
      }
    }
    if (buffer == null) return host.substring(start, end);
    if (sectionStart < end) {
      String slice = host.substring(sectionStart, end);
      if (!isNormalized) slice = slice.toLowerCase();
      buffer.write(slice);
    }
    return buffer.toString();
  }

  static String _makeScheme(String scheme, int start, int end) {
    if (start == end) return "";
    final int firstCodeUnit = scheme.codeUnitAt(start);
    if (!_isAlphabeticCharacter(firstCodeUnit)) {
      _fail(scheme, start, "Scheme not starting with alphabetic character");
    }
    bool containsUpperCase = false;
    for (int i = start; i < end; i++) {
      final int codeUnit = scheme.codeUnitAt(i);
      if (!_isSchemeCharacter(codeUnit)) {
        _fail(scheme, i, "Illegal scheme character");
      }
      if (_UPPER_CASE_A <= codeUnit && codeUnit <= _UPPER_CASE_Z) {
        containsUpperCase = true;
      }
    }
    scheme = scheme.substring(start, end);
    if (containsUpperCase) scheme = scheme.toLowerCase();
    return _canonicalizeScheme(scheme);
  }

  static String _canonicalizeScheme(String scheme) {
    if (scheme == "http") return "http";
    if (scheme == "file") return "file";
    if (scheme == "https") return "https";
    if (scheme == "package") return "package";
    return scheme;
  }

  static String _makeUserInfo(String? userInfo, int start, int end) {
    if (userInfo == null) return "";
    return _normalizeOrSubstring(userInfo, start, end, _userinfoMask);
  }

  static String _makePath(
    String? path,
    int start,
    int end,
    Iterable<String>? pathSegments,
    String scheme,
    bool hasAuthority,
  ) {
    bool isFile = (scheme == "file");
    bool ensureLeadingSlash = isFile || hasAuthority;
    String result;
    if (path == null) {
      if (pathSegments == null) return isFile ? "/" : "";
      result = pathSegments
          .map((s) => _uriEncode(_pathCharMask, s, utf8, false))
          .join("/");
    } else if (pathSegments != null) {
      throw ArgumentError('Both path and pathSegments specified');
    } else {
      result = _normalizeOrSubstring(
        path,
        start,
        end,
        _pathCharOrSlashMask,
        escapeDelimiters: true,
        replaceBackslash: true,
      );
    }
    if (result.isEmpty) {
      if (isFile) return "/";
    } else if (ensureLeadingSlash && !result.startsWith('/')) {
      result = "/" + result;
    }
    result = _normalizePath(result, scheme, hasAuthority);
    return result;
  }

  static String _normalizePath(String path, String scheme, bool hasAuthority) {
    if (scheme.isEmpty &&
        !hasAuthority &&
        !path.startsWith('/') &&
        !path.startsWith(r'\')) {
      return _normalizeRelativePath(path, scheme.isNotEmpty || hasAuthority);
    }
    return _removeDotSegments(path);
  }

  static String? _makeQuery(
    String? query,
    int start,
    int end,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
  ) {
    if (query != null) {
      if (queryParameters != null) {
        throw ArgumentError('Both query and queryParameters specified');
      }
      return _normalizeOrSubstring(
        query,
        start,
        end,
        _queryCharMask,
        escapeDelimiters: true,
      );
    }
    if (queryParameters == null) return null;
    return _makeQueryFromParameters(queryParameters);
  }

  static String _makeQueryFromParameters(
    Map<String, dynamic> queryParameters,
  ) {
    return _makeQueryFromParametersDefault(queryParameters);
  }

  static String _makeQueryFromParametersDefault(
    Map<String, dynamic /*String?|Iterable<String>*/> queryParameters,
  ) {
    var result = StringBuffer();
    var separator = "";

    void writeParameter(String key, String? value) {
      result.write(separator);
      separator = "&";
      result.write(Uri.encodeQueryComponent(key));
      if (value != null && value.isNotEmpty) {
        result.write("=");
        result.write(Uri.encodeQueryComponent(value));
      }
    }

    queryParameters.forEach((key, value) {
      if (value == null || value is String) {
        writeParameter(key, value);
      } else {
        Iterable values = value;
        for (String value in values) {
          writeParameter(key, value);
        }
      }
    });
    return result.toString();
  }

  static String? _makeFragment(String? fragment, int start, int end) {
    if (fragment == null) return null;
    return _normalizeOrSubstring(
      fragment,
      start,
      end,
      _queryCharMask,
      escapeDelimiters: true,
    );
  }

  static String? _normalizeEscape(String source, int index, bool lowerCase) {
    assert(source.codeUnitAt(index) == _PERCENT);
    if (index + 2 >= source.length) {
      return "%"; // Marks the escape as invalid.
    }
    int firstDigit = source.codeUnitAt(index + 1);
    int secondDigit = source.codeUnitAt(index + 2);
    int firstDigitValue = hexDigitValue(firstDigit);
    int secondDigitValue = hexDigitValue(secondDigit);
    if (firstDigitValue < 0 || secondDigitValue < 0) {
      return "%"; // Marks the escape as invalid.
    }
    int value = firstDigitValue * 16 + secondDigitValue;
    if (_isUnreservedChar(value)) {
      if (lowerCase && _UPPER_CASE_A <= value && _UPPER_CASE_Z >= value) {
        value |= 0x20;
      }
      return String.fromCharCode(value);
    }
    if (firstDigit >= _LOWER_CASE_A || secondDigit >= _LOWER_CASE_A) {
      return source.substring(index, index + 3).toUpperCase();
    }
    return null;
  }

  static String _escapeChar(int char) {
    assert(char <= 0x10ffff); // It's a valid unicode code point.
    List<int> codeUnits;
    if (char <= 0x7f) {
      codeUnits = _Uint8List(3);
      codeUnits[0] = _PERCENT;
      codeUnits[1] = _hexDigits.codeUnitAt(char >> 4);
      codeUnits[2] = _hexDigits.codeUnitAt(char & 0xf);
    } else {
      int flag = 0xc0; // The high-bit markers on the first byte of UTF-8.
      int encodedBytes = 2;
      if (char > 0x7ff) {
        flag = 0xe0;
        encodedBytes = 3;
        if (char > 0xffff) {
          encodedBytes = 4;
          flag = 0xf0;
        }
      }
      codeUnits = _Uint8List(3 * encodedBytes);
      int index = 0;
      while (--encodedBytes >= 0) {
        int byte = ((char >> (6 * encodedBytes)) & 0x3f) | flag;
        codeUnits[index] = _PERCENT;
        codeUnits[index + 1] = _hexDigits.codeUnitAt(byte >> 4);
        codeUnits[index + 2] = _hexDigits.codeUnitAt(byte & 0xf);
        index += 3;
        flag = 0x80; // Following bytes have only high bit set.
      }
    }
    return String.fromCharCodes(codeUnits);
  }

  static String _normalizeOrSubstring(
    String component,
    int start,
    int end,
    int charMask, {
    bool escapeDelimiters = false,
    bool replaceBackslash = false,
  }) {
    return _normalize(
          component,
          start,
          end,
          charMask,
          escapeDelimiters: escapeDelimiters,
          replaceBackslash: replaceBackslash,
        ) ??
        component.substring(start, end);
  }

  static String? _normalize(
    String component,
    int start,
    int end,
    int charMask, {
    bool escapeDelimiters = false,
    bool replaceBackslash = false,
  }) {
    StringBuffer? buffer;
    int sectionStart = start;
    int index = start;
    while (index < end) {
      int char = component.codeUnitAt(index);
      if (char < 127 && (_charTables.codeUnitAt(char) & charMask) != 0) {
        index++;
      } else {
        String? replacement;
        int sourceLength;
        if (char == _PERCENT) {
          replacement = _normalizeEscape(component, index, false);
          if (replacement == null) {
            index += 3;
            continue;
          }
          if ("%" == replacement) {
            replacement = "%25";
            sourceLength = 1;
          } else {
            sourceLength = 3;
          }
        } else if (char == _BACKSLASH && replaceBackslash) {
          replacement = "/";
          sourceLength = 1;
        } else if (!escapeDelimiters && _isGeneralDelimiter(char)) {
          _fail(component, index, "Invalid character");
          throw "unreachable"; // TODO(lrn): Remove when Never-returning functions are recognized as throwing.
        } else {
          sourceLength = 1;
          if ((char & 0xFC00) == 0xD800) {
            if (index + 1 < end) {
              int tail = component.codeUnitAt(index + 1);
              if ((tail & 0xFC00) == 0xDC00) {
                sourceLength = 2;
                char = 0x10000 + ((char & 0x3ff) << 10) + (tail & 0x3ff);
              }
            }
          }
          replacement = _escapeChar(char);
        }
        (buffer ??= StringBuffer())
          ..write(component.substring(sectionStart, index))
          ..write(replacement);
        index += sourceLength;
        sectionStart = index;
      }
    }
    if (buffer == null) {
      return null;
    }
    if (sectionStart < end) {
      buffer.write(component.substring(sectionStart, end));
    }
    return buffer.toString();
  }

  static bool _isSchemeCharacter(int char) {
    return char < 128 && ((_charTables.codeUnitAt(char) & _schemeMask) != 0);
  }

  static bool _isGeneralDelimiter(int char) {
    return char <= _RIGHT_BRACKET &&
        ((_charTables.codeUnitAt(char) & _genDelimitersMask) != 0);
  }

  bool get isAbsolute => scheme != "" && fragment == "";

  String _mergePaths(String base, String reference) {
    int backCount = 0;
    int refStart = 0;
    while (reference.startsWith("../", refStart)) {
      refStart += 3;
      backCount++;
    }

    int baseEnd = base.lastIndexOf('/');
    while (baseEnd > 0 && backCount > 0) {
      int newEnd = base.lastIndexOf('/', baseEnd - 1);
      if (newEnd < 0) {
        break;
      }
      int delta = baseEnd - newEnd;
      if ((delta == 2 || delta == 3) &&
          base.codeUnitAt(newEnd + 1) == _DOT &&
          (delta == 2 || base.codeUnitAt(newEnd + 2) == _DOT)) {
        break;
      }
      baseEnd = newEnd;
      backCount--;
    }
    return base.replaceRange(
      baseEnd + 1,
      null,
      reference.substring(refStart - 3 * backCount),
    );
  }

  static bool _mayContainDotSegments(String path) {
    if (path.startsWith('.')) return true;
    int index = path.indexOf("/.");
    return index != -1;
  }

  static String _removeDotSegments(String path) {
    if (!_mayContainDotSegments(path)) return path;
    assert(path.isNotEmpty); // An empty path would not have dot segments.
    List<String> output = [];
    bool appendSlash = false;
    for (String segment in path.split("/")) {
      appendSlash = false;
      if (segment == "..") {
        if (output.isNotEmpty) {
          output.removeLast();
          if (output.isEmpty) {
            output.add("");
          }
        }
        appendSlash = true;
      } else if ("." == segment) {
        appendSlash = true;
      } else {
        output.add(segment);
      }
    }
    if (appendSlash) output.add("");
    return output.join("/");
  }

  static String _normalizeRelativePath(String path, bool allowScheme) {
    assert(!path.startsWith('/')); // Only get called with relative paths.
    if (!_mayContainDotSegments(path)) {
      if (!allowScheme) path = _escapeScheme(path);
      return path;
    }
    assert(path.isNotEmpty); // An empty path would not have dot segments.
    List<String> output = [];
    bool appendSlash = false;
    for (String segment in path.split("/")) {
      if (".." == segment) {
        appendSlash = true;
        if (!output.isEmpty && output.last != "..") {
          output.removeLast();
        } else {
          output.add(".."); // The result can have a number of _leading_ ${'`'}..${'`'}s.
        }
      } else if ("." == segment) {
        appendSlash = true;
      } else {
        appendSlash = false;
        if (segment.isEmpty && output.isEmpty) {
          segment = './';
        }
        output.add(segment);
      }
    }
    if (output.isEmpty) {
      return "./";
    }
    assert(!output.first.isEmpty); // Would be ${'`'}./${'`'} instead.
    if (appendSlash) output.add("");
    if (!allowScheme) output[0] = _escapeScheme(output[0]);
    var result = output.join("/");
    return result;
  }

  static String _escapeScheme(String path) {
    if (path.length >= 2 && _isAlphabeticCharacter(path.codeUnitAt(0))) {
      for (int i = 1; i < path.length; i++) {
        int char = path.codeUnitAt(i);
        if (char == _COLON) {
          return "${'${'}path.substring(0, i)}%3A${'${'}path.substring(i + 1)}";
        }
        if (char > 127 || ((_charTables.codeUnitAt(char) & _schemeMask) == 0)) {
          break;
        }
      }
    }
    return path;
  }

  Uri resolve(String reference) {
    return resolveUri(Uri.parse(reference));
  }

  static int _packageNameEnd(Uri uri, String path) {
    if (uri.isScheme("package") && !uri.hasAuthority) {
      return _skipPackageNameChars(path, 0, path.length);
    }
    return -1;
  }

  Uri resolveUri(Uri reference) {
    String targetScheme;
    String targetUserInfo = "";
    String? targetHost;
    int? targetPort;
    String targetPath;
    String? targetQuery;
    const int atStart =
            0, // Nothing taken from this URI.
        afterScheme =
            1, // Scheme comes from this URI.
        afterAuthority =
            2, // Scheme and authority comes from this URI.
        afterPath =
            3, // The path, and everything before, is from this URI.
        afterQuery = 4; // Everything except fragment is from this URI.
    int split = atStart;

    if (reference.scheme.isNotEmpty) {
      if (reference is _PlatformUri) return reference;
      targetScheme = reference.scheme;
      if (reference.hasAuthority) {
        targetUserInfo = reference.userInfo;
        targetHost = reference.host;
        targetPort = reference.hasPort ? reference.port : null;
      }
      targetPath = _removeDotSegments(reference.path);
      if (reference.hasQuery) {
        targetQuery = reference.query;
      }
    } else {
      targetScheme = this.scheme;
      if (reference.hasAuthority) {
        if (reference is _PlatformUri) {
          return reference.replace(scheme: targetScheme);
        }
        targetUserInfo = reference.userInfo;
        targetHost = reference.host;
        targetPort = _makePort(
          reference.hasPort ? reference.port : null,
          targetScheme,
        );
        targetPath = _removeDotSegments(reference.path);
        if (reference.hasQuery) targetQuery = reference.query;
        split = afterScheme;
      } else {
        targetUserInfo = this._userInfo;
        targetHost = this._host;
        targetPort = this._port;
        if (reference.hasEmptyPath) {
          targetPath = this.path;
          if (reference.hasQuery) {
            split = afterPath;
            targetQuery = reference.query;
          } else {
            targetQuery = this._query;
            split = afterQuery;
          }
        } else {
          String basePath = this.path;
          int packageNameEnd = _packageNameEnd(this, basePath);
          split = afterAuthority;
          if (packageNameEnd > 0) {
            assert(targetScheme == "package");
            assert(!this.hasAuthority);
            assert(!this.hasEmptyPath);
            String packageName = basePath.substring(0, packageNameEnd);
            if (reference.hasAbsolutePath) {
              targetPath = packageName + _removeDotSegments(reference.path);
            } else {
              targetPath =
                  packageName +
                  _removeDotSegments(
                    _mergePaths(
                      basePath.substring(packageName.length),
                      reference.path,
                    ),
                  );
            }
          } else if (reference.hasAbsolutePath) {
            targetPath = _removeDotSegments(reference.path);
          } else {
            if (this.hasEmptyPath) {
              if (!this.hasAuthority) {
                if (!this.hasScheme) {
                  targetPath = reference.path;
                } else {
                  targetPath = _removeDotSegments(reference.path);
                }
              } else {
                targetPath = _removeDotSegments("/" + reference.path);
              }
            } else {
              var mergedPath = _mergePaths(this.path, reference.path);
              if (this.hasScheme || this.hasAuthority || this.hasAbsolutePath) {
                targetPath = _removeDotSegments(mergedPath);
              } else {
                targetPath = _normalizeRelativePath(
                  mergedPath,
                  this.hasScheme || this.hasAuthority,
                );
              }
            }
          }
          if (reference.hasQuery) {
            targetQuery = reference.query;
          }
        }
      }
    }
    String? fragment = reference.hasFragment ? reference.fragment : null;
    if (reference is! _PlatformUri) {
      if (split == atStart) {
        targetScheme = _makeScheme(targetScheme, 0, targetScheme.length);
      }
      if (split <= afterScheme) {
        if (targetUserInfo.isNotEmpty) {
          targetUserInfo = _makeUserInfo(
            targetUserInfo,
            0,
            targetUserInfo.length,
          );
        }
        if (targetPort != null) {
          targetPort = _makePort(targetPort, targetScheme);
        }
        if (targetHost != null && targetHost.isNotEmpty) {
          targetHost = _makeHost(targetHost, 0, targetHost.length, false);
        }
      }
      if (split <= afterPath) {
        targetPath = _makePath(
          targetPath,
          0,
          targetPath.length,
          null,
          targetScheme,
          targetHost != null,
        );
      }
      if (split <= afterPath && targetQuery != null) {
        targetQuery = _makeQuery(targetQuery, 0, targetQuery.length, null);
      }
      if (fragment != null) {
        fragment = _makeFragment(fragment, 0, fragment.length);
      }
    }
    return _Uri._internal(
      targetScheme,
      targetUserInfo,
      targetHost,
      targetPort,
      targetPath,
      targetQuery,
      fragment,
    );
  }

  bool get hasScheme => scheme.isNotEmpty;

  bool get hasAuthority => _host != null;

  bool get hasPort => _port != null;

  bool get hasQuery => _query != null;

  bool get hasFragment => _fragment != null;

  bool get hasEmptyPath => path.isEmpty;

  bool get hasAbsolutePath => path.startsWith('/');

  String get origin {
    if (scheme == "") {
      throw StateError("Cannot use origin without a scheme: $this");
    }
    if (scheme != "http" && scheme != "https") {
      throw StateError(
        "Origin is only applicable schemes http and https: $this",
      );
    }
    String? host = _host;
    if (host == null || host == "") {
      throw StateError(
        "A $scheme: URI should have a non-empty host name: $this",
      );
    }
    int? port = _port;
    if (port == null) return "$scheme://$host";
    return "$scheme://$host:$port";
  }

  String toFilePath({bool? windows}) {
    if (scheme != "" && scheme != "file") {
      throw UnsupportedError("Cannot extract a file path from a $scheme URI");
    }
    if (query != "") {
      throw UnsupportedError(
        "Cannot extract a file path from a URI with a query component",
      );
    }
    if (fragment != "") {
      throw UnsupportedError(
        "Cannot extract a file path from a URI with a fragment component",
      );
    }
    return (windows ?? _isWindows) ? _toWindowsFilePath(this) : _toFilePath();
  }

  String _toFilePath() {
    if (hasAuthority && host != "") {
      throw UnsupportedError(
        "Cannot extract a non-Windows file path from a file URI "
        "with an authority",
      );
    }
    var pathSegments = this.pathSegments;
    _checkNonWindowsPathReservedCharacters(pathSegments, false);
    var result = StringBuffer();
    if (hasAbsolutePath) result.write("/");
    result.writeAll(pathSegments, "/");
    return result.toString();
  }

  static String _toWindowsFilePath(Uri uri) {
    bool hasDriveLetter = false;
    var segments = uri.pathSegments;
    if (segments.length > 0 &&
        segments[0].length == 2 &&
        segments[0].codeUnitAt(1) == _COLON) {
      _checkWindowsDriveLetter(segments[0].codeUnitAt(0), false);
      _checkWindowsPathReservedCharacters(segments, false, 1);
      hasDriveLetter = true;
    } else {
      _checkWindowsPathReservedCharacters(segments, false, 0);
    }
    var result = StringBuffer();
    if (uri.hasAbsolutePath && !hasDriveLetter) result.write(r"\");
    if (uri.hasAuthority) {
      var host = uri.host;
      if (host.isNotEmpty) {
        result.write(r"\");
        result.write(host);
        result.write(r"\");
      }
    }
    result.writeAll(segments, r"\");
    if (hasDriveLetter && segments.length == 1) result.write(r"\");
    return result.toString();
  }

  void _writeAuthority(StringSink ss) {
    if (_userInfo.isNotEmpty) {
      ss.write(_userInfo);
      ss.write("@");
    }
    if (_host != null) ss.write(_host);
    if (_port != null) {
      ss.write(":");
      ss.write(_port);
    }
  }

  UriData? get data => (scheme == "data") ? UriData.fromUri(this) : null;

  String toString() => _text;

  String _initializeText() {
    StringBuffer sb = StringBuffer();
    if (scheme.isNotEmpty)
      sb
        ..write(scheme)
        ..write(":");
    if (hasAuthority || (scheme == "file")) {
      sb.write("//");
      _writeAuthority(sb);
    }
    sb.write(path);
    if (_query != null)
      sb
        ..write("?")
        ..write(_query);
    if (_fragment != null)
      sb
        ..write("#")
        ..write(_fragment);
    return sb.toString();
  }

  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Uri &&
        scheme == other.scheme &&
        hasAuthority == other.hasAuthority &&
        userInfo == other.userInfo &&
        host == other.host &&
        port == other.port &&
        path == other.path &&
        hasQuery == other.hasQuery &&
        query == other.query &&
        hasFragment == other.hasFragment &&
        fragment == other.fragment;
  }

  static List<String> _createList() => <String>[];

  static Map<String, List<String>> _splitQueryStringAll(
    String query, {
    Encoding encoding = utf8,
  }) {
    var result = <String, List<String>>{};
    int i = 0;
    int start = 0;
    int equalsIndex = -1;

    void parsePair(int start, int equalsIndex, int end) {
      String key;
      String value;
      if (start == end) return;
      if (equalsIndex < 0) {
        key = _uriDecode(query, start, end, encoding, true);
        value = "";
      } else {
        key = _uriDecode(query, start, equalsIndex, encoding, true);
        value = _uriDecode(query, equalsIndex + 1, end, encoding, true);
      }
      result.putIfAbsent(key, _createList).add(value);
    }

    while (i < query.length) {
      int char = query.codeUnitAt(i);
      if (char == _EQUALS) {
        if (equalsIndex < 0) equalsIndex = i;
      } else if (char == _AMPERSAND) {
        parsePair(start, equalsIndex, i);
        start = i + 1;
        equalsIndex = -1;
      }
      i++;
    }
    parsePair(start, equalsIndex, i);
    return result;
  }

  static String _uriEncode(
    int canonicalMask,
    String text,
    Encoding encoding,
    bool spaceToPlus,
  ) {
    int i = 0;
    if (identical(encoding, utf8) ||
        identical(encoding, latin1) ||
        identical(encoding, ascii)) {
      for (; i < text.length; i++) {
        var char = text.codeUnitAt(i);
        if (char >= 128 || _charTables.codeUnitAt(char) & canonicalMask == 0) {
          break;
        }
      }
    }
    if (i == text.length) return text;

    StringBuffer result = StringBuffer();
    for (int j = 0; j < i; j++) {
      result.writeCharCode(text.codeUnitAt(j));
    }

    var bytes = encoding.encode(text);
    for (; i < bytes.length; i++) {
      int byte = bytes[i];
      if (byte < 128 && ((_charTables.codeUnitAt(byte) & canonicalMask) != 0)) {
        result.writeCharCode(byte);
      } else if (spaceToPlus && byte == _SPACE) {
        result.writeCharCode(_PLUS);
      } else {
        const String hexDigits = '0123456789ABCDEF';
        result
          ..writeCharCode(_PERCENT)
          ..writeCharCode(hexDigits.codeUnitAt(byte >> 4))
          ..writeCharCode(hexDigits.codeUnitAt(byte & 0x0f));
      }
    }
    return result.toString();
  }

  static int _hexCharPairToByte(String s, int pos) {
    int byte = 0;
    for (int i = 0; i < 2; i++) {
      var charCode = s.codeUnitAt(pos + i);
      if (0x30 <= charCode && charCode <= 0x39) {
        byte = byte * 16 + charCode - 0x30;
      } else {
        charCode |= 0x20;
        if (0x61 <= charCode && charCode <= 0x66) {
          byte = byte * 16 + charCode - 0x57;
        } else {
          throw ArgumentError("Invalid URL encoding");
        }
      }
    }
    return byte;
  }

  static String _uriDecode(
    String text,
    int start,
    int end,
    Encoding encoding,
    bool plusToSpace,
  ) {
    assert(0 <= start);
    assert(start <= end);
    assert(end <= text.length);
    bool simple = true;
    for (int i = start; i < end; i++) {
      var codeUnit = text.codeUnitAt(i);
      if (codeUnit > 127 ||
          codeUnit == _PERCENT ||
          (plusToSpace && codeUnit == _PLUS)) {
        simple = false;
        break;
      }
    }
    List<int> bytes;
    if (simple) {
      if (utf8 == encoding || latin1 == encoding || ascii == encoding) {
        return text.substring(start, end);
      } else {
        bytes = text.substring(start, end).codeUnits;
      }
    } else {
      bytes = <int>[];
      for (int i = start; i < end; i++) {
        var codeUnit = text.codeUnitAt(i);
        if (codeUnit > 127) {
          throw ArgumentError("Illegal percent encoding in URI");
        }
        if (codeUnit == _PERCENT) {
          if (i + 3 > text.length) {
            throw ArgumentError('Truncated URI');
          }
          bytes.add(_hexCharPairToByte(text, i + 1));
          i += 2;
        } else if (plusToSpace && codeUnit == _PLUS) {
          bytes.add(_SPACE);
        } else {
          bytes.add(codeUnit);
        }
      }
    }
    return encoding.decode(bytes);
  }

  static bool _isAlphabeticCharacter(int codeUnit) {
    var lowerCase = codeUnit | 0x20;
    return (_LOWER_CASE_A <= lowerCase && lowerCase <= _LOWER_CASE_Z);
  }

  static bool _isUnreservedChar(int char) {
    return char < 127 &&
        ((_charTables.codeUnitAt(char) & _unreservedMask) != 0);
  }
}

final class UriData {
  static const int _noScheme = -1;

  final String _text;

  final List<int> _separatorIndices;

  Uri? _uriCache;

  UriData._(this._text, this._separatorIndices, this._uriCache);

  static const Base64Codec _base64 = base64;

  factory UriData.fromString(
    String content, {
    String? mimeType,
    Encoding? encoding,
    Map<String, String>? parameters,
    bool base64 = false,
  }) {
    StringBuffer buffer = StringBuffer();
    List<int> indices = [_noScheme];
    String? charsetName = parameters?["charset"];
    String? encodingName;
    if (encoding == null) {
      if (charsetName != null) {
        encoding = Encoding.getByName(charsetName);
      }
    } else if (charsetName == null) {
      encodingName = encoding.name;
    }
    encoding ??= ascii;
    _writeUri(mimeType, encodingName, parameters, buffer, indices);
    indices.add(buffer.length);
    if (base64) {
      buffer.write(';base64,');
      indices.add(buffer.length - 1);
      buffer.write(encoding.fuse(_base64).encode(content));
    } else {
      buffer.write(',');
      _uriEncodeBytes(_uricMask, encoding.encode(content), buffer);
    }
    return UriData._(buffer.toString(), indices, null);
  }

  factory UriData.fromBytes(
    List<int> bytes, {
    String mimeType = "application/octet-stream",
    Map<String, String>? parameters,
    bool percentEncoded = false,
  }) {
    StringBuffer buffer = StringBuffer();
    List<int> indices = [_noScheme];
    _writeUri(mimeType, null, parameters, buffer, indices);
    indices.add(buffer.length);
    if (percentEncoded) {
      buffer.write(',');
      _uriEncodeBytes(_uricMask, bytes, buffer);
    } else {
      buffer.write(';base64,');
      indices.add(buffer.length - 1);
      buffer.write(_base64.encoder.convert(bytes));
    }

    return UriData._(buffer.toString(), indices, null);
  }

  factory UriData.fromUri(Uri uri) {
    if (!uri.isScheme("data")) {
      throw ArgumentError.value(uri, "uri", "Scheme must be 'data'");
    }
    if (uri.hasAuthority) {
      throw ArgumentError.value(uri, "uri", "Data uri must not have authority");
    }
    if (uri.hasFragment) {
      throw ArgumentError.value(
        uri,
        "uri",
        "Data uri must not have a fragment part",
      );
    }
    if (!uri.hasQuery) {
      return _parse(uri.path, 0, uri);
    }
    return _parse(uri.toString(), 5, uri);
  }

  static void _writeUri(
    String? mimeType,
    String? charsetName,
    Map<String, String>? parameters,
    StringBuffer buffer,
    List<int>? indices,
  ) {
    if (mimeType == null || _caseInsensitiveEquals("text/plain", mimeType)) {
      mimeType = "";
    }

    if (mimeType.isEmpty || identical(mimeType, "application/octet-stream")) {
      buffer.write(mimeType); // Common cases need no escaping.
    } else {
      int slashIndex = _validateMimeType(mimeType);
      if (slashIndex < 0) {
        throw ArgumentError.value(mimeType, "mimeType", "Invalid MIME type");
      }
      buffer.write(
        _Uri._uriEncode(
          _tokenCharMask,
          mimeType.substring(0, slashIndex),
          utf8,
          false,
        ),
      );
      buffer.write("/");
      buffer.write(
        _Uri._uriEncode(
          _tokenCharMask,
          mimeType.substring(slashIndex + 1),
          utf8,
          false,
        ),
      );
    }
    if (charsetName != null) {
      indices
        ?..add(buffer.length)
        ..add(buffer.length + 8);
      buffer.write(";charset=");
      buffer.write(_Uri._uriEncode(_tokenCharMask, charsetName, utf8, false));
    }
    parameters?.forEach((key, value) {
      if (key.isEmpty) {
        throw ArgumentError.value("", "Parameter names must not be empty");
      }
      if (value.isEmpty) {
        throw ArgumentError.value(
          "",
          "Parameter values must not be empty",
          'parameters["$key"]',
        );
      }
      indices?.add(buffer.length);
      buffer.write(';');
      buffer.write(_Uri._uriEncode(_tokenCharMask, key, utf8, false));
      indices?.add(buffer.length);
      buffer.write('=');
      buffer.write(_Uri._uriEncode(_tokenCharMask, value, utf8, false));
    });
  }

  static int _validateMimeType(String mimeType) {
    int slashIndex = -1;
    for (int i = 0; i < mimeType.length; i++) {
      var char = mimeType.codeUnitAt(i);
      if (char != _SLASH) continue;
      if (slashIndex < 0) {
        slashIndex = i;
        continue;
      }
      return -1;
    }
    return slashIndex;
  }

  static UriData parse(String uri) {
    if (uri.length >= 5) {
      int dataDelta = _startsWithData(uri, 0);
      if (dataDelta == 0) {
        return _parse(uri, 5, null);
      }
      if (dataDelta == 0x20) {
        return _parse(uri.substring(5), 0, null);
      }
    }
    throw FormatException("Does not start with 'data:'", uri, 0);
  }

  Uri get uri {
    return _uriCache ??= _computeUri();
  }

  Uri _computeUri() {
    String path = _text;
    String? query;
    int colonIndex = _separatorIndices[0];
    int queryIndex = _text.indexOf('?', colonIndex + 1);
    int end = _text.length;
    if (queryIndex >= 0) {
      query = _Uri._normalizeOrSubstring(
        _text,
        queryIndex + 1,
        end,
        _queryCharMask,
      );
      end = queryIndex;
    }
    path = _Uri._normalizeOrSubstring(
      _text,
      colonIndex + 1,
      end,
      _pathCharOrSlashMask,
    );
    return _DataUri(this, path, query);
  }

  String get mimeType {
    int start = _separatorIndices[0] + 1;
    int end = _separatorIndices[1];
    if (start == end) return "text/plain";
    return _Uri._uriDecode(_text, start, end, utf8, false);
  }

  bool isMimeType(String mimeType) {
    int start = _separatorIndices[0] + 1;
    int end = _separatorIndices[1];
    if (start == end) {
      return mimeType.isEmpty ||
          identical(mimeType, "text/plain") ||
          _caseInsensitiveEquals(mimeType, "text/plain");
    }
    if (mimeType.isEmpty) mimeType = "text/plain";
    return (mimeType.length == end - start) &&
        _caseInsensitiveStartsWith(mimeType, _text, start);
  }

  String get charset {
    var charsetIndex = _findCharsetIndex();
    if (charsetIndex >= 0) {
      var valueStart = _separatorIndices[charsetIndex + 1] + 1;
      var valueEnd = _separatorIndices[charsetIndex + 2];
      return _Uri._uriDecode(_text, valueStart, valueEnd, utf8, false);
    }
    return "US-ASCII";
  }

  int _findCharsetIndex() {
    var separatorIndices = _separatorIndices;
    for (int i = 3; i <= separatorIndices.length; i += 2) {
      var keyStart = separatorIndices[i - 2] + 1;
      var keyEnd = separatorIndices[i - 1];
      if (keyEnd == keyStart + "charset".length &&
          _caseInsensitiveStartsWith("charset", _text, keyStart)) {
        return i - 2;
      }
    }
    return -1;
  }

  bool isCharset(String charset) {
    var charsetIndex = _findCharsetIndex();
    if (charsetIndex < 0) {
      return charset.isEmpty ||
          _caseInsensitiveEquals(charset, "US-ASCII") ||
          identical(Encoding.getByName(charset), ascii);
    }
    if (charset.isEmpty) charset = "US-ASCII";
    var valueStart = _separatorIndices[charsetIndex + 1] + 1;
    var valueEnd = _separatorIndices[charsetIndex + 2];
    var length = valueEnd - valueStart;
    if (charset.length == length &&
        _caseInsensitiveStartsWith(charset, _text, valueStart)) {
      return true;
    }
    var checkedEncoding = Encoding.getByName(charset);
    return checkedEncoding != null &&
        identical(
          checkedEncoding,
          Encoding.getByName(
            _Uri._uriDecode(_text, valueStart, valueEnd, utf8, false),
          ),
        );
  }

  bool isEncoding(Encoding encoding) {
    var charsetIndex = _findCharsetIndex();
    if (charsetIndex < 0) {
      return identical(encoding, ascii);
    }
    var valueStart = _separatorIndices[charsetIndex + 1] + 1;
    var valueEnd = _separatorIndices[charsetIndex + 2];
    return identical(
      encoding,
      Encoding.getByName(
        _Uri._uriDecode(_text, valueStart, valueEnd, utf8, false),
      ),
    );
  }

  bool get isBase64 => _separatorIndices.length.isOdd;

  String get contentText => _text.substring(_separatorIndices.last + 1);

  _Uint8List contentAsBytes() {
    String text = _text;
    int start = _separatorIndices.last + 1;
    if (isBase64) {
      return base64.decoder.convert(text, start);
    }

    const int percent = 0x25;
    int length = text.length - start;
    for (int i = start; i < text.length; i++) {
      var codeUnit = text.codeUnitAt(i);
      if (codeUnit == percent) {
        i += 2;
        length -= 2;
      }
    }
    _Uint8List result = _Uint8List(length);
    if (length == text.length) {
      result.setRange(0, length, text.codeUnits, start);
      return result;
    }
    int index = 0;
    for (int i = start; i < text.length; i++) {
      var codeUnit = text.codeUnitAt(i);
      if (codeUnit != percent) {
        result[index++] = codeUnit;
      } else {
        if (i + 2 < text.length) {
          int byte = parseHexByte(text, i + 1);
          if (byte >= 0) {
            result[index++] = byte;
            i += 2;
            continue;
          }
        }
        throw FormatException("Invalid percent escape", text, i);
      }
    }
    assert(index == result.length);
    return result;
  }

  String contentAsString({Encoding? encoding}) {
    if (encoding == null) {
      var charset = this.charset; // Returns "US-ASCII" if not present.
      encoding = Encoding.getByName(charset);
      if (encoding == null) {
        throw UnsupportedError("Unknown charset: $charset");
      }
    }
    String text = _text;
    int start = _separatorIndices.last + 1;
    if (isBase64) {
      var converter = base64.decoder.fuse(encoding.decoder);
      return converter.convert(text.substring(start));
    }
    return _Uri._uriDecode(text, start, text.length, encoding, false);
  }

  Map<String, String> get parameters {
    var result = <String, String>{};
    for (int i = 3; i < _separatorIndices.length; i += 2) {
      var start = _separatorIndices[i - 2] + 1;
      var equals = _separatorIndices[i - 1];
      var end = _separatorIndices[i];
      String key = _Uri._uriDecode(_text, start, equals, utf8, false);
      String value = _Uri._uriDecode(_text, equals + 1, end, utf8, false);
      result[key] = value;
    }
    return result;
  }

  static UriData _parse(String text, int start, Uri? sourceUri) {
    assert(start == 0 || start == 5);
    assert((start == 5) == text.startsWith("data:"));

    const int comma = 0x2c;
    const int slash = 0x2f;
    const int semicolon = 0x3b;
    const int equals = 0x3d;
    List<int> indices = [start - 1];
    int slashIndex = -1;
    var char;
    int i = start;
    for (; i < text.length; i++) {
      char = text.codeUnitAt(i);
      if (char == comma || char == semicolon) break;
      if (char == slash) {
        if (slashIndex < 0) {
          slashIndex = i;
          continue;
        }
        throw FormatException("Invalid MIME type", text, i);
      }
    }
    if (slashIndex < 0 && i > start) {
      throw FormatException("Invalid MIME type", text, i);
    }
    while (char != comma) {
      indices.add(i);
      i++;
      int equalsIndex = -1;
      for (; i < text.length; i++) {
        char = text.codeUnitAt(i);
        if (char == equals) {
          if (equalsIndex < 0) equalsIndex = i;
        } else if (char == semicolon || char == comma) {
          break;
        }
      }
      if (equalsIndex >= 0) {
        indices.add(equalsIndex);
      } else {
        var lastSeparator = indices.last;
        if (char != comma ||
            i != lastSeparator + 7 /* "base64,".length */ ||
            !text.startsWith("base64", lastSeparator + 1)) {
          throw FormatException("Expecting '='", text, i);
        }
        break;
      }
    }
    indices.add(i);
    bool isBase64 = indices.length.isOdd;
    if (isBase64) {
      text = base64.normalize(text, i + 1, text.length);
    } else {
      var data = _Uri._normalize(
        text,
        i + 1,
        text.length,
        _uricMask,
        escapeDelimiters: true,
      );
      if (data != null) {
        text = text.replaceRange(i + 1, text.length, data);
      }
    }
    return UriData._(text, indices, sourceUri);
  }

  static void _uriEncodeBytes(
    int canonicalMask,
    List<int> bytes,
    StringSink buffer,
  ) {
    int byteOr = 0;
    for (int i = 0; i < bytes.length; i++) {
      int byte = bytes[i];
      byteOr |= byte;
      if (byte < 128 && ((_charTables.codeUnitAt(byte) & canonicalMask) != 0)) {
        buffer.writeCharCode(byte);
      } else {
        buffer.writeCharCode(_PERCENT);
        buffer.writeCharCode(_hexDigits.codeUnitAt(byte >> 4));
        buffer.writeCharCode(_hexDigits.codeUnitAt(byte & 0x0f));
      }
    }
    if ((byteOr & ~0xFF) != 0) {
      for (int i = 0; i < bytes.length; i++) {
        var byte = bytes[i];
        if (byte < 0 || byte > 255) {
          throw ArgumentError.value(byte, "non-byte value");
        }
      }
    }
  }

  String toString() =>
      (_separatorIndices[0] == _noScheme) ? "data:$_text" : _text;
}

const int _schemeEndIndex = 1;

const int _hostStartIndex = 2;

const int _portStartIndex = 3;

const int _pathStartIndex = 4;

const int _queryStartIndex = 5;

const int _fragmentStartIndex = 6;

const int _notSimpleIndex = 7;

const int _uriStart = 0;

const int _nonSimpleEndStates = 14;

const int _schemeStart = 20;

const String _scannerTables =
    "\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1\xE1\xE1"
    "\x01\xE1\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1\xE3\xE1\xE1\x01\xE1\x01"
    "\xE1\xCD\x01\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x0E\x03\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x22\x01\xE1\x01\xE1\xAC\xE1\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\xE1\xE1\xE1\x01\xE1\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1"
    "\xEA\xE1\xE1\x01\xE1\x01\xE1\xCD\x01\xE1\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x0A\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x22\x01\xE1\x01\xE1\xAC"
    "\xEB\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B"
    "\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\xEB\xEB\xEB\x8B\xEB\xEB\x8B\x8B\x8B"
    "\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B"
    "\x8B\x8B\x8B\x8B\x8B\xEB\x83\xEB\xEB\x8B\xEB\x8B\xEB\xCD\x8B\xEB\x8B\x8B"
    "\x8B\x8B\x8B\x8B\x8B\x8B\x92\x83\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B\x8B"
    "\xEB\x8B\xEB\x8B\xEB\xAC\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEB\xEB"
    "\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x44\xEB\xEB\x0B\xEB\x0B"
    "\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x12\x44\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC\xE5\x05\x05\x05\x05\x05"
    "\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05"
    "\x05\x05\x05\xE5\xE5\xE5\x05\xE5\x44\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5"
    "\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE8"
    "\x8A\xE5\xE5\x05\xE5\x05\xE5\xCD\x05\xE5\x05\x05\x05\x05\x05\x05\x05\x05"
    "\x05\x8A\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x66\x05\xE5\x05\xE5\xAC"
    "\xE5\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05"
    "\x05\x05\x05\x05\x05\x05\x05\x05\x05\xE5\xE5\xE5\x05\xE5\x44\xE5\xE5\xE5"
    "\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5\xE5"
    "\xE5\xE5\xE5\xE5\xE5\xE5\x8A\xE5\xE5\x05\xE5\x05\xE5\xCD\x05\xE5\x05\x05"
    "\x05\x05\x05\x05\x05\x05\x05\x8A\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05"
    "\x66\x05\xE5\x05\xE5\xAC\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\x44\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\x8A\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xCD\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\x8A\xE7\x07\x07\x07"
    "\x07\x07\x07\x07\x07\x07\xE7\xE7\xE7\xE7\xE7\xAC\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\x44\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\x8A\xE7\xE7\xE7\xE7\xE7\xE7\xCD\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7\xE7"
    "\xE7\x8A\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\xE7\xE7\xE7\xE7\xE7\xAC"
    "\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08"
    "\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08"
    "\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08"
    "\x08\x08\x08\x08\x08\x08\x08\x05\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08"
    "\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08"
    "\x08\x08\x08\x08\x08\x08\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEB\xEB"
    "\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEA\xEB\xEB\x0B\xEB\x0B"
    "\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x10\xEA\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC\xEB\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\xEB\xEB\xEB\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB"
    "\xEA\xEB\xEB\x0B\xEB\x0B\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x12\x0A\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC"
    "\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEB\xEB\x0B\xEB\xEB\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\xEB\xEA\xEB\xEB\x0B\xEB\x0B\xEB\xCD\x0B\xEB\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0A\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\xEB\x0B\xEB\x0B\xEB\xAC\xEC\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C"
    "\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\xEC\xEC\xEC"
    "\x0C\xEC\xEC\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C"
    "\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\xEC\xEC\xEC\xEC\x0C\xEC\x0C"
    "\xEC\xCD\x0C\xEC\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\x0C\xEC\x0C\x0C\x0C\x0C"
    "\x0C\x0C\x0C\x0C\x0C\x0C\xEC\x0C\xEC\x0C\xEC\x0C\xED\x0D\x0D\x0D\x0D\x0D"
    "\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D"
    "\x0D\x0D\x0D\xED\xED\xED\x0D\xED\xED\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D"
    "\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\xED"
    "\xED\xED\xED\x0D\xED\x0D\xED\xED\x0D\xED\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D"
    "\x0D\xED\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\x0D\xED\x0D\xED\x0D\xED\x0D"
    "\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1\xE1\xE1\x01\xE1\xE1\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\xE1\xEA\xE1\xE1\x01\xE1\x01\xE1\xCD\x01\xE1\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x0F\xEA\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x22\x01\xE1\x01\xE1\xAC\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1\xE1\xE1"
    "\x01\xE1\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01\xE1\xE9\xE1\xE1\x01\xE1\x01"
    "\xE1\xCD\x01\xE1\x01\x01\x01\x01\x01\x01\x01\x01\x01\x09\x01\x01\x01\x01"
    "\x01\x01\x01\x01\x01\x01\x22\x01\xE1\x01\xE1\xAC\xEB\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\xEB\xEB\xEB\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB"
    "\xEA\xEB\xEB\x0B\xEB\x0B\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x11\xEA\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC"
    "\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEB\xEB\x0B\xEB\xEB\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\xEB\xE9\xEB\xEB\x0B\xEB\x0B\xEB\xCD\x0B\xEB\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x09\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\xEB\x0B\xEB\x0B\xEB\xAC\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEB\xEB"
    "\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\xEA\xEB\xEB\x0B\xEB\x0B"
    "\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x13\xEA\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC\xEB\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\xEB\xEB\xEB\x0B\xEB\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB"
    "\xEA\xEB\xEB\x0B\xEB\x0B\xEB\xCD\x0B\xEB\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B"
    "\x0B\xEA\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\x0B\xEB\x0B\xEB\x0B\xEB\xAC"
    "\xF5\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15"
    "\x15\x15\x15\x15\x15\x15\x15\x15\x15\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15"
    "\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\x15\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5"
    "\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\xF5\x15\xF5\x15\x15\xF5\x15\x15\x15\x15"
    "\x15\x15\x15\x15\x15\x15\xF5\xF5\xF5\xF5\xF5\xF5";

int _scan(String uri, int start, int end, int state, List<int> indices) {
  const int stateTableSize = 0x60;
  const int _charXor = 96;
  const int _xorCharLimit = 95;
  const int _invalidChar = 0x7F ^ _charXor;
  const int _writeIndexShift = 5;
  const int _stateMask = 31;

  assert(end <= uri.length);
  for (int i = start; i < end; i++) {
    int char = uri.codeUnitAt(i) ^ _charXor;
    if (char > _xorCharLimit) char = _invalidChar;
    int transition = _scannerTables.codeUnitAt(state * stateTableSize + char);
    state = transition & _stateMask;
    indices[transition >> _writeIndexShift] = i;
  }
  return state;
}

final class _SimpleUri implements _PlatformUri {
  final String _uri;
  final int _schemeEnd;
  final int _hostStart;
  final int _portStart;
  final int _pathStart;
  final int _queryStart;
  final int _fragmentStart;

  String? _schemeCache;
  int? _hashCodeCache;

  _SimpleUri(
    this._uri,
    this._schemeEnd,
    this._hostStart,
    this._portStart,
    this._pathStart,
    this._queryStart,
    this._fragmentStart,
    this._schemeCache,
  );

  bool get hasScheme => _schemeEnd > 0;
  bool get hasAuthority => _hostStart > 0;
  bool get hasUserInfo => _hostStart > _schemeEnd + 4;
  bool get hasPort => _hostStart > 0 && _portStart + 1 < _pathStart;
  bool get hasQuery => _queryStart < _fragmentStart;
  bool get hasFragment => _fragmentStart < _uri.length;

  bool get _isFile => _schemeEnd == 4 && _uri.startsWith("file");
  bool get _isHttp => _schemeEnd == 4 && _uri.startsWith("http");
  bool get _isHttps => _schemeEnd == 5 && _uri.startsWith("https");
  bool get _isPackage => _schemeEnd == 7 && _uri.startsWith("package");

  bool _isScheme(String scheme) =>
      _schemeEnd == scheme.length && _uri.startsWith(scheme);

  bool get hasAbsolutePath => _uri.startsWith("/", _pathStart);
  bool get hasEmptyPath => _pathStart == _queryStart;

  bool get isAbsolute => hasScheme && !hasFragment;

  bool isScheme(String scheme) {
    if (scheme == null || scheme.isEmpty) return _schemeEnd < 0;
    if (scheme.length != _schemeEnd) return false;
    return _caseInsensitiveStartsWith(scheme, _uri, 0);
  }

  String get scheme {
    return _schemeCache ??= _computeScheme();
  }

  String _computeScheme() {
    if (_schemeEnd <= 0) return "";
    if (_isHttp) return "http";
    if (_isHttps) return "https";
    if (_isFile) return "file";
    if (_isPackage) return "package";
    return _uri.substring(0, _schemeEnd);
  }

  String get authority =>
      _hostStart > 0 ? _uri.substring(_schemeEnd + 3, _pathStart) : "";
  String get userInfo => (_hostStart > _schemeEnd + 3)
      ? _uri.substring(_schemeEnd + 3, _hostStart - 1)
      : "";
  String get host =>
      _hostStart > 0 ? _uri.substring(_hostStart, _portStart) : "";
  int get port {
    if (hasPort) return int.parse(_uri.substring(_portStart + 1, _pathStart));
    if (_isHttp) return 80;
    if (_isHttps) return 443;
    return 0;
  }

  String get path => _uri.substring(_pathStart, _queryStart);
  String get query => (_queryStart < _fragmentStart)
      ? _uri.substring(_queryStart + 1, _fragmentStart)
      : "";
  String get fragment =>
      (_fragmentStart < _uri.length) ? _uri.substring(_fragmentStart + 1) : "";

  String get origin {
    bool isHttp = _isHttp;
    if (_schemeEnd < 0) {
      throw StateError("Cannot use origin without a scheme: $this");
    }
    if (!isHttp && !_isHttps) {
      throw StateError(
        "Origin is only applicable to schemes http and https: $this",
      );
    }
    if (_hostStart == _portStart) {
      throw StateError(
        "A $scheme: URI should have a non-empty host name: $this",
      );
    }
    if (_hostStart == _schemeEnd + 3) {
      return _uri.substring(0, _pathStart);
    }
    return _uri.substring(0, _schemeEnd + 3) +
        _uri.substring(_hostStart, _pathStart);
  }

  List<String> get pathSegments {
    int start = _pathStart;
    int end = _queryStart;
    if (_uri.startsWith("/", start)) start++;
    if (start == end) return const <String>[];
    List<String> parts = [];
    for (int i = start; i < end; i++) {
      var char = _uri.codeUnitAt(i);
      if (char == _SLASH) {
        parts.add(_uri.substring(start, i));
        start = i + 1;
      }
    }
    parts.add(_uri.substring(start, end));
    return List<String>.unmodifiable(parts);
  }

  Map<String, String> get queryParameters {
    if (!hasQuery) return const <String, String>{};
    return UnmodifiableMapView<String, String>(Uri.splitQueryString(query));
  }

  Map<String, List<String>> get queryParametersAll {
    if (!hasQuery) return const <String, List<String>>{};
    Map<String, List<String>> queryParameterLists = _Uri._splitQueryStringAll(
      query,
    );
    queryParameterLists.updateAll(_toUnmodifiableStringList);
    return Map<String, List<String>>.unmodifiable(queryParameterLists);
  }

  bool _isPort(String port) {
    int portDigitStart = _portStart + 1;
    return portDigitStart + port.length == _pathStart &&
        _uri.startsWith(port, portDigitStart);
  }

  Uri normalizePath() => this;

  Uri removeFragment() {
    if (!hasFragment) return this;
    return _SimpleUri(
      _uri.substring(0, _fragmentStart),
      _schemeEnd,
      _hostStart,
      _portStart,
      _pathStart,
      _queryStart,
      _fragmentStart,
      _schemeCache,
    );
  }

  Uri replace({
    String? scheme,
    String? userInfo,
    String? host,
    int? port,
    String? path,
    Iterable<String>? pathSegments,
    String? query,
    Map<String, dynamic /*String?|Iterable<String>*/>? queryParameters,
    String? fragment,
  }) {
    bool schemeChanged = false;
    if (scheme != null) {
      scheme = _Uri._makeScheme(scheme, 0, scheme.length);
      schemeChanged = !_isScheme(scheme);
    } else {
      scheme = this.scheme;
    }
    bool isFile = (scheme == "file");
    if (userInfo != null) {
      userInfo = _Uri._makeUserInfo(userInfo, 0, userInfo.length);
    } else if (_hostStart > 0) {
      userInfo = _uri.substring(_schemeEnd + 3, _hostStart);
    } else {
      userInfo = "";
    }
    if (port != null) {
      port = _Uri._makePort(port, scheme);
    } else {
      port = this.hasPort ? this.port : null;
      if (schemeChanged) {
        port = _Uri._makePort(port, scheme);
      }
    }
    if (host != null) {
      host = _Uri._makeHost(host, 0, host.length, false);
    } else if (_hostStart > 0) {
      host = _uri.substring(_hostStart, _portStart);
    } else if (userInfo.isNotEmpty || port != null || isFile) {
      host = "";
    }

    bool hasAuthority = host != null;
    if (path != null || pathSegments != null) {
      path = _Uri._makePath(
        path,
        0,
        _stringOrNullLength(path),
        pathSegments,
        scheme,
        hasAuthority,
      );
    } else {
      path = _uri.substring(_pathStart, _queryStart);
      if ((isFile || (hasAuthority && !path.isEmpty)) &&
          !path.startsWith('/')) {
        path = "/" + path;
      }
    }

    if (query != null || queryParameters != null) {
      query = _Uri._makeQuery(
        query,
        0,
        _stringOrNullLength(query),
        queryParameters,
      );
    } else if (_queryStart < _fragmentStart) {
      query = _uri.substring(_queryStart + 1, _fragmentStart);
    }

    if (fragment != null) {
      fragment = _Uri._makeFragment(fragment, 0, fragment.length);
    } else if (_fragmentStart < _uri.length) {
      fragment = _uri.substring(_fragmentStart + 1);
    }

    return _Uri._internal(scheme, userInfo, host, port, path, query, fragment);
  }

  Uri resolve(String reference) {
    return resolveUri(Uri.parse(reference));
  }

  Uri resolveUri(Uri reference) {
    if (reference is _SimpleUri) {
      return _simpleMerge(this, reference);
    }
    return _toNonSimple().resolveUri(reference);
  }

  static int _packageNameEnd(_SimpleUri uri) {
    if (uri._isPackage && !uri.hasAuthority) {
      return _skipPackageNameChars(uri._uri, uri._pathStart, uri._queryStart);
    }
    return -1;
  }

  Uri _simpleMerge(_SimpleUri base, _SimpleUri ref) {
    if (ref.hasScheme) return ref;
    if (ref.hasAuthority) {
      if (!base.hasScheme) return ref;
      bool isSimple = true;
      if (base._isFile) {
        isSimple = !ref.hasEmptyPath;
      } else if (base._isHttp) {
        isSimple = !ref._isPort("80");
      } else if (base._isHttps) {
        isSimple = !ref._isPort("443");
      }
      if (isSimple) {
        var delta = base._schemeEnd + 1;
        var newUri =
            base._uri.substring(0, base._schemeEnd + 1) +
            ref._uri.substring(ref._schemeEnd + 1);
        return _SimpleUri(
          newUri,
          base._schemeEnd,
          ref._hostStart + delta,
          ref._portStart + delta,
          ref._pathStart + delta,
          ref._queryStart + delta,
          ref._fragmentStart + delta,
          base._schemeCache,
        );
      } else {
        return _toNonSimple().resolveUri(ref);
      }
    }
    if (ref.hasEmptyPath) {
      if (ref.hasQuery) {
        int delta = base._queryStart - ref._queryStart;
        var newUri =
            base._uri.substring(0, base._queryStart) +
            ref._uri.substring(ref._queryStart);
        return _SimpleUri(
          newUri,
          base._schemeEnd,
          base._hostStart,
          base._portStart,
          base._pathStart,
          ref._queryStart + delta,
          ref._fragmentStart + delta,
          base._schemeCache,
        );
      }
      if (ref.hasFragment) {
        int delta = base._fragmentStart - ref._fragmentStart;
        var newUri =
            base._uri.substring(0, base._fragmentStart) +
            ref._uri.substring(ref._fragmentStart);
        return _SimpleUri(
          newUri,
          base._schemeEnd,
          base._hostStart,
          base._portStart,
          base._pathStart,
          base._queryStart,
          ref._fragmentStart + delta,
          base._schemeCache,
        );
      }
      return base.removeFragment();
    }
    if (ref.hasAbsolutePath) {
      int basePathStart = base._pathStart;
      int packageNameEnd = _packageNameEnd(this);
      if (packageNameEnd > 0) basePathStart = packageNameEnd;
      var delta = basePathStart - ref._pathStart;
      var newUri =
          base._uri.substring(0, basePathStart) +
          ref._uri.substring(ref._pathStart);
      return _SimpleUri(
        newUri,
        base._schemeEnd,
        base._hostStart,
        base._portStart,
        base._pathStart,
        ref._queryStart + delta,
        ref._fragmentStart + delta,
        base._schemeCache,
      );
    }
    if (base.hasEmptyPath && base.hasAuthority) {
      int refStart = ref._pathStart;
      while (ref._uri.startsWith("../", refStart)) {
        refStart += 3;
      }
      var delta = base._pathStart - refStart + 1;
      var newUri =
          "${'${'}base._uri.substring(0, base._pathStart)}/"
          "${'${'}ref._uri.substring(refStart)}";
      return _SimpleUri(
        newUri,
        base._schemeEnd,
        base._hostStart,
        base._portStart,
        base._pathStart,
        ref._queryStart + delta,
        ref._fragmentStart + delta,
        base._schemeCache,
      );
    }

    String baseUri = base._uri;
    String refUri = ref._uri;
    int baseStart = base._pathStart;
    int baseEnd = base._queryStart;
    int packageNameEnd = _packageNameEnd(this);
    if (packageNameEnd >= 0) {
      baseStart = packageNameEnd; // At the ${'`'}/${'`'} after the first package name.
    } else {
      while (baseUri.startsWith("../", baseStart)) baseStart += 3;
    }
    int refStart = ref._pathStart;
    int refEnd = ref._queryStart;

    int backCount = 0;

    while (refStart + 3 <= refEnd && refUri.startsWith("../", refStart)) {
      refStart += 3;
      backCount += 1;
    }

    String insert = "";

    while (baseEnd > baseStart) {
      baseEnd--;
      int char = baseUri.codeUnitAt(baseEnd);
      if (char == _SLASH) {
        insert = "/";
        if (backCount == 0) break;
        backCount--;
      }
    }

    if (baseEnd == baseStart && !base.hasScheme && !base.hasAbsolutePath) {

      insert = "";
      refStart -= backCount * 3;
    }

    var delta = baseEnd - refStart + insert.length;
    var newUri =
        "${'${'}base._uri.substring(0, baseEnd)}$insert"
        "${'${'}ref._uri.substring(refStart)}";

    return _SimpleUri(
      newUri,
      base._schemeEnd,
      base._hostStart,
      base._portStart,
      base._pathStart,
      ref._queryStart + delta,
      ref._fragmentStart + delta,
      base._schemeCache,
    );
  }

  String toFilePath({bool? windows}) {
    if (_schemeEnd >= 0 && !_isFile) {
      throw UnsupportedError("Cannot extract a file path from a $scheme URI");
    }
    if (_queryStart < _uri.length) {
      if (_queryStart < _fragmentStart) {
        throw UnsupportedError(
          "Cannot extract a file path from a URI with a query component",
        );
      }
      throw UnsupportedError(
        "Cannot extract a file path from a URI with a fragment component",
      );
    }
    return (windows ?? _Uri._isWindows)
        ? _Uri._toWindowsFilePath(this)
        : _toFilePath();
  }

  String _toFilePath() {
    if (_hostStart < _portStart) {
      throw UnsupportedError(
        "Cannot extract a non-Windows file path from a file URI "
        "with an authority",
      );
    }
    return this.path;
  }

  UriData? get data {
    assert(scheme != "data");
    return null;
  }

  int get hashCode => _hashCodeCache ??= _uri.hashCode;

  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Uri && _uri == other.toString();
  }

  Uri _toNonSimple() {
    return _Uri._internal(
      this.scheme,
      this.userInfo,
      this.hasAuthority ? this.host : null,
      this.hasPort ? this.port : null,
      this.path,
      this.hasQuery ? this.query : null,
      this.hasFragment ? this.fragment : null,
    );
  }

  String toString() => _uri;
}

class _DataUri extends _Uri {
  final UriData _data;

  _DataUri(this._data, String path, String? query)
    : super._internal("data", "", null, null, path, query, null);

  UriData? get data => _data;
}

int _startsWithData(String text, int start) {
  int delta = (text.codeUnitAt(start + 4) ^ _COLON) * 3;
  delta |= text.codeUnitAt(start) ^ 0x64 /*d*/;
  delta |= text.codeUnitAt(start + 1) ^ 0x61 /*a*/;
  delta |= text.codeUnitAt(start + 2) ^ 0x74 /*t*/;
  delta |= text.codeUnitAt(start + 3) ^ 0x61 /*a*/;
  return delta;
}

int _stringOrNullLength(String? s) => (s == null) ? 0 : s.length;

List<String> _toUnmodifiableStringList(String key, List<String> list) =>
    List<String>.unmodifiable(list);

int _skipPackageNameChars(String source, int start, int end) {
  var dots = 0;
  for (var i = start; i < end; i++) {
    var char = source.codeUnitAt(i);
    if (char == _SLASH) return (dots != 0) ? i : -1;
    if (char == _PERCENT || char == _COLON) return -1;
    dots |= char ^ _DOT;
  }
  return -1;
}

bool _caseInsensitiveStartsWith(String prefix, String string, int start) =>
    _caseInsensitiveCompareStart(prefix, string, start) >= 0;

int _caseInsensitiveCompareStart(String prefix, String string, int start) {
  int result = 0;
  for (int i = 0; i < prefix.length; i++) {
    int prefixChar = prefix.codeUnitAt(i);
    int stringChar = string.codeUnitAt(start + i);
    int delta = prefixChar ^ stringChar;
    if (delta != 0) {
      if (delta == 0x20) {
        int lowerChar = stringChar | delta;
        if (0x61 /*a*/ <= lowerChar && lowerChar <= 0x7a /*z*/ ) {
          result = 0x20;
          continue;
        }
      }
      return -1;
    }
  }
  return result;
}

bool _caseInsensitiveEquals(String string1, String string2) =>
    string1.length == string2.length &&
    _caseInsensitiveStartsWith(string1, string2, 0);

const _unreservedMask = 0x0001;

const _unreserved2396Mask = 0x0002;

const _encodeFullMask = 0x0004;

const _schemeMask = 0x0008;

const _userinfoMask = 0x0010;

const _regNameMask = 0x0020;

const _pathCharMask = 0x0040;

const _pathCharOrSlashMask = 0x0080;

const _queryCharMask = 0x0100;

const _zoneIDMask = _unreservedMask;

const _tokenCharMask = 0x0200;

const _uricMask = _queryCharMask;

const _genDelimitersMask = 0x0400;

const _ipvFutureAddressCharsMask = _userinfoMask;

const String _charTables =
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    "\x00\x00\x00\u03f6\x00\u0404\u03f4\x20\u03f4\u03f6\u01f6\u01f6\u03f6\u03fc"
    "\u01f4\u03ff\u03ff\u0584\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff"
    "\u03ff\u03ff\u05d4\u01f4\x00\u01f4\x00\u0504\u05c4\u03ff\u03ff\u03ff\u03ff"
    "\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff"
    "\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u0400\x00"
    "\u0400\u0200\u03f7\u0200\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff"
    "\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff"
    "\u03ff\u03ff\u03ff\u03ff\u03ff\u03ff\u0200\u0200\u0200\u03f7\x00";

int hexDigitValue(int char) {
  const int digit0 = 0x30;
  const int a = 0x61;
  const int f = 0x66;
  int digit = char ^ digit0;
  if (digit <= 9) return digit;
  int letter = (char | 0x20);
  if (a <= letter && letter <= f) return letter - (a - 10);
  return -1;
}

int parseHexByte(String source, int index) {
  int digit1 = hexDigitValue(source.codeUnitAt(index));
  int digit2 = hexDigitValue(source.codeUnitAt(index + 1));
  return digit1 * 16 + digit2 - (digit2 & 256);
}
`;
