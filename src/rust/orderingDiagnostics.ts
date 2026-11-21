import { normalize } from './infer';
import { type AdtDef, childTypes, shallow, type Type } from './types';

export function orderHint(type: Type): string {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return orderHint(t.target);
  if (isFloat(t)) return '小数を並べ替えるには、sort_by で total_cmp を使えます。';
  if (containsFloat(t, new Set())) {
    return '小数を含む値に順序が必要な場合は、sort_by などで小数の比較に total_cmp を使ってください。';
  }
  if (t.kind === 'adt' && !t.def.builtin)
    return 'すべてのフィールドが Ord なら、#[derive(PartialEq, Eq, PartialOrd, Ord)] を付けてください。';
  return '';
}

function containsFloat(type: Type, seen: Set<AdtDef>): boolean {
  const t = normalize(shallow(type));
  if (isFloat(t)) return true;
  if (childTypes(t).some((child) => containsFloat(child, seen))) return true;
  if (t.kind !== 'adt' || t.def.builtin || seen.has(t.def)) return false;
  seen.add(t.def);
  return t.def.variants.some((v) => v.fields.some((field) => containsFloat(field.type, seen)));
}

function isFloat(t: Type): boolean {
  return t.kind === 'float' || (t.kind === 'var' && t.v.literal === 'float');
}
