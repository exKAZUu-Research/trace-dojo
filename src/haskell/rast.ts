/**
 * The syntax after renaming: every name resolved, operators resolved by fixity, and patterns normalized to
 * constructor applications. The type checker annotates it with types and class evidence.
 */
import type { ClassEntity, ConInfo, DictParam, Evidence, FieldInfo, Fixity, TypeEntity, ValueEntity } from './entities';
import type { Literal, Pat, Span } from './syntax';
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

export type RExpr =
  | {
      k: 'var';
      ref: VarRef;
      name: string;
      span: Span;
      /** The dictionaries the variable's instantiated scheme takes, in order. */
      evidence?: Evidence[];
      type?: Type;
    }
  | { k: 'con'; con: ConInfo; span: Span }
  | { k: 'lit'; lit: Literal; span: Span; evidence?: Evidence; type?: Type }
  | { k: 'app'; fn: RExpr; arg: RExpr; span: Span }
  | { k: 'lambda'; pats: RPat[]; body: RExpr; span: Span; type?: Type }
  | { k: 'let'; binds: RBindGroup; body: RExpr; span: Span }
  | { k: 'if'; cond: RExpr; ifTrue: RExpr; ifFalse: RExpr; span: Span }
  | { k: 'case'; scrutinee: RExpr; alts: RAlt[]; span: Span }
  | {
      k: 'do';
      stmts: RStmt[];
      span: Span;
      /** The `Monad` dictionary of the block's monad. */
      monad?: Evidence;
      type?: Type;
    }
  | { k: 'tuple'; elems: RExpr[]; span: Span }
  | { k: 'list'; elems: RExpr[]; span: Span }
  | { k: 'arith'; from: RExpr; next?: RExpr; to?: RExpr; span: Span; evidence?: Evidence }
  | { k: 'comp'; expr: RExpr; quals: RStmt[]; span: Span }
  | { k: 'rsection'; op: RExpr; right: RExpr; span: Span }
  | { k: 'typed'; expr: RExpr; sig: RSigType; span: Span; dictParams?: DictParam[]; evidence?: Evidence[] }
  | { k: 'recordCon'; con: ConInfo; fields: RFieldBind[]; span: Span }
  | { k: 'recordUpdate'; expr: RExpr; fields: RFieldBind[]; span: Span; cons?: ConInfo[] };

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
      /** The `Eq` dictionary for comparing, and the `Num` or `Fractional` one for building the literal. */
      eq?: Evidence;
      num?: Evidence;
      type?: Type;
    }
  | { k: 'con'; con: ConInfo; args: RPat[]; order?: number[]; span: Span }
  | { k: 'as'; local: LocalVar; pat: RPat; span: Span }
) & { surface?: Pat };

export type RType =
  | { k: 'var'; name: string; span: Span }
  | { k: 'con'; entity: TypeEntity; span: Span }
  | { k: 'app'; fn: RType; arg: RType; span: Span }
  | { k: 'fun'; from: RType; to: RType; span: Span };

export interface RConstraint {
  cls: ClassEntity;
  type: RType;
  span: Span;
}

export interface RSigType {
  context: RConstraint[];
  type: RType;
  span: Span;
}

export interface RGuarded {
  guards: RGuard[];
  expr: RExpr;
  span: Span;
}

export type RGuard = { k: 'bool'; expr: RExpr; span: Span } | { k: 'let'; binds: RBindGroup; span: Span };

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
      /** The signatures of the pattern's variables. */
      patSigs?: Map<LocalVar, RSigType>;
    };

export interface RBindGroup {
  bindings: RBinding[];
}

export function bindingName(binding: RBinding): string {
  if (binding.k === 'pat') return binding.binders.map((binder) => binder.name).join(', ');
  return binding.binder.kind === 'local' ? binding.binder.local.name : binding.binder.entity.name;
}
