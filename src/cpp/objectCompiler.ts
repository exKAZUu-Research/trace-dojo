import { accessAsMemberOf, isBaseAccessible, isMemberAccessible } from './access';
import { CompilerBase } from './compilerBase';
import {
  bestOf,
  compareSequences,
  type ConversionHost,
  type ConversionSequence,
  convertArithmetic,
  implicitConversion,
  Rank,
} from './conversions';
import { CppException, CppRuntimeError, ProgramAbort } from './errors';
import {
  type Expr,
  hasConstantObject,
  type InitializerTarget,
  mapMemberConstants,
  type TemporaryBinding,
} from './expr';
import { SequenceValue } from './library/containerValues';
import { constructElementFromRvalue, moveConstruction } from './library/elements';
import { StringValue } from './library/string';
import { type Eval, type Frame, holdAll, type Temporary } from './runtime';
import type { Syntax } from './syntax';
import {
  type Access,
  allowsConstantCopy,
  allowsMemberAssignment,
  type ClassInfo,
  type ClassType,
  classType,
  type FunctionInfo,
  isArithmetic as isArithmeticType,
  isConstType,
  isCopyConstructor,
  nonReference,
  pointerTo,
  sameParameters,
  sameType,
  sizeOf,
  type Type,
  typeName,
  unqualified,
} from './types';
import {
  ArrayStore,
  Box,
  CObject,
  endLifetime,
  holdValues,
  Liveness,
  NULL_PTR,
  Ptr,
  Store,
  UNINIT,
  type Value,
} from './values';

/**
 * Calls a function with its arguments as its parameters declare them: a `Ptr` for a reference, else a value. A member
 * function gets the location of its object as `self`. The parameters that are objects are destroyed when the call
 * returns, unless `isCallerDestroying`: a call the program writes leaves them to the end of its full-expression, as
 * the Itanium C++ ABI does, having made them temporaries (see `callArguments`).
 */
export function invoke(
  frame: Frame,
  fn: FunctionInfo,
  args: unknown[],
  self: Ptr | undefined,
  row: number,
  isCallerDestroying = false
): Value | Ptr {
  const { runtime } = frame;
  if (fn.owner && self) self = self.forClass(fn.owner);
  if (fn.native) {
    const override = fn.libcGlobal ? runtime.libcOverrides.get(fn.name) : undefined;
    if (override && sameParameters(fn, override)) return invoke(frame, override, args, self, row, isCallerDestroying);
    runtime.spend();
    return fn.native(args, { self: self?.read(), selfLocation: self, frame, row }) as Value | Ptr;
  }
  const compiled = fn.compiled;
  if (!compiled) throw new Error(`${fn.displayName} has no body`);
  const callee = runtime.pushFrame(fn, row, compiled, self);
  try {
    for (const [index, param] of fn.params.entries()) {
      const value = args[index] as Value;
      callee.slots[index] = parameterLocation(param.type, value);
    }
    if (fn.isNoexcept) runtime.withoutOuterHandlers(() => compiled.body(callee));
    else compiled.body(callee);
    if (!isCallerDestroying) destroyParameters(callee, fn, args);
  } catch (error) {
    if (!isCallerDestroying && error instanceof CppException) destroyParameters(callee, fn, args);
    // An uncaught exception ends the program without unwinding, so its final state still holds this call's locals.
    if (!(error instanceof ProgramAbort)) runtime.popFrame();
    throw error;
  }
  runtime.popFrame();
  return callee.returnValue;
}

function parameterLocation(type: Type, value: Value): Ptr | Box {
  if (type.kind === 'reference') return value as Ptr;
  if (type.kind === 'class' && value instanceof CObject) return value.parameterStorage();
  const storage = new Box(value, type.kind !== 'class');
  storage.elementSize = sizeOf(type);
  bindPlacedValue(type, value, storage.location(0));
  return storage;
}

function destroyParameters(frame: Frame, fn: FunctionInfo, args: unknown[]): void {
  for (let index = fn.params.length - 1; index >= 0; index--) {
    const destroy = parameterDestroyer(fn.params[index].type);
    if (destroy) destroy(frame, args[index] as Value);
  }
}

function parameterDestroyer(type: Type): ((frame: Frame, value: Value) => void) | undefined {
  if (type.kind !== 'class') return undefined;
  const destroy = type.cls.operations?.destroy;
  return (frame, value) => {
    destroy?.(frame, value);
    endLifetime(value);
  };
}

/** The key that identifies a virtual function across a hierarchy: its name and its parameters. */
export function virtualKey(fn: FunctionInfo): string {
  return `${fn.name}(${fn.params.map((param) => typeName(unqualified(param.type))).join(',')})${fn.isConst ? 'const' : ''}`;
}

export function withTemporaries<T>(frame: Frame, run: Eval<T>): T {
  const mark = frame.temporaries.length;
  let result: T;
  try {
    result = run(frame);
  } catch (error) {
    if (error instanceof CppException) destroyTemporaries(frame, mark);
    throw error;
  }
  const finish = (): T => {
    destroyTemporaries(frame, mark);
    return result;
  };
  return result instanceof Store || result instanceof Ptr ? holdValues(frame, [result], finish) : finish();
}

export function bindRetainedTemporary(
  frame: Frame,
  bind: TemporaryBinding,
  retain: (temporary: Temporary) => void,
  finishExpression = false
): Ptr {
  const bindAndTransfer = (f: Frame, keep: (temporary: Temporary) => void): Ptr => {
    let index: number | undefined;
    const location = bind(f, (temporary) => {
      index = f.temporaries.push(temporary) - 1;
    });
    if (index === undefined) return location;
    const [temporary] = f.temporaries.splice(index, 1);
    keep(temporary);
    return location;
  };
  if (!finishExpression) return bindAndTransfer(frame, retain);
  const mark = frame.pending.length;
  let held: Temporary | undefined;
  try {
    const location = withTemporaries(frame, (f) =>
      bindAndTransfer(f, (temporary) => {
        held = temporary;
        f.pending.push(temporary.object);
      })
    );
    if (held) retain(held);
    return location;
  } catch (error) {
    if (error instanceof CppException && held) held.destroy(frame, held.object);
    throw error;
  } finally {
    frame.pending.length = mark;
  }
}

