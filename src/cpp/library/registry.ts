import { fma } from '../../c/library/binaryFloat';
import { BINARY, UNARY } from '../../c/library/mathFunctions';
import { CppRuntimeError, overflowError, ProgramExit } from '../errors';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import type { Entity } from '../scopes';
import {
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  DOUBLE,
  FLOAT,
  type FunctionInfo,
  INT,
  intMin,
  type IntType,
  isArithmetic,
  LDOUBLE,
  LLONG,
  LONG,
  nonReference,
  sameParameters,
  SCHAR,
  SHORT,
  type Type,
  typeName,
  UCHAR,
  UINT,
  ULLONG,
  ULONG,
  unqualified,
  USHORT,
  VOID,
} from '../types';
import { Box, Ptr } from '../values';
import { algorithmFunctions } from './algorithms';
import { makePair } from './associative';
import { cFunctions } from './cFunctions';
import { constantsOf } from './constants';
import { containerTemplates } from './containers';
import { exceptionClasses } from './exceptions';
import { FLAGS, ManipulatorValue, Streams, type StreamValue } from './iostream';
import {
  conflictsWithLibcGlobal,
  isLibcGlobalDeclared,
  isLibcHeaderMacro,
  redeclaresLibcFunction,
} from './libcGlobals';
import { randomEngines } from './random';
import { stringClass, stringFunctions } from './string';
import { asNumber, CONST_CHAR_PTR, generic, native } from './support';
import { turtleClass } from './turtle';
import { hasLocaleCtypeOverload, headerOf, isVisible } from './visibility';

/** A class template of the library, such as `std::vector`, which template arguments instantiate. */
export type LibraryTemplate =
  | { name: string; takesArrayBound?: false; instantiate: (args: Type[], row: number) => Type }
  | { name: string; takesArrayBound: true; instantiate: (element: Type, bound: number) => Type };

