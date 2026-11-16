import type { RClass, RMethod } from './objects';
import { rt } from './runtime';

export interface HierarchyEntry {
  value: RClass;
  kind: 'class' | 'module' | 'include';
  table: Map<string, RMethod>;
  next?: HierarchyEntry;
  origin?: HierarchyEntry;
}
interface Hierarchy {
  head: HierarchyEntry;
  occurrences: Set<HierarchyEntry>;
}
const hierarchies = new WeakMap<RClass, Hierarchy>();

export function initializeHierarchy(value: RClass): void {
  rt().chargeSlots(1);
  hierarchies.set(value, {
    head: {
      value,
      kind: value.isModule ? 'module' : 'class',
      table: value.methods,
      next: value.superclass && hierarchyOf(value.superclass).head,
    },
    occurrences: new Set(),
  });
}

export function* hierarchyEntries(value: RClass): Generator<HierarchyEntry> {
  for (let entry: HierarchyEntry | undefined = hierarchyOf(value).head; entry; entry = entry.next) {
    rt().spend();
    yield entry;
  }
}

export function includeHierarchy(target: RClass, module: RClass): void {
  const targetGraph = hierarchyOf(target);
  const source = hierarchyOf(module).head;
  includeAt(targetGraph.head, originOf(targetGraph.head), source, true);
  if (!target.isModule) return;
  for (const occurrence of [...targetGraph.occurrences].toReversed()) {
    if (!containsModule(occurrence, module)) includeAt(occurrence, originOf(occurrence), source, true);
  }
}

export function prependHierarchy(target: RClass, module: RClass): void {
  const targetGraph = hierarchyOf(target);
  const source = hierarchyOf(module).head;
  const createdOrigin = ensureOrigin(targetGraph.head);
  includeAt(targetGraph.head, targetGraph.head, source, false);
  if (!target.isModule) return;
  const newOrigins: HierarchyEntry[] = [];
  for (const occurrence of [...targetGraph.occurrences].toReversed()) {
    if (createdOrigin && occurrence.table === originOf(targetGraph.head).table) {
      const origin = includedEntry(originOf(targetGraph.head), occurrence.next, false);
      occurrence.table = targetGraph.head.table;
      occurrence.next = origin;
      occurrence.origin = origin;
      newOrigins.push(origin);
    }
    includeAt(occurrence, occurrence, source, false);
  }
  for (const origin of newOrigins) targetGraph.occurrences.add(origin);
}

export function copyHierarchy(source: RClass, copy: RClass): Map<HierarchyEntry, HierarchyEntry> {
  const sourceHead = hierarchyOf(source).head;
  const stop = source.superclass && hierarchyOf(source.superclass).head;
  const entries = new Map<HierarchyEntry, HierarchyEntry>();
  const tables = new Map<Map<string, RMethod>, Map<string, RMethod>>([
    [sourceHead.table, new Map()],
    [originOf(sourceHead).table, copy.methods],
  ]);
  for (let current: HierarchyEntry | undefined = sourceHead; current && current !== stop; current = current.next) {
    rt().chargeSlots(1);
    entries.set(current, {
      value: current.value === source ? copy : current.value,
      kind: current.kind,
      table: tables.get(current.table) ?? current.table,
    });
  }
  for (const [original, entry] of entries) {
    entry.next = (original.next && entries.get(original.next)) ?? stop;
    entry.origin = original.origin && entries.get(original.origin);
    if (entry.kind === 'include' && entry.value !== copy) hierarchyOf(entry.value).occurrences.add(entry);
  }
  hierarchyOf(copy).head = entries.get(sourceHead)!;
  return entries;
}

function hierarchyOf(value: RClass): Hierarchy {
  return hierarchies.get(value)!;
}

function originOf(entry: HierarchyEntry): HierarchyEntry {
  return entry.origin ?? entry;
}

function ensureOrigin(entry: HierarchyEntry): boolean {
  if (entry.origin) return false;
  const origin = includedEntry(entry, entry.next, false);
  entry.next = origin;
  entry.origin = origin;
  entry.table = new Map();
  return true;
}

function includedEntry(source: HierarchyEntry, next: HierarchyEntry | undefined, register = true): HierarchyEntry {
  rt().chargeSlots(1);
  const entry: HierarchyEntry = { value: source.value, kind: 'include', table: source.table, next };
  if (register) hierarchyOf(source.value).occurrences.add(entry);
  return entry;
}

function containsModule(start: HierarchyEntry, module: RClass): boolean {
  for (let entry: HierarchyEntry | undefined = start; entry; entry = entry.next) {
    rt().spend();
    if (entry.kind === 'include' && entry.value === module) return true;
  }
  return false;
}

function includeAt(target: HierarchyEntry, start: HierarchyEntry, source: HierarchyEntry, searchSuper: boolean): void {
  const targetOrigin = originOf(target);
  const origins: { entry: HierarchyEntry; source: HierarchyEntry }[] = [];
  let insertion = start;
  for (let module: HierarchyEntry | undefined = source; module; module = module.next) {
    rt().spend();
    const existing =
      targetOrigin !== insertion || searchSuper ? duplicateEntry(target, insertion, module, searchSuper) : undefined;
    if (existing) {
      if (existing.move) insertion = existing.entry;
      continue;
    }
    const entry = includedEntry(module, insertion.next);
    insertion.next = entry;
    insertion = entry;
    if (module.origin) origins.push({ entry, source: module.origin });
    else if (origins.at(-1)?.source === module) origins.pop()!.entry.origin = entry;
  }
}

function duplicateEntry(
  target: HierarchyEntry,
  insertion: HierarchyEntry,
  source: HierarchyEntry,
  searchSuper: boolean
): { entry: HierarchyEntry; move: boolean } | undefined {
  let insertionSeen = target === insertion;
  let superclassSeen = false;
  for (let entry = target.next; entry; entry = entry.next) {
    rt().spend();
    if (entry === originOf(target) && !searchSuper) break;
    if (entry === insertion) insertionSeen = true;
    if (entry.kind === 'include' && entry.table === source.table)
      return { entry, move: !superclassSeen && insertionSeen };
    if (entry.kind === 'class') superclassSeen = true;
  }
  return undefined;
}
