// code-gauge-allow-file fileNcss 618 -- Keeps the compilation that shares a function's context and step state together.
import type { Annotations, Coercion, FnContext, LocalVar, PathRes } from './annotations';
import type { Block, Expr, Pattern, Span, Stmt } from './ast';
import { patternBindings } from './astWalk';
import type { Checker } from './checker';
import { compileCall, compileMethodCall } from './compilerCalls';
import { construct, derefAll, evaluateValues, isPlaceExpr, isRefType, LocalPlace } from './compilerCommon';
import { compileFor, compileIf, compileLoop, compileMatch, compileWhile } from './compilerControl';
import { compileMacro } from './compilerMacros';
import { compileBinary, compileCompoundAssign, compileUnary } from './compilerOperators';
import { compileConstant, compileMatcher, compilePatternInput, type Matcher, takesWhole } from './compilerPatterns';
import { compileField, compileIndex, compilePlace } from './compilerPlaces';
import type { Formatter } from './fmt';
import { normalize } from './infer';
import type { Program } from './items';
import { type CaptureMode, captureStoragePlaces } from './loanCaptures';
import { castValue, copyValue, needsCopy } from './ops';
import { ControlSignal, type Frame, type FunctionInfo, MOVED, UNASSIGNED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { trackCollectionStorage } from './turtleTypes';
import { type ConstDef, type FnDef, isUnit, resolve, shallow, substitute, type Type } from './types';
import {
  AccessorPlace,
  CellPlace,
  DynValue,
  EnumValue,
  FnValue,
  type Place,
  RangeValue,
  StructValue,
  textOf,
  UNIT_VALUE,
  type Value,
} from './values';

export { sliceRange } from './compilerPlaces';

export type Eval = ((frame: Frame) => Value) & { valueType?: Type };
export type PlaceEval = (frame: Frame) => Place;

export interface CompiledFn {
  info: FunctionInfo;
  /** Stores the arguments in the parameters' slots. */
  bind: (frame: Frame, args: Value[]) => void;
  body: Eval;
}

/** What compiled code calls into: functions, closures, natives, conversions, and formatting. */
type CaptureCopy = (value: Value, type: Type) => Value;

export interface ClosureCapture {
  place: Place;
  duplicate?: (copy: CaptureCopy) => ClosureCapture;
}

interface FieldCapture {
  path: number[];
  mode: CaptureMode;
}

export interface CallSupport {
  callFn(def: FnDef, typeArgs: Type[], args: Value[], callRow: number | undefined, span: Span, frame: Frame): Value;
  callValue(callee: Value, args: Value[], callRow: number | undefined): Value;
  makeClosure(compiled: CompiledFn, frame: Frame, captures: ClosureCapture[]): Value;
  toIter(value: Value, from: Type): Value;
  constValue(def: ConstDef, frame: Frame, typeArgs: Type[]): Value;
  builtinConst(name: string): Value;
  formatter: Formatter;
  convertError(value: Value, from: Type, to: Type, frame: Frame): Value;
  strSlice(text: string, range: RangeValue | undefined, span: Span): string;
}

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type Reader<K extends Expr['kind']> = (c: Compiler, expr: ExprOf<K>, asStatement: boolean) => Eval;

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
  block: (c, expr, asStatement) => c.compileBlock(expr, asStatement),
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
      const run = this.compileBlock(body, isUnit(resolve(def.ret, true)), false);
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

  compileBlock(block: Block, tailAsStatement = false, clearsLocals = true): Eval {
    const stmts = block.stmts.map((stmt) => this.compileStmt(stmt));
    const tail = block.tail && (tailAsStatement ? this.statement(block.tail) : this.value(block.tail));
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

  statement(expr: Expr, span = expr.span): Eval {
    const value = this.value(expr, true);
    if (isBlockLike(expr) || isDiverging(expr)) return value;
    return this.withStep(span, value, onlyCalls(expr, this.annotations));
  }

  private compileStmt(stmt: Stmt): Eval {
    switch (stmt.kind) {
      case 'let': {
        return this.compileLet(stmt);
      }
      case 'expr': {
        const value = this.statement(stmt.expr, stmt.span);
        return (frame) => {
          frame.runtime.spend();
          value(frame);
          return UNIT_VALUE;
        };
      }
      case 'empty': {
        return () => UNIT_VALUE;
      }
    }
  }

  private compileLet(stmt: Extract<Stmt, { kind: 'let' }>): Eval {
    if (!stmt.init) {
      const locals = patternBindings(stmt.pattern, this.annotations);
      return (frame) => {
        for (const local of locals) frame.locals[local.slot] = MOVED;
        return UNIT_VALUE;
      };
    }
    // Destructuring a place moves the parts its bindings take; the place keeps the rest.
    if (stmt.pattern.kind !== 'binding' && isPlaceExpr(stmt.init, this.annotations)) return this.destructure(stmt);
    if (stmt.else) {
      const init = this.value(stmt.init);
      const matcher = this.compileMatcher(stmt.pattern);
      const elseBlock = this.compileBlock(stmt.else, true);
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
    const init = this.bindingValue(stmt.init, local?.slot);
    const run: Eval = (frame) => {
      frame.runtime.spend();
      bind(frame, init(frame));
      return UNIT_VALUE;
    };
    return this.withStep(stmt.span, run, isObjectCreation(stmt.init, this.annotations));
  }

  private paramBinder(local: LocalVar | undefined, pattern: Pattern | undefined): (frame: Frame, value: Value) => void {
    if (local) return (frame, value) => void (frame.locals[local.slot] = value);
    const bind = this.compileOwnedBinder(pattern!);
    return (frame, value) => {
      frame.temporaries.push(bind(frame, value));
    };
  }

  private bindingValue(expr: Expr, slot: number | undefined): Eval {
    const read = this.value(expr);
    if (slot === undefined || !expr.ty) return read;
    const type = normalize(shallow(expr.ty));
    if (type.kind !== 'ref' || type.mutable) return read;
    if (expr.kind === 'ref' && this.ownedPlace(expr.operand)) {
      return this.directBorrow(expr, expr.operand, slot);
    }
    const res = expr.kind === 'path' ? this.annotations.paths.get(expr) : undefined;
    return (frame) => {
      const value = read(frame);
      const referent = res?.kind === 'local' ? frame.referents.get(res.local.slot) : undefined;
      if (referent) frame.referents.set(slot, referent);
      else frame.referents.delete(slot);
      return value;
    };
  }

  /**
   * A shared borrow of an owned place, whose referent the variable in `slot` follows. A coercion (to a trait object, say)
   * applies to the value read from that one evaluation of the place, so an index's expression runs once.
   */
  private directBorrow(expr: Expr, operand: Expr, slot: number): Eval {
    const place = this.place(operand);
    let root = operand;
    while (root.kind === 'field' || root.kind === 'index' || root.kind === 'unary') root = root.operand;
    const res = this.annotations.paths.get(root);
    const rootSlot = res?.kind === 'local' ? res.local.slot : -1;
    const coercion = this.annotations.coercions.get(expr);
    const borrowed: Value[] = [];
    const coerced = coercion && this.coerce(() => borrowed.pop() as Value, coercion, expr);
    return (frame) => {
      const target = place(frame);
      if (!coerced) {
        frame.referents.set(slot, { place: target, root: rootSlot });
        return target.get();
      }
      const view = (value: Value): Value => {
        borrowed.push(value);
        return coerced(frame);
      };
      frame.referents.set(slot, { place: target, root: rootSlot, view });
      return view(target.get());
    };
  }

  private destructure(stmt: Extract<Stmt, { kind: 'let' }>): Eval {
    const input = compilePatternInput(this, stmt.init!);
    const matcher = this.compileMatcher(stmt.pattern);
    const takeAll = takesWhole(this, stmt.init!, stmt.pattern);
    const elseBlock = stmt.else && this.compileBlock(stmt.else, true);
    const run: Eval = (frame) => {
      frame.runtime.spend();
      const { value, place } = input(frame);
      const matched = frame.runtime.withRoots([place], () => matcher(frame, value, () => place));
      if (matched) takeAll?.(frame);
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

  compileOwnedBinder(pattern: Pattern): (frame: Frame, value: Value) => Place {
    const matcher = this.compileMatcher(pattern);
    return (frame, value) => {
      const place = new CellPlace(value);
      frame.runtime.withRoots([place], () => matcher(frame, value, () => place));
      return place;
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
  value(expr: Expr, asStatement = false): Eval {
    const read = this.read(expr, asStatement);
    const coercion = this.annotations.coercions.get(expr);
    const type = resolve(expr.ty ?? { kind: 'tuple', elems: [] }, true);
    const value = this.adjustedValue(expr, read, type, coercion);
    value.valueType = expr.ty;
    return value;
  }

  private adjustedValue(expr: Expr, read: Eval, type: Type, coercion?: Coercion): Eval {
    if (this.annotations.reborrows.has(expr)) return coercion ? this.coerce(read, coercion, expr) : read;
    if (!coercion) return this.valueFromPlace(expr, read, type);
    const input = coercion.kind !== 'deref' && !isRefType(type) ? this.valueFromPlace(expr, read, type) : read;
    return this.coerce(input, coercion, expr);
  }

  private valueFromPlace(expr: Expr, read: Eval, type: Type): Eval {
    if (!isPlaceExpr(expr, this.annotations)) return read;
    if (this.isCopy(type)) return needsCopy(type) ? (frame) => copyValue(read(frame)) : read;
    // Moving a whole variable out leaves it without a value, which the trace no longer shows.
    if (expr.kind === 'path') {
      const res = this.annotations.paths.get(expr);
      if (res?.kind === 'local' && res.local.mode === 'move' && !isRefType(res.local.type)) {
        const slot = res.local.slot;
        return (frame) => {
          const value = read(frame);
          frame.locals[slot] = MOVED;
          return value;
        };
      }
    }
    // A closure moves out only what it captured by value, which its own storage holds.
    if ((expr.kind === 'path' || expr.kind === 'field' || expr.kind === 'unary') && this.ownedPlace(expr)) {
      const place = this.place(expr);
      return (frame) => {
        const target = place(frame);
        const value = target.get();
        target.set(MOVED);
        return value;
      };
    }
    return read;
  }

  ownedPlace(expr: Expr): boolean {
    if (expr.kind === 'path') {
      const res = this.annotations.paths.get(expr);
      const owned = res?.kind === 'local' || res?.kind === 'capture';
      return owned && res.local.mode === 'move' && !isRefType(res.local.type);
    }
    if (expr.kind === 'field') {
      const field = this.annotations.fields.get(expr);
      return field !== undefined && field.derefs.every((step) => step === 'own') && this.ownedPlace(expr.operand);
    }
    if (expr.kind === 'index') {
      const index = this.annotations.indexes.get(expr);
      return !!index && !index.range && index.derefs.every((step) => step === 'own') && this.ownedPlace(expr.operand);
    }
    if (expr.kind !== 'unary' || expr.op !== '*') return false;
    const operand = normalize(shallow(expr.operand.ty!));
    return operand.kind === 'adt' && operand.def.builtin === 'Box' && this.ownedPlace(expr.operand);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Reference adjustments preserve mutable places and distinguish borrowed text from owned values.
  private coerce(read: Eval, coercion: Coercion, expr: Expr): Eval {
    switch (coercion.kind) {
      case 'deref': {
        const sourceType = normalize(shallow(expr.ty ?? { kind: 'tuple', elems: [] }));
        const sourceMut = sourceType.kind === 'ref' && sourceType.mutable;
        const { derefs, fromMut, toStr } = coercion;
        const keepsPlace = sourceMut && !fromMut;
        return (frame) => {
          let value = read(frame);
          if (fromMut) value = (value as Place).get();
          for (const step of derefs) if (step === 'mutRef') value = (value as Place).get();
          return toStr && !keepsPlace ? textOf(value) : value;
        };
      }
      case 'dyn': {
        return dynCoercion(read, runtimeType(coercion.type), coercion.mutable);
      }
      case 'intoIter': {
        const from = runtimeType(coercion.from);
        return (frame) => this.support.toIter(read(frame), from(frame));
      }
    }
  }

  /** An expression's value as it is: a place's value without copying it, as borrows and reads see it. */
  read(expr: Expr, asStatement = false): Eval {
    const read = (READERS[expr.kind] as Reader<Expr['kind']>)(this, expr, asStatement);
    const type = expr.ty;
    const evaluate = type && !isPlaceExpr(expr, this.annotations) ? trackCollectionStorage(read, type) : read;
    evaluate.valueType = expr.ty;
    return evaluate;
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
        return compileConstant(this, res);
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
      const assigned = this.bindingValue(expr.value, slot);
      return (frame) => {
        frame.locals[slot] = assigned(frame);
        return UNIT_VALUE;
      };
    }
    const place = this.place(expr.target);
    return (frame) => {
      const v = value(frame);
      // Evaluating the place can run the program's code, during which only this assignment holds the value.
      frame.runtime.withRoots([v], () => place(frame).set(v));
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
      const binders = expr.params.map((param) => this.paramBinder(undefined, param.pattern));
      compiled.bind = (frame, args) => {
        for (const [index, binder] of binders.entries()) binder(frame, args[index]);
      };
      const body = expr.body;
      compiled.body = body.ty && isUnit(resolve(body.ty, true)) ? this.statement(body) : this.value(body);
      this.fillInfo(functionInfo, context);
    });
    const captures = context.captures.map((local) => {
      const res: PathRes =
        local.owner === outer
          ? { kind: 'local', local }
          : { kind: 'capture', local, index: outer.captures.indexOf(local) };
      const places = captureStoragePlaces(context.projectedCaptures?.get(local) ?? [], local.type);
      const fields = places.map(({ proj, mode }) => ({ path: captureFieldIndices(local.type, proj), mode }));
      return { res, local, fields };
    });
    return (frame) =>
      this.support.makeClosure(
        compiled,
        frame,
        captures.map((capture) => this.capturePlace(frame, capture, context))
      );
  }

  private capturePlace(
    frame: Frame,
    { res, local, fields }: { res: PathRes; local: LocalVar; fields: FieldCapture[] },
    context: FnContext
  ): ClosureCapture {
    if (fields.length === 0) return { place: new CellPlace(UNIT_VALUE) };
    const localRef = local.mode === 'refMut' && !context.isMove;
    const place =
      res.kind === 'local'
        ? localRef
          ? new CellPlace(frame.locals[local.slot] as Value)
          : new LocalPlace(frame, local.slot)
        : frame.captures[(res as { index: number }).index];
    const value = place.get();
    if (context.reborrowedCaptures?.has(local)) return { place: new CellPlace(value) };
    if (!fields.some(({ mode }) => mode === 'value')) return { place };
    const type = runtimeType(local.type)(frame);
    if (fields[0].path.length === 0) return this.captureEntireValue(place, value, type, local);
    const owned = this.captureFields(frame, value, type, fields, (source, field, fieldType) => {
      const item = source[field];
      if (this.isCopy(fieldType)) return needsCopy(fieldType) ? copyValue(item) : item;
      source[field] = MOVED;
      return item;
    });
    return this.ownedCapture(frame, owned, type, fields);
  }

  private captureEntireValue(place: Place, value: Value, type: Type, local: LocalVar): ClosureCapture {
    let item = value;
    if (this.isCopy(type)) {
      if (needsCopy(type)) item = copyValue(value);
    } else if (local.mode === 'move' && !isRefType(type)) {
      place.set(MOVED);
    }
    return this.ownedValue(item, type);
  }

  private ownedValue(value: Value, type: Type): ClosureCapture {
    const place = new CellPlace(value);
    return { place, duplicate: (copy) => this.ownedValue(copy(place.get(), type), type) };
  }

  private ownedCapture(frame: Frame, value: Value, type: Type, fields: FieldCapture[]): ClosureCapture {
    const place = new CellPlace(value);
    return {
      place,
      duplicate: (copy) => {
        const cloned = this.captureFields(frame, place.get(), type, fields, (source, index, item) =>
          copy(source[index], item)
        );
        return this.ownedCapture(frame, cloned, type, fields);
      },
    };
  }

  private captureFields(
    frame: Frame,
    value: Value,
    type: Type,
    captures: FieldCapture[],
    own: (source: Value[], index: number, type: Type) => Value
  ): Value {
    const source = value instanceof StructValue ? value.fields : (value as Value[]);
    frame.runtime.allocate(source.length);
    const fields: Value[] = Array.from({ length: source.length });
    for (const index of new Set(captures.map(({ path }) => path[0]))) {
      const projected = captures
        .filter(({ path }) => path[0] === index)
        .map(({ path, mode }) => ({ path: path.slice(1), mode }));
      const fieldType = captureFieldType(type, index);
      if (projected[0].path.length > 0) {
        fields[index] = this.captureFields(frame, source[index], fieldType, projected, own);
      } else if (projected[0].mode === 'value') {
        fields[index] = own(source, index, fieldType);
      } else {
        Object.defineProperty(fields, index, {
          enumerable: true,
          get: () => source[index],
          set: (item: Value) => {
            source[index] = item;
          },
        });
      }
    }
    return value instanceof StructValue ? new StructValue(value.def, fields) : fields;
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

function captureFieldIndices(type: Type, path: string[]): number[] {
  let current = type;
  return path.map((field) => {
    const t = normalize(shallow(current));
    const index = t.kind === 'adt' ? t.def.variants[0].fields.findIndex(({ name }) => name === field) : Number(field);
    current = captureFieldType(current, index);
    return index;
  });
}

function captureFieldType(type: Type, index: number): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'tuple') return t.elems[index];
  if (t.kind !== 'adt') throw new Error('Expected a struct or tuple capture');
  const subst = new Map(t.def.params.map((param, i) => [param, t.args[i]]));
  return substitute(t.def.variants[0].fields[index].type, subst);
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

function dynCoercion(read: Eval, type: (frame: Frame) => Type, mutable: boolean): Eval {
  if (!mutable) return (frame) => new DynValue(type(frame), derefAll(read(frame)));
  return (frame) => {
    const target = read(frame) as Place;
    const concrete = type(frame);
    return new AccessorPlace(
      () => new DynValue(concrete, target.get()),
      (value) => target.set(value instanceof DynValue ? value.value : value),
      target
    );
  };
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
  const to = resolve(expr.ty!, true);
  return (frame) => castValue(operand(frame), to);
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
  return (frame) => evaluateValues(frame, elems);
}

function readArray(c: Compiler, expr: ExprOf<'array'>): Eval {
  const elems = expr.elems.map((elem) => c.value(elem));
  return (frame) => {
    frame.runtime.allocate(elems.length);
    return evaluateValues(frame, elems);
  };
}

function readArrayRepeat(c: Compiler, expr: ExprOf<'arrayRepeat'>): Eval {
  if (c.annotations.unevaluatedRepeatOperands.has(expr.value)) return () => [];
  const value = c.value(expr.value);
  const count = c.value(expr.count);
  const constant = c.annotations.paths.get(expr.value)?.kind === 'const';
  return (frame) => {
    const length = Number(count(frame) as bigint);
    frame.runtime.allocate(length);
    frame.runtime.spend(Math.ceil(length / 16));
    if (constant) return Array.from({ length }, () => value(frame));
    const item = value(frame);
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
