import type { Param, TypeDecl, Visibility } from './values';

/** A name a program refers to, resolved against its namespace and `use` imports. */
export interface ResolvedName {
  /** The fully qualified name, without a leading backslash. */
  name: string;
  /** The global name an unqualified function or constant name falls back to inside a namespace. */
  fallback?: string;
}

export type ClassRef =
  | { k: 'named'; name: string }
  | { k: 'self' }
  | { k: 'parent' }
  | { k: 'static' }
  | { k: 'expr'; e: Expr };

export interface Arg {
  e: Expr;
  spread: boolean;
  name?: string;
}

export interface ArrayItem {
  key?: Expr;
  value: Expr;
  byRef: boolean;
  spread: boolean;
}

export interface ListItem {
  key?: Expr;
  target: Expr;
  byRef: boolean;
}

export interface MatchArm {
  conditions?: Expr[];
  body: Expr;
  row: number;
}

/** Every expression carries the 0-based row where it starts, which warnings and exceptions report. */
export type Expr = { row: number } & (
  | { k: 'lit'; v: null | boolean | bigint | number | string }
  | { k: 'interp'; parts: (string | Expr)[] }
  | { k: 'var'; name: string }
  | { k: 'varvar'; name: Expr }
  | { k: 'array'; items: ArrayItem[] }
  | { k: 'list'; items: (ListItem | undefined)[]; keyed: boolean }
  | { k: 'idx'; base: Expr; index?: Expr }
  | { k: 'prop'; obj: Expr; name: string | Expr; nullsafe: boolean }
  | { k: 'sprop'; cls: ClassRef; name: string | Expr }
  | { k: 'cconst'; cls: ClassRef; name: string | Expr; className?: true }
  | { k: 'const'; name: ResolvedName }
  | { k: 'magic'; name: '__CLASS__' | '__FUNCTION__' | '__METHOD__' | '__TRAIT__' }
  | { k: 'call'; fn: ResolvedName | Expr; args: Arg[]; fcc: boolean; initRow?: number }
  | { k: 'mcall'; obj: Expr; name: string | Expr; args: Arg[]; nullsafe: boolean; fcc: boolean }
  | { k: 'scall'; cls: ClassRef; name: string | Expr; args: Arg[]; fcc: boolean }
  | { k: 'new'; cls: ClassRef; args: Arg[] }
  | { k: 'newAnon'; decl: ClassDecl; args: Arg[] }
  | { k: 'assign'; target: Expr; value: Expr }
  | { k: 'assignRef'; target: Expr; source: Expr }
  | { k: 'assignOp'; op: string; target: Expr; value: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr; foldedString?: string; swapOperands?: boolean }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'incdec'; inc: boolean; prefix: boolean; target: Expr }
  | { k: 'cond'; test: Expr; consequent?: Expr; alternate: Expr }
  | { k: 'cast'; type: string; e: Expr }
  | { k: 'silence'; e: Expr }
  | { k: 'clone'; e: Expr }
  | { k: 'throw'; e: Expr }
  | { k: 'isset'; items: Expr[] }
  | { k: 'empty'; e: Expr }
  | { k: 'closure'; fn: FunctionDecl; uses: { name: string; byRef: boolean }[]; isStatic: boolean }
  | { k: 'arrow'; fn: FunctionDecl; isStatic: boolean; parenthesized?: true }
  | { k: 'instanceof'; e: Expr; cls: ClassRef }
  | { k: 'match'; subject: Expr; arms: MatchArm[]; jumpTable?: boolean }
  | { k: 'print'; e: Expr }
  | { k: 'pipe'; l: Expr; r: Expr }
  | { k: 'unsupported'; what: string }
);

export type ExprKind = Expr['k'];

export interface CatchClause {
  types: string[];
  varName?: string;
  body: Stmt[];
  row: number;
}

export interface SwitchCase {
  test?: Expr;
  body: Stmt[];
  row: number;
}

