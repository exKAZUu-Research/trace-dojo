import type { ClassEntity, ConInfo, DictParam, Evidence, FieldInfo, Fixity, TypeEntity, ValueEntity } from './entities';
import type { Expr, Literal, Pat, Span } from './syntax';
import type { Scheme, Type } from './types';

export interface LocalVar {
  id: number;
  name: string;
  span: Span;
  fixity?: Fixity;
  /** The variable's type while its binding is being checked, then its generalized scheme. */
  type?: Type;
  scheme?: Scheme;
}

export type VarRef = { kind: 'local'; local: LocalVar } | { kind: 'global'; entity: ValueEntity };

export type Binder = VarRef;

export type RExpr = (
  | {
      k: 'var';
      ref: VarRef;
      name: string;
      span: Span;
      /** A strict binding's evaluation of its variable, which is not instantiated. */
      forcing?: true;
      /** The dictionaries the variable's instantiated scheme takes, in order. */
      evidence?: Evidence[];
    }
  | {
      k: 'con';
      con: ConInfo;
      span: Span;
      /** The dictionaries of the constructor's constraints, which the value it builds holds. */
      evidence?: Evidence[];
    }
  | { k: 'lit'; lit: Literal; span: Span; evidence?: Evidence }
  /** `evidence` is what the application's polymorphic result takes once instantiated, which applies to it. */
  | { k: 'app'; fn: RExpr; arg: RExpr; span: Span; evidence?: Evidence[] }
  | { k: 'lambda'; pats: RPat[]; body: RExpr; span: Span }
  | { k: 'let'; binds: RBindGroup; body: RExpr; span: Span }
  | { k: 'if'; cond: RExpr; ifTrue: RExpr; ifFalse: RExpr; span: Span }
  | { k: 'case'; scrutinee: RExpr; alts: RAlt[]; span: Span; what?: string }
  | {
      k: 'do';
      stmts: RStmt[];
      span: Span;
      /** The `Monad` dictionary of the block's monad. */
      monad?: Evidence;
    }
  | { k: 'tuple'; elems: RExpr[]; span: Span }
  | { k: 'list'; elems: RExpr[]; span: Span }
  | { k: 'arith'; from: RExpr; next?: RExpr; to?: RExpr; span: Span; evidence?: Evidence }
  | { k: 'comp'; expr: RExpr; quals: RStmt[]; span: Span }
  | { k: 'rsection'; op: RExpr; right: RExpr; span: Span }
  | { k: 'typed'; expr: RExpr; sig: RSigType; span: Span; dictParams?: DictParam[]; evidence?: Evidence[] }
  | { k: 'recordCon'; con: ConInfo; fields: RFieldBind[]; span: Span; evidence?: Evidence[] }
  | { k: 'recordUpdate'; expr: RExpr; fields: RFieldBind[]; span: Span; cons?: ConInfo[] }
  | { k: 'hole'; name: string; span: Span }
  | { k: 'tyapp'; expr: RExpr; typeArg: RType | undefined; required?: boolean; span: Span }
  | { k: 'implicit'; name: string; span: Span; evidence?: Evidence }
  | {
      k: 'implicitLet';
      binds: { name: string; expr: RExpr; span: Span }[];
      body: RExpr;
      span: Span;
      /** The dictionaries the bindings give the body, one per binding, which hold their values. */
      dictParams?: DictParam[];
    }
  /** `e.field`, whose evidence selects the field of the record `e`. */
  | { k: 'projection'; expr: RExpr; field: string; span: Span; evidence?: Evidence }
  /** An expression checked against a polymorphic type with constraints, which takes their dictionaries. */
  | { k: 'poly'; expr: RExpr; dictParams: DictParam[]; span: Span }
) & { type?: Type };

export interface RFieldBind {
  field: FieldInfo;
  value: RExpr;
  span: Span;
}

export type RPat = (
  | { k: 'var'; local: LocalVar; span: Span }
  | { k: 'wild'; span: Span }
  | {
      k: 'lit';
      lit: Literal;
      negative: boolean;
      span: Span;
      eq?: Evidence;
      num?: Evidence;
      negate?: Evidence;
      type?: Type;
    }
  | {
      k: 'con';
      con: ConInfo;
      args: RPat[];
      order?: number[];
      span: Span;
      /** The dictionaries a matched value of a constructor with constraints holds, which the match binds. */
      dictParams?: DictParam[];
    }
  | { k: 'as'; local: LocalVar; pat: RPat; span: Span }
  /** `!p`, which evaluates the value before matching it. */
  | { k: 'bang'; pat: RPat; span: Span }
  /** `~p`, which always matches and matches its pattern only when a variable of it is used. */
  | { k: 'lazy'; pat: RPat; span: Span }
  /** `(f -> p)`, which matches the result of applying the function to the value. */
  | { k: 'view'; expr: RExpr; pat: RPat; span: Span }
  /** `(p1; p2)`, which matches if any of its alternatives does; they bind no variables. */
  | { k: 'or'; alts: RPat[]; span: Span }
  /** `(p :: t)`, whose type variables not yet in scope bind the types they match. */
  | { k: 'sig'; pat: RPat; sigType: RType; span: Span }
) & { surface?: Pat };

