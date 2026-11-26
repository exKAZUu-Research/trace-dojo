import { compareCollated } from './collation';
import { hasExtendedGlob, hasPatternCharacters, matchesPattern } from './pattern';
import type { Shell } from './shell';

/**
 * The paths in the run's file system that a pattern matches, in the locale's collation order, as Bash's pathname
 * expansion finds them: each `/`-separated part matches the names in one directory, names starting with `.` match
 * only a part starting with `.` unless `dotglob` is on, a trailing `/` matches only directories, and with `globstar`
 * a `**` part matches any number of directories.
 *
 * @param pattern The field as a pattern, where a backslash quotes the character after it.
 */
export function expandPathname(shell: Shell, pattern: string): string[] {
  const absolute = pattern.startsWith('/');
  const parts = pattern.split('/');
  if (absolute) parts.shift();
  let paths: string[] = [absolute ? '/' : ''];
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    if (part === '' && isLast) {
      // The directory a `**` part stands for itself already ends with `/`, and the working directory, an empty
      // path, is no match.
      paths = paths
        .filter((path) => path !== '' && kindOf(shell, path) === 'directory')
        .map((path) => (path.endsWith('/') ? path : `${path}/`));
      break;
    }
    if (part === '') {
      paths = paths.map((path) => `${path}/`);
      continue;
    }
    paths = paths.flatMap((path) => expandPart(shell, path, part, isLast));
    if (paths.length === 0) return [];
  }
  return paths.toSorted(compareCollated);
}

function expandPart(shell: Shell, directory: string, part: string, isLast: boolean): string[] {
  const join = (name: string): string => joinPath(directory, name);
  if (!isPatternPart(shell, part)) {
    const path = join(part.replaceAll(/\\(.)/g, '$1'));
    return isLast ? (kindOf(shell, path) ? [path] : []) : kindOf(shell, path) === 'directory' ? [path] : [];
  }
  if (part === '**' && shell.options.globstar) return descendants(shell, directory, isLast).map(join);
  const names = listNames(shell, directory).filter((name) => matchesName(shell, part, name));
  const paths = names.map(join);
  return isLast ? paths : paths.filter((path) => kindOf(shell, path) === 'directory');
}

function isPatternPart(shell: Shell, part: string): boolean {
  const step = shell.runtime.step;
  return hasPatternCharacters(part, step) || (shell.options.extglob && hasExtendedGlob(part, step));
}

function matchesName(shell: Shell, part: string, name: string): boolean {
  if (name.startsWith('.') && !shell.options.dotglob && !/^(\\)?\./.test(part)) return false;
  return matchesPattern(part, name, shell.runtime.step, {
    extmatch: shell.options.extglob,
    fold: shell.options.nocaseglob,
  });
}

/**
 * What `**` matches under `globstar`: the directory itself (as an empty path) and every directory below it, or as the
 * last part every file and directory below it, as paths relative to the directory.
 */
function descendants(shell: Shell, directory: string, isLast: boolean): string[] {
  const found: string[] = isLast ? [] : [''];
  const pending: string[] = [''];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    for (const name of listNames(shell, joinPath(directory, relative))) {
      if (name.startsWith('.') && !shell.options.dotglob) continue;
      const path = joinPath(relative, name);
      if (kindOf(shell, joinPath(directory, path)) === 'directory') {
        found.push(path);
        pending.push(path);
      } else if (isLast) found.push(path);
    }
  }
  return found;
}

/** A path under a directory, where an empty directory is the working directory and an empty name the directory. */
function joinPath(directory: string, name: string): string {
  if (directory === '') return name;
  if (name === '') return directory.endsWith('/') ? directory : `${directory}/`;
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

function listNames(shell: Shell, directory: string): string[] {
  const path = shell.absolutePath(directory === '' ? '.' : directory);
  if (shell.runtime.io.files.kindOf(path) !== 'directory') return [];
  return shell.runtime.io.files.list(path);
}

function kindOf(shell: Shell, path: string): 'file' | 'directory' | undefined {
  return shell.runtime.io.files.kindOf(shell.absolutePath(path === '' ? '.' : path));
}
