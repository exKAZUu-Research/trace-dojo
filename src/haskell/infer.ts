import { CHAR_TYPE, FUNCTION_TYPE, LIST_TYPE, tupleCon } from './builtinTypes';
import { type ClassEnv, entailByGivens, hasConstructorHead, isSubclassOf, predsEqual } from './classEnv';
import type { ClassEntity, ConInfo, DictParam, Evidence, EvidenceHole, TypeEntity, ValueEntity } from './entities';
import { compileError } from './errors';
import { TypePrinter } from './prettyType';
import type { Binder, LocalVar, RBindGroup, RBinding, RExpr, RPat, RRhs, RSigType, RStmt, RType, VarRef } from './rast';
import type { Span } from './syntax';
import {
  defaultKind,
  freshKindVar,
  freshSkolem,
  freshTypeVar,
  instantiateType,
  type Kind,
  kindArrow,
  kindOfType,
  occursIn,
  type Pred,
  prune,
  pruneKind,
  quantifyType,
  type Scheme,
  showKind,
  splitApp,
  STAR,
  tap,
  tcon,
  type TVar,
  type Type,
  typeVarsOf,
  unifyKinds,
  zonk,
} from './types';

/** The library's types and classes that the language's syntax refers to. */
export interface Builtins {
  bool: TypeEntity;
  int: TypeEntity;
  integer: TypeEntity;
  double: TypeEntity;
  io: TypeEntity;
  eq: ClassEntity;
  num: ClassEntity;
  fractional: ClassEntity;
  enum: ClassEntity;
  monad: ClassEntity;
  monadFail: ClassEntity;
  /** The classes whose constraints defaulting may solve. */
  standardClasses: ReadonlySet<ClassEntity>;
  numericClasses: ReadonlySet<ClassEntity>;
}

let nextHoleId = 0;
let nextParamId = 0;

export function newDictParam(pred: Pred): DictParam {
  return { id: nextParamId++, pred };
}

export function fnType(from: Type, to: Type): Type {
  return tap(tcon(FUNCTION_TYPE), from, to);
}

export function listOf(elem: Type): Type {
  return tap(tcon(LIST_TYPE), elem);
}

export function typeError(span: Span, message: string): never {
  throw compileError(span, message);
}

/** Infers and checks types, recording the class evidence that code generation passes as dictionaries. */
export class Checker {
  level = 0;
  wanted: EvidenceHole[] = [];
  /** The types of globals whose binding group is being inferred, before they have schemes. */
  readonly globalMono = new Map<ValueEntity, Type>();

