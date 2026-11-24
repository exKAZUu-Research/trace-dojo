import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import { panic } from './arith';
import type { FunctionDeclaration, SourceFile, Span } from './ast';
import { checkSource } from './astCheck';
import { BufferMemorySpace } from './bufferMemory';
import { duringComptime } from './comptimeMemory';
import type { FunctionInstance } from './functions';
import { withMemoryAccounting } from './memoryAccounting';
import { MemoryFault } from './memoryFault';
import { parseZig } from './parse';
import './library/registry';
import { PROCESS_INIT } from './library/std';
import { TURTLE } from './library/turtle';
import { BranchQuotaExceeded, Frame, Runtime, ZigPanic } from './runtime';
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
  bufferMemory: BufferMemorySpace;
  main: FunctionInstance;
  mainTakesInit: boolean;
  globals: GlobalVariable[];
}

export interface CompileOptions {
  /** The rows of `// atomic` annotations, when the program is traced. */
  atomicRows?: ReadonlySet<number>;
  budget?: ExecutionBudget;
}

export function compileSource(source: string, options: CompileOptions = {}): CompiledProgram {
  const budget = options.budget ?? new ExecutionBudget();
  return compileProgram(parseZig(source, budget), { ...options, budget });
}

/** Checks and compiles a file, starting from `main` and analyzing only what it uses, as Zig does. */
export function compileProgram(file: SourceFile, options: CompileOptions = {}): CompiledProgram {
  const budget = options.budget ?? new ExecutionBudget();
  const astErrors = checkSource(file, ['Turtle'], budget);
  if (astErrors.fatal) throw new CompileError(firstErrors(astErrors.errors));
  let compiled: CompiledProgram;
  try {
    const compiler = new Compiler(file, { ...options, budget });
    compiled = withMemoryAccounting(
      {
        space: compiler.bufferMemory,
        spend: (cost) => budget.spend(cost),
        reserve: (count) => compiler.reservePhysicalSlots(count),
      },
      () => compiler.compileMain()
    );
  } catch (error) {
    // Zig reports type errors together with unused locals and similar errors, which do not stop its analysis.
    if (!(error instanceof CompileError) || astErrors.errors.length === 0) throw error;
    throw new CompileError(firstErrors([...astErrors.errors, ...error.diagnostics]));
  }
  if (astErrors.errors.length > 0) throw new CompileError(firstErrors(astErrors.errors));
  budget.spend();
  return compiled;
}

function firstErrors(errors: readonly SourceDiagnostic[]): SourceDiagnostic[] {
  return errors.toSorted((a, b) => a.row - b.row).slice(0, 5);
}

class Compiler extends StatementCompiler {
  readonly bufferMemory = new BufferMemorySpace();
  protected readonly tracing: boolean;
  private readonly atomicRows: ReadonlySet<number>;
  private readonly atomicFunctions = new WeakSet<FunctionDeclaration>();
  private root_: StructType | undefined;

  constructor(
    private readonly file: SourceFile,
    options: CompileOptions
  ) {
    const root: Namespace = { name: 'main', decls: new Map() };
    super(root, options.budget);
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
    this.runComptimeBlocks(this.file.comptimeBlocks, this.root);
    // Zig analyzes every exported function, as the linker needs it whether or not the program calls it.
    for (const exported of this.root.decls.values())
      if (exported.kind === 'fn' && exported.syntax.isExport) {
        this.declarationType(exported, exported.syntax);
        this.instantiate(new FnRef(exported), [], exported.syntax);
      }
    const main = this.instantiate(new FnRef(decl), argTypes, syntax);
    this.compilePendingBodies();
    this.checkMainReturn(main, syntax);
    return {
      main,
      mainTakesInit: argTypes.length === 1,
      globals: this.globalVariables,
      bufferMemory: this.bufferMemory,
    };
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
    if (this.atomicRows.size === 0) return;
    const rows = [...this.atomicRows].toSorted((a, b) => {
      this.compilationBudget.spend();
      return a - b;
    });
    const covered = new Set<number>();
    for (const fn of this.file.functions) {
      this.compilationBudget.spend();
      let low = 0;
      let high = rows.length;
      while (low < high) {
        this.compilationBudget.spend();
        const mid = low + Math.floor((high - low) / 2);
        if (rows[mid] < fn.row) low = mid + 1;
        else high = mid;
      }
      for (let index = low; index < rows.length && rows[index] <= fn.bodyRow; index++) {
        this.compilationBudget.spend();
        covered.add(rows[index]);
        this.atomicFunctions.add(fn);
      }
    }
    for (const row of rows) if (!covered.has(row)) throw new CompileError([{ row, message: misplacedAtomicMessage }]);
  }

  protected atomicRow(fn: FunctionDeclaration): boolean {
    return this.atomicFunctions.has(fn);
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

  /**
   * Runs code at compile time, as a container-level declaration's initializer runs. The code may use only the slots
   * from `ownSlots.from`, those of the locals it declares; another local's value is not known at compile time.
   */
  protected evaluateAtCompileTime(expression: TExpr, ownSlots?: { from: number; count: number }): Value {
    this.compilePendingBodies();
    const runtime = new Runtime(undefined, this.compilationBudget);
    runtime.bufferMemory = this.bufferMemory;
    runtime.branchCount = this.evalBranches;
    const firstOwnSlot = ownSlots?.from ?? Number.POSITIVE_INFINITY;
    const frame = new Frame(
      runtime,
      { name: 'comptime', locals: [], isAtomic: false } as unknown as FunctionInstance,
      undefined,
      ownSlots ? ownSlots.from + ownSlots.count : 0
    );
    const outsideOwn = (key: string | symbol): boolean =>
      typeof key === 'string' && /^\d+$/.test(key) && Number(key) < firstOwnSlot;
    frame.slots = new Proxy(frame.slots, {
      get: (target, key, receiver) => {
        if (outsideOwn(key)) panic('unable to resolve comptime value');
        return Reflect.get(target, key, receiver);
      },
      set: (target, key, value, receiver) => {
        if (outsideOwn(key)) panic('unable to resolve comptime value');
        return Reflect.set(target, key, value, receiver);
      },
    });
    try {
      return duringComptime(() => expression.eval(frame));
    } catch (error) {
      if (error instanceof MemoryFault) return this.error(expression.span, 'undefined のポインタは参照できません。');
      if (error instanceof BranchQuotaExceeded)
        return this.error(
          { ...expression.span, row: error.row ?? expression.span.row },
          `コンパイルのときの計算で、ループの繰り返しと関数の呼び出しが合わせて ${error.quota} 回を超えました（@setEvalBranchQuota で上限を上げられます）。`
        );
      if (error instanceof ZigPanic) {
        if (error.text === 'unable to resolve comptime value')
          return this.error(expression.span, 'コンパイルのときに値が決まりません（実行時に決まる値を使っています）。');
        return this.error(expression.span, `コンパイルのときの計算が失敗しました: ${error.text}`);
      }
      throw error;
    }
  }

  protected declVisited(decl: Decl): void {
    void decl;
  }
}
