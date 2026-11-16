import type { ClassEntity, InstanceInfo, TypeEntity, ValueEntity } from './entities';

export type TypeLike = { kind: 'type'; entity: TypeEntity } | { kind: 'class'; entity: ClassEntity };

/** What a module exports: values, and types and classes with their constructors, fields, or methods. */
export interface ExportTable {
  values: Map<string, ValueEntity>;
  types: Map<string, { entity: TypeLike; children: ValueEntity[] }>;
}

export function emptyExports(): ExportTable {
  return { values: new Map(), types: new Map() };
}

/** A module after compiling, which other modules import. */
export interface CompiledModuleInfo {
  name: string;
  exports: ExportTable;
  instances: InstanceInfo[];
}

/** Why a name or module the environment knows cannot be used, for the message that rejects it. */
export interface UnsupportedInfo {
  what: string;
}
