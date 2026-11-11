import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Module, Statement } from './ast';
import { PyBytes } from './bytesValues';
import { addressOf } from './conversions';
import { method } from './define';
import { Frame } from './frame';
import { findIndentationError } from './indentation';
import { builtinClassWithBase } from './modules/moduleClasses';
import { defineProperty } from './modules/numberSupport';
import { namespaceOf } from './namespaces';
import { argument } from './nativeArgs';
import { lookupSpecial } from './objects';
import { parseDynamicCode } from './parse';
import { localVariables, programFrames } from './reflection';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import {
  builtinClass,
  dictClass,
  exceptionClassNamed,
  newException,
  None,
  typeError,
  typeName,
  valueError,
} from './types';
import { unavailableValue } from './unavailableValues';
import { UnsupportedFeatureError } from './unsupported';
import { type Kwargs, type PyClass, PyDict, PyError, PyInstance, PyModule, PyOpaque, type PyValue } from './values';

type Mode = 'exec' | 'eval' | 'single';

interface Code {
  module: Module;
  mode: Mode;
  filename: string;
}

// Code objects ------------------------------------------------------------------------------------------------------

export const codeClass = builtinClass('code');

method(codeClass, '__repr__', 'none', 0, 0, (self) => {
  const code = codeOf(self);
  return `<code object <module> at ${addressOf(self as PyOpaque)}, file "${code.filename}", line 1>`;
});
defineProperty(codeClass, 'co_name', () => '<module>');
defineProperty(codeClass, 'co_qualname', () => '<module>');
defineProperty(codeClass, 'co_filename', (self) => codeOf(self).filename);
defineProperty(codeClass, 'co_firstlineno', () => 1n);

function codeOf(value: PyValue): Code {
  return (value as PyOpaque).data as Code;
}

// The builtins ------------------------------------------------------------------------------------------------------

export const COMPILE_KEYWORDS = ['source', 'filename', 'mode', 'flags', 'dont_inherit', 'optimize', '_feature_version'];

/** `compile(source, filename, mode, flags=0, dont_inherit=False, optimize=-1)`. */
export function compile(args: PyValue[], kwargs: Kwargs): PyValue {
  const [source, filename, mode, flags] = COMPILE_KEYWORDS.map((name, index) => argument(args, kwargs, index, name));
  for (const [index, value] of [source, filename, mode].entries()) {
    if (value === undefined) {
      throw typeError(`compile() missing required argument '${COMPILE_KEYWORDS[index]}' (pos ${index + 1})`);
    }
  }
  const text = sourceText(source as PyValue);
  if (typeof text !== 'string') throw typeError('compile() arg 1 must be a string, bytes or AST object');
  if (typeof filename !== 'string') {
    throw typeError(`expected str, bytes or os.PathLike object, not ${typeName(filename as PyValue)}`);
  }
  if (typeof mode !== 'string')
    throw typeError(`compile() argument 'mode' must be str, not ${typeName(mode as PyValue)}`);
  if (mode !== 'exec' && mode !== 'eval' && mode !== 'single') {
    throw valueError("compile() mode must be 'exec', 'eval' or 'single'");
  }
  checkFlags(flags);
  return new PyOpaque(codeClass, '', compileCode(text, mode, filename));
}

/** `eval(source, /, globals=None, locals=None)`. */
export function evaluate(args: PyValue[], kwargs: Kwargs): PyValue {
  const source = sourceText(args[0]);
  if (source === undefined) throw typeError('eval() arg 1 must be a string, bytes or code object');
  const globals = argument(args, kwargs, 1, 'globals') ?? None;
  const locals = argument(args, kwargs, 2, 'locals') ?? None;
  if (globals !== None && !(globals instanceof PyDict)) {
    throw typeError(
      isMapping(globals) ? 'globals must be a real dict; try eval(expr, {}, mapping)' : 'globals must be a dict'
    );
  }
  if (locals !== None && !isMapping(locals)) throw typeError('locals must be a mapping');
  const code = typeof source === 'string' ? compileCode(source.replace(/^[ \t]+/, ''), 'eval', '<string>') : source;
  return runCode(code, globals, locals);
}

