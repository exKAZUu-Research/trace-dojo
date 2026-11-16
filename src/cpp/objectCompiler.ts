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
import { CppRuntimeError } from './errors';
import type { Expr } from './expr';
import { type Eval, type Frame, holdAll } from './runtime';
import { FunctionContext } from './scopes';
import type { Syntax } from './syntax';
import {
  type ClassInfo,
  classType,
  type FunctionInfo,
  isArithmetic as isArithmeticType,
  isConstType,
  nonReference,
  pointerTo,
  type Type,
  typeName,
  unqualified,
} from './types';
import { type ArrayStore, Box, CObject, Liveness, NULL_PTR, Ptr, Store, UNINIT, type Value } from './values';

/**
 * Calls a function with its arguments as its parameters declare them: a `Ptr` for a reference, else a value. A member
 * function gets the location of its object as `self`.
 */
export function invoke(
  frame: Frame,
  fn: FunctionInfo,
  args: unknown[],
  self: Ptr | undefined,
  row: number
): Value | Ptr {
  const { runtime } = frame;
  if (fn.native) {
    runtime.spend();
    return fn.native(args, { self: self?.read(), frame, row }) as Value | Ptr;
  }
  const compiled = fn.compiled;
  if (!compiled) throw new Error(`${fn.displayName} has no body`);
  const callee = runtime.pushFrame(fn, row, compiled, self);
  try {
    for (const [index, param] of fn.params.entries()) {
      callee.slots[index] = param.type.kind === 'reference' ? (args[index] as Ptr) : new Box(args[index] as Value);
    }
    compiled.body(callee);
    return callee.returnValue;
  } finally {
    runtime.popFrame();
  }
}

/** The key that identifies a virtual function across a hierarchy: its name and its parameters. */
export function virtualKey(fn: FunctionInfo): string {
  return `${fn.name}(${fn.params.map((param) => typeName(param.type)).join(',')})${fn.isConst ? 'const' : ''}`;
}

