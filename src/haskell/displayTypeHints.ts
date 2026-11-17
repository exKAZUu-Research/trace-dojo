import type { Core } from './core';
import type { ConInfo } from './entities';
import type { Runtime } from './runtime';
import type { Type } from './types';
import type { Dict, Env, Slot } from './values';

export const UNKNOWN_TYPE: Type = { tag: 'tgen', index: -1 };

export type TypeHint =
  | Type
  | TypeHintRef
  | { tag: 'refinement'; template: TypeHint; actual: TypeHint }
  | { tag: 'fieldType'; parent: TypeHint; con: ConInfo; position: number }
  | {
      tag: 'frameType';
      code: Extract<Core, { k: 'frame' }>;
      env: Env | undefined;
      runtime: Runtime;
      resolved?: TypeHint;
    }
  | { tag: 'dictionaryType'; dict: Dict; runtime: Runtime; arguments?: TypeHint[] }
  | { tag: 'deferredMethodType'; dict: Slot; index: number; runtime: Runtime; resolved?: TypeHint }
  | { tag: 'methodType'; parent: TypeHint; template: Type; parameters: number }
  | { tag: 'applicationType'; parent: TypeHint; arguments: number };

export interface TypeHintRef {
  tag: 'hint';
  value: TypeHint;
}
