import type { Constant } from './constantDefaults';
import type { Param, TypeDecl, Value, Visibility } from './values';

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
  | { k: 'expr'; e: Expr; fetchRow?: number };

export interface Arg {
  e: Expr;
  spread: boolean;
  name?: string;
  sendRow?: number;
}

export interface ArrayItem {
  key?: Expr;
  keyOpcodeRow?: number;
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
  | { k: 'array'; items: ArrayItem[]; initializerRow?: number; mixedStorage?: boolean }
  | { k: 'list'; items: (ListItem | undefined)[]; keyed: boolean }
  | { k: 'idx'; base: Expr; index?: Expr }
  | { k: 'prop'; obj: Expr; name: string | Expr; nullsafe: boolean }
  | { k: 'sprop'; cls: ClassRef; name: string | Expr }
  | { k: 'cconst'; cls: ClassRef; name: string | Expr; className?: true | 'initializer'; scopeRow?: number }
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
  | {
      k: 'bin';
      op: string;
      l: Expr;
      r: Expr;
      foldedString?: string;
      concatArrayCasts?: { left: boolean; right: boolean };
      swapOperands?: boolean;
    }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'incdec'; inc: boolean; prefix: boolean; target: Expr }
  | { k: 'cond'; test: Expr; consequent?: Expr; alternate: Expr }
  | { k: 'cast'; type: string; e: Expr }
  | { k: 'silence'; e: Expr }
  | { k: 'clone'; e: Expr }
  | { k: 'throw'; e: Expr }
  | { k: 'isset'; items: Expr[] }
  | { k: 'empty'; e: Expr }
  | { k: 'closure'; fn: FunctionDecl; uses: { name: string; byRef: boolean; row: number }[]; isStatic: boolean }
  | { k: 'arrow'; fn: FunctionDecl; isStatic: boolean; parenthesized?: true }
  | { k: 'instanceof'; e: Expr; cls: ClassRef }
  | { k: 'match'; subject: Expr; arms: MatchArm[]; jumpTable?: boolean }
  | { k: 'print'; e: Expr }
  | { k: 'pipe'; l: Expr; r: Expr }
  | { k: 'yield'; key?: Expr; value?: Expr; byRef: boolean }
  | { k: 'yieldFrom'; e: Expr }
  /** A value a generator evaluated before it suspended, which the rest of the expression uses after it resumes. */
  | { k: 'held'; v: Value }
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

/**
 * Every statement carries the 0-based row where it starts, at which it records its step. A generator's statement whose
 * own expressions or loop header contain a `yield` is marked as suspending, which runs them step by step.
 */
export type Stmt = { row: number; suspends?: true } & (
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
      subjectEndRow: number;
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
  | { k: 'static'; vars: { name: string; init?: Expr; preview?: Constant }[] }
  | { k: 'unset'; targets: Expr[] }
  | { k: 'func'; decl: FunctionDecl }
  | { k: 'class'; decl: ClassDecl }
  | { k: 'const'; items: { name: string; value: Expr; opcodeRow: number }[] }
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
  /** Whether the body contains `yield`, so that a call returns a Generator that runs the body. */
  isGenerator?: boolean;
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
  hooks?: {
    get?: FunctionDecl;
    set?: FunctionDecl;
    getBacking?: boolean;
    setBacking?: boolean;
    finalGet?: boolean;
    finalSet?: boolean;
    abstractGet?: boolean;
    abstractSet?: boolean;
    syntax?: PropertyHookSyntax[];
  };
  /** Whether the hooks never read or write the property itself, so it has no storage. */
  isVirtual?: boolean;
  row: number;
  isAbstract: boolean;
  isFinal: boolean;
}

export interface ParamDecl extends Param {
  defaultExpr?: Expr;
  defaultReportRow?: number;
  promote?: PropertyDeclAst;
  row: number;
}

export interface MethodDeclAst {
  fn: FunctionDecl;
  visibility: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  syntaxHasBody?: boolean;
}

export interface PropertyHookSyntax {
  name: 'get' | 'set';
  body?: Stmt[];
  expression?: Expr;
  isFinal: boolean;
  byRefReturn: boolean;
}

export type ClassMemberSyntax =
  | { k: 'const'; items: ClassDecl['consts'] }
  | { k: 'property'; items: PropertyDeclAst[]; explicitReadonly: boolean }
  | { k: 'method'; method: MethodDeclAst }
  | { k: 'use'; trait: ClassDecl['traits'][number]; hasBlock: boolean };

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
  syntaxMembers?: ClassMemberSyntax[];
  row: number;
  endRow: number;
  isAnonymous: boolean;
}

export type TraitRule =
  | { k: 'insteadof'; trait: string; method: string; instead: string[] }
  | { k: 'as'; trait?: string; method: string; alias?: string; visibility?: Visibility; isFinal?: boolean };

export interface Program {
  body: Stmt[];
  /** Whether the program declares `strict_types=1`. */
  strictTypes: boolean;
  hasGoto: boolean;
  /** The global variables in order of first appearance, which PHP's symbol table and shutdown follow. */
  mainVars: string[];
}
