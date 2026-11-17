import { valueSlots } from './allocation';
import { hasResolvedLayout } from './layout';
import type { Type } from './types';
import { ErrorValue, NULL, optionalPayload, type Value, type ZArray, type ZStruct, type ZUnion } from './values';

interface CopyPlan {
  fixed: number;
  active?: (value: Value, spend: () => void) => number;
}

const plans = new WeakMap<Type, CopyPlan>();

export function copiedValueSlots(type: Type, value: Value, spend: () => void): number {
  const plan = planOf(type, spend);
  return plan.fixed + (plan.active?.(value, spend) ?? 0);
}

function planOf(type: Type, spend: () => void): CopyPlan {
  const cached = plans.get(type);
  if (cached) return cached;
  spend();
  const fixed = valueSlots(type);
  const plan = buildPlan(type, fixed, spend);
  if (hasResolvedLayout(type)) plans.set(type, plan);
  return plan;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Builds cached plans for each value representation, separating fixed slots from active payloads.
// code-gauge-allow functionNcss 49 -- Keeps the fixed and active storage rules together for each copied representation.
function buildPlan(type: Type, fixed: number, spend: () => void): CopyPlan {
  switch (type.kind) {
    case 'optional': {
      const child = planOf(type.child, spend);
      return { fixed: 0, active: (value, spend) => (value === NULL ? 0 : count(child, optionalPayload(value), spend)) };
    }
    case 'error_union': {
      const child = planOf(type.payload, spend);
      return { fixed: 0, active: (value, spend) => (value instanceof ErrorValue ? 0 : count(child, value, spend)) };
    }
    case 'array': {
      const child = planOf(type.child, spend);
      if (!child.active || fixed === 0) return { fixed };
      const length = Number(type.length + (type.sentinel === undefined ? 0n : 1n));
      return {
        fixed: length * (1 + child.fixed),
        active: (value, spend) => {
          let slots = 0;
          for (let index = 0; index < length; index++) {
            spend();
            slots += child.active!((value as ZArray).get(index), spend);
          }
          return slots;
        },
      };
    }
    case 'struct': {
      if (type.namespace.internal || !type.fields) return { fixed };
      const fields = type.fields.map((field, index) => {
        spend();
        return { index, plan: planOf(field.type, spend) };
      });
      const dynamic = fields.filter((field) => field.plan.active);
      if (dynamic.length === 0) return { fixed };
      let base = type.native?.storageSlots ?? 0;
      for (const field of fields) base += 1 + field.plan.fixed;
      return {
        fixed: base,
        active: (value, spend) => {
          let slots = 0;
          for (const field of dynamic) {
            spend();
            slots += field.plan.active!((value as ZStruct).slots[field.index], spend);
          }
          return slots;
        },
      };
    }
    case 'union': {
      if (type.layout !== 'auto') return { fixed };
      const fields = (type.fields ?? []).map((field) => {
        spend();
        return planOf(field.type, spend);
      });
      return {
        fixed: 1,
        active: (value, spend) => {
          const union = value as ZUnion;
          const field = fields[union.tag];
          return field ? count(field, union.slots[0], spend) : 0;
        },
      };
    }
    default: {
      return { fixed };
    }
  }
}

function count(plan: CopyPlan, value: Value, spend: () => void): number {
  spend();
  return plan.fixed + (plan.active?.(value, spend) ?? 0);
}
