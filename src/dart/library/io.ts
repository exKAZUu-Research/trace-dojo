/**
 * dart:io as the interpreter declares it: the standard streams, `exit`, and files and directories of the run's own
 * file system, following the SDK's classes and messages. A `Future` of a file operation completes in a later event,
 * as the VM's I/O service answers. The source must not contain `${`.
 */
export const IO_SOURCE = String.raw`
abstract interface class IOException implements Exception {}

/** The text of bytes written to a file or a standard stream, which hold text, so that bytes that are not UTF-8 cannot be kept. */
String _textOfBytes(List<int> bytes) {
  try {
    return utf8.decode(bytes);
  } on FormatException {
    throw UnsupportedError("UTF-8 でないバイト列の書き込みは、この採点環境では使えません。");
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

class Stdout implements IOSink {
  final bool _isError;
  Stdout._(this._isError);
  Encoding get encoding => utf8;
  bool get hasTerminal => false;
  bool get supportsAnsiEscapes => false;
  int get terminalColumns => throw const StdoutException("Could not get terminal size", _notTerminal);
  int get terminalLines => throw const StdoutException("Could not get terminal size", _notTerminal);
  external void write(Object? object);
  external void writeln([Object? object = ""]);
  external void writeAll(Iterable<dynamic> objects, [String separator = ""]);
  external void writeCharCode(int charCode);
  void add(List<int> data) {
    write(_textOfBytes(data));
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    Error.throwWithStackTrace(error, stackTrace ?? StackTrace.empty);
  }
  Future addStream(Stream<List<int>> stream) => stream.forEach(add);
  Future flush() => Future.value();
  Future close() => Future.value();
  Future get done => Future.value();
}

final Stdout stdout = Stdout._(false);
final Stdout stderr = Stdout._(true);

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
  String? readLineSync({Encoding encoding = utf8, bool retainNewlines = false}) => _readLine(retainNewlines);
  int readByteSync() => _readByte();
  StreamSubscription<List<int>> listen(void onData(List<int> event)?,
      {Function? onError, void onDone()?, bool? cancelOnError}) {
    return Stream<List<int>>.fromFuture(Future(_readRest))
        .where((bytes) => bytes.isNotEmpty)
        .listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }
  external static String? _readLine(bool retainNewlines);
  external static int _readByte();
  external static List<int> _readRest();
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
  static bool identicalSync(String path1, String path2) => _isSameFile(path1, path2);
  static Future<bool> identical(String path1, String path2) => Future(() => _isSameFile(path1, path2));
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
    _rename(path, newPath, "Cannot rename file to '" + newPath + "'");
    return File(newPath);
  }
  Future<File> rename(String newPath) => Future(() => renameSync(newPath));
  void deleteSync({bool recursive = false}) {
    _delete(path, false, recursive, "Cannot delete file");
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
    _write(newPath, _read(path, failure), false, failure, path);
    return File(newPath);
  }
  Future<File> copy(String newPath) => Future(() => copySync(newPath));
  int lengthSync() => utf8.encode(_read(path, "Cannot retrieve length of file")).length;
  Future<int> length() => Future(lengthSync);
  String readAsStringSync({Encoding encoding = utf8}) => _read(path, "Cannot open file");
  Future<String> readAsString({Encoding encoding = utf8}) => Future(() => readAsStringSync(encoding: encoding));
  List<String> readAsLinesSync({Encoding encoding = utf8}) => const LineSplitter().convert(readAsStringSync());
  Future<List<String>> readAsLines({Encoding encoding = utf8}) => Future(() => readAsLinesSync(encoding: encoding));
  List<int> readAsBytesSync() => utf8.encode(readAsStringSync());
  Future<List<int>> readAsBytes() => Future(readAsBytesSync);
  void writeAsStringSync(String contents, {FileMode mode = FileMode.write, Encoding encoding = utf8, bool flush = false}) {
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
        writeAsStringSync(contents, mode: mode);
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
    return _FileSink(this, mode._appends);
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

/**
 * An IOSink of a file. The file is opened, created or truncated, when the sink is, as the VM's I/O service opens it
 * before the program's next file operation, and what the sink buffers is written in a later event, so that it reaches
 * the file without a flush or a close.
 */
class _FileSink implements IOSink {
  final _File _file;
  final StringBuffer _buffer = StringBuffer();
  final Completer<void> _done = Completer<void>();
  bool _isClosed = false;
  bool _failed = false;
  bool _writeScheduled = false;
  _FileSink(this._file, bool appends) {
    try {
      _open(_file.path, appends);
    } catch (error, stackTrace) {
      // The VM reports a failure to open the file to done, which is unhandled unless the program closes the sink.
      _failed = true;
      Future(() => addError(error, stackTrace));
    }
  }
  Encoding get encoding => utf8;
  void write(Object? object) {
    _startWrite();
    _buffer.write(object);
  }
  void writeln([Object? object = ""]) {
    _startWrite();
    _buffer.writeln(object);
  }
  void writeAll(Iterable<dynamic> objects, [String separator = ""]) {
    _startWrite();
    _buffer.writeAll(objects, separator);
  }
  void writeCharCode(int charCode) {
    _startWrite();
    _buffer.writeCharCode(charCode);
  }
  void add(List<int> data) {
    write(_textOfBytes(data));
  }
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_done.isCompleted) _done.completeError(error, stackTrace);
  }
  Future addStream(Stream<List<int>> stream) => stream.forEach(add);
  Future flush() => Future(_writeBuffered);
  Future close() {
    if (!_isClosed) {
      _isClosed = true;
      Future(() {
        if (!_failed) _writeBuffered();
        return _file;
      }).then((file) {
        if (!_done.isCompleted) _done.complete();
      }, onError: (Object error, StackTrace stackTrace) {
        if (!_done.isCompleted) _done.completeError(error, stackTrace);
      });
    }
    return done;
  }
  Future get done => _done.future;
  void _writeBuffered() {
    final contents = _buffer.toString();
    _buffer.clear();
    if (contents.isNotEmpty) _writeOpened(contents);
  }
  /**
   * Opens the sink's file: from its start, or in append mode at the end it has now, which other writes to the file do
   * not move, and which the sink keeps writing to after the file is renamed or deleted, as the VM's open file does.
   */
  external void _open(String path, bool appends);
  external void _writeOpened(String contents);
  void _startWrite() {
    if (_isClosed) throw StateError("StreamSink is closed");
    if (_failed || _writeScheduled) return;
    _writeScheduled = true;
    Future(() {
      _writeScheduled = false;
      _writeBuffered();
    }).catchError(addError);
  }
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
