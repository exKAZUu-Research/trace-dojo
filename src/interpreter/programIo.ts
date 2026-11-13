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
    const stdin = input.stdin ?? '';
    this.stdin = new StandardInput(new TextReader(() => stdin, budget));
    const written = { length: 0 };
    this.stdout = new OutputChannel(written);
    this.stderr = new OutputChannel(written);
    this.files = new VirtualFileSystem(budget);
    for (const [path, content] of Object.entries(input.files ?? {})) {
      this.files.createDirectory(parentOf(path), true);
      this.files.open(path, { create: 'always', truncate: true, append: false }).write(content);
    }
  }

  /**
   * Opens a file to read, which reads what the file holds as it reads, as a POSIX file descriptor does, and where
   * `/dev/stdin` reads what remains of standard input.
   */
  openReader(path: string): TextReader {
    if (resolvePath(path) === STDIN_PATH) return this.stdin.reader;
    return new TextReader(this.files.openForReading(path), this.budget);
  }

  textReader(text: string): TextReader {
    return new TextReader(() => text, this.budget);
  }

  /** A reader of a text that arrives in parts, which `refill` adds when the reader has read the text so far. */
  partReader(source: () => string, refill: () => boolean): TextReader {
    return new TextReader(source, this.budget, refill);
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

  /**
   * @param source The text as it is now, which a file's writes may change while it is read.
   * @param refill Adds more text to the source when the reader has read all of it, telling whether it added any, for
   * a reader that reads ahead from another one in parts.
   */
  constructor(
    private readonly source: () => string,
    private readonly budget: ExecutionBudget,
    private readonly refill?: () => boolean
  ) {}

  get text(): string {
    return this.source();
  }

  /** Whether no text remains, after refilling the source when it can. */
  get isAtEnd(): boolean {
    while (this.position >= this.text.length) {
      if (!this.refill?.()) return true;
    }
    return false;
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
    for (;;) {
      const { text } = this;
      const match = /\r\n?|\n/g;
      match.lastIndex = this.position;
      const terminator = match.exec(text);
      // A line, or a `\r` that a `\n` may follow, that reaches the end of the text may continue in the next part.
      const isComplete = terminator && (terminator[0] !== '\r' || terminator.index + 1 < text.length);
      if (isComplete || !this.refill?.()) {
        const end = terminator ? terminator.index : text.length;
        const line = text.slice(this.position, end);
        this.position = terminator ? end + terminator[0].length : end;
        this.budget.spend(Math.ceil((line.length + 1) / 64));
        return line;
      }
    }
  }

  readRest(): string {
    while (this.refill?.()) {
      // Each refill adds a part until none remains.
    }
    const { text } = this;
    const rest = text.slice(this.position);
    this.position = text.length;
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
  /** Whether a path names the file, whose contents then count as stored; a deleted file counts only what is written. */
  isLinked = true;
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

type FileSystemNode = FileNode | DirectoryNode;

/**
 * Where a path leads: the directory holding its entry, the entry's name (empty for the root), the entry, and the
 * names of the absolute path to it.
 */
interface Location {
  parent: DirectoryNode;
  name: string;
  node: FileSystemNode | undefined;
  names: string[];
  /** Whether the path must name a directory, as one ending with `/`, `.`, or `..` does. */
  namesDirectory: boolean;
  /** The path's last name when it is `.` or `..`, which names a directory but no entry to remove or rename. */
  dots: '.' | '..' | undefined;
}

/** A directory that a walk down a path has entered, with its name in its parent. */
interface Step {
  directory: DirectoryNode;
  name: string;
}

/**
 * An in-memory file system holding text files, whose total length is bounded by {@link LIMITS}. Each call charges
 * the run for the names of its paths, which a program can make as long as its strings.
 */
export class VirtualFileSystem {
  private readonly root = new DirectoryNode();
  /** The total length of the files' contents and of all the program writes to files it deleted while open. */
  private storedLength = 0;

  constructor(private readonly budget: ExecutionBudget) {}

  kindOf(path: string): 'file' | 'directory' | undefined {
    try {
      return this.locate(path).node?.kind;
    } catch (error) {
      if (error instanceof FileSystemError) return undefined;
      throw error;
    }
  }

  readFile(path: string): string {
    const content = this.fileNodeOf(path).content;
    this.budget.spend(Math.ceil((content.length + 1) / 64));
    return content;
  }

  /** The text of a file as it is whenever it is called, which follows the file after a rename or a deletion. */
  openForReading(path: string): () => string {
    const node = this.fileNodeOf(path);
    return () => node.content;
  }

  open(path: string, mode: OpenMode): FileHandle {
    const { parent, name, node: existing, namesDirectory } = this.locate(path);
    if (existing && mode.create === 'exclusive') throw new FileSystemError('EEXIST', path);
    if (existing?.kind === 'directory' || name === '' || namesDirectory) throw new FileSystemError('EISDIR', path);
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
    this.budget.spend(Math.ceil((text.length + Math.max(position - node.content.length, 0) + 1) / 64));
    // Writing past the end, as a handle may after another truncates the file, leaves a gap of NUL characters.
    const content = node.content.padEnd(text === '' ? 0 : position, '\0');
    const updated = `${content.slice(0, position)}${text}${content.slice(position + text.length)}`;
    const gap = Math.max(position - node.content.length, 0);
    this.storedLength += node.isLinked ? updated.length - node.content.length : text.length + gap;
    if (this.storedLength > LIMITS.maxStoredLength) throw new ExecutionLimitError('storage');
    node.content = updated;
  }

  /**
   * Creates a directory, with its missing ancestors when `recursive`, returning the absolute path of the first
   * directory it created, or `undefined` when all of them existed.
   */
  createDirectory(path: string, recursive: boolean): string | undefined {
    if (!recursive) {
      const { parent, name, node, names } = this.locate(path);
      if (name === '' || node) throw new FileSystemError('EEXIST', path);
      parent.children.set(name, new DirectoryNode());
      return `/${names.join('/')}`;
    }
    const { components } = this.componentsOf(path);
    const steps: Step[] = [{ directory: this.root, name: '' }];
    let firstCreated: string | undefined;
    for (const [index, name] of components.entries()) {
      const current = (steps.at(-1) as Step).directory;
      if (name !== '.' && name !== '..' && !current.children.has(name)) {
        current.children.set(name, new DirectoryNode());
        firstCreated ??= `/${[...steps.slice(1).map((step) => step.name), name].join('/')}`;
      }
      if (current.children.get(name)?.kind === 'file' && index === components.length - 1) {
        throw new FileSystemError('EEXIST', path);
      }
      this.enter(steps, name, path);
    }
    return firstCreated;
  }

  /** Whether two paths name one file or directory, where a path that names nothing names no file. */
  isSameFile(path: string, other: string): boolean {
    try {
      const { node } = this.locate(path);
      return node !== undefined && node === this.locate(other).node;
    } catch (error) {
      if (error instanceof FileSystemError) return false;
      throw error;
    }
  }

  /** Removes a file or an empty directory, or only one of `kind` when it is given. */
  remove(path: string, kind?: 'file' | 'directory'): void {
    const { parent, name, node, dots } = this.locate(path);
    if (name === '' || (dots && kind !== 'file')) {
      throw new FileSystemError(kind === 'file' ? 'EISDIR' : dots === '..' ? 'ENOTEMPTY' : 'EINVAL', path);
    }
    if (!node) throw new FileSystemError('ENOENT', path);
    if (kind === 'file' && node.kind === 'directory') throw new FileSystemError('EISDIR', path);
    if (kind === 'directory' && node.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    if (node.kind === 'directory' && node.children.size > 0) throw new FileSystemError('ENOTEMPTY', path);
    parent.children.delete(name);
    this.release(node);
  }

  /** The names in a directory, in code unit order. */
  list(path: string): string[] {
    const { node } = this.locate(path);
    if (!node) throw new FileSystemError('ENOENT', path);
    if (node.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    this.budget.spend(Math.ceil((node.children.size + 1) / 16));
    return [...node.children.keys()].toSorted();
  }

  /** Moves a file or a directory, replacing a file at the target, or an empty directory with a directory. */
  rename(from: string, to: string): void {
    const source = this.locate(from);
    if (!source.node || source.name === '' || source.dots) {
      throw new FileSystemError(source.node ? 'EINVAL' : 'ENOENT', from);
    }
    const target = this.locate(to);
    if (isInside(target.names, source.names) || target.name === '' || target.dots) {
      throw new FileSystemError('EINVAL', to);
    }
    const { node } = source;
    const existing = target.node;
    if (node.kind === 'file' && target.namesDirectory) throw new FileSystemError('ENOTDIR', to);
    if (existing === node) return;
    const conflict = existing ? replacementConflictOf(node, existing) : undefined;
    if (conflict) throw new FileSystemError(conflict, to);
    source.parent.children.delete(source.name);
    target.parent.children.set(target.name, node);
    if (existing) this.release(existing);
  }

  /** The files by path relative to the working directory, in path order. */
  snapshot(): Record<string, string> {
    const files: [string, string][] = [];
    // An explicit stack, since a program may nest directories deeper than the host's call stack.
    const pending: [DirectoryNode, string][] = [[this.root, '']];
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      const [directory, prefix] = entry;
      for (const [name, node] of directory.children) {
        if (node.kind === 'file') files.push([`${prefix}${name}`, node.content]);
        else pending.push([node, `${prefix}${name}/`]);
      }
    }
    return Object.fromEntries(files.toSorted(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** Stops counting the contents of a file that no path names, though a handle may still write to it. */
  private release(node: FileSystemNode): void {
    if (node.kind !== 'file') return;
    this.storedLength -= node.content.length;
    node.isLinked = false;
  }

  private fileNodeOf(path: string): FileNode {
    const { node } = this.locate(path);
    if (!node) throw new FileSystemError('ENOENT', path);
    if (node.kind === 'directory') throw new FileSystemError('EISDIR', path);
    return node;
  }

  /**
   * Walks a path once, name by name as Linux resolves one, so that `..` leaves a directory only after entering it,
   * failing when a directory on the way is missing or is a file.
   */
  private locate(path: string): Location {
    const { components, namesDirectory, dots } = this.componentsOf(path);
    const last = components.pop();
    const steps: Step[] = [{ directory: this.root, name: '' }];
    for (const name of components) this.enter(steps, name, path);
    if (last === '..' && steps.length > 1) steps.pop();
    const names = steps.slice(1).map((step) => step.name);
    if (last === undefined || last === '.' || last === '..') {
      // The path names a directory it walked through, as `a/.` names `a` and `a/..` the directory holding `a`.
      const { directory, name } = steps.at(-1) as Step;
      return { parent: steps.at(-2)?.directory ?? this.root, name, node: directory, names, namesDirectory, dots };
    }
    const parent = (steps.at(-1) as Step).directory;
    const node = parent.children.get(last);
    if (namesDirectory && node?.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    return { parent, name: last, node, names: [...names, last], namesDirectory, dots };
  }

  /**
   * Enters the directory a name names, stays with `.`, or with `..` leaves the current one, which the root never
   * does.
   */
  private enter(steps: Step[], name: string, path: string): void {
    if (name === '.') return;
    if (name === '..') {
      if (steps.length > 1) steps.pop();
      return;
    }
    const child = (steps.at(-1) as Step).directory.children.get(name);
    if (!child) throw new FileSystemError('ENOENT', path);
    if (child.kind === 'file') throw new FileSystemError('ENOTDIR', path);
    steps.push({ directory: child, name });
  }

  /**
   * The names of a path from the root, keeping `.` and `..` for the walk to resolve, and whether the path must name a
   * directory, while charging the run for reading the path and walking its names.
   */
  private componentsOf(path: string): {
    components: string[];
    namesDirectory: boolean;
    dots: '.' | '..' | undefined;
  } {
    this.budget.spend(Math.ceil((path.length + 1) / 16));
    const absolute = path.startsWith('/') ? path : `${WORKING_DIRECTORY}/${path}`;
    const raw = absolute.split('/');
    const components = raw.filter((name) => name !== '');
    this.budget.spend(components.length);
    // The last name decides the dots, which trailing slashes do not change.
    const last = components.at(-1);
    const dots = last === '.' || last === '..' ? last : undefined;
    return { components, namesDirectory: raw.at(-1) === '' || dots !== undefined, dots };
  }
}

/** Whether a path lies inside a directory, which a directory cannot move into, both given by their names. */
function isInside(pathSegments: readonly string[], directorySegments: readonly string[]): boolean {
  return (
    pathSegments.length > directorySegments.length &&
    directorySegments.every((segment, index) => pathSegments[index] === segment)
  );
}

/** Why an entry cannot replace another, as POSIX `rename` allows only a file over a file or a directory over an empty one. */
function replacementConflictOf(node: FileSystemNode, existing: FileSystemNode): FileSystemErrorCode | undefined {
  if (existing.kind === 'file') return node.kind === 'file' ? undefined : 'ENOTDIR';
  if (node.kind === 'file') return 'EISDIR';
  return existing.children.size > 0 ? 'ENOTEMPTY' : undefined;
}

/** The absolute path that a path names by its text, which needs no file system, as for `/dev/stdin` and input files. */
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
