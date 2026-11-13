import type { LibraryEntry } from '../compiler';
import { ProgramAbort } from '../errors';
import { FILE_NAME } from '../preprocessor';
import type { NativeFunction } from '../runtime';
import { classificationCall, constantCall, CTYPE_FUNCTIONS, MATH_FUNCTIONS } from './mathFunctions';
import { PLATFORM_HEADER_FUNCTIONS } from './platformHeaderFunctions';
import { PLATFORM_UNMODELED } from './platformHeaders';
import { STDIO_FUNCTIONS } from './stdioFunctions';
import { STDLIB_FUNCTIONS } from './stdlibFunctions';
import { comparisonCall, STRING_FUNCTIONS } from './stringFunctions';
import { asAddress, asNumber, bytesToText, readCString } from './support';
import { newTurtleCall, removeCall, TURTLE_FUNCTIONS } from './turtleFunctions';

const MISC_FUNCTIONS: Record<string, NativeFunction> = {
  __assert_rtn: (runtime, [expression, line]) => {
    const text = bytesToText(readCString(runtime, asAddress(expression)));
    const caller = runtime.frames.at(-1)?.fn.name ?? 'main';
    const message = `Assertion failed: (${text}), function ${caller}, file ${FILE_NAME}, line ${asNumber(line)}.`;
    runtime.output('stderr', new TextEncoder().encode(`${message}\n`));
    throw new ProgramAbort(message);
  },
};

const UNSUPPORTED: Record<string, string> = {
  scanf: '標準入力（scanf）',
  fscanf: 'ファイルの読み書き（fscanf）',
  vscanf: '標準入力（vscanf）',
  vfscanf: 'ファイルの読み書き（vfscanf）',
  vsscanf: '可変長引数（vsscanf）',
  getchar: '標準入力（getchar）',
  getc: '標準入力・ファイルの読み込み（getc）',
  fgetc: '標準入力・ファイルの読み込み（fgetc）',
  ungetc: '標準入力・ファイルの読み込み（ungetc）',
  fgets: '標準入力・ファイルの読み込み（fgets）',
  gets: '標準入力（gets）',
  fread: '標準入力・ファイルの読み込み（fread）',
  fopen: 'ファイルの読み書き（fopen）',
  freopen: 'ファイルの読み書き（freopen）',
  fclose: 'ファイルの読み書き（fclose）',
  feof: '標準入力・ファイルの読み込み（feof）',
  ferror: 'ファイルの読み書き（ferror）',
  clearerr: 'ファイルの読み書き（clearerr）',
  fseek: 'ファイルの読み書き（fseek）',
  ftell: 'ファイルの読み書き（ftell）',
  rewind: 'ファイルの読み書き（rewind）',
  fgetpos: 'ファイルの読み書き（fgetpos）',
  fsetpos: 'ファイルの読み書き（fsetpos）',
  rename: 'ファイルの操作（rename）',
  tmpfile: 'ファイルの読み書き（tmpfile）',
  tmpnam: 'ファイルの操作（tmpnam）',
  vprintf: '可変長引数（vprintf）',
  vfprintf: '可変長引数（vfprintf）',
  vsprintf: '可変長引数（vsprintf）',
  vsnprintf: '可変長引数（vsnprintf）',
  getenv: '環境変数（getenv）',
  system: '外部のプロセスの呼び出し（system）',
  mblen: 'マルチバイト文字の変換（mblen）',
  mbtowc: 'マルチバイト文字の変換（mbtowc）',
  wctomb: 'マルチバイト文字の変換（wctomb）',
  mbstowcs: 'マルチバイト文字の変換（mbstowcs）',
  wcstombs: 'マルチバイト文字の変換（wcstombs）',
  at_quick_exit: 'at_quick_exit',
};
const EXTENSION_NAMES = [
  'strcasecmp',
  'strncasecmp',
  'strlcpy',
  'strlcat',
  'isascii',
  'toascii',
  'random',
  'srandom',
  'initstate',
  'setstate',
  'drand48',
  'erand48',
  'lrand48',
  'nrand48',
  'mrand48',
  'jrand48',
  'srand48',
  'seed48',
  'lcong48',
];
for (const name of EXTENSION_NAMES) UNSUPPORTED[name] = `標準 C ライブラリ以外の関数（${name}）`;

// These give the last bits of macOS's own algorithms, which no portable formula reproduces.
for (const name of ['erf', 'erfc', 'tgamma', 'lgamma']) {
  for (const suffix of ['', 'f', 'l']) UNSUPPORTED[`${name}${suffix}`] = `${name}${suffix}`;
}

const NATIVES: Record<string, NativeFunction> = {
  ...TURTLE_FUNCTIONS,
  ...STDIO_FUNCTIONS,
  ...STDLIB_FUNCTIONS,
  ...STRING_FUNCTIONS,
  ...MATH_FUNCTIONS,
  ...CTYPE_FUNCTIONS,
  ...MISC_FUNCTIONS,
  lldiv: STDLIB_FUNCTIONS.ldiv,
  imaxdiv: STDLIB_FUNCTIONS.ldiv,
  atoll: STDLIB_FUNCTIONS.atol,
};

const PLATFORM_FUNCTIONS = new Set(Object.values(PLATFORM_HEADER_FUNCTIONS).flat());
const UNMODELED = new Set(Object.values(PLATFORM_UNMODELED).flat());
const EXTENSIONS = new Set([...PLATFORM_FUNCTIONS, 'strdup', 'strndup', ...EXTENSION_NAMES]);

const SPECIAL_CALLS = {
  __builtin_huge_val: constantCall,
  __builtin_huge_valf: constantCall,
  __builtin_inff: constantCall,
  __builtin_nanf: constantCall,
  strcmp: comparisonCall,
  strncmp: comparisonCall,
  memcmp: comparisonCall,
  __builtin_fpclassify: classificationCall,
  __builtin_isnormal: classificationCall,
  new_turtle: newTurtleCall,
  remove: removeCall,
};

/** The interpreter's implementation of a library function, or why it leaves the function out. */
export function libraryEntry(name: string): LibraryEntry | undefined {
  if (name.startsWith('__trace_platform_'))
    return { kind: 'unsupported', feature: `標準 C ライブラリ以外の関数（${name.slice('__trace_platform_'.length)}）` };
  const feature = UNSUPPORTED[name];
  if (feature) return { kind: 'unsupported', feature, canDefine: EXTENSIONS.has(name) && !UNMODELED.has(name) };
  const run = NATIVES[name];
  if (!run)
    return PLATFORM_FUNCTIONS.has(name)
      ? { kind: 'unsupported', feature: `標準 C ライブラリ以外の関数（${name}）`, canDefine: !UNMODELED.has(name) }
      : undefined;
  return {
    kind: 'native',
    run,
    canDefine: EXTENSIONS.has(name) && !UNMODELED.has(name),
    ...(name in SPECIAL_CALLS ? { special: SPECIAL_CALLS[name as keyof typeof SPECIAL_CALLS] } : {}),
  };
}