/** The names the library declares that the interpreter leaves out, with the feature they belong to. */
const UNSUPPORTED_STD_NAMES: Record<string, string> = {
  cin: '標準入力（std::cin）',
  wcin: '標準入力（std::wcin）',
  ifstream: 'ファイルの読み書き（std::ifstream）',
  ofstream: 'ファイルの読み書き（std::ofstream）',
  fstream: 'ファイルの読み書き（std::fstream）',
  nothrow: '例外を投げない割り当て（std::nothrow）',
  nothrow_t: '例外を投げない割り当て（std::nothrow_t）',
  new_handler: 'メモリ不足時のハンドラ（std::new_handler）',
  set_new_handler: 'メモリ不足時のハンドラ（std::set_new_handler）',
  get_new_handler: 'メモリ不足時のハンドラ（std::get_new_handler）',
  exception_ptr: '例外へのポインタ（std::exception_ptr）',
  current_exception: '例外へのポインタ（std::current_exception）',
  make_exception_ptr: '例外へのポインタ（std::make_exception_ptr）',
  rethrow_exception: '例外へのポインタ（std::rethrow_exception）',
  filesystem: 'ファイルシステム（std::filesystem）',
  thread: 'スレッド（std::thread）',
  jthread: 'スレッド（std::jthread）',
  mutex: '排他制御（std::mutex）',
  lock_guard: '排他制御（std::lock_guard）',
  unique_lock: '排他制御（std::unique_lock）',
  scoped_lock: '排他制御（std::scoped_lock）',
  condition_variable: '条件変数（std::condition_variable）',
  atomic: 'アトミック変数（std::atomic）',
  async: '非同期処理（std::async）',
  future: '非同期処理（std::future）',
  promise: '非同期処理（std::promise）',
  this_thread: 'スレッド（std::this_thread）',
  chrono: '時刻・時間（std::chrono）',
  time: '時刻（std::time）',
  clock: '時刻（std::clock）',
  regex: '正規表現（std::regex）',
  regex_match: '正規表現（std::regex_match）',
  regex_search: '正規表現（std::regex_search）',
  regex_replace: '正規表現（std::regex_replace）',
  smatch: '正規表現（std::smatch）',
  locale: 'ロケール（std::locale）',
  type_info: '実行時の型の情報（std::type_info）',
  type_index: '実行時の型の情報（std::type_index）',
  tuple: 'std::tuple',
  make_tuple: 'std::tuple',
  tie: 'std::tie',
  get: 'std::get',
  optional: 'std::optional',
  nullopt: 'std::optional',
  make_optional: 'std::optional',
  variant: 'std::variant',
  visit: 'std::variant',
  any: 'std::any',
  function: 'std::function',
  bind: 'std::bind',
  unique_ptr: 'スマートポインタ（std::unique_ptr）',
  shared_ptr: 'スマートポインタ（std::shared_ptr）',
  weak_ptr: 'スマートポインタ（std::weak_ptr）',
  make_unique: 'スマートポインタ（std::make_unique）',
  make_shared: 'スマートポインタ（std::make_shared）',
  move: 'ムーブ（std::move）',
  forward: '完全転送（std::forward）',
  initializer_list: 'std::initializer_list',
  bitset: 'std::bitset',
  complex: '複素数（std::complex）',
  valarray: 'std::valarray',
  string_view: 'std::string_view',
  span: 'std::span',
  format: '書式（std::format）',
  ranges: 'レンジ（std::ranges）',
  views: 'レンジ（std::views）',
  forward_list: 'std::forward_list',
  wstring: 'ワイド文字列（std::wstring）',
  wcout: 'ワイド文字の出力（std::wcout）',
  numbers: '数学の定数（std::numbers）',
  normal_distribution: '正規分布（std::normal_distribution）',
  bernoulli_distribution: 'std::bernoulli_distribution',
  discrete_distribution: 'std::discrete_distribution',
  minstd_rand: 'std::minstd_rand',
  default_random_engine: 'std::default_random_engine',
  sample: 'std::sample',
  terminate: 'std::terminate',
  addressof: 'std::addressof',
};

const UNSUPPORTED_C_NAMES: Record<string, string> = {
  system: '外部のコマンドの実行（std::system）',
  getenv: '環境変数（std::getenv）',
  signal: 'シグナル（std::signal）',
  raise: 'シグナル（std::raise）',
  setjmp: '大域的な脱出（setjmp）',
  longjmp: '大域的な脱出（longjmp）',
  scanf: '標準入力（scanf）',
  vscanf: '標準入力（vscanf）',
  getchar: '標準入力（getchar）',
  stdin: '標準入力（stdin）',
  getc: '標準入力・ファイル（getc）',
  fgetc: '標準入力・ファイル（fgetc）',
  fgets: '標準入力・ファイル（fgets）',
  fscanf: '標準入力・ファイル（fscanf）',
  vfscanf: '標準入力・ファイル（vfscanf）',
  ungetc: '標準入力・ファイル（ungetc）',
  fopen: 'ファイルの読み書き（fopen）',
  freopen: 'ファイルの読み書き（freopen）',
  fclose: 'ファイルの読み書き（fclose）',
  fread: 'ファイルの読み書き（fread）',
  fwrite: 'ファイルの読み書き（fwrite）',
  fseek: 'ファイルの読み書き（fseek）',
  ftell: 'ファイルの読み書き（ftell）',
  fgetpos: 'ファイルの読み書き（fgetpos）',
  fsetpos: 'ファイルの読み書き（fsetpos）',
  rewind: 'ファイルの読み書き（rewind）',
  tmpfile: 'ファイルの読み書き（tmpfile）',
  tmpnam: 'ファイルの読み書き（tmpnam）',
  rename: 'ファイルの名前の変更（std::rename）',
  abort: 'std::abort',
  atexit: 'std::atexit',
  quick_exit: 'std::quick_exit',
};

