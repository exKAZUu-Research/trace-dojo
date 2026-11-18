// oxlint-disable unicorn/prefer-code-point -- PHP strings store bytes as code units.
import { rt } from './runtime';

export function byteMembership(characters: string): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < characters.length; index++) {
    spendScan(index);
    bytes[characters.charCodeAt(index)] = 1;
  }
  return bytes;
}

export function* literalMatches(text: string, needle: string): Generator<number, undefined> {
  if (needle === '' || needle.length > text.length) return;
  const prefixes = literalPrefixes(needle);
  let size = 0;
  for (let index = 0; index < text.length; index++) {
    spendScan(index);
    size = extendPrefix(needle, prefixes, size, text[index]);
    if (size !== needle.length) continue;
    yield index + 1 - size;
    size = 0;
  }
}

function literalPrefixes(needle: string): Uint32Array {
  const prefixes = new Uint32Array(needle.length);
  for (let index = 1; index < needle.length; index++) {
    spendScan(index);
    prefixes[index] = extendPrefix(needle, prefixes, prefixes[index - 1], needle[index]);
  }
  return prefixes;
}

function extendPrefix(needle: string, prefixes: Uint32Array, size: number, char: string): number {
  while (size > 0 && needle[size] !== char) size = prefixes[size - 1];
  return size + Number(needle[size] === char);
}

export function spendScan(index: number): void {
  if ((index & 255) === 0) rt().spend(4);
}