  constructor(
    readonly env: ClassEnv,
    readonly builtins: Builtins
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Unification

  unify(actual: Type, expected: Type, span: Span, context?: string): void {
    const failure = this.unifyTypes(actual, expected);
    if (!failure) return;
    const printer = new TypePrinter();
    let message: string;
    if (failure === 'occurs') {
      message = `型が合いません（無限の型になります）。${printer.show(expected)} が期待されているところに、${printer.show(actual)} があります。`;
    } else if (failure === 'kind') {
      message = `型の種類（カインド）が合いません。${printer.show(expected)} が期待されているところに、${printer.show(actual)} があります。`;
    } else if (failure === 'escape') {
      message = `型が合いません。型変数がそのスコープの外に出てしまいます（${printer.show(expected)} と ${printer.show(actual)}）。`;
    } else {
      message = `型が合いません。${printer.show(expected)} が期待されているところに、${printer.show(actual)} があります。`;
    }
    typeError(span, context ? `${message}（${context}）` : message);
  }

  /** Unifies two types, telling why they cannot be made equal. */
  private unifyTypes(a: Type, b: Type): undefined | 'mismatch' | 'occurs' | 'kind' | 'escape' {
    const x = prune(a);
    const y = prune(b);
    if (x === y) return undefined;
    if (x.tag === 'tvar' && !x.skolem) return this.bindVar(x, y);
    if (y.tag === 'tvar' && !y.skolem) return this.bindVar(y, x);
    if (x.tag === 'tcon' && y.tag === 'tcon') return x.entity === y.entity ? undefined : 'mismatch';
    if (x.tag === 'tap' && y.tag === 'tap') {
      return this.unifyTypes(x.fn, y.fn) ?? this.unifyTypes(x.arg, y.arg);
    }
    return 'mismatch';
  }

  private bindVar(variable: TVar, type: Type): undefined | 'occurs' | 'kind' | 'escape' {
    if (type.tag === 'tvar' && !type.skolem && type.level > variable.level) {
      // Bind the inner variable to the outer one, keeping the outer one's name for messages.
      return this.bindVar(type, variable);
    }
    if (occursIn(variable, type)) return 'occurs';
    if (!unifyKinds(variable.kind, kindOfType(type))) return 'kind';
    for (const inner of typeVarsOf(type)) {
      if (inner.level > variable.level) {
        if (inner.skolem) return 'escape';
        inner.level = variable.level;
      }
    }
    variable.ref = type;
    return undefined;
  }

  freshVar(kind: Kind = STAR, name?: string): TVar {
    return freshTypeVar(kind, this.level, name);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Schemes and evidence

  instantiate(scheme: Scheme, span: Span, origin: string): { type: Type; evidence: Evidence[] } {
    const args = scheme.kinds.map((kind, index) => this.freshVar(kind, scheme.names?.[index]));
    const evidence = scheme.preds.map((pred) =>
      this.want({ cls: pred.cls, type: instantiateType(pred.type, args) }, span, origin)
    );
    return { type: instantiateType(scheme.type, args), evidence };
  }

  want(pred: Pred, span: Span, origin: string): Evidence {
    const hole: EvidenceHole = { id: nextHoleId++, pred, span, origin };
    this.wanted.push(hole);
    return { kind: 'hole', hole };
  }

  /**
   * Reduces the wanted constraints by instances until each has a type variable at its head, then splits them into
   * those about the binding being generalized (retained) and those about enclosing ones (deferred).
   */
  simplify(holes: EvidenceHole[], outerLevel: number): { retained: EvidenceHole[]; deferred: EvidenceHole[] } {
    const retained: EvidenceHole[] = [];
    const deferred: EvidenceHole[] = [];
    const work = [...holes];
    while (work.length > 0) {
      const hole = work.shift() as EvidenceHole;
      if (hole.solution) continue;
      const pred = { cls: hole.pred.cls, type: zonk(hole.pred.type) };
      hole.pred = pred;
      if (hasConstructorHead(pred.type)) {
        const found = this.env.findInstance(pred);
        if (found === 'none') this.noInstance(hole);
        if (found !== 'pending') {
          const { instance, args } = found;
          for (const [index, type] of instance.equalities) this.unify(args[index], type, hole.span);
          const sub = instance.context.map((contextPred) => ({
            id: nextHoleId++,
            pred: { cls: contextPred.cls, type: instantiateType(contextPred.type, args) },
            span: hole.span,
            origin: hole.origin,
          }));
          hole.solution = { kind: 'instance', instance, args: sub.map((subHole) => ({ kind: 'hole', hole: subHole })) };
          work.push(...sub);
          continue;
        }
      }
      const vars = [...typeVarsOf(pred.type)];
      if (vars.length > 0 && vars.every((variable) => variable.level <= outerLevel)) deferred.push(hole);
      else retained.push(hole);
    }
    return { retained, deferred };
  }

  noInstance(hole: EvidenceHole): never {
    const printer = new TypePrinter();
    typeError(hole.span, `${printer.showPred(hole.pred)} のインスタンスがありません（${hole.origin}）。`);
  }

  /** Turns retained constraints into dictionary parameters, dropping those that superclasses of others give. */
  makeDictParams(holes: EvidenceHole[]): DictParam[] {
    const distinct: Pred[] = [];
    for (const hole of holes) if (!distinct.some((pred) => predsEqual(pred, hole.pred))) distinct.push(hole.pred);
    const kept = distinct.filter(
      (pred) =>
        !distinct.some(
          (other) =>
            other !== pred &&
            other.cls !== pred.cls &&
            isSubclassOf(other.cls, pred.cls) &&
            predsEqual({ cls: pred.cls, type: other.type }, pred)
        )
    );
    const params = kept.map((pred) => newDictParam(pred));
    const givens = params.map((param) => ({ pred: param.pred, evidence: { kind: 'param', param } as Evidence }));
    for (const hole of holes) {
      const evidence = entailByGivens(givens, hole.pred);
      if (!evidence) this.noInstance(hole);
      hole.solution = evidence;
    }
    return params;
  }

  /** Solves the constraints left at the top of a module, defaulting ambiguous numeric types as Haskell does. */
  solveTop(): void {
    for (let round = 0; round < 100; round++) {
      const { retained } = this.simplify(this.wanted, -1);
      this.wanted = [];
      if (retained.length === 0) return;
      const byVar = new Map<TVar, EvidenceHole[]>();
      for (const hole of retained) {
        const type = prune(hole.pred.type);
        if (type.tag !== 'tvar') this.ambiguous(hole);
        const list = byVar.get(type) ?? [];
        list.push(hole);
        byVar.set(type, list);
      }
      for (const [variable, holes] of byVar) {
        const chosen = this.defaultFor(variable, holes);
        if (!chosen) this.ambiguous(holes[0]);
        this.unify(variable, tcon(chosen), holes[0].span);
      }
      this.wanted = retained;
    }
  }

  private defaultFor(variable: TVar, holes: EvidenceHole[]): TypeEntity | undefined {
    if (pruneKind(variable.kind).tag !== 'star' && pruneKind(variable.kind).tag !== 'kvar') return undefined;
    const classes = holes.map((hole) => hole.pred.cls);
    if (!classes.some((cls) => this.builtins.numericClasses.has(cls))) return undefined;
    if (!classes.every((cls) => this.builtins.standardClasses.has(cls))) return undefined;
    for (const candidate of [this.builtins.integer, this.builtins.double]) {
      if (classes.every((cls) => this.solvable({ cls, type: tcon(candidate) }))) return candidate;
    }
    return undefined;
  }

  private solvable(pred: Pred): boolean {
    const found = this.env.findInstance(pred);
    if (typeof found === 'string') return false;
    return found.instance.context.every((contextPred) =>
      this.solvable({ cls: contextPred.cls, type: instantiateType(contextPred.type, found.args) })
    );
  }

  ambiguous(hole: EvidenceHole): never {
    const printer = new TypePrinter();
    typeError(
      hole.span,
      `型が曖昧です。${printer.showPred(hole.pred)} の型が決まりません（${hole.origin}）。型の注釈を付けてください。`
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Signatures

  /** Converts a signature into a scheme, quantifying its type variables in order of appearance. */
  sigToScheme(sig: RSigType, fixed?: { name: string; type: Type }): Scheme {
    const names: string[] = [];
    const collect = (type: RType): void => {
      if (type.k === 'var') {
        if (type.name !== fixed?.name && !names.includes(type.name)) names.push(type.name);
      } else if (type.k === 'app') {
        collect(type.fn);
        collect(type.arg);
      } else if (type.k === 'fun') {
        collect(type.from);
        collect(type.to);
      }
    };
    collect(sig.type);
    for (const constraint of sig.context) collect(constraint.type);
    const kinds: Kind[] = names.map(() => freshKindVar());
    const vars = new Map<string, Type>(names.map((name, index) => [name, { tag: 'tgen', index }]));
    const varKinds = new Map<string, Kind>(names.map((name, index) => [name, kinds[index]]));
    if (fixed) {
      vars.set(fixed.name, fixed.type);
      varKinds.set(fixed.name, kindOfType(fixed.type));
    }
    const type = this.convertType(sig.type, vars, varKinds, STAR);
    const preds = sig.context.map((constraint) => ({
      cls: constraint.cls,
      type: this.convertType(constraint.type, vars, varKinds, constraint.cls.tyvarKind),
    }));
    return { kinds: kinds.map(defaultKind), names, preds, type };
  }

  /** Converts a written type, checking its kinds and expanding synonyms. */
  convertType(type: RType, vars: ReadonlyMap<string, Type>, varKinds: ReadonlyMap<string, Kind>, expected: Kind): Type {
    const { type: result, kind } = this.convertTypeKind(type, vars, varKinds);
    if (!unifyKinds(kind, expected)) {
      typeError(
        type.span,
        `型の種類（カインド）が合いません。種類 ${showKind(expected)} の型が期待されているところに、種類 ${showKind(kind)} の型があります。`
      );
    }
    return result;
  }

  private convertTypeKind(
    type: RType,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): { type: Type; kind: Kind } {
    switch (type.k) {
      case 'var': {
        const found = vars.get(type.name);
        if (!found) typeError(type.span, `型変数 ${type.name} がスコープにありません。`);
        return { type: found, kind: varKinds.get(type.name) as Kind };
      }
      case 'fun': {
        const from = this.convertType(type.from, vars, varKinds, STAR);
        const to = this.convertType(type.to, vars, varKinds, STAR);
        return { type: fnType(from, to), kind: STAR };
      }
      case 'con':
      case 'app': {
        const args: RType[] = [];
        let head: RType = type;
        while (head.k === 'app') {
          args.unshift(head.arg);
          head = head.fn;
        }
        if (head.k === 'con' && head.entity.sort === 'synonym') {
          const entity = head.entity;
          if (args.length < entity.arity) {
            typeError(type.span, `型シノニム ${entity.name} には ${entity.arity} 個の型引数が要ります。`);
          }
          const synonymArgs = args.slice(0, entity.arity).map((arg) => this.convertTypeKind(arg, vars, varKinds));
          const paramKinds = synonymParamKinds(entity);
          for (const [index, arg] of synonymArgs.entries()) {
            if (!unifyKinds(arg.kind, paramKinds[index])) {
              typeError(args[index].span, `型の種類（カインド）が合いません（${entity.name} の型引数）。`);
            }
          }
          let result: Type = instantiateType(
            entity.synonym as Type,
            synonymArgs.map((arg) => arg.type)
          );
          let kind = kindOfType(result);
          for (const arg of args.slice(entity.arity)) {
            const converted = this.convertTypeKind(arg, vars, varKinds);
            const resultKind = freshKindVar();
            if (!unifyKinds(kind, kindArrow(converted.kind, resultKind))) {
              typeError(type.span, '型の種類（カインド）が合いません。型引数が多すぎます。');
            }
            result = tap(result, converted.type);
            kind = resultKind;
          }
          return { type: result, kind };
        }
        const headConverted =
          head.k === 'con'
            ? { type: tcon(head.entity) as Type, kind: head.entity.kind }
            : this.convertTypeKind(head, vars, varKinds);
        let result = headConverted.type;
        let kind = headConverted.kind;
        for (const arg of args) {
          const converted = this.convertTypeKind(arg, vars, varKinds);
          const resultKind = freshKindVar();
          if (!unifyKinds(kind, kindArrow(converted.kind, resultKind))) {
            const pruned = pruneKind(kind);
            typeError(
              arg.span,
              pruned.tag === 'star'
                ? '型の種類（カインド）が合いません。型引数をとらない型に、型引数を書いています。'
                : '型の種類（カインド）が合いません。'
            );
          }
          result = tap(result, converted.type);
          kind = resultKind;
        }
        return { type: result, kind };
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Expressions

  typeOfRef(ref: VarRef, span: Span, name: string, expr: Extract<RExpr, { k: 'var' }>): Type {
    if (ref.kind === 'local') {
      const local = ref.local;
      if (local.scheme) {
        const { type, evidence } = this.instantiate(local.scheme, span, `${name} の使用`);
        expr.evidence = evidence;
        return type;
      }
      if (!local.type) typeError(span, `${name} の型が決まっていません。`);
      return local.type;
    }
    const entity = ref.entity;
    const mono = this.globalMono.get(entity);
    if (mono) return mono;
    if (!entity.scheme) typeError(span, `${name} の型が決まっていません。`);
    const { type, evidence } = this.instantiate(entity.scheme, span, `${name} の使用`);
    expr.evidence = evidence;
    return type;
  }

  inferExpr(expr: RExpr): Type {
    const type = this.inferExprInner(expr);
    if (expr.k === 'var' || expr.k === 'lit' || expr.k === 'lambda') expr.type = type;
    return type;
  }

  checkExpr(expr: RExpr, expected: Type, context?: string): void {
    const actual = this.inferExpr(expr);
    this.unify(actual, expected, expr.span, context);
  }

  private inferExprInner(expr: RExpr): Type {
    switch (expr.k) {
      case 'var': {
        return this.typeOfRef(expr.ref, expr.span, expr.name, expr);
      }
      case 'con': {
        return this.instantiate(conScheme(expr.con), expr.span, expr.con.name).type;
      }
      case 'lit': {
        return this.inferLiteral(expr);
      }
      case 'app': {
        const fnType_ = this.inferExpr(expr.fn);
        const fn = prune(fnType_);
        const { head, args } = splitApp(fn);
        if (head.tag === 'tcon' && head.entity === FUNCTION_TYPE && args.length === 2) {
          this.checkExpr(expr.arg, args[0], argumentContext(expr.fn));
          return args[1];
        }
        const argType = this.inferExpr(expr.arg);
        const result = this.freshVar();
        this.unify(fn, fnType(argType, result), expr.span, '関数の適用');
        return result;
      }
      case 'lambda': {
        const paramTypes = expr.pats.map((pat) => {
          const type = this.freshVar();
          this.inferPat(pat, type);
          return type;
        });
        let result = this.inferExpr(expr.body);
        for (const paramType of paramTypes.toReversed()) result = fnType(paramType, result);
        return result;
      }
      case 'let': {
        this.inferBindGroup(expr.binds, false);
        return this.inferExpr(expr.body);
      }
      case 'if': {
        this.checkExpr(expr.cond, tcon(this.builtins.bool), 'if の条件');
        const type = this.inferExpr(expr.ifTrue);
        this.checkExpr(expr.ifFalse, type, 'then と else の型');
        return type;
      }
      case 'case': {
        const scrutineeType = this.inferExpr(expr.scrutinee);
        const result = this.freshVar();
        for (const alt of expr.alts) {
          this.inferPat(alt.pat, scrutineeType);
          this.checkRhs(alt.rhs, result);
        }
        return result;
      }
      case 'do': {
        return this.inferDo(expr);
      }
      case 'tuple': {
        const con = tupleCon(expr.elems.length);
        return tap(tcon(con.type), ...expr.elems.map((elem) => this.inferExpr(elem)));
      }
      case 'list': {
        const elem = this.freshVar();
        for (const item of expr.elems) this.checkExpr(item, elem, 'リストの要素');
        return listOf(elem);
      }
      case 'arith': {
        const elem = this.freshVar();
        this.checkExpr(expr.from, elem);
        if (expr.next) this.checkExpr(expr.next, elem);
        if (expr.to) this.checkExpr(expr.to, elem);
        expr.evidence = this.want({ cls: this.builtins.enum, type: elem }, expr.span, '範囲の式');
        return listOf(elem);
      }
      case 'comp': {
        for (const qual of expr.quals) this.inferQualifier(qual);
        return listOf(this.inferExpr(expr.expr));
      }
      case 'rsection': {
        const opType = this.inferExpr(expr.op);
        const a = this.freshVar();
        const b = this.freshVar();
        const c = this.freshVar();
        this.unify(opType, fnType(a, fnType(b, c)), expr.op.span);
        this.checkExpr(expr.right, b);
        return fnType(a, c);
      }
      case 'typed': {
        const scheme = this.sigToScheme(expr.sig);
        this.checkAgainstScheme(scheme, expr.span, (type) => this.checkExpr(expr.expr, type));
        return this.instantiate(scheme, expr.span, '型の注釈').type;
      }
      case 'recordCon': {
        const { type, fieldTypes } = this.instantiateCon(expr.con, expr.span);
        for (const fieldBind of expr.fields) {
          const position = fieldBind.field.positions.get(expr.con) as number;
          this.checkExpr(fieldBind.value, fieldTypes[position], `フィールド ${fieldBind.field.name}`);
        }
        return type;
      }
      case 'recordUpdate': {
        const target = this.inferExpr(expr.expr);
        const owner = expr.fields[0].field.type;
        const cons = owner.cons.filter((con) => expr.fields.every((fieldBind) => fieldBind.field.positions.has(con)));
        if (cons.length === 0 || !expr.fields.every((fieldBind) => fieldBind.field.type === owner)) {
          typeError(expr.span, 'これらのフィールドをすべて持つ構成子がありません。');
        }
        expr.cons = cons;
        const { type, fieldTypes } = this.instantiateCon(cons[0], expr.span);
        this.unify(target, type, expr.expr.span, 'レコードの更新');
        for (const fieldBind of expr.fields) {
          const position = fieldBind.field.positions.get(cons[0]) as number;
          this.checkExpr(fieldBind.value, fieldTypes[position], `フィールド ${fieldBind.field.name}`);
        }
        return type;
      }
    }
  }

  instantiateCon(con: ConInfo, span: Span): { type: Type; fieldTypes: Type[] } {
    const args = typeParamKinds(con.type).map((kind) => this.freshVar(kind));
    void span;
    return {
      type: tap(tcon(con.type), ...args),
      fieldTypes: con.fieldTypes.map((fieldType) => instantiateType(fieldType, args)),
    };
  }

  private inferLiteral(expr: Extract<RExpr, { k: 'lit' }>): Type {
    switch (expr.lit.kind) {
      case 'int': {
        const type = this.freshVar(STAR);
        expr.evidence = this.want({ cls: this.builtins.num, type }, expr.span, `リテラル ${expr.lit.value}`);
        return type;
      }
      case 'frac': {
        const type = this.freshVar(STAR);
        expr.evidence = this.want({ cls: this.builtins.fractional, type }, expr.span, `リテラル ${expr.lit.text}`);
        return type;
      }
      case 'char': {
        return tcon(CHAR_TYPE);
      }
      case 'string': {
        return listOf(tcon(CHAR_TYPE));
      }
    }
  }

  private inferDo(expr: Extract<RExpr, { k: 'do' }>): Type {
    const needsMonad = expr.stmts.some(
      (stmt, index) => stmt.k === 'bind' || (stmt.k === 'exp' && index < expr.stmts.length - 1)
    );
    const monad = this.freshVar(kindArrow(STAR, STAR), 'm');
    if (needsMonad) {
      expr.monad = this.want({ cls: this.builtins.monad, type: monad }, expr.span, 'do');
      expr.monadType = monad;
    }
    let result: Type = this.freshVar();
    for (const [index, stmt] of expr.stmts.entries()) {
      const isLast = index === expr.stmts.length - 1;
      switch (stmt.k) {
        case 'bind': {
          const value = this.freshVar();
          this.checkExpr(stmt.expr, tap(monad, value), 'do の文');
          this.inferPat(stmt.pat, value);
          if (isFailable(stmt.pat)) {
            stmt.fail = this.want({ cls: this.builtins.monadFail, type: monad }, stmt.span, '失敗しうるパターンの束縛');
          }
          break;
        }
        case 'let': {
          this.inferBindGroup(stmt.binds, false);
          break;
        }
        case 'exp': {
          if (isLast) {
            result = this.inferExpr(stmt.expr);
            if (needsMonad) this.unify(result, tap(monad, this.freshVar()), stmt.expr.span, 'do の最後の文');
          } else {
            this.checkExpr(stmt.expr, tap(monad, this.freshVar()), 'do の文');
          }
          break;
        }
      }
    }
    return result;
  }

  private inferQualifier(qual: RStmt): void {
    switch (qual.k) {
      case 'bind': {
        const elem = this.freshVar();
        this.checkExpr(qual.expr, listOf(elem), '内包表記の生成元');
        this.inferPat(qual.pat, elem);
        break;
      }
      case 'let': {
        this.inferBindGroup(qual.binds, false);
        break;
      }
      case 'exp': {
        this.checkExpr(qual.expr, tcon(this.builtins.bool), '内包表記の条件');
        break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Patterns

  inferPat(pat: RPat, type: Type): void {
    switch (pat.k) {
      case 'var': {
        pat.local.type = type;
        break;
      }
      case 'wild': {
        break;
      }
      case 'as': {
        pat.local.type = type;
        this.inferPat(pat.pat, type);
        break;
      }
      case 'lit': {
        pat.type = type;
        switch (pat.lit.kind) {
          case 'int': {
            pat.num = this.want({ cls: this.builtins.num, type }, pat.span, `リテラル ${pat.lit.value}`);
            pat.eq = this.want({ cls: this.builtins.eq, type }, pat.span, 'リテラルのパターン');
            break;
          }
          case 'frac': {
            pat.num = this.want({ cls: this.builtins.fractional, type }, pat.span, `リテラル ${pat.lit.text}`);
            pat.eq = this.want({ cls: this.builtins.eq, type }, pat.span, 'リテラルのパターン');
            break;
          }
          case 'char': {
            this.unify(tcon(CHAR_TYPE), type, pat.span);
            break;
          }
          case 'string': {
            this.unify(listOf(tcon(CHAR_TYPE)), type, pat.span);
            pat.eq = this.want({ cls: this.builtins.eq, type }, pat.span, 'リテラルのパターン');
            break;
          }
        }
        break;
      }
      case 'con': {
        const { type: conType, fieldTypes } = this.instantiateCon(pat.con, pat.span);
        this.unify(conType, type, pat.span, `構成子 ${pat.con.name} のパターン`);
        for (const [index, arg] of pat.args.entries()) this.inferPat(arg, fieldTypes[index]);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Bindings

  checkRhs(rhs: RRhs, expected: Type): void {
    this.inferBindGroup(rhs.where, false);
    if (rhs.body.k === 'plain') {
      this.checkExpr(rhs.body.expr, expected);
      return;
    }
    for (const branch of rhs.body.branches) {
      for (const guard of branch.guards) {
        if (guard.k === 'bool') this.checkExpr(guard.expr, tcon(this.builtins.bool), 'ガード');
        else this.inferBindGroup(guard.binds, false);
      }
      this.checkExpr(branch.expr, expected);
    }
  }

  /** Infers a binding's body against its type: each clause's patterns and right-hand side. */
  private inferBindingBody(binding: RBinding, type: Type): void {
    if (binding.k === 'pat') {
      this.inferPat(binding.pat, type);
      this.checkRhs(binding.rhs, type);
      return;
    }
    for (const clause of binding.clauses) {
      let remaining = type;
      for (const pat of clause.pats) {
        const param = this.freshVar();
        const result = this.freshVar();
        this.unify(remaining, fnType(param, result), clause.span, `${bindingLabel(binding)} の引数`);
        this.inferPat(pat, param);
        remaining = result;
      }
      this.checkRhs(clause.rhs, remaining);
    }
  }

  inferBindGroup(group: RBindGroup, isTop: boolean): void {
    void isTop;
    const explicit: { binding: Extract<RBinding, { k: 'fun' }>; scheme: Scheme }[] = [];
    const implicit: RBinding[] = [];
    for (const binding of group.bindings) {
      if (binding.k === 'fun' && binding.sig) {
        const scheme = this.sigToScheme(binding.sig);
        setBinderScheme(binding.binder, scheme);
        explicit.push({ binding, scheme });
      } else {
        implicit.push(binding);
      }
    }
    for (const scc of dependencyOrder(implicit)) this.inferImplicit(scc);
    for (const { binding, scheme } of explicit) {
      binding.dictParams = this.checkAgainstScheme(scheme, binding.span, (type) =>
        this.inferBindingBody(binding, type)
      );
    }
  }

  /** Infers an implicitly typed binding group and generalizes it. */
  private inferImplicit(bindings: RBinding[]): void {
    const outer = this.level;
    this.level++;
    const saved = this.wanted;
    this.wanted = [];
    const monoTypes = new Map<RBinding, Type>();
    for (const binding of bindings) {
      const type = this.freshVar();
      monoTypes.set(binding, type);
      if (binding.k === 'fun') this.setMono(binding.binder, type);
    }
    for (const binding of bindings) {
      if (binding.k === 'pat') {
        // A pattern binding's variables are monomorphic within the group.
        this.inferPat(binding.pat, monoTypes.get(binding) as Type);
        for (const [index, local] of binding.binders.entries()) {
          const global = binding.globals?.[index];
          if (global) this.globalMono.set(global, local.type as Type);
        }
      }
    }
    for (const binding of bindings) {
      const type = monoTypes.get(binding) as Type;
      if (binding.k === 'pat') this.checkRhs(binding.rhs, type);
      else this.inferBindingBody(binding, type);
    }
    this.level = outer;
    const inner = this.wanted;
    this.wanted = saved;
    const { retained, deferred } = this.simplify(inner, outer);
    const restricted = bindings.some((binding) => binding.k === 'pat' || binding.clauses[0].pats.length === 0);
    const bindingTypes = new Set<TVar>();
    for (const binding of bindings) {
      const types =
        binding.k === 'pat' ? binding.binders.map((local) => local.type as Type) : [monoTypes.get(binding) as Type];
      for (const type of types)
        for (const variable of typeVarsOf(type)) if (variable.level > outer) bindingTypes.add(variable);
    }
    const kept: EvidenceHole[] = [];
    for (const hole of retained) {
      const vars = [...typeVarsOf(hole.pred.type)].filter((variable) => variable.level > outer);
      if (restricted || vars.some((variable) => !bindingTypes.has(variable))) {
        for (const variable of vars) variable.level = outer;
        deferred.push(hole);
      } else {
        kept.push(hole);
      }
    }
    const params = this.makeDictParams(kept);
    for (const binding of bindings) {
      binding.dictParams = params;
      if (binding.k === 'pat') {
        for (const [index, local] of binding.binders.entries()) {
          local.scheme = this.generalize(local.type as Type, params, outer);
          const global = binding.globals?.[index];
          if (global) {
            global.scheme = local.scheme;
            this.globalMono.delete(global);
          }
        }
      } else {
        const scheme = this.generalize(monoTypes.get(binding) as Type, params, outer);
        setBinderScheme(binding.binder, scheme);
        if (binding.binder.kind === 'global') this.globalMono.delete(binding.binder.entity);
      }
    }
    this.wanted.push(...deferred);
  }

  private setMono(binder: Binder, type: Type): void {
    if (binder.kind === 'local') binder.local.type = type;
    else this.globalMono.set(binder.entity, type);
  }

  /** Quantifies the variables of a type that no enclosing binding shares, with the given dictionaries' constraints. */
  generalize(type: Type, params: readonly DictParam[], outer: number): Scheme {
    const zonked = zonk(type);
    const vars: TVar[] = [];
    const add = (candidate: Type): void => {
      for (const variable of typeVarsOf(candidate))
        if (variable.level > outer && !vars.includes(variable)) vars.push(variable);
    };
    add(zonked);
    for (const param of params) add(param.pred.type);
    return {
      kinds: vars.map((variable) => defaultKind(variable.kind)),
      names: vars.map((variable) => variable.name ?? 'a'),
      preds: params.map((param) => ({ cls: param.pred.cls, type: quantifyType(param.pred.type, vars) })),
      type: quantifyType(zonked, vars),
    };
  }

  /**
   * Checks code against a scheme with rigid type variables, solving its constraints from the scheme's context, and
   * returns the dictionaries the code takes.
   */
  checkAgainstScheme(
    scheme: Scheme,
    span: Span,
    check: (type: Type) => void,
    extraGivens: { pred: Pred; evidence: Evidence }[] = []
  ): DictParam[] {
    const outer = this.level;
    this.level++;
    const skolems = scheme.kinds.map((kind, index) => freshSkolem(kind, this.level, scheme.names?.[index] ?? 'a'));
    const type = instantiateType(scheme.type, skolems);
    const params = scheme.preds.map((pred) =>
      newDictParam({ cls: pred.cls, type: instantiateType(pred.type, skolems) })
    );
    const givens = [
      ...extraGivens,
      ...params.map((param) => ({ pred: param.pred, evidence: { kind: 'param', param } as Evidence })),
    ];
    const saved = this.wanted;
    this.wanted = [];
    check(type);
    this.level = outer;
    const inner = this.wanted;
    this.wanted = saved;
    const { retained, deferred } = this.simplify(inner, outer);
    for (const hole of retained) {
      const evidence = entailByGivens(givens, hole.pred);
      if (evidence) {
        hole.solution = evidence;
        continue;
      }
      const vars = [...typeVarsOf(hole.pred.type)];
      if (vars.every((variable) => !variable.skolem)) {
        // An ambiguous constraint, which defaulting at the top may solve.
        for (const variable of vars) if (variable.level > outer) variable.level = outer;
        deferred.push(hole);
        continue;
      }
      const printer = new TypePrinter();
      typeError(
        hole.span,
        `${printer.showPred(hole.pred)} を導けません（${hole.origin}）。型シグネチャの文脈に制約を加えてください。`
      );
    }
    this.wanted.push(...deferred);
    return params;
  }
}

function argumentContext(fn: RExpr): string {
  let head = fn;
  let index = 1;
  while (head.k === 'app') {
    head = head.fn;
    index++;
  }
  const name = head.k === 'var' ? head.name : head.k === 'con' ? head.con.name : undefined;
  return name ? `${name} の${index}番目の引数` : '関数の引数';
}

function bindingLabel(binding: RBinding): string {
  if (binding.k === 'pat') return 'パターン束縛';
  return binding.binder.kind === 'local' ? binding.binder.local.name : binding.binder.entity.name;
}

function setBinderScheme(binder: Binder, scheme: Scheme): void {
  if (binder.kind === 'local') binder.local.scheme = scheme;
  else binder.entity.scheme = scheme;
}

export function typeParamKinds(type: TypeEntity): Kind[] {
  const kinds: Kind[] = [];
  let kind = pruneKind(type.kind);
  while (kind.tag === 'arrow') {
    kinds.push(kind.from);
    kind = pruneKind(kind.to);
  }
  return kinds;
}

function synonymParamKinds(type: TypeEntity): Kind[] {
  return typeParamKinds(type).slice(0, type.arity);
}

export function conScheme(con: ConInfo): Scheme {
  const kinds = typeParamKinds(con.type);
  let type: Type = tap(tcon(con.type), ...kinds.map((_, index): Type => ({ tag: 'tgen', index })));
  for (const field of con.fieldTypes.toReversed()) type = fnType(field, type);
  return { kinds, preds: [], type };
}

/** Whether matching a pattern may fail, which makes a `do` binding need `MonadFail`. */
export function isFailable(pat: RPat): boolean {
  switch (pat.k) {
    case 'var':
    case 'wild': {
      return false;
    }
    case 'as': {
      return isFailable(pat.pat);
    }
    case 'lit': {
      return true;
    }
    case 'con': {
      return pat.con.type.cons.length > 1 || pat.args.some(isFailable);
    }
  }
}

/** Orders implicitly typed bindings into strongly connected components, each after those it depends on. */
function dependencyOrder(bindings: RBinding[]): RBinding[][] {
  const owner = new Map<LocalVar | ValueEntity, number>();
  for (const [index, binding] of bindings.entries()) {
    if (binding.k === 'fun') {
      owner.set(binding.binder.kind === 'local' ? binding.binder.local : binding.binder.entity, index);
    } else {
      for (const local of binding.binders) owner.set(local, index);
      for (const global of binding.globals ?? []) owner.set(global, index);
    }
  }
  const edges = bindings.map((binding) => {
    const refs = new Set<number>();
    collectBindingRefs(binding, (key) => {
      const target = owner.get(key);
      if (target !== undefined) refs.add(target);
    });
    return [...refs];
  });
  // Tarjan's algorithm, which emits components in reverse topological order: dependencies first.
  const indexOf = Array.from({ length: bindings.length }, () => -1);
  const lowLink = Array.from({ length: bindings.length }, () => 0);
  const onStack = Array.from({ length: bindings.length }, () => false);
  const stack: number[] = [];
  const result: RBinding[][] = [];
  let counter = 0;
  const strongConnect = (node: number): void => {
    indexOf[node] = counter;
    lowLink[node] = counter;
    counter++;
    stack.push(node);
    onStack[node] = true;
    for (const next of edges[node]) {
      if (indexOf[next] < 0) {
        strongConnect(next);
        lowLink[node] = Math.min(lowLink[node], lowLink[next]);
      } else if (onStack[next]) {
        lowLink[node] = Math.min(lowLink[node], indexOf[next]);
      }
    }
    if (lowLink[node] === indexOf[node]) {
      const component: RBinding[] = [];
      for (;;) {
        const member = stack.pop() as number;
        onStack[member] = false;
        component.push(bindings[member]);
        if (member === node) break;
      }
      result.push(component.toSorted((a, b) => bindings.indexOf(a) - bindings.indexOf(b)));
    }
  };
  for (let node = 0; node < bindings.length; node++) if (indexOf[node] < 0) strongConnect(node);
  return result;
}

function collectBindingRefs(binding: RBinding, visit: (key: LocalVar | ValueEntity) => void): void {
  if (binding.k === 'pat') {
    collectRhsRefs(binding.rhs, visit);
    return;
  }
  for (const clause of binding.clauses) collectRhsRefs(clause.rhs, visit);
}

function collectRhsRefs(rhs: RRhs, visit: (key: LocalVar | ValueEntity) => void): void {
  for (const binding of rhs.where.bindings) collectBindingRefs(binding, visit);
  if (rhs.body.k === 'plain') {
    collectExprRefs(rhs.body.expr, visit);
    return;
  }
  for (const branch of rhs.body.branches) {
    for (const guard of branch.guards) {
      if (guard.k === 'bool') collectExprRefs(guard.expr, visit);
      else for (const binding of guard.binds.bindings) collectBindingRefs(binding, visit);
    }
    collectExprRefs(branch.expr, visit);
  }
}

export function collectExprRefs(expr: RExpr, visit: (key: LocalVar | ValueEntity) => void): void {
  switch (expr.k) {
    case 'var': {
      visit(expr.ref.kind === 'local' ? expr.ref.local : expr.ref.entity);
      break;
    }
    case 'con':
    case 'lit': {
      break;
    }
    case 'app': {
      collectExprRefs(expr.fn, visit);
      collectExprRefs(expr.arg, visit);
      break;
    }
    case 'lambda': {
      collectExprRefs(expr.body, visit);
      break;
    }
    case 'let': {
      for (const binding of expr.binds.bindings) collectBindingRefs(binding, visit);
      collectExprRefs(expr.body, visit);
      break;
    }
    case 'if': {
      collectExprRefs(expr.cond, visit);
      collectExprRefs(expr.ifTrue, visit);
      collectExprRefs(expr.ifFalse, visit);
      break;
    }
    case 'case': {
      collectExprRefs(expr.scrutinee, visit);
      for (const alt of expr.alts) collectRhsRefs(alt.rhs, visit);
      break;
    }
    case 'do':
    case 'comp': {
      const stmts = expr.k === 'do' ? expr.stmts : expr.quals;
      for (const stmt of stmts) {
        if (stmt.k === 'let') for (const binding of stmt.binds.bindings) collectBindingRefs(binding, visit);
        else collectExprRefs(stmt.expr, visit);
      }
      if (expr.k === 'comp') collectExprRefs(expr.expr, visit);
      break;
    }
    case 'tuple':
    case 'list': {
      for (const elem of expr.elems) collectExprRefs(elem, visit);
      break;
    }
    case 'arith': {
      collectExprRefs(expr.from, visit);
      if (expr.next) collectExprRefs(expr.next, visit);
      if (expr.to) collectExprRefs(expr.to, visit);
      break;
    }
    case 'rsection': {
      collectExprRefs(expr.op, visit);
      collectExprRefs(expr.right, visit);
      break;
    }
    case 'typed': {
      collectExprRefs(expr.expr, visit);
      break;
    }
    case 'recordCon': {
      for (const field of expr.fields) collectExprRefs(field.value, visit);
      break;
    }
    case 'recordUpdate': {
      collectExprRefs(expr.expr, visit);
      for (const field of expr.fields) collectExprRefs(field.value, visit);
      break;
    }
  }
}
