import { resolvePath } from '../../interpreter/programIo';
import type { NativeCall } from '../natives';
import { CsThrow } from '../runtime';

/**
 * The locks that .NET takes on the files a program opens, as on Unix: an open with `FileShare.None` locks its file
 * exclusively and any other open shares a lock, so that a file held exclusively cannot be opened again (as after a
 * `File.Create` whose stream is never disposed) until the holder is closed. A lock follows its file when it is renamed.
 */
export type LockMode = 'shared' | 'exclusive';

interface Holders {
  shared: number;
  exclusive: number;
}

const holdersByFile = new WeakMap<object, Holders>();

/** Throws .NET's sharing violation when the file a path names is held in a way that excludes an open of the mode. */
export function checkLock(call: NativeCall, path: string, mode: LockMode): void {
  const file = call.frame.runtime.io.files.fileOf(path);
  const holders = file && holdersByFile.get(file);
  if (!holders || (holders.exclusive === 0 && (mode === 'shared' || holders.shared === 0))) return;
  const exception = call.frame.runtime.createException(
    'System.IO.IOException',
    `The process cannot access the file '${resolvePath(path)}' because it is being used by another process.`
  );
  throw new CsThrow(exception);
}

/** Locks a file for an open handle, returning the release of the lock, which releases it once. */
export function holdLock(file: object, mode: LockMode): () => void {
  let holders = holdersByFile.get(file);
  if (!holders) {
    holders = { shared: 0, exclusive: 0 };
    holdersByFile.set(file, holders);
  }
  holders[mode]++;
  let isHeld = true;
  return () => {
    if (!isHeld) return;
    isHeld = false;
    (holders as Holders)[mode]--;
  };
}
