import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, identical, type NamedType, pointerTo, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { implementsInterface, libraryVariable, sameError } from './io';
import { BOOL, callFunction, callMethod, errorText, receiverStruct, spendFor, STRING } from './support';

const UINT32 = BASIC.uint32;

/** `fs.FileMode`, the mode and permission bits of a file. */
export const FILE_MODE = namedType('io/fs', 'FileMode', UINT32);
const MODE_LETTERS = 'dalTLDpSugct?';
const MODE_PERM = 0o777;
const MODE_TYPE = 0x8f_28_00_00;

function modeString(mode: number): string {
  let text = '';
  for (let index = 0; index < MODE_LETTERS.length; index++) {
    const letter = MODE_LETTERS[index];
    if ((mode >>> (31 - index)) & 1) text += letter;
  }
  if (text === '') text = '-';
  for (let index = 0; index < 9; index++) text += (mode >>> (8 - index)) & 1 ? 'rwxrwxrwx'[index] : '-';
  return text;
}

const modeOf = (receiver: Value): number => Number(receiver as bigint);
addMethod(FILE_MODE, 'String', fn([], [STRING]), (receiver) => modeString(modeOf(receiver)));
addMethod(FILE_MODE, 'IsDir', fn([], [BOOL]), (receiver) => (modeOf(receiver) & 0x80_00_00_00) !== 0);
addMethod(FILE_MODE, 'IsRegular', fn([], [BOOL]), (receiver) => (modeOf(receiver) & MODE_TYPE) === 0);
addMethod(FILE_MODE, 'Perm', fn([], [FILE_MODE]), (receiver) => BigInt(modeOf(receiver) & MODE_PERM));
addMethod(FILE_MODE, 'Type', fn([], [FILE_MODE]), (receiver) => BigInt((modeOf(receiver) & MODE_TYPE) >>> 0));

// Errors ------------------------------------------------------------------------------------------------------------

export const ERR_INVALID = newError('invalid argument');
const ERR_PERMISSION = newError('permission denied');
const ERR_EXIST = newError('file already exists');
const ERR_NOT_EXIST = newError('file does not exist');
const ERR_CLOSED = newError('file already closed');

/** `*poll.DeadlineExceededError`, which `os.ErrDeadlineExceeded` is. */
const DEADLINE_EXCEEDED = namedType('internal/poll', 'DeadlineExceededError', { kind: 'struct', fields: [] });
addMethod(DEADLINE_EXCEEDED, 'Error', fn([], [STRING]), () => 'i/o timeout', true);
addMethod(DEADLINE_EXCEEDED, 'Timeout', fn([], [BOOL]), () => true, true);
addMethod(DEADLINE_EXCEEDED, 'Temporary', fn([], [BOOL]), () => true, true);

const TIMEOUT = { kind: 'interface' as const, methods: [{ name: 'Timeout', type: fn([], [BOOL]) }] };

/** An os error struct such as `PathError`, whose message joins its string fields and ends with its error's text. */
function errorStruct(name: string, stringFields: string[], separator: (fields: string[]) => string): NamedType {
  const fields: [string, Type][] = [
    ...stringFields.map((field): [string, Type] => [field, STRING]),
    ['Err', ERROR_TYPE],
  ];
  const type = namedType(name === 'PathError' ? 'io/fs' : 'os', name, {
    kind: 'struct',
    fields: fields.map(([field, fieldType]) => ({ name: field, type: fieldType, embedded: false })),
  });
  const errOf = (receiver: Value): Value => receiverStruct(receiver).fields[stringFields.length];
  addMethod(
    type,
    'Error',
    fn([], [STRING]),
    (receiver) => {
      const values = receiverStruct(receiver).fields.slice(0, stringFields.length) as string[];
      return `${separator(values)}: ${errorText(errOf(receiver))}`;
    },
    true
  );
  addMethod(type, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => errOf(receiver), true);
  addMethod(
    type,
    'Timeout',
    fn([], [BOOL]),
    (receiver) => {
      const error = errOf(receiver);
      return implementsInterface(error, TIMEOUT) && callMethod(error, 'Timeout') === true;
    },
    true
  );
  return type;
}

const PATH_ERROR = errorStruct('PathError', ['Op', 'Path'], ([op, path]) => `${op} ${path}`);
const LINK_ERROR = errorStruct('LinkError', ['Op', 'Old', 'New'], ([op, old, next]) => `${op} ${old} ${next}`);
const SYSCALL_ERROR = errorStruct('SyscallError', ['Syscall'], ([syscall]) => syscall);

/** `os.underlyingError`: the error inside the os package's own error types. */
function underlyingError(error: Value): Value {
  if (error instanceof Iface) {
    for (const type of [PATH_ERROR, LINK_ERROR, SYSCALL_ERROR]) {
      if (identical(error.type, pointerTo(type))) return receiverStruct(error.value).fields.at(-1);
    }
  }
  return error;
}

function isFunction(name: string, target: Value): Entity {
  return nativeFunction(name, fn([ERROR_TYPE], [BOOL]), ([error]) => sameError(underlyingError(error), target));
}

// Expand ------------------------------------------------------------------------------------------------------------

const isShellSpecial = (char: string): boolean => '*#$@!?-0123456789'.includes(char);
const isAlphaNumeric = (char: string): boolean => /^\w$/.test(char);

/** `os.getShellName`: the variable name at the start of `s` and the bytes it takes. */
function shellName(s: string): [string, number] {
  if (s[0] === '{') {
    if (s.length > 2 && isShellSpecial(s[1]) && s[2] === '}') return [s[1], 3];
    const close = s.indexOf('}', 1);
    if (close === 1) return ['', 2];
    return close === -1 ? ['', 1] : [s.slice(1, close), close + 1];
  }
  if (isShellSpecial(s[0])) return [s[0], 1];
  let end = 0;
  while (end < s.length && isAlphaNumeric(s[end])) end++;
  return [s.slice(0, end), end];
}

