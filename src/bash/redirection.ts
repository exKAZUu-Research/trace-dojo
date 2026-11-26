import { FileSystemError, type FileSystemErrorCode, type OpenMode, resolvePath } from '../interpreter/programIo';
import type { Redirect, Word } from './ast';
import { DescriptorTable, nullFile, type OpenFile } from './descriptors';
import { descriptorOfPath } from './fileTests';
import type { Shell } from './shell';

/** A redirection that failed, whose message Bash prints before skipping the command with status 1. */
export class RedirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectionError';
  }
}

const FILE_SYSTEM_MESSAGES: Record<FileSystemErrorCode, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
};

/** The message Bash prints for a failed file operation on `path`, as `strerror` words it. */
export function fileSystemMessage(error: FileSystemError): string {
  return FILE_SYSTEM_MESSAGES[error.code];
}

/**
 * Applies redirections to the shell's descriptors in order, as Bash does after expanding a command's words, throwing
 * a `RedirectionError` at the first that fails. Adds to `changed` each descriptor that the command's end restores:
 * all but those a `{name}` redirection opens or closes, which Bash leaves as they are.
 */
export function applyRedirects(shell: Shell, redirects: readonly Redirect[], changed: number[] = []): void {
  for (const redirect of redirects) applyRedirect(shell, redirect, changed);
}

function applyRedirect(shell: Shell, redirect: Redirect, changed: number[]): void {
  if (redirect.kind === 'close') {
    if (redirect.fdVariable) shell.fds.close(descriptorOfVariable(shell, redirect.fdVariable));
    else {
      changed.push(redirect.fd);
      shell.fds.close(redirect.fd);
    }
    return;
  }
  const file = openRedirectTarget(shell, redirect);
  if (redirect.fdVariable && file !== 'close') {
    const fd = shell.fds.allocate();
    shell.fds.set(fd, file);
    shell.assignVariable(redirect.fdVariable, String(fd));
    return;
  }
  changed.push(redirect.fd);
  if (file === 'close') {
    shell.fds.close(redirect.fd);
    return;
  }
  shell.fds.set(redirect.fd, file);
  if (redirect.kind === 'file' && (redirect.operator === '&>' || redirect.operator === '&>>')) {
    changed.push(2);
    shell.fds.set(2, file);
  }
}

// code-gauge-allow functionCognitiveComplexity -- One case per redirection operator, as Bash's `do_redirection_internal` has.
function openRedirectTarget(shell: Shell, redirect: Exclude<Redirect, { kind: 'close' }>): OpenFile | 'close' {
  switch (redirect.kind) {
    case 'text': {
      const text = shell.expander.expandString(redirect.body);
      return { input: shell.runtime.io.textReader(redirect.appendsNewline ? `${text}\n` : text) };
    }
    case 'file': {
      const path = expandTarget(shell, redirect.target);
      return openPath(shell, path, redirect.operator);
    }
    case 'duplicate': {
      const target = expandTarget(shell, redirect.target);
      if (target === '-') return 'close';
      const copy = /^(\d+)(-?)$/.exec(target);
      if (copy) {
        const source = Number(copy[1]);
        const file = shell.fds.get(source);
        if (!file) throw new RedirectionError(`${copy[1]}: Bad file descriptor`);
        if (copy[2] === '-' && source !== redirect.fd) shell.fds.close(source);
        return file;
      }
      if (redirect.operator === '>&' && !redirect.hasDescriptor && !redirect.fdVariable) {
        const file = openPath(shell, target, '>');
        shell.fds.set(2, file);
        return file;
      }
      throw new RedirectionError(`${redirect.target.text}: ambiguous redirect`);
    }
  }
}

function expandTarget(shell: Shell, word: Word): string {
  const fields = shell.expander.expandWords([word]);
  if (fields.length !== 1) throw new RedirectionError(`${word.text}: ambiguous redirect`);
  return fields[0];
}

const MODES: Record<Extract<Redirect, { kind: 'file' }>['operator'], OpenMode | 'read'> = {
  '<': 'read',
  '<>': { create: 'always', truncate: false, append: false },
  '>': { create: 'always', truncate: true, append: false },
  '>|': { create: 'always', truncate: true, append: false },
  '&>': { create: 'always', truncate: true, append: false },
  '>>': { create: 'always', truncate: false, append: true },
  '&>>': { create: 'always', truncate: false, append: true },
};

/** Opens a path for a redirection, where `/dev/null`, `/dev/std*`, and `/dev/fd/N` name devices and descriptors. */
// code-gauge-allow functionNcss -- Resolves devices, descriptor paths, noclobber, and the read, write, and read-write modes of one redirection.
export function openPath(
  shell: Shell,
  path: string,
  operator: Extract<Redirect, { kind: 'file' }>['operator']
): OpenFile {
  const { io } = shell.runtime;
  if (path === '') throw new RedirectionError(': No such file or directory');
  const absolute = shell.absolutePath(path);
  const device = resolvePath(absolute);
  if (device === '/dev/null') return nullFile(io.textReader(''));
  const descriptor = descriptorOfPath(device);
  if (descriptor !== undefined) {
    const file = shell.fds.get(descriptor);
    if (!file) throw new RedirectionError(`${path}: No such file or directory`);
    return file;
  }
  if (device.startsWith('/dev/')) shell.rejectDevice(device);
  const mode = MODES[operator];
  try {
    if (mode === 'read') return { input: io.openReader(absolute) };
    const clobbers = operator === '>' || operator === '&>';
    if (clobbers && shell.options.noclobber && io.files.kindOf(absolute) === 'file') {
      throw new RedirectionError(`${path}: cannot overwrite existing file`);
    }
    const handle = io.files.open(absolute, mode);
    if (operator !== '<>') return { output: handle };
    const input = io.openReader(absolute);
    return {
      input,
      output: {
        write: (text) => {
          handle.writeAt(input.position, text);
          input.position += text.length;
        },
      },
    };
  } catch (error) {
    if (error instanceof FileSystemError) throw new RedirectionError(`${path}: ${fileSystemMessage(error)}`);
    throw error;
  }
}

function descriptorOfVariable(shell: Shell, name: string): number {
  const value = shell.readNamed(name);
  if (value === undefined || !/^\d+$/.test(value)) throw new RedirectionError(`${value ?? ''}: ambiguous redirect`);
  return Number(value);
}

/** The descriptors a run starts with: standard input, output, and error. */
export function initialDescriptors(shell: Pick<Shell, 'runtime'>): DescriptorTable {
  const { io } = shell.runtime;
  return new DescriptorTable([
    [0, { input: io.stdin.reader }],
    [1, { output: io.stdout }],
    [2, { output: io.stderr }],
  ]);
}
