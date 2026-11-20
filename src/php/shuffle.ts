import { rt } from './runtime';

export function shuffle<T>(items: T[], draw: (end: bigint) => bigint): T[] {
  const runtime = rt();
  for (let left = items.length - 1; left > 0; left--) {
    runtime.spend();
    const index = Number(draw(BigInt(left)));
    if (index !== left) [items[left], items[index]] = [items[index], items[left]];
  }
  return items;
}
