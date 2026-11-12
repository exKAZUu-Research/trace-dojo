import { complexRepr } from './complexNumbers';
import { chargePrecision, formatFloat, pad, parseSpec, type Spec, unknownType } from './formatSpec';
import { valueError } from './types';
import type { PyComplex } from './values';

/** Formats a complex number with a format specification, as CPython's `format_complex_internal` does. */
export function formatComplex(value: PyComplex, specText: string): string {
  if (specText === '') return complexRepr(value);
  const spec = parseSpec(specText, value, { align: '>' });
  if (spec.type !== undefined && !'eEfFgGn'.includes(spec.type)) throw unknownType(spec.type, value);
  chargePrecision(spec.precision);
  if (spec.fill === '0') throw valueError('Zero padding is not allowed in complex format specifier');
  if (spec.align === '=') throw valueError("'=' alignment flag is not allowed in complex format specifier");
  // Without a presentation type the text is that of str(): a real part of positive zero is left out, and any other
  // one puts the number in parentheses.
  const isBare = spec.type === undefined;
  const omitsReal = isBare && Object.is(value.real, 0);
  const real = omitsReal ? '' : partText(value.real, spec, spec.sign, value);
  const imag = partText(value.imag, spec, omitsReal ? spec.sign : '+', value);
  const text = isBare && !omitsReal ? `(${real}${imag}j)` : `${real}${imag}j`;
  return pad(text, '', spec);
}

/** One part of the number with its sign and grouping but no padding, which applies to the whole text. */
function partText(part: number, spec: Spec, sign: Spec['sign'], value: PyComplex): string {
  const unpadded: Spec = { ...spec, sign, fill: ' ', align: '<', width: 0 };
  if (spec.type !== undefined || spec.precision !== undefined) {
    return formatFloat(part, { ...unpadded, type: spec.type ?? 'g' }, value);
  }
  // A part takes the digits of a float's repr without the `.0` that marks a float, of which `#` keeps the point.
  const text = formatFloat(part, unpadded, value);
  return text.endsWith('.0') ? text.slice(0, -2) + (spec.alternate ? '.' : '') : text;
}
