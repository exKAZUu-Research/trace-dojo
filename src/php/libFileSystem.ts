// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { resolvePath } from '../interpreter/programIo';
import { enc } from './bytes';
import { throwError, warn } from './errors';
import { openPath } from './libStream';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import {
  changeDirectory,
  currentDirectory,
  directoryStream,
  fileSystemFailure,
  hostPath,
  isStream,
  newStreamResource,
  openStream,
  type Stream,
  takeResourceId,
} from './streams';
import { PhpArray, type PhpObject, type Value } from './values';

const s = (value: Value): string => value as string;

defineConstant('FILE_USE_INCLUDE_PATH', 1n);
defineConstant('FILE_IGNORE_NEW_LINES', 2n);
defineConstant('FILE_SKIP_EMPTY_LINES', 4n);
defineConstant('FILE_APPEND', 8n);
defineConstant('FILE_NO_DEFAULT_CONTEXT', 16n);
defineConstant('SCANDIR_SORT_ASCENDING', 0n);
defineConstant('SCANDIR_SORT_DESCENDING', 1n);
defineConstant('SCANDIR_SORT_NONE', 2n);
// The values of glibc, which PHP on Linux takes these from.
defineConstant('GLOB_ERR', 1n);
defineConstant('GLOB_MARK', 2n);
defineConstant('GLOB_NOSORT', 4n);
defineConstant('GLOB_NOCHECK', 16n);
defineConstant('GLOB_NOESCAPE', 64n);
defineConstant('GLOB_BRACE', 1024n);
defineConstant('GLOB_ONLYDIR', 8192n);
defineConstant('GLOB_AVAILABLE_FLAGS', 9303n);

/** Opens a stream for a function that reads or writes a whole file, which takes a resource id as PHP's does. */
function withStream<T>(functionName: string, path: string, mode: string, use: (stream: Stream) => T): T | false {
  const stream = openPath(functionName, path, mode);
  if (!stream) return false;
  takeResourceId();
  return use(stream);
}

// Whole files --------------------------------------------------------------------------------------------------------

defineFunction(
  'file_get_contents(string $filename, bool $use_include_path = false, $context = null, int $offset = 0, ?int $length = null): string|false',
  ({ args }) => {
    const offset = args[3] === undefined ? 0 : Number(args[3] as bigint);
    const length = args[4] === undefined || args[4] === null ? undefined : Number(args[4] as bigint);
    if (length !== undefined && length < 0) {
      throwError('ValueError', 'file_get_contents(): Argument #5 ($length) must be greater than or equal to 0');
    }
    return withStream('file_get_contents', s(args[0]), 'rb', (stream) => {
      if (!seekTo(stream, offset)) return false;
      return length === undefined ? stream.readRest() : stream.read(length);
    });
  }
);

/** Moves to the offset `file_get_contents` starts reading at, counted from the end when negative. */
function seekTo(stream: Stream, offset: number): boolean {
  if (offset === 0) return true;
  const position = offset < 0 ? stream.length + offset : offset;
  if (position < 0 || !stream.isSeekable) {
    warn(`file_get_contents(): Failed to seek to position ${offset} in the stream`);
    return false;
  }
  stream.seek(position);
  return true;
}

defineFunction('file(string $filename, int $flags = 0, $context = null): array|false', ({ args }) => {
  const flags = args[1] === undefined ? 0n : (args[1] as bigint);
  if (flags < 0n || flags > 31n) throwError('ValueError', 'file(): Argument #2 ($flags) must be a valid flag value');
  const content = withStream('file', s(args[0]), 'rb', (stream) => stream.readRest());
  if (content === false) return false;
  return PhpArray.list(fileLines(content, (flags & 2n) === 0n, (flags & 4n) !== 0n));
});

