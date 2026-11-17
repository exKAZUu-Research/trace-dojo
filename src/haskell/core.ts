import type { ConInfo, InstanceInfo, ValueEntity } from './entities';
import type { Primitive } from './primitives';
import type { Type } from './types';
import type { Value } from './values';
import type { VisibleScope } from './visibleScope';

export interface LocalRef {
  depth: number;
  index: number;
}

/** A function or top-level binding whose calls are frames in a trace. */
export interface FunctionInfo {
  name: string;
  /** The row of its declaration, which `-- atomic` marks. */
  row: number;
  isAtomic: boolean;
}

export type Core = (
  | { k: 'local'; depth: number; index: number }
  | { k: 'global'; global: GlobalDef }
  | { k: 'lit'; value: Value }
  | { k: 'str'; value: readonly string[] }
  | { k: 'app'; fn: Core; args: Core[] }
  | LamCore
  | { k: 'frame'; size: number; body: Core; info: FunctionInfo | undefined }
  | { k: 'let'; binds: { index: number; expr: Core }[]; body: Core }
  | CaseCore
  | { k: 'charCase'; scrut: Core; value: string; matched: Core; unmatched: Core }
  | { k: 'con'; con: ConInfo; args: Core[] }
  | { k: 'prim'; prim: Primitive }
  | { k: 'method'; dict: Core; index: number }
  | { k: 'super'; dict: Core; index: number }
  | { k: 'deferredDo'; ordinary?: Core; io: IODoCore }
  | { k: 'dict'; instance: InstanceInfo; args: Core[] }
  | { k: 'error'; message: string; kind: 'error' | 'patternMatch' }
  | IODoCore
) & { displayType?: Type };

export interface LamCore {
  displayConstraints?: Type[];
  displayParameters?: Type[];
  k: 'lam';
  arity: number;
  /** The number of slots of the lambda's frame: its parameters, then the variables its body binds. */
  size: number;
  body: Core;
  /** Set for a named function, whose calls are trace frames. */
  info?: FunctionInfo;
}

export interface CaseCore {
  k: 'case';
  scrut: Core;
  /** The slot that receives the evaluated scrutinee, if any. */
  bindIndex?: number;
  /** The alternatives by constructor tag, each with the slots its fields go to (-1 for unused fields). */
  alts: Map<number, { slots: number[]; body: Core }>;
  default?: Core;
}

export type IOStmt =
  | {
      kind: 'exp';
      row: number;
      expr: Core;
      /** Whether the statement only calls functions, whose steps may show what it did. */
      onlyCalls: boolean;
      /** Whether the statement is a control statement (`if`, `case`, `when`), which records no step itself. */
      noStep: boolean;
      visible: VisibleScope;
    }
  | {
      kind: 'bind';
      row: number;
      expr: Core;
      /** The slot that receives the action's result. */
      slot: number;
      /** Code that matches the result against the pattern and binds its variables, if it is not a variable. */
      matcher?: Core;
      onlyCalls: boolean;
      visible: VisibleScope;
    }
  | {
      kind: 'let';
      row: number;
      binds: { index: number; expr: Core }[];
      visible: VisibleScope;
      /** Whether the statement defines only functions and actions, which records no step. */
      noStep: boolean;
    };

export interface IODoCore {
  k: 'iodo';
  size: number;
  stmts: IOStmt[];
  /** The row of the lambda whose parameters a block binds, which records a binding step when the block starts. */
  bindingRow?: number;
  /** The lambda's bound names, whose instantiated slots determine whether they store answers. */
  bindingNames?: string[];
  /** The variables visible when the block starts. */
  entryVisible: VisibleScope;
}

/** A top-level binding of the library or the program, which each run evaluates at most once. */
export interface GlobalDef {
  entity: ValueEntity | undefined;
  name: string;
  code?: Core;
}