/** Ends the lifetime of temporaries created since `mark`, the last first. */
function destroyTemporaries(frame: Frame, mark: number): void {
  const { temporaries } = frame;
  while (temporaries.length > mark) {
    const temporary = temporaries.pop();
    if (!temporary) break;
    holdValues(frame, [temporary.object], () => temporary.destroy(frame, temporary.object));
  }
}

/**
 * Makes the elements of an array, or the members of an aggregate, in order, keeping the ones made reachable. An
 * exception destroys the ones already made in the owner's destruction order (C++20 [except.ctor]).
 */
export function makeEach(
  frame: Frame,
  count: number,
  make: (index: number) => Value,
  destroyerAt: (index: number) => ((frame: Frame, value: Value) => void) | undefined,
  existing?: Value[],
  order: 'forward' | 'reverse' = 'reverse'
): Value[] {
  const values = existing ?? [];
  const mark = frame.pending.length;
  let index = 0;
  try {
    for (; index < count; index++) {
      const value = make(index);
      values[index] = value;
      if (!existing) frame.pending.push(value);
    }
    return values;
  } catch (error) {
    if (error instanceof CppException) {
      for (let step = 0; step < index; step++) {
        const at = order === 'forward' ? step : index - 1 - step;
        const value = values[at];
        destroyerAt(at)?.(frame, value);
        endLifetime(value);
        values[at] = UNINIT;
      }
    }
    throw error;
  } finally {
    frame.pending.length = mark;
  }
}

export function constructArray(
  frame: Frame,
  length: number,
  element: Type,
  initialize: (frame: Frame, target: InitializerTarget | undefined, index: number) => Value,
  destroy: ((frame: Frame, value: Value) => void) | undefined,
  target?: ArrayStore
): ArrayStore {
  if (!target) frame.runtime.reserve(length);
  const store =
    target ??
    new ArrayStore(
      Array.from({ length }, (): Value => UNINIT),
      element
    );
  return constructCells(
    frame,
    store,
    length,
    () => element,
    initialize,
    () => destroy
  );
}

export function constructCells<S extends ArrayStore | CObject>(
  frame: Frame,
  store: S,
  count: number,
  typeAt: (index: number) => Type,
  initialize: (frame: Frame, target: InitializerTarget | undefined, index: number) => Value,
  destroyAt: (index: number) => ((frame: Frame, value: Value) => void) | undefined
): S {
  return holdValues(frame, [store], () => {
    try {
      makeEach(
        frame,
        count,
        (index) =>
          initializeAt(frame, typeAt(index), store.location(index), store.values[index], (destination) =>
            initialize(frame, destination, index)
          ),
        destroyAt,
        store.values
      );
      return store;
    } catch (error) {
      endLifetime(store);
      throw error;
    }
  });
}

export function initializeAt(
  frame: Frame,
  type: Type,
  location: Ptr,
  previous: Value,
  initialize: (target: InitializerTarget | undefined) => Value
): Value {
  if (location.store instanceof Box && location.index === 0) location.store.elementSize = sizeOf(type);
  let target = previous instanceof CObject || previous instanceof ArrayStore ? previous : undefined;
  if (type.kind === 'class' && !type.cls.library) {
    const object =
      target instanceof CObject && target.liveness === Liveness.Alive ? target : newObject(frame, type.cls);
    if (object !== target) {
      object.needsConstruction = true;
      location.write(object);
    }
    object.completeLocation = location;
    target = object;
  }
  try {
    const value = initialize(target);
    bindPlacedValue(type, value, location);
    if (target instanceof CObject && target !== value && target.needsConstruction) endLifetime(target);
    location.write(value);
    return value;
  } catch (error) {
    if (target instanceof CObject) endLifetime(target);
    throw error;
  }
}

function bindPlacedValue(type: Type, value: Value, location: Ptr): void {
  if (type.kind === 'class' && value instanceof CObject) value.completeLocation = location;
  if (type.kind === 'array' && value instanceof ArrayStore) value.bindLocation(type.of, location);
  if (value instanceof SequenceValue) value.bindInlineStorage(location);
  if (value instanceof StringValue) value.bindLocation(location);
}

/** A zero of a scalar type, as static storage and value-initialization start with. */
export function zeroOf(type: Type): Value {
  if (type.kind === 'int')
    return type.name === 'long' || type.name === 'ulong' || type.name === 'llong' || type.name === 'ullong' ? 0n : 0;
  if (type.kind === 'float') return 0;
  if (type.kind === 'pointer' || type.kind === 'nullptr') return NULL_PTR;
  return UNINIT;
}

export interface Resolved {
  fn: FunctionInfo;
  conversions: ConversionSequence[];
}
type MatchingOverload = Resolved & { objectConversion?: ConversionSequence };

interface ObjectUseContext {
  access?: ClassInfo;
  seen: Set<ClassInfo>;
  sourceIsConst?: boolean;
  baseObject?: ClassInfo;
  requiresComplete?: boolean;
  /** Checks a destructor's access without requiring its definition, as a destruction no code may run needs. */
  accessOnly?: boolean;
}

/** Making, copying, and destroying objects, converting values, and calling functions. */
export abstract class ObjectCompiler extends CompilerBase implements ConversionHost {
  private usingLibraryAccess = false;

  withLibraryAccess<T>(compile: () => T): T {
    const previous = this.usingLibraryAccess;
    this.usingLibraryAccess = true;
    try {
      return compile();
    } finally {
      this.usingLibraryAccess = previous;
    }
  }

