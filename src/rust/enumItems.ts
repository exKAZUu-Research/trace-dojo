import type { EnumItem } from './ast';
import { constInteger } from './constExpressions';
import { compileError, type TypeScope } from './items';
import { intMax, intMin, intType } from './types';

/** The variant that `#[derive(Default)]` makes, marked `#[default]`, checked as rustc does. */
export function defaultVariant(item: EnumItem): number | undefined {
  const deriveDefault = item.attrs.derives.find((derive) => derive.name === 'Default');
  const defaults = item.variants.filter((variant) => variant.isDefault);
  if (!deriveDefault) {
    if (defaults.length > 0)
      compileError(defaults[0].span, '#[default] は、#[derive(Default)] を付けた列挙型の中にだけ書けます。');
    return undefined;
  }
  if (defaults.length === 0) {
    compileError(deriveDefault.span, '列挙型の #[derive(Default)] には、選択肢の1つに #[default] を付けてください。');
  }
  if (defaults.length > 1) compileError(defaults[1].span, '#[default] は、選択肢の1つにだけ付けてください。');
  if (defaults[0].shape !== 'unit') {
    compileError(defaults[0].span, '#[default] は、フィールドのない選択肢にだけ付けられます。');
  }
  return item.variants.indexOf(defaults[0]);
}

export function checkVariantNames(item: EnumItem): void {
  const names = new Set<string>();
  for (const variant of item.variants) {
    if (names.has(variant.name)) compileError(variant.span, `列挙子 ${variant.name} が2回宣言されています。`);
    names.add(variant.name);
  }
}

/** The variants' discriminants: each written one a constant `isize` expression, the others one more than the last. */
export function discriminants(item: EnumItem, scope: TypeScope): bigint[] {
  let next = 0n;
  const seen = new Set<bigint>();
  const hasPayloadVariant = item.variants.some((variant) => variant.shape !== 'unit');
  return item.variants.map((variant) => {
    if (variant.discriminant && hasPayloadVariant) {
      compileError(variant.discriminant.span, 'フィールドを持つ列挙型の列挙子には、値を書けません。');
    }
    const written = variant.discriminant;
    const discriminant = written ? constInteger(written, scope, intType('isize')) : next;
    if (discriminant === undefined) {
      return compileError(written!.span, '列挙子の値には、isize の定数の式を書いてください。');
    }
    if (discriminant < intMin('isize') || discriminant > intMax('isize')) {
      compileError(variant.discriminant?.span ?? variant.span, `列挙子 ${variant.name} の値が isize の範囲外です。`);
    }
    if (seen.has(discriminant)) {
      compileError(item.span, `列挙型 ${item.name} の判別値 ${discriminant} が2回使われています。`);
    }
    seen.add(discriminant);
    next = discriminant + 1n;
    return discriminant;
  });
}
