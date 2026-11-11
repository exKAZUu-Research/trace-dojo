import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Module, Statement } from './ast';
import { AttributeStore } from './attributeStore';
import { PyBytes } from './bytesValues';
import { MappingNamespace } from './classes';
import { method } from './define';
import { Frame } from './frame';
import { isIncompleteInput } from './incompleteInput';
import { findIndentationError } from './indentation';
import { builtinClassWithBase } from './modules/moduleClasses';
import { defineProperty } from './modules/numberSupport';
import { namespaceOf } from './namespaces';
import { argument } from './nativeArgs';
import { callValue, getAttribute, isTruthy, lookupSpecial } from './objects';
import { parseDynamicCode } from './parse';
import { localVariables, programFrames } from './reflection';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import { hideSubclass } from './subclasses';
import { codeClass, type CodeInfo, functionCode, hasCode, noteUnwinding, registerCode } from './tracebacks';
import {
  dictClass,
  exceptionClassNamed,
  functionClass,
  newException,
  None,
  typeError,
  typeName,
  valueError,
} from './types';
import { unavailableValue } from './unavailableValues';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Kwargs,
  type PyClass,
  PyDict,
  PyError,
  PyFunction,
  PyInstance,
  PyOpaque,
  type PyTuple,
  type PyValue,
} from './values';

export type Mode = 'exec' | 'eval' | 'single';

interface Code {
  module: Module;
  mode: Mode;
  filename: string;
}

/** The `__future__` features of the code that runs in each globals, which code it compiles inherits. */
const futureFeaturesOfGlobals = new WeakMap<Map<string, PyValue>, readonly string[]>();

export function recordFutureFeatures(globals: Map<string, PyValue>, features: readonly string[]): void {
  if (features.length > 0) futureFeaturesOfGlobals.set(globals, features);
}

/** The features the calling code enables, which the code `exec`, `eval`, and `compile` compile inherits. */
function inheritedFeatures(): readonly string[] {
  const caller = programFrames().at(-1);
  return (caller && futureFeaturesOfGlobals.get(caller.globals)) ?? [];
}

// Code objects ------------------------------------------------------------------------------------------------------

function newCode(code: Code, flags: PyValue = 0n): PyOpaque {
  const info: CodeInfo = {
    name: '<module>',
    qualifiedName: '<module>',
    firstRow: 0,
    filename: code.filename,
    compiled: code,
    futureFlags: futureFlagsOf(code, flags),
  };
  const object = new PyOpaque(codeClass, '', info);
  registerCode(code.module.scope, object);
  return object;
}

/**
 * The `co_flags` of compiled module code: the future flags compile() was given, and of the features the code enables,
 * those that change what CPython compiles.
 */
function futureFlagsOf(code: Code, flags: PyValue): bigint {
  let all = (typeof flags === 'bigint' ? flags : 0n) & FUTURE_MASK;
  for (const [flag, feature] of FUTURE_FLAGS) {
    if (RECORDED_FEATURES.has(feature) && code.module.futureFeatures.includes(feature)) all |= flag;
  }
  return all;
}

// The builtins ------------------------------------------------------------------------------------------------------

export const COMPILE_KEYWORDS = ['source', 'filename', 'mode', 'flags', 'dont_inherit', 'optimize', '_feature_version'];