/** The library a program compiles against: what `#include` and `std::` give it, and `Turtle`. */
export class Library {
  /** The iterator classes, by name, which the containers share. */
  readonly iterators = new Map<string, ClassInfo>();
  /** The instances of the class templates, by their template arguments. */
  readonly instances = new Map<string, ClassInfo>();
  /** The compiler of the program, which the library asks to compile the operations its templates need. */
  compiler!: ExpressionCompiler;
  readonly stringClass: ClassInfo;
  readonly turtle: ClassInfo;
  readonly streams: Streams;
  private readonly exceptions: Map<string, ClassInfo>;
  private readonly stdNames = new Map<string, Entity>();
  private readonly localeCtypeOverloads = new Map<string, FunctionInfo>();
  private readonly globalNames = new Map<string, Entity>();
  private readonly headers = new Set<string>();
  /** `FILE`, which only `stdout` and `stderr` point to. */
  readonly fileClass: ClassInfo;
  private readonly files = new Map<'stdout' | 'stderr', Box>();
  private readonly removeFile = native('remove', [CONST_CHAR_PTR], INT, () => {}, {
    uses: (row) => this.compiler.unsupported(row, 'ファイルの削除（remove）'),
  });

  constructor() {
    this.fileClass = new ClassInfo('FILE', 'struct');
    this.fileClass.isComplete = true;
    this.fileClass.isNoncopyable = true;
    this.fileClass.library = { kind: 'FILE', args: [], size: 152, align: 8 };
    for (const name of ['stdout', 'stderr'] as const) this.files.set(name, new Box(undefined));
    this.stringClass = stringClass(this);
    this.exceptions = exceptionClasses(() => this.stringType);
    this.turtle = turtleClass(
      () => this.exception('runtime_error'),
      () => this.stringType
    );
    this.streams = new Streams(this);
    this.populate();
  }

  get stringType(): Type {
    return classType(this.stringClass);
  }

  fileStore(name: 'stdout' | 'stderr'): Box {
    return this.files.get(name) as Box;
  }

  /** The standard stream a `FILE*` points to. */
  fileTarget(pointer: Ptr): 'stdout' | 'stderr' {
    if (pointer.store === this.files.get('stderr')) return 'stderr';
    if (pointer.store === this.files.get('stdout')) return 'stdout';
    throw new CppRuntimeError('nullAccess');
  }

  exception(name: string): ClassInfo {
    return this.exceptions.get(name) as ClassInfo;
  }

  include(header: string): void {
    this.headers.add(header);
  }

  std(name: string): Entity | undefined {
    const visible = isVisible(name, this.headers, 'std');
    const entity = visible ? this.stdNames.get(name) : undefined;
    const cOverload = this.cOverload(name);
    if (cOverload) {
      return { kind: 'functions', functions: [...(entity?.kind === 'functions' ? entity.functions : []), cOverload] };
    }
    if (entity?.kind === 'functions' && hasLocaleCtypeOverload(name, this.headers)) {
      let overload = this.localeCtypeOverloads.get(name);
      if (!overload) {
        overload = generic(name, () => {});
        this.localeCtypeOverloads.set(name, overload);
      }
      return { kind: 'functions', functions: [...entity.functions, overload] };
    }
    const feature = visible && Object.hasOwn(UNSUPPORTED_STD_NAMES, name) ? UNSUPPORTED_STD_NAMES[name] : undefined;
    return entity ?? (feature ? { kind: 'unsupported', feature } : this.unsupportedCName(name));
  }

  global(name: string): Entity | undefined {
    const cOverload = this.cOverload(name);
    if (cOverload) return { kind: 'functions', functions: [cOverload] };
    const visible = name === 'Turtle' || isVisible(name, this.headers, 'global');
    return (visible ? this.globalNames.get(name) : undefined) ?? this.unsupportedCName(name);
  }

