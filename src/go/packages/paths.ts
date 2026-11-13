import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, RUNE_ERROR } from '../literals';
import { definePackage, fn, nativeFunction } from '../native';
import { BASIC, sliceOf } from '../types';
import type { Value } from '../values';
import { libraryVariable } from './io';
import { BOOL, ERROR_TYPE, sliceOfValues, sliceValues, spendFor, STRING } from './support';

const STRINGS = sliceOf(STRING);

/**
 * `path.Clean` (and `filepath.Clean` on Unix), computed over the slash-separated elements: empty and `.` elements
 * vanish, and `..` removes the element before it, or stays at the start of a relative path.
 */
export function cleanPath(path: string): string {
  if (path === '') return '.';
  spendFor(path.length);
  const rooted = path.startsWith('/');
  const out: string[] = [];
  for (const element of path.split('/')) {
    if (element === '' || element === '.') continue;
    if (element !== '..') out.push(element);
    else if (out.length > 0 && out.at(-1) !== '..') out.pop();
    else if (!rooted) out.push('..');
  }
  const cleaned = (rooted ? '/' : '') + out.join('/');
  return cleaned === '' ? '.' : cleaned;
}

/** `path.Join`: the non-empty elements joined with slashes and cleaned. */
export function joinPath(elements: string[]): string {
  const first = elements.findIndex((element) => element !== '');
  if (first === -1) return '';
  return cleanPath(elements.slice(first).join('/'));
}

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf('/');
  return [path.slice(0, slash + 1), path.slice(slash + 1)];
}

function ext(path: string): string {
  for (let index = path.length - 1; index >= 0 && path[index] !== '/'; index--) {
    if (path[index] === '.') return path.slice(index);
  }
  return '';
}

function base(path: string): string {
  if (path === '') return '.';
  const trimmed = path.replace(/\/+$/, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return name === '' ? '/' : name;
}

/** `filepath.Rel` on Unix. */
function rel(basePath: string, targPath: string): [string, Value] {
  let baseClean = cleanPath(basePath);
  const targ = cleanPath(targPath);
  if (targ === baseClean) return ['.', undefined];
  if (baseClean === '.') baseClean = '';
  const failure = (): [string, Value] => ['', newError(`Rel: can't make ${targPath} relative to ${basePath}`)];
  if (baseClean.startsWith('/') !== targ.startsWith('/')) return failure();
  const bl = baseClean.length;
  const tl = targ.length;
  let b0 = 0;
  let bi = 0;
  let t0 = 0;
  let ti = 0;
  for (;;) {
    while (bi < bl && baseClean[bi] !== '/') bi++;
    while (ti < tl && targ[ti] !== '/') ti++;
    if (targ.slice(t0, ti) !== baseClean.slice(b0, bi)) break;
    if (bi < bl) bi++;
    if (ti < tl) ti++;
    b0 = bi;
    t0 = ti;
  }
  if (baseClean.slice(b0, bi) === '..') return failure();
  if (b0 === bl) return [targ.slice(t0), undefined];
  const seps = baseClean.slice(b0).split('/').length - 1;
  let up = `..${'/..'.repeat(seps)}`;
  if (t0 !== tl) up += `/${targ.slice(t0)}`;
  return [cleanPath(up), undefined];
}

/** `filepath.IsLocal` on Unix. */
function isLocal(path: string): boolean {
  if (path.startsWith('/') || path === '') return false;
  const cleaned = path.split('/').some((part) => part === '.' || part === '..') ? cleanPath(path) : path;
  return cleaned !== '..' && !cleaned.startsWith('../');
}

/** `fs.ValidPath`. */
function validPath(path: string): boolean {
  for (let at = 0; at < path.length;) {
    const { rune, size } = decodeRune(path, at);
    if (rune === RUNE_ERROR && size === 1) return false;
    at += size;
  }
  if (path === '.') return true;
  return path.split('/').every((element) => element !== '' && element !== '.' && element !== '..');
}

// Match -------------------------------------------------------------------------------------------------------------

class BadPattern extends Error {}

function scanChunk(pattern: string): [boolean, string, string] {
  let rest = pattern;
  let star = false;
  while (rest.startsWith('*')) {
    rest = rest.slice(1);
    star = true;
  }
  let inRange = false;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index];
    if (char === '\\') {
      if (index + 1 < rest.length) index++;
    } else if (char === '[') inRange = true;
    else if (char === ']') inRange = false;
    else if (char === '*' && !inRange) return [star, rest.slice(0, index), rest.slice(index)];
  }
  return [star, rest, ''];
}