/** `compile(source, filename, mode, flags=0, dont_inherit=False, optimize=-1)`. */
// code-gauge-allow functionCognitiveComplexity 16 -- Checks the arguments in the order CPython reports their errors in.
export function compile(args: PyValue[], kwargs: Kwargs): PyValue {
  const [source, filename, mode, flags, dontInherit, optimize] = COMPILE_KEYWORDS.map((name, index) =>
    argument(args, kwargs, index, name)
  );
  const { features, topLevelAwait, tree: treeKind } = compileFlags(flags);
  for (const [index, value] of [source, filename, mode].entries()) {
    if (value === undefined) {
      throw typeError(`compile() missing required argument '${COMPILE_KEYWORDS[index]}' (pos ${index + 1})`);
    }
  }
  const tree = astSupport?.isTree(source as PyValue) ? (source as PyValue) : undefined;
  if (tree !== undefined && treeKind !== undefined) return finishTree(tree, treeKind, optimize);
  const text = tree === undefined ? sourceText(source as PyValue) : astSupport?.unparse(tree);
  if (typeof text !== 'string') throw typeError('compile() arg 1 must be a string, bytes or AST object');
  if (typeof filename !== 'string') {
    throw typeError(`expected str, bytes or os.PathLike object, not ${typeName(filename as PyValue)}`);
  }
  if (typeof mode !== 'string')
    throw typeError(`compile() argument 'mode' must be str, not ${typeName(mode as PyValue)}`);
  if (mode !== 'exec' && mode !== 'eval' && mode !== 'single') {
    throw valueError("compile() mode must be 'exec', 'eval' or 'single'");
  }
  if (treeKind !== undefined && astSupport) {
    return finishTree(parseTree(astSupport, text, mode, filename), treeKind, optimize);
  }
  if (dontInherit === undefined || !isTruthy(dontInherit)) features.push(...inheritedFeatures());
  return newCode(compileInput(text, mode, filename, features, flags, topLevelAwait), flags);
}

/** `PyCF_DONT_IMPLY_DEDENT` and `PyCF_ALLOW_INCOMPLETE_INPUT`, with which `codeop` tells incomplete input. */
const DONT_IMPLY_DEDENT = 0x2_00n;
const ALLOW_INCOMPLETE_INPUT = 0x40_00n;

/**
 * Compiles source text with the input flags of compile(): without an implied dedent, a compound statement in single
 * mode needs the newline after it, and with incomplete input allowed, text that may continue raises
 * `_IncompleteInputError`.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Applies both input flags as CPython's compiler does.
function compileInput(
  text: string,
  mode: Mode,
  filename: string,
  features: string[],
  flags: PyValue | undefined,
  topLevelAwait: boolean
): Code {
  const bits = typeof flags === 'bigint' ? flags : 0n;
  const lacksNewline = (bits & DONT_IMPLY_DEDENT) !== 0n && mode === 'single' && lacksFinalNewline(text);
  try {
    const code = compileCode(text, mode, filename, features, topLevelAwait);
    const last = code.module.body.at(-1);
    if (lacksNewline && last !== undefined && isCompound(last)) {
      const cls = /\n[ \t]+$/.test(text) ? unshownIndentationErrorClass : unshownSyntaxErrorClass;
      throw syntaxError(cls, filename, 'single モードの複合文の後に改行がない');
    }
    return code;
  } catch (error) {
    if ((bits & ALLOW_INCOMPLETE_INPUT) === 0n || !(error instanceof PyError)) throw error;
    if (!(error.exception.cls === unshownSyntaxErrorClass || error.exception.cls === unshownIndentationErrorClass))
      throw error;
    if (lacksNewline || isIncompleteText(text, mode)) {
      throw syntaxError(unshownIncompleteInputErrorClass, filename, 'incomplete input');
    }
    throw error;
  }
}

/**
 * Whether the last statement of text lacks the newline that ends it when no dedent is implied: its own line, or the
 * line of its indented block's end, has none.
 */
function lacksFinalNewline(text: string): boolean {
  if (text.endsWith('\n')) return false;
  const lines = text.split('\n');
  if (!isBlankLine(lines.at(-1) as string)) return true;
  const lastCode = lines.findLast((line) => !isBlankLine(line)) ?? '';
  return /^[ \t\f]/.test(lastCode);
}

