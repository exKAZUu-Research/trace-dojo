import { resolvePath } from '../interpreter/programIo';
import { rejectUnsupportedFeature } from './capabilities';
import { isSetOptionName } from './options';
import type { Shell } from './shell';

/**
 * The unary file operators of `test` and `[[ ]]`, over the run's file system. Its files carry no owner, mode, or
 * time, so they behave as files a program creates: owned by it, readable and writable, and executable only when
 * they are directories; `/dev/null` is the only device.
 */
// code-gauge-allow functionNcss -- One case per file operator over the virtual file system and its devices.
export function fileTest(shell: Shell, operator: string, operand: string): boolean {
  if (operator === '-o') return isSetOptionName(operand) && shell.options[operand];
  if (operator === '-t') return false;
  if (operator === '-N') rejectUnsupportedFeature('ファイルの更新時刻を調べる演算子（-N）');
  if (operand === '') return false;
  const absolute = shell.absolutePath(operand);
  const device = resolvePath(absolute);
  if (device === '/dev/null') return ['-a', '-e', '-c', '-r', '-w'].includes(operator);
  const descriptor = descriptorOfPath(device);
  if (descriptor !== undefined) return descriptorTest(shell, operator, descriptor);
  if (device.startsWith('/dev/')) shell.rejectDevice(device);
  const kind = shell.runtime.io.files.kindOf(absolute);
  if (kind === undefined) return false;
  switch (operator) {
    case '-a':
    case '-e':
    case '-r':
    case '-w':
    case '-O':
    case '-G': {
      return true;
    }
    case '-f': {
      return kind === 'file';
    }
    case '-d':
    case '-x': {
      return kind === 'directory';
    }
    case '-s': {
      return kind === 'directory' || shell.runtime.io.files.readFile(absolute) !== '';
    }
    default: {
      // `-b`, `-c`, `-g`, `-h`, `-k`, `-L`, `-p`, `-S`, and `-u` need devices, links, sockets, or mode bits.
      return false;
    }
  }
}

/** The descriptor that `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, or `/dev/fd/N` names. */
export function descriptorOfPath(device: string): number | undefined {
  const named = ['/dev/stdin', '/dev/stdout', '/dev/stderr'].indexOf(device);
  if (named !== -1) return named;
  const match = /^\/dev\/fd\/(\d+)$/.exec(device);
  return match ? Number(match[1]) : undefined;
}

/** A file operator on a descriptor's path, which exists while the descriptor is open. */
function descriptorTest(shell: Shell, operator: string, fd: number): boolean {
  const file = shell.fds.get(fd);
  if (!file) return false;
  if (operator === '-a' || operator === '-e') return true;
  if (operator === '-r') return file.input !== undefined;
  if (operator === '-w') return file.output !== undefined;
  return false;
}

/** The binary file operators: `-ef` compares files, while `-nt` and `-ot` compare times the files do not have. */
export function fileComparison(shell: Shell, operator: string, left: string, right: string): boolean {
  if (operator !== '-ef') rejectUnsupportedFeature(`ファイルの更新時刻を比べる演算子（${operator}）`);
  if (left === '' || right === '') return false;
  return shell.runtime.io.files.isSameFile(shell.absolutePath(left), shell.absolutePath(right));
}
