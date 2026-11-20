// code-gauge-allow-file fileNcss 564 -- Keeps the compilation that shares a function's context and step state together.
import type { Annotations, Coercion, FnContext, LocalVar, PathRes } from './annotations';
import type { Block, Expr, Pattern, Span, Stmt } from './ast';
import { forEachDirect, patternBindings } from './astWalk';
import { claimString, claimStrings, moveString, settleStrings } from './capacity';
import type { Checker } from './checker';
import { compileCall, compileMethodCall } from './compilerCalls';
import { construct, evaluateValues, isPlaceExpr, isRefType, isStringType, LocalPlace } from './compilerCommon';
import { compileFor, compileIf, compileLoop, compileMatch, compileWhile } from './compilerControl';
import { compileMacro } from './compilerMacros';
import { compileBinary, compileCompoundAssign, compileUnary } from './compilerOperators';
import { compileMatcher, type Matcher, takesWhole } from './compilerPatterns';
import { compileField, compileIndex, compilePlace } from './compilerPlaces';
import type { Formatter } from './fmt';
import { normalize } from './infer';
import type { Program } from './items';
import { castValue, copiedSlots, copyValue, needsCopy } from './ops';
import { ControlSignal, type Frame, type FunctionInfo, MOVED, UNASSIGNED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { type ConstDef, type FnDef, isUnit, resolve, shallow, substitute, type Type } from './types';
import {
  CellPlace,
  DynValue,
  EnumValue,
  FnValue,
  type Place,
  RangeValue,
  StructValue,
  UNIT_VALUE,
  type Value,
} from './values';

export { sliceRange } from './compilerPlaces';

export type Eval = (frame: Frame) => Value;
export type PlaceEval = (frame: Frame) => Place;

export interface CompiledFn {
  info: FunctionInfo;
  /** Stores the arguments in the parameters' slots. */
  bind: (frame: Frame, args: Value[]) => void;
  body: Eval;
}

/** What compiled code calls into: functions, closures, natives, conversions, and formatting. */
export interface CallSupport {
  callFn(def: FnDef, typeArgs: Type[], args: Value[], callRow: number | undefined, span: Span, frame: Frame): Value;
  callValue(callee: Value, args: Value[], callRow: number | undefined): Value;
  makeClosure(compiled: CompiledFn, frame: Frame, captures: Place[], byValue: boolean[]): Value;
  toIter(value: Value, from: Type): Value;
  constValue(def: ConstDef, frame: Frame): Value;
  builtinConst(name: string): Value;
  formatter: Formatter;
  turtleNew(args: Value[], span: Span, frame: Frame): Value;
  convertError(value: Value, from: Type, to: Type, frame: Frame): Value;
  strSlice(text: string, start: number | undefined, end: number | undefined, span: Span): string;
}

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type Reader<K extends Expr['kind']> = (c: Compiler, expr: ExprOf<K>) => Eval;

const READERS: { [K in Expr['kind']]: Reader<K> } = {
  int: readInt,
  float: readFloat,
  bool: readLiteral,
  char: readLiteral,
  str: readLiteral,
  path: (c, expr) => c.path(expr),
  unary: compileUnary,
  binary: compileBinary,
  assign: (c, expr) => c.assign(expr),
  compoundAssign: compileCompoundAssign,
  ref: readRef,
  cast: readCast,
  call: compileCall,
  methodCall: compileMethodCall,
  field: compileField,
  index: compileIndex,
  range: readRange,
  tuple: readTuple,
  array: readArray,
  arrayRepeat: readArrayRepeat,
  struct: (c, expr) => c.struct(expr),
  block: (c, expr) => c.compileBlock(expr),
  if: compileIf,
  match: compileMatch,
  loop: compileLoop,
  while: compileWhile,
  for: compileFor,
  break: readJump,
  continue: readJump,
  return: readReturn,
  closure: (c, expr) => c.closure(expr),
  try: (c, expr) => c.tryExpr(expr),
  macro: (c, expr) => compileMacro(c, expr, expr.macro),
};

/** Compiles the checked bodies of a program into closures over frames. */
export class Compiler {
  readonly annotations: Annotations;
  private readonly compiled = new Map<FnContext, CompiledFn>();
  private fn!: FnContext;
  /** Whether the body being compiled records steps (tracing, and not an atomic function's body). */
  private recordsSteps = false;

  constructor(
    readonly program: Program,
    readonly checker: Checker,
    readonly support: CallSupport,
    readonly tracing: boolean
  ) {
    this.annotations = checker.annotations;
  }

  compileFn(def: FnDef): CompiledFn {
    const context = this.checker.fnContexts.get(def);
    if (!context) throw new Error(`No checked body for ${def.name}`);
    const existing = this.compiled.get(context);
    if (existing) return existing;
    const item = def.ast!;
    const info: FunctionInfo = {
      name: def.name,
      slotCount: 0,
      locals: [],
      captures: [],
      isAtomic: context.isAtomic,
    };
    const compiled: CompiledFn = { info, bind: () => {}, body: () => {} };
    this.compiled.set(context, compiled);
    this.withFn(context, () => {
      const params: { local: LocalVar | undefined; pattern: Pattern | undefined }[] = [];
      if (item.selfParam) params.push({ local: context.locals.find((local) => local.isSelf), pattern: undefined });
      for (const param of item.params) params.push({ local: undefined, pattern: param.pattern });
      const binders = params.map(({ local, pattern }) => this.paramBinder(local, pattern));
      compiled.bind = (frame, args) => {
        for (const [index, binder] of binders.entries()) binder(frame, args[index]);
      };
      const body = item.body!;
      const run = this.compileBlock(body, false, true, !isUnit(resolve(def.ret, true)));
      compiled.body = run;
      this.fillInfo(info, context);
    });
    return compiled;
  }

  /** Compiles a constant's initializer, which runs in a frame of its own. */
  compileConst(expr: Expr, context: FnContext): CompiledFn {
    const info: FunctionInfo = { name: 'const', slotCount: 0, locals: [], captures: [], isAtomic: true };
    const compiled: CompiledFn = { info, bind: () => {}, body: () => {} };
    this.withFn(context, () => {
      const saved = this.recordsSteps;
      this.recordsSteps = false;
      compiled.body = this.value(expr);
      this.recordsSteps = saved;
      this.fillInfo(info, context);
    });
    return compiled;
  }

  private fillInfo(info: FunctionInfo, context: FnContext): void {
    info.slotCount = context.slotCount;
    info.locals = context.locals.map((local) => ({
      name: local.name,
      slot: local.slot,
      type: runtimeTypeStatic(local.type),
      isSelf: local.isSelf,
    }));
    info.captures = context.captures.map((local) => ({ name: local.name, type: runtimeTypeStatic(local.type) }));
  }

  private withFn<T>(context: FnContext, run: () => T): T {
    const savedFn = this.fn;
    const savedSteps = this.recordsSteps;
    this.fn = context;
    this.recordsSteps = this.tracing && !context.isAtomic;
    try {
      return run();
    } finally {
      this.fn = savedFn;
      this.recordsSteps = savedSteps;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Steps

  stepRow(span: Span): number | undefined {
    return this.recordsSteps ? span.row : undefined;
  }

  private withStep(span: Span, run: Eval, onlyCalls: boolean): Eval {
    const row = this.stepRow(span);
    if (row === undefined) return run;
    return (frame) => {
      const { steps } = frame.runtime;
      const mark = steps.statementMark();
      const value = run(frame);
      steps.completeStatement(row, onlyCalls, mark);
      return value;
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Blocks and statements

  /**
   * Compiles a block. A function's own block keeps its variables when it ends, so that the trace can report `main`'s
   * final variables; a function body's last expression is its result, which records no step unless the function
   * returns nothing, where it is a statement.
   */
  compileBlock(block: Block, clearsLocals = true, isFnBody = false, returnsValue = false): Eval {
    const stmts = block.stmts.map((stmt) => this.compileStmt(stmt));
    let tail: Eval | undefined;
    if (block.tail) {
      const expr = block.tail;
      const value = this.value(expr);
      const isStatementLike = !isBlockLike(expr) && !(isFnBody && returnsValue) && !isDiverging(expr);
      tail = isStatementLike ? this.withStep(expr.span, value, onlyCalls(expr, this.annotations)) : value;
    }
    const declared = block.stmts.flatMap((stmt) => (stmt.kind === 'let' ? this.patternSlots(stmt.pattern) : []));
    const count = stmts.length;
    const run: Eval = (frame) => {
      for (let index = 0; index < count; index++) stmts[index](frame);
      return tail ? tail(frame) : UNIT_VALUE;
    };
    if (!clearsLocals || declared.length === 0) return run;
    return (frame) => {
      try {
        return run(frame);
      } finally {
        frame.endScope(declared);
      }
    };
  }

  private compileStmt(stmt: Stmt): Eval {
    switch (stmt.kind) {
      case 'let': {
        return this.compileLet(stmt);
      }
      case 'expr': {
        const value = this.value(stmt.expr);
        const run: Eval = (frame) => {
          frame.runtime.spend();
          settleStrings();
          value(frame);
          return UNIT_VALUE;
        };
        if (isBlockLike(stmt.expr) || isDiverging(stmt.expr)) return run;
        return this.withStep(stmt.span, run, onlyCalls(stmt.expr, this.annotations));
      }
      case 'empty': {
        return () => UNIT_VALUE;
      }
    }
  }

  private compileLet(stmt: Extract<Stmt, { kind: 'let' }>): Eval {
    if (!stmt.init) return () => UNIT_VALUE;
    // Destructuring a place moves the parts its bindings take; the place keeps the rest.
    if (stmt.pattern.kind !== 'binding' && isPlaceExpr(stmt.init, this.annotations)) return this.destructure(stmt);
    const init = this.value(stmt.init);
    if (stmt.else) {
      const matcher = this.compileMatcher(stmt.pattern);
      const elseBlock = this.compileBlock(stmt.else);
      const run: Eval = (frame) => {
        frame.runtime.spend();
        const value = init(frame);
        if (!matcher(frame, value, undefined)) elseBlock(frame);
        return UNIT_VALUE;
      };
      return this.withStep(stmt.span, run, isObjectCreation(stmt.init, this.annotations));
    }
    const bind = this.compileBinder(stmt.pattern);
    const local =
      stmt.pattern.kind === 'binding' && !stmt.pattern.sub ? this.annotations.bindings.get(stmt.pattern) : undefined;
    const refer = local && this.referent(stmt.init, local.slot);
    const claim = this.claimInLocal(local);
    const run: Eval = (frame) => {
      frame.runtime.spend();
      settleStrings();
      bind(frame, init(frame));
      claim?.(frame);
      refer?.(frame);
      return UNIT_VALUE;
    };
    return this.withStep(stmt.span, run, isObjectCreation(stmt.init, this.annotations));
  }

  /** Binds an argument to `self` or to a parameter's pattern; a `String` parameter keeps the argument's capacity. */
  private paramBinder(local: LocalVar | undefined, pattern: Pattern | undefined): (frame: Frame, value: Value) => void {
    if (local) return (frame, value) => void (frame.locals[local.slot] = value);
    const bind = this.compileBinder(pattern!);
    const claim = this.claimInLocal(pattern?.kind === 'binding' ? this.annotations.bindings.get(pattern) : undefined);
    return claim ? (frame, value) => (bind(frame, value), claim(frame)) : bind;
  }

  /** A `String` variable claims the capacity of the `String` in flight that it stores. */
  private claimInLocal(local: LocalVar | undefined): ((frame: Frame) => void) | undefined {
    if (!local || !isStringType(local.type)) return undefined;
    const { slot } = local;
    return (frame) => claimString(new LocalPlace(frame, slot));
  }

  /**
   * Records the place a variable's shared reference refers to (`let r = &x;`, `r = &s.name;`, `let r2 = r;`), for the
   * trace to show its current value, or forgets the one it had.
   */
  private referent(expr: Expr, slot: number): ((frame: Frame) => void) | undefined {
    if (!expr.ty) return undefined;
    const type = normalize(shallow(expr.ty));
    if (type.kind !== 'ref' || type.mutable) return undefined;
    if (expr.kind === 'ref' && this.ownedFieldChain(expr.operand)) {
      const place = this.place(expr.operand);
      let root = expr.operand;
      while (root.kind === 'field') root = root.operand;
      const rootRes = this.annotations.paths.get(root);
      const rootSlot = rootRes?.kind === 'local' ? rootRes.local.slot : -1;
      return (frame) => void frame.referents.set(slot, { place: place(frame), root: rootSlot });
    }
    const res = expr.kind === 'path' ? this.annotations.paths.get(expr) : undefined;
    if (res?.kind === 'local') {
      const source = res.local.slot;
      return (frame) => {
        const place = frame.referents.get(source);
        if (place) frame.referents.set(slot, place);
        else frame.referents.delete(slot);
      };
    }
    return (frame) => void frame.referents.delete(slot);
  }

  private destructure(stmt: Extract<Stmt, { kind: 'let' }>): Eval {
    const init = this.read(stmt.init!);
    const place = this.place(stmt.init!);
    const matcher = this.compileMatcher(stmt.pattern);
    const takeAll = takesWhole(this, stmt.init!, stmt.pattern);
    const elseBlock = stmt.else && this.compileBlock(stmt.else);
    const run: Eval = (frame) => {
      frame.runtime.spend();
      if (matcher(frame, init(frame), () => place(frame))) takeAll?.(frame);
      else elseBlock?.(frame);
      return UNIT_VALUE;
    };
    return this.withStep(stmt.span, run, false);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Patterns

  /** Binds an irrefutable pattern to a value. */
  compileBinder(pattern: Pattern): (frame: Frame, value: Value) => void {
    const matcher = this.compileMatcher(pattern);
    return (frame, value) => {
      matcher(frame, value, undefined);
    };
  }

  compileMatcher(pattern: Pattern): Matcher {
    return compileMatcher(this, pattern);
  }

  /** The slots of the variables a pattern binds, which go out of scope with the pattern. */
  patternSlots(pattern: Pattern): number[] {
    return patternBindings(pattern, this.annotations).map((local) => local.slot);
  }

  isCopy(type: Type): boolean {
    return this.checker.solver.isCopy(resolve(type, true));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /** An expression's value where it is moved or copied: a `Copy` aggregate read from a place is copied. */
  // code-gauge-allow functionCognitiveComplexity 17 -- One case per way a value leaves its place: copied or moved.
  // code-gauge-allow functionNcss 31 -- One case per way a value leaves its place: copied or moved.
  value(expr: Expr): Eval {
    const read = this.read(expr);
    const coercion = this.annotations.coercions.get(expr);
    const coerced = coercion ? this.coerce(read, coercion, expr) : read;
    if (!isPlaceExpr(expr, this.annotations)) return coerced;
    const type = resolve(expr.ty ?? { kind: 'tuple', elems: [] }, true);
    if (coercion) return coerced;
    if (needsCopy(type) && this.isCopy(type)) return (frame) => copyValue(coerced(frame));
    // Moving a whole variable out leaves it without a value, which the trace no longer shows.
    if (expr.kind === 'path' && !this.isCopy(type)) {
      const res = this.annotations.paths.get(expr);
      if (res?.kind === 'local' && res.local.mode === 'move' && !isRefType(res.local.type)) {
        const slot = res.local.slot;
        const movesString = isStringType(type) || normalize(shallow(type)).kind === 'adt';
        return (frame) => {
          const value = coerced(frame);
          if (movesString) moveString(new LocalPlace(frame, slot));
          frame.locals[slot] = UNASSIGNED;
          return value;
        };
      }
    }
    // Moving a field out (`let a = s.a;`) leaves the struct without it.
    if (expr.kind === 'field' && !this.isCopy(type) && this.ownedFieldChain(expr)) {
      const place = this.place(expr);
      return (frame) => {
        const target = place(frame);
        const value = target.get();
        moveString(target);
        target.set(MOVED);
        return value;
      };
    }
    return coerced;
  }

  /** Whether a field chain reaches its fields from a variable that owns them, not through a reference. */
  private ownedFieldChain(expr: Expr): boolean {
    if (expr.kind === 'path') {
      const res = this.annotations.paths.get(expr);
      return res?.kind === 'local' && res.local.mode === 'move' && !isRefType(res.local.type);
    }
    if (expr.kind !== 'field') return false;
    const field = this.annotations.fields.get(expr);
    return field !== undefined && field.derefs.length === 0 && this.ownedFieldChain(expr.operand);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of expression, statement, or pattern.
  private coerce(read: Eval, coercion: Coercion, expr: Expr): Eval {
    switch (coercion.kind) {
      case 'deref': {
        const sourceType = normalize(shallow(expr.ty ?? { kind: 'tuple', elems: [] }));
        const sourceMut = sourceType.kind === 'ref' && sourceType.mutable;
        const { derefs, fromMut } = coercion;
        if (sourceMut && !fromMut) {
          // &mut T → &mut U keeps a place.
          return (frame) => {
            let place = read(frame) as Place;
            for (const step of derefs) if (step === 'mutRef') place = place.get() as Place;
            return place;
          };
        }
        return (frame) => {
          let value = read(frame);
          if (sourceMut) value = (value as Place).get();
          for (const step of derefs) if (step === 'mutRef') value = (value as Place).get();
          return value;
        };
      }
      case 'dyn': {
        const type = runtimeType(coercion.type);
        return (frame) => new DynValue(type(frame), read(frame));
      }
      case 'intoIter': {
        const from = runtimeType(coercion.from);
        return (frame) => this.support.toIter(read(frame), from(frame));
      }
    }
  }

  /** An expression's value as it is: a place's value without copying it, as borrows and reads see it. */
  read(expr: Expr): Eval {
    return (READERS[expr.kind] as Reader<Expr['kind']>)(this, expr);
  }

  // code-gauge-allow functionNcss 39 -- One case per kind of expression, statement, or pattern.
  path(expr: Extract<Expr, { kind: 'path' }>): Eval {
    const res = this.annotations.paths.get(expr);
    if (!res) throw new Error('Unresolved path');
    switch (res.kind) {
      case 'local': {
        const slot = res.local.slot;
        const name = res.local.name;
        return (frame) => {
          const value = frame.locals[slot];
          if (value === UNASSIGNED) throw new Error(`Uninitialized variable ${name}`);
          return value;
        };
      }
      case 'capture': {
        const index = res.index;
        return (frame) => frame.captures[index].get();
      }
      case 'fn': {
        const { fn } = res;
        const typeArgs = res.typeArgs.map((arg) => runtimeType(arg));
        const span = expr.span;
        return (frame) => {
          const args = typeArgs.map((arg) => arg(frame));
          return new FnValue((values, callRow) => this.support.callFn(fn, args, values, callRow, span, frame), fn.name);
        };
      }
      case 'ctor': {
        const { def, variant } = res;
        const shape = def.variants[variant].shape;
        if (shape === 'unit') {
          if (def.kind === 'enum') return () => new EnumValue(def, variant, []);
          return () => new StructValue(def, []);
        }
        return () => new FnValue((args) => construct(def, variant, args), def.variants[variant].name);
      }
      case 'const': {
        const def = res.def;
        return (frame) => this.support.constValue(def, frame);
      }
      case 'builtinConst': {
        const value = this.support.builtinConst(res.name);
        return () => value;
      }
      case 'discard': {
        return () => UNIT_VALUE;
      }
    }
  }

  place(expr: Expr): PlaceEval {
    return compilePlace(this, expr);
  }

  struct(expr: Extract<Expr, { kind: 'struct' }>): Eval {
    const res = this.annotations.paths.get(expr);
    if (res?.kind !== 'ctor') throw new Error('Unresolved struct');
    const { def, variant } = res;
    const fields = def.variants[variant].fields;
    const values = expr.fields.map((field) => ({
      index: fields.findIndex((f) => f.name === field.name),
      value: this.value(field.value),
    }));
    // The base gives up the fields it moves, and copies the `Copy` ones.
    const base = expr.base ? this.read(expr.base) : undefined;
    const given = new Set(values.map((v) => v.index));
    const subst = new Map(def.params.map((param, index) => [param, res.typeArgs[index]]));
    const moved = fields.map((field, index) => !given.has(index) && !this.isCopy(substitute(field.type, subst)));
    return (frame) => {
      const result: Value[] = Array.from({ length: fields.length });
      return frame.runtime.withRoots(result, () => {
        for (const { index, value } of values) result[index] = value(frame);
        if (base) takeFromBase(base(frame) as StructValue, result, given, moved);
        frame.runtime.allocate(fields.length);
        claimStrings(result);
        return def.kind === 'enum' ? new EnumValue(def, variant, result) : new StructValue(def, result);
      });
    };
  }

  assign(expr: Extract<Expr, { kind: 'assign' }>): Eval {
    const value = this.value(expr.value);
    const res = expr.target.kind === 'path' ? this.annotations.paths.get(expr.target) : undefined;
    if (res?.kind === 'discard') return (frame) => (value(frame), UNIT_VALUE);
    if (res?.kind === 'local' && res.local.mode === 'move') {
      const slot = res.local.slot;
      const refer = this.referent(expr.value, slot);
      const claim = this.claimInLocal(res.local);
      return (frame) => {
        frame.locals[slot] = value(frame);
        claim?.(frame);
        refer?.(frame);
        return UNIT_VALUE;
      };
    }
    const place = this.place(expr.target);
    const storesString = isStringType(expr.target.ty!);
    return (frame) => {
      const v = value(frame);
      const target = place(frame);
      target.set(v);
      if (storesString) claimString(target);
      return UNIT_VALUE;
    };
  }

  closure(expr: Extract<Expr, { kind: 'closure' }>): Eval {
    const info = this.annotations.closures.get(expr);
    if (!info) throw new Error('Unchecked closure');
    const { context } = info;
    const outer = this.fn;
    const functionInfo: FunctionInfo = { name: '{closure}', slotCount: 0, locals: [], captures: [], isAtomic: false };
    const compiled: CompiledFn = { info: functionInfo, bind: () => {}, body: () => {} };
    this.withFn(context, () => {
      // A closure's steps are recorded as its function's are.
      this.recordsSteps = this.tracing && !outer.isAtomic && !context.isAtomic;
      const binders = expr.params.map((param) => this.compileBinder(param.pattern));
      compiled.bind = (frame, args) => {
        for (const [index, binder] of binders.entries()) binder(frame, args[index]);
      };
      compiled.body = this.value(expr.body);
      this.fillInfo(functionInfo, context);
    });
    // Captures: places of the enclosing function's variables, or copies of them for a `move` closure.
    const captures = context.captures.map((local) => {
      const res: PathRes =
        local.owner === outer
          ? { kind: 'local', local }
          : { kind: 'capture', local, index: outer.captures.indexOf(local) };
      return { res, local, fields: this.capturedFields(expr.body, local) };
    });
    const byValue = context.captures.map((local) => context.isMove || context.movedCaptures?.includes(local) === true);
    return (frame) => {
      const places = captures.map((capture) => this.capturePlace(frame, capture, context));
      return this.support.makeClosure(compiled, frame, places, byValue);
    };
  }

  /** The place a closure reaches a captured variable through: the variable's own, or a copy that it owns. */
  private capturePlace(
    frame: Frame,
    { res, local, fields }: { res: PathRes; local: LocalVar; fields: Set<string> | undefined },
    context: FnContext
  ): Place {
    const byValue = context.isMove || context.movedCaptures?.includes(local);
    let place: Place;
    if (res.kind === 'local') {
      const reborrowed = local.mode === 'refMut' && !context.isMove;
      place = reborrowed ? new CellPlace(frame.locals[local.slot] as Value) : new LocalPlace(frame, local.slot);
    } else {
      place = frame.captures[(res as { index: number }).index];
    }
    if (!byValue) return place;
    const value = place.get();
    if (this.isCopy(local.type)) return new CellPlace(needsCopy(resolve(local.type, true)) ? copyValue(value) : value);
    if (res.kind !== 'local' || local.mode !== 'move' || isRefType(local.type)) return new CellPlace(value);
    return new CellPlace(this.moveCaptured(frame, local, value, fields));
  }

  /**
   * The fields of a captured variable that a closure's body uses (`p.name`), which it captures on their own as edition
   * 2021 does, or undefined when the body uses the whole variable.
   */
  private capturedFields(body: Expr, local: LocalVar): Set<string> | undefined {
    const fields = new Set<string>();
    let whole = false;
    const isCapture = (expr: Expr): boolean => {
      const res = expr.kind === 'path' ? this.annotations.paths.get(expr) : undefined;
      return (res?.kind === 'capture' || res?.kind === 'local') && res.local === local;
    };
    const visit = (expr: Expr): void => {
      if (expr.kind === 'field' && isCapture(expr.operand) && this.annotations.fields.get(expr)?.derefs.length === 0) {
        fields.add(expr.name);
        return;
      }
      if (isCapture(expr)) whole = true;
      forEachDirect(expr, visit);
    };
    visit(body);
    return whole || fields.size === 0 ? undefined : fields;
  }

  /**
   * What a closure that captures by value takes from a variable: all of it, which leaves the variable without a value,
   * or the fields it uses, which leave the variable's other fields in place.
   */
  private moveCaptured(frame: Frame, local: LocalVar, value: Value, fields: Set<string> | undefined): Value {
    const t = normalize(shallow(resolve(local.type, true)));
    if (!fields || !(value instanceof StructValue) || t.kind !== 'adt') {
      frame.locals[local.slot] = UNASSIGNED;
      return value;
    }
    const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
    const shell = new StructValue(value.def, [...value.fields]);
    for (const [index, field] of t.def.variants[0].fields.entries()) {
      if (fields.has(field.name) && !this.isCopy(substitute(field.type, subst))) value.fields[index] = MOVED;
    }
    return shell;
  }

  tryExpr(expr: Extract<Expr, { kind: 'try' }>): Eval {
    const res = this.annotations.tries.get(expr);
    if (!res) throw new Error('Unchecked ?');
    const operand = this.value(expr.operand);
    if (res.kind === 'option') {
      return (frame) => {
        const value = operand(frame) as EnumValue;
        if (value.variant === 0) throw new ControlSignal('return', undefined, value);
        return value.fields[0];
      };
    }
    const from = res.errorFrom ? runtimeType(res.errorFrom) : undefined;
    const to = res.errorTo ? runtimeType(res.errorTo) : undefined;
    return (frame) => {
      const value = operand(frame) as EnumValue;
      if (value.variant === 0) return value.fields[0];
      const error =
        from && to ? this.support.convertError(value.fields[0], from(frame), to(frame), frame) : value.fields[0];
      throw new ControlSignal('return', undefined, new EnumValue(value.def, 1, [error]));
    };
  }
}

function readInt(_c: Compiler, expr: ExprOf<'int'>): Eval {
  const value = expr.value;
  const type = resolve(expr.ty!, true);
  if (type.kind === 'float') {
    const number = Number(value);
    return () => number;
  }
  return () => value;
}

function readFloat(_c: Compiler, expr: ExprOf<'float'>): Eval {
  const type = resolve(expr.ty!, true);
  const value = type.kind === 'float' && type.name === 'f32' ? expr.f32 : expr.value;
  return () => value;
}

function readLiteral(_c: Compiler, expr: ExprOf<'bool' | 'char' | 'str'>): Eval {
  const value = expr.value;
  return () => value;
}

function readRef(c: Compiler, expr: ExprOf<'ref'>): Eval {
  if (expr.mutable) {
    const place = c.place(expr.operand);
    return (frame) => place(frame);
  }
  return c.read(expr.operand);
}

function readCast(c: Compiler, expr: ExprOf<'cast'>): Eval {
  const operand = c.value(expr.operand);
  const from = resolve(expr.operand.ty!, true);
  const to = resolve(expr.ty!, true);
  return (frame) => castValue(operand(frame), from, to);
}

function readRange(c: Compiler, expr: ExprOf<'range'>): Eval {
  const start = expr.start ? c.value(expr.start) : undefined;
  const end = expr.end ? c.value(expr.end) : undefined;
  const inclusive = expr.inclusive;
  return (frame) => new RangeValue(start?.(frame), end?.(frame), inclusive);
}

function readTuple(c: Compiler, expr: ExprOf<'tuple'>): Eval {
  if (expr.elems.length === 0) return () => UNIT_VALUE;
  const elems = expr.elems.map((elem) => c.value(elem));
  return (frame) => claimStrings(evaluateValues(frame, elems));
}

function readArray(c: Compiler, expr: ExprOf<'array'>): Eval {
  const elems = expr.elems.map((elem) => c.value(elem));
  return (frame) => {
    frame.runtime.allocate(elems.length);
    return claimStrings(evaluateValues(frame, elems));
  };
}

function readArrayRepeat(c: Compiler, expr: ExprOf<'arrayRepeat'>): Eval {
  const value = c.value(expr.value);
  const count = c.value(expr.count);
  return (frame) => {
    const length = Number(count(frame) as bigint);
    frame.runtime.allocate(length);
    frame.runtime.spend(Math.ceil(length / 16));
    const item = value(frame);
    frame.runtime.allocate(length * copiedSlots(item));
    return Array.from({ length }, () => copyValue(item));
  };
}

function readJump(c: Compiler, expr: ExprOf<'break' | 'continue'>): Eval {
  const value = expr.kind === 'break' && expr.value ? c.value(expr.value) : undefined;
  const kind = expr.kind;
  const label = expr.label;
  return (frame) => {
    throw new ControlSignal(kind, label, value?.(frame));
  };
}

function readReturn(c: Compiler, expr: ExprOf<'return'>): Eval {
  const value = expr.value ? c.value(expr.value) : undefined;
  return (frame) => {
    throw new ControlSignal('return', undefined, value ? value(frame) : UNIT_VALUE);
  };
}

function runtimeTypeStatic(type: Type): Type {
  return resolve(type, true);
}

function isBlockLike(expr: Expr): boolean {
  return ['block', 'if', 'match', 'loop', 'while', 'for'].includes(expr.kind);
}

function isDiverging(expr: Expr): boolean {
  if (expr.kind === 'return' || expr.kind === 'break' || expr.kind === 'continue') return true;
  return expr.kind === 'macro' && expr.macro.kind === 'panic';
}

/** Whether an expression statement only calls functions or creates objects, whose own steps show what it did. */
export function onlyCalls(expr: Expr, annotations: Annotations): boolean {
  if (expr.kind === 'assign') return isObjectCreation(expr.value, annotations);
  if (expr.kind === 'call' || expr.kind === 'methodCall') return true;
  if (expr.kind === 'macro') return expr.macro.kind === 'print' || expr.macro.kind === 'write';
  return isObjectCreation(expr, annotations);
}

/**
 * Whether an expression only creates an object: a struct expression, or a call of an associated function whose name
 * starts with `new` (Rust's convention for constructors), as Java's `new`.
 */
export function isObjectCreation(expr: Expr, annotations: Annotations): boolean {
  if (expr.kind === 'struct') return true;
  if (expr.kind === 'call' && expr.callee.kind === 'path') {
    const res = annotations.paths.get(expr.callee);
    const segments = expr.callee.path.segments;
    if (res?.kind === 'fn' && segments.length > 1 && segments.at(-1)!.name.startsWith('new')) return true;
  }
  if (expr.kind === 'macro' && (expr.macro.kind === 'vec' || expr.macro.kind === 'vecRepeat')) {
    return (
      expr.macro.kind === 'vec' &&
      expr.macro.elems.length > 0 &&
      expr.macro.elems.every((elem) => isObjectCreation(elem, annotations))
    );
  }
  if (expr.kind === 'array')
    return expr.elems.length > 0 && expr.elems.every((elem) => isObjectCreation(elem, annotations));
  return false;
}

/** Fills the fields a struct expression does not give from its base: moving the moved ones, copying the others. */
function takeFromBase(source: StructValue, result: Value[], given: ReadonlySet<number>, moved: boolean[]): void {
  for (let index = 0; index < result.length; index++) {
    if (given.has(index)) continue;
    result[index] = moved[index] ? source.fields[index] : copyValue(source.fields[index]);
    if (moved[index]) source.fields[index] = MOVED;
  }
}
