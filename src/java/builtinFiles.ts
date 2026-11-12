import { FileSystemError, type TextReader, type VirtualFileSystem } from '../interpreter/programIo';
import { itemsOf, javaHash } from './builtinCollectionSupport';
import { newList } from './builtinCollectors';
import {
  absolutePathOf,
  bufferedEncoderSink,
  classOf,
  classType,
  defineIOInterface,
  filePaths,
  fileSink,
  type IOContext,
  lastNameOf,
  normalizeSlashes,
  openModeOf,
  parentPathOf,
  pathTextOf,
  pathTexts,
  ReadAheadSource,
  readSources,
  type Sink,
  TextSource,
  throwsIO,
  utf8Length,
  withNioErrors,
  writeSinks,
} from './builtinIoSupport';
import { stringify } from './builtins';
import { createStream } from './builtinStreamSupport';
import { addAbstractMethod, addConstant, addConstructor, addMethod, newString } from './builtinSupport';
import { encodable, type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  createClass,
  INT,
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  VOID,
} from './types';
import { JavaArray, JavaObject, JavaString, toInt32, type Value } from './values';

/** The classes that stand for paths, which create `File` and `Path` objects. */
export interface FileTypes {
  file: ClassInfo;
  path: ClassInfo;
  newFile: (frame: Frame, path: string) => JavaObject;
  newPath: (frame: Frame, path: string) => JavaObject;
}

/** `java.io.File` and `java.nio.file.Path`, which name files by paths relative to the working directory. */
export function defineFileTypes(context: IOContext): FileTypes {
  const file = context.registry.define('File', context.objectClass, 'java.io');
  const path = defineIOInterface(context, 'Path', 'java.nio.file');
  const pathImpl = createClass('UnixPath', context.objectClass, true);
  pathImpl.isFinal = true;
  pathImpl.interfaces.push(path);
  pathImpl.supertypes.push(classType(path));
  const types: FileTypes = {
    file,
    path,
    newFile: (frame, text) => {
      const object = frame.runtime.allocateObject(frame, file);
      filePaths.set(object, text);
      return object;
    },
    newPath: (frame, text) => {
      const object = frame.runtime.allocateObject(frame, pathImpl);
      pathTexts.set(object, text);
      return object;
    },
  };
  defineFile(context, types);
  definePath(context, types, pathImpl);
  return types;
}

/** A method of `File` that reads only the file's path. */
type FileQuery = [name: string, returnType: JavaType, query: (frame: Frame, path: string) => Value];