/** The patterns directly inside a pattern. */
export function rpatChildren(pat: RPat): RPat[] {
  switch (pat.k) {
    case 'con': {
      return pat.args;
    }
    case 'as':
    case 'bang':
    case 'lazy':
    case 'view':
    case 'sig': {
      return [pat.pat];
    }
    case 'or': {
      return pat.alts;
    }
    default: {
      return [];
    }
  }
}

/** The variables a pattern binds, in order. */
export function rpatLocals(pat: RPat): LocalVar[] {
  const result: LocalVar[] = [];
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.k === 'var' || current.k === 'as') result.push(current.local);
    pending.push(...rpatChildren(current).toReversed());
  }
  return result;
}

export type RType =
  | { k: 'var'; name: string; span: Span }
  | { k: 'con'; entity: TypeEntity; span: Span }
  | { k: 'class'; entity: ClassEntity; span: Span }
  | { k: 'tuple'; elems: RType[]; span: Span }
  | { k: 'app'; fn: RType; arg: RType; span: Span }
  /** A function type; LinearTypes' arrows give it a multiplicity other than `Many`: `One` or a variable. */
  | { k: 'fun'; from: RType; to: RType; multiplicity?: RType; span: Span }
  /** A type with a kind annotation, `(t :: k)`; kinds are types whose constructors are `Type` and `Constraint`. */
  | { k: 'kinded'; type: RType; kind: RType; span: Span }
  | { k: 'forall'; binders: RBinder[]; context: RConstraint[]; body: RType; span: Span }
  | { k: 'kindapp'; type: RType; kind: RType; span: Span };

export type RConstraint = RType;

export interface RSigType {
  context: RConstraint[];
  type: RType;
  span: Span;
  /** The variables of an explicit `forall`, in order, which scope over the definition. */
  forall?: RBinder[];
}

export interface RBinder {
  name: string;
  kind?: RType;
  inferred?: boolean;
  required?: boolean;
}

export interface RGuarded {
  guards: RGuard[];
  expr: RExpr;
  span: Span;
}

export type RGuard =
  | { k: 'bool'; expr: RExpr; span: Span }
  | { k: 'let'; binds: RBindGroup; span: Span }
  | { k: 'pat'; pat: RPat; expr: RExpr; span: Span };

export interface RRhs {
  body: { k: 'plain'; expr: RExpr } | { k: 'guarded'; branches: RGuarded[] };
  where: RBindGroup;
  span: Span;
}

export interface RAlt {
  pat: RPat;
  rhs: RRhs;
  span: Span;
}

export type RStmt =
  | { k: 'bind'; pat: RPat; expr: RExpr; span: Span; fail?: Evidence }
  | { k: 'let'; binds: RBindGroup; span: Span }
  | { k: 'exp'; expr: RExpr; span: Span };

export interface RClause {
  /** The type variables `@a` binds before the clause's patterns, in order. */
  typeBinders?: string[];
  pats: RPat[];
  rhs: RRhs;
  span: Span;
}

export type RBinding =
  | {
      k: 'fun';
      binder: Binder;
      clauses: RClause[];
      type?: Type;
      sig?: RSigType;
      span: Span;
      /** The dictionaries the binding takes after generalization. */
      dictParams?: DictParam[];
    }
  | {
      k: 'pat';
      pat: RPat;
      rhs: RRhs;
      span: Span;
      binders: LocalVar[];
      dictParams?: DictParam[];
      /** The globals a top-level pattern binding defines, one per binder. */
      globals?: ValueEntity[];
      patSigs?: Map<LocalVar, RSigType>;
    };

export interface RBindGroup {
  bindings: RBinding[];
}

/**
 * The class a constraint applies and the type it applies the class to: the one argument of a class of one parameter,
 * or the arguments packed by the class's `packed` type constructor.
 */