/** `exec(source, /, globals=None, locals=None, *, closure=None)`. */
export function execute(args: PyValue[], kwargs: Kwargs): PyValue {
  const source = sourceText(args[0]);
  if (source === undefined) throw typeError('exec() arg 1 must be a string, bytes or code object');
  const globals = argument(args, kwargs, 1, 'globals') ?? None;
  const locals = argument(args, kwargs, 2, 'locals') ?? None;
  if (globals !== None && !(globals instanceof PyDict))
    throw typeError(`exec() globals must be a dict, not ${typeName(globals)}`);
  if (locals !== None && !isMapping(locals))
    throw typeError(`locals must be a mapping or None, not ${typeName(locals)}`);
  if ((kwargs?.get('closure') ?? None) !== None) throw new UnsupportedFeatureError('exec() の closure 引数');
  runCode(typeof source === 'string' ? compileCode(source, 'exec', '<string>') : source, globals, locals);
  return None;
}

/** The text of a source argument, the code object it is, or undefined for any other value. */
function sourceText(value: PyValue): string | Code | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof PyInstance && typeof value.primitive === 'string') return value.primitive;
  if (value instanceof PyBytes) return new TextDecoder().decode(value.data);
  if (value instanceof PyOpaque && value.cls === codeClass) return codeOf(value);
  return undefined;
}

function isMapping(value: PyValue): boolean {
  return value instanceof PyDict || lookupSpecial(value, '__getitem__') !== undefined;
}

/** The flags compile() accepts: the `__future__` features, `CO_NESTED`, and `ast.PyCF_*`. */
const KNOWN_FLAGS = 0x1_fe_00_00n | 0x10n | 0xf6_00n;

function checkFlags(flags: PyValue | undefined): void {
  if (flags === undefined || flags === 0n || flags === false) return;
  if (typeof flags !== 'bigint' && typeof flags !== 'boolean') {
    throw typeError(`'${typeName(flags)}' object cannot be interpreted as an integer`);
  }
  if ((BigInt(flags) & ~KNOWN_FLAGS) !== 0n) throw valueError('compile(): unrecognised flags');
  throw new UnsupportedFeatureError('compile() の flags 引数');
}

// Compiling ---------------------------------------------------------------------------------------------------------

/** The modules parsed from each source text, which a program evaluating the same text repeatedly parses once. */
const parsedSources = new WeakMap<Runtime, Map<string, Module>>();

function compileCode(source: string, mode: Mode, filename: string): Code {
  const runtime = currentRuntime();
  runtime.spend();
  runtime.scan(source.length);
  let cache = parsedSources.get(runtime);
  if (!cache) {
    cache = new Map();
    parsedSources.set(runtime, cache);
  }
  let module = cache.get(source);
  if (!module) {
    module = parseSource(source, filename);
    cache.set(source, module);
  }
  checkMode(module, mode, filename);
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

function parseSource(source: string, filename: string): Module {
  const indentationError = findIndentationError(source);
  if (indentationError) throw syntaxError(unshownIndentationErrorClass, filename, reasonOf(indentationError));
  try {
    return parseDynamicCode(source);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    throw syntaxError(unshownSyntaxErrorClass, filename, reasonOf(error.diagnostics[0]));
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

/** The value `exec` puts as `__builtins__` into the globals it runs in, which CPython makes the builtins' dict. */
const builtinsDictValue = unavailableValue('exec()・eval() が globals に入れる __builtins__ の中身');

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
  runtime.pushFrame(frame);
  try {
    return runIn(runtime, code, frame);
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
  runtime.evaluator.runModule(module.body, frame);
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

function namespaceOfDict(value: PyValue): Map<string, PyValue> {
  if (!(value instanceof PyDict) || value.cls !== dictClass) {
    throw new UnsupportedFeatureError('exec()・eval() の globals や locals に dict 以外のマッピングを渡すこと');
  }
  return namespaceOf(value);
}

/** Puts `__builtins__` into globals that lack it, as CPython does, refusing builtins the program replaced. */
function checkBuiltins(runtime: Runtime, globals: Map<string, PyValue>): void {
  const builtins = globals.get('__builtins__');
  if (builtins === undefined) {
    globals.set('__builtins__', builtinsDictValue);
    return;
  }
  const isBuiltinsModule = builtins instanceof PyModule && builtins.dict === runtime.builtins;
  if (!isBuiltinsModule && builtins !== builtinsDictValue) {
    throw new UnsupportedFeatureError('exec()・eval() の globals で __builtins__ を差し替えること');
  }
}