  rebindCOverloads(name: string, standard: FunctionInfo[], declared: FunctionInfo[]): FunctionInfo[] {
    const global = this.global(name);
    if (global?.kind !== 'functions') return standard;
    const definitions = declared.filter((fn) => redeclaresLibcFunction(fn, this.headers));
    if (definitions.length === 0) return standard;
    return standard.map((fn) => {
      if (!global.functions.includes(fn)) return fn;
      const definition = definitions.find((candidate) => sameParameters(candidate, fn));
      return definition ?? fn;
    });
  }

  private cOverload(name: string): FunctionInfo | undefined {
    if (name === 'remove' && isLibcGlobalDeclared(name, this.headers)) return this.removeFile;
  }

  private unsupportedCName(name: string): Entity | undefined {
    if (
      Object.hasOwn(UNSUPPORTED_C_NAMES, name) &&
      (isLibcGlobalDeclared(name, this.headers) || isLibcHeaderMacro(name, this.headers))
    ) {
      return { kind: 'unsupported', feature: UNSUPPORTED_C_NAMES[name] };
    }
  }

  conflictsWithGlobal(name: string, entity: Type | FunctionInfo): boolean {
    return conflictsWithLibcGlobal(name, entity, this.headers);
  }

  isHeaderMacro(name: string): boolean {
    return isLibcHeaderMacro(name, this.headers);
  }

  /** The header to include for a library name the program uses without including it, if the library has the name. */
  missingHeader(name: string): string | undefined {
    if (
      isVisible(name, this.headers, 'global') ||
      isVisible(name, this.headers, 'std') ||
      !(this.stdNames.has(name) || this.globalNames.has(name))
    )
      return undefined;
    return headerOf(name);
  }

  /** Whether a type is one of the library's classes (or a pointer to one), whose namespace `std` a call searches. */
  isStdType(type: Type): boolean {
    const target = type.kind === 'pointer' || type.kind === 'reference' ? type.to : type;
    return target.kind === 'class' && target.cls.library !== undefined && target.cls !== this.turtle;
  }

  isStringLike(type: Type): boolean {
    return type.kind === 'class' && type.cls === this.stringClass;
  }

  private addStd(name: string, entity: Entity): void {
    this.stdNames.set(name, entity);
  }

  private addFunctions(names: Map<string, FunctionInfo[]>, target: Map<string, Entity>): void {
    for (const [name, functions] of names) {
      const existing = target.get(name);
      if (existing?.kind === 'functions') existing.functions.push(...functions);
      else target.set(name, { kind: 'functions', functions: [...functions] });
    }
  }