export function directClassConstraint(constraint: RType): { cls: ClassEntity; type: RType; span: Span } | undefined {
  const args: RType[] = [];
  let head = constraint;
  while (head.k === 'app') {
    args.unshift(head.arg);
    head = head.fn;
  }
  if (head.k !== 'class') return;
  const { packed } = head.entity;
  if (!packed) return args.length === 1 ? { cls: head.entity, type: args[0], span: constraint.span } : undefined;
  if (args.length !== packed.arity) return;
  let type: RType = { k: 'con', entity: packed, span: constraint.span };
  for (const arg of args) type = { k: 'app', fn: type, arg, span: constraint.span };
  return { cls: head.entity, type, span: constraint.span };
}

/** Replaces the type variables of a type by name. */
export function substituteRType(type: RType, substitution: ReadonlyMap<string, RType>): RType {
  switch (type.k) {
    case 'var': {
      return substitution.get(type.name) ?? type;
    }
    case 'app': {
      return { ...type, fn: substituteRType(type.fn, substitution), arg: substituteRType(type.arg, substitution) };
    }
    case 'fun': {
      return {
        ...type,
        from: substituteRType(type.from, substitution),
        to: substituteRType(type.to, substitution),
        ...(type.multiplicity ? { multiplicity: substituteRType(type.multiplicity, substitution) } : {}),
      };
    }
    case 'tuple': {
      return { ...type, elems: type.elems.map((elem) => substituteRType(elem, substitution)) };
    }
    case 'kinded': {
      return { ...type, type: substituteRType(type.type, substitution) };
    }
    default: {
      return type;
    }
  }
}

/**
 * The synonyms of constraints, as ConstraintKinds allows (`type C a = (Show a, Eq a)`), with their parameters and
 * what they stand for; a context that names one has the constraints it stands for.
 */
export const CONSTRAINT_SYNONYMS = new WeakSet<object>();

/** The parameters and right sides of a program's type synonyms, which contexts expand as written. */
export const SYNONYM_RHS = new WeakMap<object, { params: string[]; rhs: RType }>();

/** A type with the synonym it applies expanded, as long as its head is a synonym applied to enough types. */
export function expandSynonymHead(type: RType): RType {
  let current = type;
  for (let count = 0; count < 1000; count++) {
    const args: RType[] = [];
    let head: RType = current;
    while (head.k === 'app') {
      args.unshift(head.arg);
      head = head.fn;
    }
    const synonym = head.k === 'con' ? SYNONYM_RHS.get(head.entity) : undefined;
    if (!synonym || args.length < synonym.params.length) return current;
    const substitution = new Map(synonym.params.map((name, index) => [name, args[index]]));
    let expanded = substituteRType(synonym.rhs, substitution);
    for (const arg of args.slice(synonym.params.length)) expanded = { k: 'app', fn: expanded, arg, span: arg.span };
    current = expanded;
  }
  return current;
}

/** Whether a synonym's right side is a constraint: a class applied to types, a tuple of them, or such a synonym. */
export function isConstraintType(type: RType): boolean {
  const expanded = expandSynonymHead(type);
  if (expanded.k === 'tuple') return expanded.elems.length > 0 && expanded.elems.every(isConstraintType);
  let head: RType = expanded;
  while (head.k === 'app') head = head.fn;
  return head.k === 'class' || (head.k === 'con' && CONSTRAINT_SYNONYMS.has(head.entity));
}

/**
 * A name in a Template Haskell quote, which the renamer's quote mode annotates with its stage: a binder of the quote,
 * a variable of the code around it (whose value the tree holds lifted), a global name with the module GHC defines it
 * in, or a name nothing binds, which the code the tree is spliced into binds.
 */
export type QRef =
  | { k: 'bound'; local: LocalVar }
  | { k: 'outer'; name: string }
  | { k: 'global'; space: 'v' | 'd' | 'tc'; module: string; name: string }
  | { k: 'unbound'; name: string };

/** A renamed quoted expression, which keeps the structure the quote wrote. */
export type QExpr =
  | { k: 'var' | 'con'; ref: QRef }
  | { k: 'lit'; lit: Literal }
  | { k: 'app'; fn: QExpr; arg: QExpr }
  /** An operator application or section, `InfixE`, nested by the operators' fixities. */
  | { k: 'infix'; left?: QExpr; op: QExpr; right?: QExpr }
  | { k: 'lambda'; pats: QPat[]; body: QExpr }
  | { k: 'lamCase'; alts: QMatch[] }
  | { k: 'tupleSection'; elems: (QExpr | undefined)[] }
  | { k: 'let'; decls: QDecls; body: QExpr }
  | { k: 'if'; cond: QExpr; ifTrue: QExpr; ifFalse: QExpr }
  | { k: 'multiIf'; branches: QGuarded[] }
  | { k: 'case'; scrutinee: QExpr; alts: QMatch[] }
  | { k: 'do' | 'comp'; stmts: QStmt[] }
  | { k: 'tuple' | 'list'; elems: QExpr[] }
  | { k: 'arith'; from: QExpr; next?: QExpr; to?: QExpr }
  | { k: 'sig'; expr: QExpr; type: QType }
  | { k: 'recordCon'; con: QRef; fields: QFieldExp[] }
  | { k: 'recordUpdate'; expr: QExpr; fields: QFieldExp[] }
  | { k: 'tyapp'; expr: QExpr; type: QType }
  /** A splice inside the quote, whose code, of the program around the quote, builds that part of the tree. */
  | { k: 'splice'; code: Expr };