function getEsc(chunk: string): [number, string] {
  if (chunk === '' || chunk[0] === '-' || chunk[0] === ']') throw new BadPattern();
  let rest = chunk;
  if (rest[0] === '\\') {
    rest = rest.slice(1);
    if (rest === '') throw new BadPattern();
  }
  const { rune, size } = decodeRune(rest, 0);
  const next = rest.slice(size);
  if ((rune === RUNE_ERROR && size === 1) || next === '') throw new BadPattern();
  return [rune, next];
}

/** A character class `[...]` at the start of `chunk`: whether `rune` is in it, and the chunk after it. */
function matchClass(classChunk: string, rune: number): [boolean, string] {
  let chunk = classChunk.slice(1);
  const negated = chunk.startsWith('^');
  if (negated) chunk = chunk.slice(1);
  let matched = false;
  for (let ranges = 0; !(chunk.startsWith(']') && ranges > 0); ranges++) {
    let lo: number;
    let hi: number;
    [lo, chunk] = getEsc(chunk);
    hi = lo;
    if (chunk[0] === '-') [hi, chunk] = getEsc(chunk.slice(1));
    matched ||= lo <= rune && rune <= hi;
  }
  return [matched !== negated, chunk.slice(1)];
}

/** `matchChunk`: the rest of `s` after the chunk matches its start, or undefined; a bad pattern throws. */
function matchChunk(pattern: string, text: string): string | undefined {
  let chunk = pattern;
  let s = text;
  let failed = false;
  while (chunk !== '') {
    failed ||= s === '';
    const size = failed ? 0 : decodeRune(s, 0).size;
    if (chunk[0] === '[') {
      const [inClass, rest] = matchClass(chunk, failed ? 0 : decodeRune(s, 0).rune);
      s = s.slice(size);
      chunk = rest;
      failed ||= !inClass;
    } else if (chunk[0] === '?') {
      failed ||= s[0] === '/';
      s = s.slice(size);
      chunk = chunk.slice(1);
    } else {
      if (chunk[0] === '\\') {
        chunk = chunk.slice(1);
        if (chunk === '') throw new BadPattern();
      }
      failed ||= chunk[0] !== s[0];
      s = s.slice(1);
      chunk = chunk.slice(1);
    }
  }
  return failed ? undefined : s;
}

/** `path.Match`, and with `checkRest` false `filepath.Match`, which does not check the rest of a failed pattern. */
function match(patternText: string, nameText: string, checkRest: boolean): boolean {
  spendFor(patternText.length + nameText.length);
  let pattern = patternText;
  let name = nameText;
  patterns: while (pattern !== '') {
    let star: boolean;
    let chunk: string;
    [star, chunk, pattern] = scanChunk(pattern);
    if (star && chunk === '') return !name.includes('/');
    const rest = matchChunk(chunk, name);
    if (rest !== undefined && (rest === '' || pattern !== '')) {
      name = rest;
      continue;
    }
    if (star) {
      for (let index = 0; index < name.length && name[index] !== '/'; index++) {
        spendFor(chunk.length);
        const after = matchChunk(chunk, name.slice(index + 1));
        if (after === undefined) continue;
        if (pattern === '' && after !== '') continue;
        name = after;
        continue patterns;
      }
    }
    while (checkRest && pattern !== '') {
      [, chunk, pattern] = scanChunk(pattern);
      matchChunk(chunk, '');
    }
    return false;
  }
  return name === '';
}

