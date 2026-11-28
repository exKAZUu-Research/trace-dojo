import type { ImplItem } from './ast';
import { compileError, type Program } from './items';
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
 * Requires each method of a trait impl to be one the trait declares. std's `Iterator` has more provided methods
 * (`nth`, `count`, ...) than it declares here, which an impl may not override in this interpreter.
 */
export function checkImplMethods(program: Program, item: ImplItem, trait: TraitDef): void {
  for (const method of item.methods) {
    if (trait.methods.has(method.name)) continue;
    if (trait.builtin === 'Iterator' && iteratorMethods(program).has(method.name)) {
      compileError(method.span, `Iterator の ${method.name} を上書きすることは、この採点環境では使えません。`);
    }
    compileError(method.span, `メソッド ${method.name} は、トレイト ${trait.name} にありません。`);
  }
}

/** The names of the methods std's iterators have, which `IterImpl` declares. */
function iteratorMethods(program: Program): Set<string> {
  const names = new Set<string>();
  for (const impl of program.impls) {
    const self = impl.selfType;
    if (self.kind === 'adt' && self.def.name === 'IterImpl') for (const name of impl.methods.keys()) names.add(name);
  }
  return names;
}
