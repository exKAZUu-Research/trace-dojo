import type { ConInfo } from './entities';
import type { Type } from './types';

export const UNKNOWN_TYPE: Type = { tag: 'tgen', index: -1 };

export type TypeHint =
  | Type
  | TypeHintRef
  | { tag: 'refinement'; template: TypeHint; actual: TypeHint }
  | { tag: 'fieldType'; parent: TypeHint; con: ConInfo; position: number };

export interface TypeHintRef {
  tag: 'hint';
  value: TypeHint;
}