function matchFunction(checkRest: boolean, badPattern: Value): Entity {
  return nativeFunction('Match', fn([STRING, STRING], [BOOL, ERROR_TYPE]), ([pattern, name]) => {
    try {
      return [match(pattern as string, name as string, checkRest), undefined];
    } catch (error) {
      if (error instanceof BadPattern) return [false, badPattern];
      throw error;
    }
  });
}

// Packages ----------------------------------------------------------------------------------------------------------

const stringFunction = (name: string, impl: (path: string) => Value): Entity =>
  nativeFunction(name, fn([STRING], [STRING]), ([path]) => impl(path as string));

function commonMembers(badPattern: Value, checkRest: boolean): Record<string, Entity> {
  return {
    ErrBadPattern: libraryVariable('ErrBadPattern', ERROR_TYPE, badPattern),
    Match: matchFunction(checkRest, badPattern),
    Clean: stringFunction('Clean', cleanPath),
    Base: stringFunction('Base', base),
    Ext: stringFunction('Ext', ext),
    Dir: stringFunction('Dir', (path) => cleanPath(splitPath(path)[0])),
    IsAbs: nativeFunction('IsAbs', fn([STRING], [BOOL]), ([path]) => (path as string).startsWith('/')),
    Split: nativeFunction('Split', fn([STRING], [STRING, STRING]), ([path]) => splitPath(path as string)),
    Join: nativeFunction('Join', fn([STRINGS], [STRING], true), ([elements]) =>
      joinPath(sliceValues(elements) as string[])
    ),
  };
}

const PATH_BAD_PATTERN = newError('syntax error in pattern');
const FILEPATH_BAD_PATTERN = newError('syntax error in pattern');
const ERR_INVALID_PATH = newError('invalid path');

export const PATH_PACKAGE = definePackage('path', commonMembers(PATH_BAD_PATTERN, true));

function runeConstant(name: string, char: string): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedRune,
    value: { kind: 'int', value: BigInt(char.codePointAt(0) as number) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

export const FILEPATH_PACKAGE = definePackage(
  'path/filepath',
  {
    ...commonMembers(FILEPATH_BAD_PATTERN, false),
    Separator: runeConstant('Separator', '/'),
    ListSeparator: runeConstant('ListSeparator', ':'),
    ToSlash: stringFunction('ToSlash', (path) => path),
    FromSlash: stringFunction('FromSlash', (path) => path),
    VolumeName: stringFunction('VolumeName', () => ''),
    IsLocal: nativeFunction('IsLocal', fn([STRING], [BOOL]), ([path]) => isLocal(path as string)),
    Localize: nativeFunction('Localize', fn([STRING], [STRING, ERROR_TYPE]), ([path]) => {
      const text = path as string;
      return validPath(text) && !text.includes('\0') ? [text, undefined] : ['', ERR_INVALID_PATH];
    }),
    Rel: nativeFunction('Rel', fn([STRING, STRING], [STRING, ERROR_TYPE]), ([basePath, targPath]) =>
      rel(basePath as string, targPath as string)
    ),
    SkipDir: libraryVariable('SkipDir', ERROR_TYPE, newError('skip this directory')),
    SkipAll: libraryVariable('SkipAll', ERROR_TYPE, newError('skip everything and stop the walk')),
    HasPrefix: nativeFunction('HasPrefix', fn([STRING, STRING], [BOOL]), ([path, prefix]) =>
      (path as string).startsWith(prefix as string)
    ),
    SplitList: nativeFunction('SplitList', fn([STRING], [STRINGS]), ([path]) => {
      const text = path as string;
      spendFor(text.length);
      return sliceOfValues(text === '' ? [] : text.split(':'));
    }),
  },
  ['Glob', 'Walk', 'WalkDir', 'WalkFunc', 'Abs', 'EvalSymlinks']
);
