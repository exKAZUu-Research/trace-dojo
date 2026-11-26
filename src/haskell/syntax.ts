import type { Extensions } from './extensions';
import type { LocalNamespace } from './localScope';

/** A source range: 0-based rows and columns, the end column exclusive. */
export interface Span {
  row: number;
  col: number;
  endRow: number;
  endCol: number;
}

export interface Name {
  name: string;
  span: Span;
}

/** The module of a global name a splice gives when it is the module being compiled. */
export const THIS_MODULE = '';

export interface QName extends Name {
  qualifier?: string;
  /**
   * For a global name a Template Haskell splice gives, the module GHC defines it in and its namespace, by which the
   * name refers to its entity whatever the program's scope has.
   */
  global?: { module: string; namespace: 'var' | 'con' | 'type' };
}

export type Literal =
  | { kind: 'int'; value: bigint }
  | { kind: 'frac'; value: number; text: string }
  | { kind: 'char'; value: string }
  | { kind: 'string'; value: string[] };

export type SourceLiteral = Literal & { text: string };

export interface Operator extends QName {
  isConstructor: boolean;
  /** Whether the operator is a promoted constructor in a type, `':`. */
  promoted?: boolean;
}

export type Expr =
  | {
      kind: 'var';
      name: QName;
      span: Span;
      /**
       * Whether the reference only evaluates the variable for a strict binding, which as GHC's leaves an overloaded
       * binding uninstantiated: its value is then a function of its dictionaries, which evaluating does not run.
       */
      forcing?: true;
    }
  | { kind: 'con'; name: QName; span: Span }
  /** A literal; a `generated` one is the conversion's, such as a failure message, which overloading leaves alone. */
  | { kind: 'lit'; lit: Literal; span: Span; generated?: true }
  | { kind: 'app'; fn: Expr; arg: Expr; span: Span }
  | { kind: 'chain'; items: ChainItem<Expr>[]; span: Span }
  | { kind: 'binop'; op: Operator; left: Expr; right: Expr; span: Span }
  | { kind: 'neg'; expr: Expr; span: Span }
  /**
   * A lambda; a `generated` one stands for syntax the conversion desugars, such as `\case` or a tuple section, whose
   * variables bind no pattern the source wrote.
   */
  | { kind: 'lambda'; pats: Pat[]; body: Expr; span: Span; generated?: true }
  | { kind: 'let'; decls: Decl[]; body: Expr; span: Span }
  | { kind: 'if'; cond: Expr; ifTrue: Expr; ifFalse: Expr; span: Span }
  | {
      kind: 'case';
      scrutinee: Expr;
      alts: Alt[];
      span: Span;
      /** The construct the case stands for in messages, such as `\case`, when it is not a `case` itself. */
      what?: string;
    }
  | { kind: 'do'; stmts: Stmt[]; span: Span }
  | { kind: 'tuple'; elems: Expr[]; span: Span }
  | { kind: 'list'; elems: Expr[]; span: Span }
  | { kind: 'arith'; from: Expr; next?: Expr; to?: Expr; span: Span }
  | {
      kind: 'comprehension';
      expr: Expr;
      quals: Stmt[];
      span: Span;
      /** The qualifiers of the other branches of a parallel comprehension, `[e | qs1 | qs2]`, after the first. */
      parallel?: Stmt[][];
    }
  | { kind: 'leftSection'; left: Expr; op: Operator; span: Span }
  | { kind: 'rightSection'; op: Operator; right: Expr; span: Span }
  | { kind: 'typed'; expr: Expr; sig: SigType; span: Span }
  | { kind: 'recordCon'; con: QName; fields: FieldBind[]; span: Span; wildcard?: Span }
  | { kind: 'recordUpdate'; expr: Expr; fields: FieldBind[]; span: Span }
  | { kind: 'paren'; expr: Expr; span: Span }
  /**
   * A visible type application, `e @t`, `e @_` (which leaves the argument to inference), or `e (type t)`
   * (`required`), which only a `forall a ->` binder takes.
   */
  | { kind: 'tyapp'; expr: Expr; type?: TypeExpr; required?: boolean; span: Span }
  | { kind: 'implicit'; name: string; span: Span }
  /** `let ?x = e in body`, which gives the body the implicit parameters. */
  | { kind: 'implicitLet'; binds: ImplicitBind[]; body: Expr; span: Span }
  /**
   * The code of a splice inside quotes, in which quotes may name the quotes' binders at their level: each binder's
   * spelling, namespace, and the variable of the quote's code that holds its new name.
   */
  | { kind: 'quoteLevel'; expr: Expr; binders: QuoteLevelBinder[]; span: Span }
  /** `e.field`, which OverloadedRecordDot reads as `getField @"field" e`. */
  | { kind: 'projection'; expr: Expr; field: string; span: Span }
  /** A library value that code the conversion generates refers to, whatever the program's scope has. */
  | { kind: 'support'; name: string; span: Span }
  /** A typed hole, `_` or an unbound name starting with `_`, which GHC reports with its type. */
  | { kind: 'hole'; name: string; span: Span }
  /** A quoted name, `'f` or `''T`, as Template Haskell's `Name` of what it names. */
  | { kind: 'thName'; name: QName; namespace: 'var' | 'con' | 'type'; span: Span }
  /**
   * A Template Haskell quote, `[| e |]`, `[p| p |]`, `[t| t |]`, `[d| ds |]`, or `[|| e ||]`, whose body the renamer
   * renames in the quote's scope before it becomes code that builds the body's tree. The body keeps its literals
   * unoverloaded, as the tree holds them; a typed quote's `witness` is its expression as the module's code has it,
   * which gives the quote its type.
   */
  | { kind: 'quote'; body: QuoteBody; witness?: Expr; span: Span }
  /** A splice inside a quote, `$(e)`, whose expression builds that part of the tree. */
  | { kind: 'thSplice'; expr: Expr; span: Span };

