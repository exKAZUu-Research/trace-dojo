import type { EnumField } from './types';

interface EnumLookup {
  byValue: ReadonlyMap<bigint, EnumField>;
  byName: ReadonlyMap<string, EnumField>;
  indexByValue: ReadonlyMap<bigint, number>;
}

const indexes = new WeakMap<readonly EnumField[], EnumLookup>();

export function enumLookup(fields: readonly EnumField[], spend: () => void): EnumLookup {
  const cached = indexes.get(fields);
  if (cached) return cached;
  const byValue = new Map<bigint, EnumField>();
  const byName = new Map<string, EnumField>();
  const indexByValue = new Map<bigint, number>();
  for (const [position, field] of fields.entries()) {
    spend();
    byValue.set(field.value, field);
    indexByValue.set(field.value, position);
    byName.set(field.name, field);
  }
  const index = { byValue, byName, indexByValue };
  indexes.set(fields, index);
  return index;
}
