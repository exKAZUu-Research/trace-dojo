import { FileSystemError } from '../../interpreter/programIo';
import { defineNatives, type NativeCall } from '../natives';
import { type CsObject, type Value } from '../values';
import {
  ALL,
  copyFile,
  deleteDirectory,
  deleteFile,
  entryPaths,
  fileNameOf,
  fileSystemInfo,
  type FileSystemInfoState,
  fullPathOf,
  moveFile,
  newReader,
  newWriter,
  openFileReader,
  openFileWriter,
  pathArgument,
  throwException,
  trimEnd,
  utf8Length,
  valueText,
  withFiles,
} from './nativesIo';
import { fail, libraryType, newArray } from './support';

// FileInfo and DirectoryInfo, whose `Exists` and `Length` show what was there when they last looked, as in .NET.

function stateOf(receiver: Value): FileSystemInfoState {
  return (receiver as CsObject).native as FileSystemInfoState;
}

function refresh(call: NativeCall, state: FileSystemInfoState): void {
  const files = call.frame.runtime.io.files;
  const found = files.kindOf(state.fullPath);
  state.found = found;
  state.length = found === 'file' ? utf8Length(files.readFile(state.fullPath)) : undefined;
}

function found(call: NativeCall, receiver: Value): 'file' | 'directory' | undefined {
  const state = stateOf(receiver);
  if (state.found === 'unread') refresh(call, state);
  return state.found as 'file' | 'directory' | undefined;
}

/** Makes the next look read the path again, as .NET does after an operation of the object that changes it. */
function invalidate(receiver: Value): void {
  stateOf(receiver).found = 'unread';
}

