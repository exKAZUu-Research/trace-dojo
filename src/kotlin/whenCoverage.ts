import { keyOf } from './flowKeys';
import type { ClassSymbol } from './symbols';
import { isSameType } from './typeRelations';
import { isNullable, type KType, nonNull, resolved } from './types';

export class WhenCoverage {
  readonly cases = new Set<string>();
  private readonly positiveTypes: KType[] = [];
  private readonly negativeTypes: KType[] = [];

  coverTypeCases(subject: KType, checked: KType, negated: boolean, booleanClass: ClassSymbol): void {
    const target = resolved(checked);
    if (!negated && isNullable(subject) && isNullable(target)) this.cases.add('null');
    const actual = resolved(subject);
    if (actual.kind !== 'class') return;
    const sameSign = negated ? this.negativeTypes : this.positiveTypes;
    const otherSign = negated ? this.positiveTypes : this.negativeTypes;
    const nonNullTarget = nonNull(target);
    const hasComplement = otherSign.some((type) => isSameType(type, nonNullTarget));
    sameSign.push(nonNullTarget);
    for (const cls of caseClasses(actual.cls)) {
      if (!hasComplement && !coversClass(cls, target, negated)) continue;
      if (cls === booleanClass) {
        this.cases.add('true');
        this.cases.add('false');
      } else {
        this.cases.add(`class:${keyOf(cls)}`);
      }
    }
  }
}

function caseClasses(cls: ClassSymbol): ClassSymbol[] {
  return cls.isSealed && cls.sealedSubclasses.length > 0 ? cls.sealedSubclasses.flatMap(caseClasses) : [cls];
}

function coversClass(cls: ClassSymbol, checked: KType, negated: boolean): boolean {
  if (checked.kind === 'nothing') return negated;
  if (checked.kind !== 'class') return false;
  const target = checked.cls;
  const subtype = cls.isSubclassOf(target);
  if (!negated) return subtype;
  if (subtype || target.isSubclassOf(cls)) return false;
  if (!cls.isInterface && !target.isInterface) return true;
  return !cls.isInheritable || !target.isInheritable;
}
