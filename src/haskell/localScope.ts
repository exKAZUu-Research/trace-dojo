import { assert } from 'es-toolkit';
import { Map as PersistentMap } from 'immutable';

import type { LocalVar } from './rast';
import { chargeTypeWork } from './typeWorkBudget';

/**
 * The namespaces of local names: variables, and the constructors, types, type variables, and record fields (which are
 * variables too) that only a Template Haskell quote's declarations bind locally.
 */
export type LocalNamespace = 'value' | 'con' | 'type' | 'tyVar' | 'field';

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

  define(name: string, local: LocalVar, namespace: LocalNamespace = 'value'): void {
    assert(!this.sealed, 'Define all bindings before creating child scopes');
    chargeTypeWork();
    const key = keyOf(name, namespace);
    if (namespace === 'value') this.own.set(name, local);
    this.bindings = this.bindings.set(key, local);
  }

  lookup(name: string, namespace: LocalNamespace = 'value'): LocalVar | undefined {
    chargeTypeWork();
    return this.bindings.get(keyOf(name, namespace));
  }
}

/** The key of a name in a namespace: the other namespaces' keys have a space after a word, which no variable has. */
function keyOf(name: string, namespace: LocalNamespace): string {
  return namespace === 'value' ? name : `${namespace} ${name}`;
}