function isBlankLine(line: string): boolean {
  return /^[ \t\f]*(?:#.*)?\r?$/.test(line);
}

/** Whether text the grammar rejects may continue, deciding as CPython does for the text `codeop` asks about. */
function isIncompleteText(text: string, mode: Mode): boolean {
  const blank = text.split('\n').every(isBlankLine);
  if (!text.endsWith('\n') && mode !== 'exec' && !blank) {
    throw new UnsupportedFeatureError(
      'compile() の PyCF_ALLOW_INCOMPLETE_INPUT に、改行で終わらない single・eval モードの文字列を渡すこと'
    );
  }
  return isIncompleteInput(text, mode);
}

/** The tree compile() returns: the one parsed, or, for `ast.PyCF_OPTIMIZED_AST`, the one CPython's optimizer gives. */
function finishTree(tree: PyValue, kind: 'parsed' | 'optimized', optimize: PyValue | undefined): PyValue {
  if (kind === 'parsed' || !astSupport) return tree;
  // An optimization level of -1 is the interpreter's, which is 0 as the program runs without -O.
  const level = typeof optimize === 'bigint' ? Number(optimize) : 0;
  return astSupport.optimize(tree, level);
}

/** The tree `ast.parse` gives, raising the SyntaxError of text the grammar rejects. */
function parseTree(support: AstSupport, text: string, mode: Mode, filename: string): PyValue {
  const indentationError = findIndentationError(text);
  if (indentationError) throw syntaxError(unshownIndentationErrorClass, filename, reasonOf(indentationError));
  return support.parse(text, mode, (reason) => syntaxError(unshownSyntaxErrorClass, filename, reason));
}

/** How compile() makes and reads the trees of the `ast` module, which that module provides. */
export interface AstSupport {
  /** Builds the tree of source text, calling `syntaxError` for the SyntaxError of text the grammar rejects. */
  parse: (source: string, mode: Mode, syntaxError: (reason: string) => Error) => PyValue;
  unparse: (tree: PyValue) => string;
  /** Optimizes a tree as `ast.PyCF_OPTIMIZED_AST` does at an optimization level. */
  optimize: (tree: PyValue, level: number) => PyValue;
  isTree: (value: PyValue) => boolean;
}

let astSupport: AstSupport | undefined;

export function registerAstSupport(support: AstSupport): void {
  astSupport = support;
}

/** `eval(source, /, globals=None, locals=None)`. */
export function evaluate(args: PyValue[], kwargs: Kwargs): PyValue {
  const [source, globals, locals] = codeArguments(args, kwargs, 'eval');
  if (globals !== None && !(globals instanceof PyDict)) {
    throw typeError(
      isMapping(globals) ? 'globals must be a real dict; try eval(expr, {}, mapping)' : 'globals must be a dict'
    );
  }
  if (locals !== None && !isMapping(locals)) throw typeError('locals must be a mapping');
  if (source instanceof PyFunction) return runFunctionCode(source, globals, 'eval');
  const code =
    typeof source === 'string'
      ? compileCode(source.replace(/^[ \t]+/, ''), 'eval', '<string>', [...inheritedFeatures()])
      : source;
  return runCode(code, globals, locals);
}

/** `exec(source, /, globals=None, locals=None, *, closure=None)`. */
export function execute(args: PyValue[], kwargs: Kwargs): PyValue {
  const [source, globals, locals] = codeArguments(args, kwargs, 'exec');
  if (globals !== None && !(globals instanceof PyDict))
    throw typeError(`exec() globals must be a dict, not ${typeName(globals)}`);
  if (locals !== None && !isMapping(locals))
    throw typeError(`locals must be a mapping or None, not ${typeName(locals)}`);
  if ((kwargs?.get('closure') ?? None) !== None) {
    // The code this grader compiles never has free variables, which a closure would give values.
    throw typeError(
      typeof source === 'string'
        ? 'closure can only be used when source is a code object'
        : 'cannot use a closure with this code object'
    );
  }
  if (source instanceof PyFunction) {
    runFunctionCode(source, globals, 'exec');
    return None;
  }
  const code = typeof source === 'string' ? compileCode(source, 'exec', '<string>', [...inheritedFeatures()]) : source;
  runCode(code, globals, locals);
  return None;
}

/** The source, globals, and locals arguments of eval() or exec(). */
function codeArguments(args: PyValue[], kwargs: Kwargs, name: string): [string | Code | PyFunction, PyValue, PyValue] {
  const source = sourceText(args[0]);
  if (source === undefined) throw typeError(`${name}() arg 1 must be a string, bytes or code object`);
  return [source, argument(args, kwargs, 1, 'globals') ?? None, argument(args, kwargs, 2, 'locals') ?? None];
}

/**
 * The text of a source argument, what the code object it is compiles, the function whose code object it is, or
 * undefined for any other value.
 */
function sourceText(value: PyValue): string | Code | PyFunction | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof PyInstance && typeof value.primitive === 'string') return value.primitive;
  if (value instanceof PyBytes) return new TextDecoder().decode(value.data);
  if (value instanceof PyOpaque && value.cls === codeClass) {
    const { compiled, fn } = value.data as CodeInfo;
    if (fn) return fn;
    if (!compiled) throw new UnsupportedFeatureError('exec()・eval() にフレームのコードオブジェクトを渡すこと');
    return compiled as Code;
  }
  return undefined;
}

