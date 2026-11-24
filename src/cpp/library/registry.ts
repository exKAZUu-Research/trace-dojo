import { FileSystemError } from '../../interpreter/programIo';
import { byteArray } from '../bytes';
import type { ConceptInfo } from '../concepts';
import { CppRuntimeError, ProgramExit } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { ClassTemplateInfo } from '../programTemplates';
import type { Frame } from '../runtime';
import type { Entity } from '../scopes';
import {
  CHAR,
  ClassInfo,
  classType,
  decay,
  type FunctionInfo,
  INT,
  LLONG,
  LONG,
  nonReference,
  referenceTo,
  sameParameters,
  sameType,
  SCHAR,
  SHORT,
  type Type,
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
import { orderingClasses, type OrderingName } from './compare';
import { constantsOf } from './constants';
import { containerTemplates } from './containers';
import { exceptionClasses } from './exceptions';
import {
  FLAGS,
  ManipulatorValue,
  OPEN_MODE,
  Streams,
  type StreamValue,
  StreamValue as StreamValueClass,
} from './iostream';
import {
  conflictsWithLibcGlobal,
  conflictsWithStdName,
  isLibcFunctionMacro,
  isLibcGlobalDeclared,
  isLibcHeaderMacro,
  isSdkGlobalType,
  isSdkStdDeclared,
  isSdkStdForwardOnly,
  redeclaresLibcFunction,
} from './libcGlobals';
import { mathFunctions } from './math';
import { randomEngines } from './random';
import { stringClass, stringFunctions } from './string';
import { asNumber, CONST_CHAR_PTR, generic, native, readCString } from './support';
import { turtleClass } from './turtle';
import { headerOf, isCtypeFunction, isVisible } from './visibility';

/** A class template of the library, such as `std::vector`, which template arguments instantiate. */
export type LibraryTemplate =
  | {
      name: string;
      takesArrayBound?: false;
      instantiate: (args: Type[], row: number) => Type;
      /** The class template or alias template the program declares, when the template is the program's. */
      program?: ClassTemplateInfo | ConceptInfo;
    }
  | { name: string; takesArrayBound: true; instantiate: (element: Type, bound: number) => Type; program?: undefined };

/** The names the library declares that the interpreter leaves out, with the feature they belong to. */
const UNSUPPORTED_STD_NAMES: Record<string, string> = {
  wcin: '標準入力（std::wcin）',
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
  time: '時刻（std::time）',
  clock: '時刻（std::clock）',
  system: '外部のコマンドの実行（std::system）',
  getenv: '環境変数（std::getenv）',
  signal: 'シグナル（std::signal）',
  raise: 'シグナル（std::raise）',
  setjmp: '大域的な脱出（setjmp）',
  longjmp: '大域的な脱出（longjmp）',
  vscanf: '標準入力（vscanf）',
  vfscanf: '標準入力・ファイル（vfscanf）',
  freopen: 'ファイルの読み書き（freopen）',
  fread: 'ファイルの読み書き（fread）',
  fwrite: 'ファイルの読み書き（fwrite）',
  fgetpos: 'ファイルの読み書き（fgetpos）',
  fsetpos: 'ファイルの読み書き（fsetpos）',
  tmpfile: 'ファイルの読み書き（tmpfile）',
  tmpnam: 'ファイルの読み書き（tmpnam）',
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
  private readonly orderings = orderingClasses();
  private readonly nativeStdTemplates = new Set<FunctionInfo>();
  private readonly localeCtypeOverloads = new Map<string, FunctionInfo>();
  private readonly globalNames = new Map<string, Entity>();
  private readonly headers = new Set<string>();
  private readonly incomplete = new Map<ClassInfo, string>();
  /** `FILE`, which only `stdout` and `stderr` point to. */
  readonly fileClass: ClassInfo;
  private readonly files = new Map<'stdin' | 'stdout' | 'stderr', Box>();
  private readonly removeFile = native('remove', [CONST_CHAR_PTR], INT, ([path], { frame }) => {
    try {
      frame.runtime.io.files.remove(
        new TextDecoder().decode(byteArray(readCString(path as Ptr, frame.runtime))),
        'file'
      );
      return 0;
    } catch (error) {
      if (error instanceof FileSystemError) return -1;
      throw error;
    }
  });

  constructor() {
    this.fileClass = new ClassInfo('FILE', 'struct');
    this.fileClass.isComplete = true;
    this.fileClass.isNoncopyable = true;
    this.fileClass.isAssignmentDeleted = true;
    this.fileClass.library = { kind: 'FILE', args: [], size: 152, align: 8 };
    for (const name of ['stdin', 'stdout', 'stderr'] as const) this.files.set(name, new Box(undefined));
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

  fileStore(name: 'stdin' | 'stdout' | 'stderr'): Box {
    return this.files.get(name) as Box;
  }

  /** The stream a `FILE*` reads from: standard input, or a file `fopen` opened to read. */
  inputStream(pointer: Ptr, frame: Frame): StreamValue {
    if (pointer.isNull) throw new CppRuntimeError('nullAccess');
    if (pointer.store === this.files.get('stdin')) return frame.runtime.standardInput();
    const file = pointer.store instanceof Box ? pointer.store.value : undefined;
    if (file instanceof StreamValueClass && file.mode & OPEN_MODE.in) return file;
    throw new CppRuntimeError('custom', '書き込み用に開いたファイルからは読めません。');
  }

  /** Writes bytes to what a `FILE*` points to: standard output or error, or a file `fopen` opened to write. */
  writeFile(pointer: Ptr, frame: Frame, bytes: string): void {
    if (pointer.isNull) throw new CppRuntimeError('nullAccess');
    if (pointer.store === this.files.get('stdout') || pointer.store === this.files.get('stderr')) {
      frame.runtime.write(this.fileTarget(pointer), bytes);
      return;
    }
    const file = pointer.store instanceof Box ? pointer.store.value : undefined;
    if (!(file instanceof StreamValueClass) || !file.isOpen)
      throw new CppRuntimeError('custom', '閉じたファイルには書き込めません。');
    if (!(file.mode & (OPEN_MODE.out | OPEN_MODE.app)))
      throw new CppRuntimeError('custom', '読み込み用に開いたファイルには書き込めません。');
    file.write(frame, bytes);
  }

  /** The standard stream a `FILE*` points to. */
  fileTarget(pointer: Ptr): 'stdout' | 'stderr' {
    if (pointer.store === this.files.get('stderr')) return 'stderr';
    if (pointer.store === this.files.get('stdout')) return 'stdout';
    throw new CppRuntimeError('nullAccess');
  }

  /** The result type of `<=>`: `std::strong_ordering`, `std::weak_ordering`, or `std::partial_ordering`. */
  ordering(name: OrderingName): ClassInfo {
    return this.orderings.get(name) as ClassInfo;
  }

  exception(name: string): ClassInfo {
    return this.exceptions.get(name) as ClassInfo;
  }

  include(header: string): void {
    this.headers.add(header);
    for (const [cls, name] of this.incomplete) {
      if (isSdkStdForwardOnly(name, this.headers)) continue;
      cls.isComplete = true;
      this.incomplete.delete(cls);
    }
  }

  /**
   * The template arguments of a library class template that an initializer's arguments deduce, as its deduction
   * guides do (`std::vector v{1, 2}`, `std::pair p(1, 2.5)`, `std::array a{1, 2, 3}`), or undefined when they deduce
   * none. A class template that takes an array bound gives its element type, then its bound.
   */
  deduceTemplateArguments(name: string, args: readonly Expr[]): Type[] | undefined {
    if (args.some((arg) => arg.braced)) return undefined;
    const types = args.map((arg) => decay(unqualified(nonReference(arg.type))));
    const [first, second] = types;
    if (!first) return undefined;
    // An instance of the template deduces itself.
    const library = first.kind === 'class' ? first.cls.library : undefined;
    if (types.length === 1 && library?.kind === name) {
      const bound = library.aggregateArray?.type.length;
      return bound === undefined ? [...library.args] : [library.args[0], arrayBound(bound)];
    }
    const allSame = types.every((type) => sameType(type, first, false));
    if (name === 'pair') return types.length === 2 ? types : undefined;
    if (name === 'array') return allSame ? [first, arrayBound(types.length)] : undefined;
    if (!DEDUCIBLE_CONTAINERS.has(name)) return undefined;
    const isMap = MAP_CONTAINERS.has(name);
    if (allSame && !isMap) return [first];
    // `std::vector v(3, 2.5)` takes a count, then the value of each element.
    if (types.length === 2 && first.kind === 'int' && second && !isMap) return [second];
    const pair = first.kind === 'class' && first.cls.library?.kind === 'pair' ? first.cls.library.args : undefined;
    if (isMap && allSame && pair) return [unqualified(pair[0]), pair[1]];
    return undefined;
  }

  /** Whether the included headers declare `std::name`. */
  declaresStd(name: string): boolean {
    return isVisible(name, this.headers, 'std');
  }

  std(name: string): Entity | undefined {
    if (!isVisible(name, this.headers, 'std')) return undefined;
    const entity = this.stdNames.get(name);
    if (entity?.kind === 'class') this.trackDefinition(name, classType(entity.cls));
    if (entity && entity.kind !== 'functions') return entity;
    const functions = this.stdFunctions(name, entity?.functions ?? []);
    if (functions.length > 0) return { kind: 'functions', functions };
    const feature = Object.hasOwn(UNSUPPORTED_STD_NAMES, name) ? UNSUPPORTED_STD_NAMES[name] : undefined;
    return feature ? { kind: 'unsupported', feature } : this.unsupportedCName(name);
  }

  trackDefinition(name: string, type: Type): Type {
    if (type.kind === 'class' && isSdkStdForwardOnly(name, this.headers)) {
      type.cls.isComplete = false;
      this.incomplete.set(type.cls, name);
    }
    return type;
  }

  private stdFunctions(name: string, registered: FunctionInfo[]): FunctionInfo[] {
    const templates = isSdkStdDeclared(name, this.headers, 'template');
    const ordinary = isSdkStdDeclared(name, this.headers, 'function');
    const visible = registered.filter((fn) =>
      fn.isTemplate || this.nativeStdTemplates.has(fn) ? templates : ordinary
    );
    const cOverload = ordinary ? this.cOverload(name) : undefined;
    if (cOverload) visible.push(cOverload);
    if (templates && isCtypeFunction(name)) {
      let overload = this.localeCtypeOverloads.get(name);
      if (!overload) {
        overload = generic(name, () => {});
        this.localeCtypeOverloads.set(name, overload);
      }
      visible.push(overload);
    }
    return visible;
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
    const definitions = declared.filter((fn) => this.isLibcDefinition(fn));
    if (definitions.length === 0) return standard;
    return standard.map((fn) => {
      if (fn.mathIntrinsic || !global.functions.includes(fn)) return fn;
      const definition = definitions.find((candidate) => sameParameters(candidate, fn));
      return definition ?? fn;
    });
  }

  sameCFunction(declaration: FunctionInfo, library: FunctionInfo): boolean {
    return library.libcGlobal === true && redeclaresLibcFunction(declaration, this.headers);
  }

  mergeCOverloads(name: string, standard: FunctionInfo[], declared: FunctionInfo[]): FunctionInfo[] {
    const visible = this.rebindCOverloads(name, standard, declared);
    const overloads = declared.filter(
      (fn) =>
        !redeclaresLibcFunction(fn, this.headers) ||
        !visible.some(
          (candidate) => candidate.native && sameParameters(candidate, fn) && (!fn.isDefined || candidate.mathIntrinsic)
        )
    );
    return [...new Set([...overloads, ...visible])];
  }

  isLibcDefinition(fn: FunctionInfo): boolean {
    return fn.isDefined && !fn.native && redeclaresLibcFunction(fn, this.headers);
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

  conflictsWithStdName(name: string, isFunction: boolean): boolean {
    return conflictsWithStdName(name, isFunction, this.headers);
  }

  hasGlobalDeclaration(name: string): boolean {
    return isLibcGlobalDeclared(name, this.headers);
  }

  isHeaderMacro(name: string): boolean {
    return isLibcHeaderMacro(name, this.headers);
  }

  isFunctionMacro(name: string): boolean {
    return isLibcFunctionMacro(name, this.headers);
  }

  unimplementedSdkName(name: string, scope: 'global' | 'std'): string | undefined {
    if (scope === 'std') return isSdkStdDeclared(name, this.headers) ? `std::${name}` : undefined;
    if (this.hasGlobalDeclaration(name) || this.isHeaderMacro(name) || isSdkGlobalType(name, this.headers)) return name;
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
      if (target === this.globalNames) {
        for (const fn of functions) fn.libcGlobal = !fn.mathIntrinsic && !fn.instantiate;
      }
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
    for (const [name, cls] of this.orderings) this.addStd(name, { kind: 'class', cls });
    this.addStreams();
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

  private addStreams(): void {
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
    const istreamType = classType(streams.istream);
    this.addStd('cin', {
      kind: 'value',
      make: (row) => ({
        type: istreamType,
        isLvalue: true,
        row,
        run: (frame) => new Ptr(frame.runtime.standardInput(), 0),
      }),
    });
    for (const [name, cls] of [
      ['ostream', streams.ostream],
      ['istream', streams.istream],
      ['ostringstream', streams.ostringstream],
      ['istringstream', streams.istringstream],
      ['stringstream', streams.stringstream],
      ['ifstream', streams.ifstream],
      ['ofstream', streams.ofstream],
      ['fstream', streams.fstream],
      ['ios_base', streams.iosBase],
      ['ios', streams.ios],
    ] as const) {
      this.addStd(name, { kind: 'class', cls });
    }
    this.addStd('streamsize', { kind: 'type', type: LONG });
    for (const [name, apply] of Object.entries(MANIPULATORS)) {
      const isOutputOnly = OUTPUT_MANIPULATORS.has(name);
      const streamType = referenceTo(classType(isOutputOnly ? streams.ostream : streams.iosBase));
      const fn = native(name, [streamType], streamType, ([location], { frame }) => {
        const stream = location as Ptr;
        apply(stream.read() as StreamValue, frame);
        return stream;
      });
      fn.streamManipulator = isOutputOnly ? 'output' : 'both';
      if (isOutputOnly) this.nativeStdTemplates.add(fn);
      this.addStd(name, { kind: 'functions', functions: [fn] });
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
      const fn = native(name, [paramType], manipulatorType, ([value]) => {
        const number = asNumber(value);
        return new ManipulatorValue((stream) => apply(stream, number), `std::${name}`);
      });
      if (name === 'setfill') this.nativeStdTemplates.add(fn);
      manipulatorFunctions.set(name, [fn]);
    }
    this.addFunctions(manipulatorFunctions, this.stdNames);
    this.addFunctions(new Map([['getline', streams.getline()]]), this.stdNames);
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

/** The library's class templates whose deduction guides take the elements of an initializer list. */
const DEDUCIBLE_CONTAINERS = new Set([
  'vector',
  'deque',
  'list',
  'forward_list',
  'set',
  'multiset',
  'unordered_set',
  'unordered_multiset',
  'map',
  'multimap',
  'unordered_map',
  'unordered_multimap',
]);
const MAP_CONTAINERS = new Set(['map', 'multimap', 'unordered_map', 'unordered_multimap']);

function arrayBound(length: number): Type {
  return { kind: 'int', name: 'ulong', templateValue: BigInt(length) };
}
