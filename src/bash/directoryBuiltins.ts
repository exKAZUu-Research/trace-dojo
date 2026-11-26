import { resolvePath } from '../interpreter/programIo';
import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedFeature, rejectUnsupportedHostEnv } from './capabilities';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

const CD_USAGE = 'cd [-L|[-P [-e]]] [-@] [dir]';
const DIRS_USAGE = 'dirs [-clpv] [+N] [-N]';
const PUSHD_USAGE = 'pushd [-n] [+N | -N | dir]';
const POPD_USAGE = 'popd [-n] [+N | -N]';

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

/**
 * `pushd`, which changes to a directory and remembers the one it left, or with no operand swaps the top two; with
 * `-n` it adds the directory to the stack without changing to it.
 */
// code-gauge-allow functionCognitiveComplexity -- Swaps, rotates, or pushes, each with or without `-n`, as Bash's `pushd` does.
export const pushdBuiltin: Builtin = (shell, args) => {
  const parsed = parseStackArguments(shell, 'pushd', args, PUSHD_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { noChange, operands } = parsed;
  const stack = shell.store.directoryStack;
  const [operand] = operands;
  if (operand === undefined) {
    const [next] = stack;
    if (next === undefined) {
      shell.reportError('pushd: no other directory');
      return 1;
    }
    if (noChange) rejectUnsupportedFeature('pushd -n（ディレクトリを変えない入れ替え）');
    const current = shell.store.workingDirectory;
    if (!changeDirectory(shell, 'pushd', next, next)) return 1;
    stack[0] = current;
    return printStack(shell, 'plain');
  }
  const rotation = stackIndex(shell, 'pushd', operand);
  if (rotation !== undefined) {
    if (rotation === 'invalid') return 1;
    if (noChange) rejectUnsupportedFeature('pushd -n（ディレクトリを変えない入れ替え）');
    const all = [shell.store.workingDirectory, ...stack];
    const rotated = [...all.slice(rotation), ...all.slice(0, rotation)];
    if (!changeDirectory(shell, 'pushd', rotated[0], rotated[0])) return 1;
    stack.splice(0, stack.length, ...rotated.slice(1));
    return printStack(shell, 'plain');
  }
  if (noChange) {
    stack.unshift(operand);
    return printStack(shell, 'plain');
  }
  const current = shell.store.workingDirectory;
  if (!changeDirectory(shell, 'pushd', operand, operand)) return 1;
  stack.unshift(current);
  return printStack(shell, 'plain');
};

/**
 * `popd`, which returns to the directory `pushd` remembered last, or removes the one `+N` or `-N` names; with `-n`
 * it removes the remembered directory without changing to it.
 */
export const popdBuiltin: Builtin = (shell, args) => {
  const parsed = parseStackArguments(shell, 'popd', args, POPD_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { noChange, operands } = parsed;
  const stack = shell.store.directoryStack;
  if (stack.length === 0) {
    shell.reportError('popd: directory stack empty');
    return 1;
  }
  const [operand] = operands;
  const index = operand === undefined ? 0 : stackIndex(shell, 'popd', operand);
  if (index === 'invalid' || index === undefined) {
    if (index === undefined) {
      shell.reportError(`popd: ${operand}: invalid argument`);
      shell.fd2.write(`popd: usage: ${POPD_USAGE}\n`);
      return 2;
    }
    return 1;
  }
  if (index === 0) {
    const [next] = stack;
    if (!noChange && !changeDirectory(shell, 'popd', next, next)) return 1;
    stack.shift();
  } else stack.splice(index - 1, 1);
  return printStack(shell, 'plain');
};

/**
 * Reads the arguments of `pushd` and `popd`: `-n`, then `+N`, `-N`, or a directory, reporting another option as
 * Bash does.
 */
function parseStackArguments(
  shell: Shell,
  builtin: string,
  args: readonly string[],
  usage: string
): { noChange: boolean; operands: string[] } | number {
  let noChange = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      index++;
      break;
    }
    if (arg === '-n') noChange = true;
    else if (!arg.startsWith('-') || arg === '-' || STACK_INDEX.test(arg)) break;
    else {
      shell.reportError(`${builtin}: ${arg}: invalid option`);
      shell.fd2.write(`${builtin}: usage: ${usage}\n`);
      return 2;
    }
  }
  return { noChange, operands: args.slice(index) };
}

const STACK_INDEX = /^[+-]\d+$/;

/** The position in the directory stack (with the working directory at 0) that `+N` or `-N` names. */
function stackIndex(shell: Shell, builtin: string, operand: string): number | 'invalid' | undefined {
  if (!STACK_INDEX.test(operand)) return undefined;
  const size = shell.store.directoryStack.length + 1;
  const n = Number(operand.slice(1));
  const index = operand.startsWith('+') ? n : size - 1 - n;
  if (index < 0 || index >= size) {
    shell.reportError(
      size === 1 ? `${builtin}: directory stack empty` : `${builtin}: ${operand}: directory stack index out of range`
    );
    return 'invalid';
  }
  return index;
}

/** `dirs`, which prints the directory stack, or with `+N` or `-N` the one directory that names. */
export const dirsBuiltin: Builtin = (shell, args) => {
  // `+N` and `-N` may come among the options, which a number never is.
  const indexes = args.filter((arg) => STACK_INDEX.test(arg));
  const parsed = parseBuiltinOptions(
    shell,
    'dirs',
    args.filter((arg) => !STACK_INDEX.test(arg)),
    'clpv',
    DIRS_USAGE
  );
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  if (operands.length > 0) {
    shell.reportError(`dirs: ${operands[0]}: invalid option`);
    shell.fd2.write(`dirs: usage: ${DIRS_USAGE}\n`);
    return 2;
  }
  if (options.has('c')) {
    shell.store.directoryStack.length = 0;
    return 0;
  }
  const format = options.has('v') ? 'numbered' : options.has('p') ? 'lines' : 'plain';
  const operand = indexes.at(-1);
  if (operand === undefined) return printStack(shell, format);
  const index = stackIndex(shell, 'dirs', operand);
  if (index === 'invalid' || index === undefined) return 1;
  const path = [shell.store.workingDirectory, ...shell.store.directoryStack][index];
  shell.fd1.write(format === 'numbered' ? `${String(index).padStart(2)}  ${path}\n` : `${path}\n`);
  return 0;
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