function isMapping(value: PyValue): boolean {
  return value instanceof PyDict || lookupSpecial(value, '__getitem__') !== undefined;
}

/** The flags compile() accepts: the `__future__` features, `CO_NESTED`, and `ast.PyCF_*`. */
const KNOWN_FLAGS = 0x1_fe_00_00n | 0x10n | 0xf6_00n;
/** The `compiler_flag` of each `__future__` feature. */
const FUTURE_FLAGS: [bigint, string][] = [
  [0x2_00_00n, 'division'],
  [0x4_00_00n, 'absolute_import'],
  [0x8_00_00n, 'with_statement'],
  [0x10_00_00n, 'print_function'],
  [0x20_00_00n, 'unicode_literals'],
  [0x40_00_00n, 'barry_as_FLUFL'],
  [0x80_00_00n, 'generator_stop'],
  [0x1_00_00_00n, 'annotations'],
];
const RECORDED_FEATURES = new Set(['annotations', 'barry_as_FLUFL']);
const FUTURE_MASK = 0x1_fe_00_00n;
const ONLY_AST_FLAG = 0x4_00n;
/** `ast.PyCF_OPTIMIZED_AST` without `ast.PyCF_ONLY_AST`, which it includes. */
const OPTIMIZED_AST_FLAG = 0x80_00n;
const TOP_LEVEL_AWAIT_FLAG = 0x20_00n;
/** `ast.PyCF_TYPE_COMMENTS`, which changes what compile() accepts. */
const UNSUPPORTED_FLAGS: [bigint, string][] = [[0x10_00n, 'compile() の ast.PyCF_TYPE_COMMENTS']];

/**
 * What compile()'s flags ask for: the `__future__` features they enable, whether the code may await at the top level,
 * and whether compile() returns a tree, as parsed or as optimized. The other flags change nothing the program can see.
 */
function compileFlags(flags: PyValue | undefined): {
  features: string[];
  topLevelAwait: boolean;
  tree?: 'parsed' | 'optimized';
} {
  if (flags === undefined || flags === 0n || flags === false) return { features: [], topLevelAwait: false };
  if (typeof flags !== 'bigint' && typeof flags !== 'boolean') {
    throw typeError(`'${typeName(flags)}' object cannot be interpreted as an integer`);
  }
  const bits = BigInt(flags);
  if ((bits & ~KNOWN_FLAGS) !== 0n) throw valueError('compile(): unrecognised flags');
  for (const [flag, feature] of UNSUPPORTED_FLAGS) if ((bits & flag) !== 0n) throw new UnsupportedFeatureError(feature);
  const features = FUTURE_FLAGS.filter(([flag]) => (bits & flag) !== 0n).map(([, feature]) => feature);
  const tree = (bits & OPTIMIZED_AST_FLAG) !== 0n ? 'optimized' : (bits & ONLY_AST_FLAG) !== 0n ? 'parsed' : undefined;
  return { features, topLevelAwait: (bits & TOP_LEVEL_AWAIT_FLAG) !== 0n, tree };
}