/** Ends the lifetime of the temporaries a full-expression created since `mark`, the last first. */
export function destroyTemporaries(frame: Frame, mark: number): void {
  const { temporaries } = frame;
  while (temporaries.length > mark) {
    const temporary = temporaries.pop();
    if (!temporary) break;
    temporary.destroy(frame, temporary.object);
  }
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

/** Making, copying, and destroying objects, converting values, and calling functions. */
export abstract class ObjectCompiler extends CompilerBase implements ConversionHost {
  // Values and conversions ------------------------------------------------------------------------------------------

  rvalue(expr: Expr): Expr {
    if (!expr.isLvalue) return expr;
    const { type, run } = expr;
    if (type.kind === 'array') {
      return {
        type: pointerTo(type.of),
        isLvalue: false,
        row: expr.row,
        run: (frame) => new Ptr((run(frame) as Ptr).read() as ArrayStore, 0),
      };
    }
    if (expr.constant !== undefined) {
      const constant = expr.constant;
      return { ...expr, type: unqualified(type), isLvalue: false, run: () => constant };
    }
    return {
      type: type.kind === 'class' ? type : unqualified(type),
      isLvalue: false,
      row: expr.row,
      run: (frame) => (run(frame) as Ptr).read(),
      onlyCalls: expr.onlyCalls,
    };
  }

  /** An lvalue designating a temporary holding a prvalue, which lives until the end of the full-expression. */
  materialize(expr: Expr): Expr {
    if (expr.isLvalue) return expr;
    const destroy = this.destroyerOf(expr.type);
    const { run } = expr;
    return {
      type: expr.type,
      isLvalue: true,
      row: expr.row,
      onlyCalls: expr.onlyCalls,
      run: (frame) => {
        const box = new Box(run(frame) as Value);
        frame.temporaries.push({
          object: box,
          destroy: (f) => {
            if (destroy && box.value !== UNINIT) destroy(f, box.value);
            box.liveness = Liveness.Dead;
          },
        });
        return new Ptr(box, 0);
      },
    };
  }

  copyObject(expr: Expr, cls: ClassInfo): Expr {
    if (cls.isNoncopyable) {
      this.error(expr.row, `${cls.name} のオブジェクトはコピーできません（コピーコンストラクタが削除されています）。`);
    }
    const source = this.rvalue(expr);
    return {
      type: classType(cls),
      isLvalue: false,
      row: expr.row,
      isTemporaryObject: true,
      onlyCalls: expr.onlyCalls,
      run: (frame) => copyAs(frame, cls, source.run(frame) as Value),
    };
  }

  constructFrom(cls: ClassInfo, constructor: FunctionInfo, argument: Expr, row: number): Expr {
    const resolved = this.resolve(`コンストラクタ ${cls.name}`, [constructor], [argument], undefined, row);
    return this.constructWith(cls, resolved, [argument], row);
  }

  abstract bracedConversion(list: Syntax, to: Type): ConversionSequence | undefined;

  isViableConstructor(constructor: FunctionInfo): boolean {
    return !constructor.isExplicit;
  }

  /** Converts an expression to a type as initialization does, or stops with a message naming `what`. */
  convert(expr: Expr, to: Type, row: number, what = '値'): Expr {
    if (expr.type.kind === 'void') this.error(row, '値を返さない関数（void）の結果は使えません。');
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
    templateArgs?: Type[]
  ): Resolved {
    const viable: (Resolved & { objectConversion?: ConversionSequence })[] = [];
    for (const candidate of candidates) {
      const fn = candidate.instantiate ? candidate.instantiate(args, templateArgs) : candidate;
      if (!fn || (templateArgs && !candidate.instantiate)) continue;
      const conversions = this.argumentConversions(fn, args);
      if (!conversions) continue;
      const objectConversion =
        object && !fn.isStatic && !fn.isConstructor ? this.objectConversion(fn, object) : undefined;
      if (object && !fn.isStatic && !fn.isConstructor && !objectConversion) continue;
      viable.push({ fn, conversions, objectConversion });
    }
    const best = bestOf(viable, (a, b) => this.compareCandidates(a, b));
    if (best) return best;
    if (viable.length > 1)
      return this.error(row, `${description} の呼び出しに合うものが複数あり、どれを呼ぶのか決まりません。`);
    const argTypes = args.map((arg) => (arg.type.kind === 'void' ? 'void' : typeName(arg.type))).join(', ');
    const constNote =
      object && isConstType(object.type) && candidates.some((candidate) => !candidate.isConst && !candidate.isStatic)
        ? '（const のオブジェクトからは const のメンバ関数しか呼べません）'
        : '';
    return this.error(row, `${description} に、引数（${argTypes}）に合うものがありません。${constNote}`);
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
          addsQualification: false,
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
      addsQualification: false,
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

  /** Converts the arguments of a resolved call and adds the defaults of the parameters it leaves out. */
  callArguments(resolved: Resolved, args: Expr[], row: number): Eval<unknown>[] {
    const { fn, conversions } = resolved;
    const runs = args.map((arg, index) => conversions[index].apply(arg).run);
    // The library's functions take the arguments a call leaves out as missing.
    if (fn.native) return runs;
    for (const param of fn.params.slice(args.length)) {
      runs.push(this.defaultArgument(fn, param.defaultValue as Syntax, param.type, row).run);
    }
    return runs;
  }

  /** Compiles a default argument where a call uses it, in the scope of the function's declaration. */
  private defaultArgument(fn: FunctionInfo, syntax: Syntax, type: Type, row: number): Expr {
    const saved = this.context;
    this.context = new FunctionContext(undefined, fn.owner, type);
    try {
      return this.convert(this.compileExpression(syntax), type, row, '引数の既定値');
    } finally {
      this.context = saved;
    }
  }

  /**
   * A call of a resolved function. A member function needs the object, as an lvalue or a prvalue; `isQualified`
   * calls the function itself rather than the final overrider of a virtual one.
   */
  callExpr(resolved: Resolved, args: Expr[], object: Expr | undefined, row: number, isQualified = false): Expr {
    const { fn } = resolved;
    const argRuns = this.callArguments(resolved, args, row);
    const self = object && !fn.isStatic ? this.objectOf(object) : undefined;
    const virtualKeyText = fn.isVirtual && !isQualified ? virtualKey(fn) : undefined;
    const run: Eval<Value | Ptr> = (frame) => {
      const location = self?.(frame);
      return holdAll(frame, argRuns, (values) => {
        let callee = fn;
        if (virtualKeyText !== undefined && location) {
          const target = location.read();
          if (target instanceof CObject) callee = target.cls.virtuals.get(virtualKeyText) ?? fn;
          if (callee.isPure)
            throw new CppRuntimeError('custom', `純粋仮想関数 ${callee.displayName} を呼び出しました。`);
        }
        return invoke(frame, callee, values, location, row);
      });
    };
    const isReference = fn.ret.kind === 'reference';
    const type = nonReference(fn.ret);
    return {
      type,
      isLvalue: isReference,
      row,
      run,
      onlyCalls: true,
      isTemporaryObject: !isReference && type.kind === 'class',
    };
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
    if (cls.isAbstract)
      this.error(row, `${cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、オブジェクトを作れません。`);
    const { fn } = resolved;
    const argRuns = this.callArguments(resolved, args, row);
    const run: Eval<Value> = fn.native
      ? (frame) => holdAll(frame, argRuns, (values) => invoke(frame, fn, values, undefined, row) as Value)
      : (frame) =>
          holdAll(frame, argRuns, (values) => {
            const object = newObject(cls);
            invoke(frame, fn, values, new Ptr(new Box(object), 0), row);
            return object;
          });
    return { type: classType(cls), isLvalue: false, row, run, onlyCalls: true, isTemporaryObject: true };
  }

  /** Destroys an object of a type at the end of its lifetime, or undefined when that has no effect. */
  destroyerOf(type: Type): ((frame: Frame, value: Value) => void) | undefined {
    if (type.kind === 'class') return type.cls.operations?.destroy;
    if (type.kind === 'array') {
      const element = this.destroyerOf(type.of);
      if (!element) return undefined;
      return (frame, value) => {
        const { values } = value as ArrayStore;
        for (let index = values.length - 1; index >= 0; index--)
          if (values[index] !== UNINIT) element(frame, values[index]);
      };
    }
    return undefined;
  }
}

/** A new object of a class, whose members its constructor initializes. */
export function newObject(cls: ClassInfo): CObject {
  return new CObject(
    cls,
    Array.from({ length: cls.fields.length }, () => UNINIT)
  );
}

/** Copies an object as the copy constructor of `cls` does, slicing an object of a derived class. */
export function copyAs(frame: Frame, cls: ClassInfo, source: Value): Value {
  const operations = cls.operations;
  if (!operations) throw new Error(`${cls.name} cannot be copied`);
  return operations.copy(frame, source);
}
