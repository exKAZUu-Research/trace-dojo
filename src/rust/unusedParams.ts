import { compileError, type Module } from './items';
import { type AdtDef, childTypes, shallow, type Type } from './types';

interface Usage {
  params: boolean[];
  lifetimes: boolean[];
}

/**
 * Rejects a type or lifetime parameter of a struct or enum that no field's type uses, as rustc does (E0392): passing it
 * on to a parameter of a declared type counts only when that type uses its parameter, so a parameter that only the
 * type's own recursive fields pass on (`struct Node<T> { next: Option<Box<Node<T>>> }`) is unused.
 */
export function checkParamsUsed(def: AdtDef): void {
  const usage = usageOf(def);
  for (const [index, param] of def.params.entries()) {
    // A const parameter needs no field: its value is part of the type.
    if (usage.params[index] || param.constType) continue;
    const mentioned = fieldTypes(def).some((field) => someType(field, (t) => t.kind === 'param' && t.param === param));
    compileError(
      def.span,
      mentioned
        ? `型引数 ${param.name} を、ほかの型に型引数として渡しているだけで、値を持つフィールドの型では使っていません。`
        : `型引数 ${param.name} を、どのフィールドの型でも使っていません。`
    );
  }
  for (const [index, lifetime] of (def.lifetimeParams ?? []).entries()) {
    if (!usage.lifetimes[index]) {
      compileError(def.span, `ライフタイム ${lifetime} を、どのフィールドの型でも使っていません。`);
    }
  }
}

/** The usage of the declared types that `root` reaches, found by marking uses until nothing changes. */
function usageOf(root: AdtDef): Usage {
  const usages = new Map<AdtDef, Usage>();
  const declared = [root];
  for (const def of declared) {
    usages.set(def, { params: def.params.map(() => false), lifetimes: (def.lifetimeParams ?? []).map(() => false) });
    for (const field of fieldTypes(def)) {
      someType(field, (t) => {
        if (t.kind === 'adt' && isDeclared(t.def) && !declared.includes(t.def)) declared.push(t.def);
        return false;
      });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [def, usage] of usages) {
      const marker = new UsageMarker(def, usage, usages);
      for (const field of fieldTypes(def)) marker.mark(field);
      changed ||= marker.changed;
    }
  }
  return usages.get(root) as Usage;
}

class UsageMarker {
  changed = false;

  constructor(
    private readonly def: AdtDef,
    private readonly usage: Usage,
    private readonly usages: ReadonlyMap<AdtDef, Usage>
  ) {}

  mark(type: Type): void {
    const t = shallow(type);
    if (t.kind === 'param') this.set(this.usage.params, this.def.params.indexOf(t.param));
    if (t.kind === 'ref' || t.kind === 'dyn') this.markLifetime(t.lifetime);
    if (t.kind !== 'adt') {
      for (const part of partsOf(t)) this.mark(part);
      return;
    }
    // A declared type's argument is used only where that type uses its parameter; a projection (`C::Out`) uses all.
    const passed = t.def.projection ? undefined : this.usages.get(t.def);
    for (const [index, lifetime] of (t.lifetimes ?? []).entries()) {
      if (!passed || passed.lifetimes[index]) this.markLifetime(lifetime);
    }
    for (const [index, arg] of t.args.entries()) {
      if (!passed || passed.params[index]) this.mark(arg);
    }
  }

  private markLifetime(lifetime: string | undefined): void {
    if (lifetime) this.set(this.usage.lifetimes, (this.def.lifetimeParams ?? []).indexOf(lifetime));
  }

  private set(flags: boolean[], index: number): void {
    if (index < 0 || flags[index]) return;
    flags[index] = true;
    this.changed = true;
  }
}

function fieldTypes(def: AdtDef): Type[] {
  return def.variants.flatMap((variant) => variant.fields.map((field) => field.type));
}

function isDeclared(def: AdtDef): boolean {
  return !(def.module as Module | undefined)?.isStd;
}

function someType(type: Type, test: (t: Type) => boolean): boolean {
  const t = shallow(type);
  return test(t) || partsOf(t).some((part) => someType(part, test));
}

function partsOf(t: Type): Type[] {
  if (t.kind !== 'dyn') return childTypes(t);
  return [...childTypes(t), t.trait.fnSig?.ret, t.trait.item].filter((part) => part !== undefined);
}
