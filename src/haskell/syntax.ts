import type { Extensions } from './extensions';

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

/** A possibly qualified name, such as `M.fromList`. */
export interface QName extends Name {
  qualifier?: string;
}

export type Literal =
  | { kind: 'int'; value: bigint }
  | { kind: 'frac'; value: number; text: string }
  | { kind: 'char'; value: string }
  | { kind: 'string'; value: string[] };

export type SourceLiteral = Literal & { text: string };

/** An operator between operands, written as a symbol (`+`, `:`) or a name in backticks (`` `div` ``). */
export interface Operator extends QName {
  isConstructor: boolean;
}

export type Expr =
  | { kind: 'var'; name: QName; span: Span }
  | { kind: 'con'; name: QName; span: Span }
  | { kind: 'lit'; lit: Literal; span: Span }
  | { kind: 'app'; fn: Expr; arg: Expr; span: Span }
  | { kind: 'chain'; items: ChainItem<Expr>[]; span: Span }
  | { kind: 'binop'; op: Operator; left: Expr; right: Expr; span: Span }
  | { kind: 'neg'; expr: Expr; span: Span }
  | { kind: 'lambda'; pats: Pat[]; body: Expr; span: Span }
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
  /** A visible type application, `f @Int`, or `f @_`, which leaves the argument to inference. */
  | { kind: 'tyapp'; expr: Expr; type?: TypeExpr; span: Span }
  /** A typed hole, `_` or an unbound name starting with `_`, which GHC reports with its type. */
  | { kind: 'hole'; name: string; span: Span };

export interface FieldBind {
  field: QName;
  value: Expr;
  span: Span;
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
  | { kind: 'precord'; con: QName; fields: { field: QName; pat: Pat; span: Span }[]; span: Span; wildcard?: Span }
  | { kind: 'pchain'; items: ChainItem<Pat>[]; span: Span }
  | { kind: 'pbang'; pat: Pat; span: Span }
  | { kind: 'plazy'; pat: Pat; span: Span }
  | { kind: 'pview'; expr: Expr; exprText: string; pat: Pat; span: Span }
  | { kind: 'por'; alts: Pat[]; span: Span }
  /** A pattern with a type signature, `(x :: Int)`, which may bind the type variables it names. */
  | { kind: 'psig'; pat: Pat; type: TypeExpr; span: Span };

/** A type variable a `forall` or a declaration binds, with the kind it gives, as `(f :: Type -> Type)`. */
export interface TyVarBinder {
  name: Name;
  kind?: TypeExpr;
  /** Whether the binder is `{a}`, which type applications skip. */
  inferred?: boolean;
}

export type TypeExpr =
  | { kind: 'tvar'; name: string; span: Span }
  /** A type with a kind annotation, `(t :: k)`. */
  | { kind: 'tkinded'; type: TypeExpr; kindSig: TypeExpr; span: Span }
  | { kind: 'tcon'; name: QName; span: Span }
  | { kind: 'tapp'; fn: TypeExpr; arg: TypeExpr; span: Span }
  | { kind: 'tfun'; from: TypeExpr; to: TypeExpr; span: Span }
  | { kind: 'tlist'; elem: TypeExpr; span: Span }
  | { kind: 'ttuple'; elems: TypeExpr[]; span: Span };

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
  | { kind: 'let'; decls: Decl[]; span: Span }
  | { kind: 'pat'; pat: Pat; expr: Expr; span: Span };

/** The right-hand side of an equation or alternative: a plain expression or guarded ones, with `where` bindings. */
export interface Rhs {
  body: { kind: 'plain'; expr: Expr } | { kind: 'guarded'; branches: GuardedExpr[] };
  where: Decl[];
  span: Span;
}

export interface Alt {
  pat: Pat;
  rhs: Rhs;
  span: Span;
}

export type Stmt =
  | { kind: 'bind'; pat: Pat; expr: Expr; span: Span }
  | { kind: 'let'; decls: Decl[]; span: Span }
  | { kind: 'exp'; expr: Expr; span: Span };

export interface ConDecl {
  name: Name;
  fields: TypeExpr[];
  /** The positions of the fields marked `!`, which only the library may declare. */
  strictFields?: number[];
  /** The field names of a record constructor, one per field. */
  fieldNames?: Name[];
  isInfix: boolean;
  span: Span;
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
      /** The kinds the parameters' annotations give, by position. */
      paramKinds?: (TypeExpr | undefined)[];
      cons: ConDecl[];
      deriving: DerivingClause[];
      span: Span;
      /** Whether the declaration is a `newtype`, whose one constructor patterns match without evaluating. */
      newtype?: boolean;
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
  /** A standalone kind signature, `type T :: Type -> Type`. */
  | { kind: 'kindSig'; name: Name; kindSig: TypeExpr; span: Span }
  | { kind: 'instance'; context: Constraint[]; cls: QName; types: TypeExpr[]; decls: Decl[]; span: Span }
  /** `default (T1, T2)`, or `default C (T1, T2)` for one class, which choose the types ambiguous variables get. */
  | { kind: 'defaultTypes'; cls?: QName; types: TypeExpr[]; span: Span }
  | {
      kind: 'standaloneDeriving';
      context: Constraint[];
      cls: QName;
      type: TypeExpr;
      strategy?: DerivingStrategy;
      span: Span;
    };

export type DerivingStrategy = 'stock' | 'anyclass' | 'newtype' | 'via';

/** A class a `deriving` clause names, with the strategy it gives. */
export interface DerivingClause {
  cls: QName;
  strategy?: DerivingStrategy;
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