export type QuoteBody =
  | { kind: 'exp'; expr: Expr }
  | { kind: 'pat'; pat: Pat }
  | { kind: 'type'; type: TypeExpr }
  | { kind: 'decs'; decls: Decl[] };

export interface FieldBind {
  field: QName;
  value: Expr;
  span: Span;
  /** Whether `..` filled the field in, which names the constructor's field however its name is in scope. */
  byWildcard?: boolean;
}

export interface FieldPat {
  field: QName;
  pat: Pat;
  span: Span;
  /** Whether `..` filled the field in, which names the constructor's field however its name is in scope. */
  byWildcard?: boolean;
}

/** One element of an operator chain before fixity resolution: an operand, an operator, or a prefix minus. */
export type ChainItem<T> =
  | { kind: 'operand'; value: T }
  | { kind: 'operator'; op: Operator }
  | { kind: 'negate'; span: Span };

export type Pat =
  | { kind: 'pvar'; name: Name; span: Span }
  | { kind: 'pwild'; span: Span }
  | { kind: 'plit'; lit: SourceLiteral; negative: boolean; span: Span }
  | { kind: 'pcon'; con: QName; args: Pat[]; span: Span }
  | { kind: 'ptuple'; elems: Pat[]; span: Span }
  | { kind: 'plist'; elems: Pat[]; span: Span }
  | { kind: 'pas'; name: Name; pat: Pat; span: Span }
  | { kind: 'precord'; con: QName; fields: FieldPat[]; span: Span; wildcard?: Span }
  | { kind: 'pchain'; items: ChainItem<Pat>[]; span: Span }
  | { kind: 'pbang'; pat: Pat; span: Span }
  | { kind: 'plazy'; pat: Pat; span: Span }
  /** `(e -> p)`; `written` is the pattern the source wrote when the converter made the view, for messages. */
  | { kind: 'pview'; expr: Expr; exprText: string; pat: Pat; written?: Pat; span: Span }
  | { kind: 'por'; alts: Pat[]; span: Span }
  /** A pattern with a type signature, `(x :: Int)`, which may bind the type variables it names. */
  | { kind: 'psig'; pat: Pat; type: TypeExpr; span: Span }
  /** `@a` among a function's arguments, which binds the type variable the signature's `forall` has there. */
  | { kind: 'ptybinder'; name: Name; span: Span };

