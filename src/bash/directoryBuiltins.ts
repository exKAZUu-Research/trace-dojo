import { resolvePath } from '../interpreter/programIo';
import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedHostEnv } from './capabilities';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

const CD_USAGE = 'cd [-L|[-P [-e]]] [-@] [dir]';
const DIRS_USAGE = 'dirs [-clpv] [+N] [-N]';

/**
 * `cd`, which changes the working directory in the run's file system, where the program starts at `/`. A relative
 * path starts from the working directory, and `..` leaves a directory by its name, as `cd -L` does.
 */
export const cdBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'cd', args, 'LPe@', CD_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { operands } = parsed;
  if (operands.length > 1) {
    shell.reportError('cd: too many arguments');
    return 2;
  }
  const [operand] = operands;
  if (operand === undefined) rejectUnsupportedHostEnv('HOME');
  if (operand === '-') {
    const previous = shell.store.previousDirectory;
    if (previous === undefined) {
      shell.reportError('cd: OLDPWD not set');
      return 1;
    }
    if (!changeDirectory(shell, 'cd', previous, previous)) return 1;
    shell.fd1.write(`${shell.store.workingDirectory}\n`);
    return 0;
  }
  return changeDirectory(shell, 'cd', operand, operand) ? 0 : 1;
};

/** Changes the working directory, reporting a path that names no directory as `builtin: shown: reason`. */
function changeDirectory(shell: Shell, builtin: string, path: string, shown: string): boolean {
  const target = resolvePath(path.startsWith('/') ? path : `${shell.store.workingDirectory}/${path}`);
  const kind = path === '' ? 'directory' : shell.runtime.io.files.kindOf(target);
  if (kind !== 'directory') {
    shell.reportError(`${builtin}: ${shown}: ${kind === 'file' ? 'Not a directory' : 'No such file or directory'}`);
    return false;
  }
  if (path === '') return true;
  shell.store.previousDirectory = shell.store.workingDirectory;
  shell.store.workingDirectory = target;
  return true;
}

export const pwdBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'pwd', args, 'LP', 'pwd [-LP]');
  if (typeof parsed === 'number') return parsed;
  shell.fd1.write(`${shell.store.workingDirectory}\n`);
  return 0;
};

/** `pushd`, which changes to a directory and remembers the one it left, or with no operand swaps the top two. */
export const pushdBuiltin: Builtin = (shell, args) => {
  const operands = args[0] === '--' ? args.slice(1) : args;
  const stack = shell.store.directoryStack;
  const [operand] = operands;
  if (operand === undefined) {
    const [next] = stack;
    if (next === undefined) {
      shell.reportError('pushd: no other directory');
      return 1;
    }
    const current = shell.store.workingDirectory;
    if (!changeDirectory(shell, 'pushd', next, next)) return 1;
    stack[0] = current;
    return printStack(shell, 'plain');
  }
  const rotation = stackIndex(shell, operand);
  if (rotation !== undefined) {
    if (rotation === 'invalid') return 1;
    const all = [shell.store.workingDirectory, ...stack];
    const rotated = [...all.slice(rotation), ...all.slice(0, rotation)];
    if (!changeDirectory(shell, 'pushd', rotated[0], rotated[0])) return 1;
    stack.splice(0, stack.length, ...rotated.slice(1));
    return printStack(shell, 'plain');
  }
  const current = shell.store.workingDirectory;
  if (!changeDirectory(shell, 'pushd', operand, operand)) return 1;
  stack.unshift(current);
  return printStack(shell, 'plain');
};

/** `popd`, which returns to the directory `pushd` remembered last, or removes the one `+N` or `-N` names. */
export const popdBuiltin: Builtin = (shell, args) => {
  const operands = args[0] === '--' ? args.slice(1) : args;
  const stack = shell.store.directoryStack;
  if (stack.length === 0) {
    shell.reportError('popd: directory stack empty');
    return 1;
  }
  const [operand] = operands;
  const index = operand === undefined ? 0 : stackIndex(shell, operand);
  if (index === 'invalid' || index === undefined) {
    if (index === undefined) {
      shell.reportError(`popd: ${operand}: invalid argument`);
      shell.fd2.write('popd: usage: popd [-n] [+N | -N]\n');
      return 2;
    }
    return 1;
  }
  if (index === 0) {
    const [next] = stack;
    if (!changeDirectory(shell, 'popd', next, next)) return 1;
    stack.shift();
  } else stack.splice(index - 1, 1);
  return printStack(shell, 'plain');
};

/** The position in the directory stack (with the working directory at 0) that `+N` or `-N` names. */
function stackIndex(shell: Shell, operand: string): number | 'invalid' | undefined {
  const match = /^([+-])(\d+)$/.exec(operand);
  if (!match) return undefined;
  const size = shell.store.directoryStack.length + 1;
  const n = Number(match[2]);
  const index = match[1] === '+' ? n : size - 1 - n;
  if (index < 0 || index >= size) {
    shell.reportError(`${operand}: directory stack index out of range`);
    return 'invalid';
  }
  return index;
}

export const dirsBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'dirs', args, 'clpv', DIRS_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { options } = parsed;
  if (options.has('c')) {
    shell.store.directoryStack.length = 0;
    return 0;
  }
  return printStack(shell, options.has('v') ? 'numbered' : options.has('p') ? 'lines' : 'plain');
};

function printStack(shell: Shell, format: 'plain' | 'lines' | 'numbered'): number {
  const all = [shell.store.workingDirectory, ...shell.store.directoryStack];
  if (format === 'plain') shell.fd1.write(`${all.join(' ')}\n`);
  else {
    for (const [index, path] of all.entries()) {
      shell.fd1.write(format === 'numbered' ? `${String(index).padStart(2)}  ${path}\n` : `${path}\n`);
    }
  }
  return 0;
}
