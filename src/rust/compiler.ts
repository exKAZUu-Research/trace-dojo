import type { Annotations, Coercion, FnContext, LocalVar, MethodRes, PathRes, ReceiverAdjust } from './annotations';
import type { Block, Condition, Expr, FormatArgs, MacroCall, Pattern, Span, Stmt } from './ast';
import { forEachDirect, patternBindings } from './astWalk';
import type { Checker } from './checker';
import { escapeDebug, type Formatter, type Spec } from './fmt';
import { normalize } from './infer';
import type { Program } from './items';
import {
  castValue,
  cloneValue,
  compareValues,
  copyValue,
  floatArith,
  hashKey,
  intArith,
  needsCopy,
  valuesEqual,
} from './ops';
import { ControlSignal, type Frame, type FunctionInfo, RustPanic, UNASSIGNED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { type AdtDef, type FnDef, type IntName, isUnit, resolve, shallow, type Type } from './types';
import {
  AccessorPlace,
  CellPlace,
  DONE,
  DynValue,
  ElementPlace,
  EnumValue,
  FnValue,
  type FormatterValue,
  isPlace,
  type IterValue,
  type MapValue,
  type Place,
  RangeValue,
  sliceBase,
  sliceGet,
  sliceLength,
  SliceView,
  StructValue,
  UNIT_VALUE,
  type Value,
} from './values';

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
  makeClosure(compiled: CompiledFn, frame: Frame, captures: Place[], name: string): Value;
  toIter(value: Value, from: Type): Value;
  rangeIter(range: RangeValue, elem: Type): Value;
  constValue(def: unknown, frame: Frame): Value;
  builtinConst(name: string): Value;
  formatter: Formatter;
  turtleNew(args: Value[], span: Span, frame: Frame): Value;
  convertError(value: Value, from: Type, to: Type, frame: Frame): Value;
  strSlice(text: string, start: number | undefined, end: number | undefined, span: Span): string;
}

class LocalPlace implements Place {
  readonly isPlace = true;
  constructor(
    private readonly frame: Frame,
    private readonly slot: number
  ) {}

  get(): Value {
    const value = this.frame.locals[this.slot];
    return value === UNASSIGNED ? undefined : value;
  }

  set(value: Value): void {
    this.frame.locals[this.slot] = value;
  }
}

/** Compiles the checked bodies of a program into closures over frames. */
export class Compiler {
  private readonly annotations: Annotations;
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
      const binders = params.map(({ local, pattern }) => {
        if (local) return (frame: Frame, value: Value) => void (frame.locals[local.slot] = value);
        return this.compileBinder(pattern!);
      });
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