  private get accessClass(): ClassInfo | undefined {
    return this.usingLibraryAccess ? undefined : this.enclosingClass;
  }
  // Values and conversions ------------------------------------------------------------------------------------------

  rvalue(expr: Expr): Expr {
    if (!expr.isLvalue) return expr;
    const known = expr.constant ?? expr.foldedValue;
    if ((known !== undefined && !Number.isNaN(known)) || expr.readConstant) {
      return {
        type: unqualified(expr.type),
        isLvalue: false,
        row: expr.row,
        constant: expr.constant,
        foldedValue: expr.foldedValue,
        onlyCalls: expr.onlyCalls,
        run: expr.readConstant ?? (() => known),
      };
    }
    const { type, run } = expr;
    if (type.kind === 'nullptr') {
      return {
        type: unqualified(type),
        isLvalue: false,
        row: expr.row,
        constantInitialization: expr.constantDesignation || expr.staticAddress || expr.constantInitialization,
        onlyCalls: expr.onlyCalls,
        run: (frame) => {
          run(frame);
          return NULL_PTR;
        },
      };
    }
    if (type.kind === 'array') {
      return {
        type: pointerTo(type.of),
        isLvalue: false,
        staticAddress: expr.staticAddress,
        constantPointee:
          expr.constantInitialization && type.length !== undefined ? { index: 0, length: type.length } : undefined,
        row: expr.row,
        run: (frame) => new Ptr((run(frame) as Ptr).read() as ArrayStore, 0),
      };
    }
    const size = type.kind === 'class' ? 0 : sizeOf(type);
    return {
      type: type.kind === 'class' ? type : unqualified(type),
      isLvalue: false,
      staticAddress: expr.constantPointerValue,
      constantPointee: expr.constantPointee,
      constantInitialization: expr.constantInitialization,
      constantStringLength: expr.constantStringLength,
      memberConstant: expr.memberConstant,
      constant: expr.constant,
      foldedValue: expr.foldedValue,
      row: expr.row,
      run: size === 0 ? (frame) => (run(frame) as Ptr).read() : (frame) => frame.readScalar(run(frame) as Ptr, size),
      onlyCalls: expr.onlyCalls,
    };
  }

  protected isConstantInitializer(expr: Expr): boolean {
    const value = this.rvalue(expr);
    return (
      value.constantInitialization === true ||
      value.constant !== undefined ||
      value.staticAddress === true ||
      value.literalBytes !== undefined ||
      value.isNullConstant === true
    );
  }

  /** An lvalue designating a temporary holding a prvalue, which lives until the end of the full-expression. */
  materialize(expr: Expr): Expr {
    if (expr.isLvalue) return expr;
    const locate = this.temporaryLocation(expr);
    return {
      type: expr.type,
      isLvalue: true,
      isXvalue: true,
      constantInitialization: this.isConstantInitializer(expr),
      constantStringLength: expr.constantStringLength,
      row: expr.row,
      onlyCalls: expr.onlyCalls,
      run: (frame) => locate(frame),
      temporaryBinding: locate,
    };
  }

  protected temporaryLocation(expr: Expr, view?: ClassInfo): TemporaryBinding {
    const destroy = this.destroyerOf(expr.type, expr.row);
    const { run } = expr;
    return (frame, retain) => {
      const box = new Box();
      const location = box.location(0);
      holdValues(frame, [box], () =>
        initializeAt(
          frame,
          expr.type,
          location,
          UNINIT,
          (target) => run(frame, false, target instanceof CObject ? target : undefined) as Value
        )
      );
      const temporary = {
        object: box,
        destroy: (f: Frame) => {
          if (box.value !== UNINIT) destroy?.(f, box.value);
          endLifetime(box);
        },
      };
      if (retain) retain(temporary);
      else frame.temporaries.push(temporary);
      return view ? location.forClass(view) : location;
    };
  }

  copyObject(expr: Expr, cls: ClassInfo): Expr {
    if (expr.type.kind === 'class') this.checkBaseConversion(expr.type.cls, cls, expr.row);
    const candidates = this.writtenCopyConstructors(cls);
    if (candidates.length > 0) {
      const selected = this.resolve(`コピーコンストラクタ ${cls.name}`, candidates, [expr], undefined, expr.row);
      return this.constructWith(cls, selected, [expr], expr.row);
    }
    const type = classType(cls);
    const movesSource = (!expr.isLvalue || expr.isXvalue === true) && !isConstType(expr.type);
    if (movesSource) this.checkMoveOperation(type, 'copy', expr.row, { access: this.accessClass, seen: new Set() });
    else this.checkCopySource(type, expr);
    const source = this.rvalue(expr);
    const sourceIsConst = isConstType(expr.type);
    const constantInitialization = source.constantInitialization === true && allowsConstantCopy(type);
    return {
      type,
      isLvalue: false,
      row: expr.row,
      isTemporaryObject: true,
      constantInitialization,
      constantStringLength: !expr.isLvalue && constantInitialization ? source.constantStringLength : undefined,
      onlyCalls: expr.onlyCalls,
      run: (frame, _zeroInitialize, destination) => {
        const value = source.run(frame);
        return movesSource
          ? constructElementFromRvalue(frame, type, value, destination)
          : copyAs(frame, cls, value, destination, sourceIsConst);
      },
    };
  }

  private checkCopySource(type: ClassType, expr: Expr): void {
    const { cls } = type;
    if (cls.isNoncopyable) {
      this.error(expr.row, `${cls.name} のオブジェクトはコピーできません（コピーコンストラクタが削除されています）。`);
    }
    if (!cls.implicitCopyFromConst && (!expr.isLvalue || expr.isXvalue || isConstType(expr.type)))
      this.error(expr.row, `${cls.name} のコピーコンストラクタには const でない左辺値が必要です。`);
    this.checkObjectUse(type, 'copy', expr.row, {
      access: this.accessClass,
      seen: new Set(),
      sourceIsConst: isConstType(expr.type),
    });
  }

