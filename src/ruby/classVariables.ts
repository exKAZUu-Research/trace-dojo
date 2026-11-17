import { hierarchyEntries, type HierarchyEntry } from './classHierarchy';
import { className } from './conversions';
import { frozenError, nameError, rubyError } from './errors';
import { identifierKeyString, inspectStringEncoding } from './libString';
import { RBasic, RClass, type RString, type Value } from './objects';
import { rt } from './runtime';
import { singletonClassOf, str, stringBytes, stringFromBytes } from './values';

export function getClassVariable(holder: RClass, name: string): Value {
  const owner = classVariableOwner(holder, name);
  if (!owner) throw nameError(`uninitialized class variable ${name} in ${className(holder)}`, holder, name);
  return owner.classVariables.get(name)!;
}

export function setClassVariable(holder: RClass, name: string, value: Value): void {
  const resolved = classVariableOwner(holder, name);
  const owner = resolved ?? holder;
  if (owner.frozen || (owner.isSingleton && owner.attached instanceof RBasic && owner.attached.frozen))
    throw frozenError(owner, className(owner));
  if (!resolved && owner.isModule) singletonClassOf(owner);
  owner.classVariables.set(name, value);
}

export function hasClassVariable(holder: RClass, name: string): boolean {
  for (const module of classVariableAncestors(holder)) {
    if (module.classVariables.has(name)) return true;
  }
  return false;
}

function classVariableOwner(holder: RClass, name: string): RClass | undefined {
  let front: RClass | undefined;
  let target: RClass | undefined;
  for (const module of classVariableAncestors(holder)) {
    if (!module.classVariables.has(name)) continue;
    front ??= module;
    target = module;
  }
  if (front && target !== front)
    throw rubyError(rt().c.RuntimeError, classVariableCollisionMessage(name, front, target!));
  return target;
}

function classVariableCollisionMessage(name: string, front: RClass, target: RClass): RString {
  const variable = identifierKeyString(name);
  const frontName = classVariableOwnerName(front);
  const targetName = classVariableOwnerName(target);
  const shown = variable.binary ? inspectStringEncoding(variable).slice(1, -1) : variable.s;
  const bytes = stringBytes(str(`class variable ${shown} of ${frontName} is overtaken by ${targetName}`));
  let binary = true;
  let usAscii = false;
  for (const label of [
    variable.binary ? str(shown) : variable,
    identifierKeyString(frontName),
    identifierKeyString(targetName),
  ]) {
    if (stringBytes(label).some((byte) => byte >= 128)) {
      binary = label.binary;
      usAscii = label.usAscii;
    }
  }
  return stringFromBytes(bytes, binary, usAscii);
}

function classVariableOwnerName(owner: RClass): string {
  while (owner.isSingleton && owner.superclass) owner = owner.superclass;
  return className(owner);
}

function* classVariableAncestors(holder: RClass): Generator<RClass> {
  if (holder.isSingleton && holder.attached instanceof RClass) {
    yield holder;
    holder = holder.attached;
  }
  const origins = new Set<HierarchyEntry>();
  for (const entry of hierarchyEntries(holder)) {
    if (entry.origin) origins.add(entry.origin);
    if (!origins.has(entry)) yield entry.value;
  }
}