// Compiling ---------------------------------------------------------------------------------------------------------

/** The modules parsed from each source text, which a program evaluating the same text repeatedly parses once. */
const parsedSources = new WeakMap<Runtime, Map<string, Module>>();

function compileCode(
  source: string,
  mode: Mode,
  filename: string,
  features: readonly string[] = [],
  topLevelAwait = false
): Code {
  const runtime = currentRuntime();
  runtime.spend();
  runtime.scan(source.length);
  let cache = parsedSources.get(runtime);
  if (!cache) {
    cache = new Map();
    parsedSources.set(runtime, cache);
  }
  const key = `${mode} ${topLevelAwait} ${[...new Set(features)].toSorted().join(',')}\n${source}`;
  let module = cache.get(key);
  if (!module) {
    module = parseSource(source, filename, features, mode, topLevelAwait);
    checkMode(module, mode, filename);
    cache.set(key, module);
  }
  return { module: mode === 'single' ? { ...module, body: module.body.map(markDisplays) } : module, mode, filename };
}

/** Marks the expression statements that code compiled in 'single' mode shows, outside the functions and classes it defines. */
function markDisplays(statement: Statement): Statement {
  const mark = (body: Statement[]): Statement[] => body.map(markDisplays);
  switch (statement.kind) {
    case 'expression': {
      return { ...statement, displays: true };
    }
    case 'if':
    case 'while':
    case 'for': {
      return { ...statement, body: mark(statement.body), orelse: mark(statement.orelse) };
    }
    case 'try': {
      const handlers = statement.handlers.map((handler) => ({ ...handler, body: mark(handler.body) }));
      return {
        ...statement,
        body: mark(statement.body),
        handlers,
        orelse: mark(statement.orelse),
        finalbody: mark(statement.finalbody),
      };
    }
    case 'with': {
      return { ...statement, body: mark(statement.body) };
    }
    case 'match': {
      return { ...statement, cases: statement.cases.map((each) => ({ ...each, body: mark(each.body) })) };
    }
    default: {
      return statement;
    }
  }
}

function parseSource(
  source: string,
  filename: string,
  features: readonly string[],
  mode: Mode,
  topLevelAwait: boolean
): Module {
  const indentationError = findIndentationError(source);
  if (indentationError) {
    // In eval mode, the parser rejects a statement at its first token, before the tokenizer reads its indentation.
    const cls =
      mode === 'eval' && STATEMENT_START.test(source) ? unshownSyntaxErrorClass : unshownIndentationErrorClass;
    throw syntaxError(cls, filename, reasonOf(indentationError));
  }
  try {
    return parseDynamicCode(source, features, topLevelAwait);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    const [diagnostic] = error.diagnostics;
    // Code this grader cannot run, which CPython compiles, stops the program rather than raising SyntaxError.
    const unsupportedFeature = /^(.*?) ?は、この採点環境では使えません。$/.exec(diagnostic.message)?.[1];
    if (unsupportedFeature !== undefined) throw new UnsupportedFeatureError(unsupportedFeature);
    throw syntaxError(unshownSyntaxErrorClass, filename, reasonOf(diagnostic));
  }
}

