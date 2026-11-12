import { type ExecutionBudget, ExecutionLimitError, LIMITS } from './limits';

/** What a run starts from besides its program. */
export interface ProgramInput {
  /** The text the program reads from standard input. */
  stdin?: string;
  /** The contents of the files that exist when the program starts, by path; their directories exist as well. */
  files?: Readonly<Record<string, string>>;
}

/** What a run leaves besides its turtles. */
export interface ProgramOutput {
  stdout: string;
  stderr: string;
  /** The files that exist when the program ends, by path relative to the working directory, in path order. */
  finalFiles: Record<string, string>;
}

/** The working directory, which relative paths start from. */
export const WORKING_DIRECTORY = '/';
/** The path that reads standard input as a file, as on Linux. */
const STDIN_PATH = '/dev/stdin';

/**
 * The standard streams and the file system of one run, which every language's builtins share. Files hold text, which
 * languages encode as UTF-8 where they count bytes.
 */
export class ProgramIO {
  readonly stdin: StandardInput;
  readonly stdout: OutputChannel;
  readonly stderr: OutputChannel;
  readonly files: VirtualFileSystem;

  constructor(
    private readonly budget: ExecutionBudget,
    input: ProgramInput = {}
  ) {
    this.stdin = new StandardInput(new TextReader(input.stdin ?? '', budget));
    const written = { length: 0 };
    this.stdout = new OutputChannel(written);
    this.stderr = new OutputChannel(written);
    this.files = new VirtualFileSystem(budget);
    for (const [path, content] of Object.entries(input.files ?? {})) {
      this.files.createDirectory(parentOf(path), true);
      this.files.open(path, { create: 'always', truncate: true, append: false }).write(content);
    }
  }

  /** Opens a file to read the text it holds now, where `/dev/stdin` reads what remains of standard input. */
  openReader(path: string): TextReader {
    if (resolvePath(path) === STDIN_PATH) return this.stdin.reader;
    return this.textReader(this.files.readFile(path));
  }

  textReader(text: string): TextReader {
    return new TextReader(text, this.budget);
  }

  output(): ProgramOutput {
    return { stdout: this.stdout.text, stderr: this.stderr.text, finalFiles: this.files.snapshot() };
  }
}

export class StandardInput {
  isClosed = false;

  constructor(readonly reader: TextReader) {}
}

export class OutputChannel {
  text = '';
  /** Whether the program closed the stream, after which what it writes there is lost. */
  isClosed = false;

  /** @param written The length written to every channel of the run, which shares one limit. */
  constructor(private readonly written: { length: number }) {}

  write(text: string): void {
    if (this.isClosed) return;
    this.written.length += text.length;
    if (this.written.length > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
    this.text += text;
  }
}

/** Reads a text from its start, one UTF-16 code unit or one line at a time. */
export class TextReader {
  position = 0;

  constructor(
    readonly text: string,
    private readonly budget: ExecutionBudget
  ) {}

  get isAtEnd(): boolean {
    return this.position >= this.text.length;
  }

  /** The next code unit, or `undefined` at the end. */
  read(): string | undefined {
    this.budget.spend();
    if (this.isAtEnd) return undefined;
    return this.text[this.position++];
  }

  /** The text up to the next line terminator (`\n`, `\r\n`, or `\r`), consuming the terminator too. */
  readLine(): string | undefined {
    if (this.isAtEnd) return undefined;
    const match = /\r\n?|\n/g;
    match.lastIndex = this.position;
    const terminator = match.exec(this.text);
    const end = terminator ? terminator.index : this.text.length;
    const line = this.text.slice(this.position, end);
    this.position = terminator ? end + terminator[0].length : end;
    this.budget.spend(Math.ceil((line.length + 1) / 64));
    return line;
  }

