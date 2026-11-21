import { compileError } from './items';
import { type AdtDef, childTypes, shallow, type Type } from './types';

/** Rejects a type or lifetime parameter of a struct or enum that no field's type mentions, as rustc does (E0392). */
export function checkParamsUsed(def: AdtDef): void {
  const fields = def.variants.flatMap((variant) => variant.fields.map((field) => field.type));
  for (const param of def.params) {
    const used = fields.some((field) => someType(field, (t) => t.kind === 'param' && t.param === param));
    if (!used) compileError(def.span, `型引数 ${param.name} を、どのフィールドの型でも使っていません。`);
  }
  for (const lifetime of def.lifetimeParams ?? []) {
    if (!fields.some((field) => someType(field, (t) => lifetimesOf(t).includes(lifetime)))) {
      compileError(def.span, `ライフタイム ${lifetime} を、どのフィールドの型でも使っていません。`);
    }
  }
}

function someType(type: Type, test: (t: Type) => boolean): boolean {
  const t = shallow(type);
  if (test(t)) return true;
  const parts = t.kind === 'dyn' ? [...childTypes(t), t.trait.fnSig?.ret, t.trait.item] : childTypes(t);
  return parts.some((part) => part !== undefined && someType(part, test));
}

function lifetimesOf(t: Type): (string | undefined)[] {
  switch (t.kind) {
    case 'ref':
    case 'dyn': {
      return [t.lifetime];
    }
    case 'adt': {
      return t.lifetimes ?? [];
    }
    default: {
      return [];
    }
  }
}