  protected implicitMoveSource(expr: Expr, destination: Type): Expr {
    const moved: Expr = { ...expr, isXvalue: true };
    if (destination.kind === 'class' && expr.type.kind === 'class' && expr.type.cls.isDerivedFrom(destination.cls)) {
      const written = this.writtenCopyConstructors(destination.cls);
      if (written.length === 0) return destination.cls.implicitCopyFromConst ? moved : expr;
      return bestOf(this.matchingOverloads(written, [moved]), (a, b) => this.compareCandidates(a, b)) ? moved : expr;
    }
    return implicitConversion(this, moved, unqualified(destination)) ? moved : expr;
  }

  protected writtenCopyConstructors(cls: ClassInfo): FunctionInfo[] {
    return cls.constructors.filter((fn) => !fn.native && isCopyConstructor(fn, cls));
  }

  hasConstCopyParameter(type: Type): boolean {
    if (type.kind === 'array') return type.length === 0 || this.hasConstCopyParameter(type.of);
    if (type.kind !== 'class') return true;
    const candidates = this.writtenCopyConstructors(type.cls);
    return candidates.length === 0
      ? type.cls.implicitCopyFromConst
      : candidates.some(
          ({ params: [{ type: parameter }] }) => parameter.kind === 'reference' && isConstType(parameter.to)
        );
  }

  protected copySource(cls: ClassInfo, sourceIsConst: boolean, row: number): Expr {
    return { type: classType(cls, sourceIsConst), isLvalue: true, row, run: () => {} };
  }

  protected selectCopyConstructor(cls: ClassInfo, sourceIsConst: boolean, row: number): FunctionInfo | undefined {
    const viable = this.matchingOverloads(this.writtenCopyConstructors(cls), [
      this.copySource(cls, sourceIsConst, row),
    ]);
    return this.chooseOverload(`コピーコンストラクタ ${cls.name}`, viable, row)?.fn;
  }

  /** Stops at a use of a member that the code compiled now cannot access (C++20 [class.access]). */
  checkAccess(
    access: Access,
    owner: ClassInfo,
    naming: ClassInfo,
    row: number,
    name: string,
    objectClass?: ClassInfo
  ): void {
    if (isMemberAccessible(access, owner, naming, this.accessClass, objectClass)) return;
    const word = accessAsMemberOf(access, owner, naming) === 'protected' ? 'protected' : 'private';
    this.error(row, `${name} は ${owner.name} の ${word} のメンバなので、ここでは使えません。`);
  }

  checkBaseConversion(from: ClassInfo, to: ClassInfo, row: number): void {
    if (from === to || !from.isDerivedFrom(to) || isBaseAccessible(from, to, this.accessClass)) return;
    this.error(row, `${to.name} は ${from.name} の public な親クラスではないので、${from.name} から変換できません。`);
  }

  constructFrom(cls: ClassInfo, constructor: FunctionInfo, argument: Expr, row: number): Expr {
    const resolved = this.resolve(`コンストラクタ ${cls.name}`, [constructor], [argument], undefined, row);
    return this.constructWith(cls, resolved, [argument], row);
  }

  abstract bracedConversion(list: Syntax, to: Type): ConversionSequence | undefined;

  abstract checkDefined(fn: FunctionInfo, row: number): void;

  protected abstract checkWhenUsed(check: () => void): void;

  protected requireVirtualDefinitions(cls: ClassInfo, row: number): void {
    for (const fn of cls.virtuals.values()) {
      if (!fn.isPure) this.checkDefined(fn, row);
    }
  }

  isViableConstructor(constructor: FunctionInfo): boolean {
    return !constructor.isExplicit;
  }

  /** Converts an expression to a type as initialization does, or stops with a message naming `what`. */
  convert(expr: Expr, to: Type, row: number, what = '値'): Expr {
    if (expr.type.kind === 'void' && !expr.braced) this.error(row, '値を返さない関数（void）の結果は使えません。');
    const conversion = implicitConversion(this, expr, to);
    if (!conversion) return this.error(row, this.conversionMessage(expr, to, what));
    return conversion.apply(expr);
  }

  private conversionMessage(expr: Expr, to: Type, what: string): string {
    const from = typeName(expr.type);
    if (to.kind === 'reference' && !isConstType(to.to) && expr.isLvalue && isConstType(expr.type)) {
      return `const の${what}（${from}）を、const でない参照（${typeName(to)}）に束縛できません。`;
    }
    if (to.kind === 'reference' && !isConstType(to.to) && !expr.isLvalue) {
      return `一時的な${what}（${from}）を、const でない参照（${typeName(to)}）に束縛できません。`;
    }
    if (nonReference(to).kind === 'class' && expr.type.kind === 'class') {
      return `${from} 型の${what}を ${typeName(to)} 型に変換できません。`;
    }
    return `${from} 型の${what}を ${typeName(to)} 型に変換できません。`;
  }

  // Calls --------------------------------------------------------------------------------------------------------

  /**
   * Chooses the function a call uses among the candidates (C++20 [over.match]), stopping with a message when none or
   * several fit.
   */
  resolve(
    description: string,
    candidates: FunctionInfo[],
    args: Expr[],
    object: Expr | undefined,
    row: number,
    templateArgs?: Type[],
    isFunctionPointer = false
  ): Resolved {
    const viable = this.matchingOverloads(candidates, args, object, templateArgs, isFunctionPointer);
    const best = this.chooseOverload(description, viable, row);
    if (best) return best;
    const argTypes = args.map((arg) => (arg.type.kind === 'void' ? 'void' : typeName(arg.type))).join(', ');
    const constNote =
      object && isConstType(object.type) && candidates.some((candidate) => !candidate.isConst && !candidate.isStatic)
        ? '（const のオブジェクトからは const のメンバ関数しか呼べません）'
        : '';
    return this.error(row, `${description} に、引数（${argTypes}）に合うものがありません。${constNote}`);
  }

