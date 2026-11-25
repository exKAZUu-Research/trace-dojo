// code-gauge-allow-file fileNcss -- The type checker keeps its inference rules beside the substitution state they share.
import { LIMITS } from '../interpreter/limits';
import {
  CHAR_TYPE,
  COERCIBLE_CLASS,
  CONSTRAINT_TYPE_CLASS,
  EQUALITY_CLASS,
  EQUALITY_TYPES,
  FUNCTION_TYPE,
  HAS_FIELD_CLASS,
  HAS_FIELD_TYPES,
  IMPLICIT_CLASS,
  IMPLICIT_TYPES,
  LIST_TYPE,
  symbolType,
  tupleCon,
  UNIT_TYPE,
} from './builtinTypes';
import { type ClassEnv, entailByGivens, hasConstructorHead, impliedBySuperclasses, predsEqual } from './classEnv';
import { solveCoercible } from './coercible';
import { dependencyOrder } from './dependencies';
import type { ClassEntity, ConInfo, DictParam, Evidence, EvidenceHole, TypeEntity, ValueEntity } from './entities';
import { compileError } from './errors';
import { freshKinds } from './kindTemplates';
import { checkLinearUses, linearLocals } from './linearity';
import { TypePrinter } from './prettyType';
import {
  type Binder,
  type LocalVar,
  type RBindGroup,
  type RBinding,
  type RConstraint,
  type RExpr,
  type RFieldBind,
  type RPat,
  type RRhs,
  type RSigType,
  type RStmt,
  type RType,
  type VarRef,
} from './rast';
import { RecursionBudget } from './recursionBudget';
import type { Span } from './syntax';
import { constraintPreds, TypeConversion } from './typeConversion';
import { walkGraph } from './typeGraph';
import {
  couldMatch,
  defaultKind,
  freshKindVar,
  freshSkolem,
  freshTypeVar,
  functionParts,
  instantiateType,
  isFamilyApplication,
  type Kind,
  kindArrow,
  kindOfType,
  matchType,
  occursIn,
  parameterKinds,
  type Pred,
  prune,
  pruneKind,
  quantifyType,
  type Scheme,
  splitApp,
  STAR,
  substituteBound,
  tap,
  tcon,
  type TForall,
  type TVar,
  type Type,
  typeChildren,
  typesEqual,
  typeVarsOf,
  unifyKinds,
  unifyTypes,
  zonk,
} from './types';

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

  standardClasses: ReadonlySet<ClassEntity>;
  derivableClasses: ReadonlySet<ClassEntity>;
  numericClasses: ReadonlySet<ClassEntity>;
}

let nextHoleId = 0;
let nextParamId = 0;

/** The classes whose constraints alone let ExtendedDefaultRules default a type variable. */
const INTERACTIVE_CLASSES = new Set(['Show', 'Eq', 'Ord', 'Foldable', 'Traversable']);

/** The library's classes of type-level literals, `KnownNat` and `KnownSymbol`, which their values solve. */
let literalClasses: { nat: ClassEntity; symbol: ClassEntity } | undefined;

export function setLiteralClasses(nat: ClassEntity, symbol: ClassEntity): void {
  literalClasses = { nat, symbol };
}

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

/** The state of a construct whose patterns may give existential types, constraints, and GADT equalities. */
interface PatternScope {
  outer: number;
  /** The wanted constraints outside the scope, set once a pattern gives something the scope solves under. */
  savedWanted?: EvidenceHole[];
  givens: { pred: Pred; evidence: Evidence }[];
  /** The rigid types GADT equalities stand for in the scope. */
  assumed: TVar[];
}

export class Checker {
  private readonly recursion = new RecursionBudget();
  private readonly patternScopes: PatternScope[] = [];
  level = 0;
  wanted: EvidenceHole[] = [];

  readonly globalMono = new Map<ValueEntity, Type>();
  private reductionsRemaining = LIMITS.maxOperations;
  private readonly typeConversion = new TypeConversion();
  private scopedTypes: ReadonlyMap<string, Type> = new Map();
  /** The types an ambiguous type variable may default to, in order, which a `default` declaration replaces. */
  defaultTypes: Type[] | undefined;
  /** The candidates of `default C (...)` declarations, by class. */
  readonly namedDefaults = new Map<ClassEntity, Type[]>();
  set polyKinds(value: boolean) {
    this.typeConversion.polyKinds = value;
  }

  get polyKinds(): boolean {
    return this.typeConversion.polyKinds;
  }

  /** Whether AllowAmbiguousTypes lets a signature have variables only its constraints mention. */
  allowAmbiguousTypes = false;
  /** Whether a binding without arguments or a signature stays monomorphic, as the monomorphism restriction says. */
  monomorphismRestriction = true;
  /** Whether ExtendedDefaultRules relaxes defaulting as GHCi does. */
  extendedDefaults = false;
  /** The typed holes found so far with their types, which the module reports once it is checked. */
  readonly holes: { hole: Extract<RExpr, { k: 'hole' }>; type: Type }[] = [];

  constructor(
    readonly env: ClassEnv,
    readonly builtins: Builtins
  ) {}

