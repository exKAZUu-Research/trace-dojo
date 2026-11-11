import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Module, Statement } from './ast';
import { AttributeStore } from './attributeStore';
import { PyBytes } from './bytesValues';
import { MappingNamespace } from './classes';
import { method } from './define';
import { Frame } from './frame';
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

function newCode(code: Code): PyOpaque {
  const info: CodeInfo = {
    name: '<module>',
    qualifiedName: '<module>',
    firstRow: 0,
    filename: code.filename,
    compiled: code,
  };
  const object = new PyOpaque(codeClass, '', info);
  registerCode(code.module.scope, object);
  return object;
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
  return newCode(compileCode(text, mode, filename, features, topLevelAwait));
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
const ONLY_AST_FLAG = 0x4_00n;
/** `ast.PyCF_OPTIMIZED_AST` without `ast.PyCF_ONLY_AST`, which it includes. */
const OPTIMIZED_AST_FLAG = 0x80_00n;
const TOP_LEVEL_AWAIT_FLAG = 0x20_00n;
/** `ast.PyCF_TYPE_COMMENTS` and `ast.PyCF_ALLOW_INCOMPLETE_INPUT`, which change what compile() accepts. */
const UNSUPPORTED_FLAGS: [bigint, string][] = [
  [0x10_00n, 'compile() の ast.PyCF_TYPE_COMMENTS'],
  [0x40_00n, 'compile() の ast.PyCF_ALLOW_INCOMPLETE_INPUT'],
];

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
    module = parseSource(source, filename, features, topLevelAwait);
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

function parseSource(source: string, filename: string, features: readonly string[], topLevelAwait: boolean): Module {
  const indentationError = findIndentationError(source);
  if (indentationError) throw syntaxError(unshownIndentationErrorClass, filename, reasonOf(indentationError));
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

function syntaxError(cls: PyClass, filename: string, reason: string): PyError {
  const feature = `eval()・exec()・compile() に渡した文字列の構文エラーのメッセージ（${reason}）`;
  const exception = newException(cls, [unavailableValue(feature), unavailableValue(feature)]);
  exception.dict.set('filename', filename);
  return new PyError(exception);
}

for (const cls of [unshownSyntaxErrorClass, unshownIndentationErrorClass]) {
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