  protected chooseOverload(description: string, viable: MatchingOverload[], row: number): Resolved | undefined {
    const best = bestOf(viable, (a, b) => this.compareCandidates(a, b));
    if (!best && viable.length > 1)
      return this.error(row, `${description} の呼び出しに合うものが複数あり、どれを呼ぶのか決まりません。`);
    return best;
  }

  protected matchingOverloads(
    candidates: FunctionInfo[],
    args: Expr[],
    object?: Expr,
    templateArgs?: Type[],
    isFunctionPointer = false
  ): MatchingOverload[] {
    const viable: MatchingOverload[] = [];
    for (const candidate of candidates) {
      const instantiated = candidate.instantiate?.(args, templateArgs);
      const fn = candidate.instantiate ? instantiated && { ...instantiated, isTemplate: true } : candidate;
      if (!fn || (templateArgs && !candidate.instantiate)) continue;
      if (isFunctionPointer && args.length < fn.params.length) continue;
      const conversions = this.argumentConversions(fn, args);
      if (!conversions) continue;
      const objectConversion =
        object && !fn.isStatic && !fn.isConstructor ? this.objectConversion(fn, object) : undefined;
      if (object && !fn.isStatic && !fn.isConstructor && !objectConversion) continue;
      viable.push({ fn, conversions, objectConversion });
    }
    return viable;
  }

  private argumentConversions(fn: FunctionInfo, args: Expr[]): ConversionSequence[] | undefined {
    if (args.length > fn.params.length && !fn.isVariadic) return undefined;
    for (const param of fn.params.slice(args.length)) {
      if (param.defaultValue === undefined && !param.isOptional) return undefined;
    }
    const conversions: ConversionSequence[] = [];
    for (const [index, arg] of args.entries()) {
      const param = fn.params[index];
      if (!param) {
        conversions.push({
          rank: Rank.UserDefined + 1,
          isBoolean: false,
          baseDistance: 0,
          apply: (e) => this.variadicArgument(e),
        });
        continue;
      }
      if (arg.type.kind === 'void' && !arg.functions && !arg.braced) return undefined;
      const conversion = implicitConversion(this, arg, param.type);
      if (!conversion) return undefined;
      conversions.push(conversion);
    }
    return conversions;
  }

  /**
   * An argument for the `...` of a library function such as `printf`, after the default argument promotions, which
   * the function receives with its type to check against its format.
   */
  private variadicArgument(expr: Expr): Expr {
    const value = this.rvalue(expr);
    let type = value.type;
    if (type.kind === 'class') {
      return this.error(
        expr.row,
        `${typeName(type)} 型の値は、可変長引数（printf の ... など）には渡せません（c_str() などを使ってください）。`
      );
    }
    if (type.kind === 'void') return this.error(expr.row, '値を返さない関数（void）の結果は渡せません。');
    if (type.kind === 'float' && type.name === 'float') type = { kind: 'float', name: 'double' };
    if (type.kind === 'int' && ['bool', 'char', 'schar', 'uchar', 'short', 'ushort'].includes(type.name))
      type = { kind: 'int', name: 'int' };
    const promoted = isArithmeticType(type) ? convertArithmetic(value, type) : value;
    const run = promoted.run;
    const argumentType = type;
    return { ...promoted, run: (frame) => ({ value: run(frame), type: argumentType }) as unknown as Value };
  }

  /** The conversion of the object of a member function call to the implicit object parameter. */
  private objectConversion(fn: FunctionInfo, object: Expr): ConversionSequence | undefined {
    if (isConstType(object.type) && !fn.isConst) return undefined;
    return {
      rank: Rank.Exact,
      isBoolean: false,
      baseDistance: 0,
      reference: { toConst: fn.isConst },
      apply: (e) => e,
    };
  }

  private compareCandidates(
    a: Resolved & { objectConversion?: ConversionSequence },
    b: Resolved & { objectConversion?: ConversionSequence }
  ): number {
    let aBetter = false;
    let bBetter = false;
    const pairs: [ConversionSequence | undefined, ConversionSequence | undefined][] = a.conversions.map(
      (conversion, index) => [conversion, b.conversions[index]]
    );
    pairs.push([a.objectConversion, b.objectConversion]);
    for (const [left, right] of pairs) {
      if (!left || !right) continue;
      const order = compareSequences(left, right);
      if (order > 0) aBetter = true;
      if (order < 0) bBetter = true;
    }
    if (aBetter !== bBetter) return aBetter ? 1 : -1;
    if (aBetter && bBetter) return 0;
    if (a.fn.isTemplate !== b.fn.isTemplate) return a.fn.isTemplate ? -1 : 1;
    return 0;
  }

  /**
   * Converts the arguments of a resolved call and adds the defaults of the parameters it leaves out. A parameter that
   * is an object becomes a temporary of the caller's full-expression, so the call must be invoked with
   * `isCallerDestroying`.
   */
  callArguments(fn: FunctionInfo, args: Expr[], row: number): Eval<unknown>[] {
    const runs: Eval<unknown>[] = args.map((arg) => arg.run);
    // The library's functions take the arguments a call leaves out as missing.
    if (fn.native) return runs;
    for (const param of fn.params.slice(args.length)) {
      const useDefault = param.defaultValue?.use;
      if (!useDefault) return this.error(row, `引数の既定値を解決できません（${fn.displayName}）。`);
      runs.push(useDefault());
    }
    return runs.map((run, index) => {
      const type = fn.params[index]?.type;
      if (type?.kind !== 'class') return run;
      this.requireObjectUse(type, 'destroy', row);
      return (frame) => {
        const value = run(frame) as Value;
        const destroy = parameterDestroyer(type);
        if (destroy) frame.temporaries.push({ object: value, destroy });
        return value;
      };
    });
  }