  unify(actual: Type, expected: Type, span: Span, context?: string): void {
    const bind = (variable: TVar, type: Type): ReturnType<Checker['bindVar']> => this.bindVar(variable, type);
    const family = (x: Type, y: Type): ReturnType<typeof unifyTypes> => {
      const left = this.reduceFamilies(x);
      const right = this.reduceFamilies(y);
      const flexible = [left, right].find((side) => side.tag === 'tvar' && !side.skolem);
      if (flexible && (isFamilyApplication(left) || isFamilyApplication(right))) {
        return bind(flexible as TVar, flexible === left ? right : left);
      }
      if (isFamilyApplication(left) || isFamilyApplication(right)) {
        if (!typesEqual(left, right)) {
          this.want({ cls: EQUALITY_CLASS, type: tap(tcon(EQUALITY_TYPES), left, right) }, span, context ?? '型族');
        }
        return undefined;
      }
      return unifyTypes(left, right, bind, family);
    };
    const failure = unifyTypes(actual, expected, bind, family);
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

  instantiate(scheme: Scheme, span: Span, origin: string): { type: Type; evidence: Evidence[] } {
    const args = freshKinds(scheme.kinds).map((kind, index) => this.freshVar(kind, scheme.names?.[index]));
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

  // code-gauge-allow functionCognitiveComplexity -- Context reduction follows the steps of the Haskell report in one loop.
  // code-gauge-allow functionNcss -- Reduction and its depth/work guards operate on the same constraint queue.
  simplify(
    holes: EvidenceHole[],
    outerLevel: number,
    givens: { pred: Pred; evidence: Evidence }[] = []
  ): { retained: EvidenceHole[]; deferred: EvidenceHole[] } {
    const retained: EvidenceHole[] = [];
    const deferred: EvidenceHole[] = [];
    givens = normalizeGivens(givens);
    const work = [...holes];
    const depths = new Map<EvidenceHole, number>();
    for (let index = 0; index < work.length; index++) {
      const hole = work[index];
      const depth = depths.get(hole) ?? 0;
      if (--this.reductionsRemaining < 0 || depth > 200) {
        typeError(hole.span, '型クラスの制約の計算が上限を超えました。');
      }
      if (hole.solution) continue;
      const zonked = zonk(hole.pred.type);
      const pred = {
        cls: hole.pred.cls,
        type: hole.pred.cls === EQUALITY_CLASS ? zonked : this.reduceFamilies(zonked),
      };
      hole.pred = pred;
      const outcome = this.solveBuiltin(hole, givens);
      if (outcome === 'solved') continue;
      if (outcome === 'retained') {
        retained.push(hole);
        continue;
      }
      if (outcome === 'again') {
        index--;
        continue;
      }
      const given = entailByGivens(givens, pred);
      if (given) {
        hole.solution = given;
        continue;
      }
      if (pred.cls.fundeps?.length) this.improveByFundeps(pred, hole.span, givens);
      const sub = this.solveByInstance(hole);
      if (sub) {
        for (const child of sub) depths.set(child, depth + 1);
        work.push(...sub);
        continue;
      }
      const vars = [...typeVarsOf(pred.type)];
      if (vars.length > 0 && vars.every((variable) => variable.level <= outerLevel)) deferred.push(hole);
      else retained.push(hole);
    }
    return { retained, deferred };
  }

  /**
   * Solves a constraint of a class the checker knows itself: type-level literals, implicit parameters, constraints
   * written as types, `Coercible`, `HasField`, and equalities. `retained` leaves the constraint for later, `again`
   * looks at it once more as the class it turned out to be, and `undefined` leaves it to givens and instances.
   */
  private solveBuiltin(
    hole: EvidenceHole,
    givens: readonly { pred: Pred; evidence: Evidence }[]
  ): 'solved' | 'retained' | 'again' | undefined {
    const { pred } = hole;
    if (pred.cls === literalClasses?.nat || pred.cls === literalClasses?.symbol) {
      const literal = prune(this.reduceFamilies(pred.type));
      if (literal.tag === 'tcon' && literal.entity.literal !== undefined) {
        hole.solution = { kind: 'literal', value: literal.entity.literal };
        return 'solved';
      }
      if (literal.tag === 'tcon' || literal.tag === 'tap') this.noInstance(hole);
      return undefined;
    }
    switch (pred.cls) {
      case IMPLICIT_CLASS: {
        return this.solveImplicit(hole, givens);
      }
      case CONSTRAINT_TYPE_CLASS: {
        const preds = constraintPreds(pred.type);
        if (preds.length !== 1) {
          typeError(hole.span, '制約のタプルを型変数の制約に当てはめることは、この採点環境では使えません。');
        }
        if (preds[0].cls === CONSTRAINT_TYPE_CLASS) return undefined;
        hole.pred = preds[0];
        return 'again';
      }
      case COERCIBLE_CLASS: {
        hole.solution = solveCoercible(this, pred, givens, hole.span);
        return hole.solution ? 'solved' : 'retained';
      }
      case HAS_FIELD_CLASS: {
        hole.solution = this.solveHasField(pred, hole.span);
        return hole.solution ? 'solved' : undefined;
      }
      case EQUALITY_CLASS: {
        return this.solveEquality(hole);
      }
      default: {
        return undefined;
      }
    }
  }

  private solveImplicit(
    hole: EvidenceHole,
    givens: readonly { pred: Pred; evidence: Evidence }[]
  ): 'solved' | undefined {
    const [name, type] = splitApp(hole.pred.type).args;
    const given = givens.find(
      (candidate) => candidate.pred.cls === IMPLICIT_CLASS && typesEqual(splitApp(candidate.pred.type).args[0], name)
    );
    if (!given) return undefined;
    this.unify(type, splitApp(given.pred.type).args[1], hole.span, `暗黙のパラメータ（${hole.origin}）`);
    hole.solution = given.evidence;
    return 'solved';
  }

  /**
   * Solves `a ~ b` by binding an unknown side to the other, or by unifying the sides; an application of a type
   * family that cannot reduce yet leaves the equality for later.
   */
  private solveEquality(hole: EvidenceHole): 'solved' | 'retained' {
    const [left, right] = splitApp(hole.pred.type).args.map((side) => this.reduceFamilies(side));
    const flexibleSide = [left, right].find((side) => {
      const pruned = prune(side);
      return pruned.tag === 'tvar' && !pruned.skolem;
    });
    if (flexibleSide) {
      const other = prune(flexibleSide === left ? right : left);
      if (prune(flexibleSide) !== other) {
        const failure = this.bindVar(prune(flexibleSide) as TVar, other);
        if (failure) this.unify(left, right, hole.span, `型の等しさの制約（${hole.origin}）`);
      }
      hole.solution = { kind: 'equality' };
      return 'solved';
    }
    if (!typesEqual(left, right) && (isFamilyApplication(left) || isFamilyApplication(right))) return 'retained';
    this.unify(left, right, hole.span, `型の等しさの制約（${hole.origin}）`);
    hole.solution = { kind: 'equality' };
    return 'solved';
  }

  /**
   * Solves a constraint by the instance that matches it, giving the constraints of the instance's context to solve
   * next, or `undefined` when no instance decides it yet.
   */
  private solveByInstance(hole: EvidenceHole): EvidenceHole[] | undefined {
    const { pred } = hole;
    const unsolvable = pred.cls.packed && typeVarsOf(pred.type).size > 0 && this.env.findInstance(pred) === 'none';
    // An instance for any type, `instance C a`, solves a constraint on a rigid type too.
    const rigidHead = splitApp(pred.type).head;
    const anyType =
      rigidHead.tag === 'tvar' &&
      rigidHead.skolem === true &&
      this.env.instancesOf(pred.cls).some((instance) => splitApp(instance.head).head.tag === 'tgen');
    if ((!hasConstructorHead(pred.type) && !anyType) || unsolvable) return undefined;
    const found = this.instanceFor(hole);
    if (found === 'pending') return undefined;
    const { instance, args } = found;
    for (const [index, type] of instance.equalities) this.unify(args[index], type, hole.span);
    const sub = instance.context.map((contextPred): EvidenceHole => ({
      id: nextHoleId++,
      pred: { cls: contextPred.cls, type: instantiateType(contextPred.type, args) },
      span: hole.span,
      origin: hole.origin,
    }));
    hole.solution = { kind: 'instance', instance, args: sub.map((subHole) => ({ kind: 'hole', hole: subHole })) };
    return sub;
  }

  /**
   * Improves a constraint of a class with functional dependencies: when an instance or a given constraint determines
   * the arguments that depend on the ones the constraint already has, the dependent arguments must be theirs.
   */
  private improveByFundeps(pred: Pred, span: Span, givens: readonly { pred: Pred }[]): void {
    const args = splitApp(pred.type).args;
    for (const fundep of pred.cls.fundeps ?? []) {
      for (const instance of this.env.instancesOf(pred.cls)) {
        const instanceArgs = splitApp(instance.head).args;
        const bindings: (Type | undefined)[] = [];
        if (!fundep.from.every((index) => matchType(instanceArgs[index], args[index], bindings))) continue;
        const fresh = instance.kinds.map((kind, index) => bindings[index] ?? this.freshVar(kind));
        for (const index of fundep.to) this.unify(args[index], instantiateType(instanceArgs[index], fresh), span);
      }
      for (const given of givens) {
        if (given.pred.cls !== pred.cls) continue;
        const givenArgs = splitApp(zonk(given.pred.type)).args;
        if (!fundep.from.every((index) => typesEqual(givenArgs[index], args[index]))) continue;
        for (const index of fundep.to) this.unify(args[index], givenArgs[index], span);
      }
    }
  }

  /**
   * Solves `HasField "f" r a` once `r` is a known data type: with its field `f`, whose type `a` then is; a type
   * without the field fails, and an unknown `r` leaves the constraint for later.
   */
  private solveHasField(pred: Pred, span: Span): Evidence | undefined {
    const [label, record, field] = splitApp(pred.type).args.map(prune);
    const { head, args } = splitApp(record);
    if (head.tag !== 'tcon' || label.tag !== 'tcon') return undefined;
    const info = head.entity.fields.get(String(label.entity.literal));
    if (!info || head.entity.sort !== 'data') {
      typeError(span, `型 ${head.entity.name} には、フィールド ${String(label.entity.literal)} がありません。`);
    }
    this.unify(field, instantiateType(info.fieldType, args), span, `フィールド ${info.name} の型`);
    return { kind: 'field', field: info };
  }

  /** Reduces the type family applications of a type by their equations, as far as its known parts allow. */
  reduceFamilies(type: Type, depth = 0): Type {
    if (depth > 200) typeError({ row: 0, col: 0, endRow: 0, endCol: 0 }, '型族の計算が上限を超えました。');
    const pruned = prune(type);
    if (pruned.tag !== 'tap' && !(pruned.tag === 'tcon' && pruned.entity.sort === 'family')) return pruned;
    const { head, args } = splitApp(pruned);
    const reducedArgs = args.map((arg) => this.reduceFamilies(arg, depth + 1));
    if (head.tag === 'tcon' && head.entity.sort === 'family' && args.length >= head.entity.arity) {
      const reduced = this.reduceFamilyApplication(head.entity, reducedArgs.slice(0, head.entity.arity));
      if (reduced) return this.reduceFamilies(tap(reduced, ...reducedArgs.slice(head.entity.arity)), depth + 1);
    }
    return reducedArgs.every((arg, index) => arg === args[index]) ? pruned : tap(head, ...reducedArgs);
  }

  /**
   * The type a family's application reduces to by the first equation that matches, or `undefined` when none does
   * yet; for a closed family, an earlier equation that could still match stops the search.
   */
  private reduceFamilyApplication(family: TypeEntity, args: Type[]): Type | undefined {
    if (family.reduceBuiltin) return family.reduceBuiltin(args);
    for (const equation of family.equations ?? []) {
      const bindings: (Type | undefined)[] = [];
      if (equation.lhs.every((pattern, index) => matchType(pattern, args[index], bindings))) {
        return instantiateType(
          equation.rhs,
          equation.kinds.map((kind, index) => bindings[index] ?? this.freshVar(kind))
        );
      }
      if (family.closed && equation.lhs.every((pattern, index) => couldMatch(pattern, args[index]))) return undefined;
    }
    return undefined;
  }

  noInstance(hole: EvidenceHole): never {
    const printer = new TypePrinter();
    typeError(hole.span, `${printer.showPred(hole.pred)} のインスタンスがありません（${hole.origin}）。`);
  }

  /**
   * Solves the `Coercible` constraints whose unknown types nothing visible (the given types) can decide any more,
   * by GHC's defaulting of an unknown side to the other, giving back the constraints left.
   */
  private defaultCoercible(holes: EvidenceHole[], visible: readonly Type[]): EvidenceHole[] {
    const shown = new Set(visible.flatMap((type) => [...typeVarsOf(zonk(type))]));
    return holes.filter((hole) => {
      if (hole.pred.cls !== COERCIBLE_CLASS) return true;
      if ([...typeVarsOf(zonk(hole.pred.type))].some((variable) => shown.has(variable))) return true;
      hole.solution = solveCoercible(this, hole.pred, [], hole.span, true);
      return hole.solution === undefined;
    });
  }

  makeDictParams(holes: EvidenceHole[]): DictParam[] {
    const distinct: Pred[] = [];
    for (const hole of holes) if (!distinct.some((pred) => predsEqual(pred, hole.pred))) distinct.push(hole.pred);
    const kept = distinct.filter(
      (pred) =>
        !distinct.some((other) => other !== pred && other.cls !== pred.cls && impliedBySuperclasses(other, pred))
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

  solveTop(): void {
    for (let round = 0; round < 100; round++) {
      const { retained: unsolved } = this.simplify(this.wanted, -1);
      this.wanted = [];
      const retained = this.defaultCoercible(unsolved, []);
      if (retained.length === 0) return;
      // Defaulting a Coercible constraint decides types the other constraints then need solving at.
      if (retained.length < unsolved.length) {
        this.wanted = retained;
        continue;
      }
      for (const hole of retained) {
        if (prune(hole.pred.type).tag !== 'tvar') this.ambiguous(hole);
      }
      for (const [variable, holes] of holesByVariable(retained)) {
        const chosen = this.defaultFor(
          variable,
          holes.map((hole) => hole.pred)
        );
        if (!chosen) this.ambiguous(holes[0]);
        this.unify(variable, chosen, holes[0].span);
      }
      this.wanted = retained;
    }
  }

  private instanceFor(hole: EvidenceHole): Exclude<ReturnType<ClassEnv['findInstance']>, 'none' | 'overlap'> {
    const found = this.env.findInstance(hole.pred);
    if (found === 'none') this.noInstance(hole);
    if (found === 'overlap') {
      typeError(hole.span, `${new TypePrinter().showPred(hole.pred)} のインスタンスが重複しています。`);
    }
    return found;
  }

  withScopedTypes<T>(types: ReadonlyMap<string, Type>, run: () => T): T {
    const outer = this.scopedTypes;
    this.scopedTypes = new Map([...outer, ...types]);
    try {
      return run();
    } finally {
      this.scopedTypes = outer;
    }
  }

  sigToScheme(sig: RSigType): Scheme {
    const bound = new Set(sig.forall?.map((binder) => binder.name));
    const free = typeVarNames([sig.type, ...sig.context]).filter(
      (name) => !bound.has(name) && !this.scopedTypes.has(name)
    );
    if (sig.forall && free.length > 0) typeError(sig.span, `型変数 ${free[0]} がスコープにありません。`);
    const names = sig.forall ? sig.forall.map((binder) => binder.name) : free;
    const kindVars = new Map<string, Kind>();
    const kinds: Kind[] = names.map((name) => {
      const binder = sig.forall?.find((candidate) => candidate.name === name);
      return binder?.kind ? this.typeConversion.kindOf(binder.kind, kindVars) : freshKindVar();
    });
    const vars = new Map<string, Type>(this.scopedTypes);
    const varKinds = new Map<string, Kind>([...this.scopedTypes].map(([name, type]) => [name, kindOfType(type)]));
    for (const [index, name] of names.entries()) {
      vars.set(name, { tag: 'tgen', index });
      varKinds.set(name, kinds[index]);
    }
    const type = this.convertType(sig.type, vars, varKinds, STAR);
    const preds = this.convertConstraints(sig.context, vars, varKinds);
    this.checkKinds();
    const specified = sig.forall
      ? sig.forall.flatMap((binder, index) => (binder.inferred ? [] : [index]))
      : typeVarNames([...sig.context, sig.type]).flatMap((name) => {
          const index = names.indexOf(name);
          return index === -1 ? [] : [index];
        });
    const required = sig.forall?.flatMap((binder, index) => (binder.required ? [index] : []));
    const scheme = { kinds: kinds.map(defaultKind), names, preds, type, specified, required };
    if (!this.allowAmbiguousTypes) checkSchemeAmbiguity(scheme, sig.span);
    return scheme;
  }

  kindOf(type: RType, kindVars: Map<string, Kind>): Kind {
    return this.typeConversion.kindOf(type, kindVars);
  }

  /** The type variables an explicit `forall` of a signature binds, which scope over the definition it types. */
  forallScope(sig: RSigType | undefined, skolems: readonly Type[]): Map<string, Type> {
    return new Map(sig?.forall?.map((binder, index) => [binder.name, skolems[index]]));
  }

  convertType(type: RType, vars: ReadonlyMap<string, Type>, varKinds: ReadonlyMap<string, Kind>, expected: Kind): Type {
    return this.typeConversion.convert(type, vars, varKinds, expected);
  }

  convertConstraints(
    context: readonly RConstraint[],
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): Pred[] {
    return this.typeConversion.predicates(context, vars, varKinds);
  }

  superclassTypes(context: readonly RConstraint[], parameters: readonly string[], kinds: readonly Kind[]): Pred[] {
    return this.typeConversion.superclasses(context, parameters, kinds);
  }

  derivingClass(type: RType): ClassEntity | undefined {
    return this.typeConversion.derivingClass(type);
  }

  typeOfRef(ref: VarRef, span: Span, name: string, expr: Extract<RExpr, { k: 'var' }>): Type {
    if (ref.kind === 'local') {
      const local = ref.local;
      if (local.scheme) {
        const { type, evidence } = this.instantiate(local.scheme, span, `${name} の使用`);
        expr.evidence = evidence;
        return type;
      }
      if (!local.type) typeError(span, `${name} の型が決まっていません。`);
      const polymorphic = prune(local.type);
      if (polymorphic.tag === 'forall') {
        const { type, evidence } = this.instantiate(polytypeScheme(polymorphic), span, `${name} の使用`);
        expr.evidence = evidence;
        return type;
      }
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
    const type = this.recursion.run(() => this.inferExprInner(expr));
    expr.type = type;
    return type;
  }

  checkExpr(expr: RExpr, expected: Type, context?: string): void {
    if (expr.k === 'lambda' && functionParts(expected)?.multiplicity) {
      this.checkLinearLambda(expr, expected, context);
      return;
    }
    const actual = this.inferExpr(expr);
    this.unify(actual, expected, expr.span, context);
  }

  // code-gauge-allow functionNcss -- One short case per expression kind, each delegating to a helper.
  private inferExprInner(expr: RExpr): Type {
    switch (expr.k) {
      case 'hole': {
        const type = this.freshVar();
        this.holes.push({ hole: expr, type });
        return type;
      }
      case 'tyapp': {
        return this.inferTypeApplication(expr);
      }
      case 'poly': {
        return this.inferExpr(expr.expr);
      }
      case 'implicit': {
        const type = this.freshVar();
        expr.evidence = this.want(
          { cls: IMPLICIT_CLASS, type: tap(tcon(IMPLICIT_TYPES), tcon(symbolType(expr.name)), type) },
          expr.span,
          `?${expr.name} の使用`
        );
        return type;
      }
      case 'implicitLet': {
        const params = expr.binds.map((bind) =>
          newDictParam({
            cls: IMPLICIT_CLASS,
            type: tap(tcon(IMPLICIT_TYPES), tcon(symbolType(bind.name)), this.inferExpr(bind.expr)),
          })
        );
        expr.dictParams = params;
        return this.withGivens(
          params.map((param) => ({ pred: param.pred, evidence: { kind: 'param', param } as Evidence })),
          () => this.inferExpr(expr.body)
        );
      }
      case 'projection': {
        const record = this.inferExpr(expr.expr);
        const field = this.freshVar();
        expr.evidence = this.want(
          { cls: HAS_FIELD_CLASS, type: tap(tcon(HAS_FIELD_TYPES), tcon(symbolType(expr.field)), record, field) },
          expr.span,
          `フィールド ${expr.field} の取り出し`
        );
        return field;
      }
      case 'var': {
        return this.typeOfRef(expr.ref, expr.span, expr.name, expr);
      }
      case 'con': {
        const { type, evidence } = this.instantiate(conScheme(expr.con), expr.span, expr.con.name);
        if (evidence.length > 0) expr.evidence = evidence;
        if (expr.con.datatypeContext) this.wantDatatypeContext(expr.con, type, expr.span);
        return type;
      }
      case 'lit': {
        return this.inferLiteral(expr);
      }
      case 'app': {
        return this.inferApp(expr);
      }
      case 'lambda': {
        return this.inferLambda(expr);
      }
      case 'let': {
        this.inferBindGroup(expr.binds);
        return this.inferExpr(expr.body);
      }
      case 'if': {
        this.checkExpr(expr.cond, tcon(this.builtins.bool), 'if の条件');
        const type = this.inferExpr(expr.ifTrue);
        this.checkExpr(expr.ifFalse, type, 'then と else の型');
        return type;
      }
      case 'case': {
        return this.inferCase(expr);
      }
      case 'do': {
        return this.inPatternScope(() => this.inferDo(expr));
      }
      case 'tuple': {
        return tap(tcon(tupleCon(expr.elems.length).type), ...expr.elems.map((elem) => this.inferExpr(elem)));
      }
      case 'list': {
        const elem = this.freshVar();
        for (const item of expr.elems) this.checkExpr(item, elem, 'リストの要素');
        return listOf(elem);
      }
      case 'arith': {
        const elem = this.freshVar();
        for (const part of [expr.from, expr.next, expr.to]) if (part) this.checkExpr(part, elem);
        expr.evidence = this.want({ cls: this.builtins.enum, type: elem }, expr.span, '範囲の式');
        return listOf(elem);
      }
      case 'comp': {
        return this.inPatternScope(() => {
          for (const qual of expr.quals) this.inferQualifier(qual);
          return listOf(this.inferExpr(expr.expr));
        });
      }
      case 'rsection': {
        return this.inferRightSection(expr);
      }
      case 'typed': {
        const scheme = this.sigToScheme(expr.sig);
        expr.dictParams = this.checkAgainstScheme(scheme, (type, skolems) =>
          this.withScopedTypes(this.forallScope(expr.sig, skolems), () => this.checkExpr(expr.expr, type))
        );
        const instantiated = this.instantiate(scheme, expr.span, '型の注釈');
        expr.evidence = instantiated.evidence;
        return instantiated.type;
      }
      case 'recordCon': {
        if (expr.con.exKinds) {
          const { type, evidence } = this.instantiate(conScheme(expr.con), expr.span, expr.con.name);
          if (evidence.length > 0) expr.evidence = evidence;
          const fieldTypes: Type[] = [];
          let rest = prune(type);
          for (let index = 0; index < expr.con.arity; index++) {
            const { args } = splitApp(rest);
            fieldTypes.push(args[0]);
            rest = prune(args[1]);
          }
          this.checkFields(expr.fields, expr.con, fieldTypes);
          return rest;
        }
        const { type, fieldTypes } = this.instantiateCon(expr.con);
        this.checkFields(expr.fields, expr.con, fieldTypes);
        return type;
      }
      case 'recordUpdate': {
        return this.inferRecordUpdate(expr);
      }
    }
  }

  /**
   * Infers `e @t1 @t2`, where `e` is a variable or constructor whose scheme specifies its type variables: the type
   * arguments instantiate them in order.
   */
  private inferTypeApplication(expr: Extract<RExpr, { k: 'tyapp' }>): Type {
    const applications: Extract<RExpr, { k: 'tyapp' }>[] = [];
    let head: RExpr = expr;
    while (head.k === 'tyapp') {
      applications.unshift(head);
      head = head.expr;
    }
    const typeArgs = applications.map((application) => application.typeArg);
    const scheme =
      head.k === 'con'
        ? conScheme(head.con)
        : head.k === 'var'
          ? head.ref.kind === 'local'
            ? head.ref.local.scheme
            : this.globalMono.has(head.ref.entity)
              ? undefined
              : head.ref.entity.scheme
          : undefined;
    const specified = scheme?.specified ?? [];
    if (!scheme || typeArgs.length > specified.length) {
      typeError(expr.span, '型の適用（@）ができるのは、型シグネチャで型変数を決めた関数と構成子だけです。');
    }
    const args = freshKinds(scheme.kinds).map((kind, index) => this.freshVar(kind, scheme.names?.[index]));
    for (const [position, typeArg] of typeArgs.entries()) {
      const index = specified[position];
      if (applications[position].required && !scheme.required?.includes(index)) {
        typeError(applications[position].span, '(type t) を渡せるのは、forall a -> で型を受け取る引数だけです。');
      }
      if (!applications[position].required && scheme.required?.includes(index)) {
        typeError(
          applications[position].span,
          'forall a -> で型を受け取る引数には、@ ではなく (type t) で型を渡してください。'
        );
      }
      // A wildcard (`@_` or `(type _)`) leaves the variable for inference.
      if (!typeArg) continue;
      const scoped = new Map([...this.scopedTypes].map(([name, type]) => [name, kindOfType(type)]));
      const type = this.convertType(typeArg, this.scopedTypes, scoped, (args[index] as TVar).kind);
      this.checkKinds();
      this.unify(args[index], type, typeArg.span, '型の適用');
    }
    const name = head.k === 'con' ? head.con.name : head.k === 'var' ? head.name : '';
    const evidence = scheme.preds.map((pred) =>
      this.want({ cls: pred.cls, type: instantiateType(pred.type, args) }, head.span, `${name} の使用`)
    );
    if (head.k === 'var' || (head.k === 'con' && evidence.length > 0)) head.evidence = evidence;
    const type = instantiateType(scheme.type, args);
    head.type = type;
    return type;
  }

  /** Checks a lambda against a function type of LinearTypes, whose linear arguments it must use exactly once. */
  private checkLinearLambda(expr: Extract<RExpr, { k: 'lambda' }>, expected: Type, context?: string): void {
    this.inPatternScope(() => {
      let remaining = expected;
      const linear: LocalVar[] = [];
      for (const pat of expr.pats) {
        const { param, result, multiplicity } = this.splitFunction(remaining, expr.span, context ?? 'ラムダ式');
        this.inferPat(pat, param);
        if (multiplicity) linear.push(...linearLocals(pat));
        remaining = result;
      }
      this.checkExpr(expr.body, remaining, context);
      const body = { body: { k: 'plain', expr: expr.body } as const, where: { bindings: [] }, span: expr.span };
      if (linear.length > 0) checkLinearUses(linear, body);
    });
    expr.type = expected;
  }

  private inferLambda(expr: Extract<RExpr, { k: 'lambda' }>): Type {
    return this.inPatternScope(() => {
      const paramTypes = expr.pats.map((pat) => {
        const type = this.freshVar();
        this.inferPat(pat, type);
        return type;
      });
      let result = this.inferExpr(expr.body);
      for (const paramType of paramTypes.toReversed()) result = fnType(paramType, result);
      return result;
    });
  }

  private inferCase(expr: Extract<RExpr, { k: 'case' }>): Type {
    const scrutineeType = this.inferExpr(expr.scrutinee);
    const result = this.freshVar();
    for (const alt of expr.alts) {
      this.inPatternScope(() => {
        this.inferPat(alt.pat, scrutineeType);
        this.checkRhs(alt.rhs, result);
      });
    }
    return result;
  }

  /** Checks `(p :: t)` against the type it matches, binding the variables of `t` not yet in scope to what they match. */
  private checkPatternSignature(pat: Extract<RPat, { k: 'sig' }>, type: Type): void {
    const fresh = new Map(
      typeVarNames([pat.sigType])
        .filter((name) => !this.scopedTypes.has(name))
        .map((name) => [name, this.freshVar(freshKindVar(), name)] as const)
    );
    const vars = new Map<string, Type>([...this.scopedTypes, ...fresh]);
    const kinds = new Map([...vars].map(([name, variable]) => [name, kindOfType(variable)]));
    const annotated = this.convertType(pat.sigType, vars, kinds, STAR);
    this.checkKinds();
    this.unify(type, annotated, pat.span, 'パターンの型シグネチャ');
    if (fresh.size > 0) this.scopedTypes = new Map([...this.scopedTypes, ...fresh]);
  }

  /**
   * Runs the checking of a construct whose patterns may bind type variables with signatures, such as `\(x :: a) ->`,
   * which scope over the construct only.
   */
  inPatternScope<T>(run: () => T): T {
    const saved = this.scopedTypes;
    const scope: PatternScope = { outer: this.level, givens: [], assumed: [] };
    this.patternScopes.push(scope);
    let completed = false;
    try {
      const result = run();
      completed = true;
      return result;
    } finally {
      this.patternScopes.pop();
      this.scopedTypes = saved;
      if (scope.savedWanted) {
        if (completed) this.leaveImplication(scope);
        else {
          for (const variable of scope.assumed) variable.ref = undefined;
          this.level = scope.outer;
          this.wanted = scope.savedWanted;
        }
      }
    }
  }

  /**
   * Starts solving the constraints of the current pattern scope apart, under what its patterns give: existential
   * types, constraints, and GADT equalities.
   */
  private enterImplication(span: Span): PatternScope {
    const scope = this.patternScopes.at(-1);
    if (!scope) typeError(span, 'この場所では、存在型や GADT の構成子のパターンは使えません。');
    if (!scope.savedWanted) {
      scope.savedWanted = this.wanted;
      this.wanted = [];
      this.level++;
    }
    return scope;
  }

  private leaveImplication(scope: PatternScope): void {
    this.level = scope.outer;
    const inner = this.wanted;
    this.wanted = scope.savedWanted as EvidenceHole[];
    const { retained, deferred } = this.simplify(inner, scope.outer, scope.givens);
    for (const hole of retained) {
      const evidence = entailByGivens(normalizeGivens(scope.givens), hole.pred);
      if (evidence) {
        hole.solution = evidence;
        continue;
      }
      const vars = [...typeVarsOf(hole.pred.type)];
      if (vars.some((variable) => variable.skolem && variable.level > scope.outer)) {
        typeError(hole.span, `${new TypePrinter().showPred(hole.pred)} を導けません（${hole.origin}）。`);
      }
      for (const variable of vars) if (variable.level > scope.outer) variable.level = scope.outer;
      deferred.push(hole);
    }
    for (const variable of scope.assumed) variable.ref = undefined;
    this.wanted.push(...deferred);
  }

  private inferApp(expr: Extract<RExpr, { k: 'app' }>): Type {
    const fn = prune(this.inferExpr(expr.fn));
    const parts = functionParts(fn);
    if (parts) {
      const args = [parts.param, parts.result];
      const param = prune(args[0]);
      if (param.tag === 'forall') {
        const dictParams = this.checkAgainstScheme(polytypeScheme(param), (type) =>
          this.checkExpr(expr.arg, type, argumentContext(expr.fn))
        );
        if (dictParams.length > 0) expr.arg = { k: 'poly', expr: expr.arg, dictParams, span: expr.arg.span };
      } else this.checkExpr(expr.arg, args[0], argumentContext(expr.fn));
      return args[1];
    }
    const argType = this.inferExpr(expr.arg);
    const result = this.freshVar();
    this.unify(fn, fnType(argType, result), expr.span, '関数の適用');
    return result;
  }

  private inferRightSection(expr: Extract<RExpr, { k: 'rsection' }>): Type {
    const opType = this.inferExpr(expr.op);
    const a = this.freshVar();
    const b = this.freshVar();
    const c = this.freshVar();
    this.unify(opType, fnType(a, fnType(b, c)), expr.op.span);
    this.checkExpr(expr.right, b);
    return fnType(a, c);
  }

  private inferRecordUpdate(expr: Extract<RExpr, { k: 'recordUpdate' }>): Type {
    const target = this.inferExpr(expr.expr);
    const owner = expr.fields[0].field.type;
    const cons = owner.cons.filter((con) => expr.fields.every((fieldBind) => fieldBind.field.positions.has(con)));
    if (cons.length === 0 || !expr.fields.every((fieldBind) => fieldBind.field.type === owner)) {
      typeError(expr.span, 'これらのフィールドをすべて持つ構成子がありません。');
    }
    expr.cons = cons;
    const input = this.instantiateCon(cons[0]);
    const output = this.instantiateCon(cons[0]);
    this.unify(target, input.type, expr.expr.span, 'レコードの更新');
    const inputArgs = splitApp(input.type).args;
    const outputArgs = splitApp(output.type).args;
    for (const con of cons) {
      const updated = new Set(expr.fields.map((field) => field.field.positions.get(con)));
      for (const [position, fieldType] of con.fieldTypes.entries()) {
        if (updated.has(position)) continue;
        this.unify(
          instantiateType(fieldType, inputArgs),
          instantiateType(fieldType, outputArgs),
          expr.span,
          'レコードの更新'
        );
      }
    }
    this.checkFields(expr.fields, cons[0], output.fieldTypes);
    return output.type;
  }

  private checkFields(fields: readonly RFieldBind[], con: ConInfo, fieldTypes: readonly Type[]): void {
    for (const fieldBind of fields) {
      const position = fieldBind.field.positions.get(con) as number;
      this.checkExpr(fieldBind.value, fieldTypes[position], `フィールド ${fieldBind.field.name}`);
    }
  }

  /**
   * The argument and result types of a function type, which a signature may give polymorphic arguments, as
   * RankNTypes allows; a type not yet known becomes a function of fresh types.
   */
  splitFunction(type: Type, span: Span, context: string): { param: Type; result: Type; multiplicity?: Type } {
    const parts = functionParts(type);
    if (parts) return parts;
    const param = this.freshVar();
    const result = this.freshVar();
    this.unify(type, fnType(param, result), span, context);
    return { param, result };
  }

  private matchConstructor(con: ConInfo, type: Type, span: Span): Type[] {
    const { type: conType, fieldTypes } = this.instantiateCon(con);
    this.unify(conType, type, span, `構成子 ${con.name} のパターン`);
    if (con.datatypeContext) this.wantDatatypeContext(con, conType, span);
    return fieldTypes;
  }

  /**
   * Types a match of a constructor with variables of its own. Its existential variables are new rigid types the match
   * scope must not let escape; its constraints are given there, with the dictionaries the value holds; and a GADT
   * constructor's equalities hold there, which a rigid type of the scrutinee then stands for.
   */
  private matchConstructorVariables(pat: Extract<RPat, { k: 'con' }>, type: Type): Type[] {
    const { con, span } = pat;
    const scope = this.enterImplication(span);
    const args = freshKinds(typeParamKinds(con.type)).map((kind) => this.freshVar(kind));
    this.unify(tap(tcon(con.type), ...args), type, span, `構成子 ${con.name} のパターン`);
    const existentials = (con.exKinds ?? []).map((kind) => freshSkolem(kind, this.level, 'a'));
    const all = [...args, ...existentials];
    for (const [index, fixed] of con.equalities ?? []) {
      const target = prune(args[index]);
      const assumed = instantiateType(fixed, all);
      if (target.tag === 'tvar' && target.skolem) {
        target.ref = assumed;
        scope.assumed.push(target);
      } else if (target.tag === 'tvar') {
        typeError(span, `GADT の構成子 ${con.name} で照合する値の型が決まりません。型シグネチャを付けてください。`);
      } else {
        // The match's own variables stand for what the scrutinee's known type has at their places.
        for (const variable of existentials) variable.skolem = false;
        try {
          this.unify(target, assumed, span, `構成子 ${con.name} のパターン`);
        } finally {
          for (const variable of existentials) {
            variable.skolem = true;
            if (variable.ref && !scope.assumed.includes(variable)) scope.assumed.push(variable);
          }
        }
      }
    }
    pat.dictParams = (con.context ?? []).map((pred) =>
      newDictParam({ cls: pred.cls, type: instantiateType(pred.type, all) })
    );
    for (const param of pat.dictParams) {
      scope.assumed.push(...this.assumeEquality(param.pred));
      scope.givens.push({ pred: param.pred, evidence: { kind: 'param', param } });
    }
    return con.fieldTypes.map((fieldType) => instantiateType(fieldType, all));
  }

  /**
   * The constraints DatatypeContexts puts on a constructor, which its use needs at the types of the data type it
   * builds or matches, whose evidence the value does not keep.
   */
  private wantDatatypeContext(con: ConInfo, type: Type, span: Span): void {
    let result = prune(type);
    while (functionParts(result)) result = prune((functionParts(result) as { result: Type }).result);
    const { args } = splitApp(result);
    for (const pred of con.datatypeContext ?? []) {
      this.want({ cls: pred.cls, type: instantiateType(pred.type, args) }, span, `構成子 ${con.name} の文脈`);
    }
  }

  instantiateCon(con: ConInfo): { type: Type; fieldTypes: Type[] } {
    if (con.instanceArgs) {
      const vars = freshKinds(con.instanceKinds ?? []).map((kind) => this.freshVar(kind));
      return {
        type: tap(tcon(con.type), ...con.instanceArgs.map((arg) => instantiateType(arg, vars))),
        fieldTypes: con.fieldTypes.map((fieldType) => instantiateType(fieldType, vars)),
      };
    }
    const args = freshKinds(typeParamKinds(con.type)).map((kind) => this.freshVar(kind));
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

  // code-gauge-allow functionCognitiveComplexity -- The statement kinds share the monad type threaded through the block.
  private inferDo(expr: Extract<RExpr, { k: 'do' }>): Type {
    const needsMonad = expr.stmts.some(
      (stmt, index) => stmt.k === 'bind' || (stmt.k === 'exp' && index < expr.stmts.length - 1)
    );
    const monad = this.freshVar(kindArrow(STAR, STAR), 'm');
    if (needsMonad) {
      expr.monad = this.want({ cls: this.builtins.monad, type: monad }, expr.span, 'do');
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
          this.inferBindGroup(stmt.binds);
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
    expr.type = result;
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
        this.inferBindGroup(qual.binds);
        break;
      }
      case 'exp': {
        this.checkExpr(qual.expr, tcon(this.builtins.bool), '内包表記の条件');
        break;
      }
    }
  }

  // code-gauge-allow functionNcss -- Iterative pattern typing preserves binder order and literal dictionaries in one dispatch.
  inferPat(pattern: RPat, expected: Type): void {
    const pending = [{ pat: pattern, type: expected }];
    while (pending.length > 0) {
      const { pat, type } = pending.pop() as { pat: RPat; type: Type };
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
          pending.push({ pat: pat.pat, type });
          break;
        }
        case 'bang':
        case 'lazy': {
          pending.push({ pat: pat.pat, type });
          break;
        }
        case 'sig': {
          this.checkPatternSignature(pat, type);
          pending.push({ pat: pat.pat, type });
          break;
        }
        case 'view': {
          const result = this.freshVar();
          this.checkExpr(pat.expr, fnType(type, result), 'ビューパターンの関数');
          pending.push({ pat: pat.pat, type: result });
          break;
        }
        case 'or': {
          for (const alt of pat.alts.toReversed()) pending.push({ pat: alt, type });
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
          if (pat.negative)
            pat.negate = this.want({ cls: this.builtins.num, type }, pat.span, '負のリテラルのパターン');
          break;
        }
        case 'con': {
          const fieldTypes = pat.con.exKinds
            ? this.matchConstructorVariables(pat as Extract<RPat, { k: 'con' }>, type)
            : this.matchConstructor(pat.con, type, pat.span);
          for (let index = pat.args.length - 1; index >= 0; index--) {
            pending.push({ pat: pat.args[index], type: fieldTypes[index] });
          }
          break;
        }
      }
    }
  }

  checkRhs(rhs: RRhs, expected: Type): void {
    this.inferBindGroup(rhs.where);
    if (rhs.body.k === 'plain') {
      this.checkExpr(rhs.body.expr, expected);
      return;
    }
    for (const branch of rhs.body.branches) {
      this.inPatternScope(() => {
        for (const guard of branch.guards) {
          if (guard.k === 'bool') this.checkExpr(guard.expr, tcon(this.builtins.bool), 'ガード');
          else if (guard.k === 'pat') this.inferPat(guard.pat, this.inferExpr(guard.expr));
          else this.inferBindGroup(guard.binds);
        }
        this.checkExpr(branch.expr, expected);
      });
    }
  }

  /**
   * @param signature The signature's scheme and its rigid types, which the type variables `@a` of the clauses bind, in
   * the order the signature specifies its variables.
   */
  private inferBindingBody(
    binding: RBinding,
    type: Type,
    signature?: { scheme: Scheme; skolems: readonly Type[] }
  ): void {
    if (binding.k === 'pat') {
      this.inferPat(binding.pat, type);
      this.checkRhs(binding.rhs, type);
      return;
    }
    binding.type = type;
    for (const clause of binding.clauses) {
      const bound = new Map<string, Type>();
      for (const [position, name] of (clause.typeBinders ?? []).entries()) {
        const index = signature?.scheme.specified?.[position];
        if (index === undefined) typeError(clause.span, '@ で型変数を束縛するには、型シグネチャに forall が要ります。');
        if (name !== '_') bound.set(name, signature?.skolems[index] as Type);
      }
      this.withScopedTypes(bound, () =>
        this.inPatternScope(() => {
          let remaining = type;
          const linear: LocalVar[] = [];
          for (const pat of clause.pats) {
            const { param, result, multiplicity } = this.splitFunction(
              remaining,
              clause.span,
              `${bindingLabel(binding)} の引数`
            );
            this.inferPat(pat, param);
            if (multiplicity) linear.push(...linearLocals(pat));
            remaining = result;
          }
          this.checkRhs(clause.rhs, remaining);
          if (linear.length > 0) checkLinearUses(linear, clause.rhs);
        })
      );
    }
  }

  inferBindGroup(group: RBindGroup): void {
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
      binding.dictParams = this.checkAgainstScheme(scheme, (type, skolems) =>
        this.withScopedTypes(this.forallScope(binding.sig, skolems), () =>
          this.inferBindingBody(binding, type, { scheme, skolems })
        )
      );
    }
  }

  private inferImplicit(bindings: RBinding[]): void {
    const outer = this.level;
    this.level++;
    const saved = this.wanted;
    this.wanted = [];
    const monoTypes = this.assignMonoTypes(bindings);
    for (const binding of bindings) {
      const type = monoTypes.get(binding) as Type;
      if (binding.k === 'pat') this.checkRhs(binding.rhs, type);
      else this.inferBindingBody(binding, type);
    }
    this.level = outer;
    const inner = this.wanted;
    this.wanted = saved;
    const { retained, deferred } = this.simplify(inner, outer);
    const kept = this.defaultCoercible(this.keepGeneralizable(bindings, monoTypes, retained, deferred, outer), [
      ...monoTypes.values(),
    ]);
    const params = this.makeDictParams(kept);
    for (const binding of bindings) this.generalizeBinding(binding, monoTypes.get(binding) as Type, params, outer);
    this.wanted.push(...deferred);
  }

  private assignMonoTypes(bindings: RBinding[]): Map<RBinding, Type> {
    const monoTypes = new Map<RBinding, Type>();
    for (const binding of bindings) {
      const type = this.freshVar();
      monoTypes.set(binding, type);
      if (binding.k === 'fun') {
        this.setMono(binding.binder, type);
        continue;
      }
      this.inferPat(binding.pat, type);
      for (const [local, sig] of binding.patSigs ?? []) {
        const scheme = this.sigToScheme(sig);
        if (scheme.preds.length > 0) {
          typeError(sig.span, 'パターン束縛の型シグネチャの制約は、単相性制限と両立しません。');
        }
        this.unify(local.type as Type, this.instantiate(scheme, sig.span, local.name).type, sig.span);
      }
      for (const [index, local] of binding.binders.entries()) {
        const global = binding.globals?.[index];
        if (global) this.globalMono.set(global, local.type as Type);
      }
    }
    return monoTypes;
  }

  private keepGeneralizable(
    bindings: RBinding[],
    monoTypes: ReadonlyMap<RBinding, Type>,
    retained: EvidenceHole[],
    deferred: EvidenceHole[],
    outer: number
  ): EvidenceHole[] {
    // A pattern binding stays monomorphic even without the restriction, whose generalization this checker lacks.
    const restricted = bindings.some(
      (binding) => binding.k === 'pat' || (this.monomorphismRestriction && binding.clauses[0].pats.length === 0)
    );
    const types = bindings.flatMap((binding) =>
      binding.k === 'pat' ? binding.binders.map((local) => local.type as Type) : [monoTypes.get(binding) as Type]
    );
    const bindingTypes = new Set<TVar>();
    for (const type of types) for (const variable of typeVarsOf(type)) bindingTypes.add(variable);
    if (!restricted) this.defaultInternalVariables(retained, bindingTypes, outer);
    const classified = retained.map((hole) => ({
      hole,
      vars: [...typeVarsOf(hole.pred.type)].filter((variable) => variable.level > outer),
    }));
    const kept: EvidenceHole[] = [];
    for (const { hole, vars } of classified) {
      if (!restricted && vars.length > 0 && vars.every((variable) => bindingTypes.has(variable))) {
        kept.push(hole);
        continue;
      }
      for (const variable of vars) variable.level = outer;
      deferred.push(hole);
    }
    return kept;
  }

  private defaultInternalVariables(holes: EvidenceHole[], visible: ReadonlySet<TVar>, outer: number): void {
    for (const [variable, constraints] of holesByVariable(holes)) {
      if (variable.level <= outer || visible.has(variable)) continue;
      if (!constraints.every((hole) => prune(hole.pred.type) === variable)) this.ambiguous(constraints[0]);
      const chosen = this.defaultFor(
        variable,
        constraints.map((hole) => hole.pred)
      );
      if (!chosen) this.ambiguous(constraints[0]);
      this.unify(variable, chosen, constraints[0].span);
    }
  }

  private generalizeBinding(binding: RBinding, monoType: Type, params: DictParam[], outer: number): void {
    binding.dictParams = params;
    if (binding.k === 'fun') {
      setBinderScheme(binding.binder, this.generalize(monoType, params, outer, binding.span));
      if (binding.binder.kind === 'global') this.globalMono.delete(binding.binder.entity);
      return;
    }
    for (const [index, local] of binding.binders.entries()) {
      local.scheme = this.generalize(local.type as Type, params, outer, binding.span);
      const sig = binding.patSigs?.get(local);
      if (sig) {
        const inferred = local.scheme;
        const declared = this.sigToScheme(sig);
        this.checkAgainstScheme(declared, (type) =>
          this.unify(this.instantiate(inferred, sig.span, local.name).type, type, sig.span)
        );
        local.scheme = declared;
      }
      const global = binding.globals?.[index];
      if (global) {
        global.scheme = local.scheme;
        this.globalMono.delete(global);
      }
    }
  }

  private setMono(binder: Binder, type: Type): void {
    if (binder.kind === 'local') binder.local.type = type;
    else this.globalMono.set(binder.entity, type);
  }

  private generalize(type: Type, params: readonly DictParam[], outer: number, span: Span): Scheme {
    const zonked = zonk(type);
    const vars: TVar[] = [];
    const seen = new Set<TVar>();
    const add = (candidate: Type): void => {
      for (const variable of typeVarsOf(candidate))
        if (variable.level > outer && !seen.has(variable)) {
          seen.add(variable);
          vars.push(variable);
        }
    };
    add(zonked);
    for (const param of params) add(param.pred.type);
    const scheme = {
      kinds: vars.map((variable) => defaultKind(variable.kind)),
      names: vars.map((variable) => variable.name ?? 'a'),
      preds: params.map((param) => ({ cls: param.pred.cls, type: quantifyType(param.pred.type, vars) })),
      type: quantifyType(zonked, vars),
    };
    checkSchemeAmbiguity(scheme, span, (index) => {
      const variable = vars[index];
      const preds = params.filter((param) => occursIn(variable, param.pred.type)).map((param) => param.pred);
      return preds.every((pred) => prune(pred.type) === variable) && this.defaultFor(variable, preds) !== undefined;
    });
    return scheme;
  }

  private defaultFor(variable: TVar, preds: readonly Pred[]): Type | undefined {
    const kind = pruneKind(variable.kind);
    const classes = preds.map((pred) => pred.cls);
    const fits = (candidate: Type): boolean =>
      unifyKinds(variable.kind, kindOfType(candidate)) &&
      classes.every((cls) => this.solvable({ cls, type: candidate }));
    for (const cls of classes) {
      const named = this.namedDefaults.get(cls);
      const found = named?.find(fits);
      if (found) return found;
    }
    const standard = this.defaultTypes ?? [tcon(this.builtins.integer), tcon(this.builtins.double)];
    if (this.extendedDefaults) {
      if (!classes.some((cls) => this.builtins.numericClasses.has(cls) || INTERACTIVE_CLASSES.has(cls.name))) {
        return undefined;
      }
      return [tcon(UNIT_TYPE), tcon(LIST_TYPE), ...standard].find(fits);
    }
    if (kind.tag !== 'star' && kind.tag !== 'kvar') return undefined;
    if (!classes.some((cls) => this.builtins.numericClasses.has(cls))) return undefined;
    if (!classes.every((cls) => this.builtins.standardClasses.has(cls))) return undefined;
    return standard.find(fits);
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

  checkAgainstScheme(
    scheme: Scheme,
    check: (type: Type, skolems: readonly Type[]) => void,
    extraGivens: { pred: Pred; evidence: Evidence }[] = []
  ): DictParam[] {
    const outer = this.level;
    this.level++;
    const skolems = scheme.kinds.map((kind, index) => freshSkolem(kind, this.level, scheme.names?.[index] ?? 'a'));
    const type = instantiateType(scheme.type, skolems);
    const params = scheme.preds.map((pred) =>
      newDictParam({ cls: pred.cls, type: instantiateType(pred.type, skolems) })
    );
    const assumed = [...extraGivens.map((given) => given.pred), ...params.map((param) => param.pred)].flatMap((pred) =>
      this.assumeEquality(pred)
    );
    const givens = [
      ...extraGivens,
      ...params.map((param) => ({ pred: param.pred, evidence: { kind: 'param', param } as Evidence })),
    ];
    const saved = this.wanted;
    this.wanted = [];
    check(type, skolems);
    this.level = outer;
    const inner = this.wanted;
    this.wanted = saved;
    const { retained, deferred } = this.simplify(inner, outer, givens);
    for (const hole of retained) {
      const evidence = entailByGivens(givens, hole.pred);
      if (evidence) {
        hole.solution = evidence;
        continue;
      }
      const vars = [...typeVarsOf(hole.pred.type)];
      if (vars.every((variable) => !variable.skolem)) {
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
    for (const variable of assumed) variable.ref = undefined;
    this.wanted.push(...deferred);
    return params;
  }

  /** Checks a construct under given constraints, solving what it wants with them, as `let ?x = e` does. */
  private withGivens<T>(givens: { pred: Pred; evidence: Evidence }[], run: () => T): T {
    const outer = this.level;
    const saved = this.wanted;
    this.wanted = [];
    this.level++;
    const result = run();
    this.level = outer;
    const inner = this.wanted;
    this.wanted = saved;
    const { retained, deferred } = this.simplify(inner, outer, givens);
    for (const hole of [...retained, ...deferred]) {
      const evidence = entailByGivens(givens, hole.pred);
      if (evidence) hole.solution = evidence;
      else this.wanted.push(hole);
    }
    return result;
  }

  /**
   * Assumes a given equality `a ~ t` while the constraints of its scope are checked: a rigid variable on one side
   * stands for the other side. The returned variables are the ones to restore afterwards.
   */
  assumeEquality(pred: Pred): TVar[] {
    if (pred.cls !== EQUALITY_CLASS) return [];
    const [left, right] = splitApp(pred.type).args.map(prune);
    if (left.tag === 'tvar' && left.skolem && left !== right) {
      left.ref = right;
      return [left];
    }
    if (right.tag === 'tvar' && right.skolem && left !== right) {
      right.ref = left;
      return [right];
    }
    this.unify(left, right, { row: 0, col: 0, endRow: 0, endCol: 0 }, '型の等しさの制約');
    return [];
  }

  classKind(entity: ClassEntity, span: Span): Kind {
    return this.typeConversion.classKind(entity, span);
  }

  checkKinds(specialize = false): void {
    this.typeConversion.checkKinds(specialize);
  }
}

/** Givens with their constraints written as types made the classes' constraints, once their heads are classes. */
function normalizeGivens(givens: readonly { pred: Pred; evidence: Evidence }[]): { pred: Pred; evidence: Evidence }[] {
  return givens.map((given) => {
    if (given.pred.cls !== CONSTRAINT_TYPE_CLASS) return given;
    const preds = constraintPreds(zonk(given.pred.type));
    return preds.length === 1 ? { pred: preds[0], evidence: given.evidence } : given;
  });
}

function holesByVariable(holes: readonly EvidenceHole[]): Map<TVar, EvidenceHole[]> {
  const byVar = new Map<TVar, EvidenceHole[]>();
  for (const hole of holes) {
    for (const variable of typeVarsOf(hole.pred.type)) {
      const constraints = byVar.get(variable) ?? [];
      constraints.push(hole);
      byVar.set(variable, constraints);
    }
  }
  return byVar;
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

/** A polymorphic type inside another as a scheme, with its variables as `TGen` indices. */
export function polytypeScheme(type: TForall): Scheme {
  const generics = type.vars.map((_, index): Type => ({ tag: 'tgen', index }));
  const { body, preds } = substituteBound(type, generics);
  return {
    kinds: type.vars.map((variable) => variable.kind),
    names: type.vars.map((variable) => variable.name ?? 'a'),
    preds,
    type: body,
  };
}

export function conScheme(con: ConInfo): Scheme {
  if (con.instanceArgs) {
    const kinds = con.instanceKinds ?? [];
    let type: Type = tap(tcon(con.type), ...con.instanceArgs);
    for (const field of con.fieldTypes.toReversed()) type = fnType(field, type);
    return { kinds, preds: [], type, specified: kinds.map((_, index) => index) };
  }
  const params = typeParamKinds(con.type);
  const kinds = [...params, ...(con.exKinds ?? [])];
  const resultArgs = params.map(
    (_, index): Type => con.equalities?.find(([position]) => position === index)?.[1] ?? { tag: 'tgen', index }
  );
  let type: Type = tap(tcon(con.type), ...resultArgs);
  for (const field of con.fieldTypes.toReversed()) type = fnType(field, type);
  return { kinds, preds: con.context ?? [], type, specified: kinds.map((_, index) => index) };
}

export function typeParamKinds(type: TypeEntity): Kind[] {
  return parameterKinds(type.kind);
}

export function isFailable(pat: RPat): boolean {
  switch (pat.k) {
    case 'var':
    case 'wild': {
      return false;
    }
    case 'as':
    case 'bang':
    case 'view':
    case 'sig': {
      return isFailable(pat.pat);
    }
    case 'lazy': {
      return false;
    }
    case 'or': {
      return pat.alts.every(isFailable);
    }
    case 'lit': {
      return true;
    }
    case 'con': {
      return pat.con.type.cons.length > 1 || pat.args.some(isFailable);
    }
  }
}

export function typeVarNames(types: readonly RType[]): string[] {
  const names: string[] = [];
  const collect = (type: RType): void => {
    if (type.k === 'var') {
      if (!names.includes(type.name)) names.push(type.name);
    } else if (type.k === 'app') {
      collect(type.fn);
      collect(type.arg);
    } else if (type.k === 'tuple') {
      for (const elem of type.elems) collect(elem);
    } else if (type.k === 'fun') {
      collect(type.from);
      if (type.multiplicity) collect(type.multiplicity);
      collect(type.to);
    } else if (type.k === 'kinded' || type.k === 'kindapp') {
      collect(type.type);
    } else if (type.k === 'forall') {
      const inner = typeVarNames([type.body, ...type.context]);
      for (const name of inner) {
        if (!type.binders.some((binder) => binder.name === name) && !names.includes(name)) names.push(name);
      }
    }
  };
  for (const type of types) collect(type);
  return names;
}

export function checkSchemeAmbiguity(scheme: Scheme, span: Span, defaultable?: (index: number) => boolean): void {
  const visible = visibleThroughFundeps(scheme, genericIndices(scheme.type));
  const ambiguous = new Set<number>();
  for (const pred of scheme.preds) {
    for (const index of genericIndices(pred.type)) {
      if (!visible.has(index)) ambiguous.add(index);
    }
  }
  for (const index of ambiguous) {
    if (!defaultable?.(index)) throw compileError(span, '型の制約に、結果の型から決まらない型変数があります。');
  }
}

/** The variables a scheme's type shows, with those its constraints' functional dependencies determine from them. */
function visibleThroughFundeps(scheme: Scheme, visible: Set<number>): Set<number> {
  const determines = (pred: Pred, fundep: { from: number[]; to: number[] }): boolean => {
    const args = pred.cls.packed ? splitApp(pred.type).args : [pred.type];
    if (!fundep.from.every((index) => [...genericIndices(args[index])].every((generic) => visible.has(generic)))) {
      return false;
    }
    const before = visible.size;
    for (const index of fundep.to) for (const generic of genericIndices(args[index])) visible.add(generic);
    return visible.size > before;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const pred of scheme.preds) {
      for (const fundep of pred.cls.fundeps ?? []) if (determines(pred, fundep)) changed = true;
    }
  }
  return visible;
}

function genericIndices(type: Type): Set<number> {
  const result = new Set<number>();
  for (const node of walkGraph(type, prune, typeChildren)) if (node.tag === 'tgen') result.add(node.index);
  return result;
}
