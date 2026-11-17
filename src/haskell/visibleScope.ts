import type { OrderedMap } from 'immutable';

import type { Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

export interface VisibleBinding {
  level: number;
  index: number;
  type: Type;
}

export interface VisibleScope {
  level: number;
  bindings: OrderedMap<string, VisibleBinding>;
}

export function* visibleVariables(
  scope: VisibleScope
): Generator<{ name: string; depth: number; index: number; type: Type }> {
  for (const [name, entry] of scope.bindings) {
    chargeTypeWork();
    yield { name, depth: scope.level - entry.level, index: entry.index, type: entry.type };
  }
}