  readRest(): string {
    const rest = this.text.slice(this.position);
    this.position = this.text.length;
    this.budget.spend(Math.ceil((rest.length + 1) / 64));
    return rest;
  }
}

/** Why a file system operation failed, named by its POSIX error code. */
export type FileSystemErrorCode = 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EINVAL';

export class FileSystemError extends Error {
  constructor(
    readonly code: FileSystemErrorCode,
    /** The path as the program gave it. */
    readonly path: string
  ) {
    super(`${code}: ${path}`);
    this.name = 'FileSystemError';
  }
}

/** How opening a file for writing treats a file that exists or not. */
export interface OpenMode {
  /** Whether to create a missing file always, never, or only when none exists, failing if one does. */
  create: 'always' | 'never' | 'exclusive';
  /** Whether to empty an existing file. */
  truncate: boolean;
  /** Whether writes go to the end of the file, rather than over its text from its start. */
  append: boolean;
}

class FileNode {
  readonly kind = 'file';
  content = '';
}

class DirectoryNode {
  readonly kind = 'directory';
  readonly children = new Map<string, FileNode | DirectoryNode>();
}

/** A file opened for writing, which keeps writing to the same file after it is renamed or deleted, as on POSIX. */
export class FileHandle {
  /** Where the next write goes, or `undefined` for the end of the file. */
  private position: number | undefined;

  constructor(
    private readonly files: VirtualFileSystem,
    private readonly node: FileNode,
    append: boolean
  ) {
    this.position = append ? undefined : 0;
  }

  write(text: string): void {
    this.files.writeAt(this.node, this.position ?? this.node.content.length, text);
    if (this.position !== undefined) this.position += text.length;
  }
}

/** An in-memory file system holding text files, whose total length is bounded by {@link LIMITS}. */
export class VirtualFileSystem {
  private readonly root = new DirectoryNode();
  /** The total length of the files' contents, including files deleted while still open. */
  private storedLength = 0;

  constructor(private readonly budget: ExecutionBudget) {}

  kindOf(path: string): 'file' | 'directory' | undefined {
    return this.lookup(path)?.kind;
  }

  readFile(path: string): string {
    const node = this.lookup(path);
    if (!node) throw new FileSystemError(this.missingCode(path), path);
    if (node.kind === 'directory') throw new FileSystemError('EISDIR', path);
    this.budget.spend(Math.ceil((node.content.length + 1) / 64));
    return node.content;
  }

  open(path: string, mode: OpenMode): FileHandle {
    const { parent, name } = this.parentOf(path);
    const existing = parent.children.get(name);
    if (existing?.kind === 'directory' || (!existing && name === '')) throw new FileSystemError('EISDIR', path);
    if (existing && mode.create === 'exclusive') throw new FileSystemError('EEXIST', path);
    if (!existing && mode.create === 'never') throw new FileSystemError('ENOENT', path);
    const node = existing ?? new FileNode();
    parent.children.set(name, node);
    if (mode.truncate) {
      this.storedLength -= node.content.length;
      node.content = '';
    }
    return new FileHandle(this, node, mode.append);
  }

  writeAt(node: FileNode, position: number, text: string): void {
    this.budget.spend(Math.ceil((text.length + 1) / 64));
    const { content } = node;
    const updated = `${content.slice(0, position)}${text}${content.slice(position + text.length)}`;
    this.storedLength += updated.length - content.length;
    if (this.storedLength > LIMITS.maxStoredLength) throw new ExecutionLimitError('storage');
    node.content = updated;
  }

  /** Creates a directory, with its missing ancestors when `recursive`, returning whether it created any. */
  createDirectory(path: string, recursive: boolean): boolean {
    if (!recursive) {
      const { parent, name } = this.parentOf(path);
      if (name === '' || parent.children.has(name)) throw new FileSystemError('EEXIST', path);
      parent.children.set(name, new DirectoryNode());
      return true;
    }
    const segments = segmentsOf(path);
    let current = this.root;
    let created = false;
    for (const [index, segment] of segments.entries()) {
      let child = current.children.get(segment);
      if (child?.kind === 'file') throw new FileSystemError(index === segments.length - 1 ? 'EEXIST' : 'ENOTDIR', path);
      if (!child) {
        child = new DirectoryNode();
        current.children.set(segment, child);
        created = true;
      }
      current = child;
    }
    return created;
  }

