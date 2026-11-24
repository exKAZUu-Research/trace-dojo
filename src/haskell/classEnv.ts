import type { ClassEntity, Evidence, InstanceInfo, TypeEntity } from './entities';
import {
  couldMatch,
  instantiateType,
  matchType,
  type Pred,
  splitApp,
  type Type,
  typesEqual,
  typeVarsOf,
} from './types';
import { chargeTypeWork } from './typeWorkBudget';

/** The instances visible to a module: the library's, and the module's own. */
export class ClassEnv {
  private readonly own = new Map<ClassEntity, InstanceInfo[]>();

  private readonly candidates = new Map<ClassEntity, Map<TypeEntity, InstanceInfo[]>>();

  constructor(private readonly parent?: ClassEnv) {}

  add(instance: InstanceInfo): void {
    this.candidates.clear();
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
   * `pending` when selection depends on unknown variables, and `overlap` when multiple instances match.
   */
  findInstance(pred: Pred): { instance: InstanceInfo; args: Type[] } | 'none' | 'pending' | 'overlap' {
    let pending = false;
    let matched: { instance: InstanceInfo; args: Type[] } | undefined;
    const head = splitApp(pred.type).head;
    const instances = head.tag === 'tcon' ? this.instancesForHead(pred.cls, head.entity) : this.instancesOf(pred.cls);
    for (const instance of instances) {
      const bindings: (Type | undefined)[] = [];
      if (matchType(instance.head, pred.type, bindings)) {
        if (matched) return typeVarsOf(pred.type).size > 0 ? 'pending' : 'overlap';
        matched = { instance, args: instance.kinds.map((_, index) => bindings[index] as Type) };
        continue;
      }
      if (couldMatch(instance.head, pred.type)) pending = true;
    }
    return pending ? 'pending' : (matched ?? 'none');
  }

  private instancesForHead(cls: ClassEntity, head: TypeEntity): InstanceInfo[] {
    let byHead = this.candidates.get(cls);
    if (!byHead) {
      byHead = new Map();
      this.candidates.set(cls, byHead);
    }
    let candidates = byHead.get(head);
    if (!candidates) {
      candidates = this.instancesOf(cls).filter((instance) => {
        const pattern = splitApp(instance.head).head;
        return pattern.tag !== 'tcon' || pattern.entity === head;
      });
      byHead.set(head, candidates);
    }
    return candidates;
  }
}

/** Whether a constraint's type has a type constructor at its head, so that only an instance can solve it. */
export function hasConstructorHead(type: Type): boolean {
  return splitApp(type).head.tag === 'tcon';
}

/** The superclass constraint a constraint implies: the class's superclass at the position, at its type. */
export function superPred(pred: Pred, index: number): Pred {
  const cls = pred.cls.supers[index];
  const template = pred.cls.superTypes?.[index];
  if (!template) return { cls, type: pred.type };
  const args = pred.cls.packed ? splitApp(pred.type).args : [pred.type];
  return { cls, type: instantiateType(template, args) };
}

/** Whether a constraint implies another through its superclasses. */
export function impliedBySuperclasses(given: Pred, pred: Pred): boolean {
  return superclassPath(given, pred) !== undefined;
}

/** Whether a given constraint implies another through its superclasses, giving the evidence if it does. */
export function entailByGivens(
  givens: readonly { pred: Pred; evidence: Evidence }[],
  pred: Pred
): Evidence | undefined {
  for (const given of givens) {
    const path = superclassPath(given.pred, pred);
    if (!path) continue;
    let evidence = given.evidence;
    for (const index of path) evidence = { kind: 'super', of: evidence, index };
    return evidence;
  }
  return undefined;
}

/** The superclass positions that lead from a constraint to another it implies, if it does. */
function superclassPath(given: Pred, pred: Pred): number[] | undefined {
  const seen = new Set<ClassEntity>();
  const work: { pred: Pred; path: number[] }[] = [{ pred: given, path: [] }];
  while (work.length > 0) {
    chargeTypeWork();
    const current = work.pop()!;
    if (predsEqual(current.pred, pred)) return current.path;
    // A class reached again only repeats what it implies, unless its superclasses apply to other types.
    if (seen.has(current.pred.cls) && !current.pred.cls.superTypes?.length) continue;
    seen.add(current.pred.cls);
    if (current.path.length > 100) continue;
    for (let index = current.pred.cls.supers.length - 1; index >= 0; index--) {
      work.push({ pred: superPred(current.pred, index), path: [...current.path, index] });
    }
  }
  return undefined;
}

export function predsEqual(a: Pred, b: Pred): boolean {
  return a.cls === b.cls && typesEqual(a.type, b.type);
}