/** A type variable a `forall` or a declaration binds, with the kind it gives, as `(f :: Type -> Type)`. */
export interface TyVarBinder {
  name: Name;
  kind?: TypeExpr;
  /** Whether the binder is `{a}`, which type applications skip. */
  inferred?: boolean;
  /** Whether the binder is of `forall a ->`, whose argument callers pass visibly, `f (type Int)`. */
  required?: boolean;
}

export type TypeExpr =
  | { kind: 'tvar'; name: string; span: Span }
  | { kind: 'tkinded'; type: TypeExpr; kindSig: TypeExpr; span: Span }
  /** A data constructor used as a type, as DataKinds promotes it: `'True`, `'[]`, `':`. */
  | { kind: 'tpromoted'; name: QName; span: Span }
  | { kind: 'tpromotedList' | 'tpromotedTuple'; elems: TypeExpr[]; span: Span }
  /** A type applied to a kind, `T @Type` for `type T :: forall k. k -> Type`, which fixes its kind variable. */
  | { kind: 'tkindapp'; type: TypeExpr; kindArg: TypeExpr; span: Span }
  | { kind: 'timplicit'; name: string; type: TypeExpr; span: Span }
  | { kind: 'tlit'; value: bigint | string; span: Span }
  /** Types joined by type operators, `a :+: b`, before fixity resolution. */
  | { kind: 'tchain'; items: ChainItem<TypeExpr>[]; span: Span }
  /** A polymorphic type inside another, `forall a. C a => t`, as RankNTypes allows. */
  | { kind: 'tforall'; binders: TyVarBinder[]; context: Constraint[]; body: TypeExpr; span: Span }
  /** A type name; `star` marks the `*` token, which is the kind Type or multiplication as StarIsType decides. */
  | { kind: 'tcon'; name: QName; star?: boolean; span: Span }
  | { kind: 'tapp'; fn: TypeExpr; arg: TypeExpr; span: Span }
  /** A function type; LinearTypes' `a %1 -> b` and `a %m -> b` give its multiplicity, which is otherwise `Many`. */
  | { kind: 'tfun'; from: TypeExpr; to: TypeExpr; multiplicity?: Multiplicity; span: Span }
  | { kind: 'tlist'; elem: TypeExpr; span: Span }
  | { kind: 'ttuple'; elems: TypeExpr[]; span: Span }
  /** A splice inside a quote's type, `$(e)`, whose expression builds that part of the tree. */
  | { kind: 'tsplice'; expr: Expr; span: Span };

export type Constraint = TypeExpr;

export interface SigType {
  context: Constraint[];
  type: TypeExpr;
  span: Span;
  /** The variables of an explicit `forall`, which then scope over the definition the signature types. */
  forall?: TyVarBinder[];
}

export interface GuardedExpr {
  guards: Guard[];
  expr: Expr;
  span: Span;
}

export type Guard =
  | { kind: 'bool'; expr: Expr; span: Span }
  | { kind: 'let'; decls: Decl[]; span: Span; implicit?: ImplicitBind[] }
  | { kind: 'pat'; pat: Pat; expr: Expr; span: Span };

export interface Rhs {
  body: { kind: 'plain'; expr: Expr } | { kind: 'guarded'; branches: GuardedExpr[] };
  where: Decl[];
  /** A `where` that binds implicit parameters, `where ?x = e`, instead of the declarations of `where`. */
  implicit?: ImplicitBind[];
  span: Span;
}

export interface Alt {
  pat: Pat;
  rhs: Rhs;
  span: Span;
}