/** The start of source text whose first line, not indented, begins a statement that is not an expression. */
const STATEMENT_START =
  /^(?:[ \t\f]*(?:#[^\n]*)?\r?\n)*(?:(?:if|elif|else|for|while|try|except|finally|with|def|class|async|del|pass|import|from|global|nonlocal|return|raise|assert|break|continue)\b|(?:match|case)\b[^\n]*:[ \t]*(?:#[^\n]*)?\r?(?:\n|$))/;

function reasonOf({ row, message }: SourceDiagnostic): string {
  return message.endsWith('この採点環境では使えません。') ? message : `${row + 1} 行目: ${message}`;
}

function checkMode(module: Module, mode: Mode, filename: string): void {
  const body = module.body;
  if (mode === 'eval' && (body.length !== 1 || body[0].kind !== 'expression')) {
    throw syntaxError(unshownSyntaxErrorClass, filename, 'eval() では、式しか評価できません。');
  }
  // One interactive statement: a compound statement, or simple statements that semicolons join on one line.
  if (
    mode === 'single' &&
    body.length > 1 &&
    (body.some(isCompound) || body.some((each) => each.row !== body[0].row))
  ) {
    throw syntaxError(
      unshownSyntaxErrorClass,
      filename,
      'multiple statements found while compiling a single statement'
    );
  }
}

function isCompound(statement: Statement): boolean {
  return ['if', 'while', 'for', 'try', 'with', 'match', 'functionDef', 'classDef'].includes(statement.kind);
}

/**
 * The SyntaxError of source text that CPython rejects, which a program may catch. Its message is CPython's parser's,
 * which this grader cannot reproduce, so reading or showing it stops the program instead.
 */
const unshownSyntaxErrorClass = builtinClassWithBase('SyntaxError', exceptionClassNamed('SyntaxError'), 'builtins');
const unshownIndentationErrorClass = builtinClassWithBase(
  'IndentationError',
  exceptionClassNamed('IndentationError'),
  'builtins'
);
const unshownIncompleteInputErrorClass = builtinClassWithBase(
  '_IncompleteInputError',
  exceptionClassNamed('_IncompleteInputError'),
  'builtins'
);
for (const cls of [unshownSyntaxErrorClass, unshownIndentationErrorClass, unshownIncompleteInputErrorClass])
  hideSubclass(cls);

function syntaxError(cls: PyClass, filename: string, reason: string): PyError {
  const feature = `eval()・exec()・compile() に渡した文字列の構文エラーのメッセージ（${reason}）`;
  const exception = newException(cls, [unavailableValue(feature), unavailableValue(feature)]);
  exception.dict.set('filename', filename);
  return new PyError(exception);
}

for (const cls of [unshownSyntaxErrorClass, unshownIndentationErrorClass, unshownIncompleteInputErrorClass]) {
  for (const name of ['__str__', '__repr__']) {
    method(cls, name, 'none', 0, 0, (self) => {
      throw new UnsupportedFeatureError(unshownMessage(self));
    });
  }
  for (const name of ['msg', 'lineno', 'offset', 'text', 'end_lineno', 'end_offset', 'print_file_and_line']) {
    defineProperty(cls, name, (self) => {
      throw new UnsupportedFeatureError(unshownMessage(self));
    });
  }
}

function unshownMessage(exception: PyValue): string {
  const message = (exception as PyInstance).exception?.args.items[0] as PyOpaque;
  return message.text;
}

// Running -----------------------------------------------------------------------------------------------------------

/**
 * The dict of the builtins, which `exec` puts as `__builtins__` into the globals it runs in. Its repr, which lists every
 * builtin with CPython's texts such as `copyright`, stops the program instead.
 */
const builtinsDictClass = builtinClassWithBase('dict', dictClass, 'builtins');
hideSubclass(builtinsDictClass);
method(builtinsDictClass, '__repr__', 'none', 0, 0, () => {
  throw new UnsupportedFeatureError('exec()・eval() が globals に入れる __builtins__ の表示');
});
const builtinsDicts = new WeakMap<Runtime, PyDict>();

function builtinsDict(runtime: Runtime): PyDict {
  let dict = builtinsDicts.get(runtime);
  if (!dict) {
    dict = new PyDict(builtinsDictClass, new AttributeStore(runtime.builtins));
    builtinsDicts.set(runtime, dict);
  }
  return dict;
}

/**
 * Runs code in a frame of its own, as part of the statement that called `exec` or `eval`: its statements record no
 * steps, as an `# atomic` function's do not.
 */
function runCode(code: Code, globalsArg: PyValue, localsArg: PyValue): PyValue {
  const runtime = currentRuntime();
  const { globals, locals } = namespacesFor(runtime, globalsArg, localsArg);
  checkBuiltins(runtime, globals);
  const row = runtime.currentRow;
  const frame = new Frame('module', locals, new Map(), globals, row, true, code.module.scope);
  // The frame's code object names the file compile() was given, which a string exec() runs is '<string>'.
  if (!hasCode(code.module.scope)) newCode(code);
  // Code that awaits at the top level, which `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT` allows, runs as a coroutine.
  if (code.module.scope.isAsync) return runtime.newModuleCoroutine(frame, runSuspending(runtime, code, frame));
  runtime.pushFrame(frame);
  try {
    return runIn(runtime, code, frame);
  } catch (error) {
    noteUnwinding(error);
    throw error;
  } finally {
    runtime.popFrame();
    runtime.currentRow = row;
  }
}

function runIn(runtime: Runtime, code: Code, frame: Frame): PyValue {
  const { module, mode } = code;
  const [first] = module.body;
  if (mode === 'eval' && first.kind === 'expression') return runtime.evaluator.evaluate(first.expression, frame);
  if (mode === 'exec' && module.doc !== undefined) frame.locals.set('__doc__', module.doc);
  recordFutureFeatures(frame.globals, module.futureFeatures);
  runtime.evaluator.runModule(module.body, frame);
  return None;
}

function* runSuspending(runtime: Runtime, code: Code, frame: Frame): Generator<PyValue, PyValue, PyValue> {
  const { module, mode } = code;
  const [first] = module.body;
  if (mode === 'eval' && first.kind === 'expression') {
    return yield* runtime.evaluator.evaluateSuspending(first.expression, frame);
  }
  if (mode === 'exec' && module.doc !== undefined) frame.locals.set('__doc__', module.doc);
  recordFutureFeatures(frame.globals, module.futureFeatures);
  yield* runtime.evaluator.block(module.body, frame);
  return None;
}

function namespacesFor(
  runtime: Runtime,
  globalsArg: PyValue,
  localsArg: PyValue
): { globals: Map<string, PyValue>; locals: Map<string, PyValue> } {
  const frames = programFrames();
  const caller = frames.at(-1) as Frame;
  const globals = globalsArg === None ? caller.globals : namespaceOfDict(globalsArg);
  if (localsArg !== None) return { globals, locals: namespaceOfDict(localsArg) };
  if (globalsArg !== None) return { globals, locals: globals };
  if (caller.kind === 'module' || caller.kind === 'class') return { globals, locals: caller.locals };
  return { globals, locals: localVariables(frames, frames.length - 1) };
}

/**
 * Runs the code object of a function as CPython does: its body in a new frame over `globalsArg`, with no arguments,
 * defaults, or closure, giving what the call returns (a generator or coroutine for such a function).
 */
function runFunctionCode(fn: PyFunction, globalsArg: PyValue, mode: 'exec' | 'eval'): PyValue {
  const frees = (getAttribute(functionCode(fn), 'co_freevars') as PyTuple).items.length;
  if (frees > 0) {
    throw typeError(
      mode === 'eval'
        ? 'code object passed to eval() may not contain free variables'
        : `code object requires a closure of exactly length ${frees}`
    );
  }
  const runtime = currentRuntime();
  const globals = globalsArg === None ? (programFrames().at(-1) as Frame).globals : namespaceOfDict(globalsArg);
  checkBuiltins(runtime, globals);
  const copy = new PyFunction(functionClass, fn.def, globals, new Map(), [], new Map(), undefined);
  return callValue(copy, []);
}

/** The variables kept in a dict, or read and written through the item methods of a dict subclass or a mapping. */
function namespaceOfDict(value: PyValue): Map<string, PyValue> {
  return value instanceof PyDict && value.cls === dictClass ? namespaceOf(value) : new MappingNamespace(value);
}

/** Puts `__builtins__` into globals that lack it, as CPython does: the dict of the builtins module. */
function checkBuiltins(runtime: Runtime, globals: Map<string, PyValue>): void {
  if (globals.get('__builtins__') === undefined) globals.set('__builtins__', builtinsDict(runtime));
}
