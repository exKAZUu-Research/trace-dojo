import { OrderedMap } from 'immutable';

// code-gauge-allow-file fileNcss -- The Core generator covers every construct of the language in one pass over shared state.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  CONS_CON,
  DOUBLE_TYPE,
  FLOAT_TYPE,
  INT_TYPE,
  INTEGER_TYPE,
  IO_TYPE,
  NIL_CON,
  tupleCon,
  UNIT_CON,
  WORD_TYPE,
} from './builtinTypes';
import type { CaseCore, Core, FunctionInfo, GlobalDef, IODoCore, IOStmt, LamCore } from './core';
import {
  type ClassEntity,
  type ConInfo,
  type DictParam,
  type Evidence,
  type FieldInfo,
  type InstanceInfo,
  resolveEvidence,
  type TypeEntity,
  type ValueEntity,
} from './entities';
import { TailCall } from './machine';
import { patternProjection, patternResult } from './patternBindings';
import { surfacePatternText } from './patternText';
import { primitiveNamed, rationalToFloat } from './primitives';
import {
  type LocalVar,
  type RAlt,
  type RBindGroup,
  type RBinding,
  type RClause,
  type RExpr,
  type RGuard,
  type RPat,
  rpatLocals,
  type RRhs,
  type RStmt,
} from './rast';
import { RecursionBudget } from './recursionBudget';
import { type DictBuilders, dictBuilders, type Runtime } from './runtime';
import type { Span } from './syntax';
import { mapGraph } from './typeGraph';
import { prune, type Scheme, splitApp, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';
import { type Dict, Env, HaskellException, type Slot, Thunk } from './values';
import type { VisibleBinding, VisibleScope } from './visibleScope';

function local(index: number): Core {
  return { k: 'local', depth: 0, index };
}

/** The file name GHC's messages show for the program, which runs as `Main.hs`. */
export const PROGRAM_FILE = 'Main.hs';

/** Each top-level binding's definition, by the entity (or constructor or field) it defines. */
const globalDefs = new WeakMap<object, GlobalDef>();

export function globalOf(key: object, name: string, entity?: ValueEntity): GlobalDef {
  let def = globalDefs.get(key);
  if (!def) {
    def = { entity, name };
    globalDefs.set(key, def);
  }
  return def;
}

/** The library's entities that generated code refers to. */
export interface CodegenSupport {
  value(name: string): ValueEntity;
  boolType(): TypeEntity;
  monad(): ClassEntity;
  monadFail(): ClassEntity;
  num(): ClassEntity;
  fractional(): ClassEntity;
  eq(): ClassEntity;
  enumClass(): ClassEntity;
  ratioCon(): ConInfo;
}

export interface CodegenOptions {
  support: CodegenSupport;
  /** The rows of `-- atomic` annotations, which mark the functions declared on them. */
  atomicRows?: ReadonlySet<number>;
  /** Whether the module is the program, whose source positions errors show. */
  isProgram: boolean;
  traceTypes?: boolean;
}

class FrameScope {
  size = 0;
  readonly slots = new Map<LocalVar | DictParam, number>();

  readonly level: number;

  constructor(readonly parent: FrameScope | undefined) {
    this.level = parent ? parent.level + 1 : 0;
  }

  alloc(): number {
    return this.size++;
  }
}

export function sourceSpanText(span: Span): string {
  if (span.row === span.endRow) {
    return span.endCol - span.col <= 1
      ? `${PROGRAM_FILE}:${span.row + 1}:${span.col + 1}`
      : `${PROGRAM_FILE}:${span.row + 1}:${span.col + 1}-${span.endCol}`;
  }
  return `${PROGRAM_FILE}:(${span.row + 1},${span.col + 1})-(${span.endRow + 1},${span.endCol})`;
}

/** Generates code for a module's bindings and instances, registering its globals and instance dictionaries. */
export class Codegen {
  /** The scope of top-level code, which has no frame at run time. */
  private readonly rootFrame = new FrameScope(undefined);
  private frame: FrameScope = this.rootFrame;
  private visible = OrderedMap<string, VisibleBinding>();
  private sourceDefined = true;
  private readonly recursion = new RecursionBudget();
  private readonly untracedDoTypes = new Set<object>();
  /** The dictionary parameters of the bindings whose bodies are being generated, for their recursive uses. */
  private readonly ownDictParams = new Map<LocalVar | ValueEntity, DictParam[]>();
  readonly claimedAtomicRows = new Set<number>();

  constructor(private readonly options: CodegenOptions) {}

  // -------------------------------------------------------------------------------------------------------------
  // Top level

  compileTopBindings(group: RBindGroup): void {
    for (const binding of group.bindings) {
      if (binding.k === 'fun' && binding.dictParams) {
        this.ownDictParams.set(binderKey(binding), binding.dictParams);
      }
    }
    for (const binding of group.bindings) this.compileTopBinding(binding);
  }

  compileTopBinding(binding: RBinding): void {
    if (binding.k === 'fun') {
      const entity = (binding.binder as { kind: 'global'; entity: ValueEntity }).entity;
      if (binding.dictParams) this.ownDictParams.set(entity, binding.dictParams);
      const def = globalOf(entity, entity.name, entity);
      def.code = this.compileFunction(binding, entity.name, true);
      return;
    }
    const whole = globalOf(binding, '<pattern>');
    const patternOwner = { name: '<pattern>', row: binding.span.row, isAtomic: false };
    const frame = new FrameScope(undefined);
    whole.code = this.withFrame(frame, () => {
      const slot = frame.alloc();
      const rhs = this.withVisible(OrderedMap<string, VisibleBinding>(), () =>
        this.compileRhs(binding.rhs, this.patternFail(binding.span))
      );
      const matched = this.matchBoundPattern(binding, slot);
      return {
        k: 'frame',
        size: frame.size,
        body: { k: 'let', binds: [{ index: slot, expr: rhs }], body: matched },
        info: patternOwner,
      } as Core;
    });
    for (const index of binding.binders.keys()) {
      const global = (binding.globals as ValueEntity[])[index];
      globalOf(global, global.name, global).code = {
        k: 'frame',
        size: 0,
        body: patternProjection({ k: 'global', global: whole }, index, binding.binders.length),
        info: { name: global.name, row: binding.span.row, isAtomic: false, patternOwner },
        functionResult: global.scheme ? isFunctionType(global.scheme.type) : false,
      };
    }
  }

  /** Registers how a module's instance's dictionary is built. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch fills one part of a dictionary: methods, defaults, and superclasses.
  compileInstance(info: InstanceInfo, bindings: RBinding[], sourceDefined = false): void {
    for (const binding of bindings) {
      const fun = binding as Extract<RBinding, { k: 'fun' }>;
      const entity = (fun.binder as { kind: 'global'; entity: ValueEntity }).entity;
      this.ownDictParams.set(entity, fun.dictParams ?? []);
      globalOf(entity, entity.name, entity).code = this.withSourceDefined(sourceDefined, () =>
        this.compileFunction(fun, entity.name, this.options.isProgram && sourceDefined)
      );
    }
    const superCodes = info.supers.map((evidence) => {
      const frame = new FrameScope(undefined);
      for (const param of info.contextParams) frame.slots.set(param, frame.alloc());
      const code = this.withFrame(frame, () => this.compileEvidence(evidence));
      return { code, size: frame.size };
    });
    const builders: DictBuilders = {
      methods: info.cls.methods.map((method, index) => {
        const implementation = info.methods[index];
        if (implementation) {
          const def = globalOf(implementation, implementation.name, implementation);
          return (runtime: Runtime, _dict: Dict, args: Slot[]) =>
            args.length === 0
              ? runtime.global(def)
              : new Thunk(undefined, undefined, () => new TailCall(runtime.machine.force(runtime.global(def)), args));
        }
        // GHC writes the quotes around the name as the low bytes of ‘ and ’.
        const missing = `${info.span ? sourceSpanText(info.span) : PROGRAM_FILE}: No instance nor default method for class operation \u0018${method.name}\u0019`;
        return (runtime: Runtime, dict: Dict) => {
          const fallback = info.cls.defaults[index];
          if (!fallback) {
            return new Thunk(undefined, undefined, () => {
              throw new HaskellException(missing);
            });
          }
          const def = globalOf(fallback, fallback.name, fallback);
          return new Thunk(
            undefined,
            undefined,
            () => new TailCall(runtime.machine.force(runtime.global(def)), [dict])
          );
        };
      }),
      superclassSlots: superCodes.reduce((count, { size }) => count + size, 0),
      supers: superCodes.map(({ code, size }) => (_runtime: Runtime, _dict: Dict, args: Slot[]) => {
        const env = new Env(size, undefined);
        for (const [index, arg] of args.entries()) env.slots[index] = arg;
        return new Thunk(code, env);
      }),
    };
    dictBuilders.set(info, builders);
  }

  compileDefault(binding: RBinding): void {
    const fun = binding as Extract<RBinding, { k: 'fun' }>;
    const entity = (fun.binder as { kind: 'global'; entity: ValueEntity }).entity;
    this.ownDictParams.set(entity, fun.dictParams ?? []);
    globalOf(entity, entity.name, entity).code = this.compileFunction(fun, entity.name, this.options.isProgram);
  }

  compileEntry(entity: ValueEntity, evidence: Evidence[]): GlobalDef {
    const global = globalOf(entity, entity.name, entity);
    if (evidence.length === 0) return global;
    return {
      name: 'main',
      entity,
      code: { k: 'app', fn: { k: 'global', global }, args: evidence.map((item) => this.compileEvidence(item)) },
    };
  }

  /**
   * Generates a constructor's function, for uses that do not apply it to all its fields, and for every use of a
   * constructor with strict fields, which evaluates them from left to right before building the value as GHC does.
   */
  /** A constructor's function, which takes the dictionaries of its constraints first, then its fields. */
  static constructorGlobal(con: ConInfo): GlobalDef {
    const def = globalOf(con, con.name);
    if (def.code) return def;
    const dicts = con.context?.length ?? 0;
    if (con.arity + dicts === 0) {
      def.code = { k: 'con', con, args: [] };
      return def;
    }
    let body: Core = {
      k: 'con',
      con,
      args: [
        ...Array.from({ length: con.arity }, (_, index) => local(dicts + index)),
        ...Array.from({ length: dicts }, (_, index) => local(index)),
      ],
    };
    const seq: Core = { k: 'prim', prim: primitiveNamed('seq') };
    for (const position of [...(con.strictFields ?? [])].toReversed())
      body = { k: 'app', fn: seq, args: [local(dicts + position), body] };
    def.code = { k: 'lam', arity: con.arity + dicts, size: con.arity + dicts, body };
    return def;
  }

  /** A constructor applied to all its fields, after the dictionaries of its constraints. */
  private construct(con: ConInfo, args: Core[], dicts: Core[] = []): Core {
    if (con.strictFields) {
      return { k: 'app', fn: { k: 'global', global: Codegen.constructorGlobal(con) }, args: [...dicts, ...args] };
    }
    return { k: 'con', con, args: [...args, ...dicts] };
  }

  /** Generates a record field's selector, which fails for constructors without the field. */
  static fieldGlobal(field: FieldInfo): GlobalDef {
    const def = globalOf(field, field.name, field.entity);
    if (!def.code) {
      const alts: CaseCore['alts'] = new Map();
      for (const [con, position] of field.positions) {
        const slots = Array.from({ length: con.arity }, (_, index) => (index === position ? 1 : -1));
        alts.set(con.tag, { slots, body: { k: 'local', depth: 0, index: 1 } });
      }
      const allHaveIt = field.type.cons.every((con) => field.positions.has(con));
      def.code = {
        k: 'lam',
        arity: 1,
        size: 2,
        body: {
          k: 'case',
          scrut: { k: 'local', depth: 0, index: 0 },
          alts,
          default: allHaveIt ? undefined : { k: 'error', message: `No match in record selector ${field.name}` },
        },
      };
    }
    return def;
  }

  checkAtomicClaims(): number | undefined {
    for (const row of this.options.atomicRows ?? []) if (!this.claimedAtomicRows.has(row)) return row;
    return undefined;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Bindings

  private withFrame<T>(frame: FrameScope, build: () => T): T {
    const saved = this.frame;
    this.frame = frame;
    try {
      return build();
    } finally {
      this.frame = saved;
    }
  }

  private withSourceDefined<T>(sourceDefined: boolean, build: () => T): T {
    const saved = this.sourceDefined;
    this.sourceDefined &&= sourceDefined;
    try {
      return build();
    } finally {
      this.sourceDefined = saved;
    }
  }

  private infoFor(name: string, span: Span, sigSpan: Span | undefined): FunctionInfo {
    const rows = new Set<number>([span.row]);
    if (sigSpan) for (let row = sigSpan.row; row <= sigSpan.endRow; row++) rows.add(row);
    let isAtomic = false;
    for (const row of rows) {
      if (this.sourceDefined && this.options.atomicRows?.has(row)) {
        isAtomic = true;
        this.claimedAtomicRows.add(row);
      }
    }
    return { name, row: span.row, isAtomic };
  }

  /** Generates a function binding: a lambda over its dictionaries and arguments, or a top-level body. */
  private compileFunction(binding: Extract<RBinding, { k: 'fun' }>, name: string, isTop: boolean): Core {
    const dictParams = binding.dictParams ?? [];
    const arity = binding.clauses[0].pats.length;
    // Only top-level functions are frames in a trace: a local function (in `where` or `let`) runs as part of the
    // function that defines it, as a loop or a block inside a Java method does.
    const source = this.infoForBinding(binding, name);
    const info = isTop ? source : undefined;
    const atomicScope = !isTop && source.isAtomic ? source : undefined;
    const resultType = info ? this.bindingResultType(binding) : undefined;
    const functionResult = resultType ? isFunctionType(resultType) : false;
    if (dictParams.length + arity === 0) {
      const frame = new FrameScope(this.frame);
      return this.withFrame(frame, () => {
        const body = this.withVisible(isTop ? OrderedMap<string, VisibleBinding>() : this.visible, () =>
          this.compileClauseBody(binding, [], name)
        );
        return { k: 'frame', size: frame.size, body, info, atomicScope, functionResult } as Core;
      });
    }
    const visible = isTop ? OrderedMap<string, VisibleBinding>() : this.visible;
    return this.compileDictionaryLambda(
      dictParams,
      arity,
      (args) => this.withVisible(visible, () => this.compileClauseBody(binding, args, name)),
      {
        info,
        atomicScope,
        functionResult,
        displayParameters: this.options.traceTypes && binding.type ? parameterTypes(binding.type, arity) : undefined,
      }
    );
  }

  private infoForBinding(binding: Extract<RBinding, { k: 'fun' }>, name: string): FunctionInfo {
    return this.infoFor(name, binding.span, binding.sig?.span);
  }

  private compileClauseBody(binding: Extract<RBinding, { k: 'fun' }>, argSlots: number[], name: string): Core {
    const ioResult = this.bindingReturnsIO(binding);
    const fail: Core = {
      k: 'error',
      message: `${sourceSpanText(binding.span)}: Non-exhaustive patterns in function ${name}`,
    };
    return this.compileMatch(argSlots, binding.clauses, fail, ioResult);
  }

  /** Whether a binding's body (after its arguments) is an `IO` action, whose expressions run as statements. */
  private bindingReturnsIO(binding: Extract<RBinding, { k: 'fun' }>): boolean {
    if (!this.options.isProgram) return false;
    const type = this.bindingResultType(binding);
    return type ? isIOType(type) : false;
  }

  private bindingResultType(binding: Extract<RBinding, { k: 'fun' }>): Type | undefined {
    const scheme: Scheme | undefined =
      binding.binder.kind === 'local' ? binding.binder.local.scheme : binding.binder.entity.scheme;
    const type =
      binding.type ?? scheme?.type ?? (binding.binder.kind === 'local' ? binding.binder.local.type : undefined);
    return type ? resultAfter(type, binding.clauses[0].pats.length) : undefined;
  }

  // code-gauge-allow functionCognitiveComplexity -- Local functions and pattern bindings need separate slot set-ups in one recursive group.
  // code-gauge-allow functionNcss -- Recursive groups reserve caller slots before shared pattern matches or functions are compiled.
  private compileLocalGroup(group: RBindGroup): { index: number; expr: Core }[] {
    const binds: { index: number; expr: Core }[] = [];
    const slots = new Map<RBinding, number[]>();
    // Every variable of the group gets its slot first, since the group's bindings may refer to each other.
    for (const binding of group.bindings) {
      if (binding.k === 'fun') {
        const local = (binding.binder as { kind: 'local'; local: LocalVar }).local;
        const slot = this.frame.alloc();
        this.frame.slots.set(local, slot);
        this.addVisible(local, slot);
        slots.set(binding, [slot]);
        if (binding.dictParams && binding.dictParams.length > 0) this.ownDictParams.set(local, binding.dictParams);
      } else {
        const own: number[] = [];
        for (const local of binding.binders) {
          const slot = this.frame.alloc();
          this.frame.slots.set(local, slot);
          this.addVisible(local, slot);
          own.push(slot);
        }
        slots.set(binding, own);
      }
    }
    for (const binding of group.bindings) {
      const own = slots.get(binding) as number[];
      if (binding.k === 'fun') {
        const local = (binding.binder as { kind: 'local'; local: LocalVar }).local;
        binds.push({ index: own[0], expr: this.compileFunction(binding, local.name, false) });
        continue;
      }
      const whole = this.frame.alloc();
      binds.push({ index: whole, expr: this.compileRhs(binding.rhs, this.patternFail(binding.span)) });
      const matched = this.frame.alloc();
      binds.push({ index: matched, expr: this.matchBoundPattern(binding, whole) });
      for (const index of binding.binders.keys()) {
        binds.push({
          index: own[index],
          expr: patternProjection({ k: 'local', depth: 0, index: matched }, index, binding.binders.length),
        });
      }
    }
    return binds;
  }

  private patternFail(span: Span): Core {
    return {
      k: 'error',
      message: `${sourceSpanText(span)}: Non-exhaustive patterns in pattern binding`,
    };
  }

  private matchBoundPattern(binding: Extract<RBinding, { k: 'pat' }>, slot: number): Core {
    const { pat, span } = binding;
    const saved = new Map(this.frame.slots);
    const savedVisible = this.visible;
    try {
      const plan = this.planPattern(pat, slot, false);
      const text = pat.surface ? surfacePatternText(pat.surface) : patternText(pat);
      const fail: Core = {
        k: 'error',
        message: `${sourceSpanText(span)}: Non-exhaustive patterns in ${text}`,
      };
      return this.matchPlan(plan, patternResult(binding.binders.map((binder) => this.localRef(binder))), fail);
    } finally {
      this.frame.slots.clear();
      for (const [key, value] of saved) this.frame.slots.set(key, value);
      this.visible = savedVisible;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Matching

  /**
   * Matches the values in `slots` against each clause in turn, falling through to the next clause when a pattern
   * or every guard fails, and to `fail` after the last.
   */
  private compileMatch(slots: number[], clauses: readonly RClause[], fail: Core, ioResult: boolean): Core {
    let next = fail;
    for (let index = clauses.length - 1; index >= 0; index--) {
      let failRef = next;
      let failSlot: number | undefined;
      if (next.k !== 'error' && next.k !== 'local') {
        failSlot = this.frame.alloc();
        failRef = { k: 'local', depth: 0, index: failSlot };
      }
      const clause = clauses[index];
      const savedVisible = this.visible;
      const plans = clause.pats.map((pat, position) => this.planPattern(pat, slots[position], true));
      let code = this.compileRhs(clause.rhs, failRef, ioResult);
      for (let position = plans.length - 1; position >= 0; position--)
        code = this.matchPlan(plans[position], code, failRef);
      this.visible = savedVisible;
      if (failSlot !== undefined) code = { k: 'let', binds: [{ index: failSlot, expr: next }], body: code };
      next = code;
    }
    return next;
  }

  // code-gauge-allow functionCognitiveComplexity -- Pattern forms share ordered slot allocation and worklist state.
  // code-gauge-allow functionNcss -- The worklist handles each pattern form while preserving binder and field order.
  private planPattern(pat: RPat, slot: number, visible: boolean): Plan {
    const result: Plan[] = [];
    const pending = [{ pat, slot, target: result, index: 0 }];
    // The plans of the patterns inside `!p` and view patterns, which planning fills in after it plans them.
    const innerPlans: { plan: { inner: Plan }; inner: Plan[] }[] = [];
    while (pending.length > 0) {
      const job = pending.pop()!;
      const { pat, slot, target, index } = job;
      if (pat.k === 'var' || pat.k === 'as') {
        this.frame.slots.set(pat.local, slot);
        if (visible) this.addVisible(pat.local, slot);
      }
      if (pat.k === 'as' || pat.k === 'sig') {
        pending.push({ ...job, pat: pat.pat });
        continue;
      }
      if (pat.k === 'bang' || pat.k === 'view') {
        const inner: Plan[] = [];
        if (pat.k === 'bang') {
          target[index] = { k: 'bang', slot, inner: undefined as unknown as Plan };
          pending.push({ pat: pat.pat, slot, target: inner, index: 0 });
        } else {
          const viewSlot = this.frame.alloc();
          const fn = this.compileExpr(pat.expr);
          target[index] = { k: 'view', slot, fn, viewSlot, inner: undefined as unknown as Plan };
          pending.push({ pat: pat.pat, slot: viewSlot, target: inner, index: 0 });
        }
        innerPlans.push({ plan: target[index] as { inner: Plan }, inner });
        continue;
      }
      if (pat.k === 'lazy') {
        target[index] = this.planLazyPattern(pat, slot, visible);
        continue;
      }
      if (pat.k === 'or') {
        target[index] = { k: 'or', alts: pat.alts.map((alt) => this.planPattern(alt, slot, false)) };
        continue;
      }
      if (pat.k !== 'con') {
        target[index] = pat.k === 'lit' ? { k: 'lit', pat, slot } : { k: 'any' };
        continue;
      }
      const fields: Plan[] = [];
      if (pat.con.isNewtype) {
        const fieldSlot = this.frame.alloc();
        target[index] = { k: 'newtype', slot, fieldSlot, fields };
        pending.push({ pat: pat.args[0], slot: fieldSlot, target: fields, index: 0 });
        continue;
      }
      const fieldSlots = Array.from({ length: pat.args.length }, () => -1);
      const dictSlots = pat.dictParams?.map((param) => {
        const dictSlot = this.frame.alloc();
        this.frame.slots.set(param, dictSlot);
        return dictSlot;
      });
      target[index] = { k: 'con', con: pat.con, slot, fieldSlots, fields, dictSlots };
      const children = [];
      for (const position of pat.order ?? pat.args.keys()) {
        const arg = pat.args[position];
        if (arg.k === 'wild') continue;
        const fieldSlot = this.frame.alloc();
        fieldSlots[position] = fieldSlot;
        children.push({ pat: arg, slot: fieldSlot, target: fields, index: children.length });
      }
      pending.push(...children.toReversed());
    }
    for (const { plan, inner } of innerPlans) plan.inner = inner[0];
    return result[0];
  }

  /**
   * Plans `~p`: its variables are projections of one shared match of `p`, which runs only when one of them is used
   * and fails then if `p` does not match.
   */
  private planLazyPattern(pat: Extract<RPat, { k: 'lazy' }>, slot: number, visible: boolean): Plan {
    const binders = rpatLocals(pat.pat);
    if (binders.length === 0) return { k: 'any' };
    const plan = this.planPattern(pat.pat, slot, false);
    const text = pat.pat.surface ? surfacePatternText(pat.pat.surface) : patternText(pat.pat);
    const fail: Core = { k: 'error', message: `${sourceSpanText(pat.pat.span)}: Non-exhaustive patterns in ${text}` };
    const matched = this.frame.alloc();
    const binds = [
      {
        index: matched,
        expr: this.matchPlan(plan, patternResult(binders.map((binder) => this.localRef(binder))), fail),
      },
    ];
    for (const [index, binder] of binders.entries()) {
      const own = this.frame.alloc();
      this.frame.slots.set(binder, own);
      if (visible) this.addVisible(binder, own);
      binds.push({
        index: own,
        expr: patternProjection({ k: 'local', depth: 0, index: matched }, index, binders.length),
      });
    }
    return { k: 'lazy', binds };
  }

  private matchPlan(plan: Plan, success: Core, fail: Core): Core {
    let code = success;
    const pending = [{ plan, wrap: false }];
    while (pending.length > 0) {
      const { plan, wrap } = pending.pop()!;
      if (plan.k === 'any') continue;
      if (plan.k === 'lit') {
        code = this.matchLiteral(plan.pat, plan.slot, code, fail);
        continue;
      }
      if (plan.k === 'lazy') {
        code = { k: 'let', binds: plan.binds, body: code };
        continue;
      }
      if (plan.k === 'or') {
        code = this.matchAlternatives(plan.alts, code, fail);
        continue;
      }
      if (plan.k === 'bang' || plan.k === 'view') {
        if (!wrap) {
          pending.push({ plan, wrap: true }, { plan: plan.inner, wrap: false });
          continue;
        }
        code =
          plan.k === 'bang'
            ? {
                k: 'case',
                scrut: { k: 'local', depth: 0, index: plan.slot },
                bindIndex: plan.slot,
                alts: new Map(),
                default: code,
              }
            : {
                k: 'let',
                binds: [
                  {
                    index: plan.viewSlot,
                    expr: { k: 'app', fn: plan.fn, args: [{ k: 'local', depth: 0, index: plan.slot }] },
                  },
                ],
                body: code,
              };
        continue;
      }
      if (!wrap) {
        pending.push({ plan, wrap: true });
        for (const field of plan.fields) pending.push({ plan: field, wrap: false });
        continue;
      }
      code =
        plan.k === 'newtype'
          ? {
              k: 'let',
              binds: [
                {
                  index: plan.fieldSlot,
                  expr: {
                    k: 'app',
                    fn: { k: 'prim', prim: primitiveNamed('newtypeField') },
                    args: [{ k: 'local', depth: 0, index: plan.slot }],
                  },
                },
              ],
              body: code,
            }
          : {
              k: 'case',
              scrut: { k: 'local', depth: 0, index: plan.slot },
              bindIndex: plan.slot,
              alts: new Map([[plan.con.tag, { slots: plan.fieldSlots, body: code, dictSlots: plan.dictSlots }]]),
              default: plan.con.type.cons.length > 1 ? fail : undefined,
            };
    }
    return code;
  }

  /** Matches the alternatives of an or pattern in turn, sharing the code that runs after any of them matches. */
  private matchAlternatives(alts: readonly Plan[], success: Core, fail: Core): Core {
    const shared = this.frame.alloc();
    const ref: Core = { k: 'local', depth: 0, index: shared };
    let code = fail;
    for (const alt of alts.toReversed()) code = this.matchPlan(alt, ref, code);
    return { k: 'let', binds: [{ index: shared, expr: success }], body: code };
  }

  private matchLiteral(pat: Extract<RPat, { k: 'lit' }>, slot: number, success: Core, fail: Core): Core {
    const scrut: Core = { k: 'local', depth: 0, index: slot };
    if (pat.lit.kind === 'char')
      return { k: 'charCase', scrut, value: pat.lit.value, matched: success, unmatched: fail };
    const eq = this.methodOf(pat.eq as Evidence, this.options.support.eq(), '==');
    let literal: Core =
      pat.lit.kind === 'string' ? { k: 'str', value: pat.lit.value } : this.literalCore(pat.lit, pat.num);
    if (pat.negative)
      literal = {
        k: 'app',
        fn: this.methodOf(pat.negate as Evidence, this.options.support.num(), 'negate'),
        args: [literal],
      };
    return this.ifCore({ k: 'app', fn: eq, args: [scrut, literal] }, success, fail);
  }

  private ifCore(condition: Core, then: Core, otherwise: Core): Core {
    const bool = this.options.support.boolType();
    const trueCon = bool.cons[1];
    return {
      k: 'case',
      scrut: condition,
      alts: new Map([[trueCon.tag, { slots: [], body: then }]]),
      default: otherwise,
    };
  }

  private compileRhs(rhs: RRhs, fail: Core, ioResult = false): Core {
    const savedVisible = this.visible;
    const binds = this.compileLocalGroup(rhs.where);
    let body: Core;
    if (rhs.body.k === 'plain') {
      body = this.bodyExpr(rhs.body.expr, ioResult);
    } else {
      body = fail;
      for (const branch of rhs.body.branches.toReversed())
        body = this.compileGuarded(branch.guards, branch.expr, body, ioResult);
    }
    this.visible = savedVisible;
    return binds.length > 0 ? { k: 'let', binds, body } : body;
  }

  private compileGuarded(guards: readonly RGuard[], expr: RExpr, fail: Core, ioResult: boolean): Core {
    const savedVisible = this.visible;
    const wrappers: (
      | { binds: { index: number; expr: Core }[] }
      | { condition: Core }
      | { slot: number; value: Core; plan: Plan }
    )[] = [];
    try {
      for (const guard of guards) {
        chargeTypeWork();
        if (guard.k === 'let') wrappers.push({ binds: this.compileLocalGroup(guard.binds) });
        else if (guard.k === 'pat') {
          const value = this.compileExpr(guard.expr);
          const slot = this.frame.alloc();
          wrappers.push({ slot, value, plan: this.planPattern(guard.pat, slot, true) });
        } else if (!isOtherwise(guard.expr, this.options.support))
          wrappers.push({ condition: this.compileExpr(guard.expr) });
      }
      let body = this.bodyExpr(expr, ioResult);
      for (const wrapper of wrappers.toReversed()) {
        if ('binds' in wrapper) body = { k: 'let', binds: wrapper.binds, body };
        else if ('plan' in wrapper) {
          body = {
            k: 'let',
            binds: [{ index: wrapper.slot, expr: wrapper.value }],
            body: this.matchPlan(wrapper.plan, body, fail),
          };
        } else body = this.ifCore(wrapper.condition, body, fail);
      }
      return body;
    } finally {
      this.visible = savedVisible;
    }
  }

  private bodyExpr(expr: RExpr, ioResult: boolean): Core {
    return ioResult ? this.ioBlock(expr) : this.compileExpr(expr);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Expressions

  compileExpr(expr: RExpr): Core {
    return this.recursion.run(() => {
      const code = this.compileExprInner(expr);
      if (!this.options.traceTypes || !expr.type) return code;
      return code.k === 'lam'
        ? {
            ...code,
            displayType: expr.type,
            displayParameters: code.displayParameters ?? parameterTypes(expr.type, code.arity),
          }
        : { ...code, displayType: expr.type };
    });
  }

  // code-gauge-allow functionNcss -- One short case per expression kind, each delegating to a helper.
  private compileExprInner(expr: RExpr): Core {
    switch (expr.k) {
      case 'hole': {
        throw new Error('A typed hole reached code generation');
      }
      case 'tyapp': {
        return this.compileExpr(expr.expr);
      }
      case 'var': {
        return this.compileVar(expr);
      }
      case 'con': {
        const global: Core = { k: 'global', global: Codegen.constructorGlobal(expr.con) };
        if (!expr.evidence?.length) return global;
        return { k: 'app', fn: global, args: expr.evidence.map((item) => this.compileEvidence(item)) };
      }
      case 'lit': {
        return this.literalCore(expr.lit, expr.evidence);
      }
      case 'app': {
        return this.compileApp(expr);
      }
      case 'lambda': {
        return this.compileLambda(expr);
      }
      case 'let': {
        const savedVisible = this.visible;
        const binds = this.compileLocalGroup(expr.binds);
        const body = this.compileExpr(expr.body);
        this.visible = savedVisible;
        return { k: 'let', binds, body };
      }
      case 'if': {
        return this.ifCore(this.compileExpr(expr.cond), this.compileExpr(expr.ifTrue), this.compileExpr(expr.ifFalse));
      }
      case 'case': {
        return this.compileCase(expr, false);
      }
      case 'do': {
        return this.compileDo(expr);
      }
      case 'tuple': {
        return { k: 'con', con: tupleCon(expr.elems.length), args: expr.elems.map((elem) => this.compileExpr(elem)) };
      }
      case 'list': {
        let result: Core = { k: 'con', con: NIL_CON, args: [] };
        for (const elem of expr.elems.toReversed())
          result = { k: 'con', con: CONS_CON, args: [this.compileExpr(elem), result] };
        return result;
      }
      case 'arith': {
        const name = expr.next ? (expr.to ? 'enumFromThenTo' : 'enumFromThen') : expr.to ? 'enumFromTo' : 'enumFrom';
        const method = this.methodOf(expr.evidence as Evidence, this.options.support.enumClass(), name);
        const args = [expr.from, expr.next, expr.to]
          .filter((arg): arg is RExpr => arg !== undefined)
          .map((arg) => this.compileExpr(arg));
        return { k: 'app', fn: method, args };
      }
      case 'comp': {
        return this.compileComprehension(expr.quals, 0, expr.expr);
      }
      case 'rsection': {
        // `(op e)` shares `e` between calls: \\x -> op x e, with `e` bound outside the lambda.
        const slot = this.frame.alloc();
        const right = this.compileExpr(expr.right);
        const frame = new FrameScope(this.frame);
        const lambda = this.withFrame(frame, () => {
          frame.alloc();
          const op = this.compileExpr(expr.op);
          return {
            k: 'lam',
            arity: 1,
            size: frame.size,
            body: {
              k: 'app',
              fn: op,
              args: [
                { k: 'local', depth: 0, index: 0 },
                { k: 'local', depth: 1, index: slot },
              ],
            },
          } as Core;
        });
        return { k: 'let', binds: [{ index: slot, expr: right }], body: lambda };
      }
      case 'typed': {
        return this.compileTyped(expr);
      }
      case 'recordCon': {
        const args: Core[] = Array.from({ length: expr.con.arity }, (_, position) => {
          const fieldName = expr.con.fieldNames?.[position];
          return {
            k: 'error',
            message: `${sourceSpanText(expr.span)}: Missing field in record construction ${fieldName ?? ''}`.trimEnd(),
          } as Core;
        });
        for (const field of expr.fields)
          args[field.field.positions.get(expr.con) as number] = this.compileExpr(field.value);
        return this.construct(
          expr.con,
          args,
          (expr.evidence ?? []).map((item) => this.compileEvidence(item))
        );
      }
      case 'recordUpdate': {
        return this.compileRecordUpdate(expr);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch is one kind of variable reference: local, global, method, constructor, or primitive.
  // code-gauge-allow functionNcss -- Each branch is one kind of variable reference: local, global, method, constructor, or primitive.
  private compileVar(expr: Extract<RExpr, { k: 'var' }>): Core {
    const { ref } = expr;
    let head: Core;
    let evidence = expr.evidence ?? [];
    if (ref.kind === 'local') {
      head = this.localRef(ref.local);
      if (!expr.evidence) {
        const own = this.ownDictParams.get(ref.local);
        if (own)
          return own.length === 0 ? head : { k: 'app', fn: head, args: own.map((param) => this.paramRef(param)) };
      }
    } else {
      const entity = ref.entity;
      if (entity.sort === 'method') {
        const [classEvidence, ...rest] = evidence;
        head = this.methodCore(classEvidence, entity.method?.index as number);
        evidence = rest;
      } else if (entity.sort === 'field') {
        head = { k: 'global', global: Codegen.fieldGlobal(entity.field as FieldInfo) };
      } else if (entity.sort === 'con') {
        head = { k: 'global', global: Codegen.constructorGlobal(entity.con as ConInfo) };
      } else {
        head = { k: 'global', global: globalOf(entity, entity.name, entity) };
        if (!expr.evidence) {
          const own = this.ownDictParams.get(entity);
          if (own && own.length > 0) return { k: 'app', fn: head, args: own.map((param) => this.paramRef(param)) };
        }
      }
    }
    if (evidence.length === 0) return head;
    return { k: 'app', fn: head, args: evidence.map((item) => this.compileEvidence(item)) };
  }

  private compileApp(expr: Extract<RExpr, { k: 'app' }>): Core {
    const args: RExpr[] = [];
    let head: RExpr = expr;
    while (head.k === 'app') {
      args.unshift(head.arg);
      head = head.fn;
    }
    const nameArg = args[0];
    if (
      head.k === 'var' &&
      head.ref.kind === 'global' &&
      head.ref.entity === this.options.support.value('primitive') &&
      nameArg?.k === 'lit' &&
      nameArg.lit.kind === 'string'
    ) {
      const primitive = primitiveNamed(nameArg.lit.value.join(''));
      const prim: Core = { k: 'prim', prim: primitive };
      if (args.length === 1) return primitive.arity === 0 ? { k: 'app', fn: prim, args: [] } : prim;
      return { k: 'app', fn: prim, args: args.slice(1).map((rest) => this.compileExpr(rest)) };
    }
    if (head.k === 'con' && args.length >= head.con.arity && head.con.arity > 0) {
      const con = this.construct(
        head.con,
        args.slice(0, head.con.arity).map((arg) => this.compileExpr(arg)),
        (head.evidence ?? []).map((item) => this.compileEvidence(item))
      );
      const rest = args.slice(head.con.arity);
      return rest.length === 0 ? con : { k: 'app', fn: con, args: rest.map((arg) => this.compileExpr(arg)) };
    }
    return { k: 'app', fn: this.compileExpr(head), args: args.map((arg) => this.compileExpr(arg)) };
  }

  private compileLambda(expr: Extract<RExpr, { k: 'lambda' }>): Core {
    const frame = new FrameScope(this.frame);
    return this.withFrame(frame, () => {
      const slots = expr.pats.map(() => frame.alloc());
      const ioResult = this.options.isProgram && expr.type ? isIOType(resultAfter(expr.type, expr.pats.length)) : false;
      const fail: Core = {
        k: 'error',
        message: `${sourceSpanText(expr.span)}: Non-exhaustive patterns in lambda`,
      };
      const savedVisible = this.visible;
      const plans = expr.pats.map((pat, index) => this.planPattern(pat, slots[index], true));
      let body: Core;
      const inner = stripParens(expr.body);
      const binding = { row: expr.span.row, names: expr.pats.flatMap(rpatLocals).map((local) => local.name) };
      if (ioResult) {
        body = this.ioBlock(expr.body, binding);
      } else if (this.options.isProgram && inner.k === 'do') {
        body = this.compileDo(inner, binding);
      } else {
        body = this.compileExpr(expr.body);
      }
      for (let index = plans.length - 1; index >= 0; index--) body = this.matchPlan(plans[index], body, fail);
      this.visible = savedVisible;
      return {
        k: 'lam',
        arity: expr.pats.length,
        size: frame.size,
        body,
        functionResult: expr.type ? isFunctionType(resultAfter(expr.type, expr.pats.length)) : false,
      } as Core;
    });
  }

  private compileCase(expr: Extract<RExpr, { k: 'case' }>, ioResult: boolean): Core {
    const fail: Core = {
      k: 'error',
      message: `${sourceSpanText(expr.span)}: Non-exhaustive patterns in ${expr.what ?? 'case'}`,
    };
    const scrutinee = this.compileExpr(expr.scrutinee);
    if (expr.alts.length === 0) {
      return { k: 'app', fn: { k: 'global', global: this.supportGlobal('seq') }, args: [scrutinee, fail] };
    }
    const slot = this.frame.alloc();
    const clauses: RClause[] = expr.alts.map((alt: RAlt) => ({ pats: [alt.pat], rhs: alt.rhs, span: alt.span }));
    const body = this.compileMatch([slot], clauses, fail, ioResult);
    return (
      this.inlineCaseScrutinee(body, slot, scrutinee) ?? { k: 'let', binds: [{ index: slot, expr: scrutinee }], body }
    );
  }

  private inlineCaseScrutinee(code: Core, slot: number, scrutinee: Core): Core | undefined {
    if (code.k === 'case' && code.bindIndex === slot) return { ...code, scrut: scrutinee };
    if (code.k !== 'let') return undefined;
    const body = this.inlineCaseScrutinee(code.body, slot, scrutinee);
    return body ? { ...code, body } : undefined;
  }

  private compileRecordUpdate(expr: Extract<RExpr, { k: 'recordUpdate' }>): Core {
    const newtype = expr.cons?.find((con) => con.isNewtype);
    if (newtype) return this.construct(newtype, [this.compileExpr(expr.fields[0].value)]);
    const slot = this.frame.alloc();
    const target = this.compileExpr(expr.expr);
    const values = expr.fields.map((field) => {
      const valueSlot = this.frame.alloc();
      return { field: field.field, slot: valueSlot, code: this.compileExpr(field.value) };
    });
    const alts: CaseCore['alts'] = new Map();
    for (const con of expr.cons ?? []) {
      const fieldSlots = Array.from({ length: con.arity }, () => this.frame.alloc());
      const args: Core[] = fieldSlots.map((fieldSlot): Core => ({ k: 'local', depth: 0, index: fieldSlot }));
      for (const value of values)
        args[value.field.positions.get(con) as number] = { k: 'local', depth: 0, index: value.slot };
      alts.set(con.tag, { slots: fieldSlots, body: this.construct(con, args) });
    }
    const owner = expr.fields[0].field.type;
    const body: Core = {
      k: 'case',
      scrut: { k: 'local', depth: 0, index: slot },
      alts,
      default:
        (expr.cons ?? []).length < owner.cons.length
          ? {
              k: 'error',
              message: `${sourceSpanText(expr.span)}: Non-exhaustive patterns in record update`,
            }
          : undefined,
    };
    return {
      k: 'let',
      binds: [{ index: slot, expr: target }, ...values.map((value) => ({ index: value.slot, expr: value.code }))],
      body,
    };
  }

  private compileComprehension(quals: readonly RStmt[], index: number, result: RExpr): Core {
    return this.recursion.run(() => this.compileComprehensionCore(quals, index, result));
  }

  private compileComprehensionCore(quals: readonly RStmt[], index: number, result: RExpr): Core {
    if (index >= quals.length) {
      return { k: 'con', con: CONS_CON, args: [this.compileExpr(result), { k: 'con', con: NIL_CON, args: [] }] };
    }
    const qual = quals[index];
    const nil: Core = { k: 'con', con: NIL_CON, args: [] };
    switch (qual.k) {
      case 'bind': {
        const source = this.compileExpr(qual.expr);
        const frame = new FrameScope(this.frame);
        const lambda = this.withFrame(frame, () => {
          const slot = frame.alloc();
          const savedVisible = this.visible;
          const plan = this.planPattern(qual.pat, slot, true);
          const rest = this.compileComprehension(quals, index + 1, result);
          this.visible = savedVisible;
          return { k: 'lam', arity: 1, size: frame.size, body: this.matchPlan(plan, rest, nil) } as Core;
        });
        const concatMap: Core = { k: 'global', global: this.supportGlobal('concatMapList') };
        return { k: 'app', fn: concatMap, args: [lambda, source] };
      }
      case 'exp': {
        return this.ifCore(this.compileExpr(qual.expr), this.compileComprehension(quals, index + 1, result), nil);
      }
      case 'let': {
        const savedVisible = this.visible;
        const binds = this.compileLocalGroup(qual.binds);
        const rest = this.compileComprehension(quals, index + 1, result);
        this.visible = savedVisible;
        return { k: 'let', binds, body: rest };
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // do blocks

  private compileTyped(expr: Extract<RExpr, { k: 'typed' }>, build = () => this.compileExpr(expr.expr)): Core {
    const params = expr.dictParams ?? [];
    if (params.length === 0) return build();
    const fn = this.compileDictionaryLambda(params, 0, build);
    return { k: 'app', fn, args: (expr.evidence ?? []).map((evidence) => this.compileEvidence(evidence)) };
  }

  private compileDictionaryLambda(
    params: readonly DictParam[],
    arity: number,
    build: (args: number[]) => Core,
    options?: Pick<LamCore, 'info' | 'atomicScope' | 'displayParameters' | 'functionResult'>
  ): Core {
    const frame = new FrameScope(this.frame);
    return this.withFrame(frame, () => {
      for (const param of params) frame.slots.set(param, frame.alloc());
      const args = Array.from({ length: arity }, () => frame.alloc());
      const body = build(args);
      return {
        k: 'lam',
        arity: params.length + arity,
        size: frame.size,
        body,
        ...options,
        displayConstraints: this.options.traceTypes ? params.map((param) => param.pred.type) : undefined,
      };
    });
  }

  private compileDo(expr: Extract<RExpr, { k: 'do' }>, binding?: { row: number; names: string[] }): Core {
    if (this.options.isProgram && expr.type && isIOType(expr.type)) {
      return this.ioBlock(expr, binding);
    }
    const head = expr.type ? splitApp(expr.type).head : undefined;
    const key = head?.tag === 'tcon' ? head.entity : (head ?? expr);
    if (!this.options.isProgram || head?.tag === 'tcon' || this.untracedDoTypes.has(key)) {
      return this.compileOrdinaryDo(expr);
    }
    this.untracedDoTypes.add(key);
    let ordinary: Core | undefined;
    try {
      if (this.hasSequencing(expr.stmts)) ordinary = this.compileOrdinaryDo(expr);
    } finally {
      this.untracedDoTypes.delete(key);
    }
    if (this.options.traceTypes && ordinary) ordinary.displayType = expr.type;
    return { k: 'deferredDo', ordinary, io: this.compileIODo(expr, binding) };
  }

  private compileOrdinaryDo(expr: Extract<RExpr, { k: 'do' }>): Core {
    return expr.monad ? this.compileMonadic(expr.stmts, 0, expr.monad) : this.compileLetChain(expr.stmts, 0);
  }

  private compileLetChain(stmts: readonly RStmt[], index: number): Core {
    const savedVisible = this.visible;
    const binds: { index: number; expr: Core }[] = [];
    try {
      for (let position = index; position < stmts.length; position++) {
        chargeTypeWork();
        const stmt = stmts[position];
        if (stmt.k === 'exp') {
          const body = this.compileExpr(stmt.expr);
          return binds.length > 0 ? { k: 'let', binds, body } : body;
        }
        if (stmt.k !== 'let') throw new Error('A bind statement in a block without a monad');
        for (const bind of this.compileLocalGroup(stmt.binds)) binds.push(bind);
      }
      throw new Error('A do block without a final expression');
    } finally {
      this.visible = savedVisible;
    }
  }

  private compileMonadic(stmts: readonly RStmt[], index: number, monad: Evidence): Core {
    return this.recursion.run(() => this.compileMonadicCore(stmts, index, monad));
  }

  private compileMonadicCore(stmts: readonly RStmt[], index: number, monad: Evidence): Core {
    const stmt = stmts[index];
    const support = this.options.support;
    if (index === stmts.length - 1) return this.compileExpr((stmt as Extract<RStmt, { k: 'exp' }>).expr);
    switch (stmt.k) {
      case 'exp': {
        const then = this.methodOf(monad, support.monad(), '>>');
        return {
          k: 'app',
          fn: then,
          args: [this.compileExpr(stmt.expr), this.compileMonadic(stmts, index + 1, monad)],
        };
      }
      case 'let': {
        const savedVisible = this.visible;
        const binds = this.compileLocalGroup(stmt.binds);
        const body = this.compileMonadic(stmts, index + 1, monad);
        this.visible = savedVisible;
        return { k: 'let', binds, body };
      }
      case 'bind': {
        const bind = this.methodOf(monad, support.monad(), '>>=');
        const action = this.compileExpr(stmt.expr);
        const frame = new FrameScope(this.frame);
        const lambda = this.withFrame(frame, () => {
          const slot = frame.alloc();
          const savedVisible = this.visible;
          const plan = this.planPattern(stmt.pat, slot, true);
          const rest = this.compileMonadic(stmts, index + 1, monad);
          this.visible = savedVisible;
          const fail: Core = stmt.fail
            ? {
                k: 'app',
                fn: this.methodOf(stmt.fail, support.monadFail(), 'fail'),
                args: [
                  // oxlint-disable-next-line typescript/no-misused-spread -- Haskell Char values require code-point iteration.
                  { k: 'str', value: [...`Pattern match failure in 'do' block at ${sourceSpanText(stmt.pat.span)}`] },
                ],
              }
            : { k: 'error', message: 'Pattern match failure' };
          return { k: 'lam', arity: 1, size: frame.size, body: this.matchPlan(plan, rest, fail) } as Core;
        });
        return { k: 'app', fn: bind, args: [action, lambda] };
      }
    }
  }

  private compileIODo(expr: Extract<RExpr, { k: 'do' }>, binding?: { row: number; names: string[] }): IODoCore {
    return this.withIOFrame(() => this.compileIOStatements(expr, binding));
  }

  // code-gauge-allow functionNcss -- The statement kinds share the per-statement trace data computed here.
  private compileIOStatements(
    expr: Extract<RExpr, { k: 'do' }>,
    binding?: { row: number; names: string[] }
  ): Omit<IODoCore, 'size'> {
    const savedVisible = this.visible;
    const entryVisible = this.snapshotVisible();
    const stmts: IOStmt[] = [];
    for (const stmt of expr.stmts) {
      const row = stmt.span.row;
      switch (stmt.k) {
        case 'exp': {
          const { code, noStep } = this.compileStatementExpr(stmt.expr);
          stmts.push({
            kind: 'exp',
            row,
            expr: code,
            onlyCalls: isCall(stmt.expr),
            noStep,
            visible: this.snapshotVisible(),
          });
          break;
        }
        case 'bind': {
          const action = this.compileExpr(stmt.expr);
          const slot = this.frame.alloc();
          let matcher: Core | undefined;
          if (stmt.pat.k === 'var') {
            this.frame.slots.set(stmt.pat.local, slot);
            this.addVisible(stmt.pat.local, slot);
          } else {
            const plan = this.planPattern(stmt.pat, slot, true);
            const fail: Core = {
              k: 'error',
              message: `user error (Pattern match failure in 'do' block at ${sourceSpanText(stmt.pat.span)})`,
            };
            matcher = this.matchPlan(plan, { k: 'con', con: UNIT_CON, args: [] }, fail);
          }
          const onlyCalls =
            rpatLocals(stmt.pat).length === 0 ? isCall(stmt.expr) : isTurtleCreation(stmt.expr, this.options.support);
          stmts.push({
            kind: 'bind',
            row,
            expr: action,
            slot,
            matcher,
            onlyCalls,
            visible: this.snapshotVisible(),
          });
          break;
        }
        case 'let': {
          const binds = this.compileLocalGroup(stmt.binds);
          stmts.push({
            kind: 'let',
            row,
            binds,
            visible: this.snapshotVisible(),
            noStep: definesOnlyFunctions(stmt.binds),
          });
          break;
        }
      }
    }
    this.visible = savedVisible;
    return { k: 'iodo', stmts, bindingRow: binding?.row, bindingNames: binding?.names, entryVisible };
  }

  // code-gauge-allow functionCognitiveComplexity -- IO statement lowering preserves dictionary scopes and dispatches each control form.
  private compileStatementExpr(expr: RExpr): { code: Core; noStep: boolean } {
    if (expr.k === 'typed' && expr.dictParams?.length) return this.compileTypedStatement(expr);
    const inner = stripDollar(expr, this.options.support);
    if (inner.k === 'if') {
      return {
        code: this.ifCore(this.compileExpr(inner.cond), this.ioBlock(inner.ifTrue), this.ioBlock(inner.ifFalse)),
        noStep: true,
      };
    }
    if (inner.k === 'case') return { code: this.compileCase(inner, true), noStep: true };
    if (inner.k === 'app') {
      const fn = stripDollar(inner.fn, this.options.support);
      if (fn.k === 'app' && fn.fn.k === 'var' && fn.fn.ref.kind === 'global') {
        const entity = fn.fn.ref.entity;
        const support = this.options.support;
        const isWhen = entity === support.value('when');
        const isUnless = entity === support.value('unless');
        if (isWhen || isUnless) {
          const condition = this.compileExpr(fn.arg);
          const block = this.ioBlock(inner.arg);
          const skip = this.returnUnit();
          return {
            code: isWhen ? this.ifCore(condition, block, skip) : this.ifCore(condition, skip, block),
            noStep: true,
          };
        }
      }
    }
    const support = this.options.support;
    return {
      code: this.compileExpr(expr),
      noStep: inner.k === 'do' || isLoopStatement(inner, support) || isReturn(inner, support),
    };
  }

  private compileTypedStatement(expr: Extract<RExpr, { k: 'typed' }>): { code: Core; noStep: boolean } {
    let noStep = false;
    const code = this.compileTyped(expr, () => {
      const statement = this.compileStatementExpr(expr.expr);
      noStep = statement.noStep;
      return statement.code;
    });
    return { code, noStep };
  }

  private returnUnit(): Core {
    return {
      k: 'app',
      fn: { k: 'global', global: this.supportGlobal('returnIO') },
      args: [{ k: 'con', con: UNIT_CON, args: [] }],
    };
  }

  private ioBlock(expr: RExpr, binding?: { row: number; names: string[] }): Core {
    if (expr.k === 'typed' && expr.dictParams?.length)
      return this.compileTyped(expr, () => this.ioBlock(expr.expr, binding));
    const inner = stripParens(expr);
    if (inner.k === 'do' && this.hasSequencing(inner.stmts)) return this.compileIODo(inner, binding);
    if (!binding && isReturnUnit(inner, this.options.support)) return this.compileExpr(inner);
    const io =
      inner.k === 'do'
        ? this.compileIODo(inner, binding)
        : this.withIOFrame(() => {
            const { code, noStep } = this.compileStatementExpr(inner);
            return {
              k: 'iodo',
              stmts: [
                {
                  kind: 'exp',
                  row: inner.span.row,
                  expr: code,
                  onlyCalls: isCall(inner),
                  noStep,
                  visible: this.snapshotVisible(),
                },
              ],
              bindingRow: binding?.row,
              bindingNames: binding?.names,
              entryVisible: this.snapshotVisible(),
            };
          });
    return { k: 'deferredDo', io };
  }

  private hasSequencing(stmts: readonly RStmt[]): boolean {
    for (let index = 0; index < stmts.length - 1; index++) {
      chargeTypeWork();
      if (stmts[index].k !== 'let') return true;
    }
    return false;
  }

  private withIOFrame(build: () => Omit<IODoCore, 'size'>): IODoCore {
    const frame = new FrameScope(this.frame);
    const block = this.withFrame(frame, build);
    return { ...block, size: frame.size };
  }

  private snapshotVisible(): VisibleScope {
    return { level: this.frame.level, bindings: this.visible };
  }

  private addVisible(local: LocalVar, slot: number): void {
    const type = local.scheme?.type ?? local.type;
    if (!type || local.name.startsWith(' ')) return;
    chargeTypeWork();
    this.visible = this.visible.set(local.name, { level: this.frame.level, index: slot, type, previewOwner: local });
  }

  private withVisible<T>(entries: OrderedMap<string, VisibleBinding>, build: () => T): T {
    const saved = this.visible;
    this.visible = entries;
    try {
      return build();
    } finally {
      this.visible = saved;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // References and evidence

  private lookup(key: LocalVar | DictParam): Core {
    let depth = 0;
    for (let current: FrameScope | undefined = this.frame; current; current = current.parent) {
      const index = current.slots.get(key);
      if (index !== undefined) return { k: 'local', depth, index };
      depth++;
    }
    throw new Error(`No slot for ${'name' in key ? key.name : `dictionary ${key.id}`}`);
  }

  private localRef(local: LocalVar): Core {
    return this.lookup(local);
  }

  private paramRef(param: DictParam): Core {
    return this.lookup(param);
  }

  compileEvidence(evidence: Evidence): Core {
    return mapGraph<Evidence, Core>(
      evidence,
      resolveEvidence,
      (node) => (node.kind === 'super' ? [node.of] : node.kind === 'instance' ? node.args : []),
      (node, mapped) => {
        switch (node.kind) {
          case 'param': {
            return this.paramRef(node.param);
          }
          case 'instance': {
            return { k: 'dict', instance: node.instance, args: mapped };
          }
          case 'super': {
            return { k: 'super', dict: mapped[0], index: node.index };
          }
          case 'hole': {
            throw new Error(`Unsolved constraint ${node.hole.pred.cls.name}`);
          }
        }
      }
    );
  }

  private methodOf(evidence: Evidence, cls: ClassEntity, name: string): Core {
    return this.methodCore(
      evidence,
      cls.methods.findIndex((method) => method.name === name)
    );
  }

  /** A class method: an instance's own implementation when the instance is known and needs no dictionaries. */
  private methodCore(evidence: Evidence, index: number): Core {
    const resolved = resolveEvidence(evidence);
    if (resolved.kind === 'instance' && resolved.args.length === 0) {
      const implementation = resolved.instance.methods[index];
      if (implementation) return { k: 'global', global: globalOf(implementation, implementation.name, implementation) };
    }
    return { k: 'method', dict: this.compileEvidence(evidence), index };
  }

  private supportGlobal(name: string): GlobalDef {
    const entity = this.options.support.value(name);
    return globalOf(entity, entity.name, entity);
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch is one literal kind with its overloaded or fixed type.
  // code-gauge-allow functionNcss -- Literal lowering keeps numeric precision and overloaded evidence together.
  private literalCore(lit: Extract<RPat, { k: 'lit' }>['lit'], evidence: Evidence | undefined): Core {
    if (lit.kind === 'char') return { k: 'lit', value: lit.value };
    if (lit.kind === 'string') return { k: 'str', value: lit.value };
    const resolved = evidence ? resolveEvidence(evidence) : undefined;
    const instanceType = resolved?.kind === 'instance' ? splitApp(resolved.instance.head).head : undefined;
    const typeEntity = instanceType?.tag === 'tcon' ? instanceType.entity : undefined;
    if (lit.kind === 'int') {
      const value = lit.value;
      if (typeEntity === INTEGER_TYPE) return { k: 'lit', value };
      if (typeEntity === INT_TYPE) return { k: 'lit', value: BigInt.asIntN(64, value) };
      if (typeEntity === WORD_TYPE) return { k: 'lit', value: BigInt.asUintN(64, value) };
      if (typeEntity === DOUBLE_TYPE) return { k: 'lit', value: Number(value) };
      if (typeEntity === FLOAT_TYPE) return { k: 'lit', value: rationalToFloat(value, 1n) };
      const support = this.options.support;
      return {
        k: 'app',
        fn: this.methodOf(evidence as Evidence, support.num(), 'fromInteger'),
        args: [{ k: 'lit', value }],
      };
    }
    const value = lit.value;
    if (typeEntity === DOUBLE_TYPE) return { k: 'lit', value };
    if (typeEntity === FLOAT_TYPE && (!Number.isFinite(value) || value === 0)) {
      return { k: 'lit', value: Math.fround(value) };
    }
    const { numerator, denominator } = exactRatio(lit.text);
    if (typeEntity === FLOAT_TYPE) return { k: 'lit', value: rationalToFloat(numerator, denominator) };
    const ratio: Core = {
      k: 'con',
      con: this.options.support.ratioCon(),
      args: [
        { k: 'lit', value: numerator },
        { k: 'lit', value: denominator },
      ],
    };
    return {
      k: 'app',
      fn: this.methodOf(evidence as Evidence, this.options.support.fractional(), 'fromRational'),
      args: [ratio],
    };
  }
}

type Plan =
  | { k: 'any' }
  | { k: 'bang'; slot: number; inner: Plan }
  | { k: 'view'; slot: number; fn: Core; viewSlot: number; inner: Plan }
  | { k: 'lazy'; binds: { index: number; expr: Core }[] }
  | { k: 'or'; alts: Plan[] }
  | { k: 'lit'; pat: Extract<RPat, { k: 'lit' }>; slot: number }
  | { k: 'newtype'; slot: number; fieldSlot: number; fields: Plan[] }
  | { k: 'con'; con: ConInfo; slot: number; fieldSlots: number[]; fields: Plan[]; dictSlots?: number[] };

function binderKey(binding: Extract<RBinding, { k: 'fun' }>): LocalVar | ValueEntity {
  return binding.binder.kind === 'local' ? binding.binder.local : binding.binder.entity;
}

function parameterTypes(type: Type, count: number): Type[] {
  const parameters: Type[] = [];
  for (let index = 0; index < count; index++) {
    const { head, args } = splitApp(type);
    if (head.tag !== 'tcon' || head.entity.special !== 'function' || args.length !== 2) break;
    parameters.push(args[0]);
    type = args[1];
  }
  return parameters;
}

export function resultAfter(type: Type, count: number): Type {
  let current = prune(type);
  for (let index = 0; index < count; index++) {
    const { head, args } = splitApp(current);
    if (head.tag !== 'tcon' || head.entity.special !== 'function' || args.length !== 2) return current;
    current = prune(args[1]);
  }
  return current;
}

function isFunctionType(type: Type): boolean {
  const { head, args } = splitApp(type);
  return head.tag === 'tcon' && head.entity.special === 'function' && args.length === 2;
}

function isIOType(type: Type): boolean {
  const { head, args } = splitApp(type);
  return head.tag === 'tcon' && head.entity === IO_TYPE && args.length === 1;
}

function stripParens(expr: RExpr): RExpr {
  return expr.k === 'typed' && !expr.dictParams?.length ? stripParens(expr.expr) : expr;
}

/** `f $ x` as `f x`, which statements treat alike. */
function stripDollar(expr: RExpr, support: CodegenSupport): RExpr {
  const inner = stripParens(expr);
  if (inner.k === 'app' && inner.fn.k === 'app') {
    const op = inner.fn.fn;
    if (op.k === 'var' && op.ref.kind === 'global' && op.ref.entity === support.value('$')) {
      return { k: 'app', fn: inner.fn.arg, arg: inner.arg, span: inner.span };
    }
  }
  return inner;
}

/** Whether a statement only calls a function or names an action, whose own steps may show what it did. */
function isCall(expr: RExpr): boolean {
  const inner = stripParens(expr);
  return inner.k === 'app' || inner.k === 'var';
}

function isTurtleCreation(expr: RExpr, support: CodegenSupport): boolean {
  let head = stripDollar(expr, support);
  while (head.k === 'app') {
    chargeTypeWork();
    head = stripDollar(head.fn, support);
  }
  if (head.k !== 'var' || head.ref.kind !== 'global') return false;
  const entity = head.ref.entity;
  return ['newTurtle', 'newTurtleAt', 'newTurtleWithColor'].some((name) => support.value(name) === entity);
}

const LOOP_FUNCTIONS = [
  'forM_',
  'forM',
  'mapM_',
  'mapM',
  'for_',
  'for',
  'traverse_',
  'traverse',
  'zipWithM_',
  'zipWithM',
  'foldM',
  'foldM_',
];

/** Whether a statement applies a looping function such as `forM_` to a lambda, which makes it a loop. */
function isLoopStatement(expr: RExpr, support: CodegenSupport): boolean {
  const args: RExpr[] = [];
  let head = expr;
  while (head.k === 'app') {
    args.push(stripDollar(head.arg, support));
    head = stripDollar(head.fn, support);
  }
  if (head.k !== 'var' || head.ref.kind !== 'global') return false;
  const entity = head.ref.entity;
  if (entity === support.value('flip')) {
    const fn = args.at(-1);
    if (fn?.k !== 'var' || fn.ref.kind !== 'global') return false;
    const loop = fn.ref.entity;
    return LOOP_FUNCTIONS.some((name) => support.value(name) === loop) && args.some((arg) => arg.k === 'lambda');
  }
  if (!LOOP_FUNCTIONS.some((name) => support.value(name) === entity)) return false;
  return args.some((arg) => arg.k === 'lambda');
}

function definesOnlyFunctions(group: RBindGroup): boolean {
  return group.bindings.every((binding) => {
    if (binding.k === 'pat') return binding.binders.every(isFunctionOrAction);
    return binding.binder.kind === 'local' && isFunctionOrAction(binding.binder.local);
  });
}

function isFunctionOrAction(local: LocalVar): boolean {
  const type = local.scheme?.type ?? local.type;
  if (!type) return false;
  const { head } = splitApp(prune(type));
  return head.tag === 'tcon' && (head.entity.special === 'function' || head.entity === IO_TYPE);
}

/** Whether an expression is `return x` or `pure x`. */
function isReturn(expr: RExpr, support: CodegenSupport): boolean {
  if (expr.k !== 'app') return false;
  const fn = stripDollar(expr.fn, support);
  if (fn.k !== 'var' || fn.ref.kind !== 'global') return false;
  return fn.ref.entity === support.value('return') || fn.ref.entity === support.value('pure');
}

function isReturnUnit(expr: RExpr, support: CodegenSupport): boolean {
  if (expr.k !== 'app') return false;
  const fn = expr.fn;
  if (fn.k !== 'var' || fn.ref.kind !== 'global') return false;
  if (fn.ref.entity !== support.value('return') && fn.ref.entity !== support.value('pure')) return false;
  return expr.arg.k === 'con' && expr.arg.con === UNIT_CON;
}

function isOtherwise(expr: RExpr, support: CodegenSupport): boolean {
  if (expr.k === 'var' && expr.ref.kind === 'global' && expr.ref.entity === support.value('otherwise')) return true;
  return expr.k === 'con' && expr.con.name === 'True' && expr.con.type === support.boolType();
}

function patternText(pat: RPat): string {
  switch (pat.k) {
    case 'var': {
      return pat.local.name;
    }
    case 'wild': {
      return '_';
    }
    case 'as': {
      return `${pat.local.name}@${patternText(pat.pat)}`;
    }
    case 'lit': {
      return pat.lit.kind === 'string' ? JSON.stringify(pat.lit.value.join('')) : String(pat.lit.value);
    }
    case 'bang':
    case 'lazy':
    case 'view':
    case 'or': {
      return pat.surface ? surfacePatternText(pat.surface) : '_';
    }
    case 'sig': {
      return patternText(pat.pat);
    }
    case 'con': {
      if (pat.con.type.special === 'tuple') return `(${pat.args.map(patternText).join(', ')})`;
      if (pat.args.length === 0) return pat.con.name;
      return `${pat.con.name} ${pat.args.map((arg) => (arg.k === 'con' && arg.args.length > 0 ? `(${patternText(arg)})` : patternText(arg))).join(' ')}`;
    }
  }
}

function exactRatio(text: string): { numerator: bigint; denominator: bigint } {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) as RegExpExecArray;
  const digits = BigInt(`${match[1]}${match[2] ?? ''}`);
  const exponent = (match[3] ? Number(match[3]) : 0) - (match[2]?.length ?? 0);
  if (digits === 0n) return { numerator: 0n, denominator: 1n };
  if (Math.abs(exponent) + text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('operations');
  let numerator = digits;
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator, denominator };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}