export type Stmt =
  | { kind: 'bind'; pat: Pat; expr: Expr; span: Span }
  | { kind: 'let'; decls: Decl[]; span: Span; implicit?: ImplicitBind[] }
  | { kind: 'exp'; expr: Expr; span: Span }
  /** `then f` or `then f by e` in a list comprehension, as TransformListComp allows. */
  | { kind: 'transform'; fn: Expr; by?: Expr; group: boolean; span: Span }
  /**
   * `rec { ... }` in a do block, whose statements may refer to the variables they bind later, via `mfix`; `segmented`
   * for the statements of an `mdo`, which GHC splits into the smallest such groups.
   */
  | { kind: 'rec'; stmts: Stmt[]; segmented?: boolean; span: Span };

export interface ConDecl {
  name: Name;
  fields: TypeExpr[];
  /** The strictness each field is marked with, `!` or `~`, or `undefined` for one left unmarked. */
  bangs?: FieldBang[];
  /** The positions of the strict fields, which lowering decides from the marks and StrictData. */
  strictFields?: number[];
  fieldNames?: Name[];
  isInfix: boolean;
  span: Span;
  /**
   * The type variables the constructor quantifies itself: the existential ones of `forall a. C a`, or every variable
   * of a GADT constructor's signature.
   */
  exVars?: TyVarBinder[];
  /** The constraints the constructor holds the evidence of, `Show a =>`. */
  context?: Constraint[];
  /** For a constructor in GADT syntax, the type it constructs, `T Int`. */
  result?: TypeExpr;
}

export type Decl =
  | {
      kind: 'sig';
      names: Name[];
      sig: SigType;
      span: Span;
      /** Whether the signature is a class's `default` signature, which types the method's default implementation. */
      isDefault?: boolean;
    }
  | { kind: 'fixity'; assoc: 'infix' | 'infixl' | 'infixr'; prec: number; ops: Name[]; span: Span }
  | { kind: 'funClause'; name: Name; args: Pat[]; rhs: Rhs; span: Span }
  | { kind: 'patBind'; pat: Pat; rhs: Rhs; span: Span }
  | {
      kind: 'data';
      name: Name;
      params: Name[];
      /** `type data`, whose constructors are types only, as TypeData declares them. */
      typeData?: boolean;
      paramKinds?: (TypeExpr | undefined)[];
      kindSig?: TypeExpr;
      /** Whether the head binds a kind variable invisibly, `data T @k (a :: k)`, which needs a kind signature. */
      invisibleBinders?: boolean;
      cons: ConDecl[];
      /** The constraints `data Eq a => Set a` puts on the type's constructors, as DatatypeContexts allows. */
      datatypeContext?: Constraint[];
      deriving: DerivingClause[];
      span: Span;
      /** Whether the declaration is a `newtype`, whose one constructor patterns match without evaluating. */
      newtype?: boolean;
      /** For `data instance D t = ...`, the family and the types the instance gives its parameters. */
      instanceOf?: { family: QName; patterns: TypeExpr[] };
    }
  | { kind: 'typeSyn'; name: Name; params: Name[]; paramKinds?: (TypeExpr | undefined)[]; type: TypeExpr; span: Span }
  | {
      kind: 'class';
      context: Constraint[];
      name: Name;
      params: Name[];
      paramKinds?: (TypeExpr | undefined)[];
      /** The functional dependencies, `| a -> b`, as the names each determines from. */
      fundeps: { from: Name[]; to: Name[] }[];
      decls: Decl[];
      span: Span;
    }
  /** `type family F a`, open, or closed with its equations, `type family F a where ...`. */
  | {
      kind: 'typeFamily';
      name: Name;
      params: Name[];
      paramKinds?: (TypeExpr | undefined)[];
      resultKind?: TypeExpr;
      equations?: TypeEquation[];
      /** The arguments an injectivity annotation, `= r | r -> a`, says the result determines, by position. */
      injective?: number[];
      span: Span;
      associatedWith?: string;
    }
  /** `type instance F Int = Bool`, an equation of an open family. */
  | ({
      kind: 'typeInstance';
      /** For a `type instance` in a class, the class whose instances use it when they leave the family out. */
      defaultOf?: string;
    } & TypeEquation)
  /** `data family D a`, whose instances declare their constructors. */
  | {
      kind: 'dataFamily';
      name: Name;
      params: Name[];
      paramKinds?: (TypeExpr | undefined)[];
      kindSig?: TypeExpr;
      span: Span;
      associatedWith?: string;
    }
  /**
   * `pattern P x y <- p` (matching only), `pattern P x y = p` (also building), or with `where P x y = e` (building
   * by its own equations); `fields` names a record pattern synonym's fields, which are its parameters.
   */
  | {
      kind: 'patSyn';
      name: Name;
      params: Name[];
      pattern: Pat;
      direction: 'unidirectional' | 'bidirectional' | 'explicit';
      builder?: Decl[];
      fields?: boolean;
      isInfix: boolean;
      span: Span;
    }
  | { kind: 'patSynSig'; names: Name[]; sig: SigType; span: Span }
  | { kind: 'kindSig'; name: Name; kindSig: TypeExpr; span: Span }
  | {
      kind: 'instance';
      context: Constraint[];
      cls: QName;
      types: TypeExpr[];
      decls: Decl[];
      /** How `{-# OVERLAPPING #-}` and the like let the instance overlap others. */
      overlap?: OverlapMode;
      span: Span;
    }
  /** `default (T1, T2)`, or `default C (T1, T2)` for one class, which choose the types ambiguous variables get. */
  | { kind: 'defaultTypes'; cls?: QName; types: TypeExpr[]; span: Span }
  | {
      kind: 'standaloneDeriving';
      context: Constraint[];
      cls: QName;
      type: TypeExpr;
      strategy?: DerivingStrategy;
      /** For `deriving via V instance ...`, the type `V` whose instance the derived one reuses. */
      via?: TypeExpr;
      span: Span;
    }
  /** `type role T nominal representational`, the roles of a type's parameters; `undefined` is `_`, inferred. */
  | { kind: 'roleAnnotation'; name: QName; roles: (Role | undefined)[]; span: Span };