  private populate(): void {
    this.globalNames.set('Turtle', { kind: 'class', cls: this.turtle });
    const file: Entity = { kind: 'type', type: classType(this.fileClass) };
    this.globalNames.set('FILE', file);
    this.addStd('FILE', file);
    this.addStd('string', { kind: 'class', cls: this.stringClass });
    for (const [name, cls] of this.exceptions) this.addStd(name, { kind: 'class', cls });
    const { streams } = this;
    const ostreamType = classType(streams.ostream);
    for (const [name, target] of [
      ['cout', 'stdout'],
      ['cerr', 'stderr'],
      ['clog', 'clog'],
    ] as const) {
      // Each run has its own standard streams, whose formatting state the program may change.
      this.addStd(name, {
        kind: 'value',
        make: (row) => ({
          type: ostreamType,
          isLvalue: true,
          row,
          run: (frame) => new Ptr(frame.runtime.standardStream(target), 0),
        }),
      });
    }
    for (const [name, cls] of [
      ['ostream', streams.ostream],
      ['istream', streams.istream],
      ['ostringstream', streams.ostringstream],
      ['istringstream', streams.istringstream],
      ['stringstream', streams.stringstream],
      ['ios_base', streams.ios],
      ['ios', streams.ios],
    ] as const) {
      this.addStd(name, { kind: 'class', cls });
    }
    this.addStd('streamsize', { kind: 'type', type: LONG });
    for (const [name, apply] of Object.entries(MANIPULATORS)) {
      const isOutputOnly = OUTPUT_MANIPULATORS.has(name);
      this.addStd(name, {
        kind: 'value',
        make: (row) => streams.manipulatorExpr(row, apply, `std::${name}`, isOutputOnly),
      });
    }
    const manipulatorFunctions = new Map<string, FunctionInfo[]>();
    const parameterized: [string, Type, (stream: StreamValue, value: number) => void][] = [
      ['setw', INT, (stream, value) => (stream.width = value)],
      ['setprecision', INT, (stream, value) => (stream.precision = value)],
      ['setfill', CHAR, (stream, value) => (stream.fill = String.fromCodePoint(value & 0xff))],
      [
        'setbase',
        INT,
        (stream, value) => {
          stream.flags =
            (stream.flags & ~FLAGS.basefield) |
            (value === 16 ? FLAGS.hex : value === 8 ? FLAGS.oct : value === 10 ? FLAGS.dec : 0);
        },
      ],
      ['setiosflags', UINT, (stream, value) => (stream.flags |= value)],
      ['resetiosflags', UINT, (stream, value) => (stream.flags &= ~value)],
    ];
    for (const [name, paramType, apply] of parameterized) {
      const manipulatorType = streams.manipulatorType(OUTPUT_MANIPULATORS.has(name));
      manipulatorFunctions.set(name, [
        native(name, [paramType], manipulatorType, ([value]) => {
          const number = asNumber(value);
          return new ManipulatorValue((stream) => apply(stream, number), `std::${name}`);
        }),
      ]);
    }
    this.addFunctions(manipulatorFunctions, this.stdNames);
    this.addFunctions(new Map([['getline', streams.getline()]]), this.stdNames);
    this.addFunctions(stringFunctions(this, this.stringClass), this.stdNames);
    const c = cFunctions(this);
    this.addFunctions(c, this.stdNames);
    this.addFunctions(c, this.globalNames);
    // The global namespace shares <cmath>'s functions with std, as one overload set.
    const math = mathFunctions();
    this.addFunctions(math, this.stdNames);
    this.addFunctions(math, this.globalNames);
    for (const [name, entity] of constantsOf(this)) {
      if (name.startsWith('std::')) this.addStd(name.slice(5), entity);
      else this.globalNames.set(name, entity);
    }
    for (const template of containerTemplates(this)) this.addStd(template.name, { kind: 'template', template });
    for (const [name, cls] of randomEngines()) this.addStd(name, { kind: 'class', cls });
    this.addFunctions(algorithmFunctions(this), this.stdNames);
    this.addFunctions(new Map([['make_pair', [makePair(this)]]]), this.stdNames);
    const exit = native('exit', [INT], VOID, ([status]) => {
      throw new ProgramExit(asNumber(status));
    });
    this.addFunctions(new Map([['exit', [exit]]]), this.stdNames);
    this.addFunctions(new Map([['exit', [exit]]]), this.globalNames);
    for (const [name, type] of [
      ['size_t', ULONG],
      ['ptrdiff_t', LONG],
      ['intptr_t', LONG],
      ['uintptr_t', ULONG],
      ['intmax_t', LONG],
      ['uintmax_t', ULONG],
      ['int8_t', SCHAR],
      ['int16_t', SHORT],
      ['int32_t', INT],
      ['int64_t', LLONG],
      ['uint8_t', UCHAR],
      ['uint16_t', USHORT],
      ['uint32_t', UINT],
      ['uint64_t', ULLONG],
      ['nullptr_t', { kind: 'nullptr' }],
    ] as const) {
      const entity = { kind: 'type', type } as const;
      this.addStd(name, entity);
      this.globalNames.set(name, entity);
    }
    this.globalNames.set('ssize_t', { kind: 'type', type: LONG });
  }
}

/** The manipulators that libc++ declares only for `<<`. */
const OUTPUT_MANIPULATORS = new Set(['endl', 'ends', 'flush', 'setfill']);