/** The lines of a file as `file` splits them, with their line breaks or without them and their `\r`. */
function fileLines(content: string, keepNewLines: boolean, skipEmpty: boolean): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let end = content.indexOf('\n'); end !== -1; end = content.indexOf('\n', start)) {
    rt().spend();
    if (keepNewLines) lines.push(content.slice(start, end + 1));
    else {
      const lineEnd = end > 0 && content[end - 1] === '\r' ? end - 1 : end;
      if (!skipEmpty || lineEnd > start) lines.push(content.slice(start, lineEnd));
    }
    start = end + 1;
  }
  if (start < content.length) lines.push(content.slice(start));
  return lines;
}

defineFunction(
  'file_put_contents(string $filename, mixed $data, int $flags = 0, $context = null): int|false',
  ({ args }) => {
    const flags = args[2] === undefined ? 0n : (args[2] as bigint);
    const data = contentsOf(args[1]);
    return withStream('file_put_contents', s(args[0]), (flags & 8n) === 0n ? 'wb' : 'ab', (stream) => {
      if (data !== '') stream.write(data);
      return BigInt(data.length);
    });
  }
);

/** The bytes `file_put_contents` writes for its data: a string, the strings of an array, or what a stream has left. */
function contentsOf(data: Value): string {
  if (data instanceof PhpArray) {
    let result = '';
    for (const value of data.iterValues()) result += toStr(value);
    return result;
  }
  if (isStream(data)) return openStream(data, 'file_put_contents', '$data').readRest();
  return toStr(data);
}

defineFunction('readfile(string $filename, bool $use_include_path = false, $context = null): int|false', ({ args }) =>
  withStream('readfile', s(args[0]), 'rb', (stream) => {
    const content = stream.readRest();
    rt().echo(content);
    return BigInt(content.length);
  })
);

defineFunction('copy(string $from, string $to, $context = null): bool', ({ args }) => {
  const from = s(args[0]);
  const to = s(args[1]);
  const files = rt().io.files;
  if (files.kindOf(hostPath(from)) === 'directory') {
    warn('copy(): The first argument to copy() function cannot be a directory');
    return false;
  }
  if (files.isSameFile(hostPath(from), hostPath(to))) return true;
  const source = withStream('copy', from, 'rb', (stream) => stream.readRest());
  if (source === false) return false;
  return withStream('copy', to, 'wb', (stream) => {
    if (source !== '') stream.write(source);
    return true;
  });
});

// Entries ------------------------------------------------------------------------------------------------------------

/** What a path names, or `undefined` when it names nothing or cannot name a file. */
function kindOf(path: string): 'file' | 'directory' | undefined {
  if (path === '' || path.includes('\0')) return undefined;
  return rt().io.files.kindOf(hostPath(path));
}

defineFunction('file_exists(string $filename): bool', ({ args }) => kindOf(s(args[0])) !== undefined);
defineFunction('is_file(string $filename): bool', ({ args }) => kindOf(s(args[0])) === 'file');
defineFunction('is_dir(string $filename): bool', ({ args }) => kindOf(s(args[0])) === 'directory');
defineFunction('is_readable(string $filename): bool', ({ args }) => kindOf(s(args[0])) !== undefined);
defineFunction('is_writable(string $filename): bool', ({ args }) => kindOf(s(args[0])) !== undefined);
defineFunction('is_writeable(string $filename): bool', ({ args }) => kindOf(s(args[0])) !== undefined);

defineFunction('filesize(string $filename): int|false', ({ args }) => {
  const path = s(args[0]);
  const kind = kindOf(path);
  if (kind === undefined) {
    warn(`filesize(): stat failed for ${path}`);
    return false;
  }
  // Linux reports the size of a directory as the size of its first block.
  if (kind === 'directory') return 4096n;
  return BigInt(enc(rt().io.files.readFile(hostPath(path))).length);
});

defineFunction('touch(string $filename, ?int $mtime = null, ?int $atime = null): bool', ({ args }) => {
  const path = s(args[0]);
  const failure = fileSystemFailure(() => {
    rt().io.files.open(hostPath(path), { create: 'always', truncate: false, append: true });
  });
  if (failure) warn(`touch(): Unable to create file ${path} because ${failure}`);
  return failure === undefined;
});