  protected convertArguments(resolved: Resolved, args: Expr[]): Expr[] {
    return args.map((arg, index) => resolved.conversions[index].apply(arg));
  }

  /**
   * A call of a resolved function. A member function needs the object, as an lvalue or a prvalue; `isQualified`
   * calls the function itself rather than the final overrider of a virtual one.
   */
  callExpr(resolved: Resolved, args: Expr[], object: Expr | undefined, row: number, isQualified = false): Expr {
    const { fn } = resolved;
    const converted = this.convertArguments(resolved, args);
    const argRuns = this.callArguments(fn, converted, row);
    const evaluateObject = object && (fn.isStatic ? this.materialize(object).run : this.objectOf(object));
    const runs = evaluateObject ? [evaluateObject, ...argRuns] : argRuns;
    const call = this.prepareInvocation(fn, row, isQualified);
    const run: Eval<Value | Ptr> = (frame) => {
      return holdAll(frame, runs, (values) => {
        const receiver = evaluateObject ? (values.shift() as Ptr) : undefined;
        return call(frame, values, receiver);
      });
    };
    const isReference = fn.ret.kind === 'reference';
    const type = nonReference(fn.ret);
    const knownLocation = object && fn.constantAccess?.(object, converted);
    return {
      type,
      isLvalue: isReference,
      row,
      run,
      ...(object
        ? {
            staticAddress: isReference ? hasConstantObject(knownLocation) : knownLocation !== undefined,
            constantLocation: isReference ? knownLocation : undefined,
            constantInitialization: isReference && hasConstantObject(knownLocation),
            constantPointee: type.kind === 'pointer' ? knownLocation : undefined,
          }
        : this.callConstancy(fn, args, converted)),
      onlyCalls: true,
      isTemporaryObject: !isReference && type.kind === 'class',
    };
  }

  prepareInvocation(fn: FunctionInfo, row: number, isQualified = false) {
    const key = fn.isVirtual && !isQualified ? virtualKey(fn) : undefined;
    const resultClass =
      (fn.ret.kind === 'pointer' || fn.ret.kind === 'reference') && fn.ret.to.kind === 'class'
        ? fn.ret.to.cls
        : undefined;
    return (frame: Frame, args: unknown[], receiver?: Ptr): Value | Ptr => {
      const location = fn.isStatic ? undefined : receiver;
      let callee = fn;
      if (key !== undefined && location) {
        const target = location.read();
        if (target instanceof CObject) callee = target.cls.virtuals.get(key) ?? fn;
        if (callee.isPure) throw new CppRuntimeError('custom', `純粋仮想関数 ${callee.displayName} を呼び出しました。`);
      }
      const result = invoke(frame, callee, args, location, row, true);
      if (resultClass && callee !== fn && !sameType(callee.ret, fn.ret)) return (result as Ptr).forClass(resultClass);
      return result;
    };
  }

  private callConstancy(
    fn: FunctionInfo,
    args: Expr[],
    converted: Expr[]
  ): Pick<Expr, 'constant' | 'memberConstant' | 'constantInitialization' | 'constantStringLength'> {
    const arithmeticArgs = this.constantCallArguments(fn, args);
    const evaluate = fn.evaluateConstant;
    const allConstant = arithmeticArgs && arithmeticArgs.every((arg) => arg.constant !== undefined);
    return {
      ...this.libraryConstant(fn, args, converted),
      constant: allConstant ? evaluate?.(arithmeticArgs.map((arg) => arg.constant as number | bigint)) : undefined,
      memberConstant: arithmeticArgs && evaluate ? mapMemberConstants(arithmeticArgs, evaluate) : undefined,
    };
  }

  private constantCallArguments(fn: FunctionInfo, args: Expr[]): Expr[] | undefined {
    if (!fn.evaluateConstant || args.length !== fn.params.length) return;
    const converted: Expr[] = [];
    for (const [index, arg] of args.entries()) {
      const value = this.rvalue(arg);
      const target = nonReference(fn.params[index].type);
      if (!isArithmeticType(value.type) || !isArithmeticType(target)) return;
      converted.push(convertArithmetic(value, target));
    }
    return converted;
  }

  private libraryConstant(
    fn: FunctionInfo,
    source: Expr[],
    converted: Expr[]
  ): Pick<Expr, 'constantInitialization' | 'constantStringLength'> | undefined {
    const result = fn.libraryConstant?.(source);
    if (!result || !converted.every((arg) => this.isConstantInitializer(arg))) return;
    return { constantInitialization: true, constantStringLength: result === true ? undefined : result.stringLength };
  }

  /** Evaluates the location of the object of a member function call, materializing a prvalue as a temporary. */
  objectOf(object: Expr): Eval<Ptr> {
    const { run } = object.isLvalue ? object : this.materialize(object);
    return (frame) => {
      const location = run(frame) as Ptr;
      const value = location.read();
      if (value instanceof Store) value.checkAlive();
      return location;
    };
  }

  // Objects ----------------------------------------------------------------------------------------------------------

