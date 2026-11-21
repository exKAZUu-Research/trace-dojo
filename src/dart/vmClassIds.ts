import type { ClassInfo } from './classes';
import type { Declaration } from './environment';
import { eraseExtensionTypes } from './eraseExtensionTypes';
import { type DartType, sameType } from './types';

// Dart SDK 3.13.7 JIT's platform snapshot occupies class IDs through 1233.
const FIRST_PROGRAM_CLASS_ID = 1234;

export function assignVmClassIds(declarations: Iterable<Declaration>): void {
  let nextId = FIRST_PROGRAM_CLASS_ID;
  const applications = new Map<string, ClassInfo[]>();
  const reserve = (cls: ClassInfo): void => {
    if (cls.library !== '' || cls.kind === 'extensionType' || cls.vmClassId !== undefined) return;
    const previous = sharedApplication(cls, applications);
    cls.vmClassId = previous ?? nextId++;
  };
  const loadType = (type: DartType): void => reserveReferencedClasses(eraseExtensionTypes(type), reserve);
  for (const declaration of declarations) {
    if (declaration.kind !== 'class' || declaration.cls.kind === 'extensionType') continue;
    const { cls } = declaration;
    reserve(cls);
    for (const parameter of cls.typeParams) if (parameter.bound) loadType(parameter.bound);
    // Multiple on-constraints lower to a synthesized superclass, whose own header is loaded later.
    if (cls.onTypes.length > 1) nextId++;
    else if (cls.onTypes[0]) loadType(cls.onTypes[0]);
    if (cls.superclass) loadType(cls.superclass);
    for (const type of cls.interfaces) loadType(type);
  }
}

function sharedApplication(cls: ClassInfo, applications: Map<string, ClassInfo[]>): number | undefined {
  if (!cls.mixinOf || cls.declaration || !cls.superclass) return undefined;
  const parent = cls.superclass;
  const used = applications.get(cls.name);
  if (!used) {
    applications.set(cls.name, [cls]);
    return undefined;
  }
  for (const candidate of used) {
    if (
      candidate.superclass &&
      sameType(candidate.superclass, parent) &&
      sameType(candidate.interfaces[0], cls.interfaces[0])
    ) {
      return candidate.vmClassId;
    }
  }
  used.push(cls);
  return undefined;
}

function reserveReferencedClasses(type: DartType, reserve: (cls: ClassInfo) => void): void {
  switch (type.kind) {
    case 'interface': {
      reserve(type.cls);
      for (const arg of type.args) reserveReferencedClasses(arg, reserve);
      break;
    }
    case 'function': {
      for (const { bound } of type.typeParams) if (bound) reserveReferencedClasses(bound, reserve);
      for (const parameter of type.positional) reserveReferencedClasses(parameter, reserve);
      for (const named of type.named) reserveReferencedClasses(named.type, reserve);
      reserveReferencedClasses(type.returnType, reserve);
      break;
    }
    case 'record': {
      for (const field of type.positional) reserveReferencedClasses(field, reserve);
      for (const named of type.named) reserveReferencedClasses(named.type, reserve);
      break;
    }
    default: {
      break;
    }
  }
}