/** Every statement carries the 0-based row where it starts, at which it records its step. */
export type Stmt = { row: number } & (
  | { k: 'expr'; e: Expr; onlyCalls: boolean }
  | { k: 'echo'; args: Expr[] }
  | { k: 'inline'; text: string }
  | { k: 'if'; cond: Expr; consequent: Stmt[]; alternate?: Stmt[]; continuation?: 'elseif' | 'else if' }
  | { k: 'while'; cond: Expr; body: Stmt[] }
  | { k: 'do'; body: Stmt[]; cond: Expr }
  | { k: 'for'; init: Expr[]; cond: Expr[]; update: Expr[]; body: Stmt[] }
  | {
      k: 'foreach';
      subject: Expr;
      key?: Expr;
      value: Expr;
      byRef: boolean;
      body: Stmt[];
    }
  | { k: 'switch'; subject: Expr; cases: SwitchCase[] }
  | { k: 'break' | 'continue'; depth: number; explicitDepth?: true }
  | { k: 'return'; e?: Expr }
  | { k: 'block'; body: Stmt[] }
  | { k: 'try'; body: Stmt[]; catches: CatchClause[]; fin?: Stmt[] }
  | { k: 'global'; names: Expr[] }
  | { k: 'static'; vars: { name: string; init?: Expr }[] }
  | { k: 'unset'; targets: Expr[] }
  | { k: 'func'; decl: FunctionDecl }
  | { k: 'class'; decl: ClassDecl }
  | { k: 'const'; items: { name: string; value: Expr }[] }
  | { k: 'goto'; label: string; offset: number }
  | { k: 'label'; name: string }
  | { k: 'nop' }
);

export interface FunctionDecl {
  name: string;
  isPropertyHook?: boolean;
  params: ParamDecl[];
  returnType?: TypeDecl;
  byRefReturn: boolean;
  body: Stmt[];
  /** For an arrow function, the expression it returns. */
  arrowBody?: Expr;
  row: number;
  endRow: number;
  isAtomic: boolean;
  /** Whether the body uses `$this`, `func_get_args`, or other things a call must provide. */
  usesThis: boolean;
  /** The variables an arrow function reads from where it is defined. */
  captures?: string[];
  /** The labels the body declares, which `goto` jumps to. */
  hasGoto: boolean;
  isStatic?: boolean;
  /** The namespace the function was declared in, for `__NAMESPACE__` and name resolution. */
  namespace: string;
  /** The class the method belongs to, for `__CLASS__` inside a closure. */
  className?: string;
  /** Whether the declaration is a closure or an arrow function. */
  isClosure: boolean;
}

export interface ParamDecl extends Param {
  defaultExpr?: Expr;
  promote?: { visibility: Visibility; isReadonly: boolean; isFinal: boolean; setVisibility?: Visibility };
  row: number;
}

export interface PropertyDeclAst {
  name: string;
  visibility: Visibility;
  setVisibility?: Visibility;
  isStatic: boolean;
  isReadonly: boolean;
  promoted?: boolean;
  type?: TypeDecl;
  defaultExpr?: Expr;
  hooks?: { get?: FunctionDecl; set?: FunctionDecl; setParam?: string; abstractGet?: boolean; abstractSet?: boolean };
  /** Whether the hooks never read or write the property itself, so it has no storage. */
  isVirtual?: boolean;
  row: number;
  isAbstract: boolean;
  isFinal: boolean;
}

export interface MethodDeclAst {
  fn: FunctionDecl;
  visibility: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
}

export interface ClassDecl {
  /** The name messages show; for an anonymous class, `class@anonymous` or the name of what it extends or implements. */
  name: string;
  /** The name `get_class` and `::class` give an anonymous class, which holds a NUL byte, the file, and the line. */
  fullName?: string;
  kind: 'class' | 'interface' | 'trait';
  parent?: string;
  interfaces: string[];
  isAbstract: boolean;
  isFinal: boolean;
  isReadonly: boolean;
  consts: { name: string; value: Expr; visibility: Visibility; isFinal: boolean; row: number; type?: TypeDecl }[];
  props: PropertyDeclAst[];
  methods: MethodDeclAst[];
  traits: { names: string[]; rules: TraitRule[]; row: number }[];
  row: number;
  endRow: number;
  isAnonymous: boolean;
}

export type TraitRule =
  | { k: 'insteadof'; trait: string; method: string; instead: string[] }
  | { k: 'as'; trait?: string; method: string; alias?: string; visibility?: Visibility };

export interface Program {
  body: Stmt[];
  /** Whether the program declares `strict_types=1`. */
  strictTypes: boolean;
  hasGoto: boolean;
  /** The global variables in order of first appearance, which PHP's symbol table and shutdown follow. */
  mainVars: string[];
}
