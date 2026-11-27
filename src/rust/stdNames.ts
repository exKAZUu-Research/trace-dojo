import type { Generics, Span, TypeAst } from './ast';
import { compileError, type Module } from './items';
import type { BuiltinAdt } from './types';

/** The traits of the standard library that learning programs implement for their own types. */
export const STD_TRAITS_LEARNERS_IMPLEMENT = new Set([
  'Display',
  'Future',
  'Debug',
  'Clone',
  'Copy',
  'PartialEq',
  'Eq',
  'PartialOrd',
  'Ord',
  'Default',
  'From',
  'Error',
  ...['Add', 'Sub', 'Mul', 'Div', 'Rem', 'BitAnd', 'BitOr', 'BitXor', 'Shl', 'Shr'].flatMap((name) => [
    name,
    `${name}Assign`,
  ]),
  'Neg',
  'Not',
  'Index',
  'IndexMut',
  'Iterator',
  'Deref',
  'DerefMut',
  'Drop',
]);

export const REQUIRED_STD_METHODS: Record<string, string[]> = {
  Display: ['fmt'],
  Debug: ['fmt'],
  Clone: ['clone'],
  PartialEq: ['eq'],
  PartialOrd: ['partial_cmp'],
  Ord: ['cmp'],
  Default: ['default'],
  From: ['from'],
};

/** A key for an impl's self type in the standard library, naming the natives of its methods (`Vec<_>::push`). */
// code-gauge-allow functionCognitiveComplexity -- Follows Rust's name resolution case by case.
export function renderTypeKey(type: TypeAst, generics: Generics): string {
  const render = (t: TypeAst, useBound = true): string => {
    switch (t.kind) {
      case 'path': {
        const last = t.path.segments.at(-1)!;
        const param = generics.params.find((p) => p.name === last.name);
        if (param && t.path.segments.length === 1) {
          const bound = useBound ? param.bounds[0] : undefined;
          return bound?.kind === 'trait' ? bound.path.segments.at(-1)!.name : '_';
        }
        return last.args ? `${last.name}<${last.args.map((arg) => render(arg, false)).join(', ')}>` : last.name;
      }
      case 'ref': {
        return `&${t.mutable ? 'mut ' : ''}${render(t.target, useBound)}`;
      }
      case 'slice': {
        return `[${render(t.elem, useBound)}]`;
      }
      case 'array': {
        return `[${render(t.elem, useBound)}; N]`;
      }
      case 'tuple': {
        return `(${t.elems.map((elem) => render(elem, useBound)).join(', ')})`;
      }
      default: {
        return t.kind;
      }
    }
  };
  return render(type);
}

export const BUILTIN_STRUCTS: Record<string, BuiltinAdt> = {
  String: 'String',
  Vec: 'Vec',
  HashMap: 'HashMap',
  HashSet: 'HashSet',
  BTreeMap: 'BTreeMap',
  BTreeSet: 'BTreeSet',
  VecDeque: 'VecDeque',
  BinaryHeap: 'BinaryHeap',
  Box: 'Box',
  Reverse: 'Reverse',
  Turtle: 'Turtle',
  IterImpl: 'Iter',
  Range: 'Range',
  RangeInclusive: 'RangeInclusive',
  RangeFrom: 'RangeFrom',
  RangeTo: 'RangeTo',
  RangeToInclusive: 'RangeToInclusive',
  RangeFull: 'RangeFull',
  Formatter: 'Formatter',
  Stdout: 'Stdout',
  StdoutLock: 'StdoutLock',
  Stderr: 'Stderr',
  StderrLock: 'StderrLock',
  ParseIntError: 'ParseIntError',
  ParseFloatError: 'ParseFloatError',
  TryFromIntError: 'TryFromIntError',
  TryFromSliceError: 'TryFromSliceError',
  Utf8Error: 'Utf8Error',
  FromUtf8Error: 'FromUtf8Error',
  Entry: 'Entry',
  OccupiedEntry: 'OccupiedEntry',
  CaseIter: 'CaseIter',
  EscapeDefault: 'EscapeDefault',
  EscapeUnicode: 'EscapeUnicode',
  ParseError: 'ParseError',
  Unsigned: 'Unsigned',
  Signed: 'Signed',
  Indexed: 'Indexed',
  TryFromError: 'TryFromError',
  CharTryFromError: 'CharTryFromError',
  TryFromCharError: 'TryFromCharError',
  IterItem: 'IterItem',
  IterShape: 'IterShape',
  IterTarget: 'IterTarget',
  IntoItem: 'IntoItem',
  IntoShape: 'IntoShape',
  ParseBoolError: 'ParseBoolError',
  ParseCharError: 'ParseCharError',
  Rc: 'Rc',
  Weak: 'Weak',
  Stdin: 'Stdin',
  Arc: 'Arc',
  Mutex: 'Mutex',
  MutexGuard: 'MutexGuard',
  RwLock: 'RwLock',
  RwLockReadGuard: 'RwLockReadGuard',
  RwLockWriteGuard: 'RwLockWriteGuard',
  Sender: 'Sender',
  SendError: 'SendError',
  RecvError: 'RecvError',
  PoisonError: 'PoisonError',
  Receiver: 'Receiver',
  JoinHandle: 'JoinHandle',
  ScopedJoinHandle: 'ScopedJoinHandle',
  Thread: 'Thread',
  Duration: 'Duration',
  Scope: 'ThreadScope',
  StdinLock: 'StdinLock',
  BufReader: 'BufReader',
  BufWriter: 'BufWriter',
  File: 'File',
  OpenOptions: 'OpenOptions',
  Path: 'Path',
  PathBuf: 'PathBuf',
  RefCell: 'RefCell',
  Ref: 'Ref',
  RefMut: 'RefMut',
  Cell: 'Cell',
  ConstPtr: 'ConstPtr',
  MutPtr: 'MutPtr',
  Pin: 'Pin',
  AsyncFuture: 'AsyncFuture',
  Context: 'Context',
  Waker: 'Waker',
  Condvar: 'Condvar',
  CStr: 'CStr',
};

