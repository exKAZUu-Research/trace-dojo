import { keyOf } from './flowKeys';
import type { ClassSymbol } from './symbols';
import { isNullable, type KType, resolved } from './types';

export function coverTypeCases(
  covered: Set<string>,
  subject: KType,
  checked: KType,
  negated: boolean,
  booleanClass: ClassSymbol
): void {
  const target = resolved(checked);
  if (isNullable(subject) && isNullable(target) !== negated) covered.add('null');
  const actual = resolved(subject);
  if (actual.kind !== 'class') return;
  for (const cls of caseClasses(actual.cls)) {
    if (!coversClass(cls, target, negated)) continue;
    if (cls === booleanClass) {
      covered.add('true');
      covered.add('false');
    } else {
      covered.add(`class:${keyOf(cls)}`);
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