function defineFile(context: IOContext, { file, path, newFile, newPath }: FileTypes): void {
  const { stringType } = context;
  addConstructor(file, [stringType], (frame, receiver, [text]) => {
    setFilePath(receiver, requireText(frame, text));
  });
  addConstructor(file, [stringType, stringType], (frame, receiver, [parent, child]) => {
    setChildPath(frame, receiver, (parent as JavaString | undefined)?.value, child);
  });
  addConstructor(file, [file.type, stringType], (frame, receiver, [parent, child]) => {
    setChildPath(frame, receiver, parent === undefined ? undefined : pathOf(parent), child);
  });
  const queries: FileQuery[] = [
    ['getName', stringType, (frame, text) => newString(frame, lastNameOf(text))],
    ['getPath', stringType, (frame, text) => newString(frame, text)],
    ['toString', stringType, (frame, text) => newString(frame, text)],
    ['getParent', stringType, (frame, text) => optional(parentPathOf(text), (parent) => newString(frame, parent))],
    ['getParentFile', file.type, (frame, text) => optional(parentPathOf(text), (parent) => newFile(frame, parent))],
    ['getAbsolutePath', stringType, (frame, text) => newString(frame, absolutePathOf(text))],
    ['getAbsoluteFile', file.type, (frame, text) => newFile(frame, absolutePathOf(text))],
    ['toPath', path.type, (frame, text) => newPath(frame, text)],
    ['exists', BOOLEAN, (frame, text) => kindOfFile(frame, text) !== undefined],
    ['canRead', BOOLEAN, (frame, text) => kindOfFile(frame, text) !== undefined],
    ['canWrite', BOOLEAN, (frame, text) => kindOfFile(frame, text) !== undefined],
    ['isFile', BOOLEAN, (frame, text) => kindOfFile(frame, text) === 'file'],
    ['isDirectory', BOOLEAN, (frame, text) => kindOfFile(frame, text) === 'directory'],
    ['length', LONG, (frame, text) => BigInt(sizeOf(frame, text))],
    ['delete', BOOLEAN, (frame, text) => succeeds(() => fileSystemOf(frame).remove(text))],
    ['mkdir', BOOLEAN, (frame, text) => succeeds(() => fileSystemOf(frame).createDirectory(text, false))],
    ['mkdirs', BOOLEAN, (frame, text) => createsDirectories(frame, text)],
    [
      'list',
      { kind: 'array', element: stringType },
      (frame, text) => listOf(frame, text, stringType, (name) => newString(frame, name)),
    ],
    [
      'listFiles',
      { kind: 'array', element: file.type },
      (frame, text) => listOf(frame, text, file.type, (name) => newFile(frame, normalizeSlashes(`${text}/${name}`))),
    ],
  ];
  for (const [name, returnType, query] of queries) {
    addMethod(file, name, [], returnType, false, (frame, receiver) => query(frame, pathOf(receiver)));
  }
  throwsIO(
    context,
    addMethod(file, 'createNewFile', [], BOOLEAN, false, (frame, receiver) => createNewFile(frame, pathOf(receiver)))
  );
  addMethod(file, 'renameTo', [file.type], BOOLEAN, false, (frame, receiver, [target]) => {
    if (target === undefined) throwBuiltin(frame, 'NullPointerException');
    return succeeds(() => fileSystemOf(frame).rename(pathOf(receiver), pathOf(target)));
  });
  addMethod(
    file,
    'equals',
    [context.objectClass.type],
    BOOLEAN,
    false,
    (_, receiver, [other]) => other instanceof JavaObject && other.cls === file && pathOf(other) === pathOf(receiver)
  );
  // Java computes a File's hash from its path's hash on Unix.
  addMethod(file, 'hashCode', [], INT, false, (frame, receiver) =>
    toInt32(javaHash(frame, new JavaString(pathOf(receiver))) ^ 1_234_321)
  );
}

function requireText(frame: Frame, value: Value): string {
  if (!(value instanceof JavaString)) return throwBuiltin(frame, 'NullPointerException');
  return value.value;
}

function setFilePath(receiver: Value, text: string): void {
  filePaths.set(receiver as JavaObject, normalizeSlashes(text));
}

/** Sets the path of a child of a parent path, where a child of the empty parent is a child of the root. */
function setChildPath(frame: Frame, receiver: Value, parent: string | undefined, child: Value): void {
  const name = requireText(frame, child);
  if (parent === undefined) setFilePath(receiver, name);
  else if (name === '') setFilePath(receiver, parent);
  else setFilePath(receiver, `${parent === '' ? '' : normalizeSlashes(parent)}/${name}`);
}

function pathOf(file: Value): string {
  return filePaths.get(file as JavaObject) as string;
}

function optional<T>(value: T | undefined, map: (value: T) => Value): Value {
  return value === undefined ? undefined : map(value);
}

/** What a `File` names, where its empty path names nothing, though a `Path` takes it for the working directory. */
function kindOfFile(frame: Frame, text: string): 'file' | 'directory' | undefined {
  return text === '' ? undefined : fileSystemOf(frame).kindOf(text);
}

function fileSystemOf(frame: Frame): VirtualFileSystem {
  return frame.runtime.io.files;
}

/** The size of a file in bytes, or 0 for a missing one; Linux gives a directory the size of a block. */
function sizeOf(frame: Frame, text: string): number {
  const kind = kindOfFile(frame, text);
  if (kind === 'directory') return 4096;
  return kind === 'file' ? utf8Length(fileSystemOf(frame).readFile(text)) : 0;
}

/** Whether a file system call succeeds, as the methods of `File` that return false on failure tell. */
function succeeds(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    if (error instanceof FileSystemError) return false;
    throw error;
  }
}

/** An array of the entries of a directory, or null when the path names no directory. */
function listOf(frame: Frame, text: string, elementType: JavaType, entry: (name: string) => Value): Value {
  let names: string[] = [];
  if (text === '' || !succeeds(() => (names = fileSystemOf(frame).list(text)))) return undefined;
  frame.runtime.allocateArray(frame, names.length);
  return new JavaArray(elementType, names.map(entry));
}

