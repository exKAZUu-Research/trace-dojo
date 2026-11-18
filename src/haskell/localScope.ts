import assert from 'node:assert/strict';

import { Map as PersistentMap } from 'immutable';

import type { LocalVar } from './rast';
import { chargeTypeWork } from './typeWorkBudget';

export class LocalScope {
  private readonly own = new Map<string, LocalVar>();
  private bindings: PersistentMap<string, LocalVar>;
  private sealed = false;

  constructor(parent?: LocalScope) {
    if (parent) parent.sealed = true;
    this.bindings = parent?.bindings ?? PersistentMap<string, LocalVar>();
  }

  get vars(): ReadonlyMap<string, LocalVar> {
    return this.own;
  }

  define(name: string, local: LocalVar): void {
    assert.ok(!this.sealed, 'Define all bindings before creating child scopes');
    chargeTypeWork();
    this.own.set(name, local);
    this.bindings = this.bindings.set(name, local);
  }

  lookup(name: string): LocalVar | undefined {
    chargeTypeWork();
    return this.bindings.get(name);
  }
}