  private stepRow(span: Span): number | undefined {
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
        for (const slot of declared) frame.locals[slot] = UNASSIGNED;
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
    // Destructuring a variable moves only some of its elements, so the variable keeps its value.
    const destructures = stmt.pattern.kind === 'tuple' && stmt.init.kind === 'path';
    const init = destructures ? this.read(stmt.init) : this.value(stmt.init);
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
    const run: Eval = (frame) => {
      frame.runtime.spend();
      bind(frame, init(frame));
      return UNIT_VALUE;
    };
    return this.withStep(stmt.span, run, isObjectCreation(stmt.init, this.annotations));
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

  /**
   * Matches a value against a pattern, binding its variables when it matches. `place` gives where the value lives, for
   * bindings that bind by mutable reference.
   */
  compileMatcher(pattern: Pattern): (frame: Frame, value: Value, place: (() => Place) | undefined) => boolean {
    const type = resolve(pattern.ty ?? { kind: 'tuple', elems: [] }, true);
    switch (pattern.kind) {
      case 'wild': {
        return () => true;
      }
      case 'binding': {
        const res = this.annotations.paths.get(pattern);
        if (res) return this.constMatcher(res, type);
        const local = this.annotations.bindings.get(pattern);
        if (!local) return () => true;
        const sub = pattern.sub ? this.compileMatcher(pattern.sub) : undefined;
        const copies = local.mode === 'move' && needsCopy(resolve(local.type, true)) && this.isCopy(local.type);
        const localType = normalize(shallow(local.type));
        // Match ergonomics on a `&mut` value gives the parts of the value with `&mut` types, which are their places.
        const bindsPlace = local.mode === 'refMut' || (localType.kind === 'ref' && localType.mutable);
        return (frame, value, place) => {
          if (sub && !sub(frame, value, place)) return false;
          let bound = value;
          if (bindsPlace && !(local.mode === 'move' && isPlace(value))) {
            bound = place ? place() : new CellPlace(value);
          } else if (local.mode === 'ref' && isPlace(value)) bound = value.get();
          else if (copies) bound = copyValue(value);
          frame.locals[local.slot] = bound;
          return true;
        };
      }
      case 'lit': {
        const literal = this.value(pattern.expr);
        const litType = runtimeType(pattern.expr.ty ?? type);
        return (frame, value) => valuesEqual(litType(frame), derefDeep(value), literal(frame));
      }
      case 'tuple': {
        const elems = pattern.elems.map((elem) => this.compileMatcher(elem));
        return (frame, value, place) => {
          const tuple = derefDeep(value) as Value[];
          const tuplePlace = place;
          return elems.every((elem, index) =>
            elem(
              frame,
              tuple[index],
              tuplePlace || isPlace(value) ? () => new ElementPlace(derefDeep(value) as Value[], index) : undefined
            )
          );
        };
      }
      case 'tupleStruct':
      case 'struct':
      case 'path': {
        const res = this.annotations.paths.get(pattern);
        if (!res) return () => true;
        if (res.kind !== 'ctor') return this.constMatcher(res, type);
        const variant = res.variant;
        const isEnum = res.def.kind === 'enum';
        const subs: [number, ReturnType<Compiler['compileMatcher']>][] = [];
        if (pattern.kind === 'tupleStruct') {
          for (const [index, elem] of pattern.elems.entries()) subs.push([index, this.compileMatcher(elem)]);
        } else if (pattern.kind === 'struct') {
          const fields = res.def.variants[variant].fields;
          for (const field of pattern.fields) {
            subs.push([fields.findIndex((f) => f.name === field.name), this.compileMatcher(field.pattern)]);
          }
        }
        return (frame, value, place) => {
          const target = derefDeep(value);
          if (isEnum && (target as EnumValue).variant !== variant) return false;
          const fields = (target as StructValue | EnumValue).fields;
          for (const [index, sub] of subs) {
            const fieldPlace = place || isPlace(value) ? () => new ElementPlace(fields, index) : undefined;
            if (!sub(frame, fields[index], fieldPlace)) return false;
          }
          return true;
        };
      }
      case 'ref': {
        const inner = this.compileMatcher(pattern.pattern);
        return (frame, value) =>
          inner(frame, isPlace(value) ? value.get() : value, isPlace(value) ? () => value : undefined);
      }
      case 'or': {
        const alternatives = pattern.alternatives.map((alt) => this.compileMatcher(alt));
        return (frame, value, place) => alternatives.some((alt) => alt(frame, value, place));
      }
    }
  }

  /** The slots of the variables a pattern binds, which go out of scope with the pattern. */
  private patternSlots(pattern: Pattern): number[] {
    return patternBindings(pattern, this.annotations).map((local) => local.slot);
  }

  private constMatcher(res: PathRes, type: Type): (frame: Frame, value: Value) => boolean {
    if (res.kind === 'ctor') {
      const variant = res.variant;
      if (res.def.kind === 'struct') return () => true;
      return (_frame, value) => (derefDeep(value) as EnumValue).variant === variant;
    }
    if (res.kind === 'const') {
      return (frame, value) => valuesEqual(type, derefDeep(value), this.support.constValue(res.def, frame));
    }
    return () => true;
  }

  private isCopy(type: Type): boolean {
    return this.checker.solver.isCopy(resolve(type, true));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /** An expression's value where it is moved or copied: a `Copy` aggregate read from a place is copied. */
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
        return (frame) => {
          const value = coerced(frame);
          frame.locals[slot] = UNASSIGNED;
          return value;
        };
      }
    }
    return coerced;
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
    switch (expr.kind) {
      case 'int': {
        const value = expr.value;
        const type = resolve(expr.ty!, true);
        if (type.kind === 'float') {
          const number = Number(value);
          return () => number;
        }
        return () => value;
      }
      case 'float': {
        const type = resolve(expr.ty!, true);
        const value = type.kind === 'float' && type.name === 'f32' ? Math.fround(expr.value) : expr.value;
        return () => value;
      }
      case 'bool':
      case 'char':
      case 'str': {
        const value = expr.value;
        return () => value;
      }
      case 'path': {
        return this.path(expr);
      }
      case 'unary': {
        return this.unary(expr);
      }
      case 'binary': {
        return this.binary(expr);
      }
      case 'assign': {
        return this.assign(expr);
      }
      case 'compoundAssign': {
        return this.compoundAssign(expr);
      }
      case 'ref': {
        if (expr.mutable) {
          const place = this.place(expr.operand);
          return (frame) => place(frame);
        }
        return this.read(expr.operand);
      }
      case 'cast': {
        const operand = this.value(expr.operand);
        const from = resolve(expr.operand.ty!, true);
        const to = resolve(expr.ty!, true);
        return (frame) => castValue(operand(frame), from, to);
      }
      case 'call': {
        return this.call(expr);
      }
      case 'methodCall': {
        return this.methodCall(expr);
      }
      case 'field': {
        return this.field(expr);
      }
      case 'index': {
        return this.index(expr);
      }
      case 'range': {
        const start = expr.start ? this.value(expr.start) : undefined;
        const end = expr.end ? this.value(expr.end) : undefined;
        const inclusive = expr.inclusive;
        return (frame) => new RangeValue(start?.(frame), end?.(frame), inclusive);
      }
      case 'tuple': {
        if (expr.elems.length === 0) return () => UNIT_VALUE;
        const elems = expr.elems.map((elem) => this.value(elem));
        return (frame) => elems.map((elem) => elem(frame));
      }
      case 'array': {
        const elems = expr.elems.map((elem) => this.value(elem));
        return (frame) => {
          frame.runtime.allocate(elems.length);
          return elems.map((elem) => elem(frame));
        };
      }
      case 'arrayRepeat': {
        const value = this.value(expr.value);
        const count = this.value(expr.count);
        return (frame) => {
          const length = Number(count(frame) as bigint);
          frame.runtime.allocate(length);
          frame.runtime.spend(Math.ceil(length / 16));
          const item = value(frame);
          return Array.from({ length }, () => copyValue(item));
        };
      }
      case 'struct': {
        return this.struct(expr);
      }
      case 'block': {
        return this.compileBlock(expr);
      }
      case 'if': {
        return this.ifExpr(expr);
      }
      case 'match': {
        return this.matchExpr(expr);
      }
      case 'loop': {
        return this.loop(expr);
      }
      case 'while': {
        return this.whileExpr(expr);
      }
      case 'for': {
        return this.forExpr(expr);
      }
      case 'break':
      case 'continue': {
        const value = expr.kind === 'break' && expr.value ? this.value(expr.value) : undefined;
        const kind = expr.kind;
        const label = expr.label;
        return (frame) => {
          throw new ControlSignal(kind, label, value?.(frame));
        };
      }
      case 'return': {
        const value = expr.value ? this.value(expr.value) : undefined;
        return (frame) => {
          throw new ControlSignal('return', undefined, value ? value(frame) : UNIT_VALUE);
        };
      }
      case 'closure': {
        return this.closure(expr);
      }
      case 'try': {
        return this.tryExpr(expr);
      }
      case 'macro': {
        return this.macro(expr, expr.macro);
      }
    }
  }

  // code-gauge-allow functionNcss 39 -- One case per kind of expression, statement, or pattern.
  private path(expr: Extract<Expr, { kind: 'path' }>): Eval {
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

  /** The place a place expression denotes, which assignments and `&mut` borrows write through. */
  place(expr: Expr): PlaceEval {
    switch (expr.kind) {
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind === 'local') {
          const slot = res.local.slot;
          if (res.local.mode === 'refMut') return (frame) => frame.locals[slot] as Place;
          return (frame) => new LocalPlace(frame, slot);
        }
        if (res?.kind === 'capture') {
          const index = res.index;
          const local = res.local;
          if (local.mode === 'refMut') return (frame) => frame.captures[index].get() as Place;
          return (frame) => frame.captures[index];
        }
        break;
      }
      case 'field': {
        const field = this.annotations.fields.get(expr);
        if (!field) break;
        const base = this.placeThrough(expr.operand, field.derefs);
        const { index } = field;
        if (field.range) {
          return (frame) => {
            const range = base(frame).get() as RangeValue;
            return new AccessorPlace(
              () => (index === 0 ? range.start : range.end),
              (value) => {
                if (index === 0) range.start = value;
                else range.end = value;
              }
            );
          };
        }
        return (frame) => {
          const owner = base(frame).get();
          const fields = Array.isArray(owner) ? owner : (owner as StructValue).fields;
          return new ElementPlace(fields, index);
        };
      }
      case 'index': {
        return this.indexPlace(expr);
      }
      case 'unary': {
        if (expr.op === '*') {
          const operandType = normalize(shallow(expr.operand.ty!));
          if (operandType.kind === 'ref' && operandType.mutable) {
            const operand = this.read(expr.operand);
            return (frame) => operand(frame) as Place;
          }
          if (operandType.kind === 'ref') {
            const operand = this.read(expr.operand);
            return (frame) => new CellPlace(operand(frame));
          }
          // A Box is its value.
          return this.place(expr.operand);
        }
        break;
      }
      default: {
        break;
      }
    }
    // A temporary: the place holds the expression's value.
    const value = this.value(expr);
    return (frame) => new CellPlace(value(frame));
  }

  /** The place an operand reaches through derefs: through `&mut` references and owners (`Box`, `Vec`, `String`). */
  private placeThrough(operand: Expr, derefs: ('ref' | 'mutRef' | 'own')[]): PlaceEval {
    if (derefs.some((step) => step === 'ref')) {
      // Through a shared reference only reads happen, so a place over the value serves.
      const read = this.valueThrough(operand, derefs);
      return (frame) => new CellPlace(read(frame));
    }
    const base = this.place(operand);
    if (!derefs.includes('mutRef')) return base;
    return (frame) => {
      let place = base(frame);
      for (const step of derefs) if (step === 'mutRef') place = place.get() as Place;
      return place;
    };
  }

  /** An operand's value after derefs, reading through `&mut` references. */
  private valueThrough(operand: Expr, derefs: ('ref' | 'mutRef' | 'own')[]): Eval {
    const read = this.read(operand);
    if (!derefs.includes('mutRef')) return read;
    return (frame) => {
      let value = read(frame);
      for (const step of derefs) if (step === 'mutRef') value = (value as Place).get();
      return value;
    };
  }

  private field(expr: Extract<Expr, { kind: 'field' }>): Eval {
    const field = this.annotations.fields.get(expr);
    if (!field) throw new Error('Unresolved field');
    const base = this.valueThrough(expr.operand, field.derefs);
    const { index } = field;
    if (field.range) {
      return (frame) => {
        const range = base(frame) as RangeValue;
        return index === 0 ? range.start : range.end;
      };
    }
    return (frame) => {
      const owner = base(frame);
      if (Array.isArray(owner)) return owner[index];
      return (owner as StructValue).fields[index];
    };
  }

  // code-gauge-allow functionNcss 33 -- One case per kind of expression, statement, or pattern.
  private index(expr: Extract<Expr, { kind: 'index' }>): Eval {
    const res = this.annotations.indexes.get(expr);
    if (!res) throw new Error('Unresolved index');
    const base = this.valueThrough(expr.operand, res.derefs);
    const index = this.value(expr.index);
    const span = res.overloaded ? expr.bracketSpan : expr.span;
    if (res.container === 'map') {
      const keyType = runtimeType(expr.index.ty!);
      return (frame) => {
        const map = base(frame) as MapValue;
        const key = index(frame);
        const entry = map.entries.get(hashKey(keyType(frame), key));
        if (!entry) throw new RustPanic('key not found', span);
        return entry[1];
      };
    }
    if (res.range) {
      if (res.container === 'str') {
        return (frame) => {
          const range = index(frame) as RangeValue | undefined;
          const text = base(frame) as string;
          return this.support.strSlice(text, rangeStart(range), rangeEnd(range), span);
        };
      }
      return (frame) => {
        const range = index(frame) as RangeValue | undefined;
        const container = base(frame);
        return sliceRange(container, range, span);
      };
    }
    return (frame) => {
      const container = base(frame);
      const position = Number(index(frame) as bigint);
      const length = sliceLength(container);
      if (position >= length) {
        throw new RustPanic(`index out of bounds: the len is ${length} but the index is ${position}`, span);
      }
      return sliceGet(container, position);
    };
  }

  private indexPlace(expr: Extract<Expr, { kind: 'index' }>): PlaceEval {
    const res = this.annotations.indexes.get(expr);
    if (!res) throw new Error('Unresolved index');
    const base = this.placeThrough(expr.operand, res.derefs);
    const index = this.value(expr.index);
    const span = res.overloaded ? expr.bracketSpan : expr.span;
    if (res.range) {
      const read = this.index(expr);
      return (frame) => new CellPlace(read(frame));
    }
    return (frame) => {
      const container = base(frame).get();
      const position = Number(index(frame) as bigint);
      const length = sliceLength(container);
      if (position >= length) {
        throw new RustPanic(`index out of bounds: the len is ${length} but the index is ${position}`, span);
      }
      const { base: array, start } = sliceBase(container);
      return new ElementPlace(array, start + position);
    };
  }

  private struct(expr: Extract<Expr, { kind: 'struct' }>): Eval {
    const res = this.annotations.paths.get(expr);
    if (res?.kind !== 'ctor') throw new Error('Unresolved struct');
    const { def, variant } = res;
    const fields = def.variants[variant].fields;
    const values = expr.fields.map((field) => ({
      index: fields.findIndex((f) => f.name === field.name),
      value: this.value(field.value),
    }));
    // The base gives up only the fields it moves, which the borrow checker keeps from being used again.
    const base = expr.base ? this.read(expr.base) : undefined;
    return (frame) => {
      const result: Value[] = Array.from({ length: fields.length });
      for (const { index, value } of values) result[index] = value(frame);
      if (base) {
        const source = base(frame) as StructValue;
        const given = new Set(values.map((v) => v.index));
        for (let index = 0; index < fields.length; index++) {
          if (!given.has(index)) result[index] = copyValue(source.fields[index]);
        }
      }
      frame.runtime.allocate(fields.length);
      return def.kind === 'enum' ? new EnumValue(def, variant, result) : new StructValue(def, result);
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Operators

  private unary(expr: Extract<Expr, { kind: 'unary' }>): Eval {
    const operand = expr.op === '*' ? this.read(expr.operand) : this.value(expr.operand);
    if (expr.op === '*') {
      const operandType = normalize(shallow(expr.operand.ty!));
      if (operandType.kind === 'ref' && operandType.mutable) return (frame) => (operand(frame) as Place).get();
      return operand;
    }
    const type = numericType(expr.ty!);
    const span = expr.span;
    if (expr.op === '!') {
      if (type.kind === 'bool') return (frame) => !derefAll(operand(frame));
      const name = (type as { name: IntName }).name;
      return (frame) => {
        const value = derefAll(operand(frame)) as bigint;
        return name.startsWith('u') ? BigInt.asUintN(intBitsOf(name), ~value) : ~value;
      };
    }
    if (type.kind === 'float') return (frame) => -(derefAll(operand(frame)) as number);
    const name = (type as { name: IntName }).name;
    return (frame) => intArith('-', name, 0n, derefAll(operand(frame)) as bigint, span);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of expression, statement, or pattern.
  // code-gauge-allow functionNcss 37 -- One case per kind of expression, statement, or pattern.
  private binary(expr: Extract<Expr, { kind: 'binary' }>): Eval {
    const { op } = expr;
    if (op === '&&' || op === '||') {
      const left = this.value(expr.left);
      const right = this.value(expr.right);
      return op === '&&'
        ? (frame) => (left(frame) as boolean) && (right(frame) as boolean)
        : (frame) => (left(frame) as boolean) || (right(frame) as boolean);
    }
    const left = this.read(expr.left);
    const right = this.read(expr.right);
    const leftCoerced = this.annotations.coercions.get(expr.left) ? this.value(expr.left) : left;
    const rightCoerced = this.annotations.coercions.get(expr.right) ? this.value(expr.right) : right;
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      const staticType = resolve(expr.left.ty!, true);
      const compareType = runtimeType(stringish(staticType) ?? staticType);
      if (op === '==' || op === '!=') {
        const equal = op === '==';
        return (frame) => valuesEqual(compareType(frame), leftCoerced(frame), rightCoerced(frame)) === equal;
      }
      const tests: Record<string, (order: number) => boolean> = {
        '<': (o) => o < 0,
        '<=': (o) => o <= 0,
        '>': (o) => o > 0,
        '>=': (o) => o >= 0,
      };
      const test = tests[op];
      return (frame) => {
        const order = compareValues(compareType(frame), leftCoerced(frame), rightCoerced(frame));
        return order !== undefined && test(order);
      };
    }
    const type = numericType(expr.ty!);
    const span = expr.span;
    if (type.kind === 'adt') {
      // String + &str
      return (frame) => (left(frame) as string) + (derefAll(rightCoerced(frame)) as string);
    }
    if (type.kind === 'bool') {
      const fn = {
        '&': (a: boolean, b: boolean) => a && b,
        '|': (a: boolean, b: boolean) => a || b,
        '^': (a: boolean, b: boolean) => a !== b,
      }[op as '&'];
      return (frame) => fn(derefAll(left(frame)) as boolean, derefAll(right(frame)) as boolean);
    }
    if (type.kind === 'float') {
      const f32 = type.name === 'f32';
      return (frame) => floatArith(op, derefAll(left(frame)) as number, derefAll(right(frame)) as number, f32);
    }
    const name = (type as { name: IntName }).name;
    if (op === '<<' || op === '>>') {
      return (frame) => intArith(op, name, derefAll(left(frame)) as bigint, derefAll(right(frame)) as bigint, span);
    }
    return (frame) => {
      frame.runtime.spend();
      return intArith(op, name, derefAll(left(frame)) as bigint, derefAll(right(frame)) as bigint, span);
    };
  }

  private assign(expr: Extract<Expr, { kind: 'assign' }>): Eval {
    const value = this.value(expr.value);
    const res = expr.target.kind === 'path' ? this.annotations.paths.get(expr.target) : undefined;
    if (res?.kind === 'discard') return (frame) => (value(frame), UNIT_VALUE);
    if (res?.kind === 'local' && res.local.mode === 'move') {
      const slot = res.local.slot;
      return (frame) => {
        frame.locals[slot] = value(frame);
        return UNIT_VALUE;
      };
    }
    const place = this.place(expr.target);
    return (frame) => {
      const v = value(frame);
      place(frame).set(v);
      return UNIT_VALUE;
    };
  }

  // code-gauge-allow functionNcss 32 -- One case per kind of expression, statement, or pattern.
  private compoundAssign(expr: Extract<Expr, { kind: 'compoundAssign' }>): Eval {
    const place = this.place(expr.target);
    const value = this.value(expr.value);
    const type = numericType(expr.target.ty!);
    const span = expr.span;
    const { op } = expr;
    if (type.kind === 'adt') {
      return (frame) => {
        const target = place(frame);
        const addition = derefAll(value(frame)) as string;
        target.set((target.get() as string) + addition);
        return UNIT_VALUE;
      };
    }
    // On primitive types, `a[i()] += f()` evaluates its right side first; `String`'s `+=` is a call, left side first.
    if (type.kind === 'bool') {
      return (frame) => {
        const b = derefAll(value(frame)) as boolean;
        const target = place(frame);
        const a = target.get() as boolean;
        target.set(op === '&' ? a && b : op === '|' ? a || b : a !== b);
        return UNIT_VALUE;
      };
    }
    if (type.kind === 'float') {
      const f32 = type.name === 'f32';
      return (frame) => {
        const operand = derefAll(value(frame)) as number;
        const target = place(frame);
        target.set(floatArith(op, target.get() as number, operand, f32));
        return UNIT_VALUE;
      };
    }
    const name = (type as { name: IntName }).name;
    return (frame) => {
      const operand = derefAll(value(frame)) as bigint;
      const target = place(frame);
      target.set(intArith(op, name, target.get() as bigint, operand, span));
      return UNIT_VALUE;
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Calls

  private call(expr: Extract<Expr, { kind: 'call' }>): Eval {
    const { callee } = expr;
    const args = expr.args.map((arg) => this.value(arg));
    const span = expr.span;
    const callRow = expr.span.row;
    const res = callee.kind === 'path' ? this.annotations.paths.get(callee) : undefined;
    if (res?.kind === 'fn') {
      const { fn } = res;
      if ((fn as { nativeKey?: string }).nativeKey === 'Turtle::new') {
        return (frame) =>
          this.support.turtleNew(
            args.map((arg) => arg(frame)),
            span,
            frame
          );
      }
      const typeArgs = res.typeArgs.map((arg) => runtimeType(arg));
      return (frame) => {
        const values = args.map((arg) => arg(frame));
        return this.support.callFn(
          fn,
          typeArgs.map((arg) => arg(frame)),
          values,
          callRow,
          span,
          frame
        );
      };
    }
    if (res?.kind === 'ctor') {
      const { def, variant } = res;
      return (frame) => {
        frame.runtime.allocate(args.length);
        return construct(
          def,
          variant,
          args.map((arg) => arg(frame))
        );
      };
    }
    const calleeValue = this.read(callee);
    return (frame) => {
      const fn = derefAll(calleeValue(frame));
      const values = args.map((arg) => arg(frame));
      return this.support.callValue(fn instanceof DynValue ? fn.value : fn, values, callRow);
    };
  }

  private methodCall(expr: Extract<Expr, { kind: 'methodCall' }>): Eval {
    const method = this.annotations.methods.get(expr);
    if (!method) throw new Error(`Unresolved method ${expr.method}`);
    const receiver = this.receiver(expr, method);
    const args = expr.args.map((arg) => this.value(arg));
    const typeArgs = method.typeArgs.map((arg) => runtimeType(arg));
    const { fn } = method;
    const span = expr.methodSpan;
    const callRow = expr.span.row;
    return (frame) => {
      const self = receiver(frame);
      const values = [self];
      for (const arg of args) values.push(arg(frame));
      return this.support.callFn(
        fn,
        typeArgs.map((arg) => arg(frame)),
        values,
        callRow,
        span,
        frame
      );
    };
  }

  /** The receiver a method takes, after the derefs and the reference its call adds. */
  private receiver(expr: Extract<Expr, { kind: 'methodCall' }>, method: MethodRes): Eval {
    const adjust: ReceiverAdjust = method.receiver;
    const elem = adjust.rangeToIter ? rangeElem(expr.receiver.ty!) : undefined;
    if (adjust.autoref === 'mut') {
      const place = this.placeThrough(expr.receiver, adjust.derefs);
      if (elem) {
        const elemType = runtimeType(elem);
        return (frame) => new CellPlace(this.support.rangeIter(place(frame).get() as RangeValue, elemType(frame)));
      }
      return place;
    }
    const byValue = adjust.autoref === 'none' && method.fn.selfMode === 'value' && adjust.derefs.length === 0;
    const read = byValue ? this.value(expr.receiver) : this.valueThrough(expr.receiver, adjust.derefs);
    if (elem) {
      const elemType = runtimeType(elem);
      return (frame) => this.support.rangeIter(read(frame) as RangeValue, elemType(frame));
    }
    const selfType = resolve(expr.receiver.ty!, true);
    if (
      method.fn.selfMode === 'value' &&
      adjust.autoref === 'none' &&
      adjust.derefs.length > 0 &&
      needsCopy(selfType)
    ) {
      return (frame) => copyValue(read(frame));
    }
    return read;
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of expression, statement, or pattern.
  // code-gauge-allow functionNcss 33 -- One case per kind of expression, statement, or pattern.
  private closure(expr: Extract<Expr, { kind: 'closure' }>): Eval {
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
      return { res, local };
    });
    const isMove = context.isMove;
    const name = '{closure}';
    return (frame) => {
      const places = captures.map(({ res, local }) => {
        let place: Place;
        if (res.kind === 'local') {
          place =
            local.mode === 'refMut' && !isMove
              ? new CellPlace(frame.locals[local.slot] as Value)
              : new LocalPlace(frame, local.slot);
        } else {
          place = frame.captures[res.index];
        }
        if (isMove) {
          const value = place.get();
          return new CellPlace(needsCopy(resolve(local.type, true)) ? copyValue(value) : value);
        }
        return place;
      });
      return this.support.makeClosure(compiled, frame, places, name);
    };
  }

  private tryExpr(expr: Extract<Expr, { kind: 'try' }>): Eval {
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

  // -------------------------------------------------------------------------------------------------------------------
  // Control flow

  private conditionEval(cond: Condition): Eval {
    if (cond.kind === 'expr') return this.value(cond.expr);
    const value = this.read(cond.value);
    const matcher = this.compileMatcher(cond.pattern);
    const placeEval = isPlaceExpr(cond.value, this.annotations) ? this.place(cond.value) : undefined;
    return (frame) => {
      const v = value(frame);
      return matcher(frame, v, placeEval ? () => placeEval(frame) : undefined);
    };
  }

  private ifExpr(expr: Extract<Expr, { kind: 'if' }>): Eval {
    const cond = this.conditionEval(expr.cond);
    const condLocals = expr.cond.kind === 'let' ? this.patternSlots(expr.cond.pattern) : [];
    const then = this.compileBlock(expr.consequent);
    const otherwise = expr.else ? this.value(expr.else) : undefined;
    return (frame) => {
      frame.runtime.spend();
      if (cond(frame)) {
        try {
          return then(frame);
        } finally {
          for (const slot of condLocals) frame.locals[slot] = UNASSIGNED;
        }
      }
      return otherwise ? otherwise(frame) : UNIT_VALUE;
    };
  }

  private matchExpr(expr: Extract<Expr, { kind: 'match' }>): Eval {
    const scrutinee = this.read(expr.scrutinee);
    const placeEval = isPlaceExpr(expr.scrutinee, this.annotations) ? this.place(expr.scrutinee) : undefined;
    const arms = expr.arms.map((arm) => {
      const matcher = this.compileMatcher(arm.pattern);
      const body = this.value(arm.body);
      const slots = this.patternSlots(arm.pattern);
      return { matcher, body, slots };
    });
    return (frame) => {
      frame.runtime.spend();
      const value = scrutinee(frame);
      frame.temporaries.push(value);
      try {
        for (const { matcher, body, slots } of arms) {
          if (matcher(frame, value, placeEval ? () => placeEval(frame) : undefined)) {
            frame.temporaries.pop();
            try {
              return body(frame);
            } finally {
              for (const slot of slots) frame.locals[slot] = UNASSIGNED;
              frame.temporaries.push(undefined);
            }
          }
        }
      } finally {
        frame.temporaries.pop();
      }
      throw new Error('No arm matched');
    };
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of expression, statement, or pattern.
  private loop(expr: Extract<Expr, { kind: 'loop' }>): Eval {
    const body = this.compileBlock(expr.body);
    const label = expr.label;
    return (frame) => {
      for (;;) {
        frame.runtime.spend();
        try {
          body(frame);
        } catch (error) {
          if (!(error instanceof ControlSignal) || error.kind === 'return') throw error;
          if (error.label !== undefined && error.label !== label) throw error;
          if (error.kind === 'break') return error.value ?? UNIT_VALUE;
        }
      }
    };
  }

  private whileExpr(expr: Extract<Expr, { kind: 'while' }>): Eval {
    const cond = this.conditionEval(expr.cond);
    const condLocals = expr.cond.kind === 'let' ? this.patternSlots(expr.cond.pattern) : [];
    const body = this.compileBlock(expr.body);
    const label = expr.label;
    const isLet = expr.cond.kind === 'let';
    const row = isLet ? this.stepRow(expr.span) : undefined;
    const answered = isLet && this.bindsAnswer(expr.cond.kind === 'let' ? expr.cond.pattern : undefined);
    return (frame) => {
      try {
        for (;;) {
          frame.runtime.spend();
          if (!cond(frame)) return UNIT_VALUE;
          if (row !== undefined) frame.runtime.steps.stepBinding(row, answered);
          try {
            body(frame);
          } catch (error) {
            if (!(error instanceof ControlSignal) || error.kind === 'return') throw error;
            if (error.label !== undefined && error.label !== label) throw error;
            if (error.kind === 'break') return UNIT_VALUE;
          }
        }
      } finally {
        for (const slot of condLocals) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- One case per kind of expression, statement, or pattern.
  // code-gauge-allow functionNcss 36 -- One case per kind of expression, statement, or pattern.
  private forExpr(expr: Extract<Expr, { kind: 'for' }>): Eval {
    const loopInfo = this.annotations.loops.get(expr);
    if (!loopInfo) throw new Error('Unchecked for');
    const iterable = this.value(expr.iterable);
    const fromType = runtimeType(loopInfo.from);
    const bind = this.compileBinder(expr.pattern);
    const patternSlots = this.patternSlots(expr.pattern);
    const body = this.compileBlock(expr.body);
    const label = expr.label;
    const row = this.stepRow(expr.span);
    const answered = this.bindsAnswer(expr.pattern);
    return (frame) => {
      const source = iterable(frame);
      const iterator = this.support.toIter(source, fromType(frame)) as IterValue;
      frame.temporaries.push(source, iterator);
      try {
        for (;;) {
          frame.runtime.spend();
          const next = iterator.next();
          if (next === DONE) return UNIT_VALUE;
          bind(frame, next as Value);
          if (row !== undefined) frame.runtime.steps.stepBinding(row, answered);
          try {
            body(frame);
          } catch (error) {
            if (!(error instanceof ControlSignal) || error.kind === 'return') throw error;
            if (error.label !== undefined && error.label !== label) throw error;
            if (error.kind === 'break') return UNIT_VALUE;
          }
        }
      } finally {
        frame.temporaries.splice(-2, 2);
        for (const slot of patternSlots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  /** Whether a loop's pattern binds a value learners write down: a number, a `bool`, a `char`, or a string. */
  private bindsAnswer(pattern: Pattern | undefined): boolean {
    if (!pattern) return false;
    if (pattern.kind === 'tuple' || pattern.kind === 'tupleStruct' || pattern.kind === 'struct') return true;
    const type = normalize(shallow(resolve(pattern.ty ?? { kind: 'tuple', elems: [] }, true)));
    return isAnswerType(type);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Macros

  private macro(expr: Expr, macro: MacroCall): Eval {
    const span = expr.span;
    switch (macro.kind) {
      case 'print': {
        const format = macro.format ? this.format(macro.format) : () => '';
        const newline = macro.newline ? '\n' : '';
        const stream = macro.stream;
        return (frame) => {
          const text = format(frame) + newline;
          frame.runtime.write(stream, text);
          return UNIT_VALUE;
        };
      }
      case 'format': {
        return this.format(macro.format);
      }
      case 'write': {
        const target = this.read(macro.target);
        const format = macro.format ? this.format(macro.format) : () => '';
        const newline = macro.newline ? '\n' : '';
        const targetType = normalize(shallow(macro.target.ty!));
        const inner = targetType.kind === 'ref' ? normalize(shallow(targetType.target)) : targetType;
        const isString = inner.kind === 'adt' && inner.def.builtin === 'String';
        const okValue = (): Value => new EnumValue(this.program.adtDef('Result'), 0, [UNIT_VALUE]);
        if (isString) {
          const place = this.place(macro.target.kind === 'ref' ? macro.target.operand : macro.target);
          const throughRef = targetType.kind === 'ref' && macro.target.kind !== 'ref';
          return (frame) => {
            const text = format(frame) + newline;
            const p = throughRef ? (target(frame) as Place) : place(frame);
            p.set((p.get() as string) + text);
            return okValue();
          };
        }
        return (frame) => {
          const text = format(frame) + newline;
          let formatter = target(frame);
          while (isPlace(formatter)) formatter = formatter.get();
          (formatter as FormatterValue).text += text;
          return okValue();
        };
      }
      case 'panic': {
        const format = macro.format ? this.format(macro.format) : undefined;
        const name = macro.name;
        return (frame) => {
          const text = format?.(frame);
          const message =
            name === 'panic'
              ? (text ?? 'explicit panic')
              : name === 'unreachable'
                ? text === undefined
                  ? 'internal error: entered unreachable code'
                  : `internal error: entered unreachable code: ${text}`
                : name === 'todo'
                  ? text === undefined
                    ? 'not yet implemented'
                    : `not yet implemented: ${text}`
                  : text === undefined
                    ? 'not implemented'
                    : `not implemented: ${text}`;
          throw new RustPanic(message, span);
        };
      }
      case 'assert': {
        const cond = this.value(macro.cond);
        const format = macro.format ? this.format(macro.format) : undefined;
        const source = assertSource(macro.cond);
        return (frame) => {
          if (!(cond(frame) as boolean)) {
            throw new RustPanic(format ? format(frame) : `assertion failed: ${source}`, span);
          }
          return UNIT_VALUE;
        };
      }
      case 'assertEq': {
        const left = this.read(macro.left);
        const right = this.read(macro.right);
        const leftStatic = resolve(macro.left.ty!, true);
        const leftType = runtimeType(leftStatic);
        const rightType = runtimeType(macro.right.ty!);
        const eqType = runtimeType(stringish(leftStatic) ?? leftStatic);
        const format = macro.format ? this.format(macro.format) : undefined;
        const { equal } = macro;
        return (frame) => {
          const a = left(frame);
          const b = right(frame);
          if (valuesEqual(eqType(frame), a, b) !== equal) {
            const spec: Spec = {
              fill: ' ',
              align: undefined,
              sign: undefined,
              alternate: false,
              zero: false,
              width: undefined,
              precision: undefined,
            };
            const l = this.support.formatter.debug(a, leftType(frame), spec, undefined);
            const r = this.support.formatter.debug(b, rightType(frame), spec, undefined);
            const message = format ? `: ${format(frame)}` : '';
            throw new RustPanic(
              `assertion \`left ${equal ? '==' : '!='} right\` failed${message}\n  left: ${l}\n right: ${r}`,
              span
            );
          }
          return UNIT_VALUE;
        };
      }
      case 'vec': {
        const elems = macro.elems.map((elem) => this.value(elem));
        return (frame) => {
          frame.runtime.allocate(elems.length);
          return elems.map((elem) => elem(frame));
        };
      }
      case 'vecRepeat': {
        const value = this.value(macro.value);
        const count = this.value(macro.count);
        const elemType = runtimeType(macro.value.ty!);
        return (frame) => {
          const item = value(frame);
          const length = Number(count(frame) as bigint);
          frame.runtime.allocate(length);
          frame.runtime.spend(Math.ceil(length / 16));
          const type = elemType(frame);
          return Array.from({ length }, (_, index) => (index === length - 1 ? item : cloneValue(type, item)));
        };
      }
      case 'matches': {
        const value = this.read(macro.value);
        const matcher = this.compileMatcher(macro.pattern);
        return (frame) => matcher(frame, value(frame), undefined);
      }
      case 'dbg': {
        const args = macro.args.map((arg) => ({
          value: this.value(arg),
          type: runtimeType(arg.ty!),
          text: sourceText(arg),
        }));
        return (frame) => {
          const values = args.map(({ value, type, text }) => {
            const v = value(frame);
            const spec: Spec = {
              fill: ' ',
              align: undefined,
              sign: undefined,
              alternate: true,
              zero: false,
              width: undefined,
              precision: undefined,
            };
            const shown = this.support.formatter.debug(v, type(frame), spec, 0);
            frame.runtime.write('stderr', `[src/main.rs:${span.row + 1}:${span.col}] ${text} = ${shown}\n`);
            return v;
          });
          if (args.length === 0) {
            frame.runtime.write('stderr', `[src/main.rs:${span.row + 1}:${span.col}]\n`);
            return UNIT_VALUE;
          }
          return values.length === 1 ? values[0] : values;
        };
      }
    }
  }

  private format(format: FormatArgs): (frame: Frame) => string {
    const args = format.args.map((arg) => this.read(arg));
    const types = format.args.map((arg) => runtimeType(arg.ty!));
    const { pieces } = format;
    return (frame) => {
      const values = args.map((arg) => arg(frame));
      frame.runtime.spend();
      return this.support.formatter.format(
        pieces,
        values,
        types.map((type) => type(frame))
      );
    };
  }
}

function construct(def: AdtDef, variant: number, args: Value[]): Value {
  return def.kind === 'enum' ? new EnumValue(def, variant, args) : new StructValue(def, args);
}

function runtimeTypeStatic(type: Type): Type {
  return resolve(type, true);
}

function derefAll(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

function derefDeep(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

function intBitsOf(name: IntName): number {
  return name === 'usize' || name === 'isize' ? 64 : Number(name.slice(1));
}

/** The type an operator works on: numbers through references. */
function numericType(type: Type): Type {
  let t = normalize(shallow(resolve(type, true)));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t;
}

/** For comparisons of string-like types (`String == &str`), the type `str` that compares them alike. */
function stringish(type: Type): Type | undefined {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind === 'str' || (t.kind === 'adt' && t.def.builtin === 'String')) return { kind: 'str' };
  return undefined;
}

function rangeElem(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return (t as { args: Type[] }).args[0];
}

function isRefType(type: Type): boolean {
  return normalize(shallow(type)).kind === 'ref';
}

export function isAnswerType(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'char' || t.kind === 'str') return true;
  if (t.kind === 'ref') return isAnswerType(t.target);
  return t.kind === 'adt' && t.def.builtin === 'String';
}

function rangeStart(range: RangeValue | undefined): number | undefined {
  return range?.start === undefined ? undefined : Number(range.start as bigint);
}

function rangeEnd(range: RangeValue | undefined): number | undefined {
  if (range?.end === undefined) return undefined;
  return Number(range.end as bigint) + (range.inclusive ? 1 : 0);
}

/** `&v[a..b]`: a window on a slice, panicking as Rust does when the range is out of order or bounds. */
export function sliceRange(container: Value, range: RangeValue | undefined, span: Span): Value {
  const length = sliceLength(container);
  const start = rangeStart(range) ?? 0;
  const end = rangeEnd(range) ?? length;
  if (range?.inclusive && range.end !== undefined && Number(range.end as bigint) === Number.MAX_SAFE_INTEGER) {
    throw new RustPanic('attempted to index slice up to maximum usize', span);
  }
  if (start > end) throw new RustPanic(`slice index starts at ${start} but ends at ${end}`, span);
  if (end > length) {
    throw new RustPanic(`range end index ${end} out of range for slice of length ${length}`, span);
  }
  const { base, start: offset } = sliceBase(container);
  return new SliceView(base, offset + start, offset + end);
}

function isPlaceExpr(expr: Expr, annotations: Annotations): boolean {
  if (expr.kind === 'path') {
    const res = annotations.paths.get(expr);
    return res?.kind === 'local' || res?.kind === 'capture';
  }
  if (expr.kind === 'field') return true;
  if (expr.kind === 'index') return !annotations.indexes.get(expr)?.range;
  return expr.kind === 'unary' && expr.op === '*';
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

function assertSource(expr: Expr): string {
  return sourceText(expr);
}

/** The source text of an expression, as `assert!` and `dbg!` quote it. */
let sourceLines: string[] = [];
export function setSourceForMessages(source: string): void {
  sourceLines = source.split('\n');
}

// code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of expression, statement, or pattern.
// code-gauge-allow functionNcss 34 -- One case per kind of expression, statement, or pattern.
function sourceText(expr: Expr): string {
  const start = expr.span;
  let end = start;
  forEachDirect(expr, (child) => {
    if (child.span.row > end.row || (child.span.row === end.row && child.span.col > end.col)) end = child.span;
  });
  const line = sourceLines[start.row] ?? '';
  const chars = [...line];
  // Take the expression's text up to the end of its line, trimming a trailing argument separator.
  let text = chars.slice(start.col - 1).join('');
  let depth = 0;
  let cut = text.length;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) {
      if (depth === 0) {
        cut = index;
        break;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      cut = index;
      break;
    } else if (char === '"') {
      const close = text.indexOf('"', index + 1);
      if (close > 0) index = close;
    }
  }
  text = text.slice(0, cut).trim();
  void end;
  void escapeDebug;
  return text;
}
