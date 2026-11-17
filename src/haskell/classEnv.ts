import type { ClassEntity, Evidence, InstanceInfo, TypeEntity } from './entities';
import { couldMatch, matchType, type Pred, prune, splitApp, type Type, typesEqual } from './types';
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
        if (matched) return 'overlap';
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

export function isSubclassOf(cls: ClassEntity, ancestor: ClassEntity): boolean {
  return superclassPath(cls, ancestor) !== undefined;
}

export function entailByGivens(
  givens: readonly { pred: Pred; evidence: Evidence }[],
  pred: Pred
): Evidence | undefined {
  for (const given of givens) {
    if (!typesEqual(given.pred.type, pred.type)) continue;
    const path = superclassPath(given.pred.cls, pred.cls);
    if (!path) continue;
    let evidence = given.evidence;
    for (const index of path) {
      chargeTypeWork();
      evidence = { kind: 'super', of: evidence, index };
    }
    return evidence;
  }
  return undefined;
}

interface SuperclassStep {
  index: number;
  parent: SuperclassStep | undefined;
}

function superclassPath(cls: ClassEntity, ancestor: ClassEntity): number[] | undefined {
  const seen = new Set<ClassEntity>();
  const work: { cls: ClassEntity; path: SuperclassStep | undefined }[] = [{ cls, path: undefined }];
  while (work.length > 0) {
    chargeTypeWork();
    const current = work.pop()!;
    if (seen.has(current.cls)) continue;
    seen.add(current.cls);
    if (current.cls === ancestor) {
      const path: number[] = [];
      for (let step = current.path; step; step = step.parent) {
        chargeTypeWork();
        path.push(step.index);
      }
      return path.toReversed();
    }
    for (let index = current.cls.supers.length - 1; index >= 0; index--) {
      chargeTypeWork();
      work.push({ cls: current.cls.supers[index], path: { index, parent: current.path } });
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
