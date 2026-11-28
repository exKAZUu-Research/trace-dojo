import type { ImplItem } from './ast';
import { compileError, type Module } from './items';
import type { TraitDef } from './types';

/** An `unsafe trait` needs an `unsafe impl` (E0200), and only it may have one (E0199). */
export function checkImplSafety(item: ImplItem, trait: TraitDef): void {
  if (trait.isUnsafe && !item.isUnsafe) {
    compileError(item.span, `トレイト ${trait.name} は unsafe なので、unsafe impl と書いてください（E0200）。`);
  }
  if (!trait.isUnsafe && item.isUnsafe) {
    compileError(item.span, `トレイト ${trait.name} は unsafe ではないので、unsafe impl にはできません（E0199）。`);
  }
}

/**
 * Requires each method of a trait impl to be one the trait declares. std's traits have more provided methods
 * (`Iterator::nth`, `Error::description`, ...) than they declare here, which an impl may not override in this
 * interpreter.
 */
export function checkImplMethods(item: ImplItem, trait: TraitDef): void {
  for (const method of item.methods) {
    if (trait.methods.has(method.name)) continue;
    if ((trait.module as Module | undefined)?.isStd) {
      compileError(method.span, `${trait.name} の ${method.name} を上書きすることは、この採点環境では使えません。`);
    }
    compileError(method.span, `メソッド ${method.name} は、トレイト ${trait.name} にありません。`);
  }
}