defineFunction('unlink(string $filename, $context = null): bool', ({ args }) => {
  const path = s(args[0]);
  const failure = fileSystemFailure(() => rt().io.files.remove(hostPath(path), 'file'));
  if (failure) warn(`unlink(${path}): ${failure}`);
  return failure === undefined;
});

defineFunction('rename(string $from, string $to, $context = null): bool', ({ args }) => {
  const from = s(args[0]);
  const to = s(args[1]);
  const failure = fileSystemFailure(() => rt().io.files.rename(hostPath(from), hostPath(to)));
  if (failure) warn(`rename(${from},${to}): ${failure}`);
  return failure === undefined;
});

// Directories --------------------------------------------------------------------------------------------------------

defineFunction(
  'mkdir(string $directory, int $permissions = 0777, bool $recursive = false, $context = null): bool',
  ({ args }) => {
    const path = hostPath(s(args[0]));
    const files = rt().io.files;
    const failure =
      args[2] === true && files.kindOf(path) !== undefined
        ? 'File exists'
        : fileSystemFailure(() => files.createDirectory(path, args[2] === true));
    if (failure) warn(`mkdir(): ${failure}`);
    return failure === undefined;
  }
);

defineFunction('rmdir(string $directory, $context = null): bool', ({ args }) => {
  const path = s(args[0]);
  const failure = fileSystemFailure(() => rt().io.files.remove(hostPath(path), 'directory'));
  if (failure) warn(`rmdir(${path}): ${failure}`);
  return failure === undefined;
});

