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
import { compileError, REQUIRED_TYPE_TERM, unsupportedError } from './errors';
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
import type { OverlapMode, Span } from './syntax';
import { binderVisibility, constraintPreds, TypeConversion } from './typeConversion';
import { walkGraph } from './typeGraph';
import {
  couldMatch,
  defaultKind,
  defaultKindExcept,
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
  typeArgumentTargets,
  typeChildren,
  typesEqual,
  typeVarsOf,
  unifyKinds,
  unifyTypes,
  type Visibility,
  visibleBinders,
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

function newDictParam(pred: Pred): DictParam {
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

/** A given equality on a family application, `F a ~ Bool`, under which the application reduces to the other side. */
interface FamilyGiven {
  family: TypeEntity;
  args: Type[];
  to: Type;
}

/** What a given equality assumes, undone when its scope ends: a rigid variable's binding, or a family's reduction. */
type Assumption = TVar | FamilyGiven;

interface PatternScope {
  outer: number;
  /** The wanted constraints outside the scope, set once a pattern gives something the scope solves under. */
  savedWanted?: EvidenceHole[];
  givens: { pred: Pred; evidence: Evidence }[];
  /** The rigid types GADT equalities stand for in the scope. */
  assumed: Assumption[];
  hint?: string;
}

/** The expression forms whose check is their inference, with the inferred type unified with the expected one. */
type InferredForm =
  | 'hole'
  | 'var'
  | 'con'
  | 'lit'
  | 'tyapp'
  | 'implicit'
  | 'projection'
  | 'arith'
  | 'rsection'
  | 'typed'
  | 'recordCon'
  | 'recordUpdate';

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
  readonly namedDefaults = new Map<ClassEntity, Type[]>();
  set polyKinds(value: boolean) {
    this.typeConversion.polyKinds = value;
  }

  get polyKinds(): boolean {
    return this.typeConversion.polyKinds;
  }

  /** The given equalities on family applications in scope, which reduce those applications. */
  private readonly familyGivens: FamilyGiven[] = [];
  private readonly matchingGivens = new Set<FamilyGiven>();
  allowAmbiguousTypes = false;
  monomorphismRestriction = true;
  extendedDefaults = false;
  /** The overlap mode of the module's instances that name none: OverlappingInstances' or IncoherentInstances'. */
  defaultOverlap: OverlapMode | undefined;
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
   * written as types, `Coercible`, `HasField`, and equalities. `retained` leaves the constraint for later (an implicit
   * parameter's for the `let ?x` around the scope that wants it), `again`
   * looks at it once more as the class it turned out to be, and `undefined` leaves it to givens and instances.
   */
  private solveBuiltin(
    hole: EvidenceHole,
    givens: readonly { pred: Pred; evidence: Evidence }[]
  ): 'solved' | 'retained' | 'again' | undefined {
    const { pred } = hole;
    if (pred.cls === literalClasses?.nat || pred.cls === literalClasses?.symbol) return this.solveLiteral(hole, givens);
    switch (pred.cls) {
      case IMPLICIT_CLASS: {
        return this.solveImplicit(hole, givens);
      }
      case CONSTRAINT_TYPE_CLASS: {
        const preds = constraintPreds(this.reduceFamilies(pred.type));
        if (preds.length === 0) {
          hole.solution = { kind: 'equality' };
          return 'solved';
        }
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

  /**
   * Solves `KnownNat n` or `KnownSymbol s` by the literal its type reduces to, or leaves it to the givens; a family
   * application with type variables, `KnownNat (n + 1)`, may still reduce, and waits for that.
   */
  private solveLiteral(
    hole: EvidenceHole,
    givens: readonly { pred: Pred; evidence: Evidence }[]
  ): 'solved' | 'retained' | undefined {
    const literal = prune(this.reduceFamilies(hole.pred.type));
    if (literal.tag === 'tcon' && literal.entity.literal !== undefined) {
      hole.solution = { kind: 'literal', value: literal.entity.literal };
      return 'solved';
    }
    if (entailByGivens(givens, hole.pred)) return undefined;
    if (isFamilyApplication(literal) && typeVarsOf(literal).size > 0) return 'retained';
    if (literal.tag === 'tcon' || literal.tag === 'tap') this.noInstance(hole);
    return undefined;
  }

  private solveImplicit(
    hole: EvidenceHole,
    givens: readonly { pred: Pred; evidence: Evidence }[]
  ): 'solved' | 'retained' {
    const [name, type] = splitApp(hole.pred.type).args;
    const given = givens.find(
      (candidate) => candidate.pred.cls === IMPLICIT_CLASS && typesEqual(splitApp(candidate.pred.type).args[0], name)
    );
    if (!given) return 'retained';
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
    // A data instance's field is typed over the instance's own variables, which its types give the family's arguments.
    const con = info.positions.keys().next().value as ConInfo;
    let fieldArgs = args;
    if (con.instanceArgs) {
      fieldArgs = (con.instanceKinds ?? []).map((kind) => this.freshVar(kind));
      for (const [index, instanceArg] of con.instanceArgs.entries()) {
        this.unify(args[index], instantiateType(instanceArg, fieldArgs), span, `フィールド ${info.name} の型`);
      }
    }
    this.unify(field, instantiateType(info.fieldType, fieldArgs), span, `フィールド ${info.name} の型`);
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
    const builtin = family.reduceBuiltin?.(args);
    if (builtin) return builtin;
    const given = this.familyGivens.find(
      (candidate) => candidate.family === family && this.givenMatches(candidate, args)
    );
    if (given) return given.to;
    for (const equation of family.equations ?? []) {
      const bindings: (Type | undefined)[] = [];
      if (equation.lhs.every((pattern, index) => matchType(pattern, args[index], bindings))) {
        return instantiateType(
          equation.rhs,
          equation.kinds.map((kind, index) => bindings[index] ?? this.freshVar(kind))
        );
      }
      // The whole head at once, so that a variable it repeats stands for one type in every argument.
      if (family.closed && couldMatch(tap(tcon(family), ...equation.lhs), tap(tcon(family), ...args))) return undefined;
    }
    return undefined;
  }

  /**
   * Whether a given equality's family application has the arguments `args`, which are reduced, once its own arguments
   * are reduced under the givens; `G a` in `F (G a) ~ Bool` is `Int` while `G a ~ Int` is given. A given does not
   * take part in reducing its own arguments, which `F (F a) ~ a` would otherwise make endless.
   */
  private givenMatches(given: FamilyGiven, args: readonly Type[]): boolean {
    if (this.matchingGivens.has(given)) return false;
    this.matchingGivens.add(given);
    try {
      return given.args.every((arg, index) => typesEqual(this.reduceFamilies(arg), args[index]));
    } finally {
      this.matchingGivens.delete(given);
    }
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
    // An implicitly quantified variable is specified in the order it first occurs, the context included, as in GHC.
    const free = typeVarNames([...sig.context, sig.type]).filter(
      (name) => !bound.has(name) && !this.scopedTypes.has(name)
    );
    if (sig.forall && free.length > 0) typeError(sig.span, `型変数 ${free[0]} がスコープにありません。`);
    const names = sig.forall ? sig.forall.map((binder) => binder.name) : free;
    const visibilities = sig.forall ? sig.forall.map(binderVisibility) : free.map((): Visibility => 'specified');
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
    let type = this.convertType(sig.type, vars, varKinds, STAR);
    const preds = this.convertConstraints(sig.context, vars, varKinds);
    this.checkKinds();
    // A forall the whole type is, which a synonym or parentheses give (`type Id = forall r. r -> r`), quantifies the
    // signature itself: its variables and context join the scheme's, as GHC reads it.
    for (let outer = prune(type); outer.tag === 'forall'; outer = prune(type)) {
      const start = kinds.length;
      const gens = outer.vars.map((variable, offset): Type => ({ tag: 'tgen', index: start + offset }));
      for (const [offset, variable] of outer.vars.entries()) {
        kinds.push(variable.kind);
        names.push(variable.name ?? `t${start + offset}`);
        visibilities.push(variable.visibility ?? 'specified');
      }
      const inner = substituteBound(outer, gens);
      preds.push(...inner.preds);
      type = inner.body;
    }
    // A kind variable the signature names (`k` in `forall k (a :: k).`) stays a variable of the scheme's kinds, which
    // each use instantiates afresh; other unknown kinds default to Type.
    const named = new Set([...kindVars.values()].map(pruneKind));
    const scheme = { kinds: kinds.map((kind) => defaultKindExcept(kind, named)), visibilities, names, preds, type };
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
    // A required binder, `forall a ->`, takes its type from `(type t)`; a term in its place is GHC's term-to-type
    // mapping, which this environment does not do.
    const scheme = ref.kind === 'local' ? ref.local.scheme : ref.entity.scheme;
    if (scheme?.visibilities.includes('required')) throw unsupportedError(span, REQUIRED_TYPE_TERM);
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

  /**
   * Checks an expression against the type its context expects, which has no outer `forall` (`checkPoly` skolemises
   * one). Every form has a check rule: most pass the expected type, or the parts of it they decide, into their
   * subexpressions, so that a lambda anywhere among them binds its parameters at the expected parameter types,
   * polymorphic or linear as they may be; the others infer their types and unify them with the expected one.
   */
  checkExpr(expr: RExpr, expected: Type, context?: string): void {
    this.recursion.run(() => {
      if (this.checkExprInner(expr, expected, context)) expr.type = expected;
      else this.unify(this.inferExpr(expr), expected, expr.span, context);
    });
  }

  /**
   * Checks an expression against a type that may be polymorphic, `forall a. C a => t`, by skolemising it, giving the
   * expression to put in its place: one that takes the dictionaries of the type's constraints.
   */
  checkPoly(expr: RExpr, expected: Type, context?: string): RExpr {
    const type = prune(expected);
    if (type.tag !== 'forall') {
      this.checkExpr(expr, expected, context);
      return expr;
    }
    let checked = expr;
    const dictParams = this.skolemise(polytypeScheme(type), (rho) => {
      checked = this.checkPoly(expr, rho, context);
    });
    return dictParams.length > 0 ? { k: 'poly', expr: checked, dictParams, span: expr.span } : checked;
  }

  /** Checks an expression by its form's check rule, or returns false when the form infers its type instead. */
  // code-gauge-allow functionNcss -- One short case per expression kind, each delegating to a helper.
  private checkExprInner(expr: RExpr, expected: Type, context: string | undefined): boolean {
    switch (expr.k) {
      case 'lambda': {
        if (!functionParts(this.reduceFamilies(expected))) return false;
        this.checkMatch(expr.pats, expected, expr.span, context ?? 'ラムダ式', (result) => {
          expr.body = this.checkPoly(expr.body, result, context);
          return { body: { k: 'plain', expr: expr.body }, where: { bindings: [] }, span: expr.span };
        });
        return true;
      }
      case 'let': {
        this.inferBindGroup(expr.binds);
        this.checkExpr(expr.body, expected, context);
        return true;
      }
      case 'if': {
        this.checkExpr(expr.cond, tcon(this.builtins.bool), 'if の条件');
        this.checkExpr(expr.ifTrue, expected, context);
        this.checkExpr(expr.ifFalse, expected, context);
        return true;
      }
      case 'case': {
        this.inferCase(expr, expected);
        return true;
      }
      case 'do': {
        this.inPatternScope(() => this.inferDo(expr, { type: expected, context }));
        return true;
      }
      case 'poly': {
        this.checkExpr(expr.expr, expected, context);
        return true;
      }
      case 'app': {
        this.inferApp(expr, { type: expected, context });
        return true;
      }
      case 'implicitLet': {
        this.withImplicitBindings(expr, () => this.checkExpr(expr.body, expected, context));
        return true;
      }
      case 'tuple': {
        const args = this.expectedArgs(expected, tupleCon(expr.elems.length).type, expr.elems.length);
        if (!args) return false;
        for (const [index, elem] of expr.elems.entries())
          expr.elems[index] = this.checkPoly(elem, args[index], context);
        return true;
      }
      case 'list': {
        const [elem] = this.expectedArgs(expected, LIST_TYPE, 1) ?? [];
        if (!elem) return false;
        for (const [index, item] of expr.elems.entries())
          expr.elems[index] = this.checkPoly(item, elem, 'リストの要素');
        return true;
      }
      case 'comp': {
        const [elem] = this.expectedArgs(expected, LIST_TYPE, 1) ?? [];
        if (!elem) return false;
        this.inPatternScope(() => this.checkComprehension(expr, elem));
        return true;
      }
      default: {
        expr.k satisfies InferredForm;
        return false;
      }
    }
  }

  /** The arguments of the expected type when it applies `entity` to `arity` of them, as a tuple or list type does. */
  private expectedArgs(expected: Type, entity: TypeEntity, arity: number): Type[] | undefined {
    const { head, args } = splitApp(this.reduceFamilies(expected));
    return head.tag === 'tcon' && head.entity === entity && args.length === arity ? args : undefined;
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
        return this.withImplicitBindings(expr, () => this.inferExpr(expr.body));
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
        if (expr.forcing && expr.ref.kind === 'local' && expr.ref.local.scheme?.preds.length) {
          // Evaluating an overloaded binding's function of its dictionaries, which takes none.
          expr.evidence = [];
          return this.freshVar();
        }
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
        const elem = this.freshVar();
        this.inPatternScope(() => this.checkComprehension(expr, elem));
        return listOf(elem);
      }
      case 'rsection': {
        return this.inferRightSection(expr);
      }
      case 'typed': {
        const scheme = this.checkTyped(expr);
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

  private withImplicitBindings<T>(expr: Extract<RExpr, { k: 'implicitLet' }>, body: () => T): T {
    const params = expr.binds.map((bind) =>
      newDictParam({
        cls: IMPLICIT_CLASS,
        type: tap(tcon(IMPLICIT_TYPES), tcon(symbolType(bind.name)), this.inferExpr(bind.expr)),
      })
    );
    expr.dictParams = params;
    return this.inPatternScope((scope) => {
      this.enterImplication(scope);
      for (const param of params) this.assumeGiven(scope, param);
      return body();
    });
  }

  private checkComprehension(expr: Extract<RExpr, { k: 'comp' }>, elem: Type): void {
    for (const qual of expr.quals) this.inferQualifier(qual);
    this.checkExpr(expr.expr, elem);
  }

  /**
   * Infers `e @t1 @t2`, where `e` is a variable, a constructor, or `(e :: sig)`, whose scheme's visible binders the
   * type arguments instantiate in order.
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
            ? (head.ref.local.scheme ?? localPolytypeScheme(head.ref.local))
            : this.globalMono.has(head.ref.entity)
              ? undefined
              : head.ref.entity.scheme
          : head.k === 'typed'
            ? this.checkTyped(head)
            : undefined;
    const targets = scheme && typeArgumentTargets(scheme.visibilities, applications);
    if (!scheme || !targets) {
      typeError(expr.span, '型の適用（@）ができるのは、型シグネチャで型変数を決めた関数と構成子だけです。');
    }
    const args = freshKinds(scheme.kinds).map((kind, index) => this.freshVar(kind, scheme.names?.[index]));
    for (const [position, typeArg] of typeArgs.entries()) {
      const index = targets[position];
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
    if (head.k === 'var' || head.k === 'typed' || (head.k === 'con' && evidence.length > 0)) head.evidence = evidence;
    const type = instantiateType(scheme.type, args);
    head.type = type;
    return type;
  }

  private checkTyped(expr: Extract<RExpr, { k: 'typed' }>): Scheme {
    const scheme = this.sigToScheme(expr.sig);
    expr.dictParams = this.skolemise(scheme, (type, skolems) =>
      this.withScopedTypes(this.forallScope(expr.sig, skolems), () => this.checkExpr(expr.expr, type))
    );
    return scheme;
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

  private inferCase(expr: Extract<RExpr, { k: 'case' }>, result: Type = this.freshVar()): Type {
    const scrutineeType = this.scrutineeType(expr);
    for (const alt of expr.alts) {
      this.inPatternScope(() => {
        this.inferPat(alt.pat, scrutineeType);
        this.checkRhs(alt.rhs, result);
      });
    }
    return result;
  }

  /**
   * The type a case's patterns match. The parameters `\case` and `\cases` scrutinize keep their types uninstantiated,
   * polymorphic as they may be, since GHC matches those patterns against the lambda's parameter types.
   */
  private scrutineeType(expr: Extract<RExpr, { k: 'case' }>): Type {
    const { scrutinee } = expr;
    if (expr.what !== String.raw`\case` && expr.what !== String.raw`\cases`) return this.inferExpr(scrutinee);
    const parameterType = (parameter: RExpr): Type => {
      const type = parameter.k === 'var' && parameter.ref.kind === 'local' ? parameter.ref.local.type : undefined;
      if (!type || prune(type).tag !== 'forall') return this.inferExpr(parameter);
      parameter.type = type;
      return type;
    };
    if (scrutinee.k !== 'tuple') return parameterType(scrutinee);
    const type = tap(tcon(tupleCon(scrutinee.elems.length).type), ...scrutinee.elems.map(parameterType));
    scrutinee.type = type;
    return type;
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
  inPatternScope<T>(run: (scope: PatternScope) => T): T {
    const saved = this.scopedTypes;
    const scope: PatternScope = { outer: this.level, givens: [], assumed: [] };
    this.patternScopes.push(scope);
    let completed = false;
    try {
      const result = run(scope);
      completed = true;
      return result;
    } finally {
      this.patternScopes.pop();
      this.scopedTypes = saved;
      if (scope.savedWanted) {
        if (completed) this.leaveImplication(scope);
        else {
          for (const assumption of scope.assumed) this.undoAssumption(assumption);
          this.level = scope.outer;
          this.wanted = scope.savedWanted;
        }
      }
    }
  }

  /**
   * Starts solving the constraints of a pattern scope apart, under what it gives: existential types, constraints, and
   * GADT equalities.
   */
  private enterImplication(scope: PatternScope): PatternScope {
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
        typeError(
          hole.span,
          `${new TypePrinter().showPred(hole.pred)} を導けません（${hole.origin}）。${scope.hint ?? ''}`
        );
      }
      for (const variable of vars) if (variable.level > scope.outer) variable.level = scope.outer;
      deferred.push(hole);
    }
    for (const assumption of scope.assumed) this.undoAssumption(assumption);
    this.wanted.push(...deferred);
  }

  /**
   * Infers an application `f a1 ... an` from its function's type. Checked against an expected type, the result type
   * is unified with it before the arguments whose parameter types the function's type already has are checked, as
   * GHC does, so that the expected type reaches those arguments too.
   */
  // code-gauge-allow functionNcss -- The spine walk keeps the pending arguments and the instantiations it interleaves.
  private inferApp(expr: Extract<RExpr, { k: 'app' }>, expected?: { type: Type; context?: string }): Type {
    const spine: Extract<RExpr, { k: 'app' }>[] = [];
    let head: RExpr = expr;
    for (; head.k === 'app'; head = head.fn) spine.unshift(head);
    let type = this.inferExpr(head);
    const pending: { app: Extract<RExpr, { k: 'app' }>; param: Type }[] = [];
    const checkPending = (): void => {
      for (const { app, param } of pending) app.arg = this.checkPoly(app.arg, param, argumentContext(app.fn));
      pending.length = 0;
    };
    let previous: RExpr = head;
    for (const app of spine) {
      type = this.instantiateResult(previous, type);
      let parts = functionParts(prune(type));
      if (!parts && pending.length > 0) {
        // The arguments before may decide the function type here: `id caller (\f -> ...)` passes `caller`'s
        // polymorphic parameter to the lambda only once `id caller` is checked.
        checkPending();
        type = this.instantiateResult(previous, type);
        parts = functionParts(prune(type));
      }
      if (parts) {
        pending.push({ app, param: parts.param });
        type = parts.result;
      } else {
        const argType = this.inferExpr(app.arg);
        const result = this.freshVar();
        this.unify(type, fnType(argType, result), app.span, '関数の適用');
        type = result;
      }
      app.type = type;
      previous = app;
    }
    if (expected) {
      const result = prune(expected.type).tag === 'forall' ? type : this.instantiateResult(expr, type);
      this.unify(result, expected.type, expr.span, expected.context);
    }
    checkPending();
    return expr.type as Type;
  }

  /**
   * Instantiates the polymorphic type an application gives, `forall a. C a => t`, where the application takes another
   * argument or meets the type its context expects, as GHC does: the application then takes the dictionaries of the
   * constraints.
   */
  private instantiateResult(application: RExpr, type: Type): Type {
    const polymorphic = prune(type);
    if (polymorphic.tag !== 'forall' || application.k !== 'app') return type;
    const instantiated = this.instantiate(polytypeScheme(polymorphic), application.span, '関数の適用の結果');
    application.evidence = [...(application.evidence ?? []), ...instantiated.evidence];
    application.type = instantiated.type;
    return this.instantiateResult(application, instantiated.type);
  }

  private inferRightSection(expr: Extract<RExpr, { k: 'rsection' }>): Type {
    const opType = prune(this.inferExpr(expr.op));
    // An operator's arrows keep their multiplicities, as GHC types `(`op` x)` by `\y -> op y x`.
    const first = functionParts(opType);
    const second = first && functionParts(prune(first.result));
    if (second) {
      expr.right = this.checkPoly(expr.right, second.param, argumentContext(expr.op));
      const { head, args } = splitApp(opType);
      return tap(head, ...args.slice(0, -1), second.result);
    }
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
      fieldBind.value = this.checkPoly(fieldBind.value, fieldTypes[position], `フィールド ${fieldBind.field.name}`);
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
    const current = this.patternScopes.at(-1);
    if (!current) typeError(span, 'この場所では、存在型や GADT の構成子のパターンは使えません。');
    const scope = this.enterImplication(current);
    const args = freshKinds(typeParamKinds(con.type)).map((kind) => this.freshVar(kind));
    this.unify(tap(tcon(con.type), ...args), type, span, `構成子 ${con.name} のパターン`);
    const existentials = (con.exKinds ?? []).map((kind) => freshSkolem(kind, this.level, 'a'));
    const all = [...args, ...existentials];
    for (const [index, fixed] of con.equalities ?? []) {
      const target = prune(args[index]);
      const assumed = instantiateType(fixed, all);
      // An equality the scrutinee's type already has, as `a ~ a` for `Refl` at `Eq1 a a`, assumes nothing; binding a
      // rigid type to itself would make it its own cycle.
      if (prune(assumed) === target) continue;
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
    for (const param of pat.dictParams) this.assumeGiven(scope, param);
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

  /** @param expected The type the block is checked against, which its last statement then is checked against. */
  // code-gauge-allow functionCognitiveComplexity -- The statement kinds share the monad type threaded through the block.
  private inferDo(expr: Extract<RExpr, { k: 'do' }>, expected?: { type: Type; context?: string }): Type {
    const needsMonad = expr.stmts.some(
      (stmt, index) => stmt.k === 'bind' || (stmt.k === 'exp' && index < expr.stmts.length - 1)
    );
    const monad = this.freshVar(kindArrow(STAR, STAR), 'm');
    if (needsMonad) {
      expr.monad = this.want({ cls: this.builtins.monad, type: monad }, expr.span, 'do');
    }
    let result: Type = expected?.type ?? this.freshVar();
    for (const [index, stmt] of expr.stmts.entries()) {
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
          if (index === expr.stmts.length - 1) {
            if (expected) this.checkExpr(stmt.expr, result, expected.context);
            else result = this.inferExpr(stmt.expr);
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
      rhs.body.expr = this.checkPoly(rhs.body.expr, expected);
      return;
    }
    for (const branch of rhs.body.branches) {
      this.inPatternScope(() => {
        for (const guard of branch.guards) {
          if (guard.k === 'bool') this.checkExpr(guard.expr, tcon(this.builtins.bool), 'ガード');
          else if (guard.k === 'pat') this.inferPat(guard.pat, this.inferExpr(guard.expr));
          else this.inferBindGroup(guard.binds);
        }
        branch.expr = this.checkPoly(branch.expr, expected);
      });
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
      binding.dictParams = this.skolemise(scheme, (type, skolems) =>
        this.withScopedTypes(this.forallScope(binding.sig, skolems), () =>
          this.checkClauses(binding, type, `${bindingLabel(binding)} の引数`, { scheme, skolems })
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
      else this.checkClauses(binding, type, `${bindingLabel(binding)} の引数`);
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

  /**
   * @param signature The signature's scheme and its rigid types, which the type variables `@a` of the clauses bind, in
   * the order of the signature's visible binders.
   */
  checkClauses(
    binding: Extract<RBinding, { k: 'fun' }>,
    type: Type,
    context: string,
    signature?: { scheme: Scheme; skolems: readonly Type[] }
  ): void {
    binding.type = type;
    for (const clause of binding.clauses) {
      const bound = new Map<string, Type>();
      for (const [position, name] of (clause.typeBinders ?? []).entries()) {
        const index = signature && visibleBinders(signature.scheme.visibilities)[position];
        if (index === undefined) typeError(clause.span, '@ で型変数を束縛するには、型シグネチャに forall が要ります。');
        if (name !== '_') bound.set(name, signature?.skolems[index] as Type);
      }
      this.withScopedTypes(bound, () =>
        this.checkMatch(clause.pats, type, clause.span, context, (result) => {
          this.checkRhs(clause.rhs, result);
          return clause.rhs;
        })
      );
    }
  }

  /**
   * The check rule of a lambda, which the clauses of a function share: binds the patterns at the parameter types of
   * `expected`, polymorphic as they may be, checks the body against the rest, and checks that the parameters of linear
   * arrows are used once. A `forall` between the parameters is skolemised; the dictionaries of one with a context
   * would have to be taken between the parameters, which the clauses cannot.
   */
  private checkMatch(
    pats: readonly RPat[],
    expected: Type,
    span: Span,
    context: string,
    body: (result: Type) => RRhs
  ): void {
    const linear: LocalVar[] = [];
    const bind = (start: number, type: Type): void => {
      let remaining = type;
      for (let index = start; index < pats.length; index++) {
        const polymorphic = prune(remaining);
        if (polymorphic.tag === 'forall') {
          if (polymorphic.preds.length > 0) {
            throw unsupportedError(pats[index].span, '文脈付きの forall の後ろの引数をパターンで受け取る定義');
          }
          this.skolemise(polytypeScheme(polymorphic), (rho) => bind(index, rho));
          return;
        }
        const { param, result, multiplicity } = this.splitFunction(remaining, span, context);
        this.inferPat(pats[index], param);
        if (multiplicity) linear.push(...linearLocals(pats[index]));
        remaining = result;
      }
      const rhs = body(remaining);
      if (linear.length > 0) checkLinearUses(linear, rhs);
    };
    this.inPatternScope(() => bind(0, expected));
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
    const restricted =
      this.monomorphismRestriction &&
      bindings.some((binding) => binding.k === 'pat' || binding.clauses[0].pats.length === 0);
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
        this.skolemise(declared, (type) =>
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
      visibilities: vars.map((): Visibility => 'inferred'),
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
    // An implicit parameter no `let ?x` gives is unbound rather than ambiguous.
    if (hole.pred.cls === IMPLICIT_CLASS) this.noInstance(hole);
    const printer = new TypePrinter();
    typeError(
      hole.span,
      `型が曖昧です。${printer.showPred(hole.pred)} の型が決まりません（${hole.origin}）。型の注釈を付けてください。`
    );
  }

  /**
   * Checks against a polymorphic type, `forall vars. preds => type`, by skolemising it: `check` sees its type with
   * rigid variables for its own, in a pattern scope that gives its constraints, whose dictionaries are returned. Only
   * the outermost quantifier is skolemised, as GHC's simplified subsumption does; the check rules skolemise the ones
   * they meet inside.
   */
  skolemise(scheme: Scheme, check: (type: Type, skolems: readonly Type[]) => void): DictParam[] {
    return this.inPatternScope((scope) => {
      this.enterImplication(scope);
      scope.hint = '型シグネチャの文脈に制約を加えてください。';
      const skolems = scheme.kinds.map((kind, index) => freshSkolem(kind, this.level, scheme.names?.[index] ?? 'a'));
      const params = scheme.preds.map((pred) =>
        newDictParam({ cls: pred.cls, type: instantiateType(pred.type, skolems) })
      );
      for (const param of params) this.assumeGiven(scope, param);
      check(instantiateType(scheme.type, skolems), skolems);
      return params;
    });
  }

  /** Gives a constraint in a pattern scope, assuming it while the scope is checked if it is an equality. */
  private assumeGiven(scope: PatternScope, param: DictParam): void {
    scope.assumed.push(...this.assumeEquality(param.pred));
    scope.givens.push({ pred: param.pred, evidence: { kind: 'param', param } });
  }

  /**
   * Assumes a given equality `a ~ t` while the constraints of its scope are checked: a rigid variable on one side
   * stands for the other side. The returned variables are the ones to restore afterwards.
   */
  assumeEquality(pred: Pred): Assumption[] {
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
    // A family application that does not reduce, `F a ~ Bool`, reduces to the other side while the given holds.
    for (const [application, to] of [
      [left, right],
      [right, left],
    ] as const) {
      const { head, args } = splitApp(application);
      if (head.tag === 'tcon' && head.entity.sort === 'family' && args.length === head.entity.arity) {
        const given: FamilyGiven = { family: head.entity, args, to };
        this.familyGivens.push(given);
        return [given];
      }
    }
    this.unify(left, right, { row: 0, col: 0, endRow: 0, endCol: 0 }, '型の等しさの制約');
    return [];
  }

  private undoAssumption(assumption: Assumption): void {
    if ('tag' in assumption) assumption.ref = undefined;
    else this.familyGivens.splice(this.familyGivens.indexOf(assumption), 1);
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

/** The scheme of a local whose type is polymorphic, as a rank-N parameter's is. */
function localPolytypeScheme(local: LocalVar): Scheme | undefined {
  const type = local.type && prune(local.type);
  return type?.tag === 'forall' ? polytypeScheme(type) : undefined;
}

/** A polymorphic type inside another as a scheme, with its variables as `TGen` indices. */
export function polytypeScheme(type: TForall): Scheme {
  const generics = type.vars.map((_, index): Type => ({ tag: 'tgen', index }));
  const { body, preds } = substituteBound(type, generics);
  return {
    kinds: type.vars.map((variable) => variable.kind),
    visibilities: type.vars.map((variable) => variable.visibility ?? 'specified'),
    names: type.vars.map((variable) => variable.name ?? 'a'),
    preds,
    type: body,
  };
}

/**
 * A constructor's scheme: the data type's parameters, then the constructor's existential variables, all specified; a
 * GADT constructor quantifies its signature's variables instead, in their written order, before the parameters its
 * result type fixes.
 */
export function conScheme(con: ConInfo): Scheme {
  if (con.instanceArgs) {
    const kinds = con.instanceKinds ?? [];
    let type: Type = tap(tcon(con.type), ...con.instanceArgs);
    for (const field of con.fieldTypes.toReversed()) type = fnType(field, type);
    return { kinds, visibilities: kinds.map((): Visibility => 'specified'), preds: [], type };
  }
  const params = typeParamKinds(con.type);
  const kinds = [...params, ...(con.exKinds ?? [])];
  const resultArgs = params.map(
    (_, index): Type => con.equalities?.find(([position]) => position === index)?.[1] ?? { tag: 'tgen', index }
  );
  let type: Type = tap(tcon(con.type), ...resultArgs);
  for (const field of con.fieldTypes.toReversed()) type = fnType(field, type);
  const preds = con.context ?? [];
  if (!con.binders) return { kinds, visibilities: kinds.map((): Visibility => 'specified'), preds, type };
  const order = [
    ...con.binders.map((binder) => binder.index),
    ...kinds.keys().filter((index) => !con.binders?.some((binder) => binder.index === index)),
  ];
  const renumbered: Type[] = [];
  for (const [position, index] of order.entries()) renumbered[index] = { tag: 'tgen', index: position };
  return {
    kinds: order.map((index) => kinds[index]),
    visibilities: order.map((_, position) => con.binders?.[position]?.visibility ?? 'inferred'),
    preds: preds.map((pred) => ({ cls: pred.cls, type: instantiateType(pred.type, renumbered) })),
    type: instantiateType(type, renumbered),
  };
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
  // A required binder's variable, `forall a ->`, is one every caller gives.
  const required = scheme.visibilities.flatMap((visibility, index) => (visibility === 'required' ? [index] : []));
  const visible = visibleThroughFundeps(scheme, new Set([...genericIndices(scheme.type), ...required]));
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
