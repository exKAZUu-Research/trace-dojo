import { type ExecutionBudget, ExecutionLimitError } from '../interpreter/limits';
import { compileError } from './items';
import type { AdtDef, Type, TypeParam } from './types';

export class AdtStorage {
  private readonly active = new Set<AdtDef>();
  private readonly stored = new Map<AdtDef, Set<TypeParam>>();

  constructor(private readonly budget: ExecutionBudget) {}

  check(def: AdtDef): void {
    this.storedParameters(def);
  }

  private storedParameters(def: AdtDef): Set<TypeParam> {
    if (this.active.has(def)) {
      compileError(
        def.span,
        `${def.name} が値として自分自身を含んでいるので、大きさが決まりません（Box<…> に入れてください）。`
      );
    }
    const cached = this.stored.get(def);
    if (cached) return cached;
    if (this.active.size >= 512) throw new ExecutionLimitError('operations');
    this.active.add(def);
    const stored = new Set<TypeParam>();
    try {
      for (const variant of def.variants) {
        for (const { type } of variant.fields) this.visit(type, stored);
      }
    } finally {
      this.active.delete(def);
    }
    this.stored.set(def, stored);
    return stored;
  }

  private visit(type: Type, stored: Set<TypeParam>): void {
    this.budget.spend();
    switch (type.kind) {
      case 'param': {
        stored.add(type.param);
        return;
      }
      case 'tuple': {
        for (const item of type.elems) this.visit(item, stored);
        return;
      }
      case 'array':
      case 'slice': {
        this.visit(type.elem, stored);
        return;
      }
      case 'adt': {
        const params = this.storedParameters(type.def);
        for (const [index, param] of type.def.params.entries()) {
          if (params.has(param)) this.visit(type.args[index], stored);
        }
        return;
      }
    }
  }
}