function expand(s: string, mapping: Value): string {
  spendFor(s.length);
  let out: string | undefined;
  let start = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] !== '$' || j + 1 >= s.length) continue;
    out = (out ?? '') + s.slice(start, j);
    const [name, width] = shellName(s.slice(j + 1));
    if (name === '' && width > 0) {
      // Invalid syntax, such as `${}`, is dropped.
    } else if (name === '') out += s[j];
    else out += callFunction(mapping, [name]) as string;
    j += width;
    start = j + 1;
  }
  return out === undefined ? s : out + s.slice(start);
}

// Members -----------------------------------------------------------------------------------------------------------

function constant(name: string, type: Type, value: number | string): Entity {
  return {
    kind: 'const',
    name,
    type,
    value: typeof value === 'string' ? { kind: 'string', value } : { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

const MODE_CONSTANTS: Record<string, number> = {
  ModeDir: 2 ** 31,
  ModeAppend: 2 ** 30,
  ModeExclusive: 2 ** 29,
  ModeTemporary: 2 ** 28,
  ModeSymlink: 2 ** 27,
  ModeDevice: 2 ** 26,
  ModeNamedPipe: 2 ** 25,
  ModeSocket: 2 ** 24,
  ModeSetuid: 2 ** 23,
  ModeSetgid: 2 ** 22,
  ModeCharDevice: 2 ** 21,
  ModeSticky: 2 ** 20,
  ModeIrregular: 2 ** 19,
  ModeType: MODE_TYPE,
  ModePerm: MODE_PERM,
};

/** The open flags of darwin. */
const OPEN_FLAGS: Record<string, number> = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_APPEND: 8,
  O_CREATE: 512,
  O_EXCL: 2048,
  O_SYNC: 128,
  O_TRUNC: 1024,
};

/** The members of package os that do not touch the file system, the environment, or the process. */
export const OS_ERROR_MEMBERS: Record<string, Entity> = {
  FileMode: typeEntity(FILE_MODE),
  PathError: typeEntity(PATH_ERROR),
  LinkError: typeEntity(LINK_ERROR),
  SyscallError: typeEntity(SYSCALL_ERROR),
  ...Object.fromEntries(
    Object.entries(MODE_CONSTANTS).map(([name, value]) => [name, constant(name, FILE_MODE, value)])
  ),
  ...Object.fromEntries(Object.entries(OPEN_FLAGS).map(([name, value]) => [name, constant(name, BASIC.int, value)])),
  SEEK_SET: constant('SEEK_SET', BASIC.int, 0),
  SEEK_CUR: constant('SEEK_CUR', BASIC.int, 1),
  SEEK_END: constant('SEEK_END', BASIC.int, 2),
  PathSeparator: constant('PathSeparator', BASIC.untypedRune, 0x2f),
  PathListSeparator: constant('PathListSeparator', BASIC.untypedRune, 0x3a),
  DevNull: constant('DevNull', BASIC.untypedString, '/dev/null'),
  ErrInvalid: libraryVariable('ErrInvalid', ERROR_TYPE, ERR_INVALID),
  ErrPermission: libraryVariable('ErrPermission', ERROR_TYPE, ERR_PERMISSION),
  ErrExist: libraryVariable('ErrExist', ERROR_TYPE, ERR_EXIST),
  ErrNotExist: libraryVariable('ErrNotExist', ERROR_TYPE, ERR_NOT_EXIST),
  ErrClosed: libraryVariable('ErrClosed', ERROR_TYPE, ERR_CLOSED),
  ErrNoDeadline: libraryVariable('ErrNoDeadline', ERROR_TYPE, newError('file type does not support deadline')),
  ErrDeadlineExceeded: libraryVariable(
    'ErrDeadlineExceeded',
    ERROR_TYPE,
    new Iface(pointerTo(DEADLINE_EXCEEDED), new Pointer(new Cell(new GoStruct([])), 'v'))
  ),
  ErrProcessDone: libraryVariable('ErrProcessDone', ERROR_TYPE, newError('os: process already finished')),
  ErrNoHandle: libraryVariable('ErrNoHandle', ERROR_TYPE, newError('os: process handle unavailable')),
  IsExist: isFunction('IsExist', ERR_EXIST),
  IsNotExist: isFunction('IsNotExist', ERR_NOT_EXIST),
  IsPermission: isFunction('IsPermission', ERR_PERMISSION),
  IsTimeout: nativeFunction('IsTimeout', fn([ERROR_TYPE], [BOOL]), ([error]) => {
    const inner = underlyingError(error);
    return implementsInterface(inner, TIMEOUT) && callMethod(inner, 'Timeout') === true;
  }),
  IsPathSeparator: nativeFunction('IsPathSeparator', fn([BASIC.uint8], [BOOL]), ([char]) => char === 0x2fn),
  NewSyscallError: nativeFunction('NewSyscallError', fn([STRING, ERROR_TYPE], [ERROR_TYPE]), ([syscall, error]) =>
    error === undefined
      ? undefined
      : new Iface(pointerTo(SYSCALL_ERROR), new Pointer(new Cell(new GoStruct([syscall, error])), 'v'))
  ),
  Expand: nativeFunction(
    'Expand',
    fn([STRING, { kind: 'func', params: [STRING], results: [STRING], variadic: false }], [STRING]),
    ([s, mapping]) => expand(s as string, mapping)
  ),
  Getpagesize: nativeFunction('Getpagesize', fn([], [BASIC.int]), () => 16_384n),
};
