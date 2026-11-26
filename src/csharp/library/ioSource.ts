/**
 * The declarations of the library's input and output types, in C#: text readers and writers, and the files and
 * directories of the run's virtual file system. Members without bodies are implemented natively (see `nativesIo.ts`).
 */
export const IO_SOURCE = String.raw`
namespace System {
  public class UnauthorizedAccessException : SystemException { public UnauthorizedAccessException(); public UnauthorizedAccessException(string? message); public UnauthorizedAccessException(string? message, Exception? inner); }
}

namespace System.IO {
  public class IOException : SystemException { public IOException(); public IOException(string? message); public IOException(string? message, Exception? innerException); }
  public class FileNotFoundException : IOException {
    public FileNotFoundException();
    public FileNotFoundException(string? message);
    public FileNotFoundException(string? message, Exception? innerException);
    public FileNotFoundException(string? message, string? fileName);
    public string? FileName { get; }
    public override string ToString();
  }
  public class DirectoryNotFoundException : IOException { public DirectoryNotFoundException(); public DirectoryNotFoundException(string? message); public DirectoryNotFoundException(string? message, Exception? innerException); }
  public class EndOfStreamException : IOException { public EndOfStreamException(); public EndOfStreamException(string? message); public EndOfStreamException(string? message, Exception? innerException); }

  public abstract class TextWriter : IDisposable {
    public virtual string NewLine { get; set; }
    public virtual void Flush();
    public virtual void Close();
    public void Dispose();
    public virtual void Write(bool value);
    public virtual void Write(char value);
    public virtual void Write(char[]? buffer);
    public virtual void Write(char[] buffer, int index, int count);
    public virtual void Write(decimal value);
    public virtual void Write(double value);
    public virtual void Write(int value);
    public virtual void Write(long value);
    public virtual void Write(object? value);
    public virtual void Write(float value);
    public virtual void Write(string? value);
    public virtual void Write(string format, object? arg0);
    public virtual void Write(string format, object? arg0, object? arg1);
    public virtual void Write(string format, object? arg0, object? arg1, object? arg2);
    public virtual void Write(string format, params object?[] arg);
    public virtual void Write(uint value);
    public virtual void Write(ulong value);
    public virtual void WriteLine();
    public virtual void WriteLine(bool value);
    public virtual void WriteLine(char value);
    public virtual void WriteLine(char[]? buffer);
    public virtual void WriteLine(char[] buffer, int index, int count);
    public virtual void WriteLine(decimal value);
    public virtual void WriteLine(double value);
    public virtual void WriteLine(int value);
    public virtual void WriteLine(long value);
    public virtual void WriteLine(object? value);
    public virtual void WriteLine(float value);
    public virtual void WriteLine(string? value);
    public virtual void WriteLine(string format, object? arg0);
    public virtual void WriteLine(string format, object? arg0, object? arg1);
    public virtual void WriteLine(string format, object? arg0, object? arg1, object? arg2);
    public virtual void WriteLine(string format, params object?[] arg);
    public virtual void WriteLine(uint value);
    public virtual void WriteLine(ulong value);
  }
  public class StreamWriter : TextWriter {
    public StreamWriter(string path);
    public StreamWriter(string path, bool append);
    public StreamWriter(string path, bool append, System.Text.Encoding? encoding);
    public StreamWriter(Stream stream);
    public StreamWriter(Stream stream, System.Text.Encoding? encoding);
    public virtual bool AutoFlush { get; set; }
  }
  public class StringWriter : TextWriter { public StringWriter(); public override string ToString(); }

  public enum FileMode { CreateNew = 1, Create = 2, Open = 3, OpenOrCreate = 4, Truncate = 5, Append = 6 }
  [Flags]
  public enum FileAccess { Read = 1, Write = 2, ReadWrite = 3 }
  [Flags]
  public enum FileShare { None = 0, Read = 1, Write = 2, ReadWrite = 3, Delete = 4, Inheritable = 16 }
  public enum SeekOrigin { Begin = 0, Current = 1, End = 2 }
  public abstract class Stream : IDisposable {
    public virtual bool CanRead { get; }
    public virtual bool CanWrite { get; }
    public virtual bool CanSeek { get; }
    public virtual long Length { get; }
    public virtual long Position { get; set; }
    public virtual int ReadByte();
    public virtual void WriteByte(byte value);
    public virtual int Read(byte[] buffer, int offset, int count);
    public virtual void Write(byte[] buffer, int offset, int count);
    public virtual long Seek(long offset, SeekOrigin origin);
    public virtual void Flush();
    public virtual void Close();
    public void Dispose();
  }
  public class FileStream : Stream {
    public FileStream(string path, FileMode mode);
    public FileStream(string path, FileMode mode, FileAccess access);
    public FileStream(string path, FileMode mode, FileAccess access, FileShare share);
    public virtual string Name { get; }
  }

  public abstract class TextReader : IDisposable {
    public virtual string? ReadLine();
    public virtual int Read();
    public virtual int Peek();
    public virtual string ReadToEnd();
    public virtual void Close();
    public void Dispose();
  }
  public class StreamReader : TextReader {
    public StreamReader(string path);
    public StreamReader(string path, System.Text.Encoding? encoding);
    public StreamReader(Stream stream);
    public StreamReader(Stream stream, System.Text.Encoding? encoding);
    public bool EndOfStream { get; }
  }
  public class StringReader : TextReader {
    public StringReader(string s);
  }

  public static class File {
    public static bool Exists(string? path);
    public static string ReadAllText(string path);
    public static string ReadAllText(string path, System.Text.Encoding encoding);
    public static string[] ReadAllLines(string path);
    public static string[] ReadAllLines(string path, System.Text.Encoding encoding);
    public static IEnumerable<string> ReadLines(string path);
    public static IEnumerable<string> ReadLines(string path, System.Text.Encoding encoding);
    public static void WriteAllText(string path, string? contents);
    public static void WriteAllText(string path, string? contents, System.Text.Encoding encoding);
    public static void WriteAllLines(string path, string[] contents);
    public static void WriteAllLines(string path, IEnumerable<string> contents);
    public static void WriteAllLines(string path, string[] contents, System.Text.Encoding encoding);
    public static void WriteAllLines(string path, IEnumerable<string> contents, System.Text.Encoding encoding);
    public static void AppendAllText(string path, string? contents);
    public static void AppendAllText(string path, string? contents, System.Text.Encoding encoding);
    public static void AppendAllLines(string path, IEnumerable<string> contents);
    public static void AppendAllLines(string path, IEnumerable<string> contents, System.Text.Encoding encoding);
    public static byte[] ReadAllBytes(string path);
    public static void WriteAllBytes(string path, byte[] bytes);
    public static void AppendAllBytes(string path, byte[] bytes);
    public static FileStream Open(string path, FileMode mode);
    public static FileStream Open(string path, FileMode mode, FileAccess access);
    public static FileStream Open(string path, FileMode mode, FileAccess access, FileShare share);
    public static FileStream OpenRead(string path);
    public static FileStream OpenWrite(string path);
    public static FileStream Create(string path);
    public static void Delete(string path);
    public static void Copy(string sourceFileName, string destFileName);
    public static void Copy(string sourceFileName, string destFileName, bool overwrite);
    public static void Move(string sourceFileName, string destFileName);
    public static void Move(string sourceFileName, string destFileName, bool overwrite);
    public static StreamReader OpenText(string path);
    public static StreamWriter CreateText(string path);
    public static StreamWriter AppendText(string path);
  }
  public abstract class FileSystemInfo {
    public abstract string Name { get; }
    public virtual string FullName { get; }
    public string Extension { get; }
    public abstract bool Exists { get; }
    public void Refresh();
    public abstract void Delete();
    public override string ToString();
  }
  public sealed class FileInfo : FileSystemInfo {
    public FileInfo(string fileName);
    public override string Name { get; }
    public override bool Exists { get; }
    public long Length { get; }
    public string? DirectoryName { get; }
    public DirectoryInfo? Directory { get; }
    public override void Delete();
    public FileInfo CopyTo(string destFileName);
    public FileInfo CopyTo(string destFileName, bool overwrite);
    public void MoveTo(string destFileName);
    public void MoveTo(string destFileName, bool overwrite);
    public StreamReader OpenText();
    public StreamWriter CreateText();
    public StreamWriter AppendText();
    public FileStream Create();
    public FileStream Open(FileMode mode);
    public FileStream Open(FileMode mode, FileAccess access);
    public FileStream Open(FileMode mode, FileAccess access, FileShare share);
    public FileStream OpenRead();
    public FileStream OpenWrite();
  }
  public sealed class DirectoryInfo : FileSystemInfo {
    public DirectoryInfo(string path);
    public override string Name { get; }
    public override bool Exists { get; }
    public DirectoryInfo? Parent { get; }
    public DirectoryInfo Root { get; }
    public void Create();
    public DirectoryInfo CreateSubdirectory(string path);
    public override void Delete();
    public void Delete(bool recursive);
    public FileInfo[] GetFiles();
    public FileInfo[] GetFiles(string searchPattern);
    public DirectoryInfo[] GetDirectories();
    public DirectoryInfo[] GetDirectories(string searchPattern);
    public FileSystemInfo[] GetFileSystemInfos();
    public FileSystemInfo[] GetFileSystemInfos(string searchPattern);
    public IEnumerable<FileInfo> EnumerateFiles();
    public IEnumerable<FileInfo> EnumerateFiles(string searchPattern);
    public IEnumerable<DirectoryInfo> EnumerateDirectories();
    public IEnumerable<DirectoryInfo> EnumerateDirectories(string searchPattern);
    public void MoveTo(string destDirName);
  }
  public static class Directory {
    public static bool Exists(string? path);
    public static DirectoryInfo CreateDirectory(string path);
    public static void Delete(string path);
    public static void Delete(string path, bool recursive);
    public static string[] GetFiles(string path);
    public static string[] GetFiles(string path, string searchPattern);
    public static string[] GetDirectories(string path);
    public static string[] GetDirectories(string path, string searchPattern);
    public static IEnumerable<string> EnumerateFiles(string path);
    public static IEnumerable<string> EnumerateFiles(string path, string searchPattern);
    public static IEnumerable<string> EnumerateDirectories(string path);
    public static IEnumerable<string> EnumerateDirectories(string path, string searchPattern);
    public static string GetCurrentDirectory();
  }
  public static class Path {
    public static readonly char DirectorySeparatorChar = '/';
    public static readonly char AltDirectorySeparatorChar = '/';
    public static readonly char PathSeparator = ':';
    public static readonly char VolumeSeparatorChar = '/';
    public static string Combine(string path1, string path2);
    public static string Combine(string path1, string path2, string path3);
    public static string Combine(string path1, string path2, string path3, string path4);
    public static string Combine(params string[] paths);
    public static string Join(string? path1, string? path2);
    public static string Join(string? path1, string? path2, string? path3);
    public static string Join(string? path1, string? path2, string? path3, string? path4);
    public static string Join(params string?[] paths);
    public static string? GetFileName(string? path);
    public static string? GetFileNameWithoutExtension(string? path);
    public static string? GetExtension(string? path);
    public static string? GetDirectoryName(string? path);
    public static string? ChangeExtension(string? path, string? extension);
    public static bool HasExtension(string? path);
    public static bool IsPathRooted(string? path);
    public static string GetFullPath(string path);
  }
}
`;