/** The entries of a directory with `.` and `..`, sorted by their bytes as PHP's `scandir` sorts them. */
function directoryEntries(functionName: string, path: string): string[] | undefined {
  let names: string[] = [];
  const failure = fileSystemFailure(() => {
    names = rt().io.files.list(hostPath(path));
  });
  if (failure) {
    warn(`${functionName}(${path}): Failed to open directory: ${failure}`);
    return undefined;
  }
  return ['.', '..', ...names.map((name) => enc(name))].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

defineFunction(
  'scandir(string $directory, int $sorting_order = SCANDIR_SORT_ASCENDING, $context = null): array|false',
  ({ args }) => {
    const path = s(args[0]);
    const names = directoryEntries('scandir', path);
    if (!names) {
      const failure = fileSystemFailure(() => rt().io.files.list(hostPath(path))) as string;
      warn(`scandir(): (errno ${ERRNO[failure] ?? 0}): ${failure}`);
      return false;
    }
    takeResourceId();
    return PhpArray.list(args[1] === 1n ? names.toReversed() : names);
  }
);

const ERRNO: Record<string, number> = { 'No such file or directory': 2, 'Not a directory': 20 };

defineFunction('opendir(string $directory, $context = null)', ({ args }) => {
  const names = directoryEntries('opendir', s(args[0]));
  if (!names) return false;
  const stream = directoryStream(names);
  const handle = newStreamResource(stream);
  lastDirectories.set(rt(), handle);
  return handle;
});

/** The directory handle `opendir` opened last, which the directory functions use when given none. */
const lastDirectories = new WeakMap<object, PhpObject>();

function directoryOf(value: Value, functionName: string): { names: string[]; index: number } {
  const handle = value === undefined || value === null ? lastDirectories.get(rt()) : (value as PhpObject);
  if (!handle)
    throwError('TypeError', `${functionName}(): Argument #1 ($dir_handle) must be a valid Directory resource`);
  const { directory } = openStream(handle, functionName, '$dir_handle');
  if (!directory) {
    throwError('TypeError', `${functionName}(): Argument #1 ($dir_handle) must be a valid Directory resource`);
  }
  return directory;
}

defineFunction('readdir($dir_handle = null): string|false', ({ args }) => {
  const directory = directoryOf(args[0], 'readdir');
  return directory.names[directory.index++] ?? false;
});
defineFunction('rewinddir($dir_handle = null): void', ({ args }) => {
  directoryOf(args[0], 'rewinddir').index = 0;
  return null;
});
defineFunction('closedir($dir_handle = null): void', ({ args }) => {
  directoryOf(args[0], 'closedir');
  const handle = (args[0] ?? lastDirectories.get(rt())) as PhpObject;
  openStream(handle, 'closedir', '$dir_handle').isClosed = true;
  return null;
});

defineFunction('getcwd(): string|false', () => enc(currentDirectory()));
defineFunction('chdir(string $directory): bool', ({ args }) => {
  const path = hostPath(s(args[0]));
  const kind = rt().io.files.kindOf(path);
  if (kind !== 'directory') {
    const message = kind === 'file' ? 'Not a directory' : 'No such file or directory';
    warn(`chdir(): ${message} (errno ${ERRNO[message]})`);
    return false;
  }
  changeDirectory(path);
  return true;
});
defineFunction('realpath(string $path): string|false', ({ args }) => {
  const path = hostPath(s(args[0]) || '.');
  if (rt().io.files.kindOf(path) === undefined) return false;
  return enc(resolvePath(path));
});

// code-gauge-allow functionCognitiveComplexity -- Applies each of the glob flags in the order glibc does.
defineFunction('glob(string $pattern, int $flags = 0): array|false', ({ args }) => {
  const flags = args[1] === undefined ? 0n : (args[1] as bigint);
  const pattern = s(args[0]);
  const patterns = (flags & 1024n) === 0n ? [pattern] : expandBraces(pattern);
  const matches = new Set<string>();
  for (const each of patterns) for (const match of globMatches(each, (flags & 64n) === 0n)) matches.add(match);
  let paths = [...matches];
  if ((flags & 8192n) !== 0n) paths = paths.filter((path) => kindOf(path) === 'directory');
  if ((flags & 2n) !== 0n) paths = paths.map((path) => (kindOf(path) === 'directory' ? `${path}/` : path));
  if ((flags & 4n) === 0n && (flags & 1024n) === 0n) paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.length === 0 && (flags & 16n) !== 0n) paths = [pattern];
  return PhpArray.list(paths);
});