/** The argument of a constructor, whose null .NET names by the constructor's parameter and whose empty text by `path`. */
function constructorPath(value: Value, paramName: string): string {
  if (value === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', paramName);
  return pathArgument(value);
}

/** The full path without its final separators, which the root keeps. */
function trimmedFullPath(receiver: Value): string {
  return trimEnd(stateOf(receiver).fullPath);
}

/** The directory holding a full path, or `undefined` for the root, as `Path.GetDirectoryName` gives it. */
function directoryOf(fullPath: string): string | undefined {
  if (fullPath === '/') return undefined;
  const slash = fullPath.lastIndexOf('/');
  return slash === 0 ? '/' : fullPath.slice(0, slash);
}

function infoArray(
  call: NativeCall,
  typeName: string,
  paths: string[],
  kindOf: (path: string) => 'file' | 'directory'
): Value {
  return newArray(
    call,
    libraryType(call, typeName),
    paths.map((path) => fileSystemInfo(call, kindOf(path), path))
  );
}

function entriesOf(call: NativeCall, receiver: Value, pattern: Value | typeof ALL, kind: 'file' | 'directory'): Value {
  const paths = entryPaths(call, stateOf(receiver).fullPath, pattern, kind);
  return infoArray(call, kind === 'file' ? 'System.IO.FileInfo' : 'System.IO.DirectoryInfo', paths, () => kind);
}

function allEntriesOf(call: NativeCall, receiver: Value, pattern: Value | typeof ALL): Value {
  const files = call.frame.runtime.io.files;
  const paths = entryPaths(call, stateOf(receiver).fullPath, pattern);
  return infoArray(call, 'System.IO.FileSystemInfo', paths, (path) => files.kindOf(path) ?? 'file');
}

defineNatives({
  'System.IO.FileSystemInfo.get_FullName': (_call, receiver) => stateOf(receiver).fullPath,
  'System.IO.FileSystemInfo.get_Extension': (_call, receiver) => {
    // Unlike Path.GetExtension, a final dot counts as the extension.
    const { fullPath } = stateOf(receiver);
    const dot = fullPath.lastIndexOf('.');
    return dot > fullPath.lastIndexOf('/') ? fullPath.slice(dot) : '';
  },
  'System.IO.FileSystemInfo.Refresh': (call, receiver) => {
    refresh(call, stateOf(receiver));
  },
  'System.IO.FileSystemInfo.ToString': (_call, receiver) => stateOf(receiver).originalPath,

  'System.IO.FileInfo..ctor': (call, receiver, [path]) => {
    const created = fileSystemInfo(call, 'file', constructorPath(path as Value, 'fileName'));
    (receiver as CsObject).native = created.native;
  },
  'System.IO.FileInfo.get_Name': (_call, receiver) => fileNameOf(stateOf(receiver).fullPath),
  'System.IO.FileInfo.get_Exists': (call, receiver) => found(call, receiver) === 'file',
  'System.IO.FileInfo.get_Length': (call, receiver) => {
    const state = stateOf(receiver);
    if (found(call, receiver) !== 'file' || state.length === undefined)
      throwException(
        call,
        'System.IO.FileNotFoundException',
        `Could not find file '${state.fullPath}'.`,
        state.fullPath
      );
    return BigInt(state.length);
  },
  'System.IO.FileInfo.get_DirectoryName': (_call, receiver) => directoryOf(stateOf(receiver).fullPath),
  'System.IO.FileInfo.get_Directory': (call, receiver) => {
    const directory = directoryOf(stateOf(receiver).fullPath);
    return directory === undefined ? undefined : fileSystemInfo(call, 'directory', directory);
  },
  'System.IO.FileInfo.Delete': (call, receiver) => {
    deleteFile(call, stateOf(receiver).fullPath);
    invalidate(receiver);
  },
  'System.IO.FileInfo.CopyTo(string)': (call, receiver, [target]) => copyTo(call, receiver, target as Value, false),
  'System.IO.FileInfo.CopyTo(string, bool)': (call, receiver, [target, overwrite]) =>
    copyTo(call, receiver, target as Value, overwrite as boolean),
  'System.IO.FileInfo.MoveTo(string)': (call, receiver, [target]) => {
    moveTo(call, receiver, target as Value, false);
  },
  'System.IO.FileInfo.MoveTo(string, bool)': (call, receiver, [target, overwrite]) => {
    moveTo(call, receiver, target as Value, overwrite as boolean);
  },
  'System.IO.FileInfo.OpenText': (call, receiver) =>
    newReader(call, 'System.IO.StreamReader', openFileReader(call, stateOf(receiver).fullPath)),
  'System.IO.FileInfo.CreateText': (call, receiver) => {
    const writer = newWriter(call, 'System.IO.StreamWriter', openFileWriter(call, stateOf(receiver).fullPath, false));
    invalidate(receiver);
    return writer;
  },
  'System.IO.FileInfo.AppendText': (call, receiver) => {
    const writer = newWriter(call, 'System.IO.StreamWriter', openFileWriter(call, stateOf(receiver).fullPath, true));
    invalidate(receiver);
    return writer;
  },

  'System.IO.DirectoryInfo..ctor': (call, receiver, [path]) => {
    const created = fileSystemInfo(call, 'directory', constructorPath(path as Value, 'path'));
    (receiver as CsObject).native = created.native;
  },
  'System.IO.DirectoryInfo.get_Name': (_call, receiver) => {
    const trimmed = trimmedFullPath(receiver);
    return trimmed === '/' ? '/' : fileNameOf(trimmed);
  },
  'System.IO.DirectoryInfo.get_Exists': (call, receiver) => found(call, receiver) === 'directory',
  'System.IO.DirectoryInfo.get_Parent': (call, receiver) => {
    const parent = directoryOf(trimmedFullPath(receiver));
    return parent === undefined ? undefined : fileSystemInfo(call, 'directory', parent);
  },
  'System.IO.DirectoryInfo.get_Root': (call) => fileSystemInfo(call, 'directory', '/'),
  'System.IO.DirectoryInfo.Create': (call, receiver) => {
    const files = call.frame.runtime.io.files;
    withFiles(call, () => files.createDirectory(stateOf(receiver).fullPath, true), 'directory');
    invalidate(receiver);
  },
  'System.IO.DirectoryInfo.CreateSubdirectory': (call, receiver, [path]) =>
    createSubdirectory(call, receiver, path as Value),
  'System.IO.DirectoryInfo.Delete()': (call, receiver) => {
    deleteDirectory(call, stateOf(receiver).fullPath, false);
    invalidate(receiver);
  },
  'System.IO.DirectoryInfo.Delete(bool)': (call, receiver, [recursive]) => {
    deleteDirectory(call, stateOf(receiver).fullPath, recursive as boolean);
    invalidate(receiver);
  },
  'System.IO.DirectoryInfo.GetFiles()': (call, receiver) => entriesOf(call, receiver, ALL, 'file'),
  'System.IO.DirectoryInfo.GetFiles(string)': (call, receiver, [pattern]) =>
    entriesOf(call, receiver, pattern as Value, 'file'),
  'System.IO.DirectoryInfo.GetDirectories()': (call, receiver) => entriesOf(call, receiver, ALL, 'directory'),
  'System.IO.DirectoryInfo.GetDirectories(string)': (call, receiver, [pattern]) =>
    entriesOf(call, receiver, pattern as Value, 'directory'),
  'System.IO.DirectoryInfo.GetFileSystemInfos()': (call, receiver) => allEntriesOf(call, receiver, ALL),
  'System.IO.DirectoryInfo.GetFileSystemInfos(string)': (call, receiver, [pattern]) =>
    allEntriesOf(call, receiver, pattern as Value),
  'System.IO.DirectoryInfo.EnumerateFiles()': (call, receiver) => entriesOf(call, receiver, ALL, 'file'),
  'System.IO.DirectoryInfo.EnumerateFiles(string)': (call, receiver, [pattern]) =>
    entriesOf(call, receiver, pattern as Value, 'file'),
  'System.IO.DirectoryInfo.EnumerateDirectories()': (call, receiver) => entriesOf(call, receiver, ALL, 'directory'),
  'System.IO.DirectoryInfo.EnumerateDirectories(string)': (call, receiver, [pattern]) =>
    entriesOf(call, receiver, pattern as Value, 'directory'),
  'System.IO.DirectoryInfo.MoveTo': (call, receiver, [target]) => {
    moveDirectory(call, receiver, target as Value);
  },
});

function copyTo(call: NativeCall, receiver: Value, target: Value, overwrite: boolean): CsObject {
  copyFile(call, stateOf(receiver).fullPath, target, overwrite);
  // The copy's object knows the copy by its full path, which its `ToString` shows.
  return fileSystemInfo(call, 'file', fullPathOf(valueText(target)));
}

function moveTo(call: NativeCall, receiver: Value, target: Value, overwrite: boolean): void {
  moveFile(call, stateOf(receiver).fullPath, target, overwrite);
  const state = stateOf(receiver);
  state.originalPath = valueText(target);
  state.fullPath = fullPathOf(state.originalPath);
  invalidate(receiver);
}

/** `CreateSubdirectory`, which accepts only a path inside the directory or the directory itself. */
function createSubdirectory(call: NativeCall, receiver: Value, path: Value): CsObject {
  if (path === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'path');
  const text = valueText(path);
  if (text.trim() === '')
    fail('System.ArgumentException', 'Path cannot be the empty string or all whitespace.', 'path');
  if (text.startsWith('/'))
    fail('System.ArgumentException', 'Second path fragment must not be a drive or UNC name.', 'path');
  const { fullPath } = stateOf(receiver);
  const created = fullPathOf(`${fullPath}/${text}`);
  const trimmedCreated = trimEnd(created);
  const trimmedCurrent = trimEnd(fullPath);
  const isInside =
    trimmedCreated.startsWith(trimmedCurrent) &&
    (trimmedCreated.length === trimmedCurrent.length || created[trimmedCurrent.length] === '/');
  if (!isInside)
    fail(
      'System.ArgumentException',
      `The directory specified, '${text}', is not a subdirectory of '${fullPath}'.`,
      'path'
    );
  withFiles(call, () => call.frame.runtime.io.files.createDirectory(created, true), 'directory');
  return fileSystemInfo(call, 'directory', created);
}

/** `DirectoryInfo.MoveTo`, after which the object names the moved directory by its full path with a final separator. */
function moveDirectory(call: NativeCall, receiver: Value, target: Value): void {
  const files = call.frame.runtime.io.files;
  const destination = fullPathOf(pathArgument(target, 'destDirName'));
  const state = stateOf(receiver);
  const source = trimEnd(state.fullPath);
  if (source === trimEnd(destination))
    throwException(call, 'System.IO.IOException', 'Source and destination path must be different.');
  if (files.kindOf(source) === undefined)
    throwException(
      call,
      'System.IO.DirectoryNotFoundException',
      `Could not find a part of the path '${state.fullPath}'.`
    );
  if (files.kindOf(destination) !== undefined)
    throwException(
      call,
      'System.IO.IOException',
      `Cannot create '${destination}' because a file or directory with the same name already exists.`
    );
  try {
    files.rename(source, trimEnd(destination));
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    if (error.code === 'EINVAL') throwException(call, 'System.IO.IOException', 'Invalid argument');
    throwException(
      call,
      'System.IO.DirectoryNotFoundException',
      `Could not find a part of the path '${state.fullPath}'.`
    );
  }
  state.originalPath = valueText(target);
  state.fullPath = `${trimEnd(destination)}/`;
  invalidate(receiver);
}