export interface QFieldExp {
  field: QRef;
  value: QExpr;
}

export type QPat =
  | { k: 'var'; local: LocalVar }
  | { k: 'wild' }
  | { k: 'lit'; lit: Literal; negative: boolean }
  | { k: 'con'; con: QRef; args: QPat[] }
  | { k: 'infix'; left: QPat; con: QRef; right: QPat }
  | { k: 'tuple' | 'list'; elems: QPat[] }
  | { k: 'as'; local: LocalVar; pat: QPat }
  | { k: 'record'; con: QRef; fields: { field: QRef; pat: QPat }[] }
  | { k: 'bang' | 'lazy'; pat: QPat }
  | { k: 'view'; expr: QExpr; pat: QPat }
  | { k: 'sig'; pat: QPat; type: QType };

export type QType =
  | { k: 'var' | 'con'; ref: QRef }
  | { k: 'list' | 'arrow' | 'star' | 'constraint' }
  | { k: 'tupleCon'; arity: number }
  | { k: 'app'; fn: QType; arg: QType }
  | { k: 'lit'; value: bigint | string }
  | { k: 'forall'; binders: QTyVar[]; context: QType[]; body: QType }
  | { k: 'splice'; code: Expr };

/** A type variable a quote binds: by a `forall`, specified or inferred, or by a declaration's head. */
export interface QTyVar {
  local: LocalVar;
  flag: 'specified' | 'inferred' | 'required';
  /** The kind the binder's annotation gives it. */
  kind?: QType;
}

export interface QGuarded {
  guards: QStmt[];
  expr: QExpr;
}

export type QBody = { k: 'plain'; expr: QExpr } | { k: 'guarded'; branches: QGuarded[] };

/** An alternative of a `case`, whose body sees its pattern's variables and its `where` bindings. */
export interface QMatch {
  pat: QPat;
  body: QBody;
  where: QDecls;
}

export type QStmt = { k: 'bind'; pat: QPat; expr: QExpr } | { k: 'let'; decls: QDecls } | { k: 'exp'; expr: QExpr };

/** A group of declarations, with the names it binds in the order GHC gives them new names. */
export interface QDecls {
  binders: LocalVar[];
  decls: QDecl[];
}

export interface QClause {
  pats: QPat[];
  body: QBody;
  where: QDecls;
}

export type QDecl =
  | { k: 'fun'; name: QRef; clauses: QClause[] }
  | { k: 'val'; pat: QPat; body: QBody; where: QDecls }
  | { k: 'sig'; name: QRef; type: QType; isDefault?: boolean }
  | { k: 'fixity'; assoc: Fixity['assoc']; prec: number; name: QRef }
  | {
      k: 'data';
      flavour: 'data' | 'newtype' | 'typeData';
      context: QType[];
      name: QRef;
      params: QTyVar[];
      cons: QCon[];
      deriving: QDeriving[];
    }
  | { k: 'tySyn'; name: QRef; params: QTyVar[]; type: QType }
  | {
      k: 'class';
      context: QType[];
      name: QRef;
      params: QTyVar[];
      fundeps: { from: QRef[]; to: QRef[] }[];
      decls: QDecl[];
    }
  /** An instance, which binds the type variables its head and context name. */
  | { k: 'instance'; binders: LocalVar[]; context: QType[]; head: QType; decls: QDecl[] };

export interface QCon {
  name: QRef;
  fields: { name?: QRef; strict: boolean; type: QType }[];
  infix: boolean;
}

export interface QDeriving {
  strategy?: 'stock' | 'anyclass' | 'newtype' | 'via';
  via?: QType;
  cls: QType;
}

/** A renamed quote: of an expression, a pattern, a type, or declarations. */
export type QQuote =
  | { k: 'exp'; expr: QExpr }
  | { k: 'pat'; pat: QPat }
  | { k: 'type'; type: QType }
  | { k: 'decs'; decls: QDecls };
