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
    const matches: { instance: InstanceInfo; args: Type[] }[] = [];
    const head = splitApp(pred.type).head;
    const instances = head.tag === 'tcon' ? this.instancesForHead(pred.cls, head.entity) : this.instancesOf(pred.cls);
    for (const instance of instances) {
      const bindings: (Type | undefined)[] = [];
      if (matchType(instance.head, pred.type, bindings)) {
        matches.push({ instance, args: instance.kinds.map((_, index) => bindings[index] as Type) });
        continue;
      }
      // An instance that could match once the type is known decides nothing yet, unless it is incoherent.
      if (instance.overlap !== 'INCOHERENT' && couldMatch(instance.head, pred.type)) pending = true;
    }
    // As GHC does, an instance gives way to a more specific one when either pragma allows it.
    const remaining = matches.filter(
      (candidate) =>
        !matches.some(
          (other) =>
            other !== candidate &&
            moreSpecific(other.instance, candidate.instance) &&
            (overlappable(candidate.instance) || overlapping(other.instance))
        )
    );
    const coherent = remaining.filter((candidate) => candidate.instance.overlap !== 'INCOHERENT');
    const chosen = coherent.length > 0 ? coherent : remaining.slice(0, 1);
    if (chosen.length > 1) return typeVarsOf(pred.type).size > 0 ? 'pending' : 'overlap';
    // Only incoherent instances match: GHC takes one without waiting for the instances that might match later.
    if (coherent.length === 0 && chosen.length === 1) return chosen[0];
    return pending ? 'pending' : (chosen[0] ?? 'none');
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

/** Whether an instance's head is an instance of another's, but not the other way round. */
function moreSpecific(a: InstanceInfo, b: InstanceInfo): boolean {
  return matchType(b.head, a.head, []) && !matchType(a.head, b.head, []);
}

function overlappable(instance: InstanceInfo): boolean {
  return instance.overlap === 'OVERLAPPABLE' || instance.overlap === 'OVERLAPS' || instance.overlap === 'INCOHERENT';
}

function overlapping(instance: InstanceInfo): boolean {
  return instance.overlap === 'OVERLAPPING' || instance.overlap === 'OVERLAPS' || instance.overlap === 'INCOHERENT';
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

interface SuperclassStep {
  index: number;
  parent: SuperclassStep | undefined;
}

/** The superclass positions that lead from a constraint to another it implies, if it does. */
function superclassPath(given: Pred, pred: Pred): number[] | undefined {
  const seen = new Set<ClassEntity>();
  const work: { pred: Pred; step: SuperclassStep | undefined }[] = [{ pred: given, step: undefined }];
  while (work.length > 0) {
    chargeTypeWork();
    const current = work.pop()!;
    if (predsEqual(current.pred, pred)) {
      const path: number[] = [];
      for (let step = current.step; step; step = step.parent) path.push(step.index);
      return path.toReversed();
    }
    // A class reached again only repeats what it implies, unless its superclasses apply to other types.
    if (seen.has(current.pred.cls) && !current.pred.cls.superTypes) continue;
    seen.add(current.pred.cls);
    for (let index = current.pred.cls.supers.length - 1; index >= 0; index--) {
      work.push({ pred: superPred(current.pred, index), step: { index, parent: current.step } });
    }
  }
  return undefined;
}

export function predsEqual(a: Pred, b: Pred): boolean {
  return a.cls === b.cls && typesEqual(a.type, b.type);
}