export type FieldBang = 'strict' | 'lazy' | undefined;

export type Role = 'nominal' | 'representational' | 'phantom';

export type DerivingStrategy = 'stock' | 'anyclass' | 'newtype' | 'via';

export interface TypeEquation {
  family: QName;
  patterns: TypeExpr[];
  rhs: TypeExpr;
  span: Span;
}

export interface DerivingClause {
  cls: QName;
  strategy?: DerivingStrategy;
  /** For `deriving C via V`, the type `V` whose instance the derived one reuses. */
  via?: TypeExpr;
  span: Span;
}

export interface ImportItem {
  /** A value, a type or class, or (in an export list) `module M`, which exports what `M` brought into scope. */
  kind: 'value' | 'type' | 'module';
  name: QName;
  /** For a type or class: `undefined` for the name alone, `'all'` for `(..)`, or the listed constructors and fields. */
  children?: 'all' | QName[];
}

export interface Import {
  module: string;
  qualified: boolean;
  alias?: string;
  hiding: boolean;
  items?: ImportItem[];
  span: Span;
}

export interface Module {
  name: string;
  extensions: Extensions;
  exports?: ImportItem[];
  imports: Import[];
  decls: Decl[];
  span: Span;
}

/** The multiplicity LinearTypes writes on an arrow: `%1` (or `⊸`), `%Many`, or a variable `%m`. */
export type Multiplicity = { kind: 'one' } | { kind: 'many' } | { kind: 'var'; name: string; span: Span };

export type OverlapMode = 'OVERLAPPING' | 'OVERLAPPABLE' | 'OVERLAPS' | 'INCOHERENT';

/** A binding of an implicit parameter, `?x = e`. */
export interface ImplicitBind {
  name: string;
  expr: Expr;
  span: Span;
}

export interface QuoteLevelBinder {
  name: string;
  namespace: LocalNamespace;
  nameVariable: string;
}