  /** Removes a file or an empty directory, or only one of `kind` when it is given. */
  remove(path: string, kind?: 'file' | 'directory'): void {
    const { parent, name } = this.parentOf(path);
    const node = parent.children.get(name);
    if (name === '') throw new FileSystemError(kind === 'file' ? 'EISDIR' : 'EINVAL', path);
    if (!node) throw new FileSystemError('ENOENT', path);
    if (kind === 'file' && node.kind === 'directory') throw new FileSystemError('EISDIR', path);
    if (kind === 'directory' && node.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    if (node.kind === 'directory' && node.children.size > 0) throw new FileSystemError('ENOTEMPTY', path);
    parent.children.delete(name);
  }

  /** The names in a directory, in code unit order. */
  list(path: string): string[] {
    const node = this.lookup(path);
    if (!node) throw new FileSystemError(this.missingCode(path), path);
    if (node.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    this.budget.spend(Math.ceil((node.children.size + 1) / 16));
    return [...node.children.keys()].toSorted();
  }

  /** Moves a file or a directory, replacing a file at the target, or an empty directory with a directory. */
  rename(from: string, to: string): void {
    const source = this.parentOf(from);
    const node = source.parent.children.get(source.name);
    if (!node || source.name === '') throw new FileSystemError(node ? 'EINVAL' : 'ENOENT', from);
    const target = this.parentOf(to);
    if (isInside(to, from) || target.name === '') throw new FileSystemError('EINVAL', to);
    const existing = target.parent.children.get(target.name);
    const conflict = existing && existing !== node ? replacementConflictOf(node, existing) : undefined;
    if (conflict) throw new FileSystemError(conflict, to);
    source.parent.children.delete(source.name);
    target.parent.children.set(target.name, node);
  }

  /** The files by path relative to the working directory, in path order. */
  snapshot(): Record<string, string> {
    const files: [string, string][] = [];
    const visit = (directory: DirectoryNode, prefix: string): void => {
      for (const [name, node] of directory.children) {
        if (node.kind === 'file') files.push([`${prefix}${name}`, node.content]);
        else visit(node, `${prefix}${name}/`);
      }
    };
    visit(this.root, '');
    return Object.fromEntries(files.toSorted(([a], [b]) => (a < b ? -1 : 1)));
  }

  private lookup(path: string): FileNode | DirectoryNode | undefined {
    let current: FileNode | DirectoryNode = this.root;
    for (const segment of segmentsOf(path)) {
      if (current.kind === 'file') return undefined;
      const child: FileNode | DirectoryNode | undefined = current.children.get(segment);
      if (!child) return undefined;
      current = child;
    }
    return current;
  }

  /** Why a path names nothing: a missing entry, or a file where a directory should be. */
  private missingCode(path: string): FileSystemErrorCode {
    const segments = segmentsOf(path);
    for (let length = 1; length < segments.length; length++) {
      if (this.lookup(`/${segments.slice(0, length).join('/')}`)?.kind === 'file') return 'ENOTDIR';
    }
    return 'ENOENT';
  }

  /** The directory that holds the entry a path names, where the root's name is empty. */
  private parentOf(path: string): { parent: DirectoryNode; name: string } {
    const segments = segmentsOf(path);
    const name = segments.pop() ?? '';
    const parent = segments.length === 0 ? this.root : this.lookup(`/${segments.join('/')}`);
    if (!parent) throw new FileSystemError(this.missingCode(path), path);
    if (parent.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    return { parent, name };
  }
}

/** Whether a path lies inside a directory, which a directory cannot move into. */
function isInside(path: string, directory: string): boolean {
  const [pathSegments, directorySegments] = [segmentsOf(path), segmentsOf(directory)];
  return (
    pathSegments.length > directorySegments.length &&
    directorySegments.every((segment, index) => pathSegments[index] === segment)
  );
}

/** Why an entry cannot replace another, as POSIX `rename` allows only a file over a file or a directory over an empty one. */
function replacementConflictOf(
  node: FileNode | DirectoryNode,
  existing: FileNode | DirectoryNode
): FileSystemErrorCode | undefined {
  if (existing.kind === 'file') return node.kind === 'file' ? undefined : 'ENOTDIR';
  if (node.kind === 'file') return 'EISDIR';
  return existing.children.size > 0 ? 'ENOTEMPTY' : undefined;
}

/** The absolute path that a path names, resolving `.` and `..` by its text as `java.io.File` and Node.js do. */
export function resolvePath(path: string): string {
  return `/${segmentsOf(path).join('/')}`;
}

/** The parent of a path, which is the path itself when it is the root. */
export function parentOf(path: string): string {
  return resolvePath(`${resolvePath(path)}/..`);
}

function segmentsOf(path: string): string[] {
  const absolute = path.startsWith('/') ? path : `${WORKING_DIRECTORY}/${path}`;
  const segments: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments;
}