  /** A prvalue object of a class made by the resolved constructor. */
  constructWith(cls: ClassInfo, resolved: Resolved, args: Expr[], row: number): Expr {
    if (!cls.isComplete && cls.library) this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    this.checkLibraryLayout(classType(cls), row);
    if (cls.isAbstract)
      this.error(row, `${cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、オブジェクトを作れません。`);
    const { fn } = resolved;
    if (!fn.native) this.checkAccess(fn.access, cls, cls, row, `${cls.name} のコンストラクタ`, cls);
    this.checkDefined(fn, row);
    this.requireVirtualDefinitions(cls, row);
    const converted = this.convertArguments(resolved, args);
    const argRuns = this.callArguments(fn, converted, row);
    const run: Expr['run'] = fn.native
      ? (frame) => holdAll(frame, argRuns, (values) => invoke(frame, fn, values, undefined, row, true) as Value)
      : (frame, zeroInitialize, destination) =>
          holdAll(frame, argRuns, (values) => {
            const object = newObject(frame, cls, zeroInitialize, destination);
            invoke(frame, fn, values, object.receiver(), row, true);
            object.needsConstruction = false;
            return object;
          });
    return {
      type: classType(cls),
      isLvalue: false,
      row,
      run,
      onlyCalls: true,
      isTemporaryObject: true,
      ...this.libraryConstant(fn, args, converted),
    };
  }

  /**
   * Destroys an object of a type at the end of its lifetime, or undefined when that has no effect. With `row`, the code
   * compiled now destroys the object there, which needs access to its destructor.
   */
  destroyerOf(type: Type, row?: number): ((frame: Frame, value: Value) => void) | undefined {
    if (type.kind === 'class') {
      if (row !== undefined) this.requireObjectUse(type, 'destroy', row);
      return type.cls.operations?.destroy;
    }
    if (type.kind === 'array' && (type.length ?? 1) > 0) {
      const element = this.destroyerOf(type.of, row);
      if (!element) return undefined;
      return (frame, value) => {
        const { values } = value as ArrayStore;
        for (let index = values.length - 1; index >= 0; index--)
          if (values[index] !== UNINIT) element(frame, values[index]);
      };
    }
    return undefined;
  }

  requireObjectUse(type: Type, operation: 'copy' | 'assign' | 'destroy' | 'move-assign', row: number): void {
    const context: ObjectUseContext = { access: this.accessClass, seen: new Set() };
    if (operation === 'move-assign') this.checkMoveOperation(type, 'assign', row, context);
    else this.checkObjectUse(type, operation, row, context);
  }

  /** Stops when a type's destructor, or one it implies, is inaccessible here; unlike a destruction, needs no definition. */
  requireDestructorAccess(type: Type, row: number): void {
    this.checkObjectUse(type, 'destroy', row, { access: this.accessClass, seen: new Set(), accessOnly: true });
  }

  requireLibraryObjectUse(
    type: Type,
    operation: 'copy' | 'assign' | 'destroy' | 'move' | 'move-assign',
    row: number,
    sourceIsConst = true
  ): void {
    const context: ObjectUseContext = { seen: new Set(), sourceIsConst, requiresComplete: true };
    if (operation === 'assign' || operation === 'move-assign') this.checkLibraryAssignment(type, row);
    if (operation === 'move' || operation === 'move-assign') {
      this.checkMoveOperation(type, operation === 'move' ? 'copy' : 'assign', row, context);
      return;
    }
    this.checkObjectUse(type, operation, row, context);
  }

  private checkLibraryAssignment(type: Type, row: number): void {
    if (!allowsMemberAssignment(type)) this.error(row, `${typeName(type)} 型の要素には代入できません。`);
  }

  private readonly copyDefaults = new Map<FunctionInfo, Eval<unknown>[]>();

  private checkMoveOperation(type: Type, fallback: 'copy' | 'assign', row: number, context: ObjectUseContext): void {
    if (type.kind === 'reference' && fallback === 'assign') {
      this.requireLibraryObjectUse(type.to, 'assign', row);
      return;
    }
    if (type.kind === 'array') {
      if ((type.length ?? 1) > 0) this.checkMoveOperation(type.of, fallback, row, context);
      return;
    }
    if (type.kind !== 'class') return;
    const move = moveConstruction(type);
    if (move.kind === 'copy') {
      this.checkObjectUse(type, fallback, row, { ...context, sourceIsConst: true, seen: new Set() });
      return;
    }
    if (move.kind === 'array') {
      this.checkMoveOperation(move.array.type, fallback, row, { seen: context.seen });
      return;
    }
    if (move.kind !== 'members') return;
    const { cls } = type;
    const { seen } = context;
    this.requireVirtualDefinitions(cls, row);
    if (seen.has(cls)) return;
    seen.add(cls);
    if (cls.base) this.checkMoveOperation(classType(cls.base), fallback, row, { access: cls, seen, baseObject: cls });
    for (const field of cls.ownFields) this.checkMoveOperation(field.type, fallback, row, { access: cls, seen });
  }

  protected invokeStoredCopy(frame: Frame, fn: FunctionInfo, source: Ptr, target: Ptr): void {
    const defaults = this.copyDefaults.get(fn) ?? [];
    withTemporaries(frame, () =>
      holdAll(frame, [() => source, ...defaults], (args) => invoke(frame, fn, args, target, fn.row, true))
    );
  }