/** `File.mkdirs`, which tells whether it created the directory, so it fails for one that exists. */
function createsDirectories(frame: Frame, text: string): boolean {
  if (text === '') return false;
  try {
    return fileSystemOf(frame).createDirectory(text, true) !== undefined;
  } catch (error) {
    if (error instanceof FileSystemError) return false;
    throw error;
  }
}

function createNewFile(frame: Frame, text: string): boolean {
  try {
    fileSystemOf(frame).open(text, { create: 'exclusive', truncate: false, append: true });
    return true;
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    if (error.code === 'EEXIST' || error.code === 'EISDIR') return false;
    return throwBuiltin(
      frame,
      'IOException',
      error.code === 'ENOTDIR' ? 'Not a directory' : 'No such file or directory'
    );
  }
}

/** A method of `Path` that reads its path and its arguments. */
type PathMethod = [
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  run: (frame: Frame, text: string, args: Value[]) => Value,
];

function definePath(context: IOContext, { file, path, newFile, newPath }: FileTypes, pathImpl: ClassInfo): void {
  const { stringType } = context;
  const methods: PathMethod[] = [
    ['getFileName', [], path.type, (frame, text) => (text === '/' ? undefined : newPath(frame, lastNameOf(text)))],
    ['getParent', [], path.type, (frame, text) => optional(parentPathOf(text), (parent) => newPath(frame, parent))],
    [
      'resolve',
      [stringType],
      path.type,
      (frame, text, [other]) => newPath(frame, resolve(text, requireText(frame, other))),
    ],
    [
      'resolve',
      [path.type],
      path.type,
      (frame, text, [other]) => newPath(frame, resolve(text, pathTextOf(frame, other))),
    ],
    ['toAbsolutePath', [], path.type, (frame, text) => newPath(frame, absolutePathOf(text))],
    ['normalize', [], path.type, (frame, text) => newPath(frame, normalize(text))],
    ['toFile', [], file.type, (frame, text) => newFile(frame, text)],
    ['isAbsolute', [], BOOLEAN, (_, text) => text.startsWith('/')],
    ['getNameCount', [], INT, (_, text) => namesOf(text).length],
    ['getName', [INT], path.type, (frame, text, [index]) => newPath(frame, nameAt(frame, text, index as number))],
  ];
  for (const [name, parameterTypes, returnType, run] of methods) {
    addAbstractMethod(path, name, parameterTypes, returnType);
    addMethod(pathImpl, name, parameterTypes, returnType, false, (frame, receiver, args) =>
      run(frame, pathTexts.get(receiver as JavaObject) as string, args)
    );
  }
  addMethod(pathImpl, 'toString', [], stringType, false, (frame, receiver) =>
    newString(frame, pathTexts.get(receiver as JavaObject) as string)
  );
  addMethod(
    pathImpl,
    'equals',
    [context.objectClass.type],
    BOOLEAN,
    false,
    (_, receiver, [other]) =>
      other instanceof JavaObject &&
      other.cls === pathImpl &&
      pathTexts.get(other) === pathTexts.get(receiver as JavaObject)
  );
  addMethod(pathImpl, 'hashCode', [], INT, false, (_, receiver) => pathHashOf(pathTexts.get(receiver as JavaObject)));
  const stringArray: JavaType = { kind: 'array', element: stringType };
  const join: NativeMethod = (frame, _, [first, more]) => newPath(frame, joinPath(frame, first, more));
  addMethod(path, 'of', [stringType, stringArray], path.type, true, join).isVarargs = true;
  const paths = context.registry.define('Paths', context.objectClass, 'java.nio.file');
  paths.isFinal = true;
  addMethod(paths, 'get', [stringType, stringArray], path.type, true, join).isVarargs = true;
}

function resolve(base: string, other: string): string {
  if (other.startsWith('/') || base === '') return other;
  if (other === '') return base;
  return normalizeSlashes(`${base}/${other}`);
}

/** Removes `.` and the names that `..` cancels, by the path's text as `Path.normalize` does. */
function normalize(text: string): string {
  const isAbsolute = text.startsWith('/');
  const names: string[] = [];
  for (const name of text.split('/')) {
    if (name === '' || name === '.') continue;
    if (name === '..' && names.length > 0 && names.at(-1) !== '..') names.pop();
    else if (name !== '..' || !isAbsolute) names.push(name);
  }
  return `${isAbsolute ? '/' : ''}${names.join('/')}`;
}

