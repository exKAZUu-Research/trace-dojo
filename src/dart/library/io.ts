/**
 * dart:io as the interpreter declares it: the standard streams, `exit`, and files and directories of the run's own
 * file system, following the SDK's classes and messages. A `Future` of a file operation completes in a later event,
 * as the VM's I/O service answers. The source must not contain `${`.
 */
export const IO_SOURCE = String.raw`
abstract interface class IOException implements Exception {}

/**
 * Rejects what the run's files and standard streams cannot take, as they hold text: an encoding other than UTF-8, and
 * bytes that are not UTF-8. Every such check of dart:io throws its diagnostic from here.
 */
Never _unavailableIo(String what) => throw UnsupportedError(what + "は、この採点環境では使えません。");

void _requireUtf8(Encoding encoding) {
  if (encoding.name != "utf-8") _unavailableIo("UTF-8 以外の encoding によるファイルと標準入出力の読み書き");
}

/**
 * The text of bytes written to a file or a standard stream. Bytes given in parts go through one decoder, which keeps
 * a character the parts split until the next part; finishing it fails a character left unfinished.
 */
String _textOfBytes(List<int> bytes, [_Utf8Decoder? parts]) {
  try {
    return parts == null ? utf8.decode(bytes) : parts.convertChunked(bytes, 0, null);
  } on FormatException {
    _unavailableIo("UTF-8 でないバイト列の書き込み");
  }
}

void _finishText(_Utf8Decoder parts) {
  try {
    parts.flush(StringBuffer());
  } on FormatException {
    _unavailableIo("UTF-8 でないバイト列の書き込み");
  }
}

class OSError implements IOException {
  static const int noErrorCode = -1;
  final String message;
  final int errorCode;
  const OSError([this.message = "", this.errorCode = noErrorCode]);
  String toString() {
    StringBuffer sb = StringBuffer();
    sb.write("OS Error");
    if (message.isNotEmpty) {
      sb..write(": ")..write(message);
      if (errorCode != noErrorCode) {
        sb..write(", errno = ")..write(errorCode.toString());
      }
    } else if (errorCode != noErrorCode) {
      sb..write(": errno = ")..write(errorCode.toString());
    }
    return sb.toString();
  }
}

class FileSystemException implements IOException {
  final String message;
  final String? path;
  final OSError? osError;
  const FileSystemException([this.message = "", this.path = "", this.osError]);
  String toString() => _toStringHelper("FileSystemException");
  String _toStringHelper(String className) {
    StringBuffer sb = StringBuffer(className);
    sb.write(": ");
    sb.write(message);
    if (path != null) {
      sb.write(", path = '" + path! + "'");
    }
    if (osError != null) {
      sb.write(" (" + osError.toString() + ")");
    }
    return sb.toString();
  }
}

class PathAccessException extends FileSystemException {
  const PathAccessException(String path, OSError osError, [String message = ""]) : super(message, path, osError);
  String toString() => _toStringHelper("PathAccessException");
}

class PathExistsException extends FileSystemException {
  const PathExistsException(String path, OSError osError, [String message = ""]) : super(message, path, osError);
  String toString() => _toStringHelper("PathExistsException");
}

class PathNotFoundException extends FileSystemException {
  const PathNotFoundException(String path, OSError osError, [String message = ""]) : super(message, path, osError);
  String toString() => _toStringHelper("PathNotFoundException");
}

class StdinException implements IOException {
  final String message;
  final OSError? osError;
  const StdinException(this.message, [this.osError]);
  String toString() => "StdinException: " + message + (osError == null ? "" : ", " + osError.toString());
}

class StdoutException implements IOException {
  final String message;
  final OSError? osError;
  const StdoutException(this.message, [this.osError]);
  String toString() => "StdoutException: " + message + (osError == null ? "" : ", " + osError.toString());
}

/** A run's standard input and output are pipes, not a terminal, so the VM's terminal queries fail with ENOTTY. */
const OSError _notTerminal = OSError("Inappropriate ioctl for device", 25);

abstract interface class IOSink implements StreamSink<List<int>>, StringSink {
  Encoding get encoding;
  set encoding(Encoding value);
  void add(List<int> data);
  void addError(Object error, [StackTrace? stackTrace]);
  Future addStream(Stream<List<int>> stream);
  void write(Object? object);
  void writeln([Object? object = ""]);
  void writeAll(Iterable<dynamic> objects, [String separator = ""]);
  void writeCharCode(int charCode);
  Future flush();
  Future close();
  Future get done;
}

// From the SDK's lib/io/stdio.dart (3.13.7), class Stdout. Modifications: a run's standard streams are pipes, not
// a terminal, so the terminal queries answer as the VM does for a pipe, and nonBlocking is left out.
class Stdout extends _StdSink implements IOSink {
  final bool _isError;

  Stdout._(IOSink sink, this._isError) : super(sink);

  bool get hasTerminal => false;

  int get terminalColumns => throw const StdoutException("Could not get terminal size", _notTerminal);

  int get terminalLines => throw const StdoutException("Could not get terminal size", _notTerminal);

  bool get supportsAnsiEscapes => false;
}

/**
 * The IOSink a run's standard output or error writes through, in place of the SDK's _IOSinkImpl over a _StdConsumer
 * of the descriptor: it checks a write, a flush, a close and an added stream by the rules of the SDK's
 * _StreamSinkImpl and _IOSinkImpl, and writes at once, as the VM's synchronous controller does, so that its text and
 * print's stay in order. The SDK's classes would charge about five times the operations for each write, so that a run
 * could write a fifth of what Java's can.
 */
class _StdIOSink implements IOSink {
  final bool _isError;
  final Completer<void> _closed = Completer<void>();
  bool _isBound = false;
  _StdIOSink(this._isError);
  Encoding get encoding => utf8;
  set encoding(Encoding value) => _requireUtf8(value);
  void write(Object? object) {
    String string = '$object';
    if (string.isEmpty) return;
    _add(string);
  }
  void writeln([Object? object = ""]) {
    _add('$object\n');
  }
  void writeAll(Iterable objects, [String separator = ""]) {
    Iterator iterator = objects.iterator;
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
  void writeCharCode(int charCode) {
    write(String.fromCharCode(charCode));
  }
  void add(List<int> data) {
    _requireWritable();
    // print and the end of the run do not pass through the sink, so a character cannot continue in a later add.
    _writeStream(_isError, _textOfBytes(data));
  }
  void _add(String text) {
    _requireWritable();
    _writeStream(_isError, text);
  }
  /** Fails a write as the SDK's sink does: once it is closed, and while a stream is added to it. */
  void _requireWritable() {
    if (_closed.isCompleted) throw StateError("StreamSink is closed");
    if (_isBound) throw StateError("StreamSink is bound to a stream");
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    Error.throwWithStackTrace(error, stackTrace ?? StackTrace.empty);
  }
  Future addStream(Stream<List<int>> stream) {
    if (_isBound) throw StateError("StreamSink is already bound to a stream");
    _isBound = true;
    return stream.forEach((data) {
      // The VM's sink hands a stream to the descriptor's file, which fails each chunk, even an empty one, once closed.
      if (_closed.isCompleted) throw const FileSystemException("File closed", "");
      _writeStream(_isError, _textOfBytes(data));
    }).whenComplete(() {
      _isBound = false;
    });
  }
  Future flush() {
    if (_isBound) throw StateError("StreamSink is bound to a stream");
    return Future.value(this);
  }
  // Closing completes, and so does done, once closed; afterwards a write fails, and print drops what it prints.
  Future close() {
    if (_isBound) throw StateError("StreamSink is bound to a stream");
    _closeStream(_isError);
    if (!_closed.isCompleted) _closed.complete();
    return _closed.future;
  }
  Future get done => _closed.future;
}

external void _writeStream(bool isError, String text);
external void _closeStream(bool isError);

final _newLineDetector = RegExp(r'(?<!\r)\n');
final _newLineDetectorAfterCR = RegExp(r'(?<=[^\r])\n');

// From the SDK's lib/io/stdio.dart (3.13.7), class _StdSink, without modifications.
class _StdSink implements IOSink {
  final IOSink _sink;
  bool _windowsLineTerminator = false;
  bool _lastWrittenCharIsCR = false;

  _StdSink(this._sink);

  String get lineTerminator => _windowsLineTerminator ? "\r\n" : "\n";
  set lineTerminator(String lineTerminator) {
    if (lineTerminator == "\r\n") {
      assert(!_lastWrittenCharIsCR || _windowsLineTerminator);
      _windowsLineTerminator = true;
    } else if (lineTerminator == "\n") {
      _windowsLineTerminator = false;
      _lastWrittenCharIsCR = false;
    } else {
      throw ArgumentError.value(
        lineTerminator,
        "lineTerminator",
        r'invalid line terminator, must be one of "\n" or "\r\n"',
      );
    }
  }

  Encoding get encoding => _sink.encoding;
  void set encoding(Encoding encoding) {
    _sink.encoding = encoding;
  }

  String _convertToWindowsLineTerminators(String string) {
    assert(!string.isEmpty);
    var pattern = _lastWrittenCharIsCR
        ? _newLineDetectorAfterCR
        : _newLineDetector;
    var result = string.replaceAll(pattern, "\r\n");
    _lastWrittenCharIsCR = result.endsWith('\r');
    return result;
  }

  void _write(Object? object) {
    if (!_windowsLineTerminator) {
      _sink.write(object);
      return;
    }

    var string = object.toString();
    if (string.isEmpty) return;
    _sink.write(_convertToWindowsLineTerminators(string));
  }

  void write(Object? object) => _write(object);

  void writeln([Object? object = ""]) {
    if (!_windowsLineTerminator) {
      _sink.write('$object\n');
    } else {
      _sink.write(_convertToWindowsLineTerminators('$object\r\n'));
    }
  }

  void writeAll(Iterable objects, [String sep = ""]) {
    Iterator iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    if (sep.isEmpty) {
      do {
        _write(iterator.current);
      } while (iterator.moveNext());
    } else {
      _write(iterator.current);
      while (iterator.moveNext()) {
        _write(sep);
        _write(iterator.current);
      }
    }
  }

  void add(List<int> data) {
    _lastWrittenCharIsCR = false;
    _sink.add(data);
  }

  void addError(error, [StackTrace? stackTrace]) {
    _sink.addError(error, stackTrace);
  }

  void writeCharCode(int charCode) {
    if (!_windowsLineTerminator) {
      _sink.writeCharCode(charCode);
      return;
    }

    _write(String.fromCharCode(charCode));
  }

  Future addStream(Stream<List<int>> stream) {
    _lastWrittenCharIsCR = false;
    return _sink.addStream(stream);
  }

  Future flush() => _sink.flush();
  Future close() => _sink.close();
  Future get done => _sink.done;
}

final Stdout stdout = Stdout._(_StdIOSink(false), false);
final Stdout stderr = Stdout._(_StdIOSink(true), true);

class Stdin extends Stream<List<int>> {
  Stdin._();
  bool get hasTerminal => false;
  bool get supportsAnsiEscapes => false;
  bool get echoMode => throw const StdinException("Error getting terminal echo mode", _notTerminal);
  set echoMode(bool enabled) => throw const StdinException("Error setting terminal echo mode", _notTerminal);
  bool get echoNewlineMode => throw const StdinException("Error getting terminal echo newline mode", _notTerminal);
  set echoNewlineMode(bool enabled) =>
      throw const StdinException("Error setting terminal echo newline mode", _notTerminal);
  bool get lineMode => throw const StdinException("Error getting terminal line mode", _notTerminal);
  set lineMode(bool enabled) => throw const StdinException("Error setting terminal line mode", _notTerminal);
  String? readLineSync({Encoding encoding = utf8, bool retainNewlines = false}) {
    _requireUtf8(encoding);
    return _readLine(retainNewlines);
  }
  int readByteSync() => _readByte();
  StreamSubscription<List<int>> listen(void onData(List<int> event)?,
      {Function? onError, void onDone()?, bool? cancelOnError}) {
    _listen();
    return Stream<List<int>>.fromFuture(Future(_readRest))
        .where((bytes) => bytes.isNotEmpty)
        .listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }
  external static String? _readLine(bool retainNewlines);
  external static int _readByte();
  external static List<int> _readRest();
  // The native reader owns stdin's state: open, listened to (a single-subscription stream), or read to its end.
  external static void _listen();
}

final Stdin stdin = Stdin._();

int _exitCode = 0;
int get exitCode => _exitCode;
set exitCode(int code) {
  _exitCode = code;
}

external Never exit(int code);

void sleep(Duration duration) {
  int milliseconds = duration.inMilliseconds;
  if (milliseconds < 0) {
    throw ArgumentError("sleep: duration cannot be negative");
  }
  _sleep(milliseconds);
}

external void _sleep(int milliseconds);

final class FileMode {
  static const read = FileMode._internal(0);
  static const write = FileMode._internal(1);
  static const append = FileMode._internal(2);
  static const writeOnly = FileMode._internal(3);
  static const writeOnlyAppend = FileMode._internal(4);
  final int _mode;
  const FileMode._internal(this._mode);
  bool get _appends => _mode == 2 || _mode == 4;
}

final class FileSystemEntityType {
  static const file = FileSystemEntityType._internal(0);
  static const directory = FileSystemEntityType._internal(1);
  static const link = FileSystemEntityType._internal(2);
  static const unixDomainSock = FileSystemEntityType._internal(3);
  static const pipe = FileSystemEntityType._internal(4);
  static const notFound = FileSystemEntityType._internal(5);
  final int _type;
  const FileSystemEntityType._internal(this._type);
  String toString() => const ["file", "directory", "link", "unixDomainSock", "pipe", "notFound"][_type];
}

abstract class FileSystemEntity {
  String get path;
  FileSystemEntity get absolute;
  bool get isAbsolute => path.startsWith("/");
  Uri get uri => Uri.file(path);
  Directory get parent => Directory(parentOf(path));
  bool existsSync();
  Future<bool> exists() => Future(existsSync);
  FileSystemEntity renameSync(String newPath);
  Future<FileSystemEntity> rename(String newPath) => Future(() => renameSync(newPath));
  void deleteSync({bool recursive = false});
  Future<FileSystemEntity> delete({bool recursive = false}) => Future(() {
        deleteSync(recursive: recursive);
        return this;
      });
  static bool isFileSync(String path) => _kindOf(path) == 0;
  static bool isDirectorySync(String path) => _kindOf(path) == 1;
  static bool isLinkSync(String path) => false;
  static Future<bool> isFile(String path) => Future(() => isFileSync(path));
  static Future<bool> isDirectory(String path) => Future(() => isDirectorySync(path));
  static Future<bool> isLink(String path) => Future.value(false);
  static FileSystemEntityType typeSync(String path, {bool followLinks = true}) {
    var kind = _kindOf(path);
    return kind == 0
        ? FileSystemEntityType.file
        : kind == 1
            ? FileSystemEntityType.directory
            : FileSystemEntityType.notFound;
  }
  static Future<FileSystemEntityType> type(String path, {bool followLinks = true}) =>
      Future(() => typeSync(path, followLinks: followLinks));
  static bool identicalSync(String path1, String path2) {
    if (_kindOf(path1) == 2 || _kindOf(path2) == 2) {
      throw const FileSystemException("Error in FileSystemEntity.identicalSync", null, OSError("No such file or directory", 2));
    }
    return _isSameFile(path1, path2);
  }
  static Future<bool> identical(String path1, String path2) => Future(() {
        if (_kindOf(path1) == 2 || _kindOf(path2) == 2) {
          throw PathNotFoundException(
              "", const OSError("No such file or directory", 2), "Error in FileSystemEntity.identical(" + path1 + ", " + path2 + ")");
        }
        return _isSameFile(path1, path2);
      });
  static final RegExp _parentRegExp = RegExp(r'[^/]/+[^/]');
  static String parentOf(String path) {
    int rootEnd = -1;
    if (path.startsWith("/")) rootEnd = 0;
    int pos = path.lastIndexOf(_parentRegExp);
    if (pos > rootEnd) {
      return path.substring(0, pos + 1);
    } else if (rootEnd > -1) {
      return path.substring(0, rootEnd + 1);
    } else {
      return ".";
    }
  }
  static String _absolutePath(String path) {
    if (path.startsWith("/")) return path;
    String current = Directory.current.path;
    return current.endsWith("/") ? current + path : current + "/" + path;
  }
  external static int _kindOf(String path);
  external static bool _isSameFile(String path1, String path2);
}

abstract interface class File implements FileSystemEntity {
  factory File(String path) => _File(path);
  factory File.fromUri(Uri uri) => File(uri.toFilePath());
  File get absolute;
  File renameSync(String newPath);
  Future<File> rename(String newPath);
  Future<File> delete({bool recursive = false});
  void createSync({bool recursive = false, bool exclusive = false});
  Future<File> create({bool recursive = false, bool exclusive = false});
  File copySync(String newPath);
  Future<File> copy(String newPath);
  int lengthSync();
  Future<int> length();
  String readAsStringSync({Encoding encoding = utf8});
  Future<String> readAsString({Encoding encoding = utf8});
  List<String> readAsLinesSync({Encoding encoding = utf8});
  Future<List<String>> readAsLines({Encoding encoding = utf8});
  List<int> readAsBytesSync();
  Future<List<int>> readAsBytes();
  void writeAsStringSync(String contents, {FileMode mode = FileMode.write, Encoding encoding = utf8, bool flush = false});
  Future<File> writeAsString(String contents,
      {FileMode mode = FileMode.write, Encoding encoding = utf8, bool flush = false});
  void writeAsBytesSync(List<int> bytes, {FileMode mode = FileMode.write, bool flush = false});
  Future<File> writeAsBytes(List<int> bytes, {FileMode mode = FileMode.write, bool flush = false});
  IOSink openWrite({FileMode mode = FileMode.write, Encoding encoding = utf8});
  Stream<List<int>> openRead([int? start, int? end]);
}

class _File extends FileSystemEntity implements File {
  final String path;
  _File(this.path);
  String toString() => "File: '" + path + "'";
  File get absolute => isAbsolute ? this : _File(FileSystemEntity._absolutePath(path));
  bool existsSync() => FileSystemEntity._kindOf(path) == 0;
  File renameSync(String newPath) {
    final failure = "Cannot rename file to '" + newPath + "'";
    _requireFile(failure);
    _rename(path, newPath, failure);
    return File(newPath);
  }
  Future<File> rename(String newPath) => Future(() => renameSync(newPath));
  void deleteSync({bool recursive = false}) {
    if (!recursive) _requireFile("Cannot delete file");
    _delete(path, false, recursive, recursive ? "Deletion failed" : "Cannot delete file");
  }
  Future<File> delete({bool recursive = false}) => Future(() {
        deleteSync(recursive: recursive);
        return this;
      });
  void createSync({bool recursive = false, bool exclusive = false}) {
    _create(path, recursive, exclusive);
  }
  Future<File> create({bool recursive = false, bool exclusive = false}) => Future(() {
        createSync(recursive: recursive, exclusive: exclusive);
        return this;
      });
  File copySync(String newPath) {
    final failure = "Cannot copy file to '" + newPath + "'";
    _requireFile(failure);
    _write(newPath, _read(path, failure), false, failure, path);
    return File(newPath);
  }
  Future<File> copy(String newPath) => Future(() => copySync(newPath));
  /**
   * Fails unless the path names a file, as the VM checks before it renames, copies or deletes one: a directory is
   * reported as one, and a file named with a trailing separator, which names no file, as not found.
   */
  void _requireFile(String failure) {
    final kind = FileSystemEntity._kindOf(path);
    if (kind == 0) return;
    if (kind == 1) throw FileSystemException(failure, path, const OSError("Is a directory", 21));
    throw PathNotFoundException(path, const OSError("No such file or directory", 2), failure);
  }
  int lengthSync() => utf8.encode(_read(path, "Cannot retrieve length of file")).length;
  Future<int> length() => Future(lengthSync);
  String readAsStringSync({Encoding encoding = utf8}) {
    _requireUtf8(encoding);
    return _read(path, "Cannot open file");
  }
  Future<String> readAsString({Encoding encoding = utf8}) => Future(() => readAsStringSync(encoding: encoding));
  List<String> readAsLinesSync({Encoding encoding = utf8}) =>
      const LineSplitter().convert(readAsStringSync(encoding: encoding));
  Future<List<String>> readAsLines({Encoding encoding = utf8}) => Future(() => readAsLinesSync(encoding: encoding));
  List<int> readAsBytesSync() => utf8.encode(readAsStringSync());
  Future<List<int>> readAsBytes() => Future(readAsBytesSync);
  void writeAsStringSync(String contents, {FileMode mode = FileMode.write, Encoding encoding = utf8, bool flush = false}) {
    _requireUtf8(encoding);
    if (mode == FileMode.read) {
      // The VM opens the file to read, which only an empty write leaves unchanged without an error.
      _read(path, "Cannot open file");
      if (contents.isNotEmpty) throw FileSystemException("writeFrom failed", path, const OSError("Bad file descriptor", 9));
      return;
    }
    _write(path, contents, mode._appends, "Cannot open file");
  }
  Future<File> writeAsString(String contents,
          {FileMode mode = FileMode.write, Encoding encoding = utf8, bool flush = false}) =>
      Future(() {
        writeAsStringSync(contents, mode: mode, encoding: encoding);
        return this;
      });
  void writeAsBytesSync(List<int> bytes, {FileMode mode = FileMode.write, bool flush = false}) {
    writeAsStringSync(_textOfBytes(bytes), mode: mode);
  }
  Future<File> writeAsBytes(List<int> bytes, {FileMode mode = FileMode.write, bool flush = false}) => Future(() {
        writeAsBytesSync(bytes, mode: mode);
        return this;
      });
  IOSink openWrite({FileMode mode = FileMode.write, Encoding encoding = utf8}) {
    if (mode != FileMode.write && mode != FileMode.append && mode != FileMode.writeOnly && mode != FileMode.writeOnlyAppend) {
      throw ArgumentError("Invalid file mode for this operation");
    }
    _requireUtf8(encoding);
    return _IOSinkImpl(_FileStreamConsumer(this, mode._appends), encoding);
  }
  Stream<List<int>> openRead([int? start, int? end]) => Stream<List<int>>.fromFuture(Future(() {
        final from = start ?? 0;
        if (from < 0) throw RangeError("Bad start position: " + from.toString());
        if (end != null && end < from) throw RangeError("Bad end position: " + end.toString());
        // The VM reads up to the end of the file, so a range past it gives what the file has there.
        final bytes = readAsBytesSync();
        final to = end == null || end > bytes.length ? bytes.length : end;
        return from < to ? bytes.sublist(from, to) : <int>[];
      })).where((bytes) => bytes.isNotEmpty);
  external static String _read(String path, String failure);
  external static void _write(String path, String contents, bool append, String failure, [String? shownPath]);
  external static void _create(String path, bool recursive, bool exclusive);
}

// _StreamSinkImpl and _IOSinkImpl are the SDK's (lib/io/io_sink.dart) and _FileStreamConsumer is lib/io/file_impl.dart's,
// over _OpenedFile in place of RandomAccessFile.
class _StreamSinkImpl<T> implements StreamSink<T> {
  final StreamConsumer<T> _target;
  final Completer _doneCompleter = Completer();
  StreamController<T>? _controllerInstance;
  Completer? _controllerCompleter;
  bool _isClosed = false;
  bool _isBound = false;
  bool _hasError = false;
  _StreamSinkImpl(this._target);
  void add(T data) {
    if (_isClosed) {
      throw StateError("StreamSink is closed");
    }
    _controller.add(data);
  }
  void addError(error, [StackTrace? stackTrace]) {
    if (_isClosed) {
      throw StateError("StreamSink is closed");
    }
    _controller.addError(error, stackTrace);
  }
  Future addStream(Stream<T> stream) {
    if (_isBound) {
      throw StateError("StreamSink is already bound to a stream");
    }
    if (_hasError) return done;
    _isBound = true;
    var future = _controllerCompleter == null
        ? _target.addStream(stream)
        : _controllerCompleter!.future.then((_) => _target.addStream(stream));
    _controllerInstance?.close();
    return future.whenComplete(() {
      _isBound = false;
    });
  }
  Future flush() {
    if (_isBound) {
      throw StateError("StreamSink is bound to a stream");
    }
    if (_controllerInstance == null) return Future.value(this);
    _isBound = true;
    var future = _controllerCompleter!.future;
    _controllerInstance!.close();
    return future.whenComplete(() {
      _isBound = false;
    });
  }
  Future close() {
    if (_isBound) {
      throw StateError("StreamSink is bound to a stream");
    }
    if (!_isClosed) {
      _isClosed = true;
      if (_controllerInstance != null) {
        _controllerInstance!.close();
      } else {
        _closeTarget();
      }
    }
    return done;
  }
  void _closeTarget() {
    _target.close().then(_completeDoneValue, onError: _completeDoneError);
  }
  Future get done => _doneCompleter.future;
  void _completeDoneValue(value) {
    if (!_doneCompleter.isCompleted) {
      _doneCompleter.complete(value);
    }
  }
  void _completeDoneError(error, StackTrace? stackTrace) {
    if (!_doneCompleter.isCompleted) {
      _hasError = true;
      _doneCompleter.completeError(error, stackTrace);
    }
  }
  StreamController<T> get _controller {
    if (_isBound) {
      throw StateError("StreamSink is bound to a stream");
    }
    if (_isClosed) {
      throw StateError("StreamSink is closed");
    }
    if (_controllerInstance == null) {
      _controllerInstance = StreamController<T>(sync: true);
      _controllerCompleter = Completer();
      _target.addStream(_controller.stream).then(
        (_) {
          if (_isBound) {
            _controllerCompleter!.complete(this);
            _controllerCompleter = null;
            _controllerInstance = null;
          } else {
            _closeTarget();
          }
        },
        onError: (error, stackTrace) {
          if (_isBound) {
            _controllerCompleter!.completeError(error, stackTrace);
            _controllerCompleter = null;
            _controllerInstance = null;
          } else {
            _completeDoneError(error, stackTrace);
          }
        },
      );
    }
    return _controllerInstance!;
  }
}

class _IOSinkImpl extends _StreamSinkImpl<List<int>> implements IOSink {
  Encoding _encoding;
  bool _encodingMutable = true;
  _IOSinkImpl(StreamConsumer<List<int>> target, this._encoding) : super(target);
  Encoding get encoding => _encoding;
  void set encoding(Encoding value) {
    if (!_encodingMutable) {
      throw StateError("IOSink encoding is not mutable");
    }
    _requireUtf8(value);
    _encoding = value;
  }
  void write(Object? obj) {
    String string = '$obj';
    if (string.isEmpty) return;
    add(_encoding.encode(string));
  }
  void writeAll(Iterable objects, [String separator = ""]) {
    Iterator iterator = objects.iterator;
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
  void writeln([Object? object = ""]) {
    add(_encoding.encode('$object\n'));
  }
  void writeCharCode(int charCode) {
    write(String.fromCharCode(charCode));
  }
}

class _FileStreamConsumer implements StreamConsumer<List<int>> {
  File? _file;
  Future<_OpenedFile> _openFuture;
  _FileStreamConsumer(File file, bool appends)
    : _file = file,
      _openFuture = _OpenedFile._openFile(file.path, appends);
  /** The file once opened, which later streams write to without waiting for the open again. */
  _OpenedFile? _opened;
  Future<File?> addStream(Stream<List<int>> stream) {
    Completer<File?> completer = new Completer<File?>.sync();
    final opened = _opened;
    if (opened != null) {
      _write(opened, stream, completer);
      return completer.future;
    }
    _openFuture
        .then((openedFile) {
          _opened = openedFile;
          _write(openedFile, stream, completer);
        })
        .catchError(completer.completeError);
    return completer.future;
  }
  void _write(_OpenedFile openedFile, Stream<List<int>> stream, Completer<File?> completer) {
    late StreamSubscription<List<int>> _subscription;
    void error(e, StackTrace stackTrace) {
      _subscription.cancel();
      // As in the SDK, nothing waits on this close, which fails a file already closed; a character the stream left
      // unfinished does not fail it, since the VM's file holds bytes.
      openedFile.close(finishText: false);
      completer.completeError(e, stackTrace);
    }
    // _OpenedFile writes at once, so the subscription need not pause while a write is in flight.
    _subscription = stream.listen(
      (d) {
        try {
          openedFile.writeFrom(d);
        } catch (e, stackTrace) {
          error(e, stackTrace);
        }
      },
      onDone: () {
        completer.complete(_file);
      },
      onError: error,
      cancelOnError: true,
    );
  }
  Future<File?> close() => _openFuture.then((openedFile) => openedFile.close()).then((_) => _file);
}

/**
 * The open file a sink writes to, in place of the SDK's RandomAccessFile: opened at once, as the VM's I/O service
 * opens it before the program's next file operation, and written at its own position, which other writes to the file
 * do not move and which follows the file after a rename or delete.
 */
class _OpenedFile {
  /** The file holds text, so the bytes of a character written in parts wait for the rest of it. */
  final _Utf8Decoder _parts = _Utf8Decoder(false);
  final String _path;
  bool _isClosed = false;
  _OpenedFile._(this._path);
  static Future<_OpenedFile> _openFile(String path, bool appends) {
    final file = _OpenedFile._(path);
    try {
      file._open(path, appends);
    } catch (error, stackTrace) {
      // The VM's I/O service answers a failure later, after code the program runs before its next event.
      return Future<_OpenedFile>(() => Error.throwWithStackTrace(error, stackTrace));
    }
    return Future.value(file);
  }
  /** Fails once the file is closed, as the VM's RandomAccessFile does, which a failed stream closes. */
  void _requireOpen() {
    if (_isClosed) throw FileSystemException("File closed", _path);
  }
  void writeFrom(List<int> bytes) {
    _requireOpen();
    _writeOpened(_textOfBytes(bytes, _parts));
  }
  Future<void> close({bool finishText = true}) {
    try {
      _requireOpen();
      _isClosed = true;
      if (finishText) _finishText(_parts);
    } catch (error, stackTrace) {
      return Future.error(error, stackTrace);
    }
    return Future.value();
  }
  external void _open(String path, bool appends);
  external void _writeOpened(String contents);
}

abstract interface class Directory implements FileSystemEntity {
  factory Directory(String path) => _Directory(path);
  factory Directory.fromUri(Uri uri) => Directory(uri.toFilePath());
  Uri get uri;
  static Directory get current => _Directory("/");
  Directory get absolute;
  Directory renameSync(String newPath);
  Future<Directory> rename(String newPath);
  Future<Directory> delete({bool recursive = false});
  void createSync({bool recursive = false});
  Future<Directory> create({bool recursive = false});
  List<FileSystemEntity> listSync({bool recursive = false, bool followLinks = true});
  Stream<FileSystemEntity> list({bool recursive = false, bool followLinks = true});
}

class _Directory extends FileSystemEntity implements Directory {
  final String path;
  _Directory(this.path);
  String toString() => "Directory: '" + path + "'";
  Uri get uri => Uri.directory(path);
  Directory get absolute => isAbsolute ? this : _Directory(FileSystemEntity._absolutePath(path));
  bool existsSync() => FileSystemEntity._kindOf(path) == 1;
  Directory renameSync(String newPath) {
    _rename(path, newPath, "Rename failed");
    return Directory(newPath);
  }
  Future<Directory> rename(String newPath) => Future(() => renameSync(newPath));
  void deleteSync({bool recursive = false}) {
    _delete(path, true, recursive, "Deletion failed");
  }
  Future<Directory> delete({bool recursive = false}) => Future(() {
        deleteSync(recursive: recursive);
        return this;
      });
  void createSync({bool recursive = false}) {
    _createDirectory(path, recursive);
  }
  Future<Directory> create({bool recursive = false}) => Future(() {
        createSync(recursive: recursive);
        return this;
      });
  List<FileSystemEntity> listSync({bool recursive = false, bool followLinks = true}) {
    var base = path.endsWith("/") ? path : path + "/";
    var entities = <FileSystemEntity>[];
    for (var entry in _list(path, recursive)) {
      var entryPath = base + entry.substring(2);
      entities.add(entry.startsWith("d") ? Directory(entryPath) : File(entryPath));
    }
    return entities;
  }
  Stream<FileSystemEntity> list({bool recursive = false, bool followLinks = true}) =>
      Stream<List<FileSystemEntity>>.fromFuture(Future(() => listSync(recursive: recursive)))
          .expand((entities) => entities);
  external static void _createDirectory(String path, bool recursive);
  external static List<String> _list(String path, bool recursive);
}

external void _rename(String from, String to, String failure);
external void _delete(String path, bool isDirectory, bool recursive, String failure);
`;
