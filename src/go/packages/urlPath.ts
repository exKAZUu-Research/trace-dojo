import { spendFor } from './support';

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes net/url's resolvePath.
// code-gauge-allow functionNcss 35 -- Transcribes net/url's resolvePath.
/** net/url's `resolvePath`: applies the dot segments of `ref` (relative to `base`) per RFC 3986. */
export function resolvePath(base: string, ref: string): string {
  let full: string;
  if (ref === '') full = base;
  else if (ref[0] === '/') full = ref;
  else full = base.slice(0, base.lastIndexOf('/') + 1) + ref;
  if (full === '') return '';
  spendFor(full.length);
  let dst = '/';
  let first = true;
  const elements = full.split('/');
  for (const elem of elements) {
    if (elem === '.') {
      first = false;
    } else if (elem === '..') {
      const slash = dst.slice(1).lastIndexOf('/');
      dst = slash === -1 ? dst.slice(0, 1) : dst.slice(0, slash + 1);
      first = dst.length === 1;
    } else {
      if (!first) dst += '/';
      dst += elem;
      first = false;
    }
  }
  const last = elements.at(-1);
  if (last === '.' || last === '..') dst += '/';
  return dst.length > 1 && dst[1] === '/' ? dst.slice(1) : dst;
}