/** The names of a path, where the empty path has one empty name. */
function namesOf(text: string): string[] {
  if (text === '') return [''];
  return text.split('/').filter((name) => name !== '');
}

function nameAt(frame: Frame, text: string, index: number): string {
  const names = namesOf(text);
  if (index < 0 || index >= names.length) throwBuiltin(frame, 'IllegalArgumentException');
  return names[index];
}

/** Java computes a Unix path's hash from the bytes of its path. */
function pathHashOf(text = ''): number {
  let hash = 0;
  for (const byte of new TextEncoder().encode(text)) hash = toInt32(Math.imul(hash, 31) + byte);
  return hash;
}

/** The path that `Path.of` joins from its names, skipping empty ones. */
function joinPath(frame: Frame, first: Value, more: Value): string {
  let text = requireText(frame, first);
  for (const segment of (more as JavaArray | undefined)?.values ?? []) {
    const name = requireText(frame, segment);
    if (name !== '') text = text === '' ? name : `${text}/${name}`;
  }
  return normalizeSlashes(text);
}

/** The names of the constants of `StandardOpenOption`, `LinkOption`, and `StandardCopyOption`. */
const OPTION_ENUMS = [
  ['StandardOpenOption', ['OpenOption'], ['READ', 'WRITE', 'APPEND', 'TRUNCATE_EXISTING', 'CREATE', 'CREATE_NEW']],
  ['LinkOption', ['OpenOption', 'CopyOption'], ['NOFOLLOW_LINKS']],
  ['StandardCopyOption', ['CopyOption'], ['REPLACE_EXISTING', 'COPY_ATTRIBUTES', 'ATOMIC_MOVE']],
] as const;

/** `java.nio.file.Files` and the options it takes, which read and write files by their paths. */
export function defineFiles(context: IOContext, types: FileTypes): void {
  const options = {
    OpenOption: defineIOInterface(context, 'OpenOption', 'java.nio.file'),
    CopyOption: defineIOInterface(context, 'CopyOption', 'java.nio.file'),
  };
  for (const [name, interfaces, constants] of OPTION_ENUMS) {
    defineOptionEnum(
      context,
      name,
      interfaces.map((option) => options[option]),
      constants
    );
  }
  const files = context.registry.define('Files', context.objectClass, 'java.nio.file');
  files.isFinal = true;
  defineFileReads(context, files, types);
  defineFileWrites(context, files, types, options.OpenOption);
  defineFileQueries(context, files, types);
  defineCopyAndMove(context, files, types, options.CopyOption);
}

function defineOptionEnum(
  context: IOContext,
  name: string,
  interfaces: ClassInfo[],
  constants: readonly string[]
): void {
  const enumClass = classOf(context, 'Enum');
  const cls = context.registry.define(name, enumClass, 'java.nio.file');
  cls.kind = 'enum';
  cls.isFinal = true;
  cls.supertypes = [classType(enumClass, cls.type)];
  for (const option of interfaces) {
    cls.interfaces.push(option);
    cls.supertypes.push(classType(option));
  }
  for (const [ordinal, constant] of constants.entries()) {
    const object = new JavaObject(cls);
    object.enumConstant = { name: new JavaString(constant), ordinal };
    addConstant(cls, constant, cls.type, object);
  }
}

function defineFileReads(context: IOContext, files: ClassInfo, { path }: FileTypes): void {
  const { stringType, stream, streamImpl } = context;
  addStatic(context, files, 'readString', [path.type], stringType, (frame, _, [file]) =>
    newString(frame, readText(frame, file))
  );
  const listOfStrings = classType(context.collections.listClass, stringType);
  addStatic(context, files, 'readAllLines', [path.type], listOfStrings, (frame, _, [file]) =>
    newList(frame, linesOf(frame, readText(frame, file)))
  );
  addStatic(context, files, 'lines', [path.type], classType(stream, stringType), (frame, _, [file]) => {
    // The file opens now, and a buffered reader reads it as the stream consumes its lines.
    const reader = new ReadAheadSource(frame, new TextSource(openText(frame, file))).reader(frame);
    return createStream(frame, streamImpl, function* () {
      for (let line = reader.readLine(); line !== undefined; line = reader.readLine()) yield newString(frame, line);
    });
  });
  const bufferedReader = classOf(context, 'BufferedReader');
  addStatic(context, files, 'newBufferedReader', [path.type], bufferedReader.type, (frame, _, [file]) => {
    const reader = frame.runtime.allocateObject(frame, bufferedReader);
    readSources.set(reader, new ReadAheadSource(frame, new TextSource(openText(frame, file))));
    return reader;
  });
}