export const BUILTIN_ENUMS: Record<string, BuiltinAdt> = {
  Poll: 'Poll',
  ErrorKind: 'IoErrorKind',
  Bound: 'Bound',
  Option: 'Option',
  ControlFlow: 'ControlFlow',
  Result: 'Result',
  Ordering: 'Ordering',
  Infallible: 'Infallible',
  IntErrorKind: 'IntErrorKind',
  TryLockError: 'TryLockError',
  TryRecvError: 'TryRecvError',
};

export function builtinStruct(module: Module, name: string): BuiltinAdt | undefined {
  if (name !== 'Error') return BUILTIN_STRUCTS[name];
  if (module.name === 'fmt') return 'FmtError';
  return module.path === 'std::io' ? 'IoError' : undefined;
}

/** The macros of the standard library that the converter expands, by the module that defines them. */
const STD_MACROS: Record<string, ReadonlySet<string>> = {
  '': new Set([
    'assert',
    'assert_eq',
    'assert_ne',
    'cfg',
    'column',
    'dbg',
    'debug_assert',
    'debug_assert_eq',
    'debug_assert_ne',
    'eprint',
    'eprintln',
    'file',
    'format',
    'line',
    'matches',
    'module_path',
    'panic',
    'print',
    'println',
    'stringify',
    'todo',
    'unimplemented',
    'unreachable',
    'vec',
    'write',
    'writeln',
  ]),
  pin: new Set(['pin']),
};

/** Whether a `use` path names a macro of the standard library (`use std::pin::pin;`), which needs no binding. */
export function isStdMacroPath(path: readonly string[]): boolean {
  const [crate, ...rest] = path;
  if (crate !== 'std' && crate !== 'core' && crate !== 'alloc') return false;
  return STD_MACROS[rest.slice(0, -1).join('::')]?.has(rest.at(-1) ?? '') ?? false;
}

export function unavailableStdItem(segments: string[], span: Span): never {
  checkUnavailableStd(segments, span);
  return compileError(span, `${segments.join('::')} は、この採点環境では使えません。`);
}

/** Rejects the modules of the standard library that touch the outside world or run concurrently (stage D). */
export function checkUnavailableStd(segments: string[], span: Span): void {
  const [, module, name] = segments;
  const unavailable: Record<string, string> = {
    net: 'ネットワーク（std::net）',
    env: '環境変数とコマンドラインの引数（std::env）',
    time: '時刻（std::time）',
    any: 'std::any',
    ffi: '外部の関数との連携（std::ffi）',
    os: 'OS の機能（std::os）',
    alloc: 'メモリの割り当て（std::alloc）',
    arch: 'CPU 固有の命令（std::arch）',
    simd: 'SIMD（std::simd）',
    borrow: 'std::borrow',
    panic: 'std::panic',
    hint: 'std::hint',
  };
  if (module === 'io' && name) compileError(span, `std::io::${name} は、この採点環境では使えません。`);
  if (module === 'sync' && name === 'atomic')
    compileError(span, 'アトミック型（std::sync::atomic）は、この採点環境では使えません。');
  if (module && unavailable[module]) compileError(span, `${unavailable[module]}は、この採点環境では使えません。`);
  if (module === 'process' && name && name !== 'exit') {
    compileError(span, `外部のプロセス（std::process::${name}）は、この採点環境では使えません。`);
  }
}