/** The patterns that GLOB_BRACE makes of a pattern, in the order glibc tries them. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  const commas: number[] = [];
  for (let index = open; index < pattern.length; index++) {
    if (pattern[index] === '{') depth++;
    else if (pattern[index] === '}' && --depth === 0) {
      const options: string[] = [];
      let start = open + 1;
      for (const comma of commas) {
        options.push(pattern.slice(start, comma));
        start = comma + 1;
      }
      options.push(pattern.slice(start, index));
      const rest = pattern.slice(index + 1);
      return options.flatMap((option) => expandBraces(pattern.slice(0, open) + option + rest));
    } else if (pattern[index] === ',' && depth === 1) commas.push(index);
  }
  return [pattern];
}

/** The paths that a pattern matches, walking the directories that its names match one at a time. */
function globMatches(pattern: string, escapes: boolean): string[] {
  const names = pattern.split('/').filter((name) => name !== '');
  let prefixes = [pattern.startsWith('/') ? '/' : ''];
  for (const name of names) {
    const regex = /[*?[]/.test(name) ? globRegex(name, escapes) : undefined;
    const next = prefixes.flatMap((prefix) =>
      regex ? matchingEntries(prefix, regex, name.startsWith('.')).map((entry) => prefix + entry) : [prefix + name]
    );
    prefixes = next.map((path) => (path.endsWith('/') ? path : `${path}/`));
  }
  return prefixes
    .map((path) => (path === '/' ? path : path.slice(0, -1)))
    .filter((path) => path !== '' && kindOf(path) !== undefined);
}

/** The names in a directory that a pattern's name matches, where only a name starting with `.` matches hidden ones. */
function matchingEntries(directory: string, regex: RegExp, matchesHidden: boolean): string[] {
  const path = directory === '' ? '.' : directory;
  if (kindOf(path) !== 'directory') return [];
  return rt()
    .io.files.list(hostPath(path))
    .map((entry) => enc(entry))
    .filter((entry) => (matchesHidden || !entry.startsWith('.')) && regex.test(entry));
}

function globRegex(name: string, escapes: boolean): RegExp {
  let source = '';
  for (let index = 0; index < name.length; index++) {
    const char = name[index] as string;
    if (char === '*') source += '[^]*';
    else if (char === '?') source += '[^]';
    else if (char === '[') {
      const end = name.indexOf(']', index + 2);
      if (end === -1) source += String.raw`\[`;
      else {
        const body = name
          .slice(index + 1, end)
          .replace(/^!/, '^')
          .replaceAll('\\', String.raw`\\`);
        source += `[${body}]`;
        index = end;
      }
    } else if (char === '\\' && escapes && index + 1 < name.length) {
      source += escapeRegex(name[++index] as string);
    } else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(char: string): string {
  return char.replaceAll(/[$()*+.?[\\\]^{|}/-]/g, String.raw`\$&`);
}

// Paths, which these functions handle as strings without touching any file ------------------------------------------

defineFunction('basename(string $path, string $suffix = ""): string', ({ args }) =>
  basenameOf(s(args[0]), args[1] === undefined ? '' : s(args[1]))
);

export function basenameOf(fullPath: string, suffix = ''): string {
  let path = fullPath.replace(/\/+$/, '');
  path = path.slice(path.lastIndexOf('/') + 1);
  if (suffix !== '' && path.endsWith(suffix) && path !== suffix) path = path.slice(0, -suffix.length);
  return path;
}

defineFunction('dirname(string $path, int $levels = 1): string', ({ args }) => {
  const levels = (args[1] as bigint | undefined) ?? 1n;
  if (levels < 1n) throwError('ValueError', 'dirname(): Argument #2 ($levels) must be greater than or equal to 1');
  return dirnameOf(s(args[0]), levels);
});

defineConstant('PATHINFO_DIRNAME', 1n);
defineConstant('PATHINFO_BASENAME', 2n);
defineConstant('PATHINFO_EXTENSION', 4n);
defineConstant('PATHINFO_FILENAME', 8n);
defineConstant('PATHINFO_ALL', 15n);

defineFunction('pathinfo(string $path, int $flags = PATHINFO_ALL): array|string', ({ args }) => {
  const path = s(args[0]);
  const flags = args[1] === undefined ? 15n : (args[1] as bigint);
  const parts = new PhpArray();
  if ((flags & 1n) !== 0n) {
    const directory = dirnameOf(path);
    if (directory !== '') parts.set('dirname', directory);
  }
  const base = basenameOf(path);
  if ((flags & 2n) !== 0n) parts.set('basename', base);
  const dot = base.lastIndexOf('.');
  if ((flags & 4n) !== 0n && dot !== -1) parts.set('extension', base.slice(dot + 1));
  if ((flags & 8n) !== 0n) parts.set('filename', dot === -1 ? base : base.slice(0, dot));
  if (flags === 15n) return parts;
  return parts.size > 0 ? (parts.iterValues().next().value as Value) : '';
});

export function dirnameOf(path: string, levels = 1n): string {
  if (path === '') return '';
  let end = path.length;
  for (let level = 0n; level < levels; level++) {
    rt().spend();
    while (end > 0 && path[end - 1] === '/') end--;
    if (end === 0) return path.startsWith('/') ? '/' : '.';
    end = path.lastIndexOf('/', end - 1);
    if (end === -1) return '.';
  }
  while (end > 0 && path[end - 1] === '/') end--;
  return end === 0 ? '/' : path.slice(0, end);
}