function addStatic(
  context: IOContext,
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  native: NativeMethod
): MethodInfo {
  return throwsIO(context, addMethod(cls, name, parameterTypes, returnType, true, native));
}

/** The text of a file, read as `Files` reads it. */
function readText(frame: Frame, file: Value): string {
  return openText(frame, file).readRest();
}

/** Opens a file to read as `Files` does, which reads the file's text as it is when read. */
function openText(frame: Frame, file: Value): TextReader {
  const text = pathTextOf(frame, file);
  if (fileSystemOf(frame).kindOf(text) === 'directory') return throwBuiltin(frame, 'IOException', 'Is a directory');
  return withNioErrors(frame, text, () => frame.runtime.io.openReader(text));
}

function linesOf(frame: Frame, content: string): Value[] {
  const reader = frame.runtime.io.textReader(content);
  const lines: Value[] = [];
  for (let line = reader.readLine(); line !== undefined; line = reader.readLine()) lines.push(newString(frame, line));
  return lines;
}

function defineFileWrites(context: IOContext, files: ClassInfo, { path }: FileTypes, openOption: ClassInfo): void {
  const options: JavaType = { kind: 'array', element: openOption.type };
  addStatic(
    context,
    files,
    'writeString',
    [path.type, context.stringType, options],
    path.type,
    (frame, _, [file, content, given]) => {
      openForWriting(frame, file, given).write(frame, encodable(requireText(frame, content)));
      return file;
    }
  ).isVarargs = true;
  const iterable: ClassType = classType(context.collections.iterableClass, {
    kind: 'wildcard',
    bound: context.objectClass.type,
    isSuper: false,
  });
  addStatic(context, files, 'write', [path.type, iterable, options], path.type, (frame, _, [file, lines, given]) => {
    const items = itemsOf(frame, lines);
    const sink = openForWriting(frame, file, given);
    for (const line of items) sink.write(frame, encodable(`${stringify(frame, line, context.objectClass.type)}\n`));
    return file;
  }).isVarargs = true;
  const bufferedWriter = classOf(context, 'BufferedWriter');
  addStatic(
    context,
    files,
    'newBufferedWriter',
    [path.type, options],
    bufferedWriter.type,
    (frame, _, [file, given]) => {
      const writer = frame.runtime.allocateObject(frame, bufferedWriter);
      writeSinks.set(writer, bufferedEncoderSink(openForWriting(frame, file, given)));
      return writer;
    }
  ).isVarargs = true;
}

/** Opens a file to write as `Files` does with the options it is given. */
function openForWriting(frame: Frame, file: Value, given: Value): Sink {
  const text = pathTextOf(frame, file);
  const mode = openModeOf(frame, optionNamesOf(frame, given));
  return fileSink(withNioErrors(frame, text, () => fileSystemOf(frame).open(text, mode)));
}

