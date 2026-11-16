import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type { FunctionDeclaration, SourceFile, Span } from './ast';
import { checkSource } from './astCheck';
import type { FunctionInstance } from './functions';
import './library/registry';
import { PROCESS_INIT } from './library/std';
import { TURTLE } from './library/turtle';
import { Frame, Runtime, ZigPanic } from './runtime';
import { addDecls, FnRef, type TExpr } from './semaBase';
import { StatementCompiler } from './statements';
import { type Decl, type Namespace, type StructType, TYPE, type Type, typeName } from './types';
import type { Slots, Value } from './values';

/** A container-level variable, which the trace shows as Java shows a static field. */
export interface GlobalVariable {
  name: string;
  type: Type;
  cell: Slots;
}

export interface CompiledProgram {
  main: FunctionInstance;
  mainTakesInit: boolean;
  globals: GlobalVariable[];
}

export interface CompileOptions {
  /** The rows of `// atomic` annotations, when the program is traced. */
  atomicRows?: ReadonlySet<number>;
}

/** Checks and compiles a file, starting from `main` and analyzing only what it uses, as Zig does. */
export function compileProgram(file: SourceFile, options: CompileOptions = {}): CompiledProgram {
  const astErrors = checkSource(file, ['Turtle']);
  if (astErrors.fatal) throw new CompileError(firstErrors(astErrors.errors));
  let compiled: CompiledProgram;
  try {
    compiled = new Compiler(file, options).compileMain();
  } catch (error) {
    // Zig reports type errors together with unused locals and similar errors, which do not stop its analysis.
    if (!(error instanceof CompileError) || astErrors.errors.length === 0) throw error;
    throw new CompileError(firstErrors([...astErrors.errors, ...error.diagnostics]));
  }
  if (astErrors.errors.length > 0) throw new CompileError(firstErrors(astErrors.errors));
  return compiled;
}

function firstErrors(errors: readonly SourceDiagnostic[]): SourceDiagnostic[] {
  return errors.toSorted((a, b) => a.row - b.row).slice(0, 5);
}

class Compiler extends StatementCompiler {
  protected readonly tracing: boolean;
  private readonly atomicRows: ReadonlySet<number>;
  private root_: StructType | undefined;

  constructor(
    private readonly file: SourceFile,
    options: CompileOptions
  ) {
    const root: Namespace = { name: 'main', decls: new Map() };
    super(root);
    addDecls(root, file.members);
    if (!root.decls.has('Turtle')) {
      root.decls.set('Turtle', {
        kind: 'native',
        name: 'Turtle',
        resolve: () => ({ type: TYPE, value: TURTLE }),
      });
    }
    this.tracing = options.atomicRows !== undefined;
    this.atomicRows = options.atomicRows ?? new Set();
    this.checkAnnotations();
  }

  compileMain(): CompiledProgram {
    const decl = this.root.decls.get('main');
    const span: Span = { row: 0, col: 0, endRow: 0 };
    if (decl?.kind !== 'fn') return this.error(span, 'pub fn main() を宣言してください。');
    const syntax = decl.syntax;
    if (!syntax.isPub) this.error(syntax, "main は pub fn main() と宣言してください（'pub' が要ります）。");
    if (syntax.params.length > 1) this.error(syntax, 'main の引数は、なしか (init: std.process.Init) にしてください。');
    const argTypes: Type[] = [];
    if (syntax.params.length === 1) {
      const type = this.withScope({ namespace: this.root }, () =>
        syntax.params[0].type ? this.compileType(syntax.params[0].type) : undefined
      );
      if (type !== PROCESS_INIT)
        this.error(syntax.params[0], 'main の引数は (init: std.process.Init) にしてください。');
      argTypes.push(PROCESS_INIT);
    }
    const main = this.instantiate(new FnRef(decl), argTypes, syntax);
    this.compilePendingBodies();
    this.checkMainReturn(main, syntax);
    return { main, mainTakesInit: argTypes.length === 1, globals: this.globalVariables };
  }

  private checkMainReturn(main: FunctionInstance, syntax: FunctionDeclaration): void {
    const type = main.returnType;
    const payload = type.kind === 'error_union' ? type.payload : type;
    const fine =
      payload.kind === 'void' ||
      payload.kind === 'noreturn' ||
      (payload.kind === 'int' && payload.bits === 8 && !payload.signed);
    if (!fine)
      this.error(
        syntax,
        `main の戻り値の型は void・u8・!void・!u8 のどれかにしてください（${typeName(type)} 型です）。`
      );
  }

  /** Every `// atomic` must stand on a function's header, from `fn` to the body's `{`. */
  private checkAnnotations(): void {
    const headers = this.file.functions;
    for (const row of this.atomicRows) {
      if (!headers.some((fn) => fn.row <= row && row <= fn.bodyRow)) {
        throw new CompileError([{ row, message: misplacedAtomicMessage }]);
      }
    }
  }

  protected atomicRow(fn: FunctionDeclaration): boolean {
    for (const row of this.atomicRows) if (fn.row <= row && row <= fn.bodyRow) return true;
    return false;
  }

  protected rootType(): Type {
    this.root_ ??= {
      kind: 'struct',
      isTuple: false,
      namespace: this.root,
      layout: 'auto',
      fields: [],
    };
    return this.root_;
  }

  /** Runs code at compile time, as a container-level declaration's initializer runs. */
  protected evaluateAtCompileTime(expression: TExpr): Value {
    const runtime = new Runtime();
    const frame = new Frame(
      runtime,
      { name: 'comptime', locals: [], isAtomic: false } as unknown as FunctionInstance,
      undefined,
      0
    );
    try {
      return expression.eval(frame);
    } catch (error) {
      if (error instanceof ZigPanic)
        return this.error(expression.span, `コンパイルのときの計算が失敗しました: ${error.text}`);
      throw error;
    }
  }

  protected declVisited(decl: Decl): void {
    void decl;
  }
}
