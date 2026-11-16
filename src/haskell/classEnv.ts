import type { ClassEntity, Evidence, InstanceInfo } from './entities';
import { couldMatch, matchType, type Pred, prune, splitApp, type Type, typesEqual } from './types';

/** The instances visible to a module: the library's, and the module's own. */
export class ClassEnv {
  private readonly own = new Map<ClassEntity, InstanceInfo[]>();

  constructor(private readonly parent?: ClassEnv) {}

  add(instance: InstanceInfo): void {
    let list = this.own.get(instance.cls);
    if (!list) {
      list = [];
      this.own.set(instance.cls, list);
    }
    list.push(instance);
  }

  instancesOf(cls: ClassEntity): InstanceInfo[] {
    const own = this.own.get(cls) ?? [];
    return this.parent ? [...this.parent.instancesOf(cls), ...own] : own;
  }

  /**
   * The instance that solves a constraint whose type has a constructor at its head: `none` when no instance can,
   * and `pending` when one could once the type's variables are known.
   */
  findInstance(pred: Pred): { instance: InstanceInfo; args: Type[] } | 'none' | 'pending' {
    let pending = false;
    for (const instance of this.instancesOf(pred.cls)) {
      const bindings: (Type | undefined)[] = [];
      if (matchType(instance.head, pred.type, bindings)) {
        return { instance, args: instance.kinds.map((_, index) => bindings[index] as Type) };
      }
      if (couldMatch(instance.head, pred.type)) pending = true;
    }
    return pending ? 'pending' : 'none';
  }
}

/** Whether a constraint's type has a type constructor at its head, so that only an instance can solve it. */
export function hasConstructorHead(type: Type): boolean {
  return splitApp(type).head.tag === 'tcon';
}

/** The superclasses of a class, transitively, with the selection path to each from the class's dictionary. */
export function superclassPaths(cls: ClassEntity): { cls: ClassEntity; path: number[] }[] {
  const result: { cls: ClassEntity; path: number[] }[] = [];
  const visit = (current: ClassEntity, path: number[]): void => {
    for (const [index, sup] of current.supers.entries()) {
      const next = [...path, index];
      result.push({ cls: sup, path: next });
      visit(sup, next);
    }
  };
  visit(cls, []);
  return result;
}

export function isSubclassOf(cls: ClassEntity, ancestor: ClassEntity): boolean {
  return cls === ancestor || superclassPaths(cls).some((entry) => entry.cls === ancestor);
}

/** Finds evidence for a constraint among given ones, directly or through their superclasses. */
export function entailByGivens(
  givens: readonly { pred: Pred; evidence: Evidence }[],
  pred: Pred
): Evidence | undefined {
  for (const given of givens) {
    if (!typesEqual(given.pred.type, pred.type)) continue;
    if (given.pred.cls === pred.cls) return given.evidence;
    for (const { cls, path } of superclassPaths(given.pred.cls)) {
      if (cls !== pred.cls) continue;
      let evidence = given.evidence;
      for (const index of path) evidence = { kind: 'super', of: evidence, index };
      return evidence;
    }
  }
  return undefined;
}

export function predsEqual(a: Pred, b: Pred): boolean {
  return a.cls === b.cls && typesEqual(a.type, b.type);
}

export function zonkPred(pred: Pred): Pred {
  return { cls: pred.cls, type: prune(pred.type) };
}
