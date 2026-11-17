import type { EnumField } from './types';

interface EnumLookup {
  byValue: ReadonlyMap<bigint, EnumField>;
  byName: ReadonlyMap<string, EnumField>;
}

const indexes = new WeakMap<readonly EnumField[], EnumLookup>();

export function enumLookup(fields: readonly EnumField[], spend: () => void): EnumLookup {
  const cached = indexes.get(fields);
  if (cached) return cached;
  const byValue = new Map<bigint, EnumField>();
  const byName = new Map<string, EnumField>();
  for (const field of fields) {
    spend();
    byValue.set(field.value, field);
    byName.set(field.name, field);
  }
  const index = { byValue, byName };
  indexes.set(fields, index);
  return index;
}