const MANIPULATORS: Record<string, (stream: StreamValue, frame: Frame) => void> = {
  endl: (stream, frame) => stream.write(frame, '\n'),
  ends: (stream, frame) => stream.write(frame, '\0'),
  flush: () => {},
  fixed: (stream) => (stream.flags = (stream.flags & ~FLAGS.floatfield) | FLAGS.fixed),
  scientific: (stream) => (stream.flags = (stream.flags & ~FLAGS.floatfield) | FLAGS.scientific),
  hexfloat: (stream) => (stream.flags |= FLAGS.floatfield),
  defaultfloat: (stream) => (stream.flags &= ~FLAGS.floatfield),
  left: (stream) => (stream.flags = (stream.flags & ~FLAGS.adjustfield) | FLAGS.left),
  right: (stream) => (stream.flags = (stream.flags & ~FLAGS.adjustfield) | FLAGS.right),
  internal: (stream) => (stream.flags = (stream.flags & ~FLAGS.adjustfield) | FLAGS.internal),
  dec: (stream) => (stream.flags = (stream.flags & ~FLAGS.basefield) | FLAGS.dec),
  hex: (stream) => (stream.flags = (stream.flags & ~FLAGS.basefield) | FLAGS.hex),
  oct: (stream) => (stream.flags = (stream.flags & ~FLAGS.basefield) | FLAGS.oct),
  boolalpha: (stream) => (stream.flags |= FLAGS.boolalpha),
  noboolalpha: (stream) => (stream.flags &= ~FLAGS.boolalpha),
  showpoint: (stream) => (stream.flags |= FLAGS.showpoint),
  noshowpoint: (stream) => (stream.flags &= ~FLAGS.showpoint),
  showpos: (stream) => (stream.flags |= FLAGS.showpos),
  noshowpos: (stream) => (stream.flags &= ~FLAGS.showpos),
  showbase: (stream) => (stream.flags |= FLAGS.showbase),
  noshowbase: (stream) => (stream.flags &= ~FLAGS.showbase),
  uppercase: (stream) => (stream.flags |= FLAGS.uppercase),
  nouppercase: (stream) => (stream.flags &= ~FLAGS.uppercase),
  skipws: (stream) => (stream.flags |= FLAGS.skipws),
  noskipws: (stream) => (stream.flags &= ~FLAGS.skipws),
};