  private checkObjectUse(
    type: Type,
    operation: 'copy' | 'assign' | 'destroy',
    row: number,
    context: ObjectUseContext
  ): void {
    if (type.kind === 'array') {
      if ((type.length ?? 1) > 0) this.checkObjectUse(type.of, operation, row, context);
      return;
    }
    if (type.kind !== 'class') return;
    const { cls } = type;
    const { access, seen, baseObject, requiresComplete, accessOnly } = context;
    if (requiresComplete && !cls.isComplete) {
      this.checkCompleteWhenUsed(cls, row, () =>
        this.checkObjectUse(type, operation, row, { ...context, seen: new Set(seen) })
      );
      return;
    }
    const destructor = cls.destructor;
    if (
      operation === 'destroy' &&
      destructor &&
      !destructor.native &&
      !isMemberAccessible(destructor.access, cls, cls, access, baseObject ?? cls)
    ) {
      this.error(row, `${cls.name} のデストラクタは ${destructor.access} なので、ここでは使えません。`);
    }
    if (seen.has(cls)) return;
    seen.add(cls);

    this.checkLibraryStorage(cls, row);
    if (operation === 'copy' && this.checkCopyOperation(type, row, context)) return;
    if (operation === 'destroy' && destructor && !accessOnly) this.checkDefined(destructor, row);
    const nested = { access: cls, seen, sourceIsConst: cls.implicitCopyFromConst, requiresComplete, accessOnly };
    if (cls.base) this.checkObjectUse(classType(cls.base), operation, row, { ...nested, baseObject: cls });
    for (const field of cls.ownFields) this.checkObjectUse(field.type, operation, row, nested);
    for (const owned of cls.library?.ownedTypes ?? []) {
      const library = { seen, sourceIsConst: cls.library?.ownedCopyFromConst ?? true, requiresComplete: true };
      if (operation === 'assign' && cls.library?.elementUseOnAssignment === 'assign-and-copy')
        this.checkLibraryAssignment(owned, row);
      this.checkObjectUse(owned, operation, row, library);
      if (operation === 'assign' && cls.library?.elementUseOnAssignment)
        this.checkObjectUse(owned, 'copy', row, { ...library, seen: new Set() });
    }
  }

  protected checkLibraryStorage(cls: ClassInfo, row: number): void {
    const element = cls.library?.inlineElementType;
    if (element) this.checkWhenUsed(() => this.checkStoredElement(element, row, new Set()));
  }

  private checkStoredElement(type: Type, row: number, seen: Set<ClassInfo>): void {
    if (type.kind === 'array') {
      this.checkStoredElement(type.of, row, seen);
      return;
    }
    if (type.kind !== 'class') return;
    const { cls } = type;
    if (seen.has(cls)) return;
    this.requireConcreteElement(cls, row);
    seen.add(cls);
    for (const field of cls.ownFields) this.checkStoredElement(field.type, row, seen);
    const array = cls.library?.aggregateArray;
    if (array) this.checkStoredElement(array.type.of, row, seen);
    const element = cls.library?.inlineElementType;
    if (element) this.checkStoredElement(element, row, seen);
  }

  private checkCompleteWhenUsed(cls: ClassInfo, row: number, check: () => void): void {
    this.checkWhenUsed(() => {
      if (!cls.isComplete) this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
      check();
    });
  }

  private checkCopyOperation(type: ClassType, row: number, context: ObjectUseContext): boolean {
    const { cls } = type;
    this.requireVirtualDefinitions(cls, row);
    const sourceIsConst = context.sourceIsConst === true || isConstType(type);
    const hasWrittenCopy = this.writtenCopyConstructors(cls).length > 0;
    const constructor = hasWrittenCopy ? this.selectCopyConstructor(cls, sourceIsConst, row) : undefined;
    if (cls.isNoncopyable || (hasWrittenCopy ? !constructor : sourceIsConst && !cls.implicitCopyFromConst))
      this.error(row, `${cls.name} のオブジェクトはコピーできません。`);
    if (!constructor) return false;
    if (!isMemberAccessible(constructor.access, cls, cls, context.access, context.baseObject ?? cls))
      this.error(row, `${cls.name} のコピーコンストラクタは ${constructor.access} なので、ここでは使えません。`);
    this.checkDefined(constructor, row);
    if (constructor.params.length > 1) {
      const defaults = this.callArguments(constructor, [this.copySource(cls, sourceIsConst, row)], row).slice(1);
      this.copyDefaults.set(constructor, defaults);
    }
    return true;
  }
}

/** A new object of a class, whose members its constructor initializes. */
export function newObject(frame: Frame, cls: ClassInfo, zeroInitialize = false, destination?: CObject): CObject {
  if (destination?.liveness !== Liveness.Alive) return allocateObject(frame.runtime, cls, zeroInitialize);
  if (zeroInitialize && destination.needsConstruction && !destination.zeroInitialized) {
    zeroMembers(frame.runtime, cls, destination);
    destination.zeroInitialized = true;
  }
  destination.needsConstruction = false;
  return destination;
}

export function installBaseValue(base: ClassInfo, target: CObject, initialized: CObject): void {
  if (initialized === target) return;
  target.takeMessageFrom(initialized);
  for (const field of base.fields) target.values[field.index] = initialized.values[field.index];
}

function allocateObject(runtime: Frame['runtime'], cls: ClassInfo, zeroInitialize: boolean): CObject {
  runtime.reserve(cls.fields.length);
  const object = new CObject(
    cls,
    cls.fields.map(() => UNINIT),
    zeroInitialize
  );
  if (zeroInitialize) zeroMembers(runtime, cls, object);
  return object;
}

export function zeroMembers(runtime: Frame['runtime'], cls: ClassInfo, object: CObject): void {
  for (const field of cls.fields)
    object.values[field.index] = staticZero(runtime, field.type, object.location(field.index));
}

export function staticZero(runtime: Frame['runtime'], type: Type, location?: Ptr): Value {
  if (type.kind === 'class' && !type.cls.library) {
    const object = allocateObject(runtime, type.cls, true);
    object.completeLocation = location;
    object.needsConstruction = true;
    return object;
  }
  if (type.kind !== 'array') return zeroOf(type);
  const length = type.length ?? 0;
  runtime.reserve(length);
  const store = new ArrayStore([], type.of, location);
  for (let index = 0; index < length; index++) store.values.push(staticZero(runtime, type.of, store.location(index)));
  return store;
}

/** Copies an object as the copy constructor of `cls` does, slicing an object of a derived class. */
function copyAs(
  frame: Frame,
  cls: ClassInfo,
  source: Value,
  destination: CObject | undefined,
  sourceIsConst: boolean
): Value {
  const operations = cls.operations;
  if (!operations) throw new Error(`${cls.name} cannot be copied`);
  return operations.copy(frame, source, destination, sourceIsConst);
}
