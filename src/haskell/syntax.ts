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
  | { kind: 'case'; scrutinee: Expr; alts: Alt[]; span: Span }
  | { kind: 'do'; stmts: Stmt[]; span: Span }
  | { kind: 'tuple'; elems: Expr[]; span: Span }
  | { kind: 'list'; elems: Expr[]; span: Span }
  | { kind: 'arith'; from: Expr; next?: Expr; to?: Expr; span: Span }
  | { kind: 'comprehension'; expr: Expr; quals: Stmt[]; span: Span }
  | { kind: 'leftSection'; left: Expr; op: Operator; span: Span }
  | { kind: 'rightSection'; op: Operator; right: Expr; span: Span }
  | { kind: 'typed'; expr: Expr; sig: SigType; span: Span }
  | { kind: 'recordCon'; con: QName; fields: FieldBind[]; span: Span }
  | { kind: 'recordUpdate'; expr: Expr; fields: FieldBind[]; span: Span }
  | { kind: 'paren'; expr: Expr; span: Span };

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
  | { kind: 'precord'; con: QName; fields: { field: QName; pat: Pat; span: Span }[]; span: Span }
  | { kind: 'pchain'; items: ChainItem<Pat>[]; span: Span };

export type TypeExpr =
  | { kind: 'tvar'; name: string; span: Span }
  | { kind: 'tcon'; name: QName; span: Span }
  | { kind: 'tapp'; fn: TypeExpr; arg: TypeExpr; span: Span }
  | { kind: 'tfun'; from: TypeExpr; to: TypeExpr; span: Span }
  | { kind: 'tlist'; elem: TypeExpr; span: Span }
  | { kind: 'ttuple'; elems: TypeExpr[]; span: Span };

export interface Constraint {
  cls: QName;
  types: TypeExpr[];
  span: Span;
}

export interface SigType {
  context: Constraint[];
  type: TypeExpr;
  span: Span;
}

export interface GuardedExpr {
  guards: Guard[];
  expr: Expr;
  span: Span;
}

export type Guard = { kind: 'bool'; expr: Expr; span: Span } | { kind: 'let'; decls: Decl[]; span: Span };

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
  | { kind: 'sig'; names: Name[]; sig: SigType; span: Span }
  | { kind: 'fixity'; assoc: 'infix' | 'infixl' | 'infixr'; prec: number; ops: Name[]; span: Span }
  | { kind: 'funClause'; name: Name; args: Pat[]; rhs: Rhs; span: Span }
  | { kind: 'patBind'; pat: Pat; rhs: Rhs; span: Span }
  | { kind: 'data'; name: Name; params: Name[]; cons: ConDecl[]; deriving: QName[]; derivingSpan?: Span; span: Span }
  | { kind: 'typeSyn'; name: Name; params: Name[]; type: TypeExpr; span: Span }
  | { kind: 'class'; context: Constraint[]; name: Name; param: Name; decls: Decl[]; span: Span }
  | { kind: 'instance'; context: Constraint[]; cls: QName; type: TypeExpr; decls: Decl[]; span: Span };

export interface ImportItem {
  kind: 'value' | 'type';
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
  exports?: ImportItem[];
  imports: Import[];
  decls: Decl[];
  span: Span;
}
