/**
 * Whether the value of a statement or call is used: 0 when discarded, 1 when used, 2 when it is the value of the
 * method or block body that holds it, which only the caller knows.
 */
export type Use = 0 | 1 | 2;

/**
 * How a statement records its step: `assign` stores a value, `call` only calls methods, `expr` computes with calls,
 * `value` computes without calls, `constant` assigns a constant a literal (recording no step, as Java's static
 * constants do), and `none` is a statement whose inner statements record the steps (`if`, `while`, `def`, ...).
 */
export type StepKind = 'none' | 'assign' | 'call' | 'expr' | 'value' | 'constant';

export interface Stmt {
  e: Expr;
  /** The 0-based row of the statement's first line. */
  row: number;
  use: Use;
  step: StepKind;
}

export type Body = Stmt[];

export type StrPart = string | Expr | { text: string; bytes: number[] };

/** A local variable, found `depth` block scopes out from the scope that refers to it. */
export interface LocalRef {
  k: 'lvar';
  name: string;
  depth: number;
}

export type Target =
  | LocalRef
  | { k: 'ivar'; name: string }
  | { k: 'gvar'; name: string }
  | { k: 'cvar'; name: string }
  | { k: 'const'; scope?: Expr; top?: boolean; name: string; row: number }
  | { k: 'index'; recv: Expr; args: Expr[]; row: number }
  | { k: 'attr'; recv: Expr; name: string; safe: boolean; row: number }
  | MultiTarget;

/** The targets of a multiple assignment, where `splat` is the position of the one that takes the rest. */
export interface MultiTarget {
  k: 'mlhs';
  items: Target[];
  splat?: number;
}

export interface Params {
  required: ParamTarget[];
  optional: { name: string; value: Expr }[];
  /** The name of `*rest`, or '' for an anonymous `*`. */
  rest?: string;
  post: ParamTarget[];
  keywords: { name: string; value?: Expr }[];
  /** The name of `**opts`, or '' for an anonymous `**`. */
  keywordRest?: string;
  block?: string;
  /** Whether a block's parameter list ends with a comma (`|a,|`), which splats one array argument. */
  trailingComma: boolean;
}

export type ParamTarget = string | MultiTarget;

export interface BlockDef {
  params: Params | undefined;
  /** The local variables a block declares itself, in the order learners see them: parameters first. */
  locals: string[];
  body: Body;
  row: number;
  /** Whether the block's parameter count is fixed as a lambda's is, for `->` literals. */
  isLambdaLiteral: boolean;
}

export interface Rescue {
  classes: Expr[];
  variable?: Target;
  body: Body;
  row: number;
}

export interface MethodDef {
  name: string;
  params: Params;
  body: Body;
  /** The local variables of the method, in declaration order. */
  locals: string[];
  row: number;
  isAtomic: boolean;
}

export type Expr =
  | { k: 'nil' }
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'self' }
  | { k: 'int'; v: bigint }
  | { k: 'float'; v: number }
  | { k: 'str'; parts: StrPart[] }
  | { k: 'sym'; name: string }
  | { k: 'dsym'; parts: StrPart[] }
  | { k: 'array'; items: Expr[] }
  | { k: 'hash'; items: HashItem[]; braces: boolean }
  | { k: 'range'; from?: Expr; to?: Expr; exclusive: boolean }
  | LocalRef
  | { k: 'ivar'; name: string }
  | { k: 'gvar'; name: string }
  | { k: 'cvar'; name: string }
  | { k: 'const'; scope?: Expr; top?: boolean; name: string; row: number }
  | { k: 'splat'; e: Expr }
  | { k: 'blockpass'; e?: Expr }
  | { k: 'asgn'; target: Target; value: Expr; row: number }
  | { k: 'opasgn'; target: Target; op: string; value: Expr; row: number }
  | Call
  | { k: 'super'; args?: Expr[]; blockArg?: Expr; block?: BlockDef; used: Use; row: number }
  | { k: 'yield'; args: Expr[]; used: Use; row: number }
  | { k: 'and' | 'or'; l: Expr; r: Expr }
  | { k: 'not'; e: Expr; row: number }
  | { k: 'if'; cond: Expr; consequent: Body; alternative?: Body }
  | { k: 'while'; cond: Expr; body: Body; until: boolean; doWhile: boolean }
  | { k: 'for'; target: Target; iter: Expr; body: Body; row: number }
  | { k: 'case'; subject?: Expr; whens: { conds: Expr[]; body: Body; row: number }[]; else?: Body }
  | { k: 'break' | 'next'; value?: Expr; inBlock: boolean }
  | { k: 'return'; value?: Expr }
  | { k: 'retry' }
  | { k: 'begin'; body: Body; rescues: Rescue[]; else?: Body; ensure?: Body }
  | { k: 'seq'; body: Body }
  | { k: 'def'; def: MethodDef; singleton?: Expr }
  | { k: 'class'; scope?: Expr; top?: boolean; name: string; superclass?: Expr; body: Body; row: number }
  | { k: 'module'; scope?: Expr; top?: boolean; name: string; body: Body; row: number }
  | { k: 'lambda'; block: BlockDef }
  | { k: 'rescueMod'; body: Expr; handler: Expr };

export type HashItem = { key: Expr; value: Expr } | { splat: Expr };

export interface Call {
  k: 'call';
  recv?: Expr;
  name: string;
  args: Expr[];
  blockArg?: Expr;
  block?: BlockDef;
  /** Whether the call is `recv&.name`, which skips the call when `recv` is nil. */
  safe: boolean;
  /** Whether the call has no receiver (or `self.` as its receiver), which may call private methods. */
  fcall: boolean;
  /** Whether the call is a bare name with no arguments, which a local variable could have meant. */
  vcall: boolean;
  used: Use;
  row: number;
}

export interface Program {
  body: Body;
  locals: string[];
}