/** The functions of `<cmath>`, with the overloads for `float`, `double`, `long double`, and integers. */
function mathFunctions(): Map<string, FunctionInfo[]> {
  const functions = new Map<string, FunctionInfo[]>();
  for (const [name, fn] of Object.entries(UNARY)) {
    const overloads = [
      native(name, [FLOAT], FLOAT, ([x]) => Math.fround(fn(x as number))),
      native(name, [DOUBLE], DOUBLE, ([x]) => fn(x as number)),
      native(name, [LDOUBLE], LDOUBLE, ([x]) => fn(x as number)),
      promotedMath(name, 1, ([x]) => fn(x)),
    ];
    functions.set(name, overloads);
    functions.set(`${name}f`, [native(`${name}f`, [FLOAT], FLOAT, ([x]) => Math.fround(fn(x as number)))]);
    functions.set(`${name}l`, [native(`${name}l`, [LDOUBLE], LDOUBLE, ([x]) => fn(x as number))]);
  }
  for (const [name, fn] of Object.entries(BINARY)) {
    functions.set(name, [
      native(name, [FLOAT, FLOAT], FLOAT, ([x, y]) => Math.fround(fn(x as number, y as number))),
      native(name, [DOUBLE, DOUBLE], DOUBLE, ([x, y]) => fn(x as number, y as number)),
      native(name, [LDOUBLE, LDOUBLE], LDOUBLE, ([x, y]) => fn(x as number, y as number)),
      promotedMath(name, 2, ([x, y]) => fn(x, y)),
    ]);
    functions.set(`${name}f`, [
      native(`${name}f`, [FLOAT, FLOAT], FLOAT, ([x, y]) => Math.fround(fn(x as number, y as number))),
    ]);
    functions.set(`${name}l`, [
      native(`${name}l`, [LDOUBLE, LDOUBLE], LDOUBLE, ([x, y]) => fn(x as number, y as number)),
    ]);
  }
  functions.set('fma', [
    native('fma', [FLOAT, FLOAT, FLOAT], FLOAT, ([x, y, z]) => fma(x as number, y as number, z as number, true)),
    native('fma', [DOUBLE, DOUBLE, DOUBLE], DOUBLE, ([x, y, z]) => fma(x as number, y as number, z as number)),
    native('fma', [LDOUBLE, LDOUBLE, LDOUBLE], LDOUBLE, ([x, y, z]) => fma(x as number, y as number, z as number)),
    promotedMath('fma', 3, ([x, y, z]) => fma(x, y, z)),
  ]);
  functions.set('abs', [
    native('abs', [INT], INT, ([x]) => integerAbs(x, INT)),
    native('abs', [LONG], LONG, ([x]) => integerAbs(x, LONG)),
    native('abs', [LLONG], LLONG, ([x]) => integerAbs(x, LLONG)),
    native('abs', [FLOAT], FLOAT, ([x]) => Math.abs(x as number)),
    native('abs', [DOUBLE], DOUBLE, ([x]) => Math.abs(x as number)),
    native('abs', [LDOUBLE], LDOUBLE, ([x]) => Math.abs(x as number)),
  ]);
  for (const name of ['labs', 'llabs'])
    functions.set(name, [
      native(name, [name === 'labs' ? LONG : LLONG], name === 'labs' ? LONG : LLONG, ([x]) =>
        integerAbs(x, name === 'labs' ? LONG : LLONG)
      ),
    ]);
  for (const [name, test] of [
    ['isnan', (x: number) => Number.isNaN(x)],
    ['isinf', (x: number) => !Number.isFinite(x) && !Number.isNaN(x)],
    ['isfinite', (x: number) => Number.isFinite(x)],
    ['signbit', (x: number) => x < 0 || Object.is(x, -0)],
  ] as const) {
    functions.set(name, classification(name, test));
  }
  return functions;
}

/** The overloads of a classification function such as `isnan`, which libc++ also has for integers. */
function classification(name: string, test: (x: number) => boolean): FunctionInfo[] {
  return [
    ...[FLOAT, DOUBLE, LDOUBLE].map((type) => native(name, [type], BOOL, ([x]) => (test(x as number) ? 1 : 0))),
    generic(name, (args) => {
      const type = args.length === 1 ? unqualified(args[0].type) : undefined;
      if (type?.kind !== 'int') return;
      return native(name, [type], BOOL, ([x]) => (test(asNumber(x)) ? 1 : 0));
    }),
  ];
}

const promotedMath = (name: string, arity: number, run: (args: number[]) => number): FunctionInfo =>
  generic(name, (args) => {
    if (args.length !== arity) return;
    const types = args.map((arg) => unqualified(nonReference(arg.type)));
    if (!types.every(isArithmetic)) return;
    if (types[0].kind === 'float' && types.every((type) => type.kind === 'float' && type.name === types[0].name))
      return;
    const result = types.some((type) => type.kind === 'float' && type.name === 'ldouble') ? LDOUBLE : DOUBLE;
    return native(name, types, result, (values) => run(values.map((value) => asNumber(value))));
  });

function integerAbs(value: unknown, type: IntType): number | bigint {
  const numeric = BigInt(value as number | bigint);
  if (numeric === intMin(type.name)) throw overflowError(typeName(type));
  const magnitude = numeric < 0n ? -numeric : numeric;
  return typeof value === 'bigint' ? magnitude : Number(magnitude);
}