/** The names of the options in a varargs array of them. */
function optionNamesOf(frame: Frame, options: Value): string[] {
  return ((options as JavaArray | undefined)?.values ?? []).map((option) => {
    if (!(option instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
    return option.enumConstant?.name.value as string;
  });
}

/** A method of `Files` that takes a path and calls the file system once. */
type FileCall = [name: string, returnType: JavaType, call: (system: VirtualFileSystem, text: string) => Value];

const FILE_CALLS: readonly FileCall[] = [
  [
    'createFile',
    VOID,
    (system, text) => {
      system.open(text, { create: 'exclusive', truncate: false, append: true });
    },
  ],
  [
    'createDirectory',
    VOID,
    (system, text) => {
      system.createDirectory(text, false);
    },
  ],
  [
    'createDirectories',
    VOID,
    (system, text) => {
      // Only a file standing where a directory should be fails.
      if (system.kindOf(text) === 'file') throw new FileSystemError('EEXIST', text);
      system.createDirectory(text, true);
    },
  ],
  [
    'delete',
    VOID,
    (system, text) => {
      system.remove(text);
    },
  ],
  [
    'deleteIfExists',
    BOOLEAN,
    (system, text) => {
      // Only a missing file returns false; a file where a directory should be still fails.
      try {
        system.remove(text);
        return true;
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'ENOENT') return false;
        throw error;
      }
    },
  ],
  // Linux gives a directory the size of a block.
  [
    'size',
    LONG,
    (system, text) => (system.kindOf(text) === 'directory' ? 4096n : BigInt(utf8Length(system.readFile(text)))),
  ],
];

/** The methods of `FILE_CALLS` that return the path they create. */
const CREATORS = new Set(['createFile', 'createDirectory', 'createDirectories']);

function defineFileQueries(context: IOContext, files: ClassInfo, { path, newPath }: FileTypes): void {
  const linkOptions: JavaType = { kind: 'array', element: classOf(context, 'LinkOption').type };
  for (const [name, test] of [
    ['exists', (kind: string | undefined) => kind !== undefined],
    ['notExists', (kind: string | undefined) => kind === undefined],
    ['isDirectory', (kind: string | undefined) => kind === 'directory'],
    ['isRegularFile', (kind: string | undefined) => kind === 'file'],
  ] as const) {
    addMethod(files, name, [path.type, linkOptions], BOOLEAN, true, (frame, _, [file]) =>
      test(fileSystemOf(frame).kindOf(pathTextOf(frame, file)))
    ).isVarargs = true;
  }
  for (const [name, returnType, call] of FILE_CALLS) {
    const isCreator = CREATORS.has(name);
    addStatic(context, files, name, [path.type], isCreator ? path.type : returnType, (frame, _, [file]) => {
      const text = pathTextOf(frame, file);
      const result = withNioErrors(frame, text, () => call(fileSystemOf(frame), text));
      return isCreator ? file : result;
    });
  }
  addStatic(context, files, 'list', [path.type], classType(context.stream, path.type), (frame, _, [file]) => {
    const text = pathTextOf(frame, file);
    if (fileSystemOf(frame).kindOf(text) === 'file') throwBuiltin(frame, 'NotDirectoryException', text);
    const names = withNioErrors(frame, text, () => fileSystemOf(frame).list(text));
    const children = names.map((name) => newPath(frame, resolve(text, name)));
    return createStream(frame, context.streamImpl, () => children[Symbol.iterator](), children);
  });
}

function defineCopyAndMove(context: IOContext, files: ClassInfo, { path }: FileTypes, copyOption: ClassInfo): void {
  const options: JavaType = { kind: 'array', element: copyOption.type };
  for (const name of ['copy', 'move'] as const) {
    addStatic(context, files, name, [path.type, path.type, options], path.type, (frame, _, [source, target, given]) => {
      copyOrMove(frame, name === 'move', pathTextOf(frame, source), pathTextOf(frame, target), given);
      return target;
    }).isVarargs = true;
  }
}

/** Copies or moves a file, or a directory, which a copy creates without its entries. */
function copyOrMove(frame: Frame, isMove: boolean, from: string, to: string, given: Value): void {
  const system = fileSystemOf(frame);
  const kind = system.kindOf(from);
  if (kind === undefined) throwBuiltin(frame, 'NoSuchFileException', from);
  // Copying or moving a file to itself does nothing.
  if (system.isSameFile(from, to)) return;
  if (system.kindOf(to) !== undefined) {
    if (!optionNamesOf(frame, given).includes('REPLACE_EXISTING'))
      throwBuiltin(frame, 'FileAlreadyExistsException', to);
    // The target is deleted, not overwritten, so that a handle still open on it writes to the old file.
    withNioErrors(frame, to, () => system.remove(to));
  }
  // A move fails as a rename of both paths, and a copy as the creation of its target.
  if (isMove) withNioErrors(frame, from, () => system.rename(from, to), to);
  else if (kind === 'directory') withNioErrors(frame, to, () => system.createDirectory(to, false));
  else {
    const content = withNioErrors(frame, from, () => system.readFile(from));
    withNioErrors(frame, to, () =>
      system.open(to, { create: 'exclusive', truncate: false, append: false }).write(content)
    );
  }
}
