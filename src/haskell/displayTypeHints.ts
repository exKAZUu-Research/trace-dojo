import type { ConInfo } from './entities';
import type { Runtime } from './runtime';
import type { Type } from './types';
import type { Dict, Slot } from './values';

export const UNKNOWN_TYPE: Type = { tag: 'tgen', index: -1 };

export type TypeHint =
  | Type
  | TypeHintRef
  | { tag: 'refinement'; template: TypeHint; actual: TypeHint }
  | { tag: 'fieldType'; parent: TypeHint; con: ConInfo; position: number }
  | { tag: 'scopedType'; template: Type; scope: DisplayTypeScope; children?: TypeHint[] }
  | { tag: 'matchedType'; pattern: Type; variable: Type; parent: TypeHint }
  | { tag: 'dictionaryArgumentType'; slot: Slot; runtime: Runtime; resolved?: TypeHint }
  | { tag: 'dictionaryType'; dict: Dict; runtime: Runtime; arguments?: TypeHint[] }
  | { tag: 'methodType'; parent: TypeHint; template: Type; parameters: number; dictionaries: number }
  | { tag: 'applicationType'; parent: TypeHint; arguments: number };

export interface TypeHintRef {
  tag: 'hint';
  value: TypeHint;
}

export interface DisplayTypeScope {
  parent: DisplayTypeScope | undefined;
  constraints: { pattern: Type; actual: TypeHint }[];
  bindings?: Map<Type, TypeHint>;
}
